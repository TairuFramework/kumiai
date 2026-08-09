import { Client } from '@enkaku/client'
import type { AnyClientMessageOf, AnyServerMessageOf } from '@enkaku/protocol'
import { DirectTransports } from '@enkaku/transport'
import { randomIdentity } from '@kokuin/token'
import type { HubProtocol, WakeRegistry, WakeSender } from '@kumiai/hub-protocol'
import { decodeBase64url, HUB_ERROR_CODES, openWakeHint, sealWakeHint } from '@kumiai/hub-protocol'
import { createHub, createMemoryStore } from '@kumiai/hub-server'
import { createMemoryWakeRegistry } from '@kumiai/hub-wake'
import { describe, expect, test } from 'vitest'

import { HubClient } from '../src/client.js'
import { createWakeKeys } from '../src/wake-keys.js'

type HubTransports = DirectTransports<
  AnyServerMessageOf<HubProtocol>,
  AnyClientMessageOf<HubProtocol>
>

// The dispatcher's `notify` never fires in these tests (no publish happens), so a no-op sender is
// enough to satisfy `CreateHubParams.wake`'s requirement of one.
const NOOP_WAKE_SENDER: WakeSender = { send: async () => 'delivered' }

function createTestHub(options: { wake?: { registry: WakeRegistry } } = {}) {
  const store = createMemoryStore()
  const hubIdentity = randomIdentity()
  const transports: HubTransports = new DirectTransports()
  const hub = createHub({
    transport: transports.server,
    store,
    identity: hubIdentity,
    wake:
      options.wake == null
        ? undefined
        : { registry: options.wake.registry, sender: NOOP_WAKE_SENDER },
  })
  return { hub, hubID: hubIdentity.id, transports }
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

describe('createWakeKeys', () => {
  test('produces RFC 8291 sized material', () => {
    const keys = createWakeKeys()
    expect(Buffer.from(keys.publicKey, 'base64url')).toHaveLength(65)
    expect(Buffer.from(keys.authSecret, 'base64url')).toHaveLength(16)
    expect(keys.privateKey).toHaveLength(32)
  })

  test('opens what the hub would seal for it', () => {
    const keys = createWakeKeys()
    const body = sealWakeHint(
      { topicID: 'topic-a', sequenceID: '007', count: 2 },
      {
        publicKey: new Uint8Array(Buffer.from(keys.publicKey, 'base64url')),
        authSecret: new Uint8Array(Buffer.from(keys.authSecret, 'base64url')),
      },
    )
    expect(
      openWakeHint(body, {
        privateKey: keys.privateKey,
        authSecret: new Uint8Array(Buffer.from(keys.authSecret, 'base64url')),
      }),
    ).toEqual({ topicID: 'topic-a', sequenceID: '007', count: 2 })
  })

  test('each call is a fresh keypair', () => {
    expect(createWakeKeys().publicKey).not.toBe(createWakeKeys().publicKey)
  })
})

describe('HubClient.registerWake', () => {
  test('stores the exact kind, endpoint, publicKey and authSecret for the caller', async () => {
    const registry = createMemoryWakeRegistry()
    const testHub = createTestHub({ wake: { registry } })
    const { client, identity, transports } = createTestClient(testHub)

    await client.registerWake({
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: 'cHVibGlj',
      authSecret: 'YXV0aA',
    })

    const stored = await registry.get(identity.id)
    // Individual field assertions, not a single toEqual: a handler that swapped publicKey and
    // authSecret would still pass a same-shape comparison if the test itself mixed them up.
    expect(stored?.kind).toBe('webpush')
    expect(stored?.endpoint).toBe('https://push.example/a')
    expect(stored?.publicKey).toBe('cHVibGlj')
    expect(stored?.authSecret).toBe('YXV0aA')

    await transports.dispose()
  })

  test('passing expiresAt stores it', async () => {
    const registry = createMemoryWakeRegistry()
    const testHub = createTestHub({ wake: { registry } })
    const { client, identity, transports } = createTestClient(testHub)
    const expiresAt = Math.floor(Date.now() / 1000) + 3600

    await client.registerWake({
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: 'cHVibGlj',
      authSecret: 'YXV0aA',
      expiresAt,
    })

    expect((await registry.get(identity.id))?.expiresAt).toBe(expiresAt)

    await transports.dispose()
  })

  test('omitting expiresAt sends a request param with no expiresAt key at all', async () => {
    // Against a real hub, `hub/v1/wake/register`'s OWN handler has its own `expiresAt != null`
    // guard before writing to the registry — so a client that always spread `expiresAt: undefined`
    // would still leave the registry clean, and a registry-level assertion could not tell the two
    // implementations apart. Capturing what `HubClient` actually hands the enkaku client is the
    // only way to pin the omission down to `registerWake` itself.
    const calls: Array<{ procedure: string; param: unknown }> = []
    const stubClient = {
      request: (procedure: string, options: { param: unknown }) => {
        calls.push({ procedure, param: options.param })
        return Promise.resolve({ registered: true })
      },
    } as unknown as Client<HubProtocol>
    const client = new HubClient({ client: stubClient })

    await client.registerWake({
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: 'cHVibGlj',
      authSecret: 'YXV0aA',
    })

    expect(calls).toHaveLength(1)
    const param = calls[0]?.param as Record<string, unknown>
    expect('expiresAt' in param).toBe(false)
  })

  test('rejects with HUB_WAKE_NOT_SUPPORTED against a hub built without wake', async () => {
    const testHub = createTestHub()
    const { client, transports } = createTestClient(testHub)

    await expect(
      client.registerWake({
        kind: 'webpush',
        endpoint: 'https://push.example/a',
        publicKey: 'cHVibGlj',
        authSecret: 'YXV0aA',
      }),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.wakeNotSupported })

    await transports.dispose()
  })
})

