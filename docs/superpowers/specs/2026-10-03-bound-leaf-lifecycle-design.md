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
- **Device ops.** Only proven `revoke`, `reset`, `clock` and `beacon` are accepted. `register`, `add`, `label` and capability-authorised `revoke` are rejected: the registry here records only revocations and floors, and a trusted grant carries no `manage` permission.

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

**Proof bound.** A proof has at most 256 events and 256 KiB encoded. It is permanent and replayed at every Welcome, and any member can publish one, so this is a resource bound.

**Proven revoke.**
```
{ op: 'revoke', subject: D, proof: SignedEvent[], revoked: Array<{ did, cascadedFrom? }> }
```
Accepted when all of these hold:
1. `foldLog(H, proof)` succeeds, with H the anchor's controller. Every event must be authority-signed: a capability-authorised `rev` fails the sync fold.
2. Some event `k` is `rev` with `x` normalizing to D, `states[k].deny` contains D, and `states[k].gen ≥ genFloor(H)`. A `rev` from a generation that a reset retired is rejected, so an old compromised authority key cannot evict agents after the reset.
3. D is not already revoked.
4. `revoked` lists D first, then every pre-commit leaf whose chain issuer is D, each with `cascadedFrom: D`. Receivers recompute this list from the pre-commit tree and reject any difference.
5. The commit's composition follows §4.

Effects: each listed DID gets `{ status: 'revoked', controller: H, logPosition: k, cascadedFrom? }`, created if absent. Revoked records are terminal (`registry.ts:104-106`). The proof need not reach the log head, and a later kokuin un-revoke does not undo the record.

**Reset.**
```
{ op: 'reset', subject: H, proof: SignedEvent[], revoked: Array<{ did, cascadedFrom? }> }
```
- Accepted when `foldLog(H, proof)` succeeds and the proof contains a reset to generation `g > genFloor(H)` at position `k`.
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
- **Confirm before adopt.** Every lifecycle rejoin uses the epoch-change spec's confirm-before-adopt: the rejoiner keeps the derived handle pending until a responder that applied the external commit confirms at the new epoch. A responder refusal or the deadline discards the pending handle. This, not the checks below, is what keeps a refused rejoin from splitting the group.
- **Recovery check.** It runs the complete external-commit acceptance predicates of §4 on a candidate binding, not only the binding predicate: the own leaf L is present in the tree and not denied, so the commit is exactly `external_init` plus the Remove of L; the new leaf passes entry checks 1 to 7 with L as the leaf it replaces (H, credential, `exp` above tree time, generation floor, deny set, fixed identity, renewal order); and its attested time does not lower tree time, floor included, since an external commit carries no `clock` entry. A lapsed L is no obstacle (§4). It adds the external-join authoring check (`iat ≤ now < exp`, §2). Before the request it runs on the handle's own, possibly stale, state; after the GroupInfo, on the responder's state (below). A cached binding expired by wall clock but live in tree time would pass survivors, but the authoring check still forbids reusing it.
- **Port.** `GroupMLSParams`, the params of `createGroupMLS` (`mls-rpc/src/mls.ts:79-91`, `:189`), gains:
  ```ts
  recoveryBinding?: (request: { groupID: string; controllerID: string; current: ControllerBinding }) => Promise<ControllerBinding | null>
  ```
  kumiai calls it only in a lifecycle group, only when the cached binding fails the check or a responder refused it (below), and at most once per attempt. `null`, an absent port, or a returned binding that fails the check all mean "none". The binding is held for that attempt only. Once the rejoin is confirmed, it is the own leaf's binding, which later recoveries reuse.
