import { HozonDB, type Kysely } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import type { HubStore } from '@kumiai/hub-protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { createHubStoreDefinition, getHubStore } from '../src/index.js'
import type { HubTables } from '../src/tables.js'
import { hubTables } from './databases.js'

/**
 * A sweep names every frame it removes in one `in` list, and SQLite binds a parameter per element,
 * so an unchunked delete throws "too many SQL variables" at exactly the size that makes the sweep
 * worth running. Sized past the measured ceiling (32766), because anything under it passes whether
 * the delete chunks or not.
 */
const FRAME_COUNT = 33000

const FRAME_PAYLOAD = new TextEncoder().encode('frame')

describe('hub store sweeps over a backlog larger than one statement can bind', () => {
  let db: HozonDB
  let tables: Kysely<HubTables>
  let store: HubStore

  async function messageCount(): Promise<number> {
    const row = await tables
      .selectFrom('hub_messages')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow()
    return Number(row.count)
  }

  async function publishFrames(topicID: string): Promise<Array<string>> {
    const sequenceIDs: Array<string> = []
    for (let index = 0; index < FRAME_COUNT; index++) {
      const result = await store.publish({
        senderDID: 'did:test:alice',
        topicID,
        payload: FRAME_PAYLOAD,
        retain: 'log',
      })
      sequenceIDs.push(result.sequenceID)
    }
    return sequenceIDs
  }

  beforeEach(async () => {
    db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
    db.register(createHubStoreDefinition({ maxDepth: Number.POSITIVE_INFINITY }))
    store = await getHubStore(db)
    tables = await hubTables(db)
  })

  afterEach(async () => {
    await db.close()
  })

  test('trim removes every frame below the bound', async () => {
    const sequenceIDs = await publishFrames('topic-trim')
    expect(await messageCount()).toBe(FRAME_COUNT)

    // Strictly below the last frame, so one survives: a trim that silently removed nothing would
    // also satisfy an assertion that expected zero.
    const lastSequenceID = sequenceIDs[FRAME_COUNT - 1]
    if (lastSequenceID == null) throw new Error('expected a last sequence ID')
    await store.trim({ topicID: 'topic-trim', before: lastSequenceID })
    expect(await messageCount()).toBe(1)
  }, 120000)

  test('purge removes every frame past its retention', async () => {
    await publishFrames('topic-purge')
    expect(await messageCount()).toBe(FRAME_COUNT)

    // `olderThan: 0` with no subscriber retention makes every stored frame due.
    const removed = await store.purge({ olderThan: 0 })
    expect(removed).toHaveLength(FRAME_COUNT)
    expect(await messageCount()).toBe(0)
  }, 120000)
})
