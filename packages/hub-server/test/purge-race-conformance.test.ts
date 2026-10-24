import { testHubStorePurgeRaceConformance } from '@kumiai/hub-conformance'
import { afterEach, beforeEach, vi } from 'vitest'

import { createMemoryStore } from '../src/memoryStore.js'

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))
afterEach(() => vi.useRealTimers())

testHubStorePurgeRaceConformance({
  setTime: (milliseconds) => vi.setSystemTime(milliseconds),
  createHarness: async () => {
    const store = createMemoryStore()
    return {
      purger: store,
      publisher: store,
      reader: store,
      cut: { reached: Promise.resolve(), release: () => {} },
      close: async () => {},
    }
  },
})
