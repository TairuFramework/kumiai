import { Client } from '@enkaku/client'
import type { ClientTransportOf, ProtocolDefinition, ServerTransportOf } from '@enkaku/protocol'
import { type ProcedureHandlers, Server } from '@enkaku/server'
import type { ByteTransform, Unwrap, UnwrapResult } from '@kumiai/broadcast'
import { defaultRandomID } from '@kumiai/broadcast'
import type { StoredMessage } from '@kumiai/hub-protocol'
import { createHubTunnelTransport, decodeFrame, type MailboxHub } from '@kumiai/hub-tunnel'

import { sealDirectedHub } from './directed-crypto.js'
import type { HubMux } from './hub-mux.js'
import { inboxTopic } from './topic.js'

export type DirectedClientParams = {
  mux: HubMux
  localDID: string
  memberDID: string
  secret: Uint8Array
  epoch: number
  wrap: ByteTransform
  unwrap: Unwrap
  getRandomID?: () => string
}

/**
 * Directed 1:1 RPC client to a single member, over a hub-tunnel transport whose
 * send/receive topics are the two members' inbox topics for the current epoch.
 */
export function createDirectedClient<Protocol extends ProtocolDefinition>(
  params: DirectedClientParams,
): { client: Client<Protocol>; dispose: () => Promise<void> } {
  const { mux, localDID, memberDID, secret, epoch, wrap, unwrap } = params
  const getRandomID = params.getRandomID ?? defaultRandomID
  // Replies are authored by `memberDID`; drop anything a lying hub injects under
  // a different MLS sender.
  const sealedHub = sealDirectedHub({
    hub: mux.mailbox,
    wrap,
    unwrap,
    expectedSenderDID: memberDID,
  })
  const transport = createHubTunnelTransport({
    hub: sealedHub,
    sessionID: getRandomID(),
    localDID,
    sendTopicID: inboxTopic(secret, epoch, memberDID),
    receiveTopicID: inboxTopic(secret, epoch, localDID),
  }) as ClientTransportOf<Protocol>
  const client = new Client<Protocol>({ transport, serverID: memberDID })
  return {
    client,
    dispose: async () => {
      await client.dispose()
    },
  }
}

function normalizeUnwrap(result: Uint8Array | UnwrapResult): UnwrapResult {
  return result instanceof Uint8Array ? { payload: result } : result
}

export type InboxAcceptorParams<Protocol extends ProtocolDefinition> = {
  mux: HubMux
  localDID: string
  selfInboxTopic: string
  /** Map an authenticated senderDID to the topic we send replies on (their inbox). */
  resolveSendTopic: (senderDID: string) => string
  protocol: Protocol
  handlers: ProcedureHandlers<Protocol>
  wrap: ByteTransform
  unwrap: Unwrap
}

type ServerSession = {
  senderDID: string
  feed: (frameBytes: Uint8Array) => void
  dispose: () => Promise<void>
}

/**
 * Accept directed RPC. A single sealed drain of `selfInboxTopic` opens each
 * inbound frame with `unwrap`, binds every session to the MLS-authenticated
 * sender recovered from the ciphertext, and feeds decrypted frame bytes into a
 * per-session in-memory transport whose replies are sealed with `wrap`. Frames
 * whose recovered sender does not match the session binding are dropped, so a
 * malicious hub can neither read the lane nor forge/splice a sender.
 */
