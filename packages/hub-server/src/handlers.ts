import {
  type ChannelHandler,
  HandlerError,
  type ProcedureHandlers,
  type RequestHandler,
} from '@enkaku/server'
import type { HubProtocol, HubStore, StoredMessage } from '@kumiai/hub-protocol'
import { hubErrorCodeOf } from '@kumiai/hub-protocol'
import { fromB64, toB64 } from '@sozai/codec'

import { createRateLimiter, type RateLimitConfig } from './rateLimit.js'
import type { HubClientRegistry } from './registry.js'

/**
 * A single request to authorize. All six variants are always present, even though only
 * `publish` and `subscribe` are currently enforced by the handlers below: the union itself is
 * the exhaustive-switch surface a host's own `switch (req.action)` closes over, so adding a
 * seventh variant later is precisely the compatibility break this type exists to avoid.
 *
 * A host's `switch` need not handle every action today — an action it does not recognize should
 * default to allow, so a hook written before a new variant shipped does not silently start
 * refusing a procedure that was previously ungated.
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
 * the enforcement layer that has not been built yet: a hook may return them, and both are
 * silently dropped before the refusal reaches the client. They ship now rather than later
 * because widening this union is the break the surface exists to avoid — but until enforcement
 * lands, do not depend on either reaching a caller.
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
  /** Rate-limit window duration in milliseconds. Default: 60000 (1 min) */
  windowMs: number
}

export const DEFAULT_KEYPACKAGE_FETCH_LIMITS: KeyPackageFetchLimits = {
  maxCount: 10,
  maxRequests: 30,
  windowMs: 60_000,
}

