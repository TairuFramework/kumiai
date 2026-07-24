# Hub key-package + subscribe caps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks

**Goal:** Close the P4 DoS-hardening findings on the hub — key-package drain, unbounded per-DID state, un-pruned rate-limit buckets, and a mislatched subscribe-authz refusal.

**Architecture:** Named hub errors carry refusals across the tunnel (Task 1). The subscribe-authz refusal becomes permanent in the client mux (Task 2). Per-DID memory is bounded where the counts live — the store — as a port invariant with conformance coverage (Task 3). The rate limiter prunes idle buckets (Task 4). The handlers dispatch authorize for the newly-gated actions, rate-limit the mutating ones, and add a per-target-DID key-package consumption quota (Task 5).

**Tech Stack:** TypeScript, Vitest, pnpm workspace. Packages: `@kumiai/hub-protocol`, `@kumiai/hub-server`, `@kumiai/hub-conformance`, `@kumiai/rpc`.

## Global Constraints

- pnpm only. Run scripts as `rtk proxy pnpm run <script>` or invoke tools directly (`pnpm exec biome check`, `pnpm exec vitest`).
- Do not edit generated files (`lib/`).
- Cross-repo deps (`@sozai/*`, `@kokuin/*`, `@enkaku/*`) go through the workspace catalog as published `^` ranges. Internal `@kumiai/*` deps are `workspace:^`.
- Changing the `HubStore` port means running **both** contract suites against the real implementation and the doubles (`docs/agents/architecture.md`). In this repo that is `hub-server/test/conformance.test.ts` (memoryStore) and `hub-server/test/log-hub-conformance.test.ts`.
- All new config knobs are optional with defaults; never a required breaking field.
- Design defaults (verbatim): `maxKeyPackagesPerDID` = 100, `maxSubscriptionsPerDID` = 1000, `maxPerTargetConsumed` = 60, shared `windowMs` = 60_000, bucket-prune `ttlMs` = 300_000.
- Tests use `vi.useFakeTimers()` / `vi.setSystemTime(0)` for any `Date.now()`-driven behaviour, mirroring `hub-server/test/rateLimit.test.ts`.

---

### Task 1: Named hub errors for refusals and quotas

**Files:**
- Modify: `packages/hub-protocol/src/errors.ts`
- Test: `packages/hub-protocol/test/errors.test.ts`

**Interfaces:**
- Consumes: existing `HUB_ERROR_CODES`, `hubErrorCodeOf`, `hubErrorFromCode`.
- Produces (later tasks import these from `@kumiai/hub-protocol`):
  - `class AuthorizationDeniedError extends Error` — `name = 'AuthorizationDeniedError'`, code `HUB_AUTHORIZATION_DENIED`.
  - `class KeyPackageQuotaExceededError extends Error` — `name = 'KeyPackageQuotaExceededError'`, code `HUB_KEYPACKAGE_QUOTA`.
  - `class SubscriptionQuotaExceededError extends Error` — `name = 'SubscriptionQuotaExceededError'`, code `HUB_SUBSCRIPTION_QUOTA`.
  - `class KeyPackageFetchLimitError extends Error` — `name = 'KeyPackageFetchLimitError'`, code `HUB_KEYPACKAGE_FETCH_LIMIT`.
  - Each round-trips through `hubErrorCodeOf` / `hubErrorFromCode`.

- [ ] **Step 1: Write the failing test**

Append to `packages/hub-protocol/test/errors.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import {
  AuthorizationDeniedError,
  HUB_ERROR_CODES,
  hubErrorCodeOf,
  hubErrorFromCode,
  KeyPackageFetchLimitError,
  KeyPackageQuotaExceededError,
  SubscriptionQuotaExceededError,
} from '../src/errors.js'

describe('DoS-hardening hub errors round-trip through their wire codes', () => {
  const cases = [
    [new AuthorizationDeniedError('no'), HUB_ERROR_CODES.authorizationDenied, 'AuthorizationDeniedError'],
    [new KeyPackageQuotaExceededError('full'), HUB_ERROR_CODES.keyPackageQuota, 'KeyPackageQuotaExceededError'],
    [new SubscriptionQuotaExceededError('full'), HUB_ERROR_CODES.subscriptionQuota, 'SubscriptionQuotaExceededError'],
    [new KeyPackageFetchLimitError('slow down'), HUB_ERROR_CODES.keyPackageFetchLimit, 'KeyPackageFetchLimitError'],
  ] as const

  test.each(cases)('%o carries %s and rebuilds with name %s', (error, code, name) => {
    expect(hubErrorCodeOf(error)).toBe(code)
    const rebuilt = hubErrorFromCode(code, error.message)
    expect(rebuilt).toBeInstanceOf(Error)
    expect(rebuilt?.name).toBe(name)
    expect(rebuilt?.message).toBe(error.message)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/errors.test.ts` (from `packages/hub-protocol`)
Expected: FAIL — `AuthorizationDeniedError` and the new codes are not exported.

- [ ] **Step 3: Add the classes and wire codes**

In `packages/hub-protocol/src/errors.ts`, extend `HUB_ERROR_CODES`:

```ts
export const HUB_ERROR_CODES = {
  headMismatch: 'HUB_HEAD_MISMATCH',
  notSubscribed: 'HUB_NOT_SUBSCRIBED',
  retentionExceeded: 'HUB_RETENTION_EXCEEDED',
  invalidPayload: 'HUB_INVALID_PAYLOAD',
  authorizationDenied: 'HUB_AUTHORIZATION_DENIED',
  keyPackageQuota: 'HUB_KEYPACKAGE_QUOTA',
  subscriptionQuota: 'HUB_SUBSCRIPTION_QUOTA',
  keyPackageFetchLimit: 'HUB_KEYPACKAGE_FETCH_LIMIT',
} as const
```

