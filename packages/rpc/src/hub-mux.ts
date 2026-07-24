import type { BroadcastBus } from '@kumiai/broadcast'
import { RetentionExceededError, type StoredMessage } from '@kumiai/hub-protocol'
import type {
  HubFetchTopicResult,
  HubReceiveSubscription,
  HubSubscribeOptions,
  LogHub,
  MailboxHub,
} from '@kumiai/hub-tunnel'
import { getLogger, isSetup } from '@sozai/log'

import { asDeliveryPosition, type DeliveryPosition } from './cursor.js'

/**
 * A subscribe the hub refused for good — either a permanent refusal (it has answered, and the
 * answer will not change) or a transient one the retry schedule ran out on. Either way this peer
 * is NOT a subscriber of `topicID`: nothing is pushed to it there and it cannot pull it.
 */
export type SubscribeFailure = {
  topicID: string
  error: unknown
  /**
   * True when the hub settled it (e.g. RetentionExceededError) and no retry was attempted; false
   * when it was retried to the end of the schedule and never succeeded.
   */
  permanent: boolean
}

/**
 * Backoff for a TRANSIENT subscribe failure, in ms. Short enough that an ordinary reconnect blip
 * heals before the first lane operation, bounded so a hub that is answering "no" in a shape this
 * code cannot classify is not asked forever.
 */
const DEFAULT_SUBSCRIBE_RETRY_DELAYS_MS: ReadonlyArray<number> = [100, 500, 2_000, 10_000]

/** 60s: far above any real local handling time, far below the store's 30-day age bound. */
const DEFAULT_ACK_TTL_MS = 60_000

/**
 * The push lane has ended, and it will not restart on its own.
 *
 * `receive` is one long-lived channel and this mux drains it once. When it ends — the hub refused
 * it, the connection died, the server replaced it with a newer one for the same DID — nothing
 * downstream is told: every listener simply stops being called, and a peer that is only READING
 * looks identical to a peer whose group has gone quiet. That silence is the defect. The host owns
 * the connection, so the host is the only thing that can reconnect it; this is how it finds out
 * it has to.
 */
export type ReceiveLaneEnded = {
  /** What the drain threw, or `undefined` when the channel simply ended. */
  error?: unknown
}

/**
 * The logger these fall back to. `['kumiai', 'rpc']` — an app routing this category sees them
 * with everything else it collects.
 */
const logger = getLogger(['kumiai', 'rpc'])

/**
 * Fallback when a host wires no handler: both conditions leave a peer that looks healthy but
 * silently receives nothing. At ERROR level, not warn — `@sozai/log`'s default config drops `warn`.
 * Falls back to console when logging is unconfigured (logtape discards records otherwise).
 *
 * KNOWN GAP (`docs/agents/plans/next/2026-07-19-logging-reaches-a-sink.md`): `isSetup()` reports
 * whether logging is configured, not whether THIS category reaches a sink, so a `setup()` covering
 * only `['sozai']` drops these while the console fallback stays quiet.
 */
const report = (message: string, error: unknown): void => {
  if (isSetup()) {
    logger.error(message, { error })
    return
  }
  // Last resort: no logging configured, so the app has nowhere to collect this.
  console.error(`[@kumiai/rpc] ${message}`, error)
}

const warnSubscribeFailed = (failure: SubscribeFailure): void => {
  report(
    `hub refused the subscription to ${failure.topicID}` +
      `${failure.permanent ? ' (permanently)' : ' (after exhausting retries)'}. ` +
      'This peer receives nothing on that topic and cannot pull it; every publish and fetch on ' +
      'it now throws. Wire `onSubscribeFailed` to handle this.',
    failure.error,
  )
}

const warnReceiveEnded = (ended: ReceiveLaneEnded): void => {
  report(
    'the hub push lane ended and will not restart on its own. This peer will receive nothing ' +
      'further — no error, and every call keeps succeeding — until the host reconnects and ' +
      'builds a new peer. Wire `onReceiveEnded` to handle this.',
    ended.error,
  )
}

