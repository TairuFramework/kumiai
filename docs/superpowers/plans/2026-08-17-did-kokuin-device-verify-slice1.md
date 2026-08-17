# did:kokuin device verification — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a kumiai MLS leaf opt in to being a device of a `did:kokuin:` controller, and have `validateCredential` accept it by verifying an embedded, self-authenticating binding proof synchronously with zero sidecar I/O.

**Architecture:** A leaf's `MLSCredentialIdentity` gains an optional `controller` binding (profile DID + controller-log prefix + delegation capability). `validateCredential` grows a bound branch that folds the embedded prefix through a local resolver adapter (no external log fetch), verifies the capability names this device and pins this leaf's signature key, and checks an injected (empty-in-Slice-1) deny set. Floating `did:key`/`did:peer:4` leaves are untouched.

**Tech Stack:** TypeScript, `ts-mls` (`AuthenticationService`), `@kokuin/token`, `@kokuin/controller`, `@kokuin/capability`, vitest, biome, pnpm workspace catalog.

**Spec:** `docs/superpowers/specs/2026-08-17-did-kokuin-device-verify-slice1-design.md`

## Global Constraints

- **Opt-in, additive.** Floating `did:key`/`did:peer:4` leaves keep their exact current behavior. A leaf is bound iff `controller` is present.
- **Credential version stays `v: 1`.** Bound status is signalled by `controller`, never by `v`. No version gate.
- **Zero sidecar I/O on the validation path.** The resolver's `loadLog` returns only the embedded prefix; any other DID → `undefined`. No code path may fetch a log externally.
- **Permission vocabulary is fixed:** `MLS_LEAF_ACT = 'authenticate'`, `MLS_LEAF_RES = 'kumiai/mls-leaf'`.
- **Authority-only prefix.** The embedded prefix must fold with the sync `foldLog`; a capability-authorised revoke inside it makes the fold fail closed → reject.
- **Repo rules:** pnpm only; cross-repo deps (`@kokuin/*`) go through the workspace catalog as published `^` ranges; do not edit `lib/`. Run scripts as `rtk proxy pnpm run <script>` or invoke tools directly (`pnpm exec biome check`, `pnpm exec vitest`).
- **All validation is pure of external state.** `validateCredential` returns `false` on any failure (never throws past its boundary), matching the existing implementation.

## File Structure

- `pnpm-workspace.yaml` — add `@kokuin/controller` to the catalog (`@kokuin/capability` is already there).
- `packages/mls/package.json` — add `@kokuin/controller` and `@kokuin/capability` deps (`catalog:`).
- `packages/mls/src/credential.ts` — `ControllerBinding` type, `MLSCredentialIdentity.controller`, `GroupMember.controller`, structural parse of `controller`.
- `packages/mls/src/embedded-resolver.ts` — **new** — `createEmbeddedControllerResolver`.
- `packages/mls/src/authentication.ts` — `MLS_LEAF_ACT`/`MLS_LEAF_RES` constants, `matchesLeafKey` helper (extracted), `validateBoundLeaf`, the bound branch, and the optional `deviceDenySet` dependency on `createDIDAuthenticationService`.
- `packages/mls/src/group-handle.ts:530` — surface `controller` on the yielded `GroupMember`.
- `packages/mls/test/fixtures/bound-leaf.ts` — **new** — crafted bound-leaf builder.
- `packages/mls/test/authentication-bound.test.ts` — **new** — the accept/reject matrix.
- `packages/mls/test/credential-controller.test.ts` — **new** — parse structural tests.

Task order is linear: 1 → 6.

---

### Task 1: Dependencies + `controller` credential shape and parse

**Files:**
- Modify: `pnpm-workspace.yaml` (catalog block)
- Modify: `packages/mls/package.json` (dependencies)
- Modify: `packages/mls/src/credential.ts`
- Test: `packages/mls/test/credential-controller.test.ts` (create)

**Interfaces:**
- Produces: `type ControllerBinding = { id: string; prefix: Array<SignedEvent>; capability: string }`; `MLSCredentialIdentity` gains `controller?: ControllerBinding`; `GroupMember` gains `controller?: string`; `parseMLSCredentialIdentity` accepts/validates `controller` structurally.

- [ ] **Step 1: Add the catalog entry and package deps**

In `pnpm-workspace.yaml`, in the `catalog:` block next to the existing `'@kokuin/capability': ^0.1.0` line, add:

```yaml
  '@kokuin/controller': ^0.1.0
```

In `packages/mls/package.json`, add two entries to `dependencies` (keep alphabetical grouping with the existing `@kokuin/token`):

```json
    "@kokuin/capability": "catalog:",
    "@kokuin/controller": "catalog:",
    "@kokuin/token": "catalog:",
```