Add the classes after `InvalidPayloadError`:

```ts
/** An authorize hook refused the request. A settled answer, not a transient failure: the caller
 * must not retry it as though the hub were unreachable. */
export class AuthorizationDeniedError extends Error {
  override name = 'AuthorizationDeniedError'
}

/** An upload would push a DID's stored key packages past the hub's per-DID cap. Rejected, not
 * evicted: dropping an existing package would discard one the owner expects to be consumed. */
export class KeyPackageQuotaExceededError extends Error {
  override name = 'KeyPackageQuotaExceededError'
}

/** A subscribe would push a DID past the hub's per-DID subscription cap. */
export class SubscriptionQuotaExceededError extends Error {
  override name = 'SubscriptionQuotaExceededError'
}

/** A key-package fetch was throttled — the per-requester window or the per-target consumption
 * quota is exhausted. */
export class KeyPackageFetchLimitError extends Error {
  override name = 'KeyPackageFetchLimitError'
}
```

Extend `hubErrorCodeOf` (add before `return null`):

```ts
  if (error instanceof AuthorizationDeniedError) return HUB_ERROR_CODES.authorizationDenied
  if (error instanceof KeyPackageQuotaExceededError) return HUB_ERROR_CODES.keyPackageQuota
  if (error instanceof SubscriptionQuotaExceededError) return HUB_ERROR_CODES.subscriptionQuota
  if (error instanceof KeyPackageFetchLimitError) return HUB_ERROR_CODES.keyPackageFetchLimit
```

Extend `hubErrorFromCode` (add before `default`):

```ts
    case HUB_ERROR_CODES.authorizationDenied:
      return new AuthorizationDeniedError(message)
    case HUB_ERROR_CODES.keyPackageQuota:
      return new KeyPackageQuotaExceededError(message)
    case HUB_ERROR_CODES.subscriptionQuota:
      return new SubscriptionQuotaExceededError(message)
    case HUB_ERROR_CODES.keyPackageFetchLimit:
      return new KeyPackageFetchLimitError(message)
```

- [ ] **Step 4: Re-export from the package index**

In `packages/hub-protocol/src/index.ts`, add the four class names to the existing `errors.js` re-export block (alongside `RetentionExceededError`).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run test/errors.test.ts` (from `packages/hub-protocol`)
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm exec tsc --noEmit` (from `packages/hub-protocol`)
Expected: no errors.

```bash
git add packages/hub-protocol/src/errors.ts packages/hub-protocol/src/index.ts packages/hub-protocol/test/errors.test.ts
git commit -m "feat(hub-protocol): named errors for authz, quotas, and fetch limits"
```

---

### Task 2: Subscribe-authz refusal latches permanent in the mux

**Files:**
- Modify: `packages/rpc/src/hub-mux.ts:247-256` (`isPermanentSubscribeFailure`)
- Modify: `packages/rpc/test/fixtures/fake-hub.ts` (add a permanent-refusal injection)
- Test: `packages/rpc/test/hub-mux-subscribe-failure.test.ts`

**Interfaces:**
- Consumes: `AuthorizationDeniedError` from `@kumiai/hub-protocol` (Task 1).
- Produces: `FakeHub.refuseSubscribeWith(topicID: string, error: Error)` — the next subscribe to `topicID` throws `error` synchronously.

- [ ] **Step 1: Add the permanent-refusal injection to FakeHub**

In `packages/rpc/test/fixtures/fake-hub.ts`, add a field beside `#transientFailures`:

```ts
  /** A permanent refusal (an ANSWER, not a transport drop) to throw on the next subscribe. */
  #permanentRefusals = new Map<string, Error>()
```

Add the method beside `failSubscribeOnce`:

```ts
  /**
   * Make the next subscribe to `topicID` throw `error` — a hub that has ANSWERED (e.g. an
   * authorization refusal), which the mux must not retry. Distinct from `failSubscribeOnce`, a
   * transport drop that must be retried.
   */
  refuseSubscribeWith(topicID: string, error: Error): void {
    this.#permanentRefusals.set(topicID, error)
  }
```

In `subscribe`, after the transient-failure block and before the retention check:

```ts
    const refusal = this.#permanentRefusals.get(topicID)
    if (refusal != null) {
      this.#permanentRefusals.delete(topicID)
      throw refusal
    }
```

- [ ] **Step 2: Write the failing test**

Append to the `describe('a subscribe the hub refuses', ...)` block in `packages/rpc/test/hub-mux-subscribe-failure.test.ts`:

```ts
  test('an authorization refusal is permanent — no retry storm, latched as answered', async () => {
    const hub = new FakeHub({ maxRetention: 100 })
    const failures: Array<SubscribeFailure> = []
    const mux = createHubMux({
      hub,
      localDID: 'bob',
      onSubscribeFailed: (failure) => failures.push(failure),
      subscribeRetryDelaysMs: FAST_RETRIES,
    })

    hub.refuseSubscribeWith('topic:authz', new AuthorizationDeniedError('policy says no'))
    mux.retainTopic('topic:authz', { retention: 50 })
    await flush()

    expect(hub.subscriberCount('topic:authz')).toBe(0)
    // Exactly one attempt: a permanent refusal is not re-driven through the retry schedule.
    expect(hub.subscribeAttempts('topic:authz')).toBe(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.permanent).toBe(true)
    expect(failures[0]?.error).toBeInstanceOf(AuthorizationDeniedError)
  })

  test('an authorization refusal rebuilt from its wire code is still permanent (tunnel path)', async () => {
    const hub = new FakeHub({ maxRetention: 100 })
    const failures: Array<SubscribeFailure> = []
    const mux = createHubMux({
      hub,
      localDID: 'bob',
      onSubscribeFailed: (failure) => failures.push(failure),
      subscribeRetryDelaysMs: FAST_RETRIES,
    })

    // A hub reached over the tunnel rebuilds the error from its wire code; instanceof alone would
    // miss it if two hub-protocol copies were bundled. The name check must carry it.
    const rebuilt = hubErrorFromCode(HUB_ERROR_CODES.authorizationDenied, 'policy says no')
    hub.refuseSubscribeWith('topic:authz2', rebuilt as Error)
    mux.retainTopic('topic:authz2', { retention: 50 })
    await flush()

    expect(hub.subscribeAttempts('topic:authz2')).toBe(1)
    expect(failures[0]?.permanent).toBe(true)
  })
```

