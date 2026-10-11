import { getAbortReason, throwIfAborted } from '../abort.js'
import type { LogPosition } from '../cursor.js'
import {
  ControlWriteNotCommittedError,
  PeerDisposedError,
  StorageOutcomeUnknownError,
} from '../errors.js'
import type {
  AdoptionExpected,
  ControlChanges,
  ControlSlot,
  ControlSnapshot,
  ControlStore,
  EpochIdentity,
  Outcome,
} from './types.js'

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

export type CommitOnceWriteContext =
  | { kind: 'build'; source: AdoptionExpected; queueHeadID: string; checkpoint: LogPosition | null }
  | { kind: 'adoption'; before: EpochIdentity; after: EpochIdentity | null; retired: boolean }
  | { kind: 'head'; source: EpochIdentity }

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left instanceof Uint8Array && right instanceof Uint8Array)
    return left.length === right.length && left.every((byte, index) => byte === right[index])
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
    )
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false
  const entries = Object.entries(left)
  return (
    entries.length === Object.keys(right).length &&
    entries.every(
      ([key, value]) => Object.hasOwn(right, key) && sameValue(value, Reflect.get(right, key)),
    )
  )
}

function slotSource(slot: ControlSlot, source: EpochIdentity): boolean {
  return (
    slot.incarnation === source.incarnation &&
    slot.epoch === source.epoch &&
    sameValue(slot.authenticatorBefore, source.authenticator)
  )
}

export function assertCommitOnceChange(
  previous: ControlSlot | null,
  next: ControlSlot | null,
  context: CommitOnceWriteContext | null,
): void {
  if (sameValue(previous, next)) return
  if (context?.kind === 'build' && next !== null) {
    const identity = context.source.identity
    if (
      identity !== null &&
      sameValue(context.source.key, {
        groupID: identity.groupID,
        incarnation: identity.incarnation,
      }) &&
      slotSource(next, identity) &&
      next.opID === context.queueHeadID &&
      next.searchFrom === context.checkpoint &&
      (previous === null ||
        previous.incarnation < identity.incarnation ||
        (previous.incarnation === identity.incarnation && previous.epoch < identity.epoch))
    )
      return
  }
  if (
    context?.kind === 'adoption' &&
    previous !== null &&
    next === null &&
    slotSource(previous, context.before) &&
    (context.retired ||
      (context.after !== null &&
        context.after.groupID === context.before.groupID &&
        context.after.incarnation === context.before.incarnation &&
        context.after.epoch > context.before.epoch))
  )
    return
  if (
    context?.kind === 'head' &&
    previous !== null &&
    next !== null &&
    slotSource(previous, context.source)
  ) {
    const { expectedHead: _before, ...immutableBefore } = previous
    const { expectedHead: _after, ...immutableAfter } = next
    if (sameValue(immutableBefore, immutableAfter)) return
  }
  throw new Error('Commit-once slot change requires provider-verified context')
}

/** Deletes precede puts so a replacement at the fork epoch survives settlement. */
export function applyChanges(
  snapshot: ControlSnapshot,
  changes: ControlChanges,
  context: CommitOnceWriteContext | null = null,
): ControlSnapshot {
  const nextSlot = changes.commitOnce === undefined ? snapshot.commitOnce : changes.commitOnce
  assertCommitOnceChange(snapshot.commitOnce, nextSlot, context)
  const acceptance = changes.commitOnceAcceptance
  if (acceptance !== undefined && !sameValue(acceptance, snapshot.commitOnceAcceptance)) {
    if (acceptance === null) {
      if (
        snapshot.commitOnce !== null &&
        nextSlot !== null &&
        (context?.kind !== 'build' || sameValue(snapshot.commitOnce, nextSlot))
      )
        throw new Error('Cannot clear retained acceptance')
    } else {
      const identity = acceptance.source.identity
      if (
        nextSlot === null ||
        identity === null ||
        !slotSource(nextSlot, identity) ||
        !sameValue(acceptance.source.key, {
          groupID: identity.groupID,
          incarnation: identity.incarnation,
        }) ||
        acceptance.from !== nextSlot.searchFrom ||
        acceptance.payloadDigest !== nextSlot.payloadDigest
      )
        throw new Error('Acceptance does not bind the occupied slot')
    }
  }
  if (
    !sameValue(snapshot.commitOnce, nextSlot) &&
    nextSlot !== null &&
    context?.kind === 'build' &&
    snapshot.commitOnceAcceptance !== null &&
    changes.commitOnceAcceptance !== null
  )
    throw new Error('Replacement must clear prior acceptance')
  return cloneControlValue({
    commitOnce: changes.commitOnce === undefined ? snapshot.commitOnce : changes.commitOnce,
    commitOnceAcceptance:
      changes.commitOnceAcceptance === undefined
        ? snapshot.commitOnceAcceptance
        : changes.commitOnceAcceptance,
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
    onAbort = () => reject(getAbortReason(signal))
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
