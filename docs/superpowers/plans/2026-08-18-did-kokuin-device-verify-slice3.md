# did:kokuin device verification — Slice 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give consumers typed public APIs to observe device revocations and controller-log freshness — a `revokedDevices()` accessor, a `deviceRevoked` event, and a folded, cross-peer-consistent controller-log beacon (`beacon` device op) — all delivered over a `@sozai/event` `EventEmitter`.

**Architecture:** Extend the Slice 2 device registry with a second per-controller projection (`controllers`) written by a new low-stakes `beacon` op that reuses the existing device-entry fold exception, policy carve-out, and proof-gate pattern (self-scoped, no management capability). Add one shared `EventEmitter<GroupHandleEvents>` to `GroupHandle`, carried onto derived handles like `onLedgerEntries`, firing `deviceRevoked`/`controllerBeaconChanged` at exactly the points device entries fold (the commit path, `bootstrapLedger`, and the local write path) via `fire` (never `emit`, so a throwing listener cannot break a fold).

**Tech Stack:** TypeScript, `@kumiai/mls`, `@sozai/event` (EventEmitter), `@kokuin/controller` (`SignedEvent`), `@kokuin/token` (`normalizeDID`), ts-mls, vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-did-kokuin-device-verify-slice3-design.md`

## Global Constraints

- **`v: 1` untouched** — no version field on `MLSCredentialIdentity` or any control envelope; no version gate anywhere in the diff.
- **No `loadLog` port, no conformance run** — do not touch `packages/rpc`, `packages/mls-rpc`, or `packages/hub-*`. Neither `rpc-conformance` nor `hub-conformance` is triggered.
- **`@kumiai/mls` only** — the sole dependency change is adding `@sozai/event: catalog:` to `packages/mls/package.json` (the workspace catalog already pins `^0.1.3`). `@kokuin/*` catalog ranges unchanged. No new external dependency.
- **Do not edit generated `lib/`.**
- **The beacon is advisory** — it must never be read as a validation input anywhere. It gates nothing.
- **Emitter uses `fire`, never `emit`, on any fold/commit path** — a listener failure must never break a commit.
- **Machine notes:** run biome as `./node_modules/.bin/biome check <files>` (an `rtk` shim fakes `pnpm exec biome`); repo lint is `rtk proxy pnpm -w run lint`. `pnpm exec vitest` / `pnpm exec tsc` are not faked. Test-suite `pnpm test` reports cached turbo results — force a real run and confirm `Cached: 0`.

---

## File Structure

- `packages/mls/package.json` — add `@sozai/event: catalog:` dependency (Task 1).
- `packages/mls/src/registry.ts` — `controllers` projection, `ControllerBeacon` type, `beacon` op, `beaconOf` accessor (Task 1).
- `packages/mls/src/envelope-fold.ts` — thread `controllers` through the working-registry copy (Task 2).
- `packages/mls/src/device-proof.ts` — the `beacon` self-scoped proof case (Task 3).
- `packages/mls/src/group-handle.ts` — the `EventEmitter` surface, `revokedDevices()`, `emitControlEvents`, `applyLedgerEntries` return change, firing on the commit + `bootstrapLedger` paths, `GroupMember.controllerBeacon` (Tasks 4, 5).
- `packages/mls/src/group-device.ts` — `announceControllerBeacon` write API + local firing on write APIs (Task 5).
- `packages/mls/src/credential.ts` — `GroupMember.controllerBeacon` field (Task 5).
- `packages/mls/src/index.ts`, `packages/mls/src/group.ts` — barrel exports (Task 5).
- Tests: `packages/mls/test/registry.test.ts`, `packages/mls/test/envelope-fold.test.ts` (or existing fold test), `packages/mls/test/device-proof.test.ts`, `packages/mls/test/device-events.test.ts` (new), `packages/mls/test/device-write.test.ts`, `packages/mls/test/device-attacks.test.ts`.

Existing test harness to reuse (built in Slice 2): `packages/mls/test/fixtures/device-harness.ts` exports `twoDeviceProfileGroup` (a group with a `did:kokuin:` profile and two bound devices) and `joinBoundDevice`. End-to-end receive-path tests drive a second member's `processMessage(commitMessage)`.

---

### Task 1: Registry `controllers` projection + `beacon` op + `@sozai/event` dep

**Files:**
- Modify: `packages/mls/package.json` (add dependency)
- Modify: `packages/mls/src/registry.ts`
- Test: `packages/mls/test/registry.test.ts`

**Interfaces:**
- Consumes: existing `registry.ts` exports (`DeviceRegistry`, `DeviceRecord`, `DeviceOp`, `DeviceValue`, `registrySeed`, `isDeviceValue`, `registryApply`, `controllerOf`, `denySetOf`, `authority`, `foldControl`), `normalizeDID` from `@kokuin/token`, `VerifiedLedgerEntry` from `./ledger.js`.
- Produces:
  - `type ControllerBeacon = { logLength: number; headDigest: string }`
  - `DeviceRegistry` gains `controllers: ReadonlyMap<string, ControllerBeacon>`
  - `DeviceOp` gains `'beacon'`
  - `DeviceValue` gains `logLength?: number; headDigest?: string`
  - `function beaconOf(registry: DeviceRegistry, controllerDID: string): ControllerBeacon | undefined`

- [ ] **Step 1: Add the dependency**

In `packages/mls/package.json`, add to `dependencies` (keep alphabetical among `@sozai/*`):
```json
    "@sozai/event": "catalog:",
```
Then run `pnpm install` from the repo root so the workspace link resolves.

- [ ] **Step 2: Write the failing tests**

Append to `packages/mls/test/registry.test.ts` (inside the existing `describe('registryApply', ...)` and a new `describe('beacon', ...)`). These reuse the file's existing `GROUP`, `PROFILE`, `DEV_A` constants and its `deviceInput` helper. Note `deviceInput`'s `value` is typed `DeviceValue`, so the new fields must exist on `DeviceValue` for these to compile.

```typescript
import { beaconOf, type ControllerBeacon } from '../src/registry.js'

describe('beacon', () => {
  test('a beacon op records the controller log head in the controllers projection', () => {
    const r = registryApply(
      {
        issuer: normalizeDID(DEV_A),
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: PROFILE, // subject is the CONTROLLER, not a device
          value: { op: 'beacon', logLength: 7, headDigest: 'zHead1' },
        },
      },
      registrySeed(),
    )
    expect(beaconOf(r, PROFILE)).toEqual({ logLength: 7, headDigest: 'zHead1' })
    // A beacon touches only the controllers projection, never devices or the deny set.
    expect(r.devices.size).toBe(0)
    expect(denySetOf(r).size).toBe(0)
  })

  test('a later beacon overwrites the earlier one (last-write-wins)', () => {
    let r = registryApply(
      {
        issuer: normalizeDID(DEV_A),
        entry: { type: DEVICE_ENTRY_TYPE, groupID: GROUP, subject: PROFILE, value: { op: 'beacon', logLength: 3, headDigest: 'zOld' } },
      },
      registrySeed(),
    )
    r = registryApply(
      {
        issuer: normalizeDID(DEV_A),
        entry: { type: DEVICE_ENTRY_TYPE, groupID: GROUP, subject: PROFILE, value: { op: 'beacon', logLength: 9, headDigest: 'zNew' } },
      },
      r,
    )
    expect(beaconOf(r, PROFILE)).toEqual({ logLength: 9, headDigest: 'zNew' })
  })

  test('a device register/revoke leaves the controllers projection untouched', () => {
    let r = registryApply(
      { issuer: normalizeDID(DEV_A), entry: { type: DEVICE_ENTRY_TYPE, groupID: GROUP, subject: DEV_A, value: { op: 'register', controller: PROFILE } } },
      registrySeed(),
    )
    r = registryApply(
      { issuer: normalizeDID(DEV_A), entry: { type: DEVICE_ENTRY_TYPE, groupID: GROUP, subject: PROFILE, value: { op: 'beacon', logLength: 2, headDigest: 'zH' } } },
      r,
    )
    r = registryApply(
      { issuer: normalizeDID(PROFILE), entry: { type: DEVICE_ENTRY_TYPE, groupID: GROUP, subject: DEV_A, value: { op: 'revoke' } } },
      r,
    )
    // The revoke changed device status but not the controller beacon.
    expect(beaconOf(r, PROFILE)).toEqual({ logLength: 2, headDigest: 'zH' })
    expect(r.devices.get(normalizeDID(DEV_A))?.status).toBe('revoked')
  })

  test('isDeviceValue accepts a well-formed beacon and rejects a malformed one', () => {
    expect(isDeviceValue({ op: 'beacon', logLength: 1, headDigest: 'z' })).toBe(true)
    expect(isDeviceValue({ op: 'beacon', logLength: 1 })).toBe(false) // missing headDigest
    expect(isDeviceValue({ op: 'beacon', headDigest: 'z' })).toBe(false) // missing logLength
    expect(isDeviceValue({ op: 'beacon', logLength: '1', headDigest: 'z' })).toBe(false) // wrong type
  })
})
```
Add `isDeviceValue` to the file's import from `../src/registry.js` if not already imported.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/mls && pnpm exec vitest run test/registry.test.ts`
Expected: FAIL — `beaconOf` / `ControllerBeacon` not exported, `DeviceValue` has no `logLength`/`headDigest`, `op: 'beacon'` not assignable.

- [ ] **Step 4: Implement the projection and the `beacon` op**

In `packages/mls/src/registry.ts`:

Extend the op union and value:
```typescript
/** The device lifecycle operations plus the advisory controller-log beacon. */
export type DeviceOp = 'register' | 'add' | 'revoke' | 'label' | 'beacon'
```
```typescript
export type DeviceValue = {
  op: DeviceOp
  controller?: string
  label?: string
  capability?: string
  /** Beacon only: the length of the controller's FULL log at announcement time. */
  logLength?: number
  /** Beacon only: the head digest of the controller's FULL log at announcement time. */
  headDigest?: string
}
```
Add the beacon record type and extend the registry:
```typescript
/** An advisory pointer to a controller's FULL log head. Never a validation input. */
export type ControllerBeacon = { logLength: number; headDigest: string }
```
```typescript
export type DeviceRegistry = {
  devices: ReadonlyMap<string, DeviceRecord>
  controllers: ReadonlyMap<string, ControllerBeacon>
}
```
Update the seed:
```typescript
export function registrySeed(): DeviceRegistry {
  return { devices: new Map(), controllers: new Map() }
}
```
Extend `isDeviceValue` — after the existing `op` check, before the string-field checks, add the beacon shape rule, and keep the register/add controller rule:
```typescript
export function isDeviceValue(value: unknown): value is DeviceValue {
  if (value == null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.op !== 'register' && v.op !== 'add' && v.op !== 'revoke' && v.op !== 'label' && v.op !== 'beacon') {
    return false
  }
  if ((v.op === 'register' || v.op === 'add') && typeof v.controller !== 'string') return false
  if (v.op === 'beacon' && (typeof v.logLength !== 'number' || typeof v.headDigest !== 'string')) {
    return false
  }
  if (v.label !== undefined && typeof v.label !== 'string') return false
  if (v.controller !== undefined && typeof v.controller !== 'string') return false
  if (v.capability !== undefined && typeof v.capability !== 'string') return false
  if (v.logLength !== undefined && typeof v.logLength !== 'number') return false
  if (v.headDigest !== undefined && typeof v.headDigest !== 'string') return false
  return true
}
```
Thread `controllers` through `registryApply` — copy BOTH maps up front and return BOTH from every branch, and add the `beacon` case:
```typescript
export function registryApply(
  verified: VerifiedLedgerEntry<DeviceValue>,
  state: DeviceRegistry,
): DeviceRegistry {
  const subject = normalizeDID(verified.entry.subject)
  const value = verified.entry.value
  const devices = new Map(state.devices)
  const controllers = new Map(state.controllers)
  const existing = devices.get(subject)
  switch (value.op) {
    case 'register':
    case 'add': {
      // Terminal revocation: once a subject is revoked, no later register/add re-activates it. The
      // fold only ever subtracts authority — to re-authorize a device, a fresh device DID is minted.
      if (existing?.status === 'revoked') {
        return { devices, controllers }
      }
      const controller = normalizeDID(value.controller as string)
      devices.set(subject, {
        controller,
        status: 'active',
        ...(value.label !== undefined
          ? { label: value.label }
          : existing?.label !== undefined
            ? { label: existing.label }
            : {}),
      })
      return { devices, controllers }
    }
    case 'revoke': {
      if (existing == null) return { devices, controllers }
      devices.set(subject, { ...existing, status: 'revoked' })
      return { devices, controllers }
    }
    case 'label': {
      if (existing == null) return { devices, controllers }
      devices.set(subject, {
        ...existing,
        ...(value.label !== undefined ? { label: value.label } : {}),
      })
      return { devices, controllers }
    }
    case 'beacon': {
      // Advisory, self-scoped: `subject` is the CONTROLLER DID. Last-write-wins; never touches
      // `devices` or the deny set, never gates validation. Guarded present by isDeviceValue.
      controllers.set(subject, {
        logLength: value.logLength as number,
        headDigest: value.headDigest as string,
      })
      return { devices, controllers }
    }
  }
}
```
Add the accessor beside `controllerOf`:
```typescript
/** The advisory beacon a controller last announced, or undefined. Never a validation input. */
export function beaconOf(
  registry: DeviceRegistry,
  controllerDID: string,
): ControllerBeacon | undefined {
  return registry.controllers.get(normalizeDID(controllerDID))
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/mls && pnpm exec vitest run test/registry.test.ts`
Expected: PASS (all beacon tests plus the pre-existing registry tests, including "revocation is terminal").

- [ ] **Step 6: Typecheck**

Run: `cd packages/mls && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: PASS. (This confirms `foldControl`/`foldEnvelope`/`group-handle.ts`, which construct `DeviceRegistry` values, still typecheck — `foldControl` seeds via `registrySeed()` so it gets `controllers` for free; `foldEnvelope`'s hand-written copy is fixed in Task 2 and MAY error here — if so, that error is expected and closed by Task 2, so note it and proceed.)

- [ ] **Step 7: Commit**

```bash
git add packages/mls/package.json packages/mls/src/registry.ts packages/mls/test/registry.test.ts pnpm-lock.yaml
git commit -m "feat(mls): device registry controllers projection + beacon op + @sozai/event dep"
```

---

### Task 2: Thread `controllers` through `foldEnvelope`

**Files:**
- Modify: `packages/mls/src/envelope-fold.ts:64-65`
- Test: `packages/mls/test/envelope-fold.test.ts` (create if absent; otherwise the existing fold test)

**Interfaces:**
- Consumes: `foldEnvelope(baseRoster, baseRegistry, entries, groupID)`, `foldControl` (Task 1's registry), `registrySeed`, `beaconOf`, `DEVICE_ENTRY_TYPE`.
- Produces: no signature change — `foldEnvelope` now carries the `controllers` projection forward, so a `beacon` entry folded on the commit path and on the bootstrap path both land in the registry.

- [ ] **Step 1: Write the failing test**

`foldControl` already folds beacon entries (it seeds via `registrySeed()` and applies via `registryApply`, both fixed in Task 1). The gap is `foldEnvelope`, whose working registry is a hand-written copy that only clones `devices`. Add a test proving a beacon folds through `foldEnvelope` and that the base's controllers survive. Create `packages/mls/test/envelope-fold.test.ts` (or add to the existing fold test file if one covers `foldEnvelope`):

```typescript
import { normalizeDID } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import type { FoldInput } from '../src/fold.js'
import { foldEnvelope } from '../src/envelope-fold.js'
import {
  beaconOf,
  DEVICE_ENTRY_TYPE,
  type DeviceValue,
  registrySeed,
  roleReducer_seedUnused, // placeholder — see note
} from '../src/registry.js'
import { roleReducer } from '../src/roster.js'

const GROUP = 'group-1'
const CREATOR = 'did:key:zCreator'
const PROFILE = 'did:kokuin:profileP'
const DEV_A = 'did:key:zDeviceA'

function deviceInput(issuer: string, subject: string, value: DeviceValue, entryID: string): FoldInput<DeviceValue> {
  return {
    verified: { issuer: normalizeDID(issuer), entry: { type: DEVICE_ENTRY_TYPE, groupID: GROUP, subject, value } },
    entryID,
  }
}

describe('foldEnvelope beacon', () => {
  const baseRoster = roleReducer.seed({ creatorDID: CREATOR, version: 1 })

  test('a beacon entry folds into the candidate registry controllers projection', () => {
    const result = foldEnvelope(
      baseRoster,
      registrySeed(),
      [deviceInput(DEV_A, PROFILE, { op: 'beacon', logLength: 5, headDigest: 'zH' }, 'e1')],
      GROUP,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(beaconOf(result.registry, PROFILE)).toEqual({ logLength: 5, headDigest: 'zH' })
  })

  test('a base registry beacon survives folding an unrelated device entry', () => {
    const base = registrySeed()
    const seeded = foldEnvelope(baseRoster, base, [deviceInput(DEV_A, PROFILE, { op: 'beacon', logLength: 2, headDigest: 'zOld' }, 'b0')], GROUP)
    expect(seeded.ok).toBe(true)
    if (!seeded.ok) return
    const next = foldEnvelope(baseRoster, seeded.registry, [deviceInput(DEV_A, DEV_A, { op: 'register', controller: PROFILE }, 'r1')], GROUP)
    expect(next.ok).toBe(true)
    if (next.ok) expect(beaconOf(next.registry, PROFILE)).toEqual({ logLength: 2, headDigest: 'zOld' })
  })
})
```
> NOTE: delete the bogus `roleReducer_seedUnused` import line above — it is a deliberate marker that the implementer must import `roleReducer` from `../src/roster.js` (as the last import shows) and remove any invalid import. Use the real `roleReducer.seed(anchor)` to build `baseRoster`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mls && pnpm exec vitest run test/envelope-fold.test.ts`
Expected: FAIL — the second test's `beaconOf(next.registry, PROFILE)` is `undefined` because `foldEnvelope`'s working copy dropped `controllers`. (The typecheck from Task 1 Step 6 may also have flagged the copy.)

- [ ] **Step 3: Fix the working-registry copy**

In `packages/mls/src/envelope-fold.ts`, change the working-registry initialization (line ~65) to clone BOTH maps:
```typescript
  let workingRegistry: DeviceRegistry = {
    devices: new Map(baseRegistry.devices),
    controllers: new Map(baseRegistry.controllers),
  }
```
No other change — the existing `DEVICE_ENTRY_TYPE` branch already calls `registryApply`, which now handles `beacon` and threads `controllers`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mls && pnpm exec vitest run test/envelope-fold.test.ts test/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd packages/mls && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: PASS (the Task 1 Step 6 copy error, if any, is now closed).

- [ ] **Step 6: Commit**

```bash
git add packages/mls/src/envelope-fold.ts packages/mls/test/envelope-fold.test.ts
git commit -m "feat(mls): thread the controllers projection through foldEnvelope"
```

---

### Task 3: The `beacon` proof-gate case (self-scoped, no capability)

**Files:**
- Modify: `packages/mls/src/device-proof.ts:40-49` (add a branch)
- Test: `packages/mls/test/device-proof.test.ts`

**Interfaces:**
- Consumes: `verifyDeviceEntry(verified, ctx)`, `DeviceProofContext` (`bindingOfDID`, `controllerOf`), `LeafBinding`, `normalizeDID`.
- Produces: `verifyDeviceEntry` returns `true` for a `beacon` entry iff the issuer's bound leaf's `controller` equals the entry `subject` (the controller DID); no management capability is read.

- [ ] **Step 1: Write the failing tests**

Add to `packages/mls/test/device-proof.test.ts` (reuse the file's existing context-builder pattern; the sketch below shows the shape — bind names to the file's actual helpers):

```typescript
describe('verifyDeviceEntry — beacon', () => {
  const PROFILE = normalizeDID('did:kokuin:profileP')
  const DEV_A = normalizeDID('did:key:zDeviceA')
  const OTHER = normalizeDID('did:kokuin:profileOther')

  // A ctx where DEV_A's leaf is bound to PROFILE.
  const ctx = {
    bindingOfDID: (did: string) =>
      did === DEV_A ? { controller: PROFILE, prefix: [], leafKey: new Uint8Array([1]) } : undefined,
    controllerOf: (_d: string) => undefined,
  }

  test('accepts a beacon authored by a bound device of the subject controller — no capability', async () => {
    const ok = await verifyDeviceEntry(
      { issuer: DEV_A, entry: { type: DEVICE_ENTRY_TYPE, groupID: 'g', subject: PROFILE, value: { op: 'beacon', logLength: 4, headDigest: 'zH' } } },
      ctx,
    )
    expect(ok).toBe(true)
  })

  test('rejects a beacon whose issuer is bound to a DIFFERENT controller', async () => {
    const ok = await verifyDeviceEntry(
      { issuer: DEV_A, entry: { type: DEVICE_ENTRY_TYPE, groupID: 'g', subject: OTHER, value: { op: 'beacon', logLength: 4, headDigest: 'zH' } } },
      ctx,
    )
    expect(ok).toBe(false)
  })

  test('rejects a beacon whose issuer holds no bound leaf', async () => {
    const ok = await verifyDeviceEntry(
      { issuer: normalizeDID('did:key:zFloating'), entry: { type: DEVICE_ENTRY_TYPE, groupID: 'g', subject: PROFILE, value: { op: 'beacon', logLength: 4, headDigest: 'zH' } } },
      ctx,
    )
    expect(ok).toBe(false)
  })
})
```
Ensure `DEVICE_ENTRY_TYPE`, `verifyDeviceEntry`, `normalizeDID` are imported in the test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/mls && pnpm exec vitest run test/device-proof.test.ts`
Expected: FAIL — with no beacon branch, a `beacon` entry falls into the manage-op path, reads `value.capability` (undefined), and behaves unpredictably; the "accepts" case fails.

- [ ] **Step 3: Add the beacon branch**

In `packages/mls/src/device-proof.ts`, immediately after the `issuer`/`subject`/`value` locals and BEFORE the self-register branch, add:
```typescript
  if (value.op === 'beacon') {
    // Self-scoped, low-stakes: the issuer must be a bound device of the controller named as
    // `subject`. Advisory state that gates nothing, so NO management capability is required —
    // unlike revoke/label, which manage another device's binding.
    const binding = ctx.bindingOfDID(issuer)
    if (binding?.controller == null) return false
    return normalizeDID(binding.controller) === subject
  }
```
(`subject` is already `normalizeDID(verified.entry.subject)`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/mls && pnpm exec vitest run test/device-proof.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mls/src/device-proof.ts packages/mls/test/device-proof.test.ts
git commit -m "feat(mls): beacon device-entry proof case — self-scoped, no capability"
```

---

### Task 4: The `EventEmitter` surface + `revokedDevices()` + `deviceRevoked` on the receive path

**Files:**
- Modify: `packages/mls/src/group-handle.ts` (params, emitter WeakMap, `get events()`, `GroupHandleEvents`, `revokedDevices()`, `emitControlEvents`, `applyLedgerEntries` return, firing on the commit path and `bootstrapLedger`, `deriveGroup` threading)
- Test: `packages/mls/test/device-events.test.ts` (new)

**Interfaces:**
- Consumes: `EventEmitter`, `EventsSource` from `@sozai/event`; `controllerOf`, `isDeviceValue`, `DEVICE_ENTRY_TYPE`, `DeviceValue` from `./registry.js`; `VerifiedLedgerEntry` from `./ledger.js`; the Slice 2 device-write path and `test/fixtures/device-harness.ts` (`twoDeviceProfileGroup`).
- Produces:
  - `type GroupHandleEvents = { deviceRevoked: Array<{ device: string; controller: string }>; controllerBeaconChanged: { controller: string; logLength: number; headDigest: string } }`
  - `GroupHandleParams` gains `events?: EventEmitter<GroupHandleEvents>`
  - `GroupHandle.get events(): EventsSource<GroupHandleEvents>`
  - `GroupHandle.revokedDevices(): ReadonlyArray<{ device: string; controller: string; label?: string }>`
  - `GroupHandle.emitControlEvents(enacted: ReadonlyArray<VerifiedLedgerEntry>): void` (package-internal; used by Task 5's write APIs)
  - `GroupHandle.applyLedgerEntries(tokens): Promise<Array<VerifiedLedgerEntry>>` (was `Promise<void>`)
  - `emitterOf(group: GroupHandle): EventEmitter<GroupHandleEvents>` (module-internal, exported for `deriveGroup`)

- [ ] **Step 1: Write the failing tests**

Create `packages/mls/test/device-events.test.ts`. Use the Slice 2 harness. The load-bearing assertions: a subscriber on the ORIGINAL handle receives `deviceRevoked` when a SECOND member processes a revoke commit, and `revokedDevices()` lists the revoked binding.

```typescript
import { describe, expect, test } from 'vitest'
import { normalizeDID } from '@kokuin/token'

import { revokeDevice } from '../src/group-device.js'
import { twoDeviceProfileGroup } from './fixtures/device-harness.js'

describe('device events', () => {
  test('revokedDevices() lists a revoked binding with its controller', async () => {
    const g = await twoDeviceProfileGroup() // { creatorGroup, memberGroup, profile, deviceA, deviceB, identityA, ... }
    const res = await revokeDevice(g.creatorGroup, g.identityA, { device: g.deviceB, capability: g.manageCapability })
    const revoked = res.newGroup.revokedDevices()
    expect(revoked.map((r) => r.device)).toContain(normalizeDID(g.deviceB))
    expect(revoked.find((r) => r.device === normalizeDID(g.deviceB))?.controller).toBe(normalizeDID(g.profile))
  })

  test('a receiver fires deviceRevoked once when it processes a revoke commit', async () => {
    const g = await twoDeviceProfileGroup()
    const seen: Array<Array<{ device: string; controller: string }>> = []
    g.memberGroup.events.on('deviceRevoked', (batch) => { seen.push(batch) })
    const res = await revokeDevice(g.creatorGroup, g.identityA, { device: g.deviceB, capability: g.manageCapability })
    await g.memberGroup.processMessage(res.commitMessage)
    expect(seen.length).toBe(1)
    expect(seen[0].map((r) => r.device)).toContain(normalizeDID(g.deviceB))
  })

  test('a subscription survives a derived handle (shared emitter)', async () => {
    const g = await twoDeviceProfileGroup()
    let fired = 0
    g.memberGroup.events.on('deviceRevoked', () => { fired++ })
    // Drive two sequential commits through the member; the emitter is carried onto each derived handle.
    const r1 = await revokeDevice(g.creatorGroup, g.identityA, { device: g.deviceB, capability: g.manageCapability })
    await g.memberGroup.processMessage(r1.commitMessage)
    expect(fired).toBe(1)
  })
})
```
> Bind `twoDeviceProfileGroup`'s exact returned field names to the fixture (`creatorGroup`/`memberGroup`/`identityA`/`deviceB`/`profile`/`manageCapability` are the expected names from Slice 2's harness; adjust to the real exports). If the harness lacks a two-member receive path, extend it minimally rather than inlining group setup here.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/mls && pnpm exec vitest run test/device-events.test.ts`
Expected: FAIL — `events`/`revokedDevices` do not exist on `GroupHandle`.

- [ ] **Step 3: Add the emitter plumbing**

In `packages/mls/src/group-handle.ts`:

Import at the top:
```typescript
import { EventEmitter, type EventsSource } from '@sozai/event'
```
Add `controllerOf`, `isDeviceValue`, `DEVICE_ENTRY_TYPE`, `type DeviceValue` to the existing `./registry.js` import if not already present (`controllerOf` and `denySetOf` already are).

Declare the event map near the other exported types:
```typescript
/** Events a GroupHandle emits. Advisory notifications derived from the folded ledger; never
 *  a protocol input. Delivered via `fire` (a throwing listener never breaks a fold). */
export type GroupHandleEvents = {
  deviceRevoked: Array<{ device: string; controller: string }>
  controllerBeaconChanged: { controller: string; logLength: number; headDigest: string }
}
```
Add a module-level WeakMap beside the other per-handle side tables (mirrors `mutexFor`/`deviceDenyHolderFor`):
```typescript
const EMITTERS = new WeakMap<GroupHandle, EventEmitter<GroupHandleEvents>>()

/** The full emitter for a handle — module-internal, for deriveGroup to share it onward. */
export function emitterOf(group: GroupHandle): EventEmitter<GroupHandleEvents> {
  const emitter = EMITTERS.get(group)
  if (emitter == null) throw new Error('GroupHandle has no event emitter')
  return emitter
}
```
Extend `GroupHandleParams`:
```typescript
  /** Shared event emitter; a derived handle inherits its parent's so subscriptions persist. */
  events?: EventEmitter<GroupHandleEvents>
```
In the constructor, register the emitter (reuse the parent's when derived, else construct fresh). Add near the end of the constructor, after the deny-holder wiring:
```typescript
    EMITTERS.set(this, params.events ?? new EventEmitter<GroupHandleEvents>())
```
Add the public listen-only accessor beside the other getters:
```typescript
  /** Listen-only view of this group's events. Consumers subscribe; they cannot emit. */
  get events(): EventsSource<GroupHandleEvents> {
    return emitterOf(this)
  }
```

- [ ] **Step 4: Add `revokedDevices()` and `emitControlEvents`**

Add methods to `GroupHandle` (place `revokedDevices` beside `currentDenySet`):
```typescript
  /**
   * The device bindings currently at `status: 'revoked'` — an enumerable notification/tracking
   * surface for consumers deciding where else to revoke. Distinct from currentDenySet(), the
   * opaque matched-never-enumerated validation deny set; this is never a gating input.
   */
  revokedDevices(): ReadonlyArray<{ device: string; controller: string; label?: string }> {
    const out: Array<{ device: string; controller: string; label?: string }> = []
    for (const [device, record] of this.#registry.devices) {
      if (record.status === 'revoked') {
        out.push({ device, controller: record.controller, ...(record.label !== undefined ? { label: record.label } : {}) })
      }
    }
    return out
  }

  /**
   * Fire notification events for the device entries just enacted in one operation. Called from the
   * commit path, from bootstrapLedger, and from the local write APIs — NEVER from the constructor
   * or a fresh-join applyLedgerEntries, so a joiner is not replayed the whole history as live events
   * (it reads revokedDevices()/beaconOf for current state instead). Uses `fire`: a throwing
   * listener is swallowed and cannot break the fold. Reads controllerOf on the POST-fold registry.
   */
  emitControlEvents(enacted: ReadonlyArray<VerifiedLedgerEntry>): void {
    const emitter = emitterOf(this)
    const revoked: Array<{ device: string; controller: string }> = []
    for (const { entry } of enacted) {
      if (entry.type !== DEVICE_ENTRY_TYPE || !isDeviceValue(entry.value)) continue
      const value: DeviceValue = entry.value
      const subject = normalizeDID(entry.subject)
      if (value.op === 'revoke') {
        const controller = controllerOf(this.#registry, subject)
        if (controller != null) revoked.push({ device: subject, controller })
      } else if (value.op === 'beacon' && value.logLength != null && value.headDigest != null) {
        emitter.fire('controllerBeaconChanged', {
          controller: subject,
          logLength: value.logLength,
          headDigest: value.headDigest,
        })
      }
    }
    if (revoked.length > 0) emitter.fire('deviceRevoked', revoked)
  }
```

- [ ] **Step 5: Change `applyLedgerEntries` to return the appended entries; fire on the commit + bootstrap paths; thread the emitter through `deriveGroup`**

Change `applyLedgerEntries` to collect and return the verified entries it appended (callers that ignore the return are unaffected; only Task 5's write APIs use it):
```typescript
  async applyLedgerEntries(tokens: Array<string>): Promise<Array<VerifiedLedgerEntry>> {
    return mutexFor(this).run(async () => {
      const appended: Array<VerifiedLedgerEntry> = []
      for (const token of tokens) {
        const verified = await verifyLedgerEntry(token)
        if (verified == null || verified.entry.groupID !== this.groupID) continue
        const entryID = ledgerEntryDigest(token)
        this.#ledger.push({ entryID, token, verified })
        this.#entryBodies.set(entryID, { token, verified })
        appended.push(verified)
      }
      const folded = foldLedgerControl(this.#ledger, this.#anchor, this.groupID)
      this.#roster = folded.roster
      this.#registry = folded.registry
      return appended
    })
  }
```
> Note: `applyLedgerEntries` itself does NOT call `emitControlEvents` — that keeps fresh-join (`processWelcome`) and derived-membership replays silent. Firing is the caller's choice.

On the commit path, after the registry is installed (`this.#registry = candidateRegistry`, ~line 885), fire for that commit's device entries (all accepted, since `foldEnvelope` returned ok):
```typescript
      this.#registry = candidateRegistry
      if (surfaced.length > 0) this.#onLedgerEntries?.(surfaced)
      this.emitControlEvents(
        ordered.filter((i) => i.verified.entry.type === DEVICE_ENTRY_TYPE).map((i) => i.verified),
      )
```
> `ordered` is the folded `Array<FoldInput>` in scope at the `foldEnvelope(this.#roster, this.#registry, ordered, ...)` call. Confirm the variable name at the call site and use it.

In `bootstrapLedger`, mirror the surfaced computation for device entries — compute the new device entries BEFORE `#entryBodies` is reassigned (alongside the existing `surfaced` at ~line 514), then fire AFTER the registry install (~line 527):
```typescript
      const enactedDevice = log
        .filter(({ entryID, verified }) => !this.#entryBodies.has(entryID) && verified.entry.type === DEVICE_ENTRY_TYPE)
        .map(({ verified }) => verified)
```
and after `this.#registry = folded.registry`:
```typescript
      if (surfaced.length > 0) this.#onLedgerEntries?.(surfaced)
      this.emitControlEvents(enactedDevice)
```

In `deriveGroup`, pass the parent's emitter so a subscription survives:
```typescript
export function deriveGroup(group: GroupHandle, state: ClientState): GroupHandle {
  return new GroupHandle({
    state,
    credential: group.credential,
    context: group.context,
    ledger: group.ledger,
    commitPolicy: group.commitPolicy,
    resolveLedgerEntries: group.resolveLedgerEntries,
    onLedgerEntries: group.onLedgerEntries,
    events: emitterOf(group),
  })
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/mls && pnpm exec vitest run test/device-events.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + full mls suite (catch regressions from the `applyLedgerEntries` return change)**

Run: `cd packages/mls && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && pnpm exec vitest run`
Expected: PASS (all Slice 1/2 tests still green).

- [ ] **Step 8: Commit**

```bash
git add packages/mls/src/group-handle.ts packages/mls/test/device-events.test.ts
git commit -m "feat(mls): GroupHandle event emitter, revokedDevices(), deviceRevoked on the receive path"
```

---

### Task 5: `announceControllerBeacon` write API + local firing + `GroupMember.controllerBeacon` + exports

**Files:**
- Modify: `packages/mls/src/group-device.ts` (`announceControllerBeacon`; fire on `revokeDevice` and `announceControllerBeacon`)
- Modify: `packages/mls/src/credential.ts:47-65` (`GroupMember.controllerBeacon`)
- Modify: `packages/mls/src/group-handle.ts` (`#iterateMembers` attaches `controllerBeacon`)
- Modify: `packages/mls/src/group.ts`, `packages/mls/src/index.ts` (exports)
- Test: `packages/mls/test/device-write.test.ts`, `packages/mls/test/device-events.test.ts`

**Interfaces:**
- Consumes: `commitWithEntries`, `deriveGroup`, `mutexFor`, `signLedgerEntry`, `DEVICE_ENTRY_TYPE`, `emitControlEvents`, `beaconOf`, `controllerOf`.
- Produces:
  - `announceControllerBeacon(group, identity, params: { controller: string; logLength: number; headDigest: string }): Promise<DeviceWriteResult>`
  - `GroupMember` gains `controllerBeacon?: ControllerBeacon`
  - barrel exports of `announceControllerBeacon`, `type ControllerBeacon`, `type GroupHandleEvents`

- [ ] **Step 1: Write the failing tests**

Add to `packages/mls/test/device-events.test.ts`:
```typescript
import { announceControllerBeacon } from '../src/group-device.js'
import { beaconOf } from '../src/registry.js'

describe('controller beacon', () => {
  test('announceControllerBeacon folds the beacon and surfaces it on the member view + fires the event', async () => {
    const g = await twoDeviceProfileGroup()
    let beaconEvent: { controller: string; logLength: number; headDigest: string } | undefined
    g.creatorGroup.events.on('controllerBeaconChanged', (e) => { beaconEvent = e })
    const res = await announceControllerBeacon(g.creatorGroup, g.identityA, {
      controller: g.profile,
      logLength: 12,
      headDigest: 'zFullHead',
    })
    // Folded projection:
    expect(beaconOf(res.newGroup.registry, g.profile)).toEqual({ logLength: 12, headDigest: 'zFullHead' })
    // Local firing:
    expect(beaconEvent).toEqual({ controller: normalizeDID(g.profile), logLength: 12, headDigest: 'zFullHead' })
    // Member-view surfacing: deviceA is a bound device of profile.
    const memberA = res.newGroup.listMembers().find((m) => normalizeDID(m.id) === normalizeDID(g.deviceA))
    expect(memberA?.controllerBeacon).toEqual({ logLength: 12, headDigest: 'zFullHead' })
  })

  test('a receiver folds and fires controllerBeaconChanged when it processes the beacon commit', async () => {
    const g = await twoDeviceProfileGroup()
    let received: { controller: string; logLength: number; headDigest: string } | undefined
    g.memberGroup.events.on('controllerBeaconChanged', (e) => { received = e })
    const res = await announceControllerBeacon(g.creatorGroup, g.identityA, { controller: g.profile, logLength: 3, headDigest: 'zH3' })
    await g.memberGroup.processMessage(res.commitMessage)
    expect(received).toEqual({ controller: normalizeDID(g.profile), logLength: 3, headDigest: 'zH3' })
  })

  test('revokeDevice fires deviceRevoked on the local (author) handle', async () => {
    const g = await twoDeviceProfileGroup()
    const seen: Array<{ device: string; controller: string }> = []
    g.creatorGroup.events.on('deviceRevoked', (batch) => { seen.push(...batch) })
    await revokeDevice(g.creatorGroup, g.identityA, { device: g.deviceB, capability: g.manageCapability })
    expect(seen.map((r) => r.device)).toContain(normalizeDID(g.deviceB))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/mls && pnpm exec vitest run test/device-events.test.ts`
Expected: FAIL — `announceControllerBeacon` undefined; `controllerBeacon` absent on members; `revokeDevice` does not fire locally.

- [ ] **Step 3: Add `announceControllerBeacon` and fire on the write APIs**

In `packages/mls/src/group-device.ts`, add the write API (mirrors `labelDevice`, but no capability, subject = the controller, and it fires locally):
```typescript
/**
 * Announce the controller's FULL log head into the group as folded, cross-peer-consistent state.
 * Advisory only — it gates nothing. Authored by any bound device of `controller` (self-scoped, no
 * management capability). Publish only-on-change and only when the log meaningfully advances: each
 * call is a permanent ledger entry (replayed at every welcome, no compaction).
 */
export async function announceControllerBeacon(
  group: GroupHandle,
  identity: SigningIdentity,
  params: { controller: string; logLength: number; headDigest: string },
): Promise<DeviceWriteResult> {
  return mutexFor(group).run(async () => {
    const token = await signLedgerEntry(identity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: group.groupID,
      subject: params.controller,
      value: { op: 'beacon', logLength: params.logLength, headDigest: params.headDigest },
    })
    const result = await commitWithEntries(group, [], [token], false, { requireAdmin: false })
    const newGroup = deriveGroup(group, result.newState)
    const enacted = await newGroup.applyLedgerEntries([token])
    newGroup.emitControlEvents(enacted)
    return {
      commitMessage: encode(mlsMessageEncoder, result.commit),
      newGroup,
      epoch: newGroup.epoch,
    }
  })
}
```
Fire locally on `revokeDevice` too — after its `await newGroup.applyLedgerEntries([token])`, capture the return and emit:
```typescript
    const enacted = await newGroup.applyLedgerEntries([token])
    newGroup.emitControlEvents(enacted)
```
> Apply the same two-line change (capture `enacted`, call `emitControlEvents`) to `registerDevice`, `addDevice`, and `labelDevice` for symmetry ONLY if the reviewer wants uniform firing; for THIS slice the required firing is `revokeDevice` (→ `deviceRevoked`) and `announceControllerBeacon` (→ `controllerBeaconChanged`). Register/add/label produce no Slice-3 event, so leaving them unchanged is correct and preferred (YAGNI). Do the two named ones only.

- [ ] **Step 4: Add `controllerBeacon` to `GroupMember` and surface it**

In `packages/mls/src/credential.ts`, import the type and extend `GroupMember`:
```typescript
import type { ControllerBeacon } from './registry.js'
```
```typescript
export type GroupMember = {
  leafIndex: number
  id: string
  longForm: string
  controller?: string
  /** For a bound leaf: the controller's advisory folded log beacon, when one has been announced. */
  controllerBeacon?: ControllerBeacon
}
```
> If importing `./registry.js` into `credential.ts` creates an import cycle (registry.ts imports roster.ts, not credential.ts — a cycle is unlikely, but verify), instead inline the shape `{ logLength: number; headDigest: string }` on `GroupMember` and keep `ControllerBeacon` as the canonical alias exported from `registry.ts`. Prefer the import; fall back to the inline shape only if `tsc` reports a cycle.

In `packages/mls/src/group-handle.ts` `#iterateMembers`, attach the beacon from the folded projection (`beaconOf` must be imported from `./registry.js`):
```typescript
          const controller = parsed.controller ? parsed.controller.id : undefined
          const beacon = controller != null ? beaconOf(this.#registry, controller) : undefined
          yield {
            leafIndex: i / 2,
            id: parsed.id,
            longForm: parsed.longForm ?? parsed.id,
            ...(controller ? { controller } : {}),
            ...(beacon ? { controllerBeacon: beacon } : {}),
          }
```

- [ ] **Step 5: Barrel exports**

In `packages/mls/src/group.ts`, add to the `from './group-device.js'` re-export block: `announceControllerBeacon`. Add to the `from './registry.js'` block (or wherever registry types are re-exported): `type ControllerBeacon`. Add `type GroupHandleEvents` from `./group-handle.js`.

In `packages/mls/src/index.ts`, mirror the SAME three additions in the corresponding named re-export blocks (this is the public entry point — Slice 2 shipped a defect where `group.ts` re-exported names that `index.ts` omitted; do not repeat it).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/mls && pnpm exec vitest run test/device-events.test.ts test/device-write.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + confirm exports reachable**

Run: `cd packages/mls && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Add a one-line reachability assertion to `device-events.test.ts` importing from the public entry:
```typescript
import { announceControllerBeacon as _pub, type ControllerBeacon as _CB, type GroupHandleEvents as _GHE } from '../src/index.js'
```
Expected: PASS (names resolve from `../src/index.js`).

- [ ] **Step 8: Commit**

```bash
git add packages/mls/src/group-device.ts packages/mls/src/credential.ts packages/mls/src/group-handle.ts packages/mls/src/group.ts packages/mls/src/index.ts packages/mls/test/device-events.test.ts
git commit -m "feat(mls): announceControllerBeacon write API, GroupMember.controllerBeacon, local firing, exports"
```

---

### Task 6: Hardening — welcome-silence, end-to-end attack, mutation sweep, full gate

**Files:**
- Test: extend `packages/mls/test/device-events.test.ts`, `packages/mls/test/device-attacks.test.ts`, `packages/mls/test/device-authority.test.ts` (determinism)

**Interfaces:**
- Consumes: the full Slice 3 surface built above + the Slice 2 harness.

- [ ] **Step 1: A fresh joiner is NOT replayed history as live events**

In `device-events.test.ts`, assert that a member joining a group that ALREADY has a folded revoke + beacon does not fire `deviceRevoked`/`controllerBeaconChanged` at join (`processWelcome`/`applyLedgerEntries`), but DOES see the current state via `revokedDevices()` / `beaconOf`:
```typescript
  test('a fresh join folds prior state silently — no replayed events, but state is visible', async () => {
    const g = await twoDeviceProfileGroup()
    // Enact a revoke and a beacon on the creator, advancing its handle each time.
    const r1 = await revokeDevice(g.creatorGroup, g.identityA, { device: g.deviceB, capability: g.manageCapability })
    const r2 = await announceControllerBeacon(r1.newGroup, g.identityA, { controller: g.profile, logLength: 5, headDigest: 'zH5' })
    // A NEW device joins the group whose ledger ALREADY holds that revoke + beacon.
    const joiner = await g.inviteAndJoinNewDevice(r2.newGroup) // fresh GroupHandle folded from the welcome ledger
    let fired = 0
    joiner.events.on('deviceRevoked', () => { fired++ })
    joiner.events.on('controllerBeaconChanged', () => { fired++ })
    // No NEW commit has been processed since subscribing → nothing fires; the state is nonetheless present.
    expect(fired).toBe(0)
    expect(joiner.revokedDevices().map((r) => r.device)).toContain(normalizeDID(g.deviceB))
    expect(beaconOf(joiner.registry, g.profile)).toEqual({ logLength: 5, headDigest: 'zH5' })
  })
```
> `inviteAndJoinNewDevice` is illustrative — bind it to the real fixture (Slice 2's harness) or extend the fixture minimally to return a freshly-joined `GroupHandle`. The load-bearing assertions are (1) zero events fire from a pure fold-at-join (the joiner subscribed AFTER folding the welcome ledger, and no new commit follows), and (2) `revokedDevices()`/`beaconOf` still reflect the folded state. If the harness cannot expose a fresh joiner handle, assert instead that a fresh handle built via `bootstrapLedger` over the creator's `getLedger()` reports the correct `revokedDevices()`/`beaconOf` while a listener attached to it fires 0 times (bootstrap does fire on the bootstrap path — so for THIS silence assertion prefer the welcome/join path, which routes through `applyLedgerEntries` and stays silent).

- [ ] **Step 2: End-to-end attack — a beacon by a non-owner device is rejected by every honest receiver**

In `device-attacks.test.ts`, build a device bound to controller P and have it try to announce a beacon for a DIFFERENT controller Q; assert the whole commit is rejected on the receive path (a `CommitRejectedError` from `processMessage`) and thrown on the authoring path:
```typescript
  test('a beacon for a controller the issuer is not a device of is rejected', async () => {
    const g = await twoDeviceProfileGroup()
    // deviceA is bound to profile; announce a beacon for an unrelated controller DID.
    await expect(
      announceControllerBeacon(g.creatorGroup, g.identityA, { controller: 'did:kokuin:someoneElse', logLength: 1, headDigest: 'zX' }),
    ).rejects.toThrow() // authoring-side gate (verifyDeviceEntry beacon case) throws
  })
```
Add a receive-path variant if the harness can hand-craft a signed beacon token for a mismatched controller and feed it via a crafted commit; assert the receiver rejects the whole commit. If crafting is impractical, the authoring-side rejection plus the Task 3 unit tests cover the gate; note that in the test comment.

- [ ] **Step 3: Determinism — incremental vs bootstrap agree on the controllers projection**

Extend `device-authority.test.ts`'s determinism test (or add one): after enacting a `beacon` (and a revoke) through the write API, reconstruct a fresh handle via `bootstrapLedger` over `getLedger()` and assert the bootstrapped `registry.controllers` and `revokedDevices()` deep-equal the live handle's:
```typescript
    expect([...bootstrapped.registry.controllers.entries()]).toEqual([...live.registry.controllers.entries()])
    expect(bootstrapped.revokedDevices()).toEqual(live.revokedDevices())
```

- [ ] **Step 4: Mutation sweep (review gate)**

For each guard, break it, confirm a test flips, then restore:
- delete the `beacon` branch in `verifyDeviceEntry` → the "beacon for a controller the issuer is not a device of is rejected" test flips to accept (the entry falls through to the manage-op path and mis-authorizes or errors differently) — confirm the honest-accept beacon test AND the attack test both react.
- change the beacon branch check `normalizeDID(binding.controller) === subject` to always `return true` → the attack test flips to accept.
- in `emitControlEvents`, change `if (value.op === 'revoke')` to also fire on register → a spurious `deviceRevoked` fires on a register; confirm a test catches an unexpected event (add a guard assertion: registering a device fires NO `deviceRevoked`).
- in `foldEnvelope`, revert the `controllers: new Map(baseRegistry.controllers)` clone to `{ devices: ... }` only → the "base registry beacon survives" test flips.
- remove the `deriveGroup` `events: emitterOf(group)` line → the "subscription survives a derived handle" test flips (the write-path fire lands on a fresh emitter with no listeners).

Record in the commit message that the mutation sweep ran and which guards bit.

- [ ] **Step 5: Full gate**

Run:
```bash
cd packages/mls && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && pnpm exec vitest run
cd /Users/paul/dev/yulsi/kumiai && ./node_modules/.bin/biome check packages/mls/src packages/mls/test
rtk proxy pnpm -w run lint
```
Expected: all pass; biome clean; lint clean.

- [ ] **Step 6: Commit**

```bash
git add packages/mls/test/device-events.test.ts packages/mls/test/device-attacks.test.ts packages/mls/test/device-authority.test.ts
git commit -m "test(mls): Slice 3 welcome-silence, beacon attack, determinism, mutation sweep"
```

---

## Final verification

- [ ] Run the whole `@kumiai/mls` gate: `cd packages/mls && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && pnpm exec vitest run`. Force a real run and confirm `Cached: 0`.
- [ ] Run repo lint: `cd /Users/paul/dev/yulsi/kumiai && rtk proxy pnpm -w run lint` — confirm clean.
- [ ] Confirm NO consumer-port change: grep the diff for `packages/rpc`, `packages/mls-rpc`, `packages/hub-*` — expect no changes. No `loadLog` port anywhere.
- [ ] Confirm `v: 1` untouched: no version field added to `MLSCredentialIdentity` or any control envelope; no version gate in the diff.
- [ ] Confirm the only dependency change is `@sozai/event: catalog:` in `packages/mls/package.json`; `@kokuin/*` catalog ranges unchanged.
- [ ] Confirm the beacon is read nowhere as a validation input: grep for `beaconOf` / `controllers` usage — every consumer is a read for surfacing or an event, never a gate.
- [ ] `build:types` green across all packages: `cd /Users/paul/dev/yulsi/kumiai && rtk proxy pnpm -w run build:types` (or `pnpm -w run build:types`).

## Self-Review notes (author)

- **Spec coverage:** Deliverable 1 — `revokedDevices()` (Task 4) + `deviceRevoked` event over the emitter, fired on the commit path and `bootstrapLedger` (Task 4) and the local write path (Task 5). Deliverable 2 — `beacon` op + `DeviceRegistry.controllers` projection + `beaconOf` (Task 1), folded on both the incremental and commit paths (Tasks 1–2), the self-scoped no-capability proof gate (Task 3), `announceControllerBeacon` write API (Task 5), `GroupMember.controllerBeacon` read (Task 5), `controllerBeaconChanged` event (Tasks 4–5). Emitter — one shared `EventEmitter<GroupHandleEvents>`, listen-only `EventsSource` public, `fire` not `emit`, carried onto derived handles (Task 4). Constraints — `v:1`, no port/conformance, `@kumiai/mls` + one catalog dep, beacon never gates (Global Constraints + Task 6 grep).
- **Firing model (resolved design point):** events fire exactly where device entries fold on a live path — the commit path and `bootstrapLedger` (the two sites `onLedgerEntries` fires), plus the local write APIs via the `applyLedgerEntries` return. The constructor seed and `processWelcome`'s bulk `applyLedgerEntries` deliberately do NOT fire, so a joiner is not replayed history; it reads `revokedDevices()`/`beaconOf` for current state (Task 6 Step 1 pins this).
- **Beacon needs no policy change (resolved):** a beacon-only commit carries no Add/Remove and enacts only device entries, so `enactsOnlyDeviceEntries` (Slice 2) already admits its head move; the add/remove carve-outs key on `op === 'add'`/`'revoke'` and ignore `'beacon'`. `defaultCommitPolicy` is untouched.
- **Subject convention (resolved):** for `beacon`, `subject` is the CONTROLLER DID (the thing described), unlike register/add/revoke/label where `subject` is the device DID. The proof gate and fold both read it as the controller.
- **No placeholders:** every step carries literal code. Two tests (Task 4 `twoDeviceProfileGroup` field names; Task 6 harness helpers) are explicitly flagged to bind to the real Slice 2 fixture exports — the implementer confirms names against `test/fixtures/device-harness.ts`, and the review verifies.