export type HubMuxParams = {
  /** The real hub. It must serve a log: the commit lane reads one. */
  hub: LogHub
  /** Authenticated DID used to drain `hub.receive` and stamp bus publishes. */
  localDID: string
  /**
   * Called once per topic the hub has definitively refused. A NOTICE, not the enforcement: the
   * enforcement is that every publish and fetch on a refused topic throws (see
   * {@link createHubMux}). This exists because a peer that only READS a topic calls nothing that
   * could throw, so without it a pure consumer would sit silent — which is the whole defect.
   *
   * Fire-and-forget; a throw here is swallowed rather than allowed to kill the retry path.
   *
   * Omitted, the failure is warned to the console instead of passing silently — see
   * {@link warnSubscribeFailed}. Pass an empty handler to silence it deliberately.
   */
  onSubscribeFailed?: (failure: SubscribeFailure) => void
  /**
   * Called once when the push lane ends, for any reason. See {@link ReceiveLaneEnded}. Not called
   * on `dispose` — an ending the caller asked for is not news.
   *
   * Fire-and-forget: a throw here is swallowed rather than allowed to escape into the drain.
   *
   * Omitted, the condition is warned to the console instead of passing silently — see
   * {@link warnReceiveEnded}. Pass an empty handler to silence it deliberately.
   */
  onReceiveEnded?: (ended: ReceiveLaneEnded) => void
  /** Backoff schedule for transient subscribe failures. Default {@link DEFAULT_SUBSCRIBE_RETRY_DELAYS_MS}. */
  subscribeRetryDelaysMs?: ReadonlyArray<number>
  /**
   * How long a delivered message waits for its holders to ack before the claim is dropped.
   * Default {@link DEFAULT_ACK_TTL_MS}. Expiry drops the claim WITHOUT acking — acking a frame no
   * holder handled would be a false success; the hub's age bound reclaims it. Internal: not
   * surfaced on `GroupPeerParams`, wired only for this package's tests.
   */
  ackTTLMs?: number
}

/**
 * An onInbound listener. `ack` marks the message durably handled so a durable
 * hub stops redelivering it; a listener that does not need the durability gate
 * (e.g. an idempotent app consumer) may ignore it.
 */
export type InboundListener = (message: StoredMessage, ack: () => void) => void

export type MuxPublishParams = {
  topicID: string
  payload: Uint8Array
  /** Retention class. Absent: 'mailbox'. Only a 'log' publish moves the topic's head. */
  retain?: 'log' | 'mailbox'
  /**
   * Compare-and-set on the topic's head. Absent: append unconditionally. `null`: append
   * only while the topic has never had a log publish. A loser gets HeadMismatchError and
   * the store is left exactly as it was found.
   */
  expectedHead?: string | null
  /** Idempotency key: a republish of an accepted one returns its sequenceID and appends nothing. */
  publishID?: string
}

export type MuxFetchTopicParams = {
  topicID: string
  /** Exclusive cursor: entries after this log position. Absent: from the oldest retained. */
  after?: string
  limit?: number
}

export type HubMux = {
  readonly bus: BroadcastBus
  /** A mailbox-shaped view of the drain, for the directed tunnels. It carries no log. */
  readonly mailbox: MailboxHub
  publish: (params: MuxPublishParams) => Promise<{ sequenceID: string }>
  /**
   * Subscribe the local DID to a topic with NO listener, and never release it. The hub gates a
   * topic fetch on the caller's own subscription, so a reader that only wants to PULL a topic
   * still has to be a subscriber of it — and it is also what asks the hub to hold the log.
   *
   * Not paired with a release, deliberately: an app topic is subscribed for the member's whole
   * life (a rotation tears down listeners, never subscriptions), so there is no later moment
   * this could correctly be undone at. Idempotent over a topic that is HELD or being asked for —
   * that one is not re-subscribed, so `options` are the FIRST caller's. A topic the hub REFUSED
   * is not held, so a later retain asks again, carrying its own `options`.
   */
  retainTopic: (topicID: string, options?: HubSubscribeOptions) => void
  /** Pull a topic's log as the local DID. */
  fetchTopic: (params: MuxFetchTopicParams) => Promise<HubFetchTopicResult>
  onInbound: (
    topicID: string,
    listener: InboundListener,
    options?: HubSubscribeOptions,
  ) => () => void
  /**
   * Stop the drain and drop every local listener. It does NOT unsubscribe: see the note on
   * {@link createHubMux}. The member stays a subscriber of everything it was subscribed to,
   * and the hub keeps holding its mail.
   */
  dispose: () => Promise<void>
}

