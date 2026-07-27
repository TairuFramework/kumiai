// biome-ignore-all lint/suspicious/noExplicitAny: handlers are dispatched through a loosely-typed map in these tests
import {
  HUB_ERROR_CODES,
  KeyPackageQuotaExceededError,
  keyPackageDigest,
} from '@kumiai/hub-protocol'
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

function setup(overrides: Partial<Parameters<typeof createHandlers>[0]> = {}) {
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
        return req.action !== 'keypackage/fetch'
      },
    })
    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 2 }),
      ),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.authorizationDenied })
    expect(seen[0]).toMatchObject({ action: 'keypackage/fetch', did: REQUESTER, targetDID: TARGET })
  })

  test('keypackage/upload refusal throws with the authorization-denied wire code', async () => {
    const { handlers } = setup({ authorize: (req) => req.action !== 'keypackage/upload' })
    await expect(
      (handlers['hub/v1/keypackage/upload'] as any)(
        reqCtx('hub/v1/keypackage/upload', { keyPackages: ['kp'] }),
      ),
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
    const { store, handlers } = setup({
      keyPackageFetchLimits: { maxPerTargetConsumed: 4, maxRequests: 1000 },
    })
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
    const { store, handlers } = setup({
      keyPackageFetchLimits: { maxPerTargetConsumed: 1, maxRequests: 1000, windowMs: 1000 },
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
    vi.advanceTimersByTime(1000)
    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }),
      ),
    ).resolves.toMatchObject({ keyPackages: ['kp-1'] })
  })
})

describe('rate limits on mutating operations', () => {
  test('upload is throttled by the per-DID limiter', async () => {
    const { handlers } = setup({ rateLimits: { perDID: { rate: 0, burst: 2 } } })
    await (handlers['hub/v1/keypackage/upload'] as any)(
      reqCtx('hub/v1/keypackage/upload', { keyPackages: ['a'] }),
    )
    await (handlers['hub/v1/keypackage/upload'] as any)(
      reqCtx('hub/v1/keypackage/upload', { keyPackages: ['b'] }),
    )
    await expect(
      (handlers['hub/v1/keypackage/upload'] as any)(
        reqCtx('hub/v1/keypackage/upload', { keyPackages: ['c'] }),
      ),
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

describe('keypackage/fetch ordering: authorize -> per-requester -> per-target', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => vi.useRealTimers())

  test('an authz-refused fetch does not charge the per-target consumption window', async () => {
    const deniedDID = 'did:key:denied'
    const { store, handlers } = setup({
      keyPackageFetchLimits: { maxPerTargetConsumed: 1, maxRequests: 1000 },
      authorize: (req) => !(req.action === 'keypackage/fetch' && req.did === deniedDID),
    })
    for (let i = 0; i < 5; i++) await store.storeKeyPackage(TARGET, `kp-${i}`)

    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }, deniedDID),
      ),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.authorizationDenied })

    // The per-target budget (1) is still whole: an allowed requester's fetch (count 1) still
    // resolves. Had the denied call above charged the per-target window, this budget (1) would
    // already be spent and the fetch below would reject with keyPackageFetchLimit instead. Its
    // success proves the authz-refused call charged nothing to the per-target window.
    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }),
      ),
    ).resolves.toMatchObject({ keyPackages: ['kp-0'] })
  })

  test('a per-requester-throttled fetch does not charge the per-target consumption window', async () => {
    const { store, handlers } = setup({
      keyPackageFetchLimits: { maxPerTargetConsumed: 2, maxRequests: 1 },
    })
    for (let i = 0; i < 5; i++) await store.storeKeyPackage(TARGET, `kp-${i}`)

    // r1's first fetch: within both the per-requester window (maxRequests: 1) and the per-target
    // budget (per-requester=1, per-target=1).
    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }, 'did:key:r1'),
      ),
    ).resolves.toMatchObject({ keyPackages: ['kp-0'] })

    // r1's second fetch: throttled by the per-requester window. This call must not charge the
    // per-target window.
    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }, 'did:key:r1'),
      ),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.keyPackageFetchLimit })

    // r2's fetch: the per-target budget (2) still has room (1 -> 2), so this resolves. Had r1's
    // throttled call above charged the per-target window, the budget (2) would already be spent
    // and this would reject instead. Its success proves the throttled call charged nothing.
    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }, 'did:key:r2'),
      ),
    ).resolves.toMatchObject({ keyPackages: ['kp-1'] })

    // r3's fetch: the per-target budget (2) is now spent by r1 + r2's two successful fetches,
    // confirming the per-target cap is real and enforced.
    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }, 'did:key:r3'),
      ),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.keyPackageFetchLimit })
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

  test('a last-resort upload carrying more than one package is refused before charging anyone', async () => {
    const seen: Array<AuthorizeRequest> = []
    // burst: 1 makes the per-DID budget observable: if the guard ran after tryConsume, the
    // malformed request would spend the only token and the valid follow-up below would be
    // refused with EK01 instead of succeeding.
    const { store, handlers } = setup({
      authorize: (req) => {
        seen.push(req)
        return true
      },
      rateLimits: { perDID: { rate: 0, burst: 1 } },
    })
    await expect(
      (handlers['hub/v1/keypackage/upload'] as any)(
        reqCtx('hub/v1/keypackage/upload', { keyPackages: ['a', 'b'], lastResort: true }, TARGET),
      ),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.invalidPayload })
    // Refused whole: neither package was stored anywhere.
    expect(await store.fetchLastResortKeyPackage(TARGET)).toBeNull()
    expect(await store.fetchKeyPackages(TARGET, 2)).toEqual([])
    // Refused before authorize ran at all.
    expect(seen).toEqual([])
    // Refused before the rate limiter was charged: the single-token budget is still intact.
    await expect(
      (handlers['hub/v1/keypackage/upload'] as any)(
        reqCtx('hub/v1/keypackage/upload', { keyPackages: ['ok'] }, TARGET),
      ),
    ).resolves.toMatchObject({ stored: 1 })
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
    // The ordinary call's authorize request must OMIT the key entirely — not carry it as `false`
    // or an explicit `undefined`, either of which a host policy could misread as an opt-out.
    expect(seen[1]).not.toHaveProperty('lastResort')
  })

  test('an explicit lastResort: false behaves exactly like an absent flag', async () => {
    const seen: Array<AuthorizeRequest> = []
    const { store, handlers } = setup({
      authorize: (req) => {
        seen.push(req)
        return true
      },
    })
    await (handlers['hub/v1/keypackage/upload'] as any)(
      reqCtx(
        'hub/v1/keypackage/upload',
        { keyPackages: ['kp-explicit-false'], lastResort: false },
        TARGET,
      ),
    )
    expect(await store.fetchLastResortKeyPackage(TARGET)).toBeNull()
    expect(await store.fetchKeyPackages(TARGET, 1)).toEqual(['kp-explicit-false'])
    expect(seen[0]).not.toHaveProperty('lastResort')
  })
})

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

