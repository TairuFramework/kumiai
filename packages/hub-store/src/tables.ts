import type { ColumnType } from '@hozon/db'

export type HubTables = {
  hub_messages: {
    sequence_id: string
    sender_did: string
    topic_id: string
    payload: Uint8Array
    stored_at: number
    // Retention class: 'log' (removed only by trim, depth or age) or 'mailbox'
    // (delivery-derived, freed by the last ack or by age).
    retain: string
  }
  hub_deliveries: {
    sequence_id: string
    recipient_did: string
  }
  hub_key_packages: {
    id: ColumnType<number, number | undefined, never>
    owner_did: string
    key_package: string
    // Expiry in SECONDS, unlike every millisecond column here. Null never expires.
    not_after: ColumnType<number | null, number | null | undefined, never>
  }
  // One reusable, uncapped package per owner, kept apart from the pool above so no
  // ordinary-pool query can reach it.
  hub_last_resort_key_packages: {
    owner_did: string
    key_package: string
  }
  hub_subscriptions: {
    topic_id: string
    subscriber_did: string
    last_active_at: number
    // Requested retention in seconds. Insert-optional: the column defaults to 0.
    retention: ColumnType<number, number | undefined, number>
  }
  // Per-topic stored state, never a projection of the surviving log.
  hub_topics: {
    topic_id: string
    // The sequenceID of the last accepted log publish.
    head: string
    // The highest log sequenceID ever removed, or null. Monotonic.
    removed_through: ColumnType<string | null, string | null | undefined, string | null>
  }
  // Persistent global monotonic sequence counter (singleton row id=0).
  hub_sequence: {
    id: number
    counter: number
  }
  // Idempotency records: their own table so no message deleter reaches them. Their retention is
  // their own, and long: see `PUBLISH_ID_RETENTION_SECONDS`.
  hub_publish_ids: {
    topic_id: string
    publish_id: string
    sequence_id: string | null
    recorded_at: number
  }
}
