import { createGroup, encodeClientState } from '@kumiai/mls'
import { describe, expect, test } from 'vitest'

import {
  bindEntryCapability,
  coordinatorBinding,
  entryCapability,
} from '../src/entry-capability.js'
import { createOwnerQueues } from '../src/owner-queue.js'
import {
  GroupStateConflictError,
  RegistryRetireHookError,
  RegistryRetiringError,
} from '../src/persistence-errors.js'
import { createGroupHandleRegistry } from '../src/registry/registry.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import type { RetirementAttempt } from '../src/registry/types.js'
import { deferred } from '../src/runtime.js'
import { gateRegistryMaintenance } from '../src/testing.js'
import {
  createGatedRegistryFixture as createRegistryFixture,
  type RegistryFixtureBase,
  registryFixtureForceOwnerMarker,
  registryFixtureRestore,
  registryFixtureRetirement as registryRetirement,
} from './fixtures/registry.js'
import { testRegistryBackgroundWarmup } from './fixtures/registry-maintenance.js'
import { writeInstallationCheckpoint } from './fixtures/storage-seed.js'

function registry(fixture: RegistryFixtureBase) {
  const owner = createGroupHandleRegistry({
    persistence: fixture.device,
    providerID: fixture.device.providerID,
    recovery: fixture.environment,
    restore: registryFixtureRestore(fixture),
    restoreCandidate: async () => {
      throw new Error('Retirement must not restore a candidate')
    },
  })
  gateRegistryMaintenance(owner)
  return owner
}

