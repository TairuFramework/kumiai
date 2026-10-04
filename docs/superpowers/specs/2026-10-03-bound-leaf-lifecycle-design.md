# Bound-leaf lifecycle and proven revoke

## Goal

A user holds a `did:kokuin` controller H. Its authority key is kept offline or in hardware. The user adds agents (devices, apps, bots, services), and each agent has its own `did:peer`. The agents are the MLS members. H always keeps complete authority to revoke an agent.

This design makes `@kumiai/mls` carry that model end to end, so a consumer only calls it:
- **Binding.** Each agent's leaf proves it is bound to H.
- **Delegation.** One trusted agent T may grant short-lived leaf capabilities to other agents, so the hardware key is not needed for routine grants.
- **Revocation.** When H signs `rev x=D` into its controller log, any member can publish that log into a group as proof. One commit records "D revoked by H at log position N" in the group's ledger, permanently, removes D's leaf and starts a new epoch.
- **Expiry.** Every leaf capability is short-lived (24 h by default). Expiry is the bound on what a revoked agent can still do where its revocation has not been seen, and lapse in the group follows time H has attested (§2).

The first consumer is kubun's own-agents groups. It is the only consumer of this branch, so breaking wire and API changes are allowed in patch releases.

## Accepted tradeoffs

User rulings of 2026-10-03, as reset on 2026-10-04:

1. **Eventual consistency.** Between H's `rev` and the first commit that carries the proof, D can still read the group.
2. **Expiry follows H's signing in the group.** Tree time advances only when something H signed enters the tree (§2). A leaf whose `exp` has passed in wall-clock time stays usable for sending until H next signs something newer that reaches the group, or revokes it. A leaf that tree time has lapsed is removed and must rejoin with a fresh grant.
3. **Only H's keys revoke.** The authority key signs `rev`, the recovery key signs a reset. A trusted agent cannot revoke.
4. **The group ledger is the only revocation authority in kumiai.** H's log is read only to verify a proof (`rev`, reset). A revocation the ledger records is permanent in that group: kumiai ignores a later kokuin un-revoke, and a replacement agent needs a new `did:peer`. A reset acts through the generation floor: every grant signed before it is invalid.
5. **Short leaf lifetime is the revocation bound for rejoin.** Every leaf capability lives at most the group's `leafLifetime` (default 24 h, §1). A rejoiner judges each confirmer only against what it knows itself (§5). A revoked member whose revocation the rejoiner has not seen can confirm its rejoin until that member's leaf capability expires, plus 300 s of clock allowance. This is the stale-confirmation residual that standard groups carry without bound. A revoked trusted agent T can keep minting fresh children until its trusted grant expires (tradeoff 7). So for T's revocation the residual reaches only a rejoiner whose known ledger predates it, and it lasts until T's trusted grant `exp` plus 300 s on that rejoiner's clock, at most the group's `trustedGrantLifetime` (default 30 days, §1) plus 300 s after H signed that grant. Its cost: H renews T's trusted grant at least once per `trustedGrantLifetime`.
6. **Renewal cadence is the cost of that bound.** Every agent needs a fresh leaf capability at least once per `leafLifetime`, from H or T, and renews its leaf in every group (`renewLeaf`, one commit per agent per group). An agent past its capability's wall-clock `exp` cannot rejoin by recovery until it gets a fresh one (`'renewal-required'`, §5), and once tree time passes its `exp` it is lapsed and removed.
7. **A stolen trusted agent** can grant leaf capabilities to attacker agents, each within `leafLifetime`, until its own grant's `exp` (at most `trustedGrantLifetime` after H signed it) or until the user revokes it and a member publishes the proof. It cannot move tree time (§2).
8. **Fixed history horizon.** All of H's log a group carries (every leaf's prefix and every proof in the ledger) is bounded by one size, 384 KiB (§3). Past it, a commit that would grow it fails before it is published. H's path is a reset, which shrinks leaf prefixes. The ledger's own proofs never shrink, even after a reset: a group whose ledger alone nears the horizon records no further proof, and H's path is a new group. Ledger compaction or re-anchoring is a follow-up, not designed here.
9. **Removed receiver.** A receiver that a commit removes cannot see the commit's path, so it may treat itself as removed by a commit the survivors reject (§4). The removal was itself authorized, so the only effect is an early leave.
10. **A rejoin waits for a member's word** (epoch-change spec). A lifecycle rejoin is adopted only on a confirmation from a signer that passes the gate of §5.
11. **Consumer ledger entries are bounded only by the frame check** (§3), not by the horizon. A group whose consumer entries grow large enough makes every frame that carries the whole ledger fail with `FrameTooLargeError`: invites, Welcomes and sealed GroupInfo replies, so new members cannot join and a rejoiner's recovery ends `no-responder`. A bound on consumer entries is a follow-up.

Superseded by the 2026-10-04 reset, and removed with their text, tests, ports and consumer obligations: peer-supplied controller authority on rejoin (authority answers in verdicts, the authority cursor, paged `suffix`/`branch`/`none` transfer, revocation-evidence transfer, per-responder progress, the `answered` binding, `resolveBranches` at a settle point, `'authority-too-large'`, the `controllerLog`, `ingestControllerLog` and `learnedRevocations` ports); paged ledger replies (`ledgerRequest`/`ledgerReply` pages); staged proofs (the `checkpoint` op, `nextRevokeStep`, `advanceCheckpoint`, `'partial'`, `holdLogSends()`); the 512 KiB per-entry bound (replaced by the horizon); `retiredDeny` and every reading of deny from H's log head; and the lifecycle settle round for confirmations.

## Design

### Scope

In `@kumiai/mls`:
- the issuer pin for bound-leaf capabilities (F1, a privilege escalation found by the probe);
- deterministic, clock-free credential verification, including delegation chains of depth 1 through a trusted agent;
- **lifecycle groups**: groups whose genesis anchor names a controller H, with a group `leafLifetime` (§1);
- tree time, entry checks, renewal and lapse in lifecycle groups;
- a fixed leaf identity in every group;
- a proven revoke and a reset, with a cascade and a generation floor;
- the history horizon;
- removal of lapsed leaves;
- a deny set that also applies to floating leaves;
- registry/tree agreement for the existing device ops (C3);
- an invite path without role entries, and speculative helper handles that leave the live handle untouched until adoption;
- the commit-pipeline gates these need, and the issuing and lifecycle API.

In `@kumiai/mls-rpc` and `@kumiai/rpc`: recovery that rejoins a lifecycle group with a bound leaf and gates its verdict signers (§5), and the one-commit revoke run with its send hold (§5).

In `@kokuin/capability`: a child capability may not outlive its parent (§6).

