import type { TransportType } from '@enkaku/transport'
import type { EventEmitter } from '@sozai/event'

import type { ReplyData, RequestData } from './client.js'
import type { BroadcastMessage } from './transport.js'
import { defaultJitter, defaultSleep, isSuppressible } from './utils.js'

/** The payload an inbound fire-and-forget event carries to its listener. */
export type BusEvent = { data: unknown; senderDID?: string }
/** Event fan-out keyed by procedure name. */
export type BusEvents = Record<string, BusEvent>

export type BroadcastHandler = (
  prm: unknown,
  context?: { senderDID?: string; signal?: AbortSignal },
) => unknown | Promise<unknown>
export type SuppressConfig = { jitterMs?: number; suppressTtlMs?: number }
export type SuppressibleHandler = BroadcastHandler & { suppress: SuppressConfig }

const DEFAULT_JITTER_MS = 250
const DEFAULT_SUPPRESS_TTL_MS = 30_000

/** Tag a handler for jitter + observe-and-suppress storm-collapse. */
export function suppressible(
  handler: BroadcastHandler,
  config: SuppressConfig = {},
): SuppressibleHandler {
  return Object.assign(handler.bind(null) as BroadcastHandler, { suppress: config })
}

export type BroadcastResponderParams = {
  transport: TransportType<BroadcastMessage, BroadcastMessage>
  /**
   * This responder's own name, for buses that have NO authenticated sender to offer — the memory
   * bus, and doubles built on it. It is written as the outgoing message's transport-level
   * `senderDID`, not into the reply body, so a receiver reads one field either way: on an
   * authenticating transport `unwrap` overwrites it with what it recovered, and this value never
   * reaches a consumer. Self-asserted, and only ever believed where there is no one else to ask.
   */
  from: string
  requestHandlers: Record<string, BroadcastHandler | SuppressibleHandler>
  /** Optional fan-out for fire-and-forget event frames (typ 'event', no req/res kind). */
  events?: EventEmitter<BusEvents>
  sleep?: (ms: number) => Promise<void>
  getJitterMs?: (maxMs: number) => number
}

type InboundData = {
  kind?: string
  rid?: string
  prm?: unknown
  ok?: unknown
  err?: string
}

export function createBroadcastResponder(params: BroadcastResponderParams): {
  dispose: () => Promise<void>
} {
  const { transport, from, requestHandlers, events } = params
  const sleep = params.sleep ?? defaultSleep
  const getJitterMs = params.getJitterMs ?? defaultJitter

  // Maps request IDs to their expiry timer handle. First-writer-wins: once a rid
  // is registered, subsequent markReplied calls for the same rid are no-ops so
  // the original (possibly longer) TTL is never shortened by the looped-back reply.
  const suppressTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // In-flight request controllers, aborted on dispose so a torn-down epoch stops
  // its handlers rather than orphaning them.
  const inFlight = new Set<AbortController>()
  let running = true

  const markReplied = (rid: string, ttlMs: number) => {
    if (suppressTimers.has(rid)) {
      return
    }
    const timer = setTimeout(() => {
      suppressTimers.delete(rid)
    }, ttlMs)
    suppressTimers.set(rid, timer)
  }

  const handleRequest = async (
    prc: string,
    request: RequestData,
    handler: BroadcastHandler | SuppressibleHandler,
    senderDID?: string,
  ): Promise<void> => {
    // Gather requests must reach every responder — bypass storm-collapse.
    const isGather = request.gather === true
    if (!isGather && isSuppressible(handler)) {
      const { jitterMs = DEFAULT_JITTER_MS } = handler.suppress
      await sleep(getJitterMs(jitterMs))
      if (suppressTimers.has(request.rid)) {
        return
      }
    }

    // Disposed during the jitter sleep: the controller we'd create now would never be aborted.
    if (!running) {
      return
    }

    const controller = new AbortController()
    inFlight.add(controller)
    let reply: ReplyData
    try {
      const ok = await handler(request.prm, { senderDID, signal: controller.signal })
      reply = { kind: 'res', rid: request.rid, ok }
    } catch (error) {
      reply = {
        kind: 'res',
        rid: request.rid,
        err: error instanceof Error ? error.message : String(error),
      }
    } finally {
      inFlight.delete(controller)
    }
    // Disposed while this handler was in flight (e.g. it resolved on abort): don't register a new
    // suppress timer or write on a tearing-down transport.
    if (!running) {
      return
    }
    const ttlMs = isSuppressible(handler)
      ? (handler.suppress.suppressTtlMs ?? DEFAULT_SUPPRESS_TTL_MS)
      : DEFAULT_SUPPRESS_TTL_MS
    // Suppress healthy responders only on a SUCCESS. An error reply leaves the rid
    // open so a slower, working responder still answers.
    if (!isGather && reply.err == null) {
      markReplied(request.rid, ttlMs)
    }
    // Best-effort write: ignore rejections (e.g. transport disposed mid-flight). `senderDID`
    // rides at the transport level, where an authenticating transport replaces it with what it
    // recovered; see {@link BroadcastResponderParams.from}.
    await transport
      .write({ payload: { typ: 'event', prc, data: reply }, senderDID: from })
      .catch(() => {})
  }

  void (async () => {
    for await (const msg of transport) {
      if (!running) {
        break
      }
      const payload = msg?.payload
      if (payload?.typ !== 'event') {
        continue
      }
      const data = payload.data as InboundData | undefined
      if (data?.kind === 'res' && typeof data.rid === 'string') {
        // Only a peer's SUCCESS suppresses us; its error frame must not.
        if (data.err == null) {
          markReplied(data.rid, DEFAULT_SUPPRESS_TTL_MS)
        }
        continue
      }
      if (typeof payload.prc !== 'string') {
        continue
      }
      if (data?.kind === 'req' && typeof data.rid === 'string') {
        const handler = requestHandlers[payload.prc]
        if (handler != null) {
          void handleRequest(payload.prc, data as RequestData, handler, msg.senderDID)
        }
        continue
      }
      // A control frame (kind 'req'/'res') that failed its rid check above is malformed, not an
      // event — drop it rather than forwarding its raw {kind,rid,…} object to event listeners.
      if (data?.kind === 'req' || data?.kind === 'res') {
        continue
      }
      // Genuine fire-and-forget event: real app data carries no `kind` field.
      void events
        ?.emit(payload.prc, { data: payload.data, senderDID: msg.senderDID })
        .catch(() => {})
    }
  })().catch(() => {})

  return {
    dispose: async () => {
      running = false
      for (const controller of inFlight) {
        controller.abort()
      }
      inFlight.clear()
      for (const timer of suppressTimers.values()) {
        clearTimeout(timer)
      }
      suppressTimers.clear()
      await transport.dispose()
    },
  }
}
