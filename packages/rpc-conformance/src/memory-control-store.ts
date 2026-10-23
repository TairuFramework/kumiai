import type { ConformanceAnchorSlot, ConformanceAnchorStore } from './anchor-store.js'
import type { ConformanceCheckpointRecord } from './checkpoint.js'
import type { MigrationFixture } from './control-migration.js'
import type {
  ConformanceAcceptedRejoinSettlement,
  ConformanceAdoptionExpected,
  ConformanceAdoptionWrite,
  ConformanceCapturedRejoinRecord,
  ConformanceControlChanges,
  ConformanceControlSlot,
  ConformanceControlSnapshot,
  ConformanceControlStore,
  ConformanceEpochIdentity,
  ConformanceForkHalt,
  ConformanceForkRecoveryAttempt,
  ConformanceGroupCondition,
  ConformanceGroupKey,
  ConformanceOwnOccurrence,
  ConformanceRecoveryUnavailableEvent,
  ConformanceSafetyHold,
  ConformanceSaveControlBuild,
} from './control-store.js'
import { decodeControlFixtureState } from './control-store.js'
import type { ConformanceRecoveryReconciliation } from './group-mls.js'
import { migrateMemoryControl } from './memory-control-migration.js'
import type { MemoryMigrationBackend } from './memory-migration-backend.js'

export type MemoryControlStore<Position extends string = string> =
  ConformanceControlStore<Position> & {
    reportAppHold(halt: ConformanceForkHalt, reportMutationID: string): Promise<void>
    clearReportedHold(): Promise<void>
    holdRecords(): Promise<Array<ConformanceCheckpointRecord>>
    retainForkContinuation(snapshot: ConformanceControlSnapshot<Position>): Promise<void>
    authoriseFork(attempt: ConformanceForkRecoveryAttempt): Promise<void>
    forkHistory(): Promise<Array<ConformanceCapturedRejoinRecord<Position>>>
    abandonFork(): Promise<void>
    settleFork(
      record: ConformanceCapturedRejoinRecord<Position>,
      result: ConformanceRecoveryReconciliation<Position>,
    ): Promise<void>
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
      id: value.id,
      ...(value.kind === 'not-accepted' || value.kind === 'superseded-branch'
        ? { kind: value.kind, epoch: value.epoch }
        : {
            kind: 'accepted-unadoptable' as const,
            digest: value.digest,
            payloadDigest: value.payloadDigest,
            epochAfter: value.epochAfter,
            acceptedEpoch: value.acceptedEpoch,
            leafDigest: value.leafDigest,
          }),
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
      removed?: true
    }
  | { kind: 'retirement'; key: ConformanceGroupKey }
  | { kind: 'head' | 'cursor' | 'report' | 'ack' | 'abandon'; source: ConformanceEpochIdentity }

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

export function controlSafetyHeld(
  snapshot: ConformanceControlSnapshot,
  condition?: ConformanceGroupCondition | null,
): ConformanceSafetyHold {
  if (snapshot.forkHalt !== null) return 'fork-halted'
  if (condition === 'spent-set-corrupt') return 'spent-set-corrupt'
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
  const producer = field === 'forkHalt' ? Reflect.get(value, 'producer') : undefined
  const names =
    field === 'forkHalt'
      ? ['eventID', 'evidence', 'detectedAt']
      : ['groupID', 'incarnation', 'id', 'kind', 'reason']
  const result: Record<string, unknown> = {}
  for (const name of names) {
    const child: unknown = Reflect.get(value, name)
    result[name] = field === 'forkHalt' && name === 'evidence' ? copyEvidence(child) : child
  }
  if (producer !== undefined) result.producer = producer
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
      (body.producer !== undefined &&
        body.producer !== 'app-report' &&
        body.producer !== 'internal') ||
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
  if (context?.kind === 'build' && next !== null && previous === null) {
    const identity = context.source.identity
    if (
      identity !== null &&
      matches(next, identity) &&
      equal(context.source.key, { groupID: identity.groupID, incarnation: identity.incarnation }) &&
      next.opID === context.queueHeadID &&
      next.head === context.checkpoint
    )
      return
  }
  if (previous !== null && next === null) {
    if (context?.kind === 'retirement' && previous.incarnation === context.key.incarnation) return
    if (
      context?.kind === 'adoption' &&
      matches(previous, context.before) &&
      context.after !== null &&
      context.after.groupID === context.before.groupID &&
      context.after.incarnation === context.before.incarnation &&
      (context.after.epoch > context.before.epoch || context.removed === true)
    )
      return
    if (context?.kind === 'abandon' && matches(previous, context.source)) return
  }
  if (
    previous !== null &&
    next !== null &&
    context !== null &&
    'source' in context &&
    context.kind !== 'build' &&
    matches(previous, context.source)
  ) {
    const mutable =
      context.kind === 'head'
        ? 'expectedHead'
        : context.kind === 'cursor'
          ? 'skipped'
          : context.kind === 'report'
            ? 'reported'
            : context.kind === 'ack'
              ? 'acceptedAs'
              : null
    if (mutable !== null) {
      const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
      keys.delete(mutable)
      const unchanged = [...keys].every((key) =>
        equal(Reflect.get(previous, key), Reflect.get(next, key)),
      )
      if (
        unchanged &&
        (mutable === 'expectedHead' ||
          ((mutable === 'skipped' || mutable === 'reported') && next[mutable] === true) ||
          (mutable === 'acceptedAs' &&
            next.acceptedAs !== undefined &&
            (previous.acceptedAs === undefined || previous.acceptedAs === next.acceptedAs)))
      )
        return
    }
  }
  throw new Error('Unverified commit-once change')
}

