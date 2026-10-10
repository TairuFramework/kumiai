import { createMemoryGroupCoordinator, memoryGroupOwnerQueues } from './memory-group-persistence.js'
import {
  bindMemoryOwner,
  sequenceMemoryCoordinator,
  sequenceMemoryOperation,
} from './memory-group-state.js'
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
import { createOwnerQueues, type OwnerEntry, type OwnerQueues } from './owner-queue.js'
import { physicalRecordKey } from './persistence-codec.js'
import {
  GroupStateConflictError,
  GroupStateUncertainError,
  StorageOutcomeUnknownError,
} from './persistence-errors.js'
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
  group: { groupID: string; previous: GroupOwnerMarker | null } | null
  settlement?: TransactionHookSettlement
  outcome?: 'committed' | 'rolled-back'
}
type Binding = {
  providerID: string
  ownerDID: string
  proofs: Map<string, Proof>
  owners: OwnerQueues
}
const bindings = new WeakMap<MemoryDatabase, Binding>()
const scope = (groupID: string | null) => ({ groupID, devicePackages: true })

function marker(tx: MemoryTransaction, namespace: string, key: string): GroupOwnerMarker | null {
  const value = tx.rows[namespace]?.get(key)
  if (value === undefined || sameStoredValue(value, { mutationID: null, revision: 0 })) return null
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
      owners: memoryGroupOwnerQueues(db) ?? createOwnerQueues(),
    }
  }
  const owners = binding.owners
  const coordinator = createMemoryGroupCoordinator({ db, owners, atRest, providerID, effects })
  bindings.set(db, binding)
  const { groups } = coordinator
  const proofs = binding.proofs
  const ownerKey = physicalRecordKey({
    groupID: ownerDID,
    incarnation: null,
    namespace: 'device-owner',
    recordID: 'current',
  })
  const boundTx = (tx: MemoryTransaction, entry: OwnerEntry): MemoryTransaction => {
    bindMemoryOwner(tx, entry, owners)
    return {
      ...tx,
      providerID,
      onCommit: (hook) => entry.onCommit(hook),
      onRollback: (hook) => entry.onRollback(hook),
    }
  }
  async function prepare(entry: OwnerEntry): Promise<void> {
    await entry.enter('prepare')
    const keys = [JSON.stringify(['device', ownerDID])]
    if (entry.scopes.groupID !== null) keys.push(JSON.stringify(['group', entry.scopes.groupID]))
    if (keys.some((key) => !owners.started(key))) {
      await db.completionBarrier(scope(entry.scopes.groupID))
      if (owners.failure !== null) throw owners.failure
      try {
        await db.transact(scope(entry.scopes.groupID), async (tx) => {
          marker(tx, 'device-owner', ownerKey)
          if (entry.scopes.groupID !== null)
            marker(tx, 'group-owner', groupOwnerKey(entry.scopes.groupID))
        })
      } catch (error) {
        if (error instanceof GroupStateConflictError) owners.failStop(error)
        throw error
      }
      for (const key of keys) owners.markStarted(key)
    }
    await entry.enter('work')
  }
  function read<TValue>(work: (tx: MemoryTransaction) => Promise<TValue>): Promise<TValue> {
    return owners.run('read', { ownerDID, groupID: null }, async (entry) => {
      await prepare(entry)
      return await db.transact(scope(null), async (baseTx) => {
        const tx = boundTx(baseTx, entry)
        try {
          return await entry.sequence(() => work(tx))
        } finally {
          if (owners.failure === null) await entry.enter('outcome')
        }
      })
    })
  }
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
      load: sequenceMemoryOperation(tx, raw.load),
      save: sequenceMemoryOperation(tx, raw.save, 'side'),
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
  async function prove(mutationID: string, proof: Proof): Promise<'committed' | 'rolled-back'> {
    if (owners.failure !== null) throw owners.failure
    const requestedScope = scope(proof.group?.groupID ?? null)
    await db.completionBarrier(requestedScope)
    if (owners.failure !== null) throw owners.failure
    let markers: { device: GroupOwnerMarker | null; group: GroupOwnerMarker | null }
    try {
      markers = await db.transact(requestedScope, async (tx) => ({
        device: marker(tx, 'device-owner', ownerKey),
        group:
          proof.group === null
            ? null
            : marker(tx, 'group-owner', groupOwnerKey(proof.group.groupID)),
      }))
    } catch (error) {
      if (error instanceof GroupStateConflictError) owners.failStop(error)
      throw error
    }
    // Every touched owner must agree; a single matching marker cannot prove a combined entry.
    const committed =
      markers.device?.mutationID === mutationID &&
      (proof.group === null || markers.group?.mutationID === mutationID)
    const rolledBack =
      sameMarker(markers.device, proof.previousDevice) &&
      (proof.group === null || sameMarker(markers.group, proof.group.previous))
    const outcome = committed ? 'committed' : rolledBack ? 'rolled-back' : undefined
    if (outcome === undefined) {
      const error = new GroupStateConflictError('Device or group ownership conflict')
      owners.failStop(error)
      throw error
    }
    proof.settlement?.settle(outcome)
    proof.outcome = outcome
    return outcome
  }
  async function resolve(mutationID: string): Promise<'committed' | 'rolled-back'> {
    if (owners.current() !== undefined)
      return await owners.run('read', { ownerDID, groupID: null }, async () => 'committed' as const)
    if (owners.failure !== null) throw owners.failure
    const pending = owners.joinProof({ ownerDID }, mutationID)
    if (pending !== null) return await pending
    return await owners.run('read', { ownerDID, groupID: null }, async (entry) => {
      await entry.enter('prepare')
      await db.completionBarrier(scope(null))
      if (owners.failure !== null) throw owners.failure
      let current: GroupOwnerMarker | null
      try {
        current = await db.transact(scope(null), async (tx) => marker(tx, 'device-owner', ownerKey))
      } catch (error) {
        if (error instanceof GroupStateConflictError) owners.failStop(error)
        throw error
      }
      owners.markStarted(JSON.stringify(['device', ownerDID]))
      await entry.enter('outcome')
      if (current?.mutationID === mutationID) return 'committed' as const
      throw new GroupStateUncertainError('Device mutation is superseded or unclassifiable')
    })
  }
  const device: DevicePersistence<MemoryTransaction> = {
    providerID,
    ownerDID,
    groups,
    load: () => read(load),
    transition(change, work) {
      const owned = copyStoredValue(change)
      return owners.run(
        owned.group === null ? 'transition' : 'combined',
        { ownerDID, groupID: owned.group?.groupID ?? null },
        async (entry) => {
          if (owned.group !== null && owned.group.mutationID !== owned.mutationID)
            throw new GroupStateConflictError('Participant mutation ID mismatch')
          await prepare(entry)
          let proof: Proof | undefined
          let result!: Awaited<ReturnType<typeof work>>
          try {
            return await db.transact(
              scope(owned.group?.groupID ?? null),
              async (baseTx) => {
                const tx = boundTx(baseTx, entry)
                try {
                  const before = await entry.sequence(() => load(tx))
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
                          },
                  }
                  proofs.set(owned.mutationID, proof)
                  if (owned.group === null) {
                    result = await work(stores(tx, null))
                    await entry.enter('finalise')
                    await entry.enter('effects')
                    await entry.enter('account')
                  } else {
                    result = await coordinator.transitionInTransaction(
                      tx,
                      owned.group,
                      async (group) => await work(stores(tx, group)),
                    )
                  }
                  const nextDevice = proof.nextDevice
                  await sequenceMemoryCoordinator(entry, async () => {
                    tx.rows['device-owner']?.set(ownerKey, nextDevice)
                    await table<Omit<DeviceRecord, 'restoreWork'>>(tx, 'device').save(
                      'current',
                      nextDevice,
                    )
                  })
                  return result
                } finally {
                  if (owners.failure === null) await entry.enter('outcome')
                }
              },
              {
                onUnknown(settlement) {
                  if (proof !== undefined) {
                    proof.settlement = settlement
                    const retainedProof = proof
                    void entry.retain(() => prove(owned.mutationID, retainedProof))
                  }
                },
              },
            )
          } catch (error) {
            if (!(error instanceof StorageOutcomeUnknownError)) {
              if (proof !== undefined) proof.outcome = 'rolled-back'
              throw error
            }
            const pending = owners.joinProof({ ownerDID }, owned.mutationID)
            if (pending !== null && (await pending) === 'committed') return result
            throw error
          } finally {
            if (
              proof !== undefined &&
              proof.outcome === undefined &&
              proof.settlement === undefined
            )
              proof.outcome = 'committed'
            if (
              proof?.settlement === undefined &&
              owners.failure === null &&
              entry.phase === 'outcome'
            )
              entry.settle(proof?.outcome ?? 'rolled-back')
          }
        },
        { mutationID: owned.mutationID },
      )
    },
    resolve,
  }
  bindMemoryPackageReads(device, (work) => read((tx) => work(stores(tx, null))))
  return device
}
