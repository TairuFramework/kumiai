import { Client } from '@enkaku/client'
import type { AnyClientMessageOf, AnyServerMessageOf } from '@enkaku/protocol'
import { DirectTransports } from '@enkaku/transport'
import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import { HubClient } from '@kumiai/hub-client'
import {
  HeadMismatchError,
  HUB_ERROR_CODES,
  type HubProtocol,
  type HubStore,
  hubErrorFromCode,
  NotSubscribedError,
  type PublishParams,
  RetentionExceededError,
  type SubscribeParams,
} from '@kumiai/hub-protocol'
import { createHub, createMemoryStore } from '@kumiai/hub-server'
import { describe, expect, test } from 'vitest'

type HubTransports = DirectTransports<
  AnyServerMessageOf<HubProtocol>,
  AnyClientMessageOf<HubProtocol>
>

const MAX_RETENTION = 30 * 24 * 60 * 60

/**
 * Records what the server actually handed the store. Every one of these params degrades silently
 * to today's behaviour if it fails to cross the wire — a `retain` that never arrives means every
 * commit is published mailbox-class and ack GC eats the log, with nothing failing anywhere. So
 * these tests assert what the server *received*, not that the call succeeded.
 */
function recordingStore(): {
  store: HubStore
  publishes: Array<PublishParams>
  subscribes: Array<SubscribeParams>
} {
  const inner = createMemoryStore({ retention: { max: MAX_RETENTION } })
  const publishes: Array<PublishParams> = []
  const subscribes: Array<SubscribeParams> = []
  const store: HubStore = {
    ...inner,
    async publish(params) {
      publishes.push(params)
      return await inner.publish(params)
    },
    async subscribe(params) {
      subscribes.push(params)
      return await inner.subscribe(params)
    },
  }
  return { store, publishes, subscribes }
}

function createTestHub(store: HubStore) {
  const hubIdentity = randomIdentity()
  const firstTransports: HubTransports = new DirectTransports()
  const allTransports: Array<HubTransports> = [firstTransports]
  const hub = createHub({
    identity: hubIdentity,
    store,
    transport: firstTransports.server,
    purge: false,
  })
  let firstUsed = false

  function connect(identity: OwnIdentity = randomIdentity()) {
    let transports: HubTransports
    if (firstUsed) {
      transports = new DirectTransports()
      allTransports.push(transports)
      hub.server.handle(transports.server)
    } else {
      transports = firstTransports
      firstUsed = true
    }
    const rawClient = new Client<HubProtocol>({
      transport: transports.client,
      identity,
      serverID: hubIdentity.id,
    })
    return { client: new HubClient({ client: rawClient }), identity }
  }

  async function dispose(): Promise<void> {
    await hub.server.dispose()
    await Promise.all(allTransports.map((transports) => transports.dispose()))
  }

  return { connect, dispose }
}

const TOPIC = 'topic:log-lane'

function payloadOf(text: string): string {
  return btoa(text)
}

