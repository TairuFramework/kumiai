import type { EventEmitter } from '@sozai/event'

/** Opaque message stored by the hub — minimal metadata for routing only. */
export type StoredMessage = {
  /**
   * Minted by the store, inside the transaction that accepts the publish — never by the calling
   * process. Lexicographically ordered and strictly increasing within a topic: byte-comparable,
   * so a fixed-width zero-padded encoding. A bare decimal (`"10" < "9"`) or a UUID satisfies the
   * type and silently breaks every comparison the design makes on it — `expectedHead` equality,
   * `head` and `oldest` against a cursor, `after` as an exclusive cursor. A counter held in the
   * process rather than the store collides across two hub processes on one database: survivable
   * for a mailbox, fatal for a head, because the head IS a sequenceID.
   */
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
   * has never had an accepted log publish". On mismatch, throw HeadMismatchError and store
   * nothing: no log entry, no delivery row, no sequenceID consumed, no event emitted. A store
   * that appends and then throws satisfies a test that only checks for the throw, and is broken.
   *
   * The head is hub-assigned — it is a sequenceID, which only the store mints — so a member
   * cannot choose it, and cannot wedge the lane by publishing a bogus head token.
   */
  expectedHead?: string | null
  /**
   * Idempotency key. Republishing an already-accepted publishID returns its original sequenceID
   * and appends nothing: no entry, no delivery row, no sequenceID consumed, no event. This is
   * what makes a peer's restart replay work, so:
   *
   * - The `publishID` -> `sequenceID` record is **not a log entry**. `trim` and `purge` MUST NOT
   *   remove it. Its retention is its own, and strictly longer than the log's — retaining it
   *   indefinitely is the recommended implementation, since it is a key and a sequenceID, one per
   *   conditional publish. Hanging the key off the message row is the natural implementation and
   *   it is wrong: trim deletes the record with the frame, and the replay silently becomes an
   *   ordinary new publish.
   * - The returned sequenceID may name a frame that has since been trimmed. That is correct: a
   *   replay asks "did my publish land?", not "give me my frame".
   * - The dedup check happens **before** the `expectedHead` comparison. A replay carries a stale
   *   `expectedHead` by construction — the accepted publish it is replaying is what moved the
   *   head — so a store that compares first raises HeadMismatchError and tells the caller its
   *   commit was lost when it landed.
   */
  publishID?: string
  /**
   * Retention class. 'mailbox' (default): the frame is removed once every delivery is acked,
   * or when it ages out. 'log': the frame is retained unconditionally and removed only by
   * trim, because a subscriber that must read it may not exist when it is published.
   */
  retain?: 'log' | 'mailbox'
}

export type SubscribeParams = {
  subscriberDID: string
  topicID: string
  /**
   * Requested retention in seconds for this subscriber's view of the topic. Absent: the hub's
   * default. Above the hub's maximum: RetentionExceededError, at subscribe time — never a
   * silent downgrade to the maximum, which would strand a peer that believed it had asked for
   * more. A topic's frames live for the longest retention any of its subscribers asked for,
   * floored at the hub's default.
   */
  retention?: number
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
  /**
   * The topic's current head: the sequenceID of the last accepted `retain: 'log'` publish, or
   * null. A mailbox publish mints a sequenceID and appends, but does NOT move the head — a head
   * naming a mailbox frame is a head that the frame's own last ack deletes, anchoring the
   * compare-and-set to a frame no reader of the log can ever pull.
   */
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
  /**
   * The hub's default retention in seconds: the age bound applied to a topic no subscriber
   * asked to keep for longer.
   */
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
 * Retention is a **class**, declared per publish, and a **duration**, requested per subscribe.
 * They are independent.
 *
 * - The `'mailbox'` class is delivery-derived: its readers are known at publish time, so the
 *   last ack frees the frame. It is the default.
 * - The `'log'` class is not: a subscriber that must read a frame may not exist when it is
 *   published, so no refcount over current subscribers can ever free it. It is appended whether
 *   or not anyone is subscribed, and `trim` is the only thing that removes it — never `ack`,
 *   never `unsubscribe`. `trim` moves `oldest`, never touches `head`, and never removes a
 *   `publishID` dedup record.
 * - Removing a log entry removes the deliveries that pointed at it: a delivery references a log
 *   entry and does not own it, and it cannot be pushed once its referent is gone.
 * - `purge` is the age enforcement for both classes, honouring the same invariants as `trim`. A
 *   topic's frames live for the longest retention any of its subscribers asked for, floored at
 *   the hub's default.
 * - `sequenceID`s are lexicographically ordered and strictly increasing within a topic — a
 *   fixed-width zero-padded encoding, not a bare decimal and not a UUID — and they are minted by
 *   the STORE, inside the transaction, not by the calling process.
 * - `publish` checks `publishID` for a replay, then compares `expectedHead`, mints the sequenceID,
 *   appends, and advances the head — in ONE transaction, and in that order. A read-then-write
 *   compare-and-set is a race — precisely the race the head exists to eliminate — and a host that
 *   reads "the head is a scalar" and implements it as three statements does not satisfy this
 *   contract, however green its single-connection tests are.
 * - The `publishID` dedup record is **not a log entry**: no deleter may reach it, its retention is
 *   its own (indefinite is recommended), and it outlives the frame it names.
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
  subscribe(params: SubscribeParams): Promise<void>
  unsubscribe(subscriberDID: string, topicID: string): Promise<void>
  getSubscribers(topicID: string): Promise<Array<string>>
  storeKeyPackage(ownerDID: string, keyPackage: string): Promise<void>
  fetchKeyPackages(ownerDID: string, count?: number): Promise<Array<string>>
}
