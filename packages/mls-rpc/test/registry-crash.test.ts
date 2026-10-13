import { testRegistryCrashConformance } from '@kumiai/rpc-conformance'

import { createRegistryFixture } from './fixtures/registry.js'

for (const mode of ['real-mls', 'double'] as const) {
  testRegistryCrashConformance({
    name: `memory persistence / ${mode}`,
    createFixture: (options) => createRegistryFixture({ ...options, mode }),
  })
}
