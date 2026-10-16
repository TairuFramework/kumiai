import { isHeadMismatch } from '../commit.js'
import type { CommitHeader } from '../crypto.js'
import { asLogPosition, type LogPosition } from '../cursor.js'
import type { ConfirmationOutcome } from '../recovery-confirmation.js'
import { recoveryHeld, settleRecovery } from '../recovery-reconcile.js'
import type {
  CapturedRejoinRecord,
  RecoveryReconciliation,
  StoredRejoinRecord,
} from '../recovery-types.js'
import type { PublishOutcome } from './operations.js'
import { controlSafetyHeld } from './safety.js'
import { applyResolved, pruneWindow } from './store.js'
import type {
  AdoptionWriteFactory,
  AppliedCommit,
  ControlStore,
  LegacyRejoinRecord,
  Outcome,
} from './types.js'

export type SourceScanIdentity = Omit<LegacyRejoinRecord['source'], 'head'>
export type SourceScan = {
  current: SourceScanIdentity
  gap: boolean
  frames: Array<{
    position: LogPosition
    header: CommitHeader | null
    digest: string | null
    responded: boolean
  }>
}

export function rejoinBarrier(record: StoredRejoinRecord | null): LogPosition | null {
  return record != null && (record.stage === 'published' || record.stage === 'confirmed')
    ? (record.position ?? null)
    : null
}

export type SourceRecheck =
  | { kind: 'pass' }
  | { kind: 'fail'; blockingPosition: LogPosition | null }