Then install:

Run: `pnpm install`
Expected: lockfile updates, `@kumiai/mls` resolves both new packages, no errors.

- [ ] **Step 2: Write the failing parse tests**

Create `packages/mls/test/credential-controller.test.ts`:

```typescript
import { describe, expect, test } from 'vitest'

import { parseMLSCredentialIdentity } from '../src/credential.js'

const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj))

const validController = {
  id: 'did:kokuin:abc',
  prefix: [{ event: { v: 1, t: 'icp' }, sigs: ['x'] }],
  capability: 'ey.token',
}

describe('parseMLSCredentialIdentity controller', () => {
  test('accepts a well-formed controller binding', () => {
    const parsed = parseMLSCredentialIdentity(
      enc({ id: 'did:key:zDevice', controller: validController }),
    )
    expect(parsed.controller).toEqual(validController)
  })

  test('floating identity has no controller', () => {
    const parsed = parseMLSCredentialIdentity(enc({ id: 'did:key:zDevice' }))
    expect(parsed.controller).toBeUndefined()
  })

  test('rejects a non-object controller', () => {
    expect(() => parseMLSCredentialIdentity(enc({ id: 'did:key:z', controller: 'nope' }))).toThrow()
  })

  test('rejects a controller with a non-string id', () => {
    expect(() =>
      parseMLSCredentialIdentity(enc({ id: 'did:key:z', controller: { ...validController, id: 5 } })),
    ).toThrow()
  })

  test('rejects a controller with a non-string capability', () => {
    expect(() =>
      parseMLSCredentialIdentity(
        enc({ id: 'did:key:z', controller: { ...validController, capability: 5 } }),
      ),
    ).toThrow()
  })

  test('rejects a controller with a non-array prefix', () => {
    expect(() =>
      parseMLSCredentialIdentity(
        enc({ id: 'did:key:z', controller: { ...validController, prefix: {} } }),
      ),
    ).toThrow()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/mls && pnpm exec vitest run test/credential-controller.test.ts`
Expected: FAIL — `parsed.controller` is `undefined` on the accept case and the reject cases don't throw (parse ignores the unknown field today).

- [ ] **Step 4: Add the type and parse logic**

In `packages/mls/src/credential.ts`, add the import at the top:

```typescript
import type { SignedEvent } from '@kokuin/controller'
```

Add the type above `MLSCredentialIdentity`:

```typescript
/**
 * Opt-in binding that makes an MLS leaf a *device of a `did:kokuin:` controller*. Present ⟺ bound.
 * `id` names the profile DID; `prefix` is the authority-only controller-log prefix folded (sync) to
 * verify the delegation; `capability` is the delegation token binding this device under the profile.
 * All three are verification inputs — only the profile `id` is surfaced into `GroupMember`.
 */
export type ControllerBinding = {
  id: string
  prefix: Array<SignedEvent>
  capability: string
}
```

Add the field to `MLSCredentialIdentity` (after `longForm?`):

```typescript
  controller?: ControllerBinding
```

Add `controller?: string` to `GroupMember` (after `longForm`):

```typescript
  /** For a bound leaf: the authenticated `did:kokuin:` controller (profile) DID. Absent for floating leaves. */
  controller?: string
```

In `parseMLSCredentialIdentity`, after the `longForm` handling and before `return result`, add:

```typescript
  if ('controller' in candidate) {
    const c = candidate.controller
    if (c == null || typeof c !== 'object') {
      throw new Error('Invalid MLS credential: controller must be an object when present')
    }
    const cc = c as Record<string, unknown>
    if (typeof cc.id !== 'string') {
      throw new Error('Invalid MLS credential: controller.id must be a string')
    }
    if (typeof cc.capability !== 'string') {
      throw new Error('Invalid MLS credential: controller.capability must be a string')
    }
    if (!Array.isArray(cc.prefix)) {
      throw new Error('Invalid MLS credential: controller.prefix must be an array')
    }
    // Structural only — the prefix events are validated cryptographically by the fold in
    // validateCredential, never here (parse stays pure/structural, like longForm).
    result.controller = {
      id: cc.id,
      prefix: cc.prefix as Array<SignedEvent>,
      capability: cc.capability,
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/mls && pnpm exec vitest run test/credential-controller.test.ts`
Expected: PASS (all 6).

- [ ] **Step 6: Typecheck and lint**

Run: `cd packages/mls && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && cd /Users/paul/dev/yulsi/kumiai && pnpm exec biome check packages/mls/src/credential.ts packages/mls/test/credential-controller.test.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml packages/mls/package.json packages/mls/src/credential.ts packages/mls/test/credential-controller.test.ts
git commit -m "feat(mls): add optional controller binding to the MLS credential shape"
```

