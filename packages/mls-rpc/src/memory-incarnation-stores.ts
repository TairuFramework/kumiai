import {
  applyChanges,
  type CommitOnceWriteContext,
  type ControlChanges,
  type ControlSnapshot,
  forkEventID,
} from '@kumiai/rpc'

import { controlBuildContexts } from './control-write-context.js'
import {
  assertMemoryWrite,
  createUnlockedGroupStateStores,
  memoryCallback,
  memoryOpen,
  memoryOperation,
  memoryReadAdmitted,
  memoryRequired,
  memorySeal,
} from './memory-group-state.js'
import {
  decodeStoredValue,
  encodeStoredValue,
  physicalRecordKey,
  topicLocator,
} from './persistence-codec.js'
import {
  DisplacedGroupHandleError,
  GroupStateConflictError,
  OutboxReplacementError,
} from './persistence-errors.js'
import type {
  AppOutboxEntry,
  AppPoisonRecord,
  AppSettlementObligation,
  AppStatusEvent,
  AtRestCodec,
  GroupKey,
  IncarnationStores,
  MemoryTransaction,
  PendingAppFrame,
  PersistenceEvent,
} from './persistence-types.js'
import { recoveryCompletionContexts } from './recovery-completion-context.js'

export type GroupOwnerMarker = { revision: number; mutationID: string }

export function copyStoredValue<TValue>(value: TValue): TValue {
  return decodeStoredValue(encodeStoredValue(value)) as TValue
}

export function sameStoredValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left instanceof Uint8Array && right instanceof Uint8Array)
    return left.length === right.length && left.every((byte, index) => byte === right[index])
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value, index) => sameStoredValue(value, right[index]))
    )
  if (left instanceof Map && right instanceof Map) return sameStoredValue([...left], [...right])
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false
  const a = Object.entries(left)
  const b = Object.entries(right)
  return (
    a.length === b.length &&
    a.every(
      ([key, value]) =>
        Object.hasOwn(right, key) && sameStoredValue(value, Reflect.get(right, key)),
    )
  )
}

export function memoryRecordTable<TValue>(params: {
  tx: MemoryTransaction
  key: { groupID: string; incarnation: number | null }
  namespace: string
  atRest: AtRestCodec
  requiredOpen?: boolean
}) {
  const { tx, key, namespace, atRest } = params
  if (tx.groupID !== key.groupID) throw new GroupStateConflictError('Transaction group mismatch')
  const address = (recordID: string) => ({ ...key, namespace, recordID })
  const map = () => {
    const rows = tx.rows[namespace]
    if (rows === undefined) throw new GroupStateConflictError('Missing transaction namespace')
    return rows
  }
  const table = {
    async load(recordID: string): Promise<TValue | null> {
      const location = address(recordID)
      const id = physicalRecordKey(location)
      const value = await memoryRequired(
        tx,
        async () => {
          const rows = map()
          memoryReadAdmitted(tx, params.requiredOpen)
          const bytes = rows.get(id)
          if (bytes === undefined) return null
          if (!(bytes instanceof Uint8Array))
            throw new GroupStateConflictError('Unreadable sealed row')
          return (await memoryOpen(tx, atRest, location, bytes)) as TValue
        },
        params.requiredOpen,
      )
      map().has(id)
      return value
    },
    async save(recordID: string, value: TValue): Promise<void> {
      const location = address(recordID)
      const bytes = await memorySeal(tx, atRest, location, value)
      map().set(physicalRecordKey(location), bytes)
    },
    remove(recordID: string): boolean {
      const id = physicalRecordKey(address(recordID))
      return map().has(id) ? map().delete(id) : false
    },
    ids(): Array<string> {
      const ids: Array<string> = []
      for (const id of map().keys()) {
        const locator: unknown = JSON.parse(id)
        if (
          Array.isArray(locator) &&
          locator[0] === key.groupID &&
          locator[1] === key.incarnation &&
          typeof locator[2] === 'string'
        )
          ids.push(locator[2])
      }
      return ids
    },
    async list(): Promise<Array<TValue>> {
      const values: Array<TValue> = []
      for (const id of table.ids()) {
        const value = await table.load(id)
        if (value !== null) values.push(value)
      }
      return values
    },
  }
  return table
}

