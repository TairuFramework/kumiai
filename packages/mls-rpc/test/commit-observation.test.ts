import type { LogPosition } from '@kumiai/rpc'
import { describe, expect, expectTypeOf, test } from 'vitest'

import type { ConformanceAccountedGroupObservation } from '../../rpc-conformance/lib/persistence-fixture.js'
import type { AccountedGroupObservation } from '../src/entry-capability.js'
import { physicalRecordKey } from '../src/persistence-codec.js'
import { createRegistryFixture, registryFixtureObserve } from './fixtures/registry.js'
import { createStorageFixture } from './fixtures/storage-persistence.js'
import { nextChange } from './fixtures/storage-seed.js'

expectTypeOf<AccountedGroupObservation>().toExtend<
  ConformanceAccountedGroupObservation<LogPosition>
>()
expectTypeOf<
  ConformanceAccountedGroupObservation<LogPosition>
>().toExtend<AccountedGroupObservation>()

for (const mode of ['real-mls', 'double'] as const) {
  describe(`commit observations -- ${mode}`, () => {
    test.each(['control', 'metadata'] as const)(
      'unreadable %s does not change commit outcome when observed',
      async (corrupt) => {
        const outcomes: Array<unknown> = []
        for (const observed of [false, true]) {
          const fixture = await createStorageFixture({ id: 'diagnostic', mode })
          try {
            const groups = fixture.ports.device.groups
            const key = { groupID: 'diagnostic', incarnation: 1 }
            if (corrupt === 'metadata') {
              await fixture.mutateMetadata(key, () => ({ ...key, version: -1, deleted: false }))
            } else {
              await fixture.mutateStoredRecord(
                'control',
                physicalRecordKey({ ...key, namespace: 'control', recordID: 'current' }),
                (bytes) => {
                  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1
                  return bytes
                },
              )
            }
            const change = await nextChange(groups, key.groupID, 'diagnostic-transition')
            const observations: Array<AccountedGroupObservation> = []
            if (observed) fixture.entry().observe(key.groupID, (value) => observations.push(value))
            await expect(groups.transition(change, async () => 'committed')).resolves.toBe(
              'committed',
            )
            const lifetime = await groups.load(key.groupID)
            expect(lifetime).toMatchObject({ revision: 3, mutationID: 'diagnostic-transition' })
            outcomes.push(lifetime)
            expect(observations).toHaveLength(observed ? 1 : 0)
            if (observed) {
              expect(observations[0]).toMatchObject({
                mutationID: 'diagnostic-transition',
                lifetime,
                lifetimeStatus: 'readable',
                activeKey: key,
                stateStatus: 'readable',
                trustStatus: 'readable',
                ...(corrupt === 'control'
                  ? { controlStatus: 'unreadable', control: null, metadataStatus: 'readable' }
                  : {
                      metadataStatus: 'unreadable',
                      activeVersion: null,
                      controlStatus: 'readable',
                    }),
              })
            }
          } finally {
            await fixture.close()
          }
        }
        expect(outcomes[1]).toEqual(outcomes[0])
      },
    )

    test('unreadable lifetime during observation does not poison the commit', async () => {
      const fixture = await createStorageFixture({ id: 'diagnostic-lifetime', mode })
      try {
        const groups = fixture.ports.device.groups
        const change = await nextChange(groups, 'diagnostic-lifetime', 'diagnostic-transition')
        const observations: Array<AccountedGroupObservation> = []
        fixture.entry().observe(change.groupID, (value) => observations.push(value))
        fixture.onPhase('account', () => {
          // Accounting opens lifetime first. Only the subsequent diagnostic open fails.
          fixture.probeCodec(async () => {
            fixture.failNextOpen(new Error('Unreadable observation lifetime'))
          })
        })
        await expect(groups.transition(change, async () => 'committed')).resolves.toBe('committed')
        expect(observations).toHaveLength(1)
        expect(observations[0]).toMatchObject({
          lifetime: null,
          lifetimeStatus: 'unreadable',
          activeKey: null,
          activeVersion: null,
          control: null,
          terminal: null,
        })
        expect(await groups.load(change.groupID)).toMatchObject({
          revision: 3,
          mutationID: change.mutationID,
        })
      } finally {
        await fixture.close()
      }
    })

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
