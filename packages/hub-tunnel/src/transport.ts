import { Transport, type TransportType } from '@enkaku/transport'
import type { StoredMessage } from '@kumiai/hub-protocol'
import { AbortInterruption, TimeoutInterruption } from '@sozai/async'
import type { EventEmitter } from '@sozai/event'

import {
  BackpressureError,
  FrameDecodeError,
  HubReconnectingError,
  SessionNotEstablishedError,
} from './errors.js'
import type { ObservabilityEventListener } from './events.js'
import { decodeFrame, encodeFrame, type HubFrame } from './frame.js'

export type HubReceiveSubscription = AsyncIterable<StoredMessage> & {
  return?: () => void
  /**
   * Acknowledge a delivered message as durably handled, so the hub stops
   * redelivering it on reconnect. Optional: a live/in-memory transport that
   * never redelivers can omit it. A durable transport coalesces acks (batching)
   * below this contract.
   */
  ack?: (sequenceID: string) => void | Promise<void>
}

/**
 * Scope for a receive stream. Naming the topic lets a refcounted-ack hub know which consumers will
 * handle a frame — an unscoped stream is a candidate holder for every message on every topic.
 * Optional, and a hub is free to ignore it: the consumer still filters what it is handed.
 */
export type HubReceiveOptions = {
  topicID?: string
}

export type MailboxHubEvent =
  | { type: 'reconnecting' }
  | { type: 'connected' }
  | { type: 'disconnected' }

export type MailboxHubEvents = EventEmitter<{ status: MailboxHubEvent }>

/**
 * A mailbox-class publish — the only kind a {@link MailboxHub} accepts. No retention class, no
 * compare-and-set, no idempotency key: the lanes a MailboxHub fronts (directed tunnel, encrypting
 * wrapper, session hub) carry app traffic never CAS'd against a log head. Keeping those fields OFF
 * this type makes the restriction structural — a caller cannot hand a conditional publish to a
 * mailbox lane, so a wrapper fronting one has nothing to silently drop. A lane that needs the CAS
 * uses a {@link LogHub} instead.
 */
export type MailboxPublishParams = {
  senderDID: string
  topicID: string
  payload: Uint8Array
}

export type HubPublishParams = MailboxPublishParams & {
  /**
   * Retention class. 'mailbox' (default): removed once every delivery is acked, or when it ages
   * out. 'log': retained unconditionally, removed only by trim (a subscriber that must read it may
   * not exist when it is published). Only a 'log' publish moves the topic's head.
   */
  retain?: 'log' | 'mailbox'
  /**
   * Compare-and-set on the topic's head. Absent: append unconditionally. Present: append only if
   * the head is exactly this value, where `null` means "the topic has never had an accepted log
   * publish". A loser gets HeadMismatchError and nothing is stored (no entry, no delivery, no
   * sequenceID consumed).
   *
   * `null` and absent are different requests: a forwarding implementation must check for the key,
   * not for a non-null value.
   */
  expectedHead?: string | null
  /**
   * Idempotency key. Republishing an already-accepted `publishID` returns its original sequenceID
   * and appends nothing — letting a peer that crashed between publishing a commit and recording
   * the outcome ask "did my publish land?" with no responder or network peer involved.
   */
  publishID?: string
}

export type HubSubscribeOptions = {
  /**
   * Requested retention in seconds for this subscriber's view. Absent: the hub's default. Above
   * the hub's maximum the subscribe is refused, never clamped — a silent downgrade strands a peer
   * that believed it had asked for more.
   */
  retention?: number
}

export type HubFetchTopicParams = {
  subscriberDID: string
  topicID: string
  /** Exclusive cursor: entries after this sequenceID. Absent: from the oldest retained. */
  after?: string
  limit?: number
}

export type HubFetchTopicResult = {
  messages: Array<StoredMessage>
  /** The sequenceID of the last accepted log publish, or null. Survives a trim. */
  head: string | null
  /** The oldest sequenceID still retained, or null if the log is empty. */
  oldest: string | null
}

/**
 * The APIs both hub kinds share — everything except how you publish. `events` are
 * connection-lifecycle (reconnect/connect/disconnect), emitted by a mailbox and a log hub alike, so
 * they belong here rather than on either shape. {@link MailboxHub} and {@link LogHub} each add their
 * own `publish` on top; neither is derived from the other.
 */
