import type { Adapter } from '@hozon/adapter'
import { withStoreTransaction } from '@hozon/db'
import {
  type AckParams,
  type CountKeyPackagesParams,
  type FetchKeyPackagesParams,
  type FetchLastResortKeyPackageParams,
  type FetchParams,
  type FetchResult,
  type FetchTopicParams,
  type FetchTopicResult,
  type GetSubscribersParams,
  HeadMismatchError,
  type HubStore,
  type HubStoreEvents,
  KeyPackageQuotaExceededError,
  NotSubscribedError,
  type PublishParams,
  type PublishResult,
  type PurgeParams,
  RetentionExceededError,
  type StoredMessage,
  type StoreKeyPackageParams,
  type StoreLastResortKeyPackageParams,
  type SubscribeParams,
  SubscriptionQuotaExceededError,
  type TrimParams,
  type UnsubscribeParams,
} from '@kumiai/hub-protocol'
import { EventEmitter } from '@sozai/event'
import type { Kysely } from 'kysely'

import type { HubTables } from './tables.js'

export type HubStoreOptions = {
  /** Hub default retention in seconds: the floor for a topic's age bound. Default 0. */
  defaultRetention?: number
  /**
   * Maximum retention in seconds a subscribe may request. A request above it is refused with
   * `RetentionExceededError`, never clamped. Absent: no maximum.
   */
  maxRetention?: number
  /**
   * Maximum retained LOG frames per topic, oldest evicted first. Counts log frames only, so a
   * mailbox flood cannot evict the commit log. Absent: unbounded.
   */
  maxDepth?: number
  /**
   * Maximum ordinary key packages one DID may hold. An upload past it is rejected, never evicted:
   * eviction would let a flood push a victim's live packages out. Default 100.
   */
  maxKeyPackagesPerDID?: number
  /** Maximum distinct topics one DID may subscribe to. Default 1000. */
  maxSubscriptionsPerDID?: number
}

/**
 * How long an idempotency record outlives its own publish, in seconds.
 *
 * A year: past this a repeated publish is treated as new, so the window must exceed any replay a
 * real client could still hold -- a parked commit, a device restored from backup, a lane retried
 * after an outage. Not a host-tuned knob.
 */
const PUBLISH_ID_RETENTION_SECONDS = 365 * 24 * 60 * 60

/** Frames deleted per statement: see `deleteFrames`. */
const DELETE_CHUNK_SIZE = 500

const DEFAULT_MAX_KEY_PACKAGES_PER_DID = 100
const DEFAULT_MAX_SUBSCRIPTIONS_PER_DID = 1000

// A DB binary column (a Buffer under node-postgres-style drivers) as a plain Uint8Array, so payload
// equality holds against a Uint8Array caller.
function toBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value as unknown as ArrayLike<number>)
}

