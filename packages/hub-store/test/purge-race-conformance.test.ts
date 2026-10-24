import type { Kysely } from '@hozon/db'
import { sql } from '@hozon/db'
import { testHubStorePurgeRaceConformance } from '@kumiai/hub-conformance'
import type { HubStore } from '@kumiai/hub-protocol'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'

import { createHubStoreDefinition, getHubStore } from '../src/index.js'
import { createHubStore } from '../src/store.js'
import type { HubTables } from '../src/tables.js'
import { backends, hubTables } from './databases.js'

const postgres = backends().find((backend) => backend.name === 'postgres')

describe.skipIf(postgres == null)('purge race (separate Postgres connections)', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))
  afterEach(async () => {
    vi.useRealTimers()
    await postgres?.cleanup()
  })

  testHubStorePurgeRaceConformance({
    setTime: (milliseconds) => vi.setSystemTime(milliseconds),
    createHarness: async () => {
      if (postgres == null) throw new Error('Postgres is unavailable')
      const open = await postgres.createReopenable()
      const readerDB = open()
      const purgerDB = open()
      const publisherDB = open()
      const definition = createHubStoreDefinition({ defaultRetention: 0 })
      for (const db of [readerDB, purgerDB, publisherDB]) db.register(definition)
      const reader = await getHubStore(readerDB)
      const purgerTables = await hubTables(purgerDB)
      const publisherTables = await hubTables(publisherDB)
      const readerTables = await hubTables(readerDB)
      const table = purgerTables
        .selectFrom('hub_messages')
        .select('sequence_id')
        .compile()
        .sql.match(/from "([^"]+)"/)?.[1]
      if (table == null) throw new Error('Expected a prefixed messages table')
      const reached = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      let paused = false
      const selected = new WeakSet<object>()
      const plugin: Parameters<Kysely<HubTables>['withPlugin']>[0] = {
        transformQuery({ node, queryId }) {
          const encoded = JSON.stringify(node)
          if (
            node.kind === 'SelectQueryNode' &&
            encoded.includes(`"name":"${table}"`) &&
            encoded.includes('"func":"min"')
          )
            selected.add(queryId)
          return node
        },
        async transformResult({ queryId, result }) {
          if (selected.has(queryId) && !paused) {
            paused = true
            reached.resolve()
            await released.promise
          }
          return result
        },
      }
      const purger = createHubStore({
        db: purgerTables.withPlugin(plugin),
        adapter: purgerDB.adapter,
        options: { defaultRetention: 0 },
      })
      const publisherReady = Promise.withResolvers<{ store: HubStore; pid: number }>()
      const publisherClosed = Promise.withResolvers<void>()
      const connection = publisherTables.connection().execute(async (db) => {
        const pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db)).rows[0]
          ?.pid
        if (pid == null) throw new Error('Expected publisher backend PID')
        publisherReady.resolve({ store: createHubStore({ db, adapter: publisherDB.adapter }), pid })
        await publisherClosed.promise
      })
      void connection.catch(publisherReady.reject)
      const { store: publisher, pid } = await publisherReady.promise
      return {
        purger,
        publisher,
        reader,
        cut: { reached: reached.promise, release: () => released.resolve() },
        publisherSettled: async (publication) => {
          let completed = false
          void publication.then(
            () => {
              completed = true
            },
            () => {
              completed = true
            },
          )
          await expect
            .poll(
              async () => {
                if (completed) return true
                const result = await sql<{ blocked: boolean }>`
              select exists (
                select 1 from pg_stat_activity
                where pid = ${pid} and wait_event_type = 'Lock'
                  and cardinality(pg_blocking_pids(pid)) > 0
              ) as blocked
            `.execute(readerTables)
                return result.rows[0]?.blocked === true
              },
              { timeout: 5000 },
            )
            .toBe(true)
        },
        close: async () => {
          released.resolve()
          publisherClosed.resolve()
          await connection
        },
      }
    },
  })
})
