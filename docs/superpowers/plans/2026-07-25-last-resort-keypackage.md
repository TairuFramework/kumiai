# MLS Last-Resort Key Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks
**Spec:** `docs/superpowers/specs/2026-07-25-last-resort-keypackage-design.md`

**Goal:** Give every DID a reusable last-resort key package the hub serves without consuming, so a drained key-package pool can never leave a member unaddable to groups.

**Architecture:** `@kumiai/mls` gains a dedicated generator that stamps the `last_resort` extension onto a key package. The hub learns which package is last-resort from a client-supplied flag on upload — it never decodes MLS — and keeps it in a single replace-on-upload slot per DID, separate from the destructive ordinary pool. The fetch handler serves the slot non-destructively: it tops up a short response at most once, and when the per-target drain quota is spent it falls back to the slot alone, since consuming nothing charges nothing.

**Tech Stack:** TypeScript, `ts-mls` 2.0.0-rc.13, vitest, pnpm workspaces + turbo, biome, changesets.

## Global Constraints

- **pnpm only.** Never npm or yarn.
- **Never edit `lib/`** — it is generated output.
- Cross-repo deps (`@sozai/*`, `@kokuin/*`, `@enkaku/*`) go through the workspace catalog as published `^` ranges, never `workspace:`. Internal `@kumiai/*` deps are `workspace:^`.
- **An `rtk` shim intercepts `pnpm run <script>` and `pnpm exec biome`.** For real lint output run `rtk proxy pnpm run lint`. Test commands in this plan use `pnpm --filter <pkg> exec vitest run …`, which bypasses the shim.
- **`pnpm test` reports cached turbo results.** To actually re-run, use `pnpm exec turbo run test:types test:unit --force` and confirm the summary line says `Cached: 0`. (`pnpm test -- --force` does not work.)
- The `last_resort` extension is type `0x000A` from **draft-ietf-mls-extensions**, with zero-length extension data. It is *not* in RFC 9420. Do not write RFC 9420 in a comment.
- A last-resort package is the **only** key package a store may serve twice. Ordinary packages stay single-use — reuse of one is init-key reuse, which breaks forward secrecy.
- No path may return two copies of the same key package in one response.
- `hub-server` must gain no dependency on `ts-mls` or `@kumiai/mls`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/mls/src/group-credential.ts` | Add `LAST_RESORT_EXTENSION_TYPE` + `createLastResortKeyPackageBundle` | 1 |
| `packages/mls/src/group.ts`, `packages/mls/src/index.ts` | Re-export both | 1 |
| `packages/mls/test/last-resort-keypackage.test.ts` | New: extension shape, grease preservation, interop join | 1 |
| `packages/hub-protocol/src/types.ts` | Two new `HubStore` methods | 2 |
| `packages/hub-server/src/memoryStore.ts` | The single-slot map + both methods | 2 |
| `packages/hub-server/test/memoryStore.test.ts` | Slot unit tests | 2 |
| `packages/hub-conformance/src/index.ts` | Contract clauses for the slot | 3 |
| `packages/hub-protocol/src/protocol.ts` | `lastResort` upload param | 4 |
| `packages/hub-server/src/handlers.ts` | `AuthorizeRequest` field + upload routing | 4 |
| `packages/hub-server/src/handlers.ts` | Fetch top-up + quota fallback | 5 |
| `packages/hub-server/test/handlers.test.ts` | Upload (4) and fetch (5) handler tests | 4, 5 |
| `packages/hub-client/src/client.ts` | `uploadLastResortKeyPackage` | 6 |
| `packages/hub-client/test/client.test.ts` | Client round-trip | 6 |
| `.changeset/last-resort-keypackage.md` | Release note | 7 |

Tasks are ordered so the repo typechecks green after every one. Task 2 adds the port methods *and* their only implementation together, because splitting them would leave `memoryStore` failing to satisfy `HubStore`.

---

### Task 1: `@kumiai/mls` — generate a last-resort key package

**Files:**
- Modify: `packages/mls/src/group-credential.ts`
- Modify: `packages/mls/src/group.ts:16`
- Modify: `packages/mls/src/index.ts:66`
- Test: `packages/mls/test/last-resort-keypackage.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `LAST_RESORT_EXTENSION_TYPE: 0x000a` and
  `createLastResortKeyPackageBundle(identity: OwnIdentity, options?: GroupOptions): Promise<KeyPackageBundle>`,
  both exported from `@kumiai/mls`. No later task in this plan imports them — the hub never decodes MLS — but hosts do.

- [ ] **Step 1: Write the failing test**

Create `packages/mls/test/last-resort-keypackage.test.ts`:

```ts
import { randomIdentity } from '@kokuin/token'
import { greaseValues } from 'ts-mls'
import { describe, expect, test } from 'vitest'

import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  createLastResortKeyPackageBundle,
  LAST_RESORT_EXTENSION_TYPE,
  processWelcome,
} from '../src/group.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import type { Invite } from '../src/types.js'

describe('createLastResortKeyPackageBundle', () => {
  test('stamps the last_resort extension, carrying no data', async () => {
    const identity = randomIdentity()
    const bundle = await createLastResortKeyPackageBundle(identity)

    const extension = bundle.publicPackage.extensions.find(
      (ext) => ext.extensionType === LAST_RESORT_EXTENSION_TYPE,
    )
    expect(extension).toBeDefined()
    expect(extension?.extensionData).toEqual(new Uint8Array(0))
    expect(bundle.ownerDID).toBe(identity.id)
  })

  test('an ordinary bundle carries no last_resort extension', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    expect(
      bundle.publicPackage.extensions.some(
        (ext) => ext.extensionType === LAST_RESORT_EXTENSION_TYPE,
      ),
    ).toBe(false)
  })

  /**
   * Passing `extensions` at all suppresses ts-mls's own default of `greaseExtensions(...)`, so an
   * implementation that hands over a bare `[last_resort]` list silently drops the stack's GREASE.
   * Grease is probabilistic (0.1 per value over 15 values), so presence is asserted across a
   * sample: P(no grease in any of 30 packages) = 0.9^(15*30), which is not a flake risk.
   */
  test('keeps the GREASE extensions ts-mls would otherwise have added', async () => {
    const identity = randomIdentity()
    const seen = new Set<number>()
    for (let i = 0; i < 30; i++) {
      const bundle = await createLastResortKeyPackageBundle(identity)
      for (const ext of bundle.publicPackage.extensions) {
        if (ext.extensionType !== LAST_RESORT_EXTENSION_TYPE) seen.add(ext.extensionType)
      }
    }
    expect(seen.size).toBeGreaterThan(0)
    // Whatever showed up is grease and nothing else — no stray extension type leaked in.
    for (const type of seen) expect(greaseValues).toContain(type)
  })

  /**
   * The premise GREASE rests on, verified rather than assumed: a peer that has never heard of
   * extension 0x000A still adds the leaf to an anchored group. If this ever fails, the flag is
   * unusable and the hub-side plumbing has nothing safe to serve.
   */
  test('a peer that knows nothing about the extension still admits the member', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const tokens = new Map<string, string>()
    const publish = (invite: Invite) => {
      for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
    }
    const resolveLedgerEntries = async (ids: Array<string>) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error(`unknown ledger entry ${id}`)
        return token
      })

    const { group } = await createGroup(alice, 'group:last-resort', { resolveLedgerEntries })
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    publish(invite)

    const bundle = await createLastResortKeyPackageBundle(bob)
    const added = await commitInvite(group, bundle.publicPackage, invite)
    const { group: joined } = await processWelcome({
      identity: bob,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: added.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries },
    })

    expect(joined.findMemberLeafIndex(bob.id)).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kumiai/mls exec vitest run test/last-resort-keypackage.test.ts`
Expected: FAIL — `createLastResortKeyPackageBundle` and `LAST_RESORT_EXTENSION_TYPE` are not exported from `../src/group.js`.

- [ ] **Step 3: Write the implementation**

In `packages/mls/src/group-credential.ts`, widen the `ts-mls` import:

```ts
import {
  type Credential,
  defaultCredentialTypes,
  generateKeyPackageWithKey,
  greaseExtensions,
  makeCustomExtension,
} from 'ts-mls'
```

Then append to the same file:

```ts
/**
 * The `last_resort` KeyPackage extension from draft-ietf-mls-extensions (NOT RFC 9420, which has
 * no such extension). Its presence marks a key package as reusable by design; its data is empty.
 *
 * This is a KeyPackage extension, not a leaf-node one, so it needs no entry in the leaf's
 * capabilities and `controlCapabilities()` is unaffected.
 */
export const LAST_RESORT_EXTENSION_TYPE = 0x000a

/**
 * Generate a reusable last-resort key package for joining groups.
 *
 * A hub may serve this one repeatedly without consuming it, so the owner stays addable to a group
 * even after their ordinary single-use packages have been drained. Upload it through the hub's
 * last-resort slot, never through the ordinary pool.
 *
 * **The caller must retain `privatePackage` after processing a Welcome** rather than deleting it
 * as it would for an ordinary bundle: the same package can be handed to another inviter later.
 * `@kumiai/mls` never owns private packages — `processWelcome` takes the bundle as a parameter —
 * so nothing here can enforce that for you.
 */
export async function createLastResortKeyPackageBundle(
  identity: OwnIdentity,
  options?: GroupOptions,
): Promise<KeyPackageBundle> {
  const { cipherSuite } = await resolveMlsContext(options)
  const result = await generateKeyPackageWithKey({
    credential: makeMLSCredential(identity),
    signatureKeyPair: { signKey: identity.privateKey, publicKey: identity.publicKey },
    cipherSuite,
    // An invitee leaf must advertise the control extension types or ts-mls refuses to add it to an
    // anchored group. An explicit override still wins.
    capabilities: options?.capabilities ?? controlCapabilities(),
    // Supplying `extensions` at all suppresses ts-mls's own default of
    // `greaseExtensions(defaultGreaseConfig)`. `defaultGreaseConfig` is not exported, so its 0.1
    // probability is restated here — dropping the spread would silently cost the stack its GREASE.
    extensions: [
      ...greaseExtensions({ probabilityPerGreaseValue: 0.1 }),
      makeCustomExtension({
        extensionType: LAST_RESORT_EXTENSION_TYPE,
        extensionData: new Uint8Array(0),
      }),
    ],
  })
  return { ...result, ownerDID: identity.id }
}
```

In `packages/mls/src/group.ts:16`, replace the existing re-export line with:

```ts
export {
  createKeyPackageBundle,
  createLastResortKeyPackageBundle,
  LAST_RESORT_EXTENSION_TYPE,
  makeMLSCredential,
} from './group-credential.js'
```

In `packages/mls/src/index.ts`, add `createLastResortKeyPackageBundle,` and `LAST_RESORT_EXTENSION_TYPE,` to the same alphabetically-sorted export block that already contains `createKeyPackageBundle,` at line 66. Biome enforces the sort order; `LAST_RESORT_EXTENSION_TYPE` sorts among the `L` entries, not beside `createKeyPackageBundle`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @kumiai/mls exec vitest run test/last-resort-keypackage.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: no output (success).

Run: `rtk proxy pnpm run lint`
Expected: no errors. Fix any import-sort complaint it reports.

- [ ] **Step 6: Commit**

```bash
git add packages/mls/src/group-credential.ts packages/mls/src/group.ts packages/mls/src/index.ts packages/mls/test/last-resort-keypackage.test.ts
git commit -m "feat(mls): generate last-resort key packages"
```

---

### Task 2: `HubStore` port + `memoryStore` slot

**Files:**
- Modify: `packages/hub-protocol/src/types.ts:221-225`
- Modify: `packages/hub-server/src/memoryStore.ts:127` (map declaration) and `:491-496` (method block)
- Test: `packages/hub-server/test/memoryStore.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1. The hub never decodes MLS; a key package is an opaque `string` here.
- Produces, on `HubStore`:
  - `storeLastResortKeyPackage(ownerDID: string, keyPackage: string): Promise<void>`
  - `fetchLastResortKeyPackage(ownerDID: string): Promise<string | null>`

  Tasks 3, 4 and 5 all call these exact names. Absence is `null`, never `undefined`.

- [ ] **Step 1: Write the failing test**

Append to `packages/hub-server/test/memoryStore.test.ts` (it already defines `ALICE`; if the file's existing key-package tests use different constant names, follow those instead of introducing new ones):

```ts
test('the last-resort slot is served without being consumed', async () => {
  const store = createMemoryStore()
  await store.storeLastResortKeyPackage(ALICE, 'kp-lr')
  expect(await store.fetchLastResortKeyPackage(ALICE)).toBe('kp-lr')
  expect(await store.fetchLastResortKeyPackage(ALICE)).toBe('kp-lr')
})

test('an empty last-resort slot reads as null', async () => {
  const store = createMemoryStore()
  expect(await store.fetchLastResortKeyPackage(ALICE)).toBeNull()
})

test('a second last-resort upload replaces the first', async () => {
  const store = createMemoryStore()
  await store.storeLastResortKeyPackage(ALICE, 'kp-old')
  await store.storeLastResortKeyPackage(ALICE, 'kp-new')
  expect(await store.fetchLastResortKeyPackage(ALICE)).toBe('kp-new')
})

