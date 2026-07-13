import { testHubStoreConformance } from '@kumiai/hub-protocol/conformance'

import { createMemoryStore } from '../src/memoryStore.js'

const MAX_RETENTION = 30 * 24 * 60 * 60

testHubStoreConformance({
  createStore: () => createMemoryStore({ retention: { max: MAX_RETENTION } }),
  maxRetention: MAX_RETENTION,
})