Update the test file imports:

```ts
import {
  AuthorizationDeniedError,
  HUB_ERROR_CODES,
  hubErrorFromCode,
  NotSubscribedError,
  RetentionExceededError,
} from '@kumiai/hub-protocol'
```

Confirm `FakeHub` exposes `subscribeAttempts(topicID)`; if it exposes only `#subscribeAttempts`, add a reader:

```ts
  subscribeAttempts(topicID: string): number {
    return this.#subscribeAttempts.get(topicID) ?? 0
  }
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run test/hub-mux-subscribe-failure.test.ts` (from `packages/rpc`)
Expected: FAIL — `permanent` is `false` (refusal treated transient), attempts > 1.

- [ ] **Step 4: Teach `isPermanentSubscribeFailure` the authz refusal**

In `packages/rpc/src/hub-mux.ts`, import `AuthorizationDeniedError` from `@kumiai/hub-protocol` (add to the existing import) and extend the predicate:

```ts
function isPermanentSubscribeFailure(error: unknown): boolean {
  // Name as well as instance: a hub reached over the tunnel rebuilds the error from its wire code
  // (`hubErrorFromCode`), and a host bundling two copies of hub-protocol would break `instanceof`
  // alone — turning a permanent refusal back into a retry loop, silently.
  return (
    error instanceof RetentionExceededError ||
    error instanceof AuthorizationDeniedError ||
    (error instanceof Error &&
      (error.name === 'RetentionExceededError' || error.name === 'AuthorizationDeniedError'))
  )
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run test/hub-mux-subscribe-failure.test.ts` (from `packages/rpc`)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/rpc/src/hub-mux.ts packages/rpc/test/fixtures/fake-hub.ts packages/rpc/test/hub-mux-subscribe-failure.test.ts
git commit -m "fix(rpc): treat a subscribe authorization refusal as permanent"
```

---

### Task 3: Per-DID store caps (key packages, subscriptions) as a port invariant

**Files:**
- Modify: `packages/hub-server/src/memoryStore.ts` (options + `subscribe` + `storeKeyPackage` + reverse index)
- Modify: `packages/hub-conformance/src/index.ts` (new optional params + clauses)
- Modify: `packages/hub-server/test/conformance.test.ts` (pass caps)
- Modify: `packages/hub-protocol/src/types.ts` (document the invariants on `HubStore`)

**Interfaces:**
- Consumes: `KeyPackageQuotaExceededError`, `SubscriptionQuotaExceededError` (Task 1).
- Produces:
  - `MemoryStoreOptions` gains `maxKeyPackagesPerDID?: number` (default 100) and `maxSubscriptionsPerDID?: number` (default 1000).
  - `store.storeKeyPackage(did, kp)` rejects with `KeyPackageQuotaExceededError` when the DID already holds `maxKeyPackagesPerDID`.
  - `store.subscribe(...)` rejects with `SubscriptionQuotaExceededError` when the DID already holds `maxSubscriptionsPerDID` distinct topics (a re-subscribe to a topic the DID already holds does NOT count against the cap).
  - `HubStoreConformanceParams` gains `maxKeyPackagesPerDID?: number` and `maxSubscriptionsPerDID?: number`; when present, the corresponding cap clauses run.

- [ ] **Step 1: Write the failing conformance clauses**

In `packages/hub-conformance/src/index.ts`, extend `HubStoreConformanceParams`:

```ts
  /**
   * The per-DID key-package storage cap `createStore` is configured with. Omit to skip the
   * key-package quota clause. When present, the store must reject an upload past this many stored
   * packages for one owner with `KeyPackageQuotaExceededError`.
   */
  maxKeyPackagesPerDID?: number
  /**
   * The per-DID subscription cap `createStore` is configured with. Omit to skip the subscription
   * quota clause. When present, the store must reject a subscribe past this many distinct topics
   * for one DID with `SubscriptionQuotaExceededError`.
   */
  maxSubscriptionsPerDID?: number
```

Destructure them in `testHubStoreConformance`:

```ts
  const { createStore, maxRetention, maxDepth, maxKeyPackagesPerDID, maxSubscriptionsPerDID } = params