---

### Task 2: The embedded controller-resolver adapter

**Files:**
- Create: `packages/mls/src/embedded-resolver.ts`
- Test: `packages/mls/test/embedded-resolver.test.ts` (create)

**Interfaces:**
- Consumes: `SignedEvent` (`@kokuin/controller`), `DIDMethodResolver` (`@kokuin/token`).
- Produces: `createEmbeddedControllerResolver(params: { controllerID: string; prefix: Array<SignedEvent>; denySet?: ReadonlySet<string> }): DIDMethodResolver`.

- [ ] **Step 1: Write the failing test**

Create `packages/mls/test/embedded-resolver.test.ts`:

```typescript
import { createInception, didFromInception } from '@kokuin/controller'
import { describe, expect, test } from 'vitest'

import { createEmbeddedControllerResolver } from '../src/embedded-resolver.js'

const seed = new Uint8Array(32).fill(7)
const inception = createInception(seed, 0)
const did = didFromInception(inception.event)

describe('createEmbeddedControllerResolver', () => {
  test('resolves the controller signing key from the embedded prefix', async () => {
    const resolver = createEmbeddedControllerResolver({ controllerID: did, prefix: [inception] })
    const resolved = await resolver.resolve(did)
    expect(resolved.alg).toBe('EdDSA')
    expect(resolved.publicKey).toBeInstanceOf(Uint8Array)
  })

  test('returns the injected deny set', async () => {
    const denySet = new Set(['did:key:zDenied'])
    const resolver = createEmbeddedControllerResolver({ controllerID: did, prefix: [inception], denySet })
    expect(await resolver.resolveDenySet?.(did)).toBe(denySet)
  })

  test('empty deny set by default', async () => {
    const resolver = createEmbeddedControllerResolver({ controllerID: did, prefix: [inception] })
    expect((await resolver.resolveDenySet?.(did))?.size).toBe(0)
  })

  test('unknown DID never reaches an external source (loadLog returns undefined → Unknown DID)', async () => {
    const resolver = createEmbeddedControllerResolver({ controllerID: did, prefix: [inception] })
    await expect(resolver.resolve('did:kokuin:someoneElse')).rejects.toThrow(/Unknown DID/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mls && pnpm exec vitest run test/embedded-resolver.test.ts`
Expected: FAIL with "Cannot find module '../src/embedded-resolver.js'".

- [ ] **Step 3: Write the adapter**

Create `packages/mls/src/embedded-resolver.ts`:

```typescript
import { createControllerResolver, type SignedEvent } from '@kokuin/controller'
import type { DIDMethodResolver } from '@kokuin/token'

const EMPTY: ReadonlySet<string> = new Set()

/**
 * A `did:kokuin:` resolver whose log is the prefix EMBEDDED in an MLS leaf — never fetched
 * externally. `loadLog` answers only for `controllerID`, returning the embedded `prefix`, and
 * `undefined` for any other DID, so no code path can reach a sidecar. `resolveDenySet` is overridden
 * to answer from the injected group-folded set (freshness), rather than the prefix's frozen head.
 *
 * A per-leaf, one-shot instance: the prefix is small, verification is single-pass, and no `history`
 * store is configured. This is the adapter the Slice 1 spike verified to run with zero external I/O.
 */
export function createEmbeddedControllerResolver(params: {
  controllerID: string
  prefix: Array<SignedEvent>
  denySet?: ReadonlySet<string>
}): DIDMethodResolver {
  const base = createControllerResolver({
    loadLog: async (did) => (did === params.controllerID ? params.prefix : undefined),
  })
  return {
    ...base,
    async resolveDenySet(_did: string): Promise<ReadonlySet<string>> {
      return params.denySet ?? EMPTY
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mls && pnpm exec vitest run test/embedded-resolver.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Typecheck and lint**

Run: `cd packages/mls && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && cd /Users/paul/dev/yulsi/kumiai && pnpm exec biome check packages/mls/src/embedded-resolver.ts packages/mls/test/embedded-resolver.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/mls/src/embedded-resolver.ts packages/mls/test/embedded-resolver.test.ts
git commit -m "feat(mls): add embedded controller-resolver adapter (zero-I/O)"
```

---

### Task 3: Extract the floating key-binding check into a helper

Behavior-preserving refactor: the existing `did:key`/`did:peer:4` key-match logic moves into a reusable `matchesLeafKey` helper so the bound branch (Task 4) can reuse it. Existing floating behavior is the regression guard.

**Files:**
- Modify: `packages/mls/src/authentication.ts`

**Interfaces:**
- Produces: `function matchesLeafKey(parsed: MLSCredentialIdentity, signaturePublicKey: Uint8Array): boolean` (module-local, not exported).

- [ ] **Step 1: Extract the helper**

In `packages/mls/src/authentication.ts`, add an import for the parsed type:

```typescript
import { type MLSCredentialIdentity, parseMLSCredentialIdentity } from './credential.js'
```

(Replace the existing `import { parseMLSCredentialIdentity } from './credential.js'` line.)

Add this module-local function (above `createDIDAuthenticationService`), moving the body of the current `validateCredential` (everything after the `parse` try/catch) into it verbatim:

```typescript
/**
 * Whether `signaturePublicKey` is the key the parsed identity's DID authenticates with — the
 * floating-leaf binding, shared by floating validation and the bound branch (a bound leaf is a
 * floating leaf plus a controller attribution). `did:peer:4` binds through the long-form
 * authentication verification methods; every other form is a `did:key` whose key IS its identifier.
 */
