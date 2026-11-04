import { decodeClientState, encodeClientState } from '@kumiai/mls'
import {
  type HandlerConformanceParams,
  testHandlerBatchingConformance,
  testHandlerCompletionConformance,
} from '@kumiai/rpc-conformance'

import type { MemoryTransaction } from '../src/persistence-types.js'
import { createHandlerConformanceFixture } from './fixtures/handler-conformance.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { writeSideRow } from './fixtures/storage-persistence.js'
import { makeStorageSeed } from './fixtures/storage-seed.js'

for (const mode of ['real-mls', 'double'] as const) {
  const params: HandlerConformanceParams<MemoryTransaction> = {
    label: mode,
    ownershipContext: createAsyncLocalOwnershipContext,
    writeSideRow,
    async lowerEpochCandidate(groupID) {
      const seed = await makeStorageSeed({ id: groupID, incarnation: 1, epoch: 2, mode })
      const state = seed.state.state === null ? undefined : decodeClientState(seed.state.state)
      if (state === undefined) throw new Error('Missing candidate state')
      state.historicalReceiverData.clear()
      seed.state.state = encodeClientState(state)
      return seed
    },
    createFixture: (id, options) => createHandlerConformanceFixture({ id, mode, ...options }),
  }
  testHandlerCompletionConformance(params)
  testHandlerBatchingConformance(params)
}
