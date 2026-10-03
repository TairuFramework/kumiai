# Bound-leaf lifecycle and proven revoke

## Goal

A user holds a `did:kokuin` controller H. Its authority key is kept offline or in hardware. The user adds agents (devices, apps, bots, services), and each agent has its own `did:peer`. The agents are the MLS members. H always keeps complete authority to revoke an agent.

This design makes `@kumiai/mls` carry that model end to end, so a consumer only calls it:
- **Binding.** Each agent's leaf proves it is bound to H.
- **Delegation.** One trusted agent T may grant short-lived leaf capabilities to other agents, so the hardware key is not needed for routine grants.
- **Revocation.** When H signs `rev x=D` into its controller log, any member can publish that log into a group as proof. The group ledger then records "D revoked by H at log position N", permanently, and the same commit removes D's leaf and starts a new epoch.
- **Expiry.** Capability expiry is a backstop, not the main control. A lapsed leaf never blocks the group, and the members bound to the same controller can remove it.

Accepted tradeoffs (user rulings, 2026-10-03):
- **Eventual consistency.** Between H's `rev` and the first member commit that carries the proof, D can still read the group.
- **Short grants expire.** An agent that stays offline past its capability's `exp` is removed and must rejoin with a fresh grant.
- **Only H's authority key revokes** for now. A trusted agent cannot revoke.
- **Revocation is permanent in kumiai.** kokuin can later un-revoke D (a `rot` whose `d` snapshot omits it, or a reset). kumiai ignores that: D's DID stays revoked in every group that recorded it. A replacement agent needs a new `did:peer`.
- **A stolen trusted agent** can grant leaf capabilities to attacker agents until the user revokes it and a member publishes the proof.

The first consumer is kubun's own-agents groups. It is the only consumer of this branch, so breaking wire and API changes are allowed in patch releases.

## Scope

In scope, in `@kumiai/mls`:
- the issuer pin for bound-leaf capabilities (F1, a privilege escalation found by the probe)
- delegation chains of depth 1 through a trusted agent
- an expiry check at leaf entry, with no wall clock on receive
- leaf renewal
- a fixed leaf identity
- a proven revoke, a cascade and a reset
- removal of lapsed leaves
- a deny set that also applies to floating leaves
- a "bound leaves only" group setting
- the commit-policy changes these need
- issuing helpers and lifecycle helpers.

In scope, in `@kokuin/capability`: a child capability may not outlive its parent.

Out of scope:
- **Chains deeper than 1.**
- **Revokes authorised by a capability** (the management tier). They need a time-free verify mode in kokuin first.
- **Capabilities an agent issues to itself.**
- **Changes to ts-mls.** Everything here runs on the current ts-mls release.
- **The `rev` producer and log publishing.** These belong to the consumer or app. The consumer calls `createRevoke` with H's authority key and publishes the log.
- **Fan-out of proofs across groups.** The consumer calls the helper for each group.

## Background

A probe against kumiai `0d0ee9f` and ts-mls `2.0.0-rc.13` found the following.

**F1: the bound-leaf capability issuer is never pinned.**
- `verifyPinnedCapability` (`authentication.ts:103-144`) passes `requireIssuer` only on the manage path (`:196`), and never checks `sub`.
- `did:key` and `did:peer` issuers verify without a resolver. So a device can sign its own `kumiai/mls-leaf` capability naming any controller and embed that controller's public inception as the prefix.
- The probe showed an end-to-end escalation:
  1. A floating member re-labels its leaf as bound to an admin profile P through an empty path commit.
  2. It self-registers as a device of P (`device-proof.ts:56-60`).
  3. Its admin-only role entry is accepted.
- The legitimate fixture capability already has `iss == sub == controller.id`.

**A lapsed bound leaf freezes the group.**
- ts-mls validates every leaf's credential on Welcome join (`clientState.js:591`, through `validateRatchetTree`) and on external join (`createCommit.js:246`).
- kumiai's credential check rejects an expired capability (`assertDeviceCapabilityPolicy` against `Date.now()`).
- So one lapsed leaf blocks every Welcome and external join (`ValidationError: Could not validate credential`). The lapsed leaf also cannot commit with a path.

