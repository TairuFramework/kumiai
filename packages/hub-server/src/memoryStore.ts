import type {
  AckParams,
  FetchParams,
  FetchResult,
  FetchTopicParams,
  FetchTopicResult,
  HubStore,
  HubStoreEvents,
  PublishParams,
  PurgeParams,
  StoredMessage,
  SubscribeParams,
  TrimParams,
} from '@kumiai/hub-protocol'
import { HeadMismatchError, NotSubscribedError, RetentionExceededError } from '@kumiai/hub-protocol'
import { EventEmitter } from '@sozai/event'

type RetentionClass = 'log' | 'mailbox'

type LogEntry = {
  sequenceID: string
  senderDID: string
  topicID: string
  payload: Uint8Array
  storedAt: number
  retain: RetentionClass
  /** Recipients with a pending delivery of this entry: the reverse index of `deliveries`. */
  pendingFor: Set<string>
}

export type MemoryStoreRetention = {
  /** Floor, in seconds, on how long a topic's frames are kept. Default 0. */
  default?: number
  /** Ceiling, in seconds, on what a subscriber may request. Above it: RetentionExceededError. */
  max?: number
}

export type MemoryStoreOptions = {
  /** Per-topic max retained entries; oldest are trimmed beyond this. Default 1000. */
  maxDepth?: number
  retention?: MemoryStoreRetention
}

const DEFAULT_MAX_DEPTH = 1000

function formatSequenceID(counter: number): string {
  return String(counter).padStart(12, '0')
}

/**
 * In-memory implementation of HubStore for testing and development.
 *
 * Retention is a class, declared per publish, and a duration, requested per subscribe.
 *
 * - `'mailbox'` (the default) is delivery-derived: its readers are known at publish time, so the
 *   last ack frees the frame, and a publish nobody is subscribed to is dropped outright.
 * - `'log'` is not: a subscriber that must read a frame may not exist when it is published, so no
 *   refcount over current subscribers can ever free it. It is appended whether or not anyone is
 *   subscribed, and only `trim` — or the age bound — removes it.
 *
 * The store is told the class; it never infers it, and it never reads a payload.
 *
 * Both classes are bounded by age: a topic's frames live for the longest retention any of its
 * subscribers asked for, floored at the hub's default. For a mailbox topic that bound sits
 * alongside the ack GC, and the ack usually gets there first.
 */
