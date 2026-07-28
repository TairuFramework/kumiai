# Provisioning Retryable Result Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** planning
**Mode:** tasks
**Spec:** `docs/superpowers/specs/2026-07-28-provisioning-retryable-result-design.md`

**Goal:** Make `@kumiai/mls-hub`'s two provisioning entry points tell a caller whether to retry — a
transient hub failure becomes an error `Result`, a settled refusal throws.

**Architecture:** A new `src/errors.ts` classifies any error out of a hub call into exactly one of
two outcomes: return a `HubRetryableError` (caller retries later, nothing to fix) or throw a
`HubRefusedError` (the app or operator must change something). `KeyPackagePool.ensureStocked` and
`LastResortProvisioner.ensureProvisioned` change their return type from `Promise<T>` to
`AsyncResult<T, HubRetryableError>` from `@sozai/result`, leaving their success types untouched.
Pruning — which is purely local — moves onto every path, including the failure paths.

**Tech Stack:** TypeScript, vitest, `@sozai/result`, `@kumiai/hub-protocol`, `@enkaku/protocol`,
pnpm + turbo, biome.

## Global Constraints

- pnpm only. Never edit generated files under `lib/`.
- Cross-repo deps (`@sozai/*`, `@enkaku/*`, `@kokuin/*`) go through the workspace catalog as
  published `^` ranges, never `workspace:`. Internal `@kumiai/*` deps are `workspace:^`.
- Run lint as `rtk proxy pnpm run lint` from the repo root. A local `rtk` shim intercepts both
  `pnpm run lint` and `pnpm exec biome` and silently runs the wrong tool.
- Every task that changes types runs **both** `pnpm run test:types` and `pnpm run test:unit`.
  vitest strips types, so a green unit run proves nothing about the type-level work in this plan.
- Scope is `packages/mls-hub` plus the workspace catalog. Do not modify `join.ts`, `bundles()`,
  `release()`, or any other package.
- Comments: keep the non-obvious *why*, cut the essay. Match the density already in `pool.ts` and
  `provisioner.ts`.
