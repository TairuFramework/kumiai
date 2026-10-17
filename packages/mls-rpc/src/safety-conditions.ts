import { normalizeDID } from '@kokuin/token'
import { decodeEpochRosterFact } from '@kumiai/mls'
import type {
  AuthenticatedRosterAbsence,
  CheckpointRecord,
  CheckpointStore,
  GroupCondition,
  NotMemberEvidence,
} from '@kumiai/rpc'

import { provenCheckpointFacts } from './checkpoint-store.js'
import type { EntryCapability, EntryReads } from './entry-capability.js'
import { copyStoredValue, sameStoredValue } from './memory-incarnation-stores.js'
import { GroupStateConflictError } from './persistence-errors.js'
import type { GroupKey, GroupTransaction } from './persistence-types.js'
import { verifyRosterAbsence } from './recovery.js'
import { registrySafety } from './registry/safety.js'
import { readRecoverySource } from './registry/source.js'
import type { GroupHandleRegistry } from './registry/types.js'
import type { RecoveryEnvironment } from './registry/validation.js'

type ComparisonFact = { epoch: number; authHash: string; confirmedTranscriptHash: string }
type ConditionRecord = Extract<CheckpointRecord, { kind: 'condition' }>
const preparations = new WeakMap<ConditionRecord, ConditionRecord>()

export function conditionPreparation(record: ConditionRecord): ConditionRecord | undefined {
  return preparations.get(record)
}

function prepare(record: ConditionRecord): ConditionRecord {
  preparations.set(record, copyStoredValue(record))
  return record
}

export function retainedComparisonFacts(records: Array<CheckpointRecord>, key: GroupKey) {
  return provenCheckpointFacts(records, key.groupID).map((row) =>
    decodeEpochRosterFact(row.canonical),
  )
}

export function absenceFreshness(
  absence: AuthenticatedRosterAbsence,
  latestEpoch: number,
  facts: Array<ComparisonFact>,
): 'fresh' | 'freshness' | 'comparison-missing' {
  const common = absence.lineage
    .flatMap((remote) => {
      const local = facts.find((fact) => fact.epoch === remote.epoch)
      return local === undefined ? [] : [{ local, remote }]
    })
    .sort((a, b) => b.local.epoch - a.local.epoch)
  const offered = facts.find((fact) => fact.epoch === absence.epoch)
  if (common.length === 0) return 'comparison-missing'
  if (
    common.some(({ local, remote }) => local.authHash !== remote.authHash) ||
    (offered !== undefined && offered.confirmedTranscriptHash !== absence.confirmedTranscriptHash)
  )
    return 'fresh'
  return absence.epoch > latestEpoch ? 'fresh' : 'freshness'
}

export function groupCondition(
  records: Array<CheckpointRecord>,
  key: GroupKey,
): {
  condition: GroupCondition | null
  evidence: NotMemberEvidence | null
  eventID?: string
} {
  const row = records
    .filter(
      (row): row is ConditionRecord =>
        row.kind === 'condition' &&
        row.active &&
        row.key.groupID === key.groupID &&
        row.key.incarnation === key.incarnation,
    )
    .sort(
      (a, b) =>
        Number(a.event.kind === 'spent-set-corrupt') -
          Number(b.event.kind === 'spent-set-corrupt') || a.event.detectedAt - b.event.detectedAt,
    )
    .at(-1)
  return row === undefined
    ? { condition: null, evidence: null }
    : {
        condition: row.event.kind,
        evidence: copyStoredValue(row.event.evidence),
        eventID: row.event.id,
      }
}

export async function clearGroupCondition(store: CheckpointStore, key: GroupKey): Promise<void> {
  for (const row of await store.list()) {
    if (
      row.kind === 'condition' &&
      row.event.kind === 'not-member' &&
      row.active &&
      row.key.groupID === key.groupID &&
      row.key.incarnation === key.incarnation
    )
      await store.put(prepare({ ...row, active: false }))
  }
}

class ConditionNoop extends Error {}

