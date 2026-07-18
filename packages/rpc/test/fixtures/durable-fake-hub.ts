import {
  HeadMismatchError,
  NotSubscribedError,
  RetentionExceededError,
  type StoredMessage,
} from '@kumiai/hub-protocol'
import type {
  HubFetchTopicParams,
  HubFetchTopicResult,
  HubPublishParams,
  HubReceiveSubscription,
  HubSubscribeOptions,
  LogHub,
} from '@kumiai/hub-tunnel'

import { DEFAULT_MAX_RETENTION, type FakeHubOptions } from './fake-hub.js'

type Sink = {
  push: (message: StoredMessage) => void
  close: () => void
}

/** Fixed-width and zero-padded, like the store's — a bare decimal breaks `after`. */
function formatSequenceID(counter: number): string {
  return String(counter).padStart(12, '0')
}

/**
 * Durable in-memory LogHub modelling the real hub's retained log + the
 * client-adapter's redelivery. Unlike the live FakeHub, it tracks per-subscriber acks
 * and can redeliver unacked messages — letting tests exercise a disconnect, and what
 * a peer does with a frame it has already processed being pushed at it again.
 *
 * Test controls: `detach(did)` stops live delivery (peer "offline"),
 * `reattach(did)` resumes it, `redeliver(did)` pushes the subscriber's unacked
 * retained messages (reconnect backlog).
 */
export class DurableFakeHub implements LogHub {
  #seq = 0
  #log: Array<StoredMessage> = []
  #heads = new Map<string, string>()
  #topics = new Map<string, Set<string>>()
  #sinks = new Map<string, Sink>()
  #live = new Map<string, boolean>()
  #acked = new Map<string, Set<string>>()
  /** publishID -> the sequenceID it was accepted as. Not a log entry; no deleter reaches it. */
  #publishRecords = new Map<string, string>()
  /** The sequenceIDs published `retain: 'log'`. A topic's log is these, and nothing else. */
  #logClass = new Set<string>()
  /** Append-only record of every published message, for test assertions. */
  published: Array<StoredMessage> = []

  /** Retention ceiling in seconds — the memory store's default, for the reason FakeHub's is. */
  #maxRetention: number

  constructor(options: FakeHubOptions = {}) {
    this.#maxRetention = options.maxRetention ?? DEFAULT_MAX_RETENTION
  }

  /** Refuses a retention above the ceiling, as `createMemoryStore` does. See {@link FakeHub}. */
  subscribe(subscriberDID: string, topicID: string, options?: HubSubscribeOptions): void {
    if (options?.retention != null && options.retention > this.#maxRetention) {
      throw new RetentionExceededError(
        `Requested retention of ${options.retention}s exceeds the maximum of ${this.#maxRetention}s`,
      )
    }
    let set = this.#topics.get(topicID)
    if (set == null) {
      set = new Set()
      this.#topics.set(topicID, set)
    }
    set.add(subscriberDID)
  }

  unsubscribe(subscriberDID: string, topicID: string): void {
    const set = this.#topics.get(topicID)
    if (set == null) return
    set.delete(subscriberDID)
    if (set.size === 0) this.#topics.delete(topicID)
  }

