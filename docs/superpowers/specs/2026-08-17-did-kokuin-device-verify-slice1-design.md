# did:kokuin device verification — Slice 1 design

**Status:** design, awaiting review
**Date:** 2026-08-17
**Branch:** `did-kokuin-device-verify`
**Origin:** feasibility spike (2026-08-17) on adopting `@kokuin/controller` into kumiai's MLS
layer; see the memory note `did-kokuin-device-binding-spike` and the backlog item
`docs/agents/plans/backlog/2026-08-07-did-registry-ledger-entries.md`.

## Summary

Let a kumiai MLS leaf **opt in** to being a *device of a `did:kokuin:` controller (profile)*.
A leaf carries an optional `controller` binding — the profile DID plus a self-authenticating
proof — and `validateCredential` accepts it by verifying the proof **synchronously, with zero
sidecar I/O**. This is Slice 1 of a larger adoption: the read/verify substrate. It ships no
write path, no revocation, no device lifecycle, and no external ledger backend.

The controller pattern is strictly additive. Existing `did:key` / `did:peer:4` "floating"
device leaves are unchanged and remain first-class; nothing is forced onto controller DIDs.

## Motivation

The stack wants one stable identity per user profile whose device set changes over time, usable
across groups. `@kokuin/controller` provides that identity as a self-authenticating key-event log
(`did:kokuin:`). kumiai needs to *verify* such identities inside MLS groups without taking on the
storage/replication of their logs — that backend is a downstream concern (kubun), reached later
through an injected port, never a kumiai dependency (the dependency direction is kubun → kumiai, so
the reverse would cycle).

The spike established the key architectural move: the log prefix needed to verify a device binding
is **embedded in the MLS leaf** and folded synchronously, so validation is deterministic across all
group members and never depends on any member's external sync state. Revocation freshness rides a
separate, group-consistent path (Slice 2), not the async resolver.

## Decomposition

The full adoption is split into independently buildable slices, each with its own spec → plan →
implementation cycle:

- **Slice 1 (this doc) — Verify path.** `validateCredential` accepts a bound device leaf and
  surfaces an authenticated `(deviceDID, controllerDID)` pair. No writes, no flag day, no group
  coordination. Testable with crafted-leaf fixtures.
- **Slice 2 — Group revocation + self-authored relaxation (write path).** A device-management
  ledger entry type, the relaxed `foldEnvelope` authorship rule (self-scoped: subject == author),
  the version gate / policy floor, and the group-folded deny reducer that feeds Slice 1's deny seam.
  Delivers self-revocation without admin, and controller-level roster authority
  (`authority = controller ?? id`).
- **Slice 3 — Lifecycle + backend port.** Device add without admin, label/rename, the `loadLog`
  port and its conformance suite (kubun implements), reset / superseding-recovery propagation into
  groups, and the cross-group duplicity floor.

Slice 1 is foundational: it fixes the credential shape and the local-resolver adapter that every
later slice builds on, without incurring the flag day.

## Model

### Two device modes, opt-in

| Mode | leaf `id` | `controller` | Roster member is | Validated by |
| --- | --- | --- | --- | --- |
| **Floating** (today, unchanged) | `did:key` / `did:peer:4` | absent | the device itself | existing branches |
| **Bound** (opt-in) | `did:key` / `did:peer:4` | present | the **profile** (via `controller`) | new branch |

`id` **always names the device** — the addressable endpoint. enkaku is device-to-device, so RPC
routing and (Slice 2) the revocation deny-set target both key on `id`; it never switches meaning
between modes. `controller` is the optional authority pointer: for a bound leaf, authority (roster
role, admin) attaches to the profile, while the device remains the concrete leaf. A single group may
freely mix floating and bound leaves.

A consequence realised in Slice 2, noted here so Slice 1 stays forward-compatible: because `id` is
the device but authority is the controller, and the leaf's signing key (hence the token `iss` of any
ledger entry the device writes) is always the device's, the write path must resolve authority as
`controller ?? id`. Slice 1 only records `controller`; it does not yet judge roster authority.

### Credential shape

Wire shape, baked into the signed MLS leaf (`MLSCredentialIdentity` in `credential.ts`):

```
MLSCredentialIdentity = {
  v?,                       // 1 or absent = floating; 2 = bound
  id,                       // device DID — always
  longForm?,                // did:peer:4 device, as today
  controller?: {            // present ⟺ bound leaf
    id: string,             //   the did:kokuin profile DID
    prefix: SignedEvent[],  //   authority-only controller-log prefix (sync-foldable)
    capability: string,     //   delegation token binding this device under the profile
  },
}
```

`controller` merges the profile reference and its proof into one object, so "proof without a
controller" and "controller without a proof" are impossible by construction.

Derived local member state (never serialised), `GroupMember`:

```
GroupMember = { leafIndex, id /* device */, controller?: string /* profile DID */, longForm? }
```

