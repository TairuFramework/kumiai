import type { ConformanceDeviceStores, StorageTestPorts } from '@kumiai/rpc-conformance'
import { describe, expect, test } from 'vitest'

import { createMemoryDevicePersistence } from '../src/memory-device-persistence.js'
import {
  createMemoryGroupCoordinator,
  createMemoryGroupPersistence,
} from '../src/memory-group-persistence.js'
import { memoryRequired, memoryTransactionEntry } from '../src/memory-group-state.js'
import { memoryRecordTable } from '../src/memory-incarnation-stores.js'
import { createMemoryTransaction } from '../src/memory-transaction.js'
import { createOwnerQueues } from '../src/owner-queue.js'
import { GroupStateConflictError, PersistencePhaseError } from '../src/persistence-errors.js'
import type { MemoryTransaction } from '../src/persistence-types.js'
import { deferred } from '../src/runtime.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createStorageFixture } from './fixtures/storage-persistence.js'

async function nextChange(
  groups: StorageTestPorts<MemoryTransaction>['device']['groups'],
  groupID: string,
  mutationID: string,
) {
  const life = await groups.load(groupID)
  return {
    groupID,
    mutationID,
    expected:
      life === null ? null : { revision: life.revision, activeIncarnation: life.activeIncarnation },
  }
}

const groupID = 'group-A'
const key = { groupID, incarnation: 1 }
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), 1000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
const observed = <T>(promise: Promise<T>) => promise.catch((error: unknown) => error)

test.each(['group', 'coordinator', 'device'] as const)(
  '%s factory refuses a different ownership context on its database',
  (factory) => {
    const db = createMemoryTransaction({ rows: {} })
    const owners = createOwnerQueues()
    const atRest = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(97) })
    const ownershipContext = createAsyncLocalOwnershipContext()
    const params = { db, owners, atRest, providerID: 'memory', ownershipContext }
    createMemoryGroupPersistence(params)
    expect(() => {
      const changed = { ...params, ownershipContext: createAsyncLocalOwnershipContext() }
      if (factory === 'group') createMemoryGroupPersistence(changed)
      else if (factory === 'coordinator') createMemoryGroupCoordinator(changed)
      else createMemoryDevicePersistence({ ...changed, ownerDID: 'did:example:owner' })
    }).toThrow(new TypeError('ownershipContext differs from the port bound to this database'))
    expect(() =>
      createMemoryGroupPersistence({ ...params, ownershipContext: undefined }),
    ).not.toThrow()
    expect(() => createMemoryGroupCoordinator(params)).not.toThrow()
  },
)