```

Import the two error classes at the top:

```ts
import {
  HeadMismatchError,
  KeyPackageQuotaExceededError,
  NotSubscribedError,
  RetentionExceededError,
  SubscriptionQuotaExceededError,
} from '@kumiai/hub-protocol'
```

Add, inside the `describe('HubStore conformance', ...)` block:

```ts
    if (maxKeyPackagesPerDID != null) {
      test('an upload past the per-DID key-package cap is rejected, not evicted', async () => {
        const store = await createStore()
        for (let i = 0; i < maxKeyPackagesPerDID; i++) {
          await store.storeKeyPackage(ALICE, `kp-${i}`)
        }
        await expect(store.storeKeyPackage(ALICE, 'kp-overflow')).rejects.toThrow(
          KeyPackageQuotaExceededError,
        )
        // Reject, not evict: the earliest package is still there to be consumed.
        expect(await store.fetchKeyPackages(ALICE, 1)).toEqual(['kp-0'])
        // The cap is per DID: a different owner is unaffected.
        await expect(store.storeKeyPackage(BOB, 'kp-bob')).resolves.toBeUndefined()
      })
    }

    if (maxSubscriptionsPerDID != null) {
      test('a subscribe past the per-DID subscription cap is rejected', async () => {
        const store = await createStore()
        for (let i = 0; i < maxSubscriptionsPerDID; i++) {
          await store.subscribe({ subscriberDID: ALICE, topicID: `topic:${i}` })
        }
        await expect(
          store.subscribe({ subscriberDID: ALICE, topicID: 'topic:overflow' }),
        ).rejects.toThrow(SubscriptionQuotaExceededError)
        // Re-subscribing to a topic ALICE already holds does not count against the cap.
        await expect(
          store.subscribe({ subscriberDID: ALICE, topicID: 'topic:0' }),
        ).resolves.toBeUndefined()
        // The cap is per DID.
        await expect(
          store.subscribe({ subscriberDID: BOB, topicID: 'topic:overflow' }),
        ).resolves.toBeUndefined()
      })
    }
```

- [ ] **Step 2: Wire small caps into the memoryStore conformance run**

In `packages/hub-server/test/conformance.test.ts`:

```ts
const MAX_KEYPACKAGES = 3
const MAX_SUBSCRIPTIONS = 4

testHubStoreConformance({
  createStore: () =>
    createMemoryStore({
      maxDepth: MAX_DEPTH,
      retention: { max: MAX_RETENTION },
      maxKeyPackagesPerDID: MAX_KEYPACKAGES,
      maxSubscriptionsPerDID: MAX_SUBSCRIPTIONS,
    }),
  maxRetention: MAX_RETENTION,
  maxDepth: MAX_DEPTH,
  maxKeyPackagesPerDID: MAX_KEYPACKAGES,
  maxSubscriptionsPerDID: MAX_SUBSCRIPTIONS,
})
```

- [ ] **Step 3: Run to verify the new clauses fail**

Run: `pnpm exec vitest run test/conformance.test.ts` (from `packages/hub-server`)
Expected: FAIL — memoryStore does not yet enforce either cap.

- [ ] **Step 4: Enforce the caps in memoryStore**

In `packages/hub-server/src/memoryStore.ts`:

Import the errors (add to the existing `@kumiai/hub-protocol` import):

```ts
import { KeyPackageQuotaExceededError, SubscriptionQuotaExceededError } from '@kumiai/hub-protocol'
```

Extend `MemoryStoreOptions`:

```ts
  /** Max key packages stored per owner DID before an upload is rejected. Default: 100. */
  maxKeyPackagesPerDID?: number
  /** Max distinct topics one DID may subscribe to before a subscribe is rejected. Default: 1000. */
  maxSubscriptionsPerDID?: number
```

Inside `createMemoryStore`, read the caps and add the reverse index near the other top-level maps:

```ts
  const maxKeyPackagesPerDID = options.maxKeyPackagesPerDID ?? 100
  const maxSubscriptionsPerDID = options.maxSubscriptionsPerDID ?? 1000
  // Reverse index for an O(1) per-DID subscription count. Kept in lockstep with `subscriptions`.
  const subsByDID = new Map<string, Set<string>>()
```

In `subscribe`, after the retention check and before touching `subscriptions`:

```ts
      const held = subsByDID.get(params.subscriberDID)
      const alreadyHeld = held?.has(params.topicID) ?? false
      if (!alreadyHeld && (held?.size ?? 0) >= maxSubscriptionsPerDID) {
        throw new SubscriptionQuotaExceededError(
          `DID ${params.subscriberDID} exceeds the maximum of ${maxSubscriptionsPerDID} subscriptions`,
        )
      }
```

At the end of `subscribe`, after `subscribers.set(...)`:

```ts
      let ownTopics = subsByDID.get(params.subscriberDID)
      if (ownTopics == null) {
        ownTopics = new Set()
        subsByDID.set(params.subscriberDID, ownTopics)
      }
      ownTopics.add(params.topicID)
```

In `unsubscribe`, after `subscribers.delete(subscriberDID)`:

```ts
      const ownTopics = subsByDID.get(subscriberDID)
      if (ownTopics != null) {
        ownTopics.delete(topicID)
        if (ownTopics.size === 0) subsByDID.delete(subscriberDID)
      }
```

In `storeKeyPackage`, before `packages.push(keyPackage)`:

```ts
      if (packages.length >= maxKeyPackagesPerDID) {
        throw new KeyPackageQuotaExceededError(
          `DID ${ownerDID} exceeds the maximum of ${maxKeyPackagesPerDID} stored key packages`,
        )
      }
```

Note: the `let packages = keyPackages.get(ownerDID)` create-if-absent block must run before the cap check so a first upload for a new owner still works; keep the push last.

- [ ] **Step 5: Run to verify the caps pass**

Run: `pnpm exec vitest run test/conformance.test.ts` (from `packages/hub-server`)
Expected: PASS, including the two new clauses.

- [ ] **Step 6: Document the invariants on the port**

In `packages/hub-protocol/src/types.ts`, extend the doc comments on `storeKeyPackage` and `subscribe` in the `HubStore` type to state the rejection invariants (so a future store implementer honours them and conformance is not a surprise):

```ts
  /** Store one key package for later retrieval. A store MAY cap per-owner storage and reject an
   * upload past its cap with `KeyPackageQuotaExceededError` (rejected, never evicted). */
  storeKeyPackage(ownerDID: string, keyPackage: string): Promise<void>