Only the authenticated `controller.id` is retained; `prefix` and `capability` are verification
inputs, discarded after validation — exactly how `longForm` is a wire-only input today.

### Versioning — bound leaves are `v: 2`, fail-closed

`parseMLSCredentialIdentity` currently throws on `v !== 1`, and absent `v` reads as `1` permanently
(MLS leaves are signed and immutable). A bound leaf is therefore tagged `v: 2`, which every current
peer **rejects** — fail closed, rather than silently ignoring `controller` and accepting the device
key as a floating identity (which would drop the profile attribution and let mixed-version peers
disagree on membership identity). Bound leaves thus cannot appear until peers understand `v: 2`,
which is the Slice 2 version gate. Floating leaves stay `v: 1`/absent; nothing about them changes.

## Validation

`validateCredential(credential, signaturePublicKey)` — the ts-mls `AuthenticationService` signature —
does **not** receive a group ID. So a bound leaf's capability is a **profile-internal, group-
independent** fact ("profile P authorises device D for MLS use"), not a per-group grant. Which groups
P belongs to is the roster's concern (an admin invites P), handled in a later slice.

A new branch runs before the existing floating branches:

```
if (parsed.controller != null) return await validateBoundLeaf(parsed, signaturePublicKey)
```

`validateBoundLeaf` — explicit checks (deliberately not `checkCapability`, whose invocation
semantics assume a signed invocation token; here the MLS leaf key is the proof of possession):

1. **`v === 2`** and `controller.id` starts with `did:kokuin:` — else reject.
2. **The device self-authenticates against its own leaf key, exactly as a floating leaf would.**
   A bound leaf is a floating leaf *plus* a controller attribution, never a replacement:
   `did:key` → `id === did:key(signaturePublicKey)`; `did:peer:4` → `signaturePublicKey` is in the
   `longForm` authentication verification-method set. This stops a controller binding `aud = deviceX`
   onto a leaf actually keyed for `deviceY`.
3. Build the adapter:
   `resolver = createEmbeddedControllerResolver({ controllerID: controller.id, prefix: controller.prefix })`.
4. `verified = await verifyToken(controller.capability, { methods: [resolver], historic: true })`.
   Inside, `foldLog` requires the prefix's inception to hash to `controller.id` — the anchor that
   stops a leaf claiming an arbitrary profile — and validates the controller's signature over the
   capability. Any throw → reject.
5. `assertCapabilityToken(verified)` — shape.
6. `normalizeDID(verified.payload.aud) === normalizeDID(parsed.id)` — the capability's audience is
   *this* device.
7. `hasPermission({ act: MLS_LEAF_ACT, res: MLS_LEAF_RES }, verified.payload)` — grants device /
   mls-leaf use (group-independent).
8. `assertNonExpired` / `assertValidIssuedAt` on the capability payload — time claims.
9. `id ∉ denySet` — the deny seam (empty in Slice 1).
10. `cnf.kid` decodes to a key equal to `signaturePublicKey` — belt-and-suspenders proof of
    possession alongside step 2.

All pass → accept. A single fold (step 4); no delegation chain in Slice 1 (one hop, controller → device).

### The local-resolver adapter

New `packages/mls/src/embedded-resolver.ts`:

```
export function createEmbeddedControllerResolver(params: {
  controllerID: string
  prefix: SignedEvent[]
  denySet?: ReadonlySet<string>   // group-folded; empty in Slice 1
}): DIDMethodResolver
```

Wraps `createControllerResolver({ loadLog: async (did) => did === controllerID ? prefix : undefined })`,
then overrides `resolveDenySet` to return `params.denySet ?? new Set()`. A per-leaf instance
(the prefix is small; verification is one-shot; no `history` store). `loadLog` only ever returns the
embedded prefix and `undefined` for any other DID, so no code path can reach a sidecar. This is the
shape the spike verified to run with zero external I/O.

### The deny seam

`createDIDAuthenticationService` gains an optional dependency
`deviceDenySet?: () => ReadonlySet<string>`, defaulting to `() => new Set()`. The auth service is
constructed per group context (`group-context.ts`, currently arg-less), so each group closes over
its own deny provider. Slice 1 defaults it empty; Slice 2 wires the group-folded ledger deny into it.
Introducing the seam now (populated later) keeps the Slice 1/Slice 2 boundary a parameter change,
not a rewrite.

## APIs used

- `@kokuin/capability`: `assertCapabilityToken`, `hasPermission`, `assertNonExpired`,
  `assertValidIssuedAt`, `now`.
- `@kokuin/token`: `verifyToken`, `normalizeDID`, types `DIDMethodResolver`, `MethodRegistry`.
- `@kokuin/controller`: `createControllerResolver`, `tryDecodeKey`, type `SignedEvent`.
- Local: `constantTimeEqual` (already in `authentication.ts`).

## Files touched

