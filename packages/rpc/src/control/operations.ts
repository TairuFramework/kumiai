import { asLogPosition, type LogPosition } from '../cursor.js'
import type { FrameControlBuild, PrepareControlResult } from './build.js'
import type { ControlEvidenceSnapshot } from './search.js'
import { settleControlSlot } from './slot.js'
import { applyResolved } from './store.js'
import type {
  AppliedCommit,
  ControlAdoptionPort,
  ControlChanges,
  ControlSearchPort,
  ControlSnapshot,
  ControlStore,
  Operation,
  OperationRequest,
  Outcome,
} from './types.js'

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000

export function revokeHeld(snapshot: ControlSnapshot): boolean {
  return snapshot.operations.some((op) => op.revokes)
}
export type { HostBuilt } from './types.js'
export type PublishOutcome = { sequenceID: string }
export type OperationDeps = {
  control: ControlStore
  signal?: AbortSignal
  prepareBuild(op: Operation, frame: FrameControlBuild): Promise<PrepareControlResult>
  adopt: ControlAdoptionPort['adopt']
  frame: FrameControlBuild
  searchLog: ControlSearchPort['searchLog']
  readEvidence(): Promise<ControlEvidenceSnapshot>
  readHead(): Promise<LogPosition | null>
  publish(
    payload: Uint8Array,
    publishID: string,
    expectedHead: LogPosition | null,
  ): Promise<PublishOutcome>
  pullToHead(): Promise<void>
  now(): number
  operationTimeoutMs?: number
  newID(): string
  emit(outcome: Outcome): void
}

export async function enqueueOperation(
  deps: Pick<OperationDeps, 'control' | 'now' | 'operationTimeoutMs' | 'newID' | 'signal'>,
  request: OperationRequest,
): Promise<Operation> {
  const snapshot = await deps.control.load()
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

/** Deterministic repair identity; the runner stamps a new outcome with its settlement time. */
export function landedChanges(
  op: Operation,
  position: LogPosition,
  applied: AppliedCommit,
): ControlChanges {
  return {
    deleteOperations: [op.id],
    putOutcomes: [{ id: op.id, opID: op.id, at: op.enqueuedAt, kind: 'landed', position }],
    putApplied: [applied],
    cursor: {
      position,
      epoch: applied.epoch + 1,
      ...(applied.removed ? { stranded: true } : {}),
    },
  }
}

async function settle(deps: OperationDeps, op: Operation, outcome: Outcome): Promise<null> {
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

export async function stepOperation(deps: OperationDeps, op: Operation): Promise<Operation | null> {
  const finish = (kind: 'lost' | 'unknown') =>
    settle(deps, op, { id: op.id, opID: op.id, at: deps.now(), kind })
  const expired = () => deps.now() >= op.deadline
  if (op.stage === 'intent') {
    if (expired()) return finish('lost')
    await deps.pullToHead()
    if (expired()) return finish('lost')
    const snapshot = await deps.control.load()
    if (snapshot.controlHold !== null) return expired() ? finish('unknown') : op
    if ((await deps.readEvidence()).terminal) return expired() ? finish('unknown') : op
    if (expired()) return finish('lost')
    const result = await deps.prepareBuild(op, deps.frame)
    if (result.kind === 'rejected')
      return settle(deps, op, {
        id: op.id,
        opID: op.id,
        at: deps.now(),
        kind: 'rejected',
        reason: result.reason,
      })
    if (result.kind === 'expired') return finish('lost')
    return result.kind === 'saved' ? result.operation : op
  }
  const discover = () =>
    settleControlSlot({
      control: deps.control,
      search: { searchLog: deps.searchLog },
      adoption: { adopt: deps.adopt },
      readEvidence: deps.readEvidence,
      now: deps.now,
      newID: deps.newID,
      emit: deps.emit,
    })
  const retained = (await deps.control.load()).commitOnce
  const advanceAbsent = async (): Promise<Operation | null> => {
    const evidence = await deps.readEvidence()
    const identity = evidence.source.identity
    if (
      retained === null ||
      retained.publishID !== op.built.publishID ||
      retained.payloadDigest !== op.built.payloadDigest ||
      evidence.terminal ||
      identity === null ||
      evidence.source.key.groupID !== deps.control.key.groupID ||
      identity.incarnation !== retained.incarnation ||
      identity.epoch <= retained.epoch
    )
      return expired() ? finish('unknown') : op
    if (expired()) return finish('lost')
    const next: Operation = {
      id: op.id,
      kind: op.kind,
      revokes: op.revokes,
      body: op.body,
      seq: op.seq,
      enqueuedAt: op.enqueuedAt,
      deadline: op.deadline,
      stage: 'intent',
    }
    await applyResolved(
      deps.control,
      { putOperations: [next] },
      deps.newID(),
      undefined,
      deps.signal,
    )
    return next
  }
  let result = await discover()
  if (result === 'landed' || result === 'superseded') return null
  if (result === 'unknown') return expired() ? finish('unknown') : op
  const snapshot = await deps.control.load()
  const slot = snapshot.commitOnce
  if (slot === null || slot.publishID !== op.built.publishID) {
    const evidence = await deps.readEvidence()
    const row = evidence.applied.find((row) => row.epoch === op.built.epoch)
    if (row?.payloadDigest === op.built.payloadDigest) {
      await applyResolved(
        deps.control,
        { deleteOperations: [op.id] },
        deps.newID(),
        undefined,
        deps.signal,
      )
      return null
    }
    if (result === 'absent') return advanceAbsent()
    return expired() ? finish('unknown') : op
  }
  const evidence = await deps.readEvidence()
  const identity = evidence.source.identity
  if (
    evidence.terminal ||
    identity === null ||
    evidence.source.key.incarnation !== slot.incarnation
  )
    return expired() ? finish('unknown') : op
  if (identity.epoch > slot.epoch) {
    if (expired()) return finish('lost')
    const next: Operation = {
      id: op.id,
      kind: op.kind,
      revokes: op.revokes,
      body: op.body,
      seq: op.seq,
      enqueuedAt: op.enqueuedAt,
      deadline: op.deadline,
      stage: 'intent',
    }
    await applyResolved(
      deps.control,
      { putOperations: [next] },
      deps.newID(),
      undefined,
      deps.signal,
    )
    return next
  }
  if (snapshot.controlHold?.reason === 'acceptance-unknown')
    await applyResolved(deps.control, { controlHold: null }, deps.newID(), undefined, deps.signal)
  if (expired()) return finish('lost')
  const expectedHead = await deps.readHead()
  if (expired()) return finish('lost')
  const refreshed = { ...slot, expectedHead }
  await applyResolved(deps.control, { commitOnce: refreshed }, deps.newID(), undefined, deps.signal)
  if (expired()) return finish('lost')
  try {
    const published = await deps.publish(
      refreshed.payload,
      refreshed.publishID,
      refreshed.expectedHead,
    )
    asLogPosition(published.sequenceID)
  } catch {
    // A failed handoff may have committed. Discovery owns acceptance either way.
  }
  result = await discover()
  if (result === 'landed' || result === 'superseded') return null
  if (result === 'absent' && (await deps.control.load()).commitOnce === null) return advanceAbsent()
  if (expired()) return finish(result === 'absent' ? 'lost' : 'unknown')
  return op
}
