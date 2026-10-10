import { type AnchorSlot, type AppliedCommit, asLogPosition, type Outcome } from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import { memoryFaults } from '../src/memory-faults.js'
import { createMemoryGroupPersistence } from '../src/memory-group-persistence.js'
import { createGroupStateStores } from '../src/memory-group-state.js'
import { createIncarnationStores } from '../src/memory-incarnation-stores.js'
import { createMemoryTransaction } from '../src/memory-transaction.js'
import { createOwnerQueues, type OwnerQueues } from '../src/owner-queue.js'
import { physicalRecordKey, sealRecord } from '../src/persistence-codec.js'
import { GroupStateConflictError } from '../src/persistence-errors.js'
import type {
  AppOutboxEntry,
  AppSettlementObligation,
  MemoryDatabase,
  PendingAppFrame,
  PersistenceEvent,
} from '../src/persistence-types.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import { installSeed, makeStorageSeed, nextChange } from './fixtures/storage-seed.js'

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
const topicID = 'topic-secret'
const key = { groupID, incarnation: 1 }
const atRest = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(97) })
const anchor: AnchorSlot = { anchor: { epoch: 3, secret: new Uint8Array(32).fill(97) } }
const outcome: Outcome = { id: 'operation-1', opID: 'operation-1', at: 1000, kind: 'unknown' }
const pending: PendingAppFrame = {
  frame: {
    ...key,
    id: 'frame-1',
    protocol: 'chat',
    procedure: 'posted',
    segment: 3,
    topicID,
    position: '2',
  },
  payload: new TextEncoder().encode('plaintext-sentinel'),
  senderDID: 'did:example:sender',
  epoch: 3,
  idempotencyKey: JSON.stringify([groupID, 1, 'chat', 3, topicID, '2']),
}
const entry: AppOutboxEntry = {
  seq: 7,
  protocol: 'chat',
  prc: 'posted',
  data: new TextEncoder().encode('plaintext-sentinel'),
  status: 'accepted',
  lastAttempt: null,
}
const obligation: AppSettlementObligation = {
  sequenceID: '10',
  attemptID: 'publish-1',
  topicID,
  outcome: 'published',
}
const event: PersistenceEvent = { ...key, id: 'event-1', kind: 'accepted', entry }
const applied: AppliedCommit = {
  epoch: 3,
  digest: 'digest-3',
  payloadDigest: 'payload-3',
  sequenceID: '10',
  opID: null,
  removed: false,
}

test('first entry barriers exactly once per group scope, including reads', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const owners = createOwnerQueues()
  const groups = createMemoryGroupPersistence({ owners, db, atRest, providerID: 'memory' })
  const barrier = vi.spyOn(db, 'completionBarrier')
  expect(await groups.load(groupID)).toBeNull()
  expect(await groups.loadState(key)).toBeNull()
  expect(await groups.load('group-B')).toBeNull()
  expect(await groups.loadTrust('group-B')).toBeNull()
  expect(barrier.mock.calls.map(([scope]) => scope)).toEqual([
    { groupID, devicePackages: false },
    { groupID: 'group-B', devicePackages: false },
  ])
})

test('empty list refuses root reentrancy before reading the snapshot', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const owners = createOwnerQueues()
  const groups = createMemoryGroupPersistence({ owners, db, atRest, providerID: 'memory' })
  const snapshot = vi.spyOn(db, 'snapshot')
  await owners.run('read', { groupID, ownerDID: null }, async () => {
    await expect(groups.list()).rejects.toMatchObject({ name: 'ReentrantOwnershipError' })
  })
  expect(snapshot).not.toHaveBeenCalled()
})

test('empty list refuses after factory fail-stop before reading the snapshot', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const owners = createOwnerQueues()
  const groups = createMemoryGroupPersistence({ owners, db, atRest, providerID: 'memory' })
  const snapshot = vi.spyOn(db, 'snapshot')
  const conflict = new GroupStateConflictError('Foreign owner')
  owners.failStop(conflict)
  await expect(groups.list()).rejects.toBe(conflict)
  expect(snapshot).not.toHaveBeenCalled()
})

test('fallback resolution fail-stops the factory on an unreadable ownership marker', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const owners = createOwnerQueues()
  const groups = createMemoryGroupPersistence({ owners, db, atRest, providerID: 'memory' })
  await groups.load(groupID)
  memoryFaults(db).forceCommittedRow('group-owner', JSON.stringify([groupID, null, 'current']), {
    mutationID: 'foreign',
    revision: -1,
  })
  await expect(groups.resolve(groupID, 'unknown')).rejects.toMatchObject({
    name: 'GroupStateConflictError',
  })
  expect(owners.failure).toMatchObject({ name: 'GroupStateConflictError' })
  const transact = vi.spyOn(db, 'transact')
  await expect(groups.load('group-B')).rejects.toBe(owners.failure)
  expect(transact).not.toHaveBeenCalled()
})

test.each(['load', 'resolve'] as const)(
  'fail-stop during %s preparation opens no marker transaction',
  async (operation) => {
    const backend = createMemoryTransaction({ rows: {} })
    const reached = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const db: MemoryDatabase = {
      ...backend,
      async completionBarrier(scope) {
        await backend.completionBarrier(scope)
        reached.resolve()
        await resume.promise
      },
    }
    const owners = createOwnerQueues()
    const groups = createMemoryGroupPersistence({ owners, db, atRest, providerID: 'memory' })
    const transact = vi.spyOn(db, 'transact')
    const reading = (
      operation === 'load' ? groups.load(groupID) : groups.resolve(groupID, 'M')
    ).catch((error: unknown) => error)
    await reached.promise
    const conflict = new GroupStateConflictError('Foreign owner')
    owners.failStop(conflict)
    expect(await reading).toBe(conflict)
    resume.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(transact).not.toHaveBeenCalled()
  },
)

test('list queues one read per committed group sequentially behind pending proof', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const owners = createOwnerQueues()
  const groups = createMemoryGroupPersistence({ owners, db, atRest, providerID: 'memory' })
  const seed = await makeStorageSeed({ id: groupID, incarnation: 1, epoch: 3, mode: 'double' })
  const other = await makeStorageSeed({ id: 'group-B', incarnation: 1, epoch: 3, mode: 'double' })
  await installSeed(groups, seed, 'seed-A')
  await installSeed(groups, other, 'seed-B')
  expect(await groups.load('group-C')).toBeNull()
  const change = await nextChange(groups, groupID, 'pending-list')
  const fault = memoryFaults(db).rejectCommitPending()
  const write = groups.transition(change, async () => {})
  await fault.rejected
  await fault.barrierWaiting
  const run = vi.spyOn(owners, 'run')
  let returned = false
  const listing = groups.list().then((values) => {
    returned = true
    return values
  })
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(returned).toBe(false)
    expect(run.mock.calls.map(([kind, scopes]) => [kind, scopes.groupID])).toEqual([
      ['read', groupID],
    ])
    expect((await groups.load('group-B'))?.mutationID).toBe('seed-B')
  } finally {
    await fault.finish('commit')
    await write
  }
  expect((await listing).map((value) => [value.groupID, value.mutationID])).toEqual([
    [groupID, 'pending-list'],
    ['group-B', 'seed-B'],
  ])
  expect(run.mock.calls.map(([kind, scopes]) => [kind, scopes.groupID])).toEqual([
    ['read', groupID],
    ['read', 'group-B'],
    ['read', 'group-B'],
  ])
})

