# Ordinary key-package pool replenishment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks
**Spec:** `docs/superpowers/specs/2026-07-27-ordinary-keypackage-replenishment-design.md`
**Branch:** `feat/ordinary-keypackage-pool`

**Goal:** Let a host keep its ordinary key-package pool stocked, so new members stop being served a
reused last-resort init key.

**Architecture:** An upload carries an optional expiry the hub honours, so dead entries stop holding
the per-DID cap; a new self-scoped `hub/v1/keypackage/status` reports the caller's own live depth and
a digest of their own last-resort slot; and `@kumiai/mls-hub` gains a pool that tops up against that
depth, plus a Welcome wrapper that drops a single-use private half on use.

**Tech Stack:** TypeScript ESM, vitest, enkaku protocol/client/transport, ts-mls, turbo, changesets.

## Global Constraints

- pnpm only. Never edit `lib/` — it is generated.
- Cross-repo deps (`@sozai/*`, `@kokuin/*`, `@enkaku/*`) go through the workspace catalog as published
  `^` ranges, never `workspace:`. Internal `@kumiai/*` deps are `workspace:^`.
- `@kumiai/mls-hub` MUST NOT depend on `ts-mls` — every MLS wire form is reached through
  `@kumiai/mls`. `@kumiai/mls` MUST NOT depend on `@kumiai/hub-client`.
- `@kumiai/hub-protocol` gains **no new package dependency** in this work. The digest is hex over
  Web Crypto, not base64url, precisely so `@sozai/codec` need not be added to the protocol package
  for an opaque value nobody parses. (Spec deviation, recorded there.)
- Every `additionalProperties: false` in `hubProtocol` stays sealed. New surface is a new procedure,
  never a widened existing result.
- Run tests as `pnpm exec vitest run <path>` from inside the package, never `pnpm run test` — an
  `rtk` shim intercepts `pnpm run` and redirects it.
- Pair every vitest step with the package's `test:types`. vitest strips types, so a green vitest run
  proves nothing about the types in code written from this plan.
- A test double may be stricter than its port, never more permissive.

---

### Task 1: Pin the ordinary key-package lifetime