```

```ts
  /** Record a subscription. A store MAY cap the distinct topics one DID may subscribe to and
   * reject a subscribe past its cap with `SubscriptionQuotaExceededError`. A re-subscribe to a
   * topic the DID already holds never counts against the cap. */
  subscribe(params: SubscribeParams): Promise<void>
```

- [ ] **Step 7: Run the full contract surface + commit**

Run (from `packages/hub-server`): `pnpm exec vitest run test/conformance.test.ts test/log-hub-conformance.test.ts test/memoryStore.test.ts`
Expected: PASS. (`log-hub-conformance` omits the cap params, so the cap clauses are skipped there — no regression.)

```bash
git add packages/hub-server/src/memoryStore.ts packages/hub-conformance/src/index.ts packages/hub-server/test/conformance.test.ts packages/hub-protocol/src/types.ts
git commit -m "feat(hub-server): per-DID key-package and subscription caps"
```

---

### Task 4: Prune idle rate-limit buckets

**Files:**
- Modify: `packages/hub-server/src/rateLimit.ts`
- Test: `packages/hub-server/test/rateLimit.test.ts`

**Interfaces:**
- Consumes: existing `RateLimitConfig`, `createRateLimiter`.
- Produces: `RateLimitConfig` gains `ttlMs?: number` (default 300_000). A bucket at full capacity (tokens refilled to `burst`) that has not been touched for `ttlMs` is evicted opportunistically on `tryConsume`, once the bucket map exceeds an internal size threshold (1024). Eviction is behaviourally transparent: a re-created bucket starts full, identical to an untouched idle one.

- [ ] **Step 1: Write the failing test**

Add to `packages/hub-server/test/rateLimit.test.ts` inside the `describe`:

```ts
  test('evicts idle full buckets past the TTL, keeps buckets with spent tokens', () => {
    const limiter = createRateLimiter({ rate: 1, burst: 2, ttlMs: 1000 }) as ReturnType<
      typeof createRateLimiter
    > & { size(): number }

    // 1025 distinct idle keys: each consumes once then refills to full within the TTL window is
    // NOT what we want — consume once leaves them below burst, so they are NOT idle. Instead we
    // want full buckets: create them, then let them refill to full before the prune fires.
    for (let i = 0; i < 1025; i++) limiter.tryConsume(`k${i}`)
    // Every bucket now has burst-1 tokens (spent one). Refill them to full.
    vi.advanceTimersByTime(2000)
    // A touch on a fresh key past the threshold triggers the prune; the 1025 full+expired buckets go.
    limiter.tryConsume('trigger')
    expect(limiter.size()).toBeLessThan(1025)

    // A bucket with spent tokens (not full) is never evicted even if old.
    const l2 = createRateLimiter({ rate: 1, burst: 3, ttlMs: 1000 }) as ReturnType<
      typeof createRateLimiter
    > & { size(): number }
    for (let i = 0; i < 1025; i++) l2.tryConsume(`k${i}`) // each now at 2 tokens (spent 1)
    vi.advanceTimersByTime(500) // +0.5 token, still below burst=3, still non-idle
    l2.tryConsume('trigger')
    expect(l2.size()).toBe(1026) // nothing pruned: none are full
  })
```

Add a `size()` reader to the returned limiter (test-only introspection is acceptable; it is cheap and harmless in production).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/rateLimit.test.ts` (from `packages/hub-server`)
Expected: FAIL — no `ttlMs`, no `size()`, no pruning.

- [ ] **Step 3: Implement pruning**

Rewrite `packages/hub-server/src/rateLimit.ts`:

```ts
export type RateLimitConfig = {
  /** Sustained refill rate in tokens per second. */
  rate: number
  /** Maximum bucket capacity (burst). */
  burst: number
  /** Idle full buckets older than this (ms) are evicted opportunistically. Default: 300_000. */
  ttlMs?: number
}

export type RateLimiter = {
  /** Consumes a token if available, returning true; returns false otherwise. */
  tryConsume(key: string): boolean
  /** Current number of live buckets. Introspection for tests and metrics. */
  size(): number
}

type Bucket = {
  tokens: number
  lastRefill: number
}

/** Threshold above which `tryConsume` sweeps for evictable buckets. */
const PRUNE_AT = 1024

/** Per-key token-bucket rate limiter. */
export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const buckets = new Map<string, Bucket>()
  const ttlMs = config.ttlMs ?? 300_000

  function prune(now: number): void {
    for (const [key, bucket] of buckets) {
      // Full-capacity AND idle past the TTL: carries no rate state, so dropping and re-creating it
      // on next use is identical. A partially-spent bucket is never dropped — that would refund a
      // caller their spent tokens.
      if (bucket.tokens >= config.burst && now - bucket.lastRefill >= ttlMs) {
        buckets.delete(key)
      }
    }
  }

  return {
    tryConsume(key: string): boolean {
      const now = Date.now()
      let bucket = buckets.get(key)
      if (bucket == null) {
        if (buckets.size >= PRUNE_AT) prune(now)
        bucket = { tokens: config.burst, lastRefill: now }
        buckets.set(key, bucket)
      } else {
        const elapsedSeconds = (now - bucket.lastRefill) / 1000
        bucket.tokens = Math.min(config.burst, bucket.tokens + elapsedSeconds * config.rate)
        bucket.lastRefill = now
      }
      if (bucket.tokens < 1) {
        return false
      }
      bucket.tokens -= 1
      return true
    },
    size(): number {
      return buckets.size
    },
  }
}
```

Note: the prune runs only on the cold path (a key not yet in the map) once the map is large, so the common hot path is unchanged. `lastRefill` doubles as "last touched" — it is written on every `tryConsume` for an existing bucket.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/rateLimit.test.ts` (from `packages/hub-server`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub-server/src/rateLimit.ts packages/hub-server/test/rateLimit.test.ts
git commit -m "feat(hub-server): prune idle rate-limit buckets past a TTL"
```

