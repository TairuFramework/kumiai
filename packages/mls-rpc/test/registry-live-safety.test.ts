import type { SafetyHold } from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import * as persistenceCodec from '../src/persistence-codec.js'
import { registryConsumers } from '../src/registry/consumers.js'
import { registrySafety } from '../src/registry/safety.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRegistryFixture, registryFixtureSafety } from './fixtures/registry.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    describe(`live registry safety (${mode}, ${context})`, () => {
      const groupID = `live-safety-${mode}-${context}`
      const key = { groupID, incarnation: 1 }
      const create = () =>
        createRegistryFixture({
          mode,
          groupID,
          setup: 'seeded',
          ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
      const evidence = {
        kind: 'unexplained-own-commit' as const,
        epoch: 0,
        position: '1',
        digest: 'host-report',
      }

      test.each(['seal', 'rollback', 'commit'] as const)(
        'host fork pushes before proof with %s outcome',
        async (outcome) => {
          const fixture = await create()
          try {
            const api = await registryFixtureSafety(fixture)
            const capability = registrySafety(fixture.registry)
            expect(capability).toHaveProperty('onSafetyHold', expect.any(Function))
            if (capability === null) throw new Error('Missing registry capability')
            const received: Array<SafetyHold> = []
            capability.onSafetyHold(key, (reason) => received.push(reason))
            fixture.onPhase('work', () => {
              expect(received).toEqual(['fork-halted'])
            })
            fixture.onPhase('proof', () => {
              expect(received).toEqual(['fork-halted'])
            })
            const seal =
              outcome === 'seal'
                ? vi
                    .spyOn(persistenceCodec, 'sealRecord')
                    .mockRejectedValueOnce(new Error('Seal failed'))
                : null
            if (outcome === 'rollback') fixture.armNextWorkFault('before-commit')
            const pending = api.reportFork(key, evidence)
            if (outcome === 'commit') await pending
            else await expect(pending).rejects.toThrow()
            seal?.mockRestore()
            expect(received).toEqual(['fork-halted'])
            expect(capability.safetyHold(key)).toBe('fork-halted')
            expect(await api.events(key)).toHaveLength(outcome === 'commit' ? 1 : 0)
            expect((await fixture.device.groups.ports(key).control.load()).forkHalt !== null).toBe(
              outcome === 'commit',
            )
          } finally {
            await fixture.close()
          }
        },
      )

      test('trust loss pushes despite rollback and supplies late subscribers', async () => {
        const fixture = await create()
        try {
          const capability = registrySafety(fixture.registry)
          expect(capability).toHaveProperty('onSafetyHold', expect.any(Function))
          if (capability === null) throw new Error('Missing registry capability')
          const received: Array<SafetyHold> = []
          capability.onSafetyHold(key, (reason) => received.push(reason))
          await fixture.corruptTrust(groupID)
          fixture.armNextWorkFault('before-commit')
          await expect(fixture.registry.recoverySource(groupID)).rejects.toThrow()
          expect(received).toEqual(['recovery-unavailable'])
          expect(
            (await fixture.device.groups.ports(key).control.load()).recoveryUnavailable,
          ).toBeNull()
          expect(await (await registryFixtureSafety(fixture)).events(key)).toEqual([])
          const late: Array<SafetyHold> = []
          capability.onSafetyHold(key, (reason) => late.push(reason))
          expect(late).toEqual(['recovery-unavailable'])
          await expect(fixture.registry.recoverySource(groupID)).rejects.toThrow()
          expect(received).toEqual(['recovery-unavailable'])
          expect(late).toEqual(['recovery-unavailable'])
        } finally {
          await fixture.close()
        }
      })

      test('invalid and moved host reports never push', async () => {
        const fixture = await create()
        try {
          const api = await registryFixtureSafety(fixture)
          const capability = registrySafety(fixture.registry)
          expect(capability).toHaveProperty('onSafetyHold', expect.any(Function))
          if (capability === null) throw new Error('Missing registry capability')
          const received: Array<SafetyHold> = []
          const foreign = { ...key, incarnation: 2 }
          capability.onSafetyHold(key, (reason) => received.push(reason))
          capability.onSafetyHold(foreign, (reason) => received.push(reason))
          await expect(api.reportFork(key, { ...evidence, epoch: 1 })).rejects.toMatchObject({
            reason: 'epoch',
          })
          await expect(api.reportFork(foreign, evidence)).rejects.toMatchObject({ reason: 'key' })
          expect(received).toEqual([])
          expect(capability.safetyHold(key)).toBeNull()
          expect(capability.safetyHold(foreign)).toBeNull()
        } finally {
          await fixture.close()
        }
      })

      test('sinks survive owner invalidation, isolate throws and preserve fork precedence', async () => {
        const fixture = await create()
        try {
          const api = await registryFixtureSafety(fixture)
          await fixture.registry.access(groupID)
          const capability = registrySafety(fixture.registry)
          expect(capability).toHaveProperty('onSafetyHold', expect.any(Function))
          if (capability === null) throw new Error('Missing registry capability')
          capability.onSafetyHold(key, () => {
            throw new Error('Broken core sink')
          })
          const received: Array<SafetyHold> = []
          const unsubscribe = capability.onSafetyHold(key, (reason) => received.push(reason))
          await fixture.corruptState(key)
          await expect(fixture.registry.access(groupID)).rejects.toThrow()
          await api.reportFork(key, evidence)
          expect(received).toEqual(['fork-halted'])
          expect(await api.events(key)).toHaveLength(1)
          capability.latch(key, 'recovery-unavailable')
          expect(received).toEqual(['fork-halted'])
          const late: Array<SafetyHold> = []
          capability.onSafetyHold(key, (reason) => late.push(reason))
          expect(late).toEqual(['fork-halted'])
          expect(capability.safetyHold({ ...key, incarnation: 2 })).toBeNull()
          unsubscribe()
        } finally {
          await fixture.close()
        }
      })

      test('keyed retirement registration survives invalidation and disposal removes sinks', async () => {
        const fixture = await create()
        try {
          const owner = fixture.registry
          await owner.access(groupID)
          const capability = registrySafety(owner)
          expect(capability).toHaveProperty('onSafetyHold', expect.any(Function))
          if (capability === null) throw new Error('Missing registry capability')
          let retired = 0
          const unsubscribe = capability.onRetire(key, async () => {
            // Retirement hooks run after ownership release.
            await fixture.device.groups.load(groupID)
            retired++
          })
          const received: Array<SafetyHold> = []
          const stop = capability.onSafetyHold(key, (reason) => received.push(reason))
          await fixture.corruptState(key)
          await expect(owner.access(groupID)).rejects.toThrow()
          await owner.delete(key)
          expect(retired).toBe(1)
          unsubscribe()
          stop()
          capability.onSafetyHold(key, (reason) => received.push(reason))
          await owner.dispose()
          capability.latch(key, 'fork-halted')
          expect(received).toEqual([])
        } finally {
          await fixture.close()
        }
      })

      test('registration is storage-free and subscriptions unsubscribe independently', async () => {
        const fixture = await create()
        try {
          const owner = fixture.registry
          const consumers = registryConsumers({
            registry: owner,
            persistence: fixture.device.groups,
          })
          const received: Array<SafetyHold> = []
          const sink = (reason: NonNullable<SafetyHold>) => received.push(reason)
          const before = await fixture.inspectRows()
          fixture.failTrustReads(new Error('Registration must not read storage'))
          const stopFirst = consumers.onSafetyHold(key, sink)
          const stopSecond = consumers.onSafetyHold(key, sink)
          const stopRetire = consumers.onRetire(key, async () => {
            throw new Error('Unsubscribed retirement hook')
          })
          expect(consumers.safetyHold(key)).toBeNull()
          expect(received).toEqual([])
          expect(await fixture.inspectRows()).toEqual(before)
          stopFirst()
          stopRetire()
          registrySafety(owner)?.latch(key, 'recovery-unavailable')
          expect(received).toEqual(['recovery-unavailable'])
          stopSecond()
          registrySafety(owner)?.latch(key, 'fork-halted')
          expect(received).toEqual(['recovery-unavailable'])
          fixture.failTrustReads(null)
          await owner.delete(key)
        } finally {
          await fixture.close()
        }
      })
    })
  }
}