type Sink = {
  push: (message: StoredMessage) => void
  close: () => void
  /** The topic this sink reads, when it named one. Absent: it takes every message. */
  topicID?: string
}

// `symbol` admits the drain's own claim as a distinct holder identity.
type Holder = InboundListener | Sink | symbol

/**
 * Holders of one delivered message that have not yet released it. A SET OF IDENTITIES, never a
 * counter (mirrors `LogEntry.pendingFor` in `hub-server/src/memoryStore.ts`): a double-ack is a
 * no-op, where a counter would reach zero and free a frame other holders still hold.
 */
type PendingAck = {
  holders: Set<Holder>
  position: DeliveryPosition
  claimedAt: number
}

/**
 * The state of the SUBSCRIPTION at the hub, per topic — deliberately NOT the refcount, which
 * counts local listeners. Conflating the two is the defect this replaces: a listener registration
 * bumped the count, the count gated the subscribe, and a REFUSED subscribe left behind a count
 * saying "held" about a topic the hub had said no to. Nothing ever asked again, and every later
 * fetch of that topic died of `NotSubscribedError` forever.
 *
 * `asking` covers the in-flight request AND the gaps between retries: a topic being asked for is
 * not asked for twice concurrently, but a topic that has been refused is not "held" and the next
 * retain is a fresh chance to ask.
 */
type TopicSubscription =
  | { kind: 'asking' }
  | { kind: 'held' }
  /**
   * `permanent` and `retention` together decide what a later retain may do. A refusal is a refusal
   * OF A REQUEST: only a different explicit request can be answered differently, so a permanent
   * refusal of `retention: N` is cleared by a retain asking for something other than N, and by
   * nothing else. A retry-exhausted failure carries no answer at all, so any retain re-asks.
   */
  | { kind: 'refused'; error: unknown; permanent: boolean; retention: number | undefined }

/**
 * Permanent means the hub has ANSWERED, not that it failed. A retention above the operator's cap
 * is a settled fact about this request: retrying it is a busy loop against an answer that will
 * never change, and the peer's only route out is the host changing what it asks for. Anything
 * else — a socket that dropped, a hub mid-restart — is assumed transient and retried, because the
 * cost of retrying a failure that was really permanent is a bounded schedule, while the cost of
 * NOT retrying one that was really transient is a peer that never comes back.
 */
function isPermanentSubscribeFailure(error: unknown): boolean {
  // Name as well as instance: a hub reached over the tunnel rebuilds the error from its wire code
  // (`hubErrorFromCode`), and a host bundling two copies of hub-protocol would break `instanceof`
  // alone — turning a permanent refusal back into a retry loop, silently.
  return (
    error instanceof RetentionExceededError ||
    (error instanceof Error && error.name === 'RetentionExceededError')
  )
}

/**
 * Multiplex a single hub `receive` drain into a BroadcastBus view, a mailbox-hub view (for
 * directed tunnels), and an onInbound hook (for lazy directed-server accept).
 *
 * Per inbound message: (1) fire the topic's `onInbound` listeners, then (2) push to every matching
 * `mailbox.receive` sink (a sink naming no topic takes all; one naming a topic only that one).
 * Listeners run first so one can create a directed tunnel synchronously and still receive the
 * triggering frame. Topics are refcounted across all three views; the first registration subscribes.
 *
 * ## A subscribe the hub refuses
 *
 * The hub may refuse a subscribe (`RetentionExceededError`), leaving the peer unable to receive or
 * pull the topic. Retry answers a transient drop only; raising into `retainTopic` can't (it returns
 * before the hub answers, into callers that swallow); a host callback is optional and can't be the
 * guarantee. So the guarantee is a LATCH: a refused topic is recorded, and every `publish`,
 * `bus.publish`, `mailbox.publish` and `fetchTopic` on it throws the hub's own error rather than the
 * `NotSubscribedError` symptom — a refused peer cannot report itself healthy. `onSubscribeFailed` is
 * a convenience on top, for a pure reader that calls nothing that throws. A refused topic is not
 * held, so the next `retain` re-asks.
 *
 * **The refcount tracks LOCAL LISTENERS and never unsubscribes.** A subscription is a durable
 * member-topic relationship: the hub holds undelivered frames, and `unsubscribe` tells it to drop
 * them. So no local lifecycle event (dropping a listener, rotating an epoch, disposing) unsubscribes
 * — only an explicit leave-the-group would, and nothing here does. That outliving subscription is
 * what lets a returning member find its mail.
 *
 * ## The init-race window
 *
 * The drain starts synchronously in this constructor, before the caller registers the first
 * listener. A frame arriving in that window matches no holder, is left pending, and is pruned
 * unacked at the TTL — so it returns on the next reconnect rather than being lost. Acking it would
 * be the exact false success this relay exists to prevent. Options for closing the window itself:
 * `docs/agents/plans/backlog/2026-07-07-rpc-peer-lifecycle-hardening.md`.
 */
