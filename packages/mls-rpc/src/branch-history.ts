import { decodeEpochRosterFact } from '@kumiai/mls'
import type { CheckpointRecord, CheckpointStore, OwnBranchMessage } from '@kumiai/rpc'

import { provenCheckpointFacts, readCheckpointCoverage } from './checkpoint-store.js'
import { copyStoredValue } from './memory-incarnation-stores.js'
import { GroupStateConflictError } from './persistence-errors.js'
import type { GroupKey, GroupStores, GroupTransaction } from './persistence-types.js'

type JournalRecord = Extract<
  CheckpointRecord,
  { kind: 'own-branch-messages' | 'others-seen' | 'branch-coverage' }
>
const preparations = new WeakMap<CheckpointRecord, CheckpointRecord>()

export function branchHistoryPreparation(record: CheckpointRecord): CheckpointRecord | undefined {
  return preparations.get(record)
}

async function put(store: CheckpointStore, record: CheckpointRecord): Promise<void> {
  preparations.set(record, copyStoredValue(record))
  await store.put(record)
}

const sameKey = (a: GroupKey, b: GroupKey) =>
  a.groupID === b.groupID && a.incarnation === b.incarnation

export async function installedBranchMetadata(
  store: CheckpointStore,
  key: GroupKey,
  epoch: number,
): Promise<{ epoch: number; authHash: string } | null> {
  const records = await store.list()
  const fact = provenCheckpointFacts(records, key.groupID).find(
    (row) => sameKey(row.key, key) && row.epoch === epoch,
  )
  if (fact === undefined) return null
  const decoded = decodeEpochRosterFact(fact.canonical)
  return { epoch: decoded.epoch, authHash: decoded.authHash }
}

export async function startBranchCoverage(
  store: CheckpointStore,
  key: GroupKey,
  epoch: number,
  authHash: string,
): Promise<void> {
  const id = JSON.stringify(['branch-coverage', key.incarnation])
  if ((await store.load(id)) !== null) return
  await put(store, {
    kind: 'branch-coverage',
    id,
    key: { ...key },
    startedEpoch: epoch,
    startedAuthHash: authHash,
  })
}

async function validate<TTx extends GroupTransaction>(
  stores: GroupStores<TTx>,
  key: GroupKey,
  epoch: number,
  authHash: string,
): Promise<void> {
  const life = await stores.lifetime.load()
  const installed = await installedBranchMetadata(stores.checkpoints, key, epoch)
  if (
    stores.tx.groupID !== key.groupID ||
    life?.activeIncarnation !== key.incarnation ||
    installed?.authHash !== authHash
  )
    throw new GroupStateConflictError('Branch journal requires installed metadata')
}

export async function recordOwnBranchMessage<TTx extends GroupTransaction>(
  stores: GroupStores<TTx>,
  params: { key: GroupKey; message: OwnBranchMessage },
): Promise<void> {
  const key = { ...params.key }
  // Select fields explicitly: payloads never enter the prospective journal.
  const message = {
    id: params.message.id,
    epoch: params.message.epoch,
    authHash: params.message.authHash,
  }
  if (message.id.length === 0) throw new GroupStateConflictError('Missing prospective publish ID')
  await validate(stores, key, message.epoch, message.authHash)
  const id = JSON.stringify([
    'own-branch-messages',
    key.incarnation,
    message.epoch,
    message.authHash,
  ])
  const previous = await stores.checkpoints.load(id)
  if (previous !== null && previous.kind !== 'own-branch-messages')
    throw new GroupStateConflictError('Branch journal kind mismatch')
  if (previous?.messages.some((entry) => entry.id === message.id)) return
  await put(stores.checkpoints, {
    kind: 'own-branch-messages',
    id,
    key,
    epoch: message.epoch,
    authHash: message.authHash,
    messages: [...(previous?.messages ?? []), message],
  })
  for (const record of projectBranchHistory(await stores.checkpoints.list())) {
    if (record.kind === 'notice' && record.notice.closedAt === null)
      await stores.checkpoints.put(record)
  }
}

// Call only after durable authenticated admission accepts a new frame.
export async function incrementOthersSeen<TTx extends GroupTransaction>(
  stores: GroupStores<TTx>,
  params: { key: GroupKey; epoch: number; authHash: string },
): Promise<void> {
  await incrementOthersSeenBy(stores, params, 1)
}

export async function incrementOthersSeenBy<TTx extends GroupTransaction>(
  stores: GroupStores<TTx>,
  params: { key: GroupKey; epoch: number; authHash: string },
  amount: number,
): Promise<void> {
  const { epoch, authHash } = params
  const key = { ...params.key }
  await validate(stores, key, epoch, authHash)
  const id = JSON.stringify(['others-seen', key.incarnation, epoch, authHash])
  const previous = await stores.checkpoints.load(id)
  if (previous !== null && previous.kind !== 'others-seen')
    throw new GroupStateConflictError('Branch journal kind mismatch')
  const count = (previous?.count ?? 0) + amount
  if (!Number.isSafeInteger(count)) throw new GroupStateConflictError('Branch counter overflow')
  await put(stores.checkpoints, { kind: 'others-seen', id, key, epoch, authHash, count })
}