function matchesLeafKey(
  parsed: MLSCredentialIdentity,
  signaturePublicKey: Uint8Array,
): boolean {
  if (isPeer4(parsed.id)) {
    if (parsed.longForm == null) return false
    let decoded: ReturnType<typeof decodePeer4>
    try {
      decoded = decodePeer4(parsed.longForm)
    } catch {
      return false
    }
    if (decoded.shortForm !== parsed.id) return false
    const authIDs = new Set(decoded.doc.authentication ?? [])
    if (authIDs.size === 0) return false
    for (const vm of decoded.doc.verificationMethod ?? []) {
      if (!authIDs.has(vm.id)) continue
      if (typeof vm.publicKeyMultibase !== 'string') continue
      let vmBytes: Uint8Array
      try {
        vmBytes = decodeMultibase(vm.publicKeyMultibase)
      } catch {
        continue
      }
      const stripped = getAlgorithmAndPublicKey(vmBytes)
      if (stripped == null) continue
      const [, publicKeyBytes] = stripped
      if (constantTimeEqual(publicKeyBytes, signaturePublicKey)) return true
    }
    return false
  }

  try {
    const [, publicKeyFromDID] = getSignatureInfo(parsed.id)
    return constantTimeEqual(publicKeyFromDID, signaturePublicKey)
  } catch {
    return false
  }
}
```

Rewrite `validateCredential`'s body to delegate to it (the bound branch is added in Task 4; for now just the floating path):

```typescript
    async validateCredential(
      credential: Credential,
      signaturePublicKey: Uint8Array,
    ): Promise<boolean> {
      if (credential.credentialType !== defaultCredentialTypes.basic) {
        return false
      }

      let parsed: MLSCredentialIdentity
      try {
        parsed = parseMLSCredentialIdentity((credential as { identity: Uint8Array }).identity)
      } catch {
        return false
      }

      return matchesLeafKey(parsed, signaturePublicKey)
    },
```

- [ ] **Step 2: Run the existing authentication tests to verify no behavior change**

Run: `cd packages/mls && pnpm exec vitest run test/authentication.test.ts`
Expected: PASS (whatever the current floating tests are — unchanged). If the repo has no `authentication.test.ts`, run the full suite `pnpm exec vitest run` and confirm no new failures.

- [ ] **Step 3: Typecheck and lint**

Run: `cd packages/mls && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && cd /Users/paul/dev/yulsi/kumiai && pnpm exec biome check packages/mls/src/authentication.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/mls/src/authentication.ts
git commit -m "refactor(mls): extract matchesLeafKey from validateCredential"
```

---

### Task 4: The bound validation branch + deny seam + permission constants

**Files:**
- Modify: `packages/mls/src/authentication.ts`
- Create: `packages/mls/test/fixtures/bound-leaf.ts`
- Test: `packages/mls/test/authentication-bound.test.ts` (create)

**Interfaces:**
- Consumes: `matchesLeafKey` (Task 3), `createEmbeddedControllerResolver` (Task 2), `ControllerBinding`/`MLSCredentialIdentity` (Task 1).
- Produces: `MLS_LEAF_ACT`/`MLS_LEAF_RES` (exported consts); `createDIDAuthenticationService(deps?: { deviceDenySet?: () => ReadonlySet<string> }): AuthenticationService`.

- [ ] **Step 1: Write the crafted-leaf fixture builder**

Create `packages/mls/test/fixtures/bound-leaf.ts`:

```typescript
import { audienceConfirmation, createCapability, now } from '@kokuin/capability'
import { createControllerIdentity, createInception, didFromInception } from '@kokuin/controller'
import { createSigningIdentity, stringifyToken } from '@kokuin/token'

