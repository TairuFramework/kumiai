import {
  type ChannelHandler,
  HandlerError,
  type ProcedureHandlers,
  type RequestHandler,
} from '@enkaku/server'
import type { HubProtocol, HubStore, StoredMessage } from '@kumiai/hub-protocol'
import {
  HUB_ERROR_CODES,
  hubErrorCodeOf,
  InvalidPayloadError,
  KeyPackageFetchLimitError,
} from '@kumiai/hub-protocol'
import { fromB64, toB64 } from '@sozai/codec'

import { createRateLimiter, type RateLimitConfig } from './rateLimit.js'
import type { HubClientRegistry } from './registry.js'

/**
 * A single request to authorize. All six variants ship even though only `publish` and
 * `subscribe` are currently enforced: the union is the exhaustive-switch surface a host's own
 * `switch (req.action)` closes over, so adding a seventh variant later is the compatibility break
 * this type exists to avoid.
 *
 * A host's `switch` need not handle every action today — an unrecognized action should default to
 * allow, so a hook written before a new variant shipped doesn't silently start refusing a
 * procedure that was previously ungated.
 */
export type AuthorizeRequest =
  | {
      action: 'publish'
      did: string
      topicID: string
      retain: 'log' | 'mailbox'
      payloadSize: number
    }
  | { action: 'subscribe'; did: string; topicID: string; retention?: number }
  | { action: 'unsubscribe'; did: string; topicID: string }
  | { action: 'topic/fetch'; did: string; topicID: string }
  | { action: 'keypackage/upload'; did: string; count: number }
  | { action: 'keypackage/fetch'; did: string; targetDID: string; count: number }

/**
 * A plain `boolean` is shorthand for `{ allow: boolean }`, with no reason, code, or retry hint.
 *
 * **`reason` is the only field a caller sees today.** `code` and `retryAfterMs` are reserved for
 * enforcement that hasn't been built yet — a hook may return them, but both are silently dropped
 * before the refusal reaches the client. They ship now because widening this union later is the
 * break the surface exists to avoid; until enforcement lands, don't depend on either reaching a
 * caller.
 */
export type AuthorizeDecision =
  | boolean
  | { allow: boolean; reason?: string; code?: string; retryAfterMs?: number }

export type AuthorizeHook = (
  req: AuthorizeRequest,
) => AuthorizeDecision | Promise<AuthorizeDecision>

function normalizeAuthorizeDecision(decision: AuthorizeDecision): {
  allow: boolean
  reason?: string
} {
  return typeof decision === 'boolean' ? { allow: decision } : decision
}

export type HubRateLimits = {
  perDID: RateLimitConfig
  perTopic: RateLimitConfig
}

export const DEFAULT_RATE_LIMITS: HubRateLimits = {
  perDID: { rate: 20, burst: 50 },
  perTopic: { rate: 100, burst: 200 },
}

export type KeyPackageFetchLimits = {
  /** Maximum number of key packages returned per fetch. Default: 10 */
  maxCount: number
  /** Maximum number of fetch requests per requester DID per window. Default: 30 */
  maxRequests: number
  /** Maximum number of key packages that may be consumed from ONE target DID per window,
   * summed across all requesters. Bounds collective drain. Default: 60 */
  maxPerTargetConsumed: number
  /** Rate-limit window duration in milliseconds. Default: 60000 (1 min) */
  windowMs: number
}

export const DEFAULT_KEYPACKAGE_FETCH_LIMITS: KeyPackageFetchLimits = {
  maxCount: 10,
  maxRequests: 30,
  maxPerTargetConsumed: 60,
  windowMs: 60_000,
}

/**
 * Max frames queued-but-unflushed on a single receive channel before it falls back to the store.
 *
 * Should be >= the drain's 50-frame fetch page size: the drain enqueues a whole backlog page
 * before awaiting, so a limit below 50 would trip the cap on the very first page regardless of
 * writer health. The default of 256 is safely above it.
 */
export const DEFAULT_RECEIVE_BUFFER_LIMIT = 256

