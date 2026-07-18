/**
 * Conformance suite for the behaviour a hub exposes at the **`LogHub` / `MailboxHub` seam** — the
 * shape the peer and tunnel layers actually hold, and the shape every in-repo test double
 * implements.
 *
 * `testHubStoreConformance` (`./index.js`) checks a `HubStore`, and exactly one implementation runs
 * it. The doubles the rpc and tunnel suites execute against are `LogHub`s, and until this file they
 * were checked by nothing — which is how three separate doubles came to have an infallible
 * `subscribe` while the real hub refuses, hiding a swallowed subscribe failure that stalls a peer
 * permanently.
 *
 * This is deliberately NOT the `HubStore` suite bridged through an adapter. A `HubStore` adapter
 * over a `LogHub` would have to implement the storage semantics the suite checks (delivery-derived
 * mailbox GC, the age bound, ack accounting), at which point the suite tests the adapter. Only the
 * clauses a `LogHub` can answer for on its own are here; the rest stay on the `HubStore` suite.
 *
 * The hub shapes are re-declared structurally below rather than imported from `@kumiai/hub-tunnel`.
 * `hub-tunnel` runs this suite over its own double, so depending on it here would put a cycle in
 * the package graph. Structural typing means a real `LogHub` satisfies these without a cast.
 *
 * @module hub-conformance/log-hub
 */
import type { StoredMessage } from '@kumiai/hub-protocol'
import { HeadMismatchError, NotSubscribedError, RetentionExceededError } from '@kumiai/hub-protocol'
import { describe, expect, test } from 'vitest'

export type ConformanceReceiveSubscription = AsyncIterable<StoredMessage> & {
  return?: () => void
  ack?: (sequenceID: string) => void | Promise<void>
}

export type ConformancePublishParams = {
  senderDID: string
  topicID: string
  payload: Uint8Array
  retain?: 'log' | 'mailbox'
  expectedHead?: string | null
  publishID?: string
}

/** The subset of `MailboxHub` (`@kumiai/hub-tunnel`) this suite exercises. */
export type ConformanceMailboxHub = {
  subscribe: (
    subscriberDID: string,
    topicID: string,
    options?: { retention?: number },
  ) => Promise<void> | void
  unsubscribe?: (subscriberDID: string, topicID: string) => Promise<void> | void
  receive: (subscriberDID: string) => ConformanceReceiveSubscription
  publish: (params: ConformancePublishParams) => Promise<{ sequenceID: string }>
}

/** The subset of `LogHub` (`@kumiai/hub-tunnel`) this suite exercises. */
export type ConformanceLogHub = ConformanceMailboxHub & {
  fetchTopic: (params: {
    subscriberDID: string
    topicID: string
    after?: string
    limit?: number
  }) => Promise<{ messages: Array<StoredMessage>; head: string | null; oldest: string | null }>
}

export type MailboxHubConformanceParams<Hub extends ConformanceMailboxHub> = {
  /** Returns a fresh, empty hub. Called once per test case. */
  createHub: (options: { maxRetention: number; maxDepth: number }) => Hub | Promise<Hub>
  /**
   * The retention ceiling, in seconds, `createHub` is asked to configure. A subscribe above it
   * MUST be refused; one exactly at it MUST be accepted.
   */
  maxRetention: number
  /**
   * The per-topic log depth `createHub` is asked to configure. Only the LogHub suite uses it: it
   * publishes `maxDepth + 1` log frames and asserts the oldest is gone. Keep it small.
   */
  maxDepth: number
  /** Prefix for the describe block, so a failure names the double it came from. */
  label: string
}

const ALICE = 'did:key:alice'
const BOB = 'did:key:bob'
const TOPIC = 'topic:log-hub-conformance'

