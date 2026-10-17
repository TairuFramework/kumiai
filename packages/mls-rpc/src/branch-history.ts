import {
  checkpointAuthHash,
  decodeEpochCheckpoint,
  decodeEpochRosterFact,
  didFromCredential,
  verifyRecoveryLineage,
} from '@kumiai/mls'
import type {
  BranchAbandonedEvent,
  CheckpointRecord,
  CheckpointStore,
  CoverageGapReason,
  OwnBranchMessage,
  ReportCoverage,
} from '@kumiai/rpc'
import { toB64U } from '@sozai/codec'
import { decode, mlsMessageDecoder, wireformats } from 'ts-mls'

import { provenCheckpointFacts, readCheckpointCoverage } from './checkpoint-store.js'
import type { EntryReads } from './entry-capability.js'
import { copyStoredValue } from './memory-incarnation-stores.js'
import { GroupStateConflictError } from './persistence-errors.js'
import type { GroupKey, GroupStores, GroupTransaction } from './persistence-types.js'
import { authenticateRecoveryReply } from './recovery.js'
import { decodeCapturedRecoveryCandidate, decodeRecoveryCandidate } from './recovery-codec.js'
import { recoveryTrustInputs } from './registry/trust.js'

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

type AbandonmentParams = { source: GroupKey; destination: GroupKey; mutationID: string }

