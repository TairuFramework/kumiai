import { Client } from '@enkaku/client'
import type { AnyClientMessageOf, AnyServerMessageOf } from '@enkaku/protocol'
import { DirectTransports } from '@enkaku/transport'
import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import type { HubProtocol, HubStore } from '@kumiai/hub-protocol'
import { fromB64, fromUTF, toB64 } from '@sozai/codec'
import { describe, expect, test, vi } from 'vitest'

import { type AuthorizeRequest, createHandlers } from '../src/handlers.js'
import { type CreateHubParams, createHub, type HubInstance } from '../src/hub.js'
import { createMemoryStore } from '../src/memoryStore.js'
import { HubClientRegistry } from '../src/registry.js'

type HubTransports = DirectTransports<
  AnyServerMessageOf<HubProtocol>,
  AnyClientMessageOf<HubProtocol>
>

const TOPIC = 'topic:1'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function encodePayload(value: string): string {
  return toB64(fromUTF(value))
}

type TestHubOptions = Omit<CreateHubParams, 'identity' | 'store' | 'transport'> & {
  store?: HubStore
}

type TestConnection = {
  client: Client<HubProtocol>
  identity: OwnIdentity
}

type TestHub = {
  hub: HubInstance
  store: HubStore
  connect: (identity?: OwnIdentity) => TestConnection
  dispose: () => Promise<void>
}

function createTestHub(options: TestHubOptions = {}): TestHub {
  const { store: providedStore, ...hubOptions } = options
  const store = providedStore ?? createMemoryStore()
  const hubIdentity = randomIdentity()
  const firstTransports: HubTransports = new DirectTransports()
  const allTransports: Array<HubTransports> = [firstTransports]
  const hub = createHub({
    ...hubOptions,
    identity: hubIdentity,
    store,
    transport: firstTransports.server,
  })
  let firstUsed = false

  function connect(identity: OwnIdentity = randomIdentity()): TestConnection {
    let transports: HubTransports
    if (firstUsed) {
      transports = new DirectTransports()
      allTransports.push(transports)
      hub.server.handle(transports.server)
    } else {
      transports = firstTransports
      firstUsed = true
    }
    const client = new Client<HubProtocol>({
      transport: transports.client,
      identity,
      serverID: hubIdentity.id,
    })
    return { client, identity }
  }

  async function dispose(): Promise<void> {
    await hub.server.dispose()
    await Promise.all(allTransports.map((transports) => transports.dispose()))
  }

  return { hub, store, connect, dispose }
}

describe('hub authentication', () => {
  test('rejects unsigned client messages', async () => {
    const ctx = createTestHub()
    const transports: HubTransports = new DirectTransports()
    ctx.hub.server.handle(transports.server)
    const anonymous = new Client<HubProtocol>({ transport: transports.client })

    await expect(
      anonymous.request('hub/v1/publish', {
        param: { topicID: TOPIC, payload: encodePayload('nope') },
      }),
    ).rejects.toThrow('Message is not signed')

    await transports.dispose()
    await ctx.dispose()
  })

  test('handlers reject messages without a verified issuer DID', async () => {
    const registry = new HubClientRegistry()
    const store = createMemoryStore()
    const handlers = createHandlers({ registry, store })
    await expect(
      handlers['hub/v1/publish']({
        message: { header: {}, payload: { typ: 'request', prc: 'hub/v1/publish', rid: '1' } },
        param: { topicID: TOPIC, payload: encodePayload('x') },
        signal: new AbortController().signal,
      } as never),
    ).rejects.toThrow('missing verified issuer DID')
  })
})

