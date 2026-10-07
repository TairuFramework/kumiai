import { RetentionExceededError } from '@kumiai/hub-protocol'
import { afterEach, describe, expect, test } from 'vitest'

import { createHubStoreDefinition, getHubStore } from '../src/index.js'
import { backends } from './databases.js'

describe.each(backends())('store defaults ($name)', (backend) => {
  afterEach(() => backend.cleanup())

  test('rejects retention above 30 days', async () => {
    const db = await backend.open()
    db.register(createHubStoreDefinition())
    const store = await getHubStore(db)
    await store.subscribe({ subscriberDID: 'did:reader', topicID: 'topic', retention: 2592000 })
    await expect(
      store.subscribe({
        subscriberDID: 'did:reader',
        topicID: 'other',
        retention: 2592001,
      }),
    ).rejects.toBeInstanceOf(RetentionExceededError)
  })

  test.each([false, true])(
    'bounds log depth unless explicitly unbounded (%s)',
    async (unbounded) => {
      const db = await backend.open()
      db.register(
        createHubStoreDefinition(
          unbounded
            ? { maxDepth: Number.POSITIVE_INFINITY, maxRetention: Number.POSITIVE_INFINITY }
            : {},
        ),
      )
      const store = await getHubStore(db)
      await store.subscribe({
        subscriberDID: 'did:reader',
        topicID: 'topic',
        retention: unbounded ? 2592001 : 0,
      })
      let first: string | undefined
      for (let i = 0; i < 1001; i++) {
        const result = await store.publish({
          senderDID: 'did:sender',
          topicID: 'topic',
          payload: new Uint8Array([1]),
          retain: 'log',
        })
        first ??= result.sequenceID
      }
      const fetched = await store.fetchTopic({
        subscriberDID: 'did:reader',
        topicID: 'topic',
        limit: 2000,
      })
      expect(fetched.messages).toHaveLength(unbounded ? 1001 : 1000)
      expect(fetched.messages.some((message) => message.sequenceID === first)).toBe(unbounded)
    },
    // 1001 sequential publishes: Postgres needs headroom when the whole suite runs in parallel.
    120_000,
  )
})
