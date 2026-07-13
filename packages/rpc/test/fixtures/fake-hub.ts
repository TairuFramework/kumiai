import { NotSubscribedError, type StoredMessage } from '@kumiai/hub-protocol'
import type {
  HubFetchTopicParams,
  HubFetchTopicResult,
  HubPublishParams,
  HubReceiveSubscription,
  HubSubscribeOptions,
  LogHub,
} from '@kumiai/hub-tunnel'

type Sink = {
  push: (message: StoredMessage) => void
  close: () => void
}

/**
 * Fixed-width and zero-padded, like the store's. A bare decimal ("10" < "9") types
 * fine and silently breaks every comparison the log makes on a sequenceID — `after`
 * as an exclusive cursor, `head` and `oldest` against a cursor.
 */
function formatSequenceID(counter: number): string {
  return String(counter).padStart(12, '0')
}

/**
 * In-memory LogHub (bytes) for tests, modelling both of the store's retention
 * classes. Publish fans out synchronously to every subscriber of the topic except
 * the sender, AND appends to the topic's log. A `retain: 'log'` publish also moves
 * the topic's head; a mailbox publish does not.
 *
 * The log is what `fetchTopic` reads, and it is not delivery-filtered: a peer pulls
 * back its own frames, which push never gives it.
 */
export class FakeHub implements LogHub {
  #sequence = 0
  #topics = new Map<string, Set<string>>()
  #sinks = new Map<string, Set<Sink>>()
  #logs = new Map<string, Array<StoredMessage>>()
  #heads = new Map<string, string>()
  /** Retention seconds requested per topic, by the most recent subscribe. */
  #retention = new Map<string, number | undefined>()
  /** Append-only record of every published message, for test assertions. */
  published: Array<StoredMessage> = []

  subscribe(subscriberDID: string, topicID: string, options?: HubSubscribeOptions): void {
    let set = this.#topics.get(topicID)
    if (set == null) {
      set = new Set()
      this.#topics.set(topicID, set)
    }
    set.add(subscriberDID)
    this.#retention.set(topicID, options?.retention)
  }

  unsubscribe(subscriberDID: string, topicID: string): void {
    const set = this.#topics.get(topicID)
    if (set == null) return
    set.delete(subscriberDID)
    if (set.size === 0) this.#topics.delete(topicID)
  }

  async publish(params: HubPublishParams): Promise<{ sequenceID: string }> {
    const sequenceID = formatSequenceID(++this.#sequence)
    const message: StoredMessage = {
      sequenceID,
      senderDID: params.senderDID,
      topicID: params.topicID,
      payload: params.payload,
    }
    this.published.push(message)

    let log = this.#logs.get(params.topicID)
    if (log == null) {
      log = []
      this.#logs.set(params.topicID, log)
    }
    log.push(message)
    // Only a log publish moves the head.
    if (params.retain === 'log') this.#heads.set(params.topicID, sequenceID)

    // An accepted log frame is retained AND pushed — the push is not an alternative to
    // the log, it is on top of it.
    for (const did of [...(this.#topics.get(params.topicID) ?? [])]) {
      if (did === params.senderDID) continue
      for (const sink of this.#sinks.get(did) ?? []) sink.push(message)
    }
    return { sequenceID }
  }

  async fetchTopic(params: HubFetchTopicParams): Promise<HubFetchTopicResult> {
    // The hub gates a topic fetch on the caller's own subscription: a peer subscribes
    // first, then pulls.
    if (!this.#topics.get(params.topicID)?.has(params.subscriberDID)) {
      throw new NotSubscribedError(
        `${params.subscriberDID} is not a subscriber of ${params.topicID}`,
      )
    }
    const log = this.#logs.get(params.topicID) ?? []
    const after = params.after
    const selected = after == null ? log : log.filter((m) => m.sequenceID > after)
    const messages = params.limit == null ? selected : selected.slice(0, params.limit)
    return {
      messages: [...messages],
      head: this.#heads.get(params.topicID) ?? null,
      oldest: log.length > 0 ? log[0].sequenceID : null,
    }
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
    let set = this.#sinks.get(subscriberDID)
    if (set == null) {
      set = new Set()
      this.#sinks.set(subscriberDID, set)
    }
    set.add(sink)
    const remove = () => {
      sink.close()
      this.#sinks.get(subscriberDID)?.delete(sink)
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
    return { [Symbol.asyncIterator]: () => iterator, return: remove }
  }

  subscriberCount(topicID: string): number {
    return this.#topics.get(topicID)?.size ?? 0
  }

  /** The topic's head: the last accepted log publish, or null. */
  head(topicID: string): string | null {
    return this.#heads.get(topicID) ?? null
  }

  /** The retention in seconds this topic was last subscribed with. */
  requestedRetention(topicID: string): number | undefined {
    return this.#retention.get(topicID)
  }
}