describe('hub pub/sub', () => {
  test('publish fans out to subscribers (live)', async () => {
    const ctx = createTestHub()
    const { client: alice } = ctx.connect()
    const bobIdentity = randomIdentity()
    const { client: bob } = ctx.connect(bobIdentity)

    await bob.request('hub/v1/subscribe', { param: { topicID: TOPIC } })
    const channel = bob.createChannel('hub/v1/receive', { param: {} })
    const reader = channel.readable.getReader()
    await delay(20)

    await alice.request('hub/v1/publish', {
      param: { topicID: TOPIC, payload: encodePayload('hi') },
    })

    const msg = await reader.read()
    expect(msg.done).toBe(false)
    expect(msg.value?.topicID).toBe(TOPIC)
    expect(msg.value?.payload).toBe(encodePayload('hi'))

    channel.close()
    await expect(channel).rejects.toEqual('Close')
    await delay(20)
    await ctx.dispose()
  })

  test('publish to a topic with no subscribers stores nothing', async () => {
    const store = createMemoryStore()
    const ctx = createTestHub({ store })
    const { client: alice } = ctx.connect()

    await alice.request('hub/v1/publish', {
      param: { topicID: TOPIC, payload: encodePayload('void') },
    })
    await delay(20)

    expect(await store.getSubscribers(TOPIC)).toEqual([])
    expect((await store.fetch({ recipientDID: 'did:key:nobody' })).messages).toHaveLength(0)
    await ctx.dispose()
  })

  test('offline subscriber receives queued messages on connect', async () => {
    const ctx = createTestHub()
    const { client: alice } = ctx.connect()
    const bobIdentity = randomIdentity()

    const { client: bobSetup } = ctx.connect(bobIdentity)
    await bobSetup.request('hub/v1/subscribe', { param: { topicID: TOPIC } })

    await alice.request('hub/v1/publish', {
      param: { topicID: TOPIC, payload: encodePayload('queued') },
    })
    await delay(20)

    const { client: bob } = ctx.connect(bobIdentity)
    const channel = bob.createChannel('hub/v1/receive', { param: {} })
    const reader = channel.readable.getReader()
    const msg = await reader.read()
    expect(msg.value?.payload).toBe(encodePayload('queued'))

    channel.close()
    await expect(channel).rejects.toEqual('Close')
    await delay(20)
    await ctx.dispose()
  })

  test('ack drains the store', async () => {
    const store = createMemoryStore()
    const ackSpy = vi.spyOn(store, 'ack')
    const ctx = createTestHub({ store })
    const { client: alice } = ctx.connect()
    const bobIdentity = randomIdentity()
    const { client: bobSetup } = ctx.connect(bobIdentity)
    await bobSetup.request('hub/v1/subscribe', { param: { topicID: TOPIC } })

    await alice.request('hub/v1/publish', {
      param: { topicID: TOPIC, payload: encodePayload('m1') },
    })
    await delay(20)

    const { client: bob } = ctx.connect(bobIdentity)
    const channel = bob.createChannel('hub/v1/receive', { param: {} })
    const reader = channel.readable.getReader()
    const msg = await reader.read()
    const sequenceID = msg.value?.sequenceID as string
    await channel.send({ ack: [sequenceID] })
    await delay(20)

    expect(ackSpy).toHaveBeenCalledWith({ recipientDID: bobIdentity.id, sequenceIDs: [sequenceID] })
    channel.close()
    await expect(channel).rejects.toEqual('Close')
    await delay(20)
    await ctx.dispose()
  })

  test('redelivers unacked messages on reconnect', async () => {
    const ctx = createTestHub()
    const { client: alice } = ctx.connect()
    const bobIdentity = randomIdentity()
    const { client: bobSetup } = ctx.connect(bobIdentity)
    await bobSetup.request('hub/v1/subscribe', { param: { topicID: TOPIC } })

    await alice.request('hub/v1/publish', {
      param: { topicID: TOPIC, payload: encodePayload('m1') },
    })
    await delay(20)

    // First connect: read the message but do NOT ack it.
    const { client: bobFirst } = ctx.connect(bobIdentity)
    const firstChannel = bobFirst.createChannel('hub/v1/receive', { param: {} })
    const firstReader = firstChannel.readable.getReader()
    const firstMsg = await firstReader.read()
    expect(firstMsg.value?.payload).toBe(encodePayload('m1'))
    firstChannel.close()
    await expect(firstChannel).rejects.toEqual('Close')
    await delay(20)

    // Reconnect the same identity: the unacked message is delivered again.
    const { client: bobSecond } = ctx.connect(bobIdentity)
    const secondChannel = bobSecond.createChannel('hub/v1/receive', { param: {} })
    const secondReader = secondChannel.readable.getReader()
    const secondMsg = await secondReader.read()
    expect(secondMsg.value?.payload).toBe(encodePayload('m1'))

    secondChannel.close()
    await expect(secondChannel).rejects.toEqual('Close')
    await delay(20)
    await ctx.dispose()
  })

  test('does not deliver or store messages for unsubscribed topics', async () => {
    const ctx = createTestHub()
    const { client: alice } = ctx.connect()
    const bobIdentity = randomIdentity()
    const { client: bob } = ctx.connect(bobIdentity)

    await bob.request('hub/v1/subscribe', { param: { topicID: 'topic:A' } })
    const channel = bob.createChannel('hub/v1/receive', { param: {} })
    const reader = channel.readable.getReader()
    let delivered = false
    // Floating read: it stays pending (no matching topic), then settles when the
    // channel closes below. Swallow the close-time rejection so it can't surface
    // as an unhandled rejection.
    void reader.read().then(
      () => {
        delivered = true
      },
      () => {},
    )
    await delay(20)

    await alice.request('hub/v1/publish', {
      param: { topicID: 'topic:B', payload: encodePayload('other') },
    })
    await delay(20)

    expect(delivered).toBe(false)
    expect((await ctx.store.fetch({ recipientDID: bobIdentity.id })).messages).toHaveLength(0)

    // THE CONTROL. Nothing above proves the push lane works at all — a receive channel that
    // delivered NOTHING, ever, passes every assertion so far. A frame on the topic bob really is
    // subscribed to has to arrive, or the silence about `topic:B` means nothing.
    await alice.request('hub/v1/publish', {
      param: { topicID: 'topic:A', payload: encodePayload('subscribed') },
    })
    await delay(20)
    expect(delivered).toBe(true)

    channel.close()
    await expect(channel).rejects.toEqual('Close')
    await delay(20)
    await ctx.dispose()
  })

  test('unsubscribe stops further delivery', async () => {
    const ctx = createTestHub()
    const { client: alice } = ctx.connect()
    const bobIdentity = randomIdentity()
    const { client: bob } = ctx.connect(bobIdentity)

    await bob.request('hub/v1/subscribe', { param: { topicID: TOPIC } })
    await bob.request('hub/v1/unsubscribe', { param: { topicID: TOPIC } })

    expect(await ctx.store.getSubscribers(TOPIC)).toEqual([])
    await alice.request('hub/v1/publish', {
      param: { topicID: TOPIC, payload: encodePayload('gone') },
    })
    await delay(20)
    expect((await ctx.store.fetch({ recipientDID: bobIdentity.id })).messages).toHaveLength(0)
    await ctx.dispose()
  })

  /**
   * A SECOND `hub/v1/receive` FOR THE SAME DID TAKES THE LANE, and the first one ends.
   *
   * The rule used to be the opposite — refuse the second — which reads as the safer one and is
   * not. A client reconnects BECAUSE its connection broke, and the server is the last to know: it
   * still holds a writer pointing at a socket that is already gone. Refusing on that stale belief
   * turns the reconnect away and leaves the member with no push lane until a timeout it cannot
   * see. Worse, the refusal arrives on a channel promise the mux never awaited, so the member was
   * deaf AND silent about it.
   *
   * Both channels belong to one authenticated DID, so nothing here lets anyone displace anyone
   * else. Asserted on where a message actually LANDS, not on the binding: the binding is
   * bookkeeping, delivery is the property.
   */
  test('a second hub/v1/receive for the same DID takes over the push lane', async () => {
    const ctx = createTestHub()
    const { client: alice } = ctx.connect()
    const bobIdentity = randomIdentity()
    const { client: bob } = ctx.connect(bobIdentity)
    await bob.request('hub/v1/subscribe', { param: { topicID: TOPIC } })

    // The stale channel: still open as far as the server knows.
    const stale = bob.createChannel('hub/v1/receive', { param: {} })
    const staleReader = stale.readable.getReader()
    let staleDelivered = false
    // `value != null` and not merely "the read settled": ending the stale channel settles the
    // pending read too, with `{ done: true }`, and a test that counted that as a delivery would
    // report one for the very close it is asserting about.
    void staleReader.read().then(
      (result) => {
        if (result.value != null) staleDelivered = true
      },
      () => {},
    )
    await delay(20)

    // The reconnect. It is not refused, and the old channel ends on its own.
    const live = bob.createChannel('hub/v1/receive', { param: {} })
    const liveReader = live.readable.getReader()
    await delay(20)
    // It ENDS rather than errors: being replaced is not the old channel's fault, and the client
    // that replaced it is the same client.
    await expect(stale).resolves.toBeUndefined()

    await alice.request('hub/v1/publish', {
      param: { topicID: TOPIC, payload: encodePayload('after the reconnect') },
    })
    const received = await liveReader.read()
    expect(received.value?.topicID).toBe(TOPIC)
    expect(staleDelivered).toBe(false)

    live.close()
    await expect(live).rejects.toEqual('Close')
    await delay(20)
    await ctx.dispose()
  })
})

