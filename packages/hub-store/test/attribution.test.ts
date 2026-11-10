import { afterEach, describe, expect, test } from 'vitest'

import { createHubStoreDefinition, getHubStore } from '../src/index.js'
import { hubStoreMigrations } from '../src/migrations.js'
import { backends, hubTables } from './databases.js'

describe.each(backends())('hub attribution ($name)', (backend) => {
  afterEach(() => backend.cleanup())

  async function openStore() {
    const db = await backend.open()
    db.register(createHubStoreDefinition())
    return { db, store: await getHubStore(db) }
  }

  test('publish records size and attribution', async () => {
    const { db, store } = await openStore()
    const result = await store.publish({
      senderDID: 'sender',
      topicID: 'topic',
      retain: 'log',
      payload: new Uint8Array([0, 128, 255]),
      attribution: { account: 'account', actor: 'actor', via: 'delegated' },
    })
    expect(result).toMatchObject({ deduped: false, outcome: 'inserted', storedBytes: 3 })
    const tables = await hubTables(db)
    expect(await tables.selectFrom('hub_messages').selectAll().execute()).toEqual([
      expect.objectContaining({
        payload_size: 3,
        account: 'account',
        actor: 'actor',
        via: 'delegated',
      }),
    ])
  })

  test('deduplicated outcome never adds stored bytes, including after trim', async () => {
    const { store } = await openStore()
    const params = {
      senderDID: 'sender',
      topicID: 'topic',
      retain: 'log' as const,
      payload: new Uint8Array([1, 2]),
      publishID: 'publish',
    }
    const first = await store.publish(params)
    expect(await store.publish(params)).toEqual({
      sequenceID: first.sequenceID,
      deduped: true,
      outcome: 'deduplicated',
      storedBytes: 0,
    })
    await store.trim({ topicID: 'topic', before: `${first.sequenceID}0` })
    expect(await store.publish(params)).toMatchObject({ outcome: 'deduplicated', storedBytes: 0 })
    expect(await store.occupancy()).toEqual([])
  })

  test('mailbox with no recipients stores no bytes', async () => {
    const { store } = await openStore()
    expect(
      await store.publish({ senderDID: 'sender', topicID: 'topic', payload: new Uint8Array([1]) }),
    ).toMatchObject({ deduped: false, outcome: 'no-recipients', storedBytes: 0 })
    expect(await store.occupancy()).toEqual([])
  })

  test('occupancy groups by account actor via and counts each frame once', async () => {
    const { store } = await openStore()
    for (const subscriberDID of ['recipient-1', 'recipient-2']) {
      await store.subscribe({ subscriberDID, topicID: 'topic' })
    }
    for (const [actor, via] of [
      ['actor', 'direct'],
      ['actor', 'group'],
      ['other', 'direct'],
    ] as const) {
      await store.publish({
        senderDID: 'sender',
        topicID: 'topic',
        payload: new Uint8Array([1, 2]),
        attribution: { account: 'account', actor, via },
      })
    }
    await store.publish({
      senderDID: 'sender',
      topicID: 'other-topic',
      retain: 'log',
      payload: new Uint8Array([3]),
      attribution: { account: 'account', actor: 'actor', via: 'direct' },
    })
    await store.publish({
      senderDID: 'sender',
      topicID: 'topic',
      payload: new Uint8Array(),
      attribution: { account: 'other-account', actor: 'actor', via: 'direct' },
    })
    const rows = await store.occupancy()
    expect(rows).toHaveLength(4)
    expect(rows).toEqual(
      expect.arrayContaining([
        { account: 'account', actor: 'actor', via: 'direct', bytes: 3, frames: 2 },
        { account: 'account', actor: 'actor', via: 'group', bytes: 2, frames: 1 },
        { account: 'account', actor: 'other', via: 'direct', bytes: 2, frames: 1 },
        { account: 'other-account', actor: 'actor', via: 'direct', bytes: 0, frames: 1 },
      ]),
    )
  })

  test('unattributed publishes attribute to sender', async () => {
    const { store } = await openStore()
    await store.publish({
      senderDID: 'sender',
      topicID: 'topic',
      retain: 'log',
      payload: new Uint8Array([1]),
    })
    expect(await store.occupancy()).toEqual([
      { account: 'sender', actor: 'sender', via: 'direct', bytes: 1, frames: 1 },
    ])
  })

  test('legacy rows attribute to sender and migration backfills binary length', async () => {
    const reopen = await backend.createReopenable()
    const db = reopen()
    const definition = createHubStoreDefinition()
    db.register({
      ...definition,
      migrations: (ctx) =>
        Object.fromEntries(
          Object.entries(hubStoreMigrations(ctx)).filter(([name]) => name === '0-init'),
        ),
    })
    await getHubStore(db)
    const tables = await hubTables(db)
    await tables
      .insertInto('hub_messages')
      .values({
        sequence_id: 'legacy',
        sender_did: 'legacy-sender',
        topic_id: 'topic',
        payload: new Uint8Array([0, 128, 255]),
        stored_at: 0,
        retain: 'log',
      })
      .execute()
    await db.close()
    const upgraded = reopen()
    upgraded.register(createHubStoreDefinition())
    const store = await getHubStore(upgraded)
    expect(await store.occupancy()).toEqual([
      { account: 'legacy-sender', actor: 'legacy-sender', via: 'direct', bytes: 3, frames: 1 },
    ])
  })

  test('storeID is stable across reopen and distinct for independent stores', async () => {
    const reopen = await backend.createReopenable()
    const db = reopen()
    db.register(createHubStoreDefinition())
    const store = await getHubStore(db)
    const [first, concurrent] = await Promise.all([store.storeID(), store.storeID()])
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(concurrent).toBe(first)
    await db.close()
    const reopened = reopen()
    reopened.register(createHubStoreDefinition())
    expect(await (await getHubStore(reopened)).storeID()).toBe(first)
    expect(await (await openStore()).store.storeID()).not.toBe(first)
  })
})