- Run commands from `packages/mls-hub` unless a step says otherwise.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/mls-hub/src/errors.ts` (create) | The two error classes and `toRetryableOrThrow` — the single place that decides retryable vs refused. |
| `packages/mls-hub/test/errors.test.ts` (create) | Classifier unit tests, including every identification path. |
| `packages/mls-hub/src/pool.ts` (modify) | `ensureStocked` returns `AsyncResult`; prune on every path. |
| `packages/mls-hub/src/provisioner.ts` (modify) | `ensureProvisioned` returns `AsyncResult`; prune on every path. |
| `packages/mls-hub/src/index.ts` (modify) | Export the error classes. |
| `packages/mls-hub/package.json` (modify) | Add `@sozai/result`; promote `@enkaku/protocol` to a dependency. |
| `pnpm-workspace.yaml` (modify) | Catalog entry for `@sozai/result`. |
| `packages/mls-hub/test/{pool,provisioner,bundles,join}.test.ts` (modify) | Migrate call sites; add failure-path tests. |
| `packages/mls-hub/README.md` (modify) | Document the split and the cadence obligation. |
| `.changeset/*.md` (create) | Breaking change note. |
| `docs/agents/plans/next/2026-07-28-stack-wide-result-adoption.md` (create) | Record the scoped-out question. |

---

## Task 1: Error classes and the classifier

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify: `packages/mls-hub/package.json`
- Create: `packages/mls-hub/src/errors.ts`
- Create: `packages/mls-hub/test/errors.test.ts`
- Modify: `packages/mls-hub/src/index.ts`

**Interfaces:**
- Consumes: `HUB_ERROR_CODES`, `HubErrorCode`, `hubErrorCodeOf` from `@kumiai/hub-protocol`;
  `ErrorCodes` from `@enkaku/protocol`.
- Produces:
  - `class HubRetryableError extends Error` with `readonly stage: HubCallStage`,
    `readonly code: string | null`.
  - `class HubRefusedError extends Error` with `readonly stage: HubCallStage`,
    `readonly code: string`.
  - `type HubCallStage = 'status' | 'upload'`.
  - `function toRetryableOrThrow(error: unknown, stage: HubCallStage): HubRetryableError` — returns
    a retryable error, throws `HubRefusedError` for a settled refusal. Tasks 2 and 3 call this and
    nothing else.

- [ ] **Step 1: Add the catalog entry**

In `pnpm-workspace.yaml`, add to the `catalog:` block, keeping it beside the other `@sozai/*` entries
(they are grouped, not alphabetised across scopes):

```yaml
  '@sozai/log': ^0.2.0
  '@sozai/result': ^0.2.0
  '@sozai/runtime': ^0.1.0
```

- [ ] **Step 2: Add the package dependencies**

In `packages/mls-hub/package.json`, add `@sozai/result` to `dependencies` and move
`@enkaku/protocol` out of `devDependencies` into `dependencies` (the classifier uses its
`ErrorCodes` at runtime). Keys stay alphabetically sorted:

```json
  "dependencies": {
    "@enkaku/protocol": "catalog:",
    "@kokuin/token": "catalog:",
    "@kumiai/hub-client": "workspace:^",
    "@kumiai/hub-protocol": "workspace:^",
    "@kumiai/mls": "workspace:^",
    "@sozai/result": "catalog:"
  },
  "devDependencies": {
    "@enkaku/client": "catalog:",
    "@enkaku/transport": "catalog:",
    "@kumiai/hub-server": "workspace:^"
  }
```

Then, from the repo root:

```bash
pnpm install
```

- [ ] **Step 3: Write the failing classifier tests**

Create `packages/mls-hub/test/errors.test.ts`:

```ts
import { ErrorCodes } from '@enkaku/protocol'
import { AuthorizationDeniedError, KeyPackageQuotaExceededError } from '@kumiai/hub-protocol'
import { describe, expect, test } from 'vitest'

import { HubRefusedError, HubRetryableError, toRetryableOrThrow } from '../src/errors.js'

describe('toRetryableOrThrow', () => {
  test('a transport failure is retryable and carries no code', () => {
    const cause = new Error('socket closed')
    const error = toRetryableOrThrow(cause, 'status')

    expect(error).toBeInstanceOf(HubRetryableError)
    expect(error.stage).toBe('status')
    expect(error.code).toBeNull()
    expect(error.cause).toBe(cause)
  })

  test('a thrown non-Error is retryable', () => {
    const error = toRetryableOrThrow('nope', 'upload')

    expect(error).toBeInstanceOf(HubRetryableError)
    expect(error.code).toBeNull()
    expect(error.cause).toBe('nope')
  })

  // The path a host actually hits. `hub-client` is a pass-through wrapper, so a hub answer arrives
  // as an enkaku RequestError carrying the wire code — `constructor.name` is `RequestError`, `name`
  // is `'Error'`, and it is NOT an instance of the hub-protocol class. Identifying by `instanceof`
  // alone would class every refusal as retryable and retry it forever.
  test('a wire code identifies a refusal that matches neither class nor name', () => {
    const wire = Object.assign(new Error('denied'), { code: 'HUB_AUTHORIZATION_DENIED' })

    expect(() => toRetryableOrThrow(wire, 'status')).toThrow(HubRefusedError)
  })

  test('a wire code identifies a retryable answer too', () => {
    const wire = Object.assign(new Error('full'), { code: 'HUB_KEYPACKAGE_QUOTA' })
    const error = toRetryableOrThrow(wire, 'upload')

    expect(error).toBeInstanceOf(HubRetryableError)
    expect(error.code).toBe('HUB_KEYPACKAGE_QUOTA')
  })

  test('the real hub-protocol class is identified', () => {
    const error = toRetryableOrThrow(new KeyPackageQuotaExceededError('full'), 'upload')

    expect(error).toBeInstanceOf(HubRetryableError)
    expect(error.code).toBe('HUB_KEYPACKAGE_QUOTA')
  })

  // A host bundling two copies of hub-protocol breaks `instanceof`, and a rebuilt error may carry
  // only the name. Matching the name too is what keeps a refusal from becoming a retry loop.
  test('a foreign class carrying the right name is identified', () => {
    const foreign = new Error('denied')
    foreign.name = 'AuthorizationDeniedError'

    expect(() => toRetryableOrThrow(foreign, 'status')).toThrow(HubRefusedError)
  })

  test('a refusal carries its code and stage', () => {
    try {
      toRetryableOrThrow(new AuthorizationDeniedError('denied'), 'upload')
      expect.unreachable('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(HubRefusedError)
      expect((error as HubRefusedError).code).toBe('HUB_AUTHORIZATION_DENIED')
      expect((error as HubRefusedError).stage).toBe('upload')
    }
  })

  test.each([
    ['EK02 access denied', ErrorCodes.ACCESS_DENIED],
    ['EK06 message too large', ErrorCodes.MESSAGE_TOO_LARGE],
    // Reachable today: the upload schema caps `keyPackages` at 50 and nothing validates `target`
    // against it, so a pool with `target: 200` would otherwise re-mint a doomed batch forever.
    ['EK08 invalid message', ErrorCodes.INVALID_MESSAGE],
  ])('%s is refused', (_name, code) => {
    const wire = Object.assign(new Error('rejected'), { code })

    expect(() => toRetryableOrThrow(wire, 'upload')).toThrow(HubRefusedError)
  })

  test.each([
    ['EK01 handler error', ErrorCodes.HANDLER_ERROR],
    ['EK03 controller limit', ErrorCodes.CONTROLLER_LIMIT],
    ['EK04 handler limit', ErrorCodes.HANDLER_LIMIT],
    ['EK05 timeout', ErrorCodes.TIMEOUT],
  ])('%s is retryable', (_name, code) => {
    const wire = Object.assign(new Error('busy'), { code })

    expect(toRetryableOrThrow(wire, 'status')).toBeInstanceOf(HubRetryableError)
  })

  test('an unrecognised code is retryable', () => {
    const wire = Object.assign(new Error('who knows'), { code: 'SOMETHING_NEW' })

    expect(toRetryableOrThrow(wire, 'status').code).toBe('SOMETHING_NEW')
  })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
pnpm exec vitest run test/errors.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/errors.js"`.

- [ ] **Step 5: Write the implementation**

Create `packages/mls-hub/src/errors.ts`:

```ts
import { ErrorCodes } from '@enkaku/protocol'
import { HUB_ERROR_CODES, type HubErrorCode, hubErrorCodeOf } from '@kumiai/hub-protocol'

/** Which hub call failed. `'status'`: nothing was attempted. `'upload'`: attempted, outcome unknown. */
export type HubCallStage = 'status' | 'upload'

/**
 * The hub could not be made to answer, or answered something that clears on its own. Retrying later
 * can succeed and nothing needs changing, so this is returned rather than thrown — an unhandled
 * throw would take down a host that could otherwise carry on entirely offline.
 */
export class HubRetryableError extends Error {
  override name = 'HubRetryableError'
  /** The wire code when the hub answered, null for a transport failure. */
  readonly code: string | null
  readonly stage: HubCallStage

  constructor(stage: HubCallStage, code: string | null, cause: unknown) {
    super(
      `mls-hub: the hub could not complete the ${stage} request${code == null ? '' : ` (${code})`}; retry later`,
      { cause },
    )
    this.code = code
    this.stage = stage
  }
}

/**
 * The hub has answered settled: the app or its operator must change something before this call can
 * ever succeed. Thrown, so a host that writes no handler still gets told.
 */
export class HubRefusedError extends Error {
  override name = 'HubRefusedError'
  readonly code: string
  readonly stage: HubCallStage

  constructor(stage: HubCallStage, code: string, cause: unknown) {
    super(`mls-hub: the hub refused the ${stage} request (${code})`, { cause })
    this.code = code
    this.stage = stage
  }
}

