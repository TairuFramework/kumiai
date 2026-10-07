import type { HozonDB } from '@hozon/db'
import { HeadMismatchError, type HubStore } from '@kumiai/hub-protocol'
import { afterEach, describe, expect, test } from 'vitest'

import { createHubStoreDefinition, getHubStore, type HubStoreOptions } from '../src/index.js'
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
  async function freshStores(
    count: number,
    options: HubStoreOptions = {},
  ): Promise<Array<HubStore>> {
    if (postgres == null) throw new Error('Postgres is unavailable')
    const open = await postgres.createReopenable()
    const definition = createHubStoreDefinition({ maxRetention: 3600, ...options })
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

  // Publish locks the topic row (head write) and then evicts frames; trim and purge used to delete
  // frames and then write the topic row, the opposite order, which Postgres aborts as a deadlock.
  test('log publishes with depth eviction run alongside trim and purge without deadlock', async () => {
    const [publisher, sweeper] = await freshStores(2, { maxDepth: 2 })
    if (publisher == null || sweeper == null) throw new Error('expected two stores')
    const topicID = 'topic:sweep'
    const publishCount = 1500

    let publishing = true
    const sweeping = (async () => {
      const failures: Array<unknown> = []
      while (publishing) {
        try {
          await sweeper.trim({ topicID, before: '999999999999' })
          await sweeper.purge({ olderThan: 0 })
        } catch (error) {
          failures.push(error)
          if (failures.length >= 5) break
        }
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
      return failures
    })()

    const publishFailures: Array<unknown> = []
    for (let start = 0; start < publishCount; start += 25) {
      const batch = await Promise.allSettled(
        Array.from({ length: 25 }, (_, i) => {
          return publisher.publish({
            senderDID: 'did:publisher',
            topicID,
            payload: new Uint8Array([(start + i) % 256]),
            retain: 'log',
          })
        }),
      )
      for (const result of batch) {
        if (result.status === 'rejected') publishFailures.push(result.reason)
      }
    }
    publishing = false

    expect(publishFailures).toEqual([])
    expect(await sweeping).toEqual([])
  }, 120000)
})
