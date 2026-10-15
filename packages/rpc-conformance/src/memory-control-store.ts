import type { ConformanceAnchorSlot, ConformanceAnchorStore } from './anchor-store.js'
import type {
  ConformanceAcceptedRejoinSettlement,
  ConformanceAdoptionExpected,
  ConformanceAdoptionWrite,
  ConformanceControlChanges,
  ConformanceControlSlot,
  ConformanceControlSnapshot,
  ConformanceControlStore,
  ConformanceEpochIdentity,
  ConformanceForkHalt,
  ConformanceGroupKey,
  ConformanceRecoveryUnavailableEvent,
  ConformanceSafetyHold,
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

function raiseFloor(current: number | null, epoch: number): number {
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    (current !== null && (!Number.isSafeInteger(current) || current < 0))
  )
    throw new TypeError('Invalid recovery epoch floor')
  return current === null ? epoch : Math.max(current, epoch)
}

function foldSettlements<Position extends string>(
  previous: Array<ConformanceAcceptedRejoinSettlement<Position>>,
  puts: Array<ConformanceAcceptedRejoinSettlement<Position>> = [],
): Array<ConformanceAcceptedRejoinSettlement<Position>> {
  const rows = new Map<string, ConformanceAcceptedRejoinSettlement<Position>>()
  for (const value of [...previous, ...puts]) {
    const { sourceKey, target, searchFrom } = value.origin
    const head = target.captureHead
    if (head !== null && (typeof head !== 'string' || head.length === 0 || head.length > 64))
      throw new TypeError('Invalid recovery capture head')
    const key = JSON.stringify([sourceKey.groupID, sourceKey.incarnation])
    rows.set(key, {
      kind: value.kind,
      id: value.id,
      digest: value.digest,
      payloadDigest: value.payloadDigest,
      epochAfter: value.epochAfter,
      acceptedEpoch: value.acceptedEpoch,
      leafDigest: value.leafDigest,
      origin: {
        sourceKey: { groupID: sourceKey.groupID, incarnation: sourceKey.incarnation },
        target: {
          targetID: target.targetID,
          topicID: target.topicID,
          groupInfoEpoch: target.groupInfoEpoch,
          groupInfoAuthenticator: Uint8Array.from(target.groupInfoAuthenticator),
          captureHead: head,
        },
        searchFrom,
      },
      ledgerBefore: [...new Set([...(rows.get(key)?.ledgerBefore ?? []), ...value.ledgerBefore])],
    })
  }
  return [...rows.values()]
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

export function controlSafetyHeld(snapshot: ConformanceControlSnapshot): ConformanceSafetyHold {
  if (snapshot.forkHalt !== null) return 'fork-halted'
  if (snapshot.recoveryUnavailable !== null) return 'recovery-unavailable'
  return null
}

class ControlSafetyImmutableError extends Error {
  override name = 'ControlSafetyImmutableError'
  #field: 'forkHalt' | 'recoveryUnavailable'

  constructor(field: 'forkHalt' | 'recoveryUnavailable') {
    super(`Immutable safety field: ${field}`)
    this.#field = field
  }

  get field(): 'forkHalt' | 'recoveryUnavailable' {
    return this.#field
  }
}

function copyEvidence(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const kind: unknown = Reflect.get(value, 'kind')
  const names =
    kind === 'epoch-authenticator'
      ? ['epoch', 'local', 'remote']
      : kind === 'digest-divergence'
        ? ['epoch', 'position', 'localDigest', 'remoteDigest']
        : kind === 'unexplained-own-commit'
          ? ['epoch', 'position', 'digest']
          : ['epoch']
  const result: Record<string, unknown> = { kind }
  for (const name of names) {
    const child: unknown = Reflect.get(value, name)
    result[name] = child instanceof Uint8Array ? new Uint8Array(child) : child
  }
  return result
}

function copySafety(field: 'forkHalt' | 'recoveryUnavailable', value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const names =
    field === 'forkHalt'
      ? ['eventID', 'evidence', 'detectedAt']
      : ['groupID', 'incarnation', 'id', 'kind', 'reason']
  const result: Record<string, unknown> = {}
  for (const name of names) {
    const child: unknown = Reflect.get(value, name)
    result[name] = field === 'forkHalt' && name === 'evidence' ? copyEvidence(child) : child
  }
  return result
}

function completeEvidence(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const evidence = value as Record<string, unknown>
  if (typeof evidence.epoch !== 'number' || !Number.isFinite(evidence.epoch)) return false
  if (evidence.kind === 'epoch-authenticator')
    return evidence.local instanceof Uint8Array && evidence.remote instanceof Uint8Array
  if (evidence.kind === 'digest-divergence')
    return (
      typeof evidence.position === 'string' &&
      typeof evidence.localDigest === 'string' &&
      typeof evidence.remoteDigest === 'string'
    )
  return (
    evidence.kind === 'unexplained-own-commit' &&
    typeof evidence.position === 'string' &&
    typeof evidence.digest === 'string'
  )
}

function checkSafetyIdentity(
  field: 'forkHalt' | 'recoveryUnavailable',
  value: unknown,
  key: ConformanceGroupKey | null,
): void {
  if (
    key === null ||
    typeof key.groupID !== 'string' ||
    typeof key.incarnation !== 'number' ||
    !Number.isFinite(key.incarnation)
  )
    throw new TypeError('A safety write requires the store key')
  if (value === null) throw new ControlSafetyImmutableError(field)
  if (typeof value !== 'object') throw new TypeError('Incomplete safety value')
  const body = value as Record<string, unknown>
  if (field === 'forkHalt') {
    if (
      body.eventID !== JSON.stringify(['group:fork', key.groupID, key.incarnation]) ||
      typeof body.detectedAt !== 'number' ||
      !Number.isFinite(body.detectedAt) ||
      !completeEvidence(body.evidence)
    )
      throw new TypeError('Invalid fork halt')
  } else if (
    body.id !== JSON.stringify(['group:recovery-unavailable', key.groupID, key.incarnation]) ||
    body.kind !== 'group:recovery-unavailable' ||
    body.groupID !== key.groupID ||
    body.incarnation !== key.incarnation ||
    body.reason !== 'trust-unreadable'
  )
    throw new TypeError('Invalid recovery event')
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
  key: ConformanceGroupKey | null = null,
): void {
  const { forkHalt, recoveryUnavailable, recoveryEpochFloor, putSettledRejoins, ...ordinary } =
    changes
  const safety: Pick<ConformanceControlChanges, 'forkHalt' | 'recoveryUnavailable'> = {}
  if ('forkHalt' in changes) {
    const body = copySafety('forkHalt', forkHalt)
    checkSafetyIdentity('forkHalt', body, key)
    safety.forkHalt = body as ConformanceForkHalt
  }
  if ('recoveryUnavailable' in changes) {
    const body = copySafety('recoveryUnavailable', recoveryUnavailable)
    checkSafetyIdentity('recoveryUnavailable', body, key)
    safety.recoveryUnavailable = body as ConformanceRecoveryUnavailableEvent
  }
  const fields = ['forkHalt', 'recoveryUnavailable'] as const
  for (const field of fields) {
    if (field in safety && snapshot[field] !== null && !equal(snapshot[field], safety[field]))
      throw new ControlSafetyImmutableError(field)
  }
  const owned = cloneValue(ordinary)
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
    return owned.deleteAppliedBelow != null && row.epoch < owned.deleteAppliedBelow
  })
  removeRows(snapshot.responses, (row) => {
    return owned.deleteResponsesBelow != null && row.epoch < owned.deleteResponsesBelow
  })
  if (owned.deleteRejoin) snapshot.rejoin = null

  upsertRows(snapshot.operations, owned.putOperations, (row) => row.id)
  upsertRows(snapshot.outcomes, owned.putOutcomes, (row) => row.id)
  upsertRows(snapshot.welcomes, owned.putWelcomes, (row) => row.opID)
  upsertRows(snapshot.applied, owned.putApplied, (row) => row.epoch)
  const responses = new Map(
    snapshot.responses.filter((row) => row.kind === 'applied').map((row) => [row.position, row]),
  )
  for (const row of owned.putResponses ?? []) {
    if (row.kind === 'applied') responses.set(row.position, row)
  }
  snapshot.responses = [...responses.values()]

  if (owned.putRejoin !== undefined) snapshot.rejoin = owned.putRejoin
  if (owned.commitOnce !== undefined) snapshot.commitOnce = owned.commitOnce
  snapshot.commitOnceAcceptance = proof
  if (owned.controlHold !== undefined) snapshot.controlHold = owned.controlHold
  snapshot.forkHalt ??= safety.forkHalt ?? null
  snapshot.recoveryUnavailable ??= safety.recoveryUnavailable ?? null
  if (owned.strand !== undefined) snapshot.strand = owned.strand
  if (owned.cursor !== undefined) snapshot.cursor = owned.cursor
  snapshot.recoveryEpochFloor =
    recoveryEpochFloor == null
      ? (snapshot.recoveryEpochFloor ?? null)
      : raiseFloor(snapshot.recoveryEpochFloor ?? null, recoveryEpochFloor)
  snapshot.settledRejoins = foldSettlements(snapshot.settledRejoins ?? [], putSettledRejoins)
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
      forkHalt: null,
      recoveryUnavailable: null,
      strand: null,
      operations: [],
      rejoin: null,
      recoveryEpochFloor: null,
      settledRejoins: [],
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
      mutateControl(
        next.control,
        changes,
        source === null ? null : { kind: 'head', source },
        fixedKey,
      )
      next.mutationID = mutationID
      finish(next, 'apply')
    },
    loadVersion: async () => record.version,
    saveBuilt: async (intent, built, expected, mutationID) => {
      const next = cloneValue(record)
      const identity = next.state === null ? null : decodeControlFixtureState(next.state)
      if (
        controlSafetyHeld(next.control) !== null ||
        next.control.controlHold !== null ||
        !equal(expected.key, fixedKey) ||
        !equal(identity, expected.identity) ||
        next.version !== expected.stateVersion ||
        (next.control.cursor === null && !equal(next.initialIdentity, identity)) ||
        !equal(next.control.operations[0], intent) ||
        built.searchFrom !== (next.control.cursor?.position ?? null) ||
        (next.control.cursor !== null &&
          (next.control.cursor.epoch !== identity?.epoch || next.control.cursor.stranded))
      )
        return 'moved'
      const previous = next.control.commitOnce
      if (
        previous !== null &&
        previous.incarnation === fixedKey.incarnation &&
        previous.epoch >= (identity?.epoch ?? 0)
      )
        return 'occupied'
      mutateControl(
        next.control,
        {
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
        },
        null,
        fixedKey,
      )
      mutateControl(
        next.control,
        { commitOnce: built, commitOnceAcceptance: null },
        {
          kind: 'build',
          source: expected,
          queueHeadID: intent.id,
          checkpoint: next.control.cursor?.position ?? null,
        },
        fixedKey,
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
      if (
        controlSafetyHeld(next.control) !== null ||
        (write !== undefined &&
          next.control.controlHold !== null &&
          next.control.controlHold.reason !== 'acceptance-unknown')
      )
        throw Object.assign(new Error('Adoption is held'), { name: 'ControlAdoptionMovedError' })
      const expected = write?.expected
      const proof = expected?.acceptance
      const retained = next.control.commitOnce
      if (
        expected !== undefined &&
        (controlSafetyHeld(next.control) !== null ||
          (next.control.controlHold !== null &&
            next.control.controlHold.reason !== 'acceptance-unknown') ||
          !equal(expected.key, key) ||
          !equal(expected.identity, before) ||
          expected.stateVersion !== next.version ||
          (proof !== undefined &&
            (retained === null ||
              retained.payloadDigest !== proof.payloadDigest ||
              retained.searchFrom !== proof.from ||
              !equal(retained.journal, expected.journal) ||
              !equal(next.control.commitOnceAcceptance, proof))))
      ) {
        const error = new Error('Adoption source or acceptance moved')
        error.name = 'ControlAdoptionMovedError'
        throw error
      }
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
          fixedKey,
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