export function createNotMemberHandler(params: {
  registry: GroupHandleRegistry
  key: GroupKey
  recovery: RecoveryEnvironment
  current(): boolean
}): (input: { evidence: Uint8Array; requestID: string; requestKey: Uint8Array }) => Promise<void> {
  const capability = registrySafety<GroupTransaction>(params.registry)
  if (capability === null) throw new TypeError('Registered condition coordinator required')
  const { entry } = capability
  const key = { ...params.key }
  return async (input) => {
    const proof = {
      evidence: input.evidence.slice(),
      requestID: input.requestID,
      requestKey: input.requestKey.slice(),
    }
    try {
      await entry.run(
        { groupID: key.groupID, mutationID: crypto.randomUUID() },
        async (reads: EntryReads) => {
          if (!params.current()) throw new ConditionNoop()
          const lifetime = await reads.lifetime()
          if (lifetime?.activeIncarnation !== key.incarnation) throw new ConditionNoop()
          const source = await readRecoverySource(reads, key.groupID)
          const verified = await verifyRosterAbsence({
            ...proof,
            trust: source.trust,
            options: params.recovery.options,
          })
          if (
            !params.current() ||
            verified === null ||
            verified.groupID !== key.groupID ||
            normalizeDID(verified.requesterDID) !== normalizeDID(source.trust.credential.id)
          )
            throw new ConditionNoop()
          const records = await reads.checkpoints()
          const facts = retainedComparisonFacts(records, key)
          if (
            source.identity === null ||
            absenceFreshness(verified, source.identity.epoch, facts) !== 'fresh'
          )
            throw new ConditionNoop()
          const old = records.filter(
            (row): row is ConditionRecord =>
              row.kind === 'condition' &&
              row.key.groupID === key.groupID &&
              row.key.incarnation === key.incarnation,
          )
          const responderDIDs = [
            ...new Set([
              ...old.flatMap((row) => row.event.evidence?.responderDIDs ?? []),
              normalizeDID(verified.responderDID),
            ]),
          ].sort()
          const authHash = verified.lineage.find((row) => row.epoch === verified.epoch)?.authHash
          if (authHash === undefined) throw new ConditionNoop()
          const novelDID = !old.some((row) =>
            row.event.evidence?.responderDIDs.includes(normalizeDID(verified.responderDID)),
          )
          if (
            !novelDID &&
            old.some(
              (row) =>
                row.event.evidence?.responderKeyHash === verified.responderKeyHash &&
                row.event.evidence.epoch === verified.epoch &&
                row.event.evidence.authHash === authHash,
            )
          )
            throw new ConditionNoop()
          const now = Date.now()
          const evidence: NotMemberEvidence = {
            responderKeyHash: verified.responderKeyHash,
            epoch: verified.epoch,
            authHash,
            observedAt: now,
            responderDIDs,
            responderCount: responderDIDs.length,
          }
          const id = JSON.stringify([
            'not-member',
            key.groupID,
            key.incarnation,
            verified.responderKeyHash,
            verified.epoch,
            authHash,
            responderDIDs,
          ])
          const lastEmission = Math.max(
            0,
            ...old
              .filter((row) => row.notification?.emitted)
              .map((row) => row.notification?.emitAt ?? 0),
          )
          const pending = old.find((row) => row.notification?.emitted === false)?.notification
            ?.emitAt
          const emitAt = pending ?? (lastEmission === 0 ? now : Math.max(now, lastEmission + 30000))
          const currentFact = records.find(
            (row) => row.kind === 'coverage' && row.id === 'coverage',
          )
          const installationID =
            currentFact?.kind === 'coverage' ? currentFact.installations.at(-1)?.id : undefined
          if (installationID === undefined) throw new ConditionNoop()
          const row = prepare({
            kind: 'condition',
            id,
            key,
            active: true,
            sealedProof: proof.evidence,
            notification: { emitAt, emitted: emitAt <= now, installationID },
            event: { ...key, id, kind: 'not-member', detectedAt: now, evidence },
          })
          return { expected: lifetime, value: { row, source } }
        },
        async (stores, { row, source }) => {
          if (!params.current()) throw new ConditionNoop()
          const lifetime = await stores.lifetime.load()
          const trust = await stores.trust.load()
          if (
            lifetime?.activeIncarnation !== key.incarnation ||
            !sameStoredValue(trust?.installed, source.identity)
          )
            throw new GroupStateConflictError('Absence source moved')
          await clearGroupCondition(stores.checkpoints, key)
          for (const previous of await stores.checkpoints.list()) {
            if (
              previous.kind === 'condition' &&
              previous.key.incarnation === key.incarnation &&
              previous.notification?.emitted === false
            )
              await stores.checkpoints.put(
                prepare({ ...previous, notification: { ...previous.notification, emitted: true } }),
              )
          }
          await stores.checkpoints.put(row)
          if (row.notification?.emitted)
            await stores.incarnation(key.incarnation).meta.putEvents([row.event])
        },
      )
    } catch (error) {
      if (!(error instanceof ConditionNoop)) throw error
    } finally {
      proof.requestKey.fill(0)
    }
  }
}

