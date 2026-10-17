import { decodeEpochRosterFact } from '@kumiai/mls'
import type {
  CheckpointCoverage,
  CheckpointFactRecord,
  CheckpointRecord,
  CheckpointStore,
} from '@kumiai/rpc'
import { retainForkEvidence } from '@kumiai/rpc'

import {
  branchHistoryPreparation,
  projectBranchHistory,
  retainBranchAbandonments,
  retainBranchHistory,
  startBranchCoverage,
} from './branch-history.js'
import { checkpointPreparation } from './checkpoint-capture.js'
import { appHoldPreparation } from './clear-hold.js'
import {
  memoryOpen,
  memoryOperation,
  memoryReadAdmitted,
  memoryRequired,
  memoryTransactionEntry,
} from './memory-group-state.js'
import {
  copyStoredValue,
  memoryRecordTable,
  sameBytes,
  sameStoredValue,
} from './memory-incarnation-stores.js'
import { cloneValue } from './memory-rows.js'
import { physicalRecordKey } from './persistence-codec.js'
import { GroupStateConflictError } from './persistence-errors.js'
import type { AtRestCodec, MemoryTransaction } from './persistence-types.js'
import { supersededRejoinPrepared } from './registry/recovery-coordinator.js'
import { conditionPreparation } from './safety-conditions.js'

const journalCaptures = new WeakMap<object, Map<string, CheckpointRecord>>()
const appHolds = new WeakMap<object, Map<string, CheckpointRecord>>()
const histories = new WeakMap<object, Array<CheckpointRecord>>()
const conditionCaptures = new WeakMap<object, Map<string, CheckpointRecord>>()
const captures = new WeakMap<object, Map<string, Uint8Array>>()
// Finalisation re-lists checkpoints several times per transition; open unchanged bytes once.
// Keyed by OwnerEntry: lives for the whole owner run (prepare, work, effects, finalise, all
// attempts), not one transaction. Cleared on release or rollback.
const openedRows = new WeakMap<
  object,
  Map<string, { bytes: Uint8Array; record: CheckpointRecord }>
>()

export function assertCheckpointUpdates(
  before: Array<CheckpointRecord>,
  after: Array<CheckpointRecord>,
  tx?: MemoryTransaction,
): void {
  const entry = tx === undefined ? undefined : memoryTransactionEntry(tx.rows)
  const authorised = entry === undefined ? undefined : conditionCaptures.get(entry)
  for (const row of [...before, ...after]) {
    if (
      ['own-branch-messages', 'others-seen', 'branch-coverage', 'branch-abandonment'].includes(
        row.kind,
      )
    ) {
      const next = after.find((value) => value.id === row.id)
      const previous = before.find((value) => value.id === row.id)
      if (
        !sameStoredValue(previous, next) &&
        (entry === undefined ||
          next === undefined ||
          !sameStoredValue(journalCaptures.get(entry)?.get(row.id), next))
      )
        throw new GroupStateConflictError('Branch journal requires dedicated writer authority')
    }
    if (row.kind === 'app-hold' || row.kind === 'hold-history') {
      const next = after.find((value) => value.id === row.id)
      const previous = before.find((value) => value.id === row.id)
      if (
        !sameStoredValue(previous, next) &&
        (entry === undefined ||
          !appHolds.get(entry)?.has(row.id) ||
          !sameStoredValue(appHolds.get(entry)?.get(row.id), next))
      )
        throw new GroupStateConflictError('App hold records require coordinator authority')
    }
    if (row.kind === 'superseded-rejoin') {
      const next = after.find((value) => value.id === row.id)
      const previous = before.find((value) => value.id === row.id)
      if (
        !sameStoredValue(previous, next) &&
        !(
          entry !== undefined &&
          histories.get(entry)?.some((prepared) => sameStoredValue(prepared, next)) === true
        )
      )
        throw new GroupStateConflictError('Rejoin history requires coordinator authority')
    }
    if (row.kind !== 'condition') continue
    const next = after.find((value) => value.id === row.id)
    const previous = before.find((value) => value.id === row.id)
    if (
      !sameStoredValue(previous, next) &&
      (authorised?.has(row.id) !== true || !sameStoredValue(authorised.get(row.id), next))
    )
      throw new GroupStateConflictError('Group condition requires coordinator authority')
  }
  const coverage = before.find((row) => row.kind === 'coverage' && row.id === 'coverage')
  const ids = new Set(
    coverage?.kind === 'coverage' ? coverage.installations.map((row) => row.id) : [],
  )
  for (const record of after) {
    if (
      record.kind === 'coverage' &&
      !sameStoredValue(
        before.find((row) => row.id === record.id),
        record,
      )
    )
      throw new GroupStateConflictError('Checkpoint coverage requires coordinator authority')
  }
  for (const record of before) {
    const next = after.find((row) => row.id === record.id)
    if (
      (record.kind === 'coverage' || (record.kind === 'fact' && ids.has(record.id))) &&
      !sameStoredValue(record, next)
    )
      throw new GroupStateConflictError(
        'Checkpoint fact and provenance require coordinator authority',
      )
    if (
      record.kind === 'publication' &&
      ids.has(record.factID) &&
      (next?.kind !== 'publication' ||
        next.factID !== record.factID ||
        !sameStoredValue(next.key, record.key))
    )
      throw new GroupStateConflictError('Checkpoint debt requires coordinator authority')
  }
  // Finalisation may prune rows before effects run.
  if (entry !== undefined) journalCaptures.delete(entry)
}

