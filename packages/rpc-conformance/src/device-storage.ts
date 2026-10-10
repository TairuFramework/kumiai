import { describe, expect, test } from 'vitest'

import { scanSealed, storageChange, storageSeed, writeStorageInstall } from './group-storage.js'
import type {
  ConformanceDeviceStores,
  ConformanceGroupTransaction,
  StorageConformanceParams,
} from './persistence-fixture.js'

const groupID = 'group-A'
const sourceID = 'source-1'
const utf8 = (value: string) => new TextEncoder().encode(value)

export function testDeviceStorageConformance<TTx extends ConformanceGroupTransaction>(
  params: StorageConformanceParams<TTx>,
): void {
  describe(`Device storage conformance -- ${params.label}`, () => {
    test('co-stores package burn, receipt, group install, cleanup and restore work', async () => {
      const fixture = await params.createFixture('group-B')
      const donor = await params.createFixture(groupID)
      try {
        const { device } = fixture.ports
        const seed = await storageSeed(donor.ports.device.groups)
        const pool = fixture.ports.packageStores(sourceID)
        const ordinary = (await pool.ordinary.list(device.ownerDID))[0]
        const retained = await pool.lastResort.list(device.ownerDID)
        if (ordinary === undefined) throw new Error('Missing ordinary seed')
        const before = await device.load()
        await device.transition(
          {
            mutationID: 'join',
            expectedRevision: before.revision,
            group: { groupID, mutationID: 'join', expected: null },
          },
          async (stores) => {
            if (stores.group === null) throw new Error('Missing group participant')
            expect(stores.group.tx.providerID).toBe(stores.tx.providerID)
            expect(stores.group.tx.groupID).toBe(groupID)
            await stores.ordinary(sourceID).consume(ordinary.ref, groupID)
            await stores.cleanup.put({
              id: 'cleanup-join',
              ownerDID: device.ownerDID,
              sourceID,
              ref: ordinary.ref,
              kind: 'ordinary',
              groupID,
              notAfter: ordinary.notAfter,
            })
            await stores.restore.save({
              id: 'restore-join',
              stage: 'groups',
              remainingGroups: [groupID],
            })
            await writeStorageInstall(stores.group, seed, 'join')
            await params.writeSideRow(stores.tx, 'effect-1', utf8('joined'))
          },
        )
        const reopened = await fixture.reopen()
        expect(await reopened.device.load()).toEqual({
          revision: before.revision + 1,
          mutationID: 'join',
          restoreWork: { id: 'restore-join', stage: 'groups', remainingGroups: [groupID] },
        })
        expect(await reopened.device.groups.loadState({ groupID, incarnation: 1 })).toEqual({
          ...seed.state,
          version: 1,
        })
        expect(await reopened.packageStores(sourceID).ordinary.receipt(ordinary.ref)).toEqual({
          groupID,
        })
        expect(await reopened.packageStores(sourceID).ordinary.list(device.ownerDID)).toEqual([])
        await expect(
          reopened.packageStores(sourceID).ordinary.put(device.ownerDID, ordinary),
        ).rejects.toThrow()
        for (const record of retained) {
          await reopened.packageStores(sourceID).lastResort.consume(record.ref, groupID)
          await reopened.packageStores(sourceID).lastResort.consume(record.ref, 'group-C')
          expect(await reopened.packageStores(sourceID).lastResort.receipt(record.ref)).toBeNull()
        }
        expect(await reopened.packageStores(sourceID).lastResort.list(device.ownerDID)).toEqual(
          retained,
        )
        await reopened.device.groups.transition(
          await storageChange(reopened.device.groups, groupID, 'retire'),
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
        await reopened.device.transition(
          {
            mutationID: 'read-cleanup',
            expectedRevision: (await reopened.device.load()).revision,
            group: null,
          },
          async (stores) => {
            expect((await stores.cleanup.list()).some((row) => row.id === 'cleanup-join')).toBe(
              true,
            )
          },
        )
        expect(await fixture.inspectSideRow('effect-1')).toEqual(utf8('joined'))
        await scanSealed(fixture)
        for (const row of await fixture.inspectRawBytes())
          expect(new TextDecoder().decode(row.bytes)).not.toContain(ordinary.privatePackage)
      } finally {
        await fixture.close()
        await donor.close()
      }
    })

    test.each(['callback', 'after-first-write', 'before-commit'] as const)(
      'rolls back combined package transitions on %s failure',
      async (point) => {
        const fixture = await params.createFixture('group-B')
        const donor = await params.createFixture(groupID)
        try {
          const { device } = fixture.ports
          const ordinary = (
            await fixture.ports.packageStores(sourceID).ordinary.list(device.ownerDID)
          )[0]
          if (ordinary === undefined) throw new Error('Missing ordinary seed')
          const seed = await storageSeed(donor.ports.device.groups)
          const change = {
            mutationID: 'join-failed',
            expectedRevision: (await device.load()).revision,
            group: { groupID, mutationID: 'join-failed', expected: null },
          }
          const before = await fixture.inspectRows()
          const hooks: Array<string> = []
          if (point !== 'callback') fixture.failNext(point)
          await expect(
            device.transition(change, async (stores) => {
              stores.tx.onCommit(() => {
                hooks.push('commit')
              })
              stores.tx.onRollback(() => {
                hooks.push('rollback')
              })
              if (stores.group === null) throw new Error('Missing group')
              await stores.ordinary(sourceID).consume(ordinary.ref, groupID)
              await stores.cleanup.put({
                id: 'cleanup-failed',
                ownerDID: device.ownerDID,
                sourceID,
                ref: ordinary.ref,
                kind: 'ordinary',
                groupID,
                notAfter: ordinary.notAfter,
              })
              await stores.restore.save({
                id: 'restore-failed',
                stage: 'rotate',
                remainingGroups: [groupID],
              })
              await writeStorageInstall(stores.group, seed, 'join-failed')
              await params.writeSideRow(stores.tx, 'effect-1', utf8('effect'))
              if (point === 'callback') throw new Error('callback failure')
            }),
          ).rejects.toThrow()
          expect(await fixture.inspectRows()).toEqual(before)
          expect(hooks).toEqual(
            point === 'callback' || point === 'before-commit' ? ['rollback'] : [],
          )
          expect(await device.groups.load(groupID)).toBeNull()
          expect(
            await fixture.ports.packageStores(sourceID).ordinary.receipt(ordinary.ref),
          ).toBeNull()
          await fixture.reopen()
          await scanSealed(fixture)
        } finally {
          await fixture.close()
          await donor.close()
        }
      },
    )

    test.each(['commit', 'rollback'] as const)(
      'fences both owners and hook queues until combined late %s',
      async (finish) => {
        const fixture = await params.createFixture('group-B')
        const donor = await params.createFixture(groupID)
        try {
          const { device } = fixture.ports
          const pool = fixture.ports.packageStores(sourceID).ordinary
          const ordinary = (await pool.list(device.ownerDID))[0]
          if (ordinary === undefined) throw new Error('Missing package')
          const seed = await storageSeed(donor.ports.device.groups)
          const revision = (await device.load()).revision
          const before = await fixture.inspectRows()
          const hooks: Array<string> = []
          const fault = fixture.rejectCommitPending()
          let settled = false
          const operation = device
            .transition(
              {
                mutationID: 'late-join',
                expectedRevision: revision,
                group: { groupID, mutationID: 'late-join', expected: null },
              },
              async (stores) => {
                if (stores.group === null) throw new Error('Missing participant')
                stores.tx.onCommit(() => {
                  hooks.push('device-commit')
                })
                stores.group.tx.onCommit(() => {
                  hooks.push('group-commit')
                })
                stores.tx.onRollback(() => {
                  hooks.push('device-rollback')
                })
                stores.group.tx.onRollback(() => {
                  hooks.push('group-rollback')
                })
                await stores.ordinary(sourceID).consume(ordinary.ref, groupID)
                await stores.cleanup.put({
                  id: 'cleanup-late',
                  ownerDID: device.ownerDID,
                  sourceID,
                  ref: ordinary.ref,
                  kind: 'ordinary',
                  groupID,
                  notAfter: ordinary.notAfter,
                })
                await stores.restore.save({
                  id: 'restore-late',
                  stage: 'groups',
                  remainingGroups: [groupID],
                })
                await writeStorageInstall(stores.group, seed, 'late-join')
                await params.writeSideRow(stores.tx, 'effect-1', utf8('late effect'))
                return 'private-result'
              },
            )
            .then(
              (value) => {
                settled = true
                return value
              },
              (error: unknown) => {
                settled = true
                return error
              },
            )
          await fault.rejected
          await fault.barrierWaiting
          expect(settled).toBe(false)
          expect(hooks).toEqual([])
          expect(await fixture.inspectRows()).toEqual(before)
          let receiptDone = false
          const read = pool.receipt(ordinary.ref).then((value) => {
            receiptDone = true
            return value
          })
          await device.groups.transition(
            await storageChange(device.groups, 'group-B', 'independent'),
            async (stores) => params.writeSideRow(stores.tx, 'effect-B', utf8('independent')),
          )
          expect(receiptDone).toBe(false)
          expect(hooks).toEqual([])
          fixture.failNext('status-read')
          await fault.finish(finish)
          expect(await operation).toEqual(
            finish === 'commit'
              ? 'private-result'
              : expect.objectContaining({ name: 'StorageOutcomeUnknownError' }),
          )
          expect(await read).toEqual(finish === 'commit' ? { groupID } : null)
          expect(hooks).toEqual(
            finish === 'commit'
              ? ['device-commit', 'group-commit']
              : ['device-rollback', 'group-rollback'],
          )
          expect(await device.resolve('late-join')).toBe(
            finish === 'commit' ? 'committed' : 'rolled-back',
          )
          expect(await device.groups.resolve(groupID, 'late-join')).toBe(
            finish === 'commit' ? 'committed' : 'rolled-back',
          )
          expect(hooks).toHaveLength(2)
          expect(await fixture.inspectSideRow('effect-1')).toEqual(
            finish === 'commit' ? utf8('late effect') : null,
          )
          expect((await device.load()).revision).toBe(revision + (finish === 'commit' ? 1 : 0))
          const reopened = await fixture.reopen()
          expect(await reopened.packageStores(sourceID).ordinary.receipt(ordinary.ref)).toEqual(
            finish === 'commit' ? { groupID } : null,
          )
          await scanSealed(fixture)
        } finally {
          await fixture.close()
          await donor.close()
        }
      },
    )

    test('resolves combined commit-then-reject without resurrecting private material', async () => {
      const fixture = await params.createFixture('group-B')
      const donor = await params.createFixture(groupID)
      try {
        const { device } = fixture.ports
        const seed = await storageSeed(donor.ports.device.groups)
        const ordinary = (
          await fixture.ports.packageStores(sourceID).ordinary.list(device.ownerDID)
        )[0]
        if (ordinary === undefined) throw new Error('Missing package')
        const revision = (await device.load()).revision
        const hooks: Array<string> = []
        fixture.commitThenReject()
        await device.transition(
          {
            mutationID: 'commit-reject',
            expectedRevision: revision,
            group: { groupID, mutationID: 'commit-reject', expected: null },
          },
          async (stores) => {
            stores.tx.onCommit(() => {
              hooks.push('commit')
            })
            stores.tx.onRollback(() => {
              hooks.push('rollback')
            })
            if (stores.group === null) throw new Error('Missing group')
            await stores.ordinary(sourceID).consume(ordinary.ref, groupID)
            await writeStorageInstall(stores.group, seed, 'commit-reject')
          },
        )
        expect(await device.resolve('commit-reject')).toBe('committed')
        expect(hooks).toEqual(['commit'])
        const reopened = await fixture.reopen()
        expect(await reopened.packageStores(sourceID).ordinary.receipt(ordinary.ref)).toEqual({
          groupID,
        })
        await expect(
          reopened.packageStores(sourceID).ordinary.put(device.ownerDID, ordinary),
        ).rejects.toThrow()
        await scanSealed(fixture)
      } finally {
        await fixture.close()
        await donor.close()
      }
    })

    test('retries status-read barriers on the fixture clock without rerunning device work', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const { device } = fixture.ports
        const revision = (await device.load()).revision
        fixture.setTime(1000)
        fixture.failNext('status-read')
        let calls = 0
        let done = false
        const operation = device
          .transition(
            { mutationID: 'retry-read', expectedRevision: revision, group: null },
            async (stores) => {
              calls++
              await stores.restore.save({
                id: 'restore-retry',
                stage: 'rotate',
                remainingGroups: [groupID],
              })
            },
          )
          .then(() => {
            done = true
          })
        await fixture.advanceTime(0)
        await fixture.advanceTime(99)
        expect(done).toBe(false)
        expect(calls).toBe(0)
        await fixture.advanceTime(1)
        await operation
        expect(calls).toBe(1)
        expect((await device.load()).restoreWork?.id).toBe('restore-retry')
      } finally {
        await fixture.close()
      }
    })

    test('preserves restore CRUD, source isolation, CAS and expired transaction stores', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        let { device } = fixture.ports
        const pool = fixture.ports.packageStores(sourceID).ordinary
        const ordinary = (await pool.list(device.ownerDID))[0]
        if (ordinary === undefined) throw new Error('Missing package')
        expect(await pool.list('foreign-owner')).toEqual([])
        expect(
          await fixture.ports.packageStores('foreign-source').ordinary.receipt(ordinary.ref),
        ).toBeNull()
        await expect(pool.put('foreign-owner', ordinary)).rejects.toThrow()
        const stale = {
          mutationID: 'stale',
          expectedRevision: (await device.load()).revision,
          group: null,
        }
        for (const stage of ['invalidate', 'rotate', 'groups'] as const) {
          await device.transition(
            { mutationID: stage, expectedRevision: (await device.load()).revision, group: null },
            async (stores) => {
              await stores.restore.save({ id: 'restore-test', stage, remainingGroups: [groupID] })
              expect(await stores.restore.load()).toEqual({
                id: 'restore-test',
                stage,
                remainingGroups: [groupID],
              })
            },
          )
          const reopened = await fixture.reopen()
          expect((await reopened.device.load()).restoreWork?.stage).toBe(stage)
          // Continue through fresh facades after reconstruction.
          device = reopened.device
        }
        const current = fixture.ports.device
        const before = await fixture.inspectRows()
        await expect(
          current.transition(stale, async () => {
            throw new Error('CAS callback must not run')
          }),
        ).rejects.toThrow()
        expect(await fixture.inspectRows()).toEqual(before)
        let escaped: ConformanceDeviceStores<TTx> | undefined
        await current.transition(
          {
            mutationID: 'clear-work',
            expectedRevision: (await current.load()).revision,
            group: null,
          },
          async (stores) => {
            escaped = stores
            await stores.restore.save(null)
            expect(await stores.restore.load()).toBeNull()
            await stores.cleanup.remove('cleanup-1')
            expect(await stores.cleanup.list()).toEqual([])
            await expect(current.load()).rejects.toThrow()
          },
        )
        if (escaped === undefined) throw new Error('Missing stores')
        await expect(escaped.restore.load()).rejects.toThrow()
        await expect(escaped.cleanup.list()).rejects.toThrow()
        await expect(escaped.ordinary(sourceID).list(current.ownerDID)).rejects.toThrow()
        expect((await current.load()).restoreWork).toBeNull()
        await scanSealed(fixture)
      } finally {
        await fixture.close()
      }
    })
  })
}
