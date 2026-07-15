import type { BroadcastBus } from '@kumiai/broadcast'
import type { StoredMessage } from '@kumiai/hub-protocol'
import type {
  HubFetchTopicResult,
  HubReceiveSubscription,
  HubSubscribeOptions,
  LogHub,
  MailboxHub,
} from '@kumiai/hub-tunnel'

import { asDeliveryPosition } from './cursor.js'

export type HubMuxParams = {
  /** The real hub. It must serve a log: the commit lane reads one. */
  hub: LogHub
  /** Authenticated DID used to drain `hub.receive` and stamp bus publishes. */
  localDID: string
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
}

/**
 * Multiplex a single hub `receive` drain into a BroadcastBus view, a mailbox-hub view (for
 * directed tunnels), and an onInbound hook (for lazy directed-server accept).
 *
 * Per inbound message, in order: (1) fire `onInbound` listeners for the topic, then (2) push
 * to every `mailbox.receive` sink — so a listener may create a directed tunnel synchronously
 * and still receive the triggering frame. Topics are refcounted across all three views; the
 * first registration subscribes on the hub.
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

  const listeners = new Map<string, Set<InboundListener>>()
  const refcount = new Map<string, number>()
  const sinks = new Set<Sink>()
  let disposed = false

  const retain = (topicID: string, options?: HubSubscribeOptions): void => {
    const next = (refcount.get(topicID) ?? 0) + 1
    refcount.set(topicID, next)
    if (next === 1) void Promise.resolve(hub.subscribe(localDID, topicID, options)).catch(() => {})
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
  void (async () => {
    while (true) {
      let result: IteratorResult<StoredMessage>
      try {
        result = await iterator.next()
      } catch {
        return
      }
      if (disposed || result.done) return
      const message = result.value
      const ack = () => {
        // An ack names a place in THIS recipient's delivery queue, not in the topic's
        // log. The two are different sequences and must never be crossed, so the
        // position is named for what it is and never leaves this closure.
        const position = asDeliveryPosition(message.sequenceID)
        void Promise.resolve(subscription.ack?.(position)).catch(() => {})
      }
      for (const listener of listeners.get(message.topicID) ?? []) {
        try {
          listener(message, ack)
        } catch {
          // listener errors must not kill the drain
        }
      }
      for (const sink of [...sinks]) sink.push(message)
    }
  })()

  const bus: BroadcastBus = {
    publish: (topicID, payload) =>
      Promise.resolve(hub.publish({ senderDID: localDID, topicID, payload })).then(() => {}),
    subscribe: (topicID, onMessage) => onInbound(topicID, (message) => onMessage(message.payload)),
  }

  const mailbox: MailboxHub = {
    publish: (publishParams) => hub.publish(publishParams),
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

  const publish = (params: MuxPublishParams): Promise<{ sequenceID: string }> =>
    Promise.resolve(
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

  const fetchTopic = (params: MuxFetchTopicParams): Promise<HubFetchTopicResult> =>
    // Called on `hub`, not through a detached reference: a LogHub is often a class, and
    // an unbound method loses its receiver.
    Promise.resolve(
      hub.fetchTopic({
        subscriberDID: localDID,
        topicID: params.topicID,
        ...(params.after != null ? { after: params.after } : {}),
        ...(params.limit != null ? { limit: params.limit } : {}),
      }),
    )

  return {
    bus,
    mailbox,
    publish,
    fetchTopic,
    onInbound,
    dispose: async () => {
      if (disposed) return
      disposed = true
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
