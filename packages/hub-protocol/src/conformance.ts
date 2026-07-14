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
 * `createStore` MUST return an empty store — every case gets a fresh one — configured with a
 * default retention of zero, so that `purge({ olderThan: 0 })` can empty a topic whose only
 * subscriber holds the default. (A non-zero default floors the age bound and the purge-empties
 * clauses would never fire; hosts run the suite against a zero-default store.)
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
  /**
   * The per-topic log depth the store returned by `createStore` is configured to keep before it
   * evicts the oldest log frame — the count that governs its depth-based retention. A host with
   * no depth bound omits it, and the depth clause is skipped. When present it counts LOG frames
   * only: the clause floods a topic with this many mailbox frames and asserts the commit log
   * survives, so the store MUST be configured with a modest value (at least 11, to leave the
   * ordering clause's frames intact) to keep the run quick.
   */
  maxDepth?: number
}

const ALICE = 'did:key:alice'
const BOB = 'did:key:bob'
const CAROL = 'did:key:carol'
const TOPIC = 'topic:conformance'

function payload(byte: number): Uint8Array {
  return new Uint8Array([byte])
}

export function testHubStoreConformance(params: HubStoreConformanceParams): void {
  const { createStore, maxRetention, maxDepth } = params

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
      // And the mailbox frame is not in the log even BEFORE it is acked. Asserting this only
      // after the ack would pass on a store that puts mailbox frames in the log, because the
      // ack is what removes them — the assertion has to come first to mean anything.
      expect(result.messages.map((message) => message.sequenceID)).toEqual([logged])

      await store.ack({ recipientDID: BOB, sequenceIDs: [mailbox] })
      const afterAck = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(afterAck.head).toBe(logged)
      expect(afterAck.messages.map((message) => message.sequenceID)).toEqual([logged])
    })

    test('a mailbox publish to a log topic is delivered, and does not appear in the log', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })

      const first = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })
      // A mailbox frame on a topic that carries a log. Nothing stops a member publishing one:
      // the class is the publisher's to choose, and the store never infers it from the topic.
      const mailbox = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
        retain: 'mailbox',
      })
      const second = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(3),
        retain: 'log',
      })

      // It IS delivered. Push is untouched by the class: a mailbox frame reaches every
      // subscriber exactly as it always did.
      const delivered = await store.fetch({ recipientDID: BOB })
      expect(delivered.messages.map((message) => message.sequenceID)).toEqual([
        first,
        mailbox,
        second,
      ])

      // And it is NOT in the log. A topic's log is its log-class frames and nothing else.
      //
      // This is what makes the log's tip reachable. A mailbox frame does not move the head,
      // so a reader that met one in the log would advance its cursor to a position the head
      // can never equal — and every compare-and-set it anchored there would lose, forever,
      // on a frame that is not even retained. One such publish, by any member of the topic,
      // would permanently wedge every writer on it. The class is the publisher's to choose;
      // it must not be theirs to poison the log with.
      const log = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(log.messages.map((message) => message.sequenceID)).toEqual([first, second])
      expect(log.head).toBe(second)
      expect(log.oldest).toBe(first)

      // Paging honours the class too: the limit counts log frames, so a page of mailbox
      // frames cannot hand a draining reader an empty page while log frames still wait.
      const page = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC, after: first })
      expect(page.messages.map((message) => message.sequenceID)).toEqual([second])
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
        retain: 'log',
        publishID: 'publish-1',
      })

      // The replay is the caller re-sending what it journalled, byte for byte — including an
      // expectedHead that the accepted publish above has itself made stale. The dedup check must
      // precede the compare-and-set: a store that compares first raises HeadMismatchError here,
      // and the caller concludes its publish was lost when it landed.
      const replayed = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        expectedHead: null,
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

      // The first publish on the topic: the caller journals `expectedHead: null` and this key.
      const sequenceID = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        expectedHead: null,
        publishID: 'publish-1',
      })
      // A later entry gives trim an exclusive bound past `sequenceID`.
      const sentinel = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
        retain: 'log',
      })

      // The dedup record has its own retention and is never removed by trim. A store that hangs
      // the key off the message row loses it here, and the replay below silently becomes an
      // ordinary new publish — which then fails its compare-and-set against a head that names the
      // frame trim just removed, with no way for the caller to learn that its publish had landed.
      await store.trim({ topicID: TOPIC, before: sentinel })

      const replayed = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        expectedHead: null,
        publishID: 'publish-1',
      })
      // The sequenceID it returns names a frame that no longer exists, and that is correct: the
      // replay asks "did my publish land?", not "give me my frame".
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
      // A log frame, so that the allowed call below has something to hand back: the subject
      // here is authorization, and a mailbox frame would be absent from the log for a reason
      // that has nothing to do with who is asking.
      await store.publish({ senderDID: ALICE, topicID: TOPIC, payload: payload(1), retain: 'log' })

      const allowed = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(allowed.messages).toHaveLength(1)

      await expect(store.fetchTopic({ subscriberDID: CAROL, topicID: TOPIC })).rejects.toThrow(
        NotSubscribedError,
      )
    })

    test('head is stored state: it survives a trim that empties the log', async () => {
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

      // Trim ABOVE the tip: every log frame goes, the one the head names included. Every other
      // trim clause leaves a surviving frame, so a host that derives `head = max(sequenceID)`
      // over the retained log passes them all — an empty log is the only thing that tells a
      // stored head from a derived one.
      await store.trim({ topicID: TOPIC, before: `${last}\uffff` })

      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      // The log really is empty: the frames are gone, not hidden. (Assert the deletion first, or a
      // store that trims nothing passes the head assertion below for free.)
      expect(result.messages).toHaveLength(0)
      expect(result.oldest).toBeNull()
      // And the head still names the last accepted log publish. A derived head is null here, and a
      // peer that reads null CASes `expectedHead: null`, wins, and forks the group at the hub.
      expect(result.head).toBe(last)
      expect(first < last).toBe(true)
    })

    test('head is stored state: it survives a purge that empties the log', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
      const last = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })

      // The most aggressive age sweep the hub can run, on a topic whose only subscriber holds the
      // default retention: it empties the log.
      await store.purge({ olderThan: 0 })

      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages).toHaveLength(0)
      expect(result.oldest).toBeNull()
      // purge is a deleter like trim and honours the same invariant: it never touches the head.
      // The head outlives the age bound exactly as it outlives the trim.
      expect(result.head).toBe(last)
    })

    test('the dedup record outlives the log: a replay after a purge still returns the original sequenceID', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
      const sequenceID = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        expectedHead: null,
        publishID: 'publish-1',
      })

      // purge empties the log — the frame the record names is gone...
      await store.purge({ olderThan: 0 })
      expect(
        (await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })).messages,
      ).toHaveLength(0)

      // ...but the dedup record has its own retention, and purge honours trim's invariants: no
      // deleter reaches it. A host that hangs the key off the frame loses it to the sweep, and the
      // replay silently becomes a new publish that then fails its compare-and-set against a head
      // naming the purged frame — the caller told its commit was lost when it landed.
      const replayed = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        expectedHead: null,
        publishID: 'publish-1',
      })
      expect(replayed).toBe(sequenceID)
    })

    test('unsubscribe frees the mailbox frame but never the log frame or the head', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
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

      // Both frames are pending for Bob before he leaves.
      const pending = await store.fetch({ recipientDID: BOB })
      expect(pending.messages.map((message) => message.sequenceID)).toEqual([mailbox, logged])

      // Bob is the only subscriber. unsubscribe is a delivery operation, not a trim: it frees the
      // mailbox frame whose last reader Bob was, and leaves the log frame — which trim alone may
      // remove — standing. A host that implements unsubscribe as "drop this subscriber's deliveries
      // then GC any frame with no deliveries left" destroys the commit log the first time a group's
      // last member unsubscribes.
      await store.unsubscribe(BOB, TOPIC)
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })

      // The mailbox frame is gone: its only reader left...
      expect((await store.fetch({ recipientDID: BOB })).messages).toHaveLength(0)
      // ...and the log frame and the head are exactly where they were.
      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([logged])
      expect(result.head).toBe(logged)
    })

    test('an absent retain defaults to mailbox: the frame is delivery-derived and never enters the log', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
      await store.subscribe({ subscriberDID: CAROL, topicID: TOPIC })

      // No `retain`. The default is the whole backward-compatibility hinge: every app, rendezvous
      // and tunnel frame in the system publishes without one, and a host that defaults an absent
      // `retain` to 'log' turns all of them into log-class frames — never GC'd, each moving the
      // head of every topic it touches.
      const sequenceID = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
      })

      // It never was a log frame: it is absent from the log and it did not move the head...
      const before = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(before.messages).toHaveLength(0)
      expect(before.head).toBeNull()
      // ...and it IS delivered, to every subscriber, exactly as a mailbox frame always was.
      expect((await store.fetch({ recipientDID: BOB })).messages.map((m) => m.sequenceID)).toEqual([
        sequenceID,
      ])

      // Delivery-derived: once every subscriber acks, the frame is gone.
      await store.ack({ recipientDID: BOB, sequenceIDs: [sequenceID] })
      await store.ack({ recipientDID: CAROL, sequenceIDs: [sequenceID] })
      expect((await store.fetch({ recipientDID: BOB })).messages).toHaveLength(0)
      expect((await store.fetch({ recipientDID: CAROL })).messages).toHaveLength(0)

      // The frame is deleted, and the head — which it never moved — is still null.
      const after = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(after.head).toBeNull()
      expect(after.oldest).toBeNull()
    })

    test('trim removes only log-class frames: a mailbox frame on the same topic is untouched', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
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

      // Trim past both frames. trim removes log entries, and a mailbox frame is not one — it is
      // delivery-derived, freed by ack or age, never by trim. A host that scopes its DELETE to the
      // whole topic rather than to the log class silently drops the pending mail below the bound.
      await store.trim({ topicID: TOPIC, before: `${logged}\uffff` })

      // The log frame is gone...
      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages).toHaveLength(0)
      // ...and the mailbox frame's pending delivery is untouched and still deliverable.
      expect((await store.fetch({ recipientDID: BOB })).messages.map((m) => m.sequenceID)).toEqual([
        mailbox,
      ])
    })

    if (maxDepth != null) {
      test('the depth bound counts only log frames: a mailbox flood cannot evict the commit log', async () => {
        const store = await createStore()
        await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })

        // The depth bound is real, and it is the paired deletion this clause needs: publish one
        // past it in LOG frames, and the oldest log frame is evicted, oldest first.
        const logIDs: Array<string> = []
        for (let index = 0; index <= maxDepth; index++) {
          logIDs.push(
            await store.publish({
              senderDID: ALICE,
              topicID: TOPIC,
              payload: payload(index & 0xff),
              retain: 'log',
            }),
          )
        }
        const bounded = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
        expect(bounded.messages).toHaveLength(maxDepth)
        expect(bounded.oldest).toBe(logIDs[1])
        expect(bounded.head).toBe(logIDs[logIDs.length - 1])

        // Now the flood. A separate topic: one log frame — the commit — then `maxDepth` mailbox
        // frames on the same topic. The suite has already established that any member may publish a
        // mailbox frame to a log topic, so a host that counts them against the same depth lets that
        // member evict the commit log, and offline peers can no longer converge from the hub.
        const other = 'topic:conformance-depth'
        await store.subscribe({ subscriberDID: BOB, topicID: other })
        const commit = await store.publish({
          senderDID: ALICE,
          topicID: other,
          payload: payload(0),
          retain: 'log',
        })
        for (let index = 0; index < maxDepth; index++) {
          await store.publish({
            senderDID: ALICE,
            topicID: other,
            payload: payload(index & 0xff),
            retain: 'mailbox',
          })
        }

        const survived = await store.fetchTopic({ subscriberDID: BOB, topicID: other })
        expect(survived.messages.map((message) => message.sequenceID)).toEqual([commit])
        expect(survived.head).toBe(commit)
      })
    }
  })
}
