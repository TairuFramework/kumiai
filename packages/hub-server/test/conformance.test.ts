import { testHubStoreConformance } from '@kumiai/hub-protocol/conformance'

import { createMemoryStore } from '../src/memoryStore.js'

testHubStoreConformance({ createStore: () => createMemoryStore() })
