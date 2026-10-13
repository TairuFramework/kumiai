import type { GroupHandle } from '@kumiai/mls'
import type { GroupSafetyEvent, RecoveryUnavailableEvent } from '@kumiai/rpc'
import {
  type ConformanceGroupSafety,
  type ConformanceGroupSafetyEvent,
  type ConformanceManualRecovery,
  type ConformanceRecoveryUnavailableEvent,
  type ConformanceRegistryFixture,
  runGroupSafetyContract,
} from '@kumiai/rpc-conformance'
import { afterEach, beforeEach, describe, expectTypeOf } from 'vitest'

import type { GroupSafety, ManualRecovery } from '../src/safety.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRegistryFixture, type RegistryFixture } from './fixtures/registry.js'

expectTypeOf<GroupSafety>().toExtend<ConformanceGroupSafety>()
expectTypeOf<ConformanceGroupSafety>().toExtend<GroupSafety>()
expectTypeOf<ManualRecovery>().toEqualTypeOf<ConformanceManualRecovery>()
expectTypeOf<GroupSafetyEvent>().toEqualTypeOf<ConformanceGroupSafetyEvent>()
expectTypeOf<RecoveryUnavailableEvent>().toEqualTypeOf<ConformanceRecoveryUnavailableEvent>()
expectTypeOf<RegistryFixture>().toExtend<ConformanceRegistryFixture<GroupHandle>>()
expectTypeOf<Awaited<ReturnType<RegistryFixture['reopen']>>['safety']>().toEqualTypeOf<
  RegistryFixture['safety']
>()

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    describe(`memory persistence / ${mode} / ownership context ${context}`, () => {
      let current: RegistryFixture
      beforeEach(async () => {
        current = await createRegistryFixture({
          mode,
          groupID: 'group-safety-contract',
          setup: 'seeded',
          ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
      })
      afterEach(async () => {
        await current?.close()
      })
      // Contract registration is synchronous; each row receives a fresh complete fixture.
      const fixture = new Proxy({} as RegistryFixture, {
        get: (_target, property) => Reflect.get(current, property),
      })
      runGroupSafetyContract(fixture)
    })
  }
}
