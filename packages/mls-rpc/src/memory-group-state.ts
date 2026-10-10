import type { OwnerAttempt, OwnerEntry, OwnerQueues, WriteTarget } from './owner-queue.js'
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

// Guarded maps preserve bindings across copied transaction containers.
const transactionIdentities = new WeakMap<object, MemoryTransaction['rows']>()
type TransactionBinding = {
  entry: OwnerEntry
  owners: OwnerQueues
  attempt: OwnerAttempt
  changes: number
  writer: CoordinatorWriter
}
const transactionEntries = new WeakMap<MemoryTransaction['rows'], TransactionBinding>()
const coordinatorRows = new WeakSet<object>()
const rowFactories = new WeakMap<object, (assertLive: () => void) => MemoryTransaction['rows']>()
const bootstrapTrusts = new WeakMap<MemoryTransaction['rows'], Set<string>>()

export function registerMemoryTransactionRows(
  rows: MemoryTransaction['rows'],
  maps: MemoryTransaction['rows'],
  coordinator: (assertLive: () => void) => MemoryTransaction['rows'],
): void {
  transactionIdentities.set(rows, rows)
  for (const map of Object.values(maps)) transactionIdentities.set(map, rows)
  rowFactories.set(rows, coordinator)
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

type CoordinatorWriterParams = { tx: MemoryTransaction; entry: OwnerEntry; attempt: OwnerAttempt }

class CoordinatorWriter {
  #entry: OwnerEntry
  #attempt: OwnerAttempt
  #token: ReturnType<OwnerEntry['coordinator']>
  #tx: MemoryTransaction
  #active = false

  constructor(params: CoordinatorWriterParams) {
    const { tx, entry, attempt } = params
    this.#entry = entry
    this.#attempt = attempt
    this.#token = entry.coordinator(attempt)
    const factory = rowFactories.get(transactionIdentity(tx.rows))
    if (factory === undefined) throw new GroupStateConflictError('Missing private transaction view')
    const rows = factory(() => {
      attempt.assertLive()
      if (!this.#active || !['finalise', 'account'].includes(entry.phase))
        throw new PersistencePhaseError('Coordinator writer expired')
    })
    transactionIdentities.set(rows, transactionIdentity(tx.rows))
    coordinatorRows.add(rows)
    this.#tx = { ...tx, rows }
  }

  run<TValue>(work: (tx: MemoryTransaction) => Promise<TValue>): Promise<TValue> {
    return this.#entry.coordinate(this.#token, async () => {
      this.#attempt.assertLive()
      this.#active = true
      try {
        return await work(this.#tx)
      } finally {
        this.#active = false
      }
    })
  }
}

export function bindMemoryOwner(
  tx: MemoryTransaction,
  entry: OwnerEntry,
  owners: OwnerQueues,
): void {
  const identity = transactionIdentity(tx.rows)
  const previous = transactionEntries.get(identity)
  if (previous !== undefined) {
    if (previous.entry !== entry || previous.attempt !== entry.attempt())
      throw new GroupStateConflictError('Transaction ownership mismatch')
    return
  }
  const attempt = entry.attempt()
  transactionEntries.set(identity, {
    entry,
    owners,
    attempt,
    changes: 0,
    writer: new CoordinatorWriter({ tx, entry, attempt }),
  })
}

export function memoryTransactionEntry(rows: MemoryTransaction['rows']): OwnerEntry | undefined {
  return transactionBinding(rows)?.entry
}

export function memoryTransactionFailureSignal(
  rows: MemoryTransaction['rows'],
): AbortSignal | undefined {
  return transactionBinding(rows)?.attempt.signal
}

export function bindMemorySnapshot(
  source: MemoryTransaction['rows'],
  snapshot: MemoryTransaction['rows'],
): void {
  transactionIdentities.set(snapshot, transactionIdentity(source))
}

export function memoryTransactionChanged(rows: MemoryTransaction['rows']): void {
  const binding = transactionBinding(rows)
  if (binding !== undefined) binding.changes++
}

export function assertMemoryAccess(rows: MemoryTransaction['rows']): void {
  const binding = transactionBinding(rows)
  if (binding === undefined) return
  if (binding.owners.failure !== null) throw binding.owners.failure
  binding.attempt.assertLive()
  const phases = coordinatorRows.has(rows) ? ['finalise', 'account'] : ['work', 'effects']
  if (!phases.includes(binding.entry.phase))
    throw new PersistencePhaseError('Transaction capability expired')
}

export function assertMemoryWrite(tx: MemoryTransaction, target: WriteTarget): void {
  assertMemoryAccess(tx.rows)
  const entry = memoryTransactionEntry(tx.rows)
  if (entry !== undefined) entry.assertWrite(coordinatorRows.has(tx.rows) ? 'coordinator' : target)
}

export function memoryCallback<TValue>(tx: MemoryTransaction, work: () => TValue): TValue {
  const entry = memoryTransactionEntry(tx.rows)
  return entry === undefined ? work() : entry.callback(work)
}

export async function memoryRequired<TValue>(
  tx: MemoryTransaction,
  work: () => Promise<TValue>,
  required = true,
): Promise<TValue> {
  try {
    return await work()
  } catch (error) {
    if (required) transactionBinding(tx.rows)?.entry.fail(error)
    throw error
  }
}

export function memorySeal(
  tx: MemoryTransaction,
  atRest: AtRestCodec,
  address: StoredAddress,
  value: unknown,
): Promise<Uint8Array> {
  return memoryRequired(tx, () => memoryCallback(tx, () => sealRecord(atRest, address, value)))
}

export function memoryOpen(
  tx: MemoryTransaction,
  atRest: AtRestCodec,
  address: StoredAddress,
  bytes: Uint8Array,
): Promise<unknown> {
  return memoryCallback(tx, () => openRecord(atRest, address, bytes))
}

export function memoryOperation<TArgs extends Array<unknown>, TValue>(
  tx: MemoryTransaction,
  operation: (...args: TArgs) => Promise<TValue>,
  target?: WriteTarget,
): (...args: TArgs) => Promise<TValue> {
  const binding = transactionBinding(tx.rows)
  return (...args) => {
    try {
      const owned = decodeStoredValue(encodeStoredValue(args)) as TArgs
      const run = async () => {
        const changes = binding?.changes
        try {
          if (target !== undefined) assertMemoryWrite(tx, target)
          return await operation(...owned)
        } catch (error) {
          if (binding !== undefined && binding.changes !== changes) binding.entry.fail(error)
          throw error
        }
      }
      if (binding !== undefined) return binding.entry.operation(binding.attempt, run)
      assertMemoryAccess(tx.rows)
      return run()
    } catch (error) {
      return Promise.reject(error)
    }
  }
}

export function coordinateMemoryTransaction<TValue>(
  tx: MemoryTransaction,
  work: (writerTx: MemoryTransaction) => Promise<TValue>,
): Promise<TValue> {
  const binding = transactionBinding(tx.rows)
  if (binding === undefined) throw new GroupStateConflictError('Missing transaction ownership')
  return binding.writer.run((writerTx) => work({ ...tx, rows: writerTx.rows }))
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

// Internal helpers share one operation reservation.
export function createUnlockedGroupStateStores(params: {
  tx: MemoryTransaction
  groupID: string
  atRest: AtRestCodec
  requiredOpen?: boolean
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
      return await memorySeal(tx, atRest, address, value)
    }
    function store(bytes: Uint8Array): void {
      const rows = tx.rows[namespace]
      if (rows === undefined) throw new GroupStateConflictError('Missing transaction namespace')
      rows.set(key, bytes)
    }
    return {
      load(): Promise<TValue | null> {
        return memoryRequired(
          tx,
          async () => {
            const bytes = tx.rows[namespace]?.get(key)
            if (bytes === undefined) return null
            if (!(bytes instanceof Uint8Array))
              throw new GroupStateConflictError('Unreadable sealed row')
            const value = (await memoryOpen(tx, atRest, address, bytes)) as TValue
            // Touch the bound view again after host code yields.
            tx.rows[namespace]?.has(key)
            if (value === null || typeof value !== 'object' || value.groupID !== groupID) {
              throw new GroupStateConflictError('Stored row group mismatch')
            }
            return value
          },
          params.requiredOpen,
        )
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
        load: memoryOperation(tx, metadata.load),
        save: memoryOperation(tx, metadata.save, 'domain'),
      }
    },
    lifetime: {
      load: memoryOperation(tx, stores.lifetime.load),
      save: memoryOperation(tx, stores.lifetime.save, 'domain'),
    },
    trust: {
      load: memoryOperation(tx, stores.trust.load),
      save: memoryOperation(tx, stores.trust.save, 'domain'),
    },
    state(incarnation) {
      const state = stores.state(incarnation)
      return {
        load: memoryOperation(tx, state.load),
        save: memoryOperation(tx, state.save, 'domain'),
      }
    },
  }
}
