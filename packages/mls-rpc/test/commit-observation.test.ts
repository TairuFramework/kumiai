import type { LogPosition } from '@kumiai/rpc'
import { describe, expect, expectTypeOf, test } from 'vitest'

import type { ConformanceAccountedGroupObservation } from '../../rpc-conformance/lib/persistence-fixture.js'
import type { AccountedGroupObservation } from '../src/entry-capability.js'
import { createRegistryFixture, registryFixtureObserve } from './fixtures/registry.js'
import { nextChange } from './fixtures/storage-seed.js'

expectTypeOf<AccountedGroupObservation>().toExtend<
  ConformanceAccountedGroupObservation<LogPosition>
>()
expectTypeOf<
  ConformanceAccountedGroupObservation<LogPosition>
>().toExtend<AccountedGroupObservation>()

for (const mode of ['real-mls', 'double'] as const) {
  describe(`commit observations -- ${mode}`, () => {
    test('observations are detached from rows and another observer', async () => {
      const fixture = await createRegistryFixture({ mode, setup: 'seeded', groupID: 'observed' })
      try {
        const groups = fixture.device.groups
        const retained = await groups.loadTrust('observed')
        const observations: Array<AccountedGroupObservation> = []
        registryFixtureObserve(fixture, 'observed', (value) => {
          value.trust?.genesisAnchor.fill(0)
          value.trust?.installed.authenticator.fill(0)
          if (value.trust?.registry.devices instanceof Map) {
            value.trust.registry.devices.set(fixture.identity.id, {
              controller: fixture.identity.id,
              status: 'revoked',
            })
          }
          value.metadata.splice(0)
          if (value.lifetime !== null) value.lifetime.revision = 999
        })
        registryFixtureObserve(fixture, 'observed', (value) => observations.push(value))
        await groups.ports({ groupID: 'observed', incarnation: 1 }).cursor.save('topic', '1')
        expect(observations).toHaveLength(1)
        expect(observations[0]?.trust).toEqual(retained)
        expect(observations[0]?.metadata).toHaveLength(1)
        expect(observations[0]?.lifetime?.revision).toBe(2)
        expect(await groups.loadTrust('observed')).toEqual(retained)
        expect(await groups.load('observed')).toEqual(observations[0]?.lifetime)
      } finally {
        await fixture.close()
      }
    })

    test.each(['state', 'trust'] as const)(
      'unreadable %s is diagnosed without poisoning safety-only commits',
      async (corrupt) => {
        const fixture = await createRegistryFixture({
          mode,
          setup: 'seeded',
          groupID: 'diagnostic',
        })
        try {
          const key = { groupID: 'diagnostic', incarnation: 1 }
          if (corrupt === 'state') await fixture.corruptState(key)
          else await fixture.corruptTrust(key.groupID)
          const observations: Array<AccountedGroupObservation> = []
          registryFixtureObserve(fixture, key.groupID, (value) => observations.push(value))
          await fixture.device.groups
            .ports(key)
            .control.apply({ cursor: { position: null, epoch: 0 } }, 'diagnostic-control')
          expect(observations).toHaveLength(1)
          expect(observations[0]?.[corrupt === 'state' ? 'stateStatus' : 'trustStatus']).toBe(
            'unreadable',
          )
          if (corrupt === 'state') expect(observations[0]?.terminal).toBeNull()
          else expect(observations[0]?.trust).toBeNull()
        } finally {
          await fixture.close()
        }
      },
    )

    test('afterRelease preserves per-group FIFO across pending proof', async () => {
      const fixture = await createRegistryFixture({ mode, setup: 'seeded', groupID: 'fifo' })
      const calls: Array<string> = []
      const fault = fixture.armWorkFault('first', 'pending')
      try {
        const groups = fixture.device.groups
        registryFixtureObserve(
          fixture,
          'fifo',
          () => {},
          (value) => calls.push(value.mutationID),
        )
        const change = await nextChange(groups, 'fifo', 'first')
        const saving = groups.transition(change, async () => {})
        await fault.rejected
        const next = groups.transition(
          {
            ...change,
            mutationID: 'second',
            expected: { revision: (change.expected?.revision ?? 0) + 1, activeIncarnation: 1 },
          },
          async () => {},
        )
        expect(calls).toEqual([])
        await fault.finish('commit')
        await Promise.all([saving, next])
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        expect(calls).toEqual(['first', 'second'])
      } finally {
        await fixture.close()
      }
    })
  })
}