---

### Task 5: Handler authorize dispatch, mutating-op rate limits, per-target key-package quota

**Files:**
- Modify: `packages/hub-server/src/handlers.ts`
- Test: `packages/hub-server/test/handlers.test.ts` (create)

**Interfaces:**
- Consumes: `AuthorizationDeniedError`, `KeyPackageFetchLimitError` (Task 1); `didLimiter`, `fetchWindows`, `assertKeyPackageFetchAllowed`, `KeyPackageFetchLimits` (existing).
- Produces: no new exported symbols. Behaviour:
  - `keypackage/fetch`, `keypackage/upload`, `topic/fetch` dispatch `authorize`; a refusal throws `HandlerError` with code `HUB_AUTHORIZATION_DENIED`.
  - `subscribe` refusal throws `HandlerError` with code `HUB_AUTHORIZATION_DENIED` (was raw `EK02`).
  - `subscribe`, `unsubscribe`, `keypackage/upload` consume a `didLimiter` token; exhaustion throws `HandlerError` code `EK01`.
  - `keypackage/fetch` additionally enforces a per-target-DID consumption quota (`KeyPackageFetchLimits.maxPerTargetConsumed`, default 60, over the shared `windowMs`), throwing `KeyPackageFetchLimitError`.

Note on wire codes: `authorize` refusals are thrown as `HandlerError({ code: HUB_ERROR_CODES.authorizationDenied })` so the client rebuilds `AuthorizationDeniedError` via `hubErrorFromCode`. The store-raised quota errors already reach the client through `rethrowAsHandlerError`. `publish`'s existing `EK02` refusal is intentionally left unchanged (not in a finding).

- [ ] **Step 1: Write the failing tests**

Create `packages/hub-server/test/handlers.test.ts`:

```ts
import { HUB_ERROR_CODES } from '@kumiai/hub-protocol'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { AuthorizeRequest } from '../src/handlers.js'
import { createHandlers } from '../src/handlers.js'
import { createMemoryStore } from '../src/memoryStore.js'
import { HubClientRegistry } from '../src/registry.js'

const REQUESTER = 'did:key:requester'
const TARGET = 'did:key:target'

function reqCtx(prc: string, param: Record<string, unknown>, did = REQUESTER) {
  return {
    message: { header: {}, payload: { typ: 'request', prc, rid: '1', iss: did } },
    param,
  } as never
}

function setup(overrides: Parameters<typeof createHandlers>[0] extends infer P ? Partial<P> : never = {}) {
  const store = createMemoryStore()
  const registry = new HubClientRegistry()
  const handlers = createHandlers({ store, registry, ...overrides })
  return { store, registry, handlers }
}

describe('authorize dispatch on newly-gated actions', () => {
  test('keypackage/fetch refusal throws with the authorization-denied wire code', async () => {
    const seen: Array<AuthorizeRequest> = []
    const { handlers } = setup({
      authorize: (req) => {
        seen.push(req)
        return req.action === 'keypackage/fetch' ? false : true
      },
    })
    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 2 })),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.authorizationDenied })
    expect(seen[0]).toMatchObject({ action: 'keypackage/fetch', did: REQUESTER, targetDID: TARGET })
  })

  test('keypackage/upload refusal throws with the authorization-denied wire code', async () => {
    const { handlers } = setup({ authorize: (req) => req.action !== 'keypackage/upload' })
    await expect(
      (handlers['hub/v1/keypackage/upload'] as any)(reqCtx('hub/v1/keypackage/upload', { keyPackages: ['kp'] })),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.authorizationDenied })
  })

  test('topic/fetch refusal throws with the authorization-denied wire code', async () => {
    const { handlers } = setup({ authorize: (req) => req.action !== 'topic/fetch' })
    await expect(
      (handlers['hub/v1/topic/fetch'] as any)(reqCtx('hub/v1/topic/fetch', { topicID: 't' })),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.authorizationDenied })
  })

  test('subscribe refusal now uses the authorization-denied wire code (not raw EK02)', async () => {
    const { handlers } = setup({ authorize: (req) => req.action !== 'subscribe' })
    await expect(
      (handlers['hub/v1/subscribe'] as any)(reqCtx('hub/v1/subscribe', { topicID: 't' })),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.authorizationDenied })
  })
})

describe('per-target-DID key-package consumption quota', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => vi.useRealTimers())

  test('many requesters collectively cannot drain one target past the per-target budget', async () => {
    const { store, handlers } = setup({ keyPackageFetchLimits: { maxPerTargetConsumed: 4, maxRequests: 1000 } })
    for (let i = 0; i < 20; i++) await store.storeKeyPackage(TARGET, `kp-${i}`)

    // Four distinct requester DIDs each consume 1 — total 4, exactly the budget.
    for (let i = 0; i < 4; i++) {
      await (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }, `did:key:r${i}`),
      )
    }
    // A fifth requester is refused: the target's budget is spent regardless of who is asking.
    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }, 'did:key:r5'),
      ),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.keyPackageFetchLimit })
  })

  test('the per-target budget refills after the window', async () => {
    const { store, handlers } = setup({ keyPackageFetchLimits: { maxPerTargetConsumed: 1, maxRequests: 1000, windowMs: 1000 } })
    await store.storeKeyPackage(TARGET, 'kp-0')
    await store.storeKeyPackage(TARGET, 'kp-1')
    await (handlers['hub/v1/keypackage/fetch'] as any)(reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }))
    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 })),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.keyPackageFetchLimit })
    vi.advanceTimersByTime(1000)
    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 })),
    ).resolves.toMatchObject({ keyPackages: ['kp-1'] })
  })
})

describe('rate limits on mutating operations', () => {
  test('upload is throttled by the per-DID limiter', async () => {
    const { handlers } = setup({ rateLimits: { perDID: { rate: 0, burst: 2 } } })
    await (handlers['hub/v1/keypackage/upload'] as any)(reqCtx('hub/v1/keypackage/upload', { keyPackages: ['a'] }))
    await (handlers['hub/v1/keypackage/upload'] as any)(reqCtx('hub/v1/keypackage/upload', { keyPackages: ['b'] }))
    await expect(
      (handlers['hub/v1/keypackage/upload'] as any)(reqCtx('hub/v1/keypackage/upload', { keyPackages: ['c'] })),
    ).rejects.toMatchObject({ code: 'EK01' })
  })

  test('subscribe is throttled by the per-DID limiter', async () => {
    const { handlers } = setup({ rateLimits: { perDID: { rate: 0, burst: 1 } } })
    await (handlers['hub/v1/subscribe'] as any)(reqCtx('hub/v1/subscribe', { topicID: 't1' }))
    await expect(
      (handlers['hub/v1/subscribe'] as any)(reqCtx('hub/v1/subscribe', { topicID: 't2' })),
    ).rejects.toMatchObject({ code: 'EK01' })
  })
})

describe('key-package fetch capping and unknown targets (previously untested)', () => {
  test('count is capped at maxCount', async () => {
    const { store, handlers } = setup({ keyPackageFetchLimits: { maxCount: 2 } })
    for (let i = 0; i < 5; i++) await store.storeKeyPackage(TARGET, `kp-${i}`)
    const result = await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 5 }),
    )
    expect(result.keyPackages).toEqual(['kp-0', 'kp-1'])
  })

  test('fetching for a DID with no stored packages returns an empty list', async () => {
    const { handlers } = setup()
    const result = await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: 'did:key:nobody', count: 3 }),
    )
    expect(result.keyPackages).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify the tests fail**

Run: `pnpm exec vitest run test/handlers.test.ts` (from `packages/hub-server`)
Expected: FAIL — no authorize dispatch on the new actions, no per-target quota, no upload/subscribe rate limit, subscribe uses EK02.

- [ ] **Step 3: Add the per-target quota config and helper**

In `packages/hub-server/src/handlers.ts`:

Import the errors and codes (extend the existing `@kumiai/hub-protocol` import):

```ts
import { AuthorizationDeniedError, HUB_ERROR_CODES, KeyPackageFetchLimitError } from '@kumiai/hub-protocol'
```

(Only the wire-code constant is needed for the thrown `HandlerError`s; the error classes are imported so `hubErrorCodeOf` can map any that are thrown as values. Import whichever the code below actually references — `HUB_ERROR_CODES` is required; drop the class imports if unused to satisfy lint.)

Extend `KeyPackageFetchLimits` and its default:

```ts
export type KeyPackageFetchLimits = {
  /** Maximum number of key packages returned per fetch. Default: 10 */
  maxCount: number
  /** Maximum number of fetch requests per requester DID per window. Default: 30 */
  maxRequests: number
  /** Maximum number of key packages that may be consumed from ONE target DID per window,
   * summed across all requesters. Bounds collective drain. Default: 60 */
  maxPerTargetConsumed: number
  /** Rate-limit window duration in milliseconds. Default: 60000 (1 min) */
  windowMs: number
}