**Renewal is possible today.**
- No public ts-mls API takes a replacement credential.
- Both `createCommit` (UpdatePath) and `createUpdateProposal` copy the own leaf from `state.ratchetTree`. Handing them a state copy whose own leaf carries the new credential makes ts-mls sign the new LeafNode.
- ts-mls enforces no identity-stability rule on an Update or path leaf.

**Other facts the design relies on:**
- **Revoke proof.** An authority-signed `rev x=D` folds synchronously with `foldLog` in about 2 ms. The `icp` plus `rev` is about 0.7 KB with Ed25519.
- **Unknown subjects.** `registryApply('revoke')` is a no-op for a subject with no record (`registry.ts:121`).
- **Floating leaves escape the deny set.** It is consulted only for bound leaves (`authentication.ts:163`).
- **Removing an admin.** The anti-demotion rule (`policy.ts:229-235`) blocks removing a DID that holds `admin`.
- **No shared clock.** No commit timestamp exists that every member agrees on: the envelope, the ledger entries and MLS carry none.

## Design

### 1. Capability shapes

**Leaf credential.** The member is the agent:
```
{ v: 1, id: <agent did:peer>, longForm?,
  controller: { id: H, prefix: <H log from icp, authority-only>, capability: <leaf capability> } }
```

**Leaf capability.** It takes one of two forms.

| | Direct | Through a trusted agent T |
|---|---|---|
| `iss` | H | T |
| `sub` | H | H |
| `aud` | agent | agent |
| permission | `authenticate` on `kumiai/mls-leaf` | the same |
| `cnf` | the agent's leaf key | the same |
| `iat`, `exp` | required | required |
| `cap` | absent | T's trusted grant |

**Trusted grant (the parent).**
- `iss = sub = H`, `aud = T`.
- Permissions: `authenticate` on `kumiai/mls-leaf`, which T may delegate, plus `manage` on `kumiai/devices`.
- `cnf` is T's leaf key. `iat` and `exp` are required.
- T is a member with its own direct leaf capability.

**Verification.** `validateCredential` runs these checks, all deterministic and offline.
1. `controller.id` is a `did:kokuin`, and `prefix` folds to it with the synchronous `foldLog` (embedded resolver, unchanged).
2. Every token in the chain has `sub = controller.id`.
3. The root token has `iss = controller.id` and verifies against a key that is valid in the prefix. This is the F1 fix.
4. The leaf token has `aud = id`, and its `cnf` equals the leaf's signature key.
5. In the chained form:
   - the parent has `aud = T`, and the leaf token's signature verifies against the parent's `cnf`;
   - the parent's permissions cover the child (`checkCapability`);
   - the child's `exp` is no later than the parent's;
   - T is not in the deny set.
6. Each token is within its lifetime cap: `exp - iat ≤ leafMaxLifetime` for the leaf, and `≤ parentMaxLifetime` for the parent.
7. `id` is not in the deny set.

What is not checked: `exp` against "now". That check moves to leaf entry (§2).

The manage path (`verifyManagementCapability`) also requires `sub = controller.id`. A trusted grant serves as T's management capability for `register`, `add` and `label`.

**Group settings.** They are carried in the genesis anchor as a new optional field, with no anchor version change:
```
GroupAnchor.binding?: { boundOnly: boolean, leafMaxLifetime: number, parentMaxLifetime: number }
```
- Lifetimes are in seconds.
- When the field is absent, the defaults apply: `boundOnly = false`, leaf 7 days, parent 365 days.
- Every member reads the same values, so receive-side verdicts agree.

### 2. Time, entry checks and renewal

**Tree time.** For controller H, `treeTime(H)` is the highest `iat` over the leaf capabilities of all current leaves bound to H.
- The committer's leaf as it stands after the commit counts, which includes a renewed path leaf.
- Every member computes the same value from the tree, with no clock.
- Only H's grants can raise `treeTime(H)`, so a foreign controller cannot move it.

