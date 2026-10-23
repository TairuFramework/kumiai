import { asLogPosition, type LogPosition } from '../cursor.js'
import { OperationRejectedError } from '../errors.js'
import type { FrameControlBuild, PrepareControlResult } from './build.js'
import { controlSafetyHeld, type GroupForkEvidence, type SafetyHold } from './safety.js'
import type { ControlEvidenceSnapshot } from './search.js'
import { applyResolved } from './store.js'
import type {
  AppliedCommit,
  ControlAdoptionPort,
  ControlChanges,
  ControlSnapshot,
  ControlStore,
  Operation,
  OperationRequest,
  Outcome,
} from './types.js'

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const publicationHeads = new WeakMap<
  ControlStore,
  { publishID: string; heads: Set<LogPosition | null> }
>()
const pendingReports = new WeakMap<ControlStore, Promise<void>>()

export function landedChanges(
  op: Operation,
  position: LogPosition,
  applied: AppliedCommit,
): ControlChanges {
  return {
    deleteOperations: [op.id],
    putOutcomes: [{ id: op.id, opID: op.id, at: op.enqueuedAt, kind: 'landed', position }],
    putApplied: [applied],
    ...(!applied.removed ? { strand: null } : {}),
    cursor: { position, epoch: applied.epoch + 1, ...(applied.removed ? { stranded: true } : {}) },
  }
}

export function revokeHeld(snapshot: ControlSnapshot): boolean {
  return snapshot.operations.some((op) => op.revokes) || snapshot.commitOnce?.revokes === true
}
export type { HostBuilt } from './types.js'
export type PublishOutcome = { sequenceID: string }
export type OperationDeps = {
  control: ControlStore
  signal?: AbortSignal
  haltFork(evidence: GroupForkEvidence): Promise<void>
  safetyHold(): SafetyHold
  prepareBuild(op: Operation, frame: FrameControlBuild): Promise<PrepareControlResult>
  adopt: ControlAdoptionPort['adopt']
  frame: FrameControlBuild
  readEvidence(): Promise<ControlEvidenceSnapshot>
  readHead(): Promise<LogPosition | null>
  publish(
    payload: Uint8Array,
    publishID: string,
    expectedHead: LogPosition | null,
  ): Promise<PublishOutcome>
  publishFailed?(opID: string, error: unknown): void
  pullToHead(): Promise<void>
  now(): number
  operationTimeoutMs?: number
  newID(): string
  emit(outcome: Outcome): void
  scheduleReport?(deadline: number): void
}

export async function enqueueOperation(
  deps: Pick<OperationDeps, 'control' | 'now' | 'operationTimeoutMs' | 'newID' | 'signal'>,
  request: OperationRequest,
): Promise<Operation> {
  const snapshot = await deps.control.load()
  const existing = snapshot.operations.find((row) => row.id === request.id)
  if (existing !== undefined) return existing
  if (
    snapshot.outcomes.some((row) => row.opID === request.id) ||
    snapshot.welcomes.some((row) => row.opID === request.id) ||
    snapshot.commitOnce?.opID === request.id ||
    // Legacy epoch-only markers cannot distinguish IDs. Consumption releases their reservation.
    (snapshot.spentSource !== null &&
      (snapshot.spentSource.opID === undefined || snapshot.spentSource.opID === request.id))
  )
    throw new OperationRejectedError('Operation ID is retained')
  const enqueuedAt = deps.now()
  const op: Operation = {
    ...request,
    seq: Math.max(0, ...snapshot.operations.map((row) => row.seq)) + 1,
    enqueuedAt,
    deadline: enqueuedAt + (deps.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS),
    stage: 'intent',
  }
  await applyResolved(deps.control, { putOperations: [op] }, deps.newID(), undefined, deps.signal)
  return op
}

