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
export function createMemoryRecordStore<R extends StoredRecord>(): {
  list(ownerDID: string): Promise<Array<R>>
  put(ownerDID: string, record: R): Promise<void>
  delete(ownerDID: string, ref: string): Promise<void>
} {
  const byOwner = new Map<string, Map<string, R>>()
  return {
    async list(ownerDID: string): Promise<Array<R>> {
      const records = byOwner.get(ownerDID)
      return records == null ? [] : [...records.values()].map((record) => ({ ...record }))
    },
    async put(ownerDID: string, record: R): Promise<void> {
      let records = byOwner.get(ownerDID)
      if (records == null) {
        records = new Map()
        byOwner.set(ownerDID, records)
      }
      records.set(record.ref, { ...record })
    },
    async delete(ownerDID: string, ref: string): Promise<void> {
      byOwner.get(ownerDID)?.delete(ref)
    },
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
