import type { CheckpointRecord, GroupKey, ManualRecoveryRecord } from '@kumiai/rpc'

import { coordinatorBinding } from './entry-capability.js'
import {
  createManualRecoveryStore,
  findManualRecovery,
  saveManualRecovery,
  saveSuccessorTombstone,
} from './manual-recovery.js'
import { copyStoredValue, sameStoredValue } from './memory-incarnation-stores.js'
import { GroupStateConflictError, ManualRecoveryUnavailableError } from './persistence-errors.js'
import type { GroupPersistence, GroupTransaction } from './persistence-types.js'
import { retireIncarnation } from './registry/retired.js'
import { registrySafety } from './registry/safety.js'
import type { GroupHandleRegistry } from './registry/types.js'

class Noop extends Error {}

// A successor held, terminal (not a member) or restored from backup is no exit.
const unavailable = new Set([
  'fork-halted',
  'recovery-unavailable',
  'spent-set-corrupt',
  'terminal',
  'backup-restored',
])

export function openSuccessorTombstone(records: Array<CheckpointRecord>, groupID: string): boolean {
  return records.some(
    (row) =>
      row.kind === 'successor' && row.key.groupID === groupID && row.value.clearedAt === null,
  )
}

function completedSuccessor(
  records: Array<CheckpointRecord>,
  source: GroupKey,
): ManualRecoveryRecord | null {
  const row = records.find(
    (row) =>
      row.kind === 'manual-recovery' &&
      row.value.choice.mode === 'successor' &&
      row.value.stage === 'completed' &&
      sameStoredValue(row.key, source),
  )
  return row?.kind === 'manual-recovery' ? copyStoredValue(row.value) : null
}

/** Reads only the successor's own gate: the source gate is never held at the same time. */
async function assertAdmittedSuccessor(
  registry: GroupHandleRegistry,
  successor: GroupKey,
): Promise<void> {
  let access: Awaited<ReturnType<GroupHandleRegistry['access']>>
  try {
    access = await registry.access(successor.groupID)
  } catch (cause) {
    throw new ManualRecoveryUnavailableError('Successor is not admitted', { cause })
  }
  const admission = access.admission()
  if (
    !sameStoredValue(access.key, successor) ||
    (!admission.admissible && unavailable.has(admission.reason))
  )
    throw new ManualRecoveryUnavailableError('Successor is not available')
}

/** Retires the source in favour of an already admitted successor. Nothing is copied. */
export async function retireToSuccessor<TTx extends GroupTransaction>(params: {
  registry: GroupHandleRegistry
  persistence: GroupPersistence<TTx>
  source: GroupKey
  successor: GroupKey
}): Promise<GroupKey> {
  const { registry } = params
  const source = { ...params.source }
  const successor = { groupID: params.successor.groupID, incarnation: params.successor.incarnation }
  const capability = registrySafety<TTx>(registry)
  if (capability === null || capability.binding !== coordinatorBinding(params.persistence))
    throw new TypeError('Successor recovery requires a registry with the same coordinator')
  const done = await capability.entry.read(source.groupID, async (reads) =>
    completedSuccessor(await reads.checkpoints(), source),
  )
  if (done !== null) {
    if (done.choice.mode === 'successor' && sameStoredValue(done.choice.successor, successor))
      return successor
    throw new GroupStateConflictError('Source already retired to another successor')
  }
  await assertAdmittedSuccessor(registry, successor)
  const authorised = await createManualRecoveryStore({
    registry,
    persistence: params.persistence,
    key: source,
  }).authoriseManualRecovery(source, { mode: 'successor', successor })
  await capability.retire(
    source,
    async (stores, mutationID) => {
      const records = await stores.checkpoints.list()
      const record = findManualRecovery(records, source, authorised.id)
      if (record.stage !== 'authorised' || !sameStoredValue(record.choice, authorised.choice))
        throw new GroupStateConflictError('Successor authorisation moved')
      const lifetime = await stores.lifetime.load()
      if (lifetime === null) throw new GroupStateConflictError('Missing retirement lifetime')
      const at = Date.now()
      await retireIncarnation(stores, {
        source,
        nextIncarnation: null,
        // Superseded manual candidates may have been accepted; their outcome stays owed.
        abandonedAttempts: records.flatMap((row) =>
          row.kind === 'manual-recovery' &&
          sameStoredValue(row.key, source) &&
          row.value.stage === 'authorised' &&
          row.value.attempt !== null
            ? [row.value.attempt.id]
            : [],
        ),
        mutationID,
        at,
      })
      await stores.lifetime.save({
        ...lifetime,
        activeIncarnation: null,
        revision: lifetime.revision + 1,
        mutationID,
      })
      await saveManualRecovery(stores, {
        ...record,
        stage: 'completed',
        destination: successor,
        mutationID,
      })
      await saveSuccessorTombstone(stores, {
        kind: 'successor-tombstone',
        id: `successor:${record.id}`,
        source,
        successor,
        authorisationID: record.id,
        retiredAt: at,
        clearedAt: null,
      })
    },
    // The successor may have moved while the source drained.
    () => assertAdmittedSuccessor(registry, successor),
  )
  return successor
}

/** Lifts only the successor readmission block; spent checks and safety latches remain. */
export async function clearSuccessorTombstone<TTx extends GroupTransaction>(params: {
  registry: GroupHandleRegistry
  persistence: GroupPersistence<TTx>
  groupID: string
}): Promise<void> {
  const { groupID } = params
  if (typeof groupID !== 'string' || groupID.length === 0)
    throw new TypeError('Invalid tombstone group')
  const capability = registrySafety<TTx>(params.registry)
  if (capability === null || capability.binding !== coordinatorBinding(params.persistence))
    throw new TypeError('Tombstone clear requires a registry with the same coordinator')
  const open = (records: Array<CheckpointRecord>) =>
    records.flatMap((row) =>
      row.kind === 'successor' && row.key.groupID === groupID && row.value.clearedAt === null
        ? [row.value]
        : [],
    )
  try {
    await capability.entry.run(
      { groupID, mutationID: crypto.randomUUID() },
      async (reads) => {
        const values = open(await reads.checkpoints())
        if (values.length === 0) throw new Noop()
        return { expected: await reads.lifetime(), value: values }
      },
      async (stores, values) => {
        const current = open(await stores.checkpoints.list())
        if (!sameStoredValue(current, values))
          throw new GroupStateConflictError('Successor tombstone moved')
        const clearedAt = Date.now()
        for (const value of current) await saveSuccessorTombstone(stores, { ...value, clearedAt })
      },
    )
  } catch (error) {
    if (!(error instanceof Noop)) throw error
  }
}
