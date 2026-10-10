import { decodeClientState, encodeClientState } from '@kumiai/mls'
import { testDeviceStorageConformance, testGroupStorageConformance } from '@kumiai/rpc-conformance'

import type { MemoryTransaction } from '../src/persistence-types.js'
import { createStorageFixture, writeSideRow } from './fixtures/storage-persistence.js'
import { makeStorageSeed } from './fixtures/storage-seed.js'

for (const mode of ['real-mls', 'double'] as const) {
  const params = {
    label: mode,
    async lowerEpochCandidate(groupID: string) {
      const candidate = await makeStorageSeed({ id: groupID, incarnation: 1, epoch: 2, mode })
      const client =
        candidate.state.state === null ? undefined : decodeClientState(candidate.state.state)
      if (client === undefined) throw new Error('Missing lower-epoch state')
      // Evict retained epochs so receive-progress checks cannot mask epoch monotonicity.
      client.historicalReceiverData.clear()
      candidate.state.state = encodeClientState(client)
      return candidate
    },
    writeSideRow,
    createFixture: (
      id: string,
      options?: Pick<Parameters<typeof createStorageFixture>[0], 'effects' | 'ownershipContext'>,
    ) => createStorageFixture({ id, mode, ...options }),
  }
  testGroupStorageConformance<MemoryTransaction>(params)
  testDeviceStorageConformance<MemoryTransaction>(params)
}
