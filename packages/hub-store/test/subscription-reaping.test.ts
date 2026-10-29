import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createHubStoreDefinition, getHubStore, type SQLHubStore } from '../src/index.js'
import { backends } from './databases.js'

for (const backend of backends()) {
  describe(`subscription reaping (${backend.name})`, () => {
    let store: SQLHubStore
    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const db = await backend.open()
      db.register(createHubStoreDefinition())
      store = await getHubStore(db)
    })
    afterEach(async () => {
      vi.useRealTimers()
      await backend.cleanup()
    })

    test('reaps stale rows, preserves the strict boundary and refreshed subscriptions', async () => {
      vi.setSystemTime(1000)
      for (const subscriberDID of ['did:test:stale', 'did:test:refreshed', 'did:test:boundary']) {
        await store.subscribe({ topicID: 'topic:reaping', subscriberDID })
      }
      vi.setSystemTime(2000)
      await store.subscribe({ topicID: 'topic:reaping', subscriberDID: 'did:test:boundary' })
      vi.setSystemTime(11000)
      await store.subscribe({ topicID: 'topic:reaping', subscriberDID: 'did:test:refreshed' })
      vi.setSystemTime(12000)
      expect(await store.purgeSubscriptions({ olderThan: 10 })).toEqual([
        { topicID: 'topic:reaping', subscriberDID: 'did:test:stale' },
      ])
      expect((await store.getSubscribers({ topicID: 'topic:reaping' })).sort()).toEqual([
        'did:test:boundary',
        'did:test:refreshed',
      ])
      expect(await store.purgeSubscriptions({ olderThan: 10 })).toEqual([])
    })

    test('returns exactly the deleted topic and subscriber pairs', async () => {
      const pairs = [
        { topicID: 'topic:x', subscriberDID: 'did:test:one' },
        { topicID: 'topic:x', subscriberDID: 'did:test:two' },
        { topicID: 'topic:y', subscriberDID: 'did:test:one' },
      ]
      vi.setSystemTime(1000)
      for (const pair of pairs) await store.subscribe(pair)
      vi.setSystemTime(12000)
      const normalize = (values: typeof pairs) =>
        values.map((pair) => `${pair.topicID}/${pair.subscriberDID}`).sort()
      expect(normalize(await store.purgeSubscriptions({ olderThan: 10 }))).toEqual(normalize(pairs))
      expect(await store.getSubscribers({ topicID: 'topic:x' })).toEqual([])
      expect(await store.getSubscribers({ topicID: 'topic:y' })).toEqual([])
    })

    test('returns an empty set when no subscription is old enough', async () => {
      vi.setSystemTime(12000)
      await store.subscribe({ topicID: 'topic:fresh', subscriberDID: 'did:test:active' })
      expect(await store.purgeSubscriptions({ olderThan: 10 })).toEqual([])
      expect(await store.getSubscribers({ topicID: 'topic:fresh' })).toEqual(['did:test:active'])
    })
  })
}