/** Codes that will never succeed on a retry: credentials, or a request this hub will always reject. */
const REFUSED_CODES: ReadonlySet<string> = new Set<string>([
  HUB_ERROR_CODES.authorizationDenied,
  HUB_ERROR_CODES.invalidPayload,
  ErrorCodes.ACCESS_DENIED,
  ErrorCodes.MESSAGE_TOO_LARGE,
  // Reachable, not theoretical: the upload schema caps `keyPackages` at 50 and nothing validates
  // `target` against it, so a misconfigured pool would re-mint a doomed batch on every call.
  ErrorCodes.INVALID_MESSAGE,
])

/** Hub error class names, for an error that crossed a boundary and lost its class. */
const CODE_BY_NAME: Readonly<Record<string, HubErrorCode>> = {
  AuthorizationDeniedError: HUB_ERROR_CODES.authorizationDenied,
  HeadMismatchError: HUB_ERROR_CODES.headMismatch,
  InvalidPayloadError: HUB_ERROR_CODES.invalidPayload,
  KeyPackageFetchLimitError: HUB_ERROR_CODES.keyPackageFetchLimit,
  KeyPackageQuotaExceededError: HUB_ERROR_CODES.keyPackageQuota,
  NotSubscribedError: HUB_ERROR_CODES.notSubscribed,
  RetentionExceededError: HUB_ERROR_CODES.retentionExceeded,
  SubscriptionQuotaExceededError: HUB_ERROR_CODES.subscriptionQuota,
}

/**
 * The wire code an error carries, or null if it never reached the hub.
 *
 * `code` comes FIRST because it is the only path that works in production: `hub-client` is a
 * pass-through wrapper, so a hub answer arrives as an enkaku `RequestError` whose `code` is the wire
 * code and which is not an instance of any hub-protocol class. The class and name checks cover a
 * store error thrown in-process and an error rebuilt across a bundle boundary.
 */
function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const byClass = hubErrorCodeOf(error)
  if (byClass != null) return byClass
  return error instanceof Error ? (CODE_BY_NAME[error.name] ?? null) : null
}

/**
 * Classify a failed hub call: return it for the caller to retry, or throw because retrying is
 * pointless. Unrecognised is retryable — the cost of retrying a real refusal is a bounded schedule,
 * while the cost of not retrying a real outage is provisioning that never recovers.
 */
