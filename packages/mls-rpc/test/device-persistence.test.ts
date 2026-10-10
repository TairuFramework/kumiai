import { randomIdentity } from '@kokuin/token'
import {
  createKeyPackageBundle,
  encodeKeyPackage,
  encodePrivateKeyPackage,
  keyPackageRef,
} from '@kumiai/mls'
import type { KeyPackageRecord, LastResortRecord } from '@kumiai/mls-hub'
import { describe, expect, test, vi } from 'vitest'

import { createOwnerQueues, type OwnerQueues } from '../src/owner-queue.js'
import { physicalRecordKey, sealRecord } from '../src/persistence-codec.js'
import type {
  DevicePersistence,
  DeviceStores,
  HubCleanupRow,
  MemoryDatabase,
  MemoryTransaction,
  RestoreWork,
} from '../src/persistence-types.js'
import {
  createMemoryDevicePersistence,
  createMemoryGroupPersistence,
  createMemoryPackageStores,
  createMemoryTransaction,
  memoryFaults,
} from '../src/testing.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import {
  installSeed,
  makeStorageSeed,
  nextChange,
  type StorageSeed,
} from './fixtures/storage-seed.js'

const queues = new WeakMap<object, OwnerQueues>()
function ownerQueues(db: object): OwnerQueues {
  let owners = queues.get(db)
  if (owners === undefined) {
    owners = createOwnerQueues()
    queues.set(db, owners)
  }
  return owners
}

const groupID = 'group-A'
const sourceID = 'source-1'
const providerID = 'storage-provider'
const atRest = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(97) })
const restoreWork: RestoreWork = {
  id: 'restore-1',
  stage: 'invalidate',
  remainingGroups: [groupID],
}

test('device groups reuse the ownership queue already bound to the database', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const owners = createOwnerQueues()
  const groups = createMemoryGroupPersistence({ db, owners, atRest, providerID })
  const device = createMemoryDevicePersistence({
    db,
    atRest,
    providerID,
    ownerDID: 'did:example:owner',
  })
  const held = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const owner = owners.run('read', { groupID, ownerDID: null }, async () => {
    entered.resolve()
    await held.promise
  })
  await entered.promise
  let returned = false
  const reading = device.groups.load(groupID).then((value) => {
    returned = true
    return value
  })
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(returned).toBe(false)
  } finally {
    held.resolve()
    await owner
  }
  expect(await reading).toBeNull()
  expect(await groups.load(groupID)).toBeNull()
})

function packageKey(ownerDID: string, ref: string, source = sourceID): string {
  return physicalRecordKey({
    groupID: ownerDID,
    incarnation: null,
    namespace: 'device-package',
    recordID: JSON.stringify([source, ref]),
  })
}

async function writeInstall(
  stores: DeviceStores<MemoryTransaction>,
  seed: StorageSeed,
  ordinary: KeyPackageRecord,
  cleanup: HubCleanupRow,
  mutationID: string,
) {
  await stores.ordinary(sourceID).consume(ordinary.ref, seed.key.groupID)
  await stores.cleanup.put(cleanup)
  await stores.restore.save(restoreWork)
  if (stores.group === null) throw new Error('Missing group participant')
  expect(stores.group.tx.rows).toBe(stores.tx.rows)
  expect(stores.group.tx.providerID).toBe(providerID)
  await stores.group.lifetime.save({ ...seed.lifetime, mutationID })
  await stores.group.incarnation(1).state.save(seed.state)
  await stores.group.trust.save(seed.trust)
}