export function groupOwnerKey(groupID: string): string {
  return physicalRecordKey({
    groupID,
    incarnation: null,
    namespace: 'group-owner',
    recordID: 'current',
  })
}

export function groupMutationID(tx: MemoryTransaction, groupID: string): string {
  const value = tx.rows['group-owner']?.get(groupOwnerKey(groupID)) as GroupOwnerMarker | undefined
  if (value === undefined) throw new GroupStateConflictError('Missing group mutation owner')
  return value.mutationID
}

export function statusEventID(
  mutationID: string,
  seq: number,
  kind: AppStatusEvent['kind'],
): string {
  return JSON.stringify([mutationID, seq, kind])
}

export type ControlRecord = { snapshot: ControlSnapshot; mutationID: string }

const emptyControl = (): ControlSnapshot => ({
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
})

export function copyControlChanges(changes: ControlChanges, key: GroupKey): ControlChanges {
  const { forkHalt, recoveryUnavailable, ...ordinary } = changes
  // Materialize safety before an own-property clone can erase supplied fields.
  const safety = applyChanges(
    emptyControl(),
    {
      ...('forkHalt' in changes ? { forkHalt } : {}),
      ...('recoveryUnavailable' in changes ? { recoveryUnavailable } : {}),
    },
    null,
    key,
  )
  return {
    ...copyStoredValue(ordinary),
    ...(safety.forkHalt === null ? {} : { forkHalt: safety.forkHalt }),
    ...(safety.recoveryUnavailable === null
      ? {}
      : { recoveryUnavailable: safety.recoveryUnavailable }),
  }
}

const settlementID = (seq: number) => JSON.stringify(['settlement', seq])
const eventID = (id: string) => JSON.stringify(['event', id])

function laneOrder(
  left: { frame: PendingAppFrame['frame'] | AppPoisonRecord['frame'] },
  right: { frame: PendingAppFrame['frame'] | AppPoisonRecord['frame'] },
): number {
  const a = left.frame
  const b = right.frame
  const topicOrder = a.topicID < b.topicID ? -1 : a.topicID > b.topicID ? 1 : 0
  const positionOrder =
    BigInt(a.position) < BigInt(b.position) ? -1 : BigInt(a.position) > BigInt(b.position) ? 1 : 0
  return (
    a.incarnation - b.incarnation ||
    a.segment - b.segment ||
    topicOrder ||
    positionOrder ||
    a.id.localeCompare(b.id)
  )
}

