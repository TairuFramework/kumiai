import type { EventEmitter } from '@sozai/event'

/** Opaque message stored by the hub — minimal metadata for routing only. */
export type StoredMessage = {
  sequenceID: string
  senderDID: string
  topicID: string
  payload: Uint8Array
}

export type PublishParams = {
  senderDID: string
  topicID: string
  payload: Uint8Array
  /**
   * Compare-and-set on the topic's head. Absent: append unconditionally. Present: append
   * only if the topic's current head is exactly this value, where `null` means "the topic
   * has never had an accepted publish". On mismatch, throw HeadMismatchError and store
   * nothing.
   */
  expectedHead?: string | null
  /**
   * Idempotency key. Republishing an already-accepted publishID returns its original
   * sequenceID instead of appending again. Its record has its OWN retention — it is not a
   * log entry and MUST NOT be removed by trim.
   */
  publishID?: string
}

export type FetchTopicParams = {
  /** Authorization: the caller must be a current subscriber of topicID, or NotSubscribedError. */
  subscriberDID: string
  topicID: string
  /** Exclusive cursor: messages after this sequenceID. Absent: from the oldest retained. */
  after?: string
  limit?: number
}

export type FetchTopicResult = {
  messages: Array<StoredMessage>
  /** The topic's current head: the sequenceID of the last accepted publish, or null. */
  head: string | null
  /** The oldest sequenceID still retained for this topic, or null if the log is empty. */
  oldest: string | null
}

export type FetchParams = {
  recipientDID: string
  after?: string
  limit?: number
  ack?: Array<string>
}

export type FetchResult = {
  messages: Array<StoredMessage>
  cursor: string | null
  hasMore?: boolean
}

export type AckParams = {
  recipientDID: string
  sequenceIDs: Array<string>
}

export type PurgeParams = {
  olderThan: number
}

export type TrimParams = {
  topicID: string
  /**
   * Remove log entries with sequenceID strictly below this bound. Depth-versus-age retention
   * policy is the host's, layered on top by choosing this value — the contract fixes only the
   * invariant: trim moves `oldest`, never touches `head`, and never removes a `publishID`
   * dedup record.
   */
  before: string
}

export type HubStoreEvents = {
  purge: { sequenceIDs: Array<string> }
}

/**
 * The hub's storage contract: a per-topic log alongside a per-recipient mailbox.
 *
 * - Messages are retained per topic, independently of delivery: a publish is appended to the
 *   topic's log whether or not anyone is subscribed. The log is the system of record.
 * - Delivery rows govern push only. `ack` deletes a delivery, never a log entry.
 * - `trim` is the only thing that removes a log entry. It moves `oldest`, never touches `head`,
 *   and never removes a `publishID` dedup record. `purge` is the separate mailbox/expiry
 *   surface — it governs delivery rows, not the log.
 * - `sequenceID`s are lexicographically ordered and strictly increasing within a topic — a
 *   fixed-width zero-padded encoding, not a bare decimal and not a UUID.
 * - `publish` mints the sequenceID, compares `expectedHead`, appends, and advances the head in
 *   ONE transaction. A read-then-write compare-and-set is a race and does not satisfy this.
 *
 * Implementations are verified by the conformance suite exported from
 * `@kumiai/hub-protocol/conformance`.
 */
export type HubStore = {
  events: EventEmitter<HubStoreEvents>
  publish(params: PublishParams): Promise<string>
  fetch(params: FetchParams): Promise<FetchResult>
  fetchTopic(params: FetchTopicParams): Promise<FetchTopicResult>
  ack(params: AckParams): Promise<void>
  purge(params: PurgeParams): Promise<Array<string>>
  trim(params: TrimParams): Promise<void>
  subscribe(subscriberDID: string, topicID: string): Promise<void>
  unsubscribe(subscriberDID: string, topicID: string): Promise<void>
  getSubscribers(topicID: string): Promise<Array<string>>
  storeKeyPackage(ownerDID: string, keyPackage: string): Promise<void>
  fetchKeyPackages(ownerDID: string, count?: number): Promise<Array<string>>
}
