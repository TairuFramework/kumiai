// biome-ignore-all lint/suspicious/noExplicitAny: handlers are dispatched through a loosely-typed map in these tests
import type { HubStore, StoredMessage } from '@kumiai/hub-protocol'
import { getDefaultConfig, reset, setup } from '@sozai/log'
import { describe, expect, test, vi } from 'vitest'

import type { HubStoreErrorEvent } from '../src/handlers.js'
import { createHandlers } from '../src/handlers.js'
import { createMemoryStore } from '../src/memoryStore.js'
import { HubClientRegistry } from '../src/registry.js'

const REQUESTER = 'did:key:requester'
const TARGET = 'did:key:target'
const RECEIVER = 'did:key:receiver'

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

describe('an ack the store refused is reported without stopping the loop', () => {
  function receiveCtx(params: {
    acks: ReadableStream<{ ack: Array<string> }>
    writable: WritableStream<StoredMessage>
    signal: AbortSignal
  }) {
    return {
      message: {
        header: {},
        payload: { typ: 'channel', prc: 'hub/v1/receive', rid: '1', iss: RECEIVER },
      },
      param: {},
      signal: params.signal,
      writable: params.writable,
      readable: params.acks,
    } as never
  }

  /**
   * The ack loop must not break on a store failure: the frame stays pending and the client re-acks
   * next round. So a store whose ack never works redelivers every frame forever, and until this
   * hook the only evidence was the redelivery itself.
   */
  test('the hook fires and the next ack is still attempted', async () => {
    const boom = new Error('ack column is gone')
    const store = createMemoryStore()
    const acked: Array<Array<string>> = []
    const failingAck: HubStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'ack') {
          return (params: { recipientDID: string; sequenceIDs: Array<string> }) => {
            acked.push(params.sequenceIDs)
            return Promise.reject(boom)
          }
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const seen: Array<HubStoreErrorEvent> = []
    const handlers = createHandlers({
      store: failingAck,
      registry: new HubClientRegistry(),
      onStoreError: (event) => void seen.push(event),
    })

    const acks = new ReadableStream<{ ack: Array<string> }>({
      start(controller) {
        controller.enqueue({ ack: ['seq-1'] })
        controller.enqueue({ ack: ['seq-2'] })
        controller.close()
      },
    })
    const written: Array<unknown> = []
    const writable = new WritableStream<StoredMessage>({
      write(chunk) {
        written.push(chunk)
      },
    })

    // hub/v1/receive's returned promise only resolves on abort/eviction (store-and-forward keeps
    // the channel open), so drive it the same way handlers-receive.test.ts does: let the drain and
    // ack loop run, then abort to observe the result.
    const controller = new AbortController()
    const done = (handlers['hub/v1/receive'] as any)(
      receiveCtx({ acks, writable, signal: controller.signal }),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await done

    // BOTH acks were attempted: the loop did not break on the first failure.
    expect(acked).toEqual([['seq-1'], ['seq-2']])
    expect(seen).toEqual([
      { method: 'ack', did: RECEIVER, error: boom },
      { method: 'ack', did: RECEIVER, error: boom },
    ])
  })
})