// The caller has already verified the destination and its installation proof.
export function branchAbandonmentPreparer(reads: EntryReads) {
  return async function prepareBranchAbandonment(
    params: AbandonmentParams,
  ): Promise<BranchAbandonedEvent | null> {
    const { source, destination, mutationID } = params
    const records = await reads.checkpoints()
    const record = (await reads.control(source.incarnation)).rejoin
    if (
      record?.stage !== 'confirmed' ||
      destination.groupID !== source.groupID ||
      destination.incarnation !== source.incarnation + 1
    )
      throw new GroupStateConflictError('Abandonment requires an established switch')
    const snapshot =
      'format' in record
        ? decodeCapturedRecoveryCandidate(record.candidate, record.requestKey)
        : decodeRecoveryCandidate(record.candidate, record.requestKey)
    const info = decode(mlsMessageDecoder, snapshot.groupInfo)
    const context =
      info?.wireformat === wireformats.mls_group_info ? info.groupInfo.groupContext : null
    const facts = provenCheckpointFacts(records, source.groupID)
      .filter((row) => sameKey(row.key, source))
      .map((row) => ({ row, fact: decodeEpochRosterFact(row.canonical) }))
      .sort((a, b) => a.fact.epoch - b.fact.epoch)
    const retainedTrust = await reads.trust()
    const installedEpoch = retainedTrust?.installed.epoch
    const tip = facts.find(({ fact }) => fact.epoch === installedEpoch)
    const epoch = context === null ? null : Number(context.epoch)
    const transcript = context === null ? null : toB64U(context.confirmedTranscriptHash)
    const sameAtCapture = facts.find(({ fact }) => fact.epoch === epoch)
    if (
      tip !== undefined &&
      sameAtCapture === tip &&
      tip.fact.confirmedTranscriptHash === transcript
    )
      return null
    let remote: Array<{ epoch: number; authHash: string; parentAuthHash: string | null }> = []
    if ('format' in record && epoch !== null) {
      const captured = decodeCapturedRecoveryCandidate(record.candidate, record.requestKey)
      const trust = retainedTrust
      if (trust !== null) {
        const reply = await authenticateRecoveryReply({
          trust,
          sealed: captured.attestedReply,
          requestID: snapshot.requestID,
          requestKey: record.requestKey,
          options: {},
        })
        if (
          reply?.lineage !== undefined &&
          reply.responderKeyHash !== undefined &&
          tip !== undefined
        ) {
          const lineage = await verifyRecoveryLineage({
            trust: recoveryTrustInputs(trust),
            frames: reply.lineage,
            signerKeyHash: reply.responderKeyHash,
            epoch,
            authHash: checkpointAuthHash({
              groupID: source.groupID,
              genesisHash: tip.fact.genesisHash,
              epoch,
              epochAuthenticator: reply.groupInfoAuthenticator,
            }),
          })
          if (lineage !== null)
            remote = reply.lineage.map((frame) => decodeEpochCheckpoint(frame).body)
        }
      }
    }
    if (
      tip !== undefined &&
      remote.some((frame) => frame.epoch === tip.fact.epoch && frame.authHash === tip.fact.authHash)
    )
      return null
    const divergence = facts.find(
      ({ fact }) =>
        remote.some((frame) => frame.epoch === fact.epoch && frame.authHash !== fact.authHash) ||
        (transcript !== null &&
          fact.epoch === epoch &&
          fact.confirmedTranscriptHash !== transcript),
    )
    const split = divergence?.fact.epoch
    const branchOnly = (fact: ReturnType<typeof decodeEpochRosterFact>) => {
      if (split === undefined || fact.epoch < split) return false
      let current = fact
      while (current.epoch > split) {
        const parent = facts.find(
          (entry) =>
            entry.fact.epoch === current.epoch - 1 &&
            entry.fact.authHash === current.parentAuthHash,
        )
        if (parent === undefined) return false
        current = parent.fact
      }
      return current.authHash === divergence?.fact.authHash
    }
    const selected = facts.filter(({ fact }) => branchOnly(fact))
    const prior =
      split === undefined ? undefined : facts.find(({ fact }) => fact.epoch === split - 1)
    const firstRemote = remote.find((frame) => frame.epoch === split)
    const boundedSplit =
      prior !== undefined &&
      firstRemote !== undefined &&
      prior.fact.authHash === firstRemote.parentAuthHash &&
      divergence?.fact.parentAuthHash === prior.fact.authHash
    const completeAncestry = boundedSplit && tip !== undefined && branchOnly(tip.fact)
    const coverage = readCheckpointCoverage(source.groupID, records)
    const marker = records.find((row) => row.kind === 'branch-coverage' && sameKey(row.key, source))
    const reasons = new Set<CoverageGapReason>()
    if (!completeAncestry) reasons.add('unknown-ancestry')
    if (marker?.kind !== 'branch-coverage' || split === undefined || marker.startedEpoch > split)
      reasons.add('pre-journal-history')
    if (
      coverage.gaps.some(
        (gap) =>
          sameKey(gap.key, source) &&
          gap.reason === 'expired' &&
          (split === undefined || gap.through >= split),
      )
    )
      reasons.add('retention-gap')
    const known = (row: { epoch: number; authHash: string }) =>
      selected.some(({ fact }) => fact.epoch === row.epoch && fact.authHash === row.authHash)
    const observedCoverage: ReportCoverage =
      reasons.size === 0 ? { kind: 'complete' } : { kind: 'partial', reasons: [...reasons] }
    const destinationMembers = new Set(
      snapshot.sourceTree.flatMap((node) => {
        if (node?.nodeType !== 1) return []
        const did = didFromCredential(node.leaf.credential)
        return did === null ? [] : [did]
      }),
    )
    const before = new Set(prior?.fact.members.map((member) => member.signerDID) ?? [])
    const after = new Set(tip?.fact.members.map((member) => member.signerDID) ?? [])
    const notice = records.find(
      (row) =>
        row.kind === 'notice' &&
        sameKey(row.key, source) &&
        row.notice.closedAt === null &&
        (split === undefined || row.notice.splitEpoch === split),
    )
    return {
      ...source,
      id: JSON.stringify([
        'branch-abandoned',
        source.groupID,
        source.incarnation,
        destination.incarnation,
        mutationID,
      ]),
      kind: 'branch-abandoned',
      noticeID: notice?.kind === 'notice' ? notice.notice.id : null,
      epochs:
        completeAncestry && split !== undefined && tip !== undefined
          ? { from: split, through: tip.fact.epoch }
          : 'unknown',
      ownMessages: [
        ...new Map(
          records.flatMap((row) =>
            row.kind === 'own-branch-messages' && sameKey(row.key, source) && known(row)
              ? row.messages.map((message) => [message.id, message] as const)
              : [],
          ),
        ).values(),
      ],
      othersSeen: records.reduce(
        (count, row) =>
          count +
          (row.kind === 'others-seen' && sameKey(row.key, source) && known(row) ? row.count : 0),
        0,
      ),
      membersAdded: completeAncestry
        ? [...after].filter((did) => !before.has(did) && !destinationMembers.has(did)).sort()
        : [],
      membersRemoved: completeAncestry
        ? [...before].filter((did) => !after.has(did) && destinationMembers.has(did)).sort()
        : [],
      coverage: {
        ancestry: completeAncestry
          ? { kind: 'complete' }
          : { kind: 'partial', reasons: ['unknown-ancestry'] },
        ownMessages: observedCoverage,
        othersSeen: copyStoredValue(observedCoverage),
        membership: completeAncestry
          ? { kind: 'complete' }
          : { kind: 'partial', reasons: ['unknown-ancestry'] },
        ephemeral: { kind: 'partial', reasons: ['ephemeral-uncovered'] },
      },
    }
  }
}

