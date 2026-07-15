/**
 * Conformance suite for the `HubStore` contract.
 *
 * Hosts implementing `HubStore` run this against their own store:
 *
 * ```ts
 * import { testHubStoreConformance } from '@kumiai/hub-conformance'
 *
 * testHubStoreConformance({ createStore: () => new SQLHubStore(freshDatabase()) })
 * ```
 *
 * `createStore` MUST return a fresh empty store per case, configured with default retention zero,
 * so `purge({ olderThan: 0 })` can empty a topic whose only subscriber holds the default. (A
 * non-zero default floors the age bound and the purge-empties clauses never fire.)
 *
 * Every clause exists because a plausible implementation gets it wrong. Three are load-bearing: a
 * store treating `retain` as a no-op passes all but "the retention class governs deletion"; one
 * deriving all retention from delivery passes all but "publish with no subscribers is retained";
 * one hanging the idempotency key off the message row passes all but "the dedup record outlives
 * the log".
 *
 * **Trim** is driven through `trim({ topicID, before })`. Depth-vs-age policy is the host's; the
 * suite asserts only trim's invariant: it moves `oldest`, never touches `head`, never removes a
 * `publishID` record.
 *
 * **Atomicity cannot be proven in-process.** The racing-publish case runs N publishes concurrently
 * on one instance, which a non-transactional read-then-write CAS store still passes because
 * nothing interleaves. Hosts MUST also run it against their real database over SEPARATE
 * CONNECTIONS — the only version that proves the head comparison, sequence mint, append and head
 * advance happen in one transaction.
 *
 * @module hub-conformance
 */
import type { HubStore } from '@kumiai/hub-protocol'
import { HeadMismatchError, NotSubscribedError, RetentionExceededError } from '@kumiai/hub-protocol'
import { describe, expect, test } from 'vitest'

