import { encodeClientState } from '@kumiai/mls'
import { forkEventID, type GroupForkEvidence, recoveryUnavailableEventID } from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import {
  bindEntryCapability,
  coordinatorBinding,
  type EntryReads,
  entryCapability,
} from '../src/entry-capability.js'
import {
  createGroupSafety,
  DisplacedGroupHandleError,
  ForkReportRefusedError,
  ManualRecoveryUnavailableError,
} from '../src/index.js'
import {
  GroupStateConflictError,
  GroupUnavailableError,
  RegistryRetiringError,
} from '../src/persistence-errors.js'
import type { GroupKey } from '../src/persistence-types.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { deferred } from '../src/runtime.js'
import {
  createRegistryFixture,
  type RegistryFixture,
  registryFixtureRestore,
  registryFixtureRetirement,
  registryFixtureSafety,
  registryFixtureSafetyParams,
} from './fixtures/registry.js'

function entry(fixture: RegistryFixture) {
  const value = entryCapability(fixture.device.groups)
  if (value === null) throw new Error('Missing entry capability')
  return value
}
async function safety(fixture: RegistryFixture) {
  return registryFixtureSafety(fixture)
}
async function authenticatorEvidence(
  fixture: RegistryFixture,
  key: GroupKey,
): Promise<GroupForkEvidence & { kind: 'epoch-authenticator' }> {
  const trust = await fixture.device.groups.loadTrust(key.groupID)
  if (trust === null) throw new Error('Missing trust')
  const local = trust.installed.authenticator.slice()
  const remote = local.slice()
  remote[0] = (remote[0] ?? 0) ^ 1
  return { kind: 'epoch-authenticator', epoch: trust.installed.epoch, local, remote }
}
function overrideReads(fixture: RegistryFixture, fn: (reads: EntryReads) => EntryReads) {
  const capability = entry(fixture)
  const binding = coordinatorBinding(fixture.device.groups)
  if (binding === null) throw new Error('Missing binding')
  bindEntryCapability({
    persistence: fixture.device.groups,
    coordinatorBinding: binding,
    capability: {
      ...capability,
      read: (groupID, read) => capability.read(groupID, (reads) => read(fn(reads))),
      run: (request, prepare, work) => capability.run(request, (reads) => prepare(fn(reads)), work),
    },
  })
}
async function queued(fixture: RegistryFixture, groupID: string) {
  const started = deferred<void>()
  const release = deferred<void>()
  const pending = entry(fixture).read(groupID, async () => {
    started.resolve()
    await release.promise
  })
  await started.promise
  return { release: () => release.resolve(), pending }
}
async function move(fixture: RegistryFixture, key: GroupKey, incarnation: number) {
  const record = await fixture.device.groups.loadState(key)
  const trust = await fixture.device.groups.loadTrust(key.groupID)
  if (record === null || record.deleted || record.state === null) throw new Error('Missing source')
  const handle =
    incarnation === key.incarnation
      ? await fixture.advance(
          await registryFixtureRestore(fixture)({ ...record, state: record.state }),
        )
      : await fixture.makeHandle(0)
  const nextKey = { ...key, incarnation }
  const next = {
    ...record,
    ...nextKey,
    version: incarnation === key.incarnation ? record.version + 1 : 1,
    state: encodeClientState(handle.state),
    epoch: Number(handle.epoch),
    epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
  }
  const mutationID = crypto.randomUUID()
  return () =>
    entry(fixture).run(
      { groupID: key.groupID, mutationID },
      async (reads) => ({ expected: await reads.lifetime(), value: null }),
      async (stores) => {
        const life = await stores.lifetime.load()
        if (life === null) throw new Error('Missing lifetime')
        if (incarnation !== key.incarnation)
          await stores.lifetime.save({
            ...life,
            latestIncarnation: incarnation,
            activeIncarnation: incarnation,
            revision: life.revision + 1,
            mutationID,
          })
        await stores.incarnation(incarnation).state.save(next)
        await stores.trust.save(recoveryTrustFor(handle, nextKey, trust))
      },
    )
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`group safety (${mode})`, () => {
    const groupID = `safety-${mode}`
    const key = { groupID, incarnation: 1 }
    const create = () => createRegistryFixture({ mode, groupID, setup: 'seeded' })

    test.each(['lifetime', 'apply'] as const)(
      'report preserves a %s conflict raised in work',
      async (boundary) => {
        const fixture = await create()
        try {
          const capability = entry(fixture)
          const binding = coordinatorBinding(fixture.device.groups)
          if (binding === null) throw new Error('Missing binding')
          const conflict = new GroupStateConflictError('Concurrent report transition moved')
          bindEntryCapability({
            persistence: fixture.device.groups,
            coordinatorBinding: binding,
            capability: {
              ...capability,
              run: (request, prepare, work) => {
                return capability.run(request, prepare, (stores, prepared) => {
                  return work(
                    {
                      ...stores,
                      lifetime: {
                        ...stores.lifetime,
                        load: async () => {
                          if (boundary === 'lifetime') throw conflict
                          return stores.lifetime.load()
                        },
                      },
                      incarnation: (incarnation) => {
                        const target = stores.incarnation(incarnation)
                        return {
                          ...target,
                          control: {
                            ...target.control,
                            apply: async () => {
                              throw conflict
                            },
                          },
                        }
                      },
                    },
                    prepared,
                  )
                })
              },
            },
          })
          const api = await safety(fixture)
          const before = await fixture.inspectRows()
          await expect(api.reportFork(key, await authenticatorEvidence(fixture, key))).rejects.toBe(
            conflict,
          )
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )

    test('report preserves invalid refusal for a control read conflict', async () => {
      const fixture = await create()
      try {
        const conflict = new GroupStateConflictError('Unreadable report control')
        overrideReads(fixture, (reads) => ({
          ...reads,
          control: async () => {
            throw conflict
          },
        }))
        const api = await safety(fixture)
        const before = await fixture.inspectRows()
        const work = api.reportFork(key, await authenticatorEvidence(fixture, key))
        await expect(work).rejects.toBeInstanceOf(GroupUnavailableError)
        await expect(work).rejects.toMatchObject({ reason: 'invalid', cause: conflict })
        expect(await fixture.inspectRows()).toEqual(before)
      } finally {
        await fixture.close()
      }
    })

    test('field-only safety projects cold and accounted admission', async () => {
      let fixture = await create()
      try {
        const access = await fixture.registry.access(groupID)
        const recovery = {
          ...key,
          id: recoveryUnavailableEventID(key),
          kind: 'group:recovery-unavailable' as const,
          reason: 'trust-unreadable' as const,
        }
        await fixture.installRows({ key, control: { recoveryUnavailable: recovery } })
        expect(access.admission()).toEqual({
          epoch: 0,
          admissible: false,
          reason: 'recovery-unavailable',
        })
        fixture = await fixture.reopen()
        const cold = await fixture.registry.access(groupID)
        expect(cold.admission()).toEqual({
          epoch: 0,
          admissible: false,
          reason: 'recovery-unavailable',
        })
        const halt = {
          eventID: forkEventID(key),
          evidence: await authenticatorEvidence(fixture, key),
          detectedAt: 42,
        }
        await fixture.installRows({ key, control: { forkHalt: halt } })
        expect(cold.admission()).toEqual({ epoch: 0, admissible: false, reason: 'fork-halted' })
        const api = await safety(fixture)
        expect((await api.events(key)).map((event) => event.kind).sort()).toEqual([
          'group:fork',
          'group:recovery-unavailable',
        ])
        await api.ackEvent(key, recovery.id)
        expect((await api.events(key)).map((event) => event.kind)).toEqual(['group:fork'])
        expect((await fixture.device.groups.ports(key).control.load()).recoveryUnavailable).toEqual(
          recovery,
        )
        expect(await fixture.device.groups.ports(key).control.load()).toMatchObject({
          strand: null,
          controlHold: null,
          forkHalt: halt,
        })
        fixture = await fixture.reopen()
        expect((await fixture.registry.access(groupID)).admission()).toEqual({
          epoch: 0,
          admissible: false,
          reason: 'fork-halted',
        })
      } finally {
        await fixture.close()
      }
    })

    test('committed identity survives unreadable state', async () => {
      const fixture = await create()
      try {
        const api = await safety(fixture)
        const expected = (await fixture.device.groups.loadTrust(groupID))?.installed
        await fixture.corruptState(key)
        const result = await api.epochAuthenticator(key)
        expect(result).toEqual(expected)
        result?.authenticator.fill(0)
        expect(await api.epochAuthenticator(key)).toEqual(expected)
        for (const wrong of [
          { ...key, groupID: 'absent' },
          { ...key, incarnation: 2 },
          { ...key, incarnation: 0 },
        ])
          expect(await api.epochAuthenticator(wrong)).toBeNull()
        await fixture.corruptTrust(groupID)
        expect(await api.epochAuthenticator(key)).toBeNull()
      } finally {
        await fixture.close()
      }
    })

    test('transient trust errors propagate unchanged', async () => {
      const fixture = await create()
      try {
        const error = new Error('Transient trust I/O')
        let fail = false
        overrideReads(fixture, (reads) => ({
          ...reads,
          trust: async () => {
            if (fail) throw error
            return await reads.trust()
          },
        }))
        const access = await fixture.registry.access(groupID)
        fail = true
        const api = await safety(fixture)
        await expect(api.epochAuthenticator(key)).rejects.toBe(error)
        await expect(
          api.reportFork(key, {
            kind: 'unexplained-own-commit',
            epoch: 0,
            position: '1',
            digest: 'unexpected',
          }),
        ).rejects.toBe(error)
        expect(access.admission()).toMatchObject({ admissible: true })
      } finally {
        await fixture.close()
      }
    })

    test('validated report latches in prepare and completion waits for proof', async () => {
      const fixture = await create()
      const held = deferred<void>()
      const release = deferred<void>()
      try {
        const access = await fixture.registry.access(groupID)
        const api = await safety(fixture)
        const evidence = await authenticatorEvidence(fixture, key)
        const notifications: Array<unknown> = []
        access.runtime.onEpochChanged((value) => notifications.push(value))
        fixture.onPhase('work', async () => {
          held.resolve()
          await release.promise
        })
        const fault = fixture.armNextWorkFault('pending')
        let completed = false
        const report = api.reportFork(key, evidence).then(() => {
          completed = true
        })
        await held.promise
        expect(access.admission()).toEqual({ epoch: 0, admissible: false, reason: 'fork-halted' })
        expect(notifications).toEqual([])
        release.resolve()
        await fault.rejected
        expect(completed).toBe(false)
        expect(notifications).toEqual([])
        await fault.finish('commit')
        await report
        expect(await api.events(key)).toHaveLength(1)
        expect(notifications).toHaveLength(1)
      } finally {
        release.resolve()
        await fixture.close()
      }
    })

    test.each(['displaced', 'retiring', 'disposed'] as const)(
      'latched admission preserves the %s access error',
      async (state) => {
        const fixture = await create()
        try {
          const access = await fixture.registry.access(groupID)
          const api = await safety(fixture)
          await api.reportFork(key, await authenticatorEvidence(fixture, key))
          expect(access.admission()).toEqual({
            epoch: 0,
            admissible: false,
            reason: 'fork-halted',
          })
          if (state === 'retiring') {
            const attempt = registryFixtureRetirement(fixture.registry).beginRetirement(key)
            try {
              expect(access.admission).toThrow(new RegistryRetiringError({ key }))
            } finally {
              attempt.settle('rolled-back')
            }
            expect(access.admission()).toMatchObject({ reason: 'fork-halted' })
          } else {
            if (state === 'displaced') await (await move(fixture, key, 2))()
            else await fixture.registry.dispose()
            expect(access.admission).toThrow(
              new DisplacedGroupHandleError(
                state === 'displaced'
                  ? 'Registry owner is no longer current'
                  : 'Registry is disposed',
              ),
            )
          }
        } finally {
          await fixture.close()
        }
      },
    )

    test.each(['epoch', 'incarnation'] as const)(
      'report refuses moved %s identity',
      async (kind) => {
        const fixture = await create()
        try {
          const api = await safety(fixture)
          const evidence = await authenticatorEvidence(fixture, key)
          const advance = await move(fixture, key, kind === 'epoch' ? 1 : 2)
          const hold = await queued(fixture, groupID)
          const moving = advance()
          const report = api.reportFork(key, evidence)
          const refused = expect(report).rejects.toMatchObject({
            name: 'ForkReportRefusedError',
            reason: kind === 'epoch' ? 'epoch' : 'key',
          })
          hold.release()
          await moving
          const rows = await fixture.inspectRows()
          await refused
          expect(await fixture.inspectRows()).toEqual(rows)
          expect(await api.events(key)).toEqual([])
          expect((await fixture.registry.access(groupID)).admission().admissible).toBe(true)
        } finally {
          await fixture.close()
        }
      },
    )

    test.each(['key', 'local', 'remote', 'future'] as const)(
      'report refuses invalid %s evidence without writes or latch',
      async (invalid) => {
        const fixture = await create()
        try {
          const api = await safety(fixture)
          const access = await fixture.registry.access(groupID)
          const evidence = await authenticatorEvidence(fixture, key)
          if (invalid === 'local') evidence.local[0] = (evidence.local[0] ?? 0) ^ 1
          if (invalid === 'remote') evidence.remote = evidence.local.slice()
          const supplied =
            invalid === 'future'
              ? {
                  kind: 'unexplained-own-commit' as const,
                  epoch: 1,
                  position: '1',
                  digest: 'future',
                }
              : evidence
          if (invalid === 'key') await api.epochAuthenticator({ ...key, groupID: 'wrong' })
          const rows = await fixture.inspectRows()
          await expect(
            api.reportFork(invalid === 'key' ? { ...key, groupID: 'wrong' } : key, supplied),
          ).rejects.toMatchObject({
            name: 'ForkReportRefusedError',
            reason: invalid === 'key' ? 'key' : invalid === 'future' ? 'epoch' : 'authenticator',
          })
          expect(await fixture.inspectRows()).toEqual(rows)
          expect(access.admission().admissible).toBe(true)
          expect(await api.events(key)).toEqual([])
        } finally {
          await fixture.close()
        }
      },
    )

    test('digest reports remain admissible after an epoch move', async () => {
      const fixture = await create()
      try {
        const api = await safety(fixture)
        const advance = await move(fixture, key, 1)
        const hold = await queued(fixture, groupID)
        const moving = advance()
        const report = api.reportFork(key, {
          kind: 'digest-divergence',
          epoch: 0,
          position: '1',
          localDigest: 'local',
          remoteDigest: 'remote',
        })
        hold.release()
        await moving
        await report
        expect(await api.events(key)).toHaveLength(1)
      } finally {
        await fixture.close()
      }
    })

    test('report snapshots caller evidence and key before await', async () => {
      const fixture = await create()
      try {
        const api = await safety(fixture)
        const supplied = { ...key }
        const evidence = await authenticatorEvidence(fixture, key)
        const expected = {
          ...evidence,
          local: evidence.local.slice(),
          remote: evidence.remote.slice(),
        }
        const hold = await queued(fixture, groupID)
        const clock = vi.spyOn(Date, 'now').mockReturnValue(123)
        const report = api.reportFork(supplied, evidence)
        clock.mockReturnValue(456)
        supplied.incarnation = 9
        evidence.epoch = 9
        evidence.local.fill(0)
        evidence.remote.fill(0)
        hold.release()
        await report
        const halt = (await fixture.device.groups.ports(key).control.load()).forkHalt
        expect(halt?.evidence).toEqual(expected)
        expect(halt?.detectedAt).toBe(123)
        clock.mockRestore()
      } finally {
        vi.restoreAllMocks()
        await fixture.close()
      }
    })

    test('unreadable report trust persists recovery refusal', async () => {
      const fixture = await create()
      try {
        const access = await fixture.registry.access(groupID)
        const api = await safety(fixture)
        const evidence = await authenticatorEvidence(fixture, key)
        await fixture.corruptTrust(groupID)
        const rows = await fixture.inspectRows()
        await expect(api.reportFork(key, evidence)).rejects.toMatchObject({
          name: 'GroupSafetyHeldError',
          reason: 'recovery-unavailable',
        })
        expect(access.runtime.snapshot()).toBeNull()
        expect(await api.events(key)).toEqual([
          {
            ...key,
            id: recoveryUnavailableEventID(key),
            kind: 'group:recovery-unavailable',
            reason: 'trust-unreadable',
          },
        ])
        expect(await fixture.inspectRows()).not.toEqual(rows)
      } finally {
        await fixture.close()
      }
    })

    test('existing-halt report and ack are storage-neutral and tombstone ack preserves safety', async () => {
      const fixture = await create()
      try {
        const api = await safety(fixture)
        const evidence = await authenticatorEvidence(fixture, key)
        await api.reportFork(key, evidence)
        const halt = (await fixture.device.groups.ports(key).control.load()).forkHalt
        await fixture.installRows({
          key,
          events: [
            {
              ...key,
              id: 'app',
              kind: 'accepted',
              entry: {
                seq: 1,
                protocol: 'app',
                prc: 'message',
                data: new Uint8Array([9]),
                status: 'accepted',
                lastAttempt: null,
              },
            },
          ],
        })
        let rows = await fixture.inspectRows()
        await api.reportFork(key, {
          ...evidence,
          epoch: 999,
          local: new Uint8Array(),
          remote: new Uint8Array(),
        })
        await api.reportFork(key, evidence)
        await api.ackEvent(key, 'absent')
        await expect(api.ackEvent(key, 'app')).rejects.toBeInstanceOf(TypeError)
        expect(await fixture.inspectRows()).toEqual(rows)
        const events = await api.events(key)
        expect(events).toHaveLength(1)
        const first = events[0]
        if (first?.kind !== 'group:fork' || first.halt.evidence.kind !== 'epoch-authenticator')
          throw new Error('Missing authenticator event')
        first.halt.evidence.local.fill(0)
        expect((await fixture.device.groups.ports(key).control.load()).forkHalt).toEqual(halt)
        await fixture.registry.delete(key)
        expect(await api.epochAuthenticator(key)).toBeNull()
        await api.ackEvent(key, forkEventID(key))
        expect(await api.events(key)).toEqual([])
        expect((await fixture.device.groups.ports(key).control.load()).forkHalt).toEqual(halt)
        rows = await fixture.inspectRows()
        await api.ackEvent(key, forkEventID(key))
        await api.reportFork(key, evidence)
        expect(await fixture.inspectRows()).toEqual(rows)
        const appEvents = await entry(fixture).read(groupID, (reads) => reads.events(1))
        expect(appEvents.map((event) => event.id)).toEqual(['app'])
      } finally {
        await fixture.close()
      }
    })

    test('report rollback isolates incarnation latch and unreadable state displaces access', async () => {
      const fixture = await create()
      try {
        const access = await fixture.registry.access(groupID)
        const api = await safety(fixture)
        const evidence = await authenticatorEvidence(fixture, key)
        const rows = await fixture.inspectRows()
        fixture.armNextWorkFault('before-commit')
        await expect(api.reportFork(key, evidence)).rejects.toBeDefined()
        expect(await fixture.inspectRows()).toEqual(rows)
        expect(access.admission()).toMatchObject({ reason: 'fork-halted' })
        await fixture.corruptState(key)
        await fixture.device.groups
          .ports(key)
          .control.apply({ cursor: { position: null, epoch: 0 } }, 'unreadable')
        expect(access.runtime.snapshot()).toBeNull()
        expect(access.admission).toThrow(
          new DisplacedGroupHandleError('Registry owner is no longer current'),
        )
      } finally {
        await fixture.close()
      }
      const fresh = await create()
      try {
        const access = await fresh.registry.access(groupID)
        const api = await safety(fresh)
        fresh.armNextWorkFault('before-commit')
        await expect(
          api.reportFork(key, await authenticatorEvidence(fresh, key)),
        ).rejects.toBeDefined()
        await (await move(fresh, key, 2))()
        expect(access.runtime.snapshot()).toBeNull()
        expect(access.admission).toThrow(
          new DisplacedGroupHandleError('Registry owner is no longer current'),
        )
        expect((await fresh.registry.access(groupID)).admission().admissible).toBe(true)
        expect(await api.epochAuthenticator(key)).toBeNull()
      } finally {
        await fresh.close()
      }
    })

    test('factory rejects foreign binding and unregistered registry; recovery stays unavailable', async () => {
      const fixture = await create()
      const foreign = await createRegistryFixture({
        mode,
        groupID: `${groupID}-foreign`,
        setup: 'seeded',
      })
      try {
        const params = await registryFixtureSafetyParams(fixture)
        expect(() => createGroupSafety({ ...params, registry: { ...params.registry } })).toThrow(
          TypeError,
        )
        expect(() => createGroupSafety({ ...params, persistence: foreign.device.groups })).toThrow(
          TypeError,
        )
        const api = createGroupSafety(params)
        for (const choice of [
          { mode: 'resync' as const, targetID: 'hub' },
          { mode: 'successor' as const, successor: key },
        ])
          await expect(api.recover(key, choice)).rejects.toBeInstanceOf(
            ManualRecoveryUnavailableError,
          )
        expect(new ForkReportRefusedError({ reason: 'authenticator' })).toMatchObject({
          name: 'ForkReportRefusedError',
          reason: 'authenticator',
        })
      } finally {
        await fixture.close()
        await foreign.close()
      }
    })
  })
}
