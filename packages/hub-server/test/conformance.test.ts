import { testHubStoreConformance } from '@kumiai/hub-conformance'

import { createMemoryStore } from '../src/memoryStore.js'

const MAX_RETENTION = 30 * 24 * 60 * 60
const MAX_DEPTH = 16

testHubStoreConformance({
  createStore: () => createMemoryStore({ maxDepth: MAX_DEPTH, retention: { max: MAX_RETENTION } }),
  maxRetention: MAX_RETENTION,
  maxDepth: MAX_DEPTH,
})
