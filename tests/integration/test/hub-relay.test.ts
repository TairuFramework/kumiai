import { Client } from '@enkaku/client'
import type { AnyClientMessageOf, AnyServerMessageOf } from '@enkaku/protocol'
import { DirectTransports } from '@enkaku/transport'
import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import { HubClient } from '@kumiai/hub-client'
import type { HubProtocol, HubStore } from '@kumiai/hub-protocol'
import { type AuthorizeHook, createHub, createMemoryStore } from '@kumiai/hub-server'
import { describe, expect, test } from 'vitest'

type HubTransports = DirectTransports<
  AnyServerMessageOf<HubProtocol>,
  AnyClientMessageOf<HubProtocol>
>

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type TestHubOptions = {
  store?: HubStore
  authorize?: AuthorizeHook
}

function createTestHub(options: TestHubOptions = {}) {
  const store = options.store ?? createMemoryStore()
  const hubIdentity = randomIdentity()
  const firstTransports: HubTransports = new DirectTransports()
  const allTransports: Array<HubTransports> = [firstTransports]
  const hub = createHub({
    identity: hubIdentity,
    store,
    transport: firstTransports.server,
    authorize: options.authorize,
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

  return { hub, hubID: hubIdentity.id, store, connect, dispose }
}

describe('Hub relay: multi-device delivery', () => {
  test('blind relay: device publishes to a peer inbox topic', async () => {
    const testHub = createTestHub()
    const { client: phone } = testHub.connect()
    const { client: laptop, identity: laptopID } = testHub.connect()
    const inbox = `inbox:${laptopID.id}`

    await laptop.subscribe(inbox)
    const channel = laptop.receive()
    const reader = channel.readable.getReader()
    await delay(50)

    const payload = btoa('encrypted-blob')
    await phone.publish({ topicID: inbox, payload })

    const msg = await reader.read()
    expect(msg.done).toBe(false)
    expect(msg.value?.topicID).toBe(inbox)
    expect(msg.value?.payload).toBe(payload)

    channel.close()
    await expect(channel).rejects.toEqual('Close')
    await delay(50)
    await testHub.dispose()
  })

  test('store-and-forward: offline device gets messages on reconnect', async () => {
    const testHub = createTestHub()
    const { client: phone } = testHub.connect()
    const laptopID = randomIdentity()
    const inbox = `inbox:${laptopID.id}`

    // Laptop subscribes once, then goes offline (no open receive channel).
    const { client: laptopSetup } = testHub.connect(laptopID)
    await laptopSetup.subscribe(inbox)

    await phone.publish({ topicID: inbox, payload: btoa('msg-while-offline') })
    await delay(50)

    // Laptop reconnects and drains its durable inbox.
    const { client: laptop } = testHub.connect(laptopID)
    const channel = laptop.receive()
    const reader = channel.readable.getReader()

    const msg = await reader.read()
    expect(msg.value?.payload).toBe(btoa('msg-while-offline'))

    channel.close()
    await expect(channel).rejects.toEqual('Close')
    await delay(50)
    await testHub.dispose()
  })
})

describe('Hub store: pagination and acks', () => {
  test('pagination: fetch messages in batches', async () => {
    const store = createMemoryStore()
    const recipient = randomIdentity()
    const topicID = 'topic:paginate'
    await store.subscribe({ subscriberDID: recipient.id, topicID })

    for (let i = 0; i < 5; i++) {
      await store.publish({
        senderDID: 'did:key:sender',
        topicID,
        payload: new Uint8Array([i]),
      })
    }

    const result1 = await store.fetch({ recipientDID: recipient.id, limit: 2 })
    expect(result1.messages).toHaveLength(2)
    expect(result1.hasMore).toBe(true)

    const result2 = await store.fetch({
      recipientDID: recipient.id,
      after: result1.cursor ?? undefined,
      limit: 2,
    })
    expect(result2.messages).toHaveLength(2)
    expect(result2.hasMore).toBe(true)

    const result3 = await store.fetch({
      recipientDID: recipient.id,
      after: result2.cursor ?? undefined,
      limit: 2,
    })
    expect(result3.messages).toHaveLength(1)
  })

  test('ack semantics: unacked messages are re-delivered', async () => {
    const store = createMemoryStore()
    const recipient = randomIdentity()
    const topicID = 'topic:ack'
    await store.subscribe({ subscriberDID: recipient.id, topicID })

    await store.publish({
      senderDID: 'did:key:sender',
      topicID,
      payload: new Uint8Array([1]),
    })

    const result1 = await store.fetch({ recipientDID: recipient.id })
    expect(result1.messages).toHaveLength(1)

    const result2 = await store.fetch({ recipientDID: recipient.id })
    expect(result2.messages).toHaveLength(1)

    await store.ack({ recipientDID: recipient.id, sequenceIDs: [result2.messages[0].sequenceID] })

    const result3 = await store.fetch({ recipientDID: recipient.id })
    expect(result3.messages).toHaveLength(0)
  })

  test('combined ack+fetch', async () => {
    const store = createMemoryStore()
    const recipient = randomIdentity()
    const topicID = 'topic:combined'
    await store.subscribe({ subscriberDID: recipient.id, topicID })

    const { sequenceID: id1 } = await store.publish({
      senderDID: 'did:key:sender',
      topicID,
      payload: new Uint8Array([1]),
    })
    await store.publish({
      senderDID: 'did:key:sender',
      topicID,
      payload: new Uint8Array([2]),
    })

    const result = await store.fetch({ recipientDID: recipient.id, ack: [id1] })
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].payload).toEqual(new Uint8Array([2]))
  })
})