**Receive-side checks.** They run when a leaf L bound to H enters or changes, and each must pass.
- **Add, external join, Update, and the committer's path leaf:**
  - `L.exp > treeTime(H)`, where tree time is computed without L itself;
  - the chain is valid with no denied issuer.
  - When H has no other leaf in the tree, the check falls back to `L.exp > L.iat`.
- **Renewal** (the same leaf index and the same identity): the new `iat` must be at least the old `iat`.
- **A commit sent by a lapsed leaf** (`exp < treeTime(H)`, before any renewal in that commit) is rejected, unless the commit renews that leaf.
- **An application message from a lapsed leaf** is dropped.

Where the checks run:
- **Add and Update leaves:** in the sync policy callback, since the proposals carry the LeafNode.
- **Commit-path leaf:** in a gate in `processMessage` after apply, which uses the existing rollback (`group-handle.ts`, about lines 1331-1356).
- **External commit:** in the PublicMessage pre-pass.

**Author-side checks.** These use the local clock and only stop the device itself from producing a bad change. `commitInvite`, `addDevice`, `createGroup`, `createKeyPackageBundle`, `joinGroupExternal` and `renewLeaf` refuse a capability whose `exp ≤ now` or whose `iat > now`.

**Renewal.** `renewLeaf(group, binding)` makes an empty commit whose UpdatePath carries the device's own leaf with the new binding.
- It uses the same signature key and needs no admin and no ledger entry.
- It updates the handle's member credential.
- It is built with the state-copy technique: a `commitWithEntries` variant that takes an own-leaf credential override.
- Only the leaf's owner can sign its LeafNode, so a child agent applies its own renewal. Delivering a new capability from T to the child is the consumer's job.

**Fixed identity.** An Update or commit-path leaf may change only `controller.capability` and `controller.prefix`. The new prefix must still fold to the same `controller.id`.
- `id`, `longForm`, the signature key and `controller.id` never change.
- **The one exception:** a floating leaf may become bound once, keeping the same `id` and key. A group with `boundOnly` refuses floating leaves anyway.
- **Bound to floating is rejected.**

### 3. Registry, removal and deny

**Proven revoke entry.**
```
{ op: 'revoke', subject: D, proof: SignedEvent[] }   // proof: H log from icp through rev x=D
```
**Accepted from any member** when all of these hold:
1. `foldLog(C, proof)` succeeds, which requires every event to be authority-signed. A `rev` authorised by a capability fails the sync fold closed.
2. `C` is the controller recorded for D: `controllerOf(D)` from the registry, or else D's current leaf `controller.id`. If neither exists, the entry is rejected.
3. Some event `k` in the proof is `rev` with `x` normalizing to D, and `states[k].deny` contains D.

**Effects.**
- `registryApply` sets D's record to `{ status: 'revoked', controller: C, logPosition: k }`, creating the record if D has none.
- A revoked record is terminal.

The proof need not reach the log head. Proving "D was revoked at position k" is enough. A later un-revoke in kokuin does not undo it here.

A revoke without a proof keeps its current path, through a management capability, now with `sub` pinned.

**Reset entry.**
```
{ op: 'reset', controller: H, proof: SignedEvent[] }   // proof: H log from icp through a rot with higher g
```
- It is accepted from any member when `foldLog(H, proof)` succeeds and the proof contains a reset to generation `g`.
- Every leaf bound to H whose capability was verified under an earlier generation is revoked. A leaf's generation is the generation at the head of its prefix. A leaf whose prefix stops before the reset counts as the earlier generation, which fails safe: the consumer renews with a current prefix.
- Each revoked DID gets the record `{ status: 'revoked', controller: H, logPosition: <reset position>, reason: 'reset' }`. The entry's `subject` is H.

**Cascade.** When a DID T is revoked, by proof or by reset, every current leaf whose chain issuer is T is revoked in the same fold, with `cascadedFrom: T`.

