# did:kokuin device verification (Slices 1–3)

**Status:** complete
**Date:** 2026-08-18
**Branch:** `did-kokuin-device-verify` (41 commits off `main`)
**Package:** `@kumiai/mls` only

## What this was

Let a kumiai MLS leaf **opt in** to being a *device of a `did:kokuin:` controller (profile)*. One
stable profile identity per user whose device set changes over time and is usable across groups,
verified *inside* an MLS group **synchronously, with zero sidecar I/O** — kumiai never takes on the
storage or replication of a controller's key-event log (that backend is a downstream kubun concern,
and the dependency direction kubun → kumiai forbids the reverse).

The controller pattern is strictly additive: existing `did:key` / `did:peer:4` "floating" device
leaves are unchanged and remain first-class. A single group freely mixes floating and bound leaves.

Delivered in three slices, all shipped on this branch:

- **Slice 1 — verify path.** `validateCredential` accepts a bound leaf and surfaces an authenticated
  `(deviceDID, controllerDID)` pair.
- **Slice 2 — write path.** A group-folded device registry, the `kumiai.device` ledger-entry family,
  controller-level authority, and terminal revocation.
- **Slice 3 — observability + beacon.** Public event/accessor surfaces over a `@sozai/event`
  emitter, plus one advisory folded field.

## The load-bearing architectural move

The log prefix needed to verify a device binding is **embedded in the MLS leaf** and folded
synchronously. Validation is therefore deterministic across all group members and never depends on
any member's external sync state. Revocation freshness rides a separate, group-consistent path (the
folded deny set), never the async resolver. This one decision is what makes the whole feature
compatible with MLS's requirement that every member reach the same accept/reject verdict from the
same state.

## Key design decisions

**Credential shape — `controller` present ⟺ bound; `v` stays `1`.** `MLSCredentialIdentity` gains an
optional `controller = { id, prefix, capability }`: the profile DID, its authority-only controller-log
prefix (sync-foldable), and the delegation token binding this device under the profile. Merging
reference and proof into one object makes "proof without a controller" and "controller without a
proof" impossible by construction. Bound status is signalled by the field's *presence*, not by a
version bump — `id` **always** names the device (the addressable endpoint enkaku routes on and the
deny set targets), while `controller` is the optional authority pointer. Only the authenticated
`controller.id` is retained on `GroupMember`; `prefix`/`capability` are verification inputs discarded
after validation, exactly as `longForm` is today.

**Bound-leaf validation is floating-leaf validation *plus* a controller attribution.** A bound leaf
must self-authenticate against its own leaf key first (stopping a binding that claims `aud = deviceX`
onto a leaf keyed for `deviceY`), then verify the capability through a per-leaf embedded-prefix
resolver whose `loadLog` only ever returns the embedded prefix — no code path can reach a sidecar.
The capability's `aud` must equal this device, it must grant `MLS_LEAF_ACT='authenticate'` /
`MLS_LEAF_RES='kumiai/mls-leaf'` (fixed vocabulary, so mint and verify share one source), it must be
`exp`-bounded within policy, its `cnf.kid` must equal the leaf key, and the device must not be in the
deny set. `foldLog` requires the prefix's inception to hash to `controller.id` — the anchor that
stops a leaf claiming an arbitrary profile — and the embedded prefix must be authority-only (a
capability-authorised revoke inside it fails the sync fold closed).

**The device registry is group-folded state, a pure function of accepted `kumiai.device` entries.**
`DeviceRegistry.devices: device DID → { controller, status, label? }`, folded beside `RosterState`
from a single ordered pass (`foldControl`) so a role entry's authority resolves against the
registry-so-far, never a later binding. Two views derive and are never stored: `controllerOf` (the
authority input) and the deny set (`status === 'revoked'`, answered for *now*, **matched never
enumerated** per the kokuin deny-set rule).

