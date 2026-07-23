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
 * THE FALLBACK, used when a host wires no handler: say it out loud rather than nowhere.
 *
 * Both conditions leave a peer that looks healthy and is not — every call still succeeds, and
 * the group simply appears to have gone quiet. A host that has not wired the notice is exactly
 * the host that will not otherwise find out, so the default has to be loud rather than tidy.
 *
 * AT ERROR LEVEL, not warn, and that is not emphasis: `@sozai/log`'s own default configuration
 * admits `error` and drops `warn`, so a warning would be discarded by the very setup most apps
 * start from. A condition that silently loses every message this peer is sent belongs above that
 * line anyway.
 *
 * AND CONSOLE WHEN LOGGING IS NOT CONFIGURED, because logtape with no configuration discards
 * records — which would put this back exactly where it started. `isSetup()` is the difference
 * between "the app collects this" and "nobody will ever see it".
 *
 * KNOWN GAP, filed in `docs/agents/plans/next/2026-07-19-logging-reaches-a-sink.md`: `isSetup()`
 * answers whether logging is configured, not whether THIS category reaches a sink. An app calling
 * `@sozai/log`'s `setup()` with no argument gets a config covering `['sozai']` and nothing else,
 * so these records are dropped while the console fallback stays out of the way. Fixing it means
 * choosing between logtape's own emit check, a root sink in the shared default, and a documented
 * requirement — a decision that belongs to the logging story rather than to this file.
 *
 * Only these two conditions. `rpc/src` swallows failures in twenty-odd other places and every one
 * of them is ordinary control flow on a shared log — a frame sealed for another epoch, a host
 * handler that threw, a retry that ran out. Logging those would be constant noise, and a warning
 * nobody can afford to read is worth no more than silence.
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
   * How long a delivered message waits for its holders to ack before its claim is dropped.
   * Default {@link DEFAULT_ACK_TTL_MS}.
   *
   * Expiry drops the claim and sends NO upstream ack: it means a holder is broken, and telling the
   * hub the frame was durably handled would be a false success. The hub's own age bound reclaims
   * it instead.
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
 * Per inbound message, in order: (1) fire `onInbound` listeners for the topic, then (2) push to
 * every `mailbox.receive` sink whose topic scope matches — a sink naming no topic takes every
 * message, one naming a topic only that one — so a listener may create a directed tunnel
 * synchronously and still receive the triggering frame. Topics are refcounted across all three
 * views; the first registration subscribes on the hub.
 *
 * ## A subscribe the hub refuses
 *
 * The hub may say no — `RetentionExceededError` when a host asks to hold a log longer than the
 * operator allows, refused rather than clamped on purpose. A peer that is not a subscriber of a
 * topic is pushed nothing on it and cannot pull it: no commit applies, no app frame arrives. That
 * failure has to be impossible to miss, and there are three candidate surfaces:
 *
 * - **Retry with backoff** answers a dropped socket and nothing else. Retrying a settled refusal
 *   is a busy loop against an answer that will not change, so it is the answer for TRANSIENT
 *   failures only. Used, bounded, and never for a permanent one.
 * - **Raising into the caller** cannot be the whole answer: `retainTopic` is called for its effect
 *   and returns before the hub has answered, and the callers that would catch it (the commit-lane
 *   seed, the app-segment load) are the ones already written to swallow.
 * - **A host callback** is optional by nature, and an optional notice cannot be the guarantee: an
 *   unwired host would be exactly as blind as today.
 *
 * So the guarantee is a LATCH, and the callback is a convenience on top of it. A refused topic is
 * recorded as refused, and every `publish`, `bus.publish`, `mailbox.publish` and `fetchTopic` on it
 * throws the hub's own error. A peer that cannot receive on a topic does not go on transmitting
 * there as though it were whole — it fails at the first operation that touches the topic, with the
 * reason rather than the `NotSubscribedError` symptom. That is what makes it impossible for a peer
 * whose subscribe was refused to report itself healthy, whatever the host wired.
 *
 * `onSubscribeFailed` exists on top because a peer that only READS a topic calls nothing that
 * could throw. The latch cannot reach it; the notice can.
 *
 * A refused topic is not held, so the next `retain` asks again — a host that lowered its retention
 * recovers on the next rotation without restarting.
 *
 * **The refcount tracks LOCAL LISTENERS and never unsubscribes.** A subscription is a durable
 * member-topic relationship, not a session: the hub holds a subscriber's undelivered frames,
 * and `unsubscribe` tells the store to drop them and free any mailbox frame it was the last
 * reader of. So no local lifecycle event may unsubscribe — dropping a listener, rotating an
 * epoch, disposing the mux all mean "not listening", never "I have read my mail, discard the
 * rest". Only an explicit leave-the-group would unsubscribe, and nothing here does. That
 * outliving subscription is what lets a member return and find its mail; disposing the peer is
 * what backgrounding a mobile app calls.
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
    }
  }

  const subscription = hub.receive(localDID)
  const iterator = subscription[Symbol.asyncIterator]()

  // `symbol` admits the drain's own claim (below) as a distinct holder identity — not a fake
  // zero-arg `InboundListener` that would typecheck by TypeScript dropping trailing parameters
  // but never be honest about what the value is.
  type Holder = InboundListener | Sink | symbol

  /**
   * The holders of one delivered message that have not yet released it.
   *
   * A SET OF IDENTITIES, never a counter — the same choice `LogEntry.pendingFor` makes in
   * `hub-server/src/memoryStore.ts`. A holder that acks twice deletes itself twice, which is a
   * no-op; a counter would reach zero and free a frame its other holders still hold.
   */
  type PendingAck = {
    holders: Set<Holder>
    position: DeliveryPosition
    claimedAt: number
  }
  const pending = new Map<string, PendingAck>()

  const ackUpstream = (position: DeliveryPosition): void => {
    // A hub's ack may be synchronous, so it may throw synchronously — before `Promise.resolve`
    // ever sees it, which is why the rejection guard alone is not enough. An ack that fails is
    // the hub's problem: the frame ages out. A throw escaping here reaches whatever called the
    // holder's release, and on the serialized open-once chain that skips the NEXT frame's open
    // while still acking it as handled.
    try {
      void Promise.resolve(subscription.ack?.(position)).catch(() => {})
    } catch {
      // ignore
    }
  }

  const releaseClaim = (sequenceID: string, holder: Holder): void => {
    const entry = pending.get(sequenceID)
    // Absent: already released by every holder, or already swept. A late ack from a holder whose
    // claim expired is deliberately not honoured — the claim was given up on.
    if (entry == null) return
    entry.holders.delete(holder)
    if (entry.holders.size > 0) return
    pending.delete(sequenceID)
    ackUpstream(entry.position)
  }

  /**
   * Drop claims older than the TTL, WITHOUT acking — the mirror of `memoryStore.purge`.
   *
   * Swept on each inbound message rather than on a timer: the drain is the only thing that adds
   * entries, so a quiet drain has nothing to sweep, and a timer would need dispose handling and a
   * cross-platform unref for no gain. A lingering entry holds no hub resource — the hub reclaims
   * by its own age bound regardless.
   */
  const sweepPending = (now: number): void => {
    const cutoff = now - ackTTLMs
    for (const [sequenceID, entry] of pending) {
      if (entry.claimedAt <= cutoff) pending.delete(sequenceID)
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

      // Listeners snapshotted BEFORE the fan-out: a listener that unsubscribes mid-delivery would
      // otherwise be counted as pending and never receive the message it is being waited on for.
      const matchedListeners = [...(listeners.get(message.topicID) ?? [])]

      // An ack names a place in THIS recipient's delivery queue, not in the topic's log. The two
      // are different sequences and must never be crossed, so the position is named for what it
      // is and never reaches a log cursor.
      const position = asDeliveryPosition(message.sequenceID)

      // The drain holds a claim of its own across the whole fan-out. Without it, a listener that
      // acks synchronously (the commit and rendezvous lanes both do, as their first statement)
      // could empty the entry and ack upstream before `matchedSinks` below is even computed —
      // leaving a sink pushed to after the frame was already told to the hub as durably handled,
      // and a second `ackUpstream` when that sink later releases its own claim.
      const drainClaim: Holder = Symbol('drain claim')
      pending.set(message.sequenceID, {
        holders: new Set<Holder>([drainClaim, ...matchedListeners]),
        position,
        claimedAt: now,
      })

      for (const listener of matchedListeners) {
        try {
          listener(message, () => releaseClaim(message.sequenceID, listener))
        } catch {
          // listener errors must not kill the drain
        }
      }

      // Sinks matched AFTER the listener loop, not before: a listener may synchronously create a
      // mailbox sink (the directed-tunnel lazy-accept race), and it must still receive the frame
      // that triggered it. The entry is guaranteed present here — the drain's own claim above is
      // still holding it — so there is no fresh-entry branch to fall into.
      const matchedSinks = [...sinks].filter(
        (sink) => sink.topicID == null || sink.topicID === message.topicID,
      )
      const entry = pending.get(message.sequenceID)
      if (entry != null) {
        for (const sink of matchedSinks) entry.holders.add(sink)
      }

      // Releasing the drain's own claim last acks upstream iff no listener or sink is still
      // holding — which is also what covers the message nobody was interested in, with no
      // separate branch for that case.
      releaseClaim(message.sequenceID, drainClaim)

      for (const sink of matchedSinks) sink.push(message)
    }
  })()

  const bus: BroadcastBus = {
    publish: async (topicID, payload) => {
      assertSubscribable(topicID)
      await hub.publish({ senderDID: localDID, topicID, payload })
    },
    subscribe: (topicID, onMessage) => onInbound(topicID, (message) => onMessage(message.payload)),
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
    receive: (_subscriberDID): HubReceiveSubscription => {
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
      }
      sinks.add(sink)
      const remove = () => {
        sink.close()
        sinks.delete(sink)
      }
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
      return { [Symbol.asyncIterator]: () => iter, return: remove }
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
      for (const sink of [...sinks]) sink.close()
      sinks.clear()
      // Listeners go, the drain stops, SUBSCRIPTIONS STAND. Disposing means "stopped reading",
      // not "read everything, discard the rest". On mobile this is what backgrounding calls;
      // unsubscribing here would delete the user's unread mail on every app switch.
      refcount.clear()
      listeners.clear()
      iterator.return?.()
    },
  }
}
