import type { ServerTransportOf } from '@enkaku/protocol'
import type { AccessRules, ReplayOptions, ResourceLimits, Server } from '@enkaku/server'
import { serve } from '@enkaku/server'
import type { VerifyTokenHook } from '@kokuin/capability'
import type { Identity } from '@kokuin/token'
import type { HubProtocol, HubStore, WakeRegistry, WakeSender } from '@kumiai/hub-protocol'
import { hubProtocol } from '@kumiai/hub-protocol'

import {
  type AuthorizeHook,
  createHandlers,
  createStoreErrorReporter,
  type HubRateLimits,
  type HubStoreErrorHook,
  type KeyPackageFetchLimits,
} from './handlers.js'
import { HubClientRegistry } from './registry.js'
import { createWakeDispatcher } from './wake.js'

/**
 * Default access rules: any authenticated DID may call hub procedures.
 * The hub is a blind relay — per-procedure authorization (the `authorize`
 * hook) happens in the handlers.
 */
export const DEFAULT_HUB_ACCESS_RULES: AccessRules = {
  'hub/*': { allow: true },
}

export type HubPurgeOptions = {
  /** Interval between purge runs in milliseconds. Default: 3600000 (1 hour) */
  interval?: number
  /**
   * The hub's default retention in seconds: the age bound applied to a topic no subscriber asked
   * to keep for longer. Default: 604800 (7 days). The maximum a subscriber may ask for is the
   * store's, since the store is the thing that refuses the subscribe.
   */
  olderThan?: number
}

/** Replay settings a host may tune. The hub always enables replay checks and rejects stale tokens. */
export type HubReplayOptions = Omit<ReplayOptions, 'enabled' | 'rejectStale'>

export type CreateHubParams = {
  transport: ServerTransportOf<HubProtocol>
  store: HubStore
  /**
   * Hub server identity. Required: all hub procedures derive the client DID
   * from the verified `iss` of signed messages.
   */
  identity: Identity
  /** Access rules enforced by the server. Defaults to {@link DEFAULT_HUB_ACCESS_RULES}. */
  accessRules?: AccessRules
  /** Omitted: per-process memory cache. Only a persistent `cache` survives a hub restart. */
  replay?: HubReplayOptions
  /**
   * Per-action authorization hook. Consulted for publish, subscribe, topic/fetch, keypackage/*,
   * wake/*, and receive — the coarse `receive` gate at channel open plus a per-frame
   * `receive/deliver` gate by topic (see {@link CreateHubParams.receiveAuthCacheTTL}). Defaults to
   * allow-any-authed.
   */
  authorize?: AuthorizeHook
  /**
   * Called for each capability in a delegation chain after it verifies; throw to reject. This is
   * where a host plugs in revocation. Forwarded to `serve()`, which only consults it for
   * delegated capabilities.
   */
  verifyToken?: VerifyTokenHook
  /** Publish rate limits. Merged over {@link DEFAULT_RATE_LIMITS}. */
  rateLimits?: Partial<HubRateLimits>
  /**
   * Quotas applied to hub/v1/keypackage/fetch. Merged over
   * {@link DEFAULT_KEYPACKAGE_FETCH_LIMITS}.
   */
  keyPackageFetchLimits?: Partial<KeyPackageFetchLimits>
  /**
   * TTL (ms) for the per-(did, topicID) receive delivery-authorization cache. `0` consults the
   * hook for every frame. Forwarded to {@link createHandlers}. Default: 5000.
   */
  receiveAuthCacheTTL?: number
  /**
   * Called when a `HubStore` operation fails where the hub deliberately does not fail the
   * request. Forwarded to {@link createHandlers} and used by the purge timer. Fire-and-forget.
   */
  onStoreError?: HubStoreErrorHook
  /** Scheduled purge of expired stored messages. Set to `false` to disable. */
  purge?: HubPurgeOptions | false
  /**
   * Server resource limits. `hub/v1/receive` is always added to
   * `longLivedProcedures` so open mailbox channels are exempt from
   * `controllerTimeoutMs` and from the `maxConcurrentHandlers` cap.
   */
  limits?: Partial<ResourceLimits>
  /**
   * Wake notifications. Absent: `hub/v1/wake/*` refuse with `WakeNotSupportedError` — refusing is
   * the only honest answer, since accepting a registration the hub will never act on leaves the
   * device believing it is reachable.
   */
  wake?: {
    registry: WakeRegistry
    sender: WakeSender
    /** Coalescing window in milliseconds. Default: 10 000. */
    debounceMs?: number
  }
}

