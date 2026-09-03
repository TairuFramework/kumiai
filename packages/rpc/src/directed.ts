import { Client } from '@enkaku/client'
import {
  type ClientTransportOf,
  ErrorCodes,
  type ProtocolDefinition,
  type ServerTransportOf,
} from '@enkaku/protocol'
import { HandlerError, type ProcedureHandlers, Server } from '@enkaku/server'
import type { Unwrap } from '@kumiai/broadcast'
import type { StoredMessage } from '@kumiai/hub-protocol'
import {
  createHubTunnelTransport,
  decodeFrame,
  encodeFrame,
  type MailboxHub,
} from '@kumiai/hub-tunnel'
import { fromUTF } from '@sozai/codec'
import { createRuntime, type Runtime } from '@sozai/runtime'

import type { GroupCrypto } from './crypto.js'
import {
  decodeDirectedPayload,
  encodeDirectedPayload,
  isLegacyDirectedPayload,
} from './directed-tag.js'
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
  /** The protocol this frame is tagged for, decoded from the sealed in-frame discriminator. */
  protocol: string
  /** The inner hub-tunnel frame, with the protocol tag stripped. */
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
    project: (message, opened) => {
      if (opened.senderDID == null) return undefined
      // The tag is inside the seal, so it is authenticated to the recovered sender. A legacy or
      // malformed payload is dropped HERE — the open already spent the ratchet key.
      if (isLegacyDirectedPayload(opened.payload)) return undefined
      let decoded: { protocol: string; frame: Uint8Array }
      try {
        decoded = decodeDirectedPayload(opened.payload)
      } catch {
        return undefined
      }
      return {
        sequenceID: message.sequenceID,
        senderDID: opened.senderDID,
        topicID: message.topicID,
        protocol: decoded.protocol,
        payload: decoded.frame,
      }
    },
  })
}

/**
 * Default `requestTimeoutMs` a directed client aborts a unary request after. The unary-only
 * backstop for a request the recipient never answers: enkaku applies it to `request`, not to
 * stream/channel creation, so those lean on the unrouted-tag NACK ({@link createUnroutedTagResponder})
 * instead. 30s is a deliberate ceiling — a call the peer means to answer answers well inside it,
 * so its expiry is evidence the call was dropped.
 */
export const DEFAULT_DIRECTED_REQUEST_TIMEOUT_MS = 30_000

