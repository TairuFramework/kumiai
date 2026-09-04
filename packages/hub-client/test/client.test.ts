import { Client } from '@enkaku/client'
import type { AnyClientMessageOf, AnyServerMessageOf } from '@enkaku/protocol'
import { DirectTransports } from '@enkaku/transport'
import { randomIdentity } from '@kokuin/token'
import type { HubProtocol } from '@kumiai/hub-protocol'
import { keyPackageDigest } from '@kumiai/hub-protocol'
import { createHub, createMemoryStore } from '@kumiai/hub-server'
import { fromUTF, toB64, toB64U } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { HubClient } from '../src/client.js'

type HubTransports = DirectTransports<
  AnyServerMessageOf<HubProtocol>,
  AnyClientMessageOf<HubProtocol>
>

// A schema-valid topicID: 43-char base64url, the shape the hub's enkaku server enforces — it
// validates params against the protocol, which pins topicID to `^[A-Za-z0-9_-]{43}$`.
const fixtureTopic = (label: string): string => {
  const bytes = new Uint8Array(32)
  bytes.set(fromUTF(label).subarray(0, 32))
  return toB64U(bytes)
}

const TOPIC = fixtureTopic('chat')
const TOPIC_WORK = fixtureTopic('work')

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function encodePayload(value: string): string {
  return toB64(fromUTF(value))
}

function createTestHub() {
  const store = createMemoryStore()
  const hubIdentity = randomIdentity()
  const transports: HubTransports = new DirectTransports()
  const hub = createHub({
    transport: transports.server,
    store,
    identity: hubIdentity,
  })
  return { hub, hubID: hubIdentity.id, store, transports }
}

function createTestClient(testHub: ReturnType<typeof createTestHub>, identity = randomIdentity()) {
  const transports: HubTransports = new DirectTransports()
  testHub.hub.server.handle(transports.server)
  const rawClient = new Client<HubProtocol>({
    transport: transports.client,
    identity,
    serverID: testHub.hubID,
  })
  const client = new HubClient({ client: rawClient })
  return { client, identity, transports }
}

describe('HubClient', () => {
  test('publish to a topic and receive', async () => {
    const testHub = createTestHub()
    const { client: alice, transports: aliceT } = createTestClient(testHub)
    const { client: bob, transports: bobT } = createTestClient(testHub)

    await bob.subscribe({ topicID: TOPIC })
    const channel = bob.receive()
    const reader = channel.readable.getReader()
    await delay(50)

    await alice.publish({ topicID: TOPIC, payload: encodePayload('hello') })

    const msg = await reader.read()
    expect(msg.done).toBe(false)
    expect(msg.value?.topicID).toBe(TOPIC)
    expect(msg.value?.payload).toBe(encodePayload('hello'))

    channel.close()
    await expect(channel).rejects.toEqual('Close')
    await delay(50)
    await aliceT.dispose()
    await bobT.dispose()
  })

  test('receive across multiple subscribed topics', async () => {
    const testHub = createTestHub()
    const { client: alice, transports: aliceT } = createTestClient(testHub)
    const { client: bob, transports: bobT } = createTestClient(testHub)

    await bob.subscribe({ topicID: TOPIC })
    await bob.subscribe({ topicID: TOPIC_WORK })
    const channel = bob.receive()
    const reader = channel.readable.getReader()
    await delay(50)

    await alice.publish({ topicID: TOPIC, payload: encodePayload('chat-msg') })
    const msg1 = await reader.read()
    expect(msg1.value?.topicID).toBe(TOPIC)
    expect(msg1.value?.payload).toBe(encodePayload('chat-msg'))

    await alice.publish({ topicID: TOPIC_WORK, payload: encodePayload('work-msg') })
    const msg2 = await reader.read()
    expect(msg2.value?.topicID).toBe(TOPIC_WORK)
    expect(msg2.value?.payload).toBe(encodePayload('work-msg'))

    channel.close()
    await expect(channel).rejects.toEqual('Close')
    await delay(50)
    await aliceT.dispose()
    await bobT.dispose()
  })

  test('subscribe then unsubscribe stops delivery', async () => {
    const testHub = createTestHub()
    const { client: alice, transports: aliceT } = createTestClient(testHub)
    const { client: bob, identity: bobIdentity, transports: bobT } = createTestClient(testHub)

    const sub = await bob.subscribe({ topicID: TOPIC })
    expect(sub.subscribed).toBe(true)
    const unsub = await bob.unsubscribe({ topicID: TOPIC })
    expect(unsub.unsubscribed).toBe(true)

    await alice.publish({ topicID: TOPIC, payload: encodePayload('gone') })
    await delay(50)
    expect((await testHub.store.fetch({ recipientDID: bobIdentity.id })).messages).toHaveLength(0)

    await aliceT.dispose()
    await bobT.dispose()
  })

  test('uploadKeyPackages and fetchKeyPackages', async () => {
    const testHub = createTestHub()
    const { client, identity, transports } = createTestClient(testHub)

    const result = await client.uploadKeyPackages({ keyPackages: ['kp-1', 'kp-2'] })
    expect(result.stored).toBe(2)

    const fetched = await client.fetchKeyPackages({ did: identity.id, count: 1 })
    expect(fetched.keyPackages).toHaveLength(1)

    await transports.dispose()
  })

  test('uploadLastResortKeyPackage stores a package that outlives being fetched', async () => {
    const testHub = createTestHub()
    const { client, identity, transports } = createTestClient(testHub)

    const result = await client.uploadLastResortKeyPackage({ keyPackage: 'kp-lr' })
    expect(result.stored).toBe(1)

    // The ordinary pool is empty, yet a fetch still yields a package — and again after that.
    expect((await client.fetchKeyPackages({ did: identity.id, count: 1 })).keyPackages).toEqual([
      'kp-lr',
    ])
    expect((await client.fetchKeyPackages({ did: identity.id, count: 1 })).keyPackages).toEqual([
      'kp-lr',
    ])

    await transports.dispose()
  })

  test('keyPackageStatus reports the caller own live depth and slot digest', async () => {
    const testHub = createTestHub()
    const { client, transports } = createTestClient(testHub)

    const future = Math.floor(Date.now() / 1000) + 3600
    await client.uploadKeyPackages({ keyPackages: ['kp-1', 'kp-2'], notAfter: future })
    await client.uploadLastResortKeyPackage({ keyPackage: 'kp-last-resort' })

    const status = await client.keyPackageStatus()

    expect(status.count).toBe(2)
    expect(status.lastResort).toBe(keyPackageDigest('kp-last-resort'))

    await transports.dispose()
  })

  test('an upload without an expiry stays countable', async () => {
    const testHub = createTestHub()
    const { client, transports } = createTestClient(testHub)

    await client.uploadKeyPackages({ keyPackages: ['kp-forever'] })

    expect((await client.keyPackageStatus()).count).toBe(1)

    await transports.dispose()
  })

  test('notAfter reaches the hub: an already-expired upload does not count', async () => {
    const testHub = createTestHub()
    const { client, transports } = createTestClient(testHub)

    const past = Math.floor(Date.now() / 1000) - 1
    await client.uploadKeyPackages({ keyPackages: ['kp-dead'], notAfter: past })

    expect((await client.keyPackageStatus()).count).toBe(0)

    await transports.dispose()
  })
})