**Files:**
- Modify: `packages/mls/src/group-credential.ts`
- Modify: `packages/mls/src/index.ts`
- Test: `packages/mls/test/ordinary-keypackage-lifetime.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `ORDINARY_KEY_PACKAGE_LIFETIME_DAYS: number` (value `30`) exported from `@kumiai/mls`.
  `createKeyPackageBundle(identity, options?)` keeps its signature and starts emitting a pinned
  lifetime.

**Context:** `buildBundle` today omits `lifetime` for the ordinary path so ts-mls's unexported
`defaultLifetime()` (~15 days) applies. The pool's refresh cadence is built on that number, so it
must not live in a dependency's private default. `lastResortLifetime()` at
`packages/mls/src/group-credential.ts:105` is the pattern to copy, including the one-day back-date.

- [ ] **Step 1: Write the failing test**

Create `packages/mls/test/ordinary-keypackage-lifetime.test.ts`:

```ts
import {
  createKeyPackageBundle,
  ORDINARY_KEY_PACKAGE_LIFETIME_DAYS,
} from '@kumiai/mls'
import { randomIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

describe('ordinary key package lifetime', () => {
  test('is pinned here rather than inherited from ts-mls', () => {
    expect(ORDINARY_KEY_PACKAGE_LIFETIME_DAYS).toBe(30)
  })

  test('createKeyPackageBundle stamps the pinned lifetime, in SECONDS', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    const lifetime = bundle.publicPackage.leafNode.lifetime

    // Pinned in seconds and at the real magnitude. A milliseconds regression here would make every
    // minted package look decades-fresh, the pool would never refresh, and every other test in the
    // suite would stay green — the exact failure shape the last-resort branch hit on `notAfter`.
    const nowSeconds = Math.floor(Date.now() / 1000)
    const expectedNotAfter = nowSeconds + ORDINARY_KEY_PACKAGE_LIFETIME_DAYS * 86_400
    expect(Number(lifetime.notAfter)).toBeGreaterThan(expectedNotAfter - 3600)
    expect(Number(lifetime.notAfter)).toBeLessThan(expectedNotAfter + 3600)

    // Back-dated a day, so a peer with a slow clock cannot reject a package minted seconds ago.
    expect(Number(lifetime.notBefore)).toBeGreaterThan(nowSeconds - 86_400 - 3600)
    expect(Number(lifetime.notBefore)).toBeLessThan(nowSeconds - 86_400 + 3600)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd packages/mls && pnpm exec vitest run test/ordinary-keypackage-lifetime.test.ts
```

Expected: FAIL — `ORDINARY_KEY_PACKAGE_LIFETIME_DAYS` is not exported, and `notBefore` is whatever
ts-mls chose.

- [ ] **Step 3: Implement**

In `packages/mls/src/group-credential.ts`, beside `LAST_RESORT_LIFETIME_DAYS`:

```ts
/**
 * How long an ordinary, single-use key package stays valid, in days.
 *
 * Pinned here rather than left to ts-mls's unexported `defaultLifetime()` (~15 days): the top-up
 * cadence `@kumiai/mls-hub`'s pool is built around is this number, and a dependency's private
 * default can move under a patch bump. 30 sits well under the 4-month `maximumTotalLifetime` ts-mls
 * declares, and makes a weekly top-up comfortable rather than marginal.
 */
export const ORDINARY_KEY_PACKAGE_LIFETIME_DAYS = 30

/** Back-dated a day, as ts-mls's own default is, so peer clock skew cannot invalidate a fresh package. */
function ordinaryLifetime(): Lifetime {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return {
    notBefore: BigInt(nowSeconds - 86_400),
    notAfter: BigInt(nowSeconds + ORDINARY_KEY_PACKAGE_LIFETIME_DAYS * 86_400),
  }
}
```

Change `createKeyPackageBundle` to pass it:

```ts
export async function createKeyPackageBundle(
  identity: OwnIdentity,
  options?: GroupOptions,
): Promise<KeyPackageBundle> {
  return buildBundle(identity, options, { lifetime: ordinaryLifetime() })
}
```

Leave `buildBundle`'s doc comment accurate: the "left genuinely absent for the ordinary path"
sentence now applies to `extensions` only. Update it to say so.

Export the constant from `packages/mls/src/index.ts`, in the existing alphabetical block (between
`makeMLSCredential` and `type ProcessWelcomeOnceParams`, matching the block's ordering).

- [ ] **Step 4: Run the test and the type check**

```bash
cd packages/mls && pnpm exec vitest run test/ordinary-keypackage-lifetime.test.ts && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

Expected: PASS, then no type output.

- [ ] **Step 5: Run the package's whole suite**

```bash
cd packages/mls && pnpm exec vitest run
```

Expected: PASS. `last-resort-keypackage.test.ts` and `group.test.ts` both mint ordinary packages; if
either asserted on the old ~15-day default, fix the assertion to use the constant rather than
loosening it.

- [ ] **Step 6: Commit**

```bash
git add packages/mls/src/group-credential.ts packages/mls/src/index.ts packages/mls/test/ordinary-keypackage-lifetime.test.ts
git commit -m "feat(mls): pin the ordinary key package lifetime at 30 days"
```

---

### Task 2: `welcomeKeyPackageRefs`

**Files:**
- Create: `packages/mls/src/welcome-refs.ts`
- Modify: `packages/mls/src/index.ts`
- Test: `packages/mls/test/welcome-keypackage-refs.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `welcomeKeyPackageRefs(welcome: Uint8Array | unknown): Array<string>` exported from
  `@kumiai/mls`. Returns base64 refs under the same `toB64` encoding `keyPackageRef` uses, so the two
  are directly comparable.

**Context:** ts-mls exports `type Welcome` and `type EncryptedGroupSecrets` from its index
(`dist/src/index.d.ts:53`); `EncryptedGroupSecrets.newMember: Uint8Array` is the KeyPackageRef, and
`Welcome.secrets` is an array of them (verified in `dist/src/welcome.d.ts:9`). The
`Uint8Array | unknown` param and the framed-vs-decoded branch mirror `ProcessWelcomeParams.welcome`
(`packages/mls/src/group-welcome.ts:31`) — same input, so same shape.

- [ ] **Step 1: Write the failing test**

Create `packages/mls/test/welcome-keypackage-refs.test.ts`:

```ts
import { randomIdentity } from '@kokuin/token'
import {
  createGroup,
  createInvite,
  createKeyPackageBundle,
  commitInvite,
  keyPackageRef,
  welcomeKeyPackageRefs,
} from '@kumiai/mls'
import { describe, expect, test } from 'vitest'

describe('welcomeKeyPackageRefs', () => {
  test('names the ref of the package the Welcome was built for', async () => {
    const creator = randomIdentity()
    const invitee = randomIdentity()
    const group = await createGroup({ identity: creator })
    const bundle = await createKeyPackageBundle(invitee)
    const invite = await createInvite({
      group: group.group,
      identity: creator,
      recipient: invitee.id,
      keyPackage: bundle.publicPackage,
    })
    const committed = await commitInvite({ group: group.group, identity: creator, invite })

    const refs = welcomeKeyPackageRefs(committed.welcome)

    expect(refs).toEqual([await keyPackageRef(bundle.publicPackage)])
  })

  test('rejects bytes that are not a framed Welcome', () => {
    expect(() => welcomeKeyPackageRefs(new Uint8Array([1, 2, 3]))).toThrow(
      /expected a framed MLSMessage\(Welcome\)/,
    )
  })

  test('rejects an object that is not a Welcome', () => {
    expect(() => welcomeKeyPackageRefs({ nope: true })).toThrow(/not a Welcome/)
  })
})
```

**Before running:** the exact names and shapes of `createGroup` / `createInvite` / `commitInvite` and
where the Welcome lands on the commit result are NOT assumed here — open
`packages/mls/test/last-resort-keypackage.test.ts` and copy the working invite-and-commit sequence it
already uses, then adapt. Do not invent a call shape.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd packages/mls && pnpm exec vitest run test/welcome-keypackage-refs.test.ts
```

Expected: FAIL — `welcomeKeyPackageRefs` is not exported.

- [ ] **Step 3: Implement**

Create `packages/mls/src/welcome-refs.ts`:

```ts
import { toB64 } from '@sozai/codec'
import { decode, mlsMessageDecoder, type Welcome, wireformats } from 'ts-mls'

/**
 * The KeyPackageRefs a Welcome names, base64 — one per set of encrypted group secrets it carries.
 *
 * Same encoding as {@link keyPackageRef}, so a holder of several retained bundles can pick the one
 * this Welcome is for by comparison instead of trying each until one decrypts.
 *
 * Accepts framed `MLSMessage(Welcome)` bytes or a pre-decoded ts-mls Welcome, exactly as
 * `processWelcome` does — the same value reaches both.
 */
export function welcomeKeyPackageRefs(welcome: Uint8Array | unknown): Array<string> {
  let resolved: unknown = welcome
  if (welcome instanceof Uint8Array) {
    const decoded = decode(mlsMessageDecoder, welcome)
    if (decoded == null || decoded.wireformat !== wireformats.mls_welcome) {
      throw new Error('welcomeKeyPackageRefs: expected a framed MLSMessage(Welcome)')
    }
    resolved = decoded.welcome
  }
  const secrets = (resolved as Welcome | undefined)?.secrets
  if (!Array.isArray(secrets)) {
    throw new Error('welcomeKeyPackageRefs: not a Welcome')
  }
  return secrets.map((secret) => toB64(secret.newMember))
}
```

Export `welcomeKeyPackageRefs` from `packages/mls/src/index.ts` in the alphabetically correct place.

- [ ] **Step 4: Run the test and the type check**

```bash
cd packages/mls && pnpm exec vitest run test/welcome-keypackage-refs.test.ts && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

Expected: PASS, then no type output.

- [ ] **Step 5: Commit**

```bash
git add packages/mls/src/welcome-refs.ts packages/mls/src/index.ts packages/mls/test/welcome-keypackage-refs.test.ts
git commit -m "feat(mls): read the key package refs a Welcome names"
```

---

### Task 3: Protocol — `notAfter`, `keypackage/status`, `keyPackageDigest`

**Files:**
- Create: `packages/hub-protocol/src/digest.ts`
- Modify: `packages/hub-protocol/src/protocol.ts`
- Modify: `packages/hub-protocol/src/types.ts`
- Modify: `packages/hub-protocol/src/index.ts`
- Test: `packages/hub-protocol/test/digest.test.ts` (create)
- Test: `packages/hub-protocol/test/protocol.test.ts` (modify)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `keyPackageDigest(stored: string): Promise<string>` — SHA-256 over the string's UTF-8 bytes,
    lowercase hex, 64 characters.
  - `hubProtocol['hub/v1/keypackage/upload'].param.properties.notAfter` — `{ type: 'integer',
    minimum: 0 }`, optional.
  - `hubProtocol['hub/v1/keypackage/status']` — request, param `{}` sealed, result
    `{ count: integer, lastResort: string | null }`, both required.
  - `HubStore.storeKeyPackage(ownerDID: string, keyPackage: string, notAfter?: number): Promise<void>`
  - `HubStore.countKeyPackages(ownerDID: string): Promise<number>`

**Context:** `type: ['string', 'null']` is already used in this file (`protocol.ts:24`, `expectedHead`)
so the schema layer accepts it. The status param is an empty sealed object on purpose: there is no
`did` field to authorize, so the query cannot become a reconnaissance channel telling an attacker
when a drain succeeded.

- [ ] **Step 1: Write the failing digest test**

Create `packages/hub-protocol/test/digest.test.ts`:

```ts
import { keyPackageDigest } from '@kumiai/hub-protocol'
import { describe, expect, test } from 'vitest'

describe('keyPackageDigest', () => {
  // Pinned against a fixed vector, not against a second call to itself: client and server compare
  // digests across a wire, so the definition has to be a constant, not whatever the code does today.
  test('is lowercase hex SHA-256 of the string UTF-8 bytes', async () => {
    expect(await keyPackageDigest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  test('distinguishes two stored packages', async () => {
    expect(await keyPackageDigest('kp-a')).not.toBe(await keyPackageDigest('kp-b'))
  })

  test('is 64 hex characters', async () => {
    expect(await keyPackageDigest('kp')).toMatch(/^[0-9a-f]{64}$/)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd packages/hub-protocol && pnpm exec vitest run test/digest.test.ts
```

Expected: FAIL — `keyPackageDigest` is not exported.

- [ ] **Step 3: Implement the digest**

Create `packages/hub-protocol/src/digest.ts`:

```ts
/**
 * The digest `hub/v1/keypackage/status` reports for the caller's own last-resort slot: SHA-256 over
 * the stored string's UTF-8 bytes, lowercase hex.
 *
 * Lives here rather than in each `HubStore` so no implementation can drift from the definition, and
 * so a client comparing its own retained record against the hub's is comparing the same function.
 *
 * Hex rather than base64url only to keep `@kumiai/hub-protocol` free of a codec dependency for a
 * value nobody parses.
 */
export async function keyPackageDigest(stored: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stored))
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
```

Export it from `packages/hub-protocol/src/index.ts`:

```ts
export { keyPackageDigest } from './digest.js'
```

- [ ] **Step 4: Run the digest test**

```bash
cd packages/hub-protocol && pnpm exec vitest run test/digest.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing protocol test**

Append to `packages/hub-protocol/test/protocol.test.ts` (follow the assertion style already in the
file — read it first and match how it reaches into `hubProtocol`):

```ts
describe('hub/v1/keypackage/status', () => {
  test('takes no parameters, so there is no DID to authorize', () => {
    const param = hubProtocol['hub/v1/keypackage/status'].param
    expect(param.properties).toEqual({})
    expect(param.additionalProperties).toBe(false)
  })

  test('reports a live count and a nullable last-resort digest', () => {
    const result = hubProtocol['hub/v1/keypackage/status'].result
    expect(result.properties.count).toEqual({ type: 'integer' })
    expect(result.properties.lastResort).toEqual({ type: ['string', 'null'] })
    expect(result.required).toEqual(['count', 'lastResort'])
  })
})

describe('hub/v1/keypackage/upload', () => {
  test('accepts an optional batch expiry', () => {
    const param = hubProtocol['hub/v1/keypackage/upload'].param
    expect(param.properties.notAfter).toEqual({ type: 'integer', minimum: 0 })
    expect(param.required).toEqual(['keyPackages'])
  })
})
```

- [ ] **Step 6: Run it and confirm it fails**

```bash
cd packages/hub-protocol && pnpm exec vitest run test/protocol.test.ts
```

Expected: FAIL — no `status` procedure, no `notAfter` property.

- [ ] **Step 7: Implement the protocol changes**

In `packages/hub-protocol/src/protocol.ts`, add to the `upload` param properties:

```ts
        /**
         * When every package in this batch expires, in seconds. Absent means "no expiry known":
         * the entries never expire, exactly as before this field existed.
         *
         * The hub stores opaque blobs and cannot read an MLS lifetime, so it takes the uploader's
         * word — the same trust `lastResort` above already asks for, and misstating it only harms
         * the uploader's own DID: too early evicts your own live packages, too late keeps your own
         * dead ones holding your own cap.
         *
         * One value for the batch, because a batch is minted together and shares a lifetime.
         * Meaningless for `lastResort`, whose staleness is handled by rotation, so sending both is
         * rejected.
         */
        notAfter: { type: 'integer', minimum: 0 },
```

Add the new procedure after `hub/v1/keypackage/fetch`:

```ts
  'hub/v1/keypackage/status': {
    type: 'request',
    description: "The caller's own key-package inventory",
    param: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: {
        /** Live entries in the caller's ordinary pool: expired ones are not counted. */
        count: { type: 'integer' },
        /** `keyPackageDigest` of the caller's stored last-resort package, or `null` for an empty
         * slot. A digest rather than a boolean so a hub holding some OTHER package is
         * distinguishable from one holding the right one. */
        lastResort: { type: ['string', 'null'] },
      },
      required: ['count', 'lastResort'],
      additionalProperties: false,
    },
  },
```

There is deliberately no `did` parameter: the answer is always about the session's own DID, so the
query cannot be pointed at anyone else.

In `packages/hub-protocol/src/types.ts`, update `HubStore`:

```ts
  /**
   * Store one key package for later retrieval.
   *
   * A store MAY cap per-owner storage and reject an upload past its cap with
   * `KeyPackageQuotaExceededError` (rejected, never evicted).
   *
   * `notAfter` is when the package expires, in seconds. A store MUST NOT serve an entry past its
   * `notAfter` from `fetchKeyPackages`, MUST NOT count it in `countKeyPackages`, and MUST NOT let it
   * charge the per-owner cap. An entry stored without a `notAfter` never expires.
   *
   * Without that rule a pool fills with dead entries that hold the cap against every future upload,
   * and the owner can never replenish again; FIFO consumption also serves the nearest-expiry entry
   * first, which the inviter then rejects when it builds the Add.
   */
  storeKeyPackage(ownerDID: string, keyPackage: string, notAfter?: number): Promise<void>
  fetchKeyPackages(ownerDID: string, count?: number): Promise<Array<string>>
  /** How many live key packages the owner has. Expired entries are not counted. */
  countKeyPackages(ownerDID: string): Promise<number>
```

- [ ] **Step 8: Run the tests and the type check**

```bash
cd packages/hub-protocol && pnpm exec vitest run && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

Expected: PASS, then no type output. `hub-server` will not typecheck yet — that is Task 5.

- [ ] **Step 9: Commit**

```bash
git add packages/hub-protocol
git commit -m "feat(hub-protocol): key package expiry, a self-scoped status query, and a slot digest"
```

---

### Task 4: Conformance clauses for expiry and counting

**Files:**
- Modify: `packages/hub-conformance/src/index.ts`

**Interfaces:**
- Consumes: `HubStore.storeKeyPackage(ownerDID, keyPackage, notAfter?)` and
  `HubStore.countKeyPackages(ownerDID)` from Task 3.
- Produces: clauses every `HubStore` implementation must satisfy. No new export.

**Context:** The existing key-package clauses live near `packages/hub-conformance/src/index.ts:869`.
Read them first and match their voice — each clause's name states the rule, and the comment states
which plausible wrong implementation it catches. These clauses are red against today's `memoryStore`;
Task 5 turns them green. That is the point of the ordering.

- [ ] **Step 1: Add the clauses**

Insert after the existing `fetchKeyPackages` clauses:

```ts
    test('an expired key package is never served', async () => {
      const store = await createStore()
      const past = Math.floor(Date.now() / 1000) - 60
      const future = Math.floor(Date.now() / 1000) + 3600
      await store.storeKeyPackage(ALICE, 'kp-dead', past)
      await store.storeKeyPackage(ALICE, 'kp-live', future)

      // FIFO would hand out the dead one first, and the inviter would reject it when it built the
      // Add — a failure the fetcher cannot diagnose and the owner cannot see.
      expect(await store.fetchKeyPackages(ALICE, 2)).toEqual(['kp-live'])
    })

    test('a key package stored without an expiry never expires', async () => {
      const store = await createStore()
      await store.storeKeyPackage(ALICE, 'kp-forever')

      expect(await store.countKeyPackages(ALICE)).toBe(1)
      expect(await store.fetchKeyPackages(ALICE, 1)).toEqual(['kp-forever'])
    })

    test('countKeyPackages counts live entries only, per owner', async () => {
      const store = await createStore()
      const past = Math.floor(Date.now() / 1000) - 60
      const future = Math.floor(Date.now() / 1000) + 3600
      await store.storeKeyPackage(ALICE, 'kp-dead', past)
      await store.storeKeyPackage(ALICE, 'kp-live', future)
      await store.storeKeyPackage(BOB, 'kp-bob', future)

      expect(await store.countKeyPackages(ALICE)).toBe(1)
      expect(await store.countKeyPackages(BOB)).toBe(1)
      expect(await store.countKeyPackages(CAROL)).toBe(0)
    })

    test('countKeyPackages does not consume', async () => {
      const store = await createStore()
      await store.storeKeyPackage(ALICE, 'kp-1')

      expect(await store.countKeyPackages(ALICE)).toBe(1)
      expect(await store.countKeyPackages(ALICE)).toBe(1)
      expect(await store.fetchKeyPackages(ALICE, 1)).toEqual(['kp-1'])
    })
```

Then, inside the block guarded by `maxKeyPackagesPerDID` (find the existing quota clause and add
beside it):

```ts
      test('an expired key package does not charge the per-owner cap', async () => {
        const store = await createStore()
        const past = Math.floor(Date.now() / 1000) - 60
        const future = Math.floor(Date.now() / 1000) + 3600
        for (let index = 0; index < maxKeyPackagesPerDID; index++) {
          await store.storeKeyPackage(ALICE, `kp-dead-${index}`, past)
        }

        // Without this, a host that tops up on a schedule fills its cap with dead entries and can
        // never upload again — the pool is permanently wedged and the owner has no way to see it.
        await expect(store.storeKeyPackage(ALICE, 'kp-live', future)).resolves.toBeUndefined()
        expect(await store.countKeyPackages(ALICE)).toBe(1)
      })
```

- [ ] **Step 2: Run the suite and confirm the new clauses fail**

```bash
cd packages/hub-server && pnpm exec vitest run test/conformance.test.ts
```

Expected: FAIL on the five new clauses — `store.countKeyPackages is not a function`, and the expiry
clauses serving `kp-dead`. Every pre-existing clause still passes.

- [ ] **Step 3: Commit**

```bash
git add packages/hub-conformance/src/index.ts
git commit -m "test(hub-conformance): clauses for key package expiry and live counting"
```

---

### Task 5: Hub server — expiry-aware store and the status handler

**Files:**
- Modify: `packages/hub-server/src/memoryStore.ts`
- Modify: `packages/hub-server/src/handlers.ts`
- Test: `packages/hub-server/test/memoryStore.test.ts`
- Test: `packages/hub-server/test/handlers.test.ts`

**Interfaces:**
- Consumes: `keyPackageDigest`, the `status` procedure, and the widened `HubStore` from Task 3; the
  conformance clauses from Task 4.
- Produces: a `hub/v1/keypackage/status` handler; `AuthorizeRequest` gains
  `{ action: 'keypackage/status'; did: string }`.

**Context:** `memoryStore` holds ordinary packages as `Map<string, Array<string>>`
(`memoryStore.ts:127`) and consumes with `splice` (`:499`). The entries become
`{ keyPackage: string; notAfter?: number }`. The cap check at `:487` must count live entries only.
The `lastResort` map is untouched — expiry does not apply to the slot, and a hub refusing to serve it
on its own clock would deny the availability floor over clock skew.

- [ ] **Step 1: Write the failing handler test**

Add to `packages/hub-server/test/handlers.test.ts` — read the file's existing setup helpers and reuse
them rather than building a new hub:

```ts
describe('hub/v1/keypackage/status', () => {
  test('answers for the caller, counting live packages only', async () => {
    // Uses whatever authenticated-client helper this file already uses for keypackage/upload tests.
    const future = Math.floor(Date.now() / 1000) + 3600
    const past = Math.floor(Date.now() / 1000) - 60
    await store.storeKeyPackage(clientDID, 'kp-live', future)
    await store.storeKeyPackage(clientDID, 'kp-dead', past)
    await store.storeKeyPackage('did:key:someone-else', 'kp-other', future)

    const result = await client.keyPackageStatus()

    expect(result.count).toBe(1)
    expect(result.lastResort).toBeNull()
  })

  test('reports the digest of the caller own last-resort package', async () => {
    await store.storeLastResortKeyPackage(clientDID, 'kp-last-resort')

    const result = await client.keyPackageStatus()

    expect(result.lastResort).toBe(await keyPackageDigest('kp-last-resort'))
  })

  test('consults the authorize hook and can be refused', async () => {
    // Build a hub whose authorize hook denies `keypackage/status`, exactly as the existing
    // upload-refusal test in this file does for `keypackage/upload`.
    await expect(deniedClient.keyPackageStatus()).rejects.toThrow(/Not authorized/)
  })
})

describe('hub/v1/keypackage/upload notAfter', () => {
  test('carries the batch expiry into the store', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600
    await client.uploadKeyPackages(['kp-a'], future)

    expect(await store.countKeyPackages(clientDID)).toBe(1)
  })

  test('rejects an expiry on a last-resort upload', async () => {
    await expect(
      rawClient.request('hub/v1/keypackage/upload', {
        param: { keyPackages: ['kp'], lastResort: true, notAfter: 1 },
      }),
    ).rejects.toThrow(/last-resort upload carries no expiry/)
  })
})
```

`client.keyPackageStatus()` and the second `uploadKeyPackages` argument do not exist until Task 6 —
for this task, drive the procedures through the raw enkaku client the file already has, and switch to
the `HubClient` methods in Task 6. Do NOT skip the assertions to avoid that.

- [ ] **Step 2: Run and confirm it fails**

```bash
cd packages/hub-server && pnpm exec vitest run test/handlers.test.ts
```

Expected: FAIL — no status handler, `notAfter` unhandled.

- [ ] **Step 3: Make the memory store expiry-aware**

In `packages/hub-server/src/memoryStore.ts`, change the pool's element type and the three methods:

```ts
type StoredKeyPackage = { keyPackage: string; notAfter?: number }

const keyPackages = new Map<string, Array<StoredKeyPackage>>()

function isLive(entry: StoredKeyPackage, nowSeconds: number): boolean {
  return entry.notAfter == null || entry.notAfter > nowSeconds
}
```

```ts
    async storeKeyPackage(ownerDID: string, keyPackage: string, notAfter?: number): Promise<void> {
      let packages = keyPackages.get(ownerDID)
      if (packages == null) {
        packages = []
        keyPackages.set(ownerDID, packages)
      }
      // Drop the dead before charging the cap, or a pool that filled with expired entries could
      // never be replenished: the cap rejects rather than evicts, by design, so nothing else would
      // ever remove them.
      const nowSeconds = Math.floor(Date.now() / 1000)
      const live = packages.filter((entry) => isLive(entry, nowSeconds))
      if (live.length !== packages.length) {
        packages.length = 0
        packages.push(...live)
      }
      if (packages.length >= maxKeyPackagesPerDID) {
        throw new KeyPackageQuotaExceededError(
          `DID ${ownerDID} exceeds the maximum of ${maxKeyPackagesPerDID} stored key packages`,
        )
      }
      packages.push({ keyPackage, ...(notAfter != null ? { notAfter } : {}) })
    },

    async fetchKeyPackages(ownerDID: string, count?: number): Promise<Array<string>> {
      const packages = keyPackages.get(ownerDID)
      if (packages == null || packages.length === 0) return []
      const nowSeconds = Math.floor(Date.now() / 1000)
      const served: Array<string> = []
      const n = count ?? 1
      // One pass, consuming as it goes: an expired entry is dropped rather than served, so FIFO
      // stops handing out the nearest-expiry package first.
      let index = 0
      while (index < packages.length && served.length < n) {
        const entry = packages[index] as StoredKeyPackage
        packages.splice(index, 1)
        if (isLive(entry, nowSeconds)) served.push(entry.keyPackage)
      }
      return served
    },

    async countKeyPackages(ownerDID: string): Promise<number> {
      const packages = keyPackages.get(ownerDID)
      if (packages == null) return 0
      const nowSeconds = Math.floor(Date.now() / 1000)
      return packages.filter((entry) => isLive(entry, nowSeconds)).length
    },
```

Note `fetchKeyPackages` drops expired entries it walks past — it does not merely skip them. Skipping
would leave them holding the cap forever.

- [ ] **Step 4: Add the handler**

In `packages/hub-server/src/handlers.ts`, extend the `AuthorizeRequest` union:

```ts
  | { action: 'keypackage/status'; did: string }
```

Extend the upload handler's validation, beside the existing arity check:

```ts
      const { keyPackages, lastResort, notAfter } = ctx.param
      ...
      if (lastResort === true && notAfter != null) {
        throw new HandlerError({
          code: HUB_ERROR_CODES.invalidPayload,
          message: 'A last-resort upload carries no expiry: the slot is kept fresh by rotation',
        })
      }
```

and thread it into the ordinary path:

```ts
          await Promise.all(
            keyPackages.map((kp: string) => store.storeKeyPackage(clientDID, kp, notAfter)),
          )
```

Add the status handler after `hub/v1/keypackage/fetch`:

```ts
    'hub/v1/keypackage/status': (async (ctx) => {
      // No `did` parameter exists, so this answers only for the authenticated caller. That is the
      // whole authorization story: a query that could name someone else would tell an attacker
      // exactly when a drain against that DID had succeeded.
      const clientDID = getClientDID(ctx)
      const decision = normalizeAuthorizeDecision(
        await authorize({ action: 'keypackage/status', did: clientDID }),
      )
      if (!decision.allow) {
        throw new HandlerError({
          code: HUB_ERROR_CODES.authorizationDenied,
          message: decision.reason ?? 'Not authorized to read key package status',
        })
      }
      if (!didLimiter.tryConsume(clientDID)) {
        throw new HandlerError({
          code: 'EK01',
          message: 'Key package status rate limit exceeded for DID',
        })
      }
      let count: number
      let stored: string | null
      try {
        count = await store.countKeyPackages(clientDID)
        stored = await store.fetchLastResortKeyPackage(clientDID)
      } catch (error) {
        rethrowAsHandlerError(error)
      }
      return { count, lastResort: stored == null ? null : await keyPackageDigest(stored) }
    }) as RequestHandler<HubProtocol, 'hub/v1/keypackage/status'>,
```

Import `keyPackageDigest` from `@kumiai/hub-protocol` at the top of the file.

- [ ] **Step 5: Add memory-store unit tests**

Add to `packages/hub-server/test/memoryStore.test.ts`, matching the file's existing style:

```ts
test('fetchKeyPackages removes an expired entry rather than skipping it', async () => {
  const store = createMemoryStore({ maxKeyPackagesPerDID: 2 })
  const past = Math.floor(Date.now() / 1000) - 60
  const future = Math.floor(Date.now() / 1000) + 3600
  await store.storeKeyPackage('did:key:a', 'kp-dead', past)
  await store.storeKeyPackage('did:key:a', 'kp-live', future)

  expect(await store.fetchKeyPackages('did:key:a', 1)).toEqual(['kp-live'])
  // The dead entry is gone, not lingering to charge the cap.
  await store.storeKeyPackage('did:key:a', 'kp-new', future)
  await store.storeKeyPackage('did:key:a', 'kp-newer', future)
  expect(await store.countKeyPackages('did:key:a')).toBe(2)
})
```

- [ ] **Step 6: Run everything in the package plus the type check**

```bash
cd packages/hub-server && pnpm exec vitest run && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

Expected: PASS — including the five conformance clauses from Task 4, which were red and are now
green.

- [ ] **Step 7: Commit**

```bash
git add packages/hub-server
git commit -m "feat(hub-server): honour key package expiry and serve a self-scoped status query"
```

---

### Task 6: `HubClient.keyPackageStatus`

**Files:**
- Modify: `packages/hub-client/src/client.ts`
- Test: `packages/hub-client/test/client.test.ts`

**Interfaces:**
- Consumes: the `status` procedure and `notAfter` from Task 3.
- Produces:
  - `uploadKeyPackages(keyPackages: Array<string>, notAfter?: number): RequestCall<{ stored: number }>`
  - `keyPackageStatus(): RequestCall<{ count: number; lastResort: string | null }>`

- [ ] **Step 1: Write the failing test**

Add to `packages/hub-client/test/client.test.ts`, reusing the file's existing hub fixture:

```ts
test('keyPackageStatus reports the caller own live depth and slot digest', async () => {
  const future = Math.floor(Date.now() / 1000) + 3600
  await client.uploadKeyPackages(['kp-1', 'kp-2'], future)
  await client.uploadLastResortKeyPackage('kp-last-resort')

  const status = await client.keyPackageStatus()

  expect(status.count).toBe(2)
  expect(status.lastResort).toBe(await keyPackageDigest('kp-last-resort'))
})

test('an upload without an expiry stays countable', async () => {
  await client.uploadKeyPackages(['kp-forever'])

  expect((await client.keyPackageStatus()).count).toBe(1)
})
```

- [ ] **Step 2: Run and confirm it fails**

```bash
cd packages/hub-client && pnpm exec vitest run test/client.test.ts
```

Expected: FAIL — `client.keyPackageStatus is not a function`.

- [ ] **Step 3: Implement**

In `packages/hub-client/src/client.ts`:

```ts
  /**
   * Upload single-use key packages to the caller's ordinary pool.
   *
   * `notAfter` is when every package in this batch expires, in seconds — take it from the minted
   * package's own MLS lifetime. Omit it and the hub keeps the entries forever, which means a pool
   * that has gone stale still holds the per-DID cap against every future upload. `@kumiai/mls-hub`'s
   * key package pool passes it for you.
   */
  uploadKeyPackages(keyPackages: Array<string>, notAfter?: number): RequestCall<{ stored: number }> {
    return this.#client.request('hub/v1/keypackage/upload', {
      param: { keyPackages, notAfter },
    })
  }

  /**
   * The caller's own key-package inventory: live pool depth, and a digest of the last-resort slot
   * (`null` when empty).
   *
   * Answers only for the authenticated caller — there is no way to ask about another DID, because a
   * query that could would report exactly when a drain against that DID had succeeded.
   *
   * The digest is `keyPackageDigest` from `@kumiai/hub-protocol` over the stored string. Compare it
   * against a digest of your own retained package to catch a hub that lost the slot or is holding
   * something else.
   */
  keyPackageStatus(): RequestCall<{ count: number; lastResort: string | null }> {
    return this.#client.request('hub/v1/keypackage/status', { param: {} })
  }
```

- [ ] **Step 4: Run the tests and the type check**

```bash
cd packages/hub-client && pnpm exec vitest run && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

Expected: PASS, then no type output.

- [ ] **Step 5: Commit**

```bash
git add packages/hub-client
git commit -m "feat(hub-client): key package status and batch expiry on upload"
```

---

### Task 7: Shared record mechanics, and the pool store port

**Files:**
- Create: `packages/mls-hub/src/records.ts`
- Create: `packages/mls-hub/src/pool-store.ts`
- Modify: `packages/mls-hub/src/store.ts`
- Modify: `packages/mls-hub/src/provisioner.ts`
- Modify: `packages/mls-hub/src/index.ts`
- Test: `packages/mls-hub/test/pool-store.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type KeyPackageRecord = { ref: string; keyPackage: string; privatePackage: string; notAfter: number }`
  - `type KeyPackagePoolStore = { list(ownerDID): Promise<Array<KeyPackageRecord>>; put(ownerDID, record): Promise<void>; delete(ownerDID, ref): Promise<void> }`
  - `createMemoryKeyPackagePoolStore(): KeyPackagePoolStore`
  - Internal only, NOT exported from `src/index.ts`:
    `createMemoryRecordStore<R extends StoredRecord>(): { list; put; delete }` and
    `toBundles<R extends StoredRecord>(records: Array<R>, ownerDID: string, label: string): Array<KeyPackageBundle>`

**Context:** The two ports stay separate public types — `KeyPackagePoolStore` is not a
generalization of the shipped `LastResortStore`, and neither imports the other. Only the *mechanics*
are shared, through an unexported `src/records.ts`: the owner-scoped non-aliasing memory map, and the
sort-decode-or-throw that turns records into bundles. `LastResortRecord` and `KeyPackageRecord`
differ by one field — **there is no `uploadedAt` on the pool record**, because an ordinary pool upload
appends rather than replaces, so a pending record can never be safely resumed and nothing needs to
track whether it was uploaded.

`toBundles`'s throw message must stay byte-identical to the one `provisioner.bundles()` raises today
for `label` `'last-resort'` — an existing test asserts on it.

- [ ] **Step 1: Write the failing test**

Create `packages/mls-hub/test/pool-store.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import { createMemoryKeyPackagePoolStore, type KeyPackageRecord } from '../src/pool-store.js'

const ALICE = 'did:key:alice'
const BOB = 'did:key:bob'

function record(ref: string): KeyPackageRecord {
  return { ref, keyPackage: `kp-${ref}`, privatePackage: `priv-${ref}`, notAfter: 100 }
}

describe('createMemoryKeyPackagePoolStore', () => {
  test('list is scoped to the owner', async () => {
    const store = createMemoryKeyPackagePoolStore()
    await store.put(ALICE, record('a'))
    await store.put(BOB, record('b'))

    expect((await store.list(ALICE)).map((entry) => entry.ref)).toEqual(['a'])
    expect((await store.list(BOB)).map((entry) => entry.ref)).toEqual(['b'])
  })

  test('put replaces by ref rather than appending', async () => {
    const store = createMemoryKeyPackagePoolStore()
    await store.put(ALICE, record('a'))
    await store.put(ALICE, { ...record('a'), notAfter: 200 })

    const records = await store.list(ALICE)
    expect(records).toHaveLength(1)
    expect(records[0]?.notAfter).toBe(200)
  })

  test('delete is scoped to the owner and no-ops for an unknown ref', async () => {
    const store = createMemoryKeyPackagePoolStore()
    await store.put(ALICE, record('a'))

    await store.delete(BOB, 'a')
    expect(await store.list(ALICE)).toHaveLength(1)

    await expect(store.delete(ALICE, 'missing')).resolves.toBeUndefined()
    await store.delete(ALICE, 'a')
    expect(await store.list(ALICE)).toHaveLength(0)
  })

  test('list does not alias the store own state', async () => {
    const store = createMemoryKeyPackagePoolStore()
    await store.put(ALICE, record('a'))

    const records = await store.list(ALICE)
    // Mutating what a caller was handed must not reach back into the store — this holds SECRET key
    // material, and a shared reference makes one caller's edit everyone's.
    ;(records[0] as KeyPackageRecord).privatePackage = 'tampered'

    expect((await store.list(ALICE))[0]?.privatePackage).toBe('priv-a')
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

```bash
cd packages/mls-hub && pnpm exec vitest run test/pool-store.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Extract the shared mechanics**

Create `packages/mls-hub/src/records.ts` — internal, never exported from `src/index.ts`:

```ts
import {
  decodeKeyPackage,
  decodePrivateKeyPackage,
  type KeyPackageBundle,
} from '@kumiai/mls'

/** What both retained-record shapes have in common. */
export type StoredRecord = {
  ref: string
  keyPackage: string
  privatePackage: string
  notAfter: number
}

/**
 * The owner-scoped, replace-by-`ref`, non-aliasing map both in-memory reference stores are.
 *
 * Shared mechanics only: `LastResortStore` and `KeyPackagePoolStore` remain separate public ports,
 * because their records and their lifecycles differ.
 */
export function createMemoryRecordStore<R extends StoredRecord>(): {
  list(ownerDID: string): Promise<Array<R>>
  put(ownerDID: string, record: R): Promise<void>
  delete(ownerDID: string, ref: string): Promise<void>
} {
  const byOwner = new Map<string, Map<string, R>>()
  return {
    async list(ownerDID: string): Promise<Array<R>> {
      const records = byOwner.get(ownerDID)
      return records == null ? [] : [...records.values()].map((record) => ({ ...record }))
    },
    async put(ownerDID: string, record: R): Promise<void> {
      let records = byOwner.get(ownerDID)
      if (records == null) {
        records = new Map()
        byOwner.set(ownerDID, records)
      }
      records.set(record.ref, { ...record })
    },
    async delete(ownerDID: string, ref: string): Promise<void> {
      byOwner.get(ownerDID)?.delete(ref)
    },
  }
}

/**
 * Retained records as bundles, `notAfter` descending with `ref` breaking a tie.
 *
 * Throws on a record that does not round-trip rather than skipping it: narrowing a corrupt store to
 * "you appear to have fewer packages" recreates the silent failure this whole area removes. Names
 * the ref, never the material.
 */
export function toBundles<R extends StoredRecord>(
  records: Array<R>,
  ownerDID: string,
  label: string,
): Array<KeyPackageBundle> {
  const ordered = [...records].sort((a, b) => {
    if (a.notAfter !== b.notAfter) return b.notAfter - a.notAfter
    return a.ref < b.ref ? 1 : a.ref > b.ref ? -1 : 0
  })
  return ordered.map((record) => {
    const publicPackage = decodeKeyPackage(record.keyPackage)
    const privatePackage = decodePrivateKeyPackage(record.privatePackage)
    if (publicPackage == null || privatePackage == null) {
      throw new Error(
        `mls-hub: stored ${label} record ${record.ref} did not decode; its stored form is not a round-trip of what this codec writes`,
      )
    }
    return { publicPackage, privatePackage, ownerDID }
  })
}
```

Then rewrite the two shipped call sites to use it, changing no behaviour:

- `createMemoryLastResortStore` in `packages/mls-hub/src/store.ts` becomes
  `return createMemoryRecordStore<LastResortRecord>()`. Keep the whole doc comment — the MUST
  language on the port and the "loses every record on restart" warning are the point of the file.
- `bundles()` in `packages/mls-hub/src/provisioner.ts` becomes
  `return toBundles(await store.list(ownerDID), ownerDID, 'last-resort')`. The message is unchanged
  for that label, so `packages/mls-hub/test/bundles.test.ts` must still pass untouched.

- [ ] **Step 4: Implement the pool store**

Create `packages/mls-hub/src/pool-store.ts`:

```ts
/**
 * One retained ordinary key package.
 *
 * Unlike a last-resort record this carries no `uploadedAt`, and the omission is deliberate. The
 * last-resort slot is replaced in place, so re-uploading a record whose upload may or may not have
 * landed is harmless. The ordinary pool APPENDS — re-uploading such a record would put two copies
 * of one init key in the pool and both would be served, which is exactly the init-key reuse this
 * feature exists to remove. So a record whose upload was interrupted is never resumed, and nothing
 * needs to remember whether it was uploaded.
 */
export type KeyPackageRecord = {
  /** `keyPackageRef` from `@kumiai/mls` — this record's ID, and what a Welcome names. */
  ref: string
  /** `encodeKeyPackage` output: the exact string uploaded to the hub. */
  keyPackage: string
  /** `encodePrivateKeyPackage` output. SECRET key material. */
  privatePackage: string
  /**
   * The package's MLS lifetime `notAfter`, in seconds. Denormalized so a SQL store can index pruning
   * without decoding MLS, and sent to the hub so it can stop serving and stop counting the entry.
   */
  notAfter: number
}

/**
 * Durable storage for retained ordinary key packages, implemented by the host.
 *
 * **Everything a store persists here is secret** — treat it as private key storage, not a cache.
 *
 * A store MUST:
 *
 * - scope `list` to `ownerDID`. Omitting the owner predicate leaks private key material across
 *   identities.
 * - scope `delete` to `ownerDID`, and no-op for a `ref` that owner does not hold.
 * - treat `put` as replace-by-`ref`, never append.
 * - return records that do not alias its own state.
 *
 * `list` need not order: the pool sorts what it gets.
 */
export type KeyPackagePoolStore = {
  list(ownerDID: string): Promise<Array<KeyPackageRecord>>
  put(ownerDID: string, record: KeyPackageRecord): Promise<void>
  delete(ownerDID: string, ref: string): Promise<void>
}

/**
 * An in-memory {@link KeyPackagePoolStore}, and the strict reference for the rules above.
 *
 * **Loses every record on restart.** The hub keeps serving packages whose private halves are gone,
 * so every Welcome built from them fails at the joiner. Tests and throwaway processes only.
 */
export function createMemoryKeyPackagePoolStore(): KeyPackagePoolStore {
  return createMemoryRecordStore<KeyPackageRecord>()
}
```

Export `createMemoryKeyPackagePoolStore`, `type KeyPackageRecord` and `type KeyPackagePoolStore` from
`packages/mls-hub/src/index.ts`. Do NOT export anything from `records.ts` — it is internal mechanics,
and exporting it would make a shape that exists to avoid duplication into a third public port.

- [ ] **Step 5: Run the package's whole suite and the type check**

```bash
cd packages/mls-hub && pnpm exec vitest run && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

Expected: PASS, then no type output. `test/store.test.ts` and `test/bundles.test.ts` cover the two
refactored call sites and must pass **unmodified** — if either needs a change, the refactor altered
behaviour and the change is wrong, not the test.

- [ ] **Step 6: Commit**

```bash
git add packages/mls-hub/src packages/mls-hub/test/pool-store.test.ts
git commit -m "feat(mls-hub): a storage port for retained ordinary key packages"
```

---

### Task 8: `createKeyPackagePool`

**Files:**
- Create: `packages/mls-hub/src/pool.ts`
- Modify: `packages/mls-hub/src/index.ts`
- Test: `packages/mls-hub/test/pool.test.ts` (create)

**Interfaces:**
- Consumes: `KeyPackagePoolStore`, `KeyPackageRecord`, `createMemoryKeyPackagePoolStore` (Task 7);
  `ORDINARY_KEY_PACKAGE_LIFETIME_DAYS` (Task 1); `HubClient.keyPackageStatus` and the two-argument
  `uploadKeyPackages` (Task 6).
- Produces:
  - `type KeyPackagePool = { ensureStocked(): Promise<{ minted: number; depth: number }>; bundles(): Promise<Array<KeyPackageBundle>> }`
  - `type KeyPackagePoolParams = { identity: OwnIdentity; client: Pick<HubClient, 'uploadKeyPackages' | 'keyPackageStatus'>; store: KeyPackagePoolStore; options?: GroupOptions; target?: number; lowWater?: number; retainAfterExpiryDays?: number }`
  - `createKeyPackagePool(params: KeyPackagePoolParams): KeyPackagePool`

**Context:** `packages/mls-hub/src/provisioner.ts` is the model for single-flight, option validation,
store-before-upload and prune-on-the-no-op-path. Read it before writing. Differences: no resume
branch, no `uploadedAt`, and the deficit comes from the hub's reported depth rather than from local
records. Sorting and decoding for `bundles()` come from the internal `./records.js` Task 7 added —
do not re-implement them here.

- [ ] **Step 1: Write the failing tests**

Create `packages/mls-hub/test/pool.test.ts`:

```ts
import { decodeKeyPackage, ORDINARY_KEY_PACKAGE_LIFETIME_DAYS } from '@kumiai/mls'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createKeyPackagePool } from '../src/pool.js'
import { createMemoryKeyPackagePoolStore } from '../src/pool-store.js'
import { createTestHub, type TestHub } from './fixtures/hub.js'

let hub: TestHub

beforeEach(() => {
  hub = createTestHub()
})

afterEach(async () => {
  await hub.dispose()
})

describe('option validation', () => {
  test.each([
    ['target', { target: 0 }],
    ['target', { target: Number.NaN }],
    ['lowWater', { lowWater: -1 }],
    ['lowWater', { lowWater: 21 }],
    ['retainAfterExpiryDays', { retainAfterExpiryDays: -1 }],
  ])('rejects an out-of-range %s', (_name, overrides) => {
    expect(() =>
      createKeyPackagePool({
        identity: hub.identity,
        client: hub.client,
        store: createMemoryKeyPackagePoolStore(),
        ...overrides,
      }),
    ).toThrow(/mls-hub:/)
  })
})

describe('ensureStocked', () => {
  test('an empty pool mints up to target in one upload', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const upload = vi.spyOn(hub.client, 'uploadKeyPackages')
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 3,
      lowWater: 2,
    })

    const result = await pool.ensureStocked()

    expect(result).toEqual({ minted: 3, depth: 3 })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(await hub.hubStore.countKeyPackages(hub.identity.id)).toBe(3)

    const records = await store.list(hub.identity.id)
    expect(records).toHaveLength(3)

    // Pinned in SECONDS at the real lifetime: a milliseconds regression would make every record
    // look decades-fresh, nothing would ever be pruned, and every other test here would stay green.
    const expected = Math.floor(Date.now() / 1000) + ORDINARY_KEY_PACKAGE_LIFETIME_DAYS * 86_400
    for (const stored of records) {
      expect(stored.notAfter).toBeGreaterThan(expected - 86_400)
      expect(stored.notAfter).toBeLessThan(expected + 86_400)
    }
  })

  test('the uploaded bytes are the records own, and carry the expiry', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 1,
      lowWater: 1,
    })

    await pool.ensureStocked()

    const records = await store.list(hub.identity.id)
    expect(await hub.hubStore.fetchKeyPackages(hub.identity.id, 1)).toEqual([
      records[0]?.keyPackage,
    ])
  })

  test('does nothing while depth is at or above lowWater', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 4,
      lowWater: 2,
    })
    await pool.ensureStocked()
    const upload = vi.spyOn(hub.client, 'uploadKeyPackages')

    const result = await pool.ensureStocked()

    expect(result).toEqual({ minted: 0, depth: 4 })
    expect(upload).not.toHaveBeenCalled()
  })

  test('tops up only the deficit once consumption drops depth below lowWater', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 4,
      lowWater: 3,
    })
    await pool.ensureStocked()
    // Someone fetched two of them.
    await hub.hubStore.fetchKeyPackages(hub.identity.id, 2)

    const result = await pool.ensureStocked()

    expect(result).toEqual({ minted: 2, depth: 4 })
  })

  test('persists a record before uploading it', async () => {
    const inner = createMemoryKeyPackagePoolStore()
    const store = { ...inner, put: vi.fn(inner.put) }
    const upload = vi.spyOn(hub.client, 'uploadKeyPackages')
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 1,
      lowWater: 1,
    })

    await pool.ensureStocked()

    // Upload-then-persist has a crash window in which the hub serves a package whose private half
    // was never written down, and every Welcome built from it fails at the joiner.
    expect(store.put.mock.invocationCallOrder[0]).toBeLessThan(
      upload.mock.invocationCallOrder[0] as number,
    )
  })

  test('abandons an un-uploaded record instead of re-uploading it', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 1,
      lowWater: 1,
    })
    // A record written before a crash: in the store, never counted by the hub.
    await store.put(hub.identity.id, {
      ref: 'orphan',
      keyPackage: 'kp-orphan',
      privatePackage: 'priv-orphan',
      notAfter: Math.floor(Date.now() / 1000) + 86_400,
    })

    await pool.ensureStocked()

    // Re-uploading it would risk a second copy of one init key in the pool — both would be served.
    // Minting fresh costs one key generation; the orphan stays readable for a late Welcome and is
    // pruned at expiry.
    expect(await hub.hubStore.fetchKeyPackages(hub.identity.id, 5)).not.toContain('kp-orphan')
    expect((await store.list(hub.identity.id)).map((entry) => entry.ref)).toContain('orphan')
  })

  test('prunes a record past its expiry plus the grace, including on the no-op path', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 1,
      lowWater: 1,
      retainAfterExpiryDays: 7,
    })
    await pool.ensureStocked()
    const nowSeconds = Math.floor(Date.now() / 1000)
    await store.put(hub.identity.id, {
      ref: 'stale',
      keyPackage: 'kp-stale',
      privatePackage: 'priv-stale',
      notAfter: nowSeconds - 8 * 86_400,
    })
    await store.put(hub.identity.id, {
      ref: 'within-grace',
      keyPackage: 'kp-grace',
      privatePackage: 'priv-grace',
      notAfter: nowSeconds - 6 * 86_400,
    })

    // Depth is already at target, so this takes the no-op branch — which must still prune, or a
    // daily caller never prunes between refreshes.
    await pool.ensureStocked()

    const refs = (await store.list(hub.identity.id)).map((entry) => entry.ref)
    expect(refs).not.toContain('stale')
    expect(refs).toContain('within-grace')
  })

  test('is single-flight', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const upload = vi.spyOn(hub.client, 'uploadKeyPackages')
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 2,
      lowWater: 2,
    })

    const [first, second] = await Promise.all([pool.ensureStocked(), pool.ensureStocked()])

    expect(first).toEqual(second)
    expect(upload).toHaveBeenCalledTimes(1)
  })
})

describe('bundles', () => {
  test('returns every retained bundle, newest first', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 2,
      lowWater: 2,
    })
    await pool.ensureStocked()

    const bundles = await pool.bundles()

    expect(bundles).toHaveLength(2)
    for (const bundle of bundles) {
      expect(bundle.ownerDID).toBe(hub.identity.id)
    }
    const notAfters = bundles.map((bundle) => Number(bundle.publicPackage.leafNode.lifetime.notAfter))
    expect(notAfters).toEqual([...notAfters].sort((a, b) => b - a))
  })

  test('throws on a record that does not round-trip, rather than skipping it', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 1,
      lowWater: 1,
    })
    await pool.ensureStocked()
    await store.put(hub.identity.id, {
      ref: 'corrupt',
      keyPackage: 'not-a-key-package',
      privatePackage: 'not-a-private-package',
      notAfter: Math.floor(Date.now() / 1000) + 86_400,
    })

    // Narrowing a corrupt store to "you appear to have fewer packages" recreates the silent failure
    // this whole feature removes. Names the ref, never the material.
    await expect(pool.bundles()).rejects.toThrow(/key package record corrupt did not decode/)
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

```bash
cd packages/mls-hub && pnpm exec vitest run test/pool.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/mls-hub/src/pool.ts`:

```ts
import type { OwnIdentity } from '@kokuin/token'
import type { HubClient } from '@kumiai/hub-client'
import {
  createKeyPackageBundle,
  encodeKeyPackage,
  encodePrivateKeyPackage,
  type GroupOptions,
  type KeyPackageBundle,
  keyPackageRef,
} from '@kumiai/mls'

import type { KeyPackagePoolStore, KeyPackageRecord } from './pool-store.js'
import { toBundles } from './records.js'

const DAY_SECONDS = 86_400
const DEFAULT_TARGET = 20
const DEFAULT_LOW_WATER = 10
const DEFAULT_RETAIN_AFTER_EXPIRY_DAYS = 7

export type KeyPackagePoolParams = {
  /** The identity packages are minted for; also the store's owner key. */
  identity: OwnIdentity
  client: Pick<HubClient, 'uploadKeyPackages' | 'keyPackageStatus'>
  store: KeyPackagePoolStore
  /** Threaded into `createKeyPackageBundle` and `keyPackageRef`. */
  options?: GroupOptions
  /** Stock back up to this depth. Default 20, must be a finite integer greater than 0. */
  target?: number
  /** Top up once the hub reports fewer than this many. Default 10, must be `0 <= n <= target`. */
  lowWater?: number
  /** Keep a record this many days past its `notAfter`. Default 7, must be `>= 0`. */
  retainAfterExpiryDays?: number
}

export type KeyPackagePool = {
  /**
   * Bring the hub's ordinary pool back up to `target` when it has fallen below `lowWater`, and prune
   * records whose lifetime plus the retention grace has passed.
   *
   * `depth` is what this call left behind — the depth the hub reported plus `minted` — not a second
   * status read.
   */
  ensureStocked(): Promise<{ minted: number; depth: number }>
  /** Every retained bundle, `notAfter` descending, for `processWelcome`. */
  bundles(): Promise<Array<KeyPackageBundle>>
}

export function createKeyPackagePool(params: KeyPackagePoolParams): KeyPackagePool {
  const {
    identity,
    client,
    store,
    options,
    target = DEFAULT_TARGET,
    lowWater = DEFAULT_LOW_WATER,
    retainAfterExpiryDays = DEFAULT_RETAIN_AFTER_EXPIRY_DAYS,
  } = params

  // All three are fed to raw arithmetic against clock readings and counts, so an out-of-range value
  // inverts a guard rather than failing: `target <= 0` mints negative deficits, `lowWater > target`
  // tops up on every call forever, a negative grace prunes still-valid records, and `NaN` anywhere
  // disables both the top-up and the pruning. All either destroy secret key material or drain the
  // hub's cap.
  if (!Number.isInteger(target) || target <= 0) {
    throw new Error(`mls-hub: target must be an integer greater than 0, got ${target}`)
  }
  if (!Number.isInteger(lowWater) || lowWater < 0 || lowWater > target) {
    throw new Error(
      `mls-hub: lowWater must be an integer between 0 and the target of ${target}, got ${lowWater}`,
    )
  }
  if (!Number.isFinite(retainAfterExpiryDays) || retainAfterExpiryDays < 0) {
    throw new Error(
      `mls-hub: retainAfterExpiryDays must be a finite number of 0 or more, got ${retainAfterExpiryDays}`,
    )
  }

  const ownerDID = identity.id
  let inFlight: Promise<{ minted: number; depth: number }> | null = null

  const mint = async (): Promise<KeyPackageRecord> => {
    const bundle = await createKeyPackageBundle(identity, options)
    const record: KeyPackageRecord = {
      ref: await keyPackageRef(bundle.publicPackage, options),
      keyPackage: encodeKeyPackage(bundle.publicPackage),
      privatePackage: encodePrivateKeyPackage(bundle.privatePackage),
      notAfter: Number(bundle.publicPackage.leafNode.lifetime.notAfter),
    }
    // Durable before the upload. The reverse order has a crash window in which the hub serves a
    // package whose private half was never written down, and every Welcome built from it fails at
    // the joiner with nothing to diagnose.
    await store.put(ownerDID, record)
    return record
  }

  const prune = async (records: Array<KeyPackageRecord>): Promise<void> => {
    const cutoff = Math.floor(Date.now() / 1000) - retainAfterExpiryDays * DAY_SECONDS
    for (const record of records) {
      if (record.notAfter < cutoff) await store.delete(ownerDID, record.ref)
    }
  }

  const run = async (): Promise<{ minted: number; depth: number }> => {
    const { count } = await client.keyPackageStatus()
    let minted: Array<KeyPackageRecord> = []
    if (count < lowWater) {
      // Mint the whole deficit before uploading any of it, so one upload call carries the batch and
      // one `notAfter` describes it.
      const wanted = target - count
      const records: Array<KeyPackageRecord> = []
      for (let index = 0; index < wanted; index++) records.push(await mint())
      // One expiry for the batch: they were minted together under one lifetime, and the smallest is
      // the only one that keeps the hub from serving a package the inviter would reject.
      const notAfter = Math.min(...records.map((record) => record.notAfter))
      await client.uploadKeyPackages(
        records.map((record) => record.keyPackage),
        notAfter,
      )
      minted = records
    }
    // Prune on the no-op path too, or a daily caller never prunes between top-ups. Re-listing picks
    // up the records just minted, which are nowhere near the cutoff.
    await prune(await store.list(ownerDID))
    return { minted: minted.length, depth: count + minted.length }
  }

  return {
    async ensureStocked(): Promise<{ minted: number; depth: number }> {
      // Single-flight: a second caller joins the first rather than minting a competing batch against
      // the same reported depth. Cross-process overlap is undefended by design — it overshoots the
      // target, which costs cap headroom and nothing else.
      if (inFlight != null) return await inFlight
      const started = run().finally(() => {
        inFlight = null
      })
      inFlight = started
      return await started
    },
    async bundles(): Promise<Array<KeyPackageBundle>> {
      // Sorting, decoding and the loud throw on a corrupt record are shared with the last-resort
      // provisioner via `./records.js`; only the label differs.
      return toBundles(await store.list(ownerDID), ownerDID, 'key package')
    },
  }
}
```

Export `createKeyPackagePool`, `type KeyPackagePool` and `type KeyPackagePoolParams` from
`packages/mls-hub/src/index.ts`.

- [ ] **Step 4: Run the tests and the type check**

```bash
cd packages/mls-hub && pnpm exec vitest run test/pool.test.ts && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

Expected: PASS, then no type output.

- [ ] **Step 5: Commit**

```bash
git add packages/mls-hub/src/pool.ts packages/mls-hub/src/index.ts packages/mls-hub/test/pool.test.ts
git commit -m "feat(mls-hub): top the ordinary key package pool up against reported depth"
```

---

### Task 9: The Welcome wrapper, and the last-resort slot readback

**Files:**
- Create: `packages/mls-hub/src/join.ts`
- Modify: `packages/mls-hub/src/provisioner.ts`
- Modify: `packages/mls-hub/src/pool.ts`
- Modify: `packages/mls-hub/src/index.ts`
- Modify: `packages/mls-hub/package.json`
- Test: `packages/mls-hub/test/join.test.ts` (create)
- Test: `packages/mls-hub/test/provisioner.test.ts` (modify)

**Interfaces:**
- Consumes: `welcomeKeyPackageRefs` (Task 2), `keyPackageDigest` (Task 3),
  `HubClient.keyPackageStatus` (Task 6), `KeyPackagePool` (Task 8),
  `LastResortProvisioner` (existing).
- Produces:
  - `type BundleSource = { bundles(): Promise<Array<KeyPackageBundle>>; release(ref: string): Promise<void> }`
  - `processWelcomeFromSources(params: ProcessWelcomeFromSourcesParams): Promise<ProcessWelcomeFromSourcesResult>`
    where the params are `ProcessWelcomeParams` minus `keyPackageBundle`, plus
    `sources: Array<BundleSource>`; and the result is `ProcessWelcomeResult` plus
    `releaseError?: Error`.
  - `KeyPackagePool.release(ref: string): Promise<void>` — deletes the record.
  - `LastResortProvisioner.release(ref: string): Promise<void>` — a no-op; a last-resort package is
    reusable and must survive its own Welcome.
  - `LastResortProvisionerParams.client` widens to
    `Pick<HubClient, 'uploadLastResortKeyPackage' | 'keyPackageStatus'>`.

**Context:** `@kumiai/mls-hub` must not gain a `ts-mls` dependency — `welcomeKeyPackageRefs` and
`keyPackageRef` are how the Welcome and the bundles are compared. `@kumiai/hub-protocol` is currently
a **devDependency** of `mls-hub`; `keyPackageDigest` is now imported by `src/`, so move it to
`dependencies` as `workspace:^`.

- [ ] **Step 1: Write the failing tests**

Create `packages/mls-hub/test/join.test.ts`:

```ts
import { randomIdentity } from '@kokuin/token'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { processWelcomeFromSources } from '../src/join.js'
import { createKeyPackagePool } from '../src/pool.js'
import { createMemoryKeyPackagePoolStore } from '../src/pool-store.js'
import { createLastResortProvisioner } from '../src/provisioner.js'
import { createMemoryLastResortStore } from '../src/store.js'
import { createTestHub, type TestHub } from './fixtures/hub.js'

let hub: TestHub

beforeEach(() => {
  hub = createTestHub()
})

afterEach(async () => {
  await hub.dispose()
})

// Build the invite-and-commit sequence by copying the working one from
// `packages/mls/test/last-resort-keypackage.test.ts`. The inviter is a separate identity that
// fetches a key package for `hub.identity` from `hub.hubStore` and commits an invite with it.

describe('processWelcomeFromSources', () => {
  test('joins with the ordinary bundle the Welcome names, and releases it', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 2,
      lowWater: 2,
    })
    await pool.ensureStocked()
    const { welcome, invite, ratchetTree, usedRef } = await inviteFromPool()

    const result = await processWelcomeFromSources({
      identity: hub.identity,
      invite,
      welcome,
      ratchetTree,
      sources: [pool],
    })

    expect(result.group).toBeDefined()
    expect(result.releaseError).toBeUndefined()
    // A single-use private half is gone once its Welcome is processed. That deletion is the whole
    // forward-secrecy point of replenishing the pool at all.
    expect((await store.list(hub.identity.id)).map((entry) => entry.ref)).not.toContain(usedRef)
  })

  test('retains a last-resort bundle after its Welcome', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })
    const { ref } = await provisioner.ensureProvisioned()
    const { welcome, invite, ratchetTree } = await inviteFromLastResortSlot()

    await processWelcomeFromSources({
      identity: hub.identity,
      invite,
      welcome,
      ratchetTree,
      sources: [provisioner],
    })

    // Deleting it would make the owner silently unaddable forever — the outage the slot exists to
    // prevent.
    expect((await store.list(hub.identity.id)).map((entry) => entry.ref)).toContain(ref)
  })

  test('throws naming the refs sought when nothing matches', async () => {
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store: createMemoryKeyPackagePoolStore(),
      target: 1,
      lowWater: 1,
    })
    await pool.ensureStocked()
    const { welcome, invite, ratchetTree } = await inviteAStranger()

    // Trying every bundle until one decrypts would turn "wrong Welcome" into a crypto error with no
    // diagnosis; naming the refs says which package the sender expected.
    await expect(
      processWelcomeFromSources({
        identity: hub.identity,
        invite,
        welcome,
        ratchetTree,
        sources: [pool],
      }),
    ).rejects.toThrow(/no retained key package matches/)
  })

  test('a failed release surfaces on the result rather than failing the join', async () => {
    const inner = createMemoryKeyPackagePoolStore()
    const store = {
      ...inner,
      delete: vi.fn(async () => {
        throw new Error('store offline')
      }),
    }
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 1,
      lowWater: 1,
    })
    await pool.ensureStocked()
    const { welcome, invite, ratchetTree } = await inviteFromPool()

    const result = await processWelcomeFromSources({
      identity: hub.identity,
      invite,
      welcome,
      ratchetTree,
      sources: [pool],
    })

    // The join succeeded and the caller must get their group; the undeleted private half is a real
    // problem they still need told about, so it rides a separate channel.
    expect(result.group).toBeDefined()
    expect(result.releaseError?.message).toMatch(/store offline/)
  })
})
```

Replace `inviteFromPool` / `inviteFromLastResortSlot` / `inviteAStranger` with real local helpers
built from the invite-and-commit sequence in `packages/mls/test/last-resort-keypackage.test.ts`.
They must fetch the key package from `hub.hubStore` the way a real inviter would, and return the
Welcome, invite, ratchet tree, and the ref that was used.

Add to `packages/mls-hub/test/provisioner.test.ts`:

```ts
test('repairs a slot the hub lost', async () => {
  const store = createMemoryLastResortStore()
  const provisioner = createLastResortProvisioner({
    identity: hub.identity,
    client: hub.client,
    store,
  })
  const first = await provisioner.ensureProvisioned()
  // The hub lost the slot: without a readback the provisioner trusts its own record of a successful
  // upload and reports the floor as in place over an empty slot.
  await hub.hubStore.storeLastResortKeyPackage(hub.identity.id, 'kp-something-else')

  const second = await provisioner.ensureProvisioned()

  expect(second.rotated).toBe(true)
  expect(second.ref).toBe(first.ref)
  const records = await store.list(hub.identity.id)
  expect(await hub.hubStore.fetchLastResortKeyPackage(hub.identity.id)).toBe(records[0]?.keyPackage)
})
```

- [ ] **Step 2: Run and confirm both fail**

```bash
cd packages/mls-hub && pnpm exec vitest run test/join.test.ts test/provisioner.test.ts
```

Expected: FAIL — `join.js` not found; the provisioner still reports `rotated: false` for a lost slot.

- [ ] **Step 3: Implement the wrapper**

Create `packages/mls-hub/src/join.ts`:

```ts
import {
  keyPackageRef,
  type KeyPackageBundle,
  processWelcome,
  type ProcessWelcomeParams,
  type ProcessWelcomeResult,
  welcomeKeyPackageRefs,
} from '@kumiai/mls'

/**
 * Somewhere retained key packages live, and what to do with one once its Welcome has been used.
 *
 * A `KeyPackagePool` releases by deleting: an ordinary package is single-use, and keeping its
 * private half after the join is exactly the forward-secrecy loss the pool exists to close. A
 * `LastResortProvisioner` releases by doing nothing: the same package will be handed to another
 * inviter, and deleting it makes the owner silently unaddable forever.
 */
export type BundleSource = {
  bundles(): Promise<Array<KeyPackageBundle>>
  release(ref: string): Promise<void>
}

export type ProcessWelcomeFromSourcesParams = Omit<ProcessWelcomeParams, 'keyPackageBundle'> & {
  sources: Array<BundleSource>
}

export type ProcessWelcomeFromSourcesResult = ProcessWelcomeResult & {
  /**
   * The join succeeded but the used bundle could not be released — for an ordinary package, its
   * private half is still on disk. Surfaced here rather than thrown, because throwing would take
   * the caller's group away over a storage problem, and swallowed it would be exactly the silent
   * host obligation this wrapper exists to remove.
   */
  releaseError?: Error
}

/**
 * Process a Welcome using whichever retained bundle it names, and release that bundle.
 *
 * Selection is by KeyPackageRef, not by trial decryption: a mismatch is then a named error rather
 * than an undiagnosable crypto failure.
 */
export async function processWelcomeFromSources(
  params: ProcessWelcomeFromSourcesParams,
): Promise<ProcessWelcomeFromSourcesResult> {
  const { sources, ...welcomeParams } = params
  const wanted = new Set(welcomeKeyPackageRefs(welcomeParams.welcome))

  for (const source of sources) {
    for (const bundle of await source.bundles()) {
      const ref = await keyPackageRef(bundle.publicPackage, welcomeParams.options)
      if (!wanted.has(ref)) continue
      const result = await processWelcome({ ...welcomeParams, keyPackageBundle: bundle })
      try {
        await source.release(ref)
      } catch (error) {
        return { ...result, releaseError: error instanceof Error ? error : new Error(String(error)) }
      }
      return result
    }
  }

  throw new Error(
    `mls-hub: no retained key package matches this Welcome; it names ${[...wanted].join(', ')}`,
  )
}
```

- [ ] **Step 4: Add `release` to both sources**

In `packages/mls-hub/src/pool.ts`, add to the returned object and to `KeyPackagePool`:

```ts
  /** Drop a record once its Welcome has been processed. An ordinary package is single-use. */
  release(ref: string): Promise<void>
```

```ts
    async release(ref: string): Promise<void> {
      await store.delete(ownerDID, ref)
    },
```

In `packages/mls-hub/src/provisioner.ts`, add to `LastResortProvisioner`:

```ts
  /**
   * A no-op, so a provisioner can stand in as a `BundleSource`. A last-resort package is reusable by
   * design — the same one is handed to every inviter until it rotates — so a Welcome must not
   * consume it. Deleting it here would make the owner silently unaddable forever.
   */
  release(ref: string): Promise<void>
```

```ts
    async release(_ref: string): Promise<void> {},
```

- [ ] **Step 5: Add the slot readback to the provisioner**

Widen the params type:

```ts
  client: Pick<HubClient, 'uploadLastResortKeyPackage' | 'keyPackageStatus'>
```

In `run()`, replace the no-op branch's early return so a slot the hub does not actually hold is
repaired:

```ts
    if (candidate != null && candidate.notAfter - nowSeconds > rotateWithinDays * DAY_SECONDS) {
      // The record says this package was uploaded; the hub is the only authority on whether it is
      // still there. Without this readback a hub that lost or replaced the slot is reported as
      // provisioned until the next rotation falls due — the floor is gone and nothing says so.
      // Re-uploading is safe here precisely because the slot replaces in place, which is why the
      // ordinary pool cannot do the same thing.
      const { lastResort } = await client.keyPackageStatus()
      if (lastResort !== (await keyPackageDigest(candidate.keyPackage))) {
        await upload(candidate)
        await prune(records, candidate.ref)
        return { rotated: true, ref: candidate.ref }
      }
      // Prune on the no-op path too, or a daily caller never prunes between 90-day rotations.
      await prune(records, candidate.ref)
      return { rotated: false, ref: candidate.ref }
    }
```

Import `keyPackageDigest` from `@kumiai/hub-protocol`, and move `@kumiai/hub-protocol` from
`devDependencies` to `dependencies` (`workspace:^`) in `packages/mls-hub/package.json`.

- [ ] **Step 6: Export and run everything**

Export `processWelcomeFromSources`, `type BundleSource`, `type ProcessWelcomeFromSourcesParams` and
`type ProcessWelcomeFromSourcesResult` from `packages/mls-hub/src/index.ts`. Update the module doc
comment at the top of that file: the package is no longer only about last-resort provisioning.

```bash
cd packages/mls-hub && pnpm exec vitest run && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

Expected: PASS, then no type output.

- [ ] **Step 7: Confirm the layering constraints still hold**

```bash
cd /Users/paul/dev/yulsi/kumiai && grep -r "ts-mls" packages/mls-hub/src packages/mls-hub/package.json; grep -r "hub-client" packages/mls/src packages/mls/package.json
```

Expected: no output from either. Any hit is a layering violation, not a lint nit.

- [ ] **Step 8: Commit**

```bash
git add packages/mls-hub
git commit -m "feat(mls-hub): join from retained bundles, and read back the last-resort slot"
```

---

### Task 10: Changesets, docs, and the whole-repo gate

**Files:**
- Create: `.changeset/ordinary-keypackage-pool.md`
- Modify: `packages/mls-hub/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Write the changeset**

Create `.changeset/ordinary-keypackage-pool.md` (read a sibling entry such as
`.changeset/key-package-codec.md` first and match its format exactly):

```markdown
---
'@kumiai/hub-conformance': minor
'@kumiai/hub-protocol': minor
'@kumiai/hub-client': minor
'@kumiai/hub-server': minor
'@kumiai/mls-hub': minor
'@kumiai/mls': minor
---

Replenish the ordinary key-package pool.

`hub/v1/keypackage/upload` now carries an optional `notAfter`, and a store must neither serve, count,
nor charge its cap for an expired entry — without which a pool that filled with dead packages could
never be replenished. The new `hub/v1/keypackage/status` reports the caller's own live depth and a
digest of their own last-resort slot; it takes no `did`, so it cannot report on anyone else.
`@kumiai/mls-hub` gains `createKeyPackagePool`, which tops up against that depth, and
`processWelcomeFromSources`, which picks the bundle a Welcome names and drops a single-use private
half once it is used. `LastResortProvisioner` now re-uploads when the hub's slot does not hold what
it believes it uploaded.
```

- [ ] **Step 2: Update the mls-hub README**

Read `packages/mls-hub/README.md` and add the pool and the join wrapper to the documented surface,
in the voice already there. Document what the surface does, not why the package exists.

- [ ] **Step 3: Lint**

```bash
cd /Users/paul/dev/yulsi/kumiai && rtk proxy pnpm run lint
```

Expected: clean. (The plain `pnpm exec biome` and `pnpm run lint` forms are both intercepted by a
shim on this machine and report a fake result — `rtk proxy` is the one that runs the real tool.)

- [ ] **Step 4: Run the whole repo, uncached**

```bash
cd /Users/paul/dev/yulsi/kumiai && rtk proxy pnpm test --force
```

Expected: every task green, and the summary line must read `Cached: 0` — a cached run proves nothing
about the code just written. Do not accept a summary showing cache hits.

- [ ] **Step 5: Commit**

```bash
git add .changeset packages/mls-hub/README.md
git commit -m "docs: changeset and README for the ordinary key package pool"
```