describe('hub authorization', () => {
  test('authorize=false rejects publish and subscribe', async () => {
    const ctx = createTestHub({ authorize: () => false })
    const { client: alice } = ctx.connect()
    await expect(
      alice.request('hub/v1/publish', { param: { topicID: TOPIC, payload: encodePayload('x') } }),
    ).rejects.toThrow('Not authorized')
    await expect(alice.request('hub/v1/subscribe', { param: { topicID: TOPIC } })).rejects.toThrow(
      'Not authorized',
    )
    await ctx.dispose()
  })

  test('a publish request reaches the hook as a discriminated request with retain and payloadSize', async () => {
    const seen: Array<AuthorizeRequest> = []
    const ctx = createTestHub({
      authorize: (req: AuthorizeRequest) => {
        seen.push(req)
        return true
      },
    })
    const { client: alice, identity } = ctx.connect()
    const payload = encodePayload('hello, hub')

    await alice.request('hub/v1/publish', { param: { topicID: TOPIC, payload, retain: 'log' } })

    expect(seen).toHaveLength(1)
    const req = seen[0]
    // Narrow via the discriminant itself: if `publish` requests ever stopped reaching the hook
    // shaped this way, the assertions below it would never run and the test would pass for the
    // wrong reason. Assert the discriminant explicitly first.
    expect(req?.action).toBe('publish')
    if (req?.action !== 'publish') throw new Error('expected a publish request')
    expect(req.did).toBe(identity.id)
    expect(req.topicID).toBe(TOPIC)
    expect(req.retain).toBe('log')
    expect(req.payloadSize).toBe(fromB64(payload).length)

    await ctx.dispose()
  })

  test('a hook returning { allow: false, reason } refuses, and the reason reaches the error', async () => {
    const ctx = createTestHub({
      authorize: () => ({ allow: false, reason: 'topic quota exceeded for this DID' }),
    })
    const { client: alice } = ctx.connect()

    await expect(
      alice.request('hub/v1/publish', { param: { topicID: TOPIC, payload: encodePayload('x') } }),
    ).rejects.toThrow('topic quota exceeded for this DID')
    await expect(alice.request('hub/v1/subscribe', { param: { topicID: TOPIC } })).rejects.toThrow(
      'topic quota exceeded for this DID',
    )

    await ctx.dispose()
  })

  test('a hook returning true for everything permits everything, as today', async () => {
    const ctx = createTestHub({ authorize: () => true })
    const { client: alice } = ctx.connect()

    await expect(
      alice.request('hub/v1/publish', { param: { topicID: TOPIC, payload: encodePayload('x') } }),
    ).resolves.toMatchObject({ sequenceID: expect.any(String) })
    await expect(alice.request('hub/v1/subscribe', { param: { topicID: TOPIC } })).resolves.toEqual(
      {
        subscribed: true,
      },
    )

    await ctx.dispose()
  })
})

