import { createMemoryGroupCoordinator, memoryGroupOwnerQueues } from './memory-group-persistence.js'
import { sequenceMemoryCoordinator, sequenceMemoryOperation } from './memory-group-state.js'
import {
  copyStoredValue,
  type GroupOwnerMarker,
  groupOwnerKey,
  sameStoredValue,
} from './memory-incarnation-stores.js'
import {
  bindMemoryPackageReads,
  createTransactionPackageStores,
  memoryDeviceTable,
} from './memory-package-stores.js'
import { createOwnerQueues, type OwnerQueues } from './owner-queue.js'
import { physicalRecordKey } from './persistence-codec.js'
import { GroupStateConflictError, StorageOutcomeUnknownError } from './persistence-errors.js'
import type {
  AtRestCodec,
  DevicePersistence,
  DeviceRecord,
  DeviceStores,
  GroupStores,
  HubCleanupRow,
  MemoryDatabase,
  MemoryTransaction,
  RestoreWork,
  TransactionalGroupEffects,
  TransactionHookSettlement,
} from './persistence-types.js'

type Proof = {
  previousDevice: GroupOwnerMarker | null
  nextDevice: GroupOwnerMarker
  group: { groupID: string; previous: GroupOwnerMarker | null; next: GroupOwnerMarker } | null
  settlement?: TransactionHookSettlement
  complete?(): void
  outcome?: 'committed' | 'rolled-back'
}
type Binding = {
  providerID: string
  ownerDID: string
  proofs: Map<string, Proof>
  tail: Promise<void>
  owners: OwnerQueues
}
const bindings = new WeakMap<MemoryDatabase, Binding>()
const scope = (groupID: string | null) => ({ groupID, devicePackages: true })

