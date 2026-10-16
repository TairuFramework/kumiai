import { testForkNoticeConformance } from '@kumiai/rpc-conformance'

import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createForkNoticeFixture } from './fixtures/registry.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const ownership of ['supplied', 'absent'] as const) {
    testForkNoticeConformance({
      label: `${mode}, ${ownership} ownership context`,
      createFixture: () =>
        createForkNoticeFixture({
          mode,
          ownershipContext:
            ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        }),
    })
  }
}