describe('Hub groups: authorized-DID pub/sub', () => {
  // The hub gates a group topic on an authorized-DID set fed to its authorize hook.
  // The set is the group's known members; this test drives the hook and fan-out.
  function groupTopic(groupID: string): string {
    return `group/${groupID}`
  }

  function setupGroupHub(groupID: string, memberDIDs: Array<string>) {
    const members = new Set(memberDIDs)
    const authorize: AuthorizeHook = (req) => {
      // Only the topic-scoped actions carry a `topicID`; anything else (a keypackage
      // request, or an action added later) is not this gate's business and passes.
      if (!('topicID' in req)) return true
      if (req.topicID === groupTopic(groupID)) return members.has(req.did)
      return true
    }
    return createTestHub({ authorize })
  }

  test('group fan-out: members subscribe and receive', async () => {
    const groupID = 'chat'
    const alice = randomIdentity()
    const bob = randomIdentity()

    const testHub = setupGroupHub(groupID, [alice.id, bob.id])
    const { client: aliceClient } = testHub.connect(alice)
    const { client: bobClient } = testHub.connect(bob)

    await aliceClient.subscribe(groupTopic(groupID))
    await bobClient.subscribe(groupTopic(groupID))

    const channel = bobClient.receive()
    const reader = channel.readable.getReader()
    await delay(50)

    await aliceClient.publish({ topicID: groupTopic(groupID), payload: btoa('hello-group') })

    const msg = await reader.read()
    expect(msg.value?.payload).toBe(btoa('hello-group'))
    expect(msg.value?.topicID).toBe(groupTopic(groupID))

    channel.close()
    await expect(channel).rejects.toEqual('Close')
    await delay(50)
    await testHub.dispose()
  })

  test('non-member is rejected on subscribe and publish', async () => {
    const groupID = 'chat'
    const alice = randomIdentity()

    const testHub = setupGroupHub(groupID, [alice.id])
    const { client: carol } = testHub.connect()

    await expect(carol.subscribe(groupTopic(groupID))).rejects.toThrow('Not authorized')
    await expect(
      carol.publish({ topicID: groupTopic(groupID), payload: btoa('intrusion') }),
    ).rejects.toThrow('Not authorized')

    await testHub.dispose()
  })
})

describe('Hub store: eviction', () => {
  async function storeWithSubscriber() {
    const store = createMemoryStore()
    await store.subscribe({ subscriberDID: 'did:key:bob', topicID: 'topic:evict' })
    return store
  }

  test('consumer-driven purge', async () => {
    const store = await storeWithSubscriber()
    await store.publish({
      senderDID: 'did:key:alice',
      topicID: 'topic:evict',
      payload: new Uint8Array([1]),
    })

    const purged = await store.purge({ olderThan: 0 })
    expect(purged.length).toBeGreaterThan(0)

    const result = await store.fetch({ recipientDID: 'did:key:bob' })
    expect(result.messages).toHaveLength(0)
  })

  test('purge event emitted', async () => {
    const store = await storeWithSubscriber()
    await store.publish({
      senderDID: 'did:key:alice',
      topicID: 'topic:evict',
      payload: new Uint8Array([1]),
    })

    const eventPromise = store.events.once('purge')
    await store.purge({ olderThan: 0 })
    const event = await eventPromise
    expect(event.sequenceIDs.length).toBeGreaterThan(0)
  })

  test('reference counting: message survives partial ack', async () => {
    const store = createMemoryStore()
    await store.subscribe({ subscriberDID: 'did:key:bob', topicID: 'topic:fanout' })
    await store.subscribe({ subscriberDID: 'did:key:carol', topicID: 'topic:fanout' })

    const { sequenceID: id } = await store.publish({
      senderDID: 'did:key:alice',
      topicID: 'topic:fanout',
      payload: new Uint8Array([1]),
    })

    await store.ack({ recipientDID: 'did:key:bob', sequenceIDs: [id] })

    const result = await store.fetch({ recipientDID: 'did:key:carol' })
    expect(result.messages).toHaveLength(1)

    await store.ack({ recipientDID: 'did:key:carol', sequenceIDs: [id] })
    const result2 = await store.fetch({ recipientDID: 'did:key:carol' })
    expect(result2.messages).toHaveLength(0)
  })
})