export type CreateHandlersParams = {
  registry: HubClientRegistry
  store: HubStore
  authorize?: AuthorizeHook
  rateLimits?: Partial<HubRateLimits>
  keyPackageFetchLimits?: Partial<KeyPackageFetchLimits>
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

export function createHandlers(params: CreateHandlersParams): ProcedureHandlers<HubProtocol> {
  const { store, registry } = params
  const authorize: AuthorizeHook = params.authorize ?? (() => true)
  const rateLimits: HubRateLimits = {
    perDID: { ...DEFAULT_RATE_LIMITS.perDID, ...params.rateLimits?.perDID },
    perTopic: { ...DEFAULT_RATE_LIMITS.perTopic, ...params.rateLimits?.perTopic },
  }
  const didLimiter = createRateLimiter(rateLimits.perDID)
  const topicLimiter = createRateLimiter(rateLimits.perTopic)

  const fetchLimits: KeyPackageFetchLimits = {
    ...DEFAULT_KEYPACKAGE_FETCH_LIMITS,
    ...params.keyPackageFetchLimits,
  }
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
      throw new Error('Key package fetch rate limit exceeded')
    }
    window.count++
  }

  return {
    'hub/v1/publish': (async (ctx) => {
      const { topicID, payload } = ctx.param
      const senderDID = getClientDID(ctx)
      // `payloadBytes` is computed before the authorize call (rather than after, as before) so the
      // hook can see the decoded size. Decoding is pure, but moving it earlier is NOT free, and
      // two consequences are deliberate rather than overlooked:
      //
      //   - `fromB64` THROWS on malformed base64, so a caller who is both unauthorized and sending
      //     junk now gets that uncoded decoder error instead of `EK02 Not authorized`. Malformed
      //     input is answered before authorization, which leaks nothing about the topic — the
      //     decode cannot tell whether the caller was authorized — but it does mean EK02 is not
      //     the only answer an unauthorized publish can get.
      //   - the decode also runs before both rate limiters below, so a flood of oversized payloads
      //     is decoded before it is throttled. Bounded by the transport's own message limit.
      //
      // The alternative — decode after the limiters and hand the hook a size computed arithmetically
      // from the base64 length — was rejected: it re-derives `@sozai/codec`'s notion of a valid
      // encoding (it trims surrounding whitespace and accepts optional padding), and a size that
      // drifts from the real decoded length is handed to a hook that may enforce a size cap. A
      // wrong number in the authorization path is worse than either cost above.
      //
      // `retain` defaults to 'mailbox' when absent, matching the same default
      // the store applies below (`params.retain ?? 'mailbox'` in memoryStore.ts) — the hook must
      // never see an absent retain, since `AuthorizeRequest`'s `publish` variant declares it required.
      const payloadBytes = fromB64(payload)
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

      // A deduped publish appended nothing: the frame was already accepted, already fanned out to
      // whoever was subscribed then, and its sequenceID may since have been acked and its delivery
      // row removed. Re-running the loop would push a frame every current subscriber has already
      // applied, named by a dead sequenceID. Live fan-out is for a genuine append only.
      if (!deduped) {
        // The frame's place in the topic's LOG travels with the push, and only when there is one.
        // A pushed frame otherwise names only a place in the recipient's delivery queue, and a
        // recipient holding a durable log cursor cannot get from one to the other. The store minted
        // this sequenceID for an accepted append, so for a log-class publish it IS the log position;
        // a mailbox publish has none and carries none.
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
          code: 'EK02',
          message: decision.reason ?? 'Not authorized to subscribe to topic',
        })
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
      // The subscriber is the authenticated caller, taken from the verified issuer of the signed
      // message — never a wire field, or any member could read a topic's log by naming another.
      const subscriberDID = getClientDID(ctx)
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
      await store.unsubscribe(clientDID, topicID)
      return { unsubscribed: true }
    }) as RequestHandler<HubProtocol, 'hub/v1/unsubscribe'>,

    'hub/v1/receive': (async (ctx) => {
      const clientDID = getClientDID(ctx)
      const { after } = ctx.param ?? {}

      registry.register(clientDID)

      const writer = ctx.writable.getWriter()
      const reader = ctx.readable.getReader()

      // Ends this channel when a NEWER one for the same DID takes the lane. Resolved rather than
      // thrown: being replaced is not this channel's error, and the client that replaced it is
      // the same client.
      let endEvicted: (() => void) | undefined
      const evictedHere = new Promise<void>((resolve) => {
        endEvicted = resolve
      })
      let receiveToken: symbol | undefined

      try {
        // Binding EVICTS whatever held the lane. A reconnect happens because the old connection
        // broke, and the server learns that last — so the stale writer must give way to the live
        // one rather than the other way round. See `HubClientRegistry.bindReceiveWriter`.
        const { token, evicted } = registry.bindReceiveWriter(
          clientDID,
          (message: StoredMessage) => {
            writer
              .write({
                sequenceID: message.sequenceID,
                senderDID: message.senderDID,
                topicID: message.topicID,
                payload: toB64(message.payload),
                // Spread, never a plain assignment: `logPosition: undefined` on a mailbox frame is
                // a present key with a falsy value once it is off the wire, and the whole point of
                // the field is that a reader can tell "no place in any log" from a place.
                ...(message.logPosition != null ? { logPosition: message.logPosition } : {}),
              })
              .catch(() => {})
          },
          () => endEvicted?.(),
        )
        receiveToken = token
        // After the bind, so the lane is never unheld between the two: a frame arriving in that
        // window would have nowhere to go, and mailbox frames are dropped when nobody is there.
        evicted?.()

        let cursor: string | null | undefined = after
        while (true) {
          const result = await store.fetch({
            recipientDID: clientDID,
            after: cursor ?? undefined,
            limit: 50,
          })
          for (const msg of result.messages) {
            await writer.write({
              sequenceID: msg.sequenceID,
              senderDID: msg.senderDID,
              topicID: msg.topicID,
              payload: toB64(msg.payload),
              ...(msg.logPosition != null ? { logPosition: msg.logPosition } : {}),
            })
          }
          cursor = result.cursor
          if (!result.hasMore) break
        }
      } catch (error) {
        if (receiveToken != null) registry.releaseReceiveWriter(clientDID, receiveToken)
        registry.unregisterIfIdle(clientDID)
        reader.cancel().catch(() => {})
        writer.abort(error).catch(() => {})
        throw error
      }
      const token = receiveToken

      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (value?.ack != null) {
              await store.ack({ recipientDID: clientDID, sequenceIDs: value.ack })
            }
          }
        } catch {
          // Channel closed
        }
      })()

      return new Promise((resolve) => {
        const finish = (): void => {
          // Token-scoped, so a channel that has already been evicted cannot unbind the one that
          // replaced it on its way out.
          if (token != null) registry.releaseReceiveWriter(clientDID, token)
          registry.unregisterIfIdle(clientDID)
          reader.cancel().catch(() => {})
          writer.close().catch(() => {})
          resolve(undefined as never)
        }
        // Evicted by a newer channel: end this one, and let the successor keep the binding it
        // took — `finish` releases only its own token, and this channel's is no longer current.
        void evictedHere.then(finish)
        ctx.signal.addEventListener('abort', finish, { once: true })
      })
    }) as ChannelHandler<HubProtocol, 'hub/v1/receive'>,

    'hub/v1/keypackage/upload': (async (ctx) => {
      const { keyPackages } = ctx.param
      const clientDID = getClientDID(ctx)
      await Promise.all(keyPackages.map((kp: string) => store.storeKeyPackage(clientDID, kp)))
      return { stored: keyPackages.length }
    }) as RequestHandler<HubProtocol, 'hub/v1/keypackage/upload'>,

    'hub/v1/keypackage/fetch': (async (ctx) => {
      const requesterDID = getClientDID(ctx)
      assertKeyPackageFetchAllowed(requesterDID)
      const { did, count } = ctx.param
      const cappedCount = Math.min(Math.max(count ?? 1, 1), fetchLimits.maxCount)
      const keyPackages = await store.fetchKeyPackages(did, cappedCount)
      return { keyPackages }
    }) as RequestHandler<HubProtocol, 'hub/v1/keypackage/fetch'>,
  }
}
