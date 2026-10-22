import {
  type ControlChanges,
  type ControlSnapshot,
  closeControlBuild,
  controlSettled,
  deleteOperationChanges,
  deliverObligations,
  type Outcome,
  type WelcomeObligation,
} from '@kumiai/rpc'

import { controlBuildContexts, controlRetirementSources } from '../control-write-context.js'
import { entryCapability } from '../entry-capability.js'
import { sameStoredValue } from '../memory-incarnation-stores.js'
import {
  DisplacedGroupHandleError,
  GroupControlUnsettledError,
  GroupStateConflictError,
} from '../persistence-errors.js'
import type {
  GroupKey,
  GroupPersistence,
  GroupStores,
  GroupTransaction,
} from '../persistence-types.js'
import { recoveryCompletionContexts } from '../recovery-completion-context.js'

/** All incarnations must be settled before clearing any transport. */
export async function deleteIncarnations<TTx extends GroupTransaction>(
  stores: GroupStores<TTx>,
  key: GroupKey,
  mutationID: string,
): Promise<void> {
  const lifetime = await stores.lifetime.load()
  if (lifetime?.activeIncarnation !== key.incarnation)
    throw new DisplacedGroupHandleError('Inactive deletion source')
  for (let incarnation = 1; incarnation <= lifetime.latestIncarnation; incarnation++) {
    const rows = stores.incarnation(incarnation)
    if (!controlSettled(await rows.control.load()))
      throw new GroupControlUnsettledError('Group control remains unsettled')
    for (const entry of await rows.outbox.list())
      if ((await rows.meta.loadSettlement(entry.seq)) !== null)
        throw new GroupControlUnsettledError('Certified publication remains unsettled')
  }
  const active = stores.incarnation(key.incarnation)
  for (const entry of await active.outbox.list()) {
    const failed = { ...entry, status: 'failed' as const }
    await active.outbox.put([failed])
    await active.meta.putEvents([
      {
        ...key,
        id: JSON.stringify(['deleted', key.groupID, key.incarnation, entry.seq]),
        kind: 'failed',
        reason: 'deleted',
        entry: failed,
      },
    ])
  }
  for (let incarnation = 1; incarnation <= lifetime.latestIncarnation; incarnation++)
    await stores.incarnation(incarnation).clearTransport()
  await stores.lifetime.save({
    ...lifetime,
    activeIncarnation: null,
    revision: lifetime.revision + 1,
    mutationID,
  })
}

/** The caller drains source hooks before entering this transaction and saves the new lifetime after.
 * A null destination retires the source to a successor tombstone instead of a next incarnation. */
