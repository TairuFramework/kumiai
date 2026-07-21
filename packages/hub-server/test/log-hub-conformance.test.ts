import {
  type ConformanceLogHub,
  type ConformanceReceiveSubscription,
  testLogHubConformance,
} from '@kumiai/hub-conformance'
import type { HubStore, StoredMessage } from '@kumiai/hub-protocol'

import { createMemoryStore } from '../src/memoryStore.js'

const MAX_RETENTION = 30 * 24 * 60 * 60
const MAX_DEPTH = 6

/**
 * A `HubStore` has no push side, so `receive` is a poll over `fetch` with the cursor the store
 * itself hands back. It acks nothing: an ack would delete the mailbox frames the clauses are
 * observing, and none of the properties under test live here — the sender exclusion, the sequenceID
 * format, the retention refusal and the depth bound are all in the store's own `publish` and
 * `subscribe`. This adapter can only lose messages, never invent one.
 */
function pollingReceive(store: HubStore, recipientDID: string): ConformanceReceiveSubscription {
  let stopped = false
  let after: string | undefined
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<StoredMessage> {
      while (!stopped) {
        const result = await store.fetch(after == null ? { recipientDID } : { recipientDID, after })
        for (const message of result.messages) yield message
        if (result.cursor != null) after = result.cursor
        if (result.messages.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 2))
        }
      }
    },
    return: () => {
      stopped = true
    },
  }
}

/**
 * The real store, run through the same seam as every double — the baseline that says the clauses
 * describe a hub rather than describing the doubles.
 */
function createStoreAsLogHub(options: {
  maxRetention: number
  maxDepth: number
}): ConformanceLogHub {
  const store = createMemoryStore({
    maxDepth: options.maxDepth,
    retention: { max: options.maxRetention },
  })
  return {
    subscribe: (subscriberDID, topicID, subscribeOptions) =>
      store.subscribe({ subscriberDID, topicID, retention: subscribeOptions?.retention }),
    unsubscribe: (subscriberDID, topicID) => store.unsubscribe(subscriberDID, topicID),
    publish: (params) => store.publish(params),
    fetchTopic: (params) => store.fetchTopic(params),
    receive: (subscriberDID) => pollingReceive(store, subscriberDID),
  }
}

testLogHubConformance({
  label: 'createMemoryStore',
  createHub: createStoreAsLogHub,
  maxRetention: MAX_RETENTION,
  maxDepth: MAX_DEPTH,
})
