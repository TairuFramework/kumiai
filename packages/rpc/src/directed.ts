import { Client } from '@enkaku/client'
import type { ClientTransportOf, ProtocolDefinition, ServerTransportOf } from '@enkaku/protocol'
import { type ProcedureHandlers, Server } from '@enkaku/server'
import type { ByteTransform, Unwrap } from '@kumiai/broadcast'
import type { StoredMessage } from '@kumiai/hub-protocol'
import { createHubTunnelTransport, decodeFrame, type MailboxHub } from '@kumiai/hub-tunnel'
import { createRuntime, type Runtime } from '@sozai/runtime'

import type { HubMux } from './hub-mux.js'
import { createOpenOncePath } from './open-once.js'

/**
 * An inbound frame that has ALREADY been opened, with the sender the open authenticated.
 *
 * Every consumer of a topic is handed this rather than an `unwrap` of its own, because opening is
 * a consuming operation: real MLS spends the frame's per-message key on the first open, so two
 * consumers each calling `unwrap` race for one key and the loser sees a frame it cannot open. The
 * inbox topic has several consumers at once — the acceptor, and one directed client per member —
 * so this is the only shape that works there.
 */
export type OpenedInbound = {
  sequenceID: string
  /** Recovered from the ciphertext by the open, never the hub-asserted one. */
  senderDID: string
  topicID: string
  payload: Uint8Array
}

/** Subscribe to a topic's already-opened frames; returns the unsubscribe. */
export type InboundPath = (onOpened: (message: OpenedInbound) => void) => () => void

export type InboxPathParams = {
  mux: HubMux
  topicID: string
  unwrap: Unwrap
  /** Forwarded to {@link createOpenOncePath} — see there for what it decides. */
  retainOnFailure?: (message: StoredMessage) => boolean
}

/**
 * The one path that opens an inbox topic's frames, for every consumer of it.
 *
 * A frame that opens without an authenticated sender is dropped HERE. The hub-asserted sender is
 * never a fallback — directed RPC binds every session to the sender the open recovered, which is
 * what stops a lying hub forging or splicing one.
 */
export function createInboxPath(params: InboxPathParams): InboundPath {
  const { mux, topicID, unwrap, retainOnFailure } = params
  return createOpenOncePath<OpenedInbound>({
    mux,
    topicID,
    unwrap,
    ...(retainOnFailure != null ? { retainOnFailure } : {}),
    project: (message, opened) =>
      opened.senderDID == null
        ? undefined
        : {
            sequenceID: message.sequenceID,
            senderDID: opened.senderDID,
            topicID: message.topicID,
            payload: opened.payload,
          },
  })
}

export type DirectedClientParams = {
  mux: HubMux
  localDID: string
  memberDID: string
  sendTopicID: string
  receiveTopicID: string
  /** The self-inbox topic's one open-once path, shared with the acceptor. */
  inbound: InboundPath
  wrap: ByteTransform
  /** Runtime providing platform primitives. Defaults to `createRuntime()`. */
  runtime?: Runtime
}

/**
 * Directed 1:1 RPC client to a single member, over a hub-tunnel transport whose
 * send/receive topics are the two members' inbox topics for the current epoch.
 *
 * Replies are authored by `memberDID`, so anything the shared path opens under a different
 * MLS-authenticated sender belongs to another conversation on the same inbox and is left for
 * the consumer it does belong to.
 */
export function createDirectedClient<Protocol extends ProtocolDefinition>(
  params: DirectedClientParams,
): { client: Client<Protocol>; dispose: () => Promise<void> } {
  const { mux, localDID, memberDID, sendTopicID, receiveTopicID, inbound, wrap } = params
  const { getRandomID } = params.runtime ?? createRuntime()
  let unsubscribe: (() => void) | undefined
  const hub: MailboxHub = {
    async publish(publishParams) {
      return mux.mailbox.publish({
        senderDID: publishParams.senderDID,
        topicID: publishParams.topicID,
        payload: await wrap(publishParams.payload),
      })
    },
    subscribe() {},
    unsubscribe() {},
    receive(): ReturnType<MailboxHub['receive']> {
      const queue: Array<StoredMessage> = []
      let resolveNext: ((result: IteratorResult<StoredMessage>) => void) | undefined
      let closed = false
      const close = (): void => {
        closed = true
        unsubscribe?.()
        unsubscribe = undefined
        if (resolveNext != null) {
          const resolve = resolveNext
          resolveNext = undefined
          resolve({ value: undefined as unknown as StoredMessage, done: true })
        }
      }
      unsubscribe = inbound((message) => {
        if (closed || message.topicID !== receiveTopicID || message.senderDID !== memberDID) return
        if (resolveNext != null) {
          const resolve = resolveNext
          resolveNext = undefined
          resolve({ value: message, done: false })
        } else {
          queue.push(message)
        }
      })
      const iterator: AsyncIterator<StoredMessage> = {
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
          close()
          return Promise.resolve({ value: undefined as unknown as StoredMessage, done: true })
        },
      }
      return {
        [Symbol.asyncIterator]: () => iterator,
        return: close,
      }
    },
  }
  const transport = createHubTunnelTransport({
    hub,
    sessionID: getRandomID(),
    localDID,
    sendTopicID,
    receiveTopicID,
  }) as ClientTransportOf<Protocol>
  const client = new Client<Protocol>({ transport, serverID: memberDID })
  return {
    client,
    dispose: async () => {
      await client.dispose()
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}

export type InboxAcceptorParams<Protocol extends ProtocolDefinition> = {
  mux: HubMux
  localDID: string
  selfInboxTopic: string
  /** The self-inbox topic's one open-once path, shared with every directed client. */
  inbound: InboundPath
  /** Map an authenticated senderDID to the topic we send replies on (their inbox). */
  resolveSendTopic: (senderDID: string) => string
  protocol: Protocol
  handlers: ProcedureHandlers<Protocol>
  wrap: ByteTransform
}

type ServerSession = {
  senderDID: string
  feed: (frameBytes: Uint8Array) => void
  dispose: () => Promise<void>
}

/**
 * Accept directed RPC. A single sealed drain of `selfInboxTopic` opens each inbound frame with
 * `unwrap`, binds every session to the MLS-authenticated sender recovered from the ciphertext,
 * and feeds decrypted bytes into a per-session in-memory transport whose replies are sealed
 * with `wrap`. Frames whose recovered sender does not match the session binding are dropped, so
 * a malicious hub can neither read the lane nor forge/splice a sender.
 */
export function createInboxAcceptor<Protocol extends ProtocolDefinition>(
  params: InboxAcceptorParams<Protocol>,
): { dispose: () => Promise<void> } {
  const { mux, localDID, selfInboxTopic, inbound, resolveSendTopic, protocol, handlers, wrap } =
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

  // The frame arrives already opened, and the sender is the one the open authenticated — a lying
  // hub can neither read this lane nor forge a sender into it. Arrival order is the open path's
  // guarantee: it opens one frame at a time, so a session is never double-created and a tunnel is
  // never fed out of wire order (which drops as a stale seq).
  const unsubscribe = inbound((message) => {
    if (message.topicID !== selfInboxTopic) return
    const senderDID = message.senderDID
    let frame: ReturnType<typeof decodeFrame>
    try {
      frame = decodeFrame(message.payload)
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
      if (existing.senderDID === senderDID) existing.feed(message.payload)
      return // sender mismatch on an established session — splice attempt, drop
    }
    const session = createSession(senderDID)
    sessions.set(frame.sessionID, session)
    session.feed(message.payload)
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
