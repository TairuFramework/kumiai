import type { ConformanceAnchorSlot, ConformanceAnchorStore } from './anchor-store.js'
import type {
  ConformanceAdoptionExpected,
  ConformanceAdoptionWrite,
  ConformanceControlChanges,
  ConformanceControlSlot,
  ConformanceControlSnapshot,
  ConformanceControlStore,
  ConformanceEpochIdentity,
  ConformanceGroupKey,
  ConformanceSaveControlBuild,
} from './control-store.js'
import { decodeControlFixtureState } from './control-store.js'

export type MemoryControlStore<Position extends string = string> =
  ConformanceControlStore<Position> & {
    saveBuilt: ConformanceSaveControlBuild<Position>
    loadVersion(): Promise<number>
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

type Context =
  | {
      kind: 'build'
      source: ConformanceAdoptionExpected
      queueHeadID: string
      checkpoint: string | null
    }
  | {
      kind: 'adoption'
      before: ConformanceEpochIdentity
      after: ConformanceEpochIdentity | null
    }
  | { kind: 'retirement'; key: ConformanceGroupKey }
  | { kind: 'head'; source: ConformanceEpochIdentity }

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left instanceof Uint8Array && right instanceof Uint8Array)
    return left.length === right.length && left.every((value, index) => value === right[index])
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((value, index) => equal(value, right[index]))
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(
      ([key, value]) => Object.hasOwn(right, key) && equal(value, Reflect.get(right, key)),
    )
  )
}
function matches(slot: ConformanceControlSlot, identity: ConformanceEpochIdentity): boolean {
  return (
    slot.epoch === identity.epoch &&
    slot.incarnation === identity.incarnation &&
    equal(slot.authenticatorBefore, identity.authenticator)
  )
}
function guard(
  previous: ConformanceControlSlot | null,
  next: ConformanceControlSlot | null,
  context: Context | null,
): void {
  if (equal(previous, next)) return
  switch (context?.kind) {
    case 'build': {
      const source = context.source.identity
      if (
        next !== null &&
        source !== null &&
        equal(context.source.key, { groupID: source.groupID, incarnation: source.incarnation }) &&
        matches(next, source) &&
        next.opID === context.queueHeadID &&
        next.searchFrom === context.checkpoint &&
        (previous === null ||
          previous.incarnation < source.incarnation ||
          (previous.incarnation === source.incarnation && previous.epoch < source.epoch))
      )
        return
      break
    }
    case 'head': {
      if (previous === null || next === null || !matches(previous, context.source)) break
      const { expectedHead: _a, ...a } = previous
      const { expectedHead: _b, ...b } = next
      if (equal(a, b)) return
      break
    }
    case 'adoption':
      if (
        previous !== null &&
        next === null &&
        matches(previous, context.before) &&
        context.after !== null &&
        context.after.groupID === context.before.groupID &&
        context.after.incarnation === context.before.incarnation &&
        context.after.epoch > context.before.epoch
      )
        return
      break
    case 'retirement':
      if (previous !== null && next === null && previous.incarnation === context.key.incarnation)
        return
  }
  throw new Error('Unverified commit-once change')
}

/** Mutates the transaction's private copy, independently of the RPC reducer. */
function mutateControl<Position extends string>(
  snapshot: ConformanceControlSnapshot<Position>,
  changes: ConformanceControlChanges<Position>,
  context: Context | null = null,
): void {
  const owned = cloneValue(changes)
  const slot = owned.commitOnce === undefined ? snapshot.commitOnce : owned.commitOnce
  guard(snapshot.commitOnce, slot, context)
  const proof =
    owned.commitOnceAcceptance === undefined
      ? owned.commitOnce === null
        ? null
        : snapshot.commitOnceAcceptance
      : owned.commitOnceAcceptance
  if (
    proof === null &&
    snapshot.commitOnceAcceptance !== null &&
    snapshot.commitOnce !== null &&
    slot !== null &&
    (context?.kind !== 'build' || equal(snapshot.commitOnce, slot))
  )
    throw new Error('Retained acceptance')
  if (
    proof !== null &&
    (slot === null ||
      proof.source.identity === null ||
      !matches(slot, proof.source.identity) ||
      !equal(proof.source.key, {
        groupID: proof.source.identity.groupID,
        incarnation: proof.source.identity.incarnation,
      }) ||
      proof.from !== slot.searchFrom ||
      proof.payloadDigest !== slot.payloadDigest)
  )
    throw new Error('Unbound acceptance')
  if (
    !equal(snapshot.commitOnce, slot) &&
    slot !== null &&
    context?.kind === 'build' &&
    snapshot.commitOnceAcceptance !== null &&
    owned.commitOnceAcceptance !== null
  )
    throw new Error('Prior acceptance remains')
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
  if (owned.commitOnce !== undefined) snapshot.commitOnce = owned.commitOnce
  snapshot.commitOnceAcceptance = proof
  if (owned.controlHold !== undefined) snapshot.controlHold = owned.controlHold
  if (owned.strand !== undefined) snapshot.strand = owned.strand
  if (owned.cursor !== undefined) snapshot.cursor = owned.cursor
  snapshot.operations.sort((a, b) => a.seq - b.seq)
  snapshot.applied.sort((a, b) => a.epoch - b.epoch)
}

