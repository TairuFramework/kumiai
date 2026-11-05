import { Client } from '@enkaku/client'
import type { AnyClientMessageOf, AnyServerMessageOf } from '@enkaku/protocol'
import { DirectTransports } from '@enkaku/transport'
import { nobleCrypto } from '@kokuin/crypto'
import { type CryptoOptions, randomIdentity } from '@kokuin/token'
import type { HubProtocol } from '@kumiai/hub-protocol'
import { fromUTF, toB64U } from '@sozai/codec'
import { expect, test } from 'vitest'

import { createHub } from '../src/hub.js'
import { createMemoryStore } from '../src/memoryStore.js'

type HubTransports = DirectTransports<
  AnyServerMessageOf<HubProtocol>,
  AnyClientMessageOf<HubProtocol>
>
type Provider = NonNullable<CryptoOptions['crypto']>

const TOPIC = (() => {
  const bytes = new Uint8Array(32)
  bytes.set(fromUTF('crypto-topic'))
  return toB64U(bytes)
})()

async function subscribeWith(crypto?: Provider) {
  const transports: HubTransports = new DirectTransports()
  const hubIdentity = randomIdentity()
  const hub = createHub({
    crypto,
    identity: hubIdentity,
    store: createMemoryStore(),
    transport: transports.server,
    purge: false,
  })
  const client = new Client<HubProtocol>({
    transport: transports.client,
    identity: randomIdentity(),
    serverID: hubIdentity.id,
  })
  try {
    return await client.request('hub/v1/subscribe', { param: { topicID: TOPIC } })
  } finally {
    await hub.dispose()
    await transports.dispose()
  }
}

test('createHub verifies client tokens with the given provider', async () => {
  await expect(subscribeWith()).resolves.toBeDefined()

  const calls = { verify: 0 }
  const counted: Provider = {
    ...nobleCrypto,
    verify: async (item) => {
      calls.verify++
      return await nobleCrypto.verify(item)
    },
    verifyBatch: async (items) => {
      calls.verify += items.length
      return await nobleCrypto.verifyBatch(items)
    },
  }
  await expect(subscribeWith(counted)).resolves.toBeDefined()
  expect(calls.verify).toBeGreaterThan(0)

  const refusing: Provider = {
    ...nobleCrypto,
    verify: async () => false,
    verifyBatch: async (items) => items.map(() => false),
  }
  await expect(subscribeWith(refusing)).rejects.toThrow()
})