export function projectBranchHistory(records: Array<CheckpointRecord>): Array<CheckpointRecord> {
  const result = records.map((row) =>
    row.kind === 'notice' || row.kind === 'notice-event' ? copyStoredValue(row) : row,
  )
  const groupID = result[0]?.key.groupID
  if (
    groupID === undefined ||
    !result.some((row) => row.kind === 'notice' || row.kind === 'notice-event')
  )
    return result
  const own = result.filter((row) => row.kind === 'own-branch-messages')
  const hasMessages =
    own.length > 0 ||
    result.some(
      (row) =>
        (row.kind === 'notice' && row.notice.atRisk.length > 0) ||
        (row.kind === 'notice-event' && row.event.notice.atRisk.length > 0),
    )
  const facts = hasMessages
    ? provenCheckpointFacts(result, groupID).map((row) => decodeEpochRosterFact(row.canonical))
    : []
  const metadata = readCheckpointCoverage(groupID, result)
  const supported = (key: GroupKey, message: OwnBranchMessage) =>
    facts.some(
      (fact) =>
        sameKey(fact.key, key) &&
        fact.epoch === message.epoch &&
        fact.authHash === message.authHash,
    ) &&
    own.some(
      (row) =>
        sameKey(row.key, key) &&
        row.messages.some(
          (entry) =>
            entry.id === message.id &&
            entry.epoch === message.epoch &&
            entry.authHash === message.authHash,
        ),
    )
  for (const row of result) {
    if (row.kind === 'notice-event') {
      const notice = row.event.notice
      const retained = notice.atRisk.filter((message) => supported(row.key, message))
      if (retained.length !== notice.atRisk.length) {
        notice.atRisk = retained
        notice.coverage.ownMessages = { kind: 'partial', reasons: ['retention-gap'] }
      }
      continue
    }
    if (row.kind !== 'notice') continue
    const notice = row.notice
    let unknown = false
    const ancestry = (initialEpoch: number, initialHash: string) => {
      let epoch = initialEpoch
      let authHash = initialHash
      while (epoch > notice.splitEpoch) {
        const fact = facts.find(
          (fact) =>
            sameKey(fact.key, row.key) && fact.epoch === epoch && fact.authHash === authHash,
        )
        if (fact?.parentAuthHash == null) {
          unknown = true
          return false
        }
        authHash = fact.parentAuthHash
        epoch--
      }
      return epoch === notice.splitEpoch && authHash === notice.deviceAuthHash
    }
    notice.atRisk =
      notice.closedAt === null
        ? own.flatMap((entry) =>
            sameKey(entry.key, row.key) && ancestry(entry.epoch, entry.authHash)
              ? entry.messages.filter((message) => supported(row.key, message))
              : [],
          )
        : notice.atRisk.filter((message) => supported(row.key, message))
    const coverage = result.find(
      (entry) => entry.kind === 'branch-coverage' && sameKey(entry.key, row.key),
    )
    const reasons = new Set<'pre-journal-history' | 'retention-gap' | 'unknown-ancestry'>()
    if (coverage?.kind !== 'branch-coverage' || coverage.startedEpoch > notice.splitEpoch)
      reasons.add('pre-journal-history')
    if (
      metadata.gaps.some(
        (gap) =>
          sameKey(gap.key, row.key) && gap.through >= notice.splitEpoch && gap.reason === 'expired',
      )
    )
      reasons.add('retention-gap')
    if (
      unknown ||
      metadata.gaps.some(
        (gap) =>
          sameKey(gap.key, row.key) && gap.through >= notice.splitEpoch && gap.reason === 'skipped',
      )
    )
      reasons.add('unknown-ancestry')
    notice.coverage.ownMessages =
      reasons.size === 0 ? { kind: 'complete' } : { kind: 'partial', reasons: [...reasons] }
  }
  return result
}

export function retainBranchHistory(
  records: Array<CheckpointRecord>,
  facts: Array<{ key: GroupKey; epoch: number; canonical: Uint8Array }>,
): Array<string> {
  return records.flatMap((row) => {
    if (!['own-branch-messages', 'others-seen', 'branch-coverage'].includes(row.kind)) return []
    const journal = row as JournalRecord
    const epoch = journal.kind === 'branch-coverage' ? journal.startedEpoch : journal.epoch
    const authHash = journal.kind === 'branch-coverage' ? journal.startedAuthHash : journal.authHash
    return facts.some(
      (row) =>
        sameKey(row.key, journal.key) &&
        row.epoch === epoch &&
        decodeEpochRosterFact(row.canonical).authHash === authHash,
    )
      ? []
      : [journal.id]
  })
}