export function createMemoryStore(options: MemoryStoreOptions = {}): HubStore {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const defaultRetention = options.retention?.default ?? 0
  const maxRetention = options.retention?.max ?? Number.POSITIVE_INFINITY
  let counter = 0
  const entries = new Map<string, LogEntry>()
  const topicLogs = new Map<string, Array<string>>()
  const heads = new Map<string, string>()
  const deliveries = new Map<string, Array<string>>()
  /**
   * publishID -> the sequenceID it was accepted as. Not a log entry, and not reachable from one:
   * no deleter here takes a publishID, so `removeEntry`, `trim` and `purge` have no way to touch
   * this map even by mistake. Retained indefinitely — it is a key and a sequenceID, one per
   * conditional publish, and it is the only thing that lets a peer replaying its journal learn
   * that a commit it never saw acknowledged had in fact landed.
   */
  const publishRecords = new Map<string, string>()
  /** Per topic: the subscribers, each with the retention it asked for. */
  const subscriptions = new Map<string, Map<string, number>>()
  const keyPackages = new Map<string, Array<string>>()
  const events = new EventEmitter<HubStoreEvents>()

  // The age bound for a topic: the longest retention any of its subscribers asked for, floored
  // by the hub's default and by the caller's own bound.
  function retentionOf(topicID: string, floor: number): number {
    let retention = Math.max(floor, defaultRetention)
    const subscribers = subscriptions.get(topicID)
    if (subscribers != null) {
      for (const requested of subscribers.values()) {
        if (requested > retention) retention = requested
      }
    }
    return retention
  }

  // The only removal path for an entry. Pending deliveries of it go with it: they reference an
  // entry that no longer exists, so they can no longer be pushed. `heads` is never touched — an
  // empty log still has a head.
  function removeEntry(sequenceID: string): void {
    const entry = entries.get(sequenceID)
    if (entry == null) return
    for (const recipientDID of entry.pendingFor) {
      const list = deliveries.get(recipientDID)
      if (list != null) {
        const index = list.indexOf(sequenceID)
        if (index !== -1) list.splice(index, 1)
      }
    }
    const log = topicLogs.get(entry.topicID)
    if (log != null) {
      const index = log.indexOf(sequenceID)
      if (index !== -1) log.splice(index, 1)
      if (log.length === 0) topicLogs.delete(entry.topicID)
    }
    entries.delete(sequenceID)
  }

  // Drop one recipient's pending delivery. A mailbox frame whose last delivery is gone has been
  // read by everyone who was ever going to read it, so it goes with it. A log frame does not: the
  // subscriber that needs it may not exist yet.
  function dropDelivery(recipientDID: string, sequenceID: string): void {
    const list = deliveries.get(recipientDID)
    if (list != null) {
      const index = list.indexOf(sequenceID)
      if (index !== -1) list.splice(index, 1)
    }
    const entry = entries.get(sequenceID)
    if (entry == null) return
    entry.pendingFor.delete(recipientDID)
    if (entry.retain === 'mailbox' && entry.pendingFor.size === 0) {
      removeEntry(sequenceID)
    }
  }

  return {
    events,

    async publish(params: PublishParams): Promise<string> {
      const retain: RetentionClass = params.retain ?? 'mailbox'

      // The dedup check comes BEFORE the compare-and-set, and the order is load-bearing. A replay
      // carries the publishID the store has already accepted and the expectedHead the caller
      // journalled — which the accepted publish itself made stale. Comparing first would raise
      // HeadMismatchError, and the caller would conclude its commit was lost when it landed:
      // exactly the confusion the key exists to prevent. The sequenceID returned may name a frame
      // that trim has since removed, and that is correct — the question a replay asks is "did my
      // publish land?", not "give me my frame".
      if (params.publishID != null) {
        const accepted = publishRecords.get(params.publishID)
        if (accepted !== undefined) {
          return accepted
        }
      }

      // The compare-and-set, before anything is minted or written. The head comparison, the
      // sequence mint, the append and the head advance are one indivisible step, and a loser
      // leaves the log, the head and the sequence exactly as it found them: no entry, no
      // delivery, no sequenceID consumed. Absent expectedHead, this is skipped entirely — an
      // unconditional publish is the fast path every mailbox frame takes.
      if (params.expectedHead !== undefined) {
        const head = heads.get(params.topicID) ?? null
        if (head !== params.expectedHead) {
          throw new HeadMismatchError(
            `Publish to ${params.topicID} expected head ${params.expectedHead ?? 'null'}, but the head is ${head ?? 'null'}`,
          )
        }
      }

      counter++
      const sequenceID = formatSequenceID(counter)
      if (params.publishID != null) {
        publishRecords.set(params.publishID, sequenceID)
      }

      // Only a log publish moves the head. A head naming a mailbox frame is a head that the
      // frame's own last ack deletes, leaving readers of the log a head they can never reach.
      if (retain === 'log') {
        heads.set(params.topicID, sequenceID)
      }

      // Recipients = current subscribers minus the sender.
      const recipients = new Set<string>()
      const subscribers = subscriptions.get(params.topicID)
      if (subscribers != null) {
        for (const subscriberDID of subscribers.keys()) {
          if (subscriberDID !== params.senderDID) recipients.add(subscriberDID)
        }
      }

      // A mailbox frame with no recipients has already been read by everyone who was going to
      // read it. A log frame is kept regardless: its reader may not exist yet.
      if (retain === 'mailbox' && recipients.size === 0) {
        return sequenceID
      }

      const entry: LogEntry = {
        sequenceID,
        senderDID: params.senderDID,
        topicID: params.topicID,
        payload: params.payload,
        storedAt: Date.now(),
        retain,
        pendingFor: recipients,
      }
      entries.set(sequenceID, entry)

      let log = topicLogs.get(params.topicID)
      if (log == null) {
        log = []
        topicLogs.set(params.topicID, log)
      }
      log.push(sequenceID)

      for (const recipientDID of recipients) {
        let list = deliveries.get(recipientDID)
        if (list == null) {
          list = []
          deliveries.set(recipientDID, list)
        }
        list.push(sequenceID)
      }

      // Depth bound: a trim like any other, so it moves oldest and leaves head alone.
      while (log.length > maxDepth) {
        removeEntry(log[0])
      }

      return sequenceID
    },

    async fetch(params: FetchParams): Promise<FetchResult> {
      if (params.ack != null && params.ack.length > 0) {
        for (const sequenceID of params.ack) {
          dropDelivery(params.recipientDID, sequenceID)
        }
      }

      const pending = deliveries.get(params.recipientDID)
      if (pending == null || pending.length === 0) {
        return { messages: [], cursor: null }
      }

      let startIndex = 0
      if (params.after != null) {
        const afterIndex = pending.indexOf(params.after)
        if (afterIndex !== -1) {
          startIndex = afterIndex + 1
        }
      }

      const available = pending.slice(startIndex)
      const limit = params.limit ?? available.length
      const selected = available.slice(0, limit)
      const hasMore = available.length > limit

      const resultMessages: Array<StoredMessage> = []
      for (const sequenceID of selected) {
        const entry = entries.get(sequenceID)
        if (entry != null) {
          resultMessages.push({
            sequenceID: entry.sequenceID,
            senderDID: entry.senderDID,
            topicID: entry.topicID,
            payload: entry.payload,
          })
        }
      }

      const cursor =
        resultMessages.length > 0 ? resultMessages[resultMessages.length - 1].sequenceID : null

      const result: FetchResult = { messages: resultMessages, cursor }
      if (hasMore) {
        result.hasMore = true
      }
      return result
    },

    async fetchTopic(params: FetchTopicParams): Promise<FetchTopicResult> {
      if (!subscriptions.get(params.topicID)?.has(params.subscriberDID)) {
        throw new NotSubscribedError(
          `${params.subscriberDID} is not a subscriber of ${params.topicID}`,
        )
      }

      // A topic's LOG is its log-class frames, and nothing else. A mailbox frame published
      // to a log topic is still delivered — push is untouched — but it never enters the
      // log: it does not move the head, so a reader that saw one would hold a cursor
      // naming a position the head can never reach, and every compare-and-set anchored on
      // that cursor would lose forever. The class decides what the log is, and only the
      // publisher's own `retain` sets the class.
      const log = (topicLogs.get(params.topicID) ?? []).filter(
        (sequenceID) => entries.get(sequenceID)?.retain === 'log',
      )
      const after = params.after
      // Filter to the class BEFORE the limit: a page of mailbox frames must not eat the
      // caller's limit and hand back an empty page while log frames are still waiting —
      // a caller that drains until a short page would stop early and strand itself.
      const selected = after == null ? log : log.filter((sequenceID) => sequenceID > after)
      const limited = params.limit == null ? selected : selected.slice(0, params.limit)

      const messages: Array<StoredMessage> = []
      for (const sequenceID of limited) {
        const entry = entries.get(sequenceID)
        if (entry != null) {
          messages.push({
            sequenceID: entry.sequenceID,
            senderDID: entry.senderDID,
            topicID: entry.topicID,
            payload: entry.payload,
          })
        }
      }

      return {
        messages,
        head: heads.get(params.topicID) ?? null,
        oldest: log.length > 0 ? log[0] : null,
      }
    },

    async trim(params: TrimParams): Promise<void> {
      const log = topicLogs.get(params.topicID)
      if (log == null) return
      for (const sequenceID of [...log]) {
        if (sequenceID < params.before) {
          removeEntry(sequenceID)
        }
      }
    },

    async ack(params: AckParams): Promise<void> {
      for (const sequenceID of params.sequenceIDs) {
        dropDelivery(params.recipientDID, sequenceID)
      }
    },

    async purge(params: PurgeParams): Promise<Array<string>> {
      // The age bound, for both classes: the same removal path, the same invariants — head is
      // untouched.
      const now = Date.now()
      const purgedIDs: Array<string> = []
      for (const [sequenceID, entry] of entries) {
        const retention = retentionOf(entry.topicID, params.olderThan)
        if (entry.storedAt <= now - retention * 1000) {
          purgedIDs.push(sequenceID)
        }
      }
      for (const sequenceID of purgedIDs) {
        removeEntry(sequenceID)
      }
      if (purgedIDs.length > 0) {
        await events.emit('purge', { sequenceIDs: purgedIDs })
      }
      return purgedIDs
    },

    async subscribe(params: SubscribeParams): Promise<void> {
      const requested = params.retention ?? defaultRetention
      if (requested > maxRetention) {
        throw new RetentionExceededError(
          `Requested retention of ${requested}s exceeds the maximum of ${maxRetention}s`,
        )
      }
      let subscribers = subscriptions.get(params.topicID)
      if (subscribers == null) {
        subscribers = new Map()
        subscriptions.set(params.topicID, subscribers)
      }
      subscribers.set(params.subscriberDID, requested)
    },

    async unsubscribe(subscriberDID: string, topicID: string): Promise<void> {
      const subscribers = subscriptions.get(topicID)
      if (subscribers != null) {
        subscribers.delete(subscriberDID)
        if (subscribers.size === 0) {
          subscriptions.delete(topicID)
        }
      }
      // Drops this subscriber's pending deliveries for the topic — freeing a mailbox frame whose
      // last delivery this was, and leaving a log frame standing.
      const pending = deliveries.get(subscriberDID)
      if (pending != null) {
        for (const sequenceID of [...pending]) {
          if (entries.get(sequenceID)?.topicID === topicID) {
            dropDelivery(subscriberDID, sequenceID)
          }
        }
      }
    },

    async getSubscribers(topicID: string): Promise<Array<string>> {
      const subscribers = subscriptions.get(topicID)
      return subscribers == null ? [] : [...subscribers.keys()]
    },

    async storeKeyPackage(ownerDID: string, keyPackage: string): Promise<void> {
      let packages = keyPackages.get(ownerDID)
      if (packages == null) {
        packages = []
        keyPackages.set(ownerDID, packages)
      }
      packages.push(keyPackage)
    },

    async fetchKeyPackages(ownerDID: string, count?: number): Promise<Array<string>> {
      const packages = keyPackages.get(ownerDID)
      if (packages == null || packages.length === 0) return []
      const n = count ?? 1
      return packages.splice(0, n)
    },
  }
}
