import type { Kysely } from '@hozon/db'
import type { HubStore, UnsubscribeParams } from '@kumiai/hub-protocol'
import { createHandlers, createMemoryStore, HubClientRegistry } from '@kumiai/hub-server'
import { afterEach, describe, expect, test } from 'vitest'

import { createHubStoreDefinition, getHubStore } from '../src/index.js'
import { createHubStore } from '../src/store.js'
import type { HubTables } from '../src/tables.js'
import { backends, hubTables } from './databases.js'

const subscription = { subscriberDID: 'did:test:reader', topicID: 'A'.repeat(43) }
const backendsToTest = backends()

describe.each(backendsToTest)('unsubscribe transactions ($name)', (backend) => {
  afterEach(() => backend.cleanup())

  async function openStores() {
    const open = await backend.createReopenable()
    const db = open()
    db.register(createHubStoreDefinition())
    const reader = await getHubStore(db)
    const otherDB = open()
    otherDB.register(createHubStoreDefinition())
    return { db, reader, other: await getHubStore(otherDB), tables: await hubTables(db) }
  }

  test('a generation survives restart and advances after deletion', async () => {
    const { db, reader, other } = await openStores()
    const older = await reader.subscribe(subscription)
    await reader.unsubscribe(subscription)
    await db.close()
    const newer = await other.subscribe(subscription)
    expect(await other.unsubscribe({ ...subscription, expectedGeneration: older })).toBe(false)
    expect(await other.getSubscribers(subscription)).toEqual([subscription.subscriberDID])
    expect(BigInt(newer)).toBeGreaterThan(BigInt(older))
  })

  test.each(['hub_deliveries', 'hub_messages'])(
    'a failed %s cleanup rolls back membership and deliveries',
    async (table) => {
      const { db, reader, tables } = await openStores()
      const generation = await reader.subscribe(subscription)
      await reader.publish({
        senderDID: 'did:test:sender',
        topicID: subscription.topicID,
        payload: new Uint8Array([1]),
      })
      const boom = new Error('delivery cleanup failed')
      const plugin: Parameters<Kysely<HubTables>['withPlugin']>[0] = {
        transformQuery({ node }) {
          if (node.kind === 'DeleteQueryNode' && JSON.stringify(node).includes(table)) throw boom
          return node
        },
        async transformResult({ result }) {
          return result
        },
      }
      const writer = createHubStore({ db: tables.withPlugin(plugin), adapter: db.adapter })
      await expect(
        writer.unsubscribe({ ...subscription, expectedGeneration: generation }),
      ).rejects.toBe(boom)
      expect(await reader.getSubscribers(subscription)).toEqual([subscription.subscriberDID])
      expect(
        (await reader.fetch({ recipientDID: subscription.subscriberDID })).messages,
      ).toHaveLength(1)
    },
  )

  test('a waiting old unsubscribe rechecks the generation after a concurrent refresh commits', async () => {
    const { db, reader, other: separate, tables } = await openStores()
    const other = backend.name === 'node-sqlite' ? reader : separate
    const older = await reader.subscribe(subscription)
    const published = await reader.publish({
      senderDID: 'did:test:sender',
      topicID: subscription.topicID,
      payload: new Uint8Array([1]),
    })
    const reached = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const selected = new WeakSet<object>()
    const plugin: Parameters<Kysely<HubTables>['withPlugin']>[0] = {
      transformQuery({ node, queryId }) {
        if (node.kind === 'InsertQueryNode' && JSON.stringify(node).includes('hub_subscriptions'))
          selected.add(queryId)
        return node
      },
      async transformResult({ queryId, result }) {
        if (selected.has(queryId)) {
          reached.resolve()
          await released.promise
        }
        return result
      },
    }
    const writer = createHubStore({ db: tables.withPlugin(plugin), adapter: db.adapter })
    const refresh = writer.subscribe(subscription)
    await reached.promise
    let settled = false
    const stale = other
      .unsubscribe({ ...subscription, expectedGeneration: older })
      .then((removed) => {
        settled = true
        return removed
      })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const settledWhileHeld = settled
    released.resolve()
    const [newer, removed] = await Promise.all([refresh, stale])
    expect(settledWhileHeld).toBe(false)
    expect(removed).toBe(false)
    expect(BigInt(newer)).toBeGreaterThan(BigInt(older))
    expect(await reader.getSubscribers(subscription)).toEqual([subscription.subscriberDID])
    expect(
      (await reader.fetch({ recipientDID: subscription.subscriberDID })).messages.map(
        (message) => message.sequenceID,
      ),
    ).toEqual([published.sequenceID])
  })

  test('subscribe waits for matching unsubscribe cleanup (SQLite queue, separate PostgreSQL connections)', async () => {
    const { db, reader, other: separate, tables } = await openStores()
    // Node SQLite is synchronous: a busy wait on a second connection blocks this test's release.
    // Its single-connection transaction queue exercises interleaving without blocking the event loop.
    const other = backend.name === 'node-sqlite' ? reader : separate
    const generation = await reader.subscribe(subscription)
    await reader.publish({
      senderDID: 'did:test:sender',
      topicID: subscription.topicID,
      payload: new Uint8Array([1]),
    })
    const reached = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const selected = new WeakSet<object>()
    const plugin: Parameters<Kysely<HubTables>['withPlugin']>[0] = {
      transformQuery({ node, queryId }) {
        if (node.kind === 'DeleteQueryNode' && JSON.stringify(node).includes('hub_subscriptions'))
          selected.add(queryId)
        return node
      },
      async transformResult({ queryId, result }) {
        if (selected.has(queryId)) {
          reached.resolve()
          await released.promise
        }
        return result
      },
    }
    const writer = createHubStore({ db: tables.withPlugin(plugin), adapter: db.adapter })
    const events: Array<string> = []
    const removal = writer
      .unsubscribe({ ...subscription, expectedGeneration: generation })
      .then((removed) => {
        events.push('removed')
        return removed
      })
    await reached.promise
    const replacement = other.subscribe(subscription).then(async (newer) => {
      events.push('subscribed')
      await other.publish({
        senderDID: 'did:test:sender',
        topicID: subscription.topicID,
        payload: new Uint8Array([2]),
      })
      return newer
    })
    // Give the competing connection time to attempt its write while DELETE is held.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const eventsWhileHeld = [...events]
    released.resolve()
    const [removed, newer] = await Promise.all([removal, replacement])
    expect(eventsWhileHeld).toEqual([])
    expect(removed).toBe(true)
    expect(events).toEqual(['removed', 'subscribed'])
    expect(await reader.unsubscribe({ ...subscription, expectedGeneration: generation })).toBe(
      false,
    )
    expect(
      (await reader.fetch({ recipientDID: subscription.subscriberDID })).messages.map((message) => [
        ...message.payload,
      ]),
    ).toEqual([[2]])
    expect(BigInt(newer)).toBeGreaterThan(BigInt(generation))
  })
})