**Authority is universal: `authority(issuer) = controllerOf(issuer) ?? issuer`.** A group role
(`admin`/`member`) may be held by a **profile DID**; any active device of that profile then acts with
the role. `controllerOf` reads the folded registry (deterministic), never live MLS membership
(epoch-dependent, empty of a departed author's leaf on re-fold). Granting admin to a profile is a
`kumiai.role` entry whose subject is the controller DID — the roster is already DID-keyed and may hold
a role for a DID with no MLS presence yet.

**Revocation is terminal.** Once a subject reaches `status: 'revoked'`, no later `register`/`add`
returns it to `active` — the fold only ever subtracts authority; re-authorizing a device mints a
fresh device DID. Applied identically by every member, so determinism holds. This terminal model is
what let Slice 3 drop the entire KERI superseding-recovery machinery: that exists to *reverse* a
divergence, and terminal revocation never reverses.

**The acceptance-gate / pure-fold split.** Proof verification of a device entry is an
acceptance-pipeline gate (where the ratchet tree and `validateCredential` already run), not part of
the pure fold. The fold keeps the admin invariant for non-device entries; for `kumiai.device` it
applies the op and enforces structural/`ord`/`groupID` rules but **delegates authorization to the
pipeline gate** (the "typed exception"). A bootstrapping/healing member trusts the authenticated
ledger and does not re-verify — the **recorded-once** contract: verified at acceptance, frozen under
the head digest, honoured on re-fold. Device-op authorization:

- *self-register* (`subject === issuer`): the issuer's Slice-1-validated leaf binds to
  `value.controller` — no role, no capability.
- *co-device register / add / revoke / label*: the issuer presents the profile's **management
  capability** (`kumiai/devices`, `cnf`-pinned, `exp`-bounded), authorized profile `=== value.controller`
  (register/add) or `=== controllerOf(subject)` (revoke/label). The profile's prefix comes from the
  issuer's own bound leaf, so a manage-op issuer must itself be a bound device of the profile.

**The receiving commit policy carries a symmetric device-only carve-out.** `defaultCommitPolicy` (the
roster-authority gate, which runs *after* and independently of the proof gate) would otherwise reject
every device-write commit — a self-register cannot bootstrap past an `isAdmin`-gated head-move, and a
device `add` mutates the registry, not the roster. So a commit that is *entirely* device-scoped
(every enacted entry is a `kumiai.device` entry, every add/remove corresponds to one) passes
structurally, deferring authorization to the proof gate that provably already ran. Any role entry or
unrelated proposal drops the whole commit back to the admin rules unchanged, keeping the new trust
surface minimal.

**`revokeDevice` = one commit, two effects.** A `revoke` entry (folds the device to `revoked`, deny
set gains it) **and** an MLS Remove of its leaf if present. Both are required: removal alone would let
the device rejoin on its still-valid bound-leaf capability (the external-rejoin path); the deny set
alone leaves a stale leaf in the tree and does not govern a floating device. The deny provider reads
the *current* folded set, so a revoke takes effect from the **next** epoch — a commit never denies the
leaves it is itself validating. Floating leaves stay ungoverned by the deny set (a bare token is never
governed by a profile deny set).

**Slice 3 stayed deliberately small — the did:kokuin core is essentially complete at Slice 2.** Every
item the Slice 2 design had assigned to Slice 3 was reconsidered and **dropped from kumiai** with
standing rationale: profile authority-key *rotation* is orthogonal to the deterministic fold (the
profile DID is stable across rotation; authority resolution never touches profile keys, which are
pinned per-leaf by the embedded prefix); profile-key *compromise recovery* is a distinct future
concern (a device holds only a delegated capability and its own leaf key, never profile authority
keys); cross-group revocation is **explicit consumer orchestration** (kumiai emits the fact, the
consumer calls `revokeDevice` per group), not implicit propagation; and the `loadLog` port belongs to
the app/enkaku layer because **kumiai never calls it on any deterministic path**. Net: no `loadLog`
port, no conformance run, no rotation entry, no `didRegistryReducer`, no fork-resolver.

**Slice 3 observability surfaces.** `revokedDevices()` is an *enumerable* tracking surface
(`{ device, controller, label? }`), deliberately distinct from the opaque matched-never-enumerated
`currentDenySet()` — so no code path iterates the deny set for a decision. Three events on one
`@sozai/event` emitter — `deviceRevoked`, `controllerBeaconChanged` — reached through a listen-only
`EventsSource` getter (consumers subscribe, never emit). The emitter is threaded onto every derived
handle (like `onLedgerEntries`), so a subscription taken once survives epoch changes. Events fire with
**`fire`** (fire-and-forget, listener throws swallowed and logged), never `emit` — a throwing consumer
listener must never break a commit or a fold. Events fire on the live commit path, on heal, and on the
local write APIs; the constructor and the silent welcome/bulk replay stay silent (a fresh fold of
prior history replays no events but the state is fully visible). The existing `onLedgerEntries`
callback is kept unchanged (load-bearing and tested).

**The controller-log beacon is folded state, not a per-member view or the signed credential.** A
`beacon` device op (`subject` = the *controller* DID, `value = { logLength, headDigest }`) folds
last-write-wins into a second registry projection `controllers: controller DID → ControllerBeacon`,
surfaced on `GroupMember.controllerBeacon`. Folded state refreshes on each entry (so it does not go
stale on rotation, unlike a signed-per-leaf credential) and is deterministic (so it is consistent
across peers, unlike a mutable per-member view), and it dissolves the transport question — an ordinary
ledger entry carries it. It is **advisory: it gates nothing, ever.** Authorization is self-scoped
(`authority(registry, issuer) === subject`, "any bound device of the controller edits it, like the
label"), needing no management capability, riding the existing device-entry fold exception and the
device-only policy carve-out unchanged. Per-controller granularity (not per-device) prevents two
devices of one controller carrying disagreeing values. Named cost: each update is a permanent ledger
entry with no compaction path — accepted because updates are rare (rotation only) and only-on-change,
the consumer's responsibility.

**Coordinated breaking change, no negotiation.** `MLSCredentialIdentity` and `ControlEnvelope` stay
`v: 1` throughout; there is no version gate and no in-band negotiation. A pre-work peer misreads a
bound leaf's `controller` as an unknown field (downgrade to floating) and fails closed on the unknown
`kumiai.device` type. All first-party consumers (kubun, this monorepo) ship the new fold together; a
version gate is a later, separable change if a mixed-version deployment ever becomes real.

## What was built

- `credential.ts` — `controller` binding on `MLSCredentialIdentity`; `controller`/`controllerBeacon`
  on `GroupMember`; pure/structural parse rules.
- `embedded-resolver.ts` (new) — the zero-I/O per-leaf controller resolver.
- `authentication.ts` — the bound-leaf branch, the reusable management-capability verifier
  (`verifyManagementCapability`), the `MLS_LEAF_*` / `MLS_DEVICES_*` constants, and the deny seam.
- `registry.ts` (new) — `DeviceRegistry` (both projections), `registryApply`, `controllerOf`,
  `authority`, `denySetOf`, `beaconOf`, and `foldControl` (the combined ordered roster+registry fold).
- `roster.ts` / `envelope-fold.ts` — authority resolved through `authority(...)`; the `kumiai.device`
  branch and its typed authorization exception.
- `group-handle.ts` — holds the folded registry; the acceptance-pipeline device-entry gate;
  `currentDenySet()` / `revokedDevices()` / `events`; the emitter threaded onto derived handles;
  status-aware authority in the commit-policy context.
- `group-device.ts` — `registerDevice`, `addDevice`, `revokeDevice`, `labelDevice`,
  `announceControllerBeacon`, all through the `commitWithEntries` choke point.
- `policy.ts` — the device-only commit carve-out; admin resolution through `authority(...)`.
- `@kokuin/capability` and `@sozai/event` added via the workspace catalog (published `^` ranges).

## Verification

512/512 `@kumiai/mls` tests green (real run), biome clean, `build:types` 12/12 across the workspace.
Attacks were **built, not imagined** (the kokuin discipline): thief holding only the `authenticate`
capability attempting `revoke` → rejected; forged register to a foreign controller → rejected on both
the author and receive sides; stolen *manager* within `exp` → accepted at the window boundary (the
contract pinned, not treated as a bug); a revoked device cannot re-authenticate on the bound path
while a same-DID floating leaf is unaffected; incremental fold vs bootstrap-re-fold → identical
registry, deny set, and roster *even after the authoring device has left the group*. Reject cases
carry mutation discipline (break the guard, see the test flip, restore).

A four-lens blind whole-branch review (security, state-machine, API, tests) ran after Slice 3. It
found — and fixes closed and independently re-verified — one Critical (a cross-profile device hijack:
a co-device register/add did not check the subject's existing binding, letting any managing member
claim and evict another profile's device) and four Important issues (revoked records still conferred
authority through `controllerOf`/`authority` and a fourth status-blind site in the commit policy;
missing receive-side rejection and next-epoch deny-timing tests; barrel-export omissions). A minor
follow-up pass closed the remaining test/export-hygiene nits.

## Residuals and named limitations

All inherited from the kokuin security contract and accepted, not defects:

- **The stolen-manager window is real.** A stolen device holding a management capability can act until
  that capability's `exp` lapses or its revocation is published into the group ("expiry
  unconditionally, revocation best-effort"), now scoped to *manager* devices — non-manager device
  theft grants no registry authority. A manager-tier holder's planted revocations keep biting after
  the holder is itself revoked (honouring a revocation only subtracts).
- **Beacon staleness is inherent** — advisory by design, so it can only cause a *missed* freshness
  hint, never a validation error.
- **No in-group remedy for profile authority-key compromise** until a future recovery slice. A stolen
  *device* is fully handled (terminal revocation + re-add as a fresh device DID); a stolen *profile
  key set* is not.
- **Orphaned admin presence.** `revokeDevice` can remove a profile's last device leaf while it retains
  its admin role in the roster — authority survives, in-group presence does not. A separate governance
  concern, not guarded here.
- **Ledger growth** from beacon (and all) entries — no compaction path; a deferred ledger-wide concern.

The design-acknowledged review Minors were left deliberately: the single shared deny-holder and the
management capability having no per-group binding are named contract properties; the commit-policy
context's small status-aware re-derivation of `authority()` is intentionally distinct (returns
`undefined` vs self, so `isAdmin`'s `?? id` fallback works) and commented; heal-vs-live event batching
and the generic-commit author-side no-emit are intended asymmetries (the typed write APIs add local
emission).

## Follow-on work

- `docs/agents/plans/backlog/2026-08-18-did-kokuin-deferred-hardening.md` — the future kumiai-side
  concerns named across the slices: profile authority-key compromise recovery, the orphaned-admin
  presence guard, and the mixed-version negotiation gate.

The pre-existing backlog item `docs/agents/plans/backlog/2026-08-07-did-registry-ledger-entries.md`
(the origin of this work) is now substantially **superseded** by this completed adoption; left in
place for the maintainer to retire.
