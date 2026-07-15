import type { StoredMessage } from '@kumiai/hub-protocol'
import { fromUTF, toUTF } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { createHubMux } from '../src/hub-mux.js'
import { FakeHub } from './fixtures/fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 10))

describe('createHubMux', () => {
  test('bus.subscribe receives payloads published to the topic (one real subscribe)', async () => {
    const hub = new FakeHub()
    const mux = createHubMux({ hub, localDID: 'bob' })
    const got: Array<string> = []
    const unsub = mux.bus.subscribe('topic:x', (bytes) => got.push(toUTF(bytes)))
    expect(hub.subscriberCount('topic:x')).toBe(1)

    await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: fromUTF('m1') })
    await flush()
    expect(got).toEqual(['m1'])

    // Dropping the listener stops this process READING the topic. It does not stop the member
    // being a subscriber of it: unsubscribing tells the hub to drop this member's pending
    // deliveries and free any frame it was the last reader of, and a caller that has merely
    // stopped listening has not read them.
    unsub()
    expect(hub.subscriberCount('topic:x')).toBe(1)
    await mux.dispose()
  })

  test('the last listener leaving does not unsubscribe', async () => {
    const hub = new FakeHub()
    const mux = createHubMux({ hub, localDID: 'bob' })
    const a = mux.bus.subscribe('topic:y', () => {})
    const b = mux.onInbound('topic:y', () => {})
    // One real subscribe across both registrations: the refcount is about local listeners.
    expect(hub.subscriberCount('topic:y')).toBe(1)
    a()
    b()
    expect(hub.subscriberCount('topic:y')).toBe(1)
    await mux.dispose()
  })

  test('onInbound fires before sinks receive, exposing senderDID', async () => {
    const hub = new FakeHub()
    const mux = createHubMux({ hub, localDID: 'bob' })
    const order: Array<string> = []
    const senders: Array<string> = []
    mux.onInbound('topic:z', (msg: StoredMessage) => {
      order.push('onInbound')
      senders.push(msg.senderDID)
    })
    const sub = mux.mailbox.receive('bob')
    void (async () => {
      for await (const _msg of sub) order.push('sink')
    })()
    await flush()

    await hub.publish({ senderDID: 'alice', topicID: 'topic:z', payload: fromUTF('m') })
    await flush()
    expect(order).toEqual(['onInbound', 'sink'])
    expect(senders).toEqual(['alice'])
    sub.return?.()
    await mux.dispose()
  })

  test('hubLike.publish forwards the provided senderDID', async () => {
    const hub = new FakeHub()
    const mux = createHubMux({ hub, localDID: 'bob' })
    const other = createHubMux({ hub, localDID: 'carol' })
    let seen: StoredMessage | undefined
    other.onInbound('topic:p', (msg) => {
      seen = msg
    })
    await mux.mailbox.publish({ senderDID: 'bob', topicID: 'topic:p', payload: fromUTF('hey') })
    await flush()
    expect(seen?.senderDID).toBe('bob')
    expect(toUTF(seen?.payload ?? new Uint8Array())).toBe('hey')
    await mux.dispose()
    await other.dispose()
  })

  test('dispose stops the drain and leaves the subscriptions standing', async () => {
    const hub = new FakeHub()
    const mux = createHubMux({ hub, localDID: 'bob' })
    const got: Array<string> = []
    mux.bus.subscribe('topic:q', (bytes) => got.push(toUTF(bytes)))
    expect(hub.subscriberCount('topic:q')).toBe(1)

    await mux.dispose()

    // Disposed, so nothing is read here any more...
    await hub.publish({ senderDID: 'alice', topicID: 'topic:q', payload: fromUTF('m1') })
    await flush()
    expect(got).toEqual([])

    // ...and the member is still a subscriber, so the hub is still holding that frame for it.
    // A subscription is a durable relationship, not a session: disposing is this process
    // saying it has stopped reading, and on a mobile client it is what backgrounding calls.
    // Unsubscribing here would delete the user's unread messages every time they switched app.
    expect(hub.subscriberCount('topic:q')).toBe(1)
  })

  test('a sink created inside an onInbound listener receives the triggering message (lazy-accept race)', async () => {
    const hub = new FakeHub()
    const mux = createHubMux({ hub, localDID: 'bob' })
    const got: Array<string> = []
    let started = false
    // Mirrors the directed inbox acceptor: onInbound synchronously creates a
    // receive sink on first inbound, which must still receive that first frame.
    mux.onInbound('topic:lazy', () => {
      if (started) return
      started = true
      const sub = mux.mailbox.receive('bob')
      void (async () => {
        for await (const msg of sub) got.push(toUTF(msg.payload))
      })()
    })

    await hub.publish({ senderDID: 'alice', topicID: 'topic:lazy', payload: fromUTF('first') })
    await flush()
    expect(got).toEqual(['first'])
    await mux.dispose()
  })
})