describe('hub rate limiting', () => {
  test('rejects publishes beyond the per-DID burst', async () => {
    const ctx = createTestHub({ rateLimits: { perDID: { rate: 0, burst: 2 } } })
    const { client: alice } = ctx.connect()
    await alice.request('hub/v1/publish', {
      param: { topicID: TOPIC, payload: encodePayload('1') },
    })
    await alice.request('hub/v1/publish', {
      param: { topicID: TOPIC, payload: encodePayload('2') },
    })
    await expect(
      alice.request('hub/v1/publish', { param: { topicID: TOPIC, payload: encodePayload('3') } }),
    ).rejects.toThrow('rate limit')
    await ctx.dispose()
  })
})

describe('hub key packages', () => {
  test('upload then fetch consumes packages', async () => {
    const ctx = createTestHub()
    const { client: alice, identity } = ctx.connect()
    const uploaded = await alice.request('hub/v1/keypackage/upload', {
      param: { keyPackages: ['kp-1', 'kp-2'] },
    })
    expect(uploaded.stored).toBe(2)

    const { client: bob } = ctx.connect()
    const fetched = await bob.request('hub/v1/keypackage/fetch', {
      param: { did: identity.id, count: 1 },
    })
    expect(fetched.keyPackages).toEqual(['kp-1'])
    await ctx.dispose()
  })
})
