import type { EventEmitter } from '@sozai/event'

/** Opaque message stored by the hub — minimal metadata for routing only. */
export type StoredMessage = {
  /**
   * Minted by the STORE inside the accepting transaction, never by the calling process — a
   * process-held counter collides across two hubs on one database (survivable for a mailbox,
   * fatal for a head, since the head IS a sequenceID). Lexicographically ordered and strictly
   * increasing within a topic: fixed-width zero-padded, not a bare decimal (`"10" < "9"`) or a
   * UUID — either breaks every comparison the design makes (`expectedHead` equality; `head`,
   * `oldest`, and `after` as cursors).
   */
  sequenceID: string
  senderDID: string
  topicID: string
  payload: Uint8Array
  /**
   * Where this frame sits in its TOPIC'S LOG — the position a `fetchTopic` reader would meet it at,
   * and therefore the only value a reader's log cursor may be moved to.
   *
   * Present exactly when the frame is log-class, and ABSENT otherwise. A mailbox frame has no place
   * in any log, so there is nothing to report: an empty string or a zero would be a lie a cursor
   * acts on, and a cursor moved to a position the log does not contain skips every frame between it
   * and the real one, permanently and silently.
   *
   * It exists because a PUSHED frame otherwise says only where it sits in this recipient's delivery
   * queue, which is a different sequence — it runs across every subscribed topic, skips the
   * recipient's own frames, and is emptied by acking. A recipient that must advance a log cursor
   * over a frame it was pushed can neither derive this nor infer it; the store is the one party that
   * knows, because it assigned both. See `@kumiai/rpc`'s `cursor.ts` for the two brands.
   */
  logPosition?: string
}

export type PublishParams = {
  senderDID: string
  topicID: string
  payload: Uint8Array
  /**
   * Compare-and-set on the topic's head. Absent: append unconditionally. Present: append only if
   * the current head is exactly this value, where `null` means "the topic has never had an
   * accepted log publish". On mismatch, throw HeadMismatchError and store NOTHING — no log entry,
   * no delivery row, no sequenceID consumed, no event. A store that appends then throws is broken
   * (it still passes a test checking only for the throw).
   *
   * The head is a sequenceID, minted only by the store, so a member cannot choose it or wedge the
   * lane with a bogus head token.
   */
  expectedHead?: string | null
  /**
   * Idempotency key. Republishing an already-accepted publishID returns its original sequenceID
   * with `deduped: true` and appends nothing: no entry, no delivery row, no sequenceID consumed,
   * no event, no live fan-out. It is what makes a peer's restart replay work, so:
   *
   * - The `publishID` -> `sequenceID` record is **not a log entry**. `trim` and `purge` MUST NOT
   *   remove it; its retention is its own and strictly longer than the log's (indefinite is
   *   recommended — it is one key/sequenceID per conditional publish). Hanging the key off the
   *   message row is wrong: trim deletes it with the frame, and the replay silently becomes an
   *   ordinary new publish.
   * - The returned sequenceID may name an already-trimmed frame. Correct: a replay asks "did my
   *   publish land?", not "give me my frame".
   * - The dedup check happens **before** the `expectedHead` comparison. A replay carries a stale
   *   `expectedHead` by construction (the publish it replays is what moved the head), so a store
   *   that compares first raises HeadMismatchError and tells the caller its commit was lost when
   *   it landed.
   */
  publishID?: string
  /**
   * Retention class. 'mailbox' (default): the frame is removed once every delivery is acked,
   * or when it ages out. 'log': the frame is retained unconditionally and removed only by
   * trim, because a subscriber that must read it may not exist when it is published.
   */
  retain?: 'log' | 'mailbox'
}

export type PublishResult = {
  /**
   * The sequenceID the publish was accepted as. On a `publishID` replay it is the ORIGINAL
   * publish's sequenceID, which may name an already-trimmed frame.
   */
  sequenceID: string
  /**
   * True iff this call matched an already-accepted `publishID` and appended nothing (no entry,
   * delivery row, sequenceID, or event). The hub reads it to gate live fan-out: a deduped publish
   * MUST NOT be re-delivered — every current subscriber has already seen the original, and the
   * sequenceID it names may already be acked and gone. False on an ordinary accepted publish.
   */
  deduped: boolean
}

export type SubscribeParams = {
  subscriberDID: string
  topicID: string
  /**
   * Requested retention in seconds for this subscriber's view. Absent: the hub's default. Above
   * the hub's maximum: RetentionExceededError at subscribe time — never a silent downgrade to the
   * maximum, which would strand a peer that believed it had asked for more. A topic's frames live
   * for the longest retention any subscriber asked for, floored at the hub's default.
   */
  retention?: number
}

/**
 * Read a topic's log. The log is its `retain: 'log'` frames and **nothing else**: a mailbox
 * publish to the same topic is delivered normally but never appears here.
 *
 * The exclusion is load-bearing. A mailbox frame does not move the head, so a reader that met one
 * in the log would advance its cursor to a position the head can never equal, and every
 * compare-and-set anchored there would lose forever — on a frame that is not even retained. The
 * class is the publisher's to choose, so a store that serves mailbox frames from the log lets any
 * member permanently wedge every writer on the topic with a single publish.
 */
export type FetchTopicParams = {
  /** Authorization: the caller must be a current subscriber of topicID, or NotSubscribedError. */
  subscriberDID: string
  topicID: string
  /**
   * Exclusive cursor: log messages after this sequenceID. Absent: from the oldest retained.
   * `limit` counts log frames — applying it before filtering the class would hand a draining
   * reader an empty page while log frames still waited, and it would stop.
   */
  after?: string
  limit?: number
}