export type HubBase = {
  subscribe: (
    subscriberDID: string,
    topicID: string,
    options?: HubSubscribeOptions,
  ) => Promise<void> | void
  unsubscribe?: (subscriberDID: string, topicID: string) => Promise<void> | void
  receive: (subscriberDID: string, options?: HubReceiveOptions) => HubReceiveSubscription
  readonly events?: MailboxHubEvents
}

/**
 * Publish and push-delivery over topics. A subscriber sees only what is published after it
 * subscribes — no history to read.
 *
 * The shape of the adapter views over a hub (directed tunnel, session hub, encrypting wrapper) and
 * of a hub used for mailbox traffic alone. A lane that must be readable by a peer not subscribed at
 * publish time needs a {@link LogHub} instead.
 */
export type MailboxHub = HubBase & {
  publish: (params: MailboxPublishParams) => Promise<{ sequenceID: string }>
}

/**
 * A hub that also retains a readable per-topic log. A pull-driven lane needs one: commits must be
 * readable by a peer not subscribed when they were published — a member invited tomorrow has to
 * apply commits that land today, which no push will bring it.
 *
 * Its `publish` widens the mailbox one to {@link HubPublishParams}: only through a LogHub can a
 * caller drive the CAS (`expectedHead`), pin a frame to the log (`retain: 'log'`), or carry an
 * idempotency key (`publishID`). A MailboxHub deliberately cannot.
 */
export type LogHub = HubBase & {
  publish: (params: HubPublishParams) => Promise<{ sequenceID: string }>
  fetchTopic: (params: HubFetchTopicParams) => Promise<HubFetchTopicResult>
}

export type HubTunnelSessionID = string | { auto: true }

export type HubTunnelTransportParams = {
  hub: MailboxHub
  sessionID: HubTunnelSessionID
  /**
   * The authenticated DID used to drain the receive stream (`hub.receive`) and
   * stamp published frames (`senderDID`). NOT a routing key — routing is by
   * `sendTopicID` / `receiveTopicID`.
   */
  localDID: string
  /** Topic this transport publishes its outbound frames to. */
  sendTopicID: string
  /** Topic this transport subscribes to and accepts inbound frames from. */
  receiveTopicID: string
  inboxCapacity?: number
  idleTimeoutMs?: number
  reconnectTimeoutMs?: number
  signal?: AbortSignal
  onEvent?: ObservabilityEventListener
  /**
   * Fired exactly once when the peer signals graceful end-of-session via the
   * `session-end` frame kind. Non-error path — `teardown(error)` paths emit
   * through `onEvent` instead.
   */
  onSessionEnd?: () => void
}

const DEFAULT_INBOX_CAPACITY = 1024

/**
 * Build a hub-tunnel transport over the pub/sub hub API. The returned `TransportType` subscribes
 * to `receiveTopicID`, reads a single inbox subscription filtered to that topic, and writes via
 * `hub.publish` on `sendTopicID`.
 *
 * **Contract (relied on by callers):**
 * - `hub.subscribe(localDID, receiveTopicID)` and `hub.receive(localDID)` are each called
 *   **exactly once** during construction. `hub.subscribe` is invoked synchronously (before
 *   `hub.receive`); its completion is captured, not awaited, so construction never blocks on it.
 * - The first `write` (and any write still in flight when the subscribe is still in flight) gates
 *   on that subscribe completing before it publishes, so a caller that constructs a transport and
 *   immediately writes does not lose an inbound reply that lands before the subscribe has landed.
 * - On any teardown path (signal abort, idle timeout, encrypt failure, peer-side `session-end`,
 *   manual `transport.dispose()`), it publishes a best-effort `session-end` frame to `sendTopicID`
 *   and best-effort `hub.unsubscribe?.(localDID, receiveTopicID)`, the latter ordered **after**
 *   the subscribe completes (never before it) so a subscribe that is still in flight at teardown
 *   cannot land after — and resurrect — the unsubscribe.
 */
