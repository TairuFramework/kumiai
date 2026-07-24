import { testHubStoreConformance } from '@kumiai/hub-conformance'

import { createMemoryStore } from '../src/memoryStore.js'

const MAX_RETENTION = 30 * 24 * 60 * 60
const MAX_DEPTH = 16
const MAX_KEYPACKAGES = 3
const MAX_SUBSCRIPTIONS = 4

testHubStoreConformance({
  createStore: () =>
    createMemoryStore({
      maxDepth: MAX_DEPTH,
      retention: { max: MAX_RETENTION },
      maxKeyPackagesPerDID: MAX_KEYPACKAGES,
      maxSubscriptionsPerDID: MAX_SUBSCRIPTIONS,
    }),
  maxRetention: MAX_RETENTION,
  maxDepth: MAX_DEPTH,
  maxKeyPackagesPerDID: MAX_KEYPACKAGES,
  maxSubscriptionsPerDID: MAX_SUBSCRIPTIONS,
})
