import { decodeClientState, encodeClientState, restoreGroup } from '@kumiai/mls'
import { describe, expect, test } from 'vitest'

import {
  bindEntryCapability,
  coordinatorBinding,
  type EntryCapability,
  entryCapability,
} from '../src/entry-capability.js'
import { GroupStateUncertainError, SeedAdmissionRefusedError } from '../src/persistence-errors.js'
import type { GroupLifetime, MemoryTransaction, PackageUse } from '../src/persistence-types.js'
import { createGroupHandleRegistry } from '../src/registry/registry.js'
import { seedAdmission } from '../src/registry/seed.js'
import { deferred } from '../src/runtime.js'
import {
  createRegistryFixture,
  type RegistryFixtureBase,
  registryFixtureRemoveMetadata,
  registryFixtureRestore,
} from './fixtures/registry.js'

const groupID = 'registry-seed'
const key = { groupID, incarnation: 1 }
function registry(fixture: RegistryFixtureBase) {
  return createGroupHandleRegistry({
    persistence: fixture.device,
    providerID: fixture.device.providerID,
    recovery: fixture.environment,
    restore: registryFixtureRestore(fixture),
    restoreCandidate: async () => {
      throw new Error('Seed must not restore a candidate')
    },
  })
}
function entry(fixture: RegistryFixtureBase) {
  const value = entryCapability(fixture.device.groups)
  if (value === null) throw new Error('Missing capability')
  return value
}
function refused(reason: SeedAdmissionRefusedError['reason']) {
  return { name: 'SeedAdmissionRefusedError', reason }
}
const packageUse: PackageUse = { sourceID: 'seed-source', ref: 'seed-ref', kind: 'ordinary' }

