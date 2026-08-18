# did:kokuin device verification — Slice 3 design (observability + controller-log beacon)

Slice 3 of the did:kokuin device-verification adoption. It builds on Slices 1 (verify path) and 2
(write path — the device registry, `kumiai.device` register/add/revoke/label, capability-gated
authority, terminal revocation), both shipped on branch `did-kokuin-device-verify`.

Slice 3 is deliberately **small**. The design conversation established that the did:kokuin
*core* work in `@kumiai/mls` is essentially complete at Slice 2, and that most of what the original
decomposition assigned to Slice 3 either does not belong in kumiai at all or is not needed under a
terminal-revocation model. What remains is a thin, honest set of **public APIs** so consumers can
observe device revocations and controller-log freshness, plus one new low-stakes folded-state field.

## What changed relative to the original Slice 3 decomposition

The Slice 2 design closed with: "Slice 3 accordingly shrinks to: the `loadLog` port and its
conformance suite (kubun implements), reset / superseding-recovery propagation into groups, and the
cross-group duplicity floor." Every one of those items was reconsidered and **dropped from kumiai**,
for reasons that hold up under the current architecture:

- **Profile authority-key rotation is orthogonal to the deterministic MLS state.** The profile DID
  (`did:kokuin:`) is stable across rotation — that is the point of the method. `controllerOf` and
  `authority` read the folded registry and return that stable DID; they never resolve the profile's
  *keys*. So authority resolution is rotation-invariant and the group fold does not care. Keys matter
  in exactly one place — validating a bound leaf's capability signature — and that is pinned per-leaf
  by the authority-only prefix embedded at onboard time. A rotation therefore needs no rotation entry,
  no `didRegistryReducer`, no fold change. A device onboarded before a rotation keeps its valid pinned
  prefix; one onboarded after embeds the newer prefix. Any "I rotated, re-anchor me" flow is an
  enkaku/app protocol riding on kumiai, not a kumiai core mechanism.

- **Profile-key compromise recovery (the superseding-recovery lane) is out of scope.** Device
  compromise is not profile compromise: a device holds only a delegated capability plus its own MLS
  leaf key, never the profile's authority keys, so a lost/stolen device never forces a profile
  rotation or recovery. It is handled by terminal device revocation (Slice 2, already shipped) plus
  "re-add = mint a fresh device DID." The KERI superseding-recovery machinery
  (`@kokuin/controller`'s `resolveBranches`, reset handling, non-monotonic rewind) exists to *reverse*
  a divergence; terminal revocation never reverses, so none of it is needed. Recovering a stolen
  *profile authority-key set* (all n-of-n) remains a future concern in a later slice, with the named
  residual risk that until then it has no in-group remedy.

- **Cross-group revocation is explicit consumer orchestration, not implicit kumiai propagation.**
  kumiai orders per group only. A device revoked in one group must be revoked in the others by an
  explicit consumer/app call — kumiai emits the fact of a revocation and the consumer calls
  `revokeDevice` in each relevant group. Detection uses `@kokuin/controller` directly at the app
  layer if the app watches a controller log; enforcement reuses Slice 2's `revokeDevice`. kumiai adds
  no cross-group machinery.

- **The `loadLog` port + conformance suite belongs to the app/enkaku layer, not kumiai.** kumiai
  never calls `loadLog` on any deterministic path — commit validation stays synchronous, deterministic,
  and zero-I/O against the leaf-embedded prefix. `loadLog`'s only consumers (recovery, out-of-group
  resolution, log-watching) all live above kumiai. A port is a kumiai port only if kumiai consumes it;
  this one does not, so it is not defined here.

**Net:** no `loadLog` port, no conformance run, no rotation entry, no superseding-recovery fold, no
duplicity fork-resolver. This slice touches only observability APIs and one folded advisory field.

## Scope boundary

- **kumiai core (this slice):** typed public APIs to observe device revocations and controller-log
  freshness, delivered over a `@sozai/event` `EventEmitter`; a new low-stakes `beacon` device op with
  a folded per-controller projection; the read surfaces for both; a consumer-wiring example.
- **enkaku / app (not this slice):** cross-group revocation orchestration, controller-log rotation
  awareness, `loadLog` fetching, out-of-group DID resolution. These consume the kumiai APIs and
  `@kokuin/controller` directly.

## Deliverable 1 — revocation observability

A consumer needs two things kumiai already *has* the data for but does not expose ergonomically:
the current set of revoked devices, and a notification when a new revocation folds.

### `revokedDevices()`

```ts
// on GroupHandle
revokedDevices(): ReadonlyArray<{ device: string; controller: string; label?: string }>
```

Derived from the folded `#registry`: every `DeviceRecord` whose `status === 'revoked'`, projected to
`{ device: <normalized device DID>, controller, label? }`. This is an **enumerable notification/
tracking surface**, deliberately distinct from `currentDenySet()`. `currentDenySet()` is the opaque,
matched-never-enumerated validation deny set consumed by the auth service; `revokedDevices()` is
information for a consumer deciding where else to revoke. Sourcing it from the registry (a `Map` that
already carries `controller` and `label`) keeps the "the deny set is matched, never enumerated for a
decision" discipline intact — no code path iterates `currentDenySet()` for a decision.