**One commit per revoke.** The commit carries the revoke or reset entry plus a Remove for every leaf the fold revokes: the subject and its cascaded children.
- Receivers derive that set from the pre-commit tree and the entry, and reject a commit whose Removes differ from it.
- A subject with no leaf contributes no Remove.

**Lapsed-leaf removal.**
- A member M bound to H may Remove a leaf L bound to H when `L.exp < treeTime(H)`. Tree time includes M's renewed path leaf in that commit.
- It writes no ledger entry. Expiry is not revocation, so the agent may rejoin with a fresh grant.

**Deny set.**
- Every DID with a revoked record is denied. That applies on every leaf: bound and floating, on Add, external join and Update.
- Every revoked DID is also denied as a chain issuer.

**`boundOnly`.** When the anchor sets it, floating leaves are refused on entry.

### 4. Commit policy

- **Remove.**
  - A Remove that the fold derives from a proven revoke, a reset or a cascade is allowed from any member.
  - A lapsed-leaf Remove is allowed from a member bound to the same controller.
  - The anti-demotion rule does not apply to these Removes. Role entries keyed to a removed DID are dropped in the same fold.
- **Device-only commits.** `enactsOnlyDeviceEntries` includes `revoke` with a proof, and `reset`. A commit that carries only these plus the GCE head move needs no admin.
- **Roles.**
  - In these groups, roles are granted to H, and an agent acts through `authority(agent)`.
  - `authority()` resolves only active records. A revoked agent loses H's authority in the same fold.
  - `isAdmin` no longer falls back to a role keyed to a device DID whose record is revoked.
- **Beacon.** A proven revoke or a reset sets H's beacon to the proof's length and head digest when that is longer than the current beacon. No member needs to be bound to H for this.

### 5. API (`@kumiai/mls`)

**Issuing:**
```ts
mintLeafCapability(params: {
  signer: SigningIdentity        // H's authority signer, or T's leaf signer
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
  leafKey: Uint8Array
  exp: number
}): Promise<string>

buildBoundCredential(params: {
  identity: OwnIdentity
  controllerID: string
  prefix: Array<SignedEvent>
  capability: string
}): MemberCredential
```
- Both minting helpers always set `iat`.
- `mintLeafCapability` refuses a child `exp` later than the parent's.

**Group setup:**
- `createGroup(..., { binding?: { boundOnly?, leafMaxLifetime?, parentMaxLifetime? } })` writes `GroupAnchor.binding`.
- `createKeyPackageBundle`, `createLastResortKeyPackageBundle` and `joinGroupExternal` take an optional `controller?: ControllerBinding`, and build a bound credential when it is given.

**Lifecycle:**
```ts
renewLeaf(group: GroupHandle, binding: ControllerBinding): Promise<void>

publishRevokeProof(
  group: GroupHandle,
  params: { subject: string; log: Array<SignedEvent> } | { reset: true; controller: string; log: Array<SignedEvent> },
): Promise<'committed' | 'already-revoked' | 'not-provable'>

removeLapsedLeaves(group: GroupHandle): Promise<Array<string>>
```
- **`publishRevokeProof`:**
  - It runs under the group mutex and checks the proof locally.
  - It returns `'already-revoked'` when the registry already holds the revocation and no affected leaf remains.
  - On an epoch conflict it re-reads state and retries.
  - It returns `'not-provable'` instead of throwing when the proof does not prove the claim.
  - Several members publishing the same proof is safe: one commit wins, and the others see `'already-revoked'`.
- **`removeLapsedLeaves`:** it commits the Removes the caller is allowed to make (same controller) and returns the removed DIDs. It returns an empty list when there are none.

**Reads and events:**
- `revocationOf(group, did)` returns `{ controller, logPosition, reason?: 'reset', cascadedFrom? } | null`.
- `deviceRevoked` gains `logPosition` and `cascadedFrom`.
- A new event `leafLapsed` carries `{ did, controller }`. It fires when a member observes that a leaf has lapsed.