function occurrenceCoverage<Position extends string>(
  snapshot: ConformanceControlSnapshot<Position>,
  slot: ConformanceControlSlot<Position>,
  position: Position,
): 'complete' | 'incomplete' {
  return snapshot.cursor?.incomplete || slot.skipped || (slot.head !== null && position < slot.head)
    ? 'incomplete'
    : 'complete'
}

function ownConsumptionAllowed<Position extends string>(
  snapshot: ConformanceControlSnapshot<Position>,
  occurrence: ConformanceOwnOccurrence<Position>,
  changes: ConformanceControlChanges<Position>,
): boolean {
  const slot = snapshot.commitOnce
  if (slot === null || changes.commitOnce !== null) return false
  const retainedWelcome = snapshot.welcomes.find((row) => row.opID === slot.opID)
  if (
    occurrence.coverage === 'complete' &&
    slot.welcome !== null &&
    retainedWelcome !== undefined &&
    (!equal(retainedWelcome.welcome, slot.welcome.bytes) ||
      !equal(retainedWelcome.recipients, slot.welcome.recipients))
  )
    return false
  const applied = changes.putApplied?.find((row) => row.epoch === slot.epoch)
  const outcome = changes.putOutcomes?.find((row) => row.opID === slot.opID)
  return (
    applied?.opID === slot.opID &&
    applied.payloadDigest === slot.payloadDigest &&
    applied.sequenceID === occurrence.position &&
    applied.removed === false &&
    changes.cursor?.position === occurrence.position &&
    changes.cursor.epoch === slot.epoch + 1 &&
    (occurrence.coverage === 'complete'
      ? outcome?.kind === 'landed' &&
        outcome.position === occurrence.position &&
        (slot.welcome === null ||
          snapshot.welcomes.some((row) => row.opID === slot.opID) ||
          changes.putWelcomes?.some(
            (row) =>
              row.opID === slot.opID &&
              equal(row.welcome, slot.welcome?.bytes) &&
              equal(row.recipients, slot.welcome?.recipients),
          ) === true)
      : outcome?.kind === 'unknown' && !changes.putWelcomes?.some((row) => row.opID === slot.opID))
  )
}

