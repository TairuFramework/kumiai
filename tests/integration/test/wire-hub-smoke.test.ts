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
