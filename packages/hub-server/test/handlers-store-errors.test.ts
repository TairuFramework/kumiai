// biome-ignore-all lint/suspicious/noExplicitAny: handlers are dispatched through a loosely-typed map in these tests
import type { HubStore } from '@kumiai/hub-protocol'
import { getDefaultConfig, reset, setup } from '@sozai/log'
import { describe, expect, test, vi } from 'vitest'

import type { HubStoreErrorEvent } from '../src/handlers.js'
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

/**
 * A store that fails ONE method and delegates the rest. Test-local fault injection, deliberately
 * NOT a HubStore implementation offered to `hub-conformance`: it is stricter about nothing and
 * broken about one thing, which is the opposite of what a double is for.
 */
function failingStore(method: keyof HubStore, error: Error): HubStore {
  const store = createMemoryStore()
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === method) {
        return () => Promise.reject(error)
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

describe('a store failure the hub declines to turn into a request failure is reported', () => {
  /**
   * The top-up read runs AFTER `fetchKeyPackages` has already consumed destructively. Surfacing
   * its failure would destroy packages nobody received and make the client's retry burn the next
   * batch — so it is swallowed on purpose, and a permanently broken slot read returns 200 forever
   * with the availability floor silently absent.
   */
  test('the swallowed last-resort top-up read reaches the hook', async () => {
    const boom = new Error('fetchLastResortKeyPackage is not a function')
    const store = failingStore('fetchLastResortKeyPackage', boom)
    const seen: Array<HubStoreErrorEvent> = []
    const handlers = createHandlers({
      store,
      registry: new HubClientRegistry(),
      onStoreError: (event) => void seen.push(event),
    })

    await (handlers['hub/v1/keypackage/upload'] as any)(
      reqCtx('hub/v1/keypackage/upload', { keyPackages: ['kp-1'] }, TARGET),
    )
    const result = await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 3 }),
    )

    // Behaviour is UNCHANGED: the pool's one package is still served. A "fix" that started
    // failing this request would destroy key packages nobody ever received.
    expect(result).toEqual({ keyPackages: ['kp-1'] })
    expect(seen).toEqual([{ method: 'fetchLastResortKeyPackage', did: TARGET, error: boom }])
  })

  test('with no hook wired, the failure reaches a default-configured logger', async () => {
    const boom = new Error('fetchLastResortKeyPackage is not a function')
    const store = failingStore('fetchLastResortKeyPackage', boom)
    const error = vi.fn()
    setup(getDefaultConfig({ console: { error } as unknown as Console }))
    try {
      const handlers = createHandlers({ store, registry: new HubClientRegistry() })
      await (handlers['hub/v1/keypackage/upload'] as any)(
        reqCtx('hub/v1/keypackage/upload', { keyPackages: ['kp-1'] }, TARGET),
      )
      await (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 3 }),
      )
      expect(error).toHaveBeenCalledOnce()
    } finally {
      reset()
    }
  })

  /** A hook is a notice, not a dependency: a host whose reporting is broken still gets served. */
  test('a hook that throws does not fail the request', async () => {
    const store = failingStore('fetchLastResortKeyPackage', new Error('boom'))
    const handlers = createHandlers({
      store,
      registry: new HubClientRegistry(),
      onStoreError: () => {
        throw new Error('the host reporting path is itself broken')
      },
    })

    await (handlers['hub/v1/keypackage/upload'] as any)(
      reqCtx('hub/v1/keypackage/upload', { keyPackages: ['kp-1'] }, TARGET),
    )
    const result = await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 3 }),
    )
    expect(result).toEqual({ keyPackages: ['kp-1'] })
  })
})
