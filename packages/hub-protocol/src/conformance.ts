/**
 * Conformance suite for the `HubStore` contract.
 *
 * Hosts implementing `HubStore` run this against their own store:
 *
 * ```ts
 * import { testHubStoreConformance } from '@kumiai/hub-protocol/conformance'
 *
 * testHubStoreConformance({ createStore: () => new SQLHubStore(freshDatabase()) })
 * ```
 *
 * `createStore` MUST return an empty store — every case gets a fresh one.
 *
 * Every clause here exists because a plausible implementation gets it wrong. Two are
 * load-bearing: a store that derives retention from delivery passes everything except
 * "publish with no subscribers is retained", and a store that hangs the idempotency key off
 * the message row passes everything except "the dedup record outlives the log".
 *
 * **Trim** is driven through `trim({ topicID, before })`. Depth-versus-age retention policy is
 * the host's; the suite only asserts the invariant `trim` fixes: it moves `oldest`, never
 * touches `head`, and never removes a `publishID` dedup record.
 *
 * **Atomicity cannot be proven in-process.** The racing-publish case here runs N publishes
 * concurrently on one store instance; a single-threaded, non-transactional store that does
 * read-then-write compare-and-set can still pass it, because nothing interleaves between the
 * read and the write. Hosts MUST also run that case against their real database over
 * SEPARATE CONNECTIONS — that is the only version of it that proves the head comparison, the
 * sequence mint, the append and the head advance happen in one transaction.
 *
 * @module conformance
 */
import { describe, expect, test } from 'vitest'

import { HeadMismatchError, NotSubscribedError } from './errors.js'
import type { HubStore } from './types.js'

export type HubStoreConformanceParams = {
  /** Returns a fresh, empty store. Called once per test case. */
  createStore: () => HubStore | Promise<HubStore>
}

const ALICE = 'did:key:alice'
const BOB = 'did:key:bob'
const CAROL = 'did:key:carol'
const TOPIC = 'topic:conformance'

function payload(byte: number): Uint8Array {
  return new Uint8Array([byte])
}