export function createInboxAcceptor<Protocol extends ProtocolDefinition>(
  params: InboxAcceptorParams<Protocol>,
): { dispose: () => Promise<void> } {
  const { mux, localDID, selfInboxTopic, resolveSendTopic, protocol, handlers, wrap, unwrap } =
    params
  const server = new Server<Protocol>({ protocol, handlers, requireAuth: false })
  const sessions = new Map<string, ServerSession>()

  const createSession = (senderDID: string): ServerSession => {
    const queue: Array<StoredMessage> = []
    let resolveNext: ((result: IteratorResult<StoredMessage>) => void) | undefined
    let closed = false
    const sessionHub: MailboxHub = {
      async publish(publishParams) {
        const sealed = await wrap(publishParams.payload)
        return mux.mailbox.publish({
          senderDID: publishParams.senderDID,
          topicID: publishParams.topicID,
          payload: sealed,
        })
      },
      subscribe() {},
      unsubscribe() {},
      receive() {
        const iter: AsyncIterator<StoredMessage> = {
          next() {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift() as StoredMessage, done: false })
            }
            if (closed) {
              return Promise.resolve({ value: undefined as unknown as StoredMessage, done: true })
            }
            return new Promise((resolve) => {
              resolveNext = resolve
            })
          },
          return() {
            closed = true
            if (resolveNext != null) {
              const resolve = resolveNext
              resolveNext = undefined
              resolve({ value: undefined as unknown as StoredMessage, done: true })
            }
            return Promise.resolve({ value: undefined as unknown as StoredMessage, done: true })
          },
        }
        return {
          [Symbol.asyncIterator]: () => iter,
          return() {
            closed = true
            if (resolveNext != null) {
              const resolve = resolveNext
              resolveNext = undefined
              resolve({ value: undefined as unknown as StoredMessage, done: true })
            }
          },
        }
      },
    }
    const tunnel = createHubTunnelTransport({
      hub: sessionHub,
      sessionID: { auto: true },
      localDID,
      sendTopicID: resolveSendTopic(senderDID),
      receiveTopicID: selfInboxTopic,
    })
    void server.handle(tunnel as ServerTransportOf<Protocol>)
    return {
      senderDID,
      feed: (frameBytes) => {
        const message: StoredMessage = {
          sequenceID: '',
          senderDID,
          topicID: selfInboxTopic,
          payload: frameBytes,
        }
        if (resolveNext != null) {
          const resolve = resolveNext
          resolveNext = undefined
          resolve({ value: message, done: false })
        } else {
          queue.push(message)
        }
      },
      dispose: async () => {
        closed = true
        if (resolveNext != null) {
          const resolve = resolveNext
          resolveNext = undefined
          resolve({ value: undefined as unknown as StoredMessage, done: true })
        }
        await tunnel.dispose()
      },
    }
  }

  // Serialize inbound processing: `unwrap` is async (real MLS decrypt has
  // variable latency), so independent concurrent tasks could resolve out of
  // dispatch order — racing to double-create a session, or feeding frames to a
  // tunnel out of wire order (which drops them as stale seq). Chaining each
  // message onto a running tail keeps processing in arrival order.
  let inboundTail: Promise<void> = Promise.resolve()
  const unsubscribe = mux.onInbound(selfInboxTopic, (message) => {
    inboundTail = inboundTail
      .then(async () => {
        let opened: UnwrapResult
        try {
          opened = normalizeUnwrap(await unwrap(message.payload))
        } catch {
          return // un-openable — drop
        }
        const senderDID = opened.senderDID
        if (senderDID == null) return // no authenticated sender — drop
        let frame: ReturnType<typeof decodeFrame>
        try {
          frame = decodeFrame(opened.payload)
        } catch {
          return
        }
        const existing = sessions.get(frame.sessionID)
        if (frame.kind === 'session-end') {
          if (existing != null && existing.senderDID === senderDID) {
            sessions.delete(frame.sessionID)
            void existing.dispose()
          }
          return
        }
        if (frame.kind !== 'message') return
        if (existing != null) {
          if (existing.senderDID === senderDID) existing.feed(opened.payload)
          return // sender mismatch on an established session — splice attempt, drop
        }
        const session = createSession(senderDID)
        sessions.set(frame.sessionID, session)
        session.feed(opened.payload)
      })
      .catch(() => {
        // a single message's processing failure must not break the chain
      })
  })

  return {
    dispose: async () => {
      unsubscribe()
      const pending = [...sessions.values()].map((session) => session.dispose())
      sessions.clear()
      await Promise.allSettled(pending)
      await server.dispose()
    },
  }
}
