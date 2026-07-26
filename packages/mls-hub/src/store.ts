/**
 * One retained last-resort key package.
 *
 * Records ACCUMULATE across rotations rather than replacing one another. An inviter that fetched the
 * hub's slot before the last rotation still holds the previous package, and callers of
 * `fetchKeyPackages(did, N)` cache for future joins — so a Welcome arriving after a rotation
 * legitimately matches an older record, and deleting it on rotation would make that join impossible.
 */
export type LastResortRecord = {
  /** `keyPackageRef` from `@kumiai/mls` — this record's ID. */
  ref: string
  /** `encodeKeyPackage` output: the exact string uploaded to the hub's slot. */
  keyPackage: string
  /** `encodePrivateKeyPackage` output. SECRET key material. */
  privatePackage: string
  /**
   * The package's MLS lifetime `notAfter`, in seconds since the epoch.
   *
   * Denormalized out of the package so a SQL store can index pruning without decoding MLS. A
   * SCHEDULING HINT ONLY — nothing security-relevant reads it. An inviter validates the real
   * lifetime inside the package when it builds the Add, and that check is the authority.
   */
  notAfter: number
  /**
   * When the hub's slot was confirmed to hold this package, in milliseconds; `null` for a record
   * that was minted but whose upload has not yet succeeded.
   *
   * Only its NULLNESS is ever read — no code compares the value — so it carries a local timestamp
   * for host observability and need not agree with `notAfter`'s unit.
   */
  uploadedAt: number | null
}

/**
 * Durable storage for retained last-resort key packages, implemented by the host.
 *
 * `@kumiai/mls` never owns private key material, so something above it must. This is that seam.
 * **Everything a store persists here is secret** — treat it as private key storage, not as a cache.
 *
 * A store MUST:
 *
 * - scope `list` to `ownerDID` and return NOTHING belonging to another owner. Omitting the owner
 *   predicate leaks private key material across identities.
 * - scope `delete` to `ownerDID`, and no-op for a `ref` that owner does not hold.
 * - treat `put` as replace-by-`ref`, never append. The provisioner re-puts one `ref` twice — once
 *   before uploading and once after — so an appending store grows a duplicate per rotation.
 * - return records that do not alias its own state, so a caller's mutation cannot rewrite the store.
 *
 * No ordering is required from `list`: the provisioner sorts what it gets.
 */
export type LastResortStore = {
  list(ownerDID: string): Promise<Array<LastResortRecord>>
  put(ownerDID: string, record: LastResortRecord): Promise<void>
  delete(ownerDID: string, ref: string): Promise<void>
}

/**
 * An in-memory {@link LastResortStore}, and the strict reference for the rules above.
 *
 * **Loses every record on restart**, which for this port means the host's last-resort slot survives
 * in the hub while the private half needed to use it does not — the silent "unaddable forever"
 * outage the slot exists to prevent. Use it in tests and throwaway processes only.
 */
export function createMemoryLastResortStore(): LastResortStore {
  const byOwner = new Map<string, Map<string, LastResortRecord>>()
  return {
    async list(ownerDID: string): Promise<Array<LastResortRecord>> {
      const records = byOwner.get(ownerDID)
      return records == null ? [] : [...records.values()].map((record) => ({ ...record }))
    },
    async put(ownerDID: string, record: LastResortRecord): Promise<void> {
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
