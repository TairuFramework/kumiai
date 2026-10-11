import { isHeadMismatch } from '../commit.js'
import type { CommitHeader } from '../crypto.js'
import { asLogPosition, type LogPosition } from '../cursor.js'
import type { ConfirmationOutcome } from '../recovery-confirmation.js'
import { forkSettlement } from './forks.js'
import type { PublishOutcome } from './operations.js'
import { applyResolved, pruneWindow } from './store.js'
import type {
  AdoptionWriteFactory,
  AppliedCommit,
  ControlStore,
  Outcome,
  RejoinRecord,
} from './types.js'

export type RecoverySource = Omit<RejoinRecord['source'], 'head'>
export type SourceScan = {
  current: RecoverySource
  gap: boolean
  frames: Array<{
    position: LogPosition
    header: CommitHeader | null
    digest: string | null
    responded: boolean
  }>
}

export function rejoinBarrier(record: RejoinRecord | null): LogPosition | null {
  return record != null && (record.stage === 'published' || record.stage === 'confirmed')
    ? (record.position ?? null)
    : null
}

export type SourceRecheck =
  | { kind: 'pass' }
  | { kind: 'fail'; blockingPosition: LogPosition | null }

/** Only a possible source-epoch ratchet below the barrier invalidates the candidate. */
export function sourceRecheck(scan: SourceScan, record: RejoinRecord): SourceRecheck {
  const { current, gap, frames } = scan
  const source = record.source
  if (
    gap ||
    current.epoch !== source.epoch ||
    current.key.groupID !== source.key.groupID ||
    current.key.incarnation !== source.key.incarnation ||
    current.authenticator.length !== source.authenticator.length ||
    !current.authenticator.every((byte, i) => byte === source.authenticator[i])
  )
    return { kind: 'fail', blockingPosition: null }
  for (const frame of frames) {
    if (source.head != null && frame.position <= source.head) continue
    if (record.position != null && frame.position >= record.position) continue
    if (
      frame.header?.epoch === source.epoch &&
      !(frame.header.external && frame.digest === record.digest) &&
      !frame.responded
    )
      return { kind: 'fail', blockingPosition: frame.position }
  }
  return { kind: 'pass' }
}

export type RejoinDeps = {
  control: ControlStore
  signal?: AbortSignal
  publish(
    payload: Uint8Array,
    publishID: string,
    expectedHead: LogPosition | null,
  ): Promise<PublishOutcome>
  searchLog(
    from: LogPosition | null,
    payloadDigest: string,
  ): Promise<{ found: LogPosition } | 'absent' | 'gap'>
  confirm(record: RejoinRecord): Promise<ConfirmationOutcome>
  runSerial<T>(fn: () => Promise<T>): Promise<T>
  scan(record: RejoinRecord): Promise<SourceScan>
  adopt(record: RejoinRecord, write: AdoptionWriteFactory): Promise<void>
  bootstrapLedger(): Promise<boolean>
  getLedger(): Promise<Array<string>>
  newID(): string
  now(): number
  emit(outcome: Outcome): void
  discarded(
    reason: 'absent' | 'gap' | 'invalidated' | 'renewal' | 'superseded' | 'unconfirmed',
    record: RejoinRecord,
    blockingPosition?: LogPosition | null,
  ): void
}