async function install(
  device: DevicePersistence<MemoryTransaction>,
  seed: StorageSeed,
  ordinary: KeyPackageRecord,
  cleanup: HubCleanupRow,
  mutationID = 'join',
) {
  const before = await device.load()
  return device.transition(
    {
      mutationID,
      expectedRevision: before.revision,
      group: { groupID: seed.key.groupID, mutationID, expected: null },
    },
    async (stores) => writeInstall(stores, seed, ordinary, cleanup, mutationID),
  )
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(mode, () => {
    async function setup() {
      const identity = randomIdentity()
      const ownerDID = identity.id
      const bundle = await createKeyPackageBundle(identity)
      const ordinary: KeyPackageRecord = {
        kind: 'ordinary',
        ref: await keyPackageRef(bundle.publicPackage),
        keyPackage: encodeKeyPackage(bundle.publicPackage),
        privatePackage: encodePrivateKeyPackage(bundle.privatePackage),
        notAfter: Number(bundle.publicPackage.leafNode.lifetime.notAfter),
      }
      const lastResort: LastResortRecord = { ...ordinary, kind: 'last-resort', uploadedAt: null }
      const cleanup: HubCleanupRow = {
        id: 'cleanup-1',
        ownerDID,
        sourceID,
        ref: ordinary.ref,
        kind: 'ordinary',
        groupID,
        notAfter: ordinary.notAfter,
      }
      const db = createMemoryTransaction({ rows: {} })
      const device = createMemoryDevicePersistence({ db, atRest, providerID, ownerDID })
      const packageStores = createMemoryPackageStores({ device, sourceID })
      const seed = await makeStorageSeed({ id: groupID, incarnation: 1, epoch: 3, mode })
      return { db, device, packageStores, ownerDID, ordinary, lastResort, cleanup, seed, identity }
    }

    test('serializes overlapping cleanup put remove and list in call order', async () => {
      const { db, device, cleanup, ownerDID } = await setup()
      await device.transition(
        { mutationID: 'cleanup-fifo', expectedRevision: 0, group: null },
        async (stores) => {
          const [, , rows] = await Promise.all([
            stores.cleanup.put(cleanup),
            stores.cleanup.remove(cleanup.id),
            stores.cleanup.list(),
          ])
          expect(rows).toEqual([])
        },
      )
      const rows = await device.transition(
        { mutationID: 'read-cleanup', expectedRevision: 1, group: null },
        (stores) => stores.cleanup.list(),
      )
      expect(rows).toEqual([])
      expect(
        db.snapshot()['device-cleanup']?.has(
          physicalRecordKey({
            groupID: ownerDID,
            incarnation: null,
            namespace: 'device-cleanup',
            recordID: cleanup.id,
          }),
        ),
      ).toBe(false)
    }, 5000)

    test('serializes package list after an overlapping put in the same transaction', async () => {
      const { device, ordinary, ownerDID } = await setup()
      await device.transition(
        { mutationID: 'package-list-fifo', expectedRevision: 0, group: null },
        async (stores) => {
          const [, rows] = await Promise.all([
            stores.ordinary(sourceID).put(ownerDID, ordinary),
            stores.ordinary(sourceID).list(ownerDID),
          ])
          expect(rows).toEqual([ordinary])
        },
      )
    }, 5000)

    test('rejects a group-only mutation ID reused by a combined transition', async () => {
      const { device, seed, db } = await setup()
      await installSeed(device.groups, seed, 'shared-id')
      const before = db.snapshot()
      let called = false
      await expect(
        device.transition(
          {
            mutationID: 'shared-id',
            expectedRevision: 0,
            group: await nextChange(device.groups, groupID, 'shared-id'),
          },
          async () => {
            called = true
          },
        ),
      ).rejects.toThrow('Mutation ID already used')
      expect(called).toBe(false)
      expect(db.snapshot()).toEqual(before)
      expect(await device.groups.resolve(groupID, 'shared-id')).toBe('committed')
      expect(await device.resolve('shared-id')).toBe('rolled-back')
    }, 5000)

    test('rejects a combined mutation ID reused by a group-only transition and preserves device proof', async () => {
      const { device, seed, db } = await setup()
      await device.transition(
        {
          mutationID: 'shared-id',
          expectedRevision: 0,
          group: { groupID, mutationID: 'shared-id', expected: null },
        },
        async (stores) => {
          if (stores.group === null) throw new Error('Missing group participant')
          await stores.group.lifetime.save({ ...seed.lifetime, mutationID: 'shared-id' })
          await stores.group.incarnation(1).state.save(seed.state)
          await stores.group.trust.save(seed.trust)
        },
      )
      const before = db.snapshot()
      let called = false
      await expect(
        device.groups.transition(
          await nextChange(device.groups, groupID, 'shared-id'),
          async () => {
            called = true
          },
        ),
      ).rejects.toThrow('Mutation ID already used')
      expect(called).toBe(false)
      expect(db.snapshot()).toEqual(before)
      expect(await device.resolve('shared-id')).toBe('committed')
      expect(await device.groups.resolve(groupID, 'shared-id')).toBe('committed')
    }, 5000)

    test('co-stores ordinary burn receipt group install cleanup and restore-work', async () => {
      const { db, device, packageStores, ownerDID, ordinary, lastResort, cleanup, seed } =
        await setup()
      expect((await device.load()).revision).toBe(0)
      await packageStores.ordinary.put(ownerDID, ordinary)
      await packageStores.lastResort.put(ownerDID, lastResort)
      const revision = (await device.load()).revision
      await install(device, seed, ordinary, cleanup)
      expect(await device.load()).toEqual({
        revision: revision + 1,
        mutationID: 'join',
        restoreWork,
      })
      expect.soft(await packageStores.ordinary.list(ownerDID)).toEqual([])
      expect
        .soft(db.snapshot()['device-package']?.has(packageKey(ownerDID, ordinary.ref)))
        .toBe(false)
      expect(await packageStores.ordinary.receipt(ordinary.ref)).toEqual({ groupID })
      expect(await device.groups.load(groupID)).toEqual({ ...seed.lifetime, mutationID: 'join' })
      expect(await device.groups.loadState(seed.key)).toEqual(seed.state)
      expect(await device.groups.loadTrust(groupID)).toEqual(seed.trust)
      await expect(packageStores.ordinary.put(ownerDID, ordinary)).rejects.toThrow('consumed')
      await packageStores.lastResort.consume(lastResort.ref, groupID)
      await packageStores.lastResort.consume(lastResort.ref, 'group-B')
      expect(await packageStores.lastResort.receipt(lastResort.ref)).toBeNull()
      expect(await packageStores.lastResort.list(ownerDID)).toEqual([lastResort])
      for (const [namespace, rows] of Object.entries(db.snapshot())) {
        if (namespace.endsWith('-owner')) continue
        for (const bytes of rows.values()) {
          expect(bytes).toBeInstanceOf(Uint8Array)
          const text = new TextDecoder().decode(bytes as Uint8Array)
          expect(text).not.toContain(ordinary.privatePackage)
          expect(text).not.toContain('invalidate')
          expect(text).not.toContain(cleanup.id)
        }
      }
    })

    test.each(['commit', 'rollback'] as const)(
      'preserves device cleanup and package exclusion across group retirement and late %s',
      async (finish) => {
        const { db, device, packageStores, ownerDID, ordinary, cleanup, seed } = await setup()
        await packageStores.ordinary.put(ownerDID, ordinary)
        const before = await device.load()
        const secondSeed = await makeStorageSeed({ id: 'group-C', incarnation: 1, epoch: 3, mode })
        const hooks: Array<string> = []
        const fault = memoryFaults(db).rejectCommitPending()
        const firstInstall = device
          .transition(
            {
              mutationID: 'join',
              expectedRevision: before.revision,
              group: { groupID, mutationID: 'join', expected: null },
            },
            async (stores) => {
              stores.tx.onCommit(() => {
                hooks.push('device-commit')
              })
              stores.tx.onRollback(() => {
                hooks.push('device-rollback')
              })
              if (stores.group === null) throw new Error('Missing group')
              stores.group.tx.onCommit(() => {
                hooks.push('group-commit')
              })
              stores.group.tx.onRollback(() => {
                hooks.push('group-rollback')
              })
              await writeInstall(stores, seed, ordinary, cleanup, 'join')
              return 'private-result'
            },
          )
          .catch((error: unknown) => error)
        await fault.rejected
        await fault.barrierWaiting
        const deviceResolution = device.resolve('join')
        const groupResolution = device.groups.resolve(groupID, 'join')
        expect(hooks).toEqual([])
        const receiptKey = packageKey(ownerDID, ordinary.ref)
        expect(db.snapshot()['device-receipt']?.has(receiptKey) ?? false).toBe(false)
        let readDone = false
        const receiptRead = packageStores.ordinary.receipt(ordinary.ref).then((value) => {
          readDone = true
          return value
        })
        const secondInstall = install(
          device,
          secondSeed,
          ordinary,
          { ...cleanup, groupID: 'group-C' },
          'second-join',
        )
        const observedSecond = secondInstall.catch((error: unknown) => error)
        const other = await makeStorageSeed({ id: 'group-B', incarnation: 1, epoch: 3, mode })
        await installSeed(device.groups, other, 'independent')
        expect(readDone).toBe(false)
        expect(hooks).toEqual([])
        await fault.finish(finish)
        if (finish === 'commit') {
          expect(await firstInstall).toBe('private-result')
          expect(hooks).toEqual(['device-commit', 'group-commit'])
          expect(await deviceResolution).toBe('committed')
          expect(await groupResolution).toBe('committed')
          expect(await observedSecond).toMatchObject({
            message: expect.stringContaining('consumed'),
          })
          expect(await device.groups.load('group-C')).toBeNull()
          expect(await receiptRead).toEqual({ groupID })
          await device.groups.transition(
            await nextChange(device.groups, groupID, 'retire'),
            async (stores) => {
              const life = await stores.lifetime.load()
              if (life === null) throw new Error('Missing lifetime')
              await stores.lifetime.save({
                ...life,
                activeIncarnation: null,
                revision: life.revision + 1,
                mutationID: 'retire',
              })
            },
          )
          expect((await device.groups.loadState(seed.key))?.deleted).toBe(true)
          const reopenedDevice = createMemoryDevicePersistence({ db, atRest, providerID, ownerDID })
          const cleanupRows = await reopenedDevice.transition(
            {
              mutationID: 'read-cleanup',
              expectedRevision: (await reopenedDevice.load()).revision,
              group: null,
            },
            async (stores) => stores.cleanup.list(),
          )
          expect(cleanupRows).toEqual([cleanup])
          await expect(
            createMemoryPackageStores({ device: reopenedDevice, sourceID }).ordinary.put(
              ownerDID,
              ordinary,
            ),
          ).rejects.toThrow('consumed')
        } else {
          expect(await firstInstall).toMatchObject({ name: 'StorageOutcomeUnknownError' })
          expect(hooks).toEqual(['device-rollback', 'group-rollback'])
          expect(await deviceResolution).toBe('rolled-back')
          expect(await groupResolution).toBe('rolled-back')
          expect(await observedSecond).toBeUndefined()
          expect(await device.groups.load(groupID)).toBeNull()
          expect(await receiptRead).toBeNull()
        }
      },
    )

    test.each(['callback', 'after-first-write', 'before-commit'] as const)(
      'rolls back combined burn group cleanup and restore records on %s failure',
      async (failure) => {
        const { db, device, packageStores, ownerDID, ordinary, cleanup, seed } = await setup()
        await packageStores.ordinary.put(ownerDID, ordinary)
        const before = db.snapshot()
        const revision = (await device.load()).revision
        if (failure !== 'callback') memoryFaults(db).failNext(failure)
        const hooks: Array<string> = []
        await expect(
          device.transition(
            {
              mutationID: 'join',
              expectedRevision: revision,
              group: { groupID, mutationID: 'join', expected: null },
            },
            async (stores) => {
              stores.tx.onRollback(() => {
                hooks.push('rollback')
              })
              await writeInstall(stores, seed, ordinary, cleanup, 'join')
              if (failure === 'callback') throw new Error('callback failed')
            },
          ),
        ).rejects.toThrow(failure)
        expect(db.snapshot()).toEqual(before)
        expect(hooks).toEqual(failure === 'after-first-write' ? [] : ['rollback'])
        expect(await packageStores.ordinary.list(ownerDID)).toEqual([ordinary])
        expect(await device.groups.load(groupID)).toBeNull()
        expect((await device.load()).restoreWork).toBeNull()
      },
    )

    test('rejects stale device and group revisions and mismatched participant mutation IDs', async () => {
      const { db, device, packageStores, ownerDID, ordinary, cleanup, seed } = await setup()
      await packageStores.ordinary.put(ownerDID, ordinary)
      const before = db.snapshot()
      const callback = vi.fn(async () => undefined)
      await expect(
        device.transition({ mutationID: 'stale', expectedRevision: 0, group: null }, callback),
      ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
      await expect(
        device.transition(
          {
            mutationID: 'outer',
            expectedRevision: 1,
            group: { groupID, mutationID: 'inner', expected: null },
          },
          callback,
        ),
      ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
      expect(callback).not.toHaveBeenCalled()
      expect(db.snapshot()).toEqual(before)
      await install(device, seed, ordinary, cleanup)
      const installed = db.snapshot()
      await expect(
        device.transition(
          {
            mutationID: 'stale-group',
            expectedRevision: 2,
            group: {
              groupID,
              mutationID: 'stale-group',
              expected: { revision: 0, activeIncarnation: 1 },
            },
          },
          callback,
        ),
      ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
      expect(db.snapshot()).toEqual(installed)
      expect(callback).not.toHaveBeenCalled()
    })

    test('isolates owner and source predicates and rejects foreign provider reuse', async () => {
      const { db, device, packageStores, ownerDID, ordinary, cleanup } = await setup()
      await packageStores.ordinary.put(ownerDID, ordinary)
      const otherSource = createMemoryPackageStores({ device, sourceID: 'source-2' })
      expect(await otherSource.ordinary.list(ownerDID)).toEqual([])
      expect(await packageStores.ordinary.list('did:example:foreign')).toEqual([])
      await expect(packageStores.ordinary.put('did:example:foreign', ordinary)).rejects.toThrow(
        'owner',
      )
      await packageStores.ordinary.delete('did:example:foreign', ordinary.ref)
      expect(await packageStores.ordinary.list(ownerDID)).toEqual([ordinary])
      await expect(otherSource.ordinary.consume(ordinary.ref, groupID)).rejects.toThrow('ref')
      expect(await otherSource.ordinary.receipt(ordinary.ref)).toBeNull()
      await expect(
        device.transition(
          {
            mutationID: 'foreign-cleanup',
            expectedRevision: (await device.load()).revision,
            group: null,
          },
          async (stores) => stores.cleanup.put({ ...cleanup, ownerDID: 'did:example:foreign' }),
        ),
      ).rejects.toThrow('owner')
      expect(() =>
        createMemoryDevicePersistence({ db, atRest, providerID, ownerDID: 'did:example:foreign' }),
      ).toThrow('owner')
      expect(() =>
        createMemoryDevicePersistence({ db, atRest, providerID: 'foreign-provider', ownerDID }),
      ).toThrow('provider')
      expect(() =>
        createMemoryGroupPersistence({
          owners: ownerQueues(db),
          db,
          atRest,
          providerID: 'foreign-provider',
        }),
      ).toThrow('provider')
      await expect(
        device.transition(
          {
            mutationID: 'wrong-group',
            expectedRevision: (await device.load()).revision,
            group: { groupID, mutationID: 'wrong-group', expected: null },
          },
          async (stores) => stores.ordinary(sourceID).consume(ordinary.ref, 'group-B'),
        ),
      ).rejects.toThrow('group')
    })

    test('refuses pruned private refs for combined installation but retains legacy deletion metadata across restart', async () => {
      const { db, device, packageStores, ownerDID, ordinary, cleanup, seed } = await setup()
      await packageStores.ordinary.put(ownerDID, ordinary)
      await packageStores.ordinary.delete(ownerDID, ordinary.ref)
      const deleted = db.snapshot()
      expect(await packageStores.ordinary.list(ownerDID)).toEqual([])
      await expect(install(device, seed, ordinary, cleanup)).rejects.toThrow('private')
      expect(db.snapshot()).toEqual(deleted)
      const reopened = createMemoryDevicePersistence({
        db: createMemoryTransaction({ rows: deleted }),
        atRest,
        providerID,
        ownerDID,
      })
      const reopenedPackages = createMemoryPackageStores({ device: reopened, sourceID })
      await reopenedPackages.ordinary.consume(ordinary.ref, groupID)
      expect(await reopenedPackages.ordinary.receipt(ordinary.ref)).toEqual({ groupID })
      await reopenedPackages.ordinary.consume(ordinary.ref, groupID)
      await expect(reopenedPackages.ordinary.consume(ordinary.ref, 'group-B')).rejects.toThrow(
        'consumed',
      )
      await expect(reopenedPackages.ordinary.put(ownerDID, ordinary)).rejects.toThrow('consumed')
      expect(await reopened.groups.load(groupID)).toBeNull()
    })

    test('preserves concurrent distinct-ref puts and restores literal work stages without running processing', async () => {
      const { db, device, packageStores, ownerDID, ordinary, lastResort, cleanup } = await setup()
      await Promise.all(
        ['ref-1', 'ref-2'].map((ref) => packageStores.ordinary.put(ownerDID, { ...ordinary, ref })),
      )
      expect((await packageStores.ordinary.list(ownerDID)).map((row) => row.ref).sort()).toEqual([
        'ref-1',
        'ref-2',
      ])
      for (const stage of ['invalidate', 'rotate', 'groups'] as const) {
        await device.transition(
          {
            mutationID: `save-${stage}`,
            expectedRevision: (await device.load()).revision,
            group: null,
          },
          async (stores) => {
            expect(stores.group).toBeNull()
            await stores.cleanup.put(cleanup)
            await stores.restore.save({ ...restoreWork, stage })
            expect(await stores.restore.load()).toEqual({ ...restoreWork, stage })
          },
        )
        const reopened = createMemoryDevicePersistence({
          db: createMemoryTransaction({ rows: db.snapshot() }),
          atRest,
          providerID,
          ownerDID,
        })
        expect((await reopened.load()).restoreWork).toEqual({ ...restoreWork, stage })
      }
      await packageStores.lastResort.put(ownerDID, lastResort)
      await packageStores.lastResort.put(ownerDID, { ...lastResort, uploadedAt: 1000 })
      expect(await packageStores.lastResort.list(ownerDID)).toEqual([
        { ...lastResort, uploadedAt: 1000 },
      ])
      await packageStores.lastResort.delete(ownerDID, lastResort.ref)
      expect(await packageStores.lastResort.list(ownerDID)).toEqual([])
      await device.transition(
        { mutationID: 'clear-work', expectedRevision: (await device.load()).revision, group: null },
        async (stores) => {
          await stores.cleanup.remove(cleanup.id)
          expect(await stores.cleanup.list()).toEqual([])
          await stores.restore.save(null)
        },
      )
      expect((await device.load()).restoreWork).toBeNull()
    })

    test('expires every transaction-bound package cleanup and restore method and rejects root reentrancy', async () => {
      const { device, packageStores, ownerDID, ordinary } = await setup()
      let retained: DeviceStores<MemoryTransaction> | undefined
      await device.transition(
        { mutationID: 'capture', expectedRevision: 0, group: null },
        async (stores) => {
          retained = stores
          await stores.ordinary(sourceID).put(ownerDID, ordinary)
          await expect(packageStores.ordinary.list(ownerDID)).rejects.toThrow('reentrant')
        },
      )
      if (retained === undefined) throw new Error('Missing stores')
      await expect(retained.ordinary(sourceID).list(ownerDID)).rejects.toThrow('expired')
      await expect(retained.lastResort(sourceID).consume(ordinary.ref, groupID)).rejects.toThrow(
        'expired',
      )
      await expect(retained.lastResort(sourceID).receipt(ordinary.ref)).rejects.toThrow('expired')
      await expect(retained.cleanup.list()).rejects.toThrow('expired')
      await expect(retained.restore.load()).rejects.toThrow('expired')
      await expect(retained.restore.save(null)).rejects.toThrow('expired')
    })

    test('serializes same-ref writers inside one transaction so a receipt cannot regain private material', async () => {
      const { db, device, packageStores, ownerDID, ordinary } = await setup()
      await packageStores.ordinary.put(ownerDID, ordinary)
      await device.transition(
        { mutationID: 'parallel-package', expectedRevision: 1, group: null },
        async (stores) => {
          await Promise.all([
            stores.ordinary(sourceID).put(ownerDID, ordinary),
            stores.ordinary(sourceID).consume(ordinary.ref, groupID),
          ])
        },
      )
      expect(await packageStores.ordinary.receipt(ordinary.ref)).toEqual({ groupID })
      expect(await packageStores.ordinary.list(ownerDID)).toEqual([])
      expect(db.snapshot()['device-package']?.has(packageKey(ownerDID, ordinary.ref))).toBe(false)
    })

    test.each(['device-package', 'device-receipt', 'device-cleanup', 'device-restore', 'device'])(
      'rolls back every participant when sealing %s fails',
      async (namespace) => {
        const { db, device, packageStores, ownerDID, ordinary, cleanup, seed } = await setup()
        await packageStores.ordinary.put(ownerDID, ordinary)
        const before = db.snapshot()
        const failing = createMemoryDevicePersistence({
          db,
          providerID,
          ownerDID,
          atRest: {
            ...atRest,
            async seal(bytes, aad) {
              if (JSON.parse(new TextDecoder().decode(aad))[3] === namespace)
                throw new Error('seal failed')
              return atRest.seal(bytes, aad)
            },
          },
        })
        await expect(
          failing.transition(
            {
              mutationID: 'seal-fail',
              expectedRevision: 1,
              group: { groupID, mutationID: 'seal-fail', expected: null },
            },
            async (stores) => {
              await stores.ordinary(sourceID).put(ownerDID, ordinary)
              await writeInstall(stores, seed, ordinary, cleanup, 'seal-fail')
            },
          ),
        ).rejects.toThrow('seal failed')
        expect(db.snapshot()).toEqual(before)
        expect(await device.groups.load(groupID)).toBeNull()
      },
    )

    test('binds ciphertext to its source owner and record address and returns detached values', async () => {
      const { db, device, packageStores, ownerDID, ordinary } = await setup()
      const otherSource = createMemoryPackageStores({ device, sourceID: 'source-2' })
      await packageStores.ordinary.put(ownerDID, ordinary)
      await otherSource.ordinary.put(ownerDID, {
        ...ordinary,
        privatePackage: 'second-private-package',
      })
      const [listed] = await packageStores.ordinary.list(ownerDID)
      if (listed === undefined) throw new Error('Missing package')
      listed.privatePackage = 'mutated'
      expect(await packageStores.ordinary.list(ownerDID)).toEqual([ordinary])
      const corrupted = db.snapshot()
      const firstKey = packageKey(ownerDID, ordinary.ref)
      const secondKey = packageKey(ownerDID, ordinary.ref, 'source-2')
      corrupted['device-package']?.set(firstKey, corrupted['device-package']?.get(secondKey))
      const reopened = createMemoryDevicePersistence({
        db: createMemoryTransaction({ rows: corrupted }),
        atRest,
        providerID,
        ownerDID,
      })
      await expect(
        createMemoryPackageStores({ device: reopened, sourceID }).ordinary.list(ownerDID),
      ).rejects.toThrow()
      const foreignProvider = createMemoryDevicePersistence({
        db: createMemoryTransaction({ rows: db.snapshot() }),
        atRest,
        providerID: 'foreign-provider',
        ownerDID,
      })
      await expect(foreignProvider.load()).rejects.toThrow('provider')
      await expect(
        createMemoryPackageStores({ device: foreignProvider, sourceID }).ordinary.list(ownerDID),
      ).rejects.toThrow('provider')
    })

    test('holds device ownership after backend completion until the combined proof settles both hook queues', async () => {
      const { db: backend, packageStores, ownerDID, ordinary, cleanup, seed } = await setup()
      await packageStores.ordinary.put(ownerDID, ordinary)
      const proofWaiting = Promise.withResolvers<void>()
      const allowProof = Promise.withResolvers<void>()
      let resolving = false
      let earlyRead = false
      const hooks: Array<string> = []
      const db: MemoryDatabase = {
        ...backend,
        async completionBarrier(scope) {
          if (resolving && scope.groupID === groupID) {
            proofWaiting.resolve()
            await allowProof.promise
          }
          await backend.completionBarrier(scope)
        },
        async transact(scope, fn, options) {
          if (resolving && scope.groupID === null && hooks.length === 0) earlyRead = true
          return backend.transact(scope, fn, {
            onUnknown(settlement) {
              resolving = true
              options?.onUnknown(settlement)
            },
          })
        },
      }
      const device = createMemoryDevicePersistence({ db, atRest, providerID, ownerDID })
      const packages = createMemoryPackageStores({ device, sourceID })
      const before = await device.load()
      memoryFaults(backend).commitThenReject()
      const write = device.transition(
        {
          mutationID: 'held-proof',
          expectedRevision: before.revision,
          group: { groupID, mutationID: 'held-proof', expected: null },
        },
        async (stores) => {
          stores.tx.onCommit(() => {
            hooks.push('device')
          })
          stores.group?.tx.onCommit(() => {
            hooks.push('group')
          })
          await writeInstall(stores, seed, ordinary, cleanup, 'held-proof')
        },
      )
      await proofWaiting.promise
      const read = packages.ordinary.receipt(ordinary.ref)
      await new Promise<void>((done) => {
        setTimeout(done, 20)
      })
      expect(hooks).toEqual([])
      allowProof.resolve()
      await write
      expect(await read).toEqual({ groupID })
      expect(hooks).toEqual(['device', 'group'])
      expect(earlyRead).toBe(false)
    })

    test('serializes restore saves in one transaction and refuses unowned absence as rollback proof', async () => {
      const { device } = await setup()
      await expect(device.resolve('unowned')).rejects.toThrow('ownership conflict')
      await device.transition(
        { mutationID: 'concurrent-restore', expectedRevision: 0, group: null },
        async (stores) => {
          await Promise.all([
            stores.restore.save(restoreWork),
            stores.restore.save({ ...restoreWork, id: 'restore-2', stage: 'rotate' }),
          ])
          expect(await stores.restore.load()).toEqual({
            ...restoreWork,
            id: 'restore-2',
            stage: 'rotate',
          })
        },
      )
      expect((await device.load()).restoreWork).toEqual({
        ...restoreWork,
        id: 'restore-2',
        stage: 'rotate',
      })
    })

    test('rejects a source ref retained by multiple owners instead of consuming ambiguous metadata', async () => {
      const { db, packageStores, ownerDID, ordinary } = await setup()
      await packageStores.ordinary.put(ownerDID, ordinary)
      const foreignOwner = randomIdentity().id
      const rows = db.snapshot()
      const address = {
        groupID: foreignOwner,
        incarnation: null,
        namespace: 'device-package',
        recordID: JSON.stringify([sourceID, ordinary.ref]),
      }
      rows['device-package']?.set(
        physicalRecordKey(address),
        await sealRecord(atRest, address, {
          providerID,
          ownerDID: foreignOwner,
          value: { sourceID, ref: ordinary.ref, record: null },
        }),
      )
      const reopened = createMemoryDevicePersistence({
        db: createMemoryTransaction({ rows }),
        atRest,
        providerID,
        ownerDID,
      })
      const packages = createMemoryPackageStores({ device: reopened, sourceID })
      await expect(packages.ordinary.consume(ordinary.ref, groupID)).rejects.toThrow('owner')
      expect(await packages.ordinary.receipt(ordinary.ref)).toBeNull()
      expect(await packages.ordinary.list(ownerDID)).toEqual([ordinary])
    })

    test('retries proof barriers and reads with backoff without rerunning the mutation callback', async () => {
      const { db: backend, packageStores, ownerDID, ordinary, cleanup, seed } = await setup()
      await packageStores.ordinary.put(ownerDID, ordinary)
      let resolving = false
      let failedBarrier = false
      let failedRead = false
      const db: MemoryDatabase = {
        ...backend,
        async completionBarrier(scope) {
          if (resolving && scope.groupID === groupID && !failedBarrier) {
            failedBarrier = true
            throw new Error('barrier unavailable')
          }
          await backend.completionBarrier(scope)
        },
        async transact(scope, fn, options) {
          if (resolving && scope.groupID === groupID && !failedRead) {
            failedRead = true
            throw new Error('proof read unavailable')
          }
          return backend.transact(scope, fn, {
            onUnknown(settlement) {
              resolving = true
              options?.onUnknown(settlement)
            },
          })
        },
      }
      const device = createMemoryDevicePersistence({ db, atRest, providerID, ownerDID })
      const before = await device.load()
      let callbacks = 0
      const hooks: Array<string> = []
      const timer = vi.spyOn(globalThis, 'setTimeout')
      memoryFaults(backend).commitThenReject()
      try {
        await device.transition(
          {
            mutationID: 'retry-proof',
            expectedRevision: before.revision,
            group: { groupID, mutationID: 'retry-proof', expected: null },
          },
          async (stores) => {
            callbacks++
            stores.tx.onCommit(() => {
              hooks.push('device')
            })
            await writeInstall(stores, seed, ordinary, cleanup, 'retry-proof')
          },
        )
        expect(timer.mock.calls.map((call) => call[1])).toEqual([100, 200])
        expect(callbacks).toBe(1)
        expect(hooks).toEqual(['device'])
        expect(await device.resolve('retry-proof')).toBe('committed')
        expect(hooks).toEqual(['device'])
      } finally {
        timer.mockRestore()
      }
    })

    test.each(['device-owner', 'group-owner'])(
      'refuses a mismatched %s marker without settling either hook queue',
      async (namespace) => {
        const { db: backend, packageStores, ownerDID, ordinary, cleanup, seed } = await setup()
        await packageStores.ordinary.put(ownerDID, ordinary)
        let resolving = false
        let corrupted = false
        const db: MemoryDatabase = {
          ...backend,
          async completionBarrier(scope) {
            await backend.completionBarrier(scope)
            if (resolving && !corrupted) {
              corrupted = true
              await backend.transact(scope, async (tx) => {
                tx.rows[namespace]?.set(
                  physicalRecordKey({
                    groupID: namespace === 'device-owner' ? ownerDID : groupID,
                    incarnation: null,
                    namespace,
                    recordID: 'current',
                  }),
                  { revision: 99, mutationID: 'foreign-mutation' },
                )
              })
            }
          },
          transact: (scope, fn, options) =>
            backend.transact(scope, fn, {
              onUnknown(settlement) {
                resolving = true
                options?.onUnknown(settlement)
              },
            }),
        }
        const device = createMemoryDevicePersistence({ db, atRest, providerID, ownerDID })
        const before = await device.load()
        const hooks: Array<string> = []
        memoryFaults(backend).commitThenReject()
        await expect(
          device.transition(
            {
              mutationID: 'conflict-proof',
              expectedRevision: before.revision,
              group: { groupID, mutationID: 'conflict-proof', expected: null },
            },
            async (stores) => {
              stores.tx.onCommit(() => {
                hooks.push('device')
              })
              stores.group?.tx.onCommit(() => {
                hooks.push('group')
              })
              await writeInstall(stores, seed, ordinary, cleanup, 'conflict-proof')
            },
          ),
        ).rejects.toThrow('ownership conflict')
        expect(hooks).toEqual([])
      },
    )

    test('loses packages receipts trust spent authenticators and groups with the provider while retaining only host signing identity', async () => {
      const { device, packageStores, ownerDID, ordinary, lastResort, cleanup, seed, identity } =
        await setup()
      await packageStores.ordinary.put(ownerDID, ordinary)
      await packageStores.lastResort.put(ownerDID, lastResort)
      await install(device, seed, ordinary, cleanup)
      const retainedIdentity = identity.privateKey.slice()
      const lost = createMemoryDevicePersistence({
        db: createMemoryTransaction({ rows: {} }),
        atRest,
        providerID,
        ownerDID: identity.id,
      })
      const lostPackages = createMemoryPackageStores({ device: lost, sourceID })
      expect(identity.privateKey).toEqual(retainedIdentity)
      expect(await lostPackages.ordinary.list(ownerDID)).toEqual([])
      expect(await lostPackages.lastResort.list(ownerDID)).toEqual([])
      expect(await lostPackages.ordinary.receipt(ordinary.ref)).toBeNull()
      expect(await lost.groups.load(groupID)).toBeNull()
      expect(await lost.groups.loadState(seed.key)).toBeNull()
      expect(await lost.groups.loadTrust(groupID)).toBeNull()
      expect(await lost.groups.list()).toEqual([])
      expect((await lost.load()).restoreWork).toBeNull()
      await expect(lostPackages.ordinary.consume(ordinary.ref, groupID)).rejects.toThrow('ref')
    })
  })
}

test.each([
  undefined,
  null,
  {},
  { seal: 1, open: () => undefined },
  { seal: () => undefined, open: 1 },
])('rejects malformed at-rest codecs at both factory boundaries: %j', (codec) => {
  const db = createMemoryTransaction({ rows: {} })
  expect(() =>
    Reflect.apply(createMemoryDevicePersistence, undefined, [
      { db, providerID, ownerDID: 'did:example:owner', atRest: codec },
    ]),
  ).toThrow(TypeError)
  expect(() =>
    Reflect.apply(createMemoryGroupPersistence, undefined, [{ db, providerID, atRest: codec }]),
  ).toThrow(TypeError)
})