  async publish(params: HubPublishParams): Promise<{ sequenceID: string }> {
    // Dedup before compare-and-set: the store's order, and a replay depends on it.
    if (params.publishID != null) {
      const accepted = this.#publishRecords.get(params.publishID)
      if (accepted !== undefined) return { sequenceID: accepted }
    }
    if (params.expectedHead !== undefined) {
      const head = this.#heads.get(params.topicID) ?? null
      if (head !== params.expectedHead) {
        throw new HeadMismatchError(
          `Publish to ${params.topicID} expected head ${params.expectedHead ?? 'null'}, but the head is ${head ?? 'null'}`,
        )
      }
    }
    const sequenceID = formatSequenceID(++this.#seq)
    if (params.publishID != null) this.#publishRecords.set(params.publishID, sequenceID)
    const message: StoredMessage = {
      sequenceID,
      senderDID: params.senderDID,
      topicID: params.topicID,
      payload: params.payload,
    }
    this.published.push(message)
    this.#log.push(message)
    // Only a log publish moves the head — and only a log publish is IN the log.
    if (params.retain === 'log') {
      this.#logClass.add(sequenceID)
      this.#heads.set(params.topicID, sequenceID)
    }
    for (const did of this.#topics.get(params.topicID) ?? []) {
      if (did === params.senderDID) continue
      if (this.#live.get(did)) this.#sinks.get(did)?.push(message)
    }
    return { sequenceID }
  }

  async fetchTopic(params: HubFetchTopicParams): Promise<HubFetchTopicResult> {
    if (!this.#topics.get(params.topicID)?.has(params.subscriberDID)) {
      throw new NotSubscribedError(
        `${params.subscriberDID} is not a subscriber of ${params.topicID}`,
      )
    }
    // A topic's log is its log-class frames and nothing else: a mailbox frame is delivered
    // and never enters the log, so no reader's cursor can name a position the head cannot
    // reach.
    const log = this.#log.filter(
      (m) => m.topicID === params.topicID && this.#logClass.has(m.sequenceID),
    )
    const after = params.after
    const selected = after == null ? log : log.filter((m) => m.sequenceID > after)
    const messages = params.limit == null ? selected : selected.slice(0, params.limit)
    return {
      messages,
      head: this.#heads.get(params.topicID) ?? null,
      oldest: log.length > 0 ? log[0].sequenceID : null,
    }
  }

  #ack(subscriberDID: string, sequenceID: string): void {
    let set = this.#acked.get(subscriberDID)
    if (set == null) {
      set = new Set()
      this.#acked.set(subscriberDID, set)
    }
    set.add(sequenceID)
  }

  /** Stop live delivery to a subscriber (simulate going offline). */
  detach(subscriberDID: string): void {
    this.#live.set(subscriberDID, false)
  }

  /** Resume live delivery to a subscriber. */
  reattach(subscriberDID: string): void {
    this.#live.set(subscriberDID, true)
  }

  /** Push the subscriber's unacked retained messages (reconnect backlog replay). */
  redeliver(subscriberDID: string): void {
    const sink = this.#sinks.get(subscriberDID)
    if (sink == null) return
    const acked = this.#acked.get(subscriberDID) ?? new Set<string>()
    const subscribed = new Set(
      [...this.#topics].filter(([, dids]) => dids.has(subscriberDID)).map(([topic]) => topic),
    )
    for (const message of this.#log) {
      if (message.senderDID === subscriberDID) continue
      if (!subscribed.has(message.topicID)) continue
      if (acked.has(message.sequenceID)) continue
      sink.push(message)
    }
  }

  ackedCount(subscriberDID: string): number {
    return this.#acked.get(subscriberDID)?.size ?? 0
  }

  /**
   * Sweep a topic's frames older than `before`, exclusive — the hub enforcing its retention
   * window. The head is NOT touched, exactly as the store's is not: it names the last accepted
   * log publish and outlives the frame it names. A member offline for the window's duration is
   * one whose own backlog is the OLDEST thing left here.
   */
  trim(topicID: string, before: string): void {
    this.#log = this.#log.filter((m) => m.topicID !== topicID || m.sequenceID >= before)
  }

  /** The oldest log-class frame the topic still retains, or null. */
  oldest(topicID: string): string | null {
    const log = this.#log.filter((m) => m.topicID === topicID && this.#logClass.has(m.sequenceID))
    return log.length > 0 ? (log[0] as StoredMessage).sequenceID : null
  }

  /** The topic's head: the last accepted log publish, or null. It survives a trim. */
  head(topicID: string): string | null {
    return this.#heads.get(topicID) ?? null
  }

  receive(subscriberDID: string): HubReceiveSubscription {
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
    this.#sinks.set(subscriberDID, sink)
    this.#live.set(subscriberDID, true)
    const remove = () => {
      sink.close()
      if (this.#sinks.get(subscriberDID) === sink) this.#sinks.delete(subscriberDID)
    }
    const iterator: AsyncIterator<StoredMessage> = {
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
      [Symbol.asyncIterator]: () => iterator,
      return: remove,
      ack: (sequenceID: string) => this.#ack(subscriberDID, sequenceID),
    }
  }

  subscriberCount(topicID: string): number {
    return this.#topics.get(topicID)?.size ?? 0
  }
}
