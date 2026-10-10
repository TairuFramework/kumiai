import { testDeviceStorageConformance, testGroupStorageConformance } from '@kumiai/rpc-conformance'

import type { MemoryTransaction } from '../src/persistence-types.js'
import { createStorageFixture, writeSideRow } from './fixtures/storage-persistence.js'

for (const mode of ['real-mls', 'double'] as const) {
  const params = {
    label: mode,
    writeSideRow,
    createFixture: (id: string, effects?: Parameters<typeof createStorageFixture>[0]['effects']) =>
      createStorageFixture({ id, mode, effects }),
  }
  testGroupStorageConformance<MemoryTransaction>(params)
  testDeviceStorageConformance<MemoryTransaction>(params)
}