/** Only a possible source-epoch ratchet below the barrier invalidates the candidate. */
export function sourceRecheck(scan: SourceScan, record: LegacyRejoinRecord): SourceRecheck {
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

export type LegacyRejoinDeps = {
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
  confirm(record: LegacyRejoinRecord): Promise<ConfirmationOutcome>
  runSerial<T>(fn: () => Promise<T>): Promise<T>
  scan(record: LegacyRejoinRecord): Promise<SourceScan>
  canAdopt?(): Promise<boolean>
  adopt(record: LegacyRejoinRecord, write: AdoptionWriteFactory): Promise<void>
  bootstrapLedger(): Promise<boolean>
  getLedger(): Promise<Array<string>>
  newID(): string
  now(): number
  emit(outcome: Outcome): void
  discarded(
    reason: 'absent' | 'gap' | 'invalidated' | 'renewal' | 'superseded' | 'unconfirmed',
    record: LegacyRejoinRecord,
    blockingPosition?: LogPosition | null,
  ): void
}

export async function stepLegacyRejoin(
  deps: LegacyRejoinDeps,
  record: LegacyRejoinRecord,
): Promise<StoredRejoinRecord | null> {
  const save = async (next: LegacyRejoinRecord): Promise<LegacyRejoinRecord> => {
    await applyResolved(deps.control, { putRejoin: next }, deps.newID(), undefined, deps.signal)
    return next
  }
  const discard = async (
    reason: Parameters<LegacyRejoinDeps['discarded']>[0],
    blockingPosition?: LogPosition | null,
  ): Promise<null> => {
    await applyResolved(deps.control, { deleteRejoin: true }, deps.newID(), undefined, deps.signal)
    deps.discarded(reason, record, blockingPosition)
    return null
  }
  if (controlSafetyHeld(await deps.control.load()) !== null) return record
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
      if (
        current == null ||
        'format' in current ||
        current.id !== record.id ||
        current.stage !== 'published'
      )
        return current
      if (verdict.kind === 'confirmed')
        return await save({ ...record, stage: 'confirmed', verdict: verdict.sealed })
      if (verdict.kind === 'error') throw verdict.error
      if (verdict.kind === 'disposed') throw new Error('Recovery disposed')
      if (verdict.kind === 'refused') {
        if (['binding', 'lapse', 'floor'].includes(verdict.refusal)) return await discard('renewal')
        const next: LegacyRejoinRecord = { ...record, stage: 'refused', refusal: verdict.refusal }
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
    const held = async () => {
      const snapshot = await deps.control.load()
      const hold = snapshot.controlHold
      return (
        controlSafetyHeld(snapshot) !== null ||
        (hold !== null && hold.reason !== 'acceptance-unknown') ||
        (deps.canAdopt !== undefined && !(await deps.canAdopt()))
      )
    }
    if (await held()) return record
    const scan = await deps.scan(record)
    if (await held()) return record
    const checked = sourceRecheck(scan, record)
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
    const next: LegacyRejoinRecord = { ...record, stage: 'adopted' }
    const deferred = snapshot.operations.filter((op) => op.stage === 'accepted')
    const settlement = {
      deleteOperations: deferred.map((op) => op.id),
      putOutcomes: deferred.map(
        (op): Outcome => ({ id: op.id, opID: op.id, at: deps.now(), kind: 'unknown' }),
      ),
      putApplied: [row],
    }
    if (await held()) return record
    const mutationID = deps.newID()
    await deps.adopt(record, (staged) => ({
      mutationID,
      anchorLanded: record.digest,
      changes: {
        ...pruneWindow(snapshot, row.epoch),
        ...settlement,
        putRejoin: next,
        ...(snapshot.controlHold?.reason === 'acceptance-unknown' ? { controlHold: null } : {}),
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
  if (controlSafetyHeld(await deps.control.load()) !== null) return record
  const held = new Set(await deps.getLedger())
  const tokens = [...new Set(record.ledgerBefore)].filter((token) => !held.has(token))
  const snapshot = await deps.control.load()
  if (controlSafetyHeld(snapshot) !== null) return record
  const outcome: Outcome = { id: record.id, opID: null, at: deps.now(), kind: 'reenact', tokens }
  await applyResolved(
    deps.control,
    {
      deleteRejoin: true,
      ...(snapshot.cursor?.incomplete ? {} : { strand: null }),
      ...(tokens.length === 0 ? {} : { putOutcomes: [outcome] }),
      cursor: {
        ...(snapshot.cursor?.incomplete ? { incomplete: true as const } : {}),
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

export type RejoinDeps = Omit<LegacyRejoinDeps, 'confirm' | 'scan' | 'adopt' | 'discarded'> & {
  confirm(record: CapturedRejoinRecord): Promise<ConfirmationOutcome & { candidate?: Uint8Array }>
  reconcileCapture(record: CapturedRejoinRecord): Promise<RecoveryReconciliation>
  adopt(record: CapturedRejoinRecord, write: AdoptionWriteFactory): Promise<'adopted' | 'handoff'>
  reconcileBeforePublish?: boolean
  reconcileConfirmedRecovery?: string
  settleAcceptedRecovery?: (
    record: CapturedRejoinRecord,
    acceptedEpoch: number,
    leafDigest: string,
    recoveryEpochFloor?: number,
  ) => Promise<void>
  discarded(reason: 'unapplied-later' | 'accepted', record: CapturedRejoinRecord): void
}
export type RejoinStep =
  | CapturedRejoinRecord
  | null
  | { kind: 'handoff'; record: CapturedRejoinRecord }

export async function stepRejoin(
  deps: RejoinDeps,
  record: CapturedRejoinRecord,
): Promise<RejoinStep> {
  const snapshot = await deps.control.load()
  if (recoveryHeld(snapshot) || record.trigger !== 'automatic') return record
  const save = async (next: CapturedRejoinRecord) => {
    await applyResolved(deps.control, { putRejoin: next }, deps.newID(), undefined, deps.signal)
    return next
  }
  const reconcile = async (): Promise<RejoinStep> => {
    // A propagated provider/origin failure is a retry, never authenticated non-acceptance.
    const result = await deps.reconcileCapture(record)
    return await deps.runSerial(async () => {
      const snapshot = await deps.control.load()
      const current = snapshot.rejoin
      if (recoveryHeld(snapshot)) return current !== null && 'format' in current ? current : null
      if (
        current === null ||
        !('format' in current) ||
        current.id !== record.id ||
        current.stage !== record.stage
      )
        return current !== null && 'format' in current ? current : null
      if (
        result.kind === 'head-only' &&
        current.stage !== 'confirmed' &&
        current.stage !== 'adopted'
      )
        return await save({ ...current, stage: 'built', expectedHead: result.head })
      if (result.kind === 'accepted' || result.kind === 'unapplied-later') {
        const confirmed = current.stage === 'confirmed' || current.stage === 'adopted'
        const accepted = result.kind === 'accepted' || confirmed
        // Bound confirmation saved epochAfter with this exact candidate, even if its leaf was removed later.
        const acceptedEpoch =
          result.kind === 'unapplied-later' && confirmed ? current.epochAfter : result.epoch
        if (accepted && deps.settleAcceptedRecovery !== undefined)
          await deps.settleAcceptedRecovery(current, acceptedEpoch, result.leafDigest, result.epoch)
        else
          await settleRecovery({
            control: deps.control,
            record: current,
            provenance: accepted
              ? {
                  kind: 'accepted-unadoptable',
                  epoch: acceptedEpoch,
                  leafDigest: result.leafDigest,
                }
              : { kind: 'not-accepted', epoch: result.epoch },
            mutationID: deps.newID(),
            recoveryEpochFloor: result.epoch,
            signal: deps.signal,
          })
        record.requestKey.fill(0)
        record.candidate.fill(0)
        deps.discarded(accepted ? 'accepted' : 'unapplied-later', record)
        return null
      }
      return current
    })
  }
  if (record.stage === 'refused') return record
  if (record.stage === 'built') {
    if (deps.reconcileBeforePublish) {
      try {
        const found = await deps.searchLog(record.searchFrom, record.payloadDigest)
        if (typeof found === 'object')
          return await save({ ...record, stage: 'published', position: found.found })
      } catch (error) {
        if (deps.signal?.aborted) throw error
      }
      return await reconcile()
    }
    try {
      const published = await deps.publish(record.payload, record.publishID, record.expectedHead)
      return await save({
        ...record,
        stage: 'published',
        position: asLogPosition(published.sequenceID),
      })
    } catch (error) {
      if (!isHeadMismatch(error)) throw error
      const found = await deps.searchLog(record.searchFrom, record.payloadDigest)
      if (typeof found === 'object')
        return await save({ ...record, stage: 'published', position: found.found })
      return await reconcile()
    }
  }
  if (record.stage === 'published') {
    const verdict = await deps.confirm(record)
    if (verdict.kind === 'confirmed')
      return await deps.runSerial(async () => {
        const current = (await deps.control.load()).rejoin
        if (
          current === null ||
          !('format' in current) ||
          current.id !== record.id ||
          current.stage !== 'published'
        )
          return current !== null && 'format' in current ? current : null
        return await save({
          ...current,
          stage: 'confirmed',
          candidate: verdict.candidate ?? current.candidate,
          verdict: verdict.sealed,
          switchMutationID: current.switchMutationID ?? deps.newID(),
        })
      })
    if (verdict.kind === 'error') throw verdict.error
    if (verdict.kind === 'disposed') throw new Error('Recovery disposed')
    if (
      verdict.kind === 'refused' &&
      (verdict.refusal === 'policy' || verdict.refusal === 'invalid')
    ) {
      return await deps.runSerial(async () => {
        const current = (await deps.control.load()).rejoin
        if (
          current === null ||
          !('format' in current) ||
          current.id !== record.id ||
          current.stage !== 'published'
        )
          return current !== null && 'format' in current ? current : null
        const next: CapturedRejoinRecord = {
          ...current,
          stage: 'refused',
          refusal: verdict.refusal,
        }
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
      })
    }
    return await reconcile()
  }
  if (
    (record.stage === 'confirmed' || record.stage === 'adopted') &&
    deps.reconcileConfirmedRecovery === record.id
  )
    return await reconcile()
  if (record.stage === 'confirmed') {
    if (deps.canAdopt !== undefined && !(await deps.canAdopt())) return record
    const confirmed = await deps.runSerial(async () => {
      const snapshot = await deps.control.load()
      const current = snapshot.rejoin
      if (
        controlSafetyHeld(snapshot) !== null ||
        current === null ||
        !('format' in current) ||
        current.id !== record.id ||
        current.stage !== 'confirmed'
      )
        return null
      return current.switchMutationID === null
        ? await save({ ...current, switchMutationID: deps.newID() })
        : current
    })
    if (confirmed === null) return record
    const mutationID = confirmed.switchMutationID
    const position = confirmed.position
    if (mutationID === null || position === undefined || confirmed.verdict === undefined)
      throw new Error('Confirmed recovery proof required')
    const result = await deps.adopt(confirmed, (staged) => ({
      mutationID,
      changes: {
        putRejoin: {
          ...confirmed,
          stage: 'adopted',
          destinationKey: {
            groupID: confirmed.source.key.groupID,
            incarnation: staged.incarnation,
          },
        },
        cursor: { position, epoch: staged.epochAfter },
      },
    }))
    return result === 'handoff'
      ? { kind: 'handoff', record: confirmed }
      : { ...confirmed, stage: 'adopted' }
  }
  if (!(await deps.bootstrapLedger())) return record
  const current = await deps.control.load()
  if (controlSafetyHeld(current) !== null) return record
  const held = new Set(await deps.getLedger())
  const tokens = [...new Set(record.ledgerBefore)].filter((token) => !held.has(token))
  const outcome: Outcome = { id: record.id, opID: null, at: deps.now(), kind: 'reenact', tokens }
  await applyResolved(
    deps.control,
    {
      deleteRejoin: true,
      ...(current.cursor?.incomplete ? {} : { strand: null }),
      cursor: {
        ...(current.cursor?.incomplete ? { incomplete: true as const } : {}),
        position: current.cursor?.position ?? record.position ?? null,
        epoch: current.cursor?.epoch ?? record.epochAfter,
      },
      ...(tokens.length === 0 ? {} : { putOutcomes: [outcome] }),
    },
    deps.newID(),
    undefined,
    deps.signal,
  )
  if (tokens.length > 0) deps.emit(outcome)
  return null
}