export function createMemoryControlStore<Position extends string = string>(
  key: ConformanceGroupKey,
): MemoryControlStore<Position> {
  const fixedKey = { ...key }
  let record: {
    state: Uint8Array | null
    initialIdentity: ConformanceEpochIdentity | null
    version: number
    anchor: ConformanceAnchorSlot | null
    control: ConformanceControlSnapshot<Position>
    mutationID: string | null
  } = {
    state: null,
    initialIdentity: null,
    version: 0,
    anchor: null,
    mutationID: null,
    control: {
      commitOnce: null,
      commitOnceAcceptance: null,
      controlHold: null,
      strand: null,
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
    get key() {
      return { ...fixedKey }
    },
    load: async () => cloneValue(record.control),
    lastMutation: async () => record.mutationID,
    apply: async (changes, mutationID) => {
      const next = cloneValue(record)
      const source = next.state === null ? null : decodeControlFixtureState(next.state)
      if (
        changes.commitOnceAcceptance != null &&
        !equal(changes.commitOnceAcceptance.source.key, fixedKey)
      )
        throw new Error('Proof key mismatch')
      mutateControl(next.control, changes, source === null ? null : { kind: 'head', source })
      next.mutationID = mutationID
      finish(next, 'apply')
    },
    loadVersion: async () => record.version,
    saveBuilt: async (intent, built, expected, mutationID) => {
      const next = cloneValue(record)
      const identity = next.state === null ? null : decodeControlFixtureState(next.state)
      if (
        next.control.controlHold !== null ||
        !equal(expected.key, fixedKey) ||
        !equal(identity, expected.identity) ||
        next.version !== expected.stateVersion ||
        (next.control.cursor === null && !equal(next.initialIdentity, identity)) ||
        !equal(next.control.operations[0], intent) ||
        built.searchFrom !== (next.control.cursor?.position ?? null) ||
        (next.control.cursor !== null &&
          (next.control.cursor.epoch !== identity?.epoch ||
            next.control.cursor.stranded ||
            next.control.cursor.fork))
      )
        return 'moved'
      const previous = next.control.commitOnce
      if (
        previous !== null &&
        previous.incarnation === fixedKey.incarnation &&
        previous.epoch >= (identity?.epoch ?? 0)
      )
        return 'occupied'
      mutateControl(next.control, {
        putOperations: [
          {
            ...intent,
            stage: 'built',
            built: {
              incarnation: built.incarnation,
              epoch: built.epoch,
              publishID: built.publishID,
              payloadDigest: built.payloadDigest,
            },
          },
        ],
      })
      mutateControl(
        next.control,
        { commitOnce: built, commitOnceAcceptance: null },
        {
          kind: 'build',
          source: expected,
          queueHeadID: intent.id,
          checkpoint: next.control.cursor?.position ?? null,
        },
      )
      next.mutationID = mutationID
      finish(next, 'apply')
      return 'saved'
    },
    loadState: async () => record.state?.slice() ?? null,
    saveState: async (state, write) => {
      const next = cloneValue(record)
      const before = next.state === null ? null : decodeControlFixtureState(next.state)
      const after = decodeControlFixtureState(state)
      if (next.state === null) next.initialIdentity = cloneValue(after)
      next.state = state.slice()
      next.version++
      if (write != null) {
        mutateControl(
          next.control,
          write.changes,
          before === null
            ? null
            : after !== null &&
                after.groupID === before.groupID &&
                after.incarnation > before.incarnation
              ? {
                  kind: 'retirement',
                  key: { groupID: before.groupID, incarnation: before.incarnation },
                }
              : {
                  kind: 'adoption',
                  before,
                  after,
                },
        )
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
