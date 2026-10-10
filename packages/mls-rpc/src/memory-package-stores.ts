import type {
  KeyPackagePoolStore,
  KeyPackageRecord,
  LastResortRecord,
  LastResortStore,
} from '@kumiai/mls-hub'

import { sequenceMemoryOperation, sequenceMemoryTransaction } from './memory-group-state.js'
import { copyStoredValue } from './memory-incarnation-stores.js'
import { openRecord, physicalRecordKey, sealRecord } from './persistence-codec.js'
import { GroupStateConflictError } from './persistence-errors.js'
import type {
  AtRestCodec,
  DevicePersistence,
  DeviceStores,
  MemoryTransaction,
} from './persistence-types.js'

type DeviceRead = <TValue>(
  work: (stores: DeviceStores<MemoryTransaction>) => Promise<TValue>,
) => Promise<TValue>
const deviceReads = new WeakMap<DevicePersistence<MemoryTransaction>, DeviceRead>()

export function bindMemoryPackageReads(
  device: DevicePersistence<MemoryTransaction>,
  read: DeviceRead,
): void {
  deviceReads.set(device, read)
}

type DeviceTableParams = {
  tx: MemoryTransaction
  atRest: AtRestCodec
  providerID: string
  ownerDID: string
  namespace: string
}

export function memoryDeviceTable<TValue>(params: DeviceTableParams) {
  const { tx, atRest, providerID, ownerDID, namespace } = params
  if (tx.providerID !== providerID)
    throw new GroupStateConflictError('Device participant provider mismatch')
  const address = (recordID: string) => ({
    groupID: ownerDID,
    incarnation: null,
    namespace,
    recordID,
  })
  const map = () => {
    const rows = tx.rows[namespace]
    if (rows === undefined) throw new GroupStateConflictError('Missing device namespace')
    return rows
  }
  return {
    async withLock<TResult>(work: () => Promise<TResult>): Promise<TResult> {
      map()
      return await sequenceMemoryTransaction(tx, work)
    },
    async load(recordID: string): Promise<TValue | null> {
      const location = address(recordID)
      const key = physicalRecordKey(location)
      const bytes = map().get(key)
      if (bytes === undefined) return null
      if (!(bytes instanceof Uint8Array)) throw new GroupStateConflictError('Unreadable device row')
      const stored = await openRecord(atRest, location, bytes)
      map().has(key)
      if (
        stored === null ||
        typeof stored !== 'object' ||
        !('providerID' in stored) ||
        stored.providerID !== providerID ||
        !('ownerDID' in stored) ||
        stored.ownerDID !== ownerDID ||
        !('value' in stored) ||
        stored.value === null ||
        typeof stored.value !== 'object'
      )
        throw new GroupStateConflictError('Stored device owner or provider mismatch')
      return stored.value as TValue
    },
    async save(recordID: string, value: TValue): Promise<void> {
      const rows = map()
      const location = address(recordID)
      rows.set(
        physicalRecordKey(location),
        await sealRecord(atRest, location, { providerID, ownerDID, value }),
      )
    },
    remove(recordID: string): void {
      map().delete(physicalRecordKey(address(recordID)))
    },
    ids(): Array<string> {
      const ids: Array<string> = []
      for (const key of map().keys()) {
        const locator: unknown = JSON.parse(key)
        if (
          Array.isArray(locator) &&
          locator[0] === ownerDID &&
          locator[1] === null &&
          typeof locator[2] === 'string'
        )
          ids.push(locator[2])
      }
      return ids.sort()
    },
  }
}

type PackageRow<TRecord> = { sourceID: string; ref: string; record: TRecord | null }
type ReceiptRow = { sourceID: string; ref: string; groupID: string }

