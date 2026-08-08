import { Client } from '@enkaku/client'
import type { AnyClientMessageOf, AnyServerMessageOf } from '@enkaku/protocol'
import { DirectTransports } from '@enkaku/transport'
import { randomIdentity } from '@kokuin/token'
import type { HubProtocol, WakeRegistry, WakeSender } from '@kumiai/hub-protocol'
import { HUB_ERROR_CODES } from '@kumiai/hub-protocol'
import { createMemoryWakeRegistry } from '@kumiai/hub-wake'
import { describe, expect, test } from 'vitest'

import type { CreateHubParams } from '../src/hub.js'
import { createHub } from '../src/hub.js'
import { createMemoryStore } from '../src/memoryStore.js'

type HubTransports = DirectTransports<
  AnyServerMessageOf<HubProtocol>,
  AnyClientMessageOf<HubProtocol>
>

// `CreateHubParams.wake` requires a `sender`, which nothing here ever calls: the dispatcher's
// `notify` only fires from the publish fan-out, wired in a later task. This double stands in so
// the harness can exercise the real `createHub` wake wiring with just a registry.
const NOOP_WAKE_SENDER: WakeSender = { send: async () => 'delivered' }

type TestHubOptions = Omit<CreateHubParams, 'identity' | 'store' | 'transport' | 'wake'> & {
  wake?: { registry: WakeRegistry }
}

// Reuse the harness pattern from hub.test.ts: a hub over an in-memory transport with an
// authenticated client DID, collapsed to a single pre-connected client since every test here
// only needs one caller.
async function createTestHub(
  options: TestHubOptions,
): Promise<{ client: Client<HubProtocol>; clientDID: string; dispose: () => Promise<void> }> {
  const { wake, ...hubOptions } = options
  const store = createMemoryStore()
  const hubIdentity = randomIdentity()
  const transports: HubTransports = new DirectTransports()
  const hub = createHub({
    ...hubOptions,
    identity: hubIdentity,
    store,
    transport: transports.server,
    wake: wake == null ? undefined : { registry: wake.registry, sender: NOOP_WAKE_SENDER },
  })
  const clientIdentity = randomIdentity()
  const client = new Client<HubProtocol>({
    transport: transports.client,
    identity: clientIdentity,
    serverID: hubIdentity.id,
  })

  async function dispose(): Promise<void> {
    await hub.server.dispose()
    await transports.dispose()
  }

  return { client, clientDID: clientIdentity.id, dispose }
}

describe('hub/v1/wake/register', () => {
  test('stores a registration for the authenticated caller', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, clientDID, dispose } = await createTestHub({ wake: { registry } })

    await expect(
      client.request('hub/v1/wake/register', {
        param: {
          kind: 'webpush',
          endpoint: 'https://push.example/a',
          publicKey: 'cHVibGlj',
          authSecret: 'YXV0aA',
        },
      }),
    ).resolves.toEqual({ registered: true })

    const stored = await registry.get(clientDID)
    expect(stored?.endpoint).toBe('https://push.example/a')
    expect(stored?.did).toBe(clientDID)
    await dispose()
  })

  test('replaces a previous registration', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, clientDID, dispose } = await createTestHub({ wake: { registry } })

    await client.request('hub/v1/wake/register', {
      param: {
        kind: 'webpush',
        endpoint: 'https://push.example/old',
        publicKey: 'cHVibGlj',
        authSecret: 'YXV0aA',
      },
    })
    await client.request('hub/v1/wake/register', {
      param: {
        kind: 'expo',
        endpoint: 'ExponentPushToken[xxx]',
        publicKey: 'cHVibGlj',
        authSecret: 'YXV0aA',
      },
    })

    expect((await registry.get(clientDID))?.kind).toBe('expo')
    await dispose()
  })

  test('refuses when the hub has no wake support', async () => {
    const { client, dispose } = await createTestHub({})
    await expect(
      client.request('hub/v1/wake/register', {
        param: {
          kind: 'webpush',
          endpoint: 'https://push.example/a',
          publicKey: 'cHVibGlj',
          authSecret: 'YXV0aA',
        },
      }),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.wakeNotSupported })
    await dispose()
  })
})

describe('hub/v1/wake/unregister', () => {
  test('removes the registration', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, clientDID, dispose } = await createTestHub({ wake: { registry } })

    await client.request('hub/v1/wake/register', {
      param: {
        kind: 'webpush',
        endpoint: 'https://push.example/a',
        publicKey: 'cHVibGlj',
        authSecret: 'YXV0aA',
      },
    })
    await expect(client.request('hub/v1/wake/unregister', { param: {} })).resolves.toEqual({
      unregistered: true,
    })
    expect(await registry.get(clientDID)).toBeNull()
    await dispose()
  })

  test('reports false when there was nothing to remove', async () => {
    const registry = createMemoryWakeRegistry()
    const { client, dispose } = await createTestHub({ wake: { registry } })
    await expect(client.request('hub/v1/wake/unregister', { param: {} })).resolves.toEqual({
      unregistered: false,
    })
    await dispose()
  })
})