test('activity counts queued Combined admission and cancelled completion', async () => {
  const owners = createOwnerQueues()
  const entered = deferred<void>()
  const release = deferred<void>()
  const blocking = owners.run('read', { ownerDID: 'device', groupID: null }, async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const abort = new AbortController()
  const combined = owners.run(
    'combined',
    { ownerDID: 'device', groupID: 'group' },
    async () => {
      throw new Error('Cancelled entry must not run')
    },
    { mutationID: 'cancelled', signal: abort.signal },
  )
  const cancelled = expect(combined).rejects.toThrow('cancelled waiting')
  expect(owners.activity('group')).toEqual({ generation: 1, pending: 1 })
  expect(owners.activity('group', 'cancelled')).toEqual({ generation: 0, pending: 0 })
  abort.abort(new Error('cancelled waiting'))
  await cancelled
  expect(owners.activity('group')).toEqual({ generation: 2, pending: 0 })
  release.resolve()
  await blocking
})
function capability(fixture: RegistryFixtureBase) {
  const value = entryCapability(fixture.device.groups)
  if (value === null) throw new Error('Missing entry capability')
  return value
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`registry retirement (${mode})`, () => {
    const groupID = `registry-retirement-${mode}`
    const key = { groupID, incarnation: 1 }
    const create = () => createRegistryFixture({ mode, groupID, setup: 'seeded' })

    test('hook runs outside ownership and can read and complete raw work', async () => {
      const fixture = await create()
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        const phases: Array<string> = []
        fixture.onPhase('prepare', () => {
          phases.push('prepare')
        })
        fixture.onPhase('work', () => {
          phases.push('work')
        })
        access.onRetire(async () => {
          phases.push('retire')
          expect(await fixture.device.groups.load(groupID)).toMatchObject({ activeIncarnation: 1 })
          await fixture.device.groups
            .ports(key)
            .control.apply({ deleteOutcomes: [] }, 'hook-completion')
          phases.push('done')
        })
        const attempt = registryRetirement(owner).beginRetirement(key)
        await attempt.drain()
        expect(phases.indexOf('retire')).toBeLessThan(phases.indexOf('work'))
        expect(phases.at(-1)).toBe('done')
        attempt.settle('rolled-back')
      } finally {
        await fixture.close()
      }
    })

    test('never settling hook holds no owner slot and preserves diagnostic snapshot', async () => {
      const fixture = await create()
      const release = deferred<void>()
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        const snapshot = access.runtime.snapshot()
        const entered = deferred<void>()
        access.onRetire(async () => {
          entered.resolve()
          await release.promise
        })
        const attempt = registryRetirement(owner).beginRetirement(key)
        const draining = attempt.drain()
        await entered.promise
        expect(access.runtime.snapshot()).toEqual(snapshot)
        await expect(owner.access(groupID)).rejects.toBeInstanceOf(RegistryRetiringError)
        await expect(access.read(() => {})).rejects.toBeInstanceOf(RegistryRetiringError)
        await expect(access.readControl(async () => {})).rejects.toBeInstanceOf(
          RegistryRetiringError,
        )
        for (const operation of [access.epoch, access.stateVersion, access.admission])
          expect(operation).toThrow(RegistryRetiringError)
        expect(() => access.onRetire(async () => {})).toThrow(RegistryRetiringError)
        await expect(fixture.device.groups.load(groupID)).resolves.toMatchObject({
          activeIncarnation: 1,
        })
        const groupIDB = `${groupID}-other`
        const { group: handleB } = await createGroup(
          fixture.identity,
          groupIDB,
          fixture.environment.options,
        )
        const keyB = { groupID: groupIDB, incarnation: 1 }
        await expect(
          fixture.device.groups.transition(
            { groupID: groupIDB, mutationID: 'independent', expected: null },
            async (stores) => {
              await stores.lifetime.save({
                groupID: groupIDB,
                latestIncarnation: 1,
                activeIncarnation: 1,
                revision: 1,
                mutationID: 'independent',
                restorePending: false,
              })
              await stores.incarnation(1).state.save({
                ...keyB,
                version: 1,
                deleted: false,
                terminal: false,
                epoch: Number(handleB.epoch),
                epochAuthenticator: handleB.state.keySchedule.epochAuthenticator,
                state: encodeClientState(handleB.state),
                credential: handleB.credential,
                ledger: handleB.ledgerTokens,
                senderHWM: 0,
              })
              await stores.trust.save(recoveryTrustFor(handleB, keyB, null))
              await writeInstallationCheckpoint(stores, {
                key: keyB,
                handle: handleB,
                mutationID: 'independent',
                stateVersion: 1,
              })
              return 'group B'
            },
          ),
        ).resolves.toBe('group B')
        await fixture.device.groups.ports(key).control.apply({ deleteOutcomes: [] }, 'during-drain')
        release.resolve()
        await draining
        attempt.settle('rolled-back')
        expect(await owner.access(groupID)).toBe(access)
        expect(await access.read((handle) => handle.groupID)).toBe(groupID)
      } finally {
        release.resolve()
        await fixture.close()
      }
    })

    for (const reload of [false, true]) {
      test(`retire hooks survive owner invalidation with reload=${reload}`, async () => {
        const fixture = await create()
        try {
          const owner = registry(fixture)
          const access = await owner.access(groupID)
          const original = await access.read((handle) => handle)
          const calls: Array<string> = []
          access.onRetire(async () => {
            calls.push('hook')
          })
          const unregister = access.onRetire(async () => {
            calls.push('unregistered')
          })
          fixture.overrideRestore(async () => {
            throw new Error('Host restoration failed')
          })
          await expect(access.read(() => {})).rejects.toMatchObject({ reason: 'invalid' })
          expect(() => access.epoch()).toThrow('Registry owner is no longer current')
          fixture.overrideRestore(async () => original)
          if (reload) expect(await owner.access(groupID)).not.toBe(access)
          unregister()
          unregister()
          const attempt = registryRetirement(owner).beginRetirement(key)
          await attempt.drain()
          calls.push('drained')
          expect(calls).toEqual(['hook', 'drained'])
          attempt.settle('rolled-back')
        } finally {
          await fixture.close()
        }
      })
    }

    test('hook rejection restores active and observes every registered hook failure', async () => {
      const fixture = await create()
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        const first = new Error('first hook failed')
        const second = new Error('second hook failed')
        const calls: Array<number> = []
        access.onRetire(async () => {
          calls.push(1)
          throw first
        })
        access.onRetire(async () => {
          calls.push(2)
          throw second
        })
        access.onRetire(async () => {
          calls.push(3)
        })
        const attempt = registryRetirement(owner).beginRetirement(key)
        const error = await attempt.drain().catch((error: unknown) => error)
        expect(error).toBeInstanceOf(RegistryRetireHookError)
        if (!(error instanceof RegistryRetireHookError)) throw error
        expect(error.cause).toBeInstanceOf(AggregateError)
        if (!(error.cause instanceof AggregateError)) throw new Error('Missing hook failures')
        expect(error.cause.errors).toEqual([first, second])
        expect(calls).toEqual([1, 2, 3])
        expect(await owner.access(groupID)).toBe(access)
        expect(await access.read((handle) => handle.groupID)).toBe(groupID)
      } finally {
        await fixture.close()
      }
    })

    test('unregister is idempotent and hooks run once in registration order per round', async () => {
      const fixture = await create()
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        const calls: Array<number> = []
        const unregister = access.onRetire(async () => {
          calls.push(0)
        })
        access.onRetire(async () => {
          calls.push(1)
        })
        access.onRetire(async () => {
          calls.push(2)
        })
        unregister()
        unregister()
        const attempt = registryRetirement(owner).beginRetirement(key)
        const first = attempt.drain()
        await Promise.all([first, attempt.drain()])
        expect(calls).toEqual([1, 2])
        await attempt.drain()
        expect(calls).toEqual([1, 2, 1, 2])
        attempt.settle('rolled-back')
      } finally {
        await fixture.close()
      }
    })

    test('queued-before-fence entries finish in FIFO order while new calls reject', async () => {
      const fixture = await create()
      const release = deferred<void>()
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        const entered = deferred<void>()
        const calls: Array<string> = []
        const first = access.read(async () => {
          entered.resolve()
          await release.promise
          calls.push('first')
        })
        await entered.promise
        const write = capability(fixture).run(
          { groupID, mutationID: 'before-fence' },
          async (reads) => ({ expected: await reads.lifetime(), value: null }),
          async (stores) => {
            await stores.incarnation(1).control.apply({ deleteOutcomes: [] }, 'before-fence')
            calls.push('write')
          },
        )
        const second = access.read(() => {
          calls.push('second')
        })
        access.onRetire(async () => {
          calls.push('hook')
        })
        const attempt = registryRetirement(owner).beginRetirement(key)
        const draining = attempt.drain()
        await expect(access.read(() => {})).rejects.toBeInstanceOf(RegistryRetiringError)
        release.resolve()
        await Promise.all([first, write, second, draining])
        expect(calls).toEqual(['first', 'write', 'second', 'hook'])
        attempt.settle('rolled-back')
      } finally {
        release.resolve()
        await fixture.close()
      }
    })

    test('competing loser and obsolete settlement cannot unfence the winner', async () => {
      const fixture = await create()
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        const retirement = registryRetirement(owner)
        const obsolete = retirement.beginRetirement(key)
        obsolete.settle('rolled-back')
        const winner = retirement.beginRetirement(key)
        expect(winner.generation).toBeGreaterThan(obsolete.generation)
        expect(() => retirement.beginRetirement(key)).toThrow(RegistryRetiringError)
        obsolete.settle('rolled-back')
        await expect(access.read(() => {})).rejects.toBeInstanceOf(RegistryRetiringError)
        winner.settle('rolled-back')
        expect(access.epoch()).toBe(0)
      } finally {
        await fixture.close()
      }
    })

    test('rollback discards validation cache while keeping held access and snapshot', async () => {
      const fixture = await create()
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        const snapshot = access.runtime.snapshot()
        const count = fixture.restoreCount(groupID)
        const attempt = registryRetirement(owner).beginRetirement(key)
        attempt.settle('rolled-back')
        expect(access.runtime.snapshot()).toEqual(snapshot)
        expect(await owner.access(groupID)).toBe(access)
        expect(fixture.restoreCount(groupID)).toBe(count + 1)
      } finally {
        await fixture.close()
      }
    })

    test('runtime validation admitted before the fence completes even with a cold cache', async () => {
      const fixture = await create()
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        registryRetirement(owner).beginRetirement(key).settle('rolled-back')
        const held = fixture.holdRestore(groupID)
        const reading = access.read((handle) => handle.groupID)
        const completed = expect(reading).resolves.toBe(groupID)
        await held.started
        const attempt = registryRetirement(owner).beginRetirement(key)
        const draining = attempt.drain()
        held.release()
        await completed
        await draining
        attempt.settle('rolled-back')
      } finally {
        await fixture.close()
      }
    })

    test('failed in-flight restoration preserves the diagnostic snapshot during retirement', async () => {
      const fixture = await create()
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        const original = await access.read((handle) => handle)
        const snapshot = access.runtime.snapshot()
        const held = fixture.holdRestore(groupID)
        fixture.overrideRestore(async () => {
          throw new Error('Host restoration failed')
        })
        const reading = expect(access.read(() => {})).rejects.toMatchObject({ reason: 'invalid' })
        await held.started
        const attempt = registryRetirement(owner).beginRetirement(key)
        const draining = attempt.drain()
        held.release()
        await reading
        await draining
        expect(access.runtime.snapshot()).toEqual(snapshot)
        fixture.overrideRestore(async () => original)
        attempt.settle('rolled-back')
        expect(await owner.access(groupID)).toBe(access)
      } finally {
        await fixture.close()
      }
    })

    test('provider fail-stop takes priority over stale cold publication', async () => {
      const fixture = await create()
      try {
        const entry = capability(fixture)
        const binding = coordinatorBinding(fixture.device.groups)
        if (binding === null) throw new Error('Missing binding')
        const failure = new AbortController()
        bindEntryCapability({
          persistence: fixture.device.groups,
          coordinatorBinding: binding,
          capability: { ...entry, failureSignal: failure.signal },
        })
        const owner = registry(fixture)
        await owner.start()
        const held = fixture.holdRestore(groupID)
        const conflict = new GroupStateConflictError('Provider fail-stop')
        const opening = expect(owner.access(groupID)).rejects.toBe(conflict)
        await held.started
        registryRetirement(owner).beginRetirement(key)
        failure.abort(conflict)
        held.release()
        await opening
      } finally {
        await fixture.close()
      }
    })

    test('retirement waits for ambiguous earlier work and a loser cannot clear its fence', async () => {
      const fixture = await create()
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        let hooks = 0
        access.onRetire(async () => {
          hooks++
        })
        const mutationID = 'ambiguous-before-retirement'
        const fault = fixture.armWorkFault(mutationID, 'pending')
        const proof = fixture.holdProof(mutationID)
        const writing = fixture.device.groups
          .ports(key)
          .control.apply({ deleteOutcomes: [] }, mutationID)
        const rejected = expect(writing).rejects.toMatchObject({
          name: 'StorageOutcomeUnknownError',
        })
        await fault.rejected
        await proof.started
        const attempt = registryRetirement(owner).beginRetirement(key)
        const draining = attempt.drain()
        expect(() => registryRetirement(owner).beginRetirement(key)).toThrow(RegistryRetiringError)
        expect(capability(fixture).activity(groupID).pending).toBe(1)
        await expect(access.read(() => {})).rejects.toBeInstanceOf(RegistryRetiringError)
        await expect(fixture.device.groups.load(`${groupID}-other`)).resolves.toBeNull()
        expect(hooks).toBe(0)
        await fault.finish('rollback')
        proof.release()
        await rejected
        await draining
        expect(hooks).toBe(1)
        expect(capability(fixture).activity(groupID).pending).toBe(0)
        attempt.settle('rolled-back')
        expect(await owner.access(groupID)).toBe(access)
      } finally {
        await fixture.close()
      }
    })

    test('fail-stop rejects a suspended hook drain and releases only its temporary hold', async () => {
      const fixture = await create()
      const release = deferred<void>()
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        const snapshot = access.runtime.snapshot()
        const entered = deferred<void>()
        access.onRetire(async () => {
          entered.resolve()
          await release.promise
        })
        const attempt = registryRetirement(owner).beginRetirement(key)
        const draining = expect(attempt.drain()).rejects.toBeInstanceOf(GroupStateConflictError)
        await entered.promise
        const mutationID = 'conflicted-during-hook'
        const proof = fixture.holdProof(mutationID)
        fixture.armWorkFault(mutationID, 'commit-then-reject')
        const writing = expect(
          fixture.device.groups.ports(key).control.apply({ deleteOutcomes: [] }, mutationID),
        ).rejects.toBeInstanceOf(GroupStateConflictError)
        await proof.started
        await registryFixtureForceOwnerMarker(
          fixture,
          { groupID },
          { revision: 999, mutationID: 'intruder' },
        )
        proof.release()
        await Promise.all([writing, draining])
        expect(access.runtime.snapshot()).toEqual(snapshot)
        await expect(access.read(() => {})).rejects.toBeInstanceOf(GroupStateConflictError)
        expect(() => registryRetirement(owner).beginRetirement(key)).toThrow(
          GroupStateConflictError,
        )
      } finally {
        release.resolve()
        await fixture.close()
      }
    })

    test.each(['retiring', 'rolled-back'] as const)(
      'blocked cold restore cannot publish or return its old result after %s fence',
      async (outcome) => {
        const fixture = await create()
        try {
          const owner = registry(fixture)
          await owner.start()
          const held = fixture.holdRestore(groupID)
          const opening = owner.access(groupID)
          const refused = expect(opening).rejects.toBeInstanceOf(RegistryRetiringError)
          await held.started
          const attempt = registryRetirement(owner).beginRetirement(key)
          if (outcome === 'rolled-back') attempt.settle('rolled-back')
          held.release()
          await refused
          expect(fixture.restoreCount(groupID)).toBe(1)
          attempt.settle('rolled-back')
          const access = await owner.access(groupID)
          expect(fixture.restoreCount(groupID)).toBe(2)
          expect(access.runtime.snapshot()).toMatchObject({ ...key, available: true })
        } finally {
          await fixture.close()
        }
      },
    )

    test('proven retirement permanently displaces access and clears its snapshot', async () => {
      const fixture = await create()
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        const attempt = registryRetirement(owner).beginRetirement(key)
        await attempt.drain()
        attempt.settle('committed')
        expect(access.runtime.snapshot()).toBeNull()
        await expect(access.read(() => {})).rejects.toMatchObject({
          name: 'DisplacedGroupHandleError',
        })
        expect(access.epoch).toThrow('no longer current')
        expect(() => access.onRetire(async () => {})).toThrow('no longer current')
      } finally {
        await fixture.close()
      }
    })

    test('publication listener fencing the owner prevents returning newly requested access', async () => {
      const fixture = await create()
      let attempt: RetirementAttempt | undefined
      try {
        const owner = registry(fixture)
        const access = await owner.access(groupID)
        access.runtime.onEpochChanged(() => {
          attempt = registryRetirement(owner).beginRetirement(key)
        })
        const record = await fixture.device.groups.loadState(key)
        if (record === null) throw new Error('Missing state')
        await fixture.installRows({ key, state: { ...record, version: record.version + 1 } })
        await expect(owner.access(groupID)).rejects.toBeInstanceOf(RegistryRetiringError)
        expect(attempt).toBeDefined()
      } finally {
        attempt?.settle('rolled-back')
        await fixture.close()
      }
    })

    for (const kind of ['Transition', 'Combined'] as const) {
      test(`activity exclusion preserves a queued same-ID ${kind} admission`, async () => {
        const fixture = await create()
        const release = deferred<void>()
        const writes: Array<Promise<unknown>> = []
        try {
          const entry = capability(fixture)
          const device = await fixture.device.load()
          const lifetime = await fixture.device.groups.load(groupID)
          const baseline = entry.activity(groupID)
          const mutationID = 'shared-replacement'
          const entered = deferred<void>()
          const rollback = new Error('Replacement rolled back after recheck')
          writes.push(
            expect(
              entry.run(
                { groupID, mutationID },
                async (reads) => ({ expected: await reads.lifetime(), value: null }),
                async () => {
                  entered.resolve()
                  await release.promise
                  expect(entry.activity(groupID, mutationID)).toEqual({
                    generation: baseline.generation + 1,
                    pending: 1,
                  })
                  throw rollback
                },
              ),
            ).rejects.toBe(rollback),
          )
          await entered.promise
          writes.push(
            kind === 'Transition'
              ? fixture.device.groups.transition(
                  { groupID, mutationID, expected: lifetime },
                  async () => {},
                )
              : fixture.device.transition(
                  {
                    mutationID,
                    expectedRevision: device.revision,
                    group: { groupID, mutationID, expected: lifetime },
                  },
                  async () => {},
                ),
          )
          release.resolve()
          await Promise.all(writes)
          expect(entry.activity(groupID)).toEqual({
            generation: baseline.generation + 4,
            pending: 0,
          })
        } finally {
          release.resolve()
          await Promise.allSettled(writes)
          await fixture.close()
        }
      })
    }

    test('activity covers admission and completion for raw, registry and Combined writes', async () => {
      const fixture = await create()
      const release = deferred<void>()
      try {
        const entry = capability(fixture)
        const baseline = entry.activity(groupID)
        await fixture.device.groups.load(groupID)
        await entry.read(groupID, (reads) => reads.lifetime())
        expect(entry.activity(groupID)).toEqual(baseline)
        const entered = deferred<void>()
        const writing = entry.run(
          { groupID, mutationID: 'activity-replacement' },
          async (reads) => ({ expected: await reads.lifetime(), value: null }),
          async () => {
            entered.resolve()
            await release.promise
          },
        )
        await entered.promise
        expect(entry.activity(groupID)).toEqual({ generation: baseline.generation + 1, pending: 1 })
        expect(entry.activity(groupID, 'activity-replacement')).toEqual(baseline)
        release.resolve()
        await writing
        expect(entry.activity(groupID)).toEqual({ generation: baseline.generation + 2, pending: 0 })
        await fixture.device.groups
          .ports(key)
          .control.apply({ deleteOutcomes: [] }, 'raw-completion')
        const afterRaw = entry.activity(groupID)
        expect(afterRaw).toEqual({ generation: baseline.generation + 4, pending: 0 })
        const device = await fixture.device.load()
        const lifetime = await fixture.device.groups.load(groupID)
        await fixture.device.transition(
          {
            mutationID: 'combined-activity',
            expectedRevision: device.revision,
            group: { groupID, mutationID: 'combined-activity', expected: lifetime },
          },
          async () => {},
        )
        expect(entry.activity(groupID)).toEqual({ generation: afterRaw.generation + 2, pending: 0 })
        expect(entry.activity(`${groupID}-other`)).toEqual({ generation: 0, pending: 0 })
      } finally {
        release.resolve()
        await fixture.close()
      }
    })
  })
}

testRegistryBackgroundWarmup('retirement')