- **Before the request.** The `GroupMLS` port (`rpc/src/crypto.ts:367`) gains `prepareRecovery(): Promise<'ready' | 'renewal-required'>`. `attemptBody` calls it before minting the request (`peer.ts:2445`). It picks the binding against the handle's own tree and registry. `'renewal-required'` ends the attempt before any GroupInfo is requested. Outside lifecycle groups it always answers `'ready'`.
- **The reply carries the ledger.** Today the sealed reply frames only the attestation and the GroupInfo (`mls/src/recovery.ts:553`, `:674`), and the rejoiner fetches the ledger only after its commit is published (`peer.ts:2555-2558`). So it cannot see a `timeFloor`, `genFloor` or deny entry raised during its gap. In a lifecycle group, `sealGroupInfo` also frames the responder's whole ordered ledger, the same tokens `sealLedger` seals, and the attestation's digest covers both. `openSealedGroupInfo` requires the ledger to fold to the head in the GroupInfo's GroupContext, or the reply is refused like any untrusted reply (`null`). The reply already goes only to a requester with a leaf in the responder's tree, as `sealLedger` does, so the ledger reaches no one new.
- **After the GroupInfo.** `applyRecovery` (`crypto.ts:468`) re-runs the check against the GroupInfo's tree and the registry folded from the reply's ledger. That is the responder's state: authenticated, but not necessarily the survivors' current state, since a responder can lag the group and the compare-and-set (`peer.ts:2496-2501`) only catches a commit published during the attempt. The check is therefore an optimisation that avoids a wasted publish of a commit the responder's own state already refuses. Confirm-before-adopt is the safety argument. If the held binding fails, it asks the host once (unless the host supplied it in this attempt). With no usable binding, it returns `{ renewalRequired: true }`, so its result widens to `PendingRecovery | { renewalRequired: true } | null`. The peer then ends the attempt instead of re-requesting (`peer.ts:2465`).
- **Responder refusal reasons.** A responder whose lifecycle gates reject the external commit reports one of these reasons in its confirm-before-adopt refusal. The union, `RecoveryRefusalReason = 'binding' | 'lapse' | 'floor' | 'policy' | 'invalid'`, is defined once in the epoch-change spec (§1, *Confirm before adopting*); this spec maps its gates onto it:
  - `'binding'`: entry check 1, 2, 5 (chain issuer) or 7 fails;
  - `'lapse'`: entry check 3 fails;
  - `'floor'`: entry check 4 fails, or the replacement lowers tree time;
  - `'invalid'`: anything else, such as no leaf L of the same agent to replace (check 6), a denied `id`, or a commit that is not exactly `external_init` plus that Remove. A correctly built commit is never refused for shape, so retrying cannot help.

  A caller policy that rejects it after the lifecycle gates accept reports `'policy'`.

  `'binding'`, `'lapse'` and `'floor'` are binding-fixable. The rejoiner discards the pending handle, marks the refused binding unusable so no later attempt reuses it, and behaves as for `'renewal-required'` below. `'policy'` and `'invalid'` are not binding-fixable. The rejoiner discards the pending handle and reports the epoch-change spec's `'refused'` outcome with the reason, and no automatic trigger starts another attempt until the host calls `recover()`.
