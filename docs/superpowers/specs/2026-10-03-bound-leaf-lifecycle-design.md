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
- the commit-pipeline gates these need, and the issuing and lifecycle API.

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
- **Authority is the binding.** The roster is seeded `{H: admin}` instead of `{creatorDID: admin}` (`roster.ts:45-47`), and `kumiai.role` entries are rejected. A commit sender whose pre-commit leaf is bound to H acts as H. Every member therefore may Add an agent and move the ledger head. Removal is narrower (§4).
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
- A lapsed member's commit is accepted only when it is an empty commit whose path renews its own leaf out of lapse.
- `GroupHandle.sendAdmission()` returns `{ epoch, admissible: true }`, or `{ epoch, admissible: false, reason: 'lapsed' }` when the own leaf is lapsed at the handle's current epoch. `encrypt` refuses a lapsed sender with `LeafLapsedError`, and the consumer's outbox must refuse to enqueue (see the epoch-change delivery spec).
- `decrypt` and `decryptStaged` read the sender leaf before opening (`group-handle.ts:873-877`, `:915-919`). They refuse a lapsed sender with `LeafLapsedError` there, so no ratchet generation is consumed. The sender is named only at the receiver's current epoch, so the receiver judges the same tree and ledger the sender did, and both reach the same verdict.

**Author-side checks.** These use the local clock and only stop the device itself from producing a bad change. `createGroup`, `createKeyPackageBundle`, `createLastResortKeyPackageBundle`, `joinGroupExternal`, `commitInvite`, `addDevice` and `renewLeaf` refuse a capability whose `exp ≤ now` or whose `iat > now`.

**Renewal.** `renewLeaf(group, binding)` makes an empty commit whose path carries the own leaf with the new binding.
- It uses the same signature key, needs no ledger entry, and absorbs no pending proposals, so the commit always carries a path.
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
- Accepted when `timeFloor(H) < time ≤ treeTime(H)` of the pre-commit epoch. Effect: `timeFloor(H) = time`.
- **Required** in any commit whose post-commit tree time, computed without the floor, would fall below the pre-commit tree time. Removals are known before the path, and §4 keeps the path credential unchanged in removal commits, so this is checked in the callback. Helpers add the entry themselves.

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
2. **Callback** (sync, inside ts-mls; it runs for every receiver, including a removed one). It holds every proposal-level verdict: entry checks on Add and Update leaves, Remove legitimacy, the lapsed-sender restriction, composition rules, the clock requirement, and the external-commit rules. It needs no async work: chain signatures were already verified by the auth service, and the generation of a prefix is a synchronous fold.
3. **Post-apply gate** (survivors only, after ts-mls returns, before the state is adopted). It judges the committer's path leaf against the pre-commit leaf: entry checks if the credential changed, unchanged credential where the composition rules require it, and renewal out of lapse for a lapsed sender. It runs before `this.#state` is assigned, persistence, ledger application, events and zeroisation.
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
- **External commit:** exactly `external_init` plus one Remove of an existing leaf L. The new leaf passes the entry checks with L as the leaf it replaces, so it is the same agent with the same key, bound to H. It may not lower tree time, since an external commit carries no entries. Membership comes from the binding, not from a roster role, so this replaces the roster gate (`policy.ts:268-297`) in lifecycle groups.

**Composition rules.**
- A commit that enacts a `revoke` or `reset` carries exactly one such entry, its derived Removes, the head move and an optional `clock` entry. It carries no Add, Update, PSK or other Remove, and the committer's path leaf keeps its credential. A member listed in `revoked` cannot author it.
- A commit that carries any Remove keeps the committer's path credential unchanged. Renewal and removal go in separate commits.
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
- `createKeyPackageBundle`, `createLastResortKeyPackageBundle` and `joinGroupExternal` take `controller?: ControllerBinding` (today `group-credential.ts:54`, `group-welcome.ts:237`).
- `processWelcome` into a lifecycle group requires no role entry naming the joiner (`group-welcome.ts:54-67`). Instead it requires that the joiner's own binding names the anchor's controller and that every leaf in the tree is bound to it.

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
- **The consumer's part.** The consumer publishes `commitMessage` and adopts `newGroup` once its transport accepts the commit. If another commit wins the epoch, it discards `newGroup`, processes the winner, and calls the helper again on the new handle. Duplicates converge: after the winning revoke, a second call returns `'already-revoked'`.
- **`publishRevokeProof`** returns:
  - `'already-revoked'` when every DID it would revoke is already revoked and no affected leaf remains;
  - `'self-affected'` when the caller's own leaf is in the derived set, so another member must publish;
  - `'not-provable'` when the proof fails §3.
  It also commits a proof for a subject with no leaf, so the deny set closes later joins.