export type CreateHandlersParams = {
  registry: HubClientRegistry
  store: HubStore
  authorize?: AuthorizeHook
  rateLimits?: Partial<HubRateLimits>
  keyPackageFetchLimits?: Partial<KeyPackageFetchLimits>
  /** Max frames queued-but-unflushed on a receive channel. See {@link DEFAULT_RECEIVE_BUFFER_LIMIT}
   * for the >= 50-frame-page floor this should respect. Default: 256 */
  receiveBufferLimit?: number
}

function getClientDID(ctx: { message: { payload: Record<string, unknown> } }): string {
  const iss = ctx.message.payload.iss
  if (typeof iss !== 'string' || iss.length === 0) {
    throw new Error('Unauthenticated message: missing verified issuer DID')
  }
  return iss
}

/**
 * Re-raise a named store error with its wire code, so the caller can tell a lost compare-and-set
 * from an unreachable hub. Anything else is not ours and passes through untouched.
 */
function rethrowAsHandlerError(error: unknown): never {
  const code = hubErrorCodeOf(error)
  if (code != null) {
    throw new HandlerError({
      code,
      message: error instanceof Error ? error.message : code,
      cause: error,
    })
  }
  throw error
}

type ReceiveFrame = {
  sequenceID: string
  senderDID: string
  topicID: string
  payload: string
  logPosition?: string
}

function toReceiveFrame(message: StoredMessage): ReceiveFrame {
  return {
    sequenceID: message.sequenceID,
    senderDID: message.senderDID,
    topicID: message.topicID,
    payload: toB64(message.payload),
    // Spread, not assignment — `logPosition: undefined` would serialize as a present key, defeating
    // the field's absent-vs-present meaning.
    ...(message.logPosition != null ? { logPosition: message.logPosition } : {}),
  }
}

