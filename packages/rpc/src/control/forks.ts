import { asLogPosition } from '../cursor.js'
import type { AppliedCommit, ControlChanges, ControlSnapshot, ForkEvidence } from './types.js'

/** Classification uses only the retained durable window. */
export function appliedRows(snapshot: ControlSnapshot): Map<number, AppliedCommit> {
  return new Map(snapshot.applied.map((row) => [row.epoch, row]))
}

export function forkEvidence(
  snapshot: ControlSnapshot,
  conflictEpoch: number,
  frameDigest: string,
): ForkEvidence {
  let sharedPosition: ForkEvidence['sharedPosition'] = null
  for (const row of snapshot.applied) {
    if (row.epoch < conflictEpoch && (sharedPosition == null || row.sequenceID > sharedPosition))
      sharedPosition = asLogPosition(row.sequenceID)
  }
  return { conflictEpoch, sharedPosition, frameDigest }
}

/** Read losing rows before the rejoin's own row can replace one at the same epoch. */
export function forkSettlement(
  snapshot: ControlSnapshot,
  conflictEpoch: number,
  rejoinRow: AppliedCommit,
): ControlChanges {
  const accepted = snapshot.operations.filter((op) => op.stage === 'accepted')
  const affected = new Set(accepted.map((op) => op.id))
  for (const row of snapshot.applied) {
    if (row.epoch >= conflictEpoch && row.opID != null) affected.add(row.opID)
  }
  const at = Date.now()
  return {
    deleteOperations: accepted.map((op) => op.id),
    putOutcomes: [...affected].map((opID) => ({ id: opID, opID, at, kind: 'unknown' })),
    deleteAppliedFrom: conflictEpoch,
    putApplied: [rejoinRow],
  }
}
