# Bound-leaf lifecycle and proven revoke

## Goal

A user holds a `did:kokuin` controller H. Its authority key is kept offline or in hardware. The user adds agents (devices, apps, bots, services), and each agent has its own `did:peer`. The agents are the MLS members. H always keeps complete authority to revoke an agent.

This design makes `@kumiai/mls` carry that model end to end, so a consumer only calls it:
- **Binding.** Each agent's leaf proves it is bound to H.
- **Delegation.** One trusted agent T may grant short-lived leaf capabilities to other agents, so the hardware key is not needed for routine grants.
- **Revocation.** When H signs `rev x=D` into its controller log, any member can publish that log into a group as proof. The group ledger then records "D revoked by H at log position N", permanently, and the same commit removes D's leaf and starts a new epoch.
- **Expiry.** Capability expiry is a backstop, measured in time H has attested, not wall-clock time (§2). A lapsed leaf never blocks the group, cannot send, and any member can remove it.

Accepted tradeoffs (user rulings, 2026-10-03):
- **Eventual consistency.** Between H's `rev` and the first member commit that carries the proof, D can still read the group.
- **Expiry follows H's signing.** Tree time advances only when something H signed enters the tree. A leaf whose `exp` has passed in wall-clock time stays usable until H next signs something newer that reaches the group, or revokes it. An agent that tree time has lapsed is removed and must rejoin with a fresh grant.
- **Only H's keys revoke** for now: the authority key signs `rev`, the recovery key signs a reset. A trusted agent cannot revoke.
- **Revocation is permanent in kumiai.** kokuin can later un-revoke D (a `rot` whose `d` snapshot omits it). kumiai ignores that: D's DID stays revoked in every group that recorded it. A replacement agent needs a new `did:peer`.
- **A stolen trusted agent** can grant leaf capabilities to attacker agents, valid up to its own grant's `exp`, until the user revokes it and a member publishes the proof. It cannot move tree time (§2).
- **Rejoin authority comes from peers.** The hub is blind to payloads and holds no authority. A rejoiner learns H's latest log only from the members that answer it, so one honest answering member suffices, and a rejoin that only revoked members answer is bounded by their capability `exp` plus a 300 s clock allowance (§5, *Controller authority*). Authority a rejoiner learns, H's log and the group revocations it authenticated alike, is kept across attempts and restarts. A responder can delay a rejoin indefinitely, never make it adopt wrongly (§5, *Transfer complete*).
- **A reset is a fresh start for H's log.** A reset is H's deliberate act with its recovery key. kokuin's fold clears the deny set at a reset (a reset carries `d: []`, `controller/src/events.ts:501-502`, which replaces the set, `fold.ts:271`), and the reset raises the generation floor, so every pre-reset grant is invalid, a revoked agent's included. An agent revoked before the reset comes back only if H re-grants it, directly or through a trusted agent's new-generation grant; H must revoke again anyone it does not want back. A group whose ledger recorded the agent's revocation still refuses it (*Revocation is permanent in kumiai*); this rule is about H's log, which the recovery gate reads (§5).

The first consumer is kubun's own-agents groups. It is the only consumer of this branch, so breaking wire and API changes are allowed in patch releases.

## Scope

In scope, in `@kumiai/mls`:
- the issuer pin for bound-leaf capabilities (F1, a privilege escalation found by the probe)
- deterministic, clock-free credential verification, including delegation chains of depth 1 through a trusted agent
- **lifecycle groups**: groups whose genesis anchor names a controller H (§1)
- tree time, entry checks, renewal and lapse in lifecycle groups
- a fixed leaf identity in every group
- a proven revoke, a cascade and a reset, with a generation floor
- removal of lapsed leaves
- a deny set that also applies to floating leaves
- registry/tree agreement for the existing device ops (C3)
- an invite path without role entries, and speculative helper handles that leave the live handle untouched until adoption
- the commit-pipeline gates these need, and the issuing and lifecycle API.

In scope, in `@kumiai/mls-rpc` and `@kumiai/rpc`: automatic recovery that rejoins a lifecycle group with a bound leaf, and asks the host for a fresh binding when the cached one is unusable (§5).

In scope, in `@kokuin/capability`: a child capability may not outlive its parent.

Out of scope:
- **Chains deeper than 1.**
- **Revokes authorised by a capability.** They are rejected in lifecycle groups (§3). The existing management-capability revoke stays only in other groups.
- **Lifecycle rules in mixed-controller groups.** Proven revoke, reset, lapse removal and tree-time floors exist only in lifecycle groups, which hold one controller's agents.
- **Capabilities an agent issues to itself** (§1, rule 6).
- **Changes to ts-mls.** Everything here runs on ts-mls `2.0.0-rc.13`. §4 states the one residual this leaves.
- **The `rev` producer and log publishing.** These belong to the consumer. The consumer calls `createRevoke` with H's authority key and publishes the log.
- **Fan-out of proofs across groups.** The consumer calls the helper for each group.

## Background

A probe against kumiai `0d0ee9f` and ts-mls `2.0.0-rc.13` found the following. Paths are under `packages/mls/src` (kumiai), `node_modules/ts-mls/dist/src` (ts-mls) and `packages/` (kokuin).

**F1: the bound-leaf capability issuer is never pinned.**
- `verifyPinnedCapability` (`authentication.ts:103-144`) passes `requireIssuer` only on the manage path (`:196`), and never checks `sub`.
- `did:key` and `did:peer` issuers verify without a resolver. So a device can sign its own `kumiai/mls-leaf` capability naming any controller and embed that controller's public inception as the prefix.
- The probe showed an end-to-end escalation: a floating member re-labels its leaf as bound to an admin profile P through an empty path commit, self-registers as a device of P (`device-proof.ts:56-60`), and its admin-only role entry is accepted.

**A lapsed bound leaf freezes the group.**
- ts-mls validates every leaf's credential on Welcome join (`clientState.js:591`) and on external join (`createCommit.js:246`).
- kumiai's credential check rejects an expired capability against the wall clock (`authentication.ts:135-136`), and `verifyToken` checks `exp` and `nbf` against the wall clock too, since no `atTime` is passed (`authentication.ts:118-122`; kokuin `token/src/time.ts:34-48`).
- So one lapsed leaf blocks every Welcome and external join, and receivers whose clocks differ reach different verdicts.

**Where the commit pipeline can see what.**
- The ts-mls commit callback runs after proposals are applied and before the path is validated or applied (`processMessages.js:157-158`, `:175-182`). It receives the sender and the proposals, not the path. Add and Update leaves have already passed the auth service, against the pre-commit deny set (`clientState.js:679-693`).
- A receiver that the commit removes returns early: the path is neither validated nor applied, and ts-mls exposes no path to kumiai (`processMessages.js:162-174`).
- A surviving receiver's `newState.ratchetTree` holds the applied path leaf. kumiai assigns that state before anything else (`group-handle.ts:1331`) and rolls back only on a persistence failure (`:1343-1363`).
- A caller-supplied commit policy replaces the default one (`group-handle.ts:1078-1083`).

**Renewal is possible today.**
- No public ts-mls API takes a replacement credential. `createCommit` copies the own leaf from `state.ratchetTree`, so a state copy whose own leaf carries the new credential makes ts-mls sign the new LeafNode.
- ts-mls records the supplied state's tree as the old epoch's historical receiver data (`createCommit.js:84`, `clientState.js:705-711`).
- An empty commit always carries a path; a commit with only Add proposals does not (`clientState.js:443-447`).

**Other facts the design relies on:**
- **Revoke proof.** An authority-signed `rev x=D` folds synchronously with `foldLog` (kokuin `controller/src/fold.ts:482`) in about 2 ms; `icp` plus `rev` is about 0.7 KB with Ed25519. A capability-authorised `rev` fails the sync fold closed.
- **Generations.** A reset is a `rot` with a higher generation, signed by the recovery key (`fold.ts:244-256`). Historic key resolution stops at the generation boundary of the supplied prefix's head (`controller/src/state-resolver.ts:89-108`), so a grant signed before a reset fails against a prefix that includes the reset, and passes against a prefix that stops before it.
- **Registry gaps.** `registryApply('revoke')` is a no-op for an unknown subject (`registry.ts:120-124`). The cross-controller guard on register/add reads only the registry, never the subject's leaf (`device-proof.ts:70-78`).
- **Floating leaves escape the deny set.** It is consulted only for bound leaves (`authentication.ts:163`, `:227`).
- **No shared clock.** No commit timestamp exists that every member agrees on: the envelope, the ledger entries and MLS carry none.

## Design

### 1. Lifecycle groups and credentials

