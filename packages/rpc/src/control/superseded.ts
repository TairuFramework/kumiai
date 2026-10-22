import type { LogPosition } from '../cursor.js'
import { deleteOperationChanges } from './store.js'
import type { ControlChanges, ControlSnapshot, FirstValidCommit, Operation } from './types.js'

export type SupersessionEvidence =
  | { kind: 'superseded'; winner: LogPosition }
  | { kind: 'applied'; winner: LogPosition }
  | { kind: 'absent'; epochAdvanced?: boolean }
  | { kind: 'gap' | 'unavailable' }

export type SupersededDecision = 'pending' | 'lost' | 'unknown'

/** D4: a hub acknowledgement is positive acceptance, never proof of first-valid ordering. */
export function decideSuperseded(input: {
  operation: Operation
  observedHead?: LogPosition | null
  acceptance: FirstValidCommit | null
  acceptanceUnknown?: boolean
  evidence: SupersessionEvidence
  now: number
}): SupersededDecision {
  const { operation: op, acceptance, evidence, now } = input
  let acceptedAt: LogPosition | undefined
  let head = input.observedHead
  // An earlier retained copy still needs ordering proof; any later ack can resolve a CAS.
  for (const position of [
    op.hubAcceptedAt,
    acceptance?.position,
    op.stage === 'accepted' ? op.acceptedAs : undefined,
  ]) {
    if (position === undefined) continue
    if (acceptedAt === undefined || position < acceptedAt) acceptedAt = position
    if (head == null || position > head) head = position
  }
  const positive = acceptedAt !== undefined || op.stage === 'accepted' || acceptance !== null
  const acceptanceUnknown =
    input.acceptanceUnknown === true || op.reconciliation?.uncertainty !== undefined
  const pending = op.pendingPublish
  if (
    pending !== undefined &&
    (head == null || (pending.expectedHead !== null && head <= pending.expectedHead))
  )
    return 'pending'
  if (op.stage === 'intent') return now >= op.deadline ? 'lost' : 'pending'
  if (
    (evidence.kind === 'superseded' || evidence.kind === 'applied') &&
    !acceptanceUnknown &&
    (acceptedAt !== undefined ? evidence.winner < acceptedAt : !positive)
  )
    return 'lost'
  if (
    !positive &&
    !acceptanceUnknown &&
    evidence.kind === 'absent' &&
    (evidence.epochAdvanced || now >= op.deadline)
  )
    return 'lost'
  return now >= op.deadline ? 'unknown' : 'pending'
}

/** Unknown keeps the operation (and its reconciliation material); loss cancels its Welcome. */
export function supersededChanges(
  snapshot: ControlSnapshot,
  operation: Operation,
  decision: SupersededDecision,
  at: number,
): ControlChanges {
  const previous = snapshot.outcomes.filter((row) => row.opID === operation.id)
  if (previous.some((row) => row.kind === 'lost' || row.kind === 'landed'))
    return deleteOperationChanges(snapshot, [operation.id], true)
  if (decision === 'pending') return {}
  if (
    decision === 'unknown' &&
    (operation.unknownReported || previous.some((row) => row.kind === 'unknown'))
  )
    return {}
  return {
    ...(decision === 'lost'
      ? deleteOperationChanges(snapshot, [operation.id], true)
      : { putOperations: [{ ...operation, unknownReported: true }] }),
    deleteOutcomes: previous.map((row) => row.id),
    putOutcomes: [{ id: operation.id, opID: operation.id, at, kind: decision }],
  }
}
