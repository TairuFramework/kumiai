import {
  type AcceptedRejoinSettlement,
  applyChanges,
  type CapturedRejoinRecord,
  type CheckpointRecord,
  type ControlSnapshot,
  type ControlStore,
  canMoveCurrent,
  controlSafetyHeld,
  type GroupKey,
  type ManualRecoveryRecord,
  type ManualRecoveryStatus,
  type PersistedManualRecovery,
  type SuccessorTombstone,
} from '@kumiai/rpc'

import { coordinatorBinding } from './entry-capability.js'
import { copyStoredValue, sameStoredValue } from './memory-incarnation-stores.js'
import { GroupStateConflictError } from './persistence-errors.js'
import type { GroupPersistence, GroupTransaction } from './persistence-types.js'
import { recoveryCompletionContexts } from './recovery-completion-context.js'
import { registrySafety } from './registry/safety.js'
import type { GroupHandleRegistry } from './registry/types.js'
import type { RecoveryTarget } from './safety.js'
import { groupCondition } from './safety-conditions.js'

type ManualRow = Extract<CheckpointRecord, { kind: 'manual-recovery' }>
type AuthorityRow = Extract<CheckpointRecord, { kind: 'manual-recovery' | 'successor' }>

const hubMethods = ['subscribe', 'receive', 'publish', 'fetchTopic'] as const

// A missing hub would let a peer factory default to the original hub: a fallback kumiai forbids.
export function validCallTimeTarget(target: RecoveryTarget): boolean {
  const hub: unknown = target.hub
  if (typeof hub !== 'object' || hub === null) return false
  const methods = hub as Record<string, unknown>
  return (
    hubMethods.every((name) => typeof methods[name] === 'function') &&
    typeof target.commitTopicID === 'string' &&
    target.commitTopicID.length > 0
  )
}
const preparations = new WeakMap<object, AuthorityRow>()
const liveTargets = new WeakMap<GroupHandleRegistry, Map<string, RecoveryTarget>>()

export function rememberManualRecoveryTarget(
  registry: GroupHandleRegistry,
  id: string,
  target: RecoveryTarget,
): void {
  const targets = liveTargets.get(registry) ?? new Map<string, RecoveryTarget>()
  targets.set(id, { id: target.id, commitTopicID: target.commitTopicID, hub: target.hub })
  liveTargets.set(registry, targets)
}

export function manualRecoveryPreparation(record: CheckpointRecord): AuthorityRow | undefined {
  return preparations.get(record)
}

/** Only coordinator code writes successor tombstones; generic writers cannot forge or clear them. */
export async function saveSuccessorTombstone(
  stores: { checkpoints: { put(row: CheckpointRecord): Promise<void> } },
  value: SuccessorTombstone,
): Promise<void> {
  const row: AuthorityRow = {
    kind: 'successor',
    id: value.id,
    key: { ...value.source },
    value: copyStoredValue(value),
  }
  preparations.set(row, copyStoredValue(row))
  await stores.checkpoints.put(row)
}

/** A successor choice supersedes every pending resync of the same source. */
export function successorChosen(records: Array<CheckpointRecord>, key: GroupKey): boolean {
  return records.some(
    (row) =>
      row.kind === 'manual-recovery' &&
      row.value.choice.mode === 'successor' &&
      sameStoredValue(row.key, key),
  )
}

function assertNotSuperseded(records: Array<CheckpointRecord>, record: ManualRecoveryRecord): void {
  if (
    record.choice.mode === 'resync' &&
    record.stage === 'authorised' &&
    successorChosen(records, record.source)
  )
    throw new GroupStateConflictError('Manual resync superseded by a successor choice')
}

export function findManualRecovery(
  records: Array<CheckpointRecord>,
  key: GroupKey,
  id: string,
): ManualRecoveryRecord {
  const row = records.find((row) => row.id === id)
  if (
    row?.kind !== 'manual-recovery' ||
    !sameStoredValue(row.key, key) ||
    !sameStoredValue(row.value.source, key)
  )
    throw new GroupStateConflictError('Committed manual recovery authorisation required')
  return copyStoredValue(row.value)
}