/** Mutates the transaction's private copy, independently of the RPC reducer. */
function mutateControl<Position extends string>(
  snapshot: ConformanceControlSnapshot<Position>,
  changes: ConformanceControlChanges<Position>,
  context: Context | null = null,
  key: ConformanceGroupKey | null = null,
): void {
  if ('clearAppHold' in changes)
    throw new TypeError('App hold release requires coordinator authority')
  if (
    'forkRecoveryAttempt' in changes ||
    changes.putSettledRejoins?.some((row) => row.kind === 'superseded-branch')
  )
    throw new TypeError('Fork recovery requires coordinator authority')
  if (
    changes.putRejoin !== undefined &&
    'format' in changes.putRejoin &&
    changes.putRejoin.forkRecovery !== undefined &&
    (snapshot.forkRecoveryAttempt == null ||
      changes.putRejoin.id !== snapshot.forkRecoveryAttempt.id ||
      !equal(changes.putRejoin.source.key, snapshot.forkRecoveryAttempt.source) ||
      !equal(changes.putRejoin.forkRecovery, snapshot.forkRecoveryAttempt.forkRecovery))
  )
    throw new TypeError('Fork recovery record requires its bound intent')
  const intent = snapshot.forkRecoveryAttempt ?? null
  if (
    intent !== null &&
    changes.putRejoin !== undefined &&
    (!('format' in changes.putRejoin) ||
      changes.putRejoin.id !== intent.id ||
      !equal(changes.putRejoin.forkRecovery, intent.forkRecovery))
  )
    throw new TypeError('Fork recovery record requires its bound intent')
  if (intent !== null && changes.deleteRejoin && snapshot.rejoin?.id === intent.id)
    throw new TypeError('Fork recovery settlement requires coordinator authority')
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
  if (context?.kind === 'abandon' && snapshot.commitOnce !== null) {
    owned.deleteOutcomes = [
      ...new Set([
        ...(owned.deleteOutcomes ?? []),
        ...snapshot.outcomes
          .filter((row) => row.opID === snapshot.commitOnce?.opID && row.kind === 'unknown')
          .map((row) => row.id),
      ]),
    ]
  }
  const replacesReport =
    slot === null &&
    snapshot.commitOnce !== null &&
    owned.putOutcomes?.some(
      (row) =>
        row.opID === snapshot.commitOnce?.opID &&
        !snapshot.outcomes.some((old) => old.id === row.id),
    ) === true
  if (snapshot.commitOnce !== null && slot?.reported === true) {
    const built = snapshot.commitOnce
    const reports = owned.putOutcomes?.filter((row) => row.opID === built.opID) ?? []
    if (!built.reported) {
      if (
        context?.kind !== 'report' ||
        reports.length !== 1 ||
        reports[0]?.kind !== 'unknown' ||
        reports[0].id === built.opID ||
        snapshot.outcomes.some((row) => row.id === reports[0]?.id)
      )
        throw new Error('Report requires one fresh provisional unknown')
    } else if (reports.some((row) => !snapshot.outcomes.some((old) => equal(row, old))))
      throw new Error('Build already reported')
  }
  if (context?.kind === 'abandon') {
    const built = snapshot.commitOnce
    const reports = owned.putOutcomes?.filter((row) => row.opID === built?.opID) ?? []
    if (
      built === null ||
      slot !== null ||
      owned.spentSource?.epoch !== built.epoch ||
      (owned.spentSource.opID !== undefined && owned.spentSource.opID !== built.opID) ||
      reports.length !== 1 ||
      reports[0]?.kind !== 'unknown' ||
      reports[0].id === built.opID ||
      snapshot.outcomes.some(
        (row) =>
          row.id === reports[0]?.id ||
          (row.opID === built.opID &&
            (row.kind !== 'unknown' || !owned.deleteOutcomes?.includes(row.id))),
      )
    )
      throw new Error('Abandonment requires fresh unknown and matching spent source')
  }
  if (owned.spentSource !== undefined && !equal(snapshot.spentSource, owned.spentSource)) {
    if (owned.spentSource === null) {
      if (
        context?.kind !== 'retirement' &&
        !(
          context?.kind === 'adoption' &&
          !context.removed &&
          context.after !== null &&
          context.after.epoch > context.before.epoch
        )
      )
        throw new Error('Only consumption clears spent source')
    } else if (context?.kind !== 'abandon') throw new Error('Only abandonment writes spent source')
  }
  if (
    slot !== null &&
    (context?.kind === 'retirement' ||
      (context?.kind === 'adoption' &&
        (context.removed ||
          (context.after !== null && context.after.epoch > context.before.epoch))))
  )
    throw new Error('Consumption must close the live build')
  if (
    context?.kind === 'adoption' &&
    context.removed &&
    (snapshot.operations.some((row) => !owned.deleteOperations?.includes(row.id)) ||
      (snapshot.rejoin !== null && !owned.deleteRejoin))
  )
    throw new Error('Removal must close intents and rejoin work')
  guard(snapshot.commitOnce, slot, context)
  if (
    context?.kind === 'cursor' &&
    snapshot.commitOnce?.skipped !== slot?.skipped &&
    (owned.cursor?.position == null ||
      (snapshot.cursor?.position != null && owned.cursor.position <= snapshot.cursor.position))
  )
    throw new Error('Skipped requires an advancing cursor')
  removeRows(snapshot.operations, (row) => owned.deleteOperations?.includes(row.id) === true)
  removeRows(
    snapshot.outcomes,
    (row) =>
      owned.deleteOutcomes?.includes(row.id) === true ||
      (replacesReport && snapshot.commitOnce !== null && row.opID === snapshot.commitOnce.opID),
  )
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
  if (owned.spentSource !== undefined) snapshot.spentSource = owned.spentSource
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
  options?: { legacy?: MigrationFixture; migration?: MemoryMigrationBackend },
): MemoryControlStore<Position> {
  const fixedKey = { ...key }
  const legacyKey = options?.legacy?.source.key ?? options?.migration?.key
  if (
    legacyKey !== undefined &&
    (legacyKey.groupID !== key.groupID || legacyKey.incarnation !== key.incarnation)
  )
    throw new TypeError('Migration source does not bind this control store')
  let record: {
    holdRecords: Array<ConformanceCheckpointRecord>
    forkContinuation: ConformanceControlSnapshot<Position> | null
    forkHistory: Array<ConformanceCapturedRejoinRecord<Position>>
    state: Uint8Array | null
    initialIdentity: ConformanceEpochIdentity | null
    version: number
    anchor: ConformanceAnchorSlot | null
    control: ConformanceControlSnapshot<Position>
    mutationID: string | null
  } = {
    holdRecords: [],
    forkContinuation: null,
    forkHistory: [],
    state: null,
    initialIdentity: null,
    version: 0,
    anchor: null,
    mutationID: null,
    control: {
      schemaVersion: 1,
      commitOnce: null,
      spentSource: null,
      controlHold: null,
      forkHalt: null,
      recoveryUnavailable: null,
      strand: null,
      operations: [],
      rejoin: null,
      recoveryEpochFloor: null,
      forkRecoveryAttempt: null,
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
  let legacy = options?.legacy === undefined ? undefined : cloneValue(options.legacy)
  let migration = options?.migration
  async function activate(): Promise<void> {
    if (migration !== undefined) {
      record.control = cloneValue(
        await migration.activate(),
      ) as unknown as ConformanceControlSnapshot<Position>
      migration = undefined
    }
    if (legacy === undefined) return
    record.control = cloneValue(
      migrateMemoryControl(legacy),
    ) as unknown as ConformanceControlSnapshot<Position>
    legacy = undefined
  }
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
    async reportAppHold(halt, reportMutationID) {
      await activate()
      if (record.control.forkHalt !== null) return
      if (halt.producer !== 'app-report') throw new TypeError('App report required')
      const next = cloneValue(record)
      mutateControl(next.control, { forkHalt: halt }, null, fixedKey)
      const id = JSON.stringify([
        'app-hold',
        fixedKey.groupID,
        fixedKey.incarnation,
        reportMutationID,
      ])
      if (next.holdRecords.some((row) => row.id === id))
        throw new TypeError('Report identity reused')
      next.holdRecords.push({
        kind: 'app-hold',
        id,
        key: { ...fixedKey },
        producer: 'app-report',
        eventID: halt.eventID,
        reportMutationID,
        clearedAt: null,
      })
      next.mutationID = reportMutationID
      finish(next, 'apply')
    },
    async clearReportedHold() {
      await activate()
      const halt = record.control.forkHalt
      if (halt?.producer !== 'app-report') return
      const provenance = record.holdRecords.find(
        (row) =>
          row.kind === 'app-hold' &&
          row.producer === 'app-report' &&
          row.clearedAt === null &&
          equal(row.key, fixedKey) &&
          row.eventID === halt.eventID,
      )
      if (provenance?.kind !== 'app-hold') return
      const next = cloneValue(record)
      const index = next.holdRecords.findIndex((row) => row.id === provenance.id)
      next.holdRecords[index] = { ...provenance, clearedAt: Date.now() }
      next.holdRecords.push({
        kind: 'hold-history',
        id: JSON.stringify([
          'hold-history',
          fixedKey.groupID,
          fixedKey.incarnation,
          provenance.reportMutationID,
        ]),
        key: { ...fixedKey },
        halt: cloneValue(halt),
        reportMutationID: provenance.reportMutationID,
      })
      next.control.forkHalt = null
      next.mutationID = crypto.randomUUID()
      finish(next, 'apply')
    },
    holdRecords: async () => {
      await activate()
      return cloneValue(record.holdRecords)
    },
    async retainForkContinuation(snapshot) {
      await activate()
      const saved = snapshot.rejoin
      if (
        saved === null ||
        !('format' in saved) ||
        saved.stage !== 'adopted' ||
        !equal(saved.destinationKey, fixedKey)
      )
        throw new TypeError('Proven adopted continuation required')
      const next = cloneValue(record)
      next.forkContinuation = cloneValue(snapshot)
      finish(next, 'apply')
    },
    async authoriseFork(attempt) {
      await activate()
      if (
        !equal(attempt.source, fixedKey) ||
        attempt.id !== attempt.forkRecovery.attemptID ||
        !equal(attempt.source, attempt.forkRecovery.source)
      )
        throw new TypeError('Fork intent source mismatch')
      if (record.control.forkRecoveryAttempt != null) {
        if (!equal(record.control.forkRecoveryAttempt, attempt))
          throw new TypeError('Fork intent already bound')
        return
      }
      const next = cloneValue(record)
      const saved = next.control.rejoin ?? next.forkContinuation?.rejoin ?? null
      if (saved !== null) {
        if (!('format' in saved) || saved.forkRecovery !== undefined)
          throw new TypeError('Invalid branch attempt')
        next.forkHistory.push(saved)
        next.control.settledRejoins = foldSettlements(next.control.settledRejoins, [
          {
            id: saved.id,
            kind: 'superseded-branch',
            epoch: attempt.forkRecovery.splitEpoch,
            origin: {
              sourceKey: saved.source.key,
              target: saved.target,
              searchFrom: saved.searchFrom,
            },
            ledgerBefore: [
              ...new Set([
                ...next.control.settledRejoins.flatMap((row) => row.ledgerBefore),
                ...(next.forkContinuation?.settledRejoins.flatMap((row) => row.ledgerBefore) ?? []),
                ...saved.ledgerBefore,
              ]),
            ],
          },
        ])
      }
      next.control.rejoin = null
      if (next.forkContinuation !== null) next.forkContinuation.rejoin = null
      next.control.forkRecoveryAttempt = cloneValue(attempt)
      next.mutationID = attempt.id
      finish(next, 'apply')
    },
    forkHistory: async () => {
      await activate()
      return cloneValue(record.forkHistory)
    },
    async settleFork(saved, result) {
      await activate()
      if (
        (result.kind !== 'accepted' && result.kind !== 'unapplied-later') ||
        record.control.forkRecoveryAttempt?.id !== saved.id ||
        !equal(record.control.rejoin, saved)
      )
        throw new TypeError('Unbound fork settlement')
      const next = cloneValue(record)
      const common = {
        id: saved.id,
        origin: { sourceKey: saved.source.key, target: saved.target, searchFrom: saved.searchFrom },
        ledgerBefore: saved.ledgerBefore,
      }
      const accepted =
        result.kind === 'accepted' || saved.stage === 'confirmed' || saved.stage === 'adopted'
      next.control.settledRejoins = foldSettlements(next.control.settledRejoins, [
        accepted
          ? {
              ...common,
              kind: 'accepted-unadoptable',
              digest: saved.digest,
              payloadDigest: saved.payloadDigest,
              epochAfter: saved.epochAfter,
              acceptedEpoch: result.kind === 'unapplied-later' ? saved.epochAfter : result.epoch,
              leafDigest: result.leafDigest,
            }
          : { ...common, kind: 'not-accepted', epoch: result.epoch },
      ])
      next.control.forkRecoveryAttempt = null
      next.control.rejoin = null
      finish(next, 'apply')
    },
    async abandonFork() {
      await activate()
      const next = cloneValue(record)
      next.control.forkRecoveryAttempt = null
      next.control.rejoin = null
      finish(next, 'apply')
    },
    get key() {
      return { ...fixedKey }
    },
    load: async () => {
      await activate()
      return {
        ...cloneValue(record.control),
        forkRecoveryAttempt: cloneValue(record.control.forkRecoveryAttempt ?? null),
      }
    },
    lastMutation: async () => {
      await activate()
      return record.mutationID
    },
    apply: async (changes, mutationID) => {
      await activate()
      const next = cloneValue(record)
      const source = next.state === null ? null : decodeControlFixtureState(next.state)
      mutateControl(
        next.control,
        changes,
        source === null || source.deleted
          ? null
          : {
              kind:
                changes.commitOnce === null && changes.spentSource != null
                  ? 'abandon'
                  : changes.cursor !== undefined
                    ? 'cursor'
                    : changes.commitOnce?.reported === true &&
                        next.control.commitOnce?.reported !== true
                      ? 'report'
                      : changes.commitOnce?.acceptedAs !== undefined &&
                          next.control.commitOnce?.acceptedAs === undefined
                        ? 'ack'
                        : 'head',
              source,
            },
        fixedKey,
      )
      next.mutationID = mutationID
      finish(next, 'apply')
    },
    loadVersion: async () => {
      await activate()
      return record.version
    },
    saveBuilt: async (intent, built, expected, mutationID) => {
      await activate()
      const next = cloneValue(record)
      const identity = next.state === null ? null : decodeControlFixtureState(next.state)
      if (
        built.opID !== intent.id ||
        !(['kind', 'revokes', 'enqueuedAt', 'deadline'] as const).every(
          (field) => built[field] === intent[field],
        ) ||
        controlSafetyHeld(next.control) !== null ||
        next.control.controlHold !== null ||
        !equal(expected.key, fixedKey) ||
        !equal(identity, expected.identity) ||
        next.version !== expected.stateVersion ||
        (next.control.cursor === null && !equal(next.initialIdentity, identity)) ||
        !equal(next.control.operations[0], intent) ||
        built.head !== (next.control.cursor?.position ?? null) ||
        (next.control.cursor !== null &&
          (next.control.cursor.epoch !== identity?.epoch ||
            next.control.cursor.stranded ||
            next.control.cursor.incomplete))
      )
        return 'moved'
      const previous = next.control.commitOnce
      if (previous !== null || next.control.spentSource?.epoch === identity?.epoch)
        return 'occupied'
      mutateControl(
        next.control,
        {
          deleteOperations: [intent.id],
        },
        null,
        fixedKey,
      )
      mutateControl(
        next.control,
        { commitOnce: built },
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
    loadState: async () => {
      await activate()
      return record.state?.slice() ?? null
    },
    saveState: async (state, write) => {
      await activate()
      const next = cloneValue(record)
      const before = next.state === null ? null : decodeControlFixtureState(next.state)
      const after = decodeControlFixtureState(state)
      if (next.state === null) next.initialIdentity = cloneValue(after)
      next.state = state.slice()
      if (
        controlSafetyHeld(next.control) !== null ||
        (write !== undefined && next.control.controlHold !== null)
      )
        throw Object.assign(new Error('Adoption is held'), { name: 'ControlAdoptionMovedError' })
      const expected = write?.expected
      const proof = expected?.occurrence
      const retained = next.control.commitOnce
      if (
        expected !== undefined &&
        (controlSafetyHeld(next.control) !== null ||
          next.control.controlHold !== null ||
          !equal(expected.key, key) ||
          !equal(expected.identity, before) ||
          expected.stateVersion !== next.version ||
          (proof !== undefined &&
            (retained === null ||
              retained.payloadDigest !== proof.payloadDigest ||
              !equal(proof.source.key, expected.key) ||
              !equal(proof.source.identity, before) ||
              next.control.strand !== null ||
              next.control.cursor?.stranded === true ||
              proof.coverage !== occurrenceCoverage(next.control, retained, proof.position) ||
              write === undefined ||
              !ownConsumptionAllowed(next.control, proof, write.changes) ||
              !equal(retained.journal, expected.journal))))
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
                  ...(after?.terminal ? { removed: true as const } : {}),
                },
          fixedKey,
        )
        next.mutationID = write.mutationID
        if (write.anchorLanded != null && next.anchor?.pending?.advance === write.anchorLanded) {
          next.anchor.pending.landed = true
        }
      }
      if (
        before !== null &&
        after !== null &&
        (((after.incarnation !== before.incarnation ||
          after.epoch > before.epoch ||
          after.terminal) &&
          next.control.commitOnce !== null) ||
          (after.terminal &&
            (next.control.operations.length !== 0 || next.control.rejoin !== null)))
      )
        throw new Error('Source consumption requires atomic control closure')
      finish(next, 'save')
    },
    anchor: {
      load: async () => {
        await activate()
        return cloneValue(record.anchor)
      },
      save: async (slot) => {
        await activate()
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
