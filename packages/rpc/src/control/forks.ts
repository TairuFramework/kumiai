import { asLogPosition } from '../cursor.js'
import type { AppliedCommit, ControlSnapshot, ForkEvidence } from './types.js'

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