**Errors.** These are error classes, following kumiai's convention, and each carries a `reason`.
- `LeafBindingError`, with reasons `issuer-mismatch`, `subject-mismatch`, `chain-depth`, `child-outlives-parent`, `denied-issuer`, `lifetime-cap`, `identity-change` and `floating-refused`.
- `LeafLapsedError`.
- `RevokeProofError`, with reasons `no-rev`, `wrong-controller`, `not-authority-signed` and `removes-mismatch`. It is used on the authoring path. `publishRevokeProof` maps it to `'not-provable'`.
- A commit rejected on receive goes through the existing rejection path.

### 6. kokuin

In `@kokuin/capability`:
- `createCapability` refuses a delegated child whose `exp` is later than its parent's `exp`, or that has no `exp` while its parent has one.
- Chain verification (`assertValidDelegation`, called by `checkCapability` and `checkDelegationChain`) rejects the same.
- This is released as a patch version before the kumiai change. Nothing else in kokuin changes.

### 7. Release and compatibility

- kumiai ships as patch versions within the current version band.
- It is a coordinated breaking change. Old peers reject a revoke carrying a proof (`verifyDeviceEntry` demands a management capability) and the new `reset` op. Pinning the issuer also rejects any self-issued leaf capability.
- The consumer adopts both releases together.

## Testing

Each test must fail with its fix removed.

**F1**
- A self-issued leaf capability naming a foreign controller is rejected (`issuer-mismatch`).
- The probe's full escalation chain fails at the first step: re-label, self-register, admin role entry.
- A manage capability with `sub` other than the profile is rejected.

**Chains**
- A leaf capability issued by T is accepted.
- These are rejected: depth 2, a child that outlives its parent, `sub` other than H, a denied T, and a parent over its lifetime cap.

**Fixed identity**
- Changing `id`, the key or `controller.id` through an Update or a commit path is rejected.
- Bound to floating is rejected.
- Floating to bound succeeds once.

**Expiry and tree time**
- A lapsed leaf does not block a Welcome join or an external join.
- Renewal after the old `exp` succeeds, and a renewal with a lower `iat` is rejected.
- Two receivers whose mocked clocks differ by days reach the same verdict on the same commits.
- A foreign controller's leaf with a future `iat` does not move H's tree time.
- A lapsed leaf's commit is rejected unless it renews, and its application message is dropped.
- Lapsed-leaf removal succeeds for a member bound to H and is refused for a member bound to another controller.

**Proven revoke**
- A member that is neither admin nor bound to H publishes a proof: the epoch rises by exactly one, D's leaf is gone, and `revocationOf` returns the log position.
- Two members publish at once: one commit, and `'already-revoked'` for the other.
- A proof with no `rev`, the wrong controller or a capability-authorised `rev` returns `'not-provable'` and is rejected on receive.
- Removes that differ from the derived set are rejected.
- A subject with no prior record gets a revoked record.
- kokuin un-revoking D later (`rot` with `d` omitting it) does not restore D.
- Removing a DID that holds `admin` succeeds when derived from a proof, and its role entries are dropped.

**Cascade and reset**
- Revoking T removes T and every leaf it issued, in one commit.
- A reset proof revokes every leaf of the earlier generation.

**Deny and `boundOnly`**
- A revoked DID cannot rejoin as a floating leaf, by Add or external join.
- A `boundOnly` group refuses a floating key package.

**Size**
- A realistic proof (icp, two rotations, rev) stays within a stated byte budget, for Ed25519.

**Conformance**
- Both conformance suites pass.

**kokuin**
- `createCapability` and `checkCapability` reject a child that outlives its parent.

## Docs

- `docs/reference/reserved-namespaces.md`: add `kumiai.device`, with its ops `register`, `add`, `revoke` (with and without proof), `reset`, `label` and `beacon`. The file is missing it today.
- A security section in the mls reference covers the accepted tradeoffs in the Goal section:
  - revocation is permanent while kokuin can un-revoke;
  - a stolen trusted agent can grant until revoked;
  - a revoked agent can still read until the first commit carrying the proof;
  - tree time lags real time by the newest grant's age.