### `deviceRevoked` event

Fired when a commit **or a heal** folds one or more `kumiai.device` `revoke` ops, and on the local
`revokeDevice` write path, carrying the newly-revoked bindings:

```ts
deviceRevoked: Array<{ device: string; controller: string }>
```

`device` is the entry `subject` (normalized); `controller` is `controllerOf(subject)` in the
post-fold registry. The event fires at the same fold-install point that drives the existing
`onLedgerEntries` sink — including the heal path (`group-handle.ts` surfaces heal-discovered entries
there too, so a peer that missed the revoke commit and heals later still gets the event exactly once).
It is a decoded, typed view over the entries `onLedgerEntries` already carries; the existing
`onLedgerEntries` callback is **kept unchanged** (it is load-bearing and tested; migrating it is out
of scope — "emitter rather than callbacks *as possible*").

## Deliverable 2 — controller-log beacon (folded state)

A peer holding a bound leaf embeds only the controller's **authority-only prefix** as of onboard time.
When the controller's log advances (notably an authority rotation), that embedded prefix is behind,
and a consumer may want to pull the fuller log (an app/enkaku action). The beacon is the deterministic,
cross-peer-consistent signal that the controller has advanced.

### Placement: folded registry state, not a per-member advisory view

An earlier decision (2026-08-18, memory `did-kokuin-sync-beacon-decision`) placed the beacon on the
*mutable derived* `GroupMember` view, having weighed only that against the *signed credential* (which
was rejected as immutable-per-leaf and therefore stale exactly when it matters). This slice supersedes
that decision with a **third option not previously considered: folded ledger state.** Folded state is
not the signed credential — it refreshes with each new entry, so it does not go stale on rotation — and
it is deterministic, so it is **consistent across peers** (the mutable per-member view could not
guarantee that). It also dissolves the transport question entirely: the beacon is carried by an
ordinary `kumiai.device` entry, authored like `label`.

### Granularity: per controller

`logLength`/`headDigest` describe the *controller's* log, shared by all of its devices; storing them
per-device would let two devices of one controller carry disagreeing values. So the registry gains a
second projection keyed by controller DID:

```ts
export type DeviceRegistry = {
  devices: ReadonlyMap<string, DeviceRecord>
  controllers: ReadonlyMap<string, ControllerBeacon>   // new
}

export type ControllerBeacon = { logLength: number; headDigest: string }
```

The per-device staleness a consumer actually wants — *is this device's embedded prefix behind?* — is a
derived comparison (that device's embedded-prefix head vs its controller's folded `headDigest`), not
stored state.

### The `beacon` op

`DeviceOp` gains `'beacon'`. Its entry uses `subject` = the **controller** DID (not a device DID — the
subject is the thing described, a device for device ops, the controller for its beacon) and
`value = { op: 'beacon', logLength, headDigest }` (no `controller` field, no `capability` field). The
value guard `isDeviceValue` accepts `op: 'beacon'` when `logLength` is a number and `headDigest` is a
string. `registryApply` folds it by last-write-wins into `controllers.set(subject, { logLength,
headDigest })`; it never touches the `devices` map and never affects the deny set. It is advisory: it
does **not** gate validation anywhere.

### Authority and proof — self-scoped, no management capability

The rule is "any device owned by the controller may edit it, like the label." Concretely: the entry is
authorized iff `authority(registry, issuer) === subject` — i.e. the issuer is a *bound device of the
controller* named as `subject`. Because it is self-scoped and low-stakes (an advisory pointer that
gates nothing), the acceptance-pipeline proof gate (`verifyDeviceEntry`) needs only to confirm the
issuer's bound leaf resolves (via its embedded prefix) to `subject`. It requires **no** management
capability — unlike `revoke`/`label`, which manage another device's binding. In the fold this rides
the existing device-entry exception to the admin-authorship invariant (`envelope-fold.ts` /
`foldControl`), and in the receiving policy it rides the existing `enactsOnlyDeviceEntries`
device-only carve-out (`defaultCommitPolicy`) unchanged.

### Write API and read surface

```ts
// group-device.ts, matching labelDevice's shape (mutex → signLedgerEntry → commitWithEntries
// requireAdmin:false → deriveGroup → applyLedgerEntries)
export async function announceControllerBeacon(
  group: GroupHandle,
  identity: SigningIdentity,
  params: { controller: string; logLength: number; headDigest: string },
): Promise<DeviceWriteResult>
```

Read surface: `GroupMember` gains an optional derived field surfaced from the folded projection —

```ts
export type GroupMember = {
  // ...existing: leafIndex, id, longForm, controller?
  controllerBeacon?: ControllerBeacon   // controllers.get(member.controller), when present
}
```

and a `controllerBeaconChanged` event fires when a `beacon` op folds:

