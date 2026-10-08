import { decodeKeyPackage, decodePrivateKeyPackage, type KeyPackageBundle } from '@kumiai/mls'

/**
 * Which of the two retained-record kinds a record is.
 *
 * A host persists this and returns it unchanged. It is what keeps the two storage ports apart: the
 * records are otherwise near-identical, and without it `LastResortStore` is assignable to
 * `KeyPackagePoolStore`, so one store wired to both draws no diagnostic on the wrong half.
 */
export type RecordKind = 'ordinary' | 'last-resort'

/** What both retained-record shapes have in common. */
export type StoredRecord<Kind extends RecordKind = RecordKind> = {
  kind: Kind
  ref: string
  keyPackage: string
  privatePackage: string
  notAfter: number
}

/**
 * The owner-scoped, replace-by-`ref`, non-aliasing map both in-memory reference stores are.
 *
 * Shared mechanics only: `LastResortStore` and `KeyPackagePoolStore` remain separate public ports,
 * because their records and their lifecycles differ.
 */
export function createMemoryRecordStore<R extends StoredRecord>(
  reusable = false,
): {
  list(ownerDID: string): Promise<Array<R>>
  put(ownerDID: string, record: R): Promise<void>
  delete(ownerDID: string, ref: string): Promise<void>
  consume(ref: string, groupID: string): Promise<void>
  receipt(ref: string): Promise<{ groupID: string } | null>
} {
  type Snapshot = {
    byOwner: Map<string, Map<string, R>>
    receipts: Map<string, { groupID: string }>
  }
  const state = new Map<string, Snapshot>([
    ['current', { byOwner: new Map(), receipts: new Map() }],
  ])
  const current = (): Snapshot => state.get('current') as Snapshot
  const store = {
    async list(ownerDID: string): Promise<Array<R>> {
      const records = current().byOwner.get(ownerDID)
      return records == null ? [] : [...records.values()].map((record) => ({ ...record }))
    },
    async put(ownerDID: string, record: R): Promise<void> {
      let records = current().byOwner.get(ownerDID)
      if (records == null) {
        records = new Map()
        current().byOwner.set(ownerDID, records)
      }
      records.set(record.ref, { ...record })
    },
    async delete(ownerDID: string, ref: string): Promise<void> {
      current().byOwner.get(ownerDID)?.delete(ref)
    },
    async consume(ref: string, groupID: string): Promise<void> {
      if (reusable) return
      await consumeWithReceipt(store, ref, groupID, async () => {
        const held = current()
        const receipt = held.receipts.get(ref)
        if (receipt != null) {
          if (receipt.groupID !== groupID)
            throw new Error('mls-hub: key package already consumed for another group')
          return
        }
        const owners = [...held.byOwner].filter(([, records]) => records.has(ref))
        if (owners.length !== 1) {
          throw new Error(
            'mls-hub: consume requires a ref held by exactly one owner in this source',
          )
        }
        const [ownerDID, records] = owners[0] as [string, Map<string, R>]
        const byOwner = new Map(held.byOwner)
        const stagedRecords = new Map(records)
        stagedRecords.delete(ref)
        byOwner.set(ownerDID, stagedRecords)
        const receipts = new Map(held.receipts)
        receipts.set(ref, { groupID })
        // Publish the staged deletion and receipt together, with no intervening await.
        state.set('current', { byOwner, receipts })
      })
    },
    async receipt(ref: string): Promise<{ groupID: string } | null> {
      const receipt = current().receipts.get(ref)
      return receipt == null ? null : { ...receipt }
    },
  }
  return store
}

/** Resolve an adapter's ambiguous acknowledgement through its durable receipt. */
export async function consumeWithReceipt(
  store: { receipt(ref: string): Promise<{ groupID: string } | null> },
  ref: string,
  groupID: string,
  consume: () => Promise<void>,
): Promise<void> {
  try {
    await consume()
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name !== 'StorageOutcomeUnknownError') throw error
    if ((await store.receipt(ref))?.groupID !== groupID) throw error
  }
}

/**
 * Refuse a listed record belonging to the other port.
 *
 * The type system already rejects the wrong store at the wiring, which is where a TypeScript host
 * meets this. This covers what the compiler cannot: a JavaScript host, and a store adapter that
 * persists its own columns and does not write `kind` back. Throwing rather than filtering is the
 * ruling `toBundles` already makes below — a store that breaks its contract is not quietly narrowed
 * to "you appear to have fewer packages", because that is the silent failure this area exists to
 * remove.
 */
export function assertKind<Record extends StoredRecord>(
  records: Array<Record>,
  kind: RecordKind,
): Array<Record> {
  for (const record of records) {
    if (record.kind !== kind) {
      throw new Error(
        `mls-hub: stored record ${record.ref} does not belong to this store, which must hold only ${kind} records; this one is ${record.kind}. One store is wired to both ports, or an adapter is dropping the kind.`,
      )
    }
  }
  return records
}

/**
 * Retained records as bundles, `notAfter` descending with `ref` breaking a tie.
 *
 * Throws on a record that does not round-trip rather than skipping it: narrowing a corrupt store to
 * "you appear to have fewer packages" recreates the silent failure this whole area removes. Names
 * the ref, never the material.
 */
export function toBundles<R extends StoredRecord>(
  records: Array<R>,
  ownerDID: string,
  label: string,
): Array<KeyPackageBundle> {
  const ordered = [...records].sort((a, b) => {
    if (a.notAfter !== b.notAfter) return b.notAfter - a.notAfter
    return a.ref < b.ref ? 1 : a.ref > b.ref ? -1 : 0
  })
  return ordered.map((record) => {
    const publicPackage = decodeKeyPackage(record.keyPackage)
    const privatePackage = decodePrivateKeyPackage(record.privatePackage)
    if (publicPackage == null || privatePackage == null) {
      throw new Error(
        `mls-hub: stored ${label} record ${record.ref} did not decode; its stored form is not a round-trip of what this codec writes`,
      )
    }
    return { publicPackage, privatePackage, ownerDID }
  })
}