export function checkpointCaptureFor(tx: MemoryTransaction, id: string): Uint8Array | undefined {
  const entry = memoryTransactionEntry(tx.rows)
  return entry === undefined ? undefined : captures.get(entry)?.get(id)
}

function validate(record: CheckpointRecord, groupID: string, id: string): void {
  if (
    record?.key?.groupID !== groupID ||
    record.id !== id ||
    !Number.isSafeInteger(record.key.incarnation) ||
    record.key.incarnation < 1 ||
    ![
      'branch-abandonment',
      'own-branch-messages',
      'others-seen',
      'branch-coverage',
      'app-hold',
      'hold-history',
      'fact',
      'superseded-rejoin',
      'condition',
      'publication',
      'cursor',
      'coverage',
      'notice',
      'evidence',
      'notice-event',
      'notice-tombstone',
    ].includes(record.kind)
  ) {
    throw new GroupStateConflictError('Checkpoint record binding mismatch')
  }
}

export async function openCheckpointRow(
  params: { tx: MemoryTransaction; groupID: string; atRest: AtRestCodec },
  id: string,
  bytes: unknown,
): Promise<CheckpointRecord> {
  const { tx, groupID, atRest } = params
  let address: unknown
  try {
    address = JSON.parse(id)
  } catch (cause) {
    throw new GroupStateConflictError('Checkpoint address mismatch', { cause })
  }
  if (
    !Array.isArray(address) ||
    address.length !== 3 ||
    address[0] !== groupID ||
    address[1] !== null ||
    typeof address[2] !== 'string'
  )
    throw new GroupStateConflictError('Checkpoint address mismatch')
  const location = { groupID, incarnation: null, namespace: 'checkpoints', recordID: address[2] }
  if (id !== physicalRecordKey(location))
    throw new GroupStateConflictError('Checkpoint address mismatch')
  if (!(bytes instanceof Uint8Array))
    throw new GroupStateConflictError('Unreadable sealed checkpoint row')
  const entry = memoryTransactionEntry(tx.rows)
  let opened = entry === undefined ? undefined : openedRows.get(entry)
  const cached = opened?.get(id)
  if (cached !== undefined && sameBytes(cached.bytes, bytes)) return cloneValue(cached.record)
  const record = (await memoryOpen(tx, atRest, location, bytes)) as CheckpointRecord
  validate(record, groupID, location.recordID)
  if (entry !== undefined) {
    if (opened === undefined) {
      opened = new Map()
      openedRows.set(entry, opened)
      const owned = entry
      entry.afterRelease(() => openedRows.delete(owned))
      entry.onRollback(() => openedRows.delete(owned))
    }
    opened.set(id, { bytes: Uint8Array.from(bytes), record: cloneValue(record) })
  }
  return record
}

export function createUnlockedCheckpointStore(params: {
  tx: MemoryTransaction
  groupID: string
  atRest: AtRestCodec
}): CheckpointStore {
  const { tx, groupID, atRest } = params
  const table = memoryRecordTable<CheckpointRecord>({
    tx,
    key: { groupID, incarnation: null },
    namespace: 'checkpoints',
    atRest,
  })
  function rows() {
    const rows = tx.rows.checkpoints
    if (rows === undefined) throw new GroupStateConflictError('Missing checkpoint namespace')
    return rows
  }
  return {
    load: (id) =>
      memoryRequired(tx, async () => {
        const checkpointRows = rows()
        memoryReadAdmitted(tx)
        const physicalID = physicalRecordKey({
          groupID,
          incarnation: null,
          namespace: 'checkpoints',
          recordID: id,
        })
        const bytes = checkpointRows.get(physicalID)
        if (bytes === undefined) return null
        const record = await openCheckpointRow(params, physicalID, bytes)
        rows().has(physicalID)
        return record
      }),
    list: () =>
      memoryRequired(tx, async () => {
        const checkpointRows = rows()
        memoryReadAdmitted(tx)
        const records: Array<CheckpointRecord> = []
        for (const [id, bytes] of checkpointRows) {
          records.push(await openCheckpointRow(params, id, bytes))
        }
        rows()
        return records
      }),
    async put(record) {
      validate(record, groupID, record.id)
      const journal = branchHistoryPreparation(record)
      const entry = memoryTransactionEntry(tx.rows)
      if (journal !== undefined && entry !== undefined) {
        const prepared = journalCaptures.get(entry) ?? new Map<string, CheckpointRecord>()
        prepared.set(record.id, journal)
        journalCaptures.set(entry, prepared)
      }
      await table.save(record.id, record)
    },
    async remove(ids) {
      for (const id of ids) table.remove(id)
    },
  }
}