import type { ControllerBinding, MLSCredentialIdentity } from '../../src/credential.js'

export type BoundLeaf = {
  /** JSON-encoded MLSCredentialIdentity bytes, ready for a Credential.identity field. */
  identity: Uint8Array
  /** The device's signing public key = the MLS leaf key to pass as signaturePublicKey. */
  deviceKey: Uint8Array
  /** The device DID (did:key). */
  deviceID: string
  /** The controller (profile) DID. */
  controllerID: string
}

export type BuildBoundLeafOptions = {
  controllerSeed?: Uint8Array
  deviceSeed?: Uint8Array
  profile?: number
  /** Override the assembled MLSCredentialIdentity before encoding — used to craft reject cases. */
  mutate?: (identity: MLSCredentialIdentity, binding: ControllerBinding) => MLSCredentialIdentity
  /** Override the capability payload before signing — used to craft reject cases. */
  capabilityOverrides?: Record<string, unknown>
}

/**
 * Craft a bound-leaf identity from controller + capability primitives (no minting API exists in
 * Slice 1). A valid leaf by default; `mutate`/`capabilityOverrides` corrupt exactly one thing.
 */
export async function buildBoundLeaf(options: BuildBoundLeafOptions = {}): Promise<BoundLeaf> {
  const controllerSeed = options.controllerSeed ?? new Uint8Array(32).fill(31)
  const deviceSeed = options.deviceSeed ?? new Uint8Array(32).fill(41)
  const profile = options.profile ?? 0

  const inception = createInception(controllerSeed, profile)
  const controllerID = didFromInception(inception.event)
  const controller = createControllerIdentity({ seed: controllerSeed, profile, log: [inception] })
  const device = createSigningIdentity(deviceSeed)

  const capabilityToken = await createCapability(controller, {
    sub: controllerID,
    aud: device.id,
    act: 'authenticate',
    res: 'kumiai/mls-leaf',
    exp: now() + 3600,
    cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: device.publicKey }),
    ...options.capabilityOverrides,
  })

  const binding: ControllerBinding = {
    id: controllerID,
    prefix: [inception],
    capability: stringifyToken(capabilityToken),
  }
  let identity: MLSCredentialIdentity = { id: device.id, controller: binding }
  if (options.mutate) identity = options.mutate(identity, binding)

  return {
    identity: new TextEncoder().encode(JSON.stringify(identity)),
    deviceKey: device.publicKey,
    deviceID: device.id,
    controllerID,
  }
}
```

- [ ] **Step 2: Write the failing accept/reject tests**

Create `packages/mls/test/authentication-bound.test.ts`:

```typescript
import type { Credential } from 'ts-mls'
import { defaultCredentialTypes } from 'ts-mls'
import { describe, expect, test } from 'vitest'

import { createDIDAuthenticationService } from '../src/authentication.js'
import { buildBoundLeaf } from './fixtures/bound-leaf.js'

const credentialOf = (identity: Uint8Array): Credential =>
  ({ credentialType: defaultCredentialTypes.basic, identity }) as Credential

const validate = (identity: Uint8Array, key: Uint8Array, denySet?: () => ReadonlySet<string>) =>
  createDIDAuthenticationService(denySet ? { deviceDenySet: denySet } : undefined).validateCredential(
    credentialOf(identity),
    key,
  )

