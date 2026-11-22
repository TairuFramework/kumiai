import { HozonDB, type Kysely, sql } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { afterEach, describe, expect, test } from 'vitest'

import { createHubStoreDefinition, getHubStore } from '../src/index.js'
import { hubStoreMigrations } from '../src/migrations.js'
import type { HubTables } from '../src/tables.js'
import { backends, hubTables } from './databases.js'

async function migrated(): Promise<{ db: HozonDB; tables: Kysely<HubTables> }> {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  db.register(createHubStoreDefinition())
  await getHubStore(db)
  return { db, tables: await hubTables(db) }
}

describe('hub migrations', () => {
  test('attribution extends the initial schema with a new migration', () => {
    const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
    const migrations = hubStoreMigrations({
      tablePrefix: 'hozon',
      kind: adapter.kind,
      types: adapter.types,
      functions: adapter.functions,
    })
    expect(Object.keys(migrations).sort()).toEqual([
      '0-init',
      '1-attribution',
      '2-subscription-generation',
    ])
  })

  test('a fresh database carries the columns the folded migrations used to add', async () => {
    const { db, tables } = await migrated()
    await tables
      .insertInto('hub_publish_ids')
      .values({ topic_id: 't', publish_id: 'p', sequence_id: 's', recorded_at: 1 })
      .execute()
    await tables
      .insertInto('hub_key_packages')
      .values({ owner_did: 'did:test:a', key_package: 'kp', not_after: 42 })
      .execute()
    await tables
      .insertInto('hub_last_resort_key_packages')
      .values({ owner_did: 'did:test:a', key_package: 'kp-lr' })
      .execute()

    const rows = await tables.selectFrom('hub_key_packages').selectAll().execute()
    expect(rows[0]?.not_after).toBe(42)
    await db.close()
  })

  test('indexes support topic scans, subscriber quotas and publish-id expiry', async () => {
    const { db, tables } = await migrated()
    try {
      const indexes = [
        ['hozon_hub_messages_topic', ['topic_id', 'retain', 'sequence_id']],
        ['hozon_hub_subscriptions_subscriber', ['subscriber_did']],
        ['hozon_hub_publish_ids_recorded', ['recorded_at']],
      ] as const
      for (const [name, columns] of indexes) {
        const result = await sql<{ name: string }>`PRAGMA index_info(${sql.lit(name)})`.execute(
          tables,
        )
        expect(result.rows.map((row) => row.name)).toEqual(columns)
      }
    } finally {
      await db.close()
    }
  })

  test('the last-resort slot holds one package per owner', async () => {
    const { db, tables } = await migrated()
    await tables
      .insertInto('hub_last_resort_key_packages')
      .values({ owner_did: 'did:test:a', key_package: 'kp-1' })
      .execute()
    // The primary key is what enforces one slot per owner: a second plain insert fails.
    await expect(
      tables
        .insertInto('hub_last_resort_key_packages')
        .values({ owner_did: 'did:test:a', key_package: 'kp-2' })
        .execute(),
    ).rejects.toThrow()
    await db.close()
  })
})

// Apply only the old migrations first, using Hozon's real migration ledger and prefixing.
describe.each(backends())('subscription migration ($name)', (backend) => {
  afterEach(() => backend.cleanup())
  test('upgrades existing subscriptions without losing deliveries or reusing their generation', async () => {
    const open = await backend.createReopenable()
    const legacy = open()
    const definition = createHubStoreDefinition()
    legacy.register({
      ...definition,
      migrations(ctx) {
        const migrations = hubStoreMigrations(ctx)
        delete migrations['2-subscription-generation']
        return migrations
      },
    })
    const tables = await hubTables(legacy)
    await tables
      .insertInto('hub_subscriptions')
      .values({ topic_id: 't', subscriber_did: 'did:test:reader', last_active_at: 1 })
      .execute()
    await tables
      .insertInto('hub_messages')
      .values({
        sequence_id: '000000000001',
        sender_did: 'did:test:sender',
        topic_id: 't',
        payload: new Uint8Array([1]),
        stored_at: 1,
        retain: 'mailbox',
      })
      .execute()
    await tables
      .insertInto('hub_deliveries')
      .values({ sequence_id: '000000000001', recipient_did: 'did:test:reader' })
      .execute()
    await legacy.close()
    const db = open()
    db.register(definition)
    const store = await getHubStore(db)
    const upgraded = await hubTables(db)
    const row = await upgraded.selectFrom('hub_subscriptions').selectAll().executeTakeFirstOrThrow()
    expect(row.generation).toBe('0')
    expect((await store.fetch({ recipientDID: 'did:test:reader' })).messages).toHaveLength(1)
    const generation = await store.subscribe({ topicID: 't', subscriberDID: 'did:test:reader' })
    expect(
      await store.unsubscribe({
        topicID: 't',
        subscriberDID: 'did:test:reader',
        expectedGeneration: '0',
      }),
    ).toBe(false)
    expect((await store.fetch({ recipientDID: 'did:test:reader' })).messages).toHaveLength(1)
    expect(BigInt(generation)).toBeGreaterThan(0n)
  })
})