// `not_after` is seconds; every other timestamp here is milliseconds.
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export function createHubStore(
  db: Kysely<HubTables>,
  adapter: Adapter,
  options: HubStoreOptions = {},
): HubStore {
  const defaultRetention = options.defaultRetention ?? 0
  const maxRetention = options.maxRetention
  const maxDepth = options.maxDepth
  const maxKeyPackagesPerDID = options.maxKeyPackagesPerDID ?? DEFAULT_MAX_KEY_PACKAGES_PER_DID
  const maxSubscriptionsPerDID = options.maxSubscriptionsPerDID ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_DID

  const events = new EventEmitter<HubStoreEvents>()

  // One snapshot for every read of a `fetchTopic`: under Postgres' default READ COMMITTED each
  // statement would see its own, and head, oldest, gap and messages could disagree.
  function readSnapshot<Result>(fn: (trx: Kysely<HubTables>) => Promise<Result>): Promise<Result> {
    return db.isTransaction
      ? fn(db)
      : db.transaction().setIsolationLevel('repeatable read').execute(fn)
  }

  /**
   * Remove frames and the deliveries pointing at them, a chunk at a time.
   *
   * SQLite binds one parameter per `in` element and throws "too many SQL variables" past its
   * limit, so an unchunked sweep fails precisely when the backlog is large. Deliveries first: a
   * delivery references a frame and cannot be pushed once its referent is gone.
   */
  async function deleteFrames(
    executor: Kysely<HubTables>,
    sequenceIDs: Array<string>,
  ): Promise<void> {
    for (let index = 0; index < sequenceIDs.length; index += DELETE_CHUNK_SIZE) {
      const chunk = sequenceIDs.slice(index, index + DELETE_CHUNK_SIZE)
      await executor.deleteFrom('hub_deliveries').where('sequence_id', 'in', chunk).execute()
      await executor.deleteFrom('hub_messages').where('sequence_id', 'in', chunk).execute()
    }
  }

  // Every log removal (trim, depth, age) advances the topic's removal watermark, which is what
  // `fetchTopic` reports a gap from. Monotonic: it never moves back.
  async function advanceRemovedThrough(
    executor: Kysely<HubTables>,
    topicID: string,
    sequenceID: string,
  ): Promise<void> {
    await executor
      .updateTable('hub_topics')
      .set({ removed_through: sequenceID })
      .where('topic_id', '=', topicID)
      .where((eb) => {
        return eb.or([eb('removed_through', 'is', null), eb('removed_through', '<', sequenceID)])
      })
      .execute()
  }

  // Mint the next sequenceID inside the accepting transaction, from a persistent global counter.
  // Fixed-width zero-padded so lexicographic order matches numeric order (`"10" > "9"`).
  //
  // One row, so every publish on every topic serialises behind it: the cost of a single total
  // order. It deadlocks nothing: every writer takes this row FIRST and per-topic rows after.
  async function nextSequenceID(trx: Kysely<HubTables>): Promise<string> {
    const row = await trx
      .updateTable('hub_sequence')
      .set((eb) => ({ counter: eb('counter', '+', 1) }))
      .where('id', '=', 0)
      .returning('counter')
      .executeTakeFirstOrThrow()
    return String(row.counter).padStart(12, '0')
  }

  // Depth eviction runs inside the publishing transaction. Counts LOG frames only. Silent: it is a
  // synchronous consequence of the caller's own publish.
  async function evictDepth(trx: Kysely<HubTables>, topicID: string): Promise<void> {
    if (maxDepth == null) return
    const logRows = await trx
      .selectFrom('hub_messages')
      .select('sequence_id')
      .where('topic_id', '=', topicID)
      .where('retain', '=', 'log')
      .orderBy('sequence_id', 'asc')
      .execute()
    if (logRows.length <= maxDepth) return
    const evict = logRows.slice(0, logRows.length - maxDepth).map((r) => r.sequence_id)
    await deleteFrames(trx, evict)
    await advanceRemovedThrough(trx, topicID, evict[evict.length - 1] as string)
  }

  async function publish(publishParams: PublishParams): Promise<PublishResult> {
    const retain = publishParams.retain ?? 'mailbox'
    const { senderDID, topicID } = publishParams

    // The dedup check, the head compare-and-set, the sequence mint, the append, and the head
    // advance all happen in ONE transaction, in that order. A read-then-write CAS split across
    // statements is the exact race the head exists to eliminate.
    return await withStoreTransaction(db, async (trx) => {
      // 1. Dedup, BEFORE the CAS. A replay carries a stale expectedHead by construction, so
      // comparing first would report a lost commit that actually landed.
      if (publishParams.publishID != null) {
        const existing = await trx
          .selectFrom('hub_publish_ids')
          .select('sequence_id')
          .where('topic_id', '=', topicID)
          .where('publish_id', '=', publishParams.publishID)
          .executeTakeFirst()
        if (existing != null) {
          return { sequenceID: existing.sequence_id, deduped: true }
        }
      }

      // 2. Stored head (null when the topic has never had an accepted log publish).
      const topicRow = await trx
        .selectFrom('hub_topics')
        .select('head')
        .where('topic_id', '=', topicID)
        .executeTakeFirst()
      const currentHead = topicRow?.head ?? null

      // 3. Compare-and-set. On mismatch, throw and store NOTHING: the transaction rolls back.
      if (publishParams.expectedHead !== undefined && currentHead !== publishParams.expectedHead) {
        throw new HeadMismatchError(
          `head mismatch: expected ${String(publishParams.expectedHead)}, current ${String(currentHead)}`,
        )
      }

      // 4. Mint the sequenceID.
      const sequenceID = await nextSequenceID(trx)

      // 5. Recipients = current subscribers minus the sender.
      const subscriberRows = await trx
        .selectFrom('hub_subscriptions')
        .select('subscriber_did')
        .where('topic_id', '=', topicID)
        .execute()
      const recipients = subscriberRows
        .map((r) => r.subscriber_did)
        .filter((did) => did !== senderDID)

      // 6. Append. A log frame is stored unconditionally (its reader may not exist yet). A mailbox
      // frame with zero recipients is not stored, but the sequenceID is still consumed.
      if (retain === 'log' || recipients.length > 0) {
        await trx
          .insertInto('hub_messages')
          .values({
            sequence_id: sequenceID,
            sender_did: senderDID,
            topic_id: topicID,
            payload: adapter.encodeBinary(publishParams.payload) as Uint8Array,
            stored_at: Date.now(),
            retain,
          })
          .execute()

        if (recipients.length > 0) {
          await trx
            .insertInto('hub_deliveries')
            .values(recipients.map((did) => ({ sequence_id: sequenceID, recipient_did: did })))
            .execute()
        }
      }

      // 7. Advance the stored head, LOG frames only.
      //
      // The earlier head read is only an MVCC snapshot, which two transactions racing at the same
      // head both pass. The arbiter is this CONDITIONAL write: the loser matches zero rows, throws,
      // and rolls the whole transaction back.
      if (retain === 'log') {
        if (publishParams.expectedHead === undefined) {
          // Unconditional: last-writer-wins on the head pointer.
          await trx
            .insertInto('hub_topics')
            .values({ topic_id: topicID, head: sequenceID })
            .onConflict((oc) => oc.column('topic_id').doUpdateSet({ head: sequenceID }))
            .execute()
        } else if (publishParams.expectedHead === null) {
          // Lose to any concurrent transaction that inserted the row first (conflict: 0 rows).
          const inserted = await trx
            .insertInto('hub_topics')
            .values({ topic_id: topicID, head: sequenceID })
            .onConflict((oc) => oc.column('topic_id').doNothing())
            .executeTakeFirst()
          if (Number(inserted.numInsertedOrUpdatedRows ?? 0n) === 0) {
            throw new HeadMismatchError(
              'head mismatch: expected null, a concurrent publish set the head first',
            )
          }
        } else {
          const updated = await trx
            .updateTable('hub_topics')
            .set({ head: sequenceID })
            .where('topic_id', '=', topicID)
            .where('head', '=', publishParams.expectedHead)
            .executeTakeFirst()
          if (Number(updated.numUpdatedRows ?? 0n) === 0) {
            throw new HeadMismatchError(
              `head mismatch: expected ${publishParams.expectedHead}, a concurrent publish advanced it`,
            )
          }
        }
        await evictDepth(trx, topicID)
      }

      // 8. Record the idempotency key in its own table.
      if (publishParams.publishID != null) {
        await trx
          .insertInto('hub_publish_ids')
          .values({
            topic_id: topicID,
            publish_id: publishParams.publishID,
            sequence_id: sequenceID,
            recorded_at: Date.now(),
          })
          .execute()
      }

      return { sequenceID, deduped: false }
    })
  }

  async function fetch(fetchParams: FetchParams): Promise<FetchResult> {
    if (fetchParams.ack != null && fetchParams.ack.length > 0) {
      await ack({ recipientDID: fetchParams.recipientDID, sequenceIDs: fetchParams.ack })
    }

    let query = db
      .selectFrom('hub_deliveries')
      .innerJoin('hub_messages', 'hub_messages.sequence_id', 'hub_deliveries.sequence_id')
      .select([
        'hub_messages.sequence_id',
        'hub_messages.sender_did',
        'hub_messages.topic_id',
        'hub_messages.payload',
        'hub_messages.retain',
      ])
      .where('hub_deliveries.recipient_did', '=', fetchParams.recipientDID)
      .orderBy('hub_messages.sequence_id', 'asc')

    if (fetchParams.after != null) {
      query = query.where('hub_messages.sequence_id', '>', fetchParams.after)
    }

    const limit = fetchParams.limit
    if (limit != null) {
      // One extra row decides `hasMore`.
      query = query.limit(limit + 1)
    }

    const rows = await query.execute()

    let hasMore = false
    let resultRows = rows
    if (limit != null && rows.length > limit) {
      hasMore = true
      resultRows = rows.slice(0, limit)
    }

    // One global sequence serves both classes, so a log frame's own sequenceID IS its log
    // position. Omitted for a mailbox frame: a falsy placeholder is a position a cursor would move
    // to, skipping every log frame below it.
    const messages: Array<StoredMessage> = resultRows.map((row) => ({
      sequenceID: row.sequence_id,
      senderDID: row.sender_did,
      topicID: row.topic_id,
      payload: toBytes(row.payload),
      ...(row.retain === 'log' ? { logPosition: row.sequence_id } : {}),
    }))

    const cursor = messages.at(-1)?.sequenceID ?? null

    return { messages, cursor, hasMore }
  }

  async function fetchTopic(fetchParams: FetchTopicParams): Promise<FetchTopicResult> {
    const { subscriberDID, topicID, after } = fetchParams

    return await readSnapshot(async (trx) => {
      const subscription = await trx
        .selectFrom('hub_subscriptions')
        .select('subscriber_did')
        .where('topic_id', '=', topicID)
        .where('subscriber_did', '=', subscriberDID)
        .executeTakeFirst()
      if (subscription == null) {
        throw new NotSubscribedError(`${subscriberDID} is not subscribed to ${topicID}`)
      }

      const topicRow = await trx
        .selectFrom('hub_topics')
        .select(['head', 'removed_through'])
        .where('topic_id', '=', topicID)
        .executeTakeFirst()
      const head = topicRow?.head ?? null
      const removedThrough = topicRow?.removed_through ?? null

      const oldestRow = await trx
        .selectFrom('hub_messages')
        .select((eb) => eb.fn.min('sequence_id').as('oldest'))
        .where('topic_id', '=', topicID)
        .where('retain', '=', 'log')
        .executeTakeFirst()
      const oldest = (oldestRow?.oldest as string | null | undefined) ?? null

      // The log is the topic's log-class frames and NOTHING else. `limit` applies after the class
      // filter, so a page of mailbox frames cannot hand a draining reader an empty page.
      let query = trx
        .selectFrom('hub_messages')
        .select(['sequence_id', 'sender_did', 'topic_id', 'payload'])
        .where('topic_id', '=', topicID)
        .where('retain', '=', 'log')
        .orderBy('sequence_id', 'asc')
      if (after != null) {
        query = query.where('sequence_id', '>', after)
      }
      if (fetchParams.limit != null) {
        query = query.limit(fetchParams.limit)
      }
      const rows = await query.execute()

      const messages: Array<StoredMessage> = rows.map((row) => ({
        sequenceID: row.sequence_id,
        senderDID: row.sender_did,
        topicID: row.topic_id,
        payload: toBytes(row.payload),
        logPosition: row.sequence_id,
      }))

      // Removal is prefix-only, so a watermark past the cursor means frames the reader never saw
      // are gone.
      const gap = removedThrough != null && (after == null || removedThrough > after)

      return { messages, head, oldest, gap }
    })
  }

  async function ack(ackParams: AckParams): Promise<void> {
    if (ackParams.sequenceIDs.length === 0) return

    await db
      .deleteFrom('hub_deliveries')
      .where('recipient_did', '=', ackParams.recipientDID)
      .where('sequence_id', 'in', ackParams.sequenceIDs)
      .execute()

    // GC fully-acked MAILBOX frames only. Ack frees a delivery, never a log entry or the head.
    const withDeliveries = await db
      .selectFrom('hub_deliveries')
      .select('sequence_id')
      .where('sequence_id', 'in', ackParams.sequenceIDs)
      .execute()

    const stillDelivered = new Set(withDeliveries.map((r) => r.sequence_id))
    const fullyAcked = ackParams.sequenceIDs.filter((id) => !stillDelivered.has(id))

    if (fullyAcked.length > 0) {
      await db
        .deleteFrom('hub_messages')
        .where('sequence_id', 'in', fullyAcked)
        .where('retain', '=', 'mailbox')
        .execute()
    }
  }

  async function trim(trimParams: TrimParams): Promise<void> {
    // LOG frames strictly below the bound, and only those. The head and the publishID records are
    // never touched.
    await withStoreTransaction(db, async (trx) => {
      const logRows = await trx
        .selectFrom('hub_messages')
        .select('sequence_id')
        .where('topic_id', '=', trimParams.topicID)
        .where('retain', '=', 'log')
        .where('sequence_id', '<', trimParams.before)
        .orderBy('sequence_id', 'asc')
        .execute()

      const sequenceIDs = logRows.map((r) => r.sequence_id)
      if (sequenceIDs.length === 0) return

      await deleteFrames(trx, sequenceIDs)
      await advanceRemovedThrough(trx, trimParams.topicID, sequenceIDs.at(-1) as string)
    })
  }

  async function purge(purgeParams: PurgeParams): Promise<Array<string>> {
    const now = Date.now()
    const olderThan = purgeParams.olderThan

    const removed = await withStoreTransaction(db, async (trx) => {
      // Idempotency records outlive the frames they dedup, on their own clock. Without this sweep
      // the table is the fastest-growing on a long-lived hub.
      await trx
        .deleteFrom('hub_publish_ids')
        .where('recorded_at', '<=', now - PUBLISH_ID_RETENTION_SECONDS * 1000)
        .execute()

      const topicRows = await trx.selectFrom('hub_messages').select('topic_id').distinct().execute()

      // Every topic's longest CURRENT subscriber retention in one grouped read.
      const retentionRows = await trx
        .selectFrom('hub_subscriptions')
        .select((eb) => ['topic_id', eb.fn.max('retention').as('maxRetention')])
        .groupBy('topic_id')
        .execute()
      const retentionByTopic = new Map(
        retentionRows.map((row) => [row.topic_id, Number(row.maxRetention ?? 0)]),
      )

      const removedIDs: Array<string> = []
      for (const { topic_id } of topicRows) {
        const subscriberRetention = retentionByTopic.get(topic_id) ?? 0
        const effective = Math.max(olderThan, subscriberRetention, defaultRetention)
        const threshold = now - effective * 1000

        // Log removal is prefix-only by position. A clock that moved backwards can leave a due
        // frame above one that is not; removing it would punch a hole a cursor cannot see.
        const keptRow = await trx
          .selectFrom('hub_messages')
          .select((eb) => eb.fn.min('sequence_id').as('firstKept'))
          .where('topic_id', '=', topic_id)
          .where('retain', '=', 'log')
          .where('stored_at', '>', threshold)
          .executeTakeFirst()
        const firstKept = (keptRow?.firstKept as string | null | undefined) ?? null

        const frames = await trx
          .selectFrom('hub_messages')
          .select(['sequence_id', 'retain'])
          .where('topic_id', '=', topic_id)
          .where((eb) => {
            return eb.or([
              eb.and([eb('retain', '=', 'mailbox'), eb('stored_at', '<=', threshold)]),
              firstKept == null
                ? eb('retain', '=', 'log')
                : eb.and([eb('retain', '=', 'log'), eb('sequence_id', '<', firstKept)]),
            ])
          })
          .orderBy('sequence_id', 'asc')
          .execute()
        if (frames.length === 0) continue

        const ids = frames.map((frame) => frame.sequence_id)
        removedIDs.push(...ids)
        await deleteFrames(trx, ids)
        const lastLog = frames.findLast((frame) => frame.retain === 'log')
        if (lastLog != null) {
          await advanceRemovedThrough(trx, topic_id, lastLog.sequence_id)
        }
      }
      return removedIDs.sort()
    })

    if (removed.length === 0) return []
    await events.emit('purge', { sequenceIDs: removed })
    return removed
  }

  async function deleteExpiredKeyPackages(ownerDID: string): Promise<void> {
    await db
      .deleteFrom('hub_key_packages')
      .where('owner_did', '=', ownerDID)
      .where('not_after', 'is not', null)
      .where('not_after', '<=', nowSeconds())
      .execute()
  }

  async function storeKeyPackage({
    ownerDID,
    keyPackage,
    notAfter,
  }: StoreKeyPackageParams): Promise<void> {
    // Drop the dead BEFORE charging the cap. The cap rejects rather than evicts, so nothing else
    // would ever remove them, and a pool full of expired entries could never be replenished.
    await deleteExpiredKeyPackages(ownerDID)
    const row = await db
      .selectFrom('hub_key_packages')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('owner_did', '=', ownerDID)
      .executeTakeFirst()
    if (Number(row?.count ?? 0) >= maxKeyPackagesPerDID) {
      throw new KeyPackageQuotaExceededError(
        `DID ${ownerDID} exceeds the maximum of ${maxKeyPackagesPerDID} stored key packages`,
      )
    }
    await db
      .insertInto('hub_key_packages')
      .values({ owner_did: ownerDID, key_package: keyPackage, not_after: notAfter ?? null })
      .execute()
  }

  async function fetchKeyPackages({
    ownerDID,
    count,
  }: FetchKeyPackagesParams): Promise<Array<string>> {
    // Expired entries are DELETED first, not filtered after the limit: a run of dead rows would
    // otherwise consume the whole page while live packages waited behind them.
    await deleteExpiredKeyPackages(ownerDID)
    // Atomic delete-returning: a select+delete pair would let two concurrent fetches return the
    // same key package twice.
    const rows = await db
      .deleteFrom('hub_key_packages')
      .where(
        'id',
        'in',
        db
          .selectFrom('hub_key_packages')
          .select('id')
          .where('owner_did', '=', ownerDID)
          .orderBy('id', 'asc')
          .limit(count ?? 1),
      )
      .returning('key_package')
      .execute()

    return rows.map((r) => r.key_package)
  }

  async function countKeyPackages({ ownerDID }: CountKeyPackagesParams): Promise<number> {
    const row = await db
      .selectFrom('hub_key_packages')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('owner_did', '=', ownerDID)
      .where((eb) => eb.or([eb('not_after', 'is', null), eb('not_after', '>', nowSeconds())]))
      .executeTakeFirst()
    return Number(row?.count ?? 0)
  }

  async function storeLastResortKeyPackage({
    ownerDID,
    keyPackage,
  }: StoreLastResortKeyPackageParams): Promise<void> {
    await db
      .insertInto('hub_last_resort_key_packages')
      .values({ owner_did: ownerDID, key_package: keyPackage })
      .onConflict((oc) => {
        return oc
          .column('owner_did')
          .doUpdateSet({ key_package: (eb) => eb.ref('excluded.key_package') })
      })
      .execute()
  }

  async function fetchLastResortKeyPackage({
    ownerDID,
  }: FetchLastResortKeyPackageParams): Promise<string | null> {
    // Never consumes: the package carries MLS's `last_resort` extension, so serving it twice is
    // the availability floor rather than the init-key reuse `fetchKeyPackages` prevents.
    const row = await db
      .selectFrom('hub_last_resort_key_packages')
      .select('key_package')
      .where('owner_did', '=', ownerDID)
      .executeTakeFirst()
    return row?.key_package ?? null
  }

  async function subscribe(subscribeParams: SubscribeParams): Promise<void> {
    const { subscriberDID, topicID } = subscribeParams
    // Refused, never clamped: a peer that believed it had asked for more would be stranded.
    if (
      subscribeParams.retention != null &&
      maxRetention != null &&
      subscribeParams.retention > maxRetention
    ) {
      throw new RetentionExceededError(
        `requested retention ${subscribeParams.retention} exceeds the hub maximum ${maxRetention}`,
      )
    }
    const retention = subscribeParams.retention ?? defaultRetention

    // Charged on NEW rows only: refusing a refresh would strand a subscriber at the cap on every
    // reconnect.
    const held = await db
      .selectFrom('hub_subscriptions')
      .select('topic_id')
      .where('subscriber_did', '=', subscriberDID)
      .execute()
    if (!held.some((row) => row.topic_id === topicID) && held.length >= maxSubscriptionsPerDID) {
      throw new SubscriptionQuotaExceededError(
        `DID ${subscriberDID} exceeds the maximum of ${maxSubscriptionsPerDID} subscriptions`,
      )
    }
    // Upsert, so re-subscribing refreshes the activity timestamp and retention rather than failing
    // or duplicating.
    await db
      .insertInto('hub_subscriptions')
      .values({
        topic_id: topicID,
        subscriber_did: subscriberDID,
        last_active_at: Date.now(),
        retention,
      })
      .onConflict((oc) => {
        return oc.columns(['topic_id', 'subscriber_did']).doUpdateSet({
          last_active_at: (eb) => eb.ref('excluded.last_active_at'),
          retention: (eb) => eb.ref('excluded.retention'),
        })
      })
      .execute()
  }

  async function unsubscribe({ subscriberDID, topicID }: UnsubscribeParams): Promise<void> {
    await db
      .deleteFrom('hub_subscriptions')
      .where('topic_id', '=', topicID)
      .where('subscriber_did', '=', subscriberDID)
      .execute()

    // A delivery operation, not a trim: drop this subscriber's pending deliveries for the topic and
    // GC any MAILBOX frame left without a recipient. Log frames and the head are never touched.
    const pending = await db
      .selectFrom('hub_deliveries')
      .innerJoin('hub_messages', 'hub_messages.sequence_id', 'hub_deliveries.sequence_id')
      .select('hub_deliveries.sequence_id')
      .where('hub_deliveries.recipient_did', '=', subscriberDID)
      .where('hub_messages.topic_id', '=', topicID)
      .execute()

    if (pending.length === 0) return
    const sequenceIDs = pending.map((r) => r.sequence_id)

    await db
      .deleteFrom('hub_deliveries')
      .where('recipient_did', '=', subscriberDID)
      .where('sequence_id', 'in', sequenceIDs)
      .execute()

    const remaining = await db
      .selectFrom('hub_deliveries')
      .select('sequence_id')
      .where('sequence_id', 'in', sequenceIDs)
      .execute()

    const stillDelivered = new Set(remaining.map((r) => r.sequence_id))
    const orphaned = sequenceIDs.filter((id) => !stillDelivered.has(id))

    if (orphaned.length > 0) {
      await db
        .deleteFrom('hub_messages')
        .where('sequence_id', 'in', orphaned)
        .where('retain', '=', 'mailbox')
        .execute()
    }
  }

  async function getSubscribers({ topicID }: GetSubscribersParams): Promise<Array<string>> {
    const rows = await db
      .selectFrom('hub_subscriptions')
      .select('subscriber_did')
      .where('topic_id', '=', topicID)
      .execute()
    return rows.map((r) => r.subscriber_did)
  }

  return {
    events,
    publish,
    fetch,
    fetchTopic,
    ack,
    purge,
    trim,
    storeKeyPackage,
    fetchKeyPackages,
    countKeyPackages,
    storeLastResortKeyPackage,
    fetchLastResortKeyPackage,
    subscribe,
    unsubscribe,
    getSubscribers,
  }
}
