import type { TransportType } from '@enkaku/transport'
import {
  type BroadcastHandler,
  type BroadcastMessage,
  defaultJitter,
  defaultSleep,
  isSuppressible,
  type SuppressibleHandler,
} from '@kumiai/broadcast'

const DEFAULT_JITTER_MS = 250
const DEFAULT_SUPPRESS_TTL_MS = 30_000

// Hand-copied from `@kumiai/broadcast`'s `ReplyData`/`RequestData` and changes with them. The
// reply body names no sender: see the doc on the broadcast type. The sender rides at the
// transport level, where only an authenticating `unwrap` may set it.
type ReplyData = { kind: 'res'; rid: string; ok?: unknown; err?: string }
type RequestData = { kind: 'req'; rid: string; prm: unknown; gather?: boolean }

export type GroupBusServerParams = {
  transport: TransportType<BroadcastMessage, BroadcastMessage>
  /**
   * This server's own name, for buses with no authenticated sender. Written as the outgoing
   * message's transport-level `senderDID`, never into a reply body; over MLS the receiver's
   * `unwrap` overwrites it and it never reaches a consumer. Mirrors
   * `BroadcastResponderParams.from`.
   */
  from: string
  /** Fire-and-forget event procedures: prc -> handler(data, senderDID). */
  eventHandlers: Record<string, (data: unknown, senderDID?: string) => void | Promise<void>>
  /** Anycast request procedures: prc -> handler(param, { senderDID }) -> result. */
  requestHandlers: Record<string, BroadcastHandler | SuppressibleHandler>
  sleep?: (ms: number) => Promise<void>
  getJitterMs?: (maxMs: number) => number
}

/**
 * Bus-side server for a single protocol topic: dispatches plain events to
 * `eventHandlers` and anycast requests to `requestHandlers` (with the same
 * jitter + observe-and-suppress storm-collapse as `createBroadcastResponder`),
 * forwarding the unwrap-recovered `senderDID` to both.
 */
type InboundData = { kind?: string; rid?: string; prm?: unknown; gather?: boolean }

export function createGroupBusServer(params: GroupBusServerParams): {
  dispose: () => Promise<void>
} {
  const { transport, from, eventHandlers, requestHandlers } = params
  const sleep = params.sleep ?? defaultSleep
  const getJitterMs = params.getJitterMs ?? defaultJitter

  const suppressTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let running = true

  const markReplied = (rid: string, ttlMs: number): void => {
    if (suppressTimers.has(rid)) return
    const timer = setTimeout(() => suppressTimers.delete(rid), ttlMs)
    suppressTimers.set(rid, timer)
  }

  const handleRequest = async (
    prc: string,
    request: RequestData,
    handler: BroadcastHandler | SuppressibleHandler,
    senderDID?: string,
  ): Promise<void> => {
    const isGather = request.gather === true
    if (!isGather && isSuppressible(handler)) {
      const { jitterMs = DEFAULT_JITTER_MS } = handler.suppress
      await sleep(getJitterMs(jitterMs))
      if (suppressTimers.has(request.rid)) return
    }
    let reply: ReplyData
    try {
      const ok = await handler(request.prm, { senderDID })
      reply = { kind: 'res', rid: request.rid, ok }
    } catch (error) {
      reply = {
        kind: 'res',
        rid: request.rid,
        err: error instanceof Error ? error.message : String(error),
      }
    }
    const ttlMs = isSuppressible(handler)
      ? (handler.suppress.suppressTtlMs ?? DEFAULT_SUPPRESS_TTL_MS)
      : DEFAULT_SUPPRESS_TTL_MS
    if (!isGather) markReplied(request.rid, ttlMs)
    await transport
      .write({ payload: { typ: 'event', prc, data: reply }, senderDID: from })
      .catch(() => {})
  }

  void (async () => {
    for await (const msg of transport) {
      if (!running) break
      const payload = msg?.payload
      if (payload?.typ !== 'event' || typeof payload.prc !== 'string') continue
      const data = payload.data as InboundData | undefined
      if (data?.kind === 'res' && typeof data.rid === 'string') {
        markReplied(data.rid, DEFAULT_SUPPRESS_TTL_MS)
        continue
      }
      if (data?.kind === 'req' && typeof data.rid === 'string') {
        const handler = requestHandlers[payload.prc]
        if (handler != null) {
          void handleRequest(payload.prc, data as RequestData, handler, msg.senderDID)
        }
        continue
      }
      const eventHandler = eventHandlers[payload.prc]
      if (eventHandler != null) {
        void Promise.resolve(eventHandler(payload.data, msg.senderDID)).catch(() => {})
      }
    }
  })().catch(() => {})

  return {
    dispose: async () => {
      running = false
      for (const timer of suppressTimers.values()) clearTimeout(timer)
      suppressTimers.clear()
      await transport.dispose()
    },
  }
}