export type HubStoreConformanceParams = {
  /** Returns a fresh, empty store. Called once per test case. */
  createStore: () => HubStore | Promise<HubStore>
  /**
   * The maximum retention, in seconds, the store returned by `createStore` is configured to
   * allow. Must be greater than zero — a hub that retains nothing has nothing to serve.
   */
  maxRetention: number
  /**
   * The per-topic log depth `createStore` is configured to keep before evicting the oldest log
   * frame. Omit it and the depth clause is skipped. When present it counts LOG frames only: the
   * clause floods a topic with this many mailbox frames and asserts the commit log survives. Use a
   * modest value (at least 11, to leave the ordering clause's frames intact) to keep the run quick.
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
      const { sequenceID: mailbox } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'mailbox',
      })
      const { sequenceID: logged } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
        retain: 'log',
      })

      await store.ack({ recipientDID: BOB, sequenceIDs: [mailbox, logged] })
      expect((await store.fetch({ recipientDID: BOB })).messages).toHaveLength(0)

      // Both acked. The mailbox frame's readers were all known at publish time, so it is gone.
      // The log frame stays: a member invited tomorrow must read frames published today, which no
      // refcount over current subscribers can account for.
      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([logged])
      expect(result.head).toBe(logged)
    })

    test('a mailbox publish does not move the head', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })

      const { sequenceID: logged } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })
      const { sequenceID: mailbox } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
        retain: 'mailbox',
      })
      expect(mailbox).not.toBe(logged)

      // The head is the last accepted LOG publish. A store advancing it on every publish anchors
      // the head to a frame the frame's own last ack deletes: readers pull the log, never see that
      // sequenceID, and every later conditional publish compares against something unfetchable.
      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.head).toBe(logged)
      // The mailbox frame is not in the log even BEFORE it is acked. Asserting only after the ack
      // would pass on a store that logs mailbox frames, since the ack is what removes them — the
      // assertion must come first to mean anything.
      expect(result.messages.map((message) => message.sequenceID)).toEqual([logged])

      await store.ack({ recipientDID: BOB, sequenceIDs: [mailbox] })
      const afterAck = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(afterAck.head).toBe(logged)
      expect(afterAck.messages.map((message) => message.sequenceID)).toEqual([logged])
    })

    test('a mailbox publish to a log topic is delivered, and does not appear in the log', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })

      const { sequenceID: first } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })
      // A mailbox frame on a topic that carries a log. Nothing stops a member: the class is the
      // publisher's to choose, and the store never infers it from the topic.
      const { sequenceID: mailbox } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
        retain: 'mailbox',
      })
      const { sequenceID: second } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(3),
        retain: 'log',
      })

      // It IS delivered. Push is untouched by the class: a mailbox frame reaches every subscriber.
      const delivered = await store.fetch({ recipientDID: BOB })
      expect(delivered.messages.map((message) => message.sequenceID)).toEqual([
        first,
        mailbox,
        second,
      ])

      // And it is NOT in the log (a topic's log is its log-class frames and nothing else), which
      // is what keeps the log's tip reachable. A mailbox frame does not move the head, so a reader
      // meeting one in the log would advance its cursor to a position the head can never equal, and
      // every CAS anchored there would lose forever on a non-retained frame. One such publish, by
      // any member, would permanently wedge every writer on the topic.
      const log = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(log.messages.map((message) => message.sequenceID)).toEqual([first, second])
      expect(log.head).toBe(second)
      expect(log.oldest).toBe(first)

      // Paging honours the class: the limit counts log frames, so a page of mailbox frames cannot
      // hand a draining reader an empty page while log frames still wait.
      const page = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC, after: first })
      expect(page.messages.map((message) => message.sequenceID)).toEqual([second])
    })

    test('a publish to a topic with no subscribers is retained and can be pulled later', async () => {
      const store = await createStore()

      const { sequenceID } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })
      expect(typeof sequenceID).toBe('string')

      // A log frame's retention is not a function of delivery: it is here though nobody was
      // subscribed when it was published.
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
      const { sequenceID } = await store.publish({
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
      const { sequenceID: first } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })
      const { sequenceID: last } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
        retain: 'log',
      })

      await store.trim({ topicID: TOPIC, before: last })

      // Bob acked neither, so both were pending. A delivery references a log entry, does not own
      // it, and cannot be pushed once its referent is gone, so it goes with it. A store whose
      // delivery rows do not cascade leaks a row that can never be delivered.
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

      // Refused, not downgraded: a peer that believed it had asked for more would be stranded. Bob
      // is not a subscriber at all.
      await expect(store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })).rejects.toThrow(
        NotSubscribedError,
      )
    })

    test('a topic keeps its frames for the longest retention any subscriber asked for', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
      await store.subscribe({ subscriberDID: CAROL, topicID: TOPIC, retention: maxRetention })

      const { sequenceID } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })

      // The most aggressive sweep frees nothing: Carol asked for the maximum, and the topic's
      // bound is the longest any subscriber asked for.
      await store.purge({ olderThan: 0 })

      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([sequenceID])
      expect(result.head).toBe(sequenceID)
    })

    test('trim is the only deleter: head survives a trim while oldest moves', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
      const { sequenceID: first } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })
      const { sequenceID: last } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
        retain: 'log',
      })

      const beforeTrim = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(beforeTrim.oldest).toBe(first)
      expect(beforeTrim.head).toBe(last)

      // Exclusive bound: only entries strictly below `last` are removed, so `last` survives and
      // stays head — trim moves oldest without touching head.
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
          (
            await store.publish({
              senderDID: ALICE,
              topicID: TOPIC,
              payload: payload(index),
              retain: 'log',
            })
          ).sequenceID,
        )
      }

      // Byte order is the only order the design has: `expectedHead` equality and `head`/`oldest`/
      // `after` as cursors all compare these as strings. A bare decimal fails on the 9-to-10
      // boundary ("10" < "9"); a UUID fails on the very first pair.
      expect([...sequenceIDs].sort()).toEqual(sequenceIDs)
      for (let index = 1; index < sequenceIDs.length; index++) {
        expect(sequenceIDs[index] > sequenceIDs[index - 1]).toBe(true)
      }
    })

    test('expectedHead null is accepted only while the topic has never had a log publish', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })

      const { sequenceID } = await store.publish({
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
      const { sequenceID: first } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })

      const { sequenceID: winner } = await store.publish({
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

      // "Stores nothing" is the load-bearing half — a store that appends then throws passes on the
      // throw alone. The loser left no log entry, no delivery row, and did not move the head:
      // payload(3) is nowhere, in either index.
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

      const { sequenceID } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        publishID: 'publish-1',
      })

      // The replay re-sends what the caller journalled, byte for byte — including an expectedHead
      // the accepted publish above has itself made stale. The dedup check must precede the CAS: a
      // store that compares first raises HeadMismatchError, and the caller concludes its publish
      // was lost when it landed.
      const { sequenceID: replayed } = await store.publish({
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

    test('a deduped publish reports deduped, appends nothing, and creates no new delivery', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })

      // The accepted publish: BOB gets a delivery, and the store reports deduped false. Returning
      // deduped true here (or omitting the flag) would tell the hub to skip the live fan-out of a
      // genuine new frame.
      const accepted = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        publishID: 'publish-dedup',
      })
      expect(accepted.deduped).toBe(false)

      // Drain and ack the one delivery, so BOB's queue is empty and the log holds exactly [seq].
      await store.ack({ recipientDID: BOB, sequenceIDs: [accepted.sequenceID] })
      expect((await store.fetch({ recipientDID: BOB })).messages).toHaveLength(0)

      // The replay: same publishID, byte for byte. Returns the SAME sequenceID and reports deduped
      // — the signal the hub reads to NOT re-fan-out. A store always returning deduped false goes
      // red here.
      const replay = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        publishID: 'publish-dedup',
      })
      expect(replay.sequenceID).toBe(accepted.sequenceID)
      expect(replay.deduped).toBe(true)

      // It appended nothing: the log is still exactly [seq], head unmoved.
      const log = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(log.messages.map((message) => message.sequenceID)).toEqual([accepted.sequenceID])
      expect(log.head).toBe(accepted.sequenceID)

      // And — the load-bearing half — it created NO new delivery. BOB acked the original and has an
      // empty queue; a store re-running fan-out on the replay would refill it, and the hub would
      // push a frame BOB already applied, named by a sequenceID whose delivery is gone. The queue
      // must stay empty.
      expect((await store.fetch({ recipientDID: BOB })).messages).toHaveLength(0)
    })

    test('the dedup record outlives the log: a replay after a trim still returns the original sequenceID', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })

      // The first publish on the topic: the caller journals `expectedHead: null` and this key.
      const { sequenceID } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        expectedHead: null,
        publishID: 'publish-1',
      })
      // A later entry gives trim an exclusive bound past `sequenceID`.
      const { sequenceID: sentinel } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
        retain: 'log',
      })

      // The dedup record has its own retention and is never removed by trim. A store hanging the
      // key off the message row loses it here, and the replay below silently becomes an ordinary
      // new publish — which then fails its CAS against a head naming the frame trim just removed,
      // with no way for the caller to learn its publish had landed.
      await store.trim({ topicID: TOPIC, before: sentinel })

      const { sequenceID: replayed } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        expectedHead: null,
        publishID: 'publish-1',
      })
      // The returned sequenceID names a frame that no longer exists, and that is correct: the
      // replay asks "did my publish land?", not "give me my frame".
      expect(replayed).toBe(sequenceID)

      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([sentinel])
      expect(result.head).toBe(sentinel)
    })

    /**
     * READ THIS BEFORE TRUSTING A GREEN RUN OF THIS CASE — in-process it proves almost nothing.
     * The N publishes fire without awaiting but run on ONE event loop against ONE connection, so
     * nothing interleaves between read and write: a three-statement, non-transactional CAS store
     * passes every time while being exactly the race the head exists to eliminate.
     *
     * It does catch a store that ignores `expectedHead` outright, or whose losers do not raise
     * HeadMismatchError.
     *
     * To have force, a host MUST also run this against its real database over SEPARATE CONNECTIONS
     * with the publishes genuinely concurrent — the only version that proves the head comparison,
     * sequence mint, append and head advance happen in one transaction.
     */
    test('racing publishes at the same head yield exactly one accepted append', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
      const { sequenceID: first } = await store.publish({
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
      // A log frame, so the allowed call below has something to hand back: the subject is
      // authorization, and a mailbox frame would be absent from the log for an unrelated reason.
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
      const { sequenceID: first } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })
      const { sequenceID: last } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
        retain: 'log',
      })

      // Trim ABOVE the tip: every log frame goes, including the one the head names. Every other
      // trim clause leaves a surviving frame, so a host deriving `head = max(sequenceID)` over the
      // retained log passes them all — an empty log is the only thing that tells a stored head from
      // a derived one.
      await store.trim({ topicID: TOPIC, before: `${last}\uffff` })

      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      // The log really is empty: frames gone, not hidden. (Assert deletion first, or a store that
      // trims nothing passes the head assertion below for free.)
      expect(result.messages).toHaveLength(0)
      expect(result.oldest).toBeNull()
      // And the head still names the last accepted log publish. A derived head is null here, and a
      // peer reading null CASes `expectedHead: null`, wins, and forks the group at the hub.
      expect(result.head).toBe(last)
      expect(first < last).toBe(true)
    })

    test('head is stored state: it survives a purge that empties the log', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
      const { sequenceID: last } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })

      // The most aggressive age sweep, on a topic whose only subscriber holds the default: it
      // empties the log.
      await store.purge({ olderThan: 0 })

      const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages).toHaveLength(0)
      expect(result.oldest).toBeNull()
      // purge honours trim's invariant: it never touches the head. The head outlives the age bound
      // exactly as it outlives a trim.
      expect(result.head).toBe(last)
    })

    test('the dedup record outlives the log: a replay after a purge still returns the original sequenceID', async () => {
      const store = await createStore()
      await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
      const { sequenceID } = await store.publish({
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
      // deleter reaches it. A host hanging the key off the frame loses it to the sweep, and the
      // replay silently becomes a new publish that fails its CAS against a head naming the purged
      // frame — the caller told its commit was lost when it landed.
      const { sequenceID: replayed } = await store.publish({
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
      const { sequenceID: mailbox } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'mailbox',
      })
      const { sequenceID: logged } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
        retain: 'log',
      })

      // Both frames are pending for Bob before he leaves.
      const pending = await store.fetch({ recipientDID: BOB })
      expect(pending.messages.map((message) => message.sequenceID)).toEqual([mailbox, logged])

      // Bob is the only subscriber. unsubscribe is a delivery operation, not a trim: it frees the
      // mailbox frame whose last reader Bob was, and leaves the log frame (which trim alone may
      // remove) standing. A host that implements unsubscribe as "drop this subscriber's deliveries
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

      // No `retain`. The default is the backward-compatibility hinge: every app, rendezvous and
      // tunnel frame publishes without one, and a host that defaults an absent `retain` to 'log'
      // turns all of them into log-class frames — never GC'd, each moving the head of its topic.
      const { sequenceID } = await store.publish({
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
      const { sequenceID: mailbox } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'mailbox',
      })
      const { sequenceID: logged } = await store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(2),
        retain: 'log',
      })

      // Trim past both frames. trim removes log entries; a mailbox frame is not one — it is
      // delivery-derived, freed by ack or age, never by trim. A DELETE scoped to the whole topic
      // rather than the log class silently drops the pending mail below the bound.
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

        // The depth bound is real: publish one past it in LOG frames, and the oldest log frame is
        // evicted, oldest first.
        const logIDs: Array<string> = []
        for (let index = 0; index <= maxDepth; index++) {
          logIDs.push(
            (
              await store.publish({
                senderDID: ALICE,
                topicID: TOPIC,
                payload: payload(index & 0xff),
                retain: 'log',
              })
            ).sequenceID,
          )
        }
        const bounded = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
        expect(bounded.messages).toHaveLength(maxDepth)
        expect(bounded.oldest).toBe(logIDs[1])
        expect(bounded.head).toBe(logIDs[logIDs.length - 1])

        // Now the flood. A separate topic: one log frame (the commit), then `maxDepth` mailbox
        // frames on it. Any member may publish a mailbox frame to a log topic, so a host counting
        // them against the same depth lets that member evict the commit log, and offline peers can
        // no longer converge from the hub.
        const other = 'topic:conformance-depth'
        await store.subscribe({ subscriberDID: BOB, topicID: other })
        const { sequenceID: commit } = await store.publish({
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