**Lifecycle group.** A group is a lifecycle group iff its genesis anchor carries `controller: H`:
```
GroupAnchor.controller?: string   // a did:kokuin DID
```
- `createGroup` writes it when given a controller binding (§5). The creator's leaf is bound to H.
- The anchor is fixed at genesis: the extension policy pins every GroupContext extension except the ledger head.
- Decoding is strict: a `controller` that is present but not a `did:kokuin:` string makes the anchor malformed, and the group is refused. This supersedes, for this one field, the rule that new control fields go in a new extension (`anchor.ts:57-63`). Old peers ignore the field, so every peer of a lifecycle group runs this release (§7).
- There are no per-group lifetime settings. The ceilings are constants: 7 days for a leaf capability (kokuin's device default) and 365 days for a trusted grant.

In a lifecycle group:
- **Every leaf is bound to H.** A floating or foreign-bound leaf is refused on Add, external join and Update. A joiner checks it for the whole Welcome tree.
- **Authority is the binding.** The roster is seeded `{H: admin}` instead of `{creatorDID: admin}` (`roster.ts:45-47`), and `kumiai.role` entries are rejected. A commit sender whose pre-commit leaf is bound to H acts as H. So does the issuer of a consumer (non-`kumiai.*`) ledger entry that holds a leaf in the pre-commit tree: this replaces the registry-derived admin check of `foldEnvelope` (`envelope-fold.ts:92-94`) for those entries. Replays do not re-judge consumer entries, as today: the authenticated head covers them. Every member therefore may Add an agent, enact consumer entries and move the ledger head. Removal is narrower (§4).
- **Invites** carry their recipient explicitly instead of in a role entry (§5).
- **Device ops.** Only proven `revoke`, `reset`, `checkpoint`, `clock` and `beacon` are accepted. `register`, `add`, `label` and capability-authorised `revoke` are rejected: the registry here records only revocations and floors, and a trusted grant carries no `manage` permission.

**Leaf credential.** The member is the agent:
```
{ v: 1, id: <agent did:peer>, longForm?,
  controller: { id: H, prefix: <H log from icp, authority-only>, capability: <leaf capability> } }
```

**Leaf capability.**

| | Direct | Through a trusted agent T |
|---|---|---|
| `iss` | H | T |
| `sub` | H | H |
| `aud` | agent | agent (≠ T) |
| permission | `authenticate` on `kumiai/mls-leaf` | the same |
| `cnf` | the agent's leaf key | the same |
| `iat`, `exp` | required, `iat < exp` | required, `iat < exp` |
| `cap` | absent | T's trusted grant |

**Trusted grant (the parent).** `iss = sub = H`, `aud = T`, `authenticate` on `kumiai/mls-leaf`, `cnf` = T's key, `iat < exp` required. T need not be a current member; its own leaf, if any, uses a direct capability.

**Verification.** `validateCredential` is deterministic. It reads no clock and no DID cache, and every time claim is checked against a reference time taken from the token itself.
1. `controller.id` is a `did:kokuin`, and `prefix` folds to it with `foldLog`, through the embedded resolver (unchanged).
2. **Direct form.** `verifyToken(capability, { methods: [embedded], historic: true, atTime: capability.iat })`. This verifies the signature against a key valid in the prefix, and it checks `exp ≥ iat` and `nbf ≤ iat`. Then `iss = sub = controller.id` (the F1 fix), `aud = id`, the permission, `cnf` = the leaf's signature key, and `0 < exp - iat ≤ 7 days`.
3. **Chained form.**
   - The child's signature is verified offline against the key the parent's `cnf` pins: decode the JWT, then call `getVerifier(header.alg)` from `@kokuin/token` (exported, `token/src/verifier.ts:27`). The parent says "T holds key K", so T's DID is never resolved.
   - `checkCapability({act, res}, child.payload, { atTime: child.iat, methods: [embedded], maxDepth: 1 })` (`capability/src/delegation.ts:275`). With that reference time it verifies the parent against the prefix and checks the parent's `exp ≥ child.iat`, `nbf ≤ child.iat` and `iat ≤ child.iat`, `child.iss = parent.aud`, equal `sub`, permission coverage, and the child's own `exp ≥ iat` and `nbf ≤ iat`. It also checks the deny set for both audiences.
   - kumiai then checks: `parent.iss = sub = controller.id`, `child.aud = id ≠ child.iss` (no self-issuance), `child.cnf` = the leaf's key, `child.exp ≤ parent.exp`, `0 < child.exp - child.iat ≤ 7 days`, `0 < parent.exp - parent.iat ≤ 365 days`, and that T is not denied.
4. `id` is not in the deny set. This now applies to floating leaves too.

What is not checked here: `exp` against any notion of "now" (§2), and the generation floor (§2). Both depend on group state and run in the commit pipeline.

**Management capability** (other groups only). `verifyManagementCapability` uses the same reference-time verification with `iss = sub = controller` pinned. Its `exp` is then checked against the controller's tree time in the pre-commit tree (§2), not against the wall clock.

### 2. Time, generations and entry checks

**Attested time.** A leaf's attested time is a time H signed:
- for a direct leaf, its capability's `iat`;
- for a chained leaf, its trusted grant's `iat`. The T-signed child `iat` never counts.

**Tree time.** In a lifecycle group, `treeTime(H) = max(timeFloor(H), max attested time over the epoch's leaves)`.
- Every member computes it from the epoch's tree and the folded ledger, with no clock.
- `timeFloor(H)` lives in the registry and is raised only by `clock` entries (§3). It keeps tree time from going backwards when the leaf holding the maximum leaves.
- **Liveness cost.** Tree time advances only when a leaf carrying a newer H-signed time enters: a direct grant on Add or renewal, or a leaf carrying a re-issued trusted grant. T's routine renewals never advance it. In a deployment where H signs only T's yearly grant, children lapse in tree terms only at that cadence. To keep weekly lapse, H must sign something weekly that reaches the group, for example a fresh direct grant for one agent.
- In other groups, `treeTime(C)` for a controller C is the maximum attested time over leaves bound to C, with no floor. It is used only for entry checks and management capabilities.

**Lapsed.** A leaf L bound to H is lapsed at an epoch when `L.exp < treeTime(H)`, where `L.exp` is the leaf token's `exp`. A chained leaf lapses no later than its parent, since `child.exp ≤ parent.exp`.

**Generation floor.** `genFloor(H)` lives in the registry and is raised only by an accepted `reset` (§3). A leaf's generation is the generation at the head of its prefix. Ordinary rotations do not change the generation, so grants issued before a rotation keep verifying (historic semantics). A grant signed before a reset fails against any prefix that includes the reset, and a prefix that stops before the reset is below the floor.

**Entry checks.** They run on every leaf that enters or changes: an Add, the new leaf of an external commit, an Update, and a committer's path leaf whose credential changed. All are judged against the pre-commit state.
1. In a lifecycle group, the leaf is bound to the anchor's H.
2. The credential passes §1.
3. `L.exp > treeTime(H)` of the pre-commit epoch.
4. The leaf's generation is at least `genFloor(H)`.
5. Neither `id` nor the chain issuer is denied.
6. **Fixed identity.** For an Update, a path leaf or an external replacement, the new leaf has the same `id`, `longForm`, signature key and `controller.id` as the leaf it replaces. Only `controller.capability` and `controller.prefix` may change, and the prefix must still fold to `controller.id`. Outside lifecycle groups, a floating leaf may become bound once, keeping `id` and key; bound to floating is rejected.
7. **Renewal order.** When the leaf replaces one of the same identity, the new leaf token's `iat` is at least the old one's.
8. **Registry agreement** (other groups). If the registry has a record for `id`, the leaf's `controller.id` equals the record's controller (§3).

Checks 3 and 4 do not apply in non-lifecycle groups beyond `L.exp > treeTime(C)`.

**Sending.**
- A lapsed member's member commit is accepted only when it is an empty commit whose path renews its own leaf out of lapse, plus a `clock` entry if §3 requires one. This does not govern an external commit: §4's external-commit rule may replace a lapsed leaf.
- `GroupHandle.sendAdmission()` is **synchronous**. It returns `{ epoch, admissible: true }`, or `{ epoch, admissible: false, reason: 'lapsed' }` when the own leaf is lapsed at the handle's current epoch. Tree time and the own leaf's verdict are computed once when an epoch's state is installed, so the call takes no lock, awaits nothing and reads no clock. `encrypt` refuses a lapsed sender with `LeafLapsedError`, and the consumer's outbox must refuse to enqueue (see the epoch-change delivery spec).
- **The port's snapshot** (`@kumiai/mls-rpc`). `GroupMLS.sendAdmission()` never goes through `HandleAccess.read`, `mutate`, `replace` or `open`: those serialise with `replace`, which awaits the host's adoption callback (`mls-rpc/src/access.ts:28-40`, `:61-66`), so a dispatch awaited inside that callback would deadlock. Instead `HandleAccess` gains a synchronous `admission()` beside `epoch()`, and both are published together at the same points: initially, and at the end of `mutate`, `replace` and `open` (`access.ts:58`, `:65`, `:71`). `replace` publishes after the host adoption callback resolves. So inside an adoption or epoch callback, `admission()` still reports the epoch being left, paired with its own verdict. That is safe because the delivery worker re-checks admission at seal and accepts only an admission whose epoch equals the ciphertext epoch. The cost: a dispatch from inside the adoption of the sender's own renewal is judged at the lapsed epoch and refused; the host dispatches after adoption.
- `decrypt` and `decryptStaged` read the sender leaf before opening (`group-handle.ts:873-877`, `:915-919`). They refuse a lapsed sender with `LeafLapsedError` there, so no ratchet generation is consumed. The sender is named only at the receiver's current epoch, so the receiver judges the same tree and ledger the sender did, and both reach the same verdict.

**Author-side checks.** These use the local clock and only stop the device itself from producing a bad change. `createGroup`, `createKeyPackageBundle`, `createLastResortKeyPackageBundle`, `joinGroupExternal`, `commitInvite`, `addDevice` and `renewLeaf` refuse a capability whose `exp ≤ now` or whose `iat > now`.

**Renewal.** `renewLeaf(group, binding)` makes an empty commit whose path carries the own leaf with the new binding.
- It uses the same signature key and absorbs no pending proposals, so the commit always carries a path. Its only possible ledger entry is a `clock` entry, when the new leaf lowers tree time (§3).
- It builds the commit from a state copy whose own leaf, LeafNode and credential objects are deep-copied before the credential is replaced. Shared objects are never mutated.
- After `createCommit`, it replaces the old epoch's historical receiver data in the returned state with the original pre-renewal tree, so delayed old-epoch messages are judged against the leaf as it was.
- Only the leaf's owner can sign its LeafNode, so each agent renews itself. Delivering a new capability from H or T to the agent is the consumer's job.

### 3. Registry, revoke, reset and clock

All entries below are `kumiai.device` entries, accepted only in lifecycle groups, authored by any member and authorised by their proof, not by a role. Every effect is carried in the entry itself, so every replay derives it from authenticated ledger data alone: live receive, the author's derived handle, serialise and restore (`restoreGroup`), `bootstrapLedger`, and Welcome. The pre-commit tree is read only on live acceptance, to validate the entry.

**Proof checkpoint (R9-I4, R10-I1, R10-I5).** A proof is published relative to the H log the group's ledger already holds, never as the full chain from inception.
- **Recorded log and checkpoint.** Every member derives the group's recorded H log from the ledger alone, replaying its accepted `revoke`, `reset` and `checkpoint` entries in order: the first accepted entry's chain starts it, each later `revoke` or `checkpoint` appends its suffix, and each accepted `reset` replaces it with the reset's chain. The **checkpoint** is the recorded log's head. A group with no accepted entry of these kinds has none.
- **Proof form.** An entry carries only events that advance the folded head: a skipped `crit: false` event (`fold.ts:377`) makes it invalid. A group's first entry carries the chain from the inception, or, when H's log holds a reset, from the latest reset re-parented on the inception (`[icp, reset, …]`; a reset chains to the inception, `fold.ts:244-256`). A later `revoke` or `checkpoint` carries the suffix after the checkpoint (a `revoke`'s possibly empty when the recorded log already holds the `rev`). A `reset` always carries its own chain `[icp, reset, …]`, since a reset never extends the checkpoint.
- **Verification.** A `revoke` or `checkpoint` is verified with `foldLog(H, recorded ++ suffix)`, so it is fold-authenticated against the recorded log. A suffix that does not attach to the checkpoint fails that fold and the entry is rejected. The revocation run derives each entry from its handle's ledger at build time, so a step that lost the epoch race is rebuilt against the current checkpoint (§5, *Revocation run*). A `revoke` or `checkpoint` never changes the generation: a suffix holding a reset is rejected, and a higher generation is first proven by a `reset` entry.
- **Advance.** Each accepted entry moves the checkpoint to its own head: a `revoke` or `checkpoint` to the head of `recorded ++ suffix`, a `reset` to the head of its chain.
- **Bound.** Every entry that carries H-log events (a first chain, a reset chain, a `checkpoint` or a revoke suffix) is at most **512 KiB** (524,288 bytes) as its signed token's UTF-8 bytes, which are what `encodeLedgerEntries` frames (`rpc/src/ledger-entries.ts:36-50`). Receivers reject a larger entry in the pre-pass. The margin comes from the hub: a publish payload is at most 1,048,576 base64 characters (`hub-protocol/src/protocol.ts:35`, encoded by `hub-client/src/client.ts:98`), so a frame holds at most 786,432 bytes. A commit frame is the handshake header (4 bytes, `rpc/src/handshake.ts:42`), the commit-frame header (5, `rpc/src/commit-frame.ts:38-40`), the MLS commit, the sealed blob's version, nonce and tag (41, `mls-rpc/src/crypto.ts:58-70`) and the entry list's header and lengths (3, plus 4 per token, `ledger-entries.ts:30-33`). A 512 KiB entry therefore leaves 262,144 bytes, less about 60 bytes of framing, for the MLS commit itself (its proposals, UpdatePath and the committer's leaf, whose credential carries H's prefix and capability) and any other entry. In a verdict the evidence rides inside the signed token, whose base64url encoding grows it by 4/3: one 512 KiB entry is about 683 KiB of token, which with the seal and headers stays under 768 KiB, so any single entry also travels alone in one answer (§5, *Pages*).
- **Whole-frame check.** The bound sizes entries; the frame decides. Before `@kumiai/rpc` journals or publishes any frame (a commit in `frameCommit`, `peer.ts:1892-1910`, a GroupInfo reply, a ledger reply or a verdict), it checks `4·⌈n/3⌉ ≤ 1,048,576` for the frame's `n` bytes; a frame that fails throws `FrameTooLargeError` (an `@kumiai/rpc` class) and nothing is journalled or published, so a kumiai frame is never a hub schema rejection. The revocation run sizes each step by this check, cutting the step's events back until its frame passes (§5, *Revocation run*), and a responder fills a page only while its frame passes (§5, *Pages*).
- **Horizon.** This is the one proof contract. A history whose events each fit the bound alone is provable: the revocation run publishes as many `checkpoint` entries as it needs before the `revoke` (§5). A single event too large to fit alone is `'not-provable'` (`too-large`), and H's reset is the path, since the reset's chain does not carry the old generation's events. One case is open: a `checkpoint` holds no `rev`, and a `rev` whose subject the group already records revoked (for example H re-revoking, after a reset, an agent the reset's `revoked` list already holds) cannot be proven on its own, so it rides inside the next `revoke`'s suffix; when the span from it to that `rev` does not fit, the run is `'not-provable'` (`too-large`). Recovery has a separate horizon (§5, *Limit*).
- **Replay.** Live receive, the author's derived handle, restore, `bootstrapLedger` and Welcome all derive the recorded log from the ledger tokens they already hold: the invite carries the group's whole ledger (§5, *Invites*), and the lifecycle recovery replies page it (§5, *Ledger pages*). So every member verifies every entry against the same checkpoint.

**Checkpoint advance.**
```
{ op: 'checkpoint', subject: H, proof: SignedEvent[] }
```
- `proof` is the suffix after the checkpoint, or, in a group with no checkpoint, the chain from the inception. Accepted when `foldLog(H, recorded ++ proof)` succeeds, so every event is authority-signed; `proof` is not empty, so it strictly advances the checkpoint (every event advances the folded head, *Proof form*); it holds no `rev` and no reset; and it fits the bound. A suffix that does not attach fails the fold (`detached` on the authoring side). A reset goes through the `reset` entry, a `rev` through a `revoke`.
- Effect: the checkpoint moves to its head. Nothing else: no record, no deny, no floor, no Remove.
- Any member may publish it. Its authority is H's signatures, through the fold, never the publisher's.

**Proven revoke.**
```
{ op: 'revoke', subject: D, proof: SignedEvent[], revoked: Array<{ did, cascadedFrom? }> }
```
`proof` is the first proof's chain or the suffix after the checkpoint (*Proof checkpoint*). Accepted when all of these hold:
1. `foldLog(H, recorded ++ proof)` succeeds, with H the anchor's controller and `recorded` the group's recorded log (empty before the first proof). Every event must be authority-signed: a capability-authorised `rev` fails the sync fold.
2. Some event `k` of that log is `rev` with `x` normalizing to D, `states[k].deny` contains D, and `states[k].gen ≥ genFloor(H)`. A `rev` from a generation that a reset retired is rejected, so an old compromised authority key cannot evict agents after the reset.
3. D is not already revoked.
4. `revoked` lists D first, then every pre-commit leaf whose chain issuer is D, each with `cascadedFrom: D`. Receivers recompute this list from the pre-commit tree and reject any difference.
5. The commit's composition follows §4.

Effects: each listed DID gets `{ status: 'revoked', controller: H, logPosition: k, cascadedFrom? }`, created if absent. Revoked records are terminal (`registry.ts:104-106`). The proof need not reach the log head, and a later kokuin un-revoke does not undo the record.

**Reset.**
```
{ op: 'reset', subject: H, proof: SignedEvent[], revoked: Array<{ did, cascadedFrom? }> }
```
- `proof` is the reset's chain `[icp, reset, …]` (*Proof checkpoint*). Accepted when `foldLog(H, proof)` succeeds and the proof contains a reset to generation `g > genFloor(H)` at position `k`. The recorded log becomes the proof.
- `revoked` lists every pre-commit leaf whose generation is below `g`, then every pre-commit leaf whose chain issuer is one of those (`cascadedFrom`). Receivers recompute and compare it.
- Effects: `genFloor(H) = g`, and each listed DID gets `{ status: 'revoked', controller: H, logPosition: k, reason: 'reset', cascadedFrom? }`.
- An agent absent from the tree at reset time is caught by the floor at its next entry, not by the list.

**Clock.**
```
{ op: 'clock', subject: H, time: number }
```
- Accepted when `timeFloor(H) < time ≤ treeTime(H)` of the pre-commit epoch. Effect: `timeFloor(H) = time`. At most one per commit.
- **Required** in any commit whose post-commit tree time, computed **with the existing floor**, would fall below the pre-commit tree time. The entry must then carry `time = treeTime(H)` of the pre-commit epoch, so tree time never decreases. Such a commit always exists to carry it: a regression means a leaf's attested time was above the floor, so `timeFloor(H) < treeTime(H)`. Once the floor dominates every remaining leaf, ordinary commits and renewals below it need no entry.
- A regression has two causes, and §4's composition rules keep them in separate commits. A Remove of the leaf holding the maximum is known before the path, so the callback judges it, and a removed receiver agrees. A path or Update leaf whose new attested time is lower than its old one (a chained renewal whose trusted grant is older than the replaced direct grant or grant) is judged where that leaf is checked: the callback for an Update, the post-apply gate for a path leaf. Lowering a leaf's attested time is allowed; it only needs the entry. Helpers add the entry themselves, `renewLeaf` included.

**Deny set.** Every DID with a revoked record is denied as a leaf, bound or floating, on Add, external join and Update, and is denied as a chain issuer.

**Registry agreement in other groups (C3).** A `register` or `add` naming controller C for subject S is accepted only when all of these hold:
- the registry has no record for S, or the record names C;
- S's current leaf, if any, is bound to C. A floating S cannot be attributed by another member: S must first bind its own leaf, then self-register;
- an Add of S in the same commit carries a leaf bound to C.

A manage-op `revoke` or `label` additionally requires that the target's current leaf, if any, is bound to the registry's controller for it. Every later admission of S is held to its record by entry check 8. Any conflict is rejected; neither the registry nor the tree overrides the other.

**Manage path.** `verifyManagementCapability` also pins `sub = controller` (F1). It is unused in lifecycle groups.

### 4. Commit pipeline

**Gate order.** Lifecycle gates are mandatory. A caller policy runs only after they accept, and only replaces the default policy's role rules. It can never accept what a lifecycle gate rejected. This changes `combined` (`group-handle.ts:1078-1083`).

**Stages.**
1. **Pre-pass** (async, before ts-mls). It decodes the envelope, resolves the entries, folds the candidate registry (deny set, floors, records), verifies device entries and proofs, and parses an external commit's path leaf. It also precomputes the pre-commit tree time, the lapsed set and the derived `revoked` sets.
2. **Callback** (sync, inside ts-mls; it runs for every receiver, including a removed one). It holds every proposal-level verdict: entry checks on Add and Update leaves, Remove legitimacy, the lapsed-sender restriction, composition rules, the clock requirement for Removes and Updates, and the external-commit rules. It needs no async work: chain signatures were already verified by the auth service, and the generation of a prefix is a synchronous fold.
3. **Post-apply gate** (survivors only, after ts-mls returns, before the state is adopted). It judges the committer's path leaf against the pre-commit leaf: entry checks if the credential changed, unchanged credential where the composition rules require it, renewal out of lapse for a lapsed sender, and the clock requirement for a path leaf that lowers its attested time. It runs before `this.#state` is assigned, persistence, ledger application, events and zeroisation.
   - On reject, the previous state stays authoritative. The result's `consumed` secrets are not zeroed, since they belong to the previous state. The new-epoch state is dropped, and `CommitRejectedError` is thrown.
   - `commitWithEntries` and every lifecycle helper run the same gate on their own result before returning, so authors and receivers agree.

**Removed receivers.** ts-mls returns before validating or applying the path for a receiver the commit removes (`processMessages.js:162-174`), and exposes no path to kumiai. The design therefore makes every Remove verdict computable before the path: a removed receiver agrees with survivors on whether its removal was authorised. It cannot see a path that survivors then reject, so it may consider itself removed from a commit the group discards. Since that removal was itself authorised, the only effect is that a removable member leaves early, and it can rejoin if not revoked. Closing this needs either a ts-mls change exposing the decrypted commit to the callback (out of scope), or kumiai re-implementing PrivateMessage decryption (rejected). We accept it.

**Proposal rules in lifecycle groups.**
- **Add:** the added leaf passes the entry checks. Any member may add.
- **Update:** passes the entry checks, including fixed identity.
- **Remove**, one of:
  - derived from a `revoke` or `reset` entry in the same commit: the Removes equal exactly the pre-commit leaves of the entry's `revoked` DIDs;
  - a lapsed target, judged at the pre-commit tree time, from any member;
  - a self-removal proposal by the target, committed by another member.
  No other Remove is accepted. The anti-demotion rule (`policy.ts:229-235`) does not apply, since agents hold no roles.
- **GroupContextExtensions:** the head move only, from any member.
- **PSK and ReInit:** rejected.
- **External commit:** exactly `external_init` plus one Remove of an existing leaf L. The new leaf passes the entry checks with L as the leaf it replaces, so it is the same agent with the same key, bound to H. It may not lower tree time, including the floor, since an external commit carries no entries. Membership comes from the binding, not from a roster role, so this replaces the roster gate (`policy.ts:268-297`) in lifecycle groups. This rule alone governs an external commit, and so recovery: the member-commit rules (the lapsed-sender restriction in §2 and the unchanged path credential below) do not apply. The replacement may therefore renew a lapsed L and change its capability and prefix, subject to the full entry checks and no tree-time regression.

**Composition rules.**
- A commit that enacts a `revoke` or `reset` carries exactly one such entry, its derived Removes, the head move and an optional `clock` entry. It carries no Add, Update, PSK or other Remove, and the committer's path leaf keeps its credential. A member listed in `revoked` cannot author it.
- A commit that enacts a `checkpoint` carries exactly that entry and the head move: no proposal and no other entry, and the committer's path leaf keeps its credential. The lifecycle commits that remove a leaf or move the recorded log are therefore: a proof (`revoke` or `reset`), a lapse removal, a self-removal and a `checkpoint` advance.
- A member commit that carries any Remove keeps the committer's path credential unchanged. Renewal and removal go in separate commits. An external commit's Remove of the leaf it replaces is governed by the external-commit rule instead.
- Every helper commits with no pending proposals absorbed.
- With these rules, the deny set and floors that a commit installs never meet a leaf admitted in the same commit, which closes the same-commit admission gap. The final check still runs: after the commit, no surviving leaf is denied, is issued by a denied DID, or is below the generation floor.

**Other groups.** The existing rules stay, plus fixed identity, the deny set on floating leaves, registry agreement and the mandatory gate order. The external-commit rule additionally requires fixed identity against the replaced leaf.

**Beacon.** Unchanged and advisory. A beacon is no longer needed to make a proof acceptable.

### 5. API (`@kumiai/mls`)

**Issuing:**
```ts
mintLeafCapability(params: {
  signer: SigningIdentity        // H's authority signer, or T's signer
  controllerID: string
  audience: string               // agent DID
  leafKey: Uint8Array
  exp: number
  parent?: string                // T's trusted grant, required when signer is T
}): Promise<string>

mintTrustedGrant(params: {
  signer: SigningIdentity        // H's authority signer
  controllerID: string
  audience: string               // T's DID
  leafKey: Uint8Array            // T's key
  exp: number
}): Promise<string>
```
- Both set `iat` and refuse lifetimes over the ceilings. `mintLeafCapability` refuses a child `exp` later than the parent's, and an `audience` equal to the signer.
- `ControllerBinding` (`credential.ts:36-40`) is the binding input everywhere. No separate credential builder is exported.

**Group setup:**
- `createGroup(identity, groupID, { controller?: ControllerBinding, ... })` builds a bound creator leaf (today it is always floating, `group-create.ts:58`) and writes `GroupAnchor.controller = binding.id`. That makes it a lifecycle group.
- `createKeyPackageBundle`, `createLastResortKeyPackageBundle` and `joinGroupExternal` take `controller?: ControllerBinding` (today `group-credential.ts:54`, `group-welcome.ts:237`). In a lifecycle group, `joinGroupExternal` without `controller` throws `LeafBindingError` (`floating-refused`) instead of building a floating leaf.

**Recovery in a lifecycle group** (`@kumiai/mls-rpc`, `@kumiai/rpc`). Automatic recovery rejoins by external commit (`attemptBody`, `rpc/src/peer.ts:2402`). The adapter's `applyRecovery` passes only `group.credential` (`mls-rpc/src/mls.ts:315-321`), so `joinGroupExternal` builds a floating leaf (`mls/src/group-welcome.ts:236-240`), which survivors refuse. In a lifecycle group:
- **Binding.** The replacement leaf always carries a complete `ControllerBinding`. The adapter reads the own leaf's current binding from the handle's tree and reuses it when it passes the recovery check. Otherwise it asks the host.
- **Confirm before adopt.** Every lifecycle rejoin uses the epoch-change spec's confirm-before-adopt: the rejoiner keeps the derived handle pending until a responder that applied the external commit, and that passes the controller-authority gate (below), confirms at the new epoch. An authoritative responder refusal or the deadline discards the pending handle. This, not the checks below, is what keeps a refused rejoin from splitting the group.
- **Recovery check.** It runs the complete external-commit acceptance predicates of §4 on a candidate binding, not only the binding predicate: the own leaf L is present in the tree and not denied, so the commit is exactly `external_init` plus the Remove of L; the new leaf passes entry checks 1 to 7 with L as the leaf it replaces (H, credential, `exp` above tree time, generation floor, deny set, fixed identity, renewal order); and its attested time does not lower tree time, floor included, since an external commit carries no `clock` entry. A lapsed L is no obstacle (§4). It adds the external-join authoring check (`iat ≤ now < exp`, §2). Before the request it runs on the handle's own, possibly stale, state; after the GroupInfo, on the responder's state (below). A cached binding expired by wall clock but live in tree time would pass survivors, but the authoring check still forbids reusing it.
- **Port.** `GroupMLSParams`, the params of `createGroupMLS` (`mls-rpc/src/mls.ts:79-91`, `:189`), gains:
  ```ts
  recoveryBinding?: (request: { groupID: string; controllerID: string; current: ControllerBinding }) => Promise<ControllerBinding | null>
  ```
  kumiai calls it only in a lifecycle group, only when the cached binding fails the check or a responder refused it (below), and at most once per attempt. `null`, an absent port, or a returned binding that fails the check all mean "none". The binding is held for that attempt only. Once the rejoin is confirmed, it is the own leaf's binding, which later recoveries reuse.
- **Before the request.** The `GroupMLS` port (`rpc/src/crypto.ts:367`) gains `prepareRecovery(): Promise<'ready' | 'renewal-required'>`. `attemptBody` calls it before minting the request (`peer.ts:2445`). It picks the binding against the handle's own tree and registry. `'renewal-required'` ends the attempt before any GroupInfo is requested. Outside lifecycle groups it always answers `'ready'`.
- **The reply carries the ledger.** Today the sealed reply frames only the attestation and the GroupInfo (`mls/src/recovery.ts:553`, `:674`), and the rejoiner fetches the ledger only after its commit is published (`peer.ts:2555-2558`). So it cannot see a `timeFloor`, `genFloor` or deny entry raised during its gap. In a lifecycle group, `sealGroupInfo` also frames the first page of the responder's ledger (*Ledger pages*, next) and its authority answer (*Controller authority*, below), and the attestation's digest covers all three. The rejoiner publishes no external commit on a reply whose ledger pages are not complete, and a reply whose pages contradict the head in the GroupInfo's GroupContext is refused like any untrusted reply (`null`). The reply already goes only to a requester with a leaf in the responder's tree, as `sealLedger` does, so the ledger reaches no one new.
- **Ledger pages (R10-I1).** No reply carries a whole ledger in one frame: with entries of up to 512 KiB (§3, *Bound*), a ledger outgrows the hub cap. The GroupInfo reply and the ledger reply (`sealLedger`, `mls/src/recovery.ts:779-783`, answering `ensureLedger`, `peer.ts:2088`) carry the responder's ledger as pages after the request's **ledger cursor**, the `ledger` field of its signed authority cursor (*Cursor*): the entries after `ledger.length` when the responder's ledger has `ledger.head` there (`base: 'cursor'`), otherwise from its first entry (`base: 'start'`). A page is `{ base, from, tokens, more }`. The responder adds tokens in ledger order while its frame passes the whole-frame check (§3). A `ledgerReply` page holds at least one when any remains, since every entry fits alone (§3, *Bound*); the GroupInfo reply's first page may hold none when the GroupInfo leaves no room. A GroupInfo that fails the check by itself, its tree carrying every leaf's prefix, is not sent: that is a separate size horizon this spec does not bound. The rejoiner continues a page that sets `more` with a `ledgerRequest` (`peer.ts:2158-2166`) carrying a fresh signed recovery request whose ledger cursor names the end of the pages it holds; responders answer in a `ledgerReply` from that cursor. A responder's pages are taken only in order, each continuing exactly where its previous one ended. A reply's ledger counts only once complete: the fold of the rejoiner's own last-known ledger (`base: 'cursor'`) or of nothing (`base: 'start'`), followed by the pages, passes through the head in the GroupInfo's GroupContext; entries past that head are dropped. Until then it informs neither the recovery check nor gate (b). Pages whose fold contradicts the head end that responder's pages, and the rejoiner waits for another. `ensureLedger` gathers the same pages from the rejoined handle's cursor and calls `bootstrapLedger` once they reach the authenticated head.
- **After the GroupInfo.** `applyRecovery` (`crypto.ts:468`) re-runs the check against the GroupInfo's tree and the registry folded from the reply's ledger. That is the responder's state: authenticated, but not necessarily the survivors' current state, since a responder can lag the group and the compare-and-set (`peer.ts:2496-2501`) only catches a commit published during the attempt. The check is therefore an optimisation that avoids a wasted publish of a commit the responder's own state already refuses. Confirm-before-adopt is the safety argument. If the held binding fails, it asks the host once (unless the host supplied it in this attempt). With no usable binding, it returns `{ renewalRequired: true }`, so its result widens to `PendingRecovery | { renewalRequired: true } | null`. The peer then ends the attempt instead of re-requesting (`peer.ts:2465`).
- **Responder refusal reasons.** A responder whose lifecycle gates reject the external commit reports one of these reasons in its confirm-before-adopt refusal. The union, `RecoveryRefusalReason = 'binding' | 'lapse' | 'floor' | 'policy' | 'invalid'`, is defined once in the epoch-change spec (§1, *Confirm before adopting*); this spec maps its gates onto it:
  - `'binding'`: entry check 1, 2, 5 (chain issuer) or 7 fails;
  - `'lapse'`: entry check 3 fails;
  - `'floor'`: entry check 4 fails, or the replacement lowers tree time;
  - `'invalid'`: anything else, such as no leaf L of the same agent to replace (check 6), a denied `id`, or a commit that is not exactly `external_init` plus that Remove. A correctly built commit is never refused for shape, so retrying cannot help.

  A caller policy that rejects it after the lifecycle gates accept reports `'policy'`. A refusal is acted on only when its signer passes the controller-authority gate (below); otherwise it is advisory.

  `'binding'`, `'lapse'` and `'floor'` are binding-fixable. The rejoiner discards the pending handle, marks the refused binding unusable so no later attempt reuses it, and behaves as for `'renewal-required'` below. `'policy'` and `'invalid'` are not binding-fixable. The rejoiner discards the pending handle and reports the epoch-change spec's `'refused'` outcome with the reason, and no automatic trigger starts another attempt until the host calls `recover()`.
- **Outcome.** `RecoveryFailureReason` (`peer.ts:223-228`) gains `'renewal-required'`, reported through `onRecovery` as `phase: 'failed'`. It differs from `no-responder` and `deadline`: no responder can fix it. It also gains `'authority-too-large'` (*Controller authority*, *Transfer*): H's history cannot be carried to the rejoiner. Like `'refused'`, no automatic trigger starts another attempt until the host calls `recover()`.
- **No retry loop.** The peer sets `renewalRequired`. While it is set, no automatic trigger starts an attempt or requests a GroupInfo: not `healIfRequested` (`peer.ts:2642-2652`), and not the delivery worker's backoff or its uncovered-floor rejoin (epoch-change spec). The strand and the held outbox entries stay, as for any failed recovery.
- **Resume.** The host calls `recover()` (`peer.ts:2629`, trigger `'consumer'`) once it can supply a fresh binding. That clears the flag and runs one attempt, which calls `recoveryBinding()` again. A ratchet by any other path also clears it. A `recover()` with nothing new costs one port call and no GroupInfo request.
- **Survivors.** The external-commit rule (§4) judges the replacement against the pre-commit tree and floors. A floating replacement fails entry check 1. One lapsed in tree time fails check 3. One below the floor fails check 4. One that lowers tree time fails the no-`clock` rule. A responder that refuses reports the reason above.
- **Why the ledger still rides the reply.** Without confirmation, a rejoin that survivors reject would split the group silently. Survivors refuse it like any refused commit and step over it (`mls-rpc/src/apply-commit.ts:119-132`, `peer.ts:1713-1716`), while the rejoiner on `main` adopts its handle as soon as the hub accepts the commit (`peer.ts:2510-2545`), bootstraps successfully because the external commit moved no head, steps over the next honest commit as the winning side of a fork (`classify.ts:282`), and seals app frames at an epoch no other member holds until a commit two epochs ahead strands it (`classify.ts:256`). Confirm-before-adopt closes this: the rejoiner adopts only on a responder's confirmation at the new epoch, never on the hub's acceptance. The ledger on the reply only makes the common refusal (a floor or deny entry raised during the rejoiner's gap) known before the publish, so it costs no commit and no wait for the deadline.
- **Controller authority (R6-I1).** A confirmation's tag proves that its signer derived the pending branch's key, not that the branch extends accepted history. A member revoked at E+1 that kept E's secrets can hand a stale rejoiner E's GroupInfo and ledger, apply the external commit built from them on its retained E state, and confirm it with a valid tag, through an honest hub. The hub holds no authority, so in a lifecycle group the rejoiner judges every signer it relies on against H's latest log, as members supply it.
  - **Ask and answer.** No new message kind. The epoch-change spec's `recoveryConfirmRequest` is the ask, and the recovery request token carries the first one. Each carries the rejoiner's **authority cursor** (*Transfer*). In a lifecycle group every verdict (`confirmed`, `superseded` or `refused`) carries the responder's **authority answer** to that cursor, inside the signed verdict token and so under the seal. The sealed GroupInfo reply carries one too, beside the first ledger page (above). A responder computes its own latest log by the selection rule below over the host's `controllerLog(H)` and the recorded log its own ledger derives (§3, *Proof checkpoint*) (`group.getLedger()`, `mls/src/recovery.ts:781`). So a member that applied a revoke commit answers with that proof even when its host store lags. It recomputes its answer on every repeat of the request (epoch-change §1, *Reply*). The answer also carries the group's revocation evidence (*Transfer*, *Revocation evidence*).
  - **Transfer.** A rejoiner needs only what extends its own baseline, never a responder's whole log.
    - **Cursor.** `AuthorityCursor = { baseline: Head; branch?: Head; ledger: { length: number; head: string }; evidence?: Array<{ responder: string; base: 'cursor' | 'start'; after: number }> }`, where `Head = { digest: string; gen: number; seq: number }` is a folded state's digest and position (kokuin `KeyState`). `baseline` is the head of the rejoiner's baseline (*Selection*). `branch` is the head of a diverging branch it is part-way through receiving. `ledger` is the rejoiner's last-known ledger, its own handle's: its length and head digest. `evidence` holds, for each responder whose evidence has started in this attempt, the base it answered on and the last evidence position received from it (*Revocation evidence*); it replaces round 9's shared `revocationsAfter`. `RecoveryRequest` (`mls/src/recovery.ts:96-102`) gains `authority?: AuthorityCursor`, under its signature. `recoveryConfirmRequest` carries the current cursor on every repeat; that copy is unsigned, so the answer binds it (*Answer binding*).
    - **Answer.** The responder takes the cursor's most advanced head that its own log's fold passes through, `branch` first. It answers `{ kind: 'suffix', after, events, more }`: the events after that head, possibly none. A log that passes through neither head is sent as `{ kind: 'branch', events, more }`, from the inception, whatever its shape, except that a log holding a reset is sent from its latest reset re-parented on the inception, so a branch's generation is known from its first page. The responder builds that representation itself: a reset chains to the inception (`fold.ts:244-256`), and `resolveBranches` only chooses among the equal-head representations it is given (`supersede.ts:415-422`), it does not synthesise one. The responder cannot tell a stale prefix of the baseline from a diverging branch, and it must never withhold a same-generation rival: that rival is duplicity evidence, and the selection must see it to fail closed (*Selection*). A responder with no log answers `{ kind: 'none' }`.
    - **Answer binding (R10-I2).** The signed verdict token, and the GroupInfo reply's attestation, carry `answered`: the digest of the exact cursor the responder answered, with the evidence `base` and `after` it used for itself. The rejoiner records the digest of every cursor it issues in the attempt (the signed request's and each repeat's) and accepts an authority answer only when `answered` is one of them and its evidence `base` and `after` are what that cursor held for that responder (none: its prerequisite chain). An authentic token answering a cursor the attempt never issued is discarded, and its signer's transfer counts as started and incomplete until an answer to an issued cursor completes it, so it stays decisive (*Transfer complete*). A copied request with a forged cursor therefore delays the rejoin; it cannot make an answer omit evidence.
    - **Revocation evidence (R9-I1, R10-I3).** The answer also carries the responder's `revoke`, `reset` and `checkpoint` ledger entries recorded after the rejoiner's last-known ledger, as the signed ledger tokens with their positions, in ledger order, on one base: after `ledger.length` when the responder's ledger has `ledger.head` there (`base: 'cursor'`), otherwise from its first entry (`base: 'start'`). Progress is per responder and per base: the responder continues after the `after` the cursor's `evidence` holds for it on that base, and starts at the base's first entry when the cursor holds nothing for it or holds another base. So an unseen responder, or one whose base changed, always starts with its prerequisite chain, whatever other responders have sent. For each responder and base the rejoiner keeps an **evidence checkpoint**: the recorded log (§3, *Proof checkpoint*) of its own last-known ledger for `base: 'cursor'`, or an empty one for `base: 'start'`, grown by that responder's entries authenticated so far. Each entry replays over it exactly as §3 verifies an entry: a `revoke` or `checkpoint` suffix must attach and fold, a `reset` chain must fold. On a page that continues exactly from that responder's progress, the first entry that does not ends that responder's evidence. A page that does not continue it (a cursor mismatch, such as an answer to an older repeat) is not an end of evidence: it is dropped, and the next repeat asks from the progress the rejoiner holds. Each `rev x=D` so authenticated adds D to the attempt's **carried revocations**, which gate (b) reads and which are kept (*Learned revocations*). A carried `reset` chain also joins the selection as a candidate. An entry's `revoked` list is the publishing member's claim, so cascades are not taken from it: gate (b)'s chain-issuer term covers them. A responder can only add deny this way, never remove it.
    - **Pages.** One answer holds the log's events and the evidence entries in order while its frame passes the whole-frame check (§3), and at least one item when any remains, since every event and every entry fits alone (§3, *Bound*). `more` says the log or the evidence continues. No frame over the hub cap is published (§3); an answer that fails the check on receipt is discarded unread. Responders fold their log and drop skipped `crit: false` events before paging (R9-I3), so pages and cursors describe only the authenticated spine. A page that holds a skipped event, or that sets `more` but carries neither an advancing event nor an evidence entry, is invalid: the rejoiner discards it and ends that responder's transfer at its last valid page. Paging uses the existing ask and reply. A page that advances the rejoiner's candidate and sets `more` makes it repeat `recoveryConfirmRequest` at once, with the advanced cursor, instead of after `recoveryTimeoutMs`. Each responder answers the repeat from that cursor. The GroupInfo reply carries the first page, and the verdicts carry the rest.
    - **Progress is kept (R8-I1).** A page is classified by the ancestry of the state it continues, never by its wire `kind`. A page whose `after` is the head of the rejoiner's accepted authority (its stored log, grown by the pages it already ingested) extends that authority, so the rejoiner ingests it as soon as it arrives (*Ingest*), and its next cursor starts after it. Any other page continues a provisional branch: a `branch` page, or a `suffix` whose `after` is the cursor's `branch` head or a state before the accepted head. It stays provisional with that branch, held for the attempt only. A branch is ingested only once it is complete (`more: false`) and the one `resolveBranches` call selects it (*Selection*). A transfer of accepted authority cut short by the deadline resumes in the next attempt from the ingested head.
    - **Transfer complete (R9-I2).** A responder's transfer is complete when its latest valid page has `more: false`, when it ended on an invalid page (*Pages*), or when its branch is over the limit (*Limit*). It is **decisive** while incomplete unless its branch's generation, known from its first page, is below the head generation of a complete candidate received in the attempt and its evidence is complete: only then can its remainder change neither the selection nor a gate. A responder whose only answers bind cursors the attempt never issued stays incomplete (*Answer binding*).
    - **Delay residual.** Advisory signers' answers count as candidates, so a responder that repeats authentic history it copied, which needs no H key, or that goes silent mid-transfer, keeps its transfer incomplete on every attempt. It can delay a rejoin indefinitely: the attempt ends `'unconfirmed'` again and again, with no bound. It never causes a wrong adoption, since an incomplete decisive transfer blocks every verdict action. The accepted-authority pages it sends are kept, which shortens an honest transfer, not this one.
    - **Limit.** Only a diverging branch is limited. Branch events that coincide with the rejoiner's baseline never count: the rejoiner moves the cursor's `branch` head to the last state they share, so the responder's next answer is a suffix past it. A stale responder therefore costs bandwidth, never the limit: its pages coincide with the baseline until its own head, and its rebuilt answer is a prefix that loses. Every branch counts alike, a same-generation rival included.
      - **What counts.** Every event of a valid page advances the folded head (*Pages*), and each is signed by H's keys, since the synchronous fold fails a capability-authorised `rev`. Padding never reaches the count.
      - **Over the limit (R9-I3).** A branch is over the limit only once the rejoiner has received, from one responder in an attempt, an authenticated advancing event number 4097 past its divergence from the baseline. `more` alone never establishes it: a responder that reports `more` at event 4096 and then sends nothing advancing ends on an invalid page, and its 4096 events are carried as a complete branch. The rejoiner then stops asking that responder for the branch. Nobody without H's keys can cause this. At the settle point the over-limit branch is ignored when an authenticated candidate received in the attempt has a head generation above the over-limit branch's own (known from its first page, *Answer*): `resolveBranches` compares only the top generation, so that candidate supersedes it whatever its remainder holds. Otherwise the attempt ends `'authority-too-large'`, not `'unconfirmed'` (*Outcome*): a same-generation remainder could be duplicity evidence, so it is never ignored. The per-answer bound is a message bound, not a history horizon.
  - **Port.** `GroupMLSParams` (`mls-rpc/src/mls.ts:79-91`) gains, for lifecycle groups only:
    ```ts
    controllerLog?: (controllerID: string) => Promise<Array<SignedEvent> | null>
    ingestControllerLog?: (controllerID: string, log: Array<SignedEvent>) => Promise<Array<SignedEvent> | null>
    ```
    - `controllerLog` reads the host's accepted history for H: on the responder side for its answer, and on the rejoiner side for its baseline. `null`, an absent port or a log that does not fold is no log.
    - `ingestControllerLog` adds a log to that history. The host arbitrates it against its stored log by kokuin's rule (`authoritativeStates`, `controller/src/history.ts:71`): the log is accepted when its fold passes through the stored head or it wins `resolveBranches` against it, and a log that the stored one already extends leaves the store unchanged and succeeds. The host stores the result durably, through the same arbitration as every other writer of that history, and returns what is stored.
    - The host keeps only the log: no deny knowledge outlives the log that carries it. A legitimate reset branch that replaces the stored log ends the earlier generation's deny with it, by design (Goal, *A reset is a fresh start for H's log*). That is why an equal-head representation change can lose nothing the gate reads (R8-I2), and why a responder's answer log carries everything a rejoiner needs to reproduce its judgment (R8-I3).
    - A failed ingest is `null`, a throw, an absent port, or a returned log that neither passes through the ingested log's head nor wins `resolveBranches` against it.
    - The third lifecycle port, `learnedRevocations`, keeps the group revocations a rejoiner authenticated (*Learned revocations*).
  - **Selection.**
    - **Baseline.** The baseline is the rejoiner's accepted authority: `controllerLog(H)`, its own leaf's prefix and the recorded log its last-known ledger derives (§3, *Proof checkpoint*), resolved with `resolveBranches`.
    - **Candidates.** Each answer is rebuilt: a `suffix` appended to the head it names, which the rejoiner holds, and a `branch` as sent. It is folded with the synchronous `foldLog(H, …)` (kokuin `controller/src/fold.ts:482`), so a capability-authorised `rev` fails it, and an answer that does not fold is dropped. An answer counts whoever sent it, advisory signers included.
    - **One call.** At the settle point (*Adopt after the settle round*), the rejoiner calls `resolveBranches(H, [baseline, ...candidates])` (`controller/src/supersede.ts:351`) once, over every candidate received in the attempt. It never decides on an earlier pairwise comparison. So a recovery-key reset received late still settles a same-generation duplicity, because `resolveBranches` compares only the top generation (`supersede.ts:425-426`). The winner is the selected log: the baseline, or a log that extends or supersedes it. A failure, `duplicity` included, means no authority: a forked log is never accepted, even when the baseline is one side of the fork.
    - **Why it holds.** The log is self-certifying, since its inception digest is H (`fold.ts:427-447`). A withholding peer cannot shorten what an honest peer supplies, and nobody without H's keys can forge a longer log.
  - **Ingest (R7-I2).** Authority the rejoiner accepts is never lost, across candidate replacement, failed attempts and restart.
    - Before it acts on any verdict judged with a selected log (adoption, `superseded` or a refusal), the rejoiner calls `ingestControllerLog(H, selected)`, unless the selected log is the one `controllerLog` returned. It gates with the authority the call returns.
    - A failed ingest means no action. No verdict is acted on, and the attempt ends `'unconfirmed'` at its deadline.
    - Pages that extend accepted authority are ingested on arrival; provisional branches only once complete and selected (*Transfer*, *Progress is kept*).
    - Each later attempt reads the ingested log back through `controllerLog` as its baseline. A rejoiner that learned a revocation and then failed or restarted therefore still holds it when only the old answer arrives, until a reset that H signed ends it (Goal).
  - **Learned revocations (R10-I4).** A group revocation the rejoiner authenticated as evidence (*Revocation evidence*) is group-scoped recovery state. It survives failed attempts, candidate replacement and restart, and every later attempt's gate (b) registry term reads it until an adopted ledger records that DID revoked. No reset ends it: the group's record is permanent (Goal).
    - **Where it persists.** No kumiai store holds it today: a handle restores from the ts-mls state and the ledger tokens the host persisted (`restoreGroup`, `mls/src/group-create.ts:89-110`), and the anchor slot belongs to `@kumiai/rpc`, which does not judge authority. So `GroupMLSParams` gains, for lifecycle groups only, `learnedRevocations?: { list(groupID: string): Promise<Array<LearnedRevocation>>; add(groupID: string, entries: Array<LearnedRevocation>): Promise<void>; drop(groupID: string, dids: Array<string>): Promise<void> }`, with `LearnedRevocation = { did: string; token: string; position: number }`: the revoked DID, the signed ledger token that carried it, and its ledger position. The host stores it with the group and clears it when the group is deleted.
    - **Use.** Each attempt starts its carried revocations from `list`. Before it acts on any verdict judged with a carried revocation the port does not yet hold, the rejoiner calls `add` and awaits it. A failed `add`, or an absent port, means no action and an `'unconfirmed'` end, as a failed ingest does. Once an adopted handle's registry records a learned DID revoked, kumiai calls `drop` for it.
    - **Cost.** The port only adds deny. A learned `rev` the group never records stays a gate (b) term for this group's recoveries on this device, which costs at most `'unconfirmed'` attempts while only that agent answers.
  - **Gate.** A signer passes only when all of these hold against the selected log's fold:
    - **(a)** it holds a leaf bound to H in the pending tree, which is the GroupInfo's tree plus the rejoiner's replacement leaf. A DID with no such leaf fails, so the tag no longer stands alone;
    - **(b)** neither its DID nor its leaf's chain issuer is in the deny set of the fold's head (`states[head].deny`, kokuin's current state), nor in the attempt's **registry term**: the union of the revocations in the registry folded from the reply's ledger, the carried revocations (*Revocation evidence*) and the learned revocations (*Learned revocations*). An un-revoke H signs counts in the head term; a revocation the group's ledger recorded stays terminal through the registry term (Goal), even when the reply's ledger is stale, since one honest responder's evidence carries it. The union only adds deny, so it never opens a hole. A deny from before a reset does not survive the reset, by design: gate (c) refuses every pre-reset grant, and an agent H re-grants after the reset passes (Goal);
    - **(c)** its leaf's generation (§2) is at least the generation of the fold's head;
    - **(d)** its leaf is not lapsed at `max(treeTime(pending), now − 300 s)`, where `now` is the rejoiner's clock. The wall-clock term is a rejoiner-local trust decision, like the author-side checks (§2). Without it, the bounds in *Residual* below would not hold while tree time stalls (Goal). The 300 s skew matters only at the expiry boundary. An honest confirmer that it refuses costs an `'unconfirmed'` retry, never safety.
  - **Use.** In `applyRecovery`, after `assertResponderIsMember` (`mls/src/recovery.ts:581-622`), the GroupInfo attestation signer is gated against the selection over the baseline and the reply's answer. A failing reply is refused like any untrusted one. That is an optimisation: it saves a publish. The safety argument is the verdict gate, which applies to every confirmation signer and to every `superseded` or `refused` signer. A verdict whose signer fails it is advisory (epoch-change §1). That also closes the stale-signer refusal veto (R6-I2) in lifecycle groups.
  - **Adopt after the settle round.** A lifecycle rejoiner never adopts on the first confirmation. The first verdict opens the epoch-change spec's settle round. The round stays open while transfer pages keep advancing a candidate, up to the deadline. At its end, or at the deadline if that comes first, the rejoiner first checks the transfers: if any decisive transfer is still incomplete (*Transfer complete*), it neither adopts nor acts on an authoritative refusal or `superseded`, and the attempt ends `'unconfirmed'`, keeping the accepted-authority pages it ingested for the next attempt. A complete stale answer from another responder never conceals an unfinished one. Otherwise it selects the log from every answer received, ingests it, and gates every verdict. Only then do the precedence rules apply. If no responder's rebuilt answer passes through the baseline head or supersedes it (an empty `suffix` after the baseline head counts), nothing is authoritative and the attempt ends `'unconfirmed'`, retried on backoff. The cost is one `recoveryTimeoutMs` on every lifecycle rejoin.
  - **Residual.**
    - All honest members are offline, or cannot judge the commit, and only revoked members answer. Their own pre-`rev` logs pass, so a revoked confirmer is accepted until the rejoiner's clock passes its leaf's `exp` plus the 300 s allowance (gate d). That is at most 7 days and 300 s after its last grant. This holds only while the rejoiner has not yet learned the `rev`: once learned, it is ingested and kept (*Ingest*).
    - After a reset, a revoked agent counts again only under a new-generation grant from H, directly or from a trusted agent under its own new-generation grant. H must revoke again anyone it does not want back; until that `rev` reaches a member, the window above applies.
    - An agent that removed itself and later turns hostile is in no deny set. Its `exp` plus the allowance bounds it in the same way.
    - Between H signing `rev` and the first honest member holding it, in its host store or as a ledger proof, the revoked agent still counts. This is the accepted eventual-consistency window (Goal).
    - A responder repeating authentic copied history, or going silent mid-transfer, can delay a rejoin indefinitely, never make it adopt wrongly (*Delay residual*).
    - A hub that forks its readers stays the epoch-change spec's residual.

    Responders must therefore hold H's latest log. The consumer ingests a log into the store behind `controllerLog` before it publishes a revoke proof from it (Consumer contract).
  - **Other groups.** They have no controller and no gate. R6-I1 stays open there, as on main, so this is not a regression. It is filed as a follow-up for the kumiai recovery workstream.

**Invites in a lifecycle group.** Today the invite path needs a role entry three times: the inviter guard (`group-commit.ts:114-116`), the recipient binding (`:400-412`) and the Welcome check (`group-welcome.ts:53-69`). A lifecycle group rejects role entries, so each is replaced:
- `Invite` gains `recipientDID`. The invite still carries the group's whole ledger, and the joiner still checks it against the authenticated head, so the history reaches the joiner without any new role grant. The consumer transports the invite, so its size is the consumer's to carry: with entries of up to 512 KiB (§3, *Bound*), a long ledger outgrows one hub frame. Open: the invite could carry a ledger cursor and let the joiner gather pages as a rejoiner does (*Ledger pages*).
- `createInvite` takes no `permission` in a lifecycle group and signs no role entry. Its guard is that the inviter holds a leaf in the group, instead of a registry-derived admin role. It takes optional `entries`: consumer (non-`kumiai.*`) entries the inviter signed, appended after the history so they ride the Add commit.
- `commitInvite` binds the key package to `invite.recipientDID` (the same `InviteRecipientMismatchError`), runs the entry checks and the author-side checks on the key package leaf, and enacts only the appended consumer entries. `commitWithEntries`'s admin guard (`group-commit.ts:194-199`) becomes, in a lifecycle group, "the committer holds a leaf".
- `processWelcome` requires `invite.recipientDID` to be the joiner, that the joiner's own binding names the anchor's controller, and that every leaf in the tree is bound to it.
- **One-time consent.** A leaf capability is reusable until it expires, so it is not consent to one admission. The consumer's per-group consent stays its own: the admitting member checks the consent and that its ID is not yet consumed, then passes a consumer entry recording the ID in `entries`. That entry lands in the same commit as the Add, so the admission and the consumption are one epoch and a concurrent second admission loses the epoch race and sees the ID consumed on retry. kumiai does not interpret the entry.

**Lifecycle helpers.** `renewLeaf` and `removeLapsedLeaves` follow the existing write-result contract (`DeviceWriteResult`: `commitMessage`, `newGroup`, `epoch`). A proof is published by a **revocation run**, because it may take several commits.
```ts
renewLeaf(group: GroupHandle, binding: ControllerBinding): Promise<DeviceWriteResult>

removeLapsedLeaves(group: GroupHandle): Promise<{ removed: Array<string>; result?: DeviceWriteResult }>

// @kumiai/mls: derives the run's next commit from the handle; never publishes
nextRevokeStep(
  group: GroupHandle,
  params: { subject: string; log: Array<SignedEvent> } | { reset: true; log: Array<SignedEvent> },
): Promise<
  | { status: 'step'; kind: 'reset' | 'checkpoint' | 'revoke'; final: boolean; result: DeviceWriteResult }
  | { status: 'already-revoked' }
  | { status: 'self-affected'; subject: string }
  | { status: 'not-provable'; reason: RevokeProofReason }
>

// @kumiai/mls-rpc: runs the steps through the group's commit lane
publishRevokeProof(
  peer: GroupPeer, mls: GroupMLS,
  params: { subject: string; log: Array<SignedEvent> } | { reset: true; log: Array<SignedEvent> },
): Promise<
  | { status: 'committed'; steps: number; epoch: number }
  | { status: 'partial'; steps: number; cause: unknown }
  | { status: 'already-revoked' }
  | { status: 'self-affected'; subject: string }
  | { status: 'not-provable'; reason: RevokeProofReason }
>
advanceCheckpoint(peer: GroupPeer, mls: GroupMLS, params: { log: Array<SignedEvent> }):
  Promise<{ status: 'advanced' | 'partial'; steps: number; cause?: unknown }>
```
- **Ownership.** `renewLeaf`, `removeLapsedLeaves` and `nextRevokeStep` run under the group mutex, judge locally, and return a commit and a derived handle. They neither mutate the input handle, persist, publish nor retry. Only the run publishes, and only when the host calls it: kumiai never starts a run, a step or an advance on its own.
- **A derived handle is speculative until adopted.** Constructing or discarding one leaves the input handle and its subscribers untouched:
  - **Own auth state.** Today the constructor re-points the context's shared deny holder at the newest handle (`group-handle.ts:345-349`), and `deriveGroup` shares the context (`:1423-1434`). So a candidate revoking T makes the live handle reject T-issued credentials before the group accepted anything, and a discarded candidate leaves that in place. Instead `deriveGroup` gives each handle its own context: the cipher suite is shared, the authentication service and its deny provider are the handle's own.
  - **No early events.** Helpers no longer fire events on the derived handle. Today `revokeDevice` and `announceControllerBeacon` do (`group-device.ts:173`, `:203`), before any transport accepted the commit. The derived handle holds its enacted control events as pending, and `newGroup.confirmAdopted()` fires them once; later calls do nothing, and a handle never confirmed fires nothing. `HandleAccess.replace` calls it after the host adoption callback resolves; a host that adopts outside `HandleAccess` calls it itself.
- **The consumer's part.** For `renewLeaf` and `removeLapsedLeaves`, the consumer publishes `commitMessage` and adopts `newGroup` once its transport accepts the commit. If another commit wins the epoch, it discards `newGroup`, processes the winner, and calls the helper again on the new handle. A revocation run does this itself through the lane.
- **Revocation run (R10-I1, R10-I5).** `log` is H's log as the host holds it. Each step is one ordinary `commit()` on the group's peer (`rpc/src/peer.ts:2174`) whose build calls `nextRevokeStep` on the then-current handle, so a step that loses the epoch race is rebuilt against the new checkpoint, and two members running at once converge: each step continues from whatever the other landed, and after the winning revoke the other run returns `'already-revoked'`. `nextRevokeStep` strips skipped events and derives, against its handle's ledger (§3, *Proof checkpoint*):
  - the final `revoke` (or, for `{ reset: true }`, the `reset`) when it fits: the suffix after the checkpoint up to the `rev`, or a first chain;
  - otherwise the next step toward it. In a group with no checkpoint whose H log holds a reset, that is a `reset` entry carrying the shortest chain `[icp, reset, …]` that fits. Otherwise it is a `checkpoint` holding the longest run of events after the checkpoint that holds no `rev` and no reset and fits. At a `rev x=E` for another subject the group has not recorded, it is that `revoke`, carrying the suffix up to it. A `rev` whose subject the group already records revoked rides inside the next `revoke`'s suffix (§3, *Horizon*).
  "Fits" means both the entry bound and the whole-frame check (§3): the step is built, measured as the frame the lane will publish, and cut back until it passes.
  - It returns `'not-provable'` with `too-large` when no step can fit (a single event, or the span §3's *Horizon* names), with `detached` when `log` neither passes through the checkpoint nor supersedes it by a reset, with `needs-reset` when a `revoke`'s log is at a generation above the checkpoint's (the caller runs `{ reset: true, log }` first, then reruns the revoke), and otherwise as §3 fails. It returns `'already-revoked'` when every DID the target revoke would revoke is already revoked and no affected leaf remains, and `'self-affected'` with the subject when the caller's own leaf is in the derived set of the target or of an intermediate `revoke`, so another member must run it.
  - It also commits a proof for a subject with no leaf, so the deny set closes later joins.
- **Run result.** `'committed'` when the target entry landed, with the number of steps. `'partial'` when a lane failure (the deadline, a publish failure, a strand) ends the run after zero or more steps landed: the landed steps stay in the ledger, nothing is undone, and a rerun derives from the new checkpoint and continues. The other statuses are terminal and end the run where it stands; steps already landed stay. Each step's `LaneResult` reaches the host through the lane as for any commit.
- **The outbox holds for the run.** From the first step until the target revoke lands, the run ends with a terminal status, or the peer restarts, the group's outbox worker publishes no log frame (the delivery spec's §4, step 2, as for a stranded peer). The run sets the hold through a new `GroupPeer.holdLogSends()`, which returns its release. The hold outlasts a `'partial'` end, so it covers the rerun. That is what "removal before the next broadcast" means: no log frame this member queued for the group is published between the start of the run and the landing of the revoke. Ephemeral and directed frames never enter the outbox and are not held, which the eventual-consistency window already covers (Goal). After a restart the hold is gone until the host reruns.
- **`advanceCheckpoint`** runs `checkpoint` steps only, from the group's checkpoint along `log`, stopping before the first `rev` or reset, or at the log head. It sets no outbox hold. It lets a host keep the interval before a future revoke short; it is optional, and kumiai never calls it.
- **`removeLapsedLeaves`** removes every lapsed leaf, adding a `clock` entry when required. It returns `{ removed: [] }` with no result when there is nothing to remove.

**Reads and events:**
- `revocationOf(group, did)` returns `{ controller, logPosition, reason?: 'reset', cascadedFrom? } | null`.
- `GroupHandle.sendAdmission()` and `HandleAccess.admission()` (§2).
- `deviceRevoked` gains `logPosition`, `reason` and `cascadedFrom`. It fires once per listed DID at accepted adoption only: a received commit after it is persisted (`#notifyAccepted`, as today), an authored commit at `confirmAdopted()`, and `bootstrapLedger` for the entries it adds. Restore and Welcome project the records, deny set and floors silently, as today; the consumer reads them with `revocationOf`.

**Errors.** These are error classes, following kumiai's convention, and each carries a `reason`.
- `LeafBindingError`, with reasons `issuer-mismatch`, `subject-mismatch`, `chain-depth`, `self-issued`, `child-outlives-parent`, `denied-issuer`, `lifetime-cap`, `generation-floor`, `identity-change`, `controller-mismatch` and `floating-refused`.
- `LeafLapsedError`.
- `RevokeProofError` with `RevokeProofReason`: `no-rev`, `wrong-controller`, `not-authority-signed`, `generation-floor`, `too-large`, `detached`, `needs-reset`, `effects-mismatch` and `removes-mismatch`. It is used on the authoring path, and `nextRevokeStep` maps it to `'not-provable'`. On receive, an entry over the bound, a `checkpoint` holding a `rev` or reset, an empty one, or one that does not attach is rejected.
- `FrameTooLargeError` (`@kumiai/rpc`): a frame that fails the whole-frame check (§3); nothing was journalled or published.
- A commit rejected on receive goes through the existing `CommitRejectedError` path.

### 6. kokuin

In `@kokuin/capability`:
- `createCapability` (`delegation.ts:43`) refuses a delegated child whose `exp` is later than its parent's, or that has no `exp` while its parent has one.
- `assertValidDelegation` (`delegation.ts:107`), which `checkCapability` and `checkDelegationChain` call, rejects the same.

That is the only kokuin change. Deterministic verification needs nothing new: `verifyToken` takes `atTime` (`token/src/token.ts:41`), `checkCapability` threads `atTime` through the whole chain (`delegation.ts:215-263`, `:275`), and `getVerifier` is exported. The patch releases before the kumiai change.

### 7. Release and compatibility

- kumiai ships as patch versions within the current version band, with no anchor version change.
- It is a coordinated breaking change, and peers must run the same release:
  - old peers reject a revoke that carries a proof, and the `reset` and `clock` ops;
  - old peers silently ignore `GroupAnchor.controller`, so they would apply none of the lifecycle rules;
  - pinning the issuer rejects any self-issued leaf capability;
  - the time-free auth service accepts expired existing leaves that old peers refuse.
- API breaks for the consumer: `Invite.recipientDID`, `createInvite` without `permission` in lifecycle groups, the synchronous `HandleAccess.admission()`, `confirmAdopted()`, helpers no longer emitting before adoption, and recovery: `GroupMLSParams.recoveryBinding`, `GroupMLS.prepareRecovery`, the widened `applyRecovery` result, `RecoveryFailureReason` `'renewal-required'` and `'authority-too-large'`, the lifecycle refusal reasons in the confirm-before-adopt refusal, a sealed GroupInfo reply that carries the first ledger page and the authority answer in lifecycle groups, paged ledger replies continued by `ledgerRequest` with a ledger cursor, `GroupMLSParams.controllerLog`, `GroupMLSParams.ingestControllerLog`, `RecoveryRequest.authority`, the authority cursor on `recoveryConfirmRequest` (with its `ledger` and per-responder `evidence` progress, replacing `revocationsAfter`), a verdict token that carries the paged authority answer, revocation evidence (`checkpoint` entries included) and the `answered` cursor binding in lifecycle groups, `GroupMLSParams.learnedRevocations`, proofs published as suffixes against the group's checkpoint, the `kumiai.device` `checkpoint` op, the 512 KiB entry bound, the whole-frame check and `FrameTooLargeError`, `publishRevokeProof` as a run over the commit lane (`nextRevokeStep` in `@kumiai/mls`, the run and `advanceCheckpoint` in `@kumiai/mls-rpc`, `GroupPeer.holdLogSends()` in `@kumiai/rpc`, and the `'partial'` result), and `RevokeProofReason` `detached` and `needs-reset`. The request, reply and token changes are wire changes, so responders and rejoiners must run the same release. A responder without the authority answer leaves every lifecycle rejoin `'unconfirmed'`. A rejoiner without `ingestControllerLog` cannot act on any log beyond its stored one, and one without `learnedRevocations` acts on no verdict judged with carried revocations, so the consumer supplies all three ports. These add to the `@kumiai/mls-rpc` and `@kumiai/rpc` patches the epoch-change spec releases.
- The consumer adopts the kokuin and kumiai releases together.

## Consumer contract

This release ships with the epoch-change delivery spec (`kumiai.worktrees/epoch-change-log-delivery/docs/superpowers/specs/2026-10-03-epoch-change-log-delivery-design.md`), and kubun adopts both in one bump. Paths: `C` is kubun's spec (`kubun-wt/catalog-sync/docs/superpowers/specs/2026-09-27-catalog-sync-design.md`), `P` its plan (`.../plans/2026-09-27-catalog-sync.md`). `C` names the controller C and the group H (§5, opening). Below, H is the controller, as in the rest of this spec. References name `C` §5's bullets and `P`'s tasks rather than lines, which move.

**Delivery.** The epoch-change spec's Release list (its kubun items) is the authoritative delivery checklist, and this spec does not repeat it. kubun carries it as `P` Task I6.

**Own-agents groups.** `C` §5 and `P` Task 13a+13c carry the lifecycle obligations below. Each must hold after the bump.
1. **Creation** (`createOwnAgentsGroup`). It passes the creator's `ControllerBinding`, so the anchor's controller is the creator's leaf controller. The label is required.
2. **Membership** (*Membership is the tree*). Effective membership is a live leaf bound to H in the tree. The current-head check stays a local refusal, never an MLS acceptance input.
3. **Admin semantics** (*Every member is an admin, and nobody evicts*). Every member may admit agents and enact kubun's ledger entries. No member removes another except by proof, lapse or self-removal, and kubun offers no discretionary removal. No device registers.
4. **Revocation** (*Revocation is a proof from C*, *No broadcast hold*). Any member that obtains H's `rev x=D` runs `publishRevokeProof` in every own-agents group of H, including groups where D has no leaf. The run may land several commits (`checkpoint` steps, then the revoke), and kumiai holds the member's outbox for the group until the revoke lands (§5, *Revocation run*): that is "removal before its next broadcast". kubun adds no hold of its own. Before it publishes a proof, it ingests that log into its controller store (the store behind item 11's ports) through the same arbitration as `ingestControllerLog`. The device that signs a `rev` or reset ingests it at once. Rejoiners then find the log on every honest responder (§5, *Controller authority*). The helper's input stays H's log as stored; kumiai derives the proof against the group's checkpoint (§3, *Proof checkpoint*). On `'partial'` it reruns at once, and again on each reconnect of that group's hub, until the run ends otherwise; progress is in the ledger, so a rerun continues. On `'not-provable'` with `needs-reset` the member runs `{ reset: true, log }` first and then reruns the revoke; with `detached` its stored log does not reach the group's checkpoint, and it reruns once its controller store holds a log through it; with `too-large` (a single event over the entry bound, or the open case of §3's *Horizon*) it reports it, and H's reset is the documented path. A `'self-affected'` result names the subject another member must publish for. kubun may call `advanceCheckpoint`; nothing requires it.
5. **Permanence** (*Permanence*). A revoked agent DID is never re-admitted, and a reset revokes the earlier generation.
6. **Lapse and renewal** (*Lapse and renewal*). A named operation obtains fresh capabilities and calls `renewLeaf` before `exp`. H's signing cadence is the lapse granularity.
7. **Unresolved head and advisory notice** (*Unresolved head and advisory notice*). Both stay local. The beacon gates nothing.
8. **Adoption and events** (*Commits and adoption*). kubun publishes every `renewLeaf`, `removeLapsedLeaves` and `commitInvite` commit, adopts on acceptance and reruns after a lost race; a revocation run publishes and rebuilds its own steps through the lane, and kubun adopts them through `HandleAccess` like any lane commit. Every adoption calls `confirmAdopted()`. After restore or Welcome, kubun reads `revocationOf`.
9. **Three contracts** (the three admission contracts after the bullets). Leaf binding, group invite consent through `recipientDID` and `entries`, and the advisory head stay separate.
10. **Recovery binding** (*Recovery binding*). kubun's `createGroupMLS` wrapper (`plugin-p2p/src/groups/group-mls.ts:90`) passes `recoveryBinding` to the upstream factory for every own-agents group. It returns a fresh binding for the peer's own leaf key, with a leaf capability from H or from T, or `null` when none is available now. It never waits on the user. On `'renewal-required'`, including a responder's `'binding'`, `'lapse'` or `'floor'` refusal (§5), kubun reports it, obtains a grant through item 6's path, and then calls `recover()` on that group's peer. On `'refused'` (`'policy'` or `'invalid'`) kubun reports it and calls `recover()` only once the cause has changed. On `'authority-too-large'` kubun reports it and calls `recover()` once its controller store holds H's history by another path. kubun adds no recovery timer.
11. **Controller log** (*Revocation is a proof from C*, *Recovery binding*). The same wrapper passes `controllerLog` and `ingestControllerLog` for every own-agents group (§5, *Controller authority*, *Port*).
    - `controllerLog` answers H's latest accepted log from kubun's controller store (`ControllerStoreAPI.get`, kubun `packages/store-controller/src/api.ts:25`), or `null`.
    - `ingestControllerLog` arbitrates a log against the stored one, persists the result, and returns what is stored. kubun keeps no deny knowledge beside the log (*A reset is a fresh start for H's log*). Every writer of the controller store, including resolver writes and item 4's ingest, goes through that one arbitration, so a delayed write can never replace a log that carries a later revocation.
    - Neither fetches over the network or waits on the user. Item 4's ingest rule keeps the store current, and recovery's own ingest keeps what a rejoin learned.
    - No hub-hosted log service and no hub topic for H's log are added: the hub stays blind and holds no authority.
12. **Learned revocations** (*Controller authority on rejoin*). The same wrapper passes `learnedRevocations` for every own-agents group (§5, *Learned revocations*). kubun stores the list per group in its P2P store, durably before `add` resolves, never beside the controller log, and deletes it with the group. It keeps no other deny state.

## Testing

Each test must fail with its fix removed.

**F1 and verification**
- A self-issued leaf capability naming a foreign controller is rejected (`issuer-mismatch`). The probe's escalation fails at its first step.
- A manage capability with a `sub` other than the profile is rejected.
- Two receivers whose mocked clocks straddle the `exp` and `nbf` of each chain link, and of a management capability in a non-lifecycle group, reach the same verdicts on the same commits.
- A child signed by a key other than the parent's `cnf`, under T's DID, is rejected.

**Chains**
- A leaf capability issued by T is accepted.
- These are rejected: depth 2, a child that outlives its parent, `sub` other than H, a denied T, a parent over 365 days, and a child whose `aud` is T.

**Tree time (C1, I5)**
- **Adversarial:** a stolen T mints a child with a far-future `iat` and admits it. `treeTime(H)` is unchanged, no honest leaf becomes lapsed, and a lapse Remove of an honest leaf is rejected.
- A new direct grant from H advances tree time and lapses older leaves.
- Removing the leaf holding the newest time without a `clock` entry is rejected; with one, the floor holds and lapsed leaves stay lapsed.
- **Floor dominates (R-I1).** Leaves attest 100 and 90 with floor 0. Removing the first installs floor 100. A following non-rotating commit and a renewal of the surviving leaf at attested time 95 are both accepted with no `clock` entry, and tree time stays 100.
- A chained renewal whose trusted grant is older than the replaced direct grant, when that leaf held the maximum, is rejected without a `clock` entry and accepted with one carrying the pre-commit tree time. A `clock` entry with any other time in that commit is rejected.
- With no new H grant for months, nothing lapses. This documents the stall.

**Lifecycle groups (C2, I7, I8)**
- A capability revoke by T, and `register`, `add` and `label` entries, are rejected in a lifecycle group.
- A group is created with a controller binding. A second agent is admitted with no device role, and the joiner's Welcome check passes. A floating or foreign-bound leaf is refused by Add, by external join and at Welcome.
- **Invite path (R-I2).** H's creator agent invites a second agent with `createInvite` and `commitInvite`: no role entry is signed or enacted, the key package is bound to `recipientDID`, and a key package for another DID raises `InviteRecipientMismatchError`. The joiner's `processWelcome` accepts the invite by `recipientDID`, and refuses one naming another DID.
- A consumer entry passed in `entries` lands in the Add commit. Two members admitting the same recipient with the same consumed-ID entry: one commit wins, and the loser's retry sees the entry in the ledger.
- A consumer entry issued by a DID with no leaf in the pre-commit tree is rejected.
- A controller-role-only agent resyncs externally. A replacement that changes key, goes floating, or names another controller is rejected.
- A malformed `GroupAnchor.controller` makes the group refused.

**Registry agreement (C3, other groups)**
- P's manager registering an unregistered Q-bound DID as P's is rejected.
- An `add` entry whose Add carries a leaf bound to another controller is rejected.
- Registering a floating subject is rejected for anyone but the subject after it binds.

**Generation floor (C4)**
- After a reset, a previously absent DID presenting a stale-prefix grant is refused by Add and by external join.
- After a reset, a `rev` from the old generation is rejected.
- A rotation keeps earlier grants valid.
- Restore and Welcome rebuild the floor.

**Proven revoke and replay (I1, I6)**
- A member that holds no admin role publishes a proof: the epoch rises by one, D's leaf is gone, and `revocationOf` returns the log position.
- Two members publish at once: one commit wins, and the other gets `'already-revoked'` on retry.
- Rejected on receive, and `'not-provable'` from the helper: no `rev`, the wrong controller, a capability-authorised `rev`, an oversize proof, a wrong `revoked` list, and Removes that differ from it.
- A subject with no leaf gets a revoked record and is then refused at Add.
- kokuin un-revoking D later does not restore D.
- After revoking T with cascade, and after a reset, a live receiver, the author's derived handle, a restored handle and a Welcome joiner hold identical records, deny sets, floors and checkpoints.
- **Long healthy history (R9-I4).** H's log has 300 ordinary rotations, then `rev x=Mallory`. The proof is provable and is applied identically by every live member, the author's derived handle, a restored handle and a Welcome joiner that joins after it. Run twice: as the group's first proof (a 302-event chain), and after an earlier proof revoking E was accepted before the 300 rotations, when the proof carries only the 301-event suffix. Under the old 256-event full-chain bound both are `'not-provable'`.
- **Later suffix past the bound (R10-I5).** The group records a revoke of E, so its checkpoint is A. H then signs ordinary rotations whose encoded suffix exceeds 512 KiB, then `rev x=Mallory`. `publishRevokeProof` lands the `checkpoint` steps it needs and then the revoke, each frame under the hub cap. A live receiver, the author's derived handle, a restored handle and a Welcome joiner that joins after it hold identical checkpoints, records and deny sets. Under the round-9 single-entry rule it is `'not-provable'`.
- **Checkpoint entries.** A `checkpoint` holding a `rev`, holding a reset, empty, over the bound, carrying a skipped event, or not attaching is rejected on receive (`detached` on the helper). One carried with any proposal or with another entry is rejected. One accepted changes no record, deny set, floor or leaf. Any member may publish one, and one holding an event that H's keys did not sign is rejected whoever publishes it.
- **Partial run and rerun.** The hub fails the publish after two of four `checkpoint` steps landed. The run returns `'partial'` with `steps: 2`, the ledger's checkpoint is the second step's head, and no log frame the member queued for the group is published. A rerun lands the remaining two and the revoke, republishes neither landed step, and only then does the outbox publish. After a restart between the two runs, the rerun continues from the ledger the same way.
- **Two runs at once.** Alice and carol run the same revoke over the same long suffix. Every lost step is rebuilt against the new checkpoint; the ledger holds each H event once; one run returns `'committed'` and the other `'committed'` or `'already-revoked'`; no step is rejected as `detached`.
- **Intermediate `rev`.** The suffix holds `rev x=E` for an E the group has not recorded, before `rev x=Mallory`. The run lands E's revoke as a step before Mallory's. With E already recorded revoked by a reset's `revoked` list, `rev x=E` rides inside Mallory's revoke suffix when it fits, and the run is `'not-provable'` (`too-large`) when it does not (the open case).
- **Checkpoint rules (R9-I4).** A suffix that does not attach to the checkpoint is rejected, and the loser of an epoch race re-derives and lands it after the winner. A suffix holding a reset is rejected (`needs-reset` on the helper); the reset entry followed by the revoke is accepted. A single event that cannot fit an entry alone is `'not-provable'` (`too-large`), and after H's reset the reset's chain is accepted. An entry over 512 KiB is rejected on receive. A proof holding a skipped event is rejected.
- **Events at adoption.** Restore and Welcome fire no `deviceRevoked`; a live receiver fires it once after persisting; `bootstrapLedger` fires it only for entries it adds.
- Authored through the low-level API, these are rejected: revoke of T with an Add of a T-issued child, reset with a stale-generation Add, revoke with a path renewal, and two revoke entries in one commit.

**Recovery in lifecycle groups (R4-I2).** Through the real `@kumiai/mls-rpc` adapter and `@kumiai/rpc` peer, with a retention gap stranding a bound member:
- A cached binding valid by wall clock rejoins with no `recoveryBinding` call, and the replacement leaf keeps that binding.
- A cached binding expired by wall clock but live in tree time: `recoveryBinding` is called once, and the fresh binding rejoins and is accepted by survivors.
- No fresh binding (`null`, or no port): `onRecovery` reports `'renewal-required'`, and no recovery request reaches the rendezvous topic, then or on later pulls, heal triggers or worker backoff. Once the port returns a binding, `recover()` rejoins.
- A host binding that fails the recovery check (another controller, a lower `iat`, or one that lowers tree time) also reports `'renewal-required'`.
- A floating replacement, authored through the low-level API, is rejected by survivors. `joinGroupExternal` without `controller` in a lifecycle group throws `floating-refused`.
- A fresh joiner's uncovered-floor rejoin (epoch-change spec) goes through the same adapter and carries its binding.
- **Tree-lapsed but present.** A member whose leaf is still in the tree but lapsed in tree time rejoins with a fresh binding: survivors accept the external commit, and the lapsed-sender and unchanged-path-credential rules do not refuse it. The same commit authored as a member commit (a Remove plus a changed path credential) is still rejected.
- **Capability and prefix change.** A replacement whose leaf capability changes from direct to chained, and whose prefix gains a rotation, is accepted with the same `id`, key and `controller.id`; one that also changes the key is rejected.
- **Refusal reasons.** With the rejoiner's recovery check stubbed to pass, a binding below a `genFloor` that the GroupInfo's own ledger carries is published; survivors refuse it with `'floor'`: the pending handle is discarded, the held entries stay unpublished, `onRecovery` reports `'renewal-required'`, and the next attempt calls `recoveryBinding()` instead of reusing the refused binding. An `'invalid'` refusal (a replacement for a leaf L the responder's tree no longer holds, authored through the low-level API) reports `'refused'` with reason `'invalid'`, does not set `renewalRequired`, and starts no further attempt on later pulls, heal triggers or worker backoff until the host calls `recover()`.
- **Floor raised in the gap.** While a member is detached, others remove the leaf holding the maximum and install a `timeFloor` above the detached leaf's `exp`, which is still above the remaining tree's maximum attested time. Its recovery reports `'renewal-required'` and publishes no external commit. With a fresh binding above the floor, it rejoins. A reply whose ledger does not fold to the GroupInfo's head is refused.

**Controller authority (R6-I1, R6-I2).** These run through the real adapter and peer, with an honest hub. Mallory is revoked by a proof commit at E+1 after bob's last epoch E, and she kept E's secrets.
- **Regression.**
  - Bob strands behind a retention gap. Mallory seals E's GroupInfo and ledger, and bob's external commit wins the compare-and-set.
  - Mallory applies it on her E state and sends a confirmation with a valid tag and her pre-`rev` log. Alice, who holds the proof, answers `superseded` with the log carrying `rev x=Mallory`.
  - Bob does not adopt. Mallory's confirmation is advisory under gate (b), alice's `superseded` stands, and bob asks for a fresh GroupInfo.
  - Without the gate, bob adopts the obsolete branch.
  - Run twice: with alice's host store holding the log, and with it lacking the log so that alice answers from her ledger proof. Run with each verdict arriving first.
- **Lapse-removed confirmer.** Mallory was removed as lapsed instead, with her leaf's `exp` before bob's `now − 300 s`. Her confirmation is advisory under gate (d).
- **No leaf.** A confirmation with a valid tag, re-signed by a DID that holds no leaf in the pending tree, is advisory under gate (a).
- **Only revoked members answer.** Alice is offline, and bob has never learned the `rev`. Bob adopts on mallory's confirmation at a clock of exactly her `exp` plus 300 s, since the lapse predicate is strict. Just past that, her confirmation is advisory and the attempt reports `'unconfirmed'`. This pins the residual's boundary (R7-M1).
- **Learned authority is kept (R7-I2).** Alice answers `superseded` with the log carrying `rev x=Mallory`, and bob ingests it before acting. Alice then goes offline. Run three ways: the next attempt in the same process, after a restart, and after a candidate replacement. Only mallory answers, with her pre-`rev` log and a valid confirmation. Her answer rebuilds to a prefix of bob's baseline and loses, and her confirmation is advisory under gate (b), so the attempt ends `'unconfirmed'`. With a failing `ingestControllerLog`, bob does not act on alice's `superseded`, and the attempt ends `'unconfirmed'`.
- **Reset ends deny, the floor keeps the old grant out.** Bob's stored log holds `rev x=Mallory`, and a recovery-key reset branch supersedes it. After the ingest the stored log is the reset branch and holds no deny for mallory. Her pre-reset confirmation is advisory under gate (c). A mallory leaf re-granted by T under T's new-generation grant passes gates (b) and (c). Presented on the short (inception, reset) and on the long (inception, `rev x=Mallory`, reset) representation, the gate gives the same verdicts.
- **Fresh authority on resend (R7-I3).** Alice answers bob's first request with log A. Before bob's repeat arrives, alice's host ingests log B, which revokes mallory. The repeat's verdict carries B, not the cached token with A, and mallory's confirmation is advisory. The verdict and its tag are unchanged between the two replies, and the resend keeps its jitter.
- **Long healthy history (R7-I4).** H's log has 300 events from ordinary rotations, and no revocation. Bob's baseline is the inception. Alice pages the suffix, bob ingests each page, and the rejoin is confirmed in one attempt.
- **Huge baseline gap.** Bob's baseline is 2000 events behind. The suffix pages across repeats. With a deadline short enough to cut the transfer, the next attempt starts its cursor after the ingested head, and the rejoin is confirmed without restarting the transfer.
- **Branch over the limit.** Alice's log supersedes bob's baseline by a branch longer than 4096 events. The attempt ends `'authority-too-large'`, and no automatic trigger starts another attempt until the host calls `recover()`.
- **Same-generation rival (fail closed).** Bob's baseline is one side of a same-generation fork with no rotate. Alice, honest, holds the other side and answers it as `branch`. The selection reports `duplicity`, nothing is authoritative, and the attempt ends `'unconfirmed'`, even with a valid confirmation from a signer that passes the gate against bob's baseline alone. Without the rule, alice withholds the rival and bob adopts on the forked log.
- **Multi-page reset beside a rival (R8-I1).** Bob holds baseline A. Alice answers a reset branch B over two pages, so page two arrives as a `suffix` after B's provisional head. Carol answers a competing branch. Run with each responder first. Bob's store is unchanged until the settle point, page two is never ingested on arrival, and the single `resolveBranches` call selects B, which is then ingested once. With classification by wire `kind`, page two is ingested on arrival.
- **Exact limit (R9-I3).** Mallory's branch has exactly 4096 authenticated events past the divergence. Run with trailing skipped padding behind event 4096, and with a lying `more: true` on the page ending at event 4096. The branch is carried as complete and selection decides; the attempt never ends `'authority-too-large'`. Branch event 4097 delivered authenticated does end it (absent a higher-generation candidate).
- **Padding page (R9-I3).** A page carrying a skipped event, and a page carrying only skipped events, is invalid: it is discarded, that responder's transfer ends at its last valid page, and it neither repeats the request nor keeps the settle round open. Alice's honest pages carry no skipped event.
- **Deadline mid-transfer (R9-I2).** Mallory answers a complete stale log and a valid confirmation. Alice's first page extends bob's accepted authority with `more: true`, and her next page carries `rev x=Mallory`. The deadline falls just before that page. Bob neither adopts nor acts on any refusal: the attempt ends `'unconfirmed'`, the first page stays ingested, and the next attempt's cursor starts after it, receives the `rev`, and mallory's confirmation is advisory. Without the rule, bob adopts on mallory's confirmation.
- **Stale ledger and un-revoke (R9-I1).** The group records mallory's revocation at E+1, after bob's last-known epoch E. H then signs a same-generation un-revoke of mallory. Mallory seals E's GroupInfo and ledger, applies bob's external commit on her E state and confirms. Alice answers `superseded` with H's latest log and her evidence carrying the E+1 revoke entry. The selected head no longer denies mallory and the reply's ledger predates the revocation, but the carried revocation puts her in gate (b)'s registry term: her confirmation is advisory and alice's `superseded` decides. Run with each verdict first. An evidence entry whose suffix does not attach to bob's recorded log adds nothing. Without the carried revocations, bob adopts.
- **Forged cursor (R10-I2).** As in the stale-ledger regression, mallory copies bob's `recoveryConfirmRequest` and republishes it with the evidence position moved past the E+1 revoke entry. Alice answers it honestly, and every answer of hers to bob's own requests is dropped. Bob discards her answer, since its `answered` digest is no cursor he issued, and her transfer stays incomplete: he does not adopt on mallory's confirmation, and the attempt ends `'unconfirmed'`. Without the binding, bob adopts.
- **Late responder (R10-I3).** Carol's evidence has advanced to position 100. Dave answers late on `base: 'start'`: his first proof chain is at 20 and a later revoke suffix of mallory at 120. Dave's answer starts at 20, both authenticate, and mallory's confirmation is advisory. With a shared watermark, dave's 120 does not attach, his evidence ends, and bob adopts. A page of dave's answering an older cursor is dropped without ending his evidence.
- **Learned revocation kept (R10-I4).** As in the stale-ledger regression: bob authenticates alice's evidence and refuses mallory, then the attempt fails before adoption; in a second run bob restarts instead. In the next attempt only mallory answers: `learnedRevocations` returns mallory, her confirmation is advisory, and the attempt ends `'unconfirmed'`. With a failing `add`, bob acts on no verdict in the first attempt. After bob adopts a ledger that records mallory's revocation, she is dropped from the port.
- **Paged ledger.** The responder's ledger exceeds one frame. The GroupInfo reply carries the first page; bob gathers the rest with `ledgerRequest` before he publishes, and his recovery check and gate (b) read the complete ledger. A responder whose pages fold past a different head is dropped, and another's pages complete it. `ensureLedger` bootstraps from pages the same way.
- **Oversized obsolete branch (R8-I4).** Carol answers a branch over the limit at the baseline's generation, and alice a short reset branch at a higher generation. Run with each first. The over-limit branch is ignored, the reset branch is selected, and the rejoin is confirmed. Without alice, the attempt ends `'authority-too-large'`.
- **Late reset settles duplicity.** Two same-generation rival answers arrive first, and a reset branch that supersedes both arrives later in the settle round. The single `resolveBranches` call selects the reset branch.
- **Truncated answer.** Mallory's answer stops before the `rev`, and alice's is longer. The selection keeps alice's, whichever arrives first, and mallory's confirmation is advisory. An answer that neither extends nor supersedes bob's accepted authority cannot authorize a verdict, even when it is the only one; it stays as rival evidence for the complete-set selection.
- **No authority answer.** Every responder's `controllerLog` returns `null` and its ledger holds no proof, so each answers `none`, or each sends an answer over the per-answer bound, which is discarded unread. A confirmation with a valid tag does not adopt, and the attempt ends `'unconfirmed'`, retried on backoff.
- **Stale refusal.** Mallory's correctly bound `refused: 'policy'` arrives first, and she is in the pending tree because the GroupInfo was sealed before her removal. It is advisory under gate (b), and bob adopts on alice's confirmation after the settle round.
- **Attestation signer.** Mallory's GroupInfo reply is refused by gate (b) when bob's baseline already holds the `rev`, and no external commit is published.

**Pipeline (I3, I4)**
- A renewal and a lapse Remove go in separate commits. Combined in one commit, they are rejected.
- A commit with an invalid path that removes a receiver: survivors reject it and keep their state, ledger and events, and the old epoch still decrypts. The removed receiver's outcome is the documented residual.
- An always-accept caller policy does not admit an identity-changing Update, a floating Add into a lifecycle group, or a lapsed Add.
- **Speculative handles (R-I3).** A member builds a revoke of T with `publishRevokeProof` and loses the epoch race. On the original handle, a T-issued credential still validates, and no `deviceRevoked` has fired. After the winning commit is processed, it fires once. For a won race, it fires at `confirmAdopted()` and not before; a second call fires nothing.

**Renewal (M2)**
- A renewal after the old `exp` succeeds, and a renewal with a lower `iat` is rejected.
- A delayed message from the old epoch still decrypts after the renewal.
- A pending Add is not absorbed, and the commit carries a path.

**Lapse and sending (I10)**
- A lapsed member gets `admissible: false` from `sendAdmission`, and `encrypt` refuses. Receivers refuse a lapsed sender's frame before opening it.
- **Admission without a lock (R-I9).** Against real `@kumiai/mls-rpc` with `simpleHandleAccess`, a host adoption callback inside `replace` awaits `GroupMLS.sendAdmission()` and then the rpc `dispatch`: both resolve, the adoption completes, and the admission reports the pre-adoption epoch. After `replace` resolves, it reports the new epoch with its own verdict.
- After renewal, the member can send again.
- A lapsed member's non-renewing commit is rejected.
- Lapse removal works from any member.

**Size and the wire (R10-I1).** In `@kumiai/integration-tests`, through `@kumiai/hub-server` and `HubClient`:
- A realistic first proof (icp, two rotations, rev) with Ed25519 stays under 2 KiB.
- A revoke whose entry is exactly 512 KiB publishes, and every receiver applies it. A commit whose frame is one byte over the cap fails with `FrameTooLargeError` before it is journalled, and the hub receives no request. The run instead cuts the step and lands it in two.
- A verdict carrying one 512 KiB evidence entry is published, delivered and opened. A ledger reply and a GroupInfo reply whose ledger exceeds the cap are paged, and every page is accepted by the hub's schema.

**Conformance**
- Both conformance suites pass.

**kokuin**
- `createCapability` and `checkCapability` reject a child that outlives its parent.

## Docs

- `docs/reference/reserved-namespaces.md`: add `kumiai.device`, with its ops `register`, `add`, `revoke` (with and without proof), `reset`, `checkpoint`, `clock`, `label` and `beacon`, the 512 KiB entry bound, and the lifecycle-group restrictions. The file is missing it today.
- The anchor reference documents `controller` and the exact-version requirement.
- A security section in the mls reference covers the accepted tradeoffs in the Goal section:
  - revocation is permanent in a group's ledger while kokuin can un-revoke;
  - a reset ends the earlier generation's deny in H's log and invalidates every pre-reset grant; H re-revokes anyone it does not want back after re-granting;
  - a stolen trusted agent can grant until its grant expires or it is revoked, but cannot move tree time;
  - a revoked agent can still read until the first commit carrying the proof;
  - tree time follows H's signatures, so lapse lags real time and stalls when H signs nothing;
  - a removed receiver cannot see the commit path (§4);
  - a rejoin is confirmed only by a signer that passes the controller-authority gate, against the log for H that kokuin's branch resolution selects from its own accepted history and its responders' answers. One honest answering member suffices. A rejoin that only revoked or self-removed members answer is bounded by their capability `exp` plus 300 s on the rejoiner's clock, authority a rejoiner has learned is kept across attempts and restarts until H resets, group revocations it authenticated are kept until its adopted ledger records them, a responder can delay a rejoin indefinitely but never make it adopt wrongly, and R6-I1 remains open in groups without a controller (§5);
  - a proof longer than one entry is published as several commits, each frame under the hub cap, and the member's log sends wait for it (§3, §5).
