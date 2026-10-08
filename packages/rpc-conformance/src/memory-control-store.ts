import type { ConformanceAnchorSlot, ConformanceAnchorStore } from './anchor-store.js'
import type {
  ConformanceAdoptionWrite,
  ConformanceControlChanges,
  ConformanceControlSnapshot,
  ConformanceControlStore,
} from './control-store.js'

export type MemoryControlStore<Position extends string = string> =
  ConformanceControlStore<Position> & {
    anchor: ConformanceAnchorStore
    saveState(state: Uint8Array, write?: ConformanceAdoptionWrite<Position>): Promise<void>
    loadState(): Promise<Uint8Array | null>
    failNext(point: 'mid-apply' | 'mid-save'): void
    commitThenRejectNext(point: 'apply' | 'save'): void
  }

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
function applyChanges<Position extends string>(
  snapshot: ConformanceControlSnapshot<Position>,
  changes: ConformanceControlChanges<Position>,
): ConformanceControlSnapshot<Position> {
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

export function createMemoryControlStore<
  Position extends string = string,
>(): MemoryControlStore<Position> {
  let record: {
    state: Uint8Array | null
    anchor: ConformanceAnchorSlot | null
    control: ConformanceControlSnapshot<Position>
    mutationID: string | null
  } = {
    state: null,
    anchor: null,
    mutationID: null,
    control: {
      operations: [],
      rejoin: null,
      outcomes: [],
      welcomes: [],
      applied: [],
      responses: [],
      cursor: null,
    },
  }
  let failure: 'mid-apply' | 'mid-save' | undefined
  let ambiguous: 'apply' | 'save' | undefined
  const finish = (next: typeof record, point: 'apply' | 'save') => {
    if (failure === (point === 'apply' ? 'mid-apply' : 'mid-save')) {
      failure = undefined
      throw new Error('Injected transaction failure')
    }
    record = next
    if (ambiguous === point) {
      ambiguous = undefined
      const error = new Error('Committed transaction outcome unknown')
      error.name = 'StorageOutcomeUnknownError'
      throw error
    }
  }
  return {
    load: async () => structuredClone(record.control),
    lastMutation: async () => record.mutationID,
    apply: async (changes, mutationID) => {
      const next = structuredClone(record)
      next.control = applyChanges(next.control, changes)
      next.mutationID = mutationID
      finish(next, 'apply')
    },
    loadState: async () => record.state?.slice() ?? null,
    saveState: async (state, write) => {
      const next = structuredClone(record)
      next.state = state.slice()
      if (write != null) {
        next.control = applyChanges(next.control, write.changes)
        next.mutationID = write.mutationID
        if (write.anchorLanded != null && next.anchor?.pending?.advance === write.anchorLanded) {
          next.anchor.pending.landed = true
        }
      }
      finish(next, 'save')
    },
    anchor: {
      load: async () => structuredClone(record.anchor),
      save: async (slot) => {
        const next = structuredClone(record)
        next.anchor = structuredClone(slot)
        record = next
      },
    },
    failNext: (point) => {
      failure = point
    },
    commitThenRejectNext: (point) => {
      ambiguous = point
    },
  }
}
