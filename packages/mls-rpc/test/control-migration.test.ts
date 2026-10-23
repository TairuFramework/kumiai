import {
  legacyMigrationFixture,
  legacyMigrationOperation,
  legacyMigrationSlot,
  type MigrationFixture,
  type MigrationResult,
  testControlMigrationActivation,
  testLegacyControlMapping,
} from '@kumiai/rpc-conformance'
import { describe, expect, test, vi } from 'vitest'

import { enqueueOperation } from '../../rpc/lib/control/operations.js'
import { entryCapability } from '../src/entry-capability.js'
import { createMemoryDevicePersistence } from '../src/memory-device-persistence.js'
import { memoryFaults } from '../src/memory-faults.js'
import { groupOwnerKey, memoryRecordTable } from '../src/memory-incarnation-stores.js'
import { createMemoryTransaction } from '../src/memory-transaction.js'
import { decodeStoredValue, physicalRecordKey, recordAAD } from '../src/persistence-codec.js'
import { StorageOutcomeUnknownError } from '../src/persistence-errors.js'
import { listRetiredOutcomes } from '../src/registry/retired.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'

const atRest = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(98) })

async function fixture(
  input: MigrationFixture,
  ownership: 'supplied' | 'absent' = 'absent',
  withControl = true,
  initialJournalDecision: 'adapter' | 'none' | 'missing' = 'adapter',
) {
  let journalDecision = initialJournalDecision
  const db = createMemoryTransaction({ rows: {} })
  const { key } = input.source
  let migrationWritten = false
  let migrationIncarnation: number | null = null
  let paused: { started(): void; wait: Promise<void> } | null = null
  const codec = {
    ...atRest,
    async seal(bytes: Uint8Array, aad: Uint8Array) {
      const value = decodeStoredValue(bytes) as { snapshot?: { schemaVersion?: number } }
      if (value?.snapshot?.schemaVersion === 1) {
        migrationWritten = true
        migrationIncarnation = (
          JSON.parse(new TextDecoder().decode(aad)) as Array<unknown>
        )[2] as number
        if (paused !== null) {
          const held = paused
          paused = null
          held.started()
          await held.wait
        }
      }
      return atRest.seal(bytes, aad)
    },
  }
  await db.transact({ groupID: key.groupID, devicePackages: false }, async (tx) => {
    const table = <T>(namespace: string, incarnation: number | null = key.incarnation) =>
      memoryRecordTable<T>({
        tx,
        key: { groupID: key.groupID, incarnation },
        atRest,
        namespace,
      })
    await table('lifetime', null).save('current', {
      groupID: key.groupID,
      latestIncarnation: input.source.retired ? 2 : 1,
      activeIncarnation: input.source.retired ? 2 : 1,
      revision: 1,
      mutationID: 'seed',
      restorePending: false,
    })
    await table('state').save('current', {
      ...key,
      epoch: input.source.epoch,
      terminal: input.source.terminal,
      deleted: input.source.deleted ?? false,
    })
    if (withControl)
      await table('control').save('current', { snapshot: input.snapshot, mutationID: 'legacy' })
    if (input.mainJournal) await table('meta').save('main-journal', input.mainJournal)
    tx.rows['group-owner']?.set(groupOwnerKey(key.groupID), { revision: 1, mutationID: 'seed' })
  })
  function open() {
    return createMemoryDevicePersistence({
      // A new root factory over the same physical backend, including unfinished transactions.
      db: { ...db },
      atRest: codec,
      providerID: 'migration-provider',
      ownerDID: 'owner',
      ownershipContext: ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
      legacyCommitJournal:
        journalDecision === 'missing'
          ? undefined
          : journalDecision === 'none'
            ? null
            : {
                load: (tx, origin) =>
                  memoryRecordTable<NonNullable<MigrationFixture['mainJournal']>>({
                    tx,
                    key: origin,
                    atRest,
                    namespace: 'meta',
                  }).load('main-journal'),
                async clear(tx, origin) {
                  memoryRecordTable({ tx, key: origin, atRest, namespace: 'meta' }).remove(
                    'main-journal',
                  )
                },
              },
    })
  }
  let device = open()
  const load = async () =>
    (await device.groups.ports(key).control.load()) as unknown as MigrationResult
  return {
    load,
    migrationWritten: () => migrationWritten,
    migrationIncarnation: () => migrationIncarnation,
    async seedIncarnation(incarnation: number, snapshot: Record<string, unknown>) {
      await db.transact({ groupID: key.groupID, devicePackages: false }, async (tx) => {
        const origin = { groupID: key.groupID, incarnation }
        await memoryRecordTable({ tx, key: origin, atRest, namespace: 'state' }).save('current', {
          ...origin,
          epoch: 4,
          terminal: false,
          deleted: false,
        })
        await memoryRecordTable({ tx, key: origin, atRest, namespace: 'control' }).save('current', {
          snapshot,
          mutationID: 'legacy',
        })
      })
    },
    async rawControl(incarnation: number) {
      const address = {
        groupID: key.groupID,
        incarnation,
        namespace: 'control',
        recordID: 'current',
      }
      const bytes = db.snapshot().control?.get(physicalRecordKey(address))
      if (!(bytes instanceof Uint8Array)) throw new Error('Missing control ciphertext')
      return (
        decodeStoredValue(await atRest.open(bytes, recordAAD(address))) as {
          snapshot: Record<string, unknown>
        }
      ).snapshot
    },
    pause() {
      let started!: () => void
      let release!: () => void
      const reached = new Promise<void>((done) => {
        started = done
      })
      const wait = new Promise<void>((done) => {
        release = done
      })
      paused = { started, wait }
      return { started: reached, release }
    },
    get device() {
      return device
    },
    get db() {
      return db
    },
    reopen(decision = journalDecision) {
      journalDecision = decision
      migrationWritten = false
      device = open()
    },
    async journal() {
      return await db.transact({ groupID: key.groupID, devicePackages: false }, (tx) =>
        memoryRecordTable({ tx, key, atRest, namespace: 'meta' }).load('main-journal'),
      )
    },
  }
}

