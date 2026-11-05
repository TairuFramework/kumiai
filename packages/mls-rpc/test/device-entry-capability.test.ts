import { describe, expect, test, vi } from 'vitest'

import {
  type DeviceEntryCapability,
  deviceEntryCapability,
} from '../src/device-entry-capability.js'
import type { EntryReads } from '../src/entry-capability.js'
import { entryCapability } from '../src/entry-capability.js'
import { createMemoryDevicePersistence } from '../src/memory-device-persistence.js'
import { memoryGroupOwnerQueues } from '../src/memory-group-persistence.js'
import { groupOwnerKey } from '../src/memory-incarnation-stores.js'
import { createMemoryTransaction } from '../src/memory-transaction.js'
import type { DeviceRecord, MemoryTransaction } from '../src/persistence-types.js'
import { memoryFaults } from '../src/testing.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { installSeed, makeStorageSeed } from './fixtures/storage-seed.js'

type Capability = DeviceEntryCapability<MemoryTransaction>
function capabilityFor(device: ReturnType<typeof createMemoryDevicePersistence>) {
  const capability = deviceEntryCapability(device)
  expect(capability, 'registered device preparation capability').toBeTruthy()
  if (capability === null) throw new Error('Missing device preparation capability')
  return capability
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const request = { groupID: 'combined-A', mutationID: 'prepared-combined' }

async function setup(context: boolean) {
  const db = createMemoryTransaction({ rows: {} })
  const atRest = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(76) })
  const device = createMemoryDevicePersistence({
    db,
    atRest,
    providerID: 'combined-provider',
    ownerDID: 'did:example:combined',
    ownershipContext: context ? createAsyncLocalOwnershipContext() : undefined,
  })
  const seed = await makeStorageSeed({
    id: request.groupID,
    incarnation: 1,
    epoch: 0,
    mode: 'double',
  })
  await installSeed(device.groups, seed, 'seed')
  await device.load()
  const capability = await capabilityFor(device)
  const owners = memoryGroupOwnerQueues(db)
  if (owners === undefined) throw new Error('Missing owners')
  const prepare = async (reads: { device(): Promise<DeviceRecord>; group: EntryReads }) => {
    const device = await reads.device()
    const lifetime = await reads.group.lifetime()
    if (lifetime === null) throw new Error('Missing lifetime')
    return {
      expectedDeviceRevision: device.revision,
      expected: { revision: lifetime.revision, activeIncarnation: lifetime.activeIncarnation },
      value: { revision: device.revision, version: (await reads.group.metadata(1))?.version },
    }
  }
  return { db, atRest, device, seed, capability, owners, prepare }
}

