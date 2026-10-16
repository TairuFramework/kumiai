import { Client, RequestError } from '@enkaku/client'
import type { AnyClientMessageOf, AnyServerMessageOf } from '@enkaku/protocol'
import { DirectTransports } from '@enkaku/transport'
import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import { type ConformanceLogHub, testTopicAuthorizationConformance } from '@kumiai/hub-conformance'
import { type HubProtocol, hubErrorFromCode, type StoredMessage } from '@kumiai/hub-protocol'
import { fromB64, toB64, toB64U } from '@sozai/codec'

import { createHub } from '../src/hub.js'
import { createMemoryStore } from '../src/memoryStore.js'

type HubTransports = DirectTransports<
  AnyServerMessageOf<HubProtocol>,
  AnyClientMessageOf<HubProtocol>
>

async function createFixture() {
  const commitTopicID = toB64U(crypto.getRandomValues(new Uint8Array(32)))
  const checkpointTopicID = toB64U(crypto.getRandomValues(new Uint8Array(32)))
  const topics = new Set([commitTopicID, checkpointTopicID])
  const store = createMemoryStore()
  const identity = randomIdentity()
  const deniedIdentity = randomIdentity()
  const first: HubTransports = new DirectTransports()
  const transports = [first]
  const hub = createHub({
    identity,
    store,
    transport: first.server,
    purge: false,
    receiveAuthCacheTTL: 0,
    authorize: (request) => {
      if (!('topicID' in request)) return true
      return topics.has(request.topicID) && request.did !== deniedIdentity.id
    },
  })
  // Existing subscriptions must not bypass policy after access is revoked.
  for (const topicID of topics) {
    await store.subscribe({ subscriberDID: deniedIdentity.id, topicID, retention: 604_800 })
  }
  let firstUsed = false
  function connect(member: OwnIdentity): Client<HubProtocol> {
    const connection: HubTransports = firstUsed ? new DirectTransports() : first
    if (firstUsed) {
      transports.push(connection)
      hub.server.handle(connection.server)
    }
    firstUsed = true
    return new Client<HubProtocol>({
      identity: member,
      serverID: identity.id,
      transport: connection.client,
    })
  }
  async function request<Result>(call: PromiseLike<Result>): Promise<Result> {
    try {
      return await call
    } catch (error) {
      if (error instanceof RequestError) throw hubErrorFromCode(error.code, error.message) ?? error
      throw error
    }
  }
  function view(denied: boolean): ConformanceLogHub {
    const clients = new Map<string, Client<HubProtocol>>()
    function client(did: string): Client<HubProtocol> {
      const key = denied ? deniedIdentity.id : did
      let value = clients.get(key)
      if (value == null) {
        value = connect(denied ? deniedIdentity : randomIdentity())
        clients.set(key, value)
      }
      return value
    }
    return {
      subscribe: async (did, topicID, options) => {
        await request(client(did).request('hub/v1/subscribe', { param: { topicID, ...options } }))
      },
      publish: (params) => {
        const { senderDID, payload, ...rest } = params
        return request(
          client(senderDID).request('hub/v1/publish', {
            param: { ...rest, payload: toB64(payload) },
          }),
        )
      },
      fetchTopic: async (params) => {
        const { subscriberDID, ...rest } = params
        const result = await request(
          client(subscriberDID).request('hub/v1/topic/fetch', { param: rest }),
        )
        return {
          ...result,
          messages: result.messages.map((message) => ({
            ...message,
            payload: fromB64(message.payload),
          })),
        }
      },
      receive: (did) => {
        let channel: ReturnType<Client<HubProtocol>['createChannel']> | undefined
        let stopped = false
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<StoredMessage> {
            const opened = client(did).createChannel('hub/v1/receive', { param: {} })
            channel = opened
            void Promise.resolve(opened).catch(() => {})
            const reader = opened.readable.getReader()
            try {
              while (!stopped) {
                const next = await reader.read()
                if (next.done || next.value == null) return
                yield { ...next.value, payload: fromB64(next.value.payload) }
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
  return {
    commitTopicID,
    checkpointTopicID,
    allowed: view(false),
    denied: view(true),
    dispose: async () => {
      await hub.dispose()
      await Promise.all(transports.map((connection) => connection.dispose()))
    },
  }
}

testTopicAuthorizationConformance({ createFixture })
