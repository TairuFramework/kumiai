# MLS last-resort key packages

**Date:** 2026-07-25
**Scope:** `@kumiai/mls`, `@kumiai/hub-protocol`, `@kumiai/hub-server`, `@kumiai/hub-conformance`,
`@kumiai/hub-client`
**Origin:** `docs/agents/plans/next/2026-07-25-hub-last-resort-keypackage.md` (deleted by this spec)

## Problem

A victim's key-package pool can still be emptied. The drain is rate-bounded as of 2026-07-25
(per-target consumption quota plus authorize dispatch, see
`docs/agents/plans/completed/2026-07-25-hub-keypackage-subscribe-caps.complete.md`), but an
authorized attacker staying within quota eventually exhausts the pool. Once it is empty the victim
cannot be added to any group until they re-upload.

MLS answers this with a *last-resort* key package: one that is reusable by design, so the hub may
serve it repeatedly without consuming it. The stack neither generates nor stores one today.

Two facts constrain the design:

- `ts-mls` 2.0.0-rc.13 has no last-resort support — no `lastResort` parameter, no `last_resort`
  extension. It must be added manually as a `CustomExtension`.
- The hub stores key packages as opaque `string` blobs. It cannot distinguish a last-resort package
  from an ordinary one without decoding MLS.

The extension comes from **draft-ietf-mls-extensions**, extension type `0x000A`, with zero-length
extension data. It is not in RFC 9420; the originating note said otherwise.

## Decisions

| Question | Decision |
|---|---|
| How the hub learns a package is last-resort | Client-supplied flag on upload. The hub stays MLS-agnostic. |
| Slot cardinality | One per DID, replaced on re-upload. |
| Fetch fill | Ordinary packages first (consumed), then the last-resort appended at most once. |
| Consumption quota | A quota refusal falls back to serving the last-resort alone; a non-consuming serve charges nothing. |
| Port shape | Two dedicated `HubStore` methods; `fetchKeyPackages` is unchanged and stays purely destructive. |
| `@kumiai/mls` API | A dedicated `createLastResortKeyPackageBundle`, not a flag on the existing function. |
| Branch boundary | Through `hub-client`. No automatic provisioning. |

### Why trusting the client flag is sound

Upload is authenticated: a client can only write to its own DID's slot. Mislabelling an ordinary
single-use package as last-resort causes init-key reuse for the uploader alone — self-harm, not a
cross-DID attack. Buying protection against it would mean giving `hub-server` a hard dependency on
`ts-mls` and breaking the opaque-blob layering the store is built on. Not worth it.

## Design

### 1. `@kumiai/mls` — generation

New exports from `packages/mls/src/group-credential.ts`:

```ts
export const LAST_RESORT_EXTENSION_TYPE = 0x000a

export async function createLastResortKeyPackageBundle(
  identity: OwnIdentity,
  options?: GroupOptions,
): Promise<KeyPackageBundle>
```

The body matches `createKeyPackageBundle` and adds an `extensions` argument:

```ts
extensions: [
  // Passing `extensions` at all suppresses ts-mls's own default of
  // `greaseExtensions(defaultGreaseConfig)` (keyPackage.js:60). `defaultGreaseConfig` is not
  // exported, so its 0.1 probability is restated here.
  ...greaseExtensions({ probabilityPerGreaseValue: 0.1 }),
  makeCustomExtension({
    extensionType: LAST_RESORT_EXTENSION_TYPE,
    extensionData: new Uint8Array(0),
  }),
]
```

`0x000A` is a **KeyPackage** extension, not a leaf-node one. Leaf capabilities are unaffected and
`controlCapabilities()` is unchanged.

Tests:

- The extension is present on the encoded package and decodes back to zero-length data.
- The `greaseExtensions` values survive alongside it — the call does not silently drop grease.
- A peer that knows nothing about `0x000A` still accepts the package into an anchored group. This
  is grease's own premise; it gets verified rather than assumed.

**Host obligation, documented on the new function.** `@kumiai/mls` never owns private packages —
`joinGroup` takes the bundle as a parameter (`packages/mls/src/group-welcome.ts:86`) — so the host
must retain the last-resort `privatePackage` after a Welcome rather than deleting it as it would an
ordinary one. Nothing in this stack enforces that; the doc comment is the whole mechanism.

### 2. `@kumiai/hub-protocol` — wire and port

`hub/v1/keypackage/upload` gains an optional param field:

```ts
lastResort: { type: 'boolean' }
```

When `lastResort` is true, `keyPackages` must contain exactly one entry. JSON Schema cannot express
that conditional cleanly, so the handler enforces it and rejects with the existing
`HUB_INVALID_PAYLOAD`. No new error code.

`HubStore` (`packages/hub-protocol/src/types.ts:222`) gains two methods. `fetchKeyPackages` keeps
its signature and stays purely destructive over the ordinary pool:

```ts
storeLastResortKeyPackage(ownerDID: string, keyPackage: string): Promise<void>
fetchLastResortKeyPackage(ownerDID: string): Promise<string | null>
```

Absence is `null`, never `undefined`.

The `AuthorizeHook` params for `action: 'keypackage/upload'` gain `lastResort?: boolean`, so a host
policy can refuse the slot specifically.

### 3. `@kumiai/hub-server` — store

`memoryStore.ts` adds `const lastResortKeyPackages = new Map<string, string>()`.

- `storeLastResortKeyPackage` is an unconditional `set`. Replace-on-upload; rotation is just
  re-upload.
- `fetchLastResortKeyPackage` is a plain `get`. No `splice`, ever.

The slot sits **outside** `maxKeyPackagesPerDID`. A one-entry-per-DID map cannot grow, so it needs
no quota of its own, and charging it against the ordinary cap would let a full pool block the floor.

### 4. `@kumiai/hub-server` — handler

**Upload** (`handlers.ts:559`). On `lastResort === true`: validate exactly-one, pass the flag to
`authorize`, charge `didLimiter` as today, then call `storeLastResortKeyPackage`. Returns
`{ stored: 1 }`.

**Fetch**, replacing `handlers.ts:608-615`:

1. `assertKeyPackageFetchAllowed(requesterDID)` — unchanged, and still first, so a throttled
   requester never charges the target.
2. `assertTargetConsumptionAllowed(targetDID, cappedCount)`. **If it throws, do not rethrow yet.**
   Call `fetchLastResortKeyPackage(targetDID)`; serve `[lastResort]` if one exists, otherwise
   rethrow the `KeyPackageFetchLimitError`. A non-consuming serve charges nothing.
3. Otherwise charge as today and call `fetchKeyPackages(targetDID, cappedCount)`. If the result is
   shorter than `cappedCount`, append the last-resort exactly once when one exists.

Every path returns at most one copy of the last-resort package. Two Adds sharing an init key in one
commit is exactly the reuse this feature exists to avoid.

Accepted consequence: a DID with a last-resort slot can be fetched from indefinitely once its
window is spent. That is the trade — the served package is reusable by design, so unbounded reads
of it leak nothing a single read does not.

### 5. `@kumiai/hub-conformance`

Added to the store suite (`packages/hub-conformance/src/index.ts:879+`):

- `fetchLastResortKeyPackage` returns the same string across repeated calls, including after the
  ordinary pool is emptied.
- A second `storeLastResortKeyPackage` replaces the first.
- With a last-resort slot present, ordinary packages are still never returned twice — the
  init-key-reuse guard.
- `fetchLastResortKeyPackage` on a DID with no slot returns `null`.
- Storing a last-resort package does not count toward `maxKeyPackagesPerDID`.

Handler-level tests in `packages/hub-server/test/handlers.test.ts` cover the quota-refusal fallback
and the exactly-one-copy fill.

`AGENTS.md` requires both contract suites against the real implementation and the doubles when a
port changes. `memoryStore` is the only `HubStore` implementation — there are no doubles — so the
doubles half is a no-op here. Stated rather than silently skipped.

### 6. `@kumiai/hub-client`

```ts
uploadLastResortKeyPackage(keyPackage: string): RequestCall<{ stored: number }>
```

A thin wrapper sending `{ keyPackages: [keyPackage], lastResort: true }`.

## Out of scope

- Automatic provisioning: generating and uploading a last-resort package during identity setup, and
  any rotation or lifetime policy. Deserves its own spec.
- Host-side private-package retention. Documented as an obligation; not enforced here.
- Any change to how ordinary key packages are generated, stored, or consumed.

## Success criteria

- A DID whose ordinary pool is empty can still be fetched a usable key package.
- A DID whose per-target consumption window is spent can still be fetched its last-resort package.
- No ordinary key package is ever returned by two fetches.
- No single fetch response contains two copies of the same key package.
- `hub-server` gains no dependency on `ts-mls` or `@kumiai/mls`.
