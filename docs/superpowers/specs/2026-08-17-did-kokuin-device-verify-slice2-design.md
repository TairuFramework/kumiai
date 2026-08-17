# did:kokuin device verification — Slice 2 design

**Status:** design, awaiting review
**Date:** 2026-08-17
**Branch:** `did-kokuin-device-verify` (stacked on Slice 1)
**Origin:** the Decomposition in the Slice 1 design
(`docs/superpowers/specs/2026-08-17-did-kokuin-device-verify-slice1-design.md`), refined against the
kokuin security model (`../kokuin/docs/reference/security.md`). See the memory note
`did-kokuin-device-binding-spike`.

## Summary

Slice 1 shipped the read/verify path: a bound MLS leaf carries a `controller` binding and
`validateCredential` accepts it synchronously, with an empty deny seam. Slice 2 builds the **write
path** — a group-folded **device registry** that records `device → controller` bindings, mutated by a
`kumiai.device` ledger-entry family, and the authority rules that let a profile manage its own device
set and act as a group admin. It delivers:

- **Self-service revocation without a group admin.** A device holding its profile's delegated
  *management capability* revokes a co-device (e.g. a lost one), producing a commit that both removes
  the target's MLS leaf and folds it into the group deny set that Slice 1's seam already consumes.
- **Admin-as-controller.** A group role (`admin`/`member`) may be held by a `did:kokuin:` **profile
  DID**; any device of that profile then acts with the role. The universal rule is
  `authority(issuer) = controllerOf(issuer) ?? issuer`, applied at every authority check.
- **The full device lifecycle** the registry needs: `register`, `add` (co-device, no admin), `revoke`,
  `label`.

Everything is verified deterministically from group state, with **zero external I/O on the fold** —
the same discipline as Slice 1. The external controller log is never a live consensus gate; a
profile's judgment enters the group only as a published, verified entry.

## Relation to the kokuin security model

Three facts from `../kokuin/docs/reference/security.md` shape this design and are load-bearing:

- **Device revocation is a management-tier operation** (the remedy ladder): "a device is lost or
  stolen → `rev` naming the device DID," authored by a management capability that is `cnf`-pinned and
  carries `exp`. Slice 2 reuses this capability class rather than inventing authority.
- **kumiai's revocation surface is named explicitly:** a device's authority under a profile is
  "MLS roster membership whose removal is an MLS Remove proposal," and the deny set reaches a device
  "only where that device's authority is mediated by the profile — a capability the profile issued
  (`aud` is the device), or a group roster." Slice 1's deny seam already governs exactly the
  *capability-mediated* (bound) leaf and never a bare (floating) leaf; Slice 2 keeps that invariant.
- **The stolen-manager window is a named, accepted limitation**, not a gap to close here: "revocation
  reaches it best-effort, expiry unconditionally," and "a thief's planted revocations survive the
  owner's remedy." Slice 2 inherits this contract; cross-group reset propagation is Slice 3.

## Decomposition status

This is Slice 2 of the adoption. Relative to the Slice 1 Decomposition, one item moved and one was
dropped:

- **Moved in from Slice 3:** the full device lifecycle (`add` without admin, `label`/rename). Building
  the registry once, whole, avoids a second pass over the fold and a second authority-model change.
- **Dropped:** the version gate / policy floor. The credential and control-envelope versions stay
  `v: 1`. The only consumers today are first-party (kubun and this monorepo), shipped together, so the
  breaking change is coordinated, not negotiated — the same decision Slice 1 made for the credential
  shape.

Slice 3 accordingly shrinks to: the `loadLog` port and its conformance suite (kubun implements),
reset / superseding-recovery propagation into groups, and the cross-group duplicity floor.

## Model

### The device registry

A new group-folded structure, folded beside `RosterState`, a pure function of the accepted
`kumiai.device` entries in the ledger:

```
DeviceRegistry = {
  devices: ReadonlyMap<string /* device DID */, {
    controller: string          // the did:kokuin profile this device belongs to
    status: 'active' | 'revoked'
    label?: string
  }>
}
```

Two views are derived from it, never stored separately:

- `controllerOf(deviceDID)` = `devices.get(deviceDID)?.controller` — the authority-resolution input.
- the **deny set** Slice 1 consumes = `{ d | devices.get(d).status === 'revoked' }` — answered for
  *now* (current folded state), and **matched, never enumerated** (per the kokuin deny-set rule; the
  set kumiai exposes holds device DIDs only).

### The `kumiai.device` entry family

One reserved control type — `kumiai.device` — recognized by a second `kumiai.*` branch in
`envelope-fold.ts` beside `kumiai.role` (`ROLE_ENTRY_TYPE`, `roster.ts:10`). The operation is carried
in `value` so there is one fold branch and one namespace reservation:

```
LedgerEntry = {
  type: 'kumiai.device',
  groupID,
  subject: <the device DID the op concerns>,
  ord?,
  value: {
    op: 'register' | 'add' | 'revoke' | 'label',
    controller?: string,   // register / add: the profile the device binds to
    label?: string,        // label
    capability?: string,   // manage ops: the embedded management capability the acceptance gate
                           //   verifies; the pure fold never reads it (recorded-once trust)
  },
}
issuer (from the signed token's `iss`) = <the signing device DID>
```

`kumiai.*` stays reserved and fail-closed: an unknown `kumiai.*` type is still rejected
(`envelope-fold.ts:81-84`). A pre-Slice-2 member therefore rejects any commit carrying a
`kumiai.device` entry — the coordinated breaking change described above.

### Authority resolution — `authority = controller ?? id`

One rule, applied everywhere authority is decided: `authority(issuer) = controllerOf(issuer) ?? issuer`,
where `controllerOf` reads the **folded registry**, never live MLS membership. Reading the registry
(part of the deterministic ledger) rather than the ratchet tree (epoch-dependent, and empty of a
departed author's leaf on a bootstrap re-fold) is what keeps the fold deterministic across all members
— the same property Slice 1 preserved by embedding the prefix in the leaf.

`RosterState` roles stay DID-keyed (`roster.ts:20`) and may now be keyed by a **controller DID**. The
admin check at `envelope-fold.ts:60-63` and the roster reducer at `roster.ts:48-49` change from
`roles.get(issuer) === 'admin'` to `roles.get(authority(issuer)) === 'admin'`. Granting admin to a
profile is a `kumiai.role` entry whose **subject is the controller DID**; the roster is already
DID-keyed and explicitly may "hold a role for a DID that has no MLS membership yet," so no new
structure is needed.

`didOfLeaf` / `buildCommitPolicyContext` (`group-handle.ts:1042-1043`, `policy.ts:62-71`), which today
resolve a leaf to its device DID before a roster lookup, resolve through `authority(...)` as well, so
an admin profile's device passes the commit policy.

### The universal admin invariant gains one typed exception

The invariant at `envelope-fold.ts:60-63` ("the issuer must be an admin in state-so-far") still runs
for every entry type **except** `kumiai.device`. For device ops, authorization is a proof checked in
the acceptance pipeline (below), not a roster role:

| op | Authorized when |
| --- | --- |
| `register` (self) | `subject === issuer` **and** the issuer's leaf binds to `value.controller` (leaf-attestation) — no role, no management capability |
| `register` (co-device), `add` | the issuer presents the profile's **management capability** (`kumiai/devices`), where the authorized profile `=== value.controller` — asserting a binding for a device not yet in the registry |
| `revoke`, `label` | the issuer presents the profile's **management capability**, where the authorized profile `=== controllerOf(subject)` — the registry already binds the subject |

**Layering removes any chicken-and-egg:** registry-mutating entries are authorized by *proofs*
(leaf-attestation, management capability), never by registry state; the registry then mediates every
*roster* authority decision. A `register` bootstraps a binding; later entries resolve authority
against the registry that binding is part of.

## Proof verification — the acceptance-gate / pure-fold split

This is the move that keeps the pure fold synchronous and deterministic. Verification of a device
entry's proof is an **acceptance-pipeline gate**, not part of the pure fold. Three layers:

1. **Acceptance pipeline** — where the ratchet tree is present and `validateCredential` already runs
   (`group-handle.ts` `#prepareCommitPipeline`, and the authoring side of `commitWithEntries`). For
   each `kumiai.device` entry in the commit, verify its proof and **reject the whole commit** on any
   failure:
   - *self-register* (`subject === issuer`): the issuer's leaf binds to `value.controller`, read off
     its Slice-1-validated `GroupMember.controller` (`credential.ts:47-65`). No new cryptography.
   - *manage ops* (co-device `register`, `add`, `revoke`, `label`): the issuer presents the profile's
     **management capability** — a `@kokuin/capability` grant with `act`/`res` covering `kumiai/devices`,
     `cnf`-pinned to the issuer's key and `exp`-bounded — verified exactly as Slice 1 verifies a bound
     leaf (`verifyToken` with `historic: true` through an embedded-prefix resolver, `assertCapabilityToken`,
     `assertDeviceCapabilityPolicy`). The authorized profile is `value.controller` for a
     register/add (the subject is not yet in the registry) and `controllerOf(subject)` for a
     revoke/label (the registry already binds it). The profile's log prefix used to verify the
     capability comes from the **issuer's own bound leaf** (the only in-group source of the profile's
     keys, embedded per Slice 1) — so a manage-op issuer must itself be a bound device of the
     authorized profile.