/**
 * Only a live resync owns the source's recovery. A successor never uses the rejoin slot (its
 * retirement re-reads its own row), and a resync it superseded is never resumed; counting either
 * would let an unexecuted successor choice disable automatic healing.
 */
export function hasActiveManualRecovery(records: Array<CheckpointRecord>, key: GroupKey): boolean {
  if (successorChosen(records, key)) return false
  return records.some(
    (row) =>
      row.kind === 'manual-recovery' &&
      sameStoredValue(row.key, key) &&
      row.value.stage === 'authorised' &&
      row.value.choice.mode === 'resync',
  )
}

/**
 * The row a restarted owner resumes: the live (non-superseded) authorised resync for `key`, else
 * the newest completed choice that ran from or onto `key`. Never list order, which no port defines.
 */
export function resumableManualRecovery(
  records: Array<CheckpointRecord>,
  key: GroupKey,
): ManualRecoveryRecord | null {
  const rows = records.filter((row): row is ManualRow => row.kind === 'manual-recovery')
  const live = successorChosen(records, key)
    ? undefined
    : rows.find((row) => row.value.stage === 'authorised' && sameStoredValue(row.key, key))
  if (live !== undefined) return copyStoredValue(live.value)
  let newest: ManualRow | undefined
  for (const row of rows) {
    if (
      row.value.stage !== 'completed' ||
      !(sameStoredValue(row.key, key) || sameStoredValue(row.value.destination, key))
    )
      continue
    // Rows completed before stamping order by id only to stay deterministic.
    const order = (candidate: ManualRow) => candidate.value.completedSequence ?? 0
    if (
      newest === undefined ||
      order(row) > order(newest) ||
      (order(row) === order(newest) && row.id > newest.id)
    )
      newest = row
  }
  return newest === undefined ? null : copyStoredValue(newest.value)
}

export function manualRecoveryStatus(
  records: Array<CheckpointRecord>,
  key: GroupKey,
): ManualRecoveryStatus | null {
  const rows = records.filter(
    (row): row is ManualRow => row.kind === 'manual-recovery' && sameStoredValue(row.key, key),
  )
  // The live choice wins regardless of list order: a successor supersedes, then a pending
  // resync; completed history ties break by id only to stay deterministic.
  const row =
    rows.find((row) => row.value.choice.mode === 'successor') ??
    rows.find((row) => row.value.stage === 'authorised') ??
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
  if (row === undefined) return null
  return {
    id: row.id,
    kind:
      row.value.stage === 'completed'
        ? 'completed'
        : row.value.pauseReason === null
          ? 'pending'
          : 'paused',
    reason: row.value.pauseReason,
  }
}

function choiceValue(choice: PersistedManualRecovery): PersistedManualRecovery {
  if (choice.mode === 'resync') {
    if (
      typeof choice.targetID !== 'string' ||
      choice.targetID.length === 0 ||
      typeof choice.commitTopicID !== 'string' ||
      choice.commitTopicID.length === 0 ||
      typeof choice.allowOpenFork !== 'boolean'
    )
      throw new TypeError('Invalid manual recovery transport binding')
    return {
      mode: 'resync',
      targetID: choice.targetID,
      commitTopicID: choice.commitTopicID,
      allowOpenFork: choice.allowOpenFork,
    }
  }
  if (
    choice.mode !== 'successor' ||
    typeof choice.successor?.groupID !== 'string' ||
    choice.successor.groupID.length === 0 ||
    !Number.isSafeInteger(choice.successor.incarnation) ||
    choice.successor.incarnation < 1
  )
    throw new TypeError('Invalid manual recovery successor')
  return {
    mode: 'successor',
    successor: { groupID: choice.successor.groupID, incarnation: choice.successor.incarnation },
  }
}

function mergeSettlements(
  ...groups: Array<Array<AcceptedRejoinSettlement>>
): Array<AcceptedRejoinSettlement> {
  const result = new Map<string, AcceptedRejoinSettlement>()
  for (const row of groups.flat()) {
    const source = row.origin.sourceKey
    const id = JSON.stringify([source.groupID, source.incarnation])
    result.set(id, {
      ...copyStoredValue(row),
      ledgerBefore: [...new Set([...(result.get(id)?.ledgerBefore ?? []), ...row.ledgerBefore])],
    })
  }
  return [...result.values()]
}