function marker(tx: MemoryTransaction, namespace: string, key: string): GroupOwnerMarker | null {
  const value = tx.rows[namespace]?.get(key)
  if (
    value === undefined ||
    (namespace === 'group-owner' && sameStoredValue(value, { mutationID: null, revision: 0 }))
  )
    return null
  if (
    value === null ||
    typeof value !== 'object' ||
    !('revision' in value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !('mutationID' in value) ||
    typeof value.mutationID !== 'string'
  )
    throw new GroupStateConflictError('Unreadable ownership marker')
  return value as GroupOwnerMarker
}

function sameMarker(left: GroupOwnerMarker | null, right: GroupOwnerMarker | null): boolean {
  return left === null || right === null
    ? left === right
    : left.revision === right.revision && left.mutationID === right.mutationID
}

export function createMemoryDevicePersistence(params: {
  db: MemoryDatabase
  atRest: AtRestCodec
  providerID: string
  ownerDID: string
  effects?: TransactionalGroupEffects<MemoryTransaction>
}): DevicePersistence<MemoryTransaction> {
  const { db, atRest, providerID, ownerDID, effects } = params
  if (atRest == null || typeof atRest.seal !== 'function' || typeof atRest.open !== 'function')
    throw new TypeError('Expected callable at-rest seal and open')
  let binding = bindings.get(db)
  if (binding !== undefined && binding.providerID !== providerID)
    throw new GroupStateConflictError('Persistence provider mismatch')
  if (binding !== undefined && binding.ownerDID !== ownerDID)
    throw new GroupStateConflictError('Persistence owner mismatch')
  if (binding === undefined) {
    binding = {
      providerID,
      ownerDID,
      proofs: new Map(),
      tail: Promise.resolve(),
      owners: memoryGroupOwnerQueues(db) ?? createOwnerQueues(),
    }
  }
  const owners = binding.owners
  const coordinator = createMemoryGroupCoordinator({ db, owners, atRest, providerID, effects })
  bindings.set(db, binding)
  const { groups } = coordinator
  const proofs = binding.proofs
  const ownership = binding
  async function withDeviceOwner<TValue>(
    work: (hold: (completion: Promise<void>) => void) => Promise<TValue>,
  ): Promise<TValue> {
    // This also rejects root calls made from inside a transaction, before waiting on our owner.
    await db.completionBarrier(scope(null))
    const previous = ownership.tail
    const { promise, resolve } = Promise.withResolvers<void>()
    ownership.tail = promise
    await previous
    const holds: Array<Promise<void>> = []
    try {
      return await work((completion) => {
        holds.push(completion)
      })
    } finally {
      if (holds.length === 0) resolve()
      else
        void Promise.allSettled(holds).then(() => {
          resolve()
        })
    }
  }
  const ownerKey = physicalRecordKey({
    groupID: ownerDID,
    incarnation: null,
    namespace: 'device-owner',
    recordID: 'current',
  })
  const boundTx = (tx: MemoryTransaction): MemoryTransaction => ({ ...tx, providerID })
  function table<TValue>(tx: MemoryTransaction, namespace: string) {
    return memoryDeviceTable<TValue>({ tx, atRest, providerID, ownerDID, namespace })
  }
  function restore(tx: MemoryTransaction): DeviceStores<MemoryTransaction>['restore'] {
    const rows = table<RestoreWork>(tx, 'device-restore')
    const raw = {
      async load() {
        const ids = rows.ids()
        if (ids.length > 1) throw new GroupStateConflictError('Multiple restore work records')
        if (ids.length === 0) return null
        const work = await rows.load(ids[0] as string)
        if (
          work === null ||
          work.id !== ids[0] ||
          !['invalidate', 'rotate', 'groups'].includes(work.stage) ||
          !Array.isArray(work.remainingGroups) ||
          !work.remainingGroups.every((id) => typeof id === 'string')
        )
          throw new GroupStateConflictError('Invalid restore work')
        return work
      },
      async save(work: RestoreWork | null) {
        const owned = copyStoredValue(work)
        const ids = rows.ids()
        if (owned !== null) {
          if (
            typeof owned.id !== 'string' ||
            !['invalidate', 'rotate', 'groups'].includes(owned.stage) ||
            !Array.isArray(owned.remainingGroups) ||
            !owned.remainingGroups.every((id) => typeof id === 'string')
          )
            throw new GroupStateConflictError('Invalid restore work')
          await rows.save(owned.id, owned)
        }
        for (const id of ids) if (id !== owned?.id) rows.remove(id)
      },
    }
    return {
      load: () => rows.withLock(raw.load),
      save: (work) => {
        const owned = copyStoredValue(work)
        return rows.withLock(() => raw.save(owned))
      },
    }
  }
  async function load(tx: MemoryTransaction): Promise<DeviceRecord> {
    const value = await table<Omit<DeviceRecord, 'restoreWork'>>(tx, 'device').load('current')
    const owner = marker(tx, 'device-owner', ownerKey)
    if (value === null) {
      if (owner !== null) throw new GroupStateConflictError('Missing device revision record')
      return { revision: 0, mutationID: 'initial', restoreWork: await restore(tx).load() }
    }
    if (!sameMarker(value, owner)) throw new GroupStateConflictError('Device ownership conflict')
    return {
      revision: value.revision,
      mutationID: value.mutationID,
      restoreWork: await restore(tx).load(),
    }
  }
  function stores(
    tx: MemoryTransaction,
    group: GroupStores<MemoryTransaction> | null,
  ): DeviceStores<MemoryTransaction> {
    const cleanup = table<HubCleanupRow>(tx, 'device-cleanup')
    const rawCleanup: DeviceStores<MemoryTransaction>['cleanup'] = {
      async list() {
        const values: Array<HubCleanupRow> = []
        for (const id of cleanup.ids()) {
          const row = await cleanup.load(id)
          if (row === null || row.ownerDID !== ownerDID || row.id !== id)
            throw new GroupStateConflictError('Cleanup owner or ID mismatch')
          values.push(row)
        }
        return values
      },
      async put(row) {
        const owned = copyStoredValue(row)
        cleanup.ids()
        if (owned.ownerDID !== ownerDID) throw new GroupStateConflictError('Cleanup owner mismatch')
        if (
          typeof owned.sourceID !== 'string' ||
          typeof owned.ref !== 'string' ||
          typeof owned.id !== 'string' ||
          !['ordinary', 'last-resort'].includes(owned.kind)
        )
          throw new GroupStateConflictError('Cleanup source or kind mismatch')
        await cleanup.save(owned.id, owned)
      },
      async remove(id) {
        cleanup.remove(id)
      },
    }
    return {
      tx,
      group,
      ordinary: (sourceID) =>
        createTransactionPackageStores({ tx, atRest, providerID, ownerDID, sourceID }).ordinary,
      lastResort: (sourceID) =>
        createTransactionPackageStores({ tx, atRest, providerID, ownerDID, sourceID }).lastResort,
      cleanup: {
        list: sequenceMemoryOperation(tx, rawCleanup.list),
        put: sequenceMemoryOperation(tx, rawCleanup.put),
        remove: sequenceMemoryOperation(tx, rawCleanup.remove),
      },
      restore: restore(tx),
    }
  }
  async function resolve(mutationID: string): Promise<'committed' | 'rolled-back'> {
    const proof = proofs.get(mutationID)
    const requestedScope = scope(proof?.group?.groupID ?? null)
    let delay = 100
    for (;;) {
      let owners: { deviceOwner: GroupOwnerMarker | null; groupOwner: GroupOwnerMarker | null }
      try {
        // Absence proves rollback only after the barrier and against both retained owners.
        await db.completionBarrier(requestedScope)
        owners = await db.transact(requestedScope, async (tx) => {
          return {
            deviceOwner: marker(tx, 'device-owner', ownerKey),
            groupOwner:
              proof?.group == null
                ? null
                : marker(tx, 'group-owner', groupOwnerKey(proof.group.groupID)),
          }
        })
      } catch (error) {
        if (error instanceof GroupStateConflictError) throw error
        await new Promise<void>((done) => {
          setTimeout(done, delay)
        })
        delay = Math.min(delay * 2, 15000)
        continue
      }
      const { deviceOwner, groupOwner } = owners
      const committed =
        proof === undefined
          ? deviceOwner?.mutationID === mutationID
          : sameMarker(deviceOwner, proof.nextDevice) &&
            (proof.group === null || sameMarker(groupOwner, proof.group.next))
      const rolledBack =
        proof !== undefined &&
        sameMarker(deviceOwner, proof.previousDevice) &&
        (proof.group === null || sameMarker(groupOwner, proof.group.previous))
      const outcome = committed ? 'committed' : rolledBack ? 'rolled-back' : undefined
      if (outcome === undefined || (proof?.outcome !== undefined && outcome !== proof.outcome))
        throw new GroupStateConflictError('Device or group ownership conflict')
      proof?.settlement?.settle(outcome)
      if (proof !== undefined) {
        proof.outcome = outcome
        proof.complete?.()
      }
      return outcome
    }
  }
  const groupResolve = groups.resolve
  groups.resolve = (groupID, mutationID) => {
    const proof = proofs.get(mutationID)
    return proof?.group?.groupID === groupID && proof.outcome !== 'rolled-back'
      ? resolve(mutationID)
      : groupResolve(groupID, mutationID)
  }
  const device: DevicePersistence<MemoryTransaction> = {
    providerID,
    ownerDID,
    groups,
    async load() {
      return await withDeviceOwner(
        async () => await db.transact(scope(null), (tx) => load(boundTx(tx))),
      )
    },
    transition(change, work) {
      const owned = copyStoredValue(change)
      if (owned.group !== null && owned.group.mutationID !== owned.mutationID)
        return Promise.reject(new GroupStateConflictError('Participant mutation ID mismatch'))
      async function run(hold: (completion: Promise<void>) => void) {
        let proof: Proof | undefined
        let result!: Awaited<ReturnType<typeof work>>
        try {
          return await db.transact(
            scope(owned.group?.groupID ?? null),
            async (baseTx) => {
              const tx = boundTx(baseTx)
              const entry = owners.current()
              try {
                const before = await load(tx)
                if (before.revision !== owned.expectedRevision)
                  throw new GroupStateConflictError('Device revision conflict')
                const prior = proofs.get(owned.mutationID)
                if (prior !== undefined && prior.outcome !== 'rolled-back')
                  throw new GroupStateConflictError('Mutation ID already used; resolve its proof')
                proof = {
                  previousDevice: marker(tx, 'device-owner', ownerKey),
                  nextDevice: { revision: before.revision + 1, mutationID: owned.mutationID },
                  group:
                    owned.group === null
                      ? null
                      : {
                          groupID: owned.group.groupID,
                          previous: marker(tx, 'group-owner', groupOwnerKey(owned.group.groupID)),
                          next: {
                            revision: (owned.group.expected?.revision ?? 0) + 1,
                            mutationID: owned.mutationID,
                          },
                        },
                }
                proofs.set(owned.mutationID, proof)
                if (owned.group === null) result = await work(stores(tx, null))
                else {
                  // Reuse group validation within the owned transaction; no backend gate or transaction is nested.
                  result = await coordinator.transitionInTransaction(
                    tx,
                    owned.group,
                    async (group) => await work(stores(tx, group)),
                  )
                }
                const nextDevice = proof.nextDevice
                const account = async () => {
                  tx.rows['device-owner']?.set(ownerKey, nextDevice)
                  await table<Omit<DeviceRecord, 'restoreWork'>>(tx, 'device').save(
                    'current',
                    nextDevice,
                  )
                }
                if (entry === undefined) await account()
                else await sequenceMemoryCoordinator(entry, account)
                return result
              } finally {
                if (entry !== undefined && owners.failure === null) await entry.enter('outcome')
              }
            },
            {
              onUnknown(settlement) {
                if (proof !== undefined) {
                  proof.settlement = settlement
                  const { promise, resolve } = Promise.withResolvers<void>()
                  proof.complete = resolve
                  hold(promise)
                }
              },
            },
          )
        } catch (error) {
          if (!(error instanceof StorageOutcomeUnknownError)) {
            if (proof !== undefined) proof.outcome = 'rolled-back'
            throw error
          }
          if (proof !== undefined && (await resolve(owned.mutationID)) === 'committed')
            return result
          throw error
        } finally {
          if (proof !== undefined && proof.outcome === undefined && proof.settlement === undefined)
            proof.outcome = 'committed'
        }
      }
      return withDeviceOwner((hold) =>
        owned.group === null
          ? run(hold)
          : owners.run(
              'transition',
              { groupID: owned.group.groupID, ownerDID: null },
              async (entry) => {
                await entry.enter('prepare')
                await entry.enter('work')
                try {
                  const result = await run(hold)
                  entry.settle('committed')
                  return result
                } catch (error) {
                  if (owners.failure === null && entry.phase === 'outcome')
                    entry.settle('rolled-back')
                  throw error
                }
              },
              { mutationID: owned.mutationID },
            ),
      )
    },
    resolve,
  }
  bindMemoryPackageReads(device, async (work) => {
    return await withDeviceOwner(
      async () => await db.transact(scope(null), (tx) => work(stores(boundTx(tx), null))),
    )
  })
  return device
}