export type HubInstance = {
  registry: HubClientRegistry
  server: Server<HubProtocol>
  /**
   * Stops the purge timer, waits for an in-flight purge and in-flight wake sends, then disposes the
   * server. Idempotent: every call returns the same promise.
   */
  dispose(): Promise<void>
}

export function createHub(params: CreateHubParams): HubInstance {
  const registry = new HubClientRegistry()
  // One reporter for the whole hub. Its type IS `HubStoreErrorHook`, so `createHandlers`' own
  // wrapper delegates to this instance rather than building a second one from the same hook —
  // which matters the moment a reporter holds state, as the throttling the README names would.
  const storeErrorReporter = createStoreErrorReporter(params.onStoreError)
  const wakeDispatcher =
    params.wake == null
      ? undefined
      : createWakeDispatcher({
          registry: params.wake.registry,
          sender: params.wake.sender,
          debounceMs: params.wake.debounceMs,
          onError: ({ did, error }) => storeErrorReporter({ method: 'wake', did, error }),
        })
  const handlers = createHandlers({
    registry,
    store: params.store,
    authorize: params.authorize,
    rateLimits: params.rateLimits,
    keyPackageFetchLimits: params.keyPackageFetchLimits,
    receiveAuthCacheTTL: params.receiveAuthCacheTTL,
    onStoreError: storeErrorReporter,
    wake:
      params.wake == null
        ? undefined
        : { registry: params.wake.registry, dispatcher: wakeDispatcher },
  })
  const limits: Partial<ResourceLimits> = {
    ...params.limits,
    longLivedProcedures: [
      ...new Set([...(params.limits?.longLivedProcedures ?? []), 'hub/v1/receive']),
    ],
  }
  const server = serve<HubProtocol>({
    handlers,
    protocol: hubProtocol,
    transport: params.transport,
    identity: params.identity,
    accessRules: params.accessRules ?? DEFAULT_HUB_ACCESS_RULES,
    verifyToken: params.verifyToken,
    replay: { ...params.replay, enabled: true, rejectStale: true },
    limits,
  })
  let purgeTimer: ReturnType<typeof setInterval> | undefined
  let purgeInFlight: Promise<void> | undefined
  if (params.purge !== false) {
    const interval = params.purge?.interval ?? 3_600_000
    const olderThan = params.purge?.olderThan ?? 604_800
    purgeTimer = setInterval(() => {
      const run = params.store
        .purge({ olderThan })
        .then(() => {})
        .catch((error: unknown) => {
          // Purge failures are non-fatal; retried on the next interval
          storeErrorReporter({ method: 'purge', error })
        })
      purgeInFlight = run
      void run.finally(() => {
        if (purgeInFlight === run) purgeInFlight = undefined
      })
    }, interval)
  }

  // Stop background work first so nothing new starts, then drain what already did, then the server.
  let teardown: Promise<void> | undefined
  function stopBackground(): Promise<void> {
    teardown ??= (async () => {
      if (purgeTimer != null) clearInterval(purgeTimer)
      await purgeInFlight
      await wakeDispatcher?.dispose()
    })()
    return teardown
  }
  let disposing: Promise<void> | undefined
  function dispose(): Promise<void> {
    disposing ??= (async () => {
      await stopBackground()
      await server.dispose()
    })()
    return disposing
  }
  // Disposing the server directly must still stop purge and wake.
  void server.disposed.then(stopBackground)
  return { registry, server, dispose }
}
