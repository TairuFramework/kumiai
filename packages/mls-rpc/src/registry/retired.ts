import type { ControlChanges, Outcome } from '@kumiai/rpc'

import { sameStoredValue } from '../memory-incarnation-stores.js'
import { DisplacedGroupHandleError, GroupStateConflictError } from '../persistence-errors.js'
import type { GroupKey, GroupStores, GroupTransaction } from '../persistence-types.js'

/** The caller drains source hooks before entering this transaction and saves the new lifetime after. */
export async function retireIncarnation<TTx extends GroupTransaction>(
  stores: GroupStores<TTx>,
  params: {
    source: GroupKey
    nextIncarnation: number
    switchedRejoinID?: string
    mutationID: string
    at: number
  },
): Promise<void> {
  const { source, nextIncarnation, switchedRejoinID, mutationID, at } = params
  const lifetime = await stores.lifetime.load()
  if (lifetime?.activeIncarnation !== source.incarnation)
    throw new DisplacedGroupHandleError('Inactive retirement source')
  if (
    stores.tx.groupID !== source.groupID ||
    lifetime.groupID !== source.groupID ||
    nextIncarnation !== lifetime.latestIncarnation + 1
  )
    throw new GroupStateConflictError('Retirement destination mismatch')

  const rows = stores.incarnation(source.incarnation)
  const control = await rows.control.load()
  const rejoin = control.rejoin
  if (
    switchedRejoinID !== undefined &&
    (rejoin?.id !== switchedRejoinID ||
      rejoin.stage !== 'confirmed' ||
      !sameStoredValue(rejoin.source.key, source))
  )
    throw new GroupStateConflictError('Retirement requires matching confirmed rejoin')

  const outcomes: Array<Outcome> = control.operations.map(({ id }) => ({
    id,
    opID: id,
    at,
    kind: 'unknown',
  }))
  const changes: ControlChanges = {
    deleteOperations: control.operations.map(({ id }) => id),
  }
  if (rejoin !== null) {
    if (switchedRejoinID !== undefined) changes.putRejoin = { ...rejoin, stage: 'adopted' }
    else {
      changes.deleteRejoin = true
      outcomes.push({ id: rejoin.id, opID: null, at, kind: 'unknown' })
    }
  }
  // Owed outcomes survive unchanged, including their original timestamps.
  changes.putOutcomes = outcomes.filter(({ id }) => !control.outcomes.some((row) => row.id === id))
  await rows.control.apply(changes, mutationID)

  for (const entry of await rows.outbox.list()) {
    if ((await rows.meta.loadSettlement(entry.seq)) !== null) continue
    const failed = { ...entry, status: 'failed' as const }
    await rows.outbox.put([failed])
    await rows.meta.putEvents([
      {
        ...source,
        id: JSON.stringify([
          'incarnation-abandoned',
          source.groupID,
          source.incarnation,
          entry.seq,
        ]),
        kind: 'failed',
        reason: 'incarnation-abandoned',
        entry: failed,
        nextIncarnation,
      },
    ])
    await rows.outbox.remove([entry.seq])
  }
}