export function createCheckpointStore(
  params: Parameters<typeof createUnlockedCheckpointStore>[0],
): CheckpointStore {
  const store = createUnlockedCheckpointStore(params)
  const { tx } = params
  const put = memoryOperation(tx, store.put, 'side')
  return {
    load: memoryOperation(tx, store.load),
    list: memoryOperation(tx, store.list),
    put(record) {
      const history =
        record.kind === 'superseded-rejoin' && supersededRejoinPrepared(record) ? record : undefined
      const condition = record.kind === 'condition' ? conditionPreparation(record) : undefined
      const canonical = record.kind === 'fact' ? checkpointPreparation(record) : undefined
      const journal = branchHistoryPreparation(record)
      const appHold =
        record.kind === 'app-hold' || record.kind === 'hold-history'
          ? appHoldPreparation(record)
          : undefined
      const result = put(record)
      const entry = memoryTransactionEntry(tx.rows)
      if (journal !== undefined && entry !== undefined) {
        const prepared = journalCaptures.get(entry) ?? new Map<string, CheckpointRecord>()
        prepared.set(record.id, journal)
        journalCaptures.set(entry, prepared)
      }
      if (appHold !== undefined && entry !== undefined) {
        const prepared = appHolds.get(entry) ?? new Map<string, CheckpointRecord>()
        prepared.set(record.id, appHold)
        appHolds.set(entry, prepared)
      }
      if (history !== undefined && entry !== undefined)
        histories.set(entry, [...(histories.get(entry) ?? []), copyStoredValue(history)])
      if (condition !== undefined && entry !== undefined) {
        const prepared = conditionCaptures.get(entry) ?? new Map<string, CheckpointRecord>()
        prepared.set(record.id, condition)
        conditionCaptures.set(entry, prepared)
      }
      if (canonical !== undefined && entry !== undefined) {
        const prepared = captures.get(entry) ?? new Map<string, Uint8Array>()
        prepared.set(record.id, canonical)
        captures.set(entry, prepared)
      }
      return result
    },
    remove: memoryOperation(tx, store.remove, 'side'),
  }
}

function ranges(facts: Array<CheckpointFactRecord>): CheckpointCoverage['retained'] {
  const result: CheckpointCoverage['retained'] = []
  for (const fact of [...facts].sort(
    (a, b) => a.key.incarnation - b.key.incarnation || a.epoch - b.epoch,
  )) {
    const last = result.at(-1)
    if (last?.key.incarnation === fact.key.incarnation && last.through + 1 === fact.epoch)
      last.through = fact.epoch
    else result.push({ key: { ...fact.key }, from: fact.epoch, through: fact.epoch })
  }
  return result
}

export function provenCheckpointFacts(
  records: Array<CheckpointRecord>,
  groupID: string,
): Array<CheckpointFactRecord> {
  const coverage = readCheckpointCoverage(groupID, records)
  const metadata = records.find((row) => row.kind === 'coverage' && row.id === 'coverage')
  const ids = new Set(
    metadata?.kind === 'coverage' ? metadata.installations.map((row) => row.id) : [],
  )
  return records.filter(
    (row): row is CheckpointFactRecord =>
      row.kind === 'fact' &&
      row.key.groupID === groupID &&
      ids.has(row.id) &&
      coverage.retained.some(
        (range) =>
          range.key.incarnation === row.key.incarnation &&
          range.from <= row.epoch &&
          range.through >= row.epoch,
      ),
  )
}

export function readCheckpointCoverage(
  groupID: string,
  records: Array<CheckpointRecord>,
): CheckpointCoverage {
  const coverage = records.find(
    (row) => row.kind === 'coverage' && row.key.groupID === groupID && row.id === 'coverage',
  )
  if (coverage?.kind !== 'coverage')
    return { groupID, current: null, retained: [], effectiveFloor: null, gaps: [] }
  const ids = new Set(coverage.installations.map((row) => row.id))
  const facts = records.filter(
    (row): row is CheckpointFactRecord =>
      row.kind === 'fact' && row.key.groupID === groupID && ids.has(row.id),
  )
  const now = Date.now()
  const expired = facts.filter(
    (fact) => fact.supersededAt !== null && now - fact.supersededAt >= 604800000,
  )
  const expiredIDs = new Set(expired.map((fact) => fact.id))
  const retained = facts.filter((fact) => !expiredIDs.has(fact.id))
  return copyStoredValue({
    groupID,
    current: coverage.current,
    retained: ranges(retained),
    effectiveFloor: retained.length === 0 ? null : Math.min(...retained.map((fact) => fact.epoch)),
    gaps: mergeGaps([
      ...coverage.gaps,
      ...expired.map((fact) => ({
        key: fact.key,
        from: fact.epoch,
        through: fact.epoch,
        reason: 'expired' as const,
      })),
    ]),
  })
}