export async function stepRejoin(
  deps: RejoinDeps,
  record: RejoinRecord,
): Promise<RejoinRecord | null> {
  const save = async (next: RejoinRecord): Promise<RejoinRecord> => {
    await applyResolved(deps.control, { putRejoin: next }, deps.newID(), undefined, deps.signal)
    return next
  }
  const discard = async (
    reason: Parameters<RejoinDeps['discarded']>[0],
    blockingPosition?: LogPosition | null,
  ): Promise<null> => {
    await applyResolved(deps.control, { deleteRejoin: true }, deps.newID(), undefined, deps.signal)
    deps.discarded(reason, record, blockingPosition)
    return null
  }
  if (record.stage === 'refused') return record
  if (record.stage === 'built') {
    let position: LogPosition
    try {
      position = asLogPosition(
        (await deps.publish(record.payload, record.publishID, record.expectedHead)).sequenceID,
      )
    } catch (error) {
      if (!isHeadMismatch(error)) throw error
      const found = await deps.searchLog(record.expectedHead, record.payloadDigest)
      if (typeof found !== 'object') return await discard(found)
      position = found.found
    }
    return await save({ ...record, stage: 'published', position })
  }
  if (record.stage === 'published') {
    const verdict = await deps.confirm(record)
    return await deps.runSerial(async () => {
      const current = (await deps.control.load()).rejoin
      if (current?.id !== record.id || current.stage !== 'published') return current
      if (verdict.kind === 'confirmed')
        return await save({ ...record, stage: 'confirmed', verdict: verdict.sealed })
      if (verdict.kind === 'error') throw verdict.error
      if (verdict.kind === 'disposed') throw new Error('Recovery disposed')
      if (verdict.kind === 'refused') {
        if (['binding', 'lapse', 'floor'].includes(verdict.refusal)) return await discard('renewal')
        const next: RejoinRecord = { ...record, stage: 'refused', refusal: verdict.refusal }
        const outcome: Outcome = {
          id: record.id,
          opID: null,
          at: deps.now(),
          kind: 'refused',
          reason: verdict.refusal,
        }
        await applyResolved(
          deps.control,
          { putRejoin: next, putOutcomes: [outcome] },
          deps.newID(),
          undefined,
          deps.signal,
        )
        deps.emit(outcome)
        return next
      }
      return await discard(verdict.kind)
    })
  }
  if (record.stage === 'confirmed') {
    const checked = sourceRecheck(await deps.scan(record), record)
    if (checked.kind === 'fail') return await discard('invalidated', checked.blockingPosition)
    const position = record.position
    if (position == null) throw new Error('Confirmed rejoin has no position')
    const snapshot = await deps.control.load()
    const row: AppliedCommit = {
      epoch: record.epochAfter - 1,
      digest: record.digest,
      payloadDigest: record.payloadDigest,
      sequenceID: position,
      opID: null,
      removed: false,
    }
    const next: RejoinRecord = { ...record, stage: 'adopted' }
    const deferred = snapshot.operations.filter((op) => op.stage === 'accepted')
    const settlement =
      record.conflictEpoch == null
        ? {
            deleteOperations: deferred.map((op) => op.id),
            putOutcomes: deferred.map(
              (op): Outcome => ({ id: op.id, opID: op.id, at: deps.now(), kind: 'unknown' }),
            ),
            putApplied: [row],
          }
        : forkSettlement(snapshot, record.conflictEpoch, row)
    const mutationID = deps.newID()
    await deps.adopt(record, (staged) => ({
      mutationID,
      anchorLanded: record.digest,
      changes: {
        ...pruneWindow(snapshot, row.epoch),
        ...settlement,
        putRejoin: next,
        cursor: { position, epoch: staged.epochAfter, stranded: true },
        putResponses: [
          {
            position,
            digest: record.digest,
            kind: 'applied',
            epoch: row.epoch,
            epochAfter: staged.epochAfter,
          },
        ],
      },
    }))
    for (const outcome of settlement.putOutcomes ?? []) deps.emit(outcome)
    return next
  }
  if (!(await deps.bootstrapLedger())) return record
  const held = new Set(await deps.getLedger())
  const tokens = record.ledgerBefore.filter((token) => !held.has(token))
  const snapshot = await deps.control.load()
  const outcome: Outcome = { id: record.id, opID: null, at: deps.now(), kind: 'reenact', tokens }
  await applyResolved(
    deps.control,
    {
      deleteRejoin: true,
      ...(tokens.length === 0 ? {} : { putOutcomes: [outcome] }),
      cursor: {
        position: snapshot.cursor?.position ?? record.position ?? null,
        epoch: snapshot.cursor?.epoch ?? record.epochAfter,
      },
    },
    deps.newID(),
    undefined,
    deps.signal,
  )
  if (tokens.length > 0) deps.emit(outcome)
  return null
}
