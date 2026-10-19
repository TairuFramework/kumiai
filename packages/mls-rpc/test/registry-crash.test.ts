import { testRegistryCrashConformance } from '@kumiai/rpc-conformance'

import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createGatedRegistryFixture as createRegistryFixture } from './fixtures/registry.js'
import { testRegistryBackgroundWarmup } from './fixtures/registry-maintenance.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    testRegistryCrashConformance({
      name: `memory persistence / ${mode} / ownership context ${context}`,
      createFixture: (options) =>
        createRegistryFixture({
          ...options,
          mode,
          ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        }),
    })
  }
}

testRegistryBackgroundWarmup('crash')
