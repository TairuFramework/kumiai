import { asLogPosition, type LogPosition } from '../cursor.js'
import type { FrameControlBuild, PrepareControlResult } from './build.js'
import { controlSafetyHeld, type GroupForkEvidence, type SafetyHold } from './safety.js'
import type { ControlEvidenceSnapshot } from './search.js'
import { settleControlSlot } from './slot.js'
import { applyResolved } from './store.js'
import type {
  AppliedCommit,
  ControlAdoptionPort,
  ControlBuildRef,
  ControlChanges,
  ControlSearchPort,
  ControlSnapshot,
  ControlStore,
  Operation,
  OperationRequest,
  Outcome,
} from './types.js'

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const publicationHeads = new WeakMap<
  ControlStore,
  { build: ControlBuildRef; heads: Set<LogPosition | null> }
>()

export function revokeHeld(snapshot: ControlSnapshot): boolean {
  return snapshot.operations.some((op) => op.revokes)
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
  searchLog: ControlSearchPort['searchLog']
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
    ...(!applied.removed ? { strand: null } : {}),
    cursor: {
      position,
      epoch: applied.epoch + 1,
      ...(applied.removed ? { stranded: true } : {}),
    },
  }
}

async function settle(deps: OperationDeps, op: Operation, outcome: Outcome): Promise<null> {
  // Only delete a still-present operation and write its outcome together, under the runner lane.
  const current = await deps.control.load()
  if (
    !current.operations.some((row) => row.id === op.id) ||
    current.outcomes.some((row) => row.opID === op.id)
  )
    return null
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
  const held = (snapshot?: ControlSnapshot) =>
    deps.safetyHold() !== null || (snapshot !== undefined && controlSafetyHeld(snapshot) !== null)
  const waiting = () => (expired() ? finish(op.stage === 'intent' ? 'lost' : 'unknown') : op)
  const initial = await deps.control.load()
  if (held(initial) && initial.outcomes.some((row) => row.opID === op.id)) {
    await applyResolved(
      deps.control,
      { deleteOperations: [op.id] },
      deps.newID(),
      undefined,
      deps.signal,
    )
    return null
  }
  if (op.stage !== 'intent') {
    const applied = initial.applied.find((row) => row.epoch === op.built.epoch)
    if (applied?.payloadDigest === op.built.payloadDigest) {
      await applyResolved(
        deps.control,
        { deleteOperations: [op.id] },
        deps.newID(),
        undefined,
        deps.signal,
      )
      return null
    }
  }
  if (held(initial)) return waiting()
  if (op.stage === 'intent') {
    if (expired()) return finish('lost')
    if (held()) return waiting()
    await deps.pullToHead()
    if (held()) return waiting()
    if (expired()) return finish('lost')
    const snapshot = await deps.control.load()
    if (held(snapshot)) return waiting()
    if (snapshot.controlHold !== null) return expired() ? finish('lost') : op
    if (held()) return waiting()
    const evidence = await deps.readEvidence()
    if (held()) return waiting()
    if (evidence.terminal) return expired() ? finish('lost') : op
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
  let retryHead: LogPosition | null | undefined
  const discover = () => {
    retryHead = undefined
    return settleControlSlot({
      control: deps.control,
      signal: deps.signal,
      haltFork: deps.haltFork,
      safetyHold: deps.safetyHold,
      search: {
        searchLog: async (built, position) => {
          const found = await deps.searchLog(built, position)
          retryHead = found.kind === 'unknown' ? found.retryHead : undefined
          return found
        },
      },
      adoption: { adopt: deps.adopt },
      readEvidence: deps.readEvidence,
      now: deps.now,
      newID: deps.newID,
      emit: deps.emit,
    })
  }
  const resetIntent = async (): Promise<Operation | null> => {
    if (held()) return waiting()
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
  const retained = (await deps.control.load()).commitOnce
  const advanceAbsent = async (): Promise<Operation | null> => {
    if (held()) return waiting()
    const evidence = await deps.readEvidence()
    if (held()) return waiting()
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
    return resetIntent()
  }
  let result = await discover()
  if (result === 'landed' || result === 'superseded') return null
  if (held()) return waiting()
  if (result === 'unknown' && (expired() || op.stage === 'accepted' || retryHead === undefined))
    return expired() ? finish('unknown') : op
  const snapshot = await deps.control.load()
  if (held(snapshot)) return waiting()
  const slot = snapshot.commitOnce
  if (
    result === 'unknown' &&
    (slot === null ||
      slot.incarnation !== op.built.incarnation ||
      slot.epoch !== op.built.epoch ||
      slot.publishID !== op.built.publishID ||
      slot.payloadDigest !== op.built.payloadDigest ||
      (snapshot.controlHold !== null && snapshot.controlHold.reason !== 'acceptance-unknown'))
  )
    return expired() ? finish('unknown') : op
  if (slot === null || slot.publishID !== op.built.publishID) {
    if (held()) return waiting()
    const evidence = await deps.readEvidence()
    if (held()) return waiting()
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
    if (
      op.stage === 'built' &&
      row !== undefined &&
      row.payloadDigest !== op.built.payloadDigest &&
      !evidence.terminal &&
      snapshot.controlHold === null &&
      evidence.source.key.groupID === deps.control.key.groupID &&
      evidence.source.key.incarnation === op.built.incarnation &&
      evidence.source.identity?.incarnation === op.built.incarnation &&
      evidence.source.identity.epoch > op.built.epoch
    )
      return resetIntent()
    if (result === 'absent') return advanceAbsent()
    return expired() ? finish('unknown') : op
  }
  if (held()) return waiting()
  const evidence = await deps.readEvidence()
  if (held()) return waiting()
  const identity = evidence.source.identity
  if (
    evidence.terminal ||
    snapshot.strand !== null ||
    snapshot.cursor?.stranded === true ||
    evidence.cursor?.stranded === true ||
    identity === null ||
    evidence.source.key.incarnation !== slot.incarnation
  )
    return expired() ? finish('unknown') : op
  if (identity.epoch > slot.epoch)
    return result === 'unknown' ? (expired() ? finish('unknown') : op) : resetIntent()
  if (
    identity.epoch !== slot.epoch ||
    identity.authenticator.length !== slot.authenticatorBefore.length ||
    identity.authenticator.some((byte, index) => byte !== slot.authenticatorBefore[index])
  )
    return expired() ? finish('unknown') : op
  if (held()) return waiting()
  const expectedHead = await deps.readHead()
  if (held()) return waiting()
  if (result === 'unknown' && expectedHead !== retryHead) return waiting()
  const current = snapshot.operations.find((row) => row.id === op.id)
  if (current === undefined || snapshot.outcomes.some((row) => row.opID === op.id)) return null
  const pending = current.pendingPublish
  const outstanding =
    pending !== undefined &&
    (expectedHead === null ||
      (pending.expectedHead !== null && expectedHead <= pending.expectedHead))
  const acceptanceUnknown =
    result === 'unknown' || snapshot.controlHold?.reason === 'acceptance-unknown'
  const absentOutcome = () => finish(acceptanceUnknown || outstanding ? 'unknown' : 'lost')
  if (held()) return waiting()
  if (expired()) return absentOutcome()
  let publications = publicationHeads.get(deps.control)
  if (
    publications === undefined ||
    publications.build.incarnation !== op.built.incarnation ||
    publications.build.epoch !== op.built.epoch ||
    publications.build.publishID !== op.built.publishID ||
    publications.build.payloadDigest !== op.built.payloadDigest
  ) {
    publications = { build: { ...op.built }, heads: new Set() }
    publicationHeads.set(deps.control, publications)
  }
  // Pending copy retries survive restart; acknowledged heads also stay quiet in memory.
  if (
    (result === 'unknown' && pending?.expectedHead === expectedHead) ||
    publications.heads.has(expectedHead)
  )
    return op
  const refreshed = { ...slot, expectedHead }
  await applyResolved(deps.control, { commitOnce: refreshed }, deps.newID(), undefined, deps.signal)
  if (held()) return waiting()
  if (expired()) return absentOutcome()
  const { pendingPublish: _previous, ...withoutPending } = current
  await applyResolved(
    deps.control,
    { putOperations: [{ ...current, pendingPublish: { expectedHead } }] },
    deps.newID(),
    undefined,
    deps.signal,
  )
  if (held()) return waiting()
  if (expired()) {
    await applyResolved(
      deps.control,
      { putOperations: [outstanding ? current : withoutPending] },
      deps.newID(),
      undefined,
      deps.signal,
    )
    return absentOutcome()
  }
  if (held()) return waiting()
  try {
    const published = await deps.publish(
      refreshed.payload,
      refreshed.publishID,
      refreshed.expectedHead,
    )
    publications.heads.add(expectedHead)
    publications.heads.add(asLogPosition(published.sequenceID))
  } catch (error) {
    deps.publishFailed?.(op.id, error)
    if (
      error instanceof Error &&
      ['HeadMismatchError', 'AuthorizationDeniedError', 'RecoveryRequiredError'].includes(
        error.name,
      )
    )
      await applyResolved(
        deps.control,
        { putOperations: [outstanding ? current : withoutPending] },
        deps.newID(),
        undefined,
        deps.signal,
      )
    // A failed handoff may have committed. Discovery owns acceptance either way.
  }
  if (held()) return waiting()
  result = await discover()
  if (result === 'landed' || result === 'superseded') return null
  if (result === 'absent' && (await deps.control.load()).commitOnce === null) return advanceAbsent()
  if (held()) return waiting()
  if (expired()) {
    if (result !== 'absent' || acceptanceUnknown) return finish('unknown')
    const finalSnapshot = await deps.control.load()
    if (held(finalSnapshot)) return waiting()
    const after = finalSnapshot.operations.find((row) => row.id === op.id)
    const head = await deps.readHead()
    if (held()) return waiting()
    const attempt = after?.pendingPublish
    return finish(
      attempt !== undefined &&
        (head === null || (attempt.expectedHead !== null && head <= attempt.expectedHead))
        ? 'unknown'
        : 'lost',
    )
  }
  return op
}
