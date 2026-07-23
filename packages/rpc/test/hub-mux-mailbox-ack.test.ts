import { describe, expect, test } from 'vitest'

import { createHubMux } from '../src/hub-mux.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

describe('the mailbox facade relays its ack', () => {
  test('a scoped receive acks the frame it read', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })

    mux.mailbox.subscribe('bob', 'topic:x')
    const subscription = mux.mailbox.receive('bob', { topicID: 'topic:x' })
    const iterator = subscription[Symbol.asyncIterator]()
    await flush()

    await hub.publish({
      senderDID: 'alice',
      topicID: 'topic:x',
      payload: new Uint8Array([1]),
    })
    const next = await iterator.next()
    expect(next.done).toBe(false)

    expect(hub.ackedCount('bob')).toBe(0)
    await subscription.ack?.(next.value.sequenceID)
    await flush()
    expect(hub.ackedCount('bob')).toBe(1)

    subscription.return?.()
    await mux.dispose()
  })

  test('a scoped receive is not a holder for another topic', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })

    mux.mailbox.subscribe('bob', 'topic:x')
    mux.retainTopic('topic:y')
    const subscription = mux.mailbox.receive('bob', { topicID: 'topic:x' })
    await flush()

    await hub.publish({
      senderDID: 'alice',
      topicID: 'topic:y',
      payload: new Uint8Array([1]),
    })
    await flush()

    // Unscoped, this sink would be a pending holder for every message on every topic, and a frame
    // it discards on topic mismatch would wait for an ack that never comes.
    expect(hub.ackedCount('bob')).toBe(1)

    subscription.return?.()
    await mux.dispose()
  })

  test('closing a receive without acking releases the claims it was still holding', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })

    mux.mailbox.subscribe('bob', 'topic:x')
    const subscription = mux.mailbox.receive('bob', { topicID: 'topic:x' })
    const iterator = subscription[Symbol.asyncIterator]()
    await flush()

    await hub.publish({
      senderDID: 'alice',
      topicID: 'topic:x',
      payload: new Uint8Array([1]),
    })
    const next = await iterator.next()
    expect(next.done).toBe(false)

    expect(hub.ackedCount('bob')).toBe(0)
    // Closed without ever acking: the last holder abandoning its subscription must still release
    // the claim, not strand it for the TTL sweep — which deliberately does not ack.
    subscription.return?.()
    await flush()
    expect(hub.ackedCount('bob')).toBe(1)

    await mux.dispose()
  })
})