test('the last-resort slot is outside the per-DID key-package cap', async () => {
  const store = createMemoryStore({ maxKeyPackagesPerDID: 2 })
  await store.storeLastResortKeyPackage(ALICE, 'kp-lr')
  await store.storeKeyPackage(ALICE, 'kp-0')
  await store.storeKeyPackage(ALICE, 'kp-1')
  // The slot neither consumed cap headroom nor gained any from it.
  await expect(store.storeKeyPackage(ALICE, 'kp-2')).rejects.toThrow()
  expect(await store.fetchLastResortKeyPackage(ALICE)).toBe('kp-lr')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kumiai/hub-server exec vitest run test/memoryStore.test.ts`
Expected: FAIL — `store.storeLastResortKeyPackage is not a function`.

- [ ] **Step 3: Add the port methods**

In `packages/hub-protocol/src/types.ts`, inside the `HubStore` type, directly after the `fetchKeyPackages` line:

```ts
  /**
   * Store the owner's single last-resort key package, replacing any previous one.
   *
   * A last-resort package is marked reusable in MLS (`last_resort`,
   * draft-ietf-mls-extensions), which makes it the ONE key package a store may serve twice: it is
   * the floor that keeps an owner addable to a group after their ordinary pool has been drained.
   * One slot per owner, and it MUST NOT count against the per-owner cap `storeKeyPackage`
   * enforces — a full pool must never be able to block the floor.
   */
  storeLastResortKeyPackage(ownerDID: string, keyPackage: string): Promise<void>
  /** The owner's last-resort key package, or `null` when they have none. NEVER consumes: repeated
   * calls return the same package. */
  fetchLastResortKeyPackage(ownerDID: string): Promise<string | null>
```

- [ ] **Step 4: Implement in `memoryStore`**

In `packages/hub-server/src/memoryStore.ts`, beside the existing `const keyPackages = new Map<string, Array<string>>()` at line 127:

```ts
  /** One reusable package per DID, replaced on re-upload. Deliberately not in `keyPackages`: a
   * one-entry-per-DID map cannot grow, so it needs no quota, and charging it against
   * `maxKeyPackagesPerDID` would let a full pool block the availability floor. */
  const lastResortKeyPackages = new Map<string, string>()
```

Then, after the existing `fetchKeyPackages` method:

```ts
    async storeLastResortKeyPackage(ownerDID: string, keyPackage: string): Promise<void> {
      lastResortKeyPackages.set(ownerDID, keyPackage)
    },

    async fetchLastResortKeyPackage(ownerDID: string): Promise<string | null> {
      // No splice, ever. Reuse is the point here — this package is marked last-resort in MLS, so
      // serving it again is by design rather than the init-key reuse `fetchKeyPackages` avoids.
      return lastResortKeyPackages.get(ownerDID) ?? null
    },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @kumiai/hub-server exec vitest run test/memoryStore.test.ts`
Expected: PASS, including the four new tests.

Run: `pnpm --filter @kumiai/hub-protocol exec tsc --noEmit --skipLibCheck -p tsconfig.test.json && pnpm --filter @kumiai/hub-server exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: no output. If a *different* type fails to satisfy `HubStore`, stop — the spec assumed `memoryStore` is the only implementation, and a second one changes the task list.

- [ ] **Step 6: Commit**

```bash
git add packages/hub-protocol/src/types.ts packages/hub-server/src/memoryStore.ts packages/hub-server/test/memoryStore.test.ts
git commit -m "feat(hub): add a non-consuming last-resort key-package slot to HubStore"
```

---

### Task 3: `hub-conformance` clauses for the slot

**Files:**
- Modify: `packages/hub-conformance/src/index.ts` (after the key-package clauses ending at line ~916)

**Interfaces:**
- Consumes: `storeLastResortKeyPackage` / `fetchLastResortKeyPackage` from Task 2.
- Produces: nothing consumed by later tasks.

The suite runs against `createMemoryStore` via `packages/hub-server/test/conformance.test.ts`, which passes `maxKeyPackagesPerDID: 3`. There are no `HubStore` doubles in this repo — `memoryStore` is the only implementation — so "run both suites against the real implementation and the doubles" has no doubles half here. Note that in the commit message rather than skipping it silently.

- [ ] **Step 1: Write the failing clauses**

In `packages/hub-conformance/src/index.ts`, after the existing `fetchKeyPackages returns what it has when asked for more…` test and before the `if (maxKeyPackagesPerDID != null) {` block:

```ts
    /**
     * A LAST-RESORT PACKAGE IS THE ONE KEY PACKAGE A STORE MAY SERVE TWICE. It carries the
     * `last_resort` extension (draft-ietf-mls-extensions), which marks it reusable by design, so
     * the reuse the clause above forbids is here the entire point — it is the floor that keeps a
     * member addable after an attacker has drained their ordinary pool.
     *
     * A store that consumed it would reintroduce the outage this exists to prevent, and, like
     * single-use enforcement, nothing downstream is in a position to notice.
     */
    test('a last-resort key package is served without ever being consumed', async () => {
      const store = await createStore()
      await store.storeLastResortKeyPackage(ALICE, 'kp-last-resort')

      expect(await store.fetchLastResortKeyPackage(ALICE)).toBe('kp-last-resort')
      expect(await store.fetchLastResortKeyPackage(ALICE)).toBe('kp-last-resort')
    })

    test('an owner with no last-resort package reads as null, not undefined', async () => {
      const store = await createStore()
      expect(await store.fetchLastResortKeyPackage(BOB)).toBeNull()
    })

    test('a second last-resort upload replaces the first — the slot holds one', async () => {
      const store = await createStore()
      await store.storeLastResortKeyPackage(ALICE, 'kp-old')
      await store.storeLastResortKeyPackage(ALICE, 'kp-new')
      expect(await store.fetchLastResortKeyPackage(ALICE)).toBe('kp-new')
    })

    /** The slot must not become a back door that re-serves single-use packages. */
    test('an occupied last-resort slot does not make ordinary packages reusable', async () => {
      const store = await createStore()
      await store.storeLastResortKeyPackage(ALICE, 'kp-last-resort')
      await store.storeKeyPackage(ALICE, 'kp-ordinary')

      expect(await store.fetchKeyPackages(ALICE, 1)).toEqual(['kp-ordinary'])
      expect(await store.fetchKeyPackages(ALICE, 1)).toEqual([])
      // The two live in separate places: draining the pool left the slot untouched.
      expect(await store.fetchLastResortKeyPackage(ALICE)).toBe('kp-last-resort')
    })
```

And inside the existing `if (maxKeyPackagesPerDID != null) {` block, after the cap test already there:

```ts
      test('the last-resort slot is not charged against the per-DID cap', async () => {
        const store = await createStore()
        await store.storeLastResortKeyPackage(ALICE, 'kp-last-resort')
        // A full ordinary pool alongside an occupied slot: the slot bought no headroom and cost
        // none. A store that charged it would let a full pool block the floor.
        for (let i = 0; i < maxKeyPackagesPerDID; i++) {
          await store.storeKeyPackage(ALICE, `kp-${i}`)
        }
        await expect(store.storeKeyPackage(ALICE, 'kp-overflow')).rejects.toThrow(
          KeyPackageQuotaExceededError,
        )
        expect(await store.fetchLastResortKeyPackage(ALICE)).toBe('kp-last-resort')
      })
```

- [ ] **Step 2: Run the suite to verify the new clauses pass**

Run: `pnpm --filter @kumiai/hub-server exec vitest run test/conformance.test.ts`
Expected: PASS. The clauses pass immediately because Task 2 implemented them — that is fine here; the conformance suite is a contract, not a red-green driver.

- [ ] **Step 3: Prove each clause bites**

For each of the five clauses, break the implementation, confirm the clause fails, then restore it. A clause that passes against a broken store is not a contract.

1. In `memoryStore.ts`, make `fetchLastResortKeyPackage` consume: `const kp = lastResortKeyPackages.get(ownerDID) ?? null; lastResortKeyPackages.delete(ownerDID); return kp`.
   Run the suite. Expected: the *served without ever being consumed* clause FAILS. Restore.
2. Make it return `undefined` instead of `null` (`return lastResortKeyPackages.get(ownerDID)`, with the return type widened locally).
   Expected: the *null, not undefined* clause FAILS. Restore.
3. Make `storeLastResortKeyPackage` a no-op when a value is already present.
   Expected: the *replaces the first* clause FAILS. Restore.
4. Make `fetchKeyPackages` fall back to the slot in place of consuming (`return [lastResortKeyPackages.get(ownerDID)]` when the pool is non-empty).
   Expected: the *does not make ordinary packages reusable* clause FAILS. Restore.
5. Make `storeLastResortKeyPackage` also `packages.push(keyPackage)` into the ordinary pool.
   Expected: the *not charged against the per-DID cap* clause FAILS. Restore.

Run after each: `pnpm --filter @kumiai/hub-server exec vitest run test/conformance.test.ts`

- [ ] **Step 4: Confirm the store is fully restored**

Run: `git diff packages/hub-server/src/memoryStore.ts`
Expected: no output — every mutation from Step 3 is reverted.

Run: `pnpm --filter @kumiai/hub-server exec vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub-conformance/src/index.ts
git commit -m "test(hub-conformance): contract clauses for the last-resort key-package slot

memoryStore is the only HubStore implementation, so there are no doubles to
run the suite against. Each clause was verified to fail against a store
mutated to break it."
```

---

### Task 4: upload wire flag and handler routing

**Files:**
- Modify: `packages/hub-protocol/src/protocol.ts:174-198`
- Modify: `packages/hub-server/src/handlers.ts:40` (`AuthorizeRequest`) and `:559-585` (upload handler)
- Test: `packages/hub-server/test/handlers.test.ts`

**Interfaces:**
- Consumes: `storeLastResortKeyPackage` from Task 2.
- Produces: the wire param `{ keyPackages: [kp], lastResort: true }` on `hub/v1/keypackage/upload`, which Task 6's client method sends verbatim. `AuthorizeRequest` for `keypackage/upload` gains `lastResort?: boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/hub-server/test/handlers.test.ts`:

```ts
describe('last-resort key package upload', () => {
  test('a last-resort upload lands in the slot, not the ordinary pool', async () => {
    const { store, handlers } = setup()
    const result = await (handlers['hub/v1/keypackage/upload'] as any)(
      reqCtx('hub/v1/keypackage/upload', { keyPackages: ['kp-lr'], lastResort: true }, TARGET),
    )
    expect(result.stored).toBe(1)
    expect(await store.fetchLastResortKeyPackage(TARGET)).toBe('kp-lr')
    // Nothing leaked into the destructive pool.
    expect(await store.fetchKeyPackages(TARGET, 1)).toEqual([])
  })

  test('an upload without the flag still goes to the ordinary pool', async () => {
    const { store, handlers } = setup()
    await (handlers['hub/v1/keypackage/upload'] as any)(
      reqCtx('hub/v1/keypackage/upload', { keyPackages: ['kp-0', 'kp-1'] }, TARGET),
    )
    expect(await store.fetchLastResortKeyPackage(TARGET)).toBeNull()
    expect(await store.fetchKeyPackages(TARGET, 2)).toEqual(['kp-0', 'kp-1'])
  })

  test('a last-resort upload carrying more than one package is refused', async () => {
    const { store, handlers } = setup()
    await expect(
      (handlers['hub/v1/keypackage/upload'] as any)(
        reqCtx('hub/v1/keypackage/upload', { keyPackages: ['a', 'b'], lastResort: true }, TARGET),
      ),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.invalidPayload })
    // Refused whole: neither package was stored anywhere.
    expect(await store.fetchLastResortKeyPackage(TARGET)).toBeNull()
    expect(await store.fetchKeyPackages(TARGET, 2)).toEqual([])
  })

  test('the authorize hook sees the flag, so a host can refuse the slot alone', async () => {
    const seen: Array<AuthorizeRequest> = []
    const { store, handlers } = setup({
      authorize: (req) => {
        seen.push(req)
        return !(req.action === 'keypackage/upload' && req.lastResort === true)
      },
    })
    await expect(
      (handlers['hub/v1/keypackage/upload'] as any)(
        reqCtx('hub/v1/keypackage/upload', { keyPackages: ['kp-lr'], lastResort: true }, TARGET),
      ),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.authorizationDenied })
    expect(seen[0]).toMatchObject({ action: 'keypackage/upload', lastResort: true, count: 1 })

    // The same hook lets an ordinary upload through — the refusal was specific to the slot.
    await (handlers['hub/v1/keypackage/upload'] as any)(
      reqCtx('hub/v1/keypackage/upload', { keyPackages: ['kp-0'] }, TARGET),
    )
    expect(await store.fetchKeyPackages(TARGET, 1)).toEqual(['kp-0'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @kumiai/hub-server exec vitest run test/handlers.test.ts -t 'last-resort key package upload'`
Expected: FAIL — the flag is ignored, so the package lands in the ordinary pool and `fetchLastResortKeyPackage` returns `null`.

- [ ] **Step 3: Add the wire flag**

In `packages/hub-protocol/src/protocol.ts`, inside the `hub/v1/keypackage/upload` param `properties`, after `keyPackages`:

```ts
        /**
         * Route this upload to the owner's single reusable last-resort slot instead of the
         * destructive pool. The hub stores opaque blobs and cannot tell a `last_resort`-marked
         * package from an ordinary one, so it takes the uploader's word for it: mislabelling an
         * ordinary package is init-key reuse, but only against the uploader's own DID.
         *
         * Requires `keyPackages` to hold exactly one entry — the slot holds one.
         */
        lastResort: { type: 'boolean' },
```

Leave `required: ['keyPackages']` and `additionalProperties: false` as they are.

- [ ] **Step 4: Widen `AuthorizeRequest`**

In `packages/hub-server/src/handlers.ts`, replace line 40:

```ts
  | { action: 'keypackage/upload'; did: string; count: number; lastResort?: boolean }
```

- [ ] **Step 5: Route the upload**

Replace the body of the `'hub/v1/keypackage/upload'` handler with:

```ts
    'hub/v1/keypackage/upload': (async (ctx) => {
      const { keyPackages, lastResort } = ctx.param
      const clientDID = getClientDID(ctx)
      // The slot holds one package, so a flagged upload carries exactly one. JSON Schema cannot
      // express a conditional on a sibling field, so the arity is enforced here.
      let lastResortPackage: string | null = null
      if (lastResort === true) {
        const [only, ...rest] = keyPackages
        if (only == null || rest.length > 0) {
          throw new HandlerError({
            code: HUB_ERROR_CODES.invalidPayload,
            message: 'A last-resort upload must carry exactly one key package',
          })
        }
        lastResortPackage = only
      }
      const decision = normalizeAuthorizeDecision(
        await authorize({
          action: 'keypackage/upload',
          did: clientDID,
          count: keyPackages.length,
          // Spread, not assignment: `lastResort: undefined` would make an ordinary upload look
          // like one that explicitly opted out.
          ...(lastResort === true ? { lastResort: true } : {}),
        }),
      )
      if (!decision.allow) {
        throw new HandlerError({
          code: HUB_ERROR_CODES.authorizationDenied,
          message: decision.reason ?? 'Not authorized to upload key packages',
        })
      }
      if (!didLimiter.tryConsume(clientDID)) {
        throw new HandlerError({
          code: 'EK01',
          message: 'Key package upload rate limit exceeded for DID',
        })
      }
      // A batch crossing the cap partially commits (the store enforces per-call, so the cap still
      // holds) and rejects the rest with HUB_KEYPACKAGE_QUOTA; a retry finds the earlier ones stored.
      // The last-resort path has no cap to cross: the slot is one entry, replaced in place.
      try {
        if (lastResortPackage != null) {
          await store.storeLastResortKeyPackage(clientDID, lastResortPackage)
        } else {
          await Promise.all(keyPackages.map((kp: string) => store.storeKeyPackage(clientDID, kp)))
        }
      } catch (error) {
        rethrowAsHandlerError(error)
      }
      return { stored: keyPackages.length }
    }) as RequestHandler<HubProtocol, 'hub/v1/keypackage/upload'>,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @kumiai/hub-server exec vitest run test/handlers.test.ts`
Expected: PASS, all describes including the pre-existing ones.

Run: `pnpm --filter @kumiai/hub-protocol exec vitest run && pnpm --filter @kumiai/hub-server exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: PASS, then no output.

- [ ] **Step 7: Commit**

```bash
git add packages/hub-protocol/src/protocol.ts packages/hub-server/src/handlers.ts packages/hub-server/test/handlers.test.ts
git commit -m "feat(hub): route flagged uploads to the last-resort slot"
```

---

### Task 5: fetch top-up and quota fallback

**Files:**
- Modify: `packages/hub-server/src/handlers.ts:587-616` (the `hub/v1/keypackage/fetch` handler)
- Test: `packages/hub-server/test/handlers.test.ts`

**Interfaces:**
- Consumes: `fetchLastResortKeyPackage` from Task 2, and the populated slot from Task 4.
- Produces: no new symbols. The observable change is the `keyPackages` array a fetch returns.

- [ ] **Step 1: Write the failing tests**

Append to `packages/hub-server/test/handlers.test.ts`:

```ts
describe('last-resort key package fetch', () => {
  test('the slot tops up a short response, exactly once', async () => {
    const { store, handlers } = setup()
    await store.storeKeyPackage(TARGET, 'kp-0')
    await store.storeLastResortKeyPackage(TARGET, 'kp-lr')

    const result = await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 5 }),
    )
    // Short of the 5 asked for, and padded by ONE copy — never to `count`. Two Adds sharing one
    // init key in a single commit is the reuse this feature must not introduce.
    expect(result.keyPackages).toEqual(['kp-0', 'kp-lr'])

    const second = await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 5 }),
    )
    expect(second.keyPackages).toEqual(['kp-lr'])
  })

  test('a response that already satisfies count is not topped up', async () => {
    const { store, handlers } = setup()
    await store.storeKeyPackage(TARGET, 'kp-0')
    await store.storeLastResortKeyPackage(TARGET, 'kp-lr')

    const result = await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }),
    )
    expect(result.keyPackages).toEqual(['kp-0'])
  })

  test('a target with no slot is unchanged: a short response stays short', async () => {
    const { store, handlers } = setup()
    await store.storeKeyPackage(TARGET, 'kp-0')
    const result = await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 5 }),
    )
    expect(result.keyPackages).toEqual(['kp-0'])
  })

  test('a spent per-target drain budget still yields the last-resort package', async () => {
    const { store, handlers } = setup({
      keyPackageFetchLimits: { maxPerTargetConsumed: 1, maxRequests: 1000 },
    })
    await store.storeKeyPackage(TARGET, 'kp-0')
    await store.storeKeyPackage(TARGET, 'kp-1')
    await store.storeLastResortKeyPackage(TARGET, 'kp-lr')

    await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }),
    )
    // Budget spent. Serving the slot consumes nothing, so it charges nothing — this is the whole
    // point of the feature: the drain bound must not sit on top of the availability floor.
    const result = await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }),
    )
    expect(result.keyPackages).toEqual(['kp-lr'])
    // And the quota still did its job: the second ordinary package was NOT drained.
    expect(await store.fetchKeyPackages(TARGET, 1)).toEqual(['kp-1'])
  })

  test('a spent budget is still refused when the target has no last-resort package', async () => {
    const { store, handlers } = setup({
      keyPackageFetchLimits: { maxPerTargetConsumed: 1, maxRequests: 1000 },
    })
    await store.storeKeyPackage(TARGET, 'kp-0')
    await store.storeKeyPackage(TARGET, 'kp-1')

    await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }),
    )
    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }),
      ),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.keyPackageFetchLimit })
  })

  test('the per-requester rate limit is not bypassed by a last-resort package', async () => {
    const { store, handlers } = setup({ keyPackageFetchLimits: { maxRequests: 1 } })
    await store.storeLastResortKeyPackage(TARGET, 'kp-lr')

    await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }),
    )
    // The requester's own budget is a separate bound and the slot must not be a way around it,
    // or one requester could hammer the hub for free.
    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }),
      ),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.keyPackageFetchLimit })
  })

  test('an authorize refusal is not bypassed by a last-resort package', async () => {
    const { store, handlers } = setup({ authorize: (req) => req.action !== 'keypackage/fetch' })
    await store.storeLastResortKeyPackage(TARGET, 'kp-lr')
    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }),
      ),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.authorizationDenied })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @kumiai/hub-server exec vitest run test/handlers.test.ts -t 'last-resort key package fetch'`
Expected: FAIL — the top-up cases return only the ordinary packages, and the spent-budget case rejects with `HUB_KEYPACKAGE_FETCH_LIMIT`.

- [ ] **Step 3: Rewrite the fetch tail**

In `packages/hub-server/src/handlers.ts`, replace everything from the `// Order matters:` comment through `return { keyPackages }` inside the `hub/v1/keypackage/fetch` handler with:

