import { setImmediate as waitForTurn } from 'node:timers/promises'
import { GroupControlUnsettledError } from '@kumiai/rpc'
import { describe, expect, test } from 'vitest'

import {
  bindEntryCapability,
  coordinatorBinding,
  entryCapability,
} from '../src/entry-capability.js'
import {
  DisplacedGroupHandleError,
  GroupStateConflictError,
  RegistryRetireHookError,
  RegistryRetiringError,
} from '../src/persistence-errors.js'
import type { AppOutboxEntry } from '../src/persistence-types.js'
import { createGroupHandleRegistry } from '../src/registry/registry.js'
import {
  ackRetiredOutcome,
  retireIncarnation,
  serveRetiredObligations,
} from '../src/registry/retired.js'
import { registryRetirement } from '../src/registry/retirement.js'
import type { GroupHandleRegistry } from '../src/registry/types.js'
import { deferred } from '../src/runtime.js'
import {
  createRegistryFixture,
  type RegistryFixtureBase,
  registryFixtureForceOwnerMarker,
  registryFixtureRestore,
} from './fixtures/registry.js'
import { writeSideRow } from './fixtures/storage-persistence.js'
import { makeStorageSeed, nextChange } from './fixtures/storage-seed.js'

const groupID = 'registry-delete'
const key = { groupID, incarnation: 1 }
const outcome = { id: 'owed', opID: 'owed', at: 123, kind: 'unknown' as const }
const welcome = {
  opID: 'welcome',
  welcome: new Uint8Array([7, 8]),
  recipients: ['recipient'],
  epoch: 0,
  epochAfter: 1,
  committed: true as const,
}
function entry(seq = 1): AppOutboxEntry {
  return {
    seq,
    protocol: 'chat',
    prc: 'posted',
    data: new Uint8Array([1, 2, 3]),
    status: 'accepted',
    lastAttempt: null,
  }
}
function registry(fixture: RegistryFixtureBase) {
  return createGroupHandleRegistry({
    persistence: fixture.device,
    providerID: fixture.device.providerID,
    recovery: fixture.environment,
    restore: registryFixtureRestore(fixture),
    restoreCandidate: async () => {
      throw new Error('Unexpected candidate restoration')
    },
  })
}
function capability(fixture: RegistryFixtureBase) {
  const value = entryCapability(fixture.device.groups)
  if (value === null) throw new Error('Missing capability')
  return value
}
function overrideCapability(fixture: RegistryFixtureBase, value: ReturnType<typeof capability>) {
  const binding = coordinatorBinding(fixture.device.groups)
  if (binding === null) throw new Error('Missing binding')
  bindEntryCapability({
    persistence: fixture.device.groups,
    coordinatorBinding: binding,
    capability: value,
  })
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`registry deletion and disposal -- ${mode}`, () => {
    const create = () => createRegistryFixture({ mode, setup: 'seeded', groupID })
    async function mutationCall(
      fixture: RegistryFixtureBase,
      owner: GroupHandleRegistry,
      kind: 'seed' | 'switch',
    ) {
      if (kind === 'seed') {
        const candidate = await fixture.makeHandle(0, `${groupID}-new`)
        return () => owner.seed(candidate, { packageUse: null })
      }
      const recovery = await fixture.confirmedRecovery(key, { confirm: true })
      return () =>
        owner.switchIncarnation(recovery.candidate, {
          source: recovery.source,
          rejoinID: recovery.record.id,
          proof: recovery.proof,
          write: {
            mutationID: 'disposal-switch',
            source: { rejoinID: recovery.record.id },
            destination: {
              control: {
                cursor: {
                  position: recovery.proof.position,
                  epoch: Number(recovery.candidate.epoch),
                },
              },
            },
          },
        })
    }
    async function installOtherGroup(fixture: RegistryFixtureBase) {
      const otherKey = { groupID: 'group-B', incarnation: 1 }
      const seed = await makeStorageSeed({
        id: otherKey.groupID,
        incarnation: 1,
        epoch: 0,
        mode,
        identity: fixture.identity,
        options: fixture.environment.options,
      })
      await fixture.installRows({ key: otherKey, state: seed.state, trust: seed.trust })
      return fixture.device.groups.ports(otherKey)
    }
    async function switchSource(fixture: RegistryFixtureBase, switchedRejoinID?: string) {
      const candidate = await makeStorageSeed({
        id: groupID,
        incarnation: 2,
        epoch: 1,
        mode,
        identity: fixture.identity,
        options: fixture.environment.options,
      })
      const mutationID = 'switch-before-delete'
      await fixture.device.groups.transition(
        await nextChange(fixture.device.groups, groupID, mutationID),
        async (stores) => {
          await retireIncarnation(stores, {
            source: key,
            nextIncarnation: 2,
            switchedRejoinID,
            mutationID,
            at: 123,
          })
          const lifetime = await stores.lifetime.load()
          const trust = await stores.trust.load()
          if (lifetime === null || trust === null) throw new Error('Missing source')
          await stores.lifetime.save({
            ...lifetime,
            latestIncarnation: 2,
            activeIncarnation: 2,
            revision: lifetime.revision + 1,
            mutationID,
          })
          await stores.incarnation(2).state.save(candidate.state)
          await stores.trust.save({
            ...candidate.trust,
            genesisAnchor: trust.genesisAnchor,
            spentEpochAuthenticators: trust.spentEpochAuthenticators,
          })
        },
      )
      return { groupID, incarnation: 2 }
    }

    test.each(['device', 'group'] as const)(
      'delete refuses unchanged while %s restore work is pending',
      async (scope) => {
        const fixture = await create()
        try {
          if (scope === 'device') {
            await fixture.device.transition(
              {
                mutationID: 'pending-device-restore',
                expectedRevision: (await fixture.device.load()).revision,
                group: null,
              },
              async (stores) => {
                await stores.restore.save({
                  id: 'delete-restore',
                  stage: 'groups',
                  remainingGroups: [groupID],
                })
              },
            )
          } else {
            await fixture.device.groups.transition(
              await nextChange(fixture.device.groups, groupID, 'pending-group-restore'),
              async (stores) => {
                const lifetime = await stores.lifetime.load()
                if (lifetime === null) throw new Error('Missing source lifetime')
                await stores.lifetime.save({
                  ...lifetime,
                  revision: lifetime.revision + 1,
                  mutationID: 'pending-group-restore',
                  restorePending: true,
                })
              },
            )
          }
          const owner = registry(fixture)
          const before = await fixture.inspectRows()
          await expect(owner.delete(key)).rejects.toMatchObject({ reason: 'restore-pending' })
          expect(await fixture.inspectRows()).toEqual(before)
          expect(() => registryRetirement(owner).assertAvailable(groupID)).not.toThrow()
          expect(await fixture.device.groups.loadState(key)).toMatchObject({ deleted: false })
          await owner.dispose()
        } finally {
          await fixture.close()
        }
      },
    )

    test.each(['outcome', 'welcome'] as const)(
      'delete refuses old-incarnation owed %s',
      async (kind) => {
        const fixture = await create()
        try {
          await fixture.installRows({
            key,
            control: kind === 'outcome' ? { putOutcomes: [outcome] } : { putWelcomes: [welcome] },
          })
          const nextKey = await switchSource(fixture)
          const owner = registry(fixture)
          const access = await owner.access(groupID)
          expect((await fixture.device.groups.ports(nextKey).control.load()).outcomes).toEqual([])
          const before = await fixture.inspectRows()
          await expect(owner.delete(nextKey)).rejects.toBeInstanceOf(GroupControlUnsettledError)
          expect(await fixture.inspectRows()).toEqual(before)
          expect(await owner.access(groupID)).toBe(access)
          expect(await access.read((handle) => handle.groupID)).toBe(groupID)
          if (kind === 'outcome')
            await ackRetiredOutcome({ persistence: fixture.device.groups, key, id: outcome.id })
          else
            expect(
              await serveRetiredObligations({
                persistence: fixture.device.groups,
                key,
                search: { searchLog: async () => ({ kind: 'unknown' }) },
                deliverWelcome: async () => {},
              }),
            ).toMatchObject({ remaining: [], failures: [] })
          await owner.delete(nextKey)
          expect(await fixture.device.groups.load(groupID)).toMatchObject({
            activeIncarnation: null,
          })
        } finally {
          await fixture.close()
        }
      },
    )

    test('delete refuses retained adopted continuation without rewriting proof inputs', async () => {
      const fixture = await create()
      try {
        const { record } = await fixture.confirmedRecovery(key)
        await fixture.installRows({ key, control: { putRejoin: record } })
        const nextKey = await switchSource(fixture, record.id)
        const before = await fixture.inspectRows()
        const owner = registry(fixture)
        await expect(owner.delete(nextKey)).rejects.toBeInstanceOf(GroupControlUnsettledError)
        expect(await fixture.inspectRows()).toEqual(before)
        expect((await fixture.device.groups.ports(key).control.load()).rejoin).toEqual({
          ...record,
          stage: 'adopted',
        })
        expect((await owner.access(groupID)).key).toEqual(nextKey)
      } finally {
        await fixture.close()
      }
    })

    test('delete drains handler root reads and completion outside the slot', async () => {
      const fixture = await create()
      const release = deferred<void>()
      try {
        await fixture.installRows({ key, control: { putOutcomes: [outcome] } })
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        const entered = deferred<void>()
        access.onRetire(async () => {
          expect(await fixture.device.groups.load(groupID)).toMatchObject({ activeIncarnation: 1 })
          entered.resolve()
          await release.promise
          await fixture.device.groups
            .ports(key)
            .control.apply({ deleteOutcomes: [outcome.id] }, 'handler-completion')
        })
        const deleting = owner.delete(key)
        await entered.promise
        await expect(owner.access(groupID)).rejects.toBeInstanceOf(RegistryRetiringError)
        expect(await fixture.device.groups.load(groupID)).toMatchObject({ activeIncarnation: 1 })
        release.resolve()
        await deleting
        expect(access.runtime.snapshot()).toBeNull()
        expect(await fixture.device.groups.loadState(key)).toMatchObject({ deleted: true })
      } finally {
        release.resolve()
        await fixture.close()
      }
    })

    test.each([1, 3] as const)(
      'delete re-drains after %s changes and restores owner creation on refusal',
      async (changes) => {
        const fixture = await create()
        try {
          const original = capability(fixture)
          let rounds = 0
          overrideCapability(fixture, {
            ...original,
            async run(request, prepare, work) {
              if (rounds++ < changes)
                await fixture.device.groups
                  .ports(key)
                  .control.apply({ deleteOutcomes: [] }, `drain-race-${rounds}`)
              return original.run(request, prepare, work)
            },
          })
          const owner = registry(fixture)
          const access = await owner.access(groupID)
          let hooks = 0
          access.onRetire(async () => {
            hooks++
          })
          if (changes === 3) {
            await expect(owner.delete(key)).rejects.toBeInstanceOf(GroupControlUnsettledError)
            expect(await owner.access(groupID)).toBe(access)
            expect(await access.read((handle) => handle.groupID)).toBe(groupID)
          } else await owner.delete(key)
          expect(hooks).toBe(changes === 3 ? 3 : 2)
        } finally {
          await fixture.close()
        }
      },
    )

    test('another group commit does not cause re-drain', async () => {
      const fixture = await create()
      try {
        const other = await installOtherGroup(fixture)
        const original = capability(fixture)
        overrideCapability(fixture, {
          ...original,
          async run(request, prepare, work) {
            await other.control.apply({ deleteOutcomes: [] }, 'other-group')
            return original.run(request, prepare, work)
          },
        })
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        let hooks = 0
        access.onRetire(async () => {
          hooks++
        })
        await owner.delete(key)
        expect(hooks).toBe(1)
      } finally {
        await fixture.close()
      }
    })

    test('queued raw admission after drain forces a new round before any deletion write', async () => {
      const fixture = await create()
      const queued = deferred<void>()
      const proceed = deferred<void>()
      const writes: Array<Promise<unknown>> = []
      try {
        const original = capability(fixture)
        let first = true
        overrideCapability(fixture, {
          ...original,
          run(request, prepare, work) {
            return original.run(
              request,
              async (reads) => {
                const value = await prepare(reads)
                if (first) {
                  first = false
                  queued.resolve()
                  await proceed.promise
                }
                return value
              },
              work,
            )
          },
        })
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        let hooks = 0
        access.onRetire(async () => {
          hooks++
        })
        const deleting = owner.delete(key)
        writes.push(deleting)
        await queued.promise
        writes.push(
          fixture.device.groups
            .ports(key)
            .control.apply({ deleteOutcomes: [] }, 'queued-after-drain'),
        )
        expect(original.activity(groupID).pending).toBe(2)
        proceed.resolve()
        await Promise.all(writes)
        expect(hooks).toBe(2)
        expect(await fixture.device.groups.load(groupID)).toMatchObject({ activeIncarnation: null })
      } finally {
        proceed.resolve()
        await Promise.allSettled(writes)
        await fixture.close()
      }
    })

    test('delete fails uncertified entries once and retains trust, events, cleanup and host history', async () => {
      const fixture = await create()
      try {
        const value = entry()
        const accepted = { ...key, id: 'accepted', kind: 'accepted' as const, entry: value }
        await fixture.installRows({ key, outbox: [value], events: [accepted] })
        const device = await fixture.device.load()
        const cleanup = {
          id: 'cleanup',
          ownerDID: fixture.identity.id,
          groupID,
          sourceID: 'hub',
          ref: 'package',
          kind: 'ordinary' as const,
          notAfter: 12345,
        }
        await fixture.device.transition(
          { mutationID: 'device-cleanup', expectedRevision: device.revision, group: null },
          async (stores) => {
            await stores.cleanup.put(cleanup)
            await writeSideRow(stores.tx, 'host-history', new Uint8Array([9, 8]))
          },
        )
        const trust = await fixture.device.groups.loadTrust(groupID)
        const before = await fixture.inspectRows()
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        await owner.delete(key)
        expect(await fixture.device.groups.ports(key).outbox.list()).toEqual([])
        expect(await fixture.device.groups.ports(key).outbox.events()).toEqual([
          accepted,
          {
            ...key,
            id: JSON.stringify(['deleted', groupID, 1, value.seq]),
            kind: 'failed',
            reason: 'deleted',
            entry: { ...value, status: 'failed' },
          },
        ])
        expect(await fixture.device.groups.loadTrust(groupID)).toEqual(trust)
        const after = await fixture.inspectRows()
        expect(before['device-cleanup']?.size).toBe(1)
        expect(after['device-cleanup']).toEqual(before['device-cleanup'])
        expect(after['host-side']).toEqual(before['host-side'])
        await expect(owner.delete(key)).rejects.toBeInstanceOf(DisplacedGroupHandleError)
        await expect(access.read(() => {})).rejects.toBeInstanceOf(DisplacedGroupHandleError)
        await expect(owner.access(groupID)).rejects.toMatchObject({ reason: 'deleted' })
        expect(await fixture.inspectRows()).toEqual(after)
      } finally {
        await fixture.close()
      }
    })

    test.each(['active', 'retired'] as const)(
      'delete protects %s certified settlement until original publication',
      async (location) => {
        const fixture = await create()
        try {
          const certified = {
            ...entry(),
            lastAttempt: {
              incarnation: 1,
              epoch: 0,
              floor: null,
              attempts: 1,
              publishID: 'publish',
              segment: 0,
              topicID: 'original',
            },
          }
          const obligation = {
            attemptID: 'publish',
            sequenceID: '19',
            topicID: 'original',
            outcome: 'published' as const,
          }
          await fixture.installRows({
            key,
            outbox: [certified],
            settlements: [{ seq: 1, value: obligation }],
          })
          const active = location === 'retired' ? await switchSource(fixture) : key
          const owner = registry(fixture)
          const before = await fixture.inspectRows()
          await expect(owner.delete(active)).rejects.toBeInstanceOf(GroupControlUnsettledError)
          expect(await fixture.inspectRows()).toEqual(before)
          expect(await fixture.device.groups.ports(key).outbox.events()).toEqual([])
          await fixture.device.groups
            .ports(key)
            .outbox.remove(1, { incarnation: 1, segment: 0, topicID: 'original', position: '19' })
          await owner.delete(active)
          expect(await fixture.device.groups.ports(key).outbox.events()).toEqual([
            {
              ...key,
              id: expect.any(String),
              kind: 'published',
              entry: certified,
              occurrence: { incarnation: 1, segment: 0, topicID: 'original', position: '19' },
            },
          ])
        } finally {
          await fixture.close()
        }
      },
    )

    test.each(['commit', 'rollback'] as const)(
      'delete effect and tombstone co-%s',
      async (result) => {
        const failure = new Error('Delete effect rejected')
        const fixture = await createRegistryFixture({
          mode,
          groupID,
          setup: 'seeded',
          effects: {
            async delete(tx, suppliedKey) {
              expect(suppliedKey).toEqual(key)
              await writeSideRow(tx, 'deleted', new Uint8Array([1]))
              if (result === 'rollback') throw failure
            },
          },
        })
        try {
          const owner = registry(fixture)
          const access = await owner.access(groupID)
          const before = await fixture.inspectRows()
          if (result === 'rollback') {
            await expect(owner.delete(key)).rejects.toBe(failure)
            expect(await fixture.inspectRows()).toEqual(before)
            expect(await owner.access(groupID)).toBe(access)
          } else {
            await owner.delete(key)
            expect((await fixture.inspectRows())['host-side']?.get('deleted')).toEqual(
              new Uint8Array([1]),
            )
            expect(await fixture.device.groups.loadState(key)).toMatchObject({ deleted: true })
          }
        } finally {
          await fixture.close()
        }
      },
    )

    test('hook rejection and transaction rollback restore active access', async () => {
      const fixture = await create()
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        const unregister = access.onRetire(async () => {
          throw new Error('Hook failed')
        })
        await expect(owner.delete(key)).rejects.toBeInstanceOf(RegistryRetireHookError)
        expect(await owner.access(groupID)).toBe(access)
        unregister()
        fixture.armNextWorkFault('before-commit')
        const before = await fixture.inspectRows()
        await expect(owner.delete(key)).rejects.toThrow()
        expect(await fixture.inspectRows()).toEqual(before)
        expect(await owner.access(groupID)).toBe(access)
        await owner.delete(key)
      } finally {
        await fixture.close()
      }
    })

    test.each(['commit', 'rollback'] as const)(
      'delete pending proof retains hold until %s',
      async (result) => {
        const fixture = await create()
        try {
          const owner = registry(fixture)
          const access = await owner.access(groupID)
          const fault = fixture.armNextWorkFault('pending')
          const deleting = owner.delete(key)
          const settled =
            result === 'commit'
              ? expect(deleting).resolves.toBeUndefined()
              : expect(deleting).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' })
          const mutationID = await fault.mutationID
          const proof = fixture.holdProof(mutationID)
          await fault.rejected
          await proof.started
          await expect(owner.access(groupID)).rejects.toBeInstanceOf(RegistryRetiringError)
          expect(() => access.epoch()).toThrow(RegistryRetiringError)
          await fault.finish(result)
          proof.release()
          await settled
          if (result === 'commit') {
            expect(access.runtime.snapshot()).toBeNull()
            await expect(owner.access(groupID)).rejects.toMatchObject({ reason: 'deleted' })
          } else expect(await owner.access(groupID)).toBe(access)
        } finally {
          await fixture.close()
        }
      },
    )

    test('delete fail-stop propagates canonical conflict and prevents runtime recovery', async () => {
      const fixture = await create()
      try {
        const owner = registry(fixture)
        await owner.access(groupID)
        const fault = fixture.armNextWorkFault('commit-then-reject')
        const deleting = expect(owner.delete(key)).rejects.toBeInstanceOf(GroupStateConflictError)
        const proof = fixture.holdProof(await fault.mutationID)
        await proof.started
        await registryFixtureForceOwnerMarker(
          fixture,
          { groupID },
          { revision: 999, mutationID: 'intruder' },
        )
        proof.release()
        await deleting
        await expect(owner.access(groupID)).rejects.toBeInstanceOf(GroupStateConflictError)
      } finally {
        await fixture.close()
      }
    })

    test('dispose closes admission synchronously, waits hooks and pending proof, then unregisters and releases binding', async () => {
      const fixture = await create()
      const release = deferred<void>()
      try {
        const other = await installOtherGroup(fixture)
        const original = capability(fixture)
        let observers = 0
        overrideCapability(fixture, {
          ...original,
          observe(...args) {
            observers++
            const unsubscribe = original.observe(...args)
            return () => {
              observers--
              unsubscribe()
            }
          },
        })
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        const entered = deferred<void>()
        access.onRetire(async () => {
          expect(await fixture.device.groups.load(groupID)).toMatchObject({ activeIncarnation: 1 })
          entered.resolve()
          await release.promise
        })
        const mutationID = 'pending-at-disposal'
        const fault = fixture.armWorkFault(mutationID, 'pending')
        const proof = fixture.holdProof(mutationID)
        const writing = expect(
          fixture.device.groups.ports(key).control.apply({ deleteOutcomes: [] }, mutationID),
        ).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' })
        await fault.rejected
        await proof.started
        let finished = false
        const disposing = owner.dispose().then(() => {
          finished = true
        })
        expect(() => access.epoch()).toThrow(DisplacedGroupHandleError)
        await expect(owner.access(groupID)).rejects.toBeInstanceOf(DisplacedGroupHandleError)
        await expect(owner.recoverySource(groupID)).rejects.toBeInstanceOf(
          DisplacedGroupHandleError,
        )
        expect(() => registry(fixture)).toThrow('live registry')
        await other.control.apply({ deleteOutcomes: [] }, 'during-disposal')
        expect(finished).toBe(false)
        await fault.finish('rollback')
        proof.release()
        await writing
        await entered.promise
        await fixture.device.groups
          .ports(key)
          .control.apply({ deleteOutcomes: [] }, 'raw-during-disposal')
        expect(observers).toBe(1)
        release.resolve()
        await disposing
        await owner.dispose()
        expect(observers).toBe(0)
        expect(access.runtime.snapshot()).toBeNull()
        expect(await fixture.device.groups.loadState(key)).toMatchObject({ deleted: false })
        const replacement = registry(fixture)
        expect((await replacement.access(groupID)).key).toEqual(key)
        await replacement.dispose()
      } finally {
        release.resolve()
        await fixture.close()
      }
    })

    test.each(['seed', 'switch'] as const)(
      'disposed registry refuses %s without writing after binding replacement',
      async (kind) => {
        const fixture = await create()
        try {
          const owner = registry(fixture)
          const mutate = await mutationCall(fixture, owner, kind)
          await owner.dispose()
          const replacement = registry(fixture)
          try {
            const before = await fixture.inspectRows()
            await expect(mutate()).rejects.toBeInstanceOf(DisplacedGroupHandleError)
            expect(await fixture.inspectRows()).toEqual(before)
            expect((await replacement.access(groupID)).key).toEqual(key)
          } finally {
            await replacement.dispose()
          }
        } finally {
          await fixture.close()
        }
      },
    )

    test.each(['seed', 'switch'] as const)(
      'dispose waits for issued %s suspended between read and mutation phases',
      async (kind) => {
        const fixture = await create()
        const entered = deferred<void>()
        const release = deferred<void>()
        let issued: Promise<unknown> | undefined
        let disposing: Promise<void> | undefined
        try {
          const original = capability(fixture)
          let suspended = false
          let armed = false
          overrideCapability(fixture, {
            ...original,
            async read(groupID, fn) {
              const result = await original.read(groupID, fn)
              if (armed && !suspended) {
                suspended = true
                entered.resolve()
                await release.promise
              }
              return result
            },
          })
          const owner = registry(fixture)
          await owner.start()
          const mutate = await mutationCall(fixture, owner, kind)
          armed = true
          issued = mutate()
          await entered.promise
          let finished = false
          disposing = owner.dispose().then(() => {
            finished = true
          })
          await waitForTurn()
          expect(finished).toBe(false)
          expect(() => registry(fixture)).toThrow('live registry')
          release.resolve()
          expect(await issued).toEqual({
            groupID: kind === 'seed' ? `${groupID}-new` : groupID,
            incarnation: kind === 'seed' ? 1 : 2,
          })
          await disposing
          const replacement = registry(fixture)
          await replacement.dispose()
        } finally {
          release.resolve()
          await issued
          await disposing
          await fixture.close()
        }
      },
    )

    test.each(['commit', 'rollback'] as const)(
      'dispose retains an issued switch hold until unknown outcome resolves as %s',
      async (result) => {
        const fixture = await create()
        let issued: Promise<unknown> | undefined
        let disposing: Promise<void> | undefined
        const fault = fixture.armWorkFault('disposal-switch', 'pending')
        const proof = fixture.holdProof('disposal-switch')
        try {
          const owner = registry(fixture)
          const mutate = await mutationCall(fixture, owner, 'switch')
          const access = await owner.access(groupID)
          issued = mutate().catch((error: unknown) => error)
          await fault.rejected
          await proof.started
          let finished = false
          disposing = owner.dispose().then(() => {
            finished = true
          })
          await waitForTurn()
          expect(finished).toBe(false)
          expect(access.runtime.snapshot()?.incarnation).toBe(1)
          expect(() => registryRetirement(owner).assertAvailable(groupID)).toThrow(
            RegistryRetiringError,
          )
          expect(() => registry(fixture)).toThrow('live registry')
          await fault.finish(result)
          proof.release()
          await issued
          await disposing
          expect(await fixture.device.groups.load(groupID)).toMatchObject({
            activeIncarnation: result === 'commit' ? 2 : 1,
          })
          expect((await fixture.device.groups.ports(key).control.load()).rejoin?.stage).toBe(
            result === 'commit' ? 'adopted' : 'confirmed',
          )
          const replacement = registry(fixture)
          await replacement.dispose()
        } finally {
          await fault.finish(result)
          proof.release()
          await issued
          await disposing
          await fixture.close()
        }
      },
    )

    test('dispose waits completion work submitted by a rejecting hook before releasing the binding', async () => {
      const fixture = await create()
      const entered = deferred<void>()
      const proof = fixture.holdProof('rejected-hook-completion')
      const fault = fixture.armWorkFault('rejected-hook-completion', 'pending')
      let writing: Promise<unknown> | undefined
      let disposing: Promise<unknown> | undefined
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        access.onRetire(async () => {
          writing = fixture.device.groups
            .ports(key)
            .control.apply({ deleteOutcomes: [] }, 'rejected-hook-completion')
            .catch((error: unknown) => error)
          entered.resolve()
          throw new Error('Hook rejected after submitting completion')
        })
        let finished = false
        disposing = owner.dispose().catch((error: unknown) => {
          finished = true
          return error
        })
        await entered.promise
        await fault.rejected
        await proof.started
        expect(finished).toBe(false)
        expect(() => registry(fixture)).toThrow('live registry')
        await fault.finish('rollback')
        proof.release()
        expect(await disposing).toBeInstanceOf(RegistryRetireHookError)
        await writing
        const replacement = registry(fixture)
        await replacement.dispose()
      } finally {
        await fault.finish('rollback')
        proof.release()
        await writing
        await disposing
        await fixture.close()
      }
    })
  })
}
