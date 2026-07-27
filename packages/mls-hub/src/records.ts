import { decodeKeyPackage, decodePrivateKeyPackage, type KeyPackageBundle } from '@kumiai/mls'

/** What both retained-record shapes have in common. */
export type StoredRecord = {
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