export function createTransactionPackageStores(params: {
  tx: MemoryTransaction
  atRest: AtRestCodec
  providerID: string
  ownerDID: string
  sourceID: string
}): { ordinary: KeyPackagePoolStore; lastResort: LastResortStore } {
  const { tx, sourceID, ownerDID } = params
  if (typeof sourceID !== 'string' || sourceID.length === 0)
    throw new TypeError('Expected package source ID')
  const receipts = memoryDeviceTable<ReceiptRow>({ ...params, namespace: 'device-receipt' })
  const id = (ref: string) => JSON.stringify([sourceID, ref])
  function store<TRecord extends KeyPackageRecord | LastResortRecord>(
    kind: TRecord['kind'],
    namespace: string,
  ) {
    const table = memoryDeviceTable<PackageRow<TRecord>>({ ...params, namespace })
    function assertRefOwner(ref: string): void {
      for (const namespace of ['device-package', 'device-receipt']) {
        for (const key of tx.rows[namespace]?.keys() ?? []) {
          const locator = JSON.parse(key) as [string, null, string]
          if (locator[2] === id(ref) && locator[0] !== ownerDID)
            throw new GroupStateConflictError('Source ref requires exactly one owner')
        }
      }
    }
    async function load(ref: string) {
      const row = await table.load(id(ref))
      if (row !== null && (row.sourceID !== sourceID || row.ref !== ref))
        throw new GroupStateConflictError('Stored package source or ref mismatch')
      if (row?.record !== null && row?.record !== undefined) {
        if (row.record.kind !== kind || row.record.ref !== ref)
          throw new GroupStateConflictError('Stored package kind or ref mismatch')
      }
      return row
    }
    async function receipt(ref: string): Promise<{ groupID: string } | null> {
      // Even reusable no-op methods must expire with their transaction.
      table.ids()
      if (kind === 'last-resort') return null
      const row = await receipts.load(id(ref))
      if (row === null) return null
      if (row.sourceID !== sourceID || row.ref !== ref || typeof row.groupID !== 'string')
        throw new GroupStateConflictError('Stored receipt source or ref mismatch')
      return { groupID: row.groupID }
    }
    const raw = {
      async list(owner: string): Promise<Array<TRecord>> {
        const ids = table.ids()
        if (owner !== ownerDID) return []
        const records: Array<TRecord> = []
        for (const recordID of ids) {
          const locator: unknown = JSON.parse(recordID)
          if (!Array.isArray(locator) || locator[0] !== sourceID) continue
          const row = await load(locator[1])
          if (row?.record !== null && row?.record !== undefined) records.push(row.record)
        }
        return records
      },
      async put(owner: string, record: TRecord): Promise<void> {
        table.ids()
        if (owner !== ownerDID) throw new GroupStateConflictError('Package owner mismatch')
        const owned = copyStoredValue(record)
        if (
          owned.kind !== kind ||
          typeof owned.ref !== 'string' ||
          typeof owned.privatePackage !== 'string' ||
          owned.privatePackage.length === 0
        )
          throw new GroupStateConflictError('Package kind or private ref mismatch')
        if (kind === 'ordinary' && (await receipt(owned.ref)) !== null)
          throw new GroupStateConflictError('Key package already consumed')
        if (kind === 'ordinary') assertRefOwner(owned.ref)
        await table.save(id(owned.ref), { sourceID, ref: owned.ref, record: owned })
      },
      async delete(owner: string, ref: string): Promise<void> {
        table.ids()
        if (owner !== ownerDID) return
        const row = await load(ref)
        if (row?.record === null || row === null) return
        if (kind === 'last-resort') table.remove(id(ref))
        else await table.save(id(ref), { sourceID, ref, record: null })
      },
      async consume(ref: string, groupID: string): Promise<void> {
        table.ids()
        if (kind === 'last-resort') return
        if (tx.groupID !== null && tx.groupID !== groupID)
          throw new GroupStateConflictError('Package participant group mismatch')
        assertRefOwner(ref)
        const consumed = await receipt(ref)
        if (consumed !== null) {
          if (tx.groupID !== null || consumed.groupID !== groupID)
            throw new GroupStateConflictError('Key package already consumed')
          return
        }
        const row = await load(ref)
        if (row === null) throw new GroupStateConflictError('Source does not hold this ref')
        if (tx.groupID !== null && (row.record === null || !row.record.privatePackage))
          throw new GroupStateConflictError('Installation requires retained private package')
        // A receipt permanently excludes every future private record at this address.
        table.remove(id(ref))
        await receipts.save(id(ref), { sourceID, ref, groupID })
      },
      receipt,
    }
    return {
      list: sequenceMemoryOperation(tx, raw.list),
      put: sequenceMemoryOperation(tx, raw.put),
      delete: sequenceMemoryOperation(tx, raw.delete),
      consume: sequenceMemoryOperation(tx, raw.consume),
      receipt: sequenceMemoryOperation(tx, raw.receipt),
    }
  }
  return {
    ordinary: store<KeyPackageRecord>('ordinary', 'device-package'),
    lastResort: store<LastResortRecord>('last-resort', 'device-last-resort'),
  }
}

export function createMemoryPackageStores(params: {
  device: DevicePersistence<MemoryTransaction>
  sourceID: string
}): { ordinary: KeyPackagePoolStore; lastResort: LastResortStore } {
  const { device, sourceID } = params
  if (typeof sourceID !== 'string' || sourceID.length === 0)
    throw new TypeError('Expected package source ID')
  const read = deviceReads.get(device)
  if (read === undefined) throw new TypeError('Package stores require a memory device participant')
  const readPackages = <TValue>(
    work: (stores: {
      ordinary: KeyPackagePoolStore
      lastResort: LastResortStore
    }) => Promise<TValue>,
  ) =>
    read((stores) =>
      work({ ordinary: stores.ordinary(sourceID), lastResort: stores.lastResort(sourceID) }),
    )
  async function run<TValue>(
    work: (stores: {
      ordinary: KeyPackagePoolStore
      lastResort: LastResortStore
    }) => Promise<TValue>,
  ): Promise<TValue> {
    for (;;) {
      const before = await device.load()
      let started = false
      try {
        return await device.transition(
          { mutationID: crypto.randomUUID(), expectedRevision: before.revision, group: null },
          async (stores) => {
            started = true
            return await work({
              ordinary: stores.ordinary(sourceID),
              lastResort: stores.lastResort(sourceID),
            })
          },
        )
      } catch (error) {
        // Retry only a lost device CAS, before any package work or hooks ran.
        if (
          !started &&
          error instanceof GroupStateConflictError &&
          error.message === 'Device revision conflict'
        )
          continue
        throw error
      }
    }
  }
  return {
    ordinary: {
      list: (owner) => readPackages((stores) => stores.ordinary.list(owner)),
      put: (owner, record) => run((stores) => stores.ordinary.put(owner, record)),
      delete: (owner, ref) => run((stores) => stores.ordinary.delete(owner, ref)),
      consume: (ref, groupID) => run((stores) => stores.ordinary.consume(ref, groupID)),
      receipt: (ref) => readPackages((stores) => stores.ordinary.receipt(ref)),
    },
    lastResort: {
      list: (owner) => readPackages((stores) => stores.lastResort.list(owner)),
      put: (owner, record) => run((stores) => stores.lastResort.put(owner, record)),
      delete: (owner, ref) => run((stores) => stores.lastResort.delete(owner, ref)),
      consume: (ref, groupID) => run((stores) => stores.lastResort.consume(ref, groupID)),
      receipt: (ref) => readPackages((stores) => stores.lastResort.receipt(ref)),
    },
  }
}