```ts
      // Order matters: a refusal above never charged a window; per-requester before per-target so a
      // throttled requester doesn't charge the target. rethrow maps KeyPackageFetchLimitError (no
      // `code` of its own) to its wire code.
      try {
        assertKeyPackageFetchAllowed(requesterDID)
      } catch (error) {
        rethrowAsHandlerError(error)
      }
      let targetBudgetSpent = false
      try {
        assertTargetConsumptionAllowed(targetDID, cappedCount)
      } catch (error) {
        if (!(error instanceof KeyPackageFetchLimitError)) rethrowAsHandlerError(error)
        targetBudgetSpent = true
      }
      if (targetBudgetSpent) {
        // The drain budget bounds CONSUMPTION, and serving the slot consumes nothing — so a spent
        // budget refuses the pool while the reusable floor still answers. A target with no slot is
        // refused exactly as before.
        const lastResort = await store.fetchLastResortKeyPackage(targetDID)
        if (lastResort == null) {
          throw new HandlerError({
            code: HUB_ERROR_CODES.keyPackageFetchLimit,
            message: `Key package consumption limit exceeded for target ${targetDID}`,
          })
        }
        return { keyPackages: [lastResort] }
      }
      const consumed = await store.fetchKeyPackages(targetDID, cappedCount)
      if (consumed.length >= cappedCount) return { keyPackages: consumed }
      const lastResort = await store.fetchLastResortKeyPackage(targetDID)
      // Appended AT MOST ONCE, never padded out to `cappedCount`: handing one caller two copies of
      // one init key is the reuse the whole design avoids.
      return { keyPackages: lastResort == null ? consumed : [...consumed, lastResort] }
```