function overlay(source: ControlSnapshot, record: ManualRecoveryRecord): ControlSnapshot {
  return {
    ...source,
    rejoin: copyStoredValue(record.attempt),
    recoveryEpochFloor: record.epochFloor,
    settledRejoins: mergeSettlements(source.settledRejoins, record.settlements),
  }
}

function assertCandidate(record: ManualRecoveryRecord, attempt: CapturedRejoinRecord): void {
  if (
    record.choice.mode !== 'resync' ||
    attempt.format !== 2 ||
    attempt.trigger !== 'manual' ||
    attempt.authorisationID !== record.id ||
    !sameStoredValue(attempt.source.key, record.source) ||
    attempt.target.targetID !== record.choice.targetID ||
    attempt.target.topicID !== record.choice.commitTopicID ||
    attempt.forkRecovery !== undefined
  )
    throw new GroupStateConflictError(
      'Manual candidate requires its bound source, target and authorisation',
    )
}

export async function saveManualRecovery(
  stores: {
    checkpoints: {
      put(row: CheckpointRecord): Promise<void>
      list(): Promise<Array<CheckpointRecord>>
    }
  },
  value: ManualRecoveryRecord,
): Promise<void> {
  const saved = copyStoredValue(value)
  if (saved.stage === 'completed' && saved.completedSequence === undefined) {
    // Stamped inside the completing transaction: newest completion wins whatever the list order.
    let newest = 0
    for (const row of await stores.checkpoints.list())
      if (row.kind === 'manual-recovery' && row.key.groupID === saved.source.groupID)
        newest = Math.max(newest, row.value.completedSequence ?? 0)
    saved.completedSequence = newest + 1
  }
  const row: ManualRow = {
    kind: 'manual-recovery',
    id: saved.id,
    key: { ...saved.source },
    value: saved,
  }
  preparations.set(row, copyStoredValue(row))
  await stores.checkpoints.put(row)
}

export function manualRecoveryAttempt(
  records: Array<CheckpointRecord>,
  key: GroupKey,
  id: string,
): ManualRecoveryRecord {
  const record = findManualRecovery(records, key, id)
  if (record.choice.mode !== 'resync')
    throw new GroupStateConflictError('Resync authorisation required')
  assertNotSuperseded(records, record)
  if (record.attempt !== null) assertCandidate(record, record.attempt)
  return record
}

export type ManualRecoveryStore = {
  authoriseManualRecovery(
    key: GroupKey,
    choice: PersistedManualRecovery,
  ): Promise<ManualRecoveryRecord>
  manualRecoveryControl(id: string): ControlStore
  readManualRecovery(id: string): Promise<ManualRecoveryRecord | null>
  resolveManualRecoveryTarget(id: string): Promise<RecoveryTarget | null>
  /** Completes the choice as a same-key transport move, or returns false so it must rejoin. */
  moveCurrent(
    id: string,
    runtime: { stateVersion: number; ledgerComplete: boolean },
  ): Promise<boolean>
}