export async function writeBranchAbandonment(
  store: CheckpointStore,
  event: BranchAbandonedEvent,
  facts: Array<CheckpointRecord>,
): Promise<void> {
  await put(store, {
    kind: 'branch-abandonment',
    id: event.id,
    key: { groupID: event.groupID, incarnation: event.incarnation },
    event,
    factIDs: provenCheckpointFacts(facts, event.groupID)
      .filter((row) => row.key.incarnation === event.incarnation)
      .map((row) => row.id),
    acknowledgedAt: null,
  })
  for (const row of facts) {
    if (
      row.kind !== 'notice' ||
      row.key.incarnation !== event.incarnation ||
      row.notice.closedAt !== null
    )
      continue
    await store.put({ ...row, notice: { ...row.notice, closedAt: Date.now() } })
  }
}

export async function acknowledgeBranchAbandonment(
  store: CheckpointStore,
  key: GroupKey,
  id: string,
): Promise<boolean> {
  const row = await store.load(id)
  if (row?.kind !== 'branch-abandonment' || !sameKey(row.key, key)) return false
  if (row.acknowledgedAt === null) await put(store, { ...row, acknowledgedAt: Date.now() })
  return true
}

type AbandonmentRecord = Extract<CheckpointRecord, { kind: 'branch-abandonment' }>

function retainedAbandonment(
  row: AbandonmentRecord,
  ids: Set<string>,
  now: number,
): AbandonmentRecord | null {
  if (row.acknowledgedAt !== null && now - row.acknowledgedAt >= 604800000) return null
  if (row.factIDs.every((id) => ids.has(id))) return row
  const partial = { kind: 'partial' as const, reasons: ['retention-gap' as const] }
  return {
    ...row,
    factIDs: row.factIDs.filter((id) => ids.has(id)),
    event: {
      ...row.event,
      epochs: 'unknown',
      ownMessages: [],
      othersSeen: 0,
      membersAdded: [],
      membersRemoved: [],
      coverage: {
        ...row.event.coverage,
        ancestry: partial,
        ownMessages: partial,
        othersSeen: partial,
        membership: partial,
      },
    },
  }
}

export function branchAbandonmentEvents(
  records: Array<CheckpointRecord>,
  key: GroupKey,
): Array<BranchAbandonedEvent> {
  const ids = new Set(provenCheckpointFacts(records, key.groupID).map((row) => row.id))
  return records.flatMap((row) => {
    if (row.kind !== 'branch-abandonment' || !sameKey(row.key, key) || row.acknowledgedAt !== null)
      return []
    const retained = retainedAbandonment(row, ids, Date.now())
    return retained === null ? [] : [copyStoredValue(retained.event)]
  })
}

export async function retainBranchAbandonments(
  store: CheckpointStore,
  facts: Array<{ id: string }>,
  now: number,
): Promise<void> {
  const ids = new Set(facts.map((row) => row.id))
  for (const row of await store.list()) {
    if (row.kind !== 'branch-abandonment') continue
    const retained = retainedAbandonment(row, ids, now)
    if (retained === null) await store.remove([row.id])
    else if (retained !== row) await store.put(retained)
  }
}
