import type { LogHub } from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import { createHubMux } from '../src/hub-mux.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

/**
 * Spies on the raw upstream `ack`, counting calls rather than distinct sequenceIDs.
 * `DurableFakeHub.ackedCount` is the size of a `Set`, so it cannot tell a single ack from a
 * duplicate one — a wrapping hub delegating explicitly is the only way to see that. Built by
 * per-method delegation, not `{...instance}`: `DurableFakeHub` is a class, and the spread copies
 * only its own enumerable properties, dropping every prototype method.
 */
function hubCountingAcks(instance: DurableFakeHub): { hub: LogHub; ackCalls: () => number } {
  let calls = 0
  const hub: LogHub = {
    subscribe: (subscriberDID, topicID, options) =>
      instance.subscribe(subscriberDID, topicID, options),
    unsubscribe: (subscriberDID, topicID) => instance.unsubscribe(subscriberDID, topicID),
    publish: (params) => instance.publish(params),
    fetchTopic: (params) => instance.fetchTopic(params),
    receive: (subscriberDID) => {
      const subscription = instance.receive(subscriberDID)
      return {
        ...subscription,
        ack: (sequenceID: string) => {
          calls += 1
          return subscription.ack?.(sequenceID)
        },
      }
    },
  }
  return { hub, ackCalls: () => calls }
}

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

  test('closing after receiving a message abandons the claim rather than acking it', async () => {
    const { hub: wrappedHub, ackCalls } = hubCountingAcks(new DurableFakeHub())
    const mux = createHubMux({ hub: wrappedHub, localDID: 'bob', onSubscribeFailed: () => {} })

    mux.mailbox.subscribe('bob', 'topic:x')
    const subscription = mux.mailbox.receive('bob', { topicID: 'topic:x' })
    const iterator = subscription[Symbol.asyncIterator]()
    await flush()

    await wrappedHub.publish({
      senderDID: 'alice',
      topicID: 'topic:x',
      payload: new Uint8Array([1]),
    })
    const next = await iterator.next()
    expect(next.done).toBe(false)

    // Closed without ever acking: a consumer that has not read a frame to completion has not
    // handled it, so closing must not tell the hub it was durably handled. The claim is
    // abandoned — dropped from `pending` — not acked; the hub keeps it for the next drain.
    subscription.return?.()
    await flush()
    expect(ackCalls()).toBe(0)

    // Not stranded either: a fresh delivery on the same sequenceID (what the next drain would
    // do) must still resolve normally rather than finding a leftover entry from the closed sink.
    await mux.dispose()
  })

  test('closing with a frame still queued and never read produces no upstream ack', async () => {
    const { hub: wrappedHub, ackCalls } = hubCountingAcks(new DurableFakeHub())
    const mux = createHubMux({ hub: wrappedHub, localDID: 'bob', onSubscribeFailed: () => {} })

    mux.mailbox.subscribe('bob', 'topic:x')
    const subscription = mux.mailbox.receive('bob', { topicID: 'topic:x' })
    await flush()

    // Two frames delivered, neither ever pulled via `next()` — they sit unread in `queue`.
    await wrappedHub.publish({
      senderDID: 'alice',
      topicID: 'topic:x',
      payload: new Uint8Array([1]),
    })
    await wrappedHub.publish({
      senderDID: 'alice',
      topicID: 'topic:x',
      payload: new Uint8Array([2]),
    })
    await flush()

    // The old (wrong) rule acked on queue rather than on hand-out, producing two upstream acks
    // for frames this consumer never read — a silent loss against a durable hub. Closing must
    // abandon both claims instead.
    subscription.return?.()
    await flush()
    expect(ackCalls()).toBe(0)

    await mux.dispose()
  })

  test("the consumer's explicit ack still produces exactly one upstream ack", async () => {
    const { hub: wrappedHub, ackCalls } = hubCountingAcks(new DurableFakeHub())
    const mux = createHubMux({ hub: wrappedHub, localDID: 'bob', onSubscribeFailed: () => {} })

    mux.mailbox.subscribe('bob', 'topic:x')
    const subscription = mux.mailbox.receive('bob', { topicID: 'topic:x' })
    const iterator = subscription[Symbol.asyncIterator]()
    await flush()

    await wrappedHub.publish({
      senderDID: 'alice',
      topicID: 'topic:x',
      payload: new Uint8Array([1]),
    })
    const next = await iterator.next()
    expect(next.done).toBe(false)

    await subscription.ack?.(next.value.sequenceID)
    await flush()
    expect(ackCalls()).toBe(1)

    subscription.return?.()
    await mux.dispose()
    // Closing after the explicit ack must not produce a second one for the same frame.
    expect(ackCalls()).toBe(1)
  })
})
