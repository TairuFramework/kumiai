import type { CheckpointRecord, ControlChanges, ForkHalt } from '@kumiai/rpc'

import { coordinatorBinding } from './entry-capability.js'
import { copyStoredValue, sameStoredValue } from './memory-incarnation-stores.js'
import { GroupStateConflictError } from './persistence-errors.js'
import type {
  GroupKey,
  GroupPersistence,
  GroupStores,
  GroupTransaction,
} from './persistence-types.js'
import { registrySafety } from './registry/safety.js'
import type { GroupHandleRegistry } from './registry/types.js'

type AppHold = Extract<CheckpointRecord, { kind: 'app-hold' }>
type HoldRecord = Extract<CheckpointRecord, { kind: 'app-hold' | 'hold-history' }>
type ClearAuthority = {
  key: GroupKey
  halt: ForkHalt
  provenance: AppHold
  mutationID: string
}
const preparations = new WeakMap<HoldRecord, HoldRecord>()
const clearAuthorities = new WeakMap<GroupTransaction, ClearAuthority>()

function prepare<TRecord extends HoldRecord>(record: TRecord): TRecord {
  preparations.set(record, copyStoredValue(record))
  return record
}

export function appHoldPreparation(record: HoldRecord): HoldRecord | undefined {
  return preparations.get(record)
}

export async function writeAppHoldReport<TTx extends GroupTransaction>(
  stores: GroupStores<TTx>,
  key: GroupKey,
  halt: ForkHalt,
  mutationID: string,
): Promise<void> {
  if (halt.producer !== 'app-report') throw new GroupStateConflictError('App report required')
  const id = JSON.stringify(['app-hold', key.groupID, key.incarnation, mutationID])
  if ((await stores.checkpoints.load(id)) !== null)
    throw new GroupStateConflictError('App report identity already used')
  await stores.checkpoints.put(
    prepare({
      kind: 'app-hold',
      id,
      key: { ...key },
      producer: 'app-report',
      eventID: halt.eventID,
      reportMutationID: mutationID,
      clearedAt: null,
    }),
  )
  await stores.incarnation(key.incarnation).control.apply({ forkHalt: halt }, mutationID)
}

export function consumeAppHoldClear(params: {
  tx: GroupTransaction
  key: GroupKey
  changes: ControlChanges
  halt: ForkHalt | null
  mutationID: string
  records: Array<CheckpointRecord>
}): ControlChanges['clearAppHold'] {
  if (!('clearAppHold' in params.changes)) return undefined
  const authority = clearAuthorities.get(params.tx)
  clearAuthorities.delete(params.tx)
  if (
    authority === undefined ||
    authority.mutationID !== params.mutationID ||
    !sameStoredValue(authority.key, params.key) ||
    !sameStoredValue(authority.halt, params.halt) ||
    params.halt?.producer !== 'app-report' ||
    !sameStoredValue(params.changes.clearAppHold, {
      eventID: authority.provenance.eventID,
      reportMutationID: authority.provenance.reportMutationID,
    }) ||
    !params.records.some((row) => sameStoredValue(row, authority.provenance)) ||
    !params.records.some(
      (row) =>
        row.kind === 'hold-history' &&
        sameStoredValue(row.key, params.key) &&
        row.reportMutationID === authority.provenance.reportMutationID &&
        sameStoredValue(row.halt, params.halt),
    )
  )
    throw new GroupStateConflictError('App hold release requires matching report and history')
  return params.changes.clearAppHold
}

class ClearNoop extends Error {}

// Storage only. Registry and peer release propagation is installed separately.
export function createClearReportedHold<TTx extends GroupTransaction>(params: {
  registry: GroupHandleRegistry
  persistence: GroupPersistence<TTx>
}): (key: GroupKey) => Promise<void> {
  const capability = registrySafety<TTx>(params.registry)
  if (capability === null || capability.binding !== coordinatorBinding(params.persistence))
    throw new TypeError('Hold release requires the registered coordinator')
  return async function clearReportedHold(requested) {
    const key = { ...requested }
    const mutationID = crypto.randomUUID()
    try {
      await capability.entry.run(
        { groupID: key.groupID, mutationID },
        async (reads) => {
          const lifetime = await reads.lifetime()
          if (lifetime?.activeIncarnation !== key.incarnation) throw new ClearNoop()
          const halt = (await reads.control(key.incarnation)).forkHalt
          // Legacy and internal halts never acquire app ownership from their event ID.
          if (halt?.producer !== 'app-report') throw new ClearNoop()
          const provenance = (await reads.checkpoints()).find(
            (row): row is AppHold =>
              row.kind === 'app-hold' &&
              row.producer === 'app-report' &&
              sameStoredValue(row.key, key) &&
              row.eventID === halt.eventID &&
              row.clearedAt === null,
          )
          if (provenance === undefined) throw new ClearNoop()
          return { expected: lifetime, value: { halt, provenance } }
        },
        async (stores, { halt, provenance }) => {
          const target = stores.incarnation(key.incarnation)
          if (
            (await stores.lifetime.load())?.activeIncarnation !== key.incarnation ||
            !sameStoredValue((await target.control.load()).forkHalt, halt) ||
            !sameStoredValue(await stores.checkpoints.load(provenance.id), provenance)
          )
            throw new GroupStateConflictError('Reported hold moved')
          const cleared = prepare({ ...provenance, clearedAt: Date.now() })
          await stores.checkpoints.put(
            prepare({
              kind: 'hold-history',
              id: JSON.stringify([
                'hold-history',
                key.groupID,
                key.incarnation,
                provenance.reportMutationID,
              ]),
              key,
              halt,
              reportMutationID: provenance.reportMutationID,
            }),
          )
          await stores.checkpoints.put(cleared)
          clearAuthorities.set(stores.tx, { key, halt, provenance: cleared, mutationID })
          try {
            await target.control.apply(
              {
                clearAppHold: {
                  eventID: provenance.eventID,
                  reportMutationID: provenance.reportMutationID,
                },
              },
              mutationID,
            )
          } finally {
            clearAuthorities.delete(stores.tx)
          }
        },
      )
    } catch (error) {
      if (!(error instanceof ClearNoop)) throw error
    }
  }
}
