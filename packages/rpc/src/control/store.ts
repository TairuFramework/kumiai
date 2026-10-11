import { throwIfAborted } from '../abort.js'
import {
  ControlWriteNotCommittedError,
  PeerDisposedError,
  StorageOutcomeUnknownError,
} from '../errors.js'
import type { ControlChanges, ControlSnapshot, ControlStore, Outcome } from './types.js'

function putRows<Row, Key>(
  rows: Array<Row>,
  puts: Array<Row> | undefined,
  key: (row: Row) => Key,
): Array<Row> {
  const result = new Map(rows.map((row) => [key(row), row]))
  for (const row of puts ?? []) result.set(key(row), row)
  return [...result.values()]
}

function cloneControlValue<TValue>(value: TValue): TValue {
  if (value instanceof Uint8Array) return Uint8Array.from(value) as TValue
  if (Array.isArray(value)) return value.map(cloneControlValue) as TValue
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) copy[key] = cloneControlValue(child)
    return copy as TValue
  }
  return value
}

/** Deletes precede puts so a replacement at the fork epoch survives settlement. */
export function applyChanges(snapshot: ControlSnapshot, changes: ControlChanges): ControlSnapshot {
  return cloneControlValue({
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
        (row) =>
          (changes.deleteAppliedFrom == null || row.epoch < changes.deleteAppliedFrom) &&
          (changes.deleteAppliedBelow == null || row.epoch >= changes.deleteAppliedBelow),
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

/** The host co-commits this reset with the joined state and a cleared anchor slot. */
export function readmissionChanges(snapshot: ControlSnapshot): ControlChanges {
  const at = Date.now()
  const outcomes: Array<Outcome> = snapshot.operations.map(({ id }) => ({
    id,
    opID: id,
    at,
    kind: 'unknown',
  }))
  if (snapshot.rejoin != null) {
    outcomes.push({ id: snapshot.rejoin.id, opID: null, at, kind: 'unknown' })
  }
  let newestResponseEpoch = 0
  for (const { epoch } of snapshot.responses) {
    newestResponseEpoch = Math.max(newestResponseEpoch, epoch)
  }
  return {
    deleteOperations: snapshot.operations.map(({ id }) => id),
    deleteRejoin: true,
    putOutcomes: outcomes,
    deleteAppliedFrom: 0,
    deleteResponsesBelow: newestResponseEpoch + 1,
    cursor: null,
  }
}

/** The sole writer must remain paused until the ambiguous write has been read back. */
export async function applyResolved(
  store: ControlStore,
  changes: ControlChanges,
  mutationID: string,
  sleep?: (delay: number) => Promise<void>,
  signal?: AbortSignal,
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
    throwIfAborted(signal)
    let last: string | null
    try {
      last = await abortable(store.lastMutation(), signal)
    } catch (error) {
      throwIfAborted(signal)
      if (
        error instanceof PeerDisposedError ||
        (error instanceof Error && error.name === 'PeerDisposedError')
      )
        throw error
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await abortable(
          sleep?.(delay) ??
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, delay)
            }),
          signal,
        )
      } finally {
        if (timer != null) clearTimeout(timer)
      }
      delay = Math.min(delay * 2, 15_000)
      continue
    }
    if (last !== mutationID) throw new ControlWriteNotCommittedError()
    return
  }
}

async function abortable<TValue>(promise: Promise<TValue>, signal?: AbortSignal): Promise<TValue> {
  if (signal == null) return await promise
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export function pruneWindow(snapshot: ControlSnapshot, newestEpoch: number): ControlChanges {
  const oldestEpoch = newestEpoch - 63
  const changes: ControlChanges = {}
  if (snapshot.applied.some((row) => row.epoch < oldestEpoch)) {
    changes.deleteAppliedBelow = oldestEpoch
  }
  if (snapshot.responses.some((row) => row.epoch < oldestEpoch)) {
    changes.deleteResponsesBelow = oldestEpoch
  }
  return changes
}