describe('Topic log over the wire', () => {
  test('a peer subscribing after the fact pulls frames published with zero subscribers', async () => {
    const { store } = recordingStore()
    const ctx = createTestHub(store)
    const { client: alice } = ctx.connect()

    // Nobody is subscribed to the topic. A delivery-row implementation of the pull retains
    // nothing here and returns nothing below — which is exactly the peer this lane exists for.
    const first = await alice.publish({
      topicID: TOPIC,
      payload: payloadOf('commit-1'),
      retain: 'log',
    })
    const second = await alice.publish({
      topicID: TOPIC,
      payload: payloadOf('commit-2'),
      retain: 'log',
    })

    const { client: bob } = ctx.connect()
    await bob.subscribe(TOPIC)

    const result = await bob.fetchTopic({ topicID: TOPIC })
    expect(result.messages.map((message) => message.sequenceID)).toEqual([
      first.sequenceID,
      second.sequenceID,
    ])
    expect(result.messages.map((message) => atob(message.payload))).toEqual([
      'commit-1',
      'commit-2',
    ])
    expect(result.head).toBe(second.sequenceID)
    expect(result.oldest).toBe(first.sequenceID)

    // The cursor is exclusive and the limit applies after it.
    const page = await bob.fetchTopic({ topicID: TOPIC, after: first.sequenceID })
    expect(page.messages.map((message) => message.sequenceID)).toEqual([second.sequenceID])
    const limited = await bob.fetchTopic({ topicID: TOPIC, limit: 1 })
    expect(limited.messages.map((message) => message.sequenceID)).toEqual([first.sequenceID])
    expect(limited.head).toBe(second.sequenceID)

    await ctx.dispose()
  })

  test('the retention class crosses the wire: a log frame survives every subscriber acking it', async () => {
    const { store, publishes } = recordingStore()
    const ctx = createTestHub(store)
    const { client: alice, identity: aliceIdentity } = ctx.connect()
    const { client: bob, identity: bobIdentity } = ctx.connect()

    await bob.subscribe(TOPIC)
    const mailbox = await alice.publish({ topicID: TOPIC, payload: payloadOf('chat') })
    const logged = await alice.publish({
      topicID: TOPIC,
      payload: payloadOf('commit'),
      retain: 'log',
    })

    // The server received the class the client sent — not a default.
    expect(publishes.map((params) => params.retain)).toEqual([undefined, 'log'])
    expect(publishes[1].senderDID).toBe(aliceIdentity.id)

    await store.ack({
      recipientDID: bobIdentity.id,
      sequenceIDs: [mailbox.sequenceID, logged.sequenceID],
    })

    // Every subscriber has acked both. The mailbox frame is gone; the log frame is not, because
    // a subscriber that must read it may not exist yet.
    const result = await bob.fetchTopic({ topicID: TOPIC })
    expect(result.messages.map((message) => message.sequenceID)).toEqual([logged.sequenceID])
    expect(result.head).toBe(logged.sequenceID)

    await ctx.dispose()
  })

  test('expectedHead crosses the wire: the loser gets a HeadMismatchError it can act on', async () => {
    const { store, publishes } = recordingStore()
    const ctx = createTestHub(store)
    const { client: alice } = ctx.connect()
    const { client: bob } = ctx.connect()
    await bob.subscribe(TOPIC)

    const first = await alice.publish({
      topicID: TOPIC,
      payload: payloadOf('commit-1'),
      retain: 'log',
      expectedHead: null,
    })
    // The empty-topic sentinel arrived as null, not as an absent field: those are different
    // requests, and a wire that collapses them turns every conditional publish unconditional.
    expect(publishes[0].expectedHead).toBeNull()

    // A second publish at the same head loses the compare-and-set.
    const rejected = await alice
      .publish({
        topicID: TOPIC,
        payload: payloadOf('commit-2'),
        retain: 'log',
        expectedHead: null,
      })
      .catch((error: unknown) => error)

    const error = rejected as { code?: string; message?: string }
    expect(error.code).toBe(HUB_ERROR_CODES.headMismatch)
    // The caller can branch on the error class: "I lost the CAS, rebase and retry" is not the
    // same as "the hub is unreachable", and a transport failure carries no hub code at all.
    expect(hubErrorFromCode(error.code as string, error.message ?? '')).toBeInstanceOf(
      HeadMismatchError,
    )

    // Nothing was stored for the loser.
    const result = await bob.fetchTopic({ topicID: TOPIC })
    expect(result.messages.map((message) => message.sequenceID)).toEqual([first.sequenceID])
    expect(result.head).toBe(first.sequenceID)

    await ctx.dispose()
  })

  test('publishID crosses the wire: a replay returns the original sequenceID', async () => {
    const { store, publishes } = recordingStore()
    const ctx = createTestHub(store)
    const { client: alice } = ctx.connect()
    const { client: bob } = ctx.connect()
    await bob.subscribe(TOPIC)

    const original = await alice.publish({
      topicID: TOPIC,
      payload: payloadOf('commit-1'),
      retain: 'log',
      expectedHead: null,
      publishID: 'commit-1',
    })
    // The replay resends the journalled request byte for byte, stale expectedHead and all.
    const replayed = await alice.publish({
      topicID: TOPIC,
      payload: payloadOf('commit-1'),
      retain: 'log',
      expectedHead: null,
      publishID: 'commit-1',
    })

    expect(publishes.map((params) => params.publishID)).toEqual(['commit-1', 'commit-1'])
    expect(replayed.sequenceID).toBe(original.sequenceID)

    const result = await bob.fetchTopic({ topicID: TOPIC })
    expect(result.messages).toHaveLength(1)

    await ctx.dispose()
  })

  test('retention crosses the wire: a subscribe above the maximum is refused, not clamped', async () => {
    const { store, subscribes } = recordingStore()
    const ctx = createTestHub(store)
    const { client: bob } = ctx.connect()

    await bob.subscribe(TOPIC, { retention: MAX_RETENTION })
    expect(subscribes[0].retention).toBe(MAX_RETENTION)

    const rejected = await bob
      .subscribe('topic:greedy', { retention: MAX_RETENTION + 1 })
      .catch((error: unknown) => error)
    const error = rejected as { code?: string; message?: string }
    expect(error.code).toBe(HUB_ERROR_CODES.retentionExceeded)
    expect(hubErrorFromCode(error.code as string, error.message ?? '')).toBeInstanceOf(
      RetentionExceededError,
    )
    expect(await store.getSubscribers('topic:greedy')).toEqual([])

    await ctx.dispose()
  })

  test('the topic log is gated on subscription: a non-subscriber is refused', async () => {
    const { store } = recordingStore()
    const ctx = createTestHub(store)
    const { client: alice } = ctx.connect()
    const { client: carol } = ctx.connect()

    await alice.publish({ topicID: TOPIC, payload: payloadOf('commit-1'), retain: 'log' })

    const rejected = await carol.fetchTopic({ topicID: TOPIC }).catch((error: unknown) => error)
    const error = rejected as { code?: string; message?: string }
    expect(error.code).toBe(HUB_ERROR_CODES.notSubscribed)
    expect(hubErrorFromCode(error.code as string, error.message ?? '')).toBeInstanceOf(
      NotSubscribedError,
    )

    await ctx.dispose()
  })
})
