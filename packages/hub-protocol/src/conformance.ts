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
 * Every clause here exists because a plausible implementation gets it wrong. Three are
 * load-bearing: a store that treats `retain` as a no-op passes everything except "the retention
 * class governs deletion", a store that derives all retention from delivery passes everything
 * except "publish with no subscribers is retained", and a store that hangs the idempotency key
 * off the message row passes everything except "the dedup record outlives the log".
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

import { HeadMismatchError, NotSubscribedError, RetentionExceededError } from './errors.js'
import type { HubStore } from './types.js'

export type HubStoreConformanceParams = {
  /** Returns a fresh, empty store. Called once per test case. */
  createStore: () => HubStore | Promise<HubStore>
  /**
   * The maximum retention, in seconds, the store returned by `createStore` is configured to
   * allow. Must be greater than zero — a hub that retains nothing has nothing to serve.
   */
  maxRetention: number
}

const ALICE = 'did:key:alice'
const BOB = 'did:key:bob'
const CAROL = 'did:key:carol'
const TOPIC = 'topic:conformance'

function payload(byte: number): Uint8Array {
  return new Uint8Array([byte])
}

export function testHubStoreConformance(params: HubStoreConformanceParams): void {
  const { createStore, maxRetention } = params

  describe('HubStore conformance', () => {
    test('the retention class governs deletion: an acked mailbox frame is gone, an acked log frame is not', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })

      // Two publishes to the same topic, with the same subscribers, differing only in class.
      const mailbox = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'mailbox',
      })
      const logged = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
        retain: 'log',
      })

      await store.ack({ recipientDID: BOB, sequenceIDs: [mailbox, logged] })
      expect((await store.fetch({ recipientDID: BOB })).messages).toHaveLength(0)

      // Every subscriber has read both. The mailbox frame's readers were all known at publish
      // time, so it is done. The log frame's may not be: a member invited tomorrow must read
      // frames published today, and no refcount over current subscribers can account for it.
      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([logged])
      expect(result.head).toBe(logged)
    })

    test('a mailbox publish does not move the head', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })

      const logged = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })
      const mailbox = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
        retain: 'mailbox',
      })
      expect(mailbox).not.toBe(logged)

      // The head is the last accepted LOG publish. A store that advances it on every publish
      // anchors the head to a frame that the frame's own last ack deletes: readers pull the log,
      // never see that sequenceID, and every later conditional publish compares against
      // something no reader can fetch.
      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.head).toBe(logged)

      await store.ack({ recipientDID: BOB, sequenceIDs: [mailbox] })
      const afterAck = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(afterAck.head).toBe(logged)
      expect(afterAck.messages.map((message) => message.sequenceID)).toEqual([logged])
    })

    test('a publish to a topic with no subscribers is retained and can be pulled later', async () => {
      const store = await createStore()

      const sequenceID = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })
      expect(typeof sequenceID).toBe('string')

      // A log frame's retention is not a function of delivery: it is there even though nobody
      // was subscribed when it was published.
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([sequenceID])
      expect(result.messages[0].payload).toEqual(payload(1))
      expect(result.head).toBe(sequenceID)
      expect(result.oldest).toBe(sequenceID)
    })

    test('ack deletes the delivery, not the log entry', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
      const sequenceID = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })

      await store.ack({ recipientDID: BOB, sequenceIDs: [sequenceID] })
      const delivered = await store.fetch({ recipientDID: BOB })
      expect(delivered.messages).toHaveLength(0)

      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([sequenceID])
      expect(result.head).toBe(sequenceID)
    })

    test('trimming an entry removes the deliveries that pointed at it', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
      const first = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })
      const last = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
        retain: 'log',
      })

      await store.trim({ topicID: TOPIC, before: last })

      // Bob acked neither, so both were pending. A delivery references a log entry and does not
      // own it — and it cannot be pushed once its referent is gone, so it goes with it. A store
      // whose delivery rows do not cascade leaks a row that can never be delivered.
      const delivered = await store.fetch({ recipientDID: BOB })
      expect(delivered.messages.map((message) => message.sequenceID)).toEqual([last])
      expect(first < last).toBe(true)
    })

    test('a subscribe above the hub maximum is refused rather than clamped', async () => {
      const store = await createStore()

      await expect(
        store.subscribe({
          subscriberDID: BOB,
          topicID: TOPIC,
          retention: maxRetention + 1,
        }),
      ).rejects.toThrow(RetentionExceededError)

      // Refused, not silently downgraded to the maximum: a peer that believed it had asked for
      // more would be stranded. Bob is not a subscriber at all.
      await expect(store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })).rejects.toThrow(
        NotSubscribedError,
      )
    })

    test('a topic keeps its frames for the longest retention any subscriber asked for', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
      await store.subscribe({ subscriberDID: CAROL, topicID: TOPIC, retention: maxRetention })

      const sequenceID = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })

      // The most aggressive expiry sweep the hub can run: it frees nothing here, because Carol
      // asked for the maximum and the topic's bound is the longest any subscriber asked for.
      await store.purge({ olderThan: 0 })

      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([sequenceID])
      expect(result.head).toBe(sequenceID)
    })

    test('trim is the only deleter: head survives a trim while oldest moves', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
      const first = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })
      const last = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
        retain: 'log',
      })

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
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })

      const sequenceIDs: Array<string> = []
      for (let index = 0; index < 11; index++) {
        sequenceIDs.push(
          await store.publish({
            senderDID: ALICE,
            topicID: TOPIC,
            payload: payload(index),
            retain: 'log',
          }),
        )
      }

      // Byte order is the only order the design has: `expectedHead` equality, `head` and `oldest`
      // against a cursor, and `after` as an exclusive cursor all compare these as strings. A host
      // minting a bare decimal fails here on the 9-to-10 boundary ("10" < "9"); a host minting a
      // UUID fails on the very first pair.
      expect([...sequenceIDs].sort()).toEqual(sequenceIDs)
      for (let index = 1; index < sequenceIDs.length; index++) {
        expect(sequenceIDs[index] > sequenceIDs[index - 1]).toBe(true)
      }
    })

    test('expectedHead null is accepted only while the topic has never had a log publish', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })

      const sequenceID = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        expectedHead: null,
      })

      await expect(
        store.publish({
          senderDID: ALICE,
          topicID: TOPIC,
          payload: payload(2),
          retain: 'log',
          expectedHead: null,
        }),
      ).rejects.toThrow(HeadMismatchError)

      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.head).toBe(sequenceID)
      expect(result.messages).toHaveLength(1)
    })

    test('two publishes at the same head: one accepted, one rejected, nothing stored for the loser', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
      const first = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })

      const winner = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
        retain: 'log',
        expectedHead: first,
      })

      await expect(
        store.publish({
          senderDID: ALICE,
          topicID: TOPIC,
          payload: payload(3),
          retain: 'log',
          expectedHead: first,
        }),
      ).rejects.toThrow(HeadMismatchError)

      // "Stores nothing" is the load-bearing half, and it is the half a store that appends and
      // THEN throws passes on the throw alone. The loser left no log entry, no delivery row, and
      // did not move the head: payload(3) is nowhere, in either index.
      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([first, winner])
      expect(result.messages.map((message) => message.payload)).toEqual([payload(1), payload(2)])
      expect(result.head).toBe(winner)

      const delivered = await store.fetch({ recipientDID: BOB })
      expect(delivered.messages.map((message) => message.sequenceID)).toEqual([first, winner])
    })

    test('a replayed publishID returns the original sequenceID and appends nothing', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })

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
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })

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

    /**
     * READ THIS BEFORE TRUSTING A GREEN RUN OF THIS CASE.
     *
     * As written here it proves almost nothing. It fires N publishes without awaiting between
     * them, but they run on ONE event loop against ONE connection: whatever the store does
     * between reading the head and writing it, nothing interleaves, so a store that reads the
     * head, mints a sequence and writes — three statements, no transaction — passes this case
     * every time while being exactly the race the head exists to eliminate. An in-memory store
     * passing it is a tautology, not evidence.
     *
     * What it does catch: a store that ignores `expectedHead` outright, and one whose losers do
     * not raise HeadMismatchError.
     *
     * To have any force, a host MUST also run this against its real database over SEPARATE
     * CONNECTIONS, with the N publishes genuinely concurrent. That is the only version that
     * proves the head comparison, the sequence mint, the append and the head advance happen in
     * one transaction. Treating this in-process case as proof of atomicity is the specific
     * mistake a green suite invites.
     */
    test('racing publishes at the same head yield exactly one accepted append', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
      const first = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })

      const racers = [2, 3, 4, 5, 6].map((byte) =>
        store.publish({
          senderDID: ALICE,
          topicID: TOPIC,
          payload: payload(byte),
          retain: 'log',
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
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
      await store.publish({ senderDID: ALICE, topicID: TOPIC, payload: payload(1) })

      const allowed = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(allowed.messages).toHaveLength(1)

      await expect(store.fetchTopic({ subscriberDID: CAROL, topicID: TOPIC })).rejects.toThrow(
        NotSubscribedError,
      )
    })
  })
}