test('a retrying transition keeps its group slot across two provider transactions', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const owners = createOwnerQueues()
  const groups = createMemoryGroupPersistence({ owners, db, atRest, providerID: 'memory' })
  const rolledBack = Promise.withResolvers<void>()
  const retry = Promise.withResolvers<void>()
  const write = owners.run('transition', { groupID, ownerDID: null }, async (entry) => {
    await entry.enter('prepare')
    await entry.enter('work')
    memoryFaults(db).failNext('before-commit')
    await expect(db.transact({ groupID, devicePackages: false }, async () => {})).rejects.toThrow(
      'before-commit',
    )
    await entry.enter('outcome')
    rolledBack.resolve()
    await retry.promise
    await entry.enter('work')
    await db.transact({ groupID, devicePackages: false }, async () => {})
    await entry.enter('outcome')
    entry.settle('committed')
  })
  await rolledBack.promise
  let loaded = false
  const read = groups.loadState(key).then((value) => {
    loaded = true
    return value
  })
  try {
    await new Promise<void>((done) => setTimeout(done, 0))
    expect(loaded).toBe(false)
  } finally {
    retry.resolve()
    await write
    await read
  }
})

test('barrier creates a neutral owner marker and proves initially absent rollback', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const owners = createOwnerQueues()
  const groups = createMemoryGroupPersistence({ owners, db, atRest, providerID: 'memory' })
  expect(await groups.load(groupID)).toBeNull()
  const ownerKey = physicalRecordKey({
    groupID,
    incarnation: null,
    namespace: 'group-owner',
    recordID: 'current',
  })
  expect(db.snapshot()['group-owner']?.get(ownerKey)).toEqual({ mutationID: null, revision: 0 })
  const seed = await makeStorageSeed({ id: groupID, incarnation: 1, epoch: 3, mode: 'double' })
  const change = await nextChange(groups, groupID, 'absent-rollback')
  const fault = memoryFaults(db).rejectCommitPending()
  const write = groups
    .transition(change, async (stores) => {
      await stores.lifetime.save({ ...seed.lifetime, mutationID: change.mutationID })
      await stores.incarnation(1).state.save(seed.state)
      await stores.trust.save(seed.trust)
    })
    .catch((error: unknown) => error)
  await fault.rejected
  await fault.barrierWaiting
  const proof = groups.resolve(groupID, 'absent-rollback')
  await fault.finish('rollback')
  expect(await proof).toBe('rolled-back')
  expect(await write).toMatchObject({ name: 'StorageOutcomeUnknownError' })
  expect(await groups.load(groupID)).toBeNull()
})