export function createManualRecoveryStore<TTx extends GroupTransaction>(params: {
  registry: GroupHandleRegistry
  persistence: GroupPersistence<TTx>
  key: GroupKey
  resolveTarget?: (targetID: string) => Promise<RecoveryTarget>
}): ManualRecoveryStore {
  const capability = registrySafety<TTx>(params.registry)
  if (capability === null || capability.binding !== coordinatorBinding(params.persistence))
    throw new TypeError('Manual recovery requires a registry with the same coordinator')
  const { entry } = capability
  const key = { ...params.key }
  const save = saveManualRecovery
  async function change(
    id: string,
    mutationID: string,
    update: (record: ManualRecoveryRecord, source: ControlSnapshot) => ManualRecoveryRecord | null,
    continuation = false,
  ): Promise<void> {
    await entry.run(
      { groupID: key.groupID, mutationID },
      async (reads) => {
        const lifetime = await reads.lifetime()
        const records = await reads.checkpoints()
        const record = findManualRecovery(records, key, id)
        assertNotSuperseded(records, record)
        if (
          !(record.stage === 'authorised' && lifetime?.activeIncarnation === key.incarnation) &&
          !(
            continuation &&
            record.stage === 'completed' &&
            record.destination !== null &&
            lifetime?.activeIncarnation === record.destination?.incarnation
          )
        )
          throw new GroupStateConflictError('Manual recovery source is no longer active')
        return {
          expected: lifetime,
          value: { before: record, next: update(record, await reads.control(key.incarnation)) },
        }
      },
      async (stores, prepared) => {
        if (prepared.next === null) return
        if (
          !sameStoredValue(
            findManualRecovery(await stores.checkpoints.list(), key, id),
            prepared.before,
          )
        )
          throw new GroupStateConflictError('Manual recovery authorisation moved')
        await save(stores, { ...prepared.next, mutationID })
      },
    )
  }
  const api: ManualRecoveryStore = {
    async authoriseManualRecovery(requested, supplied) {
      if (!sameStoredValue(requested, key))
        throw new TypeError('Manual recovery source key mismatch')
      const choice = choiceValue(supplied)
      if (choice.mode === 'successor' && choice.successor.groupID === key.groupID)
        throw new TypeError('A successor must be another group')
      const mutationID = crypto.randomUUID()
      return entry.run<
        { record: ManualRecoveryRecord; existing: boolean; replaces?: ManualRecoveryRecord },
        ManualRecoveryRecord
      >(
        { groupID: key.groupID, mutationID },
        async (reads) => {
          const lifetime = await reads.lifetime()
          if (lifetime?.activeIncarnation !== key.incarnation)
            throw new GroupStateConflictError('Manual recovery requires the active source')
          const pending = (await reads.checkpoints()).filter(
            (row): row is ManualRow =>
              row.kind === 'manual-recovery' &&
              sameStoredValue(row.key, key) &&
              row.value.stage === 'authorised',
          )
          const existing = pending.find((row) => sameStoredValue(row.value.choice, choice))
          if (existing !== undefined)
            return { expected: lifetime, value: { record: existing.value, existing: true } }
          // Only a successor choice supersedes pending work; a retired source is already inactive.
          if (pending.length > 0 && choice.mode !== 'successor')
            throw new GroupStateConflictError(
              'Manual recovery already authorised for another choice',
            )
          // An unexecuted successor choice is replaced in place, so one successor row stays live.
          const unexecuted = pending.find((row) => row.value.choice.mode === 'successor')
          if (unexecuted !== undefined)
            return {
              expected: lifetime,
              value: {
                record: { ...copyStoredValue(unexecuted.value), choice, mutationID },
                existing: false,
                replaces: copyStoredValue(unexecuted.value),
              },
            }
          const control = await reads.control(key.incarnation)
          const record: ManualRecoveryRecord = {
            id: crypto.randomUUID(),
            source: key,
            choice,
            stage: 'authorised',
            pauseReason: null,
            destination: null,
            attempt: null,
            epochFloor: null,
            settlements: copyStoredValue(control.settledRejoins),
            mutationID,
          }
          return { expected: lifetime, value: { record, existing: false } }
        },
        async (stores, { record, existing, replaces }) => {
          if (replaces !== undefined) {
            const current = findManualRecovery(await stores.checkpoints.list(), key, replaces.id)
            if (!sameStoredValue(current, replaces))
              throw new GroupStateConflictError('Manual recovery authorisation moved')
            await save(stores, record)
          } else if (!existing) {
            const control = stores.incarnation(key.incarnation).control
            const intent = (await control.load()).forkRecoveryAttempt
            if (intent != null) {
              const changes = {}
              recoveryCompletionContexts.set(stores.tx, {
                key,
                changes,
                abandonForkRecovery: true,
                forkRecovery: { attempt: null },
              })
              try {
                await control.apply(changes, mutationID)
              } finally {
                recoveryCompletionContexts.delete(stores.tx)
              }
              // The abandoned intent proves this device behind; it can never move current.
              record.abandonedForkRecovery = intent.id
            }
            await save(stores, record)
          }
          return copyStoredValue(record)
        },
      )
    },
    manualRecoveryControl(id) {
      return {
        key: { ...key },
        load: () =>
          entry.read(key.groupID, async (reads) => {
            const records = await reads.checkpoints()
            const record = findManualRecovery(records, key, id)
            // A superseded attempt must not feed a live peer its stale candidate.
            assertNotSuperseded(records, record)
            return overlay(await reads.control(key.incarnation), record)
          }),
        lastMutation: () =>
          entry.read(
            key.groupID,
            async (reads) => findManualRecovery(await reads.checkpoints(), key, id).mutationID,
          ),
        async apply(supplied, mutationID) {
          const changes = copyStoredValue(supplied)
          if (
            Object.keys(changes).some(
              (name) =>
                !['putRejoin', 'deleteRejoin', 'recoveryEpochFloor', 'putSettledRejoins'].includes(
                  name,
                ),
            )
          )
            throw new GroupStateConflictError('Manual overlay permits only recovery changes')
          await change(id, mutationID, (record, source) => {
            if (record.choice.mode !== 'resync')
              throw new GroupStateConflictError('Successor authorisation has no rejoin overlay')
            if (changes.putRejoin !== undefined) {
              if (!('format' in changes.putRejoin))
                throw new GroupStateConflictError('Captured manual recovery required')
              assertCandidate(record, changes.putRejoin)
              changes.putRejoin.ledgerBefore = [
                ...new Set([
                  ...changes.putRejoin.ledgerBefore,
                  ...(record.attempt?.ledgerBefore ?? []),
                  ...(source.rejoin?.ledgerBefore ?? []),
                  ...source.settledRejoins.flatMap((row) => row.ledgerBefore),
                  ...record.settlements.flatMap((row) => row.ledgerBefore),
                ]),
              ]
            }
            const obligations = [
              ...new Set([
                ...(source.rejoin?.ledgerBefore ?? []),
                ...(record.attempt?.ledgerBefore ?? []),
                ...source.settledRejoins.flatMap((row) => row.ledgerBefore),
                ...record.settlements.flatMap((row) => row.ledgerBefore),
              ]),
            ]
            for (const settlement of changes.putSettledRejoins ?? []) {
              if (
                record.attempt === null ||
                settlement.id !== record.attempt.id ||
                !sameStoredValue(settlement.origin, {
                  sourceKey: key,
                  target: record.attempt.target,
                  searchFrom: record.attempt.searchFrom,
                }) ||
                settlement.kind === 'superseded-branch'
              )
                throw new GroupStateConflictError('Manual settlement requires its bound attempt')
              settlement.ledgerBefore = [...new Set([...settlement.ledgerBefore, ...obligations])]
            }
            if (
              changes.deleteRejoin &&
              record.attempt !== null &&
              !changes.putSettledRejoins?.length
            )
              throw new GroupStateConflictError(
                'Manual attempt deletion requires its bound settlement',
              )
            const { putSettledRejoins, ...remaining } = changes
            const next = applyChanges(overlay(source, record), remaining, null, key)
            return {
              ...record,
              attempt: next.rejoin as CapturedRejoinRecord | null,
              epochFloor: next.recoveryEpochFloor,
              settlements: mergeSettlements(next.settledRejoins, putSettledRejoins ?? []),
            }
          })
        },
      }
    },
    async moveCurrent(id, runtime) {
      const mutationID = crypto.randomUUID()
      return await entry.run(
        { groupID: key.groupID, mutationID },
        async (reads) => {
          const lifetime = await reads.lifetime()
          const records = await reads.checkpoints()
          const record = findManualRecovery(records, key, id)
          assertNotSuperseded(records, record)
          if (record.stage !== 'authorised' || lifetime?.activeIncarnation !== key.incarnation)
            throw new GroupStateConflictError('Manual recovery source is no longer active')
          return { expected: lifetime, value: record }
        },
        async (stores, prepared) => {
          // Any other queued owner work could still publish from or advance this state.
          const { pending } = entry.activity(key.groupID, mutationID)
          const records = await stores.checkpoints.list()
          const record = findManualRecovery(records, key, id)
          if (!sameStoredValue(record, prepared) || record.choice.mode !== 'resync')
            throw new GroupStateConflictError('Manual recovery authorisation moved')
          const target = stores.incarnation(key.incarnation)
          const control = await target.control.load()
          const state = await target.state.load()
          const outbox = await target.outbox.list()
          let settlementUnresolved = false
          for (const entry of outbox)
            if ((await target.meta.loadSettlement(entry.seq)) !== null) settlementUnresolved = true
          const { condition } = groupCondition(records, key)
          const readable = state !== null && !state.deleted && state.state !== null ? state : null
          const current = canMoveCurrent({
            control,
            activity: { pending },
            stateReadable: readable !== null && readable.version === runtime.stateVersion,
            stateEpoch: readable?.epoch ?? null,
            ledgerComplete: runtime.ledgerComplete,
            walkComplete: control.cursor === null || control.cursor.epoch === readable?.epoch,
            outboxUnresolved: outbox.some(
              (entry) => entry.status === 'accepted' && entry.lastAttempt !== null,
            ),
            settlementUnresolved,
            hardHold: capability.held(key) ?? controlSafetyHeld(control, condition),
            condition,
            openForkNotice: records.some(
              (row) =>
                row.kind === 'notice' &&
                row.key.groupID === key.groupID &&
                row.notice.closedAt === null,
            ),
            // The executing choice counts once it saved a candidate or abandoned a fork intent.
            activeRejoin:
              record.attempt !== null ||
              record.abandonedForkRecovery !== undefined ||
              records.some(
                (row) =>
                  row.kind === 'manual-recovery' &&
                  row.id !== id &&
                  row.value.stage === 'authorised' &&
                  sameStoredValue(row.key, key),
              ),
            allowOpenFork: record.choice.allowOpenFork,
          })
          if (!current) return false
          // Hub positions are per hub; MLS state, holds and owed work stay exactly as they were.
          if (control.cursor !== null && control.cursor.position !== null)
            await target.control.apply(
              { cursor: { position: null, epoch: control.cursor.epoch } },
              mutationID,
            )
          for (const row of records) {
            if (row.key.groupID !== key.groupID || row.key.incarnation !== key.incarnation) continue
            if (row.kind === 'cursor' && row.position !== null)
              await stores.checkpoints.put({ ...row, position: null })
            if (row.kind === 'publication' && row.accepted && row.frame !== null)
              await stores.checkpoints.put({
                ...row,
                accepted: false,
                nextHeartbeatAt: null,
                retryAt: 0,
                retryDelay: 1000,
              })
          }
          await save(stores, {
            ...record,
            stage: 'completed',
            destination: { ...key },
            mutationID,
          })
          return true
        },
      )
    },
    readManualRecovery: (id) =>
      entry.read(key.groupID, async (reads) => {
        const records = await reads.checkpoints()
        return records.some((row) => row.kind === 'manual-recovery' && row.id === id)
          ? findManualRecovery(records, key, id)
          : null
      }),
    async resolveManualRecoveryTarget(id) {
      const record = await api.readManualRecovery(id)
      if (
        record === null ||
        record.choice.mode !== 'resync' ||
        (record.stage !== 'authorised' && record.stage !== 'completed')
      )
        throw new GroupStateConflictError('Resync authorisation required')
      let target: RecoveryTarget | null = null
      try {
        const resolved =
          liveTargets.get(params.registry)?.get(id) ??
          (await params.resolveTarget?.(record.choice.targetID))
        if (
          resolved?.id === record.choice.targetID &&
          resolved.commitTopicID === record.choice.commitTopicID &&
          validCallTimeTarget(resolved)
        )
          target = resolved
      } catch {
        /* An unavailable host binding pauses the saved choice. */
      }
      const pauseReason = target === null ? 'target-unresolved' : null
      await change(
        id,
        crypto.randomUUID(),
        (current) => (current.pauseReason === pauseReason ? null : { ...current, pauseReason }),
        true,
      )
      return target
    },
  }
  return api
}
