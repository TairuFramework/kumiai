import type { EventEmitter } from '@sozai/event'

/** Opaque message stored by the hub — minimal metadata for routing only. */
export type StoredMessage = {
  /**
   * Minted by the STORE inside the accepting transaction, never by the caller — a process-held
   * counter collides across hubs on one database. Lexicographically ordered, strictly increasing
   * within a topic: fixed-width zero-padded, not a bare decimal or UUID, since `expectedHead`,
   * `head`, `oldest`, and `after` all compare it directly.
   */
  sequenceID: string
  senderDID: string
  topicID: string
  payload: Uint8Array
  /**
   * Where this frame sits in its topic's log — the only position a `fetchTopic` reader's cursor
   * may be moved to. Present exactly when the frame is log-class, absent otherwise: a mailbox
   * frame has no log position, and a fabricated one (empty string, zero) would send a cursor to a
   * position that silently skips real frames.
   *
   * Needed because a pushed frame's own sequence position is in the recipient's delivery queue — a
   * different number (spans every subscribed topic, skips the recipient's own sends, cleared by
   * acking) that the recipient can't derive. Only the store knows both. See `@kumiai/rpc`'s
   * `cursor.ts` for the two brands.
   */
  logPosition?: string
}

export type PublishParams = {
  senderDID: string
  topicID: string
  payload: Uint8Array
  /**
   * Compare-and-set on the topic's head. Absent: append unconditionally. Present: append only if
   * the current head equals this value (`null` means the topic has never had an accepted log
   * publish). On mismatch, throw HeadMismatchError and store NOTHING — no entry, delivery row,
   * sequenceID, or event.
   *
   * The head is minted only by the store, so a member cannot choose it or wedge the lane with a
   * bogus token.
   */
  expectedHead?: string | null
  /**
   * Idempotency key. Republishing an already-accepted publishID returns its original sequenceID
   * with `deduped: true` and appends nothing — what makes a peer's restart replay work.
   *
   * - The `publishID` -> `sequenceID` record is **not a log entry**: `trim`/`purge` must not
   *   remove it, and its retention (indefinite recommended) is its own, longer than the log's.
   *   Hanging it off the message row is wrong — trim would delete it with the frame, and the
   *   replay would silently become an ordinary new publish.
   * - The returned sequenceID may name an already-trimmed frame — a replay asks "did my publish
   *   land?", not "give me my frame".
   * - The dedup check runs **before** the `expectedHead` comparison: a replay's `expectedHead` is
   *   stale by construction, so comparing first would raise HeadMismatchError on a commit that
   *   actually landed.
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
   * The sequenceID the publish was accepted as. On a `publishID` replay, the ORIGINAL publish's
   * sequenceID — may name an already-trimmed frame.
   */
  sequenceID: string
  /**
   * True iff this call matched an already-accepted `publishID` and appended nothing. The hub reads
   * it to gate live fan-out: a deduped publish MUST NOT be re-delivered — every current subscriber
   * already saw the original, and its sequenceID may already be acked and gone.
   */
  deduped: boolean
}

export type SubscribeParams = {
  subscriberDID: string
  topicID: string
  /**
   * Requested retention in seconds for this subscriber's view. Absent: the hub's default. Above
   * the hub's maximum: RetentionExceededError at subscribe time — never a silent downgrade, which
   * would strand a peer that believed it had asked for more. A topic's frames live for the longest
   * retention any subscriber asked for, floored at the hub's default.
   */
  retention?: number
}

/**
 * Read a topic's log — its `retain: 'log'` frames and **nothing else**; a mailbox publish to the
 * same topic is delivered normally but never appears here.
 *
 * The exclusion is load-bearing: a mailbox frame doesn't move the head, so a reader that met one
 * in the log would advance its cursor to a position the head can never equal, losing every
 * compare-and-set anchored there — permanently, on a frame that isn't even retained. A store that
 * serves mailbox frames from the log lets any member wedge every writer on the topic with a single
 * publish.
 */
