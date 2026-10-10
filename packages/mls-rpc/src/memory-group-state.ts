import {
  decodeStoredValue,
  encodeStoredValue,
  openRecord,
  physicalRecordKey,
  type StoredAddress,
  sealRecord,
} from './persistence-codec.js'
import { GroupStateConflictError } from './persistence-errors.js'
import { assertStateTransition, assertTrustTransition } from './persistence-guards.js'
import type {
  AtRestCodec,
  GroupRecoveryTrust,
  GroupStateRecord,
  GroupStores,
  IncarnationStores,
  MemoryTransaction,
} from './persistence-types.js'

export type GroupStateStores = Pick<GroupStores<MemoryTransaction>, 'tx' | 'lifetime' | 'trust'> & {
  state(incarnation: number): IncarnationStores['state']
}

// Provider-bound transaction copies share the same rows view.
const transactionLocks = new WeakMap<MemoryTransaction['rows'], Promise<void>>()

export async function withMemoryTransactionLock<TValue>(
  tx: MemoryTransaction,
  work: () => Promise<TValue>,
): Promise<TValue> {
  // Refuse expired callers before waiting for unfinished host work.
  tx.rows.lifetime
  const previous = transactionLocks.get(tx.rows)
  const { promise, resolve } = Promise.withResolvers<void>()
  transactionLocks.set(tx.rows, promise)
  if (previous !== undefined) await previous
  try {
    tx.rows.lifetime
    return await work()
  } finally {
    if (transactionLocks.get(tx.rows) === promise) transactionLocks.delete(tx.rows)
    resolve()
  }
}

export function lockMemoryOperation<TArgs extends Array<unknown>, TValue>(
  tx: MemoryTransaction,
  operation: (...args: TArgs) => Promise<TValue>,
): (...args: TArgs) => Promise<TValue> {
  return async (...args) => {
    // Queued operations own their arguments before yielding to another caller.
    const owned = decodeStoredValue(encodeStoredValue(args)) as TArgs
    return await withMemoryTransactionLock(tx, () => operation(...owned))
  }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

function copyTrust(trust: GroupRecoveryTrust): GroupRecoveryTrust {
  const spent = trust.spentEpochAuthenticators
    .map((bytes) => Uint8Array.from(bytes))
    .sort(compareBytes)
  return {
    ...trust,
    spentEpochAuthenticators: spent.filter(
      (bytes, index) => index === 0 || compareBytes(bytes, spent[index - 1] as Uint8Array) !== 0,
    ),
  }
}

// Internal helpers must not reacquire the transaction lock.
export function createUnlockedGroupStateStores(params: {
  tx: MemoryTransaction
  groupID: string
  atRest: AtRestCodec
}): GroupStateStores {
  const { tx, groupID, atRest } = params
  if (tx.groupID !== groupID) throw new GroupStateConflictError('Transaction group mismatch')
  function slot<TValue extends { groupID: string }>(namespace: string, incarnation: number | null) {
    const address: StoredAddress = { groupID, incarnation, namespace, recordID: 'current' }
    const key = physicalRecordKey(address)
    return {
      async load(): Promise<TValue | null> {
        const bytes = tx.rows[namespace]?.get(key)
        if (bytes === undefined) return null
        if (!(bytes instanceof Uint8Array))
          throw new GroupStateConflictError('Unreadable sealed row')
        const value = (await openRecord(atRest, address, bytes)) as TValue
        // Touch the bound view again after host code yields.
        tx.rows[namespace]?.has(key)
        if (value === null || typeof value !== 'object' || value.groupID !== groupID) {
          throw new GroupStateConflictError('Stored row group mismatch')
        }
        return value
      },
      async save(value: TValue): Promise<void> {
        const rows = tx.rows[namespace]
        if (rows === undefined) throw new GroupStateConflictError('Missing transaction namespace')
        if (value.groupID !== groupID) throw new GroupStateConflictError('Row group mismatch')
        const bytes = await sealRecord(atRest, address, value)
        rows.set(key, bytes)
      },
    }
  }
  const trustRow = slot<GroupRecoveryTrust>('trust', null)
  async function loadTrust(): Promise<GroupRecoveryTrust | null> {
    const value = await trustRow.load()
    if (value === null) return null
    assertTrustTransition(null, value)
    return copyTrust(value)
  }
  const trust: GroupStateStores['trust'] = {
    load: loadTrust,
    async save(value) {
      const previous = await loadTrust()
      assertTrustTransition(previous, value)
      await trustRow.save(copyTrust(value))
    },
  }
  return {
    tx,
    lifetime: slot('lifetime', null),
    trust,
    state(incarnation) {
      if (!Number.isSafeInteger(incarnation) || incarnation < 1) {
        throw new GroupStateConflictError('Invalid incarnation')
      }
      const row = slot<GroupStateRecord>('state', incarnation)
      return {
        async load() {
          const value = await row.load()
          if (value !== null && value.incarnation !== incarnation) {
            throw new GroupStateConflictError('Stored incarnation mismatch')
          }
          return value
        },
        async save(value) {
          if (value.incarnation !== incarnation)
            throw new GroupStateConflictError('Row incarnation mismatch')
          const previous = await row.load()
          const retained = await loadTrust()
          assertStateTransition(previous, value, retained)
          await row.save(value)
        },
      }
    },
  }
}

export function createGroupStateStores(
  params: Parameters<typeof createUnlockedGroupStateStores>[0],
): GroupStateStores {
  const stores = createUnlockedGroupStateStores(params)
  const { tx } = params
  return {
    tx,
    lifetime: {
      load: lockMemoryOperation(tx, stores.lifetime.load),
      save: lockMemoryOperation(tx, stores.lifetime.save),
    },
    trust: {
      load: lockMemoryOperation(tx, stores.trust.load),
      save: lockMemoryOperation(tx, stores.trust.save),
    },
    state(incarnation) {
      const state = stores.state(incarnation)
      return {
        load: lockMemoryOperation(tx, state.load),
        save: lockMemoryOperation(tx, state.save),
      }
    },
  }
}