export function createHubMux(params: HubMuxParams): HubMux {
  const { hub, localDID } = params
  const onSubscribeFailed = params.onSubscribeFailed ?? warnSubscribeFailed
  const onReceiveEnded = params.onReceiveEnded ?? warnReceiveEnded
  const retryDelaysMs = params.subscribeRetryDelaysMs ?? DEFAULT_SUBSCRIBE_RETRY_DELAYS_MS
  const ackTTLMs = params.ackTTLMs ?? DEFAULT_ACK_TTL_MS

  const listeners = new Map<string, Set<InboundListener>>()
  const refcount = new Map<string, number>()
  const subscriptions = new Map<string, TopicSubscription>()
  const sinks = new Set<Sink>()
  let disposed = false

  /**
   * Retry backoffs currently sleeping, each as the function that ends its sleep early.
   *
   * A timer nobody can reach still holds the process open, so a `dispose` that only sets a flag
   * leaves the caller waiting out the longest backoff for work already abandoned. Cancelling ENDS
   * the sleep rather than dropping it: clearing the timeout alone would leave the awaiting retry
   * suspended on a promise that can never settle, trading a held timer for a leaked one.
   */
  const sleeping = new Set<() => void>()

  const sleep = (ms: number): Promise<void> => {
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer)
        sleeping.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, ms)
      sleeping.add(wake)
    })
  }

  const reportFailure = (failure: SubscribeFailure): void => {
    try {
      onSubscribeFailed?.(failure)
    } catch {
      // a host's notice handler must not break the mux
    }
  }

  /**
   * Ask the hub, once, and record what it said. Runs to the first `await` SYNCHRONOUSLY, so a hub
   * whose `subscribe` registers synchronously is registered by the time `retain` returns — the
   * subscribe-then-pull ordering the commit lane depends on is unchanged.
   */
  const attemptSubscribe = async (
    topicID: string,
    options: HubSubscribeOptions | undefined,
    attempt: number,
  ): Promise<void> => {
    subscriptions.set(topicID, { kind: 'asking' })
    try {
      // Inside the try, and awaited: `subscribe` may reject OR throw synchronously (the type
      // allows `void`), and the old code's `Promise.resolve(...).catch()` caught only the first.
      await hub.subscribe(localDID, topicID, options)
      if (disposed) return
      subscriptions.set(topicID, { kind: 'held' })
      return
    } catch (error) {
      if (disposed) return
      const permanent = isPermanentSubscribeFailure(error)
      const delay = retryDelaysMs[attempt]
      if (permanent || delay === undefined) {
        // The refusal is LATCHED, not just reported: see the note on `createHubMux` for why a
        // notice a host may not have wired cannot be the whole answer.
        subscriptions.set(topicID, {
          kind: 'refused',
          error,
          permanent,
          retention: options?.retention,
        })
        reportFailure({ topicID, error, permanent })
        return
      }
      await sleep(delay)
      if (disposed) return
      await attemptSubscribe(topicID, options, attempt + 1)
    }
  }

  const retain = (topicID: string, options?: HubSubscribeOptions): void => {
    refcount.set(topicID, (refcount.get(topicID) ?? 0) + 1)
    // Gated on the SUBSCRIPTION, never on the refcount. A topic held, or currently being asked
    // for, is not asked for again. A refused one may be: the hub said no, so this peer does not
    // hold it, and the data structure must not pretend otherwise.
    const state = subscriptions.get(topicID)
    if (state == null) {
      void attemptSubscribe(topicID, options, 0)
      return
    }
    if (state.kind !== 'refused') return
    // A PERMANENT refusal is an answer to a specific request, and is re-asked only under a
    // different one. In particular a retain carrying NO retention does not clear it: a caller with
    // no opinion about the window must not overrule the one that had an opinion and was refused —
    // subscribing anyway would land the peer on the hub's default and quietly deliver the silent
    // downgrade the hub refused to perform, which is worse than the refusal it replaces.
    //
    // A retry-exhausted failure carries no answer, so any retain re-asks.
    if (state.permanent && (options?.retention == null || options.retention === state.retention)) {
      return
    }
    void attemptSubscribe(topicID, options, 0)
  }

  /**
   * The enforcement half. A topic the hub refused is one this peer cannot read, so it does not go
   * on transmitting there as a full participant either: every publish and every fetch on it
   * rejects with the hub's own error.
   */
  const assertSubscribable = (topicID: string): void => {
    const state = subscriptions.get(topicID)
    if (state?.kind === 'refused') throw state.error
  }

  // Drops a local listener's reference, and NOTHING at the hub. The subscription stands: the
  // frames this member has been sent and not read are its own, and a caller that has merely
  // stopped listening has not read them.
  const release = (topicID: string): void => {
    const current = refcount.get(topicID) ?? 0
    if (current <= 0) return
    const next = current - 1
    if (next === 0) refcount.delete(topicID)
    else refcount.set(topicID, next)
  }

  const onInbound = (
    topicID: string,
    listener: InboundListener,
    options?: HubSubscribeOptions,
  ): (() => void) => {
    let set = listeners.get(topicID)
    if (set == null) {
      set = new Set()
      listeners.set(topicID, set)
    }
    set.add(listener)
    retain(topicID, options)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      const current = listeners.get(topicID)
      current?.delete(listener)
      if (current != null && current.size === 0) listeners.delete(topicID)
      release(topicID)
      // NOT dropped from any `pending` holder set (unlike `abandonSink`): the delivery-time ack
      // closure keys on `listener` identity and keeps working after unregister, so a caller may
      // still release a claim for a frame it already received.
    }
  }

  const subscription = hub.receive(localDID)
  const iterator = subscription[Symbol.asyncIterator]()

  const pending = new Map<string, PendingAck>()

  const ackUpstream = (position: DeliveryPosition): void => {
    // A hub's ack may be synchronous and throw synchronously, before `Promise.resolve` sees it —
    // so the rejection guard alone is not enough. A throw escaping here reaches the holder's
    // release; on the serialized open-once chain that would skip the next frame's open.
    try {
      void Promise.resolve(subscription.ack?.(position)).catch(() => {})
    } catch {
      // ignore
    }
  }

  const releaseClaim = (sequenceID: string, holder: Holder): void => {
    const entry = pending.get(sequenceID)
    // Absent: already released by every holder, or swept. A late ack from an expired claim is not
    // honoured — the claim was given up on.
    if (entry == null) return
    entry.holders.delete(holder)
    if (entry.holders.size > 0) return
    pending.delete(sequenceID)
    ackUpstream(entry.position)
  }

  /**
   * Abandon a sink's claims when a mailbox consumer closes its subscription (or the mux disposes).
   * Never acks — a closing consumer has not handled what it still holds. Scans `pending` rather
   * than keeping a per-sink `held` set: one pass over a usually-small map, only on close, off the
   * per-message hot path.
   */
  const abandonSink = (sink: Sink): void => {
    sink.close()
    sinks.delete(sink)
    for (const [sequenceID, entry] of pending) {
      if (!entry.holders.delete(sink)) continue
      if (entry.holders.size === 0) pending.delete(sequenceID)
    }
  }

  /**
   * Drop claims older than the TTL, WITHOUT acking — the mirror of `memoryStore.purge`. Swept on
   * each inbound message, not on a timer: the drain is the only thing that adds entries.
   *
   * BREAKS at the first entry within the cutoff instead of scanning the whole map. Relies on
   * `pending` (a `Map`) iterating in insertion order with `claimedAt` non-decreasing — held by the
   * drain's `delete`-then-`set` on a redelivered position, which re-inserts it at the end with a
   * fresh `claimedAt`. Amortised O(1) per message.
   */
  const sweepPending = (now: number): void => {
    const cutoff = now - ackTTLMs
    for (const [sequenceID, entry] of pending) {
      if (entry.claimedAt > cutoff) break
      pending.delete(sequenceID)
    }
  }

  // Reported once, and only for an ending nobody asked for. `dispose` ends the drain too, and a
  // host being told its lane died in response to its own teardown is noise that trains hosts to
  // ignore the notice.
  const reportEnded = (ended: ReceiveLaneEnded): void => {
    if (disposed) return
    try {
      onReceiveEnded?.(ended)
    } catch {
      // a host's notice handler must not break the mux
    }
  }
  void (async () => {
    while (true) {
      let result: IteratorResult<StoredMessage>
      try {
        result = await iterator.next()
      } catch (error) {
        reportEnded({ error })
        return
      }
      if (disposed) return
      if (result.done) {
        reportEnded({})
        return
      }
      const message = result.value
      const now = Date.now()
      sweepPending(now)

      // Snapshotted BEFORE fan-out: a listener that unsubscribes mid-delivery must not be counted
      // as a pending holder of a frame it is still receiving.
      const matchedListeners = [...(listeners.get(message.topicID) ?? [])]

      // A place in THIS recipient's delivery queue, not the topic's log — different sequences, never
      // crossed, so this never reaches a log cursor.
      const position = asDeliveryPosition(message.sequenceID)

      // The drain holds its own claim across the whole fan-out. Without it a synchronously-acking
      // listener (the commit and rendezvous lanes both ack first) could empty the entry and ack
      // upstream before `matchedSinks` is even computed — pushing to a sink after the frame was
      // reported handled, and double-acking when that sink later releases.
      const drainClaim: Holder = Symbol('drain claim')
      const entry: PendingAck = {
        holders: new Set<Holder>([drainClaim, ...matchedListeners]),
        position,
        claimedAt: now,
      }
      // `set` OVERWRITES when the hub redelivers a position with an outstanding claim (a reconnect
      // racing a not-yet-swept claim): benign, since holders and matches are recomputed against
      // current registrations. Deleted before re-set so the refreshed entry moves to the END of the
      // Map — `set` on an existing key keeps its slot, which would leave a newer `claimedAt` at an
      // older position and break `sweepPending`'s ordering. A redelivery also refreshes `claimedAt`,
      // so an aggressively-redelivering hub is bounded by its own cadence, not the TTL.
      pending.delete(message.sequenceID)
      pending.set(message.sequenceID, entry)

      for (const listener of matchedListeners) {
        try {
          listener(message, () => releaseClaim(message.sequenceID, listener))
        } catch {
          // listener errors must not kill the drain
        }
      }

      // Matched AFTER the listener loop: a listener may synchronously create a mailbox sink (the
      // directed-tunnel lazy-accept race) that must still receive the triggering frame.
      const matchedSinks = [...sinks].filter(
        (sink) => sink.topicID == null || sink.topicID === message.topicID,
      )
      for (const sink of matchedSinks) entry.holders.add(sink)

      // An empty interested set is the shape of a frame that arrived before its listener registered
      // (a returning member's backlog lands the instant the channel opens, ahead of
      // `initControlLanes`). Acking here would report a frame nobody read as durably handled —
      // permanent loss, since `memoryStore` keys `deliveries` by DID and redelivers an unacked frame
      // but not an acked one. So the drain releases its own claim (which may ack) ONLY when something
      // matched; otherwise the entry is pruned unacked at the TTL and the frame returns on the next
      // redelivery (see "The init-race window" above).
      if (matchedListeners.length > 0 || matchedSinks.length > 0) {
        releaseClaim(message.sequenceID, drainClaim)
      }

      for (const sink of matchedSinks) {
        try {
          sink.push(message)
        } catch {
          // A throwing push would escape the IIFE and kill the drain permanently (no more sweeps or
          // acks, no `onReceiveEnded`). Unreachable today — `mailbox.receive`'s push cannot throw —
          // guarded for symmetry with the listener loop.
        }
      }
    }
  })()

  const bus: BroadcastBus = {
    publish: async (topicID, payload) => {
      assertSubscribable(topicID)
      await hub.publish({ senderDID: localDID, topicID, payload })
    },
    subscribe: (topicID, onMessage) =>
      onInbound(topicID, (message, ack) => onMessage(message.payload, ack)),
  }

  const mailbox: MailboxHub = {
    publish: async (publishParams) => {
      assertSubscribable(publishParams.topicID)
      return await hub.publish(publishParams)
    },
    subscribe: (_subscriberDID, topicID) => {
      retain(topicID)
    },
    unsubscribe: (_subscriberDID, topicID) => {
      release(topicID)
    },
    receive: (_subscriberDID, options): HubReceiveSubscription => {
      const queue: Array<StoredMessage> = []
      let resolveNext: ((result: IteratorResult<StoredMessage>) => void) | undefined
      let closed = false
      const sink: Sink = {
        push: (message) => {
          if (closed) return
          if (resolveNext != null) {
            const resolve = resolveNext
            resolveNext = undefined
            resolve({ value: message, done: false })
          } else {
            queue.push(message)
          }
        },
        close: () => {
          closed = true
          if (resolveNext != null) {
            const resolve = resolveNext
            resolveNext = undefined
            resolve({ value: undefined as unknown as StoredMessage, done: true })
          }
        },
        // Unscoped, this sink holds every message on every topic — including the ones it discards
        // on topic mismatch, which would then wait out the TTL rather than being acked.
        topicID: options?.topicID,
      }
      sinks.add(sink)
      // A closing consumer has not handled what it still holds, so its claims are abandoned, not
      // acked. See `abandonSink`.
      const remove = () => abandonSink(sink)
      const iter: AsyncIterator<StoredMessage> = {
        next: () => {
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
        return: () => {
          remove()
          return Promise.resolve({ value: undefined as unknown as StoredMessage, done: true })
        },
      }
      return {
        [Symbol.asyncIterator]: () => iter,
        return: remove,
        // Advertised UNCONDITIONALLY, even when upstream `subscription.ack` is absent (`ackUpstream`
        // then no-ops): releasing this sink's claim does real local work regardless — freeing the
        // holder-set entry so other holders' acks can free the frame.
        ack: (sequenceID) => releaseClaim(sequenceID, sink),
      }
    },
  }

  const publish = async (params: MuxPublishParams): Promise<{ sequenceID: string }> => {
    assertSubscribable(params.topicID)
    return await Promise.resolve(
      hub.publish({
        senderDID: localDID,
        topicID: params.topicID,
        payload: params.payload,
        ...(params.retain != null ? { retain: params.retain } : {}),
        // `expectedHead: null` is a compare-and-set against an empty topic and must reach
        // the hub; only an ABSENT key means "append unconditionally". Keyed on presence,
        // never on nullness — the first commit of a group's life is exactly the null case.
        ...('expectedHead' in params ? { expectedHead: params.expectedHead } : {}),
        ...(params.publishID != null ? { publishID: params.publishID } : {}),
      }),
    )
  }

  const fetchTopic = async (params: MuxFetchTopicParams): Promise<HubFetchTopicResult> => {
    // A fetch of a refused topic would die of `NotSubscribedError` — the SYMPTOM, naming the mux's
    // own failure to subscribe as if it were the caller's mistake. The latched refusal is raised
    // instead, so what reaches the host is the reason.
    assertSubscribable(params.topicID)
    // Called on `hub`, not through a detached reference: a LogHub is often a class, and
    // an unbound method loses its receiver.
    return await Promise.resolve(
      hub.fetchTopic({
        subscriberDID: localDID,
        topicID: params.topicID,
        ...(params.after != null ? { after: params.after } : {}),
        ...(params.limit != null ? { limit: params.limit } : {}),
      }),
    )
  }

  return {
    bus,
    mailbox,
    publish,
    retainTopic: (topicID, options) => {
      retain(topicID, options)
    },
    fetchTopic,
    onInbound,
    dispose: async () => {
      if (disposed) return
      disposed = true
      // Before anything else: a retry sleeping out its backoff is work already abandoned, and
      // every path it could wake into checks `disposed` and returns.
      for (const wake of [...sleeping]) wake()
      // Cleared without acking (the same abandon as `abandonSink`/`sweepPending`), before closing
      // sinks so their per-sink scans have nothing left to find.
      pending.clear()
      for (const sink of [...sinks]) {
        sink.close()
        sinks.delete(sink)
      }
      // Listeners go, the drain stops, SUBSCRIPTIONS STAND. Disposing means "stopped reading",
      // not "read everything, discard the rest". On mobile this is what backgrounding calls;
      // unsubscribing here would delete the user's unread mail on every app switch.
      refcount.clear()
      listeners.clear()
      iterator.return?.()
    },
  }
}
