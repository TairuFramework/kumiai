/// <reference types="node" />

import { AsyncLocalStorage } from 'node:async_hooks'

import {
  type OwnerEntry,
  type OwnerQueues,
  ownerEntryFailureSignal,
  type WriteTarget,
} from './owner-queue.js'
import {
  decodeStoredValue,
  encodeStoredValue,
  openRecord,
  physicalRecordKey,
  type StoredAddress,
  sealRecord,
} from './persistence-codec.js'
import { GroupStateConflictError, PersistencePhaseError } from './persistence-errors.js'
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

// Guarded maps retain their provider identity when callers copy the rows container.
const transactionIdentities = new WeakMap<object, MemoryTransaction['rows']>()
const transactionEntries = new WeakMap<
  MemoryTransaction['rows'],
  { entry: OwnerEntry; owners: OwnerQueues }
>()
const coordinatorContext = new AsyncLocalStorage<OwnerEntry>()
const bootstrapTrusts = new WeakMap<MemoryTransaction['rows'], Set<string>>()

export function withoutMemoryCoordinator<TValue>(callback: () => TValue): TValue {
  return coordinatorContext.exit(callback)
}

export function registerMemoryTransactionRows(
  rows: MemoryTransaction['rows'],
  maps: MemoryTransaction['rows'],
): void {
  transactionIdentities.set(rows, rows)
  for (const map of Object.values(maps)) transactionIdentities.set(map, rows)
}

function transactionIdentity(rows: MemoryTransaction['rows']): MemoryTransaction['rows'] {
  const identity = transactionIdentities.get(rows)
  if (identity !== undefined) return identity
  for (const map of Object.values(rows)) {
    const identity = transactionIdentities.get(map)
    if (identity !== undefined) return identity
  }
  return rows
}

function transactionBinding(rows: MemoryTransaction['rows']) {
  return transactionEntries.get(transactionIdentity(rows))
}

export function bindMemoryOwner(
  tx: MemoryTransaction,
  entry: OwnerEntry,
  owners: OwnerQueues,
): void {
  transactionEntries.set(transactionIdentity(tx.rows), { entry, owners })
}

export function memoryTransactionEntry(rows: MemoryTransaction['rows']): OwnerEntry | undefined {
  return transactionBinding(rows)?.entry
}

export function memoryTransactionFailureSignal(
  rows: MemoryTransaction['rows'],
): AbortSignal | undefined {
  const entry = memoryTransactionEntry(rows)
  return entry === undefined ? undefined : ownerEntryFailureSignal(entry)
}

export function assertMemoryAccess(rows: MemoryTransaction['rows']): void {
  const binding = transactionBinding(rows)
  if (binding === undefined) return
  if (binding.owners.failure !== null) throw binding.owners.failure
  if (!['work', 'finalise', 'effects', 'account'].includes(binding.entry.phase))
    throw new PersistencePhaseError('Transaction capability expired')
}

export function assertMemoryWrite(tx: MemoryTransaction, target: WriteTarget): void {
  const entry = memoryTransactionEntry(tx.rows)
  if (entry !== undefined)
    entry.assertWrite(coordinatorContext.getStore() === entry ? 'coordinator' : target)
}

async function sequenceMemoryTransaction<TValue>(
  tx: MemoryTransaction,
  work: () => Promise<TValue>,
): Promise<TValue> {
  const entry = memoryTransactionEntry(tx.rows)
  if (entry !== undefined) {
    assertMemoryAccess(tx.rows)
    return await entry.sequence(work)
  }
  // Unbound provider primitives have no application ownership to sequence.
  tx.rows.lifetime
  return await work()
}

export function sequenceMemoryOperation<TArgs extends Array<unknown>, TValue>(
  tx: MemoryTransaction,
  operation: (...args: TArgs) => Promise<TValue>,
  target?: WriteTarget,
): (...args: TArgs) => Promise<TValue> {
  return async (...args) => {
    // Queued operations own their arguments before yielding to another caller.
    const owned = decodeStoredValue(encodeStoredValue(args)) as TArgs
    return await sequenceMemoryTransaction(tx, () => {
      if (target !== undefined) assertMemoryWrite(tx, target)
      return operation(...owned)
    })
  }
}

export function sequenceMemoryCoordinator<TValue>(
  entry: OwnerEntry,
  work: () => Promise<TValue>,
): Promise<TValue> {
  return entry.sequence(() => {
    entry.assertWrite('coordinator')
    return coordinatorContext.run(entry, work)
  })
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

// Internal helpers run inside the entry sequencer.
export function createUnlockedGroupStateStores(params: {
  tx: MemoryTransaction
  groupID: string
  atRest: AtRestCodec
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
      assertMemoryWrite(tx, 'domain')
      if (tx.rows[namespace] === undefined)
        throw new GroupStateConflictError('Missing transaction namespace')
      if (value.groupID !== groupID) throw new GroupStateConflictError('Row group mismatch')
      return await withoutMemoryCoordinator(() => sealRecord(atRest, address, value))
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
        const value = (await withoutMemoryCoordinator(() =>
          openRecord(atRest, address, bytes),
        )) as TValue
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
      assertMemoryWrite(tx, 'domain')
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
          assertMemoryWrite(tx, 'domain')
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
        load: sequenceMemoryOperation(tx, metadata.load),
        save: sequenceMemoryOperation(tx, metadata.save, 'domain'),
      }
    },
    lifetime: {
      load: sequenceMemoryOperation(tx, stores.lifetime.load),
      save: sequenceMemoryOperation(tx, stores.lifetime.save, 'domain'),
    },
    trust: {
      load: sequenceMemoryOperation(tx, stores.trust.load),
      save: sequenceMemoryOperation(tx, stores.trust.save, 'domain'),
    },
    state(incarnation) {
      const state = stores.state(incarnation)
      return {
        load: sequenceMemoryOperation(tx, state.load),
        save: sequenceMemoryOperation(tx, state.save, 'domain'),
      }
    },
  }
}