2. **`envelope-fold`** — stays pure and synchronous. It keeps the admin invariant for non-device
   entries, and for `kumiai.device` it applies the registry op and enforces the structural / `ord` /
   `groupID` rules (as it already does for role entries), but **delegates authorization to the
   pipeline gate**. That delegation is the "typed exception."
3. **Registry fold and bootstrap re-fold** — pure. `DeviceRegistry` is a pure function of *accepted*
   device entries. A bootstrapping member (`bootstrapLedger`, `group-handle.ts:452`) **trusts** the
   authenticated ledger and does not re-verify proofs, because a commit carrying an unvetted entry was
   rejected by honest members at its origin and never entered canonical history. This is the
   **recorded-once** contract: verified at acceptance, frozen under the head digest (`head.ts`),
   honoured on re-fold. An expired *authorizing* capability never un-revokes — honouring a revocation
   only ever subtracts authority.

## Revocation surfaces and deny-seam wiring

`revokeDevice(A)` authors **one commit with two effects**, matching the two surfaces the security doc
sanctions:

1. a `kumiai.device` `revoke` entry → folds `A` to `status: 'revoked'` → the derived deny set gains
   `A`;
2. if `A` currently holds a leaf, an **MLS Remove** of that leaf in the same commit. Removal alone is
   insufficient — Slice 1's `external-rejoin` path would let `A` rejoin on its still-valid bound-leaf
   capability; the deny set closes that. The deny set alone is insufficient for a floating device and
   leaves a stale leaf in the tree; the Remove closes that. Both are required.

**Seam wiring.** `group-context.ts:19` stops constructing the auth service arg-less. `resolveMlsContext`
gains access to the handle's folded registry and constructs
`createDIDAuthenticationService({ deviceDenySet: () => handle.currentDenySet() })` — a provider that
reads the *current* folded deny set (matching `resolveDenySet` = "now"). A revoke takes deny-effect
from the **next** epoch, so a commit never retroactively denies the leaves it is itself validating.
Floating leaves remain ungoverned by the deny set (the Slice 1 invariant, and the security doc's rule
that a bare token is never governed by a profile deny set).

## Breaking change — `v: 1`, no negotiation

Both `MLSCredentialIdentity` (Slice 1) and `ControlEnvelope` stay `v: 1`. There is no version gate and
no policy floor. A pre-Slice-2 member fails closed on the unknown `kumiai.device` type — an
uncoordinated old reader would desync — so the mitigation is coordination: all first-party consumers
(kubun, this monorepo) ship the new fold together. There is no in-band negotiation, exactly as Slice 1
decided for the credential shape. If a mixed-version deployment ever becomes real, a version gate is a
later, separable change.

## Write API and propagation

New `GroupHandle` methods, siblings of `commitLedgerEntries` (`group-commit.ts:291`), all routing
through the `commitWithEntries` choke point (`group-commit.ts:175`) and all returning the
`commitMessage` bytes the caller (kubun) broadcasts over its own delivery service — propagation
identical to role entries today (the entry id rides the commit's `authenticatedData` envelope; each
receiver resolves, verifies, and folds it in `processMessage`):

- `registerDevice({ device, controller })` — emit a `register` entry: self-attested (leaf) when
  `device` is the caller's own, or management-capability-authorized when recording a co-device already
  in the group.
- `addDevice(...)` — bring a co-device into the group without a group admin: an MLS `add` proposal for
  the new leaf plus an `add` entry, authorized by the management capability.
- `revokeDevice(device)` — the two-effect commit above.
- `labelDevice(device, label)` — a `label` entry.

Each signs its entry with `signLedgerEntry` (`ledger.ts:47-66`); manage-op entries carry the embedded
management capability the pipeline verifies. The **management capability is minted profile-side**
(kokuin / kubun), exactly as Slice 1's `authenticate` capability is — Slice 2 only *verifies* it; the
minting API is out of scope and fixtures craft it directly, the same boundary Slice 1 drew.

## APIs used

- `@kokuin/capability`: `assertCapabilityToken`, `hasPermission`, `assertDeviceCapabilityPolicy`,
  `assertValidIssuedAt`, `now` (as Slice 1), for the management-capability path.
- `@kokuin/token`: `verifyToken`, `normalizeDID`, types `DIDMethodResolver`.
- `@kokuin/controller`: `SignedEvent`, `createControllerResolver`, `tryDecodeKey` (as Slice 1), via the
  Slice 1 embedded resolver.
- Local (Slice 1): `createEmbeddedControllerResolver`, `validateBoundLeaf`'s verification building
  blocks (factored for reuse by the manage-op gate), `constantTimeEqual`.

The `@kokuin/capability` floor is `^0.3.0` (established in Slice 1; the `^0.1.0` premise had rotted).
No new external dependency.