function mergeGaps(gaps: CheckpointCoverage['gaps']): CheckpointCoverage['gaps'] {
  const result: CheckpointCoverage['gaps'] = []
  for (const gap of [...gaps].sort(
    (a, b) => a.key.incarnation - b.key.incarnation || a.from - b.from,
  )) {
    const last = result.at(-1)
    if (
      last?.key.incarnation === gap.key.incarnation &&
      last.reason === gap.reason &&
      last.through + 1 >= gap.from
    )
      last.through = Math.max(last.through, gap.through)
    else result.push(copyStoredValue(gap))
  }
  return result
}

// Only the coordinator calls this through its finalisation writer.
export async function retainCheckpointInstallations(
  store: CheckpointStore,
  installed: Array<CheckpointFactRecord>,
  now: number,
): Promise<void> {
  const records = await store.list()
  const previous = records.find((row) => row.kind === 'coverage' && row.id === 'coverage')
  const coverage = previous?.kind === 'coverage' ? copyStoredValue(previous) : null
  if (coverage === null && installed.length === 0) return
  const byID = new Map(
    records
      .filter((row): row is CheckpointFactRecord => row.kind === 'fact')
      .map((row) => [row.id, row]),
  )
  const facts =
    coverage?.installations.flatMap(({ id }) => {
      const fact = byID.get(id)
      return fact === undefined ? [] : [fact]
    }) ?? []
  const gaps = coverage?.gaps ?? []
  let current = coverage?.current ?? null
  for (const fact of installed) {
    const prior = facts.at(-1)
    if (prior !== undefined) {
      prior.supersededAt ??= now
      await store.put(prior)
    }
    const from = prior?.key.incarnation === fact.key.incarnation ? prior.epoch + 1 : 0
    if (from < fact.epoch)
      gaps.push({
        key: fact.key,
        from,
        through: fact.epoch - 1,
        reason: from === 0 ? 'pre-join' : 'skipped',
      })
    const decoded = decodeEpochRosterFact(fact.canonical)
    await startBranchCoverage(store, fact.key, fact.epoch, decoded.authHash)
    facts.push(fact)
    current = { key: { ...fact.key }, epoch: fact.epoch }
  }
  const retained: Array<CheckpointFactRecord> = []
  const removed = new Set<string>()
  for (const [index, fact] of facts.entries()) {
    if (
      index < facts.length - 256 ||
      (fact.supersededAt !== null && now - fact.supersededAt >= 604800000)
    ) {
      removed.add(fact.id)
      gaps.push({ key: fact.key, from: fact.epoch, through: fact.epoch, reason: 'expired' })
    } else retained.push(fact)
  }
  await store.remove([
    ...retainBranchHistory(records, retained),
    ...records.flatMap((row) =>
      row.kind === 'condition' &&
      row.notification !== undefined &&
      removed.has(row.notification.installationID)
        ? [row.id]
        : [],
    ),
    ...removed,
    ...records
      .filter((row) => row.kind === 'publication' && removed.has(row.factID))
      .map((row) => row.id),
  ])
  const key = current?.key ?? coverage?.key
  if (key === undefined) throw new GroupStateConflictError('Missing checkpoint coverage key')
  await store.put({
    kind: 'coverage',
    id: 'coverage',
    key,
    current,
    effectiveFloor: retained.length === 0 ? null : Math.min(...retained.map((row) => row.epoch)),
    gaps: mergeGaps(gaps),
    installations: retained.map(({ id, key, epoch }) => ({ id, key, epoch })),
  })
  if (records.some((row) => row.kind === 'branch-abandonment'))
    await retainBranchAbandonments(store, retained, now)
  if (
    !records.some(
      (row) => row.kind === 'evidence' || row.kind === 'notice' || row.kind === 'notice-tombstone',
    )
  )
    return
  const beforeEvidence = await store.list()
  const afterEvidence = retainForkEvidence(projectBranchHistory(beforeEvidence), retained, now)
  await store.remove(
    beforeEvidence
      .filter((row) => !afterEvidence.some((next) => next.id === row.id))
      .map((row) => row.id),
  )
  for (const row of afterEvidence) {
    if (
      !sameStoredValue(
        beforeEvidence.find((before) => before.id === row.id),
        row,
      )
    )
      await store.put(row)
  }
}