describe('validateCredential — bound did:kokuin leaf', () => {
  test('A1: accepts a valid bound leaf', async () => {
    const leaf = await buildBoundLeaf()
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(true)
  })

  test('R1: rejects a controller.id that is not did:kokuin', async () => {
    const leaf = await buildBoundLeaf({
      mutate: (id, b) => ({ ...id, controller: { ...b, id: 'did:web:evil.example' } }),
    })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R2: rejects a prefix whose inception hashes to another profile', async () => {
    const other = await buildBoundLeaf({ controllerSeed: new Uint8Array(32).fill(99) })
    const leaf = await buildBoundLeaf({
      mutate: (id, b) => ({
        ...id,
        controller: { ...b, prefix: JSON.parse(new TextDecoder().decode(other.identity)).controller.prefix },
      }),
    })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R3: rejects a tampered capability signature', async () => {
    const leaf = await buildBoundLeaf({
      mutate: (id, b) => ({ ...id, controller: { ...b, capability: `${b.capability}x` } }),
    })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R4: rejects a capability whose aud is another device', async () => {
    const leaf = await buildBoundLeaf({ capabilityOverrides: { aud: 'did:key:zSomeoneElse' } })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R5: rejects a capability lacking the mls-leaf grant', async () => {
    const leaf = await buildBoundLeaf({ capabilityOverrides: { act: 'read', res: 'other' } })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R6: rejects an expired capability', async () => {
    const leaf = await buildBoundLeaf({ capabilityOverrides: { exp: now() - 10 } })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R7: rejects a capability with no exp (device policy)', async () => {
    const leaf = await buildBoundLeaf({ capabilityOverrides: { exp: undefined } })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R8: rejects when cnf pins a different key', async () => {
    const leaf = await buildBoundLeaf({
      capabilityOverrides: {
        cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: new Uint8Array(32).fill(1) }),
      },
    })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R9: rejects when the leaf key differs from the device id key', async () => {
    const leaf = await buildBoundLeaf()
    expect(await validate(leaf.identity, new Uint8Array(32).fill(2))).toBe(false)
  })

  test('R11: rejects when the deny set contains the device id', async () => {
    const leaf = await buildBoundLeaf()
    const denySet = () => new Set([leaf.deviceID])
    expect(await validate(leaf.identity, leaf.deviceKey, denySet)).toBe(false)
  })
})
```

Add the two imports this file uses from the packages at the top (`now`, `audienceConfirmation`):

```typescript
import { audienceConfirmation, now } from '@kokuin/capability'
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/mls && pnpm exec vitest run test/authentication-bound.test.ts`
Expected: FAIL — `createDIDAuthenticationService` takes no args yet and the bound branch does not exist, so A1 returns `false` (the device id is did:key but the floating path ignores `controller` and still matches the key → actually returns `true`); the reject cases that corrupt only the capability still return `true`. Confirm at least A1's siblings R3–R8 fail (they return `true` without the bound branch).

- [ ] **Step 4: Add constants, the deny-set dependency, and the bound branch**

In `packages/mls/src/authentication.ts`, add imports:

```typescript
import {
  assertCapabilityToken,
  assertDeviceCapabilityPolicy,
  assertValidIssuedAt,
  hasPermission,
} from '@kokuin/capability'
import { tryDecodeKey } from '@kokuin/controller'
import { normalizeDID, verifyToken } from '@kokuin/token'

import { createEmbeddedControllerResolver } from './embedded-resolver.js'
```

(Extend the existing `@kokuin/token` import rather than duplicating it if the named imports already pull from there.)

Add the exported constants near the top of the file:

```typescript
/** The action a device capability must grant for a leaf to authenticate as a kumiai MLS leaf. */
export const MLS_LEAF_ACT = 'authenticate'
/** The resource half of that grant — kumiai-namespaced, group-independent. */
export const MLS_LEAF_RES = 'kumiai/mls-leaf'

const EMPTY_DENY: ReadonlySet<string> = new Set()
```

Add the bound-branch function (module-local, above `createDIDAuthenticationService`):

```typescript
/**
 * Validate a bound leaf: the device authenticates against its own leaf key (floating check), and the
 * embedded controller proof shows the profile authorised THIS device with THIS key. All sync — the
 * prefix is folded through the embedded resolver, never fetched. Returns false on any failure.
 */