export function toRetryableOrThrow(error: unknown, stage: HubCallStage): HubRetryableError {
  const code = codeOf(error)
  if (code != null && REFUSED_CODES.has(code)) {
    throw new HubRefusedError(stage, code, error)
  }
  return new HubRetryableError(stage, code, error)
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm exec vitest run test/errors.test.ts
```

Expected: PASS, 15 tests.

- [ ] **Step 7: Export the classes**

In `packages/mls-hub/src/index.ts`, add above the `./join.js` export (the export blocks are sorted by
module path):

```ts
export {
  type HubCallStage,
  HubRefusedError,
  HubRetryableError,
} from './errors.js'
```

`toRetryableOrThrow` stays internal — a host classifies by catching or by reading the returned error,
never by calling the classifier itself.

- [ ] **Step 8: Verify types and the whole package**

```bash
pnpm run test:types && pnpm run test:unit
```

Expected: both PASS. No existing test changes yet, so `test:unit` should be entirely green.

- [ ] **Step 9: Lint and commit**

```bash
cd ../.. && rtk proxy pnpm run lint && cd packages/mls-hub
git add ../../pnpm-workspace.yaml ../../pnpm-lock.yaml package.json src/errors.ts src/index.ts test/errors.test.ts
git commit -m "feat(mls-hub): classify a failed hub call as retryable or refused"
```

---

## Task 2: `ensureStocked` returns a Result

**Files:**
- Modify: `packages/mls-hub/src/pool.ts`
- Modify: `packages/mls-hub/test/fixtures/hub.ts`
- Modify: `packages/mls-hub/test/pool.test.ts`
- Modify: `packages/mls-hub/test/join.test.ts` (the five `pool.ensureStocked()` call sites)

**Interfaces:**
- Consumes: `toRetryableOrThrow`, `HubRetryableError` from `./errors.js` (Task 1).
- Produces: `KeyPackagePool.ensureStocked(): AsyncResult<{ minted: number; depth: number }, HubRetryableError>`.
  Note it is **not** an `async` method — it returns the `AsyncResult` synchronously, so callers can
  write `await pool.ensureStocked().value`.

- [ ] **Step 1: Let the fixture refuse**

A refusal reaching a host is an enkaku `RequestError` carrying the wire code — not an instance of any
hub-protocol class — so the only test that proves the classifier works in production has to come
from a real hub. `createHub` takes an `authorize` hook, and `keypackage/status` is one of the actions
it covers.

In `packages/mls-hub/test/fixtures/hub.ts`, thread the hook through:

```ts
import type { AuthorizeHook } from '@kumiai/hub-server'

/** A real hub over in-process transports, plus one authenticated client for `identity`. */
export function createTestHub(
  identity: OwnIdentity = randomIdentity(),
  authorize?: AuthorizeHook,
): TestHub {
  const hubStore = createMemoryStore()
  const hubIdentity = randomIdentity()
  const serverTransports: HubTransports = new DirectTransports()
  const hub = createHub({
    transport: serverTransports.server,
    store: hubStore,
    identity: hubIdentity,
    ...(authorize == null ? {} : { authorize }),
  })
```

The rest of the function is unchanged. Spread rather than assign: `authorize: undefined` would still
be an own property, and the hub's own params treat an absent hook differently from a present one.

- [ ] **Step 2: Write the failing tests**

Append to `packages/mls-hub/test/pool.test.ts`, inside a new top-level block. `Result` is imported for
its type only where needed; these tests use the instance methods.

```ts
describe('ensureStocked failure paths', () => {
  test('a transport failure at the status stage returns a retryable error and prunes', async () => {
    const store = createMemoryKeyPackagePoolStore()
    // An expired record the prune must still remove even though the hub call failed.
    await store.put(hub.identity.id, {
      ref: 'dead',
      keyPackage: 'a',
      privatePackage: 'b',
      notAfter: Math.floor(Date.now() / 1000) - 30 * 86_400,
    })
    vi.spyOn(hub.client, 'keyPackageStatus').mockRejectedValue(new Error('socket closed'))
    const pool = createKeyPackagePool({ identity: hub.identity, client: hub.client, store })

    const result = await pool.ensureStocked()

    expect(result.isError()).toBe(true)
    expect(result.error).toBeInstanceOf(HubRetryableError)
    expect(result.error?.stage).toBe('status')
    // Prune is local and independent of the hub. A caller that only ever hits transient failures
    // would otherwise never prune at all.
    expect(await store.list(hub.identity.id)).toHaveLength(0)
  })

  test('a transport failure at the upload stage returns a retryable error and keeps the records', async () => {
    const store = createMemoryKeyPackagePoolStore()
    vi.spyOn(hub.client, 'uploadKeyPackages').mockRejectedValue(new Error('socket closed'))
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 3,
      lowWater: 2,
    })

    const result = await pool.ensureStocked()

    expect(result.isError()).toBe(true)
    expect(result.error?.stage).toBe('upload')
    // The upload may have landed. Deleting these would strand the hub serving packages whose
    // private halves are gone — the outage this store exists to prevent.
    expect(await store.list(hub.identity.id)).toHaveLength(3)
  })

  // The path a host actually hits, end to end through a real hub. The refusal arrives as an enkaku
  // RequestError whose `code` is HUB_AUTHORIZATION_DENIED and which is not an instance of
  // AuthorizationDeniedError — classifying by `instanceof` alone would return it as retryable and
  // the host would retry a settled refusal forever.
  test('a real hub refusal throws instead of returning', async () => {
    const denying = createTestHub(hub.identity, (req) => req.action !== 'keypackage/status')
    try {
      const pool = createKeyPackagePool({
        identity: denying.identity,
        client: denying.client,
        store: createMemoryKeyPackagePoolStore(),
      })

      await expect(pool.ensureStocked()).rejects.toThrow(HubRefusedError)
    } finally {
      await denying.dispose()
    }
  })

  test('a refused call reports its code and stage', async () => {
    const denying = createTestHub(hub.identity, (req) => req.action !== 'keypackage/status')
    try {
      const pool = createKeyPackagePool({
        identity: denying.identity,
        client: denying.client,
        store: createMemoryKeyPackagePoolStore(),
      })

      await pool.ensureStocked()
      expect.unreachable('expected a throw')
    } catch (error) {
      expect((error as HubRefusedError).code).toBe('HUB_AUTHORIZATION_DENIED')
      expect((error as HubRefusedError).stage).toBe('status')
    } finally {
      await denying.dispose()
    }
  })

  // An oversized batch cannot reach the store at all: the upload schema caps `keyPackages` at 50
  // entries, and nothing validates `target` against it. Retrying would re-mint a doomed batch on
  // every call, so this has to be refused rather than returned.
  test('a batch over the wire schema limit is refused', async () => {
    const store = createMemoryKeyPackagePoolStore()
    // 51 is the smallest deficit that trips the schema's `maxItems: 50`. Keep it at the minimum:
    // every extra package is real key generation.
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 51,
      lowWater: 51,
    })

    await expect(pool.ensureStocked()).rejects.toThrow(HubRefusedError)
  })

  test('a quota refusal from the real hub is retryable, not a throw', async () => {
    // Fill the hub to its per-DID cap of 100 through the raw client, then let the pool try.
    await hub.client.uploadKeyPackages(Array.from({ length: 50 }, (_, index) => `a-${index}`))
    await hub.client.uploadKeyPackages(Array.from({ length: 50 }, (_, index) => `b-${index}`))
    const store = createMemoryKeyPackagePoolStore()
    // The hub reports 100 live packages, so force a top-up by raising the floor above it.
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 110,
      lowWater: 105,
    })

    const result = await pool.ensureStocked()

    expect(result.isError()).toBe(true)
    expect(result.error).toBeInstanceOf(HubRetryableError)
    expect(result.error?.code).toBe('HUB_KEYPACKAGE_QUOTA')
  })

  test('the next call mints against the hub count rather than re-uploading a failed batch', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const upload = vi
      .spyOn(hub.client, 'uploadKeyPackages')
      .mockRejectedValueOnce(new Error('socket closed'))
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 3,
      lowWater: 2,
    })

    expect((await pool.ensureStocked()).isError()).toBe(true)
    const stranded = (await store.list(hub.identity.id)).map((record) => record.ref)

    const second = await pool.ensureStocked()

    expect(second.value).toEqual({ minted: 3, depth: 3 })
    // A fresh batch, never the stranded one: the hub does not dedupe, so re-uploading a package
    // that did land would hand one init key to two inviters.
    const secondUpload = upload.mock.calls[1]?.[0] as Array<string>
    const strandedPackages = new Set(
      (await store.list(hub.identity.id))
        .filter((record) => stranded.includes(record.ref))
        .map((record) => record.keyPackage),
    )
    expect(secondUpload.some((keyPackage) => strandedPackages.has(keyPackage))).toBe(false)
    // The stranded records survive: that upload may have landed.
    expect(await store.list(hub.identity.id)).toHaveLength(6)
  })

  test('concurrent callers share one failing run and one error instance', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const status = vi
      .spyOn(hub.client, 'keyPackageStatus')
      .mockRejectedValue(new Error('socket closed'))
    const pool = createKeyPackagePool({ identity: hub.identity, client: hub.client, store })

    const [first, second] = await Promise.all([pool.ensureStocked(), pool.ensureStocked()])

    expect(status).toHaveBeenCalledTimes(1)
    expect(first.error).toBe(second.error)
  })
})
```

Add to the imports at the top of the file:

```ts
import { HubRefusedError, HubRetryableError } from '../src/errors.js'
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
pnpm exec vitest run test/pool.test.ts -t 'ensureStocked failure paths'
```

Expected: FAIL — `result.isError is not a function`, because `ensureStocked` still resolves a plain
object.

- [ ] **Step 4: Rewrite `run` and `ensureStocked`**

In `packages/mls-hub/src/pool.ts`, add the imports:

```ts
import { AsyncResult, Result } from '@sozai/result'

