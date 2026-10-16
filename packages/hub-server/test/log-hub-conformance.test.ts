import {
  type ConformanceLogHub,
  type ConformanceReceiveSubscription,
  testLogAckConformance,
  testLogHubConformance,
} from '@kumiai/hub-conformance'
import type { HubStore, StoredMessage } from '@kumiai/hub-protocol'

import { createMemoryStore } from '../src/memoryStore.js'

const MAX_RETENTION = 30 * 24 * 60 * 60
const MAX_DEPTH = 6

/**
 * A `HubStore` has no push side, so `receive` is a poll over `fetch` with the cursor the store
 * itself hands back. Acknowledgements go straight to the store. Sender exclusion, sequenceIDs,
 * retention refusal and depth bounds all come from the store. This adapter can only lose
 * messages, never invent one.
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
    ack: (sequenceID) => store.ack({ recipientDID, sequenceIDs: [sequenceID] }),
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
    unsubscribe: (subscriberDID, topicID) => store.unsubscribe({ subscriberDID, topicID }),
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

testLogAckConformance({
  label: 'createMemoryStore',
  createHub: createStoreAsLogHub,
  maxRetention: MAX_RETENTION,
  maxDepth: MAX_DEPTH,
})
