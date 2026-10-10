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

function removeRows<Row>(rows: Array<Row>, remove: (row: Row) => boolean): void {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    if (row !== undefined && remove(row)) rows.splice(index, 1)
  }
}

function upsertRows<Row, Key>(
  rows: Array<Row>,
  puts: Array<Row> | undefined,
  key: (row: Row) => Key,
): void {
  for (const put of puts ?? []) {
    const index = rows.findIndex((row) => key(row) === key(put))
    if (index < 0) rows.push(put)
    else rows[index] = put
  }
}

function cloneValue<TValue>(value: TValue): TValue {
  if (value instanceof Uint8Array) return Uint8Array.from(value) as TValue
  if (Array.isArray(value)) return value.map(cloneValue) as TValue
  if (value !== null && typeof value === 'object') {
    if (value instanceof Map) {
      return new Map([...value].map(([key, item]) => [cloneValue(key), cloneValue(item)])) as TValue
    }
    const copy: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) copy[key] = cloneValue(child)
    return copy as TValue
  }
  return value
}

/** Mutates the transaction's private copy, independently of the RPC reducer. */
function mutateControl<Position extends string>(
  snapshot: ConformanceControlSnapshot<Position>,
  changes: ConformanceControlChanges<Position>,
): void {
  const owned = cloneValue(changes)
  removeRows(snapshot.operations, (row) => owned.deleteOperations?.includes(row.id) === true)
  removeRows(snapshot.outcomes, (row) => owned.deleteOutcomes?.includes(row.id) === true)
  removeRows(snapshot.welcomes, (row) => owned.deleteWelcomes?.includes(row.opID) === true)
  removeRows(snapshot.applied, (row) => {
    return (
      (owned.deleteAppliedFrom != null && row.epoch >= owned.deleteAppliedFrom) ||
      (owned.deleteAppliedBelow != null && row.epoch < owned.deleteAppliedBelow)
    )
  })
  removeRows(snapshot.responses, (row) => {
    return owned.deleteResponsesBelow != null && row.epoch < owned.deleteResponsesBelow
  })
  if (owned.deleteRejoin) snapshot.rejoin = null

  upsertRows(snapshot.operations, owned.putOperations, (row) => row.id)
  upsertRows(snapshot.outcomes, owned.putOutcomes, (row) => row.id)
  upsertRows(snapshot.welcomes, owned.putWelcomes, (row) => row.opID)
  upsertRows(snapshot.applied, owned.putApplied, (row) => row.epoch)
  upsertRows(snapshot.responses, owned.putResponses, (row) => row.position)
  if (owned.putRejoin !== undefined) snapshot.rejoin = owned.putRejoin
  if (owned.cursor !== undefined) snapshot.cursor = owned.cursor
  snapshot.operations.sort((a, b) => a.seq - b.seq)
  snapshot.applied.sort((a, b) => a.epoch - b.epoch)
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
    load: async () => cloneValue(record.control),
    lastMutation: async () => record.mutationID,
    apply: async (changes, mutationID) => {
      const next = cloneValue(record)
      mutateControl(next.control, changes)
      next.mutationID = mutationID
      finish(next, 'apply')
    },
    loadState: async () => record.state?.slice() ?? null,
    saveState: async (state, write) => {
      const next = cloneValue(record)
      next.state = state.slice()
      if (write != null) {
        mutateControl(next.control, write.changes)
        next.mutationID = write.mutationID
        if (write.anchorLanded != null && next.anchor?.pending?.advance === write.anchorLanded) {
          next.anchor.pending.landed = true
        }
      }
      finish(next, 'save')
    },
    anchor: {
      load: async () => cloneValue(record.anchor),
      save: async (slot) => {
        const next = cloneValue(record)
        next.anchor = cloneValue(slot)
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