// Only callers already holding the transaction lock use these helpers.
export function createUnlockedIncarnationStores(params: {
  tx: MemoryTransaction
  key: GroupKey
  atRest: AtRestCodec
  adoptionContext?: () => Promise<CommitOnceWriteContext | null>
  requiredOpen?: boolean
}): IncarnationStores {
  const { tx, atRest } = params
  const key = { ...params.key }
  const stateStores = createUnlockedGroupStateStores({
    tx,
    groupID: key.groupID,
    atRest,
    requiredOpen: params.requiredOpen,
  })
  const table = <TValue>(namespace: string) =>
    memoryRecordTable<TValue>({ tx, key, namespace, atRest, requiredOpen: params.requiredOpen })
  const control = table<ControlRecord>('control')
  const anchor = table<Awaited<ReturnType<IncarnationStores['anchor']['load']>>>('anchor')
  const pending = table<PendingAppFrame>('pending')
  const poison = table<AppPoisonRecord>('poison')
  const cursor = table<{ topicID: string; position: string }>('cursor')
  const outbox = table<AppOutboxEntry>('outbox')
  const meta = table<AppSettlementObligation | PersistenceEvent>('meta')
  async function active(): Promise<void> {
    const life = await stateStores.lifetime.load()
    if (life?.activeIncarnation !== key.incarnation)
      throw new DisplacedGroupHandleError('Inactive group incarnation')
  }
  function frameKey(frame: PendingAppFrame['frame'] | AppPoisonRecord['frame']): void {
    if (frame.groupID !== key.groupID || frame.incarnation !== key.incarnation)
      throw new GroupStateConflictError('Frame identity mismatch')
    if (!/^\d+$/.test(frame.position)) throw new GroupStateConflictError('Invalid lane position')
  }
  async function putEvent(event: PersistenceEvent): Promise<void> {
    if (event.groupID !== key.groupID || event.incarnation !== key.incarnation)
      throw new GroupStateConflictError('Event identity mismatch')
    const id = eventID(event.id)
    const previous = await meta.load(id)
    if (previous !== null && !sameStoredValue(previous, event))
      throw new GroupStateConflictError('Conflicting persistence event')
    if (previous === null) await meta.save(id, event)
  }
  async function events(): Promise<Array<PersistenceEvent>> {
    const values: Array<PersistenceEvent> = []
    for (const id of meta.ids()) {
      if (JSON.parse(id)[0] !== 'event') continue
      const value = await meta.load(id)
      if (value !== null) values.push(value as PersistenceEvent)
    }
    return values
  }
  async function loadSettlement(seq: number): Promise<AppSettlementObligation | null> {
    return (await meta.load(settlementID(seq))) as AppSettlementObligation | null
  }
  async function remove(seq: number): Promise<void> {
    const entry = await outbox.load(String(seq))
    if (entry === null) return
    const obligation = await loadSettlement(seq)
    if (obligation !== null) {
      const published = (await events()).find(
        (event) =>
          event.kind === 'published' &&
          event.entry.seq === seq &&
          sameStoredValue(event.entry, entry) &&
          event.occurrence.incarnation === key.incarnation &&
          event.occurrence.position === obligation.sequenceID &&
          event.occurrence.topicID === obligation.topicID &&
          event.occurrence.segment === entry.lastAttempt?.segment &&
          entry.lastAttempt.publishID === obligation.attemptID,
      )
      if (published === undefined)
        throw new GroupStateConflictError('Certified entry requires its original occurrence')
    } else {
      const existing = (await events()).some(
        (event) =>
          (event.kind === 'failed' &&
            (event.reason === 'incarnation-abandoned' || event.reason === 'deleted') &&
            event.id === JSON.stringify([event.reason, key.groupID, key.incarnation, seq]) &&
            sameStoredValue(event.entry, entry)) ||
          ((event.kind === 'published' || event.kind === 'failed') &&
            event.entry.seq === seq &&
            event.id.startsWith(`[${JSON.stringify(groupMutationID(tx, key.groupID))},`)),
      )
      if (!existing)
        await putEvent({
          ...key,
          id: statusEventID(groupMutationID(tx, key.groupID), seq, 'failed'),
          kind: 'failed',
          reason: 'removed',
          entry,
        })
    }
    outbox.remove(String(seq))
    meta.remove(settlementID(seq))
  }
  return {
    state: stateStores.state(key.incarnation),
    control: {
      async load() {
        const snapshot = (await control.load('current'))?.snapshot ?? emptyControl()
        return {
          ...snapshot,
          recoveryEpochFloor: snapshot.recoveryEpochFloor ?? null,
          settledRejoins: snapshot.settledRejoins ?? [],
        }
      },
      async apply(changes, mutationID) {
        const owned = copyControlChanges(changes, key)
        if (mutationID !== groupMutationID(tx, key.groupID))
          throw new GroupStateConflictError('Control mutation mismatch')
        const owedOnly = Object.keys(owned).every(
          (name) => name === 'deleteOutcomes' || name === 'deleteWelcomes',
        )
        if (
          owned.commitOnceAcceptance != null &&
          !sameStoredValue(owned.commitOnceAcceptance.source.key, key)
        )
          throw new GroupStateConflictError('Acceptance key mismatch')
        const previous = (await control.load('current'))?.snapshot ?? emptyControl()
        let context: CommitOnceWriteContext | null = controlBuildContexts.get(tx) ?? null
        if (owned.commitOnce === null && context === null)
          context = (await params.adoptionContext?.()) ?? null
        if (owned.commitOnce != null && context === null) {
          const state = await stateStores.state(key.incarnation).load()
          if (state !== null && !state.deleted)
            context = {
              kind: 'head',
              source: { ...key, epoch: state.epoch, authenticator: state.epochAuthenticator },
            }
        }
        const slotOnly = Object.keys(owned).every(
          (name) => name === 'commitOnce' || name === 'commitOnceAcceptance',
        )
        const completion = recoveryCompletionContexts.get(tx)
        const completing =
          completion !== undefined &&
          sameStoredValue(completion.key, key) &&
          sameStoredValue(completion.changes, owned)
        if (
          !owedOnly &&
          !completing &&
          !(slotOnly && context?.kind === 'retirement' && sameStoredValue(context.key, key))
        )
          await active()
        const snapshot = applyChanges(previous, owned, context, key)
        if (previous.forkHalt === null && snapshot.forkHalt !== null)
          await putEvent({
            ...key,
            id: forkEventID(key),
            kind: 'group:fork',
            halt: snapshot.forkHalt,
          })
        if (previous.recoveryUnavailable === null && snapshot.recoveryUnavailable !== null)
          await putEvent(snapshot.recoveryUnavailable)
        await control.save('current', { snapshot, mutationID })
      },
    },
    anchor: {
      async load() {
        return await anchor.load('current')
      },
      async save(slot) {
        const owned = copyStoredValue(slot)
        await active()
        if (owned === null) anchor.remove('current')
        else await anchor.save('current', owned)
      },
    },
    pending: {
      async list() {
        return (await pending.list()).sort(laneOrder)
      },
      async put(records) {
        const owned = copyStoredValue(records)
        await active()
        for (const record of owned) {
          frameKey(record.frame)
          await pending.save(record.frame.id, record)
        }
      },
      async poison(records) {
        const owned = copyStoredValue(records)
        for (const record of owned) {
          frameKey(record.frame)
          await poison.save(record.frame.id, record)
        }
      },
      async listPoison() {
        return (await poison.list()).sort(laneOrder)
      },
      async complete(ids) {
        for (const id of [...ids]) {
          pending.remove(id)
          poison.remove(id)
        }
      },
    },
    cursor: {
      async load(topicID) {
        const value = await cursor.load(await topicLocator(topicID))
        if (value !== null && value.topicID !== topicID)
          throw new GroupStateConflictError('Cursor topic mismatch')
        return value?.position ?? null
      },
      async save(topicID, position) {
        await active()
        await cursor.save(await topicLocator(topicID), { topicID, position })
      },
    },
    outbox: {
      async list() {
        return (await outbox.list()).sort((a, b) => a.seq - b.seq)
      },
      async put(entries) {
        const owned = copyStoredValue(entries)
        await active()
        for (const entry of owned) {
          if (!Number.isSafeInteger(entry.seq) || entry.seq < 0)
            throw new GroupStateConflictError('Invalid outbox sequence')
          if (entry.lastAttempt !== null && entry.lastAttempt.incarnation !== key.incarnation)
            throw new GroupStateConflictError('Attempt incarnation mismatch')
          const previous = await outbox.load(String(entry.seq))
          if (previous !== null) {
            if (
              previous.protocol !== entry.protocol ||
              previous.prc !== entry.prc ||
              !sameStoredValue(previous.data, entry.data)
            )
              throw new OutboxReplacementError('Immutable outbox data changed')
            if ((await loadSettlement(entry.seq)) !== null && !sameStoredValue(previous, entry))
              throw new GroupStateConflictError('Obligated entry cannot change')
          }
          if (!sameStoredValue(previous, entry)) await outbox.save(String(entry.seq), entry)
        }
      },
      async remove(seqs) {
        for (const seq of [...seqs]) await remove(seq)
      },
      async clear() {
        for (const entry of await outbox.list()) await remove(entry.seq)
      },
    },
    meta: {
      loadSettlement,
      async putSettlement(seq, value) {
        const owned = copyStoredValue(value)
        const previous = await loadSettlement(seq)
        if (owned === null) {
          if (previous !== null && (await outbox.load(String(seq))) !== null)
            throw new GroupStateConflictError('Certified settlement cannot be discarded')
          meta.remove(settlementID(seq))
        } else {
          if (previous !== null && !sameStoredValue(previous, owned))
            throw new GroupStateConflictError('Conflicting settlement')
          if (previous === null) await meta.save(settlementID(seq), owned)
        }
      },
      events,
      async putEvents(values) {
        for (const event of copyStoredValue(values)) await putEvent(event)
      },
      async ackEvent(id) {
        meta.remove(eventID(id))
      },
    },
    async clearTransport() {
      for (const id of meta.ids())
        if (JSON.parse(id)[0] === 'settlement')
          throw new GroupStateConflictError('Unresolved settlement obligation')
      for (const entry of await outbox.list()) await remove(entry.seq)
      for (const rows of [anchor, pending, poison, cursor])
        for (const id of rows.ids()) rows.remove(id)
      const previous = await control.load('current')
      if (previous !== null)
        await control.save('current', {
          mutationID: previous.mutationID,
          snapshot: {
            ...emptyControl(),
            commitOnce: previous.snapshot.commitOnce,
            commitOnceAcceptance: previous.snapshot.commitOnceAcceptance,
            controlHold: previous.snapshot.controlHold,
            forkHalt: previous.snapshot.forkHalt,
            recoveryUnavailable: previous.snapshot.recoveryUnavailable,
            strand: previous.snapshot.strand,
            recoveryEpochFloor: previous.snapshot.recoveryEpochFloor ?? null,
            settledRejoins: previous.snapshot.settledRejoins ?? [],
            outcomes: previous.snapshot.outcomes,
            welcomes: previous.snapshot.welcomes,
            // Adopted recovery remains owed until explicit continuation settlement.
            rejoin: previous.snapshot.rejoin?.stage === 'adopted' ? previous.snapshot.rejoin : null,
            cursor: previous.snapshot.controlHold !== null ? previous.snapshot.cursor : null,
          },
        })
    },
  }
}