export type DirectedClientParams = {
  mux: HubMux
  localDID: string
  memberDID: string
  sendTopicID: string
  receiveTopicID: string
  /** The self-inbox topic's one open-once path, shared with the acceptor. */
  inbound: InboundPath
  wrap: GroupCrypto['wrap']
  /** Runtime providing platform primitives. Defaults to `createRuntime()`. */
  runtime?: Runtime
  /** The protocol name outbound frames are tagged with, and inbound frames filtered on. */
  protocol: string
  /**
   * How long a unary request waits before aborting. Defaults to
   * {@link DEFAULT_DIRECTED_REQUEST_TIMEOUT_MS}. Unary only — enkaku does not apply it to
   * stream/channel creation.
   */
  requestTimeoutMs?: number
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
  const { mux, localDID, memberDID, sendTopicID, receiveTopicID, inbound, wrap, protocol } = params
  const requestTimeoutMs = params.requestTimeoutMs ?? DEFAULT_DIRECTED_REQUEST_TIMEOUT_MS
  const { getRandomID } = params.runtime ?? createRuntime()
  let unsubscribe: (() => void) | undefined
  const hub: MailboxHub = {
    async publish(publishParams) {
      const tagged = encodeDirectedPayload(protocol, publishParams.payload)
      return mux.mailbox.publish({
        senderDID: publishParams.senderDID,
        topicID: publishParams.topicID,
        payload: await wrap(tagged, { aad: fromUTF(publishParams.topicID) }),
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
        if (
          closed ||
          message.topicID !== receiveTopicID ||
          message.protocol !== protocol ||
          message.senderDID !== memberDID
        )
          return
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
  const client = new Client<Protocol>({ transport, serverID: memberDID, requestTimeoutMs })
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
  /** The tag's string NAME — distinct from `protocol` above, which is the definition object. */
  protocolName: string
  handlers: ProcedureHandlers<Protocol>
  wrap: GroupCrypto['wrap']
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
  const {
    mux,
    localDID,
    selfInboxTopic,
    inbound,
    resolveSendTopic,
    protocol,
    protocolName,
    handlers,
    wrap,
  } = params
  const server = new Server<Protocol>({ protocol, handlers, requireAuth: false })
  const sessions = new Map<string, ServerSession>()

  const createSession = (senderDID: string): ServerSession => {
    const queue: Array<StoredMessage> = []
    let resolveNext: ((result: IteratorResult<StoredMessage>) => void) | undefined
    let closed = false
    const sessionHub: MailboxHub = {
      async publish(publishParams) {
        const tagged = encodeDirectedPayload(protocolName, publishParams.payload)
        const sealed = await wrap(tagged, { aad: fromUTF(publishParams.topicID) })
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
    if (message.topicID !== selfInboxTopic || message.protocol !== protocolName) return
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

/** Frame payload types that carry a NEW request a peer must answer — the only ones worth NACKing. */
const REQUEST_LIKE = new Set(['request', 'stream', 'channel', 'send'])

export type UnroutedTagResponderParams = {
  mux: HubMux
  localDID: string
  /** The self-inbox topic's one open-once path, shared with every acceptor. */
  inbound: InboundPath
  /** Whether this peer serves the tag's protocol; a tag outside it is unrouted. */
  isRegistered: (protocol: string) => boolean
  /** The topic to reply on for an authenticated sender — the sender's own inbox. */
  resolveSendTopic: (senderDID: string) => string
  wrap: GroupCrypto['wrap']
}

/**
 * Restores failure legibility for a frame tagged for a protocol this peer does not serve. Every
 * acceptor filters on its own protocol, so a frame tagged for none is fed to no acceptor and would
 * be silently dropped; this single peer-level consumer of the shared inbound path NACKs it, so a
 * caller's unary request rejects with `INVALID_MESSAGE` (and a stream/channel creation, which the
 * client timeout cannot abort, rejects at all) instead of hanging.
 *
 * Three constraints, each of which if broken makes this worse than nothing:
 * - The NACK is tagged with the OFFENDING protocol, not one of ours, or the caller's own protocol
 *   filter drops it.
 * - Only REQUEST-like frames are answered: a `result`/`error`/`receive` reply carries an `rid` too,
 *   and NACKing one lets two peers that both lack the tag volley error frames forever.
 * - The reply reuses the offending frame's `sessionID` (the caller's tunnel locks to it) and a
 *   fresh, monotonic `seq` (the tunnel drops `seq` below what it has already seen).
 */
export function createUnroutedTagResponder(params: UnroutedTagResponderParams): {
  dispose: () => void
} {
  const { mux, localDID, inbound, isRegistered, resolveSendTopic, wrap } = params
  // Monotonic across every session this responder answers: a caller's virgin tunnel expects seq 0,
  // and any seq >= its expected value is accepted, so one NACK per caller session is always fresh.
  let seq = 0
  const unsubscribe = inbound((message) => {
    if (isRegistered(message.protocol)) return
    let frame: ReturnType<typeof decodeFrame>
    try {
      frame = decodeFrame(message.payload)
    } catch {
      return
    }
    if (frame.kind !== 'message') return
    const payload = frame.body.payload
    const rid = payload.rid
    if (typeof rid !== 'string' || !REQUEST_LIKE.has(payload.typ)) return
    const errorPayload = new HandlerError({
      code: ErrorCodes.INVALID_MESSAGE,
      message: `No handler registered for protocol "${message.protocol}"`,
    }).toPayload(rid)
    const nack = encodeFrame({
      v: 1,
      sessionID: frame.sessionID,
      seq: seq++,
      kind: 'message',
      body: { header: {}, payload: errorPayload },
    })
    void (async () => {
      const topicID = resolveSendTopic(message.senderDID)
      const sealed = await wrap(encodeDirectedPayload(message.protocol, nack), {
        aad: fromUTF(topicID),
      })
      await mux.mailbox.publish({ senderDID: localDID, topicID, payload: sealed })
    })()
  })
  return { dispose: unsubscribe }
}
