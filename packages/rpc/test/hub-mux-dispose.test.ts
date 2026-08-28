import type { LogHub } from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import { createHubMux } from '../src/hub-mux.js'
import { FakeHub } from './fixtures/fake-hub.js'

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

/**
 * A hub that delegates to `FakeHub` for everything except `receive`, whose async-iterator
 * `return()` is controllable: it counts calls and settles (or rejects) on `gate`, so a test can
 * observe what `dispose()` does while the drain close is still in flight.
 */
function controllableReceiveHub(gate: Promise<unknown>): {
  hub: LogHub
  returnCalls: () => number
} {
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
          return: async () => {
            returnCalls++
            await gate
            return iterator.return ? iterator.return() : { done: true as const, value: undefined }
          },
        }),
        ack: inner.ack?.bind(inner),
      }
    },
  }
  return { hub, returnCalls: () => returnCalls }
}

describe('createHubMux dispose', () => {
  test('awaits the receive-iterator close before resolving', async () => {
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const { hub, returnCalls } = controllableReceiveHub(gate)
    const mux = createHubMux({ hub, localDID: 'bob' })

    let settled = false
    const disposal = mux.dispose().then(() => {
      settled = true
    })

    await tick()
    expect(settled).toBe(false)

    releaseGate()
    await disposal
    expect(settled).toBe(true)
    expect(returnCalls()).toBe(1)
  })

  test('concurrent callers share one disposal', async () => {
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const { hub, returnCalls } = controllableReceiveHub(gate)
    const mux = createHubMux({ hub, localDID: 'bob' })

    let firstSettled = false
    let secondSettled = false
    const first = mux.dispose().then(() => {
      firstSettled = true
    })
    const second = mux.dispose().then(() => {
      secondSettled = true
    })

    await tick()
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)

    releaseGate()
    await Promise.all([first, second])
    expect(firstSettled).toBe(true)
    expect(secondSettled).toBe(true)
    // The body — including the drain close — ran once, not once per caller.
    expect(returnCalls()).toBe(1)
  })

  test('concurrent callers observe the same rejection', async () => {
    const error = new Error('drain close failed')
    const gate = Promise.reject(error)
    // The gate itself is never awaited outside `dispose()`; without this it would report as an
    // unhandled rejection before either `dispose()` call gets to it.
    gate.catch(() => {})
    const { hub } = controllableReceiveHub(gate)
    const mux = createHubMux({ hub, localDID: 'bob' })

    const first = mux.dispose()
    const second = mux.dispose()

    await expect(first).rejects.toBe(error)
    await expect(second).rejects.toBe(error)
  })
})
