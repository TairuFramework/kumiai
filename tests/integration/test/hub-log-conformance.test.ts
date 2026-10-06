import { Client, RequestError } from '@enkaku/client'
import type { AnyClientMessageOf, AnyServerMessageOf } from '@enkaku/protocol'
import { DirectTransports } from '@enkaku/transport'
import { randomIdentity } from '@kokuin/token'
import { HubClient } from '@kumiai/hub-client'
import { type HubProtocol, hubErrorFromCode, type StoredMessage } from '@kumiai/hub-protocol'
import { createHub, createMemoryStore } from '@kumiai/hub-server'
import { fromB64, fromUTF, toB64U } from '@sozai/codec'
import { afterEach } from 'vitest'

// hub-server already declares the conformance dependency, so its build orders these declarations.
import {
  type ConformanceLogHub,
  testLogHubConformance,
} from '../../../packages/hub-conformance/lib/index.js'

const MAX_RETENTION = 30 * 24 * 60 * 60
const MAX_DEPTH = 6

const wireDisposals: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(wireDisposals.splice(0).map((dispose) => dispose()))
})

function createWireLogHub(options: { maxRetention: number; maxDepth: number }): ConformanceLogHub {
  const store = createMemoryStore({
    maxDepth: options.maxDepth,
    retention: { max: options.maxRetention },
  })
  const identity = randomIdentity()
  const first: HubTransports = new DirectTransports()
  const transports = [first]
  const hub = createHub({ identity, store, transport: first.server, purge: false })
  const clients = new Map<string, HubClient>()
  const aliases = new Map<string, string>()
  const topics = new Map<string, string>()
  const topicAliases = new Map<string, string>()
  function topic(label: string): string {
    let id = topics.get(label)
    if (id == null) {
      const bytes = new Uint8Array(32)
      bytes.set(fromUTF(label).subarray(0, 32))
      id = toB64U(bytes)
      topics.set(label, id)
      topicAliases.set(id, label)
    }
    return id
  }
  function client(did: string): HubClient {
    let value = clients.get(did)
    if (value == null) {
      const connection: HubTransports = clients.size === 0 ? first : new DirectTransports()
      if (clients.size !== 0) {
        transports.push(connection)
        hub.server.handle(connection.server)
      }
      const member = randomIdentity()
      aliases.set(member.id, did)
      value = new HubClient({
        client: new Client<HubProtocol>({
          identity: member,
          serverID: identity.id,
          transport: connection.client,
        }),
      })
      clients.set(did, value)
    }
    return value
  }
  function message(value: {
    sequenceID: string
    senderDID: string
    topicID: string
    payload: string
    logPosition?: string
  }): StoredMessage {
    return {
      ...value,
      senderDID: aliases.get(value.senderDID) as string,
      topicID: topicAliases.get(value.topicID) as string,
      payload: fromB64(value.payload),
    }
  }
  async function request<T>(call: PromiseLike<T>): Promise<T> {
    try {
      return await call
    } catch (error) {
      if (error instanceof RequestError) throw hubErrorFromCode(error.code, error.message) ?? error
      throw error
    }
  }
  wireDisposals.push(async () => {
    await hub.server.dispose()
    await Promise.all(transports.map((connection) => connection.dispose()))
  })
  return {
    subscribe: async (did, label, subscription) => {
      await request(client(did).subscribe({ topicID: topic(label), ...subscription }))
    },
    unsubscribe: async (did, label) => {
      await request(client(did).unsubscribe({ topicID: topic(label) }))
    },
    publish: (params) =>
      request(client(params.senderDID).publish({ ...params, topicID: topic(params.topicID) })),
    fetchTopic: async (params) => {
      const result = await request(
        client(params.subscriberDID).fetchTopic({ ...params, topicID: topic(params.topicID) }),
      )
      return { ...result, messages: result.messages.map(message) }
    },
    receive: (did) => {
      let stopped = false
      let channel: ReturnType<HubClient['receive']> | undefined
      return {
        async *[Symbol.asyncIterator]() {
          channel = client(did).receive()
          void Promise.resolve(channel).catch(() => {})
          const reader = channel.readable.getReader()
          try {
            while (!stopped) {
              const next = await reader.read()
              if (next.done || next.value == null) return
              yield message(next.value)
            }
          } finally {
            reader.releaseLock()
          }
        },
        return: () => {
          stopped = true
          channel?.close()
        },
      }
    },
  }
}

testLogHubConformance({
  label: 'HubClient over hub-server wire',
  createHub: createWireLogHub,
  maxRetention: MAX_RETENTION,
  maxDepth: MAX_DEPTH,
})

type HubTransports = DirectTransports<
  AnyServerMessageOf<HubProtocol>,
  AnyClientMessageOf<HubProtocol>
>
