import { HeadMismatchError, NotSubscribedError, RetentionExceededError } from '@kumiai/hub-protocol'
import { describe, expect, test, vi } from 'vitest'

import { createMemoryStore } from '../src/memoryStore.js'

const ALICE = 'did:key:alice'
const BOB = 'did:key:bob'
const CAROL = 'did:key:carol'
const TOPIC = 'topic:1'

describe('createMemoryStore pub/sub', () => {
  test('a mailbox publish with no subscribers is dropped: nobody was ever going to read it', async () => {
    const store = createMemoryStore()
    const id = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([1]),
    })
    expect(typeof id).toBe('string')
    expect((await store.fetch({ recipientDID: BOB })).messages).toHaveLength(0)

    // The mailbox class is delivery-derived, so a subscriber who arrives later gets nothing.
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    const log = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
    expect(log.messages).toHaveLength(0)
    expect(log.oldest).toBeNull()
  })

  test('a log publish with no subscribers is retained: its reader may not exist yet', async () => {
    const store = createMemoryStore()
    const id = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([1]),
      retain: 'log',
    })

    // Nobody was subscribed, so there is no delivery...
    expect((await store.fetch({ recipientDID: BOB })).messages).toHaveLength(0)

    // ...but a log frame's retention is not a function of delivery, and a subscriber who
    // arrives later can pull it.
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    const log = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
    expect(log.messages.map((m) => m.sequenceID)).toEqual([id])
    expect(log.head).toBe(id)
    expect(log.oldest).toBe(id)
  })

  test('publish fans out to current subscribers (minus sender)', async () => {
    const store = createMemoryStore()
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    await store.subscribe({ subscriberDID: ALICE, topicID: TOPIC })
    await store.publish({ senderDID: ALICE, topicID: TOPIC, payload: new Uint8Array([1, 2]) })

    const bob = await store.fetch({ recipientDID: BOB })
    expect(bob.messages).toHaveLength(1)
    expect(bob.messages[0].topicID).toBe(TOPIC)
    expect(bob.messages[0].senderDID).toBe(ALICE)
    expect(bob.messages[0].payload).toEqual(new Uint8Array([1, 2]))

    // Sender is excluded from its own publish.
    const alice = await store.fetch({ recipientDID: ALICE })
    expect(alice.messages).toHaveLength(0)
  })

  test('getSubscribers reflects subscribe / unsubscribe', async () => {
    const store = createMemoryStore()
    expect(await store.getSubscribers(TOPIC)).toEqual([])
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC }) // idempotent
    expect(await store.getSubscribers(TOPIC)).toEqual([BOB])
    await store.unsubscribe(BOB, TOPIC)
    expect(await store.getSubscribers(TOPIC)).toEqual([])
  })

  test('unsubscribe clears the subscriber pending deliveries for that topic', async () => {
    const store = createMemoryStore()
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    await store.subscribe({ subscriberDID: CAROL, topicID: TOPIC })
    await store.publish({ senderDID: ALICE, topicID: TOPIC, payload: new Uint8Array([1]) })

    await store.unsubscribe(BOB, TOPIC)
    expect((await store.fetch({ recipientDID: BOB })).messages).toHaveLength(0)
    // Carol still has hers.
    expect((await store.fetch({ recipientDID: CAROL })).messages).toHaveLength(1)
  })

  test('last unsubscribe frees a mailbox frame and leaves a log frame standing', async () => {
    const store = createMemoryStore()
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    await store.publish({ senderDID: ALICE, topicID: TOPIC, payload: new Uint8Array([1]) })
    const logged = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([2]),
      retain: 'log',
    })
    await store.unsubscribe(BOB, TOPIC)

    // Re-subscribe: neither frame is pending any more.
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    expect((await store.fetch({ recipientDID: BOB })).messages).toHaveLength(0)

    // The mailbox frame's only reader is gone, so it is gone. Trim is the only deleter of a log
    // frame, and unsubscribe is not trim.
    const log = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
    expect(log.messages.map((m) => m.sequenceID)).toEqual([logged])
    expect(log.head).toBe(logged)
  })

  test('maxDepth evicts the oldest log frame per topic on publish', async () => {
    const store = createMemoryStore({ maxDepth: 2 })
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    const first = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([1]),
      retain: 'log',
    })
    await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([2]),
      retain: 'log',
    })
    const last = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([3]),
      retain: 'log',
    })

    const result = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
    expect(result.messages.map((m) => m.payload[0])).toEqual([2, 3])
    expect(result.oldest != null && result.oldest > first).toBe(true)
    expect(result.head).toBe(last)
  })

  test('maxDepth counts log frames only: a mailbox flood cannot evict the commit log', async () => {
    const store = createMemoryStore({ maxDepth: 2 })
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    const commit = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([1]),
      retain: 'log',
    })
    // A member floods the log topic with mailbox frames, well past the depth bound. They are the
    // publisher's to choose, but they must not be theirs to evict the log with.
    for (let i = 0; i < 5; i++) {
      await store.publish({ senderDID: ALICE, topicID: TOPIC, payload: new Uint8Array([i]) })
    }

    const log = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
    expect(log.messages.map((m) => m.sequenceID)).toEqual([commit])
    expect(log.head).toBe(commit)
  })

  test('the last ack frees a mailbox frame; a log frame outlives every ack', async () => {
    const store = createMemoryStore()
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    await store.subscribe({ subscriberDID: CAROL, topicID: TOPIC })
    const mailbox = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([1]),
    })
    const logged = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([2]),
      retain: 'log',
    })

    await store.ack({ recipientDID: BOB, sequenceIDs: [mailbox, logged] })
    // One recipient's ack does not touch another's deliveries.
    expect((await store.fetch({ recipientDID: CAROL })).messages).toHaveLength(2)

    await store.ack({ recipientDID: CAROL, sequenceIDs: [mailbox, logged] })
    expect((await store.fetch({ recipientDID: CAROL })).messages).toHaveLength(0)

    // Everyone has read both. The mailbox frame's readers were all known at publish time, so it
    // is done. The log frame's may not be, so no ack can free it.
    const log = await store.fetchTopic({ subscriberDID: CAROL, topicID: TOPIC })
    expect(log.messages.map((m) => m.sequenceID)).toEqual([logged])
    expect(log.head).toBe(logged)
  })

  test('trim removes log entries below the bound and never moves head', async () => {
    const store = createMemoryStore()
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    const first = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([1]),
      retain: 'log',
    })
    const last = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([2]),
      retain: 'log',
    })

    // Exclusive bound: everything strictly below `last` goes, `last` stays. The trimmed entry's
    // pending delivery goes with it.
    await store.trim({ topicID: TOPIC, before: last })
    const log = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
    expect(log.messages.map((m) => m.sequenceID)).toEqual([last])
    expect(log.oldest).toBe(last)
    expect(log.head).toBe(last)
    expect((await store.fetch({ recipientDID: BOB })).messages.map((m) => m.sequenceID)).toEqual([
      last,
    ])

    // Trimming the whole log empties it without resetting head.
    await store.trim({ topicID: TOPIC, before: 'zzz' })
    const emptied = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
    expect(emptied.messages).toHaveLength(0)
    expect(emptied.oldest).toBeNull()
    expect(emptied.head).toBe(last)
    expect(first < last).toBe(true)
  })

  test('trim removes only log frames: a mailbox frame on the same topic keeps its delivery', async () => {
    const store = createMemoryStore()
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    const mailbox = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([1]),
    })
    const logged = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([2]),
      retain: 'log',
    })

    // Trim past both. The log frame goes; the mailbox frame is delivery-derived, not a log entry,
    // and trim never touches it — so its pending delivery is still there.
    await store.trim({ topicID: TOPIC, before: 'zzz' })
    expect((await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })).messages).toHaveLength(
      0,
    )
    expect((await store.fetch({ recipientDID: BOB })).messages.map((m) => m.sequenceID)).toEqual([
      mailbox,
    ])
    expect(logged > mailbox).toBe(true)
  })

  test('fetchTopic refuses a non-subscriber and honours after/limit', async () => {
    const store = createMemoryStore()
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    const first = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([1]),
      retain: 'log',
    })
    await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([2]),
      retain: 'log',
    })
    await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([3]),
      retain: 'log',
    })

    await expect(store.fetchTopic({ subscriberDID: CAROL, topicID: TOPIC })).rejects.toThrow(
      NotSubscribedError,
    )

    // `after` is exclusive, `limit` applies after the cursor.
    const page = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC, after: first })
    expect(page.messages.map((m) => m.payload[0])).toEqual([2, 3])
    const limited = await store.fetchTopic({
      subscriberDID: BOB,
      topicID: TOPIC,
      after: first,
      limit: 1,
    })
    expect(limited.messages.map((m) => m.payload[0])).toEqual([2])
    expect(limited.oldest).toBe(first)
  })

  test('fetch respects after cursor, limit, and hasMore', async () => {
    const store = createMemoryStore()
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    const id1 = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([1]),
    })
    await store.publish({ senderDID: ALICE, topicID: TOPIC, payload: new Uint8Array([2]) })
    await store.publish({ senderDID: ALICE, topicID: TOPIC, payload: new Uint8Array([3]) })

    const after = await store.fetch({ recipientDID: BOB, after: id1 })
    expect(after.messages.map((m) => m.payload[0])).toEqual([2, 3])

    const limited = await store.fetch({ recipientDID: BOB, limit: 1 })
    expect(limited.messages).toHaveLength(1)
    expect(limited.hasMore).toBe(true)
  })

  test('purge removes aged messages and emits the purge event', async () => {
    const store = createMemoryStore()
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    await store.publish({ senderDID: ALICE, topicID: TOPIC, payload: new Uint8Array([1]) })
    const handler = vi.fn()
    store.events.on('purge', handler)
    const purged = await store.purge({ olderThan: 0 })
    expect(purged.length).toBeGreaterThan(0)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ sequenceIDs: expect.any(Array) }),
    )
    expect((await store.fetch({ recipientDID: BOB })).messages).toHaveLength(0)
  })

  test('purge ages out a log frame nobody asked to keep for longer', async () => {
    const store = createMemoryStore()
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([1]),
      retain: 'log',
    })

    const purged = await store.purge({ olderThan: 0 })
    expect(purged).toHaveLength(1)
    const log = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
    expect(log.messages).toHaveLength(0)
  })

  test('a subscribe above the maximum retention is refused, not clamped', async () => {
    const store = createMemoryStore({ retention: { max: 60 } })
    await expect(
      store.subscribe({ subscriberDID: BOB, topicID: TOPIC, retention: 61 }),
    ).rejects.toThrow(RetentionExceededError)
    expect(await store.getSubscribers(TOPIC)).toEqual([])
    await expect(store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })).rejects.toThrow(
      NotSubscribedError,
    )
  })

  test('a topic keeps its frames for the longest retention any subscriber asked for', async () => {
    const store = createMemoryStore({ retention: { max: 3600 } })
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    await store.subscribe({ subscriberDID: CAROL, topicID: TOPIC, retention: 3600 })
    const id = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([1]),
      retain: 'log',
    })

    // The most aggressive sweep the hub can run frees nothing: Carol asked for an hour.
    expect(await store.purge({ olderThan: 0 })).toEqual([])
    const log = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
    expect(log.messages.map((m) => m.sequenceID)).toEqual([id])

    // With Carol gone, so is the request that was keeping the frame.
    await store.unsubscribe(CAROL, TOPIC)
    expect(await store.purge({ olderThan: 0 })).toEqual([id])
  })

  test('the store default retention floors what an expiry sweep may remove', async () => {
    const store = createMemoryStore({ retention: { default: 3600, max: 3600 } })
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([1]),
      retain: 'log',
    })
    expect(await store.purge({ olderThan: 0 })).toEqual([])
  })

  test('a losing conditional publish consumes no sequenceID and leaves no gap', async () => {
    const store = createMemoryStore()
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    const first = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([1]),
      retain: 'log',
    })
    expect(first).toBe('000000000001')

    await expect(
      store.publish({
        senderDID: ALICE,
        topicID: TOPIC,
        payload: new Uint8Array([2]),
        retain: 'log',
        expectedHead: null,
      }),
    ).rejects.toThrow(HeadMismatchError)

    // The loser leaves the sequence exactly as it found it: the next accepted publish takes the
    // sequenceID the loser would have had. A store that mints before it compares burns one here.
    const next = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([3]),
      retain: 'log',
      expectedHead: first,
    })
    expect(next).toBe('000000000002')

    const log = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
    expect(log.messages.map((m) => m.sequenceID)).toEqual([first, next])
    expect(log.head).toBe(next)
  })

  test('a mailbox publish neither reads nor moves the head, so the CAS ignores it', async () => {
    const store = createMemoryStore()
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    const logged = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([1]),
      retain: 'log',
      expectedHead: null,
    })
    await store.publish({ senderDID: ALICE, topicID: TOPIC, payload: new Uint8Array([2]) })

    // The interleaved mailbox frame did not move the head, so a conditional publish against the
    // last log frame still wins.
    const next = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([3]),
      retain: 'log',
      expectedHead: logged,
    })
    const log = await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })
    expect(log.head).toBe(next)
  })

  test('a replayed publishID consumes no sequenceID and survives a purge of the whole log', async () => {
    const store = createMemoryStore()
    await store.subscribe({ subscriberDID: BOB, topicID: TOPIC })
    const first = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([1]),
      retain: 'log',
      expectedHead: null,
      publishID: 'commit-1',
    })
    expect(first).toBe('000000000001')

    // The age bound removes the frame. It cannot reach the dedup record.
    expect(await store.purge({ olderThan: 0 })).toEqual([first])
    expect((await store.fetchTopic({ subscriberDID: BOB, topicID: TOPIC })).messages).toHaveLength(
      0,
    )

    // The replay carries the head the caller journalled, which the frame's own acceptance made
    // stale. It still gets its original sequenceID back — naming a frame that no longer exists,
    // which is the answer to "did my publish land?".
    const replayed = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([1]),
      retain: 'log',
      expectedHead: null,
      publishID: 'commit-1',
    })
    expect(replayed).toBe(first)

    // Nothing was appended and no sequenceID was burned: the next publish takes the next ID.
    const next = await store.publish({
      senderDID: ALICE,
      topicID: TOPIC,
      payload: new Uint8Array([2]),
      retain: 'log',
    })
    expect(next).toBe('000000000002')
  })

  test('key package store and fetch', async () => {
    const store = createMemoryStore()
    await store.storeKeyPackage(ALICE, 'kp-1')
    await store.storeKeyPackage(ALICE, 'kp-2')
    expect(await store.fetchKeyPackages(ALICE, 1)).toEqual(['kp-1'])
    expect(await store.fetchKeyPackages(ALICE)).toEqual(['kp-2'])
  })
})