for (const mode of ['real-mls', 'double'] as const) {
  describe(`seed (${mode})`, () => {
    const create = (setup: 'empty' | 'seeded' = 'empty') =>
      createRegistryFixture({ mode, setup, groupID })
    test('absent Welcome installs incarnation one with empty incarnation stores', async () => {
      const fixture = await create()
      try {
        const history = await fixture.welcomeHistory('ordinary')
        const owner = registry(fixture)
        expect(await owner.seed(history.exact, { packageUse: history.packageUse })).toEqual(key)
        const trust = await fixture.device.groups.loadTrust(groupID)
        expect(trust?.spentEpochAuthenticators).toEqual([
          history.exact.state.keySchedule.epochAuthenticator,
        ])
        const access = await owner.access(groupID)
        expect(access.stateVersion()).toBe(1)
        await entry(fixture).read(groupID, async (reads) => {
          expect(await reads.control(1)).toMatchObject({
            operations: [],
            outcomes: [],
            welcomes: [],
            rejoin: null,
          })
        })
        const ports = fixture.device.groups.ports(key)
        expect(await ports.anchor.load()).toBeNull()
        expect(await ports.outbox.list()).toEqual([])
        expect(await ports.cursor.load('topic')).toBeNull()
      } finally {
        await fixture.close()
      }
    })
    test('genesis requires null package and true lifetime absence', async () => {
      const fixture = await create()
      try {
        const owner = registry(fixture)
        const genesis = await fixture.makeHandle(0)
        await expect(owner.seed(genesis, { packageUse })).rejects.toMatchObject(
          refused('invalid-genesis'),
        )
        expect(await fixture.device.groups.load(groupID)).toBeNull()
        expect(await owner.seed(genesis, { packageUse: null })).toEqual(key)
        await expect(
          owner.seed(genesis, { packageUse: null, replace: true }),
        ).rejects.toMatchObject(refused('spent'))
        const unspentGenesis = await fixture.makeHandle(0)
        expect(unspentGenesis.state.keySchedule.epochAuthenticator).not.toEqual(
          genesis.state.keySchedule.epochAuthenticator,
        )
        await expect(
          owner.seed(unspentGenesis, { packageUse: null, replace: true }),
        ).rejects.toMatchObject(refused('invalid-genesis'))
      } finally {
        await fixture.close()
      }
    })
    test('non-genesis validates package shape and candidate configuration', async () => {
      const fixture = await create()
      try {
        const candidate = await fixture.makeHandle(1)
        fixture.environment.options.commitPolicy = () => 'accept'
        const owner = registry(fixture)
        for (const use of [
          null,
          { ...packageUse, sourceID: '' },
          { ...packageUse, ref: '' },
          { ...packageUse, kind: 'unknown' },
        ]) {
          await expect(
            owner.seed(candidate, { packageUse: use as PackageUse | null }),
          ).rejects.toMatchObject(refused('invalid-package-use'))
        }
        await expect(owner.seed(candidate, { packageUse })).rejects.toThrow(
          'callback references mismatch',
        )
        expect(await fixture.device.groups.load(groupID)).toBeNull()
      } finally {
        await fixture.close()
      }
    })
    test('fresh spent seed refuses, including a separately restored Welcome', async () => {
      const fixture = await create()
      try {
        const history = await fixture.welcomeHistory('last-resort')
        const owner = registry(fixture)
        await owner.seed(history.exact, { packageUse: history.packageUse })
        const state = decodeClientState(encodeClientState(history.exact.state))
        if (state === undefined) throw new Error('Invalid Welcome state')
        const restored = await restoreGroup({
          state,
          credential: history.exact.credential,
          ledgerEntries: history.exact.ledgerTokens,
          options: fixture.environment.options,
        })
        expect(restored).not.toBe(history.exact)
        for (const candidate of [history.exact, restored]) {
          await expect(
            owner.seed(candidate, { replace: true, packageUse: history.packageUse }),
          ).rejects.toMatchObject(refused('spent'))
        }
      } finally {
        await fixture.close()
      }
    })
    test('alreadyJoined older unspent Welcome returns active key without writes and validates candidate', async () => {
      const fixture = await create()
      try {
        const history = await fixture.welcomeHistory('ordinary')
        const original = entry(fixture)
        const binding = coordinatorBinding(fixture.device.groups)
        if (binding === null) throw new Error('Missing binding')
        let writeEntries = 0
        const observed: EntryCapability<MemoryTransaction> = {
          ...original,
          run(request, prepare, work) {
            writeEntries++
            return original.run(request, prepare, work)
          },
        }
        bindEntryCapability({
          persistence: fixture.device.groups,
          capability: observed,
          coordinatorBinding: binding,
        })
        const owner = registry(fixture)
        await owner.seed(history.exact, { packageUse: history.packageUse })
        await owner.seed(history.newer, { replace: true, packageUse: history.packageUse })
        const activeKey = { groupID, incarnation: 2 }
        const lifetime = await fixture.device.groups.load(groupID)
        const state = await fixture.device.groups.loadState(activeKey)
        const trust = await fixture.device.groups.loadTrust(groupID)
        expect(Number(history.unusedOlder.epoch)).toBeLessThan(Number(history.newer.epoch))
        expect(trust?.spentEpochAuthenticators).not.toContainEqual(
          history.unusedOlder.state.keySchedule.epochAuthenticator,
        )
        expect(writeEntries).toBe(2)
        writeEntries = 0
        expect(await owner.seed(history.unusedOlder, { packageUse: history.packageUse })).toEqual(
          activeKey,
        )
        fixture.environment.options.commitPolicy = () => 'accept'
        const invalidCandidate = await fixture.makeHandle(Number(history.unusedOlder.epoch))
        await expect(owner.seed(invalidCandidate, { packageUse })).rejects.toThrow(
          'callback references mismatch',
        )
        expect(writeEntries).toBe(0)
        expect(await fixture.device.groups.load(groupID)).toEqual(lifetime)
        expect(await fixture.device.groups.loadState(activeKey)).toEqual(state)
        expect(await fixture.device.groups.loadTrust(groupID)).toEqual(trust)
      } finally {
        await fixture.close()
      }
    })
    test('readmit requires explicit true and omission or false leaves source usable', async () => {
      const fixture = await create()
      try {
        const history = await fixture.welcomeHistory('ordinary')
        const owner = registry(fixture)
        await owner.seed(history.exact, { packageUse: history.packageUse })
        const access = await owner.access(groupID)
        let drains = 0
        access.onRetire(async () => {
          drains++
        })
        for (const replace of [undefined, false]) {
          await expect(
            owner.seed(history.newer, { replace, packageUse: history.packageUse }),
          ).rejects.toMatchObject(refused('replace-required'))
          expect(await access.read((handle) => Number(handle.epoch))).toBe(
            Number(history.exact.epoch),
          )
        }
        expect(drains).toBe(0)
      } finally {
        await fixture.close()
      }
    })
    test('readmit drains hooks then creates n+1 retaining owed source artifacts', async () => {
      const fixture = await create()
      try {
        const history = await fixture.welcomeHistory('ordinary')
        const owner = registry(fixture)
        await owner.seed(history.exact, { packageUse: history.packageUse })
        await fixture.installRows({
          key,
          outbox: [
            {
              seq: 1,
              protocol: 'chat',
              prc: 'posted',
              data: new Uint8Array([1]),
              lastAttempt: null,
              status: 'accepted',
            },
          ],
          control: { putOutcomes: [{ id: 'owed', opID: 'old-op', at: 10, kind: 'unknown' }] },
        })
        const access = await owner.access(groupID)
        const hook = deferred<void>()
        const release = deferred<void>()
        access.onRetire(async () => {
          expect(await fixture.device.groups.load(groupID)).toMatchObject({ activeIncarnation: 1 })
          hook.resolve()
          await release.promise
        })
        const seeding = owner.seed(history.newer, { replace: true, packageUse: history.packageUse })
        await hook.promise
        await expect(access.read(() => {})).rejects.toMatchObject({ name: 'RegistryRetiringError' })
        release.resolve()
        expect(await seeding).toEqual({ groupID, incarnation: 2 })
        expect(await fixture.device.groups.loadState(key)).toMatchObject({ deleted: true })
        await expect(access.read(() => {})).rejects.toMatchObject({
          name: 'DisplacedGroupHandleError',
        })
        await entry(fixture).read(groupID, async (reads) => {
          expect((await reads.control(1)).outcomes).toContainEqual({
            id: 'owed',
            opID: 'old-op',
            at: 10,
            kind: 'unknown',
          })
        })
        expect(await fixture.device.groups.ports(key).outbox.list()).toEqual([])
        const events = await fixture.device.groups.ports(key).outbox.events()
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'failed',
              reason: 'incarnation-abandoned',
              nextIncarnation: 2,
            }),
          ]),
        )
        expect(
          (await fixture.device.groups.loadTrust(groupID))?.spentEpochAuthenticators,
        ).toHaveLength(2)
        expect((await owner.access(groupID)).stateVersion()).toBe(1)
      } finally {
        await fixture.close()
      }
    })
    test('tombstone lower unspent Welcome creates latest+1 without retirement', async () => {
      const fixture = await create()
      try {
        const history = await fixture.welcomeHistory('ordinary')
        const owner = registry(fixture)
        await owner.seed(history.newer, { packageUse: history.packageUse })
        const access = await owner.access(groupID)
        let drains = 0
        access.onRetire(async () => {
          drains++
        })
        const lifetime = await fixture.device.groups.load(groupID)
        if (lifetime === null) throw new Error('Missing lifetime')
        await fixture.device.groups.transition(
          { groupID, mutationID: 'delete-source', expected: lifetime },
          async (stores) => {
            await stores.lifetime.save({
              ...lifetime,
              revision: lifetime.revision + 1,
              mutationID: 'delete-source',
              activeIncarnation: null,
            })
          },
        )
        expect(await owner.seed(history.unusedOlder, { packageUse: history.packageUse })).toEqual({
          groupID,
          incarnation: 2,
        })
        expect(drains).toBe(0)
      } finally {
        await fixture.close()
      }
    })
    test.each(['missing', 'malformed'] as const)(
      'active %s metadata refuses typed',
      async (kind) => {
        const fixture = await create('seeded')
        try {
          if (kind === 'missing') await registryFixtureRemoveMetadata(fixture, key)
          else await fixture.mutateMetadata(key, (value) => ({ ...(value as object), version: -1 }))
          await expect(
            registry(fixture).seed(await fixture.makeHandle(2), { replace: true, packageUse }),
          ).rejects.toMatchObject(refused('invalid-active-metadata'))
        } finally {
          await fixture.close()
        }
      },
    )
    test('admission rechecked inside work on metadata-only drift with unchanged lifetime CAS', async () => {
      const fixture = await create('seeded')
      try {
        const before = await fixture.device.groups.load(groupID)
        const state = await fixture.device.groups.loadState(key)
        const trust = await fixture.device.groups.loadTrust(groupID)
        let stateSaves = 0
        let trustSaves = 0
        const original = entry(fixture)
        const binding = coordinatorBinding(fixture.device.groups)
        if (binding === null) throw new Error('Missing binding')
        const observed: EntryCapability<MemoryTransaction> = {
          ...original,
          run(request, prepare, work) {
            return original.run(request, prepare, (stores, prepared) =>
              work(
                {
                  ...stores,
                  trust: {
                    ...stores.trust,
                    save(value) {
                      trustSaves++
                      return stores.trust.save(value)
                    },
                  },
                  incarnation(incarnation) {
                    const rows = stores.incarnation(incarnation)
                    return {
                      ...rows,
                      state: {
                        ...rows.state,
                        save(record, expected) {
                          stateSaves++
                          return rows.state.save(record, expected)
                        },
                      },
                    }
                  },
                },
                prepared,
              ),
            )
          },
        }
        bindEntryCapability({
          persistence: fixture.device.groups,
          capability: observed,
          coordinatorBinding: binding,
        })
        fixture.onPhase('work', async () => {
          await fixture.mutateMetadata(key, (value) => ({ ...(value as object), deleted: true }))
        })
        await expect(
          registry(fixture).seed(await fixture.makeHandle(2), { replace: true, packageUse }),
        ).rejects.toMatchObject(refused('invalid-active-metadata'))
        expect(stateSaves).toBe(0)
        expect(trustSaves).toBe(0)
        expect(await fixture.device.groups.load(groupID)).toEqual(before)
        expect(await fixture.device.groups.loadState(key)).toEqual(state)
        expect(await fixture.device.groups.loadTrust(groupID)).toEqual(trust)
      } finally {
        await fixture.close()
      }
    })
    test('readmission accepts completion and cursor writes from its retirement drain', async () => {
      const fixture = await create('seeded')
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        const before = await fixture.device.groups.load(groupID)
        access.onRetire(async () => {
          await fixture.device.groups.ports(key).control.apply({ deleteOutcomes: [] }, 'completion')
          await fixture.device.groups.ports(key).cursor.save('draining-topic', 'finished')
        })
        await expect(
          owner.seed(await fixture.makeHandle(2), { replace: true, packageUse }),
        ).resolves.toEqual({ groupID, incarnation: 2 })
        expect((await fixture.device.groups.load(groupID))?.revision).toBe(
          (before?.revision ?? 0) + 3,
        )
        expect(await fixture.device.groups.ports(key).cursor.load('draining-topic')).toBe(
          'finished',
        )
        expect(
          await fixture.device.groups
            .ports({ groupID, incarnation: 2 })
            .cursor.load('draining-topic'),
        ).toBeNull()
        expect(access.runtime.snapshot()).toBeNull()
      } finally {
        await fixture.close()
      }
    })
    test('post-drain admission Read refuses on drift while group B proceeds', async () => {
      const fixture = await create('seeded')
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        access.onRetire(async () => {
          expect(
            await owner.seed(await fixture.makeHandle(0, 'group-B'), { packageUse: null }),
          ).toEqual({ groupID: 'group-B', incarnation: 1 })
          fixture.onPhase('work', async () => {
            await fixture.mutateMetadata(key, (value) => ({ ...(value as object), version: 99 }))
          })
        })
        await expect(
          owner.seed(await fixture.makeHandle(2), { replace: true, packageUse }),
        ).rejects.toThrow('Seed admission moved')
        await entry(fixture).read('group-B', async (reads) => {
          expect(await reads.lifetime()).toMatchObject({ groupID: 'group-B', activeIncarnation: 1 })
        })
        expect(await fixture.device.groups.load(groupID)).toMatchObject({ activeIncarnation: 1 })
      } finally {
        await fixture.close()
      }
    })
    test.each(['commit', 'rollback'] as const)(
      'seed ambiguity retains fence until %s proof',
      async (outcome) => {
        const fixture = await create()
        try {
          const history = await fixture.welcomeHistory('ordinary')
          const owner = registry(fixture)
          await owner.seed(history.exact, { packageUse: history.packageUse })
          const source = await owner.access(groupID)
          const before = await fixture.inspectRows()
          const fault = fixture.armNextWorkFault('pending')
          let returned = false
          const seeding = owner
            .seed(history.newer, { replace: true, packageUse: history.packageUse })
            .then((value) => {
              returned = true
              return value
            })
          const result =
            outcome === 'rollback'
              ? expect(seeding).rejects.toThrow()
              : expect(seeding).resolves.toEqual({ groupID, incarnation: 2 })
          const mutationID = await fault.mutationID
          await fault.rejected
          expect(returned).toBe(false)
          await expect(source.read(() => {})).rejects.toMatchObject({
            name: 'RegistryRetiringError',
          })
          const resolving = fixture.device.groups.resolve(groupID, mutationID)
          await fault.finish(outcome)
          expect(await resolving).toBe(outcome === 'commit' ? 'committed' : 'rolled-back')
          await result
          if (outcome === 'rollback') {
            expect(await fixture.inspectRows()).toEqual(before)
            expect(await source.read((handle) => handle.groupID)).toBe(groupID)
          } else {
            await expect(source.read(() => {})).rejects.toMatchObject({
              name: 'DisplacedGroupHandleError',
            })
            expect(
              (await fixture.device.groups.loadTrust(groupID))?.spentEpochAuthenticators,
            ).toHaveLength(2)
          }
        } finally {
          await fixture.close()
        }
      },
    )
    test('seed unknown returns saved result after proof and superseded marker is uncertain', async () => {
      let fixture = await create()
      try {
        let owner = registry(fixture)
        const history = await fixture.welcomeHistory('ordinary')
        const fault = fixture.armNextWorkFault('pending')
        let returned = false
        const seeding = owner
          .seed(history.exact, { packageUse: history.packageUse })
          .then((value) => {
            returned = true
            return value
          })
        const mutationID = await fault.mutationID
        await fault.rejected
        expect(returned).toBe(false)
        const resolving = fixture.device.groups.resolve(groupID, mutationID)
        await fault.finish('commit')
        expect(await resolving).toBe('committed')
        expect(await seeding).toEqual(key)
        expect(await fixture.device.groups.load(groupID)).toMatchObject({
          latestIncarnation: 1,
          revision: 1,
        })
        expect(
          (await fixture.device.groups.loadTrust(groupID))?.spentEpochAuthenticators,
        ).toHaveLength(1)
        fixture = await fixture.reopen()
        owner = registry(fixture)
        expect(await fixture.device.groups.resolve(groupID, mutationID)).toBe('committed')
        const current = await owner.access(groupID)
        await fixture.device.groups
          .ports(key)
          .control.apply({ deleteOutcomes: [] }, 'superseding-marker')
        await expect(fixture.device.groups.resolve(groupID, mutationID)).rejects.toBeInstanceOf(
          GroupStateUncertainError,
        )
        expect((await owner.access(groupID)).key).toEqual(current.key)
        await expect(
          owner.seed(history.exact, { packageUse: history.packageUse }),
        ).rejects.toMatchObject(refused('spent'))
      } finally {
        await fixture.close()
      }
    })
    test('state metadata reader handles absent, valid, deleted, malformed rows and expires', async () => {
      const fixture = await create()
      try {
        let saved!: () => Promise<unknown>
        const absent = entry(fixture).run(
          { groupID, mutationID: 'absent-metadata' },
          async (reads) => ({ expected: await reads.lifetime(), value: null }),
          async (stores) => {
            const state = stores.incarnation(1).state
            expect(await state.loadMetadata()).toBeNull()
            saved = state.loadMetadata
          },
        )
        await expect(absent).rejects.toThrow('Initial transition requires a lifetime')
        await expect(saved()).rejects.toMatchObject({ name: 'PersistencePhaseError' })
        await registry(fixture).seed(await fixture.makeHandle(0), { packageUse: null })
        for (const deleted of [false, true]) {
          await fixture.mutateMetadata(key, (value) => ({ ...(value as object), deleted }))
          await entry(fixture).run(
            { groupID, mutationID: `read-metadata-${deleted}` },
            async (reads) => ({ expected: await reads.lifetime(), value: null }),
            async (stores) => {
              expect(await stores.incarnation(1).state.loadMetadata()).toMatchObject({
                ...key,
                version: 1,
                deleted,
              })
            },
          )
        }
        await fixture.mutateMetadata(key, (value) => ({ ...(value as object), version: 'invalid' }))
        await expect(
          entry(fixture).run(
            { groupID, mutationID: 'invalid-metadata' },
            async (reads) => ({ expected: await reads.lifetime(), value: null }),
            async (stores) => {
              await stores.incarnation(1).state.loadMetadata()
            },
          ),
        ).rejects.toThrow('Unreadable state version metadata')
      } finally {
        await fixture.close()
      }
    })
    test('pure admission refuses halted and reports alreadyJoined for unspent older Welcome', async () => {
      const fixture = await create('seeded')
      try {
        const lifetime = (await fixture.device.groups.load(groupID)) as GroupLifetime
        const trust = await fixture.device.groups.loadTrust(groupID)
        const metadata = await entry(fixture).read(groupID, (reads) => reads.metadata(1))
        const welcome = { epoch: 0, epochAuthenticator: new Uint8Array([99]) }
        expect(() =>
          seedAdmission({ lifetime, trust, metadata, welcome, forkHalted: true, replace: true }),
        ).toThrow(SeedAdmissionRefusedError)
        expect(seedAdmission({ lifetime, trust, metadata, welcome, forkHalted: false })).toBe(
          'alreadyJoined',
        )
      } finally {
        await fixture.close()
      }
    })
  })
}