export function createHubTunnelTransport<R, W>(
  params: HubTunnelTransportParams,
): TransportType<R, W> {
  const {
    hub,
    sessionID,
    localDID,
    sendTopicID,
    receiveTopicID,
    signal,
    idleTimeoutMs,
    reconnectTimeoutMs,
    onEvent,
    onSessionEnd,
  } = params
  const inboxCapacity = params.inboxCapacity ?? DEFAULT_INBOX_CAPACITY

  let lockedSessionID: string | null = typeof sessionID === 'string' ? sessionID : null

  let outboundSeq = 0
  let expectedSeq = 0
  // Async IIFE, not Promise.resolve(hub.subscribe(...)) (a sync throw would escape construction)
  // and not .then(() => hub.subscribe(...)) (would defer the call, reversing subscribe-before-
  // receive). `write` gates its first send on `subscribed`; a failed subscribe yields no inbound
  // frames but still lets sends proceed.
  const subscribed = (async () => {
    try {
      await hub.subscribe(localDID, receiveTopicID)
    } catch {
      // A failed subscribe yields no inbound frames; the send gate still proceeds.
    }
  })()
  const subscription = hub.receive(localDID, { topicID: receiveTopicID })
  const iterator = subscription[Symbol.asyncIterator]()

  let abortHandler: (() => void) | undefined
  let torndown = false
  let readableController: ReadableStreamDefaultController<R> | undefined
  let lastActivity = Date.now()
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let unsubscribeEvents: (() => void) | undefined

  const clearIdleTimer = (): void => {
    if (idleTimer != null) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
  }

  const clearReconnectTimer = (): void => {
    if (reconnectTimer != null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
  }

  const sendSessionEnd = (): void => {
    if (lockedSessionID == null) return
    const frame: HubFrame = {
      v: 1,
      sessionID: lockedSessionID,
      kind: 'session-end',
      seq: outboundSeq,
    }
    void hub
      .publish({
        senderDID: localDID,
        topicID: sendTopicID,
        payload: encodeFrame(frame),
      })
      .catch(() => {
        // ignore
      })
  }

  // Holds every teardown effect EXCEPT the voluntary-path extras (session-end frame, controller
  // error) — every teardown path (voluntary dispose, idle, abort, readable-pull error,
  // `result.done`, remote session-end) routes through this, not just `teardown`, so none of them
  // can bypass it and leak the reconnect timer / hub-status listener / abort listener / unsubscribe.
  const releaseResources = (): void => {
    if (torndown) return
    torndown = true
    clearIdleTimer()
    clearReconnectTimer()
    if (unsubscribeEvents != null) {
      try {
        unsubscribeEvents()
      } catch {
        // ignore
      }
      unsubscribeEvents = undefined
    }
    if (abortHandler != null && signal != null) {
      signal.removeEventListener('abort', abortHandler)
      abortHandler = undefined
    }
    // Ordered after `subscribed`: unsubscribing before an in-flight subscribe lands would have
    // the subscribe's later mutation resurrect a subscription this transport no longer wants.
    // `releaseResources` itself stays synchronous — only the unsubscribe is deferred.
    void subscribed.then(() => hub.unsubscribe?.(localDID, receiveTopicID)).catch(() => {})
    try {
      // Fire-and-forget: awaiting `return()` deadlocks on the real wire hub, where it waits behind
      // the drain loop's in-flight `next()` that never settles during teardown. No-op catch keeps a
      // late rejection off the unhandled-rejection path.
      const rawClose = iterator.return?.()
      if (rawClose != null) void Promise.resolve(rawClose).catch(() => {})
    } catch {
      // synchronous throw from `return()` — nothing more to release
    }
  }

  const teardown = (error?: unknown): void => {
    if (torndown) return
    releaseResources()
    sendSessionEnd()
    if (error !== undefined && readableController != null) {
      try {
        readableController.error(error)
      } catch {
        // already closed
      }
    }
  }

  const scheduleIdleTimer = (): void => {
    if (idleTimeoutMs == null || torndown) return
    clearIdleTimer()
    const elapsed = Date.now() - lastActivity
    const remaining = idleTimeoutMs - elapsed
    const delay = remaining > 0 ? remaining : 0
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      if (torndown) return
      const sinceActivity = Date.now() - lastActivity
      if (sinceActivity >= idleTimeoutMs) {
        teardown(new TimeoutInterruption({ message: 'idle timeout' }))
      } else {
        scheduleIdleTimer()
      }
    }, delay)
  }

  const markActivity = (): void => {
    lastActivity = Date.now()
  }

  // A hub's ack may be synchronous and throw synchronously, before `Promise.resolve` sees it — so
  // the rejection guard alone is not enough (same fix as `ackUpstream` in rpc/src/hub-mux.ts). An
  // escape here would kill the pump's IIFE.
  const ackHandled = (sequenceID: string): void => {
    try {
      void Promise.resolve(subscription.ack?.(sequenceID)).catch(() => {})
    } catch {
      // ignore
    }
  }

  const readable = new ReadableStream<R>(
    {
      start(controller) {
        readableController = controller
        if (signal?.aborted === true) {
          teardown(new AbortInterruption({ cause: signal.reason }))
          return
        }
        scheduleIdleTimer()
        void (async () => {
          while (true) {
            let result: IteratorResult<StoredMessage>
            try {
              result = await iterator.next()
            } catch (error) {
              if (!torndown) {
                releaseResources()
                controller.error(error)
              }
              return
            }
            if (torndown) return
            if (result.done) {
              releaseResources()
              controller.close()
              return
            }
            const message = result.value
            // Every outcome below is HANDLED (enqueued, filtered, deduped, undecodable, session-end)
            // except the two teardown branches — backpressure overflow and a non-FrameDecodeError
            // decode — which flip this false: the frame never reached the consumer, so acking would
            // report a lost frame as handled. The ack lives in the `finally` (one place, not one per
            // `continue`) so a new drop path can't skip it.
            let handled = true
            try {
              if (message.topicID !== receiveTopicID) {
                onEvent?.({ type: 'frame-dropped', reason: 'topic-mismatch' })
                continue
              }
              let frame: HubFrame
              try {
                frame = decodeFrame(message.payload)
              } catch (error) {
                if (error instanceof FrameDecodeError) continue
                handled = false
                teardown(error)
                return
              }
              if (lockedSessionID == null) {
                lockedSessionID = frame.sessionID
              } else if (frame.sessionID !== lockedSessionID) {
                onEvent?.({ type: 'frame-dropped', reason: 'session-mismatch' })
                continue
              }
              if (frame.kind === 'session-end') {
                // Before `releaseResources()` (which closes the iterator): a subscription whose
                // close abandons outstanding claims (hub-mux's mailbox facade does) can no longer
                // honour an ack afterwards.
                ackHandled(message.sequenceID)
                try {
                  controller.close()
                } catch {
                  // already closed
                }
                releaseResources()
                handled = false
                onSessionEnd?.()
                return
              }
              if (frame.kind !== 'message') {
                continue
              }
              if (frame.seq < expectedSeq) {
                onEvent?.({ type: 'frame-dropped', reason: 'dedup' })
                continue
              }
              const desired = controller.desiredSize
              if (desired != null && desired <= 0) {
                const err = new BackpressureError(
                  `Hub tunnel inbox overflow: capacity=${inboxCapacity} session=${lockedSessionID}`,
                )
                handled = false
                teardown(err)
                return
              }
              expectedSeq = frame.seq + 1
              markActivity()
              controller.enqueue(frame.body as R)
            } finally {
              if (handled) {
                ackHandled(message.sequenceID)
              }
            }
          }
        })()
      },
      cancel() {
        teardown()
      },
    },
    new CountQueuingStrategy({ highWaterMark: inboxCapacity }),
  )

  const writable = new WritableStream<W>({
    async write(value) {
      if (torndown) {
        throw new Error('Hub tunnel transport torn down')
      }
      if (lockedSessionID == null) {
        throw new SessionNotEstablishedError(
          'hub-tunnel: cannot send before session is established',
        )
      }
      await subscribed
      if (torndown) {
        throw new Error('Hub tunnel transport torn down')
      }
      const frame: HubFrame = {
        v: 1,
        sessionID: lockedSessionID,
        kind: 'message',
        seq: outboundSeq++,
        body: value as unknown as Extract<HubFrame, { kind: 'message' }>['body'],
      }
      await hub.publish({
        senderDID: localDID,
        topicID: sendTopicID,
        payload: encodeFrame(frame),
      })
      markActivity()
    },
    close() {
      teardown()
    },
    abort() {
      teardown()
    },
  })

  const transport = new Transport<R, W>({ stream: { readable, writable } })

  if (signal != null && signal.aborted !== true) {
    abortHandler = (): void => {
      teardown(new AbortInterruption({ cause: signal.reason }))
    }
    signal.addEventListener('abort', abortHandler, { once: true })
  }

  transport.events.on('disposed', () => {
    teardown()
  })

  if (!torndown && reconnectTimeoutMs != null && hub.events != null) {
    const armReconnectTimer = (): void => {
      if (torndown || reconnectTimer != null) return
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        if (torndown) return
        teardown(new HubReconnectingError('reconnect timeout exceeded'))
      }, reconnectTimeoutMs)
    }
    unsubscribeEvents = hub.events.on('status', (event) => {
      if (torndown) return
      switch (event.type) {
        case 'reconnecting':
        case 'disconnected':
          armReconnectTimer()
          return
        case 'connected':
          clearReconnectTimer()
          return
      }
    })
  }

  return transport
}