export const DEFAULT_KEYPACKAGE_FETCH_LIMITS: KeyPackageFetchLimits = {
  maxCount: 10,
  maxRequests: 30,
  maxPerTargetConsumed: 60,
  windowMs: 60_000,
}
```

Add a second window map and a per-target charge helper beside `fetchWindows` / `assertKeyPackageFetchAllowed`:

```ts
  const targetWindows = new Map<string, { count: number; resetAt: number }>()

  /** Charge `amount` packages against the target DID's consumption window. Throws when the
   * window's budget is spent — this bounds how fast anyone, collectively, can drain a target. */
  function assertTargetConsumptionAllowed(targetDID: string, amount: number): void {
    const now = Date.now()
    if (targetWindows.size > 1024) {
      for (const [did, window] of targetWindows) {
        if (window.resetAt <= now) targetWindows.delete(did)
      }
    }
    const window = targetWindows.get(targetDID)
    if (window == null || window.resetAt <= now) {
      if (amount > fetchLimits.maxPerTargetConsumed) {
        throw new KeyPackageFetchLimitError(`Key package consumption limit exceeded for target ${targetDID}`)
      }
      targetWindows.set(targetDID, { count: amount, resetAt: now + fetchLimits.windowMs })
      return
    }
    if (window.count + amount > fetchLimits.maxPerTargetConsumed) {
      throw new KeyPackageFetchLimitError(`Key package consumption limit exceeded for target ${targetDID}`)
    }
    window.count += amount
  }
```

Change the existing per-requester `throw new Error('Key package fetch rate limit exceeded')` in `assertKeyPackageFetchAllowed` to:

```ts
      throw new KeyPackageFetchLimitError('Key package fetch rate limit exceeded')
```

- [ ] **Step 4: Dispatch authorize and rate-limit the handlers**

`hub/v1/subscribe` — replace the refusal throw:

```ts
      if (!decision.allow) {
        throw new HandlerError({
          code: HUB_ERROR_CODES.authorizationDenied,
          message: decision.reason ?? 'Not authorized to subscribe to topic',
        })
      }
      if (!didLimiter.tryConsume(clientDID)) {
        throw new HandlerError({ code: 'EK01', message: 'Subscribe rate limit exceeded for DID' })
      }
