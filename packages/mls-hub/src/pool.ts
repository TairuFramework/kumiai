import type { OwnIdentity } from '@kokuin/token'
import type { HubClient } from '@kumiai/hub-client'
import {
  createKeyPackageBundle,
  encodeKeyPackage,
  encodePrivateKeyPackage,
  type GroupOptions,
  type KeyPackageBundle,
  keyPackageRef,
} from '@kumiai/mls'

import type { KeyPackagePoolStore, KeyPackageRecord } from './pool-store.js'
import { toBundles } from './records.js'

const DAY_SECONDS = 86_400
const DEFAULT_TARGET = 20
const DEFAULT_LOW_WATER = 10
const DEFAULT_RETAIN_AFTER_EXPIRY_DAYS = 7

export type KeyPackagePoolParams = {
  /** The identity packages are minted for; also the store's owner key. */
  identity: OwnIdentity
  client: Pick<HubClient, 'uploadKeyPackages' | 'keyPackageStatus'>
  store: KeyPackagePoolStore
  /** Threaded into `createKeyPackageBundle` and `keyPackageRef`. */
  options?: GroupOptions
  /** Stock back up to this depth. Default 20, must be a finite integer greater than 0. */
  target?: number
  /** Top up once the hub reports fewer than this many. Default 10, must be `0 <= n <= target`. */
  lowWater?: number
  /** Keep a record this many days past its `notAfter`. Default 7, must be `>= 0`. */
  retainAfterExpiryDays?: number
}

export type KeyPackagePool = {
  /**
   * Bring the hub's ordinary pool back up to `target` when it has fallen below `lowWater`, and prune
   * records whose lifetime plus the retention grace has passed.
   *
   * `depth` is what this call left behind — the depth the hub reported plus `minted` — not a second
   * status read.
   */
  ensureStocked(): Promise<{ minted: number; depth: number }>
  /** Every retained bundle, `notAfter` descending, for `processWelcome`. */
  bundles(): Promise<Array<KeyPackageBundle>>
  /** Drop a record once its Welcome has been processed. An ordinary package is single-use. */
  release(ref: string): Promise<void>
}

export function createKeyPackagePool(params: KeyPackagePoolParams): KeyPackagePool {
  const {
    identity,
    client,
    store,
    options,
    target = DEFAULT_TARGET,
    lowWater = DEFAULT_LOW_WATER,
    retainAfterExpiryDays = DEFAULT_RETAIN_AFTER_EXPIRY_DAYS,
  } = params

  // All three are fed to raw arithmetic against clock readings and counts, so an out-of-range value
  // inverts a guard rather than failing: `target <= 0` mints negative deficits, `lowWater > target`
  // tops up on every call forever, a negative grace prunes still-valid records, and `NaN` anywhere
  // disables both the top-up and the pruning. All either destroy secret key material or drain the
  // hub's cap.
  if (!Number.isInteger(target) || target <= 0) {
    throw new Error(`mls-hub: target must be an integer greater than 0, got ${target}`)
  }
  if (!Number.isInteger(lowWater) || lowWater < 0 || lowWater > target) {
    throw new Error(
      `mls-hub: lowWater must be an integer between 0 and the target of ${target}, got ${lowWater}`,
    )
  }
  if (!Number.isFinite(retainAfterExpiryDays) || retainAfterExpiryDays < 0) {
    throw new Error(
      `mls-hub: retainAfterExpiryDays must be a finite number of 0 or more, got ${retainAfterExpiryDays}`,
    )
  }

  const ownerDID = identity.id
  let inFlight: Promise<{ minted: number; depth: number }> | null = null

  const mint = async (): Promise<KeyPackageRecord> => {
    const bundle = await createKeyPackageBundle(identity, options)
    const record: KeyPackageRecord = {
      ref: await keyPackageRef(bundle.publicPackage, options),
      keyPackage: encodeKeyPackage(bundle.publicPackage),
      privatePackage: encodePrivateKeyPackage(bundle.privatePackage),
      notAfter: Number(bundle.publicPackage.leafNode.lifetime.notAfter),
    }
    // Durable before the upload. The reverse order has a crash window in which the hub serves a
    // package whose private half was never written down, and every Welcome built from it fails at
    // the joiner with nothing to diagnose.
    await store.put(ownerDID, record)
    return record
  }

  const prune = async (records: Array<KeyPackageRecord>): Promise<void> => {
    const cutoff = Math.floor(Date.now() / 1000) - retainAfterExpiryDays * DAY_SECONDS
    for (const record of records) {
      if (record.notAfter < cutoff) await store.delete(ownerDID, record.ref)
    }
  }

  const run = async (): Promise<{ minted: number; depth: number }> => {
    const { count } = await client.keyPackageStatus()
    let minted: Array<KeyPackageRecord> = []
    if (count < lowWater) {
      // Mint the whole deficit before uploading any of it, so one upload call carries the batch and
      // one `notAfter` describes it.
      const wanted = target - count
      const records: Array<KeyPackageRecord> = []
      for (let index = 0; index < wanted; index++) records.push(await mint())
      // One expiry for the batch: they were minted together under one lifetime, and the smallest is
      // the only one that keeps the hub from serving a package the inviter would reject.
      const notAfter = Math.min(...records.map((record) => record.notAfter))
      await client.uploadKeyPackages(
        records.map((record) => record.keyPackage),
        notAfter,
      )
      minted = records
    }
    // Prune on the no-op path too, or a daily caller never prunes between top-ups. Re-listing picks
    // up the records just minted, which are nowhere near the cutoff.
    await prune(await store.list(ownerDID))
    return { minted: minted.length, depth: count + minted.length }
  }

  return {
    async ensureStocked(): Promise<{ minted: number; depth: number }> {
      // Single-flight: a second caller joins the first rather than minting a competing batch against
      // the same reported depth. Cross-process overlap is undefended by design — it overshoots the
      // target, which costs cap headroom and nothing else.
      if (inFlight != null) return await inFlight
      const started = run().finally(() => {
        inFlight = null
      })
      inFlight = started
      return await started
    },
    async bundles(): Promise<Array<KeyPackageBundle>> {
      // Sorting, decoding and the loud throw on a corrupt record are shared with the last-resort
      // provisioner via `./records.js`; only the label differs.
      return toBundles(await store.list(ownerDID), ownerDID, 'key package')
    },
    async release(ref: string): Promise<void> {
      await store.delete(ownerDID, ref)
    },
  }
}