describe('store errors on the key-package fetch path keep their wire code', () => {
  /** A store whose ordinary-pool read fails. The specific error is arbitrary — what matters is
   * that it is one of the hub's NAMED errors, so a client can tell it from a transport failure. */
  function storeThatFailsOn(
    method: 'fetchKeyPackages' | 'fetchLastResortKeyPackage',
    error: Error,
  ) {
    return {
      ...createMemoryStore(),
      [method]: async () => {
        throw error
      },
    }
  }

  test('a named store error from fetchKeyPackages reaches the client coded, not bare', async () => {
    const { handlers } = setup({
      store: storeThatFailsOn(
        'fetchKeyPackages',
        new KeyPackageQuotaExceededError('store unavailable'),
      ) as never,
    })
    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }),
      ),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.keyPackageQuota })
  })

  test('a named store error from the top-up read reaches the client coded when nothing was consumed', async () => {
    const store = storeThatFailsOn(
      'fetchLastResortKeyPackage',
      new KeyPackageQuotaExceededError('store unavailable'),
    )
    // The pool is EMPTY, so the short answer consumed nothing and the failing top-up read is the
    // only thing standing between the caller and an answer. Surfacing it loses nothing.
    const { handlers } = setup({ store: store as never })
    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 5 }),
      ),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.keyPackageQuota })
  })

  /**
   * `fetchKeyPackages` is DESTRUCTIVE. Once it returns, those packages are out of the store for
   * good, and a throw from the bonus top-up read would destroy packages nobody ever received —
   * with every retry burning the next batch. The concrete trigger is a store that has not
   * implemented the slot yet (`fetchLastResortKeyPackage is not a function`), which would make
   * every fetch against it silently drain the target: the exact drain this feature exists to close.
   */
  test('a broken slot read does not discard packages the pool already gave up', async () => {
    const store = {
      ...createMemoryStore(),
      fetchLastResortKeyPackage: undefined as never,
    }
    await store.storeKeyPackage(TARGET, 'kp-0')
    const { handlers } = setup({ store: store as never })
    const result = await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 5 }),
    )
    expect(result.keyPackages).toEqual(['kp-0'])
  })

  test('a named store error from the top-up read is swallowed once the pool has answered', async () => {
    const store = storeThatFailsOn(
      'fetchLastResortKeyPackage',
      new KeyPackageQuotaExceededError('store unavailable'),
    )
    // The ordinary pool answered short, so `kp-0` is already spliced out. The client gets it.
    await store.storeKeyPackage(TARGET, 'kp-0')
    const { handlers } = setup({ store: store as never })
    const result = await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 5 }),
    )
    expect(result.keyPackages).toEqual(['kp-0'])
  })

  test('an unnamed store error still passes through untouched', async () => {
    const { handlers } = setup({
      store: storeThatFailsOn('fetchKeyPackages', new Error('disk on fire')) as never,
    })
    // Not ours to classify: a bare Error must not be dressed up in a hub code it never earned.
    await expect(
      (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }),
      ),
    ).rejects.toThrow('disk on fire')
  })

  /**
   * On the fallback path the request was ALREADY being refused — the target's drain budget is
   * spent, and the slot was the only thing that could have rescued it. So a store failure there
   * must not replace a retryable coded refusal with an opaque error: the client's correct move is
   * unchanged, and the store error rides along as `cause` for the operator.
   */
  test('a store failure on the spent-budget fallback still refuses with the quota code', async () => {
    const store = storeThatFailsOn('fetchLastResortKeyPackage', new Error('store unavailable'))
    await store.storeKeyPackage(TARGET, 'kp-0')
    await store.storeKeyPackage(TARGET, 'kp-1')
    const { handlers } = setup({
      store: store as never,
      keyPackageFetchLimits: { maxPerTargetConsumed: 1, maxRequests: 1000 },
    })
    await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }),
    )
    const refusal = await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 1 }),
    ).catch((error: unknown) => error)
    expect(refusal).toMatchObject({ code: HUB_ERROR_CODES.keyPackageFetchLimit })
    // Swallowing it would leave an operator blind to a broken store behind a plausible refusal.
    expect((refusal as { cause?: unknown }).cause).toBeInstanceOf(Error)
    expect(((refusal as { cause?: Error }).cause as Error).message).toBe('store unavailable')
  })
})