```

(The `didLimiter.tryConsume` goes after the authorize check and before `store.subscribe`.)

`hub/v1/unsubscribe` — add a rate-limit before `store.unsubscribe`:

```ts
      if (!didLimiter.tryConsume(clientDID)) {
        throw new HandlerError({ code: 'EK01', message: 'Unsubscribe rate limit exceeded for DID' })
      }
```

`hub/v1/topic/fetch` — add authorize before `store.fetchTopic`:

```ts
      const decision = normalizeAuthorizeDecision(
        await authorize({ action: 'topic/fetch', did: subscriberDID, topicID }),
      )
      if (!decision.allow) {
        throw new HandlerError({
          code: HUB_ERROR_CODES.authorizationDenied,
          message: decision.reason ?? 'Not authorized to fetch topic',
        })
      }
```

`hub/v1/keypackage/upload` — add authorize + rate-limit before the store writes:

```ts
      const decision = normalizeAuthorizeDecision(
        await authorize({ action: 'keypackage/upload', did: clientDID, count: keyPackages.length }),
      )
      if (!decision.allow) {
        throw new HandlerError({
          code: HUB_ERROR_CODES.authorizationDenied,
          message: decision.reason ?? 'Not authorized to upload key packages',
        })
      }
      if (!didLimiter.tryConsume(clientDID)) {
        throw new HandlerError({ code: 'EK01', message: 'Key package upload rate limit exceeded for DID' })
      }
```

Wrap the `store.storeKeyPackage` loop in `try/catch` that routes the store's quota error to the wire:

```ts
      try {
        await Promise.all(keyPackages.map((kp: string) => store.storeKeyPackage(clientDID, kp)))
      } catch (error) {
        rethrowAsHandlerError(error)
      }
```

`hub/v1/keypackage/fetch` — dispatch authorize, cap the count, then charge both windows:

```ts
    'hub/v1/keypackage/fetch': (async (ctx) => {
      const requesterDID = getClientDID(ctx)
      const { did: targetDID, count } = ctx.param
      const cappedCount = Math.min(Math.max(count ?? 1, 1), fetchLimits.maxCount)
      const decision = normalizeAuthorizeDecision(
        await authorize({ action: 'keypackage/fetch', did: requesterDID, targetDID, count: cappedCount }),
      )
      if (!decision.allow) {
        throw new HandlerError({
          code: HUB_ERROR_CODES.authorizationDenied,
          message: decision.reason ?? 'Not authorized to fetch key packages',
        })
      }
      assertKeyPackageFetchAllowed(requesterDID)
      assertTargetConsumptionAllowed(targetDID, cappedCount)
      const keyPackages = await store.fetchKeyPackages(targetDID, cappedCount)
      return { keyPackages }
    }) as RequestHandler<HubProtocol, 'hub/v1/keypackage/fetch'>,
```

Note ordering: authorize first (a refusal must not consume rate budget), then per-requester, then per-target. The per-target window is charged `cappedCount` (the ask), not the number actually served — this prevents an attacker cheaply probing a near-empty pool.

- [ ] **Step 5: Run to verify the tests pass**

Run: `pnpm exec vitest run test/handlers.test.ts` (from `packages/hub-server`)
Expected: PASS.

- [ ] **Step 6: Full package test + lint + commit**

Run (from `packages/hub-server`): `pnpm exec vitest run`
Expected: PASS (no regression in `handlers-receive`, `hub`, `memoryStore`, `registry`, conformance).

Run from repo root: `rtk proxy pnpm run lint`
Expected: clean (fix any biome findings).

```bash
git add packages/hub-server/src/handlers.ts packages/hub-server/test/handlers.test.ts
git commit -m "feat(hub-server): authorize dispatch, mutating-op rate limits, per-target key-package quota"
```

---

### Task 6: Full-stack verification

**Files:** none (verification only).

- [ ] **Step 1: Build the changed packages**

Run from repo root: `rtk proxy pnpm run build`
Expected: all packages build; no `tsc` errors.

- [ ] **Step 2: Run the full test suite (forced, not cached)**

Run from repo root: `pnpm test -- --force` is broken (see memory `kumiai-test-verification`). Instead run the affected packages directly and confirm `Cached: 0` is not being trusted:

```
pnpm exec vitest run   # in each of: packages/hub-protocol, packages/hub-server, packages/rpc
```

Expected: PASS across all three, including both hub contract suites (`conformance`, `log-hub-conformance`) and the rpc hub-conformance.

- [ ] **Step 3: Lint the whole repo**

Run from repo root: `rtk proxy pnpm run lint`
Expected: clean.

- [ ] **Step 4: Final commit if any lint fixups were needed**

```bash
git add -A
git commit -m "chore(hub): lint and verification fixups"
```

---

## Self-review notes

- **Spec coverage:** §1 errors → Task 1. §2 store caps → Task 3. §3 handler authorize/rate-limit/per-target quota → Task 5. §4 bucket TTL prune → Task 4. §5 hub-mux permanence → Task 2. Testing section → Tasks 1–5 each carry their tests + Task 6 full run. Deferred last-resort → documented in spec, no task (correct).
- **Type consistency:** error class + wire-code names (`AuthorizationDeniedError`/`HUB_AUTHORIZATION_DENIED`, etc.) are identical across Tasks 1, 2, 3, 5. `maxPerTargetConsumed`, `maxKeyPackagesPerDID`, `maxSubscriptionsPerDID`, `ttlMs` used consistently. `assertTargetConsumptionAllowed` / `assertKeyPackageFetchAllowed` / `subsByDID` are the only new internal names.
- **Ordering guard (Task 5):** authorize → per-requester → per-target, so a refused or rate-limited request never wrongly charges a downstream window.