for (const mode of ['real-mls', 'double'] as const) {
  for (const withPort of [false, true]) {
    describe(`memory ownership -- ${mode} -- port: ${withPort}`, () => {
      const options = () => ({
        id: groupID,
        mode,
        ownershipContext: withPort ? createAsyncLocalOwnershipContext() : undefined,
      })

      test('effect callables are captured once before finalise', async () => {
        const phases: Array<string> = []
        const counts = { outbox: 0, delete: 0 }
        let entry: ReturnType<typeof memoryTransactionEntry>
        const fixture = await createStorageFixture({
          ...options(),
          effects: {
            get outbox() {
              if (entry !== undefined) {
                counts.outbox++
                phases.push(entry.phase)
              }
              return async () => {}
            },
            get delete() {
              if (entry !== undefined) {
                counts.delete++
                phases.push(entry.phase)
              }
              return async () => {}
            },
          },
        })
        try {
          // Capture the real entry synchronously through the supplied port or marker.
          const groups = fixture.ports.device.groups
          await groups.transition(await nextChange(groups, groupID, 'capture'), async (stores) => {
            entry = memoryTransactionEntry(stores.tx.rows)
            stores.tx.onCommit(() => {})
          })
        } finally {
          await fixture.close()
        }
        expect(counts).toEqual({ outbox: 1, delete: 1 })
        expect(phases).toEqual(['work', 'work'])
      })

      test('a throwing effect getter preserves its error and releases the next transition', async () => {
        const hostError = new Error('effect getter failed')
        let failCapture = true
        const fixture = await createStorageFixture({
          ...options(),
          effects: {
            get outbox() {
              if (failCapture) throw hostError
              return undefined
            },
          },
        })
        try {
          const groups = fixture.ports.device.groups
          const before = await groups.load(groupID)
          let outcomeError: unknown
          const result = await within(
            observed(
              groups.transition(
                await nextChange(groups, groupID, 'getter-error'),
                async (stores) => {
                  const entry = memoryTransactionEntry(stores.tx.rows)
                  if (entry === undefined) throw new Error('Missing transaction entry')
                  const enter = entry.enter
                  entry.enter = async (phase) => {
                    try {
                      await enter(phase)
                    } catch (error) {
                      if (phase === 'outcome') outcomeError = error
                      throw error
                    }
                  }
                },
              ),
            ),
          )
          failCapture = false
          await within(
            groups.transition(await nextChange(groups, groupID, 'after-getter'), async () => {}),
          )
          expect(result).toBe(hostError)
          // Backend release can expire cleanup, but capture must not leave a phase change in flight.
          expect(outcomeError).not.toEqual(
            expect.objectContaining({ message: 'Phase is already changing' }),
          )
          expect((await groups.load(groupID))?.revision).toBe((before?.revision ?? 0) + 1)
        } finally {
          await fixture.close()
        }
      })

      test('a throwing effect getter with fail-stop reports the conflict without an unhandled rejection', async () => {
        const hostError = new Error('effect getter failed')
        const conflict = new GroupStateConflictError('factory stopped during effect capture')
        const unhandled: Array<unknown> = []
        const onUnhandled = (error: unknown) => unhandled.push(error)
        const db = createMemoryTransaction({ rows: {} })
        const owners = createOwnerQueues()
        const groups = createMemoryGroupPersistence({
          db,
          owners,
          atRest: createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(97) }),
          providerID: 'memory',
          ownershipContext: options().ownershipContext,
          effects: {
            get outbox(): undefined {
              owners.failStop(conflict)
              throw hostError
            },
          },
        })
        process.on('unhandledRejection', onUnhandled)
        try {
          const result = await within(
            observed(
              groups.transition(
                { groupID, mutationID: 'getter-fail-stop', expected: null },
                async () => {},
              ),
            ),
          )
          await turn()
          expect(result).toBe(conflict)
          expect(unhandled).toEqual([])
        } finally {
          process.off('unhandledRejection', onUnhandled)
        }
      })

      test('a caught phase refusal before a required open does not poison the transition', async () => {
        const fixture = await createStorageFixture(options())
        try {
          const groups = fixture.ports.device.groups
          const before = await groups.load(groupID)
          let refusal: unknown
          await groups.transition(
            await nextChange(groups, groupID, 'caught-phase-refusal'),
            async (stores) => {
              const entry = memoryTransactionEntry(stores.tx.rows)
              if (entry === undefined) throw new Error('Missing transaction entry')
              refusal = await observed(
                memoryRequired(stores.tx, async () => {
                  entry.assertWrite('coordinator')
                  return await stores.trust.load()
                }),
              )
              expect(entry.rollbackOnly).toBe(false)
              await stores.incarnation(1).cursor.save('after-refusal', '5')
            },
          )
          expect(refusal).toBeInstanceOf(PersistencePhaseError)
          expect((await groups.load(groupID))?.revision).toBe((before?.revision ?? 0) + 1)
          expect(await groups.ports(key).cursor.load('after-refusal')).toBe('5')
        } finally {
          await fixture.close()
        }
      })

      test('a caught codec phase error during a required open makes the transition rollback-only', async () => {
        const fixture = await createStorageFixture(options())
        const openError = new PersistencePhaseError('codec open failed')
        try {
          const groups = fixture.ports.device.groups
          const before = await fixture.inspectRows()
          let caught: unknown
          await expect(
            groups.transition(
              await nextChange(groups, groupID, 'caught-open-phase-error'),
              async (stores) => {
                fixture.failNextOpen(openError)
                caught = await observed(stores.trust.load())
                await stores.incarnation(1).cursor.save('after-open-failure', '7')
              },
            ),
          ).rejects.toThrow(new GroupStateConflictError('Transaction is rollback-only'))
          expect(caught).toBe(openError)
          expect(await groups.ports(key).cursor.load('after-open-failure')).toBeNull()
          expect(await fixture.inspectRows()).toEqual(before)
        } finally {
          await fixture.close()
        }
      })

      test('a caught load failure before opening a row does not poison the transition', async () => {
        const fixture = await createStorageFixture(options())
        try {
          const groups = fixture.ports.device.groups
          let refusal: unknown
          await groups.transition(
            await nextChange(groups, groupID, 'missing-namespace'),
            async (stores) => {
              const table = memoryRecordTable({
                tx: stores.tx,
                key,
                namespace: 'missing-namespace',
                atRest: createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(97) }),
              })
              refusal = await observed(table.load('current'))
              await stores.incarnation(1).cursor.save('after-load-refusal', '6')
            },
          )
          expect(refusal).toBeInstanceOf(GroupStateConflictError)
          expect(await groups.ports(key).cursor.load('after-load-refusal')).toBe('6')
        } finally {
          await fixture.close()
        }
      })

      test('a codec seal can resume from unrelated code without retaining coordinator access', async () => {
        const fixture = await createStorageFixture(options())
        const latch = fixture.holdNextSeal()
        try {
          const groups = fixture.ports.device.groups
          let operation!: Promise<unknown>
          const write = observed(
            groups.transition(
              await nextChange(groups, groupID, 'unrelated-seal'),
              async (stores) => {
                operation = observed(stores.incarnation(1).cursor.save('unrelated', '4'))
              },
            ),
          )
          await within(latch.reached)
          queueMicrotask(latch.release)
          expect(await within(write)).toBeUndefined()
          expect(await within(operation)).toBeUndefined()
          expect(await groups.ports(key).cursor.load('unrelated')).toBe('4')
        } finally {
          latch.release()
          await fixture.close()
        }
      })

      test.each(['work', 'effects'] as const)(
        'device %s rejection revokes a suspended operation before backend completion',
        async (phase) => {
          const fixture = await createStorageFixture(options())
          const device = fixture.ports.device
          const before = await fixture.inspectRows()
          const latch = deferred<ReturnType<typeof fixture.holdNextSeal>>()
          let operation!: Promise<unknown>
          let supplied!: ConformanceDeviceStores<MemoryTransaction>
          const suspend = async () => {
            const hold = fixture.holdNextSeal()
            latch.resolve(hold)
            operation = observed(
              supplied.restore.save({ id: 'abandoned', stage: 'groups', remainingGroups: [] }),
            )
            await hold.reached
            throw new Error('device host failed')
          }
          if (phase === 'effects') fixture.onPhase('effects', suspend)
          let hold: ReturnType<typeof fixture.holdNextSeal> | undefined
          try {
            const writer = observed(
              device.transition(
                { mutationID: `device-reject-${phase}`, expectedRevision: 1, group: null },
                async (stores) => {
                  supplied = stores
                  if (phase === 'work') await suspend()
                },
              ),
            )
            hold = await within(latch.promise)
            await within(hold.reached)
            expect(await within(operation)).toMatchObject({ name: 'PersistencePhaseError' })
            expect(await within(writer)).toMatchObject({ message: 'device host failed' })
            expect(await within(device.load())).toMatchObject({ revision: 1 })
            hold.release()
            await turn()
            expect(await fixture.inspectRows()).toEqual(before)
          } finally {
            hold?.release()
            await fixture.close()
          }
        },
      )

      test('a finalise host accessor cannot write restorePending', async () => {
        const fixture = await createStorageFixture(options())
        let tx!: MemoryTransaction
        const results: Array<unknown> = []
        try {
          const groups = fixture.ports.device.groups
          const life = await groups.load(groupID)
          if (life === null) throw new Error('Missing lifetime')
          fixture.onPhase('finalise', async () => {
            const accessor = {
              get value() {
                return fixture
                  .constructGroupStores(tx, key)
                  .lifetime.save({ ...life, restorePending: true })
              },
            }
            results.push(await observed(accessor.value))
          })
          await groups.transition(await nextChange(groups, groupID, 'accessor'), async (stores) => {
            tx = stores.tx
          })
          expect(results).toEqual([expect.objectContaining({ name: 'PersistencePhaseError' })])
          expect((await groups.load(groupID))?.restorePending).toBe(false)
        } finally {
          await fixture.close()
        }
      })

      test('a codec cannot read independently constructed lifetime stores in account', async () => {
        const fixture = await createStorageFixture(options())
        let supplied!: ConformanceDeviceStores<MemoryTransaction>
        const results: Array<unknown> = []
        try {
          fixture.onPhase('account', () => {
            fixture.probeCodec(async (phase) => {
              expect(phase).toBe('account')
              results.push(
                await observed(fixture.constructGroupStores(supplied.tx, key).lifetime.load()),
              )
            })
          })
          const device = fixture.ports.device
          await device.transition(
            {
              mutationID: 'account-read',
              expectedRevision: 1,
              group: await nextChange(device.groups, groupID, 'account-read'),
            },
            async (stores) => {
              supplied = stores
            },
          )
          expect(results).toEqual([expect.objectContaining({ name: 'PersistencePhaseError' })])
        } finally {
          await fixture.close()
        }
      })

      test('reopen with the context port works after fail-stop', async () => {
        const fixture = await createStorageFixture(options())
        try {
          const device = fixture.ports.device
          const fault = fixture.rejectCommitPending()
          const writer = observed(
            device.transition(
              { mutationID: 'conflict', expectedRevision: 1, group: null },
              async () => {},
            ),
          )
          await within(fault.rejected)
          await fixture.forceOwnerMarker(
            { ownerDID: device.ownerDID },
            { mutationID: 'foreign', revision: 20 },
          )
          await fault.finish('rollback')
          expect(await within(writer)).toMatchObject({ name: 'GroupStateConflictError' })
          await fixture.forceOwnerMarker(
            { ownerDID: device.ownerDID },
            { mutationID: 'seed-device', revision: 1 },
          )
          const reopened = await fixture.reopen()
          expect(await reopened.device.groups.load(groupID)).toMatchObject({ groupID })
          expect(await reopened.device.load()).toMatchObject({ revision: 1 })
          await reopened.device.transition(
            { mutationID: 'after-restart', expectedRevision: 1, group: null },
            async () => {},
          )
          expect(await reopened.device.load()).toMatchObject({ revision: 2 })
        } finally {
          await fixture.close()
        }
      })
    })
  }
}
