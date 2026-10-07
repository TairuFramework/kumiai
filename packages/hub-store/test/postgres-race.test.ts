import type { HozonDB } from '@hozon/db'
import { HeadMismatchError, type HubStore } from '@kumiai/hub-protocol'
import { afterEach, describe, expect, test } from 'vitest'

import { createHubStoreDefinition, getHubStore } from '../src/index.js'
import { backends } from './databases.js'

// The atomicity clause the in-process conformance suite cannot prove: a single-connection SQLite
// store serialises every transaction on its one connection, so a read-then-write CAS still passes.
// Only concurrent transactions over SEPARATE connections against a real database exercise the head
// comparison, sequence mint, append, and head advance happening in one transaction. Each publisher
// below holds its own connection pool, as two hub processes on one database would.
const postgres = backends().find((backend) => backend.name === 'postgres')

describe.skipIf(postgres == null)('HubStore CAS atomicity (separate Postgres connections)', () => {
  afterEach(async () => {
    await postgres?.cleanup()
  })

  // N stores on one fresh database, each on its own pool.
  async function freshStores(count: number): Promise<Array<HubStore>> {
    if (postgres == null) throw new Error('Postgres is unavailable')
    const open = await postgres.createReopenable()
    const definition = createHubStoreDefinition({ maxRetention: 3600 })
    const dbs: Array<HozonDB> = []
    for (let i = 0; i < count; i++) {
      const db = open()
      db.register(definition)
      dbs.push(db)
    }
    // Migrate through one connection before the others open the store.
    const stores: Array<HubStore> = []
    for (const db of dbs) {
      stores.push(await getHubStore(db))
    }
    return stores
  }

  test('N publishers racing at the same head: exactly one append is accepted', async () => {
    const N = 8
    const stores = await freshStores(N + 1)
    const topicID = 'topic:race'
    const seeder = stores[N]
    if (seeder == null) throw new Error('expected a seeder store')

    // Seed a first log frame so the head is a concrete value, not null.
    const seed = await seeder.publish({
      senderDID: 'did:seed',
      topicID,
      payload: new Uint8Array([0]),
      retain: 'log',
      expectedHead: null,
    })
    const head0 = seed.sequenceID

    // N stores publish concurrently, each expecting head0. Exactly one may win.
    const results = await Promise.allSettled(
      stores.slice(0, N).map((store, i) => {
        return store.publish({
          senderDID: `did:racer-${i}`,
          topicID,
          payload: new Uint8Array([i + 1]),
          retain: 'log',
          expectedHead: head0,
        })
      }),
    )

    const accepted = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(accepted).toHaveLength(1)
    expect(rejected).toHaveLength(N - 1)
    // Every loser fails specifically on the CAS, not on some other error.
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(HeadMismatchError)
    }

    // The log holds exactly the seed plus the single winner, and the head names the winner.
    await seeder.subscribe({ subscriberDID: 'did:reader', topicID })
    const topic = await seeder.fetchTopic({ subscriberDID: 'did:reader', topicID })
    expect(topic.messages).toHaveLength(2)
    const winnerSeq = (accepted[0] as PromiseFulfilledResult<{ sequenceID: string }>).value
      .sequenceID
    expect(topic.head).toBe(winnerSeq)
    expect(topic.messages[1]?.sequenceID).toBe(winnerSeq)
  }, 30000)
})
