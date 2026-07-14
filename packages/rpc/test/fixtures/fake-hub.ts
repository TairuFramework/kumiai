import { HeadMismatchError, NotSubscribedError, type StoredMessage } from '@kumiai/hub-protocol'
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
  /** The sequenceIDs published `retain: 'log'`. A topic's log is these, and nothing else. */
  #logClass = new Set<string>()
  /**
   * publishID -> the sequenceID it was accepted as. NOT a log entry: no deleter reaches
   * it, and it outlives the frame it names. It is the only thing that lets a peer replaying
   * its journal learn that a commit it never saw acknowledged had in fact landed.
   */
  #publishRecords = new Map<string, string>()
  /** Retention seconds requested per topic, by the most recent subscribe. */
  #retention = new Map<string, number | undefined>()
  /**
   * A hub that lies about who sent a frame. See {@link FakeHub.lieAboutSender}.
   */
  #senderLie: ((message: StoredMessage, readerDID: string) => string) | undefined
  /** Append-only record of every published message, for test assertions. */
  published: Array<StoredMessage> = []

  /**
   * Make the hub lie about a frame's `senderDID`, per reader — the field it authenticates
   * and therefore the field it can freely invent.
   *
   * `senderDID` is the hub's word about who handed a frame over, and this hub is not trusted:
   * a design that reads authority out of it has moved that authority to the hub without
   * saying so. A FakeHub that cannot forge the one field the design says is forgeable cannot
   * model the threat, so it can.
   */
  lieAboutSender(fn: (message: StoredMessage, readerDID: string) => string): void {
    this.#senderLie = fn
  }

  #asReadBy(message: StoredMessage, readerDID: string): StoredMessage {
    if (this.#senderLie == null) return message
    return { ...message, senderDID: this.#senderLie(message, readerDID) }
  }

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
    // The dedup check comes BEFORE the compare-and-set, and the order is the store's
    // contract. A replay carries the publishID the store already accepted and the
    // expectedHead the caller journalled — which its own accepted publish made stale — so
    // comparing first would tell a peer its commit was lost when it landed.
    if (params.publishID != null) {
      const accepted = this.#publishRecords.get(params.publishID)
      if (accepted !== undefined) return { sequenceID: accepted }
    }
    // The compare-and-set, before anything is minted: a loser leaves the log, the head and
    // the sequence exactly as it found them. `null` means "the topic has never had an
    // accepted log publish", and is a different request from an absent expectedHead.
    if (params.expectedHead !== undefined) {
      const head = this.#heads.get(params.topicID) ?? null
      if (head !== params.expectedHead) {
        throw new HeadMismatchError(
          `Publish to ${params.topicID} expected head ${params.expectedHead ?? 'null'}, but the head is ${head ?? 'null'}`,
        )
      }
    }

    const sequenceID = formatSequenceID(++this.#sequence)
    if (params.publishID != null) this.#publishRecords.set(params.publishID, sequenceID)
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
    // Only a log publish moves the head — and only a log publish is IN the log.
    if (params.retain === 'log') {
      this.#logClass.add(sequenceID)
      this.#heads.set(params.topicID, sequenceID)
    }

    // An accepted log frame is retained AND pushed — the push is not an alternative to
    // the log, it is on top of it.
    for (const did of [...(this.#topics.get(params.topicID) ?? [])]) {
      if (did === params.senderDID) continue
      const asRead = this.#asReadBy(message, did)
      for (const sink of this.#sinks.get(did) ?? []) sink.push(asRead)
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
    // A topic's log is its log-class frames and nothing else. A mailbox frame published to
    // the commit topic is delivered, and never enters the log: it does not move the head,
    // so a reader that met one would carry a cursor the head can never equal, and every
    // compare-and-set anchored there would lose forever.
    const log = (this.#logs.get(params.topicID) ?? []).filter((m) =>
      this.#logClass.has(m.sequenceID),
    )
    const after = params.after
    const selected = after == null ? log : log.filter((m) => m.sequenceID > after)
    const messages = (params.limit == null ? selected : selected.slice(0, params.limit)).map((m) =>
      this.#asReadBy(m, params.subscriberDID),
    )
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

  /**
   * Remove a topic's frames older than `before`, exclusive — the hub sweeping a log past its
   * retention. The head is NOT touched, exactly as the store's is not: it names the last
   * accepted log publish, and it outlives the frame it names. So a topic whose log has been
   * swept away entirely still has a head, and that is the state a returning member reads.
   */
  trim(topicID: string, before: string): void {
    const log = this.#logs.get(topicID)
    if (log == null) return
    this.#logs.set(
      topicID,
      log.filter((message) => message.sequenceID >= before),
    )
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