export function createHandlers(params: CreateHandlersParams): ProcedureHandlers<HubProtocol> {
  const { store, registry } = params
  const authorize: AuthorizeHook = params.authorize ?? (() => true)
  const rateLimits: HubRateLimits = {
    perDID: { ...DEFAULT_RATE_LIMITS.perDID, ...params.rateLimits?.perDID },
    perTopic: { ...DEFAULT_RATE_LIMITS.perTopic, ...params.rateLimits?.perTopic },
  }
  const didLimiter = createRateLimiter(rateLimits.perDID)
  const topicLimiter = createRateLimiter(rateLimits.perTopic)
  const receiveBufferLimit = params.receiveBufferLimit ?? DEFAULT_RECEIVE_BUFFER_LIMIT

  const fetchLimits: KeyPackageFetchLimits = {
    ...DEFAULT_KEYPACKAGE_FETCH_LIMITS,
    ...params.keyPackageFetchLimits,
  }
  // Bounded by request throughput x windowMs, not by an absolute cap: each entry expires after its
  // own window and the size > 1024 sweep (below) drops expired entries, but there is no hard ceiling
  // on distinct keys held concurrently. The absolute per-DID bound lives in the STORE's caps (see
  // memoryStore's per-DID key-package/subscription quotas), not here — this is the pre-existing
  // rate-window pattern (fetchWindows/targetWindows), acknowledged, not changed.
  const fetchWindows = new Map<string, { count: number; resetAt: number }>()

  function assertKeyPackageFetchAllowed(requesterDID: string): void {
    const now = Date.now()
    if (fetchWindows.size > 1024) {
      for (const [did, window] of fetchWindows) {
        if (window.resetAt <= now) {
          fetchWindows.delete(did)
        }
      }
    }
    const window = fetchWindows.get(requesterDID)
    if (window == null || window.resetAt <= now) {
      fetchWindows.set(requesterDID, { count: 1, resetAt: now + fetchLimits.windowMs })
      return
    }
    if (window.count >= fetchLimits.maxRequests) {
      throw new KeyPackageFetchLimitError('Key package fetch rate limit exceeded')
    }
    window.count++
  }

  // Same bound as fetchWindows above: throughput x windowMs plus the size > 1024 expired-entry
  // sweep, not an absolute cap — the absolute per-DID bound is the store's caps, not this map.
  const targetWindows = new Map<string, { count: number; resetAt: number }>()

  /** Charge `amount` packages against the target DID's consumption window. Throws when the
   * window's budget is spent — this bounds how fast anyone, collectively, can drain a target. */
  function assertTargetConsumptionAllowed(targetDID: string, amount: number): void {
    const now = Date.now()
    if (targetWindows.size > 1024) {
      for (const [did, window] of targetWindows) {
        if (window.resetAt <= now) targetWindows.delete(did)
      }
    }
    const window = targetWindows.get(targetDID)
    if (window == null || window.resetAt <= now) {
      if (amount > fetchLimits.maxPerTargetConsumed) {
        throw new KeyPackageFetchLimitError(
          `Key package consumption limit exceeded for target ${targetDID}`,
        )
      }
      targetWindows.set(targetDID, { count: amount, resetAt: now + fetchLimits.windowMs })
      return
    }
    if (window.count + amount > fetchLimits.maxPerTargetConsumed) {
      throw new KeyPackageFetchLimitError(
        `Key package consumption limit exceeded for target ${targetDID}`,
      )
    }
    window.count += amount
  }

  return {
    'hub/v1/publish': (async (ctx) => {
      const { topicID, payload } = ctx.param
      const senderDID = getClientDID(ctx)
      // Decoded before authorize (not after) so the hook can see the real size. Two consequences
      // are deliberate: an unauthorized caller sending malformed base64 gets a decode error instead
      // of EK02, and decoding runs before both rate limiters, so oversized payloads are decoded
      // before being throttled (bounded by the transport's own message limit). Deriving the size
      // arithmetically from the base64 length instead was rejected — it drifts from
      // `@sozai/codec`'s actual decoding and can hand the hook a wrong number.
      //
      // `retain` defaults to 'mailbox' here, matching the store's own default (`memoryStore.ts`) —
      // the hook must never see an absent retain, since `AuthorizeRequest`'s `publish` variant
      // declares it required.
      let payloadBytes: Uint8Array
      try {
        payloadBytes = fromB64(payload)
      } catch (error) {
        rethrowAsHandlerError(
          new InvalidPayloadError(
            error instanceof Error ? error.message : 'Invalid base64 payload encoding',
          ),
        )
      }
      const retain = ctx.param.retain ?? 'mailbox'
      const decision = normalizeAuthorizeDecision(
        await authorize({
          action: 'publish',
          did: senderDID,
          topicID,
          retain,
          payloadSize: payloadBytes.length,
        }),
      )
      if (!decision.allow) {
        throw new HandlerError({
          code: 'EK02',
          message: decision.reason ?? 'Not authorized to publish to topic',
        })
      }
      if (!didLimiter.tryConsume(senderDID)) {
        throw new HandlerError({ code: 'EK01', message: 'Publish rate limit exceeded for DID' })
      }
      if (!topicLimiter.tryConsume(topicID)) {
        throw new HandlerError({ code: 'EK01', message: 'Publish rate limit exceeded for topic' })
      }
      let sequenceID: string
      let deduped: boolean
      try {
        const result = await store.publish({
          senderDID,
          topicID,
          payload: payloadBytes,
          retain: ctx.param.retain,
          // Absent and null are different requests: null is the empty-topic sentinel, absent is
          // an unconditional publish. Spreading only when present keeps them apart.
          ...('expectedHead' in ctx.param ? { expectedHead: ctx.param.expectedHead } : {}),
          publishID: ctx.param.publishID,
        })
        sequenceID = result.sequenceID
        deduped = result.deduped
      } catch (error) {
        rethrowAsHandlerError(error)
      }

      // A deduped publish appended nothing: already fanned out to whoever was subscribed then, and
      // its sequenceID may since be acked and its delivery row gone. Re-running would push a frame
      // every current subscriber already has, named by a dead sequenceID.
      if (!deduped) {
        // Only a log-class publish carries a logPosition. This sequenceID IS the log position (the
        // store just minted it for this accepted append); a mailbox publish has none, since its
        // recipient's own delivery-queue position isn't usable as a durable log cursor.
        const logPosition = ctx.param.retain === 'log' ? { logPosition: sequenceID } : {}
        // Live-deliver to currently-connected subscribers (minus the sender).
        const subscribers = await store.getSubscribers(topicID)
        for (const recipientDID of subscribers) {
          if (recipientDID === senderDID) continue
          const client = registry.getClient(recipientDID)
          if (client?.sendMessage != null) {
            client.sendMessage({
              sequenceID,
              senderDID,
              topicID,
              payload: payloadBytes,
              ...logPosition,
            })
          }
        }
      }

      return { sequenceID }
    }) as RequestHandler<HubProtocol, 'hub/v1/publish'>,

    'hub/v1/subscribe': (async (ctx) => {
      const { topicID, retention } = ctx.param
      const clientDID = getClientDID(ctx)
      const decision = normalizeAuthorizeDecision(
        await authorize({ action: 'subscribe', did: clientDID, topicID, retention }),
      )
      if (!decision.allow) {
        throw new HandlerError({
          code: HUB_ERROR_CODES.authorizationDenied,
          message: decision.reason ?? 'Not authorized to subscribe to topic',
        })
      }
      if (!didLimiter.tryConsume(clientDID)) {
        throw new HandlerError({ code: 'EK01', message: 'Subscribe rate limit exceeded for DID' })
      }
      try {
        await store.subscribe({ subscriberDID: clientDID, topicID, retention })
      } catch (error) {
        rethrowAsHandlerError(error)
      }
      return { subscribed: true }
    }) as RequestHandler<HubProtocol, 'hub/v1/subscribe'>,

    'hub/v1/topic/fetch': (async (ctx) => {
      const { topicID, after, limit } = ctx.param
      // subscriberDID is the authenticated caller (verified issuer), never a wire field — or any
      // member could read another's topic log by naming them.
      const subscriberDID = getClientDID(ctx)
      const decision = normalizeAuthorizeDecision(
        await authorize({ action: 'topic/fetch', did: subscriberDID, topicID }),
      )
      if (!decision.allow) {
        throw new HandlerError({
          code: HUB_ERROR_CODES.authorizationDenied,
          message: decision.reason ?? 'Not authorized to fetch topic',
        })
      }
      try {
        const result = await store.fetchTopic({ subscriberDID, topicID, after, limit })
        return {
          messages: result.messages.map((message) => ({
            sequenceID: message.sequenceID,
            senderDID: message.senderDID,
            topicID: message.topicID,
            payload: toB64(message.payload),
          })),
          head: result.head,
          oldest: result.oldest,
        }
      } catch (error) {
        rethrowAsHandlerError(error)
      }
    }) as RequestHandler<HubProtocol, 'hub/v1/topic/fetch'>,

    'hub/v1/unsubscribe': (async (ctx) => {
      const { topicID } = ctx.param
      const clientDID = getClientDID(ctx)
      if (!didLimiter.tryConsume(clientDID)) {
        throw new HandlerError({ code: 'EK01', message: 'Unsubscribe rate limit exceeded for DID' })
      }
      await store.unsubscribe(clientDID, topicID)
      return { unsubscribed: true }
    }) as RequestHandler<HubProtocol, 'hub/v1/unsubscribe'>,

    'hub/v1/receive': (async (ctx) => {
      const clientDID = getClientDID(ctx)
      const { after } = ctx.param ?? {}

      registry.register(clientDID)

      const writer = ctx.writable.getWriter()
      const reader = ctx.readable.getReader()

      let endEvicted: (() => void) | undefined
      const evictedHere = new Promise<void>((resolve) => {
        endEvicted = resolve
      })
      let receiveToken: symbol | undefined

      // Delivery state machine (H1) + bounded write queue (H3).
      // - DRAINING: live pushes buffer instead of writing; the drain writes the backlog in order.
      // - after the drain: flush buffered frames with sequenceID > lastServed (the dedup), then LIVE.
      // - LIVE: live pushes write directly.
      let phase: 'draining' | 'live' = 'draining'
      const liveBuffer: Array<ReceiveFrame> = []
      let lastServed = '' // highest sequenceID written; '' precedes every real (zero-padded) ID
      let pending = 0 // frames queued or mid-write but not yet flushed to the socket
      let tornDown = false
      let writeChain: Promise<void> = Promise.resolve()

      let resolveDone: () => void = () => {}
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve
      })

      // Idempotent teardown, shared by every failure and end path. Frames stay pending in the store
      // and redeliver on the next connect (store-and-forward).
      function finish(): void {
        if (tornDown) return
        tornDown = true
        if (receiveToken != null) registry.releaseReceiveWriter(clientDID, receiveToken)
        registry.unregisterIfIdle(clientDID)
        reader.cancel().catch(() => {})
        writer.abort(new Error('receive channel torn down')).catch(() => {})
        resolveDone()
      }

      // Serialize writes one at a time (preserves order). Over the cap or on a write rejection, tear
      // the channel down rather than swallow the error or grow without bound.
      function pushWrite(frame: ReceiveFrame): void {
        if (tornDown) return
        pending++
        if (pending > receiveBufferLimit) {
          finish()
          return
        }
        writeChain = writeChain.then(async () => {
          if (tornDown) return
          try {
            await writer.ready
            await writer.write(frame)
            if (frame.sequenceID > lastServed) lastServed = frame.sequenceID
          } catch {
            finish()
          } finally {
            pending--
          }
        })
      }

      // The registry callback (publish fan-out). Buffers during the drain, writes once live.
      // INVARIANT this and the flush's `> lastServed` dedup both depend on: the publish path must
      // keep a FIXED await-depth between the store minting a sequenceID and its call to
      // `sendMessage`, so concurrent publishes reach onLive in the same order their sequenceIDs
      // were minted. Break that ordering and the dedup doesn't just reorder frames — it silently
      // DROPS a lower-seq frame that arrives after a higher one already raised lastServed.
      const onLive = (message: StoredMessage): void => {
        const frame = toReceiveFrame(message)
        if (phase === 'draining') {
          // Bound liveBuffer the same way pushWrite bounds the write queue: a stalled-but-still-
          // connected reader can hang writeChain indefinitely, and buffered frames never reach
          // pushWrite's own cap check. Without this, the drain never completes and every publish
          // grows liveBuffer without bound. Drop the frame instead — it stays pending in the store
          // and redelivers on reconnect (store-and-forward), same fallback pushWrite's cap uses.
          if (liveBuffer.length >= receiveBufferLimit) {
            finish()
            return
          }
          liveBuffer.push(frame)
        } else {
          pushWrite(frame)
        }
      }

      try {
        // Binding evicts whatever held the lane: a reconnect means the old connection broke and the
        // server learns last, so the stale writer must give way to the live one. See
        // `HubClientRegistry.bindReceiveWriter`.
        const { token, evicted } = registry.bindReceiveWriter(clientDID, onLive, () =>
          endEvicted?.(),
        )
        receiveToken = token
        // After the bind, so the lane is never unheld between the two.
        evicted?.()

        // Drain the backlog. Await each page so lastServed is exact before the flush.
        let cursor: string | null | undefined = after
        while (!tornDown) {
          const result = await store.fetch({
            recipientDID: clientDID,
            after: cursor ?? undefined,
            limit: 50,
          })
          for (const msg of result.messages) {
            pushWrite(toReceiveFrame(msg))
          }
          await writeChain
          cursor = result.cursor
          if (!result.hasMore) break
        }

        // Flush frames that arrived live during the drain, deduped against what the drain already served,
        // then go live. The flip happens only when the buffer is observed empty in the SAME synchronous
        // step (no await between the empty check and the assignment), so a frame that arrived via onLive
        // during a prior write is caught on the next iteration rather than stranded.
        while (!tornDown) {
          if (liveBuffer.length === 0) {
            phase = 'live'
            break
          }
          const batch = liveBuffer.splice(0)
          for (const frame of batch) {
            if (frame.sequenceID > lastServed) pushWrite(frame)
          }
          await writeChain
        }
      } catch (error) {
        // A synchronous drain error (e.g. store.fetch threw): clean up and reject the handler.
        tornDown = true
        if (receiveToken != null) registry.releaseReceiveWriter(clientDID, receiveToken)
        registry.unregisterIfIdle(clientDID)
        reader.cancel().catch(() => {})
        writer.abort(error).catch(() => {})
        throw error
      }

      // Ack loop (M1): a store.ack failure must not stop later acks; only a reader error closes.
      void (async () => {
        while (true) {
          let result: { done: boolean; value?: { ack?: Array<string> } }
          try {
            result = await reader.read()
          } catch {
            break
          }
          if (result.done) break
          const ack = result.value?.ack
          if (ack != null) {
            try {
              await store.ack({ recipientDID: clientDID, sequenceIDs: ack })
            } catch {
              // Frame stays pending; the client re-acks next round. Do NOT break.
            }
          }
        }
      })()

      // H2: an already-aborted signal never fires 'abort', so run teardown now.
      if (ctx.signal.aborted) {
        finish()
        return done
      }
      void evictedHere.then(finish)
      ctx.signal.addEventListener('abort', finish, { once: true })
      return done
    }) as ChannelHandler<HubProtocol, 'hub/v1/receive'>,

    'hub/v1/keypackage/upload': (async (ctx) => {
      const { keyPackages } = ctx.param
      const clientDID = getClientDID(ctx)
      const decision = normalizeAuthorizeDecision(
        await authorize({ action: 'keypackage/upload', did: clientDID, count: keyPackages.length }),
      )
      if (!decision.allow) {
        throw new HandlerError({
          code: HUB_ERROR_CODES.authorizationDenied,
          message: decision.reason ?? 'Not authorized to upload key packages',
        })
      }
      if (!didLimiter.tryConsume(clientDID)) {
        throw new HandlerError({
          code: 'EK01',
          message: 'Key package upload rate limit exceeded for DID',
        })
      }
      // A batch that crosses the per-DID cap mid-way commits the packages before the cap and rejects
      // the rest with HUB_KEYPACKAGE_QUOTA — Promise.all doesn't undo the ones that already
      // resolved. The cap is still never exceeded (the store enforces it per-call), and a retrying
      // client simply finds the earlier packages already stored. Cosmetic partial-store, documented
      // not fixed.
      try {
        await Promise.all(keyPackages.map((kp: string) => store.storeKeyPackage(clientDID, kp)))
      } catch (error) {
        rethrowAsHandlerError(error)
      }
      return { stored: keyPackages.length }
    }) as RequestHandler<HubProtocol, 'hub/v1/keypackage/upload'>,

    'hub/v1/keypackage/fetch': (async (ctx) => {
      const requesterDID = getClientDID(ctx)
      const { did: targetDID, count } = ctx.param
      const cappedCount = Math.min(Math.max(count ?? 1, 1), fetchLimits.maxCount)
      const decision = normalizeAuthorizeDecision(
        await authorize({
          action: 'keypackage/fetch',
          did: requesterDID,
          targetDID,
          count: cappedCount,
        }),
      )
      if (!decision.allow) {
        throw new HandlerError({
          code: HUB_ERROR_CODES.authorizationDenied,
          message: decision.reason ?? 'Not authorized to fetch key packages',
        })
      }
      // Ordering: authorize first (a refusal must never consume rate budget), then the
      // per-requester window, then the per-target window. Both quota errors are translated to
      // their wire code via rethrowAsHandlerError (KeyPackageFetchLimitError has no `code` of its
      // own — hubErrorCodeOf is what maps the class to HUB_ERROR_CODES.keyPackageFetchLimit).
      try {
        assertKeyPackageFetchAllowed(requesterDID)
        assertTargetConsumptionAllowed(targetDID, cappedCount)
      } catch (error) {
        rethrowAsHandlerError(error)
      }
      const keyPackages = await store.fetchKeyPackages(targetDID, cappedCount)
      return { keyPackages }
    }) as RequestHandler<HubProtocol, 'hub/v1/keypackage/fetch'>,
  }
}
