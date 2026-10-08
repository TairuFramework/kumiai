import { ControlWriteNotCommittedError, StorageOutcomeUnknownError } from '../errors.js'
import type { ControlChanges, ControlSnapshot, ControlStore } from './types.js'

function putRows<Row, Key>(
  rows: Array<Row>,
  puts: Array<Row> | undefined,
  key: (row: Row) => Key,
): Array<Row> {
  const result = new Map(rows.map((row) => [key(row), row]))
  for (const row of puts ?? []) result.set(key(row), row)
  return [...result.values()]
}

/** Deletes precede puts so a replacement at the fork epoch survives settlement. */
export function applyChanges(snapshot: ControlSnapshot, changes: ControlChanges): ControlSnapshot {
  return structuredClone({
    operations: putRows(
      snapshot.operations.filter((row) => !changes.deleteOperations?.includes(row.id)),
      changes.putOperations,
      (row) => row.id,
    ).sort((a, b) => a.seq - b.seq),
    rejoin: changes.putRejoin ?? (changes.deleteRejoin ? null : snapshot.rejoin),
    outcomes: putRows(
      snapshot.outcomes.filter((row) => !changes.deleteOutcomes?.includes(row.id)),
      changes.putOutcomes,
      (row) => row.id,
    ),
    welcomes: putRows(
      snapshot.welcomes.filter((row) => !changes.deleteWelcomes?.includes(row.opID)),
      changes.putWelcomes,
      (row) => row.opID,
    ),
    applied: putRows(
      snapshot.applied.filter(
        (row) => changes.deleteAppliedFrom == null || row.epoch < changes.deleteAppliedFrom,
      ),
      changes.putApplied,
      (row) => row.epoch,
    ).sort((a, b) => a.epoch - b.epoch),
    responses: putRows(
      snapshot.responses.filter(
        (row) => changes.deleteResponsesBelow == null || row.epoch >= changes.deleteResponsesBelow,
      ),
      changes.putResponses,
      (row) => row.position,
    ),
    cursor: changes.cursor === undefined ? snapshot.cursor : changes.cursor,
  })
}

export function controlSettled(snapshot: ControlSnapshot): boolean {
  return (
    snapshot.operations.length === 0 &&
    snapshot.rejoin === null &&
    snapshot.outcomes.length === 0 &&
    snapshot.welcomes.length === 0
  )
}

/** The sole writer must remain paused until the ambiguous write has been read back. */
export async function applyResolved(
  store: ControlStore,
  changes: ControlChanges,
  mutationID: string,
  sleep: (delay: number) => Promise<void> = (delay) =>
    new Promise((resolve) => setTimeout(resolve, delay)),
): Promise<void> {
  try {
    await store.apply(changes, mutationID)
    return
  } catch (error) {
    if (
      !(error instanceof StorageOutcomeUnknownError) &&
      !(error instanceof Error && error.name === 'StorageOutcomeUnknownError')
    )
      throw error
  }
  let delay = 100
  for (;;) {
    let last: string | null
    try {
      last = await store.lastMutation()
    } catch {
      await sleep(delay)
      delay = Math.min(delay * 2, 15_000)
      continue
    }
    if (last !== mutationID) throw new ControlWriteNotCommittedError()
    return
  }
}

export function pruneWindow(snapshot: ControlSnapshot, newestEpoch: number): ControlChanges {
  const oldestEpoch = newestEpoch - 63
  const changes: ControlChanges = {}
  if (snapshot.applied.some((row) => row.epoch < oldestEpoch)) {
    // The port deletes an upper range, so replace the retained window in one apply.
    changes.deleteAppliedFrom = 0
    changes.putApplied = snapshot.applied.filter((row) => row.epoch >= oldestEpoch)
  }
  if (snapshot.responses.some((row) => row.epoch < oldestEpoch)) {
    changes.deleteResponsesBelow = oldestEpoch
  }
  return changes
}