- `packages/mls/src/credential.ts` — `MLSCredentialIdentity` and `GroupMember` fields;
  `parseMLSCredentialIdentity` structural rules for `controller` (reject a non-object `controller`,
  non-string `controller.id`/`capability`, non-array `prefix`). All crypto stays in
  `validateCredential`; parse remains pure/structural.
- `packages/mls/src/embedded-resolver.ts` — new adapter.
- `packages/mls/src/authentication.ts` — bound branch, `validateBoundLeaf`, the optional
  `deviceDenySet` dependency, and `MLS_LEAF_ACT` / `MLS_LEAF_RES` constants.
- `packages/mls/src/group-context.ts` — pass the (defaulted-empty) deny provider through.
- `packages/mls/src/index.ts` — export the adapter only if a consumer needs it (likely internal).
- `packages/mls/package.json` + `pnpm-workspace.yaml` catalog — add `@kokuin/capability` (published
  `^` range via the catalog, per repo convention).

## Testing

Unit level, directly on `validateCredential` — no group/MLS assembly needed. New
`packages/mls/test/authentication-bound.test.ts`; existing floating tests are the regression guard.

Fixture builders (`test/fixtures/`) craft bound leaves from primitives, since no minting API exists
yet (Slice 3): `buildBoundLeaf({ controllerSeed, profile, deviceKey, overrides })` assembling
`createInception` → `createControllerIdentity` → `createCapability` (pinning `deviceKey`) → the
`controller` object → `MLSCredentialIdentity` bytes. `overrides` corrupts exactly one field per
reject case.

Accept / reject matrix (each reject is a single-field mutation of a valid leaf):

| # | Case | Expect | Rule |
| --- | --- | --- | --- |
| A1 | valid bound leaf (did:key device) | accept | all |
| A2 | valid bound leaf (did:peer:4 device, longForm) | accept | + floating peer4 check |
| A3 | floating did:key / did:peer:4 (regression) | accept | unchanged branches |
| R1 | `controller.id` not `did:kokuin:` | reject | 1 |
| R2 | prefix inception hashes to a different profile | reject | 4 (arbitrary-profile) |
| R3 | capability signature tampered | reject | 4 |
| R4 | `capability.aud` ≠ leaf `id` | reject | 6 |
| R5 | permission lacks mls-leaf grant | reject | 7 |
| R6 | expired / future-`iat` capability | reject | 8 |
| R7 | `cnf.kid` ≠ leaf key / `cnf` absent | reject | 10 |
| R8 | leaf key ≠ `id`'s implied key (floating check fails) | reject | 2 |
| R9 | prefix contains a cap-authorised revoke (`foldLog` fails closed) | reject | 4 / authority-only |
| R10 | `controller` present but `v` ≠ 2 | reject | 1 |
| R11 | `v: 2` but `controller` absent | reject | versioning |
| R12 | deny provider contains the device `id` | reject | 9 (the seam) |

R12 injects a non-empty `deviceDenySet` provider to prove the seam works before Slice 2 exists.

Mutation discipline: every reject case is confirmed by removing the corresponding check and seeing
the test flip to accept — a reject test that passes against a no-op validator proves nothing. A
test-level assertion that the adapter's would-be "sidecar" callback is never invoked guards the
zero-I/O invariant.

Both contract-suite runs are not triggered by Slice 1 — no consumer port changes here (the `loadLog`
port lands in Slice 3). Standard `test:types` + `test:unit` for `@kumiai/mls`.

## Risks and sequencing

- **Mixed-version groups.** A group containing peers that predate `v: 2` cannot admit bound leaves —
  old peers reject them. This is intended (fail closed) and is exactly why bound leaves are gated
  behind Slice 2's version floor. Slice 1 defines the shape and the rejection; it does not yet
  advertise or negotiate support.
- **`MLS_LEAF_ACT` / `MLS_LEAF_RES` vocabulary.** The permission a device capability must carry is
  defined here and must match what Slice 3's minting side issues. Naming it in Slice 1 keeps fixtures
  and later minting in agreement; getting it wrong is a coordinated change, so it is called out
  explicitly rather than left implicit.
- **Authority-only prefix.** The embedded prefix must contain no capability-authorised revoke, or the
  sync `foldLog` fails closed and the leaf is rejected. This is a real constraint on what a minting
  side may embed (Slice 3), enforced here as reject case R9.
- **`@kokuin/capability` as a new dependency.** kumiai gains a second kokuin dependency beyond
  `@kokuin/token`. It rides the workspace catalog as a published `^` range.

## Non-goals (Slice 1)

- No capability minting API (fixtures craft capabilities directly).
- No device add, label, or revocation (Slice 2/3).
- No group-folded deny reducer — only the empty-by-default seam.
- No roster authority via `controller` — recorded, not judged.
- No `loadLog` port, no conformance suite, no kubun integration.
- No reset / superseding-recovery propagation, no cross-group duplicity floor.
```