- **`removeLapsedLeaves`** removes every lapsed leaf, adding a `clock` entry when required. It returns `{ removed: [] }` with no result when there is nothing to remove.

**Reads and events:**
- `revocationOf(group, did)` returns `{ controller, logPosition, reason?: 'reset', cascadedFrom? } | null`.
- `GroupHandle.sendAdmission()` (§2).
- `deviceRevoked` gains `logPosition`, `reason` and `cascadedFrom`. It fires once per listed DID, from the ledger fold, on every replay path.

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
- The consumer adopts the kokuin and kumiai releases together.

## Consumer contract

kubun's §5 (`kubun-wt/catalog-sync/docs/superpowers/specs/2026-09-27-catalog-sync-design.md`) must change as follows to match this design and plan row 85 (`.../plans/2026-09-27-catalog-sync.md:85`). The controller amends kubun; this spec does not.
1. **Membership** (`:864-866`). Effective membership is a live leaf bound to H in the tree, which any member verifies from the tree. The current-head check stays as a local refusal of sessions and requests, never as an MLS acceptance input.
2. **Registry and unbinding** (`:867-873`). No device registers at join: `register`, `add`, `label` and capability revoke are rejected in lifecycle groups. Unbinding is H's authority key signing `rev x=D`. Any member that obtains the log calls `publishRevokeProof` in every own-agents group, including groups where D has no leaf.
3. **Broadcast hold** (`:874-879`). The hold is removed. A member that sees `rev x=D` commits D's removal before its next broadcast to H. Local refusal of D stays.
4. **Creation** (`:861`, `:986`). `createOwnAgentsGroup` passes the creator's `ControllerBinding`, so the anchor's controller equals the creator's leaf controller. A joiner's Welcome check authenticates the anchor. The label is required in both the prose and the GraphQL signature.
5. **Admin semantics.** Every member may admit agents. No member may remove another except by proof, lapse or self-removal. kubun must not offer discretionary removal in own-agents groups.
6. **Handoff and admission** (`:893-906`). The handoff delivers a leaf capability from H or from T. A trusted agent is not a revocation signer. Admission requires the joiner's key package to be bound to H and not lapsed. A freshly resolved head is not an MLS gate.
7. **Renewal.** A named consumer operation obtains fresh capabilities and calls `renewLeaf` in each group before `exp`. Because only H-signed time advances tree time, the consumer decides H's signing cadence, and that cadence is the lapse granularity.
8. **Write results.** The consumer publishes every helper's commit, adopts the new handle on acceptance, and re-runs the helper after losing an epoch race.
9. **Send admission.** `GroupHandle.sendAdmission()` backs the rpc port's `sendAdmission` from the epoch-change delivery spec.
10. **Permanence.** A revoked agent DID is never re-admitted, and a reset revokes every agent of the earlier generation. Replacements need new DIDs and new grants.

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
- With no new H grant for months, nothing lapses. This documents the stall.

**Lifecycle groups (C2, I7, I8)**
- A capability revoke by T, and `register`, `add` and `label` entries, are rejected in a lifecycle group.
- A group is created with a controller binding. A second agent is admitted with no device role, and the joiner's Welcome check passes. A floating or foreign-bound leaf is refused by Add, by external join and at Welcome.
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
- Authored through the low-level API, these are rejected: revoke of T with an Add of a T-issued child, reset with a stale-generation Add, revoke with a path renewal, and two revoke entries in one commit.

**Pipeline (I3, I4)**
- A renewal and a lapse Remove go in separate commits. Combined in one commit, they are rejected.
- A commit with an invalid path that removes a receiver: survivors reject it and keep their state, ledger and events, and the old epoch still decrypts. The removed receiver's outcome is the documented residual.
- An always-accept caller policy does not admit an identity-changing Update, a floating Add into a lifecycle group, or a lapsed Add.

**Renewal (M2)**
- A renewal after the old `exp` succeeds, and a renewal with a lower `iat` is rejected.
- A delayed message from the old epoch still decrypts after the renewal.
- A pending Add is not absorbed, and the commit carries a path.

**Lapse and sending (I10)**
- A lapsed member gets `admissible: false` from `sendAdmission`, and `encrypt` refuses. Receivers refuse a lapsed sender's frame before opening it.
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