import { type HubRetryableError, toRetryableOrThrow } from './errors.js'
```

Replace the `run` function and the `ensureStocked` method. Everything else in the file is unchanged.

```ts
  type StockResult = Result<{ minted: number; depth: number }, HubRetryableError>

  const run = async (): Promise<StockResult> => {
    let count: number
    try {
      ;({ count } = await client.keyPackageStatus())
    } catch (error) {
      const retryable = toRetryableOrThrow(error, 'status')
      // Prune anyway: it is local, and a caller that only ever hits transient failures would
      // otherwise never prune at all.
      await prune(await store.list(ownerDID), new Set())
      return Result.error(retryable)
    }

    let minted: Array<KeyPackageRecord> = []
    if (count < lowWater) {
      // Mint the whole deficit before uploading any of it, so one upload call carries the batch and
      // one `notAfter` describes it.
      const wanted = target - count
      // Concurrent: key generation dominates a mint, and each one writes its own ref. Store-before-
      // upload still holds — every `put` settles before the upload below.
      const records = await Promise.all(Array.from({ length: wanted }, () => mint()))
      // One expiry for the batch: they were minted together under one lifetime, and the smallest is
      // the only one that keeps the hub from serving a package the inviter would reject.
      const notAfter = Math.min(...records.map((record) => record.notAfter))
      const keepRefs = new Set(records.map((record) => record.ref))
      try {
        await client.uploadKeyPackages(
          records.map((record) => record.keyPackage),
          notAfter,
        )
      } catch (error) {
        const retryable = toRetryableOrThrow(error, 'upload')
        // The records stay: the upload may have landed, and deleting them would strand the hub
        // serving packages whose private halves are gone. `keepRefs` guards them against a forward
        // clock correction between the mint and the prune's own clock read.
        await prune(await store.list(ownerDID), keepRefs)
        return Result.error(retryable)
      }
      minted = records
    }
    // Prune on the no-op path too, or a daily caller never prunes between top-ups.
    await prune(await store.list(ownerDID), new Set(minted.map((record) => record.ref)))
    return Result.ok({ minted: minted.length, depth: count + minted.length })
  }

  return {
    ensureStocked(): AsyncResult<{ minted: number; depth: number }, HubRetryableError> {
      // Single-flight: a second caller joins the first rather than minting a competing batch against
      // the same reported depth. Cross-process overlap is undefended by design — it overshoots the
      // target, which costs cap headroom and nothing else.
      //
      // The shared promise holds a `Result`, not an `AsyncResult`, so every joiner sees the same
      // settled outcome and the same error instance. A refusal rejects it, as it should.
      if (inFlight == null) {
        const started = run().finally(() => {
          inFlight = null
        })
        inFlight = started
      }
      return new AsyncResult(inFlight)
    },
```

`bundles()` and `release()` in that same returned object are unchanged — only `ensureStocked` is
replaced, and it is no longer an `async` method, so it returns the `AsyncResult` synchronously.

Change the `inFlight` declaration to hold the `Result` promise:

```ts
  let inFlight: Promise<StockResult> | null = null
```

Note `StockResult` is a type alias declared inside `createKeyPackagePool`, above `mint`, so it can
be referenced by both `inFlight` and `run`.

Update the `ensureStocked` doc comment on the `KeyPackagePool` type:

```ts
  /**
   * Bring the hub's ordinary pool back up to `target` when it has fallen below `lowWater`, and prune
   * records whose lifetime plus the retention grace has passed. Pruning happens on every path,
   * including the failure paths — it is local and owes nothing to the hub.
   *
   * `depth` is what this call left behind — the depth the hub reported plus `minted` — not a second
   * status read.
   *
   * An error `Result` means the hub could not be reached or gave an answer that clears on its own;
   * nothing needs fixing and the next call self-corrects. A `HubRefusedError` is thrown instead,
   * because it will never succeed until the app or the operator changes something.
   */
  ensureStocked(): AsyncResult<{ minted: number; depth: number }, HubRetryableError>
```

- [ ] **Step 5: Run the new tests to verify they pass**

```bash
pnpm exec vitest run test/pool.test.ts -t 'ensureStocked failure paths'
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Migrate the existing call sites**

Every existing `await pool.ensureStocked()` now yields a `Result`. Where the test asserts the value,
read `.value` — on the error branch it throws the real error, so a broken setup stays loud:

```ts
// before
const result = await pool.ensureStocked()
expect(result).toEqual({ minted: 3, depth: 3 })

// after
const result = await pool.ensureStocked().value
expect(result).toEqual({ minted: 3, depth: 3 })
```

Where the call is setup and the result is discarded, still read `.value`, so a setup failure fails
the test instead of passing silently:

```ts
// before
await pool.ensureStocked()

// after
await pool.ensureStocked().value
```

Apply this to all 16 `ensureStocked()` sites in `test/pool.test.ts` and all 5 in `test/join.test.ts`.
Do not change what any existing assertion checks.

- [ ] **Step 7: Run the full package**

```bash
pnpm run test:types && pnpm run test:unit
```

Expected: both PASS. `test:types` is what catches a missed `.value` — vitest strips types, so the
unit run alone would not.

- [ ] **Step 8: Lint and commit**

```bash
cd ../.. && rtk proxy pnpm run lint && cd packages/mls-hub
git add src/pool.ts test/pool.test.ts test/join.test.ts
git commit -m "feat(mls-hub)!: ensureStocked returns a Result for a retryable hub failure"
```

---

## Task 3: `ensureProvisioned` returns a Result

**Files:**
- Modify: `packages/mls-hub/src/provisioner.ts`
- Modify: `packages/mls-hub/test/provisioner.test.ts`
- Modify: `packages/mls-hub/test/bundles.test.ts` (the eight `provisioner.ensureProvisioned()` sites)
- Modify: `packages/mls-hub/test/join.test.ts` (the three `provisioner.ensureProvisioned()` sites)

**Interfaces:**
- Consumes: `toRetryableOrThrow`, `HubRetryableError` from `./errors.js` (Task 1).
- Produces: `LastResortProvisioner.ensureProvisioned(): AsyncResult<{ rotated: boolean; ref: string }, HubRetryableError>`.
  Not an `async` method, matching `ensureStocked`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mls-hub/test/provisioner.test.ts`:

```ts
describe('ensureProvisioned failure paths', () => {
  test('a status failure leaves the local record intact and returns a retryable error', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })
    const { ref } = await provisioner.ensureProvisioned().value
    vi.spyOn(hub.client, 'keyPackageStatus').mockRejectedValue(new Error('socket closed'))

    const result = await provisioner.ensureProvisioned()

    expect(result.isError()).toBe(true)
    expect(result.error).toBeInstanceOf(HubRetryableError)
    expect(result.error?.stage).toBe('status')
    // The readback is skipped, not faked: the record stays exactly as it was, so the next
    // successful call performs it and repairs the slot if the hub disagrees.
    const records = await store.list(hub.identity.id)
    expect(records).toHaveLength(1)
    expect(records[0]?.ref).toBe(ref)
    expect(records[0]?.uploadedAt).not.toBeNull()
  })

  test('a status failure does not suppress the readback on the next call', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })
    const { ref } = await provisioner.ensureProvisioned().value
    // The hub loses the slot while it is unreachable.
    await hub.hubStore.storeLastResortKeyPackage(hub.identity.id, 'something-else')
    const status = vi
      .spyOn(hub.client, 'keyPackageStatus')
      .mockRejectedValueOnce(new Error('socket closed'))

    expect((await provisioner.ensureProvisioned()).isError()).toBe(true)
    const repaired = await provisioner.ensureProvisioned().value

    expect(status).toHaveBeenCalledTimes(2)
    expect(repaired).toEqual({ rotated: true, ref })
  })

  test('an upload failure returns a retryable error and leaves the record resumable', async () => {
    const store = createMemoryLastResortStore()
    vi.spyOn(hub.client, 'uploadLastResortKeyPackage').mockRejectedValue(new Error('socket closed'))
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const result = await provisioner.ensureProvisioned()

    expect(result.isError()).toBe(true)
    expect(result.error?.stage).toBe('upload')
    const records = await store.list(hub.identity.id)
    expect(records).toHaveLength(1)
    expect(records[0]?.uploadedAt).toBeNull()
  })

  test('the next call resumes the same package rather than minting', async () => {
    const store = createMemoryLastResortStore()
    const upload = vi
      .spyOn(hub.client, 'uploadLastResortKeyPackage')
      .mockRejectedValueOnce(new Error('socket closed'))
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    expect((await provisioner.ensureProvisioned()).isError()).toBe(true)
    const pending = (await store.list(hub.identity.id))[0]

    const second = await provisioner.ensureProvisioned().value

    // Re-uploading the identical package is safe because the slot replaces in place, so it does not
    // matter whether the first attempt landed.
    expect(second).toEqual({ rotated: true, ref: pending?.ref })
    expect(upload).toHaveBeenCalledTimes(2)
    expect(await store.list(hub.identity.id)).toHaveLength(1)
  })

  test('a refusal throws instead of returning', async () => {
    const store = createMemoryLastResortStore()
    vi.spyOn(hub.client, 'uploadLastResortKeyPackage').mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'HUB_AUTHORIZATION_DENIED' }),
    )
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    await expect(provisioner.ensureProvisioned()).rejects.toThrow(HubRefusedError)
  })

  test('an expired record is pruned on a failure path', async () => {
    const store = createMemoryLastResortStore()
    await store.put(hub.identity.id, {
      ref: 'dead',
      keyPackage: 'a',
      privatePackage: 'b',
      notAfter: Math.floor(Date.now() / 1000) - 120 * 86_400,
      uploadedAt: 1,
    })
    vi.spyOn(hub.client, 'uploadLastResortKeyPackage').mockRejectedValue(new Error('socket closed'))
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    expect((await provisioner.ensureProvisioned()).isError()).toBe(true)

    // Only the freshly minted record survives; the long-dead one is gone even though the hub call
    // failed.
    const records = await store.list(hub.identity.id)
    expect(records).toHaveLength(1)
    expect(records[0]?.ref).not.toBe('dead')
  })

  test('concurrent callers share one failing run and one error instance', async () => {
    const store = createMemoryLastResortStore()
    const upload = vi
      .spyOn(hub.client, 'uploadLastResortKeyPackage')
      .mockRejectedValue(new Error('socket closed'))
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const [first, second] = await Promise.all([
      provisioner.ensureProvisioned(),
      provisioner.ensureProvisioned(),
    ])

    expect(upload).toHaveBeenCalledTimes(1)
    expect(first.error).toBe(second.error)
  })
})
```

Add to the imports at the top of the file:

```ts
import { HubRefusedError, HubRetryableError } from '../src/errors.js'
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run test/provisioner.test.ts -t 'ensureProvisioned failure paths'
```

Expected: FAIL — `provisioner.ensureProvisioned(...).value is undefined` / `result.isError is not a
function`.

- [ ] **Step 3: Rewrite `run` and `ensureProvisioned`**

In `packages/mls-hub/src/provisioner.ts`, add the imports:

```ts
import { AsyncResult, Result } from '@sozai/result'

