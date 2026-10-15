import {
  type ControlChanges,
  type ControlSearchPort,
  type ControlSnapshot,
  controlSafetyHeld,
  controlSettled,
  deliverObligations,
  type Outcome,
  type WelcomeObligation,
} from '@kumiai/rpc'

import { decodeControlJournal } from '../control-journal.js'
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
    if (switchedRejoinID !== undefined)
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
  search: ControlSearchPort
  deliverWelcome: (obligation: WelcomeObligation) => Promise<void>
}): Promise<{ delivered: Array<string>; remaining: Array<string>; failures: Array<unknown> }> {
  const snapshot = await readRetiredControl(params)
  const control = params.persistence.ports(params.key).control
  const accepted = new Set<string>()
  const failures: Array<unknown> = []
  let checked: Promise<boolean> | undefined
  try {
    await deliverObligations(
      {
        control,
        canDeliver: async (obligation) => {
          if (obligation.committed) return true
          const slot = snapshot.commitOnce
          const acceptance = snapshot.commitOnceAcceptance
          if (
            controlSafetyHeld(snapshot) !== null ||
            slot?.opID !== obligation.opID ||
            acceptance === null ||
            snapshot.strand !== null ||
            snapshot.cursor?.stranded === true ||
            (snapshot.controlHold !== null && snapshot.controlHold.reason !== 'acceptance-unknown')
          )
            return false
          checked ??= (async () => {
            const journal = decodeControlJournal(slot.journal)
            if (
              !sameStoredValue(journal.source.key, params.key) ||
              !sameStoredValue(acceptance.source, journal.source) ||
              acceptance.payloadDigest !== slot.payloadDigest ||
              acceptance.from !== slot.searchFrom ||
              journal.checkpoint !== slot.searchFrom ||
              slot.incarnation !== params.key.incarnation ||
              slot.epoch !== journal.source.identity?.epoch ||
              !sameStoredValue(slot.authenticatorBefore, journal.source.identity?.authenticator)
            )
              return false
            const result = await params.search.searchLog(slot)
            return (
              result.kind === 'first-valid' &&
              result.proof.payloadDigest === slot.payloadDigest &&
              result.proof.from === acceptance.from &&
              result.proof.position === acceptance.position &&
              sameStoredValue(result.proof.source, acceptance.source)
            )
          })()
          return checked
        },
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