for (const mode of ['real-mls', 'double'] as const) {
  describe(mode, () => {
    async function setup() {
      const db = createMemoryTransaction({ rows: { 'host-status': new Map() } })
      const groups = createMemoryGroupPersistence({
        owners: ownerQueues(db),
        db,
        atRest,
        providerID: 'memory',
      })
      const seed = await makeStorageSeed({ id: groupID, incarnation: 1, epoch: 3, mode })
      await installSeed(groups, seed, 'seed')
      return { db, groups, seed }
    }

    test('rejects overlapping state saves after one version advance', async () => {
      const { groups, seed } = await setup()
      await groups.transition(
        await nextChange(groups, groupID, 'overlapping-state'),
        async (stores) => {
          const [, second] = await Promise.all([
            stores.incarnation(1).state.save({ ...seed.state, version: 2 }),
            stores
              .incarnation(1)
              .state.save({ ...seed.state, version: 3 })
              .catch((error: unknown) => error),
          ])
          expect(second).toMatchObject({ name: 'GroupStateConflictError' })
          expect(await stores.incarnation(1).state.load()).toEqual({ ...seed.state, version: 2 })
        },
      )
      expect((await groups.loadState(key))?.version).toBe(2)
      expect((await groups.load(groupID))?.revision).toBe(2)
    })

    test('rejects overlapping trust saves that discard a staged spent authenticator', async () => {
      const { groups, seed } = await setup()
      const firstTrust = {
        ...seed.trust,
        spentEpochAuthenticators: [
          ...seed.trust.spentEpochAuthenticators,
          new Uint8Array(32).fill(1),
        ],
      }
      await groups.transition(
        await nextChange(groups, groupID, 'overlapping-trust'),
        async (stores) => {
          const [, second] = await Promise.all([
            stores.trust.save(firstTrust),
            stores.trust
              .save({
                ...seed.trust,
                spentEpochAuthenticators: [
                  ...seed.trust.spentEpochAuthenticators,
                  new Uint8Array(32).fill(2),
                ],
              })
              .catch((error: unknown) => error),
          ])
          expect(second).toMatchObject({ name: 'GroupStateConflictError' })
          expect(await stores.trust.load()).toEqual(firstTrust)
        },
      )
      expect((await groups.loadTrust(groupID))?.spentEpochAuthenticators).toEqual(
        expect.arrayContaining(firstTrust.spentEpochAuthenticators),
      )
    })

    test.each([
      { protocol: 'other-protocol' },
      { prc: 'other-procedure' },
      { data: new Uint8Array([9]) },
    ])('rejects overlapping immutable outbox replacement %j', async (replacement) => {
      const { groups } = await setup()
      await groups.transition(
        await nextChange(groups, groupID, 'overlapping-outbox'),
        async (stores) => {
          const [, second] = await Promise.all([
            stores.incarnation(1).outbox.put([entry]),
            stores
              .incarnation(1)
              .outbox.put([{ ...entry, ...replacement }])
              .catch((error: unknown) => error),
          ])
          expect(second).toMatchObject({ name: 'OutboxReplacementError' })
          expect(await stores.incarnation(1).outbox.list()).toEqual([entry])
        },
      )
      expect(await groups.ports(key).outbox.list()).toEqual([entry])
    })

    test('rejects overlapping conflicting settlement puts and retains the first value', async () => {
      const { groups } = await setup()
      await groups.transition(
        await nextChange(groups, groupID, 'overlapping-settlement'),
        async (stores) => {
          const [, second] = await Promise.all([
            stores.incarnation(1).meta.putSettlement(7, obligation),
            stores
              .incarnation(1)
              .meta.putSettlement(7, { ...obligation, attemptID: 'other-attempt' })
              .catch((error: unknown) => error),
          ])
          expect(second).toMatchObject({ name: 'GroupStateConflictError' })
          expect(await stores.incarnation(1).meta.loadSettlement(7)).toEqual(obligation)
        },
      )
      expect(await groups.ports(key).outbox.loadSettlement(7)).toEqual(obligation)
    })

    test('rejects overlapping conflicting event puts and retains the first value', async () => {
      const { groups } = await setup()
      await groups.transition(
        await nextChange(groups, groupID, 'overlapping-event'),
        async (stores) => {
          const [, second] = await Promise.all([
            stores.incarnation(1).meta.putEvents([event]),
            stores
              .incarnation(1)
              .meta.putEvents([{ ...event, entry: { ...entry, status: 'failed' } }])
              .catch((error: unknown) => error),
          ])
          expect(second).toMatchObject({ name: 'GroupStateConflictError' })
          expect(await stores.incarnation(1).meta.events()).toEqual([event])
        },
      )
      expect(await groups.ports(key).outbox.events()).toEqual([event])
    })

    test('keeps overlapping identical puts idempotent across store instances', async () => {
      const { groups } = await setup()
      await groups.transition(
        await nextChange(groups, groupID, 'overlapping-identical'),
        async (stores) => {
          await Promise.all([
            stores.incarnation(1).outbox.put([entry]),
            stores.incarnation(1).outbox.put([structuredClone(entry)]),
            stores.incarnation(1).meta.putSettlement(7, obligation),
            stores.incarnation(1).meta.putSettlement(7, { ...obligation }),
            stores.incarnation(1).meta.putEvents([event]),
            stores.incarnation(1).meta.putEvents([structuredClone(event)]),
          ])
          expect(await stores.incarnation(1).outbox.list()).toEqual([entry])
          expect(await stores.incarnation(1).meta.loadSettlement(7)).toEqual(obligation)
          expect(await stores.incarnation(1).meta.events()).toEqual([event])
        },
      )
      expect((await groups.loadState(key))?.version).toBe(2)
      expect((await groups.load(groupID))?.revision).toBe(2)
    })

    test('reads an anchor after its overlapping save across store instances', async () => {
      const { groups } = await setup()
      await groups.transition(
        await nextChange(groups, groupID, 'overlapping-read'),
        async (stores) => {
          const [, loaded] = await Promise.all([
            stores.incarnation(1).anchor.save(anchor),
            stores.incarnation(1).anchor.load(),
          ])
          expect(loaded).toEqual(anchor)
        },
      )
    })

    test('retains both overlapping control updates across store instances', async () => {
      const { groups } = await setup()
      await groups.transition(
        await nextChange(groups, groupID, 'overlapping-control'),
        async (stores) => {
          await Promise.all([
            stores.incarnation(1).control.apply({ putOutcomes: [outcome] }, 'overlapping-control'),
            stores.incarnation(1).control.apply({ putApplied: [applied] }, 'overlapping-control'),
          ])
          const snapshot = await stores.incarnation(1).control.load()
          expect(snapshot.outcomes).toEqual([outcome])
          expect(snapshot.applied).toEqual([applied])
        },
      )
    })

    test('fences an overlapping anchor write behind lifetime retirement', async () => {
      const { groups } = await setup()
      await groups.transition(
        await nextChange(groups, groupID, 'overlapping-retirement'),
        async (stores) => {
          const life = await stores.lifetime.load()
          if (life === null) throw new Error('Missing lifetime')
          const [, second] = await Promise.all([
            stores.lifetime.save({
              ...life,
              activeIncarnation: null,
              revision: 2,
              mutationID: 'overlapping-retirement',
            }),
            stores
              .incarnation(1)
              .anchor.save(anchor)
              .catch((error: unknown) => error),
          ])
          expect(second).toMatchObject({ name: 'DisplacedGroupHandleError' })
          expect(await stores.incarnation(1).anchor.load()).toBeNull()
        },
      )
      expect((await groups.load(groupID))?.activeIncarnation).toBeNull()
    })

    test('serialises every store operation behind an unrelated namespace seal', async () => {
      const { db, groups, seed } = await setup()
      const entered = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      let pause = true
      const paused = createMemoryGroupPersistence({
        owners: ownerQueues(db),
        db,
        providerID: 'memory',
        atRest: {
          ...atRest,
          async seal(bytes, aad) {
            if (pause && new TextDecoder().decode(aad).includes('"anchor"')) {
              pause = false
              entered.resolve()
              await released.promise
            }
            return await atRest.seal(bytes, aad)
          },
        },
      })
      await paused.transition(
        await nextChange(groups, groupID, 'all-overlapping'),
        async (stores) => {
          const rows = stores.incarnation(1)
          const first = rows.anchor.save(anchor)
          await entered.promise
          const alias = { ...stores.tx }
          const other = createIncarnationStores({ tx: alias, key, atRest })
          const states = createGroupStateStores({ tx: alias, groupID, atRest })
          const completed: Array<number> = []
          const queued = Promise.all(
            [
              stores.lifetime.load(),
              stores.lifetime.save({
                ...seed.lifetime,
                revision: 2,
                mutationID: 'all-overlapping',
              }),
              stores.trust.load(),
              stores.trust.save(seed.trust),
              rows.state.load(),
              rows.state.save({ ...seed.state, version: 2 }),
              rows.control.load(),
              rows.control.apply({ putOutcomes: [outcome] }, 'all-overlapping'),
              rows.anchor.load(),
              rows.anchor.save(null),
              rows.pending.list(),
              rows.pending.put([pending]),
              rows.pending.poison([
                { frame: pending.frame, reason: 'decode-failed', keyConsumed: false },
              ]),
              rows.pending.listPoison(),
              rows.pending.complete([pending.frame.id]),
              rows.cursor.load(topicID),
              rows.cursor.save(topicID, '10'),
              rows.outbox.list(),
              rows.outbox.put([entry]),
              rows.outbox.remove([7]),
              rows.outbox.clear(),
              rows.meta.loadSettlement(7),
              rows.meta.putSettlement(7, obligation),
              rows.meta.putSettlement(7, null),
              rows.meta.events(),
              rows.meta.putEvents([event]),
              rows.meta.ackEvent(event.id),
              rows.clearTransport(),
              other.anchor.load(),
              states.lifetime.load(),
              states.trust.load(),
              states.state(1).load(),
            ].map(async (operation, index) => {
              const value = await operation
              completed.push(index)
              return value
            }),
          )
          try {
            await new Promise<void>((resolve) => setImmediate(resolve))
            expect(completed).toEqual([])
          } finally {
            released.resolve()
          }
          const [, results] = await Promise.all([first, queued])
          expect(completed).toEqual(Array.from({ length: 32 }, (_, index) => index))
          expect(results[8]).toEqual(anchor)
          expect(results[13]).toEqual([
            { frame: pending.frame, reason: 'decode-failed', keyConsumed: false },
          ])
          expect(results[28]).toBeNull()
          expect(await rows.pending.list()).toEqual([])
          expect(await rows.pending.listPoison()).toEqual([])
          expect(await rows.cursor.load(topicID)).toBeNull()
          expect(await rows.outbox.list()).toEqual([])
          expect((await rows.control.load()).outcomes).toEqual([outcome])
        },
      )
      expect((await groups.loadState(key))?.version).toBe(2)
      expect((await groups.load(groupID))?.revision).toBe(2)
    })

    test('completes an outbox effect that loads transaction-bound lifetime', async () => {
      const { db, groups, seed } = await setup()
      const observed: Array<typeof seed.lifetime | null> = []
      const committed: Array<string> = []
      const effects = createMemoryGroupPersistence({
        owners: ownerQueues(db),
        db,
        atRest,
        providerID: 'memory',
        effects: {
          async outbox(tx, status) {
            observed.push(await createGroupStateStores({ tx, groupID, atRest }).lifetime.load())
            tx.onCommit(() => committed.push(status.id))
          },
        },
      })
      await expect(
        effects.transition(await nextChange(groups, groupID, 'outbox-effect'), async (stores) => {
          const rows = stores.incarnation(1)
          await rows.outbox.put([entry])
          await rows.meta.putEvents([event])
          return 'outbox-result'
        }),
      ).resolves.toBe('outbox-result')
      expect(observed).toEqual([{ ...seed.lifetime, revision: 2, mutationID: 'outbox-effect' }])
      expect(committed).toEqual([event.id])
      expect(await groups.ports(key).outbox.list()).toEqual([entry])
      expect((await groups.loadState(key))?.version).toBe(2)
      await groups.ports(key).anchor.save(anchor)
      expect(await groups.ports(key).anchor.load()).toEqual(anchor)
    }, 2000)

    test('completes a delete effect that clears transaction-bound transport', async () => {
      const { db, groups, seed } = await setup()
      await groups.transition(
        await nextChange(groups, groupID, 'prepare-delete'),
        async (stores) => {
          const rows = stores.incarnation(1)
          await rows.anchor.save(anchor)
          await rows.pending.put([pending])
          await rows.cursor.save(topicID, '10')
          await rows.outbox.put([entry])
          await rows.control.apply({ putOutcomes: [outcome] }, 'prepare-delete')
        },
      )
      const committed: Array<typeof key> = []
      const effects = createMemoryGroupPersistence({
        owners: ownerQueues(db),
        db,
        atRest,
        providerID: 'memory',
        effects: {
          async delete(tx, deletedKey) {
            await createIncarnationStores({ tx, key: deletedKey, atRest }).clearTransport()
            tx.onCommit(() => committed.push(deletedKey))
          },
        },
      })
      await expect(
        effects.transition(await nextChange(groups, groupID, 'delete-effect'), async (stores) => {
          const life = await stores.lifetime.load()
          if (life === null) throw new Error('Missing lifetime')
          await stores.lifetime.save({
            ...life,
            activeIncarnation: null,
            revision: life.revision + 1,
            mutationID: 'delete-effect',
          })
          return 'delete-result'
        }),
      ).resolves.toBe('delete-result')
      expect(committed).toEqual([key])
      const ports = groups.ports(key)
      expect(await ports.anchor.load()).toBeNull()
      expect(await ports.cursor.load(topicID)).toBeNull()
      expect(await ports.outbox.list()).toEqual([])
      expect((await ports.control.load()).outcomes).toEqual([outcome])
      expect(db.snapshot().pending?.size).toBe(0)
      expect(await groups.loadTrust(groupID)).toEqual(seed.trust)
      expect(await groups.loadState(key)).toMatchObject({ deleted: true, version: 3 })
      expect(await groups.load(groupID)).toMatchObject({ activeIncarnation: null, revision: 3 })
    }, 2000)

    test('commits or rolls back every namespace and side effect together', async () => {
      const { db, groups } = await setup()
      const effectsHooks: Array<string> = []
      const effects = createMemoryGroupPersistence({
        owners: ownerQueues(db),
        db,
        atRest,
        providerID: 'memory',
        effects: {
          async outbox(tx, status) {
            tx.onCommit(() => {
              effectsHooks.push('commit')
            })
            tx.onRollback(() => {
              effectsHooks.push('rollback')
            })
            const address = {
              groupID,
              incarnation: 1,
              namespace: 'host-status',
              recordID: status.id,
            }
            tx.rows['host-status']?.set(
              physicalRecordKey(address),
              await sealRecord(atRest, address, status),
            )
          },
        },
      })
      const write = async (stores: Parameters<Parameters<typeof groups.transition>[1]>[0]) => {
        const rows = stores.incarnation(1)
        await rows.anchor.save(anchor)
        await rows.control.apply({ putOutcomes: [outcome] }, 'multi-write')
        await rows.pending.put([pending])
        await rows.cursor.save(topicID, '10')
        await rows.outbox.put([entry])
        await rows.meta.putSettlement(7, obligation)
        await rows.meta.putEvents([event])
      }
      const before = db.snapshot()
      await expect(
        effects.transition(await nextChange(groups, groupID, 'multi-write'), async (stores) => {
          await write(stores)
          throw new Error('after first domain write')
        }),
      ).rejects.toThrow('after first domain write')
      expect(db.snapshot()).toEqual(before)
      const retry = await nextChange(groups, groupID, 'multi-write')
      memoryFaults(db).failNext('before-commit')
      await expect(effects.transition(retry, write)).rejects.toThrow('before-commit')
      expect(db.snapshot()).toEqual(before)
      expect(effectsHooks).toEqual(['rollback'])
      await effects.transition(await nextChange(groups, groupID, 'multi-write'), write)
      expect(effectsHooks).toEqual(['rollback', 'commit'])
      for (const [namespace, rows] of Object.entries(db.snapshot())) {
        if (namespace === 'group-owner') continue
        for (const bytes of rows.values()) {
          expect(bytes).toBeInstanceOf(Uint8Array)
          expect(new TextDecoder().decode(bytes as Uint8Array)).not.toContain('plaintext-sentinel')
          expect(new TextDecoder().decode(bytes as Uint8Array)).not.toContain(topicID)
        }
      }
      expect(db.snapshot()['host-status']?.size).toBe(1)
      const reopened = createMemoryGroupPersistence({
        owners: createOwnerQueues(),
        db: createMemoryTransaction({ rows: db.snapshot() }),
        atRest,
        providerID: 'memory',
      })
      expect((await reopened.loadState(key))?.version).toBe(2)
      expect((await reopened.load(groupID))?.revision).toBe(2)
      await reopened.transition(await nextChange(reopened, groupID, 'inspect'), async (stores) => {
        const rows = stores.incarnation(1)
        expect(await rows.anchor.load()).toEqual(anchor)
        expect((await rows.control.load()).outcomes).toEqual([outcome])
        expect(await rows.pending.list()).toEqual([pending])
        expect(await rows.cursor.load(topicID)).toBe('10')
        expect(await rows.outbox.list()).toEqual([entry])
        expect(await rows.meta.loadSettlement(7)).toEqual(obligation)
        expect(await rows.meta.events()).toContainEqual(event)
      })
    })

    test('isolates incarnations and sorts numeric lane positions without locator collisions', async () => {
      const { groups, seed } = await setup()
      const address = { groupID, incarnation: 1, namespace: 'pending', recordID: 'current' }
      expect(physicalRecordKey({ ...address, groupID: 'a|b', recordID: 'c' })).not.toBe(
        physicalRecordKey({ ...address, groupID: 'a', recordID: 'b|c' }),
      )
      await groups.transition(await nextChange(groups, groupID, 'lanes'), async (stores) => {
        const rows = stores.incarnation(1)
        await rows.pending.put([
          { ...pending, frame: { ...pending.frame, id: 'frame-2', position: '10' } },
          pending,
          {
            ...pending,
            epoch: 4,
            frame: { ...pending.frame, id: 'frame-3', segment: 4, position: '2' },
          },
          {
            ...pending,
            frame: { ...pending.frame, id: 'frame-4', topicID: 'topic-other', position: '2' },
          },
        ])
        const all = await rows.pending.list()
        expect(all.map((r) => r.frame.id)).toEqual(['frame-4', 'frame-1', 'frame-2', 'frame-3'])
        expect(
          all
            .filter((r) => r.frame.topicID === topicID && r.frame.segment === 3)
            .map((r) => r.frame.position),
        ).toEqual(['2', '10'])
        expect(await rows.cursor.load('topic-other')).toBeNull()
        await rows.anchor.save(anchor)
        await rows.control.apply({ putApplied: [applied] }, 'lanes')
        const oldRows = stores.incarnation(1)
        const nextRows = stores.incarnation(2)
        expect(await nextRows.anchor.load()).toBeNull()
        expect((await oldRows.control.load()).applied).toHaveLength(1)
        expect((await nextRows.control.load()).applied).toEqual([])
      })
      const next = await makeStorageSeed({ id: groupID, incarnation: 2, epoch: 1, mode })
      next.trust.genesisAnchor = seed.trust.genesisAnchor
      next.trust.spentEpochAuthenticators.push(seed.state.epochAuthenticator)
      await installSeed(groups, next, 'switch')
      expect((await groups.loadState(key))?.deleted).toBe(true)
      expect((await groups.loadState(next.key))?.version).toBe(1)
      expect((await groups.loadTrust(groupID))?.spentEpochAuthenticators).toHaveLength(2)
      expect((await groups.loadTrust(groupID))?.spentEpochAuthenticators).toEqual(
        expect.arrayContaining([seed.state.epochAuthenticator, next.state.epochAuthenticator]),
      )
      await expect(groups.ports(key).outbox.put(entry)).rejects.toMatchObject({
        name: 'DisplacedGroupHandleError',
      })
    })

    test('rejects stale revisions and tombstone-as-absent installation', async () => {
      const { db, groups } = await setup()
      const before = db.snapshot()
      await expect(
        groups.transition(
          { groupID, mutationID: 'stale', expected: { revision: 0, activeIncarnation: 1 } },
          async () => undefined,
        ),
      ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
      expect(db.snapshot()).toEqual(before)
      await groups.transition(await nextChange(groups, groupID, 'delete'), async (stores) => {
        const life = await stores.lifetime.load()
        if (life === null) throw new Error('Missing lifetime')
        await stores.lifetime.save({
          ...life,
          activeIncarnation: null,
          revision: life.revision + 1,
          mutationID: 'delete',
        })
      })
      await expect(
        groups.transition(
          { groupID, mutationID: 'tombstone-is-not-absent', expected: null },
          async () => undefined,
        ),
      ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
    })

    test.each([
      'anchor',
      'control',
      'pending',
      'poison',
      'cursor',
      'outbox',
      'meta',
      'state',
      'trust',
      'lifetime',
    ])('rolls back every row and marker when sealing %s fails', async (namespace) => {
      const { db, groups, seed } = await setup()
      const before = db.snapshot()
      const failing = createMemoryGroupPersistence({
        owners: ownerQueues(db),
        db,
        providerID: 'memory',
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
        failing.transition(await nextChange(groups, groupID, 'seal-fail'), async (stores) => {
          const rows = stores.incarnation(1)
          await rows.anchor.save(anchor)
          await rows.control.apply({ putOutcomes: [outcome] }, 'seal-fail')
          await rows.pending.put([pending])
          await rows.pending.poison([
            { frame: { ...pending.frame, id: 'poison-1' }, reason: 'invalid', keyConsumed: true },
          ])
          await rows.cursor.save(topicID, '10')
          await rows.outbox.put([entry])
          await rows.meta.putEvents([event])
          await stores.trust.save(seed.trust)
        }),
      ).rejects.toThrow('seal failed')
      expect(db.snapshot()).toEqual(before)
    })

    test('preserves markers and hooks on settlement mismatches and co-deletes certified entries with their occurrence', async () => {
      const { db, seed } = await setup()
      const statuses: Array<string> = []
      const withEffects = createMemoryGroupPersistence({
        owners: ownerQueues(db),
        db,
        atRest,
        providerID: 'memory',
        effects: {
          async outbox(tx, status) {
            tx.onCommit(() => {
              statuses.push(status.kind)
            })
            tx.rows['host-status']?.set(
              physicalRecordKey({ ...key, namespace: 'host-status', recordID: status.id }),
              await sealRecord(
                atRest,
                { ...key, namespace: 'host-status', recordID: status.id },
                status,
              ),
            )
          },
        },
      })
      const ports = withEffects.ports(key)
      const attempted: AppOutboxEntry = {
        ...entry,
        lastAttempt: {
          incarnation: 1,
          epoch: 3,
          floor: null,
          attempts: 1,
          publishID: 'publish-1',
          segment: 3,
          topicID,
        },
      }
      await ports.outbox.put(attempted)
      const expected = { identity: seed.trust.installed, stateVersion: 2, attemptID: 'publish-1' }
      const before = db.snapshot()
      for (const [seq, expectedValue, value, reason] of [
        [
          7,
          { ...expected, identity: { ...expected.identity, epoch: 4 } },
          obligation,
          'identity-changed',
        ],
        [7, { ...expected, stateVersion: 1 }, obligation, 'state-version-changed'],
        [8, expected, obligation, 'entry-missing'],
        [7, { ...expected, attemptID: 'old-attempt' }, obligation, 'attempt-changed'],
        [7, expected, { ...obligation, topicID: 'wrong-topic' }, 'attempt-changed'],
      ] as const) {
        expect(await ports.outbox.recordSettlement(seq, value, expectedValue)).toEqual({
          recorded: false,
          reason,
        })
        expect(db.snapshot()).toEqual(before)
        expect(statuses).toEqual(['accepted'])
      }
      expect(await ports.outbox.recordSettlement(7, obligation, expected)).toEqual({
        recorded: true,
      })
      const certified = db.snapshot()
      await expect(ports.outbox.remove(7)).rejects.toThrow('original occurrence')
      expect(db.snapshot()).toEqual(certified)
      if (attempted.lastAttempt === null) throw new Error('Missing attempt')
      await expect(
        ports.outbox.put({
          ...attempted,
          lastAttempt: { ...attempted.lastAttempt, publishID: 'replacement' },
        }),
      ).rejects.toThrow('Obligated entry')
      await ports.outbox.remove(7, { incarnation: 1, segment: 3, topicID, position: '10' })
      expect(await ports.outbox.list()).toEqual([])
      expect(await ports.outbox.loadSettlement(7)).toBeNull()
      expect(
        (await ports.outbox.events()).find((value) => value.kind === 'published'),
      ).toMatchObject({
        entry: attempted,
        occurrence: { incarnation: 1, segment: 3, topicID, position: '10' },
      })
      expect(statuses).toEqual(['accepted', 'published'])
      const removed = db.snapshot()
      await ports.outbox.remove(7)
      await ports.outbox.ackEvent('unknown')
      expect(db.snapshot()).toEqual(removed)
    })

    test('keeps control-apply markers separate and resolves a facade commit before exposing its rows', async () => {
      const { db, groups } = await setup()
      const ports = groups.ports(key)
      memoryFaults(db).commitThenReject()
      await ports.control.apply({ putOutcomes: [outcome] }, 'control-apply')
      expect(await ports.control.lastMutation()).toBe('control-apply')
      await ports.cursor.save(topicID, '10')
      expect(await ports.control.lastMutation()).toBe('control-apply')
      expect((await ports.control.load()).outcomes).toEqual([outcome])
      memoryFaults(db).commitThenReject()
      await ports.outbox.put(entry)
      expect(await ports.outbox.list()).toEqual([entry])
    })

    test('keeps owed records and fork evidence on transport clearing and refuses unresolved obligations', async () => {
      const { db, groups } = await setup()
      await groups.transition(
        await nextChange(groups, groupID, 'prepare-clear'),
        async (stores) => {
          const rows = stores.incarnation(1)
          await rows.control.apply(
            {
              putOutcomes: [outcome],
              putWelcomes: [
                {
                  opID: 'welcome-1',
                  welcome: new Uint8Array([1]),
                  recipients: ['did:example:recipient'],
                },
              ],
              putApplied: [applied],
              cursor: {
                epoch: 3,
                position: asLogPosition('10'),
                fork: { conflictEpoch: 3, sharedPosition: asLogPosition('2'), frameDigest: 'fork' },
              },
            },
            'prepare-clear',
          )
          await rows.anchor.save(anchor)
          await rows.pending.put([pending])
          await rows.pending.complete(['unknown'])
          expect(await rows.pending.list()).toEqual([pending])
          await rows.meta.putEvents([event])
          await rows.outbox.put([entry])
        },
      )
      await groups.transition(
        await nextChange(groups, groupID, 'clear-transport'),
        async (stores) => {
          const rows = stores.incarnation(1)
          await rows.clearTransport()
          expect(await rows.anchor.load()).toBeNull()
          expect(await rows.pending.list()).toEqual([])
          const control = await rows.control.load()
          expect(control.outcomes).toEqual([outcome])
          expect(control.welcomes).toHaveLength(1)
          expect(control.applied).toEqual([])
          expect(control.cursor?.fork).toEqual({
            conflictEpoch: 3,
            sharedPosition: asLogPosition('2'),
            frameDigest: 'fork',
          })
          expect(await rows.meta.events()).toContainEqual(event)
          await rows.outbox.put([{ ...entry, seq: 8 }])
          await rows.meta.putSettlement(8, obligation)
        },
      )
      expect(await groups.ports(key).control.lastMutation()).toBe('prepare-clear')
      const before = db.snapshot()
      await expect(
        groups.transition(await nextChange(groups, groupID, 'blocked-clear'), async (stores) =>
          stores.incarnation(1).clearTransport(),
        ),
      ).rejects.toThrow('Unresolved settlement')
      expect(db.snapshot()).toEqual(before)
      await groups.transition(await nextChange(groups, groupID, 'clear'), async (stores) => {
        const rows = stores.incarnation(1)
        await rows.pending.complete(['frame-1', 'frame-1'])
        expect(await rows.pending.list()).toEqual([])
        expect(await rows.cursor.load(topicID)).toBeNull()
      })
    })

    test('makes nested values defensive and expires transaction stores', async () => {
      const { groups } = await setup()
      const owned = structuredClone(entry)
      await groups.ports(key).outbox.put(owned)
      owned.data.fill(0)
      const loaded = await groups.ports(key).outbox.list()
      loaded[0]?.data.fill(0)
      expect(await groups.ports(key).outbox.list()).toEqual([entry])
      await expect(
        groups.ports(key).outbox.put({ ...entry, prc: 'replacement' }),
      ).rejects.toMatchObject({ name: 'OutboxReplacementError' })
      let expired: Parameters<Parameters<typeof groups.transition>[1]>[0] | undefined
      await groups.transition(await nextChange(groups, groupID, 'expire'), async (stores) => {
        expired = stores
      })
      if (expired === undefined) throw new Error('Missing stores')
      await expect(expired.incarnation(1).pending.list()).rejects.toThrow('expired')
    })

    test('requires matching co-written trust and rejects a reused authenticator', async () => {
      const { db, groups, seed } = await setup()
      const before = db.snapshot()
      const next = await makeStorageSeed({ id: groupID, incarnation: 2, epoch: 1, mode })
      next.trust.genesisAnchor = seed.trust.genesisAnchor
      next.trust.spentEpochAuthenticators.push(seed.state.epochAuthenticator)
      const change = await nextChange(groups, groupID, 'missing-trust')
      await expect(
        groups.transition(change, async (stores) => {
          await stores.lifetime.save({
            ...next.lifetime,
            revision: 2,
            mutationID: change.mutationID,
          })
          await stores.incarnation(2).state.save(next.state)
        }),
      ).rejects.toThrow('co-written')
      expect(db.snapshot()).toEqual(before)
      await expect(
        installSeed(
          groups,
          {
            ...seed,
            key: next.key,
            lifetime: { ...seed.lifetime, latestIncarnation: 2, activeIncarnation: 2 },
            state: { ...seed.state, incarnation: 2 },
            trust: { ...seed.trust, installed: { ...seed.trust.installed, incarnation: 2 } },
          },
          'spent',
        ),
      ).rejects.toThrow('already spent')
      expect(db.snapshot()).toEqual(before)
      expect(() =>
        createMemoryGroupPersistence({
          owners: ownerQueues(db),
          db,
          atRest,
          providerID: 'other-provider',
        }),
      ).toThrow('provider mismatch')
    })

    test('validates settlement against the state reached after waiting for the group gate', async () => {
      const { db, groups, seed } = await setup()
      const ports = groups.ports(key)
      const attempted: AppOutboxEntry = {
        ...entry,
        lastAttempt: {
          incarnation: 1,
          epoch: 3,
          floor: null,
          attempts: 1,
          publishID: 'publish-1',
          segment: 3,
          topicID,
        },
      }
      await ports.outbox.put(attempted)
      const expected = { identity: seed.trust.installed, stateVersion: 2, attemptID: 'publish-1' }
      let release!: () => void
      let entered!: () => void
      const enteredPromise = new Promise<void>((done) => {
        entered = done
      })
      const wait = new Promise<void>((done) => {
        release = done
      })
      const first = groups.transition(
        await nextChange(groups, groupID, 'terminal-first'),
        async (stores) => {
          entered()
          await wait
          const state = await stores.incarnation(1).state.load()
          if (state === null || state.deleted) throw new Error('Missing state')
          await stores
            .incarnation(1)
            .state.save({ ...state, version: state.version + 1, terminal: true })
        },
      )
      await enteredPromise
      const stale = ports.outbox.recordSettlement(7, obligation, expected)
      release()
      await first
      const afterTerminal = db.snapshot()
      expect(await stale).toEqual({ recorded: false, reason: 'state-version-changed' })
      expect(db.snapshot()).toEqual(afterTerminal)
      const fault = memoryFaults(db).rejectCommitPending()
      const settlement = ports.outbox.recordSettlement(7, obligation, {
        ...expected,
        stateVersion: 3,
      })
      await fault.rejected
      await fault.barrierWaiting
      const later = groups.transition(
        {
          groupID,
          mutationID: 'after-certification',
          expected: { revision: 4, activeIncarnation: 1 },
        },
        async (stores) => {
          expect(await stores.incarnation(1).meta.loadSettlement(7)).toEqual(obligation)
          const state = await stores.incarnation(1).state.load()
          if (state === null || state.deleted) throw new Error('Missing state')
          await stores.incarnation(1).state.save({ ...state, version: 5 })
        },
      )
      await fault.finish('commit')
      expect(await settlement).toEqual({ recorded: true })
      await later
    })

    test('versions trust-only metadata once', async () => {
      const { groups, seed } = await setup()
      await groups.transition(
        await nextChange(groups, groupID, 'trust-metadata'),
        async (stores) => {
          await stores.trust.save({
            ...seed.trust,
            ledger: [...seed.trust.ledger, ...seed.trust.ledger],
          })
        },
      )
      expect((await groups.loadState(key))?.version).toBe(2)
    })

    test('refuses an incarnation number without its installation', async () => {
      const { db, groups } = await setup()
      const before = db.snapshot()
      await expect(
        groups.transition(
          await nextChange(groups, groupID, 'orphan-incarnation'),
          async (stores) => {
            const life = await stores.lifetime.load()
            if (life === null) throw new Error('Missing lifetime')
            await stores.lifetime.save({
              ...life,
              latestIncarnation: 2,
              activeIncarnation: null,
              revision: life.revision + 1,
              mutationID: 'orphan-incarnation',
            })
          },
        ),
      ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
      expect(db.snapshot()).toEqual(before)
    })

    test('refuses an installed trust identity without its matching state', async () => {
      const { db, groups } = await setup()
      const before = db.snapshot()
      await expect(
        groups.transition(await nextChange(groups, groupID, 'orphan-trust'), async (stores) => {
          const trust = await stores.trust.load()
          if (trust === null) throw new Error('Missing trust')
          await stores.trust.save({ ...trust, installed: { ...trust.installed, epoch: 4 } })
        }),
      ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
      expect(db.snapshot()).toEqual(before)
    })

    test('performs refused settlement and unknown cleanup without a mutation write', async () => {
      const { db, groups, seed } = await setup()
      const ports = groups.ports(key)
      const before = db.snapshot()
      memoryFaults(db).failNext('after-first-write')
      expect(
        await ports.outbox.recordSettlement(7, obligation, {
          identity: seed.trust.installed,
          stateVersion: 0,
          attemptID: 'publish-1',
        }),
      ).toEqual({ recorded: false, reason: 'state-version-changed' })
      await ports.outbox.remove(99)
      await ports.outbox.ackEvent('unknown')
      await ports.outbox.clear()
      expect(db.snapshot()).toEqual(before)
      await expect(ports.cursor.save(topicID, '10')).rejects.toThrow('after-first-write')
      expect(db.snapshot()).toEqual(before)
    })

    test('performs safety-only writes with unreadable state and trust', async () => {
      const { db } = await setup()
      const rows = db.snapshot()
      rows.state?.set(
        physicalRecordKey({ ...key, namespace: 'state', recordID: 'current' }),
        new Uint8Array([0]),
      )
      rows.trust?.set(
        physicalRecordKey({ groupID, incarnation: null, namespace: 'trust', recordID: 'current' }),
        new Uint8Array([0]),
      )
      const broken = createMemoryTransaction({ rows })
      const groups = createMemoryGroupPersistence({
        owners: createOwnerQueues(),
        db: broken,
        atRest,
        providerID: 'memory',
      })
      await groups.ports(key).control.apply({ putOutcomes: [outcome] }, 'safety-control')
      const change = await nextChange(groups, groupID, 'safety-event')
      const halt: PersistenceEvent = {
        ...key,
        id: 'halt-1',
        kind: 'group:recovery-unavailable',
        reason: 'trust-unreadable',
      }
      await groups.transition(change, async (stores) =>
        stores.incarnation(1).meta.putEvents([halt]),
      )
      expect((await groups.ports(key).control.load()).outcomes).toEqual([outcome])
      await expect(groups.loadTrust(groupID)).rejects.toThrow()
      expect(broken.snapshot().state).toEqual(rows.state)
      expect(broken.snapshot().trust).toEqual(rows.trust)
    })

    test('allows owed cleanup through a retired facade and keeps its key bound', async () => {
      const { groups, seed } = await setup()
      const old = groups.ports(key)
      await old.control.apply({ putOutcomes: [outcome] }, 'old-outcome')
      await old.outbox.put(entry)
      const next = await makeStorageSeed({ id: groupID, incarnation: 2, epoch: 1, mode })
      next.trust.genesisAnchor = seed.trust.genesisAnchor
      next.trust.spentEpochAuthenticators.push(seed.state.epochAuthenticator)
      await installSeed(groups, next, 'retire')
      const leakedKey = old.key
      leakedKey.incarnation = 2
      expect(old.key).toEqual(key)
      expect(await old.outbox.list()).toEqual([entry])
      await old.control.apply({ deleteOutcomes: [outcome.id] }, 'ack-old-outcome')
      await old.outbox.remove(7)
      for (const value of await old.outbox.events()) await old.outbox.ackEvent(value.id)
      expect(await old.outbox.events()).toEqual([])
      await expect(old.anchor.save(anchor)).rejects.toMatchObject({
        name: 'DisplacedGroupHandleError',
      })
      await expect(old.cursor.save(topicID, '10')).rejects.toMatchObject({
        name: 'DisplacedGroupHandleError',
      })
      await expect(
        old.control.apply({ putOutcomes: [outcome] }, 'new-old-outcome'),
      ).rejects.toMatchObject({ name: 'DisplacedGroupHandleError' })
      expect(await groups.ports(next.key).outbox.list()).toEqual([])
      expect(await groups.ports(next.key).anchor.load()).toBeNull()
    })

    test('refuses existing-lifetime installation with missing trust and requires atomic source tombstones', async () => {
      const { db, seed } = await setup()
      const next = await makeStorageSeed({ id: groupID, incarnation: 2, epoch: 1, mode })
      next.trust.genesisAnchor = seed.trust.genesisAnchor
      next.trust.spentEpochAuthenticators.push(seed.state.epochAuthenticator)
      const absentTrust = db.snapshot()
      absentTrust.trust?.clear()
      const missing = createMemoryGroupPersistence({
        owners: createOwnerQueues(),
        db: createMemoryTransaction({ rows: absentTrust }),
        atRest,
        providerID: 'memory',
      })
      await expect(installSeed(missing, next, 'missing-retained-trust')).rejects.toThrow('trust')
      const absentState = db.snapshot()
      absentState.state?.clear()
      const missingState = createMemoryGroupPersistence({
        owners: createOwnerQueues(),
        db: createMemoryTransaction({ rows: absentState }),
        atRest,
        providerID: 'memory',
      })
      await installSeed(missingState, next, 'replace-missing-state')
      expect((await missingState.loadState(key))?.deleted).toBe(true)
    })

    test('expires staged trust methods and advances an explicit state version only once', async () => {
      const { groups, seed } = await setup()
      let expired: Parameters<Parameters<typeof groups.transition>[1]>[0] | undefined
      await groups.transition(
        await nextChange(groups, groupID, 'explicit-state'),
        async (stores) => {
          expired = stores
          await stores.trust.save(seed.trust)
          await stores.incarnation(1).state.save({ ...seed.state, version: 2 })
          await stores.incarnation(1).anchor.save(anchor)
          await stores.incarnation(1).cursor.save(topicID, '10')
        },
      )
      expect((await groups.loadState(key))?.version).toBe(2)
      if (expired === undefined) throw new Error('Missing stores')
      await expect(expired.trust.load()).rejects.toThrow('expired')
      await expect(expired.trust.save(seed.trust)).rejects.toThrow('expired')
    })

    test.each(['commit', 'rollback'] as const)(
      'waits for ambiguous %s proof and settles hooks before releasing callers',
      async (finish) => {
        const { db, groups } = await setup()
        const change = await nextChange(groups, groupID, 'uncertain')
        const fault = memoryFaults(db).rejectCommitPending()
        const hooks: Array<string> = []
        let returned = false
        const write = groups
          .transition(change, async (stores) => {
            stores.tx.onCommit(() => {
              hooks.push('commit')
              throw new Error('hook')
            })
            stores.tx.onCommit(() => {
              hooks.push('second-commit')
            })
            stores.tx.onRollback(() => {
              hooks.push('rollback')
            })
            await stores.incarnation(1).anchor.save(anchor)
            return 'private-result'
          })
          .then(
            (value) => {
              returned = true
              return value
            },
            (error: unknown) => {
              returned = true
              throw error
            },
          )
        const observed = write.catch((error: unknown) => error)
        await fault.rejected
        await fault.barrierWaiting
        expect(returned).toBe(false)
        expect(hooks).toEqual([])
        const competing = groups.ports(key).cursor.save(topicID, '20')
        const other = createMemoryGroupPersistence({
          owners: ownerQueues(db),
          db,
          atRest,
          providerID: 'memory',
        })
        expect(await other.load('group-B')).toBeNull()
        await fault.finish(finish)
        if (finish === 'commit') {
          expect(await observed).toBe('private-result')
          expect(hooks).toEqual(['commit', 'second-commit'])
        } else {
          expect(await observed).toMatchObject({ name: 'StorageOutcomeUnknownError' })
          expect(hooks).toEqual(['rollback'])
        }
        await competing
      },
    )
  })
}

test('retries completion-barrier and proof-read failures outside storage without admitting the candidate again', async () => {
  const backend = createMemoryTransaction({ rows: {} })
  let resolving = false
  let failedBarrier = false
  let failedRead = false
  let barrierPassed = false
  const db: MemoryDatabase = {
    ...backend,
    async completionBarrier(scope) {
      if (resolving && !failedBarrier) {
        failedBarrier = true
        throw new Error('barrier unavailable')
      }
      await backend.completionBarrier(scope)
      barrierPassed = true
    },
    async transact(scope, work, options) {
      if (resolving) {
        expect(barrierPassed).toBe(true)
        barrierPassed = false
        if (!failedRead) {
          failedRead = true
          throw new Error('proof read unavailable')
        }
      }
      return await backend.transact(scope, work, {
        onUnknown(settlement) {
          resolving = true
          options?.onUnknown(settlement)
        },
      })
    },
  }
  const groups = createMemoryGroupPersistence({
    owners: ownerQueues(db),
    db,
    atRest,
    providerID: 'memory',
  })
  const seed = await makeStorageSeed({ id: groupID, incarnation: 1, epoch: 3, mode: 'double' })
  await installSeed(groups, seed, 'seed')
  const change = await nextChange(groups, groupID, 'retry-proof')
  memoryFaults(backend).commitThenReject()
  const timer = vi.spyOn(globalThis, 'setTimeout')
  let callbacks = 0
  const hooks: Array<string> = []
  try {
    expect(
      await groups.transition(change, async (stores) => {
        callbacks++
        stores.tx.onCommit(() => {
          hooks.push('commit')
        })
        await stores.incarnation(1).anchor.save(anchor)
        return 'private'
      }),
    ).toBe('private')
    expect(timer.mock.calls.map((call) => call[1])).toEqual([100, 200])
    expect(callbacks).toBe(1)
    expect(hooks).toEqual(['commit'])
    const before = backend.snapshot()
    expect(await groups.resolve(groupID, 'retry-proof')).toBe('committed')
    expect(backend.snapshot()).toEqual(before)
    expect(hooks).toEqual(['commit'])
  } finally {
    timer.mockRestore()
  }
})
