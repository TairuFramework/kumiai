import type { AppliedCommit, ControlSnapshot } from './types.js'

/** Classification uses only the retained durable window. */
export function appliedRows(snapshot: ControlSnapshot): Map<number, AppliedCommit> {
  return new Map(snapshot.applied.map((row) => [row.epoch, row]))
}