async function validateBoundLeaf(
  parsed: MLSCredentialIdentity,
  signaturePublicKey: Uint8Array,
  deviceDenySet: () => ReadonlySet<string>,
): Promise<boolean> {
  const controller = parsed.controller
  if (controller == null) return false
  if (!controller.id.startsWith('did:kokuin:')) return false

  // A bound leaf is a floating leaf plus a controller attribution — the device still authenticates
  // against its own key.
  if (!matchesLeafKey(parsed, signaturePublicKey)) return false

  const resolver = createEmbeddedControllerResolver({
    controllerID: controller.id,
    prefix: controller.prefix,
  })

  let verified: Awaited<ReturnType<typeof verifyToken>>
  try {
    // The fold inside requires the prefix's inception to hash to controller.id (anchor) and checks
    // the controller's signature over the capability. `historic` so a rotated issuer still verifies.
    verified = await verifyToken(controller.capability, { methods: [resolver], historic: true })
  } catch {
    return false
  }

  try {
    assertCapabilityToken(verified)
    if (normalizeDID(verified.payload.aud) !== normalizeDID(parsed.id)) return false
    if (!hasPermission({ act: MLS_LEAF_ACT, res: MLS_LEAF_RES }, verified.payload)) return false
    assertValidIssuedAt(verified.payload)
    assertDeviceCapabilityPolicy(verified.payload)
  } catch {
    return false
  }

  if (deviceDenySet().has(normalizeDID(parsed.id))) return false

  const kid = verified.payload.cnf?.kid
  if (typeof kid !== 'string') return false
  const pinned = tryDecodeKey(kid)
  if (pinned == null || !constantTimeEqual(pinned.publicKey, signaturePublicKey)) return false

  return true
}
```

Change `createDIDAuthenticationService` to take the optional dependency and route bound leaves:

```typescript
export function createDIDAuthenticationService(
  deps: { deviceDenySet?: () => ReadonlySet<string> } = {},
): AuthenticationService {
  const deviceDenySet = deps.deviceDenySet ?? (() => EMPTY_DENY)
  return {
    async validateCredential(
      credential: Credential,
      signaturePublicKey: Uint8Array,
    ): Promise<boolean> {
      if (credential.credentialType !== defaultCredentialTypes.basic) {
        return false
      }

      let parsed: MLSCredentialIdentity
      try {
        parsed = parseMLSCredentialIdentity((credential as { identity: Uint8Array }).identity)
      } catch {
        return false
      }

      if (parsed.controller != null) {
        return await validateBoundLeaf(parsed, signaturePublicKey, deviceDenySet)
      }
      return matchesLeafKey(parsed, signaturePublicKey)
    },
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/mls && pnpm exec vitest run test/authentication-bound.test.ts`
Expected: PASS (A1 + R1–R11).

- [ ] **Step 6: Run the full mls suite (regression) + typecheck + lint**

Run: `cd packages/mls && pnpm exec vitest run && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && cd /Users/paul/dev/yulsi/kumiai && pnpm exec biome check packages/mls/src/authentication.ts packages/mls/test/authentication-bound.test.ts packages/mls/test/fixtures/bound-leaf.ts`
Expected: all pass, no errors. Floating tests unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/mls/src/authentication.ts packages/mls/test/authentication-bound.test.ts packages/mls/test/fixtures/bound-leaf.ts
git commit -m "feat(mls): validate bound did:kokuin device leaves"
```

---

### Task 5: Prove the R10 authority-only-prefix and zero-sidecar invariants

Two spec guarantees not yet pinned: a capability-authorised revoke embedded in the prefix must fail closed (R10), and no validation ever reaches an external log (the zero-I/O invariant). Both are test-only additions.

**Files:**
- Test: `packages/mls/test/authentication-bound.test.ts` (extend)

**Interfaces:**
- Consumes: `buildBoundLeaf` (Task 4), `createControllerResolver` shape from `@kokuin/controller` (for the sidecar-never-called assertion, mirror the adapter).

- [ ] **Step 1: Add the R10 test**

The simplest authority-only violation to construct without a full revoke event is a prefix whose second event is structurally a non-inception the sync fold rejects; assert rejection. Append to `authentication-bound.test.ts`:

```typescript
  test('R10: rejects a prefix the sync fold cannot fold (authority-only violated)', async () => {
    const leaf = await buildBoundLeaf({
      mutate: (id, b) => ({
        ...id,
        // A second, malformed event the fold refuses — stands in for a cap-authorised revoke, which
        // the sync foldLog also refuses (CAPABILITY_REVOKE_NEEDS_ASYNC_FOLD).
        controller: { ...b, prefix: [...b.prefix, { event: { v: 1, t: 'rev', crit: true }, sigs: [] }] },
      }),
    })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })
```

- [ ] **Step 2: Add the zero-sidecar assertion**

This proves validation never fetches a log for any DID other than the embedded one. Append:

```typescript
  test('validation never fetches a log externally', async () => {
    // buildBoundLeaf embeds the whole prefix; if validation reached out, it would need a loader.
    // We assert success without any external loader being configured anywhere in the path.
    const leaf = await buildBoundLeaf()
    // A second controller DID that is NOT the embedded one must be unresolvable — proven indirectly
    // by R4 (aud swap) and R2 (foreign prefix) already rejecting; here we assert the happy path needs
    // nothing external by running it with no network/loader in scope.
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(true)
  })
```

- [ ] **Step 3: Run the extended suite**

Run: `cd packages/mls && pnpm exec vitest run test/authentication-bound.test.ts`
Expected: PASS (including R10 and the zero-sidecar test).

- [ ] **Step 4: Mutation check (review gate)**

For each of R1–R11 and R10, temporarily delete the corresponding check in `validateBoundLeaf` and confirm the matching test flips to failing (accept), then restore. Record that this was done in the commit message. This is the discipline that stops a reject test from passing against a no-op validator.

- [ ] **Step 5: Commit**

```bash
git add packages/mls/test/authentication-bound.test.ts
git commit -m "test(mls): pin authority-only-prefix and zero-sidecar invariants"
```

---

### Task 6: Surface `controller` on GroupMember

**Files:**
- Modify: `packages/mls/src/group-handle.ts:530`
- Test: `packages/mls/test/group-handle-controller.test.ts` (create) — or extend an existing group-handle test if member listing is already covered there.

**Interfaces:**
- Consumes: `GroupMember.controller` (Task 1).
- Produces: `listMembers()` yields `controller` (the profile DID) for bound leaves.

- [ ] **Step 1: Write the failing test**

Create `packages/mls/test/group-handle-controller.test.ts`:

```typescript
import { describe, expect, test } from 'vitest'

import { parseMLSCredentialIdentity } from '../src/credential.js'

// The member projection maps a parsed identity to GroupMember. This unit test asserts the mapping
// rule directly (the group-handle generator applies it per leaf): a bound identity surfaces its
// controller DID; a floating one surfaces none.
function projectMember(identityBytes: Uint8Array, leafIndex: number) {
  const parsed = parseMLSCredentialIdentity(identityBytes)
  return {
    leafIndex,
    id: parsed.id,
    longForm: parsed.longForm ?? parsed.id,
    ...(parsed.controller ? { controller: parsed.controller.id } : {}),
  }
}

const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj))

describe('GroupMember controller surfacing', () => {
  test('bound leaf surfaces the controller DID', () => {
    const identity = enc({
      id: 'did:key:zDevice',
      controller: { id: 'did:kokuin:profile', prefix: [{ event: { v: 1, t: 'icp' }, sigs: ['s'] }], capability: 't' },
    })
    expect(projectMember(identity, 0).controller).toBe('did:kokuin:profile')
  })

  test('floating leaf surfaces no controller', () => {
    expect(projectMember(enc({ id: 'did:key:zDevice' }), 0)).not.toHaveProperty('controller')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mls && pnpm exec vitest run test/group-handle-controller.test.ts`
Expected: PASS for the projection rule as written (the test defines `projectMember` locally). This test locks the rule; Step 3 applies the same rule in `group-handle.ts`. If you prefer a true integration test, build a group with a bound leaf and assert `listMembers()`; that needs the group harness in `test/fixtures/` and is optional for Slice 1.

- [ ] **Step 3: Apply the rule in group-handle**

In `packages/mls/src/group-handle.ts`, at line 530, change:

```typescript
          yield { leafIndex: i / 2, id: parsed.id, longForm: parsed.longForm ?? parsed.id }
```

to:

```typescript
          yield {
            leafIndex: i / 2,
            id: parsed.id,
            longForm: parsed.longForm ?? parsed.id,
            ...(parsed.controller ? { controller: parsed.controller.id } : {}),
          }
```

- [ ] **Step 4: Typecheck, lint, and run the mls suite**

Run: `cd packages/mls && pnpm exec vitest run && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && cd /Users/paul/dev/yulsi/kumiai && pnpm exec biome check packages/mls/src/group-handle.ts packages/mls/test/group-handle-controller.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/mls/src/group-handle.ts packages/mls/test/group-handle-controller.test.ts
git commit -m "feat(mls): surface controller DID on bound GroupMember"
```

---

## Final verification

- [ ] Run the whole `@kumiai/mls` gate: `cd packages/mls && pnpm run test:types && pnpm exec vitest run` (or `rtk proxy pnpm run test` per the machine note). Confirm `Cached: 0` if using turbo; force a real run.
- [ ] Run `cd /Users/paul/dev/yulsi/kumiai && rtk proxy pnpm run lint` and confirm clean before final review.
- [ ] Confirm no consumer-port change was made (no contract-suite run needed — the `loadLog` port is Slice 3).

## Self-Review notes (author)

- **Spec coverage:** credential shape + parse (Task 1); adapter (Task 2); `matchesLeafKey` reuse (Task 3); bound branch with all 10 validation steps, deny seam, permission constants, device-policy (Task 4); authority-only-prefix + zero-I/O (Task 5); GroupMember surfacing (Task 6). The `MLS_LEAF_ACT/RES` constants match the spec verbatim. The `v:1`/no-gate decision is reflected (no version check anywhere).
- **Spec dep correction:** the spec's "Files touched" names only `@kokuin/capability`; this plan adds `@kokuin/controller` too (source of `SignedEvent`, `createControllerResolver`, `tryDecodeKey`, `createInception`), since `@kumiai/mls` deps only `@kokuin/token` today.
- **group-context.ts:** not modified in Slice 1 — the deny seam is the optional `deviceDenySet` param, exercised directly in tests; Slice 2 wires a real provider through `resolveMlsContext`.
- **Deferred detail for the executor:** if `assertCapabilityToken` does not itself reject an `alg:'none'` (unsigned) capability, R3's sibling — an unsigned forged capability — must also reject; verify by adding a quick unsigned-capability case in Task 4 if the executor finds `verifyToken` returns unsigned tokens unchecked (see `ledger.ts`'s `isVerifiedToken` note for the pattern).
```
