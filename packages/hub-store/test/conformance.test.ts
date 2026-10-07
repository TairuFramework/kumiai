import {
  type ConformanceLogHub,
  type ConformanceReceiveSubscription,
  testHubStoreConformance,
  testLogHubConformance,
} from '@kumiai/hub-conformance'
import type { HubStore, StoredMessage } from '@kumiai/hub-protocol'
import { afterEach, beforeEach, describe, vi } from 'vitest'

import { createHubStoreDefinition, getHubStore, type HubStoreOptions } from '../src/index.js'
import { type Backend, backends } from './databases.js'

const MAX_RETENTION = 30 * 24 * 60 * 60
const MAX_DEPTH = 16
const MAX_KEYPACKAGES = 3
const MAX_SUBSCRIPTIONS = 4

const RECEIVE_POLL_MS = 5
const RECEIVE_FETCH_LIMIT = 50

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Default retention 0, so `purge({ olderThan: 0 })` can empty a topic whose only subscriber holds
// the default.
async function storeFor(backend: Backend, options: HubStoreOptions): Promise<HubStore> {
  const db = await backend.open()
  db.register(createHubStoreDefinition({ defaultRetention: 0, ...options }))
  return await getHubStore(db)
}

// Present the store at the LogHub seam. The store is a pull API and live push belongs to
// `@kumiai/hub-server`'s handlers, so a delivery poll stands in for `receive`.
function logHubOver(store: HubStore): ConformanceLogHub {
  // The suite calls `subscribe` without awaiting it and then publishes. Over the wire each call is
  // its own awaited request, so chaining reproduces that ordering.
  let tail: Promise<unknown> = Promise.resolve()
  function chain<Result>(operation: () => Promise<Result>): Promise<Result> {
    const next = tail.then(operation, operation)
    tail = next.catch(() => {})
    return next
  }

  function receive(subscriberDID: string): ConformanceReceiveSubscription {
    let stopped = false
    let after: string | undefined
    const buffered: Array<StoredMessage> = []
    const iterator: AsyncIterator<StoredMessage> = {
      async next() {
        while (!stopped) {
          const message = buffered.shift()
          if (message != null) return { value: message, done: false }
          const result = await store.fetch({
            recipientDID: subscriberDID,
            after,
            limit: RECEIVE_FETCH_LIMIT,
          })
          if (result.messages.length > 0) {
            buffered.push(...result.messages)
            after = result.cursor ?? after
            continue
          }
          await sleep(RECEIVE_POLL_MS)
        }
        return { value: undefined, done: true }
      },
    }
    return {
      [Symbol.asyncIterator]: () => iterator,
      // Read between polls: a loop suspended in a fetch would only honour a generator's queued
      // `return` at its next yield, which a subscription asserting silence never reaches.
      return: () => {
        stopped = true
      },
      ack: (sequenceID) => store.ack({ recipientDID: subscriberDID, sequenceIDs: [sequenceID] }),
    }
  }

  return {
    subscribe: (subscriberDID, topicID, options) => {
      return chain(() => store.subscribe({ subscriberDID, topicID, retention: options?.retention }))
    },
    unsubscribe: (subscriberDID, topicID) => {
      return chain(() => store.unsubscribe({ subscriberDID, topicID }))
    },
    receive,
    // Passed straight through: an absent `expectedHead` is an unconditional publish and a null one
    // is the empty-topic sentinel.
    publish: (publishParams) => chain(() => store.publish(publishParams)),
    fetchTopic: (fetchParams) => chain(() => store.fetchTopic(fetchParams)),
  }
}

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))
afterEach(() => vi.useRealTimers())

describe.each(backends())('$name', (backend) => {
  afterEach(async () => {
    await backend.cleanup()
  })

  testHubStoreConformance({
    setTime: (milliseconds) => vi.setSystemTime(milliseconds),
    createStore: () => {
      return storeFor(backend, {
        maxRetention: MAX_RETENTION,
        maxDepth: MAX_DEPTH,
        maxKeyPackagesPerDID: MAX_KEYPACKAGES,
        maxSubscriptionsPerDID: MAX_SUBSCRIPTIONS,
      })
    },
    maxRetention: MAX_RETENTION,
    maxDepth: MAX_DEPTH,
    maxKeyPackagesPerDID: MAX_KEYPACKAGES,
    maxSubscriptionsPerDID: MAX_SUBSCRIPTIONS,
  })

  testLogHubConformance({
    label: backend.name,
    createHub: async (limits) => logHubOver(await storeFor(backend, limits)),
    maxRetention: MAX_RETENTION,
    maxDepth: MAX_DEPTH,
  })
})
