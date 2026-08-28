import type { LogHub } from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import { createHubMux } from '../src/hub-mux.js'
import { FakeHub } from './fixtures/fake-hub.js'

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

/**
 * Delegates to `FakeHub` except for `receive`, whose iterator `return()` is controllable: it counts
 * calls and its promise settles on `gate` (a never-settling `gate` models the real wire hub, which
 * `dispose()` must not await). With `returnThrows`, `return()` throws SYNCHRONOUSLY — the one
 * close-failure `mux.dispose()` still rejects on, since it runs the `return()` call un-try/caught.
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
    // A never-settling `return()` (the real wire hub's teardown shape). The old awaited close
    // deadlocked here.
    const neverSettles = new Promise<void>(() => {})
    const { hub, returnCalls } = controllableReceiveHub(neverSettles)
    const mux = createHubMux({ hub, localDID: 'bob' })

    let settled = false
    const disposal = mux.dispose().then(() => {
      settled = true
    })

    await tick()
    expect(settled).toBe(true) // resolved despite the parked close
    await disposal
    expect(returnCalls()).toBe(1) // close still initiated once
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
    // A synchronously-throwing `return()` — the only close-failure `mux.dispose()` still rejects on.
    // The memoized promise hands that rejection to every caller.
    const { hub } = controllableReceiveHub(Promise.resolve(), error)
    const mux = createHubMux({ hub, localDID: 'bob' })

    const first = mux.dispose()
    const second = mux.dispose()
    expect(second).toBe(first)

    await expect(first).rejects.toBe(error)
    await expect(second).rejects.toBe(error)
  })
})
