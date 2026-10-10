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
  GroupKey,
  GroupRecoveryTrust,
  GroupStateRecord,
  GroupStores,
  IncarnationStores,
  MemoryTransaction,
} from './persistence-types.js'

type StateMetadata = GroupKey & { version: number; deleted: boolean }

export type GroupStateStores = Pick<GroupStores<MemoryTransaction>, 'tx' | 'lifetime' | 'trust'> & {
  state(incarnation: number): IncarnationStores['state']
  stateMetadata(incarnation: number): {
    load(): Promise<StateMetadata | null>
    save(value: StateMetadata): Promise<void>
  }
}

// Provider-bound transaction copies share the same rows view.
const finalisingTransactions = new WeakSet<MemoryTransaction['rows']>()

export function beginMemoryGroupFinalisation(tx: MemoryTransaction): void {
  finalisingTransactions.add(tx.rows)
}

export function assertMemoryGroupMutable(tx: MemoryTransaction): void {
  if (finalisingTransactions.has(tx.rows))
    throw new GroupStateConflictError('Group domain writes expired at finalisation')
}

const bootstrapTrusts = new WeakMap<MemoryTransaction['rows'], Set<string>>()
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
  coordinatorWrites?: boolean
}): GroupStateStores {
  const { tx, groupID, atRest } = params
  if (tx.groupID !== groupID) throw new GroupStateConflictError('Transaction group mismatch')
  function slot<TValue extends { groupID: string }>(
    namespace: string,
    incarnation: number | null,
    recordID = 'current',
  ) {
    const address: StoredAddress = { groupID, incarnation, namespace, recordID }
    const key = physicalRecordKey(address)
    async function prepare(value: TValue): Promise<Uint8Array> {
      if (!params.coordinatorWrites) assertMemoryGroupMutable(tx)
      if (tx.rows[namespace] === undefined)
        throw new GroupStateConflictError('Missing transaction namespace')
      if (value.groupID !== groupID) throw new GroupStateConflictError('Row group mismatch')
      return await sealRecord(atRest, address, value)
    }
    function store(bytes: Uint8Array): void {
      const rows = tx.rows[namespace]
      if (rows === undefined) throw new GroupStateConflictError('Missing transaction namespace')
      rows.set(key, bytes)
    }
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
      prepare,
      store,
      async save(value: TValue): Promise<void> {
        store(await prepare(value))
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
      if (!params.coordinatorWrites) assertMemoryGroupMutable(tx)
      const previous = await loadTrust()
      assertTrustTransition(previous, value)
      await trustRow.save(copyTrust(value))
      if (previous === null) {
        const groups = bootstrapTrusts.get(tx.rows) ?? new Set<string>()
        groups.add(groupID)
        bootstrapTrusts.set(tx.rows, groups)
      }
    },
  }
  function stateMetadata(incarnation: number) {
    const row = slot<StateMetadata>('meta', incarnation, JSON.stringify(['state-version']))
    return {
      async load() {
        const value = await row.load()
        if (
          value !== null &&
          (value.incarnation !== incarnation ||
            !Number.isSafeInteger(value.version) ||
            value.version < 1 ||
            typeof value.deleted !== 'boolean')
        )
          throw new GroupStateConflictError('Unreadable state version metadata')
        return value
      },
      save: row.save,
      prepare: row.prepare,
      store: row.store,
    }
  }
  return {
    tx,
    stateMetadata,
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
          if (!params.coordinatorWrites) assertMemoryGroupMutable(tx)
          if (value.incarnation !== incarnation)
            throw new GroupStateConflictError('Row incarnation mismatch')
          const metadata = stateMetadata(incarnation)
          if (value.deleted) {
            // Retirement needs administrative version/identity, never private ratchets.
            const previous = await metadata.load()
            if (
              previous === null &&
              tx.rows.state?.has(
                physicalRecordKey({
                  groupID,
                  incarnation,
                  namespace: 'state',
                  recordID: 'current',
                }),
              )
            )
              throw new GroupStateConflictError('Missing state version metadata')
            if (
              !Number.isSafeInteger(value.version) ||
              value.version !== (previous?.version ?? 0) + 1
            )
              throw new GroupStateConflictError('State version conflict')
          } else {
            const previous = await row.load()
            const retained = await loadTrust()
            assertStateTransition(
              previous,
              value,
              retained,
              bootstrapTrusts.get(tx.rows)?.has(groupID),
            )
          }
          const stateBytes = await row.prepare(value)
          const metadataBytes = await metadata.prepare({
            groupID,
            incarnation,
            version: value.version,
            deleted: value.deleted,
          })
          row.store(stateBytes)
          metadata.store(metadataBytes)
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
    stateMetadata(incarnation) {
      const metadata = stores.stateMetadata(incarnation)
      return {
        load: lockMemoryOperation(tx, metadata.load),
        save: lockMemoryOperation(tx, metadata.save),
      }
    },
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