for (const ownership of ['supplied', 'absent'] as const) {
  describe(`sealed root migration (${ownership} ownership context)`, () => {
    test('migrated epoch-only marker permits unrelated enqueue', async () => {
      const input = legacyMigrationFixture()
      input.snapshot.spentSource = { epoch: 4 }
      const host = await fixture(input, ownership)
      const control = host.device.groups.ports(input.source.key).control
      const op = await enqueueOperation(
        { control, now: () => 100, newID: () => crypto.randomUUID() },
        {
          id: 'unrelated',
          kind: 'ledger',
          revokes: false,
          body: new Uint8Array(),
        },
      )
      expect((await control.load()).operations).toEqual([op])
      expect((await control.load()).spentSource).toEqual({ epoch: 4 })
    })
    test.each([false, true])(
      'retired ahead work cannot block the current incarnation or recovery (deleted=%s)',
      async (deleted) => {
        const input = legacyMigrationFixture()
        input.source.retired = true
        input.source.epoch = 3
        if (deleted) input.source.deleted = true
        input.snapshot.commitOnce = legacyMigrationSlot()
        input.snapshot.operations = [legacyMigrationOperation('accepted')]
        input.snapshot.welcomes = [
          { opID: 'op', welcome: new Uint8Array([0, 255]), recipients: ['did:b'] },
        ]
        const host = await fixture(input, ownership)
        const current = legacyMigrationFixture().snapshot
        current.commitOnce = { ...legacyMigrationSlot(), incarnation: 2 }
        const operation = legacyMigrationOperation('accepted')
        operation.built = { ...(operation.built as Record<string, unknown>), incarnation: 2 }
        current.operations = [operation]
        await host.seedIncarnation(2, current)
        const currentKey = { ...input.source.key, incarnation: 2 }
        expect(await host.device.groups.ports(currentKey).control.load()).toMatchObject({
          schemaVersion: 1,
          commitOnce: { opID: 'op', epoch: 4, incarnation: 2 },
        })
        const retired = await host.load()
        expect(retired.commitOnce).toBeNull()
        expect(retired.operations).toEqual([])
        expect(retired.outcomes[1]).toMatchObject({ opID: 'op', kind: 'unknown' })
        expect(retired.welcomes).toEqual([
          { opID: 'op', welcome: new Uint8Array([0, 255]), recipients: ['did:b'] },
        ])
        expect(
          await listRetiredOutcomes({ persistence: host.device.groups, key: input.source.key }),
        ).toEqual(retired.outcomes)
        let ran = false
        await host.device.groups.transition(
          {
            groupID: currentKey.groupID,
            mutationID: 'recovery',
            expected: { revision: 1, activeIncarnation: 2 },
          },
          async (stores) => {
            expect(await stores.incarnation(2).control.load()).toMatchObject({
              schemaVersion: 1,
              commitOnce: { incarnation: 2 },
            })
            ran = true
          },
        )
        expect(ran).toBe(true)
        const once = host.db.snapshot()
        host.reopen()
        expect(await host.device.groups.ports(currentKey).control.load()).toMatchObject({
          schemaVersion: 1,
          commitOnce: { incarnation: 2 },
        })
        expect(await host.load()).toEqual(retired)
        expect(host.db.snapshot()).toEqual(once)
      },
    )
    test.each(['seed', 'unclassifiable'])(
      'resolve first (%s) migrates before later registry reads and workers',
      async (mutationID) => {
        const input = legacyMigrationFixture()
        input.snapshot.operations = [legacyMigrationOperation()]
        input.snapshot.commitOnce = legacyMigrationSlot()
        const host = await fixture(input, ownership)
        host.reopen()
        const resolution = host.device.groups.resolve(input.source.key.groupID, mutationID)
        if (mutationID === 'seed') await expect(resolution).resolves.toBe('committed')
        else await expect(resolution).rejects.toThrow('unclassifiable')
        expect((await host.rawControl(1)).schemaVersion).toBe(1)
        const entry = entryCapability(host.device.groups)
        if (entry === null) throw new Error('Missing entry capability')
        await entry.read(input.source.key.groupID, async (reads) => {
          expect(await reads.control(1)).toMatchObject({ schemaVersion: 1, operations: [] })
        })
        expect(await host.load()).toMatchObject({ schemaVersion: 1, commitOnce: { opID: 'op' } })
        const group = {
          groupID: input.source.key.groupID,
          mutationID: 'read-worker',
          expected: { revision: 1, activeIncarnation: 1 },
        }
        const inspect = async (
          stores: Parameters<Parameters<typeof host.device.groups.transition>[1]>[0],
        ) => {
          expect(await stores.incarnation(1).control.load()).toMatchObject({
            schemaVersion: 1,
            operations: [],
          })
          throw new Error('Worker observed migrated state')
        }
        await expect(host.device.groups.transition(group, inspect)).rejects.toThrow(
          'Worker observed migrated state',
        )
        await host.device.load()
        await expect(
          host.device.transition(
            { mutationID: group.mutationID, expectedRevision: 0, group },
            async (stores) => {
              if (stores.group === null) throw new Error('Missing group stores')
              return inspect(stores.group)
            },
          ),
        ).rejects.toThrow('Worker observed migrated state')
        const once = host.db.snapshot()
        host.reopen()
        await host.load()
        expect(host.db.snapshot()).toEqual(once)
      },
    )
    test('a resolve migration failure cannot let a later worker skip activation', async () => {
      const input = legacyMigrationFixture()
      input.snapshot.operations = [legacyMigrationOperation()]
      input.snapshot.commitOnce = legacyMigrationSlot()
      const host = await fixture(input, ownership)
      memoryFaults(host.db).failNext('before-commit', host.migrationWritten)
      await expect(host.device.groups.resolve(input.source.key.groupID, 'seed')).rejects.toThrow(
        'before-commit',
      )
      expect((await host.rawControl(1)).schemaVersion).toBeUndefined()
      expect(await host.load()).toMatchObject({
        schemaVersion: 1,
        operations: [],
        commitOnce: { opID: 'op' },
      })
    })
    test('requires a journal decision for legacy snapshot activation', async () => {
      const input = legacyMigrationFixture()
      input.mainJournal = {
        publishID: 'pending-main',
        expectedHead: null,
        epoch: 4,
        holdsLogSends: true,
        kind: 'remove',
        commit: new Uint8Array([8]),
        bodies: [],
        journal: new Uint8Array([0, 255]),
      }
      const host = await fixture(input, ownership, true, 'missing')
      const before = host.db.snapshot()
      await expect(host.load()).rejects.toMatchObject({
        name: 'LegacyJournalDecisionRequiredError',
      })
      expect(host.db.snapshot()).toEqual(before)
      expect((await host.rawControl(1)).schemaVersion).toBeUndefined()
      expect(await host.journal()).toEqual(input.mainJournal)
      host.reopen('adapter')
      expect((await host.load()).outcomes).toContainEqual(
        expect.objectContaining({
          kind: 'unknown',
          lostCommit: { kind: 'remove', journal: new Uint8Array([0, 255]) },
        }),
      )
      expect(await host.journal()).toBeNull()
    })
    test.each([false, true])(
      'an absent control snapshot needs no journal decision or state read (unreadable=%s)',
      async (unreadable) => {
        const input = legacyMigrationFixture()
        const host = await fixture(input, ownership, false, 'missing')
        if (unreadable)
          await host.db.transact(
            { groupID: input.source.key.groupID, devicePackages: false },
            async (tx) => {
              tx.rows.state?.set(
                physicalRecordKey({
                  ...input.source.key,
                  namespace: 'state',
                  recordID: 'current',
                }),
                new Uint8Array([0]),
              )
            },
          )
        const before = host.db.snapshot()
        expect(await host.load()).toMatchObject({
          schemaVersion: 1,
          commitOnce: null,
          operations: [],
          outcomes: [],
        })
        expect(host.db.snapshot()).toEqual(before)
        host.reopen()
        await host.load()
        expect(host.db.snapshot()).toEqual(before)
      },
    )
    test('an explicit no-main-journal choice activates a legacy snapshot', async () => {
      const host = await fixture(legacyMigrationFixture(), ownership, true, 'none')
      expect((await host.load()).schemaVersion).toBe(1)
      const once = host.db.snapshot()
      host.reopen('missing')
      await host.load()
      expect(host.db.snapshot()).toEqual(once)
    })
    test('repeated ambiguous migration rollbacks stop with a typed activation error', async () => {
      const host = await fixture(legacyMigrationFixture(), ownership)
      const before = host.db.snapshot()
      const transact = host.db.transact
      let attempts = 0
      const failing = vi.spyOn(host.db, 'transact').mockImplementation((scope, work) =>
        transact(scope, async (tx) => {
          const result = await work(tx)
          if (host.migrationWritten()) {
            attempts++
            if (attempts > 4) throw new Error('Retry witness limit')
            throw new StorageOutcomeUnknownError('Migration outcome unavailable')
          }
          return result
        }),
      )
      try {
        host.reopen()
        await expect(host.load()).rejects.toMatchObject({ name: 'LegacyControlActivationError' })
        expect(attempts).toBe(3)
      } finally {
        failing.mockRestore()
      }
      expect(host.db.snapshot()).toEqual(before)
      host.reopen()
      expect((await host.load()).schemaVersion).toBe(1)
    })
    test('loads refuse an unmarked snapshot after activation', async () => {
      const input = legacyMigrationFixture()
      const host = await fixture(input, ownership)
      await host.load()
      const snapshot = await host.rawControl(1)
      delete snapshot.schemaVersion
      await host.db.transact({ groupID: input.source.key.groupID, devicePackages: false }, (tx) =>
        memoryRecordTable({ tx, key: input.source.key, atRest, namespace: 'control' }).save(
          'current',
          {
            snapshot,
            mutationID: 'unmarked',
          },
        ),
      )
      await expect(host.load()).rejects.toThrow('migration mark')
    })
    test('workers remain held when one incarnation committed and another migration is unfinished', async () => {
      const input = legacyMigrationFixture()
      input.source.retired = true
      input.snapshot.operations = [legacyMigrationOperation()]
      input.snapshot.commitOnce = legacyMigrationSlot()
      const host = await fixture(input, ownership)
      const next = legacyMigrationFixture().snapshot
      next.commitOnce = { ...legacyMigrationSlot(), incarnation: 2 }
      const operation = legacyMigrationOperation()
      operation.built = { ...(operation.built as Record<string, unknown>), incarnation: 2 }
      next.operations = [operation]
      await host.seedIncarnation(2, next)
      const fault = memoryFaults(host.db).rejectCommitPending(
        () => host.migrationIncarnation() === 2,
      )
      let ran = false
      const worker = host.load().then((snapshot) => {
        ran = true
        return snapshot
      })
      await fault.rejected
      try {
        await fault.barrierWaiting
        expect((await host.rawControl(1)).schemaVersion).toBe(1)
        expect((await host.rawControl(2)).schemaVersion).toBeUndefined()
        expect(ran).toBe(false)
      } finally {
        await fault.finish('commit')
      }
      expect((await worker).commitOnce).toBeNull()
      expect(
        await host.device.groups.ports({ ...input.source.key, incarnation: 2 }).control.load(),
      ).toMatchObject({ schemaVersion: 1, commitOnce: { epoch: 4, incarnation: 2 } })
      const once = host.db.snapshot()
      host.reopen()
      await host.load()
      expect(host.db.snapshot()).toEqual(once)
    })
    test('imports a main-only slot when no legacy control snapshot exists', async () => {
      const input = legacyMigrationFixture()
      input.mainJournal = {
        publishID: 'main-only',
        expectedHead: null,
        epoch: 4,
        holdsLogSends: true,
        acceptedAs: '006',
        kind: 'invite',
        commit: new Uint8Array([8]),
        bodies: [],
        journal: new Uint8Array([0, 255]),
      }
      const host = await fixture(input, ownership, false)
      const result = await host.load()
      expect(result.schemaVersion).toBe(1)
      expect(result.outcomes).toHaveLength(1)
      expect(result.outcomes[0]).toMatchObject({
        kind: 'unknown',
        opID: null,
        lostCommit: { kind: 'invite', journal: new Uint8Array([0, 255]) },
      })
      expect(await host.journal()).toBeNull()
      const once = host.db.snapshot()
      host.reopen()
      expect(await host.load()).toEqual(result)
      expect(host.db.snapshot()).toEqual(once)
    })
    testLegacyControlMapping({
      map: async (input) => await (await fixture(input, ownership)).load(),
    })
    testControlMigrationActivation(async (input) => {
      const host = await fixture(input, ownership)
      return {
        bytes: () => host.db.snapshot(),
        reopen: () => host.reopen(),
        journal: host.journal,
        beforeCommit: (point) =>
          memoryFaults(host.db).failNext(point ?? 'before-commit', host.migrationWritten),
        afterCommit: () => memoryFaults(host.db).commitThenReject(host.migrationWritten),
        ambiguous: () => memoryFaults(host.db).rejectCommitPending(host.migrationWritten),
        pause: host.pause,
        async read(path, ready) {
          let result: MigrationResult
          if (path === 'cold') {
            const entry = entryCapability(host.device.groups)
            if (entry === null) throw new Error('Missing entry capability')
            result = (await entry.read(
              input.source.key.groupID,
              async (reads) => await reads.control(input.source.key.incarnation),
            )) as unknown as MigrationResult
          } else if (path === 'retired') {
            await listRetiredOutcomes({ persistence: host.device.groups, key: input.source.key })
            result = await host.load()
          } else if (path === 'state') {
            await host.device.groups.loadState(input.source.key)
            ready?.()
            result = await host.load()
          } else result = await host.load()
          ready?.()
          return result
        },
      }
    })

    test('before-commit fault leaves the complete legacy snapshot; reopen migrates once', async () => {
      const input = legacyMigrationFixture()
      input.snapshot.commitOnce = legacyMigrationSlot()
      input.snapshot.operations = [legacyMigrationOperation()]
      const host = await fixture(input, ownership)
      const before = host.db.snapshot()
      memoryFaults(host.db).failNext('before-commit', host.migrationWritten)
      await expect(host.load()).rejects.toThrow('before-commit')
      expect(host.db.snapshot()).toEqual(before)
      host.reopen()
      expect((await host.load()).schemaVersion).toBe(1)
      const once = host.db.snapshot()
      host.reopen()
      await host.load()
      expect(host.db.snapshot()).toEqual(once)
    })

    test.each(['commit', 'rollback'] as const)(
      'ambiguous %s blocks cold/start/retired worker callbacks until completion proof',
      async (outcome) => {
        const input = legacyMigrationFixture()
        input.snapshot.commitOnce = legacyMigrationSlot()
        input.snapshot.operations = [legacyMigrationOperation()]
        const host = await fixture(input, ownership)
        const before = host.db.snapshot()
        const fault = memoryFaults(host.db).rejectCommitPending(host.migrationWritten)
        const ran: Array<string> = []
        const entry = entryCapability(host.device.groups)
        if (entry === null) throw new Error('Missing entry capability')
        const worker = host.load().then(() => ran.push('publication'))
        await fault.rejected
        const cold = entry.read(input.source.key.groupID, async (reads) => {
          await reads.control(1)
          ran.push('cold')
        })
        const retired = host.device.groups
          .ports(input.source.key)
          .control.load()
          .then(() => ran.push('delivery'))
        await fault.barrierWaiting
        expect(ran).toEqual([])
        expect(host.db.snapshot()).toEqual(before)
        await fault.finish(outcome)
        await Promise.all([worker, cold, retired])
        expect(ran.sort()).toEqual(['cold', 'delivery', 'publication'])
        const once = host.db.snapshot()
        host.reopen()
        await host.load()
        expect(host.db.snapshot()).toEqual(once)
      },
    )

    test('commit-then-reject proves completion before activation and keeps exact host report once', async () => {
      const input = legacyMigrationFixture()
      input.mainJournal = {
        publishID: 'main',
        expectedHead: null,
        epoch: 4,
        kind: 'ledger',
        bodies: ['\u0000token.令牌'],
        journal: new Uint8Array([0, 255, 42]),
        commit: new Uint8Array([8]),
        holdsLogSends: true,
        acceptedAs: '006',
      }
      const host = await fixture(input, ownership)
      memoryFaults(host.db).commitThenReject(host.migrationWritten)
      const result = await host.load()
      expect(result.outcomes[1]).toMatchObject({
        kind: 'unknown',
        lostCommit: {
          kind: 'ledger',
          tokens: ['\u0000token.令牌'],
          journal: new Uint8Array([0, 255, 42]),
        },
      })
      expect(await host.journal()).toBeNull()
      const once = host.db.snapshot()
      host.reopen()
      expect(await host.load()).toEqual(result)
      expect(host.db.snapshot()).toEqual(once)
    })
  })
}