export function testHubStoreConformance(params: HubStoreConformanceParams): void {
  const { createStore } = params

  describe('HubStore conformance', () => {
    test('a publish to a topic with no subscribers is retained and can be pulled later', async () => {
      const store = await createStore()

      const sequenceID = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
      })
      expect(typeof sequenceID).toBe('string')

      // Retention is not a function of delivery: the frame is in the log even though nobody
      // was subscribed when it was published.
      await store.subscribe(BOB, TOPIC)
      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([sequenceID])
      expect(result.messages[0].payload).toEqual(payload(1))
      expect(result.head).toBe(sequenceID)
      expect(result.oldest).toBe(sequenceID)
    })

    test('ack deletes the delivery, not the log entry', async () => {
      const store = await createStore()
      await store.subscribe(BOB, TOPIC)
      const sequenceID = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
      })

      await store.ack({ recipientDID: BOB, sequenceIDs: [sequenceID] })
      const delivered = await store.fetch({ recipientDID: BOB })
      expect(delivered.messages).toHaveLength(0)

      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([sequenceID])
      expect(result.head).toBe(sequenceID)
    })

    test('trim is the only deleter: head survives a trim while oldest moves', async () => {
      const store = await createStore()
      await store.subscribe(BOB, TOPIC)
      const first = await store.publish({ senderDID: ALICE, topicID: TOPIC, payload: payload(1) })
      const last = await store.publish({ senderDID: ALICE, topicID: TOPIC, payload: payload(2) })

      const beforeTrim = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(beforeTrim.oldest).toBe(first)
      expect(beforeTrim.head).toBe(last)

      // Exclusive bound: only entries strictly below `last` are removed, so `last` survives
      // and stays head — trim moves oldest without touching head.
      await store.trim({ topicID: TOPIC, before: last })

      const after = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(after.messages.map((message) => message.sequenceID)).toEqual([last])
      expect(after.oldest).toBe(last)
      expect(after.head).toBe(last)
    })

    test('sequenceIDs are lexicographically ordered across the 9 to 10 boundary', async () => {
      const store = await createStore()
      await store.subscribe(BOB, TOPIC)

      const sequenceIDs: Array<string> = []
      for (let index = 0; index < 11; index++) {
        sequenceIDs.push(
          await store.publish({ senderDID: ALICE, topicID: TOPIC, payload: payload(index) }),
        )
      }

      expect([...sequenceIDs].sort()).toEqual(sequenceIDs)
      for (let index = 1; index < sequenceIDs.length; index++) {
        expect(sequenceIDs[index] > sequenceIDs[index - 1]).toBe(true)
      }
    })

    test('expectedHead null is accepted only while the topic has never had a publish', async () => {
      const store = await createStore()
      await store.subscribe(BOB, TOPIC)

      const sequenceID = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        expectedHead: null,
      })

      await expect(
        store.publish({
          senderDID: ALICE,
          topicID: TOPIC,
          payload: payload(2),
          expectedHead: null,
        }),
      ).rejects.toThrow(HeadMismatchError)

      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.head).toBe(sequenceID)
      expect(result.messages).toHaveLength(1)
    })

    test('two publishes at the same head: one accepted, one rejected, nothing stored for the loser', async () => {
      const store = await createStore()
      await store.subscribe(BOB, TOPIC)
      const first = await store.publish({ senderDID: ALICE, topicID: TOPIC, payload: payload(1) })

      const winner = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
        expectedHead: first,
      })

      await expect(
        store.publish({
          senderDID: ALICE,
          topicID: TOPIC,
          payload: payload(3),
          expectedHead: first,
        }),
      ).rejects.toThrow(HeadMismatchError)

      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([first, winner])
      expect(result.head).toBe(winner)
    })

    test('a replayed publishID returns the original sequenceID and appends nothing', async () => {
      const store = await createStore()
      await store.subscribe(BOB, TOPIC)

      const sequenceID = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        publishID: 'publish-1',
      })
      const replayed = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        publishID: 'publish-1',
      })
      expect(replayed).toBe(sequenceID)

      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([sequenceID])
      expect(result.head).toBe(sequenceID)
    })

    test('the dedup record outlives the log: a replay after a trim still returns the original sequenceID', async () => {
      const store = await createStore()
      await store.subscribe(BOB, TOPIC)

      const sequenceID = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        publishID: 'publish-1',
      })
      // A later entry gives trim an exclusive bound past `sequenceID`.
      const sentinel = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
      })

      // The dedup record has its own retention and is never removed by trim. A store that
      // hangs the key off the message row loses it here, and the replay below silently
      // becomes an ordinary new publish.
      await store.trim({ topicID: TOPIC, before: sentinel })

      const replayed = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        publishID: 'publish-1',
      })
      expect(replayed).toBe(sequenceID)

      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([sentinel])
      expect(result.head).toBe(sentinel)
    })

    test('racing publishes at the same head yield exactly one accepted append', async () => {
      const store = await createStore()
      await store.subscribe(BOB, TOPIC)
      const first = await store.publish({ senderDID: ALICE, topicID: TOPIC, payload: payload(1) })

      const racers = [2, 3, 4, 5, 6].map((byte) =>
        store.publish({
          senderDID: ALICE,
          topicID: TOPIC,
          payload: payload(byte),
          expectedHead: first,
        }),
      )
      const outcomes = await Promise.allSettled(racers)

      const accepted = outcomes.filter((outcome) => outcome.status === 'fulfilled')
      expect(accepted).toHaveLength(1)
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect(outcome.reason).toBeInstanceOf(HeadMismatchError)
        }
      }

      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages).toHaveLength(2)
    })

    test('fetchTopic refuses a non-subscriber', async () => {
      const store = await createStore()
      await store.subscribe(BOB, TOPIC)
      await store.publish({ senderDID: ALICE, topicID: TOPIC, payload: payload(1) })

      const allowed = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(allowed.messages).toHaveLength(1)

      await expect(store.fetchTopic({ subscriberDID: CAROL, topicID: TOPIC })).rejects.toThrow(
        NotSubscribedError,
      )
    })
  })
}
