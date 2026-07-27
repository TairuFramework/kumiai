import { createMemoryRecordStore } from './records.js'

/**
 * One retained ordinary key package.
 *
 * Unlike a last-resort record this carries no `uploadedAt`, and the omission is deliberate. The
 * last-resort slot is replaced in place, so re-uploading a record whose upload may or may not have
 * landed is harmless. The ordinary pool APPENDS — re-uploading such a record would put two copies
 * of one init key in the pool and both would be served, which is exactly the init-key reuse this
 * feature exists to remove. So a record whose upload was interrupted is never resumed, and nothing
 * needs to remember whether it was uploaded.
 */
export type KeyPackageRecord = {
  /** `keyPackageRef` from `@kumiai/mls` — this record's ID, and what a Welcome names. */
  ref: string
  /** `encodeKeyPackage` output: the exact string uploaded to the hub. */
  keyPackage: string
  /** `encodePrivateKeyPackage` output. SECRET key material. */
  privatePackage: string
  /**
   * The package's MLS lifetime `notAfter`, in seconds. Denormalized so a SQL store can index pruning
   * without decoding MLS, and sent to the hub so it can stop serving and stop counting the entry.
   */
  notAfter: number
}

/**
 * Durable storage for retained ordinary key packages, implemented by the host.
 *
 * **Everything a store persists here is secret** — treat it as private key storage, not a cache.
 *
 * A store MUST:
 *
 * - scope `list` to `ownerDID`. Omitting the owner predicate leaks private key material across
 *   identities.
 * - scope `delete` to `ownerDID`, and no-op for a `ref` that owner does not hold.
 * - treat `put` as replace-by-`ref`, never append.
 * - return records that do not alias its own state.
 *
 * `list` need not order: the pool sorts what it gets.
 */
export type KeyPackagePoolStore = {
  list(ownerDID: string): Promise<Array<KeyPackageRecord>>
  put(ownerDID: string, record: KeyPackageRecord): Promise<void>
  delete(ownerDID: string, ref: string): Promise<void>
}

/**
 * An in-memory {@link KeyPackagePoolStore}, and the strict reference for the rules above.
 *
 * **Loses every record on restart.** The hub keeps serving packages whose private halves are gone,
 * so every Welcome built from them fails at the joiner. Tests and throwaway processes only.
 */
export function createMemoryKeyPackagePoolStore(): KeyPackagePoolStore {
  return createMemoryRecordStore<KeyPackageRecord>()
}
