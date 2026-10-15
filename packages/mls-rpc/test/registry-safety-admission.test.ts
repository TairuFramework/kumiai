import { encodeClientState } from '@kumiai/mls'
import {
  forkEventID,
  GroupSafetyHeldError,
  recoveryUnavailableEventID,
  type SafetyHold,
} from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import {
  bindEntryCapability,
  coordinatorBinding,
  type EntryReads,
  entryCapability,
} from '../src/entry-capability.js'
import { GroupStateConflictError, GroupUnavailableError } from '../src/persistence-errors.js'
import type { GroupKey } from '../src/persistence-types.js'
import { RetainedTrustUnavailableError, registrySafety } from '../src/registry/safety.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { deferred } from '../src/runtime.js'
import {
  createRegistryFixture,
  type RegistryFixture,
  registryFixtureCorruptControl,
  registryFixtureRemoveTrust,
  registryFixtureSafety,
} from './fixtures/registry.js'

function entry(fixture: RegistryFixture) {
  const value = entryCapability(fixture.device.groups)
  if (value === null) throw new Error('Missing entry')
  return value
}
function intercept(fixture: RegistryFixture, fn: (reads: EntryReads) => EntryReads) {
  const capability = entry(fixture)
  const binding = coordinatorBinding(fixture.device.groups)
  if (binding === null) throw new Error('Missing binding')
  bindEntryCapability({
    persistence: fixture.device.groups,
    coordinatorBinding: binding,
    capability: {
      ...capability,
      read: (id, read) => capability.read(id, (reads) => read(fn(reads))),
      run: (request, prepare, work) => capability.run(request, (reads) => prepare(fn(reads)), work),
    },
  })
}
async function setHold(fixture: RegistryFixture, key: GroupKey, reason: NonNullable<SafetyHold>) {
  await fixture.device.groups.ports(key).control.apply(
    reason === 'fork-halted'
      ? {
          forkHalt: {
            eventID: forkEventID(key),
            detectedAt: 1,
            evidence: {
              kind: 'digest-divergence',
              epoch: 0,
              position: '1',
              localDigest: 'local',
              remoteDigest: 'remote',
            },
          },
        }
      : {
          recoveryUnavailable: {
            ...key,
            id: recoveryUnavailableEventID(key),
            kind: 'group:recovery-unavailable',
            reason: 'trust-unreadable',
          },
        },
    crypto.randomUUID(),
  )
}
function expectedRecovery(key: GroupKey) {
  return {
    ...key,
    id: JSON.stringify(['group:recovery-unavailable', key.groupID, key.incarnation]),
    kind: 'group:recovery-unavailable',
    reason: 'trust-unreadable',
  }
}
async function durableDiagnosis(fixture: RegistryFixture, key: GroupKey) {
  const control = await fixture.device.groups.ports(key).control.load()
  expect(control).toMatchObject({
    recoveryUnavailable: expectedRecovery(key),
    forkHalt: null,
    strand: null,
    controlHold: null,
  })
  expect(await (await registryFixtureSafety(fixture)).events(key)).toEqual([expectedRecovery(key)])
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`registry safety admission (${mode})`, () => {
    const groupID = `safety-admission-${mode}`
    const key = { groupID, incarnation: 1 }
    const create = () => createRegistryFixture({ mode, groupID, setup: 'seeded' })

    test.each(['source', 'access', 'read', 'mutate', 'replace', 'adopt'] as const)(
      '%s preserves trust diagnosis when hold persistence fails',
      async (operation) => {
        const fixture = await create()
        try {
          let armed = false
          const trustFailure = new GroupStateConflictError('Corrupt retained trust')
          const persistFailure = new Error('Hold persistence write failed')
          intercept(fixture, (reads) => ({
            ...reads,
            trust: async () => {
              if (armed) throw trustFailure
              return reads.trust()
            },
          }))
          const capability = entry(fixture)
          const binding = coordinatorBinding(fixture.device.groups)
          if (binding === null) throw new Error('Missing binding')
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
                      incarnation: (incarnation) => {
                        const target = stores.incarnation(incarnation)
                        return {
                          ...target,
                          control: {
                            ...target.control,
                            apply: async (...args) => {
                              if (armed) throw persistFailure
                              await target.control.apply(...args)
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
          const owner = fixture.registry
          const access = await owner.access(groupID)
          const accepted = await fixture.acceptedOrdinary(access)
          const callback = vi.fn(async () => 1)
          const adoption = vi.fn(() => accepted.write)
          const before = await fixture.inspectRows()
          armed = true
          const work =
            operation === 'source'
              ? owner.recoverySource(groupID)
              : operation === 'access'
                ? owner.access(groupID)
                : operation === 'read'
                  ? access.read(callback)
                  : operation === 'mutate'
                    ? access.mutate(callback, adoption)
                    : operation === 'replace'
                      ? access.replace(accepted.candidate, adoption)
                      : access.adopt(accepted.candidate, accepted.expected, accepted.write)
          const mutation = ['mutate', 'replace', 'adopt'].includes(operation)
          await expect(work).rejects.toBeInstanceOf(
            mutation ? GroupSafetyHeldError : RetainedTrustUnavailableError,
          )
          await expect(work).rejects.toMatchObject({ reason: 'recovery-unavailable' })
          if (!mutation) await expect(work).rejects.toMatchObject({ cause: trustFailure })
          expect(registrySafety(owner)?.held(key)).toBe('recovery-unavailable')
          expect(callback).not.toHaveBeenCalled()
          expect(adoption).not.toHaveBeenCalled()
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )

    for (const cache of ['cached', 'uncached'] as const) {
      for (const reason of ['fork-halted', 'recovery-unavailable'] as const) {
        test.each(['mutate', 'replace', 'adopt'] as const)(
          `%s stops before ${cache} restore when ${reason} arrives during state read`,
          async (operation) => {
            const fixture = await create()
            try {
              let armed = false
              intercept(fixture, (reads) => ({
                ...reads,
                metadata: async (incarnation) => {
                  const metadata = await reads.metadata(incarnation)
                  return armed && cache === 'uncached' && metadata !== null
                    ? { ...metadata, version: metadata.version + 1 }
                    : metadata
                },
                state: async (incarnation) => {
                  const record = await reads.state(incarnation)
                  if (armed) registrySafety(fixture.registry)?.latch(key, reason)
                  return armed && cache === 'uncached' && record !== null
                    ? { ...record, version: record.version + 1 }
                    : record
                },
              }))
              const access = await fixture.registry.access(groupID)
              const accepted = await fixture.acceptedOrdinary(access)
              const callback = vi.fn(async () => true)
              const adoption = vi.fn(() => accepted.write)
              const restores = fixture.restoreCount(groupID)
              const rows = await fixture.inspectRows()
              armed = true
              const work =
                operation === 'mutate'
                  ? access.mutate(callback, adoption)
                  : operation === 'replace'
                    ? access.replace(accepted.candidate, adoption, callback)
                    : access.adopt(accepted.candidate, accepted.expected, accepted.write)
              await expect(work).rejects.toBeInstanceOf(GroupSafetyHeldError)
              await expect(work).rejects.toMatchObject({ reason })
              expect(fixture.restoreCount(groupID)).toBe(restores)
              expect(callback).not.toHaveBeenCalled()
              expect(adoption).not.toHaveBeenCalled()
              expect(await fixture.inspectRows()).toEqual(rows)
            } finally {
              await fixture.close()
            }
          },
        )
      }
    }

    for (const reason of ['fork-halted', 'recovery-unavailable'] as const) {
      test.each(['mutate', 'replace', 'adopt'] as const)(
        `queued %s refuses before callbacks (${reason})`,
        async (operation) => {
          const fixture = await create()
          try {
            const access = await fixture.registry.access(groupID)
            const accepted = await fixture.acceptedOrdinary(access)
            const gate = deferred<void>()
            const started = deferred<void>()
            const blocking = entry(fixture).read(groupID, async () => {
              started.resolve()
              await gate.promise
            })
            await started.promise
            const callback = vi.fn(async () => true)
            const adoption = vi.fn(() => accepted.write)
            const work =
              operation === 'mutate'
                ? access.mutate(async () => {
                    callback()
                    return 1
                  }, adoption)
                : operation === 'replace'
                  ? access.replace(accepted.candidate, adoption, callback)
                  : access.adopt(accepted.candidate, accepted.expected, accepted.write)
            const assertion = expect(work).rejects.toMatchObject({
              name: 'GroupSafetyHeldError',
              reason,
            })
            registrySafety(fixture.registry)?.latch(key, reason)
            const rows = await fixture.inspectRows()
            gate.resolve()
            await blocking
            await assertion
            expect(callback).not.toHaveBeenCalled()
            expect(adoption).not.toHaveBeenCalled()
            expect(await fixture.inspectRows()).toEqual(rows)
          } finally {
            await fixture.close()
          }
        },
      )
      test.each(['mutate', 'replace', 'adopt'] as const)(
        `prepared %s rechecks safety in work (${reason})`,
        async (operation) => {
          const fixture = await create()
          try {
            const access = await fixture.registry.access(groupID)
            const accepted = operation === 'mutate' ? null : await fixture.acceptedOrdinary(access)
            const before = await fixture.inspectRows()
            fixture.onPhase('work', () => {
              registrySafety(fixture.registry)?.latch(key, reason)
            })
            await expect(
              accepted === null
                ? access.mutate(async () => 1)
                : operation === 'replace'
                  ? access.replace(accepted.candidate, () => accepted.write)
                  : access.adopt(accepted.candidate, accepted.expected, accepted.write),
            ).rejects.toMatchObject({ name: 'GroupSafetyHeldError', reason })
            expect(await fixture.inspectRows()).toEqual(before)
          } finally {
            await fixture.close()
          }
        },
      )
      test(`committed safety gates mutate and replacement factory: ${reason}`, async () => {
        const fixture = await create()
        try {
          const access = await fixture.registry.access(groupID)
          const accepted = await fixture.acceptedOrdinary(access)
          await setHold(fixture, key, reason)
          const before = await fixture.inspectRows()
          const callback = vi.fn(async () => 1)
          const adoption = vi.fn(() => accepted.write)
          await expect(access.mutate(callback)).rejects.toMatchObject({
            name: 'GroupSafetyHeldError',
            reason,
          })
          await expect(access.replace(accepted.candidate, adoption)).rejects.toMatchObject({
            name: 'GroupSafetyHeldError',
            reason,
          })
          expect(callback).not.toHaveBeenCalled()
          expect(adoption).not.toHaveBeenCalled()
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      })
    }

    test.each(['fork-halted', 'recovery-unavailable'] as const)(
      'proven adoption replay remains storage-neutral under %s',
      async (reason) => {
        const fixture = await create()
        try {
          const access = await fixture.registry.access(groupID)
          const accepted = await fixture.acceptedOrdinary(access)
          expect(await access.adopt(accepted.candidate, accepted.expected, accepted.write)).toBe(
            'installed',
          )
          await setHold(fixture, key, reason)
          const before = await fixture.inspectRows()
          expect(await access.adopt(accepted.candidate, accepted.expected, accepted.write)).toBe(
            'noop',
          )
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )
    test.each(['fork-halted', 'recovery-unavailable'] as const)(
      'retirement hook-created %s prevents switch installation',
      async (reason) => {
        const fixture = await create()
        try {
          const recovery = await fixture.confirmedRecovery(key, { confirm: true })
          const owner = fixture.registry
          const access = await owner.access(groupID)
          let afterHook: Awaited<ReturnType<RegistryFixture['inspectRows']>> | undefined
          access.onRetire(async () => {
            await setHold(fixture, key, reason)
            afterHook = await fixture.inspectRows()
          })
          await expect(
            owner.switchIncarnation(recovery.candidate, {
              source: recovery.source,
              rejoinID: recovery.record.id,
              proof: recovery.proof,
              write: {
                mutationID: crypto.randomUUID(),
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
            }),
          ).rejects.toMatchObject({ name: 'RegistryResyncRefusedError', reason })
          expect(afterHook).toBeDefined()
          expect((await fixture.device.groups.load(groupID))?.activeIncarnation).toBe(1)
          expect(await fixture.device.groups.loadState({ groupID, incarnation: 2 })).toBeNull()
          expect(await fixture.inspectRows()).toEqual(afterHook)
        } finally {
          await fixture.close()
        }
      },
    )
    test.each(['seed', 'switch'] as const)(
      'failed fork report latch refuses %s before retirement drain',
      async (operation) => {
        const fixture = await create()
        try {
          const recovery =
            operation === 'switch' ? await fixture.confirmedRecovery(key, { confirm: true }) : null
          const owner = fixture.registry
          const access = await owner.access(groupID)
          const hook = vi.fn(async () => {})
          access.onRetire(hook)
          const api = await registryFixtureSafety(fixture)
          const pushed: Array<SafetyHold> = []
          const unsubscribe = registrySafety(owner)?.onSafetyHold(key, (reason) =>
            pushed.push(reason),
          )
          fixture.armNextWorkFault('before-commit')
          await expect(
            api.reportFork(key, {
              kind: 'unexplained-own-commit',
              epoch: 0,
              position: '1',
              digest: 'fork',
            }),
          ).rejects.toThrow()
          expect(pushed).toEqual(['fork-halted'])
          unsubscribe?.()
          expect((await fixture.device.groups.ports(key).control.load()).forkHalt).toBeNull()
          expect(access.admission()).toMatchObject({ admissible: false, reason: 'fork-halted' })
          const before = await fixture.inspectRows()
          if (recovery === null) {
            await expect(
              owner.seed(await fixture.makeHandle(2), {
                replace: true,
                packageUse: { sourceID: 'source', ref: 'fresh', kind: 'ordinary' },
              }),
            ).rejects.toMatchObject({ reason: 'fork-halted' })
          } else {
            await expect(
              owner.switchIncarnation(recovery.candidate, {
                source: recovery.source,
                rejoinID: recovery.record.id,
                proof: recovery.proof,
                write: {
                  mutationID: crypto.randomUUID(),
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
              }),
            ).rejects.toMatchObject({ name: 'RegistryResyncRefusedError', reason: 'fork-halted' })
          }
          expect(hook).not.toHaveBeenCalled()
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )
    test.each(['missing', 'corrupt', 'empty-spent'] as const)(
      'seed preserves surviving %s spent requirement',
      async (damage) => {
        const fixture = await create()
        try {
          if (damage === 'empty-spent')
            intercept(fixture, (reads) => ({
              ...reads,
              trust: async () => {
                const trust = await reads.trust()
                return trust === null ? null : { ...trust, spentEpochAuthenticators: [] }
              },
            }))
          const owner = fixture.registry
          if (damage === 'missing') await registryFixtureRemoveTrust(fixture, groupID)
          if (damage === 'corrupt') await fixture.corruptTrust(groupID)
          const fresh = await fixture.makeHandle(2)
          const before = await fixture.inspectRows()
          await expect(
            owner.seed(fresh, {
              replace: true,
              packageUse: { sourceID: 'source', ref: 'fresh', kind: 'ordinary' },
            }),
          ).rejects.toMatchObject({ name: 'SeedAdmissionRefusedError', reason: 'unavailable' })
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )
    test.each(['source', 'report', 'authenticator'] as const)(
      'installed-key mismatch at %s stays invalid without writing',
      async (operation) => {
        const fixture = await create()
        try {
          intercept(fixture, (reads) => ({
            ...reads,
            trust: async () => {
              const trust = await reads.trust()
              return trust === null
                ? null
                : { ...trust, installed: { ...trust.installed, incarnation: 2 } }
            },
          }))
          const owner = fixture.registry
          const api = await registryFixtureSafety(fixture)
          const before = await fixture.inspectRows()
          await expect(
            operation === 'source'
              ? owner.recoverySource(groupID)
              : operation === 'report'
                ? api.reportFork(key, {
                    kind: 'unexplained-own-commit',
                    epoch: 0,
                    position: '1',
                    digest: 'fork',
                  })
                : api.epochAuthenticator(key),
          ).rejects.toMatchObject({ name: 'GroupUnavailableError', reason: 'invalid' })
          expect(await api.events(key)).toEqual([])
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )

    test.each(['seed', 'switch'] as const)(
      'prepared %s refuses a pending fork latch in work',
      async (operation) => {
        const fixture = await create()
        try {
          const recovery =
            operation === 'switch' ? await fixture.confirmedRecovery(key, { confirm: true }) : null
          const owner = fixture.registry
          await owner.access(groupID)
          const fresh = recovery === null ? await fixture.makeHandle(2) : recovery.candidate
          const before = await fixture.inspectRows()
          fixture.onPhase('work', () => {
            registrySafety(owner)?.latch(key, 'fork-halted')
          })
          await expect(
            recovery === null
              ? owner.seed(fresh, {
                  replace: true,
                  packageUse: { sourceID: 'source', ref: 'fresh', kind: 'ordinary' },
                })
              : owner.switchIncarnation(fresh, {
                  source: recovery.source,
                  rejoinID: recovery.record.id,
                  proof: recovery.proof,
                  write: {
                    mutationID: crypto.randomUUID(),
                    source: { rejoinID: recovery.record.id },
                    destination: {
                      control: {
                        cursor: { position: recovery.proof.position, epoch: Number(fresh.epoch) },
                      },
                    },
                  },
                }),
          ).rejects.toMatchObject({ reason: 'fork-halted' })
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )
    test('failed trust-loss write retains incarnation latch', async () => {
      const fixture = await create()
      let reopened: RegistryFixture | undefined
      try {
        const owner = fixture.registry
        await owner.access(groupID)
        await fixture.corruptTrust(groupID)
        fixture.armNextWorkFault('before-commit')
        await expect(owner.recoverySource(groupID)).rejects.toThrow()
        expect(registrySafety(owner)?.held(key)).toBe('recovery-unavailable')
        expect(
          (await fixture.device.groups.ports(key).control.load()).recoveryUnavailable,
        ).toBeNull()
        reopened = await fixture.reopen()
        expect(
          (await reopened.device.groups.ports(key).control.load()).recoveryUnavailable,
        ).toBeNull()
        expect(registrySafety(reopened.registry)?.held(key)).toBeNull()
      } finally {
        await reopened?.close()
        await fixture.close()
      }
    })
    test.each(['missing', 'corrupt', 'empty-spent'] as const)(
      'epoch authenticator observes %s trust loss without writes',
      async (damage) => {
        const fixture = await create()
        try {
          if (damage === 'empty-spent')
            intercept(fixture, (reads) => ({
              ...reads,
              trust: async () => {
                const trust = await reads.trust()
                return trust === null ? null : { ...trust, spentEpochAuthenticators: [] }
              },
            }))
          const owner = fixture.registry
          const api = await registryFixtureSafety(fixture)
          if (damage === 'missing') await registryFixtureRemoveTrust(fixture, groupID)
          if (damage === 'corrupt') await fixture.corruptTrust(groupID)
          const before = await fixture.inspectRows()
          expect(await api.epochAuthenticator(key)).toBeNull()
          expect(registrySafety(owner)?.held(key)).toBeNull()
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )

    test('diagnosis for a moved lifetime installs no hold on the new owner', async () => {
      const fixture = await create()
      try {
        const capability = entry(fixture)
        const binding = coordinatorBinding(fixture.device.groups)
        if (binding === null) throw new Error('Missing binding')
        const handle = await fixture.makeHandle(0)
        const trust = await fixture.device.groups.loadTrust(groupID)
        const record = await fixture.device.groups.loadState(key)
        if (record === null || record.deleted || record.state === null)
          throw new Error('Missing source')
        const nextKey = { groupID, incarnation: 2 }
        let loseTrust = true
        let move = true
        bindEntryCapability({
          persistence: fixture.device.groups,
          coordinatorBinding: binding,
          capability: {
            ...capability,
            read: (id, read) =>
              capability.read(id, (reads) =>
                read({
                  ...reads,
                  trust: async () => {
                    if (loseTrust) {
                      loseTrust = false
                      return null
                    }
                    return reads.trust()
                  },
                }),
              ),
            async run(request, prepare, work) {
              if (move) {
                move = false
                const mutationID = crypto.randomUUID()
                await capability.run(
                  { groupID, mutationID },
                  async (reads) => ({ expected: await reads.lifetime(), value: null }),
                  async (stores) => {
                    const lifetime = await stores.lifetime.load()
                    if (lifetime === null) throw new Error('Missing lifetime')
                    await stores.lifetime.save({
                      ...lifetime,
                      activeIncarnation: 2,
                      latestIncarnation: 2,
                      revision: lifetime.revision + 1,
                      mutationID,
                    })
                    await stores.incarnation(2).state.save({
                      ...record,
                      ...nextKey,
                      version: 1,
                      epoch: 0,
                      epochAuthenticator: handle.state.keySchedule.epochAuthenticator,
                      state: encodeClientState(handle.state),
                      credential: handle.credential,
                      ledger: handle.ledgerTokens,
                    })
                    await stores.trust.save(recoveryTrustFor(handle, nextKey, trust))
                  },
                )
              }
              return capability.run(request, prepare, work)
            },
          },
        })
        const owner = fixture.registry
        await expect(owner.recoverySource(groupID)).rejects.toMatchObject({
          reason: 'recovery-unavailable',
        })
        expect(registrySafety(owner)?.held(key)).toBeNull()
        expect(registrySafety(owner)?.held(nextKey)).toBeNull()
        expect(
          (await fixture.device.groups.ports(key).control.load()).recoveryUnavailable,
        ).toBeNull()
        expect(
          (await fixture.device.groups.ports(nextKey).control.load()).recoveryUnavailable,
        ).toBeNull()
        expect((await owner.access(groupID)).admission().admissible).toBe(true)
      } finally {
        await fixture.close()
      }
    })

    test('repeated trust diagnosis after event acknowledgement writes nothing', async () => {
      const fixture = await create()
      try {
        const owner = fixture.registry
        const api = await registryFixtureSafety(fixture)
        await fixture.corruptTrust(groupID)
        await expect(owner.recoverySource(groupID)).rejects.toMatchObject({
          reason: 'recovery-unavailable',
        })
        await api.ackEvent(key, recoveryUnavailableEventID(key))
        const before = await fixture.inspectRows()
        await expect(owner.recoverySource(groupID)).rejects.toMatchObject({
          reason: 'recovery-unavailable',
        })
        expect(await api.events(key)).toEqual([])
        expect((await fixture.device.groups.ports(key).control.load()).recoveryUnavailable).toEqual(
          expectedRecovery(key),
        )
        expect(await fixture.inspectRows()).toEqual(before)
      } finally {
        await fixture.close()
      }
    })

    test.each(['fork-halted', 'recovery-unavailable'] as const)(
      'replacement factory rechecks %s after lifetime await',
      async (reason) => {
        const fixture = await create()
        try {
          let armed = false
          let lifetimes = 0
          intercept(fixture, (reads) => ({
            ...reads,
            lifetime: async () => {
              const lifetime = await reads.lifetime()
              if (armed && ++lifetimes === 2) registrySafety(fixture.registry)?.latch(key, reason)
              return lifetime
            },
          }))
          const access = await fixture.registry.access(groupID)
          const accepted = await fixture.acceptedOrdinary(access)
          const factory = vi.fn(() => accepted.write)
          armed = true
          const before = await fixture.inspectRows()
          await expect(access.replace(accepted.candidate, factory)).rejects.toMatchObject({
            name: 'GroupSafetyHeldError',
            reason,
          })
          expect(factory).not.toHaveBeenCalled()
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )
    test.each(['fork-halted', 'recovery-unavailable'] as const)(
      'switch rechecks %s between preflight and drain',
      async (reason) => {
        const fixture = await create()
        try {
          const capability = entry(fixture)
          const binding = coordinatorBinding(fixture.device.groups)
          if (binding === null) throw new Error('Missing binding')
          let armed = false
          bindEntryCapability({
            persistence: fixture.device.groups,
            coordinatorBinding: binding,
            capability: {
              ...capability,
              async read(id, read) {
                const result = await capability.read(id, read)
                if (armed && result === false) registrySafety(fixture.registry)?.latch(key, reason)
                return result
              },
            },
          })
          const recovery = await fixture.confirmedRecovery(key, { confirm: true })
          const owner = fixture.registry
          const access = await owner.access(groupID)
          const hook = vi.fn(async () => {})
          access.onRetire(hook)
          armed = true
          const before = await fixture.inspectRows()
          await expect(
            owner.switchIncarnation(recovery.candidate, {
              source: recovery.source,
              rejoinID: recovery.record.id,
              proof: recovery.proof,
              write: {
                mutationID: crypto.randomUUID(),
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
            }),
          ).rejects.toMatchObject({ name: 'RegistryResyncRefusedError', reason })
          expect(hook).not.toHaveBeenCalled()
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )

    test('pending fork takes precedence over a recovery field in switch refusal', async () => {
      const fixture = await create()
      try {
        const recovery = await fixture.confirmedRecovery(key, { confirm: true })
        const owner = fixture.registry
        await owner.access(groupID)
        await setHold(fixture, key, 'recovery-unavailable')
        registrySafety(owner)?.latch(key, 'fork-halted')
        const before = await fixture.inspectRows()
        await expect(
          owner.switchIncarnation(recovery.candidate, {
            source: recovery.source,
            rejoinID: recovery.record.id,
            proof: recovery.proof,
            write: {
              mutationID: crypto.randomUUID(),
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
          }),
        ).rejects.toMatchObject({ name: 'RegistryResyncRefusedError', reason: 'fork-halted' })
        expect(await fixture.inspectRows()).toEqual(before)
      } finally {
        await fixture.close()
      }
    })
    test('cold trust diagnosis retains stored fork precedence after failed writing', async () => {
      const fixture = await create()
      try {
        await setHold(fixture, key, 'fork-halted')
        await fixture.corruptTrust(groupID)
        const owner = fixture.registry
        fixture.armNextWorkFault('before-commit')
        await expect(owner.recoverySource(groupID)).rejects.toThrow()
        expect(registrySafety(owner)?.held(key)).toBe('fork-halted')
        expect(
          (await fixture.device.groups.ports(key).control.load()).recoveryUnavailable,
        ).toBeNull()
      } finally {
        await fixture.close()
      }
    })

    test.each(['missing', 'corrupt', 'both-corrupt', 'empty-spent'] as const)(
      'recoverySource alone persists %s trust loss',
      async (damage) => {
        const fixture = await create()
        let reopened: RegistryFixture | undefined
        try {
          if (damage === 'empty-spent')
            intercept(fixture, (reads) => ({
              ...reads,
              trust: async () => {
                const trust = await reads.trust()
                return trust === null ? null : { ...trust, spentEpochAuthenticators: [] }
              },
            }))
          const owner = fixture.registry
          if (damage === 'missing') await registryFixtureRemoveTrust(fixture, groupID)
          if (damage === 'corrupt' || damage === 'both-corrupt') await fixture.corruptTrust(groupID)
          if (damage === 'both-corrupt') await fixture.corruptState(key)
          await expect(owner.recoverySource(groupID)).rejects.toMatchObject({
            name: 'GroupUnavailableError',
            reason: 'recovery-unavailable',
          })
          await durableDiagnosis(fixture, key)
          const rows = await fixture.inspectRows()
          await expect(owner.recoverySource(groupID)).rejects.toMatchObject({
            reason: 'recovery-unavailable',
          })
          expect(await fixture.inspectRows()).toEqual(rows)
          reopened = await fixture.reopen()
          await durableDiagnosis(reopened, key)
        } finally {
          await reopened?.close()
          await fixture.close()
        }
      },
    )
    test.each(['read', 'mutate', 'replace', 'adopt'] as const)(
      'held access %s reload persists trust loss',
      async (operation) => {
        const fixture = await create()
        try {
          const access = await fixture.registry.access(groupID)
          const accepted = await fixture.acceptedOrdinary(access)
          await fixture.corruptTrust(groupID)
          const callback = vi.fn(async () => 1)
          const work =
            operation === 'read'
              ? access.read(callback)
              : operation === 'mutate'
                ? access.mutate(callback)
                : operation === 'replace'
                  ? access.replace(
                      accepted.candidate,
                      () => accepted.write,
                      async () => {
                        callback()
                        return true
                      },
                    )
                  : access.adopt(accepted.candidate, accepted.expected, accepted.write)
          await expect(work).rejects.toBeInstanceOf(
            operation === 'read' ? GroupUnavailableError : GroupSafetyHeldError,
          )
          await expect(work).rejects.toMatchObject({ reason: 'recovery-unavailable' })
          expect(callback).not.toHaveBeenCalled()
          await durableDiagnosis(fixture, key)
        } finally {
          await fixture.close()
        }
      },
    )
    test.each(['mutate', 'replace', 'adopt'] as const)(
      'transient trust I/O at %s mutation escapes unchanged',
      async (operation) => {
        const fixture = await create()
        try {
          let armed = false
          const error = new Error('Transient mutation trust I/O')
          intercept(fixture, (reads) => ({
            ...reads,
            trust: async () => {
              if (armed) throw error
              return reads.trust()
            },
          }))
          const access = await fixture.registry.access(groupID)
          const accepted = await fixture.acceptedOrdinary(access)
          const before = await fixture.inspectRows()
          armed = true
          await expect(
            operation === 'mutate'
              ? access.mutate(async () => 1)
              : operation === 'replace'
                ? access.replace(accepted.candidate, () => accepted.write)
                : access.adopt(accepted.candidate, accepted.expected, accepted.write),
          ).rejects.toBe(error)
          expect(registrySafety(fixture.registry)?.held(key)).toBeNull()
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )
    test.each(['missing', 'corrupt', 'empty-spent'] as const)(
      'report %s trust persists recovery refusal',
      async (damage) => {
        const fixture = await create()
        try {
          if (damage === 'empty-spent')
            intercept(fixture, (reads) => ({
              ...reads,
              trust: async () => {
                const trust = await reads.trust()
                return trust === null ? null : { ...trust, spentEpochAuthenticators: [] }
              },
            }))
          const api = await registryFixtureSafety(fixture)
          if (damage === 'missing') await registryFixtureRemoveTrust(fixture, groupID)
          if (damage === 'corrupt') await fixture.corruptTrust(groupID)
          await expect(
            api.reportFork(key, {
              kind: 'unexplained-own-commit',
              epoch: 0,
              position: '1',
              digest: 'remote',
            }),
          ).rejects.toMatchObject({ name: 'GroupSafetyHeldError', reason: 'recovery-unavailable' })
          await durableDiagnosis(fixture, key)
        } finally {
          await fixture.close()
        }
      },
    )
    test.each(['source', 'access', 'report'] as const)(
      'transient trust I/O at %s escapes unchanged',
      async (operation) => {
        const fixture = await create()
        try {
          const error = new Error('Transient trust I/O')
          intercept(fixture, (reads) => ({
            ...reads,
            trust: async () => {
              throw error
            },
          }))
          const owner = fixture.registry
          const api = await registryFixtureSafety(fixture)
          const before = await fixture.inspectRows()
          await expect(
            operation === 'source'
              ? owner.recoverySource(groupID)
              : operation === 'access'
                ? owner.access(groupID)
                : api.reportFork(key, {
                    kind: 'unexplained-own-commit',
                    epoch: 0,
                    position: '1',
                    digest: 'remote',
                  }),
          ).rejects.toBe(error)
          expect(registrySafety(owner)?.held(key)).toBeNull()
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )
    test.each(['metadata', 'installed-key', 'control'] as const)(
      '%s corruption stays invalid without a safety write',
      async (damage) => {
        const fixture = await create()
        try {
          if (damage === 'installed-key')
            intercept(fixture, (reads) => ({
              ...reads,
              trust: async () => {
                const trust = await reads.trust()
                return trust === null
                  ? null
                  : { ...trust, installed: { ...trust.installed, incarnation: 2 } }
              },
            }))
          const owner = fixture.registry
          if (damage === 'metadata') await fixture.mutateMetadata(key, () => null)
          if (damage === 'control') {
            await registryFixtureCorruptControl(fixture, key)
            await fixture.corruptTrust(groupID)
          }
          const before = await fixture.inspectRows()
          await expect(owner.recoverySource(groupID)).rejects.toMatchObject({ reason: 'invalid' })
          expect(registrySafety(owner)?.held(key)).toBeNull()
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )
    test.each(['active', 'tombstone'] as const)(
      'seed respects spent before fork and refuses fresh %s source',
      async (source) => {
        const fixture = await createRegistryFixture({ mode, groupID, setup: 'empty' })
        try {
          const owner = fixture.registry
          const history = await fixture.welcomeHistory('last-resort')
          await owner.seed(history.exact, { packageUse: history.packageUse })
          const trust = await fixture.device.groups.loadTrust(groupID)
          if (trust === null) throw new Error('Missing trust')
          await fixture.installRows({
            key,
            trust: {
              ...trust,
              spentEpochAuthenticators: [
                ...trust.spentEpochAuthenticators,
                history.alternate.state.keySchedule.epochAuthenticator.slice(),
              ],
            },
          })
          await setHold(fixture, key, 'fork-halted')
          if (source === 'tombstone') await owner.delete(key)
          const before = await fixture.inspectRows()
          await expect(
            owner.seed(history.alternate, { replace: true, packageUse: history.packageUse }),
          ).rejects.toMatchObject({ reason: 'spent' })
          await expect(
            owner.seed(history.newer, { replace: true, packageUse: history.packageUse }),
          ).rejects.toMatchObject({ reason: 'fork-halted' })
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )
    test.each(['active', 'tombstone'] as const)(
      'seed unreadable latest %s control refuses unavailable',
      async (source) => {
        const fixture = await create()
        try {
          const owner = fixture.registry
          if (source === 'tombstone') await owner.delete(key)
          await registryFixtureCorruptControl(fixture, key)
          const fresh = await fixture.makeHandle(2)
          const before = await fixture.inspectRows()
          await expect(
            owner.seed(fresh, {
              replace: true,
              packageUse: { sourceID: 'source', ref: 'fresh', kind: 'ordinary' },
            }),
          ).rejects.toMatchObject({ name: 'SeedAdmissionRefusedError', reason: 'unavailable' })
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )
    test.each(['active', 'tombstone'] as const)(
      'field-only recovery hold permits %s readmission and retains old evidence',
      async (source) => {
        const fixture = await create()
        try {
          const owner = fixture.registry
          await owner.access(groupID)
          await setHold(fixture, key, 'recovery-unavailable')
          if (source === 'tombstone') await owner.delete(key)
          const fresh = await fixture.makeHandle(2)
          expect(
            await owner.seed(fresh, {
              replace: true,
              packageUse: { sourceID: 'source', ref: 'fresh', kind: 'ordinary' },
            }),
          ).toEqual({ groupID, incarnation: 2 })
          expect((await owner.access(groupID)).admission().admissible).toBe(true)
          await durableDiagnosis(fixture, key)
        } finally {
          await fixture.close()
        }
      },
    )
    test('retirement hook-created fork prevents seed installation', async () => {
      const fixture = await create()
      try {
        const access = await fixture.registry.access(groupID)
        access.onRetire(() => setHold(fixture, key, 'fork-halted'))
        const fresh = await fixture.makeHandle(2)
        await expect(
          fixture.registry.seed(fresh, {
            replace: true,
            packageUse: { sourceID: 'source', ref: 'fresh', kind: 'ordinary' },
          }),
        ).rejects.toMatchObject({ reason: 'fork-halted' })
        expect((await fixture.device.groups.load(groupID))?.activeIncarnation).toBe(1)
      } finally {
        await fixture.close()
      }
    })
    test.each(['fork-halted', 'recovery-unavailable'] as const)(
      'switch refuses %s after event acknowledgement before drain',
      async (reason) => {
        const fixture = await create()
        try {
          const recovery = await fixture.confirmedRecovery(key, { confirm: true })
          const owner = fixture.registry
          const access = await owner.access(groupID)
          const hook = vi.fn(async () => {})
          access.onRetire(hook)
          await setHold(fixture, key, reason)
          const api = await registryFixtureSafety(fixture)
          await api.ackEvent(
            key,
            reason === 'fork-halted' ? forkEventID(key) : recoveryUnavailableEventID(key),
          )
          const before = await fixture.inspectRows()
          await expect(
            owner.switchIncarnation(recovery.candidate, {
              source: recovery.source,
              rejoinID: recovery.record.id,
              proof: recovery.proof,
              write: {
                mutationID: crypto.randomUUID(),
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
            }),
          ).rejects.toMatchObject({ name: 'RegistryResyncRefusedError', reason })
          expect(hook).not.toHaveBeenCalled()
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      },
    )
  })
}