## Files touched

- `packages/mls/src/registry.ts` — **new** — `DeviceRegistry`, its fold reducer, `controllerOf`, and
  the derived deny set. Mirrors `roster.ts`'s shape.
- `packages/mls/src/envelope-fold.ts` — the `kumiai.device` branch; `authority(issuer)` applied to the
  admin invariant (`:60-63`); the typed-exception delegation.
- `packages/mls/src/roster.ts` — `authority(...)` in `roleReducer.verifyAuthority` (`:48-49`); roles
  keyed by a resolved authority DID.
- `packages/mls/src/authentication.ts` — factor the manage-op verification out of `validateBoundLeaf`
  so the acceptance gate reuses it; add the `kumiai/devices` permission constants.
- `packages/mls/src/group-context.ts` — thread the folded deny set into
  `createDIDAuthenticationService` (`:19`).
- `packages/mls/src/group-handle.ts` — the acceptance-pipeline device-entry gate in
  `#prepareCommitPipeline`; `authority(...)` in `buildCommitPolicyContext` / `didOfLeaf`
  (`:1042-1043`); `currentDenySet()`; hold the folded `DeviceRegistry`.
- `packages/mls/src/group-commit.ts` / `group-membership.ts` — the write methods; the Remove-plus-entry
  coupling in `revokeDevice`.
- `packages/mls/src/policy.ts` — `authority(...)` in the admin resolution (`:62-71`).
- `packages/mls/src/index.ts` — export the registry types a consumer needs (member/registry views).

## Testing

Unit-level on the fold / registry / pipeline, with attacks **built, not imagined** — the kokuin
discipline (their security doc: every rule "exists because its absence was a defect somebody built and
demonstrated"). New `packages/mls/test/registry.test.ts`, `device-authority.test.ts`, and extensions
to the envelope-fold and group-handle suites. Fixtures extend Slice 1's `buildBoundLeaf` with a
`buildManagementCapability` (profile mints a `kumiai/devices` grant, `cnf`-pinned, `exp`-bounded) and
`kumiai.device` entry builders.

Required cases:

- **Determinism (the Approach-A gap this design closes):** fold a ledger incrementally versus
  bootstrap-re-fold → identical `DeviceRegistry`, deny set, and roster — *especially after the device
  that authored the entries has left the group*.
- **Attacks:**
  - thief-A holding only the `authenticate` capability tries `revoke(B)` → rejected (no management
    grant).
  - forged register: a member asserts `X → P` without self-leaf-attestation and without a management
    capability → the commit is rejected.
  - stolen *manager* within `exp` → accepted, asserted at the window boundary (the named, accepted
    limitation — the test pins the contract, it does not treat it as a bug).
  - admin-as-controller: any device of the admin profile authors an admin entry → accepted; a device
    of a non-admin profile → rejected.
  - a revoked device cannot re-authenticate on the bound path; a floating leaf with the same device
    DID is unaffected (deny governs only capability-mediated leaves).
- **Constraints carried from the kokuin consumer rules:** the resolver wrapper still forwards
  `resolveHistoric` **and** `resolveDenySet` (a Slice 1 regression guard); the deny set is matched, not
  enumerated; `isVerifiedToken` is checked after every `verifyToken`; audience enforcement stays the
  caller's.
- **Mutation discipline:** every reject case flips to accept when its specific check is removed, then
  is restored.

No consumer port changes here (the `loadLog` port is Slice 3), so neither contract suite is triggered;
standard `test:types` + unit for `@kumiai/mls`. Confirm this at plan time.

## Risks and named limitations

- **The stolen-manager window is real and accepted.** A stolen device holding a management capability
  can act until that capability's `exp` lapses or the profile's revocation of it is published into the
  group. This is the kokuin contract ("expiry unconditionally, revocation best-effort"), now scoped to
  *manager* devices rather than every device. Non-manager device theft grants no registry authority.
- **Planted revocations survive.** Per the security doc, a manager-tier holder's revocations keep
  biting after the holder is itself revoked; honouring a revocation only ever subtracts authority.
- **Per-group only.** A revocation folded into one group does not reach the profile's other groups in
  Slice 2. Cross-group propagation of a controller reset / superseding recovery is Slice 3.
- **Coordinated breaking change.** No version negotiation; a mixed-version group is unsupported until a
  gate is added (deferred).

## Non-goals (Slice 2)

- No `loadLog` port, no conformance suite, no controller-log *write* path (embedding a real controller
  `rev` event — approach "X" — is deferred; Slice 2 uses the kumiai-native, management-capability-
  authorized entry, approach "Y").
- No reset / superseding-recovery propagation into groups.
- No cross-group duplicity floor.
- No version gate / policy floor.
- No management-capability minting API (fixtures craft it).
