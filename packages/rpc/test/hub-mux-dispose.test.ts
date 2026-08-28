import type { LogHub } from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import { createHubMux } from '../src/hub-mux.js'
import { FakeHub } from './fixtures/fake-hub.js'

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

/**
 * A hub that delegates to `FakeHub` for everything except `receive`, whose async-iterator
 * `return()` is controllable: it counts calls and its returned promise settles on `gate`. When
 * `returnThrows` is set, `return()` instead throws SYNCHRONOUSLY — the one close-failure shape
 * `mux.dispose()` still surfaces, since the mux fires the close-and-forget but runs the `return()`
 * call itself un-try/caught. A never-settling `gate` models the real wire hub, whose `return()`
 * parks behind the in-flight `next()` during teardown — `dispose()` must not await it.
 */
function controllableReceiveHub(
  gate: Promise<unknown> = Promise.resolve(),
  returnThrows?: unknown,
): {
  hub: LogHub
  returnCalls: () => number
} {
  gate.catch(() => {})
  const fake = new FakeHub()
  let returnCalls = 0
  const hub: LogHub = {
    subscribe: (subscriberDID, topicID, options) => fake.subscribe(subscriberDID, topicID, options),
    unsubscribe: (subscriberDID, topicID) => fake.unsubscribe(subscriberDID, topicID),
    publish: (params) => fake.publish(params),
    fetchTopic: (params) => fake.fetchTopic(params),
    receive: (subscriberDID) => {
      const inner = fake.receive(subscriberDID)
      const iterator = inner[Symbol.asyncIterator]()
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => iterator.next(),
          return: () => {
            returnCalls++
            if (returnThrows !== undefined) throw returnThrows
            return (async () => {
              await gate
              return iterator.return ? iterator.return() : { done: true as const, value: undefined }
            })()
          },
        }),
        ack: inner.ack?.bind(inner),
      }
    },
  }
  return { hub, returnCalls: () => returnCalls }
}

describe('createHubMux dispose', () => {
  test('resolves without awaiting the receive-iterator close (never deadlocks on a parked return)', async () => {
    // A receive `return()` whose promise never settles — the shape the real wire hub takes during
    // teardown, where `return()` parks behind the in-flight `next()`. The old `await
    // iterator.return()` deadlocked here; the fire-and-forget close must let `dispose()` resolve.
    const neverSettles = new Promise<void>(() => {})
    const { hub, returnCalls } = controllableReceiveHub(neverSettles)
    const mux = createHubMux({ hub, localDID: 'bob' })

    let settled = false
    const disposal = mux.dispose().then(() => {
      settled = true
    })

    await tick()
    // Resolved despite the close still parked — the drain is closed fire-and-forget, not awaited.
    expect(settled).toBe(true)
    await disposal
    // The close was still initiated exactly once (fire-and-forget ≠ never-called).
    expect(returnCalls()).toBe(1)
  })

  test('concurrent callers share one disposal', async () => {
    const { hub, returnCalls } = controllableReceiveHub()
    const mux = createHubMux({ hub, localDID: 'bob' })

    const first = mux.dispose()
    const second = mux.dispose()
    // Memoized: the second caller gets the very same promise, not a re-run of the body.
    expect(second).toBe(first)

    await Promise.all([first, second])
    // The body — including initiating the drain close — ran once, not once per caller.
    expect(returnCalls()).toBe(1)
  })

  test('concurrent callers observe the same rejection', async () => {
    const error = new Error('drain close failed')
    // A `return()` that throws SYNCHRONOUSLY — the close-failure shape `mux.dispose()` still
    // surfaces (the async settlement is fire-and-forget and no longer awaited). The memoized
    // disposal promise hands that same rejection to every caller.
    const { hub } = controllableReceiveHub(Promise.resolve(), error)
    const mux = createHubMux({ hub, localDID: 'bob' })

    const first = mux.dispose()
    const second = mux.dispose()
    expect(second).toBe(first)

    await expect(first).rejects.toBe(error)
    await expect(second).rejects.toBe(error)
  })
})