export function createIncarnationStores(
  params: Parameters<typeof createUnlockedIncarnationStores>[0],
): IncarnationStores {
  const stores = createUnlockedIncarnationStores(params)
  const { tx } = params
  const key = { ...params.key }
  const applyControl = memoryOperation(tx, stores.control.apply, 'side')
  return {
    state: {
      loadInitialIdentity: memoryOperation(tx, stores.state.loadInitialIdentity),
      loadMetadata: memoryOperation(tx, stores.state.loadMetadata),
      load: memoryOperation(tx, stores.state.load),
      save: memoryOperation(tx, stores.state.save, 'domain'),
    },
    control: {
      load: memoryOperation(tx, stores.control.load),
      apply: async (changes, mutationID) => {
        assertMemoryWrite(tx, 'side')
        const owned = memoryCallback(tx, () => copyControlChanges(changes, key))
        await applyControl(owned, mutationID)
      },
    },
    anchor: {
      load: memoryOperation(tx, stores.anchor.load),
      save: memoryOperation(tx, stores.anchor.save, 'side'),
    },
    pending: {
      list: memoryOperation(tx, stores.pending.list),
      put: memoryOperation(tx, stores.pending.put, 'side'),
      poison: memoryOperation(tx, stores.pending.poison, 'side'),
      listPoison: memoryOperation(tx, stores.pending.listPoison),
      complete: memoryOperation(tx, stores.pending.complete, 'side'),
    },
    cursor: {
      load: memoryOperation(tx, stores.cursor.load),
      save: memoryOperation(tx, stores.cursor.save, 'side'),
    },
    outbox: {
      list: memoryOperation(tx, stores.outbox.list),
      put: memoryOperation(tx, stores.outbox.put, 'side'),
      remove: memoryOperation(tx, stores.outbox.remove, 'side'),
      clear: memoryOperation(tx, stores.outbox.clear, 'side'),
    },
    meta: {
      loadSettlement: memoryOperation(tx, stores.meta.loadSettlement),
      putSettlement: memoryOperation(tx, stores.meta.putSettlement, 'side'),
      events: memoryOperation(tx, stores.meta.events),
      putEvents: memoryOperation(tx, stores.meta.putEvents, 'side'),
      ackEvent: memoryOperation(tx, stores.meta.ackEvent, 'side'),
    },
    clearTransport: memoryOperation(tx, stores.clearTransport, 'side'),
  }
}