describe('HubClient.unregisterWake', () => {
  test('reports true when a registration existed, false when there was none', async () => {
    const registry = createMemoryWakeRegistry()
    const testHub = createTestHub({ wake: { registry } })
    const { client, transports } = createTestClient(testHub)

    const before = await client.unregisterWake()
    expect(before.unregistered).toBe(false)

    await client.registerWake({
      kind: 'webpush',
      endpoint: 'https://push.example/a',
      publicKey: 'cHVibGlj',
      authSecret: 'YXV0aA',
    })
    const after = await client.unregisterWake()
    expect(after.unregistered).toBe(true)

    await transports.dispose()
  })
})

describe('wake registration round trip', () => {
  test('a hint sealed to a just-registered device opens with the device private key', async () => {
    const registry = createMemoryWakeRegistry()
    const testHub = createTestHub({ wake: { registry } })
    const { client, identity, transports } = createTestClient(testHub)
    const keys = createWakeKeys()

    await client.registerWake({
      kind: 'webpush',
      endpoint: 'https://push.example/x',
      publicKey: keys.publicKey,
      authSecret: keys.authSecret,
    })

    const stored = await registry.get(identity.id)
    expect(stored).not.toBeNull()
    if (stored == null) {
      throw new Error('unreachable')
    }

    // The base64url round trip through registration, decoded here exactly as the hub's own
    // dispatch path would, is what this test exists to prove — not the seal/open primitives
    // themselves, which have their own coverage above.
    const body = sealWakeHint(
      { topicID: 'topic-a', sequenceID: '007', count: 2 },
      {
        publicKey: decodeBase64url(stored.publicKey),
        authSecret: decodeBase64url(stored.authSecret),
      },
    )

    expect(
      openWakeHint(body, {
        privateKey: keys.privateKey,
        authSecret: decodeBase64url(keys.authSecret),
      }),
    ).toEqual({ topicID: 'topic-a', sequenceID: '007', count: 2 })

    await transports.dispose()
  })
})
