import type { GroupHandle } from '@kumiai/mls'
import type { ConformanceRegistryFixture } from '@kumiai/rpc-conformance'
import { testRegistryConformance } from '@kumiai/rpc-conformance'
import { expect, expectTypeOf, test } from 'vitest'

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

for (const mode of ['real-mls', 'double'] as const) {
  test.each(['complete', 'incomplete'] as const)(
    `${mode}: current own occurrence installs and settles with %s coverage`,
    async (coverage) => {
      const fixture = await createRegistryFixture({ mode, groupID: 'group-A', setup: 'seeded' })
      try {
        const access = await fixture.registry.access('group-A')
        const own = await fixture.acceptedOrdinary(access)
        const expected = own.write.expected
        if (expected?.occurrence === undefined) throw new Error('Missing own occurrence')
        if (coverage === 'incomplete') {
          await fixture.installRows({
            key: access.key,
            control: {
              cursor: {
                position: null,
                epoch: expected.occurrence.source.identity?.epoch ?? 0,
                incomplete: true,
              },
            },
          })
          expected.occurrence.coverage = 'incomplete'
          own.write.changes.putOutcomes = [
            { id: crypto.randomUUID(), opID: 'rotation', kind: 'unknown', at: 100 },
          ]
        }
        const before = access.epoch()
        await access.replace(own.candidate, () => own.write)
        expect(access.epoch()).toBe(before + 1)
        const control = await fixture.device.groups.ports(access.key).control.load()
        expect(control.commitOnce).toBeNull()
        expect(control.operations).toEqual([])
        expect(control.outcomes).toMatchObject([
          { kind: coverage === 'complete' ? 'landed' : 'unknown', opID: 'rotation' },
        ])
      } finally {
        await fixture.close()
      }
    },
  )
}