for (const backend of [...backendsToTest, null]) {
  describe(`real unsubscribe handlers (${backend?.name ?? 'memory'})`, () => {
    afterEach(async () => {
      await backend?.cleanup()
    })

    test('an old handler completing after a replacement subscribe cannot delete its delivery', async () => {
      let store: HubStore
      if (backend == null) store = createMemoryStore()
      else {
        const db = await backend.open()
        db.register(createHubStoreDefinition())
        store = await getHubStore(db)
      }
      const reached = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      let held = false
      const handlers = createHandlers({
        store: {
          ...store,
          async unsubscribe(params: UnsubscribeParams) {
            if (!held) {
              held = true
              reached.resolve()
              await released.promise
            }
            return await store.unsubscribe(params)
          },
        },
        registry: new HubClientRegistry(),
      })
      function context(param: Record<string, unknown>) {
        return {
          param,
          message: { header: {}, payload: { iss: subscription.subscriberDID } },
        } as never
      }
      const first = await handlers['hub/v1/subscribe'](context({ topicID: subscription.topicID }))
      const stale = handlers['hub/v1/unsubscribe'](
        context({ topicID: subscription.topicID, expectedGeneration: first.generation }),
      )
      await reached.promise
      try {
        const newer = await handlers['hub/v1/subscribe'](context({ topicID: subscription.topicID }))
        await store.publish({
          senderDID: 'did:test:sender',
          topicID: subscription.topicID,
          payload: new Uint8Array([1]),
        })
        released.resolve()
        expect(await stale).toEqual({ unsubscribed: false })
        expect(await store.getSubscribers(subscription)).toEqual([subscription.subscriberDID])
        expect(
          (await store.fetch({ recipientDID: subscription.subscriberDID })).messages,
        ).toHaveLength(1)
        expect(
          await handlers['hub/v1/unsubscribe'](
            context({ topicID: subscription.topicID, expectedGeneration: newer.generation }),
          ),
        ).toEqual({ unsubscribed: true })
        expect((await store.fetch({ recipientDID: subscription.subscriberDID })).messages).toEqual(
          [],
        )
        await handlers['hub/v1/subscribe'](context({ topicID: subscription.topicID }))
        expect(
          await handlers['hub/v1/unsubscribe'](context({ topicID: subscription.topicID })),
        ).toEqual({ unsubscribed: true })
        expect(await store.getSubscribers(subscription)).toEqual([])
      } finally {
        released.resolve()
        await stale
      }
    })
  })
}