export async function retireIncarnation<TTx extends GroupTransaction>(
  stores: GroupStores<TTx>,
  params: {
    source: GroupKey
    nextIncarnation: number | null
    switchedRejoinID?: string
    manualRejoinID?: string
    /** Manual candidates outside control whose acceptance stays unknown. */
    abandonedAttempts?: Array<string>
    mutationID: string
    at: number
  },
): Promise<void> {
  const { source, nextIncarnation, switchedRejoinID, manualRejoinID, mutationID, at } = params
  if (nextIncarnation === null && (switchedRejoinID !== undefined || manualRejoinID !== undefined))
    throw new GroupStateConflictError('Successor retirement adopts no rejoin')
  const lifetime = await stores.lifetime.load()
  if (lifetime?.activeIncarnation !== source.incarnation)
    throw new DisplacedGroupHandleError('Inactive retirement source')
  if (
    stores.tx.groupID !== source.groupID ||
    lifetime.groupID !== source.groupID ||
    (nextIncarnation !== null && nextIncarnation !== lifetime.latestIncarnation + 1)
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

  const abandoned = control.operations
  const outcomes: Array<Outcome> = abandoned.map(({ id }) => ({
    id,
    opID: id,
    at,
    kind: 'unknown',
  }))
  const closure = closeControlBuild(control, { kind: 'unknown' }, at, crypto.randomUUID())
  const changes: ControlChanges = {
    ...closure,
    spentSource: null,
    ...deleteOperationChanges(
      control,
      abandoned.map(({ id }) => id),
    ),
  }
  if (rejoin !== null && manualRejoinID === undefined) {
    if (switchedRejoinID !== undefined && nextIncarnation !== null)
      changes.putRejoin = {
        ...rejoin,
        stage: 'adopted',
        ...('format' in rejoin
          ? { destinationKey: { groupID: source.groupID, incarnation: nextIncarnation } }
          : {}),
      }
    else {
      changes.deleteRejoin = true
      outcomes.push({ id: rejoin.id, opID: null, at, kind: 'unknown' })
    }
  }
  for (const id of params.abandonedAttempts ?? [])
    outcomes.push({ id, opID: null, at, kind: 'unknown' })
  // Owed outcomes survive unchanged, including their original timestamps.
  changes.putOutcomes = [...(closure.putOutcomes ?? []), ...outcomes].filter(
    ({ id }) => !control.outcomes.some((row) => row.id === id),
  )
  if (control.forkRecoveryAttempt != null)
    recoveryCompletionContexts.set(stores.tx, {
      key: source,
      changes,
      forkRecovery: { attempt: null },
    })
  const previousContext = controlBuildContexts.get(stores.tx)
  // Closure precedes the pointer change, so the provider cannot infer retirement yet.
  controlBuildContexts.set(stores.tx, { kind: 'retirement', key: source })
  controlRetirementSources.set(stores.tx, { ...source })
  try {
    await rows.control.apply(changes, mutationID)
  } finally {
    if (previousContext === undefined) controlBuildContexts.delete(stores.tx)
    else controlBuildContexts.set(stores.tx, previousContext)
    recoveryCompletionContexts.delete(stores.tx)
  }

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
        ...(nextIncarnation === null ? {} : { nextIncarnation }),
      },
    ])
    await rows.outbox.remove([entry.seq])
  }
}

async function readRetiredControl<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>
  key: GroupKey
}): Promise<ControlSnapshot> {
  const capability = entryCapability(params.persistence)
  if (capability === null)
    throw new GroupStateConflictError('Retired service requires registered entry capability')
  return capability.read(params.key.groupID, async (reads) => {
    const lifetime = await reads.lifetime()
    if (
      lifetime === null ||
      params.key.incarnation < 1 ||
      !Number.isSafeInteger(params.key.incarnation) ||
      params.key.incarnation > lifetime.latestIncarnation ||
      lifetime.activeIncarnation === params.key.incarnation
    )
      throw new DisplacedGroupHandleError('Retired service requires a retired key')
    return reads.control(params.key.incarnation)
  })
}

export async function serveRetiredObligations<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>
  key: GroupKey
  deliverWelcome: (obligation: WelcomeObligation) => Promise<void>
}): Promise<{ delivered: Array<string>; remaining: Array<string>; failures: Array<unknown> }> {
  const snapshot = await readRetiredControl(params)
  const control = params.persistence.ports(params.key).control
  const accepted = new Set<string>()
  const failures: Array<unknown> = []
  try {
    await deliverObligations(
      {
        control,
        canDeliver: async () => true,
        deliverWelcome: async (obligation) => {
          await params.deliverWelcome(obligation)
          accepted.add(obligation.opID)
        },
      },
      snapshot,
    )
  } catch (error) {
    if (error instanceof AggregateError) failures.push(...error.errors)
    else failures.push(error)
  }
  const remaining = (await readRetiredControl(params)).welcomes.map(({ opID }) => opID)
  return {
    delivered: [...accepted].filter((opID) => !remaining.includes(opID)),
    remaining,
    failures,
  }
}

export async function listRetiredOutcomes<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>
  key: GroupKey
}): Promise<Array<Outcome>> {
  return (await readRetiredControl(params)).outcomes
}

export async function ackRetiredOutcome<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>
  key: GroupKey
  id: string
}): Promise<void> {
  await readRetiredControl(params)
  await params.persistence
    .ports(params.key)
    .control.apply({ deleteOutcomes: [params.id] }, crypto.randomUUID())
}