describe('hub/v1/keypackage/status', () => {
  test('answers for the caller, counting live packages only', async () => {
    const { store, handlers } = setup()
    const future = Math.floor(Date.now() / 1000) + 3600
    const past = Math.floor(Date.now() / 1000) - 60
    await store.storeKeyPackage(TARGET, 'kp-live', future)
    await store.storeKeyPackage(TARGET, 'kp-dead', past)
    await store.storeKeyPackage('did:key:someone-else', 'kp-other', future)

    const result = await (handlers['hub/v1/keypackage/status'] as any)(
      reqCtx('hub/v1/keypackage/status', {}, TARGET),
    )

    expect(result.count).toBe(1)
    expect(result.lastResort).toBeNull()
  })

  test("reports the digest of the caller's own last-resort package", async () => {
    const { store, handlers } = setup()
    await store.storeLastResortKeyPackage(TARGET, 'kp-last-resort')

    const result = await (handlers['hub/v1/keypackage/status'] as any)(
      reqCtx('hub/v1/keypackage/status', {}, TARGET),
    )

    expect(result.lastResort).toBe(await keyPackageDigest('kp-last-resort'))
  })

  test('consults the authorize hook and can be refused', async () => {
    const { handlers } = setup({ authorize: (req) => req.action !== 'keypackage/status' })
    await expect(
      (handlers['hub/v1/keypackage/status'] as any)(reqCtx('hub/v1/keypackage/status', {}, TARGET)),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.authorizationDenied })
  })
})

describe('hub/v1/keypackage/upload notAfter', () => {
  test('carries the batch expiry into the store', async () => {
    const { store, handlers } = setup()
    const future = Math.floor(Date.now() / 1000) + 3600
    await (handlers['hub/v1/keypackage/upload'] as any)(
      reqCtx('hub/v1/keypackage/upload', { keyPackages: ['kp-a'], notAfter: future }, TARGET),
    )

    expect(await store.countKeyPackages(TARGET)).toBe(1)
  })

  test('rejects an expiry on a last-resort upload', async () => {
    const { handlers } = setup()
    await expect(
      (handlers['hub/v1/keypackage/upload'] as any)(
        reqCtx(
          'hub/v1/keypackage/upload',
          { keyPackages: ['kp'], lastResort: true, notAfter: 1 },
          TARGET,
        ),
      ),
    ).rejects.toThrow(/last-resort upload carries no expiry/)
  })
})
