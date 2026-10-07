import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HozonDB, type Kysely, type StoreDefinition } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { PostgresAdapter } from '@hozon/postgres'
import { inject } from 'vitest'

import { HUB_STORE } from '../src/definition.js'
import type { HubTables } from '../src/tables.js'

declare module 'vitest' {
  // biome-ignore lint/style/useConsistentTypeDefinitions: module augmentation needs an interface.
  interface ProvidedContext {
    postgresURL: string | null
  }
}

export type Backend = {
  name: 'node-sqlite' | 'postgres'
  /** Opens a fresh, empty database. */
  open: () => Promise<HozonDB>
  /** Creates a fresh, empty database and returns an opener for it: each call is a new connection. */
  createReopenable: () => Promise<() => HozonDB>
  /** Closes every database this backend opened and removes what it created on disk. */
  cleanup: () => Promise<void>
}

export function postgresURL(): string | null {
  return inject('postgresURL')
}

// A table prefix per database keeps runs on one Postgres server apart.
function freshPrefix(): string {
  return `t${randomUUID().replaceAll('-', '').slice(0, 30)}`
}

function createSQLiteBackend(): Backend {
  const opened: Array<HozonDB> = []
  const directories: Array<string> = []
  const track = (db: HozonDB): HozonDB => {
    opened.push(db)
    return db
  }
  return {
    name: 'node-sqlite',
    open: async () => {
      return track(new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) }))
    },
    async createReopenable() {
      const directory = await mkdtemp(join(tmpdir(), 'kumiai-hub-store-'))
      directories.push(directory)
      const database = join(directory, 'hub.db')
      return () => track(new HozonDB({ adapter: new NodeSQLiteAdapter({ database }) }))
    },
    async cleanup() {
      await Promise.all(opened.splice(0).map((db) => db.close()))
      await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
      )
    },
  }
}

function createPostgresBackend(url: string): Backend {
  const opened: Array<HozonDB> = []
  const openAt = (tablePrefix: string): HozonDB => {
    const adapter = new PostgresAdapter({ url, options: { onnotice: () => {} } })
    const db = new HozonDB({ adapter, tablePrefix })
    opened.push(db)
    return db
  }
  return {
    name: 'postgres',
    open: async () => openAt(freshPrefix()),
    async createReopenable() {
      const tablePrefix = freshPrefix()
      return () => openAt(tablePrefix)
    },
    async cleanup() {
      await Promise.all(opened.splice(0).map((db) => db.close()))
    },
  }
}

/** node-sqlite always, Postgres when the global setup provided a server. */
export function backends(): Array<Backend> {
  const url = postgresURL()
  return url == null ? [createSQLiteBackend()] : [createSQLiteBackend(), createPostgresBackend(url)]
}

const TABLES_PROBE = 'kumiai-hub-tables-probe'

const tablesProbe: StoreDefinition<HubTables, Kysely<HubTables>> = {
  name: TABLES_PROBE,
  migrations: {},
  dependsOn: [HUB_STORE],
  createAPI: (db) => db,
}

/** The hub store's tables, through the same prefixing the store itself runs behind. */
export async function hubTables(db: HozonDB): Promise<Kysely<HubTables>> {
  db.register(tablesProbe)
  return await db.getStore<Kysely<HubTables>>(TABLES_PROBE)
}