- **Outcome.** `RecoveryFailureReason` (`peer.ts:223-228`) gains `'renewal-required'`, reported through `onRecovery` as `phase: 'failed'`. It differs from `no-responder` and `deadline`: no responder can fix it.
- **No retry loop.** The peer sets `renewalRequired`. While it is set, no automatic trigger starts an attempt or requests a GroupInfo: not `healIfRequested` (`peer.ts:2642-2652`), and not the delivery worker's backoff or its uncovered-floor rejoin (epoch-change spec). The strand and the held outbox entries stay, as for any failed recovery.
- **Resume.** The host calls `recover()` (`peer.ts:2629`, trigger `'consumer'`) once it can supply a fresh binding. That clears the flag and runs one attempt, which calls `recoveryBinding()` again. A ratchet by any other path also clears it. A `recover()` with nothing new costs one port call and no GroupInfo request.
- **Survivors.** The external-commit rule (§4) judges the replacement against the pre-commit tree and floors. A floating replacement fails entry check 1. One lapsed in tree time fails check 3. One below the floor fails check 4. One that lowers tree time fails the no-`clock` rule. A responder that refuses reports the reason above.
- **Why the ledger still rides the reply.** Without confirmation, a rejoin that survivors reject would split the group silently. Survivors refuse it like any refused commit and step over it (`mls-rpc/src/apply-commit.ts:119-132`, `peer.ts:1713-1716`), while the rejoiner on `main` adopts its handle as soon as the hub accepts the commit (`peer.ts:2510-2545`), bootstraps successfully because the external commit moved no head, steps over the next honest commit as the winning side of a fork (`classify.ts:282`), and seals app frames at an epoch no other member holds until a commit two epochs ahead strands it (`classify.ts:256`). Confirm-before-adopt closes this: the rejoiner adopts only on a responder's confirmation at the new epoch, never on the hub's acceptance. The ledger on the reply only makes the common refusal (a floor or deny entry raised during the rejoiner's gap) known before the publish, so it costs no commit and no wait for the deadline.

**Invites in a lifecycle group.** Today the invite path needs a role entry three times: the inviter guard (`group-commit.ts:114-116`), the recipient binding (`:400-412`) and the Welcome check (`group-welcome.ts:53-69`). A lifecycle group rejects role entries, so each is replaced:
- `Invite` gains `recipientDID`. The invite still carries the group's whole ledger, and the joiner still checks it against the authenticated head, so the history reaches the joiner without any new role grant.
- `createInvite` takes no `permission` in a lifecycle group and signs no role entry. Its guard is that the inviter holds a leaf in the group, instead of a registry-derived admin role. It takes optional `entries`: consumer (non-`kumiai.*`) entries the inviter signed, appended after the history so they ride the Add commit.
- `commitInvite` binds the key package to `invite.recipientDID` (the same `InviteRecipientMismatchError`), runs the entry checks and the author-side checks on the key package leaf, and enacts only the appended consumer entries. `commitWithEntries`'s admin guard (`group-commit.ts:194-199`) becomes, in a lifecycle group, "the committer holds a leaf".
- `processWelcome` requires `invite.recipientDID` to be the joiner, that the joiner's own binding names the anchor's controller, and that every leaf in the tree is bound to it.
- **One-time consent.** A leaf capability is reusable until it expires, so it is not consent to one admission. The consumer's per-group consent stays its own: the admitting member checks the consent and that its ID is not yet consumed, then passes a consumer entry recording the ID in `entries`. That entry lands in the same commit as the Add, so the admission and the consumption are one epoch and a concurrent second admission loses the epoch race and sees the ID consumed on retry. kumiai does not interpret the entry.

**Lifecycle helpers.** They follow the existing write-result contract (`DeviceWriteResult`: `commitMessage`, `newGroup`, `epoch`).
```ts
renewLeaf(group: GroupHandle, binding: ControllerBinding): Promise<DeviceWriteResult>

publishRevokeProof(
  group: GroupHandle,
  params: { subject: string; log: Array<SignedEvent> } | { reset: true; log: Array<SignedEvent> },
): Promise<
  | { status: 'committed'; result: DeviceWriteResult }
  | { status: 'already-revoked' }
  | { status: 'self-affected' }
  | { status: 'not-provable'; reason: RevokeProofReason }
>

removeLapsedLeaves(group: GroupHandle): Promise<{ removed: Array<string>; result?: DeviceWriteResult }>
```
- **Ownership.** Each helper runs under the group mutex, judges locally, and returns a commit and a derived handle. It neither mutates the input handle, persists, publishes nor retries.
- **A derived handle is speculative until adopted.** Constructing or discarding one leaves the input handle and its subscribers untouched:
  - **Own auth state.** Today the constructor re-points the context's shared deny holder at the newest handle (`group-handle.ts:345-349`), and `deriveGroup` shares the context (`:1423-1434`). So a candidate revoking T makes the live handle reject T-issued credentials before the group accepted anything, and a discarded candidate leaves that in place. Instead `deriveGroup` gives each handle its own context: the cipher suite is shared, the authentication service and its deny provider are the handle's own.
  - **No early events.** Helpers no longer fire events on the derived handle. Today `revokeDevice` and `announceControllerBeacon` do (`group-device.ts:173`, `:203`), before any transport accepted the commit. The derived handle holds its enacted control events as pending, and `newGroup.confirmAdopted()` fires them once; later calls do nothing, and a handle never confirmed fires nothing. `HandleAccess.replace` calls it after the host adoption callback resolves; a host that adopts outside `HandleAccess` calls it itself.
- **The consumer's part.** The consumer publishes `commitMessage` and adopts `newGroup` once its transport accepts the commit. If another commit wins the epoch, it discards `newGroup`, processes the winner, and calls the helper again on the new handle. Duplicates converge: after the winning revoke, a second call returns `'already-revoked'`.
- **`publishRevokeProof`** returns:
  - `'already-revoked'` when every DID it would revoke is already revoked and no affected leaf remains;
  - `'self-affected'` when the caller's own leaf is in the derived set, so another member must publish;
  - `'not-provable'` when the proof fails §3.
  It also commits a proof for a subject with no leaf, so the deny set closes later joins.
- **`removeLapsedLeaves`** removes every lapsed leaf, adding a `clock` entry when required. It returns `{ removed: [] }` with no result when there is nothing to remove.

**Reads and events:**
- `revocationOf(group, did)` returns `{ controller, logPosition, reason?: 'reset', cascadedFrom? } | null`.
- `GroupHandle.sendAdmission()` and `HandleAccess.admission()` (§2).
- `deviceRevoked` gains `logPosition`, `reason` and `cascadedFrom`. It fires once per listed DID at accepted adoption only: a received commit after it is persisted (`#notifyAccepted`, as today), an authored commit at `confirmAdopted()`, and `bootstrapLedger` for the entries it adds. Restore and Welcome project the records, deny set and floors silently, as today; the consumer reads them with `revocationOf`.

**Errors.** These are error classes, following kumiai's convention, and each carries a `reason`.
- `LeafBindingError`, with reasons `issuer-mismatch`, `subject-mismatch`, `chain-depth`, `self-issued`, `child-outlives-parent`, `denied-issuer`, `lifetime-cap`, `generation-floor`, `identity-change`, `controller-mismatch` and `floating-refused`.
- `LeafLapsedError`.
- `RevokeProofError` with `RevokeProofReason`: `no-rev`, `wrong-controller`, `not-authority-signed`, `generation-floor`, `too-large`, `effects-mismatch` and `removes-mismatch`. It is used on the authoring path, and `publishRevokeProof` maps it to `'not-provable'`.
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
- API breaks for the consumer: `Invite.recipientDID`, `createInvite` without `permission` in lifecycle groups, the synchronous `HandleAccess.admission()`, `confirmAdopted()`, helpers no longer emitting before adoption, and recovery: `GroupMLSParams.recoveryBinding`, `GroupMLS.prepareRecovery`, the widened `applyRecovery` result, `RecoveryFailureReason` `'renewal-required'`, the lifecycle refusal reasons in the confirm-before-adopt refusal, and a sealed GroupInfo reply that carries the ledger in lifecycle groups (a wire change, so responders and rejoiners must run the same release). These add to the `@kumiai/mls-rpc` and `@kumiai/rpc` patches the epoch-change spec releases.
- The consumer adopts the kokuin and kumiai releases together.

## Consumer contract

This release ships with the epoch-change delivery spec (`kumiai.worktrees/epoch-change-log-delivery/docs/superpowers/specs/2026-10-03-epoch-change-log-delivery-design.md`), and kubun adopts both in one bump. Paths: `C` is kubun's spec (`kubun-wt/catalog-sync/docs/superpowers/specs/2026-09-27-catalog-sync-design.md`), `P` its plan (`.../plans/2026-09-27-catalog-sync.md`). `C` names the controller C and the group H (§5, opening). Below, H is the controller, as in the rest of this spec. References name `C` §5's bullets and `P`'s tasks rather than lines, which move.

**Delivery.** The epoch-change spec's Release list (its kubun items) is the authoritative delivery checklist, and this spec does not repeat it. kubun carries it as `P` Task I6.

**Own-agents groups.** `C` §5 and `P` Task 13a+13c carry the lifecycle obligations below. Each must hold after the bump.
1. **Creation** (`createOwnAgentsGroup`). It passes the creator's `ControllerBinding`, so the anchor's controller is the creator's leaf controller. The label is required.
2. **Membership** (*Membership is the tree*). Effective membership is a live leaf bound to H in the tree. The current-head check stays a local refusal, never an MLS acceptance input.
3. **Admin semantics** (*Every member is an admin, and nobody evicts*). Every member may admit agents and enact kubun's ledger entries. No member removes another except by proof, lapse or self-removal, and kubun offers no discretionary removal. No device registers.
4. **Revocation** (*Revocation is a proof from C*, *No broadcast hold*). Any member that obtains H's `rev x=D` calls `publishRevokeProof` in every own-agents group of H, including groups where D has no leaf, and commits D's removal before its next broadcast to that group. There is no broadcast hold.
5. **Permanence** (*Permanence*). A revoked agent DID is never re-admitted, and a reset revokes the earlier generation.
6. **Lapse and renewal** (*Lapse and renewal*). A named operation obtains fresh capabilities and calls `renewLeaf` before `exp`. H's signing cadence is the lapse granularity.
7. **Unresolved head and advisory notice** (*Unresolved head and advisory notice*). Both stay local. The beacon gates nothing.
8. **Adoption and events** (*Commits and adoption*). kubun publishes every helper's commit, adopts on acceptance and reruns after a lost race. Every adoption calls `confirmAdopted()`. After restore or Welcome, kubun reads `revocationOf`.
9. **Three contracts** (the three admission contracts after the bullets). Leaf binding, group invite consent through `recipientDID` and `entries`, and the advisory head stay separate.
10. **Recovery binding** (*Recovery binding*). kubun's `createGroupMLS` wrapper (`plugin-p2p/src/groups/group-mls.ts:90`) passes `recoveryBinding` to the upstream factory for every own-agents group. It returns a fresh binding for the peer's own leaf key, with a leaf capability from H or from T, or `null` when none is available now. It never waits on the user. On `'renewal-required'`, including a responder's `'binding'`, `'lapse'` or `'floor'` refusal (§5), kubun reports it, obtains a grant through item 6's path, and then calls `recover()` on that group's peer. On `'refused'` (`'policy'` or `'invalid'`) kubun reports it and calls `recover()` only once the cause has changed. kubun adds no recovery timer.

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
- After revoking T with cascade, and after a reset, a live receiver, the author's derived handle, a restored handle and a Welcome joiner hold identical records, deny sets and floors.
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

**Size**
- A realistic proof (icp, two rotations, rev) with Ed25519 stays under 2 KiB, and a proof over the bound is rejected.

**Conformance**
- Both conformance suites pass.

**kokuin**
- `createCapability` and `checkCapability` reject a child that outlives its parent.

## Docs

- `docs/reference/reserved-namespaces.md`: add `kumiai.device`, with its ops `register`, `add`, `revoke` (with and without proof), `reset`, `clock`, `label` and `beacon`, and the lifecycle-group restrictions. The file is missing it today.
- The anchor reference documents `controller` and the exact-version requirement.
- A security section in the mls reference covers the accepted tradeoffs in the Goal section:
  - revocation is permanent while kokuin can un-revoke;
  - a stolen trusted agent can grant until its grant expires or it is revoked, but cannot move tree time;
  - a revoked agent can still read until the first commit carrying the proof;
  - tree time follows H's signatures, so lapse lags real time and stalls when H signs nothing;
  - a removed receiver cannot see the commit path (§4).