export type FetchTopicParams = {
  /** Authorization: the caller must be a current subscriber of topicID, or NotSubscribedError. */
  subscriberDID: string
  topicID: string
  /**
   * Exclusive cursor: log messages after this sequenceID. Absent: from the oldest retained.
   * `limit` counts log frames — applying it before filtering by class would hand a draining reader
   * an empty page (and stop it) while log frames still waited.
   */
  after?: string
  limit?: number
}

export type FetchTopicResult = {
  messages: Array<StoredMessage>
  /**
   * The topic's current head: the sequenceID of the last accepted `retain: 'log'` publish, or
   * null. A mailbox publish does NOT move the head — if it could, acking that frame would delete
   * the very value the CAS depends on.
   *
   * The head is **stored state, not a projection of the log**: it outlives every frame, so a
   * `trim` or `purge` that empties the log leaves it unchanged. A host that derives it instead
   * (`SELECT max(sequenceID) WHERE topic=? AND retain='log'`) passes single-connection tests, then
   * returns null the first time a log ages out — a peer reads that null, CASes
   * `expectedHead: null`, wins, and forks the group.
   */
  head: string | null
  /** The oldest sequenceID still retained for this topic, or null if the log is empty. */
  oldest: string | null
  // No `hasMore`/paging cursor by design: a reader draining by `after` terminates once its
  // last-seen sequenceID equals `head` (both `head`/`oldest` survive a trim); against a
  // fully-trimmed topic it reads forward from null.
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
  /** The hub's default retention in seconds: the age bound for a topic no subscriber asked to keep longer. */
  olderThan: number
}

export type TrimParams = {
  topicID: string
  /**
   * Remove `retain: 'log'` frames with sequenceID strictly below this bound, and **only** those —
   * `trim` never touches a mailbox frame on the same topic (freed by its own last ack or by age);
   * a DELETE scoped to the whole topic would silently drop pending mail.
   *
   * Depth-vs-age policy is the host's; the contract fixes only the invariant — trim moves
   * `oldest`, never touches `head`, never removes a `publishID` record. Any depth/count bound a
   * host layers on must count log-class frames only, or a member could evict the log with a
   * mailbox flood.
   */
  before: string
}

/**
 * The `purge` event is the ONLY removal event the store emits — it lets a host observe scheduled,
 * asynchronous expiry it did not initiate. `trim` and depth eviction stay silent, since both are
 * the synchronous consequence of the caller's own action. A host layering more deleters should
 * keep this rule, so a listener can read every `purge` as clock-driven, never caller-driven.
 */
export type HubStoreEvents = {
  purge: { sequenceIDs: Array<string> }
}

/**
 * The hub's storage contract: a per-topic log alongside a per-recipient mailbox. Retention is a
 * **class** (declared per publish) and a **duration** (requested per subscribe), independent of
 * each other — see `PublishParams.retain`, `FetchTopicResult.head`, and `TrimParams.before` above
 * for the mailbox/log split, head semantics, and trim invariants this contract holds together.
 *
 * - `publish` checks `publishID` for a replay, then compares `expectedHead`, mints the
 *   sequenceID, appends, and advances the head — in ONE transaction, in that order. A
 *   read-then-write CAS reintroduces the exact race the head exists to eliminate; three separate
 *   statements against a scalar head does not satisfy this contract, however green its
 *   single-connection tests.
 * - Removing a log entry removes the deliveries that pointed at it: a delivery references a log
 *   entry, does not own it, and cannot be pushed once its referent is gone.
 * - `purge` enforces age for both classes under the same invariants as `trim`. A topic's frames
 *   live for the longest retention any CURRENT subscriber asked for, floored at the hub's
 *   default — and because that window tracks current subscribers, it can shrink: a topic
 *   momentarily holding no long-retention subscriber collapses to the hub default, and a `purge`
 *   landing in that gap removes frames a returning subscriber was entitled to keep. A host needing
 *   a floor no transient gap can lower must set the hub default high enough, or not `purge` topics
 *   whose readers reconnect.
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
