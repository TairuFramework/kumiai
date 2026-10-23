import { HeadMismatchError } from '@kumiai/hub-protocol'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { FakeHub } from './fixtures/fake-hub.js'

const ALICE = 'did:key:alice'
const BOB = 'did:key:bob'
const TOPIC = 'topic:publish-id'

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))
afterEach(() => vi.useRealTimers())

describe.each([
  { name: 'FakeHub', Hub: FakeHub },
  { name: 'DurableFakeHub', Hub: DurableFakeHub },
])('$name publish IDs', ({ Hub }) => {
  test('expired double publish ID cannot bypass stale-head CAS', async () => {
    const hub = new Hub()
    hub.subscribe(BOB, TOPIC)
    const start = 100_000
    const cutoff = start + 365 * 24 * 60 * 60 * 1000
    const publish = {
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([1]),
      retain: 'log',
      publishID: 'expiring',
      expectedHead: null,
    } as const
    vi.setSystemTime(start)
    const accepted = await hub.publish(publish)
    vi.setSystemTime(cutoff - 1)
    hub.purgePublishIDs(Date.now())
    expect(await hub.publish(publish)).toEqual(accepted)
    vi.setSystemTime(cutoff)
    hub.purgePublishIDs(Date.now())
    await expect(hub.publish(publish)).rejects.toThrow(HeadMismatchError)
    expect(hub.published.map((message) => message.sequenceID)).toEqual([accepted.sequenceID])
    const log = await hub.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
    expect(log.head).toBe(accepted.sequenceID)
    expect(log.messages.map((message) => message.sequenceID)).toEqual([accepted.sequenceID])
    const fresh = await hub.publish({ ...publish, expectedHead: accepted.sequenceID })
    expect(fresh.sequenceID).toBe('000000000002')
  })

  test('accepted retry precedes CAS and preserves fanout', async () => {
    const hub = new Hub()
    hub.subscribe(BOB, TOPIC)
    const subscription = hub.receive(BOB)
    const iterator = subscription[Symbol.asyncIterator]()
    try {
      const publish = {
        senderDID: ALICE,
        topicID: TOPIC,
        payload: new Uint8Array([1]),
        retain: 'log',
        publishID: 'accepted',
        expectedHead: null,
      } as const
      const accepted = await hub.publish(publish)
      expect(accepted).toEqual({ sequenceID: '000000000001' })
      expect((await iterator.next()).value?.sequenceID).toBe(accepted.sequenceID)
      expect(await hub.publish(publish)).toEqual(accepted)
      const sentinel = await hub.publish({
        ...publish,
        publishID: 'sentinel',
        expectedHead: accepted.sequenceID,
      })
      expect((await iterator.next()).value?.sequenceID).toBe(sentinel.sequenceID)
      expect(hub.published.map((message) => message.sequenceID)).toEqual([
        accepted.sequenceID,
        sentinel.sequenceID,
      ])
    } finally {
      subscription.return?.()
    }
  })
})