import { type HubRetryableError, toRetryableOrThrow } from './errors.js'
```

Declare the alias and change `inFlight`, above `pickCandidate`:

```ts
  type ProvisionResult = Result<{ rotated: boolean; ref: string }, HubRetryableError>

  let inFlight: Promise<ProvisionResult> | null = null
```

`upload` keeps its signature but its failure is now classified by the caller, so it is unchanged.
Replace `run` and the `ensureProvisioned` method:

```ts
  const run = async (): Promise<ProvisionResult> => {
    const records = await store.list(ownerDID)
    const candidate = pickCandidate(records)
    const nowSeconds = Math.floor(Date.now() / 1000)

    // Resume an interrupted provision rather than minting, which would orphan the pending record on
    // every retry. Only while it is still worth uploading: one already inside the rotation window
    // falls through to a mint, since finishing its upload would report success over a dead slot.
    if (
      candidate != null &&
      candidate.uploadedAt == null &&
      candidate.notAfter - nowSeconds > rotateWithinDays * DAY_SECONDS
    ) {
      try {
        await upload(candidate)
      } catch (error) {
        const retryable = toRetryableOrThrow(error, 'upload')
        await prune(records, candidate.ref)
        return Result.error(retryable)
      }
      await prune(records, candidate.ref)
      return Result.ok({ rotated: true, ref: candidate.ref })
    }

    // An expired candidate needs no special case: the difference goes negative and falls through.
    if (candidate != null && candidate.notAfter - nowSeconds > rotateWithinDays * DAY_SECONDS) {
      // The record says this package was uploaded; the hub is the only authority on whether it is
      // still there. Without this readback a hub that lost or replaced the slot is reported as
      // provisioned until the next rotation falls due — the floor is gone and nothing says so.
      // Re-uploading is safe here precisely because the slot replaces in place, which is why the
      // ordinary pool cannot do the same thing.
      let lastResort: string | null
      try {
        ;({ lastResort } = await client.keyPackageStatus())
      } catch (error) {
        const retryable = toRetryableOrThrow(error, 'status')
        // Skip the repair, write nothing that would suppress it: the record is left exactly as it
        // was, so the next successful call performs the readback instead.
        await prune(records, candidate.ref)
        return Result.error(retryable)
      }
      if (lastResort !== (await keyPackageDigest(candidate.keyPackage))) {
        try {
          await upload(candidate)
        } catch (error) {
          const retryable = toRetryableOrThrow(error, 'upload')
          await prune(records, candidate.ref)
          return Result.error(retryable)
        }
        await prune(records, candidate.ref)
        return Result.ok({ rotated: true, ref: candidate.ref })
      }
      // Prune on the no-op path too, or a daily caller never prunes between 90-day rotations.
      await prune(records, candidate.ref)
      return Result.ok({ rotated: false, ref: candidate.ref })
    }

    const minted = await mint()
    try {
      await upload(minted)
    } catch (error) {
      const retryable = toRetryableOrThrow(error, 'upload')
      // `minted.ref` is kept: a forward clock correction between the mint and the prune's own clock
      // read could otherwise put the just-minted record past the cutoff and delete the private half
      // of a package the hub may already be serving.
      await prune([...records, minted], minted.ref)
      return Result.error(retryable)
    }
    await prune([...records, minted], minted.ref)
    return Result.ok({ rotated: true, ref: minted.ref })
  }

  return {
    ensureProvisioned(): AsyncResult<{ rotated: boolean; ref: string }, HubRetryableError> {
      // Single-flight: a second caller joins the first instead of minting a competing package.
      // Cross-process overlap is undefended by design — it yields one occupied slot and two valid
      // retained records.
      //
      // The shared promise holds a `Result`, so every joiner sees the same settled outcome and the
      // same error instance. A refusal rejects it, as it should.
      if (inFlight == null) {
        const started = run().finally(() => {
          inFlight = null
        })
        inFlight = started
      }
      return new AsyncResult(inFlight)
    },
```

`bundles()` and `release()` in that same returned object are unchanged — only `ensureProvisioned` is
replaced, and it is no longer an `async` method.

Update the `ensureProvisioned` doc comment on the `LastResortProvisioner` type:

```ts
  /**
   * Bring the hub's last-resort slot up to date, doing nothing when it already is.
   *
   * `rotated` means the slot was written by this call — a fresh mint or a resumed upload.
   * `ref` names the package this call left in the slot. Pruning happens on every path, including
   * the failure paths — it is local and owes nothing to the hub.
   *
   * An error `Result` means the hub could not be reached or gave an answer that clears on its own:
   * the local record is left untouched, so the next call redoes the readback and repairs the slot
   * if the hub disagrees. A `HubRefusedError` is thrown instead, because it will never succeed
   * until the app or the operator changes something.
   */
  ensureProvisioned(): AsyncResult<{ rotated: boolean; ref: string }, HubRetryableError>
```

- [ ] **Step 4: Run the new tests to verify they pass**

```bash
pnpm exec vitest run test/provisioner.test.ts -t 'ensureProvisioned failure paths'
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Migrate the existing call sites**

Same migration as Task 2 Step 5: read `.value` at every existing call, whether the result is asserted
or discarded.

```ts
// before
const settled = await provisioner.ensureProvisioned()
// after
const settled = await provisioner.ensureProvisioned().value

// before
const { ref } = await provisioner.ensureProvisioned()
// after
const { ref } = await provisioner.ensureProvisioned().value
```

Apply to all 39 sites in `test/provisioner.test.ts`, the 8 in `test/bundles.test.ts`, and the 3 in
`test/join.test.ts`. Do not change what any existing assertion checks.

- [ ] **Step 6: Run the full package**

```bash
pnpm run test:types && pnpm run test:unit
```

Expected: both PASS.

- [ ] **Step 7: Lint and commit**

```bash
cd ../.. && rtk proxy pnpm run lint && cd packages/mls-hub
git add src/provisioner.ts test/provisioner.test.ts test/bundles.test.ts test/join.test.ts
git commit -m "feat(mls-hub)!: ensureProvisioned returns a Result for a retryable hub failure"
```

---

## Task 4: Documentation, changeset, and the deferred question

**Files:**
- Modify: `packages/mls-hub/README.md`
- Create: `.changeset/provisioning-retryable-result.md`
- Create: `docs/agents/plans/next/2026-07-28-stack-wide-result-adoption.md`

**Interfaces:**
- Consumes: the final public surface from Tasks 1-3.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Update the README exports section**

In `packages/mls-hub/README.md`, extend the `createKeyPackagePool` bullet with its new return, and
the `createLastResortProvisioner` bullet likewise. Add these sentences to the respective bullets:

For `createKeyPackagePool`: after "…and prunes retained records past their lifetime plus the grace.",
insert:

> `ensureStocked()` returns an `AsyncResult` — see *Retryable and refused* below. Pruning runs on
> every path, including the failure paths.

For `createLastResortProvisioner`: after "…rather than trusting `uploadedAt` alone.", insert:

> `ensureProvisioned()` returns an `AsyncResult` — see *Retryable and refused* below. A hub it
> cannot reach leaves the local record untouched, so the next call redoes the readback.

Add `HubRetryableError`, `HubRefusedError`, and `HubCallStage` to the exports list as their own
bullet:

```md
- `HubRetryableError`, `HubRefusedError`, `HubCallStage` — the two outcomes of a failed hub call.
```

- [ ] **Step 2: Add the README section**

Insert a new section immediately before `## ⚠️ Security: the store holds private key material`:

````md
## Retryable and refused

Both entry points return `AsyncResult` from `@sozai/result`. The success types are unchanged —
`{ minted, depth }` and `{ rotated, ref }` — and no field ever holds a placeholder for something the
hub never confirmed.

```ts
const result = await pool.ensureStocked()
if (result.isError()) {
  // The hub could not be reached, or answered something that clears on its own. Nothing to fix:
  // the next call re-reads the hub and self-corrects.
}
// Or, to let a failure propagate: `await pool.ensureStocked().value`
```

A `HubRefusedError` is **thrown** rather than returned. The split is by what the caller must do: an
unhandled throw is surfaced, which is right for something that needs credentials or configuration
changed; an unhandled retryable failure would surface as a crash, which is wrong for something whose
correct response is to carry on and try later. `HubRefusedError` carries `code` and `stage`, so a
host that disagrees can catch and downgrade deliberately.

Refused today: `HUB_AUTHORIZATION_DENIED`, `HUB_INVALID_PAYLOAD`, and enkaku's `EK02`, `EK06`, and
`EK08`. `EK08` is how an oversized batch fails — the upload schema caps `keyPackages` at 50 entries,
so a `target` above that never succeeds. Everything else, including `HUB_KEYPACKAGE_QUOTA` and every
transport failure, is retryable: a cap clears as packages are consumed or expire.

**Call these on a cadence, not only at startup.** The self-healing depends on it. Nothing is written
on a failure path that would suppress a later check, so a hub outage costs nothing as long as a
later call happens — but a host that provisions once at startup and never again degrades silently,
and the damage lands on whoever tries to invite the user next.

An unreachable hub costs the user nothing while it lasts: an inviter fetches key packages through
the same hub, so a top-up that fails during an outage denies nobody anything. That is why failing
startup over it would be the worse trade.
````

- [ ] **Step 3: Write the changeset**

Create `.changeset/provisioning-retryable-result.md`:

```md
---
'@kumiai/mls-hub': minor
---

`KeyPackagePool.ensureStocked()` and `LastResortProvisioner.ensureProvisioned()` now return an
`AsyncResult` from `@sozai/result` rather than a bare promise. A hub that cannot be reached, or that
answers something which clears on its own (a key-package quota), is returned as a
`HubRetryableError` for the caller to retry later; a settled refusal — authorization denied, an
invalid payload, an oversized batch — throws a `HubRefusedError` carrying its wire code and the
stage it failed at.

Both were previously all-or-nothing throws, and `ensureProvisioned()` in particular could fail an
app's startup over a transient outage during a call that used to be entirely local. Pruning now runs
on every path, including the failure paths.

Migration: read `.value` where the returned value was used directly
(`await pool.ensureStocked().value`), or branch on `result.isError()` to carry on through an outage.
```

- [ ] **Step 4: Record the deferred question**

Create `docs/agents/plans/next/2026-07-28-stack-wide-result-adoption.md`:

```md
# Should the rest of kumiai return Results too

**Priority:** low — a design question, not a defect. Needs brainstorming, not a patch.
**Origin:** scoped out of `feat/provisioning-retryable-result` (2026-07-28); see
`docs/superpowers/specs/2026-07-28-provisioning-retryable-result-design.md`.

`@kumiai/mls-hub` now returns `AsyncResult` from its two provisioning entry points, splitting a
retryable hub failure from a settled refusal. It is the only package in kumiai that does. The
question is whether that pattern earns its keep anywhere else.

## Why it was not swept across

A blanket conversion would move 156 `throw new` sites, both conformance suites, and every double
behind them. Most of those throws are broken invariants rather than outcomes a caller chooses
between — constructor validation, a store record that fails its own round-trip contract, an
unauthenticated message. `Result` is for expected failure paths; converting by grep would drown the
signal.

The rule `mls-hub` adopted is also domain-specific. Retryable-versus-refused came from the hub's
error taxonomy and from the fact that an unreachable hub costs a user nothing while it lasts.
`@kumiai/mls`'s crypto failures do not split that way and would need their own classification.

## What to decide

- Which failures elsewhere in the stack are genuinely *expected* — a caller picks between outcomes —
  rather than invariant violations.
- Whether `@kumiai/rpc`'s existing `isPermanentSubscribeFailure` (`packages/rpc/src/hub-mux.ts:255`)
  should be expressed the same way, given it already encodes the identical rule internally.
- How the conformance suites express a `Result`-returning port, since every double must match.
- Note that `@sozai/result` is used by exactly one package in sozai itself, so kumiai would be
  setting the stack's precedent rather than following it.

Read what `mls-hub` actually cost before deciding: that is the point of having done it first.
```

- [ ] **Step 5: Verify the whole package one more time**

```bash
pnpm run test:types && pnpm run test:unit
```

Expected: both PASS.

- [ ] **Step 6: Lint and commit**

```bash
cd ../.. && rtk proxy pnpm run lint && cd packages/mls-hub
git add README.md ../../.changeset/provisioning-retryable-result.md ../../docs/agents/plans/next/2026-07-28-stack-wide-result-adoption.md
git commit -m "docs(mls-hub): document the retryable/refused split"
```

---

## Verification

After all four tasks, from the repo root:

```bash
pnpm run test
```

`pnpm test` reports cached turbo results. Confirm the run was real — the summary must show
`Cached: 0`. Note that `pnpm test -- --force` does not work here; force it via turbo directly if the
cache needs busting.

```bash
rtk proxy pnpm run lint
```

Expected: clean. The plain `pnpm run lint` and `pnpm exec biome` are both intercepted by a local shim
and will report misleading output.