Out of scope: chains deeper than 1; revokes authorised by a capability (rejected in lifecycle groups); lifecycle rules in mixed-controller groups; capabilities an agent issues to itself; changes to ts-mls (everything runs on ts-mls `2.0.0-rc.13`, §4 states the one residual); the `rev` producer and log publishing, and fan-out of proofs across groups (the consumer's).

### Background

A probe against kumiai `0d0ee9f` and ts-mls `2.0.0-rc.13` found the following. Paths are under `packages/mls/src` (kumiai), `node_modules/ts-mls/dist/src` (ts-mls) and `packages/` (kokuin).

- **F1: the bound-leaf capability issuer is never pinned.** `verifyPinnedCapability` (`authentication.ts:103-144`) passes `requireIssuer` only on the manage path (`:196`) and never checks `sub`. `did:key` and `did:peer` issuers verify without a resolver, so a device can sign its own `kumiai/mls-leaf` capability naming any controller and embed that controller's public inception as the prefix. The probe escalated end to end: a floating member re-labels its leaf as bound to an admin profile P, self-registers as a device of P (`device-proof.ts:56-60`), and its admin-only role entry is accepted.
- **A lapsed bound leaf freezes the group.** ts-mls validates every leaf's credential on Welcome join (`clientState.js:591`) and external join (`createCommit.js:246`). kumiai rejects an expired capability against the wall clock (`authentication.ts:135-136`), and `verifyToken` checks `exp` and `nbf` against it too (`authentication.ts:118-122`; kokuin `token/src/time.ts:34-48`). So one lapsed leaf blocks every join, and receivers whose clocks differ disagree.
- **Where the pipeline sees what.** The ts-mls commit callback runs after proposals are applied and before the path is validated (`processMessages.js:157-158`, `:175-182`); it sees the sender and proposals, not the path. Add and Update leaves have passed the auth service against the pre-commit deny set (`clientState.js:679-693`). A receiver the commit removes returns early, and ts-mls exposes no path to kumiai (`processMessages.js:162-174`). A survivor's `newState.ratchetTree` holds the applied path leaf; kumiai assigns that state first (`group-handle.ts:1331`) and rolls back only on a persistence failure (`:1343-1363`). A caller-supplied commit policy replaces the default one (`group-handle.ts:1078-1083`).
- **Renewal is possible today.** No ts-mls API takes a replacement credential, but `createCommit` copies the own leaf from `state.ratchetTree`, so a state copy whose own leaf carries the new credential makes ts-mls sign the new LeafNode. ts-mls records the supplied tree as the old epoch's receiver data (`createCommit.js:84`, `clientState.js:705-711`). An empty commit always carries a path (`clientState.js:443-447`).
- **Proofs and generations.** An authority-signed `rev x=D` folds synchronously with `foldLog` (kokuin `controller/src/fold.ts:482`); a capability-authorised `rev` fails the sync fold closed. A reset is a `rot` with a higher generation, signed by the recovery key, that chains to the inception (`fold.ts:244-256`). Historic key resolution stops at the generation boundary of the supplied prefix's head (`controller/src/state-resolver.ts:89-108`).
- **Registry gaps.** `registryApply('revoke')` is a no-op for an unknown subject (`registry.ts:120-124`). The cross-controller guard on register/add reads only the registry (`device-proof.ts:70-78`). The deny set is consulted only for bound leaves (`authentication.ts:163`, `:227`).
- **No shared clock.** No commit timestamp exists that every member agrees on.
- **Event sizes** (measured with kokuin's own builders, `createInception`, `createRotate`, `createRevoke`, `createReset`, Ed25519, a `did:peer:4` revoke target; size is the UTF-8 length of the signed event's JSON): inception 388 B, rotation 453-455 B, revoke 336 B, reset 525 B. A log of three rotations per revoke is 4,238 B at 10 events, 21,248 B at 50, 42,570 B at 100 and 109,065 B (106.5 KiB) at 256; rotations only, 4,476 / 22,676 / 45,426 / 116,562 B. A ledger token carries its payload base64url-encoded, so a proof costs 4/3 of that inside a token.

### 1. Lifecycle groups and credentials

**Lifecycle group.** A group is a lifecycle group iff its genesis anchor carries `controller: H`:
```
GroupAnchor.controller?: string     // a did:kokuin DID
GroupAnchor.leafLifetime?: number   // seconds; lifecycle groups only; default 86,400
GroupAnchor.trustedGrantLifetime?: number   // seconds; lifecycle groups only; default 2,592,000
```
- `createGroup` writes all three when given a controller binding (§5): `leafLifetime` from its `leafLifetime` option, default 86,400 s (24 h), at most 604,800 s (7 days); `trustedGrantLifetime` from its option of that name, default 2,592,000 s (30 days), at most 31,536,000 s (365 days). The creator's leaf is bound to H.
- The anchor is fixed at genesis: the extension policy pins every GroupContext extension except the ledger head.
- Decoding is strict: a `controller` that is present but not a `did:kokuin:` string, a `leafLifetime` outside `1..604,800`, or a `trustedGrantLifetime` outside `1..31,536,000`, makes the anchor malformed, and the group is refused. This supersedes, for these fields, the rule that new control fields go in a new extension (`anchor.ts:57-63`). Old peers ignore them, so every peer of a lifecycle group runs this release (Release).
- The trusted-grant ceiling is a constant, 365 days; a lifecycle group's `trustedGrantLifetime` is enforced by consensus like `leafLifetime`.

In a lifecycle group:
- **Every leaf is bound to H.** A floating or foreign-bound leaf is refused on Add, external join and Update. A joiner checks the whole Welcome tree.
- **Authority is the binding.** The roster is seeded `{H: admin}` instead of `{creatorDID: admin}` (`roster.ts:45-47`), and `kumiai.role` entries are rejected. A commit sender whose pre-commit leaf is bound to H acts as H. So does the issuer of a consumer (non-`kumiai.*`) ledger entry that holds a leaf in the pre-commit tree; this replaces the registry-derived admin check of `foldEnvelope` (`envelope-fold.ts:92-94`) for those entries. Every member may Add an agent, enact consumer entries and move the ledger head. Removal is narrower (§4).
- **Invites** carry their recipient explicitly (§5).
- **Device ops.** Only proven `revoke`, `reset`, `clock` and `beacon` are accepted. `register`, `add`, `label` and capability-authorised `revoke` are rejected: the registry here records only revocations and floors.

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

**Trusted grant (the parent).** `iss = sub = H`, `aud = T`, `authenticate` on `kumiai/mls-leaf`, `cnf` = T's key, `iat < exp`. T need not be a current member; its own leaf, if any, uses a direct capability.

**Verification.** `validateCredential` is deterministic: it reads no clock and no DID cache, and checks every time claim against a reference time from the token itself. The group's `leafLifetime` and `trustedGrantLifetime` reach it through the handle's own authentication context (§5, *Speculative handles*).
1. `controller.id` is a `did:kokuin`, and `prefix` folds to it with `foldLog`.
2. **Direct form.** `verifyToken(capability, { methods: [embedded], historic: true, atTime: capability.iat })`, which verifies the signature against a key valid in the prefix and checks `exp ≥ iat` and `nbf ≤ iat`. Then `iss = sub = controller.id` (the F1 fix), `aud = id`, the permission, `cnf` = the leaf's signature key, and `0 < exp - iat ≤ leafLifetime`.
3. **Chained form.** The child's signature is verified against the key the parent's `cnf` pins (`getVerifier(header.alg)`, exported from `@kokuin/token`, `token/src/verifier.ts:27`), so T's DID is never resolved. `checkCapability({act, res}, child.payload, { atTime: child.iat, methods: [embedded], maxDepth: 1 })` (`capability/src/delegation.ts:275`) verifies the parent against the prefix and checks the parent's `exp ≥ child.iat`, `nbf ≤ child.iat`, `iat ≤ child.iat`, `child.iss = parent.aud`, equal `sub`, permission coverage, and the child's own `exp ≥ iat`, `nbf ≤ iat`. kumiai then checks `parent.iss = sub = controller.id`, `child.aud = id ≠ child.iss`, `child.cnf` = the leaf's key, `child.exp ≤ parent.exp`, `0 < child.exp - child.iat ≤ leafLifetime`, `0 < parent.exp - parent.iat ≤ trustedGrantLifetime` (365 days outside lifecycle groups), and that T is not denied.
4. `id` is not in the deny set. This now applies to floating leaves too.

`exp` against any "now", and the generation floor, are not checked here: both depend on group state and run in the commit pipeline (§2). Outside lifecycle groups the leaf lifetime ceiling is 7 days.

**Management capability** (other groups only). `verifyManagementCapability` uses the same reference-time verification with `iss = sub = controller` pinned, and checks `exp` against the controller's tree time in the pre-commit tree (§2).

### 2. Time, generations and entry checks

**Attested time.** For a direct leaf, its capability's `iat`; for a chained leaf, its trusted grant's `iat`. The T-signed child `iat` never counts.

**Tree time.** In a lifecycle group, `treeTime(H) = max(timeFloor(H), max attested time over the epoch's leaves)`, computed by every member from the tree and the folded ledger with no clock. `timeFloor(H)` lives in the registry and is raised only by `clock` entries (§3). Tree time advances only when a leaf carrying a newer H-signed time enters; T's routine renewals never advance it. To keep lapse close to `leafLifetime`, H must sign something that reaches the group at that cadence, for example a fresh direct grant for one agent. In other groups, `treeTime(C)` is the maximum attested time over leaves bound to C, with no floor; it serves only entry checks and management capabilities.

**Lapsed.** A leaf L bound to H is lapsed at an epoch when `L.exp < treeTime(H)`, `L.exp` being the leaf token's `exp`.

**Generation floor.** `genFloor(H)` lives in the registry and is raised only by an accepted `reset` (§3). A leaf's generation is the generation at the head of its prefix. Ordinary rotations do not change it, so earlier grants keep verifying. A grant signed before a reset fails against any prefix that includes the reset, and a prefix that stops before it is below the floor.

**Entry checks.** They run on every leaf that enters or changes (an Add, an external commit's new leaf, an Update, a committer's path leaf whose credential changed), against the pre-commit state:
1. In a lifecycle group, the leaf is bound to the anchor's H.
2. The credential passes §1.
3. `L.exp > treeTime(H)` of the pre-commit epoch.
4. The leaf's generation is at least `genFloor(H)`.
5. Neither `id` nor the chain issuer is revoked in the registry.
6. **Fixed identity.** An Update, path leaf or external replacement keeps the replaced leaf's `id`, `longForm`, signature key and `controller.id`. Only `controller.capability` and `controller.prefix` may change, and the prefix must still fold to `controller.id`. Outside lifecycle groups, a floating leaf may become bound once, keeping `id` and key; bound to floating is rejected.
7. **Renewal order.** A leaf replacing one of the same identity has a token `iat` at least the old one's.
8. **Registry agreement** (other groups). If the registry has a record for `id`, the leaf's `controller.id` equals the record's controller (§3).
9. **History horizon** (lifecycle groups). The commit keeps the group's history size within the horizon (§3).

Outside lifecycle groups check 3 reads `L.exp > treeTime(C)`, and checks 4 and 9 do not apply.

**Sending.**
- A lapsed member's member commit is accepted only when it is an empty commit whose path renews its own leaf out of lapse, plus a `clock` entry if §3 requires one. An external commit follows §4 instead.
- `GroupHandle.sendAdmission()` is **synchronous**: `{ epoch, admissible: true }`, or `{ epoch, admissible: false, reason: 'lapsed' }` when the own leaf is lapsed at the handle's epoch. The verdict is computed once when an epoch's state is installed, so the call takes no lock and reads no clock. `encrypt` refuses a lapsed sender with `LeafLapsedError`, and the delivery outbox refuses to enqueue (epoch-change spec).
- **The port's snapshot** (`@kumiai/mls-rpc`). `GroupMLS.sendAdmission()` never goes through `HandleAccess.read`, `mutate`, `replace` or `open`, which serialise with `replace` and its awaited host adoption callback (`mls-rpc/src/access.ts:28-40`, `:61-66`); a dispatch awaited inside that callback would deadlock. `HandleAccess` gains a synchronous `admission()` beside `epoch()`, both published together initially and at the end of `mutate`, `replace` (after the adoption callback resolves) and `open` (`access.ts:58`, `:65`, `:71`). Inside an adoption callback it still reports the epoch being left; the delivery worker accepts a seal only when the admission epoch equals the ciphertext epoch. A dispatch from inside the adoption of the sender's own renewal is therefore refused, and the host dispatches after adoption.
- `decrypt` and `decryptStaged` refuse a lapsed sender with `LeafLapsedError` before opening (`group-handle.ts:873-877`, `:915-919`), so no ratchet generation is consumed; sender and receiver judge the same epoch's tree.

**Author-side checks.** These use the local clock and only stop the device itself from producing a bad change. `createGroup`, `createKeyPackageBundle`, `createLastResortKeyPackageBundle`, `joinGroupExternal`, `commitInvite`, `addDevice` and `renewLeaf` refuse a capability whose `exp ≤ now` or whose `iat > now`.

**Renewal.** `renewLeaf(group, binding)` makes an empty commit whose path carries the own leaf with the new binding, with the same signature key and no absorbed proposals, so it always carries a path. Its only possible ledger entry is a `clock` entry (§3). It builds the commit from a state copy whose own leaf, LeafNode and credential objects are deep-copied before the credential is replaced, and afterwards restores the original pre-renewal tree as the old epoch's receiver data, so delayed old-epoch messages are judged against the leaf as it was. Only the leaf's owner can sign its LeafNode, so each agent renews itself; delivering a new capability from H or T is the consumer's job, at least once per `leafLifetime` (tradeoff 6).

### 3. Registry, proofs, horizon and clock

All entries below are `kumiai.device` entries, accepted only in lifecycle groups, authored by any member and authorised by their proof, not by a role. Every effect is carried in the entry, so every replay (live receive, the author's derived handle, `restoreGroup`, `bootstrapLedger`, Welcome) derives it from authenticated ledger data alone. The pre-commit tree is read only on live acceptance.

**Recorded log.** Every member derives the group's recorded H log from the ledger alone, replaying its accepted `revoke` and `reset` entries in order: the first accepted entry's proof starts it, each later `revoke` appends its proof, and each `reset` replaces it with the reset's chain. So the ledger holds each event of H's log once per generation.
- A group's first proof carries the chain from the inception, or, when H's log holds a reset, from the latest reset re-parented on the inception (`[icp, reset, …]`). A later `revoke` carries the suffix after the recorded log's head, possibly empty when the recorded log already holds the `rev`. A `reset` carries its own chain `[icp, reset, …]`.
- A proof carries only events that advance the folded head: a skipped `crit: false` event (`fold.ts:377`) makes it invalid.
- A `revoke` is verified with `foldLog(H, recorded ++ proof)`. A suffix that does not attach fails that fold and is rejected; a member that lost an epoch race rebuilds its proof against the new recorded log (§5). A `revoke` never changes the generation: a suffix holding a reset is rejected, and a higher generation is first proven by a `reset` entry.

**Proven revoke.**
```
{ op: 'revoke', subject: D, proof: SignedEvent[], revoked: Array<{ did, cascadedFrom? }> }
```
Accepted when:
1. `foldLog(H, recorded ++ proof)` succeeds, H being the anchor's controller. Every event must be authority-signed.
2. Some event `k` of that log is `rev` with `x` normalizing to D, `states[k].deny` contains D, and `states[k].gen ≥ genFloor(H)`, so an old compromised authority key cannot evict agents after a reset.
3. D is not already revoked in the registry.
4. `revoked` lists D first, then every pre-commit leaf whose chain issuer is D, each with `cascadedFrom: D`. Receivers recompute it and reject any difference.
5. The commit's composition follows §4, and the horizon holds.

Effects: each listed DID gets `{ status: 'revoked', controller: H, logPosition: k, cascadedFrom? }`, created if absent. Revoked records are terminal (`registry.ts:104-106`). The proof need not reach H's log head. Nothing in H's log undoes the record: kumiai reads H's log only to verify the proof.

**Reset.**
```
{ op: 'reset', subject: H, proof: SignedEvent[], revoked: Array<{ did, cascadedFrom? }> }
```
- Accepted when `foldLog(H, proof)` succeeds and the proof holds a reset to generation `g > genFloor(H)` at position `k`. The recorded log becomes the proof.
- `revoked` lists every pre-commit leaf whose generation is below `g`, then every pre-commit leaf whose chain issuer is one of those (`cascadedFrom`). Receivers recompute and compare it.
- Effects: `genFloor(H) = g`, and each listed DID gets `{ status: 'revoked', controller: H, logPosition: k, reason: 'reset', cascadedFrom? }`. An agent absent from the tree is caught by the floor at its next entry.
- Agents H keeps renew under the new generation before the reset lands; a member listed in `revoked` cannot author it (§4).

**History horizon.** In a lifecycle group, the group's **history size** is the sum, over every bound leaf in the tree, of the size of its `controller.prefix`, plus the sum, over every accepted ledger entry, of the size of its `proof`. An event's size is the UTF-8 length of the signed event's JSON, as the credential and the ledger token payload carry it; a list's size is the sum of its events'.
- **The bound.** A commit is accepted only when its post-commit history size is at most `HISTORY_HORIZON = 393,216` bytes (384 KiB), or is no larger than the pre-commit size. The second clause means a commit that only removes leaves, or shortens prefixes, is never refused, so a group can always shrink.
- **Why this number.** The hub caps a publish at 1,048,576 base64 characters (`hub-protocol/src/protocol.ts:35`), 786,432 raw bytes. Every frame that carries group history (a commit, a Welcome, an invite, a sealed GroupInfo reply carrying the tree and the ledger) carries at most the group's history. Inside ledger tokens it grows by about 1.35 (base64url plus per-token headers, signatures and claims; measured) to about 531,000 bytes, leaving about 255,000 bytes for the commit, the rest of each leaf (keys, capability tokens), consumer entries, sealing and framing. By the measured sizes (Background), the horizon holds about 860 rotations or 920 mixed events, counted once per copy: ten agents each carrying a 50-event prefix use 212 KB of it.
- **Judged where.** The added size of an Add, an Update or an entry is known in the callback, and a path leaf's in the post-apply gate. A commit that removes a receiver keeps the committer's path credential (§4), so a removed receiver reaches the same verdict.
- **Past the horizon.** Every helper computes the post-commit size before it builds and fails with a typed reason before anything is published: `LeafBindingError` (`history-horizon`) for a leaf, `'not-provable'` (`too-large`) for a proof. H's path is a reset: agents renew with prefixes re-parented on the inception (`[icp, reset, …]`, two events, 913 B), and the reset commit removes the rest. The ledger's proofs are never removed, so a group whose ledger alone nears the horizon records no further proof, and H's path is a new group (tradeoff 8).
- **Whole-frame check.** The horizon bounds history; the frame decides. Before `@kumiai/rpc` journals or publishes any frame (a commit in `frameCommit`, `rpc/src/peer.ts:1892-1910`, a GroupInfo or ledger reply, a verdict), it checks `4·⌈n/3⌉ ≤ 1,048,576` for the frame's `n` bytes. A frame that fails throws `FrameTooLargeError` (`@kumiai/rpc`) and nothing is journalled or published, so a kumiai frame is never a hub schema rejection. Consumer entries are not bounded by the horizon, only by this check.

**Clock.**
```
{ op: 'clock', subject: H, time: number }
```
- Accepted when `timeFloor(H) < time ≤ treeTime(H)` of the pre-commit epoch. Effect: `timeFloor(H) = time`. At most one per commit.
- **Required** in any commit whose post-commit tree time, computed with the existing floor, would fall below the pre-commit tree time; it must then carry `time = treeTime(H)` of the pre-commit epoch, so tree time never decreases. Such a commit can always carry it, since a regression means a leaf's attested time was above the floor.
- A regression comes from a Remove of the leaf holding the maximum (judged in the callback, so a removed receiver agrees) or from a path or Update leaf whose new attested time is lower than its old one (judged where that leaf is checked). §4 keeps the two in separate commits. Helpers add the entry themselves, `renewLeaf` included.

**Deny set.** Every DID with a revoked record is denied as a leaf, bound or floating, on Add, external join and Update, and as a chain issuer.

**Registry agreement in other groups (C3).** A `register` or `add` naming controller C for subject S is accepted only when the registry has no record for S or the record names C; S's current leaf, if any, is bound to C (a floating S must first bind its own leaf, then self-register); and an Add of S in the same commit carries a leaf bound to C. A manage-op `revoke` or `label` also requires that the target's current leaf, if any, is bound to the registry's controller for it. Entry check 8 holds every later admission of S to its record. **Manage path:** `verifyManagementCapability` also pins `sub = controller` (F1).

### 4. Commit pipeline

**Gate order.** Lifecycle gates are mandatory. A caller policy runs only after they accept, and only replaces the default policy's role rules; it can never accept what a lifecycle gate rejected. This changes `combined` (`group-handle.ts:1078-1083`).

**Stages.**
1. **Pre-pass** (async, before ts-mls): decodes the envelope, resolves the entries, folds the candidate registry, verifies device entries and proofs, parses an external commit's path leaf, and precomputes the pre-commit tree time, lapsed set, history size and derived `revoked` sets.
2. **Callback** (sync, inside ts-mls, for every receiver, a removed one included): every proposal-level verdict: entry checks on Add and Update leaves, Remove legitimacy, the lapsed-sender restriction, composition, the clock requirement for Removes and Updates, the horizon for everything known before the path, and the external-commit rules.
3. **Post-apply gate** (survivors only, before the state is adopted): the committer's path leaf against its pre-commit leaf: entry checks if the credential changed, an unchanged credential where composition requires it, renewal out of lapse for a lapsed sender, the clock requirement and the horizon for the path leaf. On reject, the previous state stays authoritative, the result's `consumed` secrets are not zeroed, the new-epoch state is dropped, and `CommitRejectedError` is thrown. `commitWithEntries` and every lifecycle helper run the same gate on their own result.

**Removed receivers.** ts-mls returns before validating or applying the path for a removed receiver (`processMessages.js:162-174`). Every Remove verdict is therefore computable before the path, so a removed receiver agrees with survivors on whether its removal was authorised, but it may consider itself removed by a commit the group then discards for its path. Closing this needs a ts-mls change exposing the decrypted commit to the callback (out of scope). Accepted (tradeoff 9).

**Proposal rules in lifecycle groups.**
- **Add:** passes the entry checks. Any member may add.
- **Update:** passes the entry checks, fixed identity included.
- **Remove**, one of: derived from a `revoke` or `reset` entry in the same commit (the Removes equal exactly the pre-commit leaves of its `revoked` DIDs); a lapsed target, judged at the pre-commit tree time, from any member; a self-removal proposal by the target, committed by another member. No other Remove is accepted. The anti-demotion rule (`policy.ts:229-235`) does not apply.
- **GroupContextExtensions:** the head move only. **PSK and ReInit:** rejected.
- **External commit:** exactly `external_init` plus one Remove of an existing leaf L. The new leaf passes the entry checks with L as the leaf it replaces, so it is the same agent with the same key, bound to H. It may not lower tree time, since it carries no entries. This replaces the roster gate (`policy.ts:268-297`) and alone governs an external commit: the member-commit rules do not apply, so it may renew a lapsed L and change its capability and prefix.

**Composition rules.**
- A commit enacting a `revoke` or `reset` carries exactly that entry, its derived Removes, the head move and an optional `clock` entry; no Add, Update, PSK or other Remove, and the committer's path leaf keeps its credential. A member listed in `revoked` cannot author it.
- A member commit carrying any Remove keeps the committer's path credential unchanged: renewal and removal go in separate commits. An external commit's Remove follows the external-commit rule.
- Every helper commits with no pending proposals absorbed.
- So the deny set and floors a commit installs never meet a leaf admitted in the same commit. The final check still runs: after the commit, no surviving leaf is denied, issued by a denied DID, or below the generation floor.

**Other groups.** The existing rules stay, plus fixed identity, the deny set on floating leaves, registry agreement and the mandatory gate order. The external-commit rule also requires fixed identity. **Beacon** is unchanged and advisory.

### 5. API

**Issuing** (`@kumiai/mls`):
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
Both set `iat` and refuse lifetimes over the ceilings (7 days for a leaf capability, 365 days for a trusted grant; a group's `leafLifetime` and `trustedGrantLifetime` may be lower, and its entry checks enforce them). `mintLeafCapability` refuses a child `exp` later than the parent's and an `audience` equal to the signer. `ControllerBinding` (`credential.ts:36-40`) is the binding input everywhere.

**Group setup.**
- `createGroup(identity, groupID, { controller?: ControllerBinding, leafLifetime?: number, trustedGrantLifetime?: number, ... })` builds a bound creator leaf (today always floating, `group-create.ts:58`) and writes `GroupAnchor.controller`, `leafLifetime` and `trustedGrantLifetime`. That makes it a lifecycle group.
- `createKeyPackageBundle`, `createLastResortKeyPackageBundle` and `joinGroupExternal` take `controller?: ControllerBinding` (`group-credential.ts:54`, `group-welcome.ts:237`). In a lifecycle group, `joinGroupExternal` without it throws `LeafBindingError` (`floating-refused`).

**Invites in a lifecycle group.** Today the invite path needs a role entry three times: the inviter guard (`group-commit.ts:114-116`), the recipient binding (`:400-412`) and the Welcome check (`group-welcome.ts:53-69`). Each is replaced:
- `Invite` gains `recipientDID`. The invite still carries the group's whole ledger, checked by the joiner against the authenticated head, and its history is within the horizon (§3).
- `createInvite` takes no `permission` and signs no role entry; its guard is that the inviter holds a leaf. It takes optional `entries`: consumer entries the inviter signed, appended so they ride the Add commit.
- `commitInvite` binds the key package to `invite.recipientDID` (`InviteRecipientMismatchError`), runs the entry checks, the horizon and the author-side checks on the key package leaf, and enacts only the appended consumer entries. `commitWithEntries`'s admin guard (`group-commit.ts:194-199`) becomes "the committer holds a leaf".
- `processWelcome` requires `invite.recipientDID` to be the joiner, its own binding to name the anchor's controller, and every leaf in the tree to be bound to it.
- **One-time consent** stays the consumer's: the admitting member checks its consent and that the ID is unconsumed, then passes a consumer entry recording the ID in `entries`, so admission and consumption land in one commit, and a concurrent second admission loses the epoch race and sees the ID consumed on retry.

**Lifecycle helpers.** `renewLeaf`, `removeLapsedLeaves` and `revokeWithProof` follow the write-result contract (`DeviceWriteResult`: `commitMessage`, `newGroup`, `epoch`), run under the group mutex, judge locally, and return a commit and a derived handle. They neither mutate the input handle, persist, publish nor retry.
```ts
renewLeaf(group: GroupHandle, binding: ControllerBinding): Promise<DeviceWriteResult>
removeLapsedLeaves(group: GroupHandle): Promise<{ removed: Array<string>; result?: DeviceWriteResult }>

// @kumiai/mls: builds the one proof commit against the handle's recorded log
revokeWithProof(
  group: GroupHandle,
  params: { subject: string; log: Array<SignedEvent> } | { reset: true; log: Array<SignedEvent> },
): Promise<
  | { status: 'built'; result: DeviceWriteResult }
  | { status: 'already-revoked' }
  | { status: 'self-affected'; subject: string }
  | { status: 'not-provable'; reason: RevokeProofReason }
>

// @kumiai/mls-rpc: publishes it as one commit through the group's commit lane
publishRevokeProof(
  peer: GroupPeer, mls: GroupMLS,
  params: { subject: string; log: Array<SignedEvent> } | { reset: true; log: Array<SignedEvent> },
): Promise<
  | { status: 'committed'; epoch: number }
  | { status: 'already-revoked' }
  | { status: 'self-affected'; subject: string }
  | { status: 'not-provable'; reason: RevokeProofReason }
>
```
- **`revokeWithProof`** strips skipped events and derives the proof against the handle's recorded log (§3): the suffix up to the `rev`, a first chain, or the reset's chain. It returns `'not-provable'` with `too-large` when the commit would exceed the horizon, with `detached` when `log` neither passes through the recorded log's head nor holds a reset above it, with `needs-reset` when a `revoke`'s log is at a generation above the recorded one (the caller publishes `{ reset: true, log }` first, then reruns), and otherwise as §3 fails. It returns `'already-revoked'` when the subject is recorded revoked and no affected leaf remains, and `'self-affected'` when the caller's own leaf is in the derived set, so another member must publish. It commits a proof for a subject with no leaf, so the deny set closes later joins.
- **`publishRevokeProof`** runs one ordinary `commit()` on the group's peer (`rpc/src/peer.ts:2174`) with `holdLogSends: true` (epoch-change spec §4). Its build calls `revokeWithProof` on the then-current handle, so a proof that loses the epoch race is rebuilt against the new recorded log, and after a winning proof by another member it returns `'already-revoked'`. A lane failure (deadline, publish failure, strand) throws as for any commit; nothing is undone, and the caller reruns.
- **Removal before the next broadcast.** From the call until the commit lands or is known unlanded, the peer submits no log frame for the group, including one sealed before the call and not yet submitted, and the revoke commit is published only after the peer's log submissions already in flight settle: in memory while the call runs, and through the commit journal across a restart (epoch-change spec §4, *Revoke hold*). So no log frame is submitted after the hold is taken, and a frame already submitted went to a member still legitimate when it was submitted. The hold covers one peer; the epoch-change spec's one owner per group makes that peer the group's only log sender. Ephemeral and directed frames are not held; the eventual-consistency window covers them (tradeoff 1).
- **`removeLapsedLeaves`** removes every lapsed leaf, adding a `clock` entry when required, and returns `{ removed: [] }` with no result when there is nothing to remove.
- **The consumer's part.** For `renewLeaf`, `removeLapsedLeaves` and `commitInvite`, the consumer publishes `commitMessage` and adopts `newGroup` once its transport accepts the commit; after a lost epoch race it discards `newGroup`, processes the winner and calls the helper again. `publishRevokeProof` does this itself through the lane.

**Speculative handles.** A derived handle is speculative until adopted; constructing or discarding one leaves the input handle and its subscribers untouched.
- **Own auth state.** Today the constructor re-points the context's shared deny holder at the newest handle (`group-handle.ts:345-349`), and `deriveGroup` shares the context (`:1423-1434`), so a candidate revoking T makes the live handle reject T-issued credentials before the group accepted anything. Instead `deriveGroup` gives each handle its own context: the cipher suite is shared, the authentication service, its deny provider and the group's `leafLifetime` and `trustedGrantLifetime` are the handle's own.
- **No early events.** Helpers no longer fire events on the derived handle (today `revokeDevice` and `announceControllerBeacon` do, `group-device.ts:173`, `:203`). The derived handle holds its control events as pending, and `newGroup.confirmAdopted()` fires them once; a handle never confirmed fires nothing. `HandleAccess.replace` calls it after the host adoption callback resolves; a host that adopts outside `HandleAccess` calls it itself.

**Recovery in a lifecycle group** (`@kumiai/mls-rpc`, `@kumiai/rpc`). Automatic recovery rejoins by external commit (`attemptBody`, `rpc/src/peer.ts:2402`). The adapter's `applyRecovery` passes only `group.credential` (`mls-rpc/src/mls.ts:315-321`), so `joinGroupExternal` builds a floating leaf (`mls/src/group-welcome.ts:236-240`), which survivors refuse. In a lifecycle group:
- **Binding.** The replacement leaf always carries a complete `ControllerBinding`. The adapter reuses the own leaf's current binding when it passes the recovery check, and otherwise asks the host.
- **Recovery check.** The complete external-commit acceptance predicates of §4 on a candidate binding: the own leaf L is present and not denied, so the commit is exactly `external_init` plus the Remove of L; the new leaf passes entry checks 1 to 7 and 9 with L as the leaf it replaces; and its attested time does not lower tree time. A lapsed L is no obstacle. It adds the external-join authoring check (`iat ≤ now < exp`). Before the request it runs on the handle's own state; after the GroupInfo, on the responder's (below).
- **Port.** `GroupMLSParams` (`mls-rpc/src/mls.ts:79-91`) gains `recoveryBinding?: (request: { groupID: string; controllerID: string; current: ControllerBinding }) => Promise<ControllerBinding | null>`. kumiai calls it only in a lifecycle group, only when the cached binding fails the check or a responder refused it, at most once per attempt. `null`, an absent port, or a binding that fails the check all mean "none". Once the rejoin is confirmed, the binding is the own leaf's.
- **Before the request.** `GroupMLS` (`rpc/src/crypto.ts:367`) gains `prepareRecovery(): Promise<'ready' | 'renewal-required'>`, called by `attemptBody` before it mints the request (`peer.ts:2445`). `'renewal-required'` ends the attempt before any GroupInfo is requested. Outside lifecycle groups it answers `'ready'`.
- **The reply carries the ledger.** Today the sealed reply frames only the attestation and the GroupInfo (`mls/src/recovery.ts:553`). In a lifecycle group `sealGroupInfo` also frames the responder's whole ledger, and the attestation's digest covers it. Its history is within the horizon, and the whole-frame check applies. A reply whose ledger does not fold to the head in the GroupInfo's GroupContext is refused like any untrusted reply (`null`). The reply goes only to a requester with a leaf in the responder's tree, as `sealLedger` does (`recovery.ts:779-783`). This lets the rejoiner see a floor or revocation raised during its gap before it publishes.
- **After the GroupInfo.** `applyRecovery` (`crypto.ts:468`) re-runs the check against the GroupInfo's tree and the registry folded from the reply's ledger, and gates the attestation signer (below); a failing reply is refused. This avoids a publish the responder's own state already refuses; it is not the safety argument, which is confirm-before-adopt. If the held binding fails, it asks the host once (unless the host supplied it in this attempt). With no usable binding it returns `{ renewalRequired: true }`, widening its result to `PendingRecovery | { renewalRequired: true } | null`, and the peer ends the attempt (`peer.ts:2465`).
- **Verdict gate.** Every lifecycle rejoin uses the epoch-change spec's confirm-before-adopt. A confirmation's tag proves only that its signer applied the external commit, so a member that kept an old epoch's secrets after its removal could apply a stale rejoin and confirm it. In a lifecycle group a verdict (`confirmed`, `superseded` or `refused`), and the GroupInfo attestation, counts only when its signer passes all of these, judged only against the rejoiner's own state:
  - **(a)** it holds a leaf bound to H in the pending tree (the GroupInfo's tree plus the replacement leaf);
  - **(b)** neither its DID nor its leaf's chain issuer is revoked in the rejoiner's **known registry**: the registry folded from its own last-known ledger, joined with the one folded from the reply's ledger (revocations united, floors at their maximum, so neither can remove what the other holds);
  - **(c)** its leaf's generation is at least the known registry's `genFloor(H)`;
  - **(d)** its leaf is not lapsed at `max(treeTime(pending tree), now − 300 s)`, tree time taken with the known registry's `timeFloor(H)` and `now` being the rejoiner's clock. This is a rejoiner-local trust decision, like the author-side checks; an honest confirmer it refuses costs an `'unconfirmed'` retry, never safety.
  A verdict whose signer fails is advisory (epoch-change spec §1). The epoch-change precedence then applies unchanged: a counted confirmation adopts at once.
- **Residual.** A member revoked after the rejoiner's last-known ledger, whose revocation reaches the rejoiner neither in its own ledger nor in the reply's, passes (b). It can confirm a stale rejoin until the rejoiner's clock passes its leaf's `exp` plus 300 s, at most `leafLifetime` plus 300 s after its last grant (tradeoff 5). Under a revoked T, the bound is T's trusted grant `exp` plus 300 s, at most `trustedGrantLifetime` plus 300 s after H signed it (tradeoffs 5 and 7). A self-removed agent turned hostile is bounded the same way. H's log plays no part, so an un-revoke never helps a revoked member, and nothing about H's log needs to reach the rejoiner. A hub that forks its readers stays the epoch-change spec's residual. Groups without a controller have no gate, as on main.
- **Responder refusal reasons.** The union `RecoveryRefusalReason = 'binding' | 'lapse' | 'floor' | 'policy' | 'invalid'` is defined in the epoch-change spec (§1). The lifecycle gates map onto it: `'binding'` for entry check 1, 2, 5 (chain issuer), 7 or 9; `'lapse'` for check 3; `'floor'` for check 4 or a tree-time regression; `'invalid'` for anything else (no leaf L of the same agent, a denied `id`, a commit of the wrong shape). A caller policy that rejects after the lifecycle gates accept reports `'policy'`.
- **Outcomes.** `'binding'`, `'lapse'` and `'floor'` are binding-fixable: the rejoiner discards the pending handle, marks the refused binding unusable, and ends as `'renewal-required'`. `'policy'` and `'invalid'` end as the epoch-change spec's `'refused'`. `RecoveryFailureReason` (`peer.ts:223-228`) gains `'renewal-required'`, reported through `onRecovery` as `phase: 'failed'`.
- **No retry loop.** While `renewalRequired` is set, no automatic trigger starts an attempt or requests a GroupInfo: not `healIfRequested` (`peer.ts:2642-2652`), not the delivery worker's backoff or its uncovered-floor rejoin. The strand and the held outbox entries stay. The host calls `recover()` (`peer.ts:2629`) once it can supply a fresh binding; that clears the flag and runs one attempt. A ratchet by any other path also clears it.

**Reads and events.**
- `revocationOf(group, did)` returns `{ controller, logPosition, reason?: 'reset', cascadedFrom? } | null`.
- `GroupHandle.sendAdmission()` and `HandleAccess.admission()` (§2).
- `deviceRevoked` gains `logPosition`, `reason` and `cascadedFrom`. It fires once per listed DID at accepted adoption only: a received commit after it is persisted, an authored commit at `confirmAdopted()`, and `bootstrapLedger` for entries it adds. Restore and Welcome project records, deny set and floors silently; the consumer reads them with `revocationOf`.

### 6. kokuin

In `@kokuin/capability`, `createCapability` (`delegation.ts:43`) refuses a delegated child whose `exp` is later than its parent's, or that has no `exp` while its parent has one, and every capability-to-capability link that `checkCapability` and `checkDelegationChain` verify rejects the same. An invocation is not a child capability: the invocation path through `assertValidDelegation` (`delegation.ts:107`) keeps its behaviour, and the capability it presents is still checked against its own `exp` at `atTime`. That is the only kokuin change. `verifyToken` already takes `atTime` (`token/src/token.ts:41`), `checkCapability` threads it through the chain (`delegation.ts:215-263`, `:275`), and `getVerifier` is exported.

## Errors and outcomes

Error classes, following kumiai's convention, each carrying a `reason`:
- `LeafBindingError`: `issuer-mismatch`, `subject-mismatch`, `chain-depth`, `self-issued`, `child-outlives-parent`, `denied-issuer`, `lifetime-cap` (over the group's `leafLifetime` or `trustedGrantLifetime`, or a constant ceiling), `generation-floor`, `identity-change`, `controller-mismatch`, `floating-refused` and `history-horizon`.
- `LeafLapsedError`.
- `RevokeProofError` with `RevokeProofReason`: `no-rev`, `wrong-controller`, `not-authority-signed`, `generation-floor`, `too-large`, `detached`, `needs-reset`, `effects-mismatch` and `removes-mismatch`. Used on the authoring path; `revokeWithProof` maps it to `'not-provable'`.
- `FrameTooLargeError` (`@kumiai/rpc`): a frame failed the whole-frame check; nothing was journalled or published.
- A commit rejected on receive goes through `CommitRejectedError`, which gains the refusal reason (epoch-change spec).

Recovery outcomes added here: `'renewal-required'` (`onRecovery`, `phase: 'failed'`), held until the host's `recover()` or a ratchet. `RecoveryRefusalReason` and the `'refused'` and `'unconfirmed'` outcomes are the epoch-change spec's.

## Testing

Each test names the guarantee it pins and must fail with its fix removed.

**Verification**
1. *Issuer pin (F1).* A self-issued leaf capability naming a foreign controller is rejected (`issuer-mismatch`), and the probe's escalation fails at its first step. A manage capability with another `sub` is rejected.
2. *Clock-free verdicts.* Two receivers whose mocked clocks straddle the `exp` and `nbf` of each chain link, and of a management capability in another group, reach the same verdicts.
3. *Chains.* A T-issued leaf capability is accepted. Rejected: depth 2, a child that outlives its parent, `sub` other than H, a denied T, a parent over 365 days outside lifecycle groups, a child whose `aud` is T, and a child signed by a key other than the parent's `cnf`.
4. *Lifetime cap.* In a group created with the default, a direct and a chained leaf of exactly 24 h are accepted and of 24 h plus 1 s are rejected (`lifetime-cap`) at Add, Update, external join and Welcome. A group created with `leafLifetime: 3600` enforces 1 h. A trusted grant of exactly 30 days is accepted under the default `trustedGrantLifetime` and one of 30 days plus 1 s is rejected (`lifetime-cap`) at Add, Update, external join and Welcome; a group created with `trustedGrantLifetime: 86400` enforces 1 day. An anchor with `leafLifetime` 0 or above 7 days, or `trustedGrantLifetime` 0 or above 365 days, is refused.

**Tree time and lapse**
5. *Only H moves tree time.* A stolen T mints a child with a far-future `iat` and admits it: tree time is unchanged, and a lapse Remove of an honest leaf is rejected.
6. *Grants advance it.* A new direct grant from H advances tree time and lapses older leaves; with no new H grant nothing lapses.
7. *Clock entry.* Removing the leaf holding the newest time without a `clock` entry is rejected, and with one the floor holds. Leaves attest 100 and 90 with floor 0; removing the first installs floor 100, and a following commit and a renewal at 95 need no entry. A chained renewal lowering the maximum is rejected without the entry and accepted with one carrying the pre-commit tree time.
8. *Lapse and sending.* A lapsed member gets `admissible: false`, `encrypt` refuses, receivers refuse its frame before opening, and its non-renewing commit is rejected. Any member removes it. After renewal it sends again.
9. *Admission without a lock.* Against real `@kumiai/mls-rpc` with `simpleHandleAccess`, an adoption callback inside `replace` awaits `sendAdmission()` and then `dispatch`: both resolve, the admission reports the pre-adoption epoch, and after `replace` the new one.
10. *Renewal.* A renewal after the old `exp` succeeds, a lower `iat` is rejected, a delayed old-epoch message still decrypts, and a pending Add is not absorbed.

**Lifecycle groups**
11. *Device ops.* A capability revoke by T, and `register`, `add` and `label`, are rejected.
12. *Binding is membership.* A second agent is admitted with no role entry, and the Welcome check passes. A floating or foreign-bound leaf is refused by Add, external join and Welcome. A malformed `controller` refuses the group.
13. *Invite path.* `createInvite` and `commitInvite` sign and enact no role entry, the key package is bound to `recipientDID`, another DID raises `InviteRecipientMismatchError`, and `processWelcome` refuses an invite naming another DID. A consumer entry in `entries` lands in the Add commit; of two admissions with the same consumed-ID entry one wins and the loser's retry sees it. A consumer entry from a DID with no leaf is rejected.
14. *Fixed identity.* A replacement that changes key, goes floating or names another controller is rejected; one whose capability changes from direct to chained and whose prefix gains a rotation is accepted.
15. *Registry agreement (C3, other groups).* P's manager registering a Q-bound DID as P's, an `add` whose Add carries a leaf bound to another controller, and registering a floating subject for anyone but the subject are rejected.

**Proofs and floors**
16. *Proven revoke.* A member with no role publishes a proof: the epoch rises by one, D's leaf is gone, `revocationOf` returns the log position, and a leafless subject gets a record and is refused at Add. Two members at once: one wins, the other gets `'already-revoked'`.
17. *Rejected proofs.* No `rev`, the wrong controller, a capability-authorised `rev`, a skipped event, a suffix that does not attach, a suffix holding a reset (`needs-reset` on the helper), a wrong `revoked` list and Removes that differ from it are rejected on receive and `'not-provable'` from the helper.
18. *Suffix against the recorded log.* After a first proof revoking E, H signs 50 rotations and `rev x=Mallory`; the proof carries only the 51-event suffix and is applied identically by every live member, the author's derived handle, a restored handle and a Welcome joiner. A later proof for a `rev` the recorded log already holds carries an empty suffix.
19. *Ledger is the only revocation authority.* H signs an un-revoke of D after the group recorded D: D stays refused at Add and external join, and as a verdict signer.
20. *Generation floor.* After a reset, a stale-prefix grant is refused by Add and external join, a `rev` from the old generation is rejected, a rotation keeps earlier grants valid, the cascade removes leaves under a revoked T, and restore and Welcome rebuild records, deny set and floors identically.
21. *Composition.* Authored through the low-level API: revoke of T with an Add of a T-issued child, reset with a stale-generation Add, revoke with a path renewal, two revoke entries in one commit, and a renewal with a lapse Remove are rejected.

**History horizon**
22. *Bound on every growth.* With history size 1 KB below the horizon, an Add whose prefix is 2 KB, a renewal whose prefix grows by 2 KB, an external replacement doing the same, and a proof whose suffix is 2 KB are each rejected by every receiver, the removed receiver of a lapse Remove included, and each helper fails before publishing (`history-horizon`, or `'not-provable'` `too-large`). Removing a leaf, or a renewal that shortens its prefix, is accepted while over.
23. *Reset is the path.* The same group: agents renew with prefixes `[icp, reset]`, the reset commit lands, and the earlier proof is then accepted.
24. *Frames fit.* In `@kumiai/integration-tests` through `@kumiai/hub-server` and `HubClient`: a group at the horizon, with a 64 KiB consumer entry, publishes a commit, a Welcome and a sealed GroupInfo reply carrying its ledger, each accepted by the hub's schema. A frame one byte over the cap throws `FrameTooLargeError` before it is journalled, and the hub receives nothing.

**Revoke run**
25. *One commit, rebuilt after a lost race.* Alice's proof loses the epoch race to carol's commit; the lane rebuilds it against the new recorded log and lands it as one commit.
26. *Removal before the next broadcast.* Bob queues a log entry, then calls `publishRevokeProof`; the publish is delayed. No log frame of bob's reaches the hub before the revoke commit. Bob is killed after the journal write and before the publish: after restart the journal replays the revoke, and the queued entry is published only after it lands. Without the journal flag, the entry is published first. A frame sealed before the call whose `lastAttempt` write is paused until the revoke starts is not submitted before the revoke lands, and a publish in flight when it starts settles before the revoke commit is published (epoch-change test 36a).
27. *Speculative handles.* A revoke of T that loses the race leaves T-issued credentials valid on the original handle and fires no `deviceRevoked`; after the winner is processed it fires once. For a won race it fires at `confirmAdopted()` and a second call fires nothing.
28. *Pipeline.* A commit with an invalid path that removes a receiver: survivors reject it and keep their state, and the old epoch still decrypts. An always-accept caller policy does not admit an identity-changing Update, a floating Add or a lapsed Add.

**Recovery** (through the real `@kumiai/mls-rpc` adapter and `@kumiai/rpc` peer, a retention gap stranding a bound member)
29. *Binding reuse.* A cached binding valid by wall clock rejoins with no `recoveryBinding` call.
30. *Fresh binding.* A cached binding expired by wall clock but live in tree time: `recoveryBinding` is called once, and the fresh binding is accepted.
31. *Renewal required.* No fresh binding (`null`, or no port), or one that fails the check (another controller, a lower `iat`, a tree-time regression, over the horizon): `'renewal-required'`, and no recovery request reaches the rendezvous topic, then or on later pulls, heal triggers or worker backoff. Once the port answers, `recover()` rejoins.
32. *Floating refused.* A floating replacement authored through the low-level API is rejected, and `joinGroupExternal` without `controller` throws `floating-refused`.
33. *Tree-lapsed but present.* A leaf lapsed in tree time rejoins with a fresh binding; the same change as a member commit is rejected.
34. *Refusal reasons.* With the recovery check stubbed to pass, a binding below a `genFloor` the reply's ledger carries is refused with `'floor'`: the pending handle is discarded, `'renewal-required'` is reported, and the next attempt calls `recoveryBinding()` instead of reusing it. An `'invalid'` refusal reports `'refused'` and starts no further attempt until `recover()`.
35. *Floor raised in the gap.* A `timeFloor` installed while the member was detached makes its recovery report `'renewal-required'` with no external commit; a reply whose ledger does not fold to the GroupInfo's head is refused.

**Verdict gate** (Mallory kept epoch E's secrets and is revoked by a proof commit at E+1; bob is stranded at E)
36. *Known revocation.* Bob's own ledger, or the reply's ledger from alice, records Mallory revoked. Mallory seals E's GroupInfo, applies bob's external commit on her E state and confirms with a valid tag: her confirmation and her GroupInfo attestation are advisory under (b), and bob adopts only on alice's confirmation. Run with each verdict first. Without the gate, bob adopts the obsolete branch.
37. *Revoked chain issuer.* The same with T revoked and Mallory's leaf issued by T: advisory under (b). With T's revocation unknown to bob and Mallory's leaf `exp` equal to T's trusted grant `exp`, her confirmation counts up to that `exp` plus 300 s on bob's clock and is advisory under (d) just past it.
38. *Floor, lapse, no leaf.* A pre-reset confirmer is advisory under (c); a confirmer whose leaf `exp` is before bob's `now − 300 s` under (d); a confirmation re-signed by a DID with no leaf in the pending tree under (a).
39. *Residual boundary.* Nothing bob holds records Mallory's revocation and only she answers: bob adopts on her confirmation at a clock of exactly her `exp` plus 300 s, and just past it her confirmation is advisory and the attempt reports `'unconfirmed'`.
40. *Stale refusal.* Mallory's correctly bound `refused: 'policy'` arrives first while bob knows her revocation: it is advisory, and bob adopts on alice's confirmation.

**Conformance and kokuin**
41. Both conformance suites pass.
42. `createCapability` and `checkCapability` reject a child that outlives its parent.

## Release

- **kokuin first.** The `@kokuin/capability` patch (§6) releases before the kumiai change.
- **kumiai** ships patch versions within the current band, with no anchor version change. It is a coordinated breaking change, and every peer of a lifecycle group runs the same release: old peers reject proofs and the `reset` and `clock` ops, ignore `GroupAnchor.controller`, `leafLifetime` and `trustedGrantLifetime`, accept self-issued leaf capabilities, and refuse expired leaves the time-free auth service accepts.
- **API and wire breaks:** `GroupAnchor.controller`, `leafLifetime` and `trustedGrantLifetime`; `Invite.recipientDID`, `createInvite` without `permission` in lifecycle groups; the synchronous `HandleAccess.admission()`; `confirmAdopted()` and helpers no longer emitting before adoption; `revokeWithProof` in `@kumiai/mls` and `publishRevokeProof` in `@kumiai/mls-rpc` as one lane commit with `holdLogSends`; proofs as suffixes against the recorded log; the history horizon and `LeafBindingError` `history-horizon`; the whole-frame check and `FrameTooLargeError`; `RevokeProofReason` `detached` and `needs-reset`; `GroupMLSParams.recoveryBinding`, `GroupMLS.prepareRecovery`, the widened `applyRecovery` result, `RecoveryFailureReason` `'renewal-required'`, the lifecycle refusal reasons, and a sealed GroupInfo reply carrying the ledger. These add to the `@kumiai/mls-rpc` and `@kumiai/rpc` patches of the epoch-change spec, which ships in the same release.
- **Docs.** `docs/reference/reserved-namespaces.md` adds `kumiai.device` with its ops (`register`, `add`, `revoke` with and without proof, `reset`, `clock`, `label`, `beacon`) and the lifecycle restrictions. The anchor reference documents `controller`, `leafLifetime`, `trustedGrantLifetime` and the exact-version requirement. A security section in the mls reference states the Accepted tradeoffs.

### Consumer contract

kubun adopts this release and the epoch-change spec in one bump. `C` is kubun's spec (`kubun-wt/catalog-sync/docs/superpowers/specs/2026-09-27-catalog-sync-design.md`) §5, which names the controller C and the group H; `P` is its plan, Task 13a+13c. The epoch-change spec's Release list is the delivery checklist (P Task I6).

1. **Creation.** `createOwnAgentsGroup` passes the creator's `ControllerBinding`, so the anchor's controller is the creator's leaf controller, kubun's `leafLifetime` (option `ownAgentsLeafLifetime`, default 24 h) and kubun's `trustedGrantLifetime` (option `ownAgentsTrustedGrantLifetime`, default 30 days). The label is required.
2. **Membership** is a live leaf bound to H in the tree. The current-head check stays a local refusal, never an MLS input.
3. **Admin.** Every member may admit agents and enact kubun's entries. No discretionary removal; no device registration.
4. **Revocation.** Any member that obtains H's `rev x=D` runs `publishRevokeProof` in every own-agents group of H, including groups where D has no leaf, with H's log as it holds it, on the group's one peer, which kubun runs on the group's designated commit hub (epoch-change spec §5, *One owner per group*). kumiai holds that peer's log submissions for the group until the commit lands, so kubun adds no hold. On a thrown lane failure kubun reruns on that group's next hub reconnect. On `needs-reset` it publishes `{ reset: true, log }` first, then reruns; on `detached` it reruns once it holds a log through the group's recorded head; on `too-large` it reports it (H's path: a reset, or a new group when the ledger alone is full). `'self-affected'` names the subject another member must publish for.
5. **Permanence.** A revoked agent DID is never re-admitted to a group that recorded it; a reset revokes the earlier generation.
6. **Lapse and renewal.** A named operation obtains fresh capabilities and calls `renewLeaf` in every group at least once per `leafLifetime`. H's signing cadence is the tree-time lapse granularity. H re-issues T's trusted grant at least once per `trustedGrantLifetime`, or T's children are refused.
7. **Head and beacon** stay local; the beacon gates nothing.
8. **Adoption.** kubun publishes every `renewLeaf`, `removeLapsedLeaves` and `commitInvite` commit and adopts on acceptance; a revoke run publishes through the lane. Every adoption calls `confirmAdopted()`. After restore or Welcome, kubun reads `revocationOf`.
9. **Three contracts.** Leaf binding, group invite consent (`recipientDID`, `entries`) and the advisory head stay separate.
10. **Recovery.** kubun's `createGroupMLS` wrapper passes `recoveryBinding` for every own-agents group: a fresh binding for its own leaf key from H or T, or `null`; it never waits on the user. On `'renewal-required'` kubun obtains a grant and then calls `recover()`. On `'refused'` it reports and calls `recover()` only once the cause has changed. It adds no recovery timer.