export async function flushConditionEvents(
  registry: GroupHandleRegistry,
  key: GroupKey,
  current: () => boolean = () => true,
): Promise<void> {
  const capability = registrySafety<GroupTransaction>(registry)
  if (capability === null) throw new TypeError('Registered condition coordinator required')
  try {
    await capability.entry.run(
      { groupID: key.groupID, mutationID: crypto.randomUUID() },
      async (reads) => {
        if (!current()) throw new ConditionNoop()
        const rows = (await reads.checkpoints()).filter(
          (row): row is ConditionRecord =>
            row.kind === 'condition' &&
            row.key.incarnation === key.incarnation &&
            row.notification?.emitted === false &&
            row.notification.emitAt <= Date.now(),
        )
        if (rows.length === 0) throw new ConditionNoop()
        return { expected: await reads.lifetime(), value: rows }
      },
      async (stores, rows) => {
        if (!current()) throw new ConditionNoop()
        for (const row of rows) {
          if (row.notification === undefined) continue
          await stores.checkpoints.put(
            prepare({ ...row, notification: { ...row.notification, emitted: true } }),
          )
          await stores.incarnation(key.incarnation).meta.putEvents([row.event])
        }
      },
    )
  } catch (error) {
    if (!(error instanceof ConditionNoop)) throw error
  }
}

class ConditionAlreadyStored extends Error {}

export function groupConditionWriter<TTx extends GroupTransaction>(params: {
  entry: EntryCapability<TTx>
  latch(key: GroupKey, reason: 'spent-set-corrupt'): void
}) {
  return async (
    requested: GroupKey,
    condition: 'spent-set-corrupt',
    evidence: null,
  ): Promise<void> => {
    const key = { ...requested }
    const id = JSON.stringify([condition, key.groupID, key.incarnation])
    try {
      await params.entry.run(
        { groupID: key.groupID, mutationID: crypto.randomUUID() },
        async (reads) => {
          const lifetime = await reads.lifetime()
          if (lifetime?.latestIncarnation !== key.incarnation) throw new ConditionAlreadyStored()
          params.latch(key, condition)
          if ((await reads.checkpoints()).some((row) => row.id === id))
            throw new ConditionAlreadyStored()
          return { expected: lifetime, value: Date.now() }
        },
        async (stores, detectedAt) => {
          if ((await stores.checkpoints.load(id)) !== null) throw new ConditionAlreadyStored()
          const event = { ...key, id, kind: condition, detectedAt, evidence }
          await stores.checkpoints.put(
            prepare({ kind: 'condition', id, key, event, active: true, sealedProof: null }),
          )
          await stores.incarnation(key.incarnation).meta.putEvents([event])
        },
      )
    } catch (error) {
      if (!(error instanceof ConditionAlreadyStored)) throw error
    }
  }
}