`KeyPackageFetchLimitError` is already imported at `handlers.ts:12`. Do not mutate the array `fetchKeyPackages` returns — a different store implementation may hand back a frozen one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @kumiai/hub-server exec vitest run`
Expected: PASS, whole package. The pre-existing quota tests in `per-target-DID key-package consumption quota` must still pass unchanged — none of those targets has a slot.

- [ ] **Step 5: Commit**

```bash
git add packages/hub-server/src/handlers.ts packages/hub-server/test/handlers.test.ts
git commit -m "feat(hub): serve the last-resort slot on short fetches and spent drain budgets"
```

---

### Task 6: `hub-client` upload method

**Files:**
- Modify: `packages/hub-client/src/client.ts:120-130`
- Test: `packages/hub-client/test/client.test.ts`

**Interfaces:**
- Consumes: the `lastResort` wire param from Task 4.
- Produces: `uploadLastResortKeyPackage(keyPackage: string): RequestCall<{ stored: number }>` on the hub client.

- [ ] **Step 1: Write the failing test**

Append inside the same `describe` that holds `uploadKeyPackages and fetchKeyPackages` in `packages/hub-client/test/client.test.ts`:

```ts
  test('uploadLastResortKeyPackage stores a package that outlives being fetched', async () => {
    const testHub = createTestHub()
    const { client, identity, transports } = createTestClient(testHub)

    const result = await client.uploadLastResortKeyPackage('kp-lr')
    expect(result.stored).toBe(1)

    // The ordinary pool is empty, yet a fetch still yields a package — and again after that.
    expect((await client.fetchKeyPackages(identity.id, 1)).keyPackages).toEqual(['kp-lr'])
    expect((await client.fetchKeyPackages(identity.id, 1)).keyPackages).toEqual(['kp-lr'])

    await transports.dispose()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kumiai/hub-client exec vitest run test/client.test.ts`
Expected: FAIL — `client.uploadLastResortKeyPackage is not a function`.

- [ ] **Step 3: Add the method**

In `packages/hub-client/src/client.ts`, directly after `uploadKeyPackages`:

```ts
  /**
   * Upload the caller's single reusable last-resort key package, replacing any previous one. The
   * hub serves it without consuming it once the ordinary pool runs dry, so the caller stays
   * addable to a group. Generate it with `createLastResortKeyPackageBundle` from `@kumiai/mls` —
   * an ordinary package sent here would be handed out twice, which is init-key reuse.
   */
  uploadLastResortKeyPackage(keyPackage: string): RequestCall<{ stored: number }> {
    return this.#client.request('hub/v1/keypackage/upload', {
      param: { keyPackages: [keyPackage], lastResort: true },
    })
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kumiai/hub-client exec vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub-client/src/client.ts packages/hub-client/test/client.test.ts
git commit -m "feat(hub-client): add uploadLastResortKeyPackage"
```

---

### Task 7: changeset and whole-branch verification

**Files:**
- Create: `.changeset/last-resort-keypackage.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the changeset**

Create `.changeset/last-resort-keypackage.md`:

```markdown
---
'@kumiai/hub-conformance': minor
'@kumiai/hub-protocol': minor
'@kumiai/hub-server': minor
'@kumiai/hub-client': minor
'@kumiai/mls': minor
---

MLS last-resort key packages, so a drained pool can no longer strand a member.

The key-package drain was already rate-bounded, but an authorized attacker
staying within quota could still empty a victim's pool, after which the victim
could not be added to any group until they re-uploaded.

`@kumiai/mls` gains `createLastResortKeyPackageBundle`, which stamps the
`last_resort` extension (type `0x000A`, draft-ietf-mls-extensions) onto a key
package, marking it reusable by design. Hosts must retain its private package
after a Welcome rather than deleting it as they would an ordinary one.

The hub learns which package is last-resort from a `lastResort` flag on
`hub/v1/keypackage/upload` — it never decodes MLS. `HubStore` gains
`storeLastResortKeyPackage` and `fetchLastResortKeyPackage`, backing a single
replace-on-upload slot per DID that sits outside the per-DID storage cap and is
never consumed. A fetch serves ordinary packages first and appends the slot at
most once; when the per-target drain budget is spent it falls back to the slot
alone, since serving it consumes nothing and so charges nothing.

`hub-client` gains `uploadLastResortKeyPackage`.
```

- [ ] **Step 2: Run the whole test suite, uncached**

Run: `pnpm exec turbo run test:types test:unit --force`
Expected: all tasks successful, and the summary line reads `Cached: 0`. A run reporting cached results proves nothing — re-run with `--force` if it does.

- [ ] **Step 3: Lint**

Run: `rtk proxy pnpm run lint`
Expected: no errors.

- [ ] **Step 4: Confirm the layering held**

Run: `grep -n "ts-mls\|@kumiai/mls" packages/hub-server/package.json packages/hub-protocol/package.json`
Expected: no matches. The hub must still treat key packages as opaque blobs.

- [ ] **Step 5: Commit**

```bash
git add .changeset/last-resort-keypackage.md
git commit -m "chore: changeset for last-resort key packages"
```

---

## Verification checklist

Before moving the plan to `reviewing`:

- [ ] A DID whose ordinary pool is empty can still be fetched a usable key package.
- [ ] A DID whose per-target consumption window is spent can still be fetched its last-resort package.
- [ ] No ordinary key package is ever returned by two fetches.
- [ ] No single fetch response contains two copies of the same key package.
- [ ] `hub-server` has no dependency on `ts-mls` or `@kumiai/mls`.
- [ ] Neither the per-requester rate limit nor the authorize hook can be bypassed via the slot.
- [ ] `pnpm exec turbo run test:types test:unit --force` is green with `Cached: 0`.
