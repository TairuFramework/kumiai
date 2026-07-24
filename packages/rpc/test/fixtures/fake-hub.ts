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
 * 30 days in seconds — `createMemoryStore`'s own default ceiling. Kept in step deliberately: a
 * fixture with a laxer ceiling than the store it stands in for silently stops modelling the one
 * refusal that matters.
 */
export const DEFAULT_MAX_RETENTION = 2_592_000

/**
 * Per-topic log-class depth, matching `createMemoryStore`'s own default. Kept in step for the same
 * reason the retention ceiling is: a fixture that retains unconditionally never produces a cursor
 * below `oldest` on its own, so every path that must survive a trimmed log is only ever reached by
 * a test that remembered to call `trim()` by hand.
 */
export const DEFAULT_MAX_DEPTH = 1000

export type FakeHubOptions = {
  /** Retention ceiling in seconds. Default {@link DEFAULT_MAX_RETENTION}. */
  maxRetention?: number
  /** Per-topic log-class depth before the oldest is evicted. Default {@link DEFAULT_MAX_DEPTH}. */
  maxDepth?: number
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
  /**
   * A hub that does not honour the compare-and-set. Off by default: everything below is
   * OPT-IN, so an honest hub is what every test gets unless it asks for otherwise.
   */
  #acceptsAnyHead = false
  /** Frames a given reader is not shown at all: `readerDID -> sequenceIDs`. */
  #hidden = new Map<string, Set<string>>()
  /** Frames a given reader is shown even though its cursor is already past them. */
  #belowCursor = new Map<string, Set<string>>()
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

  /**
   * Stop honouring the compare-and-set: accept every publish at whatever head it names, so
   * two commits at one head both land and the log forks.
   *
   * A conforming store cannot do this — the head comparison, the sequence mint and the append
   * are one transaction — and the store's contract is not what this models. It models the hub
   * the design refuses to trust. **The double-accept is the ONLY way a fork exists at all**, so
   * a fixture that cannot produce one cannot exercise a single line of the code that heals it.
   */
  acceptAtAnyHead(): void {
    this.#acceptsAnyHead = true
  }

  /**
   * Serve divergent logs: withhold a frame from one reader while showing it to another. This
   * is what "the hub accepted both and told different members different things" actually looks
   * like from inside a peer.
   */
  hideFrom(readerDID: string, sequenceID: string): void {
    let set = this.#hidden.get(readerDID)
    if (set == null) {
      set = new Set()
      this.#hidden.set(readerDID, set)
    }
    set.add(sequenceID)
  }

  /**
   * Hand a reader a frame its cursor has ALREADY PASSED — the branch it was never shown,
   * arriving after it committed to the other one.
   *
   * `fetchTopic`'s `after` is an exclusive cursor, and that is a CONTRACT: the party it binds
   * is the party this design does not trust. A hub that has already broken the compare-and-set
   * to fork the log has no reason to keep this one, and a peer that assumed it would can never
   * be shown the branch it lost — which is exactly the observation that heals it.
   *
   * ONE-SHOT: the frame is served on the next read and then the log converges to one story. A
   * hub that kept re-serving a frame below every peer's cursor forever would simply re-trigger
   * every heal forever, which is a hub denying service rather than a hub forking a log, and no
   * peer-side rule can survive it.
   */
  revealTo(readerDID: string, sequenceID: string): void {
    this.#hidden.get(readerDID)?.delete(sequenceID)
    let set = this.#belowCursor.get(readerDID)
    if (set == null) {
      set = new Set()
      this.#belowCursor.set(readerDID, set)
    }
    set.add(sequenceID)
  }

  #asReadBy(message: StoredMessage, readerDID: string): StoredMessage {
    if (this.#senderLie == null) return message
    return { ...message, senderDID: this.#senderLie(message, readerDID) }
  }

  /**
   * The retention ceiling, in seconds. Defaults to the memory store's own
   * ({@link DEFAULT_MAX_RETENTION}), so the default fixture refuses exactly what a default real
   * hub refuses — a test that never mentions retention gets the operator's real answer, not an
   * infinitely permissive one.
   */
  #maxRetention: number
  /** Per-topic log-class depth bound. See {@link DEFAULT_MAX_DEPTH}. */
  #maxDepth: number
  /** One-shot transient failures to inject, per topic. See {@link FakeHub.failSubscribeOnce}. */
  #transientFailures = new Map<string, number>()
  /** A permanent refusal (an ANSWER, not a transport drop) to throw on the next subscribe. */
  #permanentRefusals = new Map<string, Error>()
  /** Every subscribe ASKED FOR, per topic, refused or not — what a retry loop is counted with. */
  #subscribeAttempts = new Map<string, number>()

  constructor(options: FakeHubOptions = {}) {
    this.#maxRetention = options.maxRetention ?? DEFAULT_MAX_RETENTION
    this.#maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  }

  /**
   * Make the next `count` subscribes to `topicID` fail with a transport error — a hub that is
   * unreachable rather than one that has answered. The distinction is the whole retry policy: a
   * caller must retry this and must NOT retry a RetentionExceededError.
   */
  failSubscribeOnce(topicID: string, count = 1): void {
    this.#transientFailures.set(topicID, (this.#transientFailures.get(topicID) ?? 0) + count)
  }

  /**
   * Make the next subscribe to `topicID` throw `error` — a hub that has ANSWERED (e.g. an
   * authorization refusal), which the mux must not retry. Distinct from `failSubscribeOnce`, a
   * transport drop that must be retried.
   */
  refuseSubscribeWith(topicID: string, error: Error): void {
    this.#permanentRefusals.set(topicID, error)
  }

  /**
   * Refuses a retention above the ceiling, exactly as `createMemoryStore` does
   * (`hub-server/src/memoryStore.ts`) and as the conformance suite asserts of any real store. An
   * infallible fixture cannot model a hub saying no, and a subscribe that cannot fail is a
   * subscribe whose failure handling is never executed — which is precisely how the mux came to
   * swallow every one of them unnoticed.
   *
   * Throws SYNCHRONOUSLY, which `HubBase.subscribe` allows (`Promise<void> | void`): a caller that
   * only catches a rejection is as broken as one that catches nothing, and the fixture should be
   * able to show that.
   */
  subscribe(subscriberDID: string, topicID: string, options?: HubSubscribeOptions): void {
    this.#subscribeAttempts.set(topicID, (this.#subscribeAttempts.get(topicID) ?? 0) + 1)
    const pending = this.#transientFailures.get(topicID) ?? 0
    if (pending > 0) {
      this.#transientFailures.set(topicID, pending - 1)
      throw new Error(`FakeHub: subscribe to ${topicID} failed (injected transport failure)`)
    }
    const refusal = this.#permanentRefusals.get(topicID)
    if (refusal != null) {
      this.#permanentRefusals.delete(topicID)
      throw refusal
    }
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
    if (params.expectedHead !== undefined && !this.#acceptsAnyHead) {
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
      // A log-class frame carries its place in the topic's log wherever it is handed out — pushed
      // or pulled. This hub mints one sequence for both classes, so that place IS the sequenceID
      // here; what the contract fixes is that a reader is TOLD it rather than assuming the two
      // sequences coincide. A mailbox frame has no place in a log and carries no key at all.
      ...(params.retain === 'log' ? { logPosition: sequenceID } : {}),
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
      // The depth bound, as the store enforces it: a trim like any other — it moves `oldest` and
      // leaves the head alone — counting LOG frames only. A mailbox frame is bounded by ack and
      // age, not depth; counting it here would let any member evict the commit log with a mailbox
      // flood. Only a log publish can push the log-class count over the bound.
      let logDepth = log.reduce(
        (count, m) => (this.#logClass.has(m.sequenceID) ? count + 1 : count),
        0,
      )
      while (logDepth > this.#maxDepth) {
        const index = log.findIndex((m) => this.#logClass.has(m.sequenceID))
        if (index === -1) break
        log.splice(index, 1)
        logDepth--
      }
    }

    // An accepted log frame is retained AND pushed — the push is not an alternative to
    // the log, it is on top of it.
    for (const did of [...(this.#topics.get(params.topicID) ?? [])]) {
      if (did === params.senderDID) continue
      // A frame this reader is being kept from does not reach it by push either.
      if (this.#hidden.get(did)?.has(sequenceID) === true) continue
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
    // An honest hub shows every reader the same log and honours the exclusive cursor. A hub
    // told to fork does neither: a frame it is withholding from this reader is not in the
    // reader's log at all, and one it has been told to reveal is served even though the
    // reader's cursor is already past it.
    const hidden = this.#hidden.get(params.subscriberDID)
    const belowCursor = this.#belowCursor.get(params.subscriberDID)
    const visible = hidden == null ? log : log.filter((m) => !hidden.has(m.sequenceID))
    const selected = visible.filter(
      (m) => after == null || m.sequenceID > after || belowCursor?.has(m.sequenceID) === true,
    )
    const messages = (params.limit == null ? selected : selected.slice(0, params.limit)).map((m) =>
      this.#asReadBy(m, params.subscriberDID),
    )
    // A frame served below the cursor is served once: the fork is shown, and then the hub tells
    // one story again.
    for (const message of messages) belowCursor?.delete(message.sequenceID)
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

  /** How many times a subscribe to this topic was attempted, refused or not. */
  subscribeAttempts(topicID: string): number {
    return this.#subscribeAttempts.get(topicID) ?? 0
  }

  /** The retention in seconds this topic was last subscribed with. */
  requestedRetention(topicID: string): number | undefined {
    return this.#retention.get(topicID)
  }
}
