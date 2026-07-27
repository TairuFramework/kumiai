import { createMemoryRecordStore } from './records.js'

/**
 * One retained last-resort key package.
 *
 * Records accumulate across rotations rather than replacing one another: an inviter that fetched the
 * slot before a rotation still holds the previous package, so a Welcome arriving afterwards
 * legitimately matches an older record.
 */
export type LastResortRecord = {
  /** `keyPackageRef` from `@kumiai/mls` — this record's ID. */
  ref: string
  /** `encodeKeyPackage` output: the exact string uploaded to the hub's slot. */
  keyPackage: string
  /** `encodePrivateKeyPackage` output. SECRET key material. */
  privatePackage: string
  /**
   * The package's MLS lifetime `notAfter`, in seconds. Denormalized so a SQL store can index pruning
   * without decoding MLS.
   *
   * A scheduling hint only. The authority is the lifetime inside the package, which the inviter
   * validates when it builds the Add.
   */
  notAfter: number
  /**
   * When the hub's slot was confirmed to hold this package, in milliseconds; `null` for a record
   * minted but not yet uploaded. Only its nullness is read, so the unit need not match `notAfter`.
   */
  uploadedAt: number | null
}

/**
 * Durable storage for retained last-resort key packages, implemented by the host.
 *
 * **Everything a store persists here is secret** — treat it as private key storage, not a cache.
 *
 * A store MUST:
 *
 * - scope `list` to `ownerDID`. Omitting the owner predicate leaks private key material across
 *   identities.
 * - scope `delete` to `ownerDID`, and no-op for a `ref` that owner does not hold.
 * - treat `put` as replace-by-`ref`, never append. The provisioner re-puts one `ref` twice per
 *   rotation, before and after uploading.
 * - return records that do not alias its own state.
 *
 * `list` need not order: the provisioner sorts what it gets.
 */
export type LastResortStore = {
  list(ownerDID: string): Promise<Array<LastResortRecord>>
  put(ownerDID: string, record: LastResortRecord): Promise<void>
  delete(ownerDID: string, ref: string): Promise<void>
}

/**
 * An in-memory {@link LastResortStore}, and the strict reference for the rules above.
 *
 * **Loses every record on restart.** The hub keeps serving the slot while the private half needed to
 * use it is gone, leaving the owner silently unaddable. Tests and throwaway processes only.
 */
export function createMemoryLastResortStore(): LastResortStore {
  return createMemoryRecordStore<LastResortRecord>()
}
