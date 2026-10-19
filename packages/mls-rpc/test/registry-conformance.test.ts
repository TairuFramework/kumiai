import type { GroupHandle } from '@kumiai/mls'
import type { ConformanceRegistryFixture } from '@kumiai/rpc-conformance'
import { testRegistryConformance } from '@kumiai/rpc-conformance'
import { expectTypeOf } from 'vitest'

import {
  createGatedRegistryFixture as createRegistryFixture,
  type RegistryFixture,
} from './fixtures/registry.js'
import { testRegistryBackgroundWarmup } from './fixtures/registry-maintenance.js'

for (const mode of ['real-mls', 'double'] as const) {
  testRegistryConformance({
    name: `memory persistence / ${mode}`,
    createFixture: (options) => createRegistryFixture({ ...options, mode }),
  })
}

expectTypeOf<RegistryFixture>().toExtend<ConformanceRegistryFixture<GroupHandle>>()
expectTypeOf<keyof RegistryFixture>().toEqualTypeOf<keyof ConformanceRegistryFixture<GroupHandle>>()
expectTypeOf<Awaited<ReturnType<RegistryFixture['reopen']>>>().toEqualTypeOf<RegistryFixture>()

testRegistryBackgroundWarmup('conformance')
