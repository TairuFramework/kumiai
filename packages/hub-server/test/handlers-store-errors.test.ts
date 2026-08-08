// biome-ignore-all lint/suspicious/noExplicitAny: handlers are dispatched through a loosely-typed map in these tests
import type { HubStore, StoredMessage } from '@kumiai/hub-protocol'
import { toB64 } from '@sozai/codec'
import { getDefaultConfig, reset, setup } from '@sozai/log'
import { describe, expect, test, vi } from 'vitest'

import type { HubStoreErrorEvent } from '../src/handlers.js'
import { createHandlers, createStoreErrorReporter } from '../src/handlers.js'
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

type CapturedRecord = { category: ReadonlyArray<string>; level: string; message: string }

/**
 * Routes `['kumiai']` (and children) to `records` instead of the console, so a test can pin the
 * category and message a report actually carries rather than only that a report happened.
 */
function setupCapture(records: Array<CapturedRecord>): void {
  setup({
    sinks: {
      capture: (record) => {
        records.push({
          category: record.category,
          level: record.level,
          message: record.message.join(''),
        })
      },
    },
    loggers: [
      // Without an entry covering it, logtape treats the meta logger as unconfigured, attaches a
      // console sink of its own and prints an info-level notice on every configure(). No sink
      // named here: `records` is asserted against, and logtape's own diagnostics are not the
      // records under test.
      { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: [] },
      { category: ['kumiai'], lowestLevel: 'debug', sinks: ['capture'] },
    ],
  })
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

  /**
   * The category and message are the product an operator actually reads: the README and the
   * changeset both promise `['kumiai', 'hub-server']`, and the consequence text is the sentence
   * that tells them what the hub did instead of failing. A console-mock test can't catch either
   * going wrong — the default logger config carries every category, so a wrong one still prints.
   */
  test('with no hook wired, the failure is reported under ["kumiai", "hub-server"] with the top-up consequence', async () => {
    const boom = new Error('fetchLastResortKeyPackage is not a function')
    const store = failingStore('fetchLastResortKeyPackage', boom)
    const records: Array<CapturedRecord> = []
    setupCapture(records)
    try {
      const handlers = createHandlers({ store, registry: new HubClientRegistry() })
      await (handlers['hub/v1/keypackage/upload'] as any)(
        reqCtx('hub/v1/keypackage/upload', { keyPackages: ['kp-1'] }, TARGET),
      )
      await (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 3 }),
      )
      expect(records).toHaveLength(1)
      expect(records[0]?.category).toEqual(['kumiai', 'hub-server'])
      expect(records[0]?.level).toBe('error')
      expect(records[0]?.message).toContain('without the last-resort top-up')
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
    // Nothing is ever published to RECEIVER, so a sink that recorded what it wrote would have
    // nothing to assert on; it only needs to exist as a valid destination for the channel.
    const writable = new WritableStream<StoredMessage>({
      write() {},
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

  /**
   * Same pin as the top-up test above, for the other event this file can drive through
   * `createHandlers`: category, level, and the `ack` consequence text, none of which the
   * hook-based test above can see since it bypasses the reporter entirely.
   */
  test('with no hook wired, an ack failure is reported under ["kumiai", "hub-server"] with the ack consequence', async () => {
    const boom = new Error('ack column is gone')
    const store = createMemoryStore()
    const failingAck: HubStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'ack') {
          return () => Promise.reject(boom)
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const records: Array<CapturedRecord> = []
    setupCapture(records)
    try {
      const handlers = createHandlers({ store: failingAck, registry: new HubClientRegistry() })
      const acks = new ReadableStream<{ ack: Array<string> }>({
        start(controller) {
          controller.enqueue({ ack: ['seq-1'] })
          controller.close()
        },
      })
      const writable = new WritableStream<StoredMessage>({ write() {} })
      const controller = new AbortController()
      const done = (handlers['hub/v1/receive'] as any)(
        receiveCtx({ acks, writable, signal: controller.signal }),
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      controller.abort()
      await done

      expect(records).toHaveLength(1)
      expect(records[0]?.category).toEqual(['kumiai', 'hub-server'])
      expect(records[0]?.level).toBe('error')
      expect(records[0]?.message).toContain('redelivers every frame forever')
      // Pins subjectOf's `ack` arm: without it, nothing here would say WHICH DID's acks are stuck.
      expect(records[0]?.message).toContain(`for ${RECEIVER}`)
    } finally {
      reset()
    }
  })
})

describe('a publish whose fan-out cannot read its subscribers still succeeds', () => {
  const payload = toB64(new TextEncoder().encode('hello'))

  /**
   * `getSubscribers` runs AFTER `store.publish` committed the append and its delivery rows in one
   * transaction, so the frame is already durable for every subscriber. Failing the request would
   * report a lie AND make the loss permanent: the caller's `publishID` retry returns
   * `deduped: true`, which gates the whole fan-out block off.
   */
  test('the failure reaches the hook and the frame stays readable', async () => {
    const boom = new Error('subscriber index is gone')
    const store = failingStore('getSubscribers', boom)
    const seen: Array<HubStoreErrorEvent> = []
    const handlers = createHandlers({
      store,
      registry: new HubClientRegistry(),
      onStoreError: (event) => void seen.push(event),
    })

    await (handlers['hub/v1/subscribe'] as any)(
      reqCtx('hub/v1/subscribe', { topicID: 'topic-1' }, RECEIVER),
    )
    const result = await (handlers['hub/v1/publish'] as any)(
      reqCtx('hub/v1/publish', { topicID: 'topic-1', payload: payload, retain: 'log' }),
    )

    expect(result).toMatchObject({ sequenceID: expect.any(String) })
    expect(seen).toEqual([{ method: 'getSubscribers', topicID: 'topic-1', error: boom }])

    // The point of the swallow: the frame is durable regardless of the failed live push, so the
    // subscriber gets it by pulling. An assertion that only checked the report would pass just as
    // well if the publish had silently dropped the frame.
    const fetched = await (handlers['hub/v1/topic/fetch'] as any)(
      reqCtx('hub/v1/topic/fetch', { topicID: 'topic-1' }, RECEIVER),
    )
    expect(fetched.messages).toHaveLength(1)
    expect(fetched.messages[0]).toMatchObject({ senderDID: REQUESTER, payload: payload })
  })

  /** A hook is a notice, not a dependency — same rule as the other sites. */
  test('a hook that throws does not fail the publish', async () => {
    const store = failingStore('getSubscribers', new Error('subscriber index is gone'))
    const handlers = createHandlers({
      store,
      registry: new HubClientRegistry(),
      onStoreError: () => {
        throw new Error('the host reporting path is itself broken')
      },
    })

    const result = await (handlers['hub/v1/publish'] as any)(
      reqCtx('hub/v1/publish', { topicID: 'topic-1', payload: payload, retain: 'log' }),
    )
    expect(result).toMatchObject({ sequenceID: expect.any(String) })
  })
})

/**
 * `purge` is reported from `createHub`'s setInterval timer, not from any handler this file can
 * drive — spinning up `createHub` and its timer just to reach `createStoreErrorReporter` would be
 * machinery out of proportion to what's being checked. `createStoreErrorReporter` is exported for
 * exactly this: it's the same function `hub.ts` calls, so exercising it directly with a synthetic
 * `purge` event pins the same category/level/message contract without the timer.
 */
describe('the purge consequence, exercised directly against the exported reporter', () => {
  test('with no hook wired, a purge failure is reported under ["kumiai", "hub-server"] with the purge consequence', () => {
    const boom = new Error('purge column is gone')
    const records: Array<CapturedRecord> = []
    setupCapture(records)
    try {
      const report = createStoreErrorReporter()
      report({ method: 'purge', error: boom })

      expect(records).toHaveLength(1)
      expect(records[0]?.category).toEqual(['kumiai', 'hub-server'])
      expect(records[0]?.level).toBe('error')
      expect(records[0]?.message).toContain('grows without bound')
    } finally {
      reset()
    }
  })
})

/**
 * The fan-out variant is the first event whose subject is a topic rather than a DID, so the
 * default log line has to name it. Exercised directly against the exported reporter for the same
 * reason as `purge` above — the site that produces it is covered separately in the publish tests.
 */
describe('the publish fan-out consequence, exercised directly against the exported reporter', () => {
  test('with no hook wired, a getSubscribers failure names the topic and the push-to-pull consequence', () => {
    const boom = new Error('subscriber index is gone')
    const records: Array<CapturedRecord> = []
    setupCapture(records)
    try {
      const report = createStoreErrorReporter()
      report({ method: 'getSubscribers', topicID: 'topic-1', error: boom })

      expect(records).toHaveLength(1)
      expect(records[0]?.category).toEqual(['kumiai', 'hub-server'])
      expect(records[0]?.level).toBe('error')
      expect(records[0]?.message).toContain('on topic topic-1')
      expect(records[0]?.message).toContain('degraded from push to pull')
    } finally {
      reset()
    }
  })
})