export type FetchTopicResult = {
  messages: Array<StoredMessage>
  /**
   * The topic's current head: the sequenceID of the last accepted `retain: 'log'` publish, or
   * null. A mailbox publish does NOT move the head — a head naming a mailbox frame is deleted by
   * that frame's own last ack, anchoring the CAS to a frame no reader of the log can pull.
   *
   * The head is **stored state, not a projection of the log**: it outlives every frame, so a
   * `trim` or `purge` that empties the log leaves it still naming the last accepted publish. A
   * host that derives it (`SELECT max(sequenceID) WHERE topic=? AND retain='log'`) passes every
   * single-connection test, then returns null the first time a log ages out — a peer reads that
   * null, CASes `expectedHead: null`, wins, and forks the group. Recomputing the head does not
   * satisfy this contract however green the tests are.
   */
  head: string | null
  /** The oldest sequenceID still retained for this topic, or null if the log is empty. */
  oldest: string | null
  // No `hasMore` / paging cursor by design: a reader draining by `after` terminates on the
  // (`head`, `oldest`) pair this result already carries (both survive a trim). It is caught up
  // once its last seen sequenceID equals `head`; against a fully-trimmed topic (`head` set,
  // `oldest` null) it reads forward from null. `hasMore` would widen the store contract, the wire
  // response, and every host/test for a signal `head`/`oldest` already give.
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
   * Remove `retain: 'log'` frames with sequenceID strictly below this bound, and **only** those.
   * A mailbox frame on the same topic is delivery-derived (freed by its last ack or by age) and
   * `trim` never touches it: a DELETE scoped to the whole topic rather than the log class silently
   * drops pending mail below the bound.
   *
   * Depth-vs-age policy is the host's, chosen via this value; the contract fixes only the
   * invariant — trim moves `oldest`, never touches `head`, never removes a `publishID` record. Any
   * depth/count bound a host layers on must count log-class frames only: a member can publish a
   * mailbox frame to a log topic, so counting mailbox frames lets that member evict the log with a
   * flood.
   */
  before: string
}

/**
 * The `purge` event is the age sweep's notification, and the ONLY removal event the store emits —
 * it lets a host observe scheduled, asynchronous expiry it did not initiate. `trim` and depth
 * eviction stay silent: both are the synchronous consequence of a caller's own action, so the
 * caller already knows what left. A host layering more deleters keeps this rule (only the age
 * sweep is observable), so a listener can read every `purge` as "the clock removed these", never
 * "someone trimmed".
 */
export type HubStoreEvents = {
  purge: { sequenceIDs: Array<string> }
}

/**
 * The hub's storage contract: a per-topic log alongside a per-recipient mailbox.
 *
 * Retention is a **class** (declared per publish) and a **duration** (requested per subscribe);
 * they are independent.
 *
 * - `'mailbox'` (the default) is delivery-derived: readers are known at publish time, so the last
 *   ack frees the frame.
 * - `'log'` is not: a subscriber that must read a frame may not exist when it is published, so no
 *   refcount over current subscribers can free it. It is appended whether or not anyone is
 *   subscribed, and `trim` alone removes it — never `ack`, never `unsubscribe`. `trim` moves
 *   `oldest`, never touches `head`, never removes a `publishID` record. Any depth/count bound a
 *   host layers on must count log-class frames only — a mailbox frame shares the topic but not the
 *   log, so counting it lets any member evict the log with a mailbox flood.
 * - The `head` is **stored state, not a projection of the log**: it names the last accepted log
 *   publish and outlives every frame, so it stands when `trim` or `purge` empties the log. A host
 *   that recomputes it returns null the moment the log empties, and a peer reading that null CASes
 *   `expectedHead: null`, wins, and forks the group.
 * - Removing a log entry removes the deliveries that pointed at it: a delivery references a log
 *   entry, does not own it, and cannot be pushed once its referent is gone.
 * - `purge` enforces age for both classes under the same invariants as `trim`. A topic's frames
 *   live for the longest retention any CURRENT subscriber asked for, floored at the hub's default.
 *   Because that window tracks current subscribers, it can shrink: a topic momentarily holding no
 *   long-retention subscriber (all unsubscribed, or none re-subscribed yet after a restart)
 *   collapses to the hub default, and a `purge` landing in that gap removes frames a returning
 *   subscriber was entitled to keep. A host needing a floor no transient gap can lower must set
 *   the hub default high enough, or not `purge` topics whose readers reconnect.
 * - `sequenceID`s are lexicographically ordered and strictly increasing within a topic
 *   (fixed-width zero-padded, not a bare decimal or UUID) and minted by the STORE inside the
 *   transaction, not by the calling process.
 * - `publish` checks `publishID` for a replay, then compares `expectedHead`, mints the sequenceID,
 *   appends, and advances the head — in ONE transaction, in that order. A read-then-write CAS is
 *   the exact race the head exists to eliminate; three statements against a scalar head does not
 *   satisfy this contract, however green its single-connection tests.
 * - The `publishID` dedup record is **not a log entry**: no deleter may reach it, its retention is
 *   its own (indefinite recommended), and it outlives the frame it names.
 *
 * Verified by the conformance suite in `@kumiai/hub-conformance`.
 */
export type HubStore = {
  events: EventEmitter<HubStoreEvents>
  publish(params: PublishParams): Promise<PublishResult>
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