function payload(byte: number): Uint8Array {
  return new Uint8Array([byte])
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `subscribe` is declared `Promise<void> | void`, and a double that refuses SYNCHRONOUSLY is as
 * conforming as one that rejects — a caller catching only a rejection is as broken as one catching
 * nothing. Wrapping in `Promise.resolve().then` makes both arrive as a rejection so a single
 * assertion covers each.
 */
function subscribing(
  hub: ConformanceMailboxHub,
  subscriberDID: string,
  topicID: string,
  options?: { retention?: number },
): Promise<void> {
  return Promise.resolve().then(() => hub.subscribe(subscriberDID, topicID, options))
}

/**
 * Read up to `limit` messages off a receive subscription, giving up after `timeoutMs` of silence.
 * A push hub delivers during `publish`, so the timeout is only ever paid by a clause asserting
 * that NOTHING arrives.
 */
async function drain(
  subscription: ConformanceReceiveSubscription,
  limit: number,
  timeoutMs = 50,
): Promise<Array<StoredMessage>> {
  const iterator = subscription[Symbol.asyncIterator]()
  const collected: Array<StoredMessage> = []
  while (collected.length < limit) {
    const next = await Promise.race([
      iterator.next(),
      sleep(timeoutMs).then(() => 'timeout' as const),
    ])
    if (next === 'timeout' || next.done === true) break
    collected.push(next.value)
  }
  // Closed unconditionally: a hub whose `receive` is a poll loop over a pull API keeps polling
  // until it is told to stop, and a clause asserting that nothing arrives would otherwise leave a
  // timer running past the end of the run.
  subscription.return?.()
  return collected
}

/**
 * The clauses a `MailboxHub` can answer for. Every `LogHub` runs these too
 * (see {@link testLogHubConformance}).
 */
export function testMailboxHubConformance<Hub extends ConformanceMailboxHub>(
  params: MailboxHubConformanceParams<Hub>,
): void {
  const { createHub, maxRetention, maxDepth, label } = params

  describe(`${label}: MailboxHub conformance`, () => {
    test('a publish is not echoed to its sender', async () => {
      const hub = await createHub({ maxRetention, maxDepth })
      hub.subscribe(ALICE, TOPIC)
      hub.subscribe(BOB, TOPIC)
      const toAlice = hub.receive(ALICE)
      const toBob = hub.receive(BOB)

      await hub.publish({ senderDID: ALICE, topicID: TOPIC, payload: payload(1) })

      // The real store builds recipients as "current subscribers MINUS the sender". A hub that
      // echoes lets a component whose correctness turns on receiving its own publish — a gather
      // counting its own reply toward a quorum, a client confirming a publish by observing it
      // arrive — pass here and deliver nothing in production.
      expect(await drain(toAlice, 1)).toEqual([])
      // ...and the control: the echo is absent because the sender is excluded, not because the
      // hub delivered nothing at all.
      expect((await drain(toBob, 1)).map((message) => message.senderDID)).toEqual([ALICE])
    })

    test('sequenceIDs are lexicographically ordered across the 9 to 10 boundary', async () => {
      const hub = await createHub({ maxRetention, maxDepth })
      hub.subscribe(BOB, TOPIC)

      const minted: Array<string> = []
      for (let index = 0; index < 11; index++) {
        const { sequenceID } = await hub.publish({
          senderDID: ALICE,
          topicID: TOPIC,
          payload: payload(index),
        })
        minted.push(sequenceID)
      }

      // Every comparison a caller makes on a sequenceID is a STRING comparison: `after` as an
      // exclusive cursor, a cursor against `head` and `oldest`. A bare decimal counter types fine
      // and silently inverts at the 9→10 boundary ("10" < "9"), so the tenth frame is invisible to
      // a cursor parked on the ninth. Sorting must be a no-op.
      expect([...minted].sort()).toEqual(minted)
      for (let index = 1; index < minted.length; index++) {
        expect(minted[index] > minted[index - 1]).toBe(true)
      }
    })

    test('a subscribe above the hub maximum is refused, never clamped', async () => {
      const hub = await createHub({ maxRetention, maxDepth })

      // Refused, never clamped: the contract says so in as many words
      // (`hub-tunnel/src/transport.ts`, `HubSubscribeOptions.retention`). A silent downgrade
      // strands a peer that believed it had asked for more.
      await expect(subscribing(hub, BOB, TOPIC, { retention: maxRetention + 1 })).rejects.toThrow(
        RetentionExceededError,
      )
    })

    test('a subscribe exactly at the hub maximum is accepted', async () => {
      const hub = await createHub({ maxRetention, maxDepth })

      // The boundary is inclusive, and it matters: the app lane's default retention sits exactly
      // ON the store's default ceiling. A hub refusing at the boundary rejects every default peer.
      await expect(subscribing(hub, BOB, TOPIC, { retention: maxRetention })).resolves.not.toThrow()
    })
  })
}

/** The MailboxHub clauses plus the ones that need a readable log. */
export function testLogHubConformance<Hub extends ConformanceLogHub>(
  params: MailboxHubConformanceParams<Hub>,
): void {
  const { createHub, maxRetention, maxDepth, label } = params

  testMailboxHubConformance(params)

  describe(`${label}: LogHub conformance`, () => {
    test('fetchTopic refuses a non-subscriber', async () => {
      const hub = await createHub({ maxRetention, maxDepth })
      hub.subscribe(ALICE, TOPIC)
      await hub.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })

      // The hub gates a topic pull on the caller's own subscription. This is what turns a
      // swallowed subscribe failure into a permanent stall rather than a degraded read, so a
      // double that serves anyone cannot show the stall at all.
      await expect(hub.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })).rejects.toThrow(
        NotSubscribedError,
      )
    })

    test('a refused subscribe leaves no subscription behind', async () => {
      const hub = await createHub({ maxRetention, maxDepth })
      await expect(subscribing(hub, BOB, TOPIC, { retention: maxRetention + 1 })).rejects.toThrow(
        RetentionExceededError,
      )

      // "Refused, never clamped" is a claim about state, not just about the throw: a hub that
      // threw AND subscribed at its ceiling would pass the throw clause while leaving the caller
      // believing it holds a retention it does not.
      await expect(hub.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })).rejects.toThrow(
        NotSubscribedError,
      )
    })

    test('a mailbox publish is delivered, stays out of the log, and does not move the head', async () => {
      const hub = await createHub({ maxRetention, maxDepth })
      hub.subscribe(BOB, TOPIC)
      const { sequenceID: logged } = await hub.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
      })
      await hub.publish({ senderDID: ALICE, topicID: TOPIC, payload: payload(2) })

      // A mailbox frame in the log would be a position the head can never equal: a reader whose
      // cursor lands on it loses every compare-and-set anchored there, forever.
      const result = await hub.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([logged])
      expect(result.head).toBe(logged)
    })

    test('two publishes at the same head: one accepted, one refused, nothing stored for the loser', async () => {
      const hub = await createHub({ maxRetention, maxDepth })
      hub.subscribe(BOB, TOPIC)
      const { sequenceID: first } = await hub.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        expectedHead: null,
      })

      await expect(
        hub.publish({
          senderDID: BOB,
          topicID: TOPIC,
          payload: payload(2),
          retain: 'log',
          expectedHead: null,
        }),
      ).rejects.toThrow(HeadMismatchError)

      // A loser leaves the log, the head and the sequence exactly as it found them. A hub that
      // accepted both is a forked log, which no peer-side rule below it can repair.
      const result = await hub.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([first])
      expect(result.head).toBe(first)
    })

    test('a replayed publishID returns the original sequenceID and appends nothing', async () => {
      const hub = await createHub({ maxRetention, maxDepth })
      hub.subscribe(BOB, TOPIC)
      const { sequenceID: first } = await hub.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        expectedHead: null,
        publishID: 'publish-1',
      })

      // The dedup check comes BEFORE the compare-and-set, and the order is the contract: a replay
      // carries the expectedHead the caller journalled, which its own accepted publish made stale.
      // Comparing first would tell a peer its commit was lost when it had landed.
      const replay = await hub.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: payload(1),
        retain: 'log',
        expectedHead: null,
        publishID: 'publish-1',
      })
      expect(replay.sequenceID).toBe(first)

      const result = await hub.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages.map((message) => message.sequenceID)).toEqual([first])
    })

    test('a log topic trims itself once its depth bound is exceeded', async () => {
      const hub = await createHub({ maxRetention, maxDepth })
      hub.subscribe(BOB, TOPIC)

      const minted: Array<string> = []
      for (let index = 0; index <= maxDepth; index++) {
        const { sequenceID } = await hub.publish({
          senderDID: ALICE,
          topicID: TOPIC,
          payload: payload(index),
          retain: 'log',
        })
        minted.push(sequenceID)
      }

      // A hub that retains unconditionally never produces a cursor below `oldest` on its own, so
      // every path that must cope with a trimmed log — commit-lane pull, journal replay, the app
      // lane's below-retention notice — is only ever reached by a test that remembered to arrange
      // one by hand. A peer returning after `maxDepth` commits is a real state; a double that
      // cannot reach it hides whatever the peer does there.
      const result = await hub.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
      expect(result.messages).toHaveLength(maxDepth)
      expect(result.oldest).toBe(minted[1])
      // The head names the last accepted log publish and outlives the frames a trim removes.
      expect(result.head).toBe(minted[minted.length - 1])
      // The evicted frame is gone from the log, not merely hidden behind a cursor.
      expect(result.messages.map((message) => message.sequenceID)).not.toContain(minted[0])
    })
  })
}
