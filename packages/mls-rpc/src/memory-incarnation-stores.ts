import { applyChanges, type ControlSnapshot } from '@kumiai/rpc'

import {
  createUnlockedGroupStateStores,
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
      const value = await memoryRequired(tx, async () => {
        const rows = map()
        memoryReadAdmitted(tx)
        const bytes = rows.get(id)
        if (bytes === undefined) return null
        if (!(bytes instanceof Uint8Array))
          throw new GroupStateConflictError('Unreadable sealed row')
        return (await memoryOpen(tx, atRest, location, bytes)) as TValue
      })
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
  operations: [],
  rejoin: null,
  outcomes: [],
  welcomes: [],
  applied: [],
  responses: [],
  cursor: null,
})
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
}): IncarnationStores {
  const { tx, atRest } = params
  const key = { ...params.key }
  const stateStores = createUnlockedGroupStateStores({ tx, groupID: key.groupID, atRest })
  const table = <TValue>(namespace: string) =>
    memoryRecordTable<TValue>({ tx, key, namespace, atRest })
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
          (event.kind === 'published' || event.kind === 'failed') &&
          event.entry.seq === seq &&
          event.id.startsWith(`[${JSON.stringify(groupMutationID(tx, key.groupID))},`),
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
        return (await control.load('current'))?.snapshot ?? emptyControl()
      },
      async apply(changes, mutationID) {
        const owned = copyStoredValue(changes)
        if (mutationID !== groupMutationID(tx, key.groupID))
          throw new GroupStateConflictError('Control mutation mismatch')
        const owedOnly = Object.keys(owned).every(
          (name) => name === 'deleteOutcomes' || name === 'deleteWelcomes',
        )
        if (!owedOnly) await active()
        await control.save('current', {
          snapshot: applyChanges(
            (await control.load('current'))?.snapshot ?? emptyControl(),
            owned,
          ),
          mutationID,
        })
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
            outcomes: previous.snapshot.outcomes,
            welcomes: previous.snapshot.welcomes,
            cursor:
              previous.snapshot.cursor?.fork === undefined
                ? null
                : { ...previous.snapshot.cursor, position: null },
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
  return {
    state: {
      load: memoryOperation(tx, stores.state.load),
      save: memoryOperation(tx, stores.state.save, 'domain'),
    },
    control: {
      load: memoryOperation(tx, stores.control.load),
      apply: memoryOperation(tx, stores.control.apply, 'side'),
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