```ts
controllerBeaconChanged: { controller: string; logLength: number; headDigest: string }
```

### The cost, named

Every beacon update is a permanent ledger entry — a signed token, replayed at every welcome, covered
by the running head, with **no compaction path** (a known ledger-wide limitation). This is acceptable
only because beacon updates are **rare** (published only when the controller log meaningfully advances,
i.e. on rotation) and **only-on-change** (a device publishes a `beacon` op only when the head actually
differs from the folded value). If beacon churn ever became a real cost, the remedy is the deferred
ledger checkpoint/compaction story, not a change here. The write API does not itself enforce rarity;
the consumer is responsible for publishing only-on-change, and the wiring example says so.

## The emitter surface

All three events live on one `@sozai/event` `EventEmitter`, matching kumiai's existing idiom
(`rpc/handlers.ts` constructs `new EventEmitter<BusEvents>()`):

```ts
export type GroupHandleEvents = {
  deviceRevoked: Array<{ device: string; controller: string }>
  controllerBeaconChanged: { controller: string; logLength: number; headDigest: string }
}

// on GroupHandle:
get events(): EventsSource<GroupHandleEvents>   // listen-only view; consumers subscribe, never emit
```

- The public accessor returns the **listen-only** `EventsSource` view (`on`/`once`/`readable`), so
  consumers cannot emit. The handle holds the full `EventEmitter` privately.
- The emitter instance is threaded through `GroupHandleParams` and **carried onto derived handles**
  (`deriveGroup`, `commitInvite`, `removeMember`), exactly as `onLedgerEntries` is — so a subscription
  taken once survives epoch changes and keeps delivering.
- Events are dispatched with **`fire`** (fire-and-forget, synchronous, listener failures swallowed and
  logged via the handle's logger), never `emit`. `emit` awaits listeners and rethrows their failures;
  on the fold/commit path a throwing consumer listener must never break the commit. The emitter is
  constructed with the handle's logger so `fire` reports listener failures.
- `@sozai/event` is added to `packages/mls/package.json` as `catalog:` (workspace catalog already
  pins `^0.1.3`). No new external dependency and no catalog change.

## Determinism

- `revokedDevices()` and the `controllers` projection are pure functions of the folded ledger — every
  peer computes identical values. The beacon is folded state, so all peers agree on it; it is never a
  validation input, so even a stale or absent beacon cannot cause validation divergence.
- Events are notifications derived from the same fold every peer runs; two peers that fold the same
  entries fire the same events (the heal path guarantees a peer that missed a commit still fires the
  event once when it heals). Listener execution order/timing is local and carries no protocol meaning.
- The `beacon` op adds a fold case that only ever writes the `controllers` map by last-write-wins;
  it cannot empty the admin set, cannot change any device's `status`, and cannot affect authority
  resolution. Determinism of the roster/registry fold is unchanged.

## Global constraints

- **`v: 1` is untouched.** No version field is added to `MLSCredentialIdentity` or any control
  envelope; no version gate anywhere. First-party consumers only (kubun and this monorepo), shipped
  together — the same coordinated-breaking-change stance as Slices 1 and 2.
- **No `loadLog` port and no conformance run.** No change to any `rpc`/`hub` port surface, so neither
  `rpc-conformance` nor `hub-conformance` is triggered. The diff must not touch `packages/rpc`,
  `packages/mls-rpc`, or `packages/hub-*`.
- **`@kumiai/mls` only.** No cross-repo dependency change beyond adding `@sozai/event: catalog:` to
  `packages/mls/package.json` (already in the workspace catalog). `@kokuin/*` catalog ranges unchanged.
- **Do not edit generated `lib/`.**

## Non-goals (explicitly deferred)

- The `loadLog(did) => Promise<Array<SignedEvent> | undefined>` port, its conformance suite, and a
  reference double — belong to the app/enkaku layer; not defined in kumiai.
- Controller authority-key rotation propagation into groups, a rotation entry type, and a
  `didRegistryReducer` folding rotate/reset chains.
- Superseding-recovery rewind into group state, reset handling, and profile-key compromise recovery.
- The cross-group duplicity floor / fork-resolver.
- Any automatic cross-group revocation propagation inside kumiai.

## Risks

- **Beacon staleness is inherent and accepted.** The folded beacon is only as fresh as the last
  published `beacon` op; a controller that rotated but published no beacon entry leaves a stale
  pointer. This is advisory by design — it can only cause a *missed* freshness hint, never a validation
  error — so best-effort freshness is the correct contract.
- **Ledger growth from beacon entries.** Bounded by the rare-rotation + only-on-change discipline; the
  structural remedy (compaction/checkpoint) is a deferred ledger-wide concern, not this slice.
- **No in-group remedy for profile-key compromise** until the deferred recovery slice. A stolen
  *device* is fully handled (terminal revocation + re-add as a fresh device DID); a stolen *profile
  authority-key set* is not. This is a named, accepted limitation of the current scope, not a defect.
