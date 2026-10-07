import type { Kysely, Migration, MigrationContext } from '@hozon/db'

import type { HubTables } from './tables.js'

export function hubStoreMigrations(ctx: MigrationContext): Record<string, Migration> {
  const t = ctx.types
  const p = ctx.tablePrefix
  return {
    '0-init': {
      async up(db) {
        await db.schema
          .createTable('hub_messages')
          .addColumn('sequence_id', t.text, (col) => col.notNull().primaryKey())
          .addColumn('sender_did', t.text, (col) => col.notNull())
          .addColumn('topic_id', t.text, (col) => col.notNull())
          .addColumn('payload', t.binary, (col) => col.notNull())
          .addColumn('stored_at', t.bigint, (col) => col.notNull())
          .addColumn('retain', t.text, (col) => col.notNull().defaultTo('mailbox'))
          .execute()
        await db.schema
          .createIndex(`${p}_hub_messages_topic`)
          .on('hub_messages')
          .columns(['topic_id', 'retain', 'sequence_id'])
          .execute()

        await db.schema
          .createTable('hub_deliveries')
          .addColumn('sequence_id', t.text, (col) => col.notNull())
          .addColumn('recipient_did', t.text, (col) => col.notNull())
          .addPrimaryKeyConstraint(`${p}_hub_deliveries_pk`, ['sequence_id', 'recipient_did'])
          .execute()
        await db.schema
          .createIndex(`${p}_hub_deliveries_recipient`)
          .on('hub_deliveries')
          .column('recipient_did')
          .execute()

        await db.schema
          .createTable('hub_key_packages')
          .addColumn('id', t.serial, (col) => col.primaryKey())
          .addColumn('owner_did', t.text, (col) => col.notNull())
          .addColumn('key_package', t.text, (col) => col.notNull())
          .addColumn('not_after', t.bigint)
          .execute()
        await db.schema
          .createIndex(`${p}_hub_key_packages_owner`)
          .on('hub_key_packages')
          .column('owner_did')
          .execute()

        // The primary key is what holds "one last-resort slot per owner".
        await db.schema
          .createTable('hub_last_resort_key_packages')
          .addColumn('owner_did', t.text, (col) => col.notNull().primaryKey())
          .addColumn('key_package', t.text, (col) => col.notNull())
          .execute()

        await db.schema
          .createTable('hub_subscriptions')
          .addColumn('topic_id', t.text, (col) => col.notNull())
          .addColumn('subscriber_did', t.text, (col) => col.notNull())
          .addColumn('last_active_at', t.bigint, (col) => col.notNull().defaultTo(0))
          .addColumn('retention', t.bigint, (col) => col.notNull().defaultTo(0))
          .addPrimaryKeyConstraint(`${p}_hub_subscriptions_pk`, ['topic_id', 'subscriber_did'])
          .execute()
        await db.schema
          .createIndex(`${p}_hub_subscriptions_subscriber`)
          .on('hub_subscriptions')
          .columns(['subscriber_did'])
          .execute()

        await db.schema
          .createTable('hub_topics')
          .addColumn('topic_id', t.text, (col) => col.notNull().primaryKey())
          .addColumn('head', t.text, (col) => col.notNull())
          .addColumn('removed_through', t.text)
          .execute()

        // Persisted, not derived from surviving frames, so emptying a topic never regresses
        // minting below a head the topic still names. Global, so a sequenceID is unique across
        // topics and the mailbox fetch stays globally ordered.
        await db.schema
          .createTable('hub_sequence')
          .addColumn('id', t.bigint, (col) => col.notNull().primaryKey())
          .addColumn('counter', t.bigint, (col) => col.notNull())
          .execute()
        // Through the query builder, not raw SQL, so the table prefix applies.
        await (db as Kysely<HubTables>)
          .insertInto('hub_sequence')
          .values({ id: 0, counter: 0 })
          .execute()

        await db.schema
          .createTable('hub_publish_ids')
          .addColumn('topic_id', t.text, (col) => col.notNull())
          .addColumn('publish_id', t.text, (col) => col.notNull())
          .addColumn('sequence_id', t.text)
          .addColumn('recorded_at', t.bigint, (col) => col.notNull().defaultTo(0))
          .addPrimaryKeyConstraint(`${p}_hub_publish_ids_pk`, ['topic_id', 'publish_id'])
          .execute()
        await db.schema
          .createIndex(`${p}_hub_publish_ids_recorded`)
          .on('hub_publish_ids')
          .columns(['recorded_at'])
          .execute()
      },
      async down(db) {
        await db.schema.dropTable('hub_publish_ids').execute()
        await db.schema.dropTable('hub_sequence').execute()
        await db.schema.dropTable('hub_topics').execute()
        await db.schema.dropTable('hub_subscriptions').execute()
        await db.schema.dropTable('hub_last_resort_key_packages').execute()
        await db.schema.dropTable('hub_key_packages').execute()
        await db.schema.dropTable('hub_deliveries').execute()
        await db.schema.dropTable('hub_messages').execute()
      },
    },
  }
}