export async function stepOperation(deps: OperationDeps, op: Operation): Promise<Operation | null> {
  const finish = async (result: { kind: 'lost' } | { kind: 'rejected'; reason: string }) => {
    const snapshot = await deps.control.load()
    if (!snapshot.operations.some((row) => row.id === op.id)) return null
    const outcome: Outcome = { id: deps.newID(), opID: op.id, at: deps.now(), ...result }
    await applyResolved(
      deps.control,
      { deleteOperations: [op.id], putOutcomes: [outcome] },
      deps.newID(),
      undefined,
      deps.signal,
    )
    deps.emit(outcome)
    return null
  }
  if (deps.now() >= op.deadline) return finish({ kind: 'lost' })
  if (deps.safetyHold() !== null) return op
  await deps.pullToHead()
  const snapshot = await deps.control.load()
  if (!snapshot.operations.some((row) => row.id === op.id)) return null
  if (deps.now() >= op.deadline) return finish({ kind: 'lost' })
  if (
    deps.safetyHold() !== null ||
    controlSafetyHeld(snapshot) !== null ||
    snapshot.controlHold !== null ||
    snapshot.commitOnce !== null
  )
    return op
  const result = await deps.prepareBuild(op, deps.frame)
  if (result.kind === 'rejected') return finish({ kind: 'rejected', reason: result.reason })
  if (result.kind === 'expired') return finish({ kind: 'lost' })
  return result.kind === 'saved' ? null : op
}

/** Storage-only clock work stays independent of an unfinished publication or walk. */
export function reportLiveBuild(
  deps: Pick<OperationDeps, 'control' | 'now' | 'newID' | 'signal' | 'emit'>,
): Promise<void> {
  const pending = pendingReports.get(deps.control)
  if (pending !== undefined) return pending
  const reporting = (async () => {
    const built = (await deps.control.load()).commitOnce
    if (built === null || built.reported || deps.now() < built.deadline) return
    const outcome: Outcome = { id: deps.newID(), opID: built.opID, at: deps.now(), kind: 'unknown' }
    await applyResolved(
      deps.control,
      { commitOnce: { ...built, reported: true }, putOutcomes: [outcome] },
      deps.newID(),
      undefined,
      deps.signal,
    )
    deps.emit(outcome)
  })().finally(() => pendingReports.delete(deps.control))
  pendingReports.set(deps.control, reporting)
  return reporting
}

/** Replay is transport bookkeeping. Only the ordinary walk can consume and settle this build. */
export async function stepLiveBuild(deps: OperationDeps): Promise<void> {
  let snapshot = await deps.control.load()
  let built = snapshot.commitOnce
  if (built === null) return
  if (!built.reported) deps.scheduleReport?.(built.deadline)
  await reportLiveBuild(deps)
  if (deps.safetyHold() !== null || controlSafetyHeld(snapshot) !== null) return
  try {
    await deps.pullToHead()
  } catch (error) {
    if (error instanceof Error && error.name === 'RecoveryRequiredError') return
    throw error
  }
  snapshot = await deps.control.load()
  built = snapshot.commitOnce
  if (
    built === null ||
    built.acceptedAs !== undefined ||
    built.skipped ||
    deps.now() >= built.deadline ||
    snapshot.strand !== null ||
    snapshot.cursor?.stranded ||
    snapshot.controlHold !== null
  )
    return
  const evidence = await deps.readEvidence()
  const identity = evidence.source.identity
  if (
    evidence.terminal ||
    identity === null ||
    identity.epoch !== built.epoch ||
    evidence.source.key.incarnation !== built.incarnation ||
    identity.authenticator.length !== built.authenticatorBefore.length ||
    identity.authenticator.some((byte, index) => byte !== built.authenticatorBefore[index])
  )
    return
  const expectedHead = await deps.readHead()
  let sent = publicationHeads.get(deps.control)
  if (sent?.publishID !== built.publishID) {
    sent = { publishID: built.publishID, heads: new Set() }
    publicationHeads.set(deps.control, sent)
  }
  if (sent.heads.has(expectedHead)) return
  const refreshed = { ...built, expectedHead }
  await applyResolved(deps.control, { commitOnce: refreshed }, deps.newID(), undefined, deps.signal)
  if (deps.now() >= built.deadline || deps.safetyHold() !== null) return
  try {
    const published = await deps.publish(refreshed.payload, refreshed.publishID, expectedHead)
    sent.heads.add(expectedHead)
    const current = (await deps.control.load()).commitOnce
    if (
      current?.publishID === built.publishID &&
      current.payloadDigest === built.payloadDigest &&
      current.epoch === built.epoch &&
      current.incarnation === built.incarnation
    ) {
      await applyResolved(
        deps.control,
        {
          commitOnce: {
            ...current,
            acceptedAs: current.acceptedAs ?? asLogPosition(published.sequenceID),
          },
        },
        deps.newID(),
        undefined,
        deps.signal,
      )
    }
  } catch (error) {
    deps.publishFailed?.(built.opID, error)
  }
  await deps.pullToHead()
}
