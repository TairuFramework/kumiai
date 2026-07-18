import { Client } from '@enkaku/client'
import type { AnyClientMessageOf, AnyServerMessageOf } from '@enkaku/protocol'
import { DirectTransports } from '@enkaku/transport'
import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import { HubClient } from '@kumiai/hub-client'
import type { HubProtocol, StoredMessage } from '@kumiai/hub-protocol'
import { createHub, createMemoryStore } from '@kumiai/hub-server'
import type { HubReceiveSubscription, LogHub } from '@kumiai/hub-tunnel'

/**
 * A {@link LogHub} over the REAL hub-server, reached over the real Enkaku wire.
 *
 * This is transport glue and nothing else: every publish, subscribe, fetch and delivery
 * crosses `hub/publish`, `hub/subscribe`, `hub/topic/fetch` and `hub/receive` on an actual
 * `createHub`, against an actual store. It substitutes no hub behaviour — the only work here
 * is the base64 the protocol carries payloads as, which `LogHub` states in bytes.
 */

type HubTransports = DirectTransports<
  AnyServerMessageOf<HubProtocol>,
  AnyClientMessageOf<HubProtocol>
>

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * The receive side, as a poll over `hub/receive`'s channel. The channel is opened lazily on
 * first iteration because `createGroupPeer` calls `receive` during construction, and a peer
 * that is disposed before it ever reads must not leave a channel open.
 */
function receiveOverWire(client: HubClient): HubReceiveSubscription {
  let stopped = false
  let channel: ReturnType<HubClient['receive']> | undefined
  const acks: Array<string> = []

  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<StoredMessage> {
      if (channel == null) {
        channel = client.receive()
        // The channel call itself rejects with 'Close' when the stream is closed, which is
        // the ordinary teardown path here and not an error anyone is waiting on.
        void Promise.resolve(channel).catch(() => {})
      }
      const reader = channel.readable.getReader()
      try {
        while (!stopped) {
          const next = await reader.read()
          if (next.done || next.value == null) return
          const message = next.value
          yield {
            sequenceID: message.sequenceID,
            senderDID: message.senderDID,
            topicID: message.topicID,
            payload: fromBase64(message.payload),
            ...(message.logPosition != null && { logPosition: message.logPosition }),
          } as StoredMessage
        }
      } finally {
        reader.releaseLock()
      }
    },
    return: () => {
      stopped = true
      try {
        channel?.close()
      } catch {
        // Already closed by dispose.
      }
    },
    ack: (sequenceID: string) => {
      acks.push(sequenceID)
    },
  }
}

export type WireHub = {
  /** A LogHub for one member, over its own authenticated client connection. */
  connect: (identity: OwnIdentity) => LogHub
  dispose: () => Promise<void>
}

export function createWireHub(options: { retentionSeconds?: number } = {}): WireHub {
  const store = createMemoryStore({
    retention: { max: options.retentionSeconds ?? 30 * 24 * 60 * 60 },
  })
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
  const subscriptions: Array<HubReceiveSubscription> = []

  function connect(identity: OwnIdentity): LogHub {
    let transports: HubTransports
    if (firstUsed) {
      transports = new DirectTransports()
      allTransports.push(transports)
      hub.server.handle(transports.server)
    } else {
      transports = firstTransports
      firstUsed = true
    }
    const client = new HubClient({
      client: new Client<HubProtocol>({
        transport: transports.client,
        identity,
        serverID: hubIdentity.id,
      }),
    })

    return {
      subscribe: async (_subscriberDID, topicID, subscribeOptions) => {
        // The hub authenticates the subscriber from the connection, so the DID the caller
        // passes is not sent — it is already the connection's.
        await client.subscribe(topicID, subscribeOptions)
      },
      unsubscribe: async (_subscriberDID, topicID) => {
        await client.unsubscribe(topicID)
      },
      publish: async (params) => {
        return await client.publish({
          topicID: params.topicID,
          payload: toBase64(params.payload),
          ...(params.retain != null && { retain: params.retain }),
          ...('expectedHead' in params && { expectedHead: params.expectedHead }),
          ...(params.publishID != null && { publishID: params.publishID }),
        })
      },
      fetchTopic: async (params) => {
        const result = await client.fetchTopic({
          topicID: params.topicID,
          ...(params.after != null && { after: params.after }),
          ...(params.limit != null && { limit: params.limit }),
        })
        return {
          messages: result.messages.map(
            (message) =>
              ({
                sequenceID: message.sequenceID,
                senderDID: message.senderDID,
                topicID: message.topicID,
                payload: fromBase64(message.payload),
              }) as StoredMessage,
          ),
          head: result.head ?? null,
          oldest: result.oldest ?? null,
        }
      },
      receive: () => {
        const subscription = receiveOverWire(client)
        subscriptions.push(subscription)
        return subscription
      },
    }
  }

  async function dispose(): Promise<void> {
    for (const subscription of subscriptions) subscription.return?.()
    await hub.server.dispose()
    await Promise.all(allTransports.map((transports) => transports.dispose()))
  }

  return { connect, dispose }
}
