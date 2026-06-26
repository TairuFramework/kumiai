import { Client } from '@enkaku/client'
import type { AnyClientMessageOf, AnyServerMessageOf, ProtocolDefinition } from '@enkaku/protocol'
import { type ProcedureHandlers, type RequestHandler, serve } from '@enkaku/server'
import type { StoredMessage } from '@kumiai/hub-protocol'
import {
  createHubTunnelTransport,
  type HubLike,
  type HubPublishParams,
  type HubReceiveSubscription,
} from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

// ---------------------------------------------------------------------------
// In-memory HubLike double — topic pub/sub with per-subscriber delivery.
// ---------------------------------------------------------------------------

type Inbox = {
  messages: Array<StoredMessage>
  wakers: Array<(msg: StoredMessage) => void>
}

function createInMemoryHub(): HubLike {
  const inboxes: Record<string, Inbox> = {}
  // topicID -> set of subscriber DIDs
  const subscriptions: Record<string, Set<string>> = {}
  let seq = 0

  function getInbox(did: string): Inbox {
    if (inboxes[did] == null) {
      inboxes[did] = { messages: [], wakers: [] }
    }
    return inboxes[did] as Inbox
  }

  function deliver(did: string, msg: StoredMessage): void {
    const inbox = getInbox(did)
    const waker = inbox.wakers.shift()
    if (waker != null) {
      waker(msg)
    } else {
      inbox.messages.push(msg)
    }
  }

  async function publish(params: HubPublishParams): Promise<{ sequenceID: string }> {
    const sequenceID = String(++seq)
    const stored: StoredMessage = {
      sequenceID,
      senderDID: params.senderDID,
      topicID: params.topicID,
      payload: params.payload,
    }
    const subscribers = subscriptions[params.topicID]
    if (subscribers != null) {
      for (const did of subscribers) {
        if (did !== params.senderDID) deliver(did, stored)
      }
    }
    return { sequenceID }
  }

  function subscribe(subscriberDID: string, topicID: string): void {
    if (subscriptions[topicID] == null) {
      subscriptions[topicID] = new Set()
    }
    subscriptions[topicID].add(subscriberDID)
  }

  function unsubscribe(subscriberDID: string, topicID: string): void {
    subscriptions[topicID]?.delete(subscriberDID)
  }

  function receive(subscriberDID: string): HubReceiveSubscription {
    const inbox = getInbox(subscriberDID)
    let done = false

    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<StoredMessage>> {
            if (done) {
              return Promise.resolve({ value: undefined as unknown as StoredMessage, done: true })
            }
            const queued = inbox.messages.shift()
            if (queued != null) {
              return Promise.resolve({ value: queued, done: false })
            }
            return new Promise<IteratorResult<StoredMessage>>((resolve) => {
              inbox.wakers.push((msg) => {
                resolve({ value: msg, done: false })
              })
            })
          },
          return(): Promise<IteratorResult<StoredMessage>> {
            done = true
            // Wake any pending waker so the iterator loop can exit
            const waker = inbox.wakers.shift()
            if (waker != null) {
              waker({ sequenceID: '', senderDID: '', topicID: '', payload: new Uint8Array(0) })
            }
            return Promise.resolve({ value: undefined as unknown as StoredMessage, done: true })
          },
        }
      },
    }
  }

  return { publish, subscribe, unsubscribe, receive }
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

const protocol = {
  echo: {
    type: 'request',
    param: {
      type: 'object',
      properties: { msg: { type: 'string' } },
      required: ['msg'],
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: { msg: { type: 'string' } },
      required: ['msg'],
      additionalProperties: false,
    },
  },
} as const satisfies ProtocolDefinition

type Protocol = typeof protocol

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('hub-tunnel echo', () => {
  test('client → server round-trip via in-memory hub', async () => {
    const hub = createInMemoryHub()
    const C2S = 'tunnel:client-to-server'
    const S2C = 'tunnel:server-to-client'

    const clientTransport = createHubTunnelTransport<
      AnyServerMessageOf<Protocol>,
      AnyClientMessageOf<Protocol>
    >({
      hub,
      sessionID: 'session-1',
      localDID: 'client',
      sendTopicID: C2S,
      receiveTopicID: S2C,
    })

    const serverTransport = createHubTunnelTransport<
      AnyClientMessageOf<Protocol>,
      AnyServerMessageOf<Protocol>
    >({
      hub,
      sessionID: 'session-1',
      localDID: 'server',
      sendTopicID: S2C,
      receiveTopicID: C2S,
    })

    const echoHandler: RequestHandler<Protocol, 'echo'> = async ({ param }) => param
    const handlers = { echo: echoHandler } as ProcedureHandlers<Protocol>

    const server = serve<Protocol>({ handlers, requireAuth: false, transport: serverTransport })
    const client = new Client<Protocol>({ transport: clientTransport })

    try {
      const result = await client.request('echo', { param: { msg: 'hello' } })
      expect(result).toEqual({ msg: 'hello' })
    } finally {
      await client.dispose()
      await server.dispose()
    }
  })
})
