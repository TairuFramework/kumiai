// biome-ignore-all lint/suspicious/noExplicitAny: handlers are dispatched through a loosely-typed map in these tests
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