for (const context of [false, true])
  describe(`device preparation (ownershipContext=${context})`, () => {
    test('Combined prepare owns device then group outside provider work', async () => {
      const { db, device, capability, prepare } = await setup(context)
      const transact = vi.spyOn(db, 'transact')
      const entered = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      const order: Array<string> = []
      const combined = capability.runCombined(
        request,
        async (reads) => {
          const value = await prepare(reads)
          entered.resolve()
          await released.promise
          return value
        },
        async (stores, prepared) => {
          expect(prepared).toEqual({ revision: 0, version: 1 })
          expect(stores.group).not.toBeNull()
          order.push('work')
          return 42
        },
      )
      await entered.promise
      const group = device.groups.load(request.groupID).then(() => order.push('group'))
      const provisioning = device.load().then(() => order.push('device'))
      await tick()
      expect(transact.mock.calls, 'prepare opens no provider work transaction').toHaveLength(0)
      expect(order).toEqual([])
      released.resolve()
      expect(await combined).toBe(42)
      // Proof reads below are outside the work transaction count.
      expect(transact.mock.calls).toHaveLength(1)
      await Promise.all([group, provisioning])
      expect(order[0]).toBe('work')
      expect(await device.load()).toMatchObject({ revision: 1, mutationID: request.mutationID })
      expect(await device.groups.load(request.groupID)).toMatchObject({
        revision: 2,
        mutationID: request.mutationID,
      })
    })

    test('group holder refuses device acquisition', async () => {
      const { device, capability } = await setup(context)
      const group = entryCapability(device.groups)
      if (group === null) throw new Error('Missing group capability')
      let deviceRequests = 0
      await group.read(request.groupID, async () => {
        expect(() => capability.assertRoot()).toThrowError(/Root persistence/)
        await expect(
          capability.read(async () => {
            deviceRequests++
          }),
        ).rejects.toMatchObject({ name: 'ReentrantOwnershipError' })
        if (context) {
          await tick()
          await expect(
            capability.runCombined(
              request,
              async () => {
                deviceRequests++
                throw new Error('queued')
              },
              async () => {},
            ),
          ).rejects.toMatchObject({ name: 'ReentrantOwnershipError' })
        }
      })
      await capability.read(async () => {
        deviceRequests++
      })
      expect(deviceRequests).toBe(1)
    })

    test('cancelled Combined withdraws group wait and releases device', async () => {
      const { owners, device, capability, prepare } = await setup(context)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const holder = owners.run('read', { groupID: request.groupID, ownerDID: null }, async () => {
        entered.resolve()
        await release.promise
      })
      await entered.promise
      const cancel = new AbortController()
      let called = 0
      const combined = capability
        .runCombined({ ...request, signal: cancel.signal }, prepare, async () => {
          called++
        })
        .catch((error: unknown) => error)
      await tick()
      let provisioned = false
      const provisioning = device.load().then(() => {
        provisioned = true
      })
      await device.groups.load('independent-B')
      expect(provisioned, 'Combined holds D while waiting for G').toBe(false)
      const reason = new Error('cancel Combined')
      cancel.abort(reason)
      expect(await combined).toBe(reason)
      await provisioning
      expect(called).toBe(0)
      release.resolve()
      await holder
      // A cancelled waiter must not consume the next grant.
      let nextGroup = false
      const after = device.groups.load(request.groupID).then(() => {
        nextGroup = true
      })
      await tick()
      expect(nextGroup, 'cancelled waiter must release its raced group grant').toBe(true)
      await after
      expect(called).toBe(0)
    })

    test.each(['commit', 'rollback'] as const)(
      'Combined proof retains both owners and preparation (%s)',
      async (outcome) => {
        const { db, device, capability, prepare } = await setup(context)
        const fault = memoryFaults(db).rejectCommitPending()
        const hooks: Array<string> = []
        let preparations = 0
        let completed = false
        const result = capability
          .runCombined(
            request,
            async (reads) => {
              preparations++
              return prepare(reads)
            },
            async (stores) => {
              stores.tx.onCommit(() => hooks.push('device'))
              stores.group?.tx.onCommit(() => hooks.push('group'))
              return 'saved-result'
            },
          )
          .then(
            (value) => {
              completed = true
              return value
            },
            (error: unknown) => error,
          )
        await fault.rejected
        await fault.barrierWaiting
        const progressed: Array<string> = []
        const reads = [
          device.load().then(() => progressed.push('device')),
          device.groups.load(request.groupID).then(() => progressed.push('group')),
        ]
        await tick()
        expect(completed).toBe(false)
        expect(progressed).toEqual([])
        expect(hooks).toEqual([])
        expect(preparations).toBe(1)
        await fault.finish(outcome)
        if (outcome === 'commit') expect(await result).toBe('saved-result')
        else expect(await result).toMatchObject({ name: 'StorageOutcomeUnknownError' })
        await Promise.all(reads)
        expect(hooks).toEqual(outcome === 'commit' ? ['device', 'group'] : [])
        expect(preparations).toBe(1)
      },
    )

    test('device read and expired prepare views cannot write', async () => {
      const { atRest, device, capability, prepare } = await setup(context)
      const seal = vi.spyOn(atRest, 'seal')
      await capability.read(async (stores) => {
        expect(stores.group).toBeNull()
        await expect(
          stores.restore.save({ id: 'restore', stage: 'invalidate', remainingGroups: [] }),
        ).rejects.toMatchObject({ name: 'PersistencePhaseError' })
        await expect(
          stores.ordinary('source').consume('ref', request.groupID),
        ).rejects.toMatchObject({ name: 'PersistencePhaseError' })
        expect(() => stores.tx.rows.device?.set('forbidden', 1)).toThrow()
      })
      expect(seal).not.toHaveBeenCalled()
      let saved!: Parameters<Parameters<Capability['runCombined']>[1]>[0]
      await capability.runCombined(
        request,
        async (reads) => {
          saved = reads
          return prepare(reads)
        },
        async () => {
          await expect(saved.device()).rejects.toMatchObject({ name: 'PersistencePhaseError' })
          await expect(saved.group.metadata(1)).rejects.toMatchObject({
            name: 'PersistencePhaseError',
          })
        },
      )
      const error = new Error('read rejected')
      await expect(
        capability.read(async () => {
          throw error
        }),
      ).rejects.toBe(error)
      expect((await device.load()).revision).toBe(1)
    })

    test('work revalidates prepared group and device expectations', async () => {
      const { capability, prepare } = await setup(context)
      for (const field of ['device', 'group']) {
        let worked = false
        await expect(
          capability.runCombined(
            request,
            async (reads) => {
              const prepared = await prepare(reads)
              return field === 'device'
                ? { ...prepared, expectedDeviceRevision: 99 }
                : { ...prepared, expected: null }
            },
            async () => {
              worked = true
            },
          ),
        ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
        expect(worked).toBe(false)
      }
    })

    test('copied and unregistered wrappers have no device capability', async () => {
      const { device } = await setup(context)
      expect(deviceEntryCapability({ ...device })).toBeNull()
    })
  })

test('Combined proof requires both matching markers before exposing result or hooks', async () => {
  const { db, capability, prepare } = await setup(true)
  const fault = memoryFaults(db).rejectCommitPending()
  const hooks: Array<string> = []
  const result = capability
    .runCombined(request, prepare, async (stores) => {
      stores.tx.onCommit(() => hooks.push('device'))
      stores.group?.tx.onCommit(() => hooks.push('group'))
      return 'private-result'
    })
    .catch((error: unknown) => error)
  await fault.rejected
  await fault.barrierWaiting
  const transact = db.transact.bind(db)
  vi.spyOn(db, 'transact').mockImplementationOnce((scope, work, options) => {
    // Change one marker after backend completion, before the fresh proof read.
    memoryFaults(db).forceCommittedRow('group-owner', groupOwnerKey(request.groupID), {
      revision: 1,
      mutationID: 'seed',
    })
    return transact(scope, work, options)
  })
  await fault.finish('commit')
  const observed = await result
  expect(observed, 'one matching marker cannot expose a Combined result').not.toBe('private-result')
  expect(observed).toMatchObject({ name: 'GroupStateConflictError' })
  expect(hooks).toEqual([])
})
