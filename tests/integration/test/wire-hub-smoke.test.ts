import { randomIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import { createWireHub } from './log-hub-over-wire.js'

const utf8 = new TextEncoder()
const flush = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))

/** The adapter itself, before anything is built on it. */
describe('LogHub over the real hub-server wire', () => {
  test('publish, fetchTopic and push delivery all cross the wire', async () => {
    const hub = createWireHub()
    const aliceID = randomIdentity()
    const bobID = randomIdentity()
    const alice = hub.connect(aliceID)
    const bob = hub.connect(bobID)

    const received: Array<string> = []
    // ORDER MATTERS and this is the peer's order: hub-mux opens the receive stream during
    // construction and subscribes to topics afterwards.
    const subscription = bob.receive(bobID.id)
    void (async () => {
      for await (const message of subscription) {
        received.push(new TextDecoder().decode(message.payload))
      }
    })()
    await flush()
    await bob.subscribe(bobID.id, 'topic:smoke')
    await flush()

    await alice.publish({
      senderDID: aliceID.id,
      topicID: 'topic:smoke',
      payload: utf8.encode('pushed'),
      retain: 'log',
    })
    await flush()

    expect(received).toEqual(['pushed'])

    const fetched = await bob.fetchTopic({ subscriberDID: bobID.id, topicID: 'topic:smoke' })
    expect(fetched.messages.map((m) => new TextDecoder().decode(m.payload))).toEqual(['pushed'])
    expect(fetched.head).not.toBeNull()

    subscription.return?.()
    await hub.dispose()
  })
})

/**
 * The property every "abandon rather than ack" decision on this branch depends on, proven
 * against the real hub-server rather than against `memoryStore` directly or `DurableFakeHub`.
 * `memoryStore`'s `deliveries` map is keyed by recipient DID, not by subscription instance, so
 * these tests model a reconnect as a fresh `WireConnection` for the same identity — per
 * `WireConnection`'s own contract above — rather than a second subscription on the live one.
 */
describe('Durable ack over the wire', () => {
  test('a mailbox frame every recipient acks is reclaimed: not redelivered to a fresh receive', async () => {
    const hub = createWireHub()
    const aliceID = randomIdentity()
    const bobID = randomIdentity()
    const alice = hub.connect(aliceID)
    let bob = hub.connect(bobID)
    const topicID = 'topic:ack-reclaim'

    await bob.subscribe(bobID.id, topicID)
    const firstSub = bob.receive(bobID.id)
    const firstIterator = firstSub[Symbol.asyncIterator]()

    await alice.publish({ senderDID: aliceID.id, topicID, payload: utf8.encode('mailbox-msg') })
    await flush()

    const first = await firstIterator.next()
    expect(first.done).toBe(false)
    const sequenceID = first.value?.sequenceID as string
    await firstSub.ack?.(sequenceID)
    await flush()
    firstSub.return?.()

    // The reader dies and a fresh connection for the same DID takes its place — the redelivery
    // question can only be asked of a receive that never saw the first delivery.
    await bob.disconnect()
    bob = hub.connect(bobID)

    const receivedAfterAck: Array<string> = []
    const freshSub = bob.receive(bobID.id)
    void (async () => {
      for await (const message of freshSub) {
        receivedAfterAck.push(new TextDecoder().decode(message.payload))
      }
    })()
    await flush()
    expect(receivedAfterAck).toEqual([])

    freshSub.return?.()
    await hub.dispose()
  })

  test('a mailbox frame that is not acked is redelivered to a fresh receive', async () => {
    const hub = createWireHub()
    const aliceID = randomIdentity()
    const bobID = randomIdentity()
    const alice = hub.connect(aliceID)
    let bob = hub.connect(bobID)
    const topicID = 'topic:ack-redeliver'

    await bob.subscribe(bobID.id, topicID)
    const firstSub = bob.receive(bobID.id)
    const firstIterator = firstSub[Symbol.asyncIterator]()

    await alice.publish({ senderDID: aliceID.id, topicID, payload: utf8.encode('mailbox-msg') })
    await flush()

    const first = await firstIterator.next()
    expect(first.done).toBe(false)
    // No ack — the reader dies having read it but never confirmed it.
    firstSub.return?.()

    await bob.disconnect()
    bob = hub.connect(bobID)

    const receivedAfterReconnect: Array<string> = []
    const freshSub = bob.receive(bobID.id)
    void (async () => {
      for await (const message of freshSub) {
        receivedAfterReconnect.push(new TextDecoder().decode(message.payload))
      }
    })()
    await flush()
    expect(receivedAfterReconnect).toEqual(['mailbox-msg'])

    freshSub.return?.()
    await hub.dispose()
  })

  test('a log-class frame survives every ack and still serves from fetchTopic', async () => {
    const hub = createWireHub()
    const aliceID = randomIdentity()
    const bobID = randomIdentity()
    const alice = hub.connect(aliceID)
    const bob = hub.connect(bobID)
    const topicID = 'topic:ack-log-survives'

    await bob.subscribe(bobID.id, topicID)
    const subscription = bob.receive(bobID.id)
    const iterator = subscription[Symbol.asyncIterator]()

    const published = await alice.publish({
      senderDID: aliceID.id,
      topicID,
      payload: utf8.encode('commit'),
      retain: 'log',
    })
    await flush()

    const next = await iterator.next()
    expect(next.done).toBe(false)
    const sequenceID = next.value?.sequenceID as string
    // Bob is the only subscriber, so this ack retires the frame's every delivery.
    await subscription.ack?.(sequenceID)
    await flush()
    subscription.return?.()

    const fetched = await bob.fetchTopic({ subscriberDID: bobID.id, topicID })
    expect(fetched.messages.map((message) => message.sequenceID)).toEqual([published.sequenceID])
    expect(fetched.head).toBe(published.sequenceID)

    await hub.dispose()
  })
})
