import type { OwnIdentity } from '@kokuin/token'
import type { HubClient } from '@kumiai/hub-client'
import {
  createLastResortKeyPackageBundle,
  encodeKeyPackage,
  encodePrivateKeyPackage,
  type GroupOptions,
  type KeyPackageBundle,
  keyPackageRef,
  LAST_RESORT_LIFETIME_DAYS,
} from '@kumiai/mls'

import { toBundles } from './records.js'
import type { LastResortRecord, LastResortStore } from './store.js'

const DAY_SECONDS = 86_400
const DEFAULT_ROTATE_WITHIN_DAYS = 30
const DEFAULT_RETAIN_AFTER_EXPIRY_DAYS = 7

export type LastResortProvisionerParams = {
  /** The identity the package is minted for; also the store's owner key. */
  identity: OwnIdentity
  client: Pick<HubClient, 'uploadLastResortKeyPackage'>
  store: LastResortStore
  /** Threaded into `createLastResortKeyPackageBundle` and `keyPackageRef`. */
  options?: GroupOptions
  /** Rotate once the live package has fewer than this many days left. Default 30, must be `0 < n < LAST_RESORT_LIFETIME_DAYS`. */
  rotateWithinDays?: number
  /** Keep a retired record this many days past its `notAfter`. Default 7, must be `>= 0`. */
  retainAfterExpiryDays?: number
}

export type LastResortProvisioner = {
  /**
   * Bring the hub's last-resort slot up to date, doing nothing when it already is.
   *
   * `rotated` means the slot was written by this call — a fresh mint or a resumed upload.
   * `ref` names the package this call left in the slot.
   */
  ensureProvisioned(): Promise<{ rotated: boolean; ref: string }>
  /** Every retained bundle, `notAfter` descending, for `processWelcome`. */
  bundles(): Promise<Array<KeyPackageBundle>>
}

export function createLastResortProvisioner(
  params: LastResortProvisionerParams,
): LastResortProvisioner {
  const {
    identity,
    client,
    store,
    options,
    rotateWithinDays = DEFAULT_ROTATE_WITHIN_DAYS,
    retainAfterExpiryDays = DEFAULT_RETAIN_AFTER_EXPIRY_DAYS,
  } = params

  // Both options are day counts fed to raw arithmetic against clock readings, so an out-of-range
  // value inverts a guard rather than failing: `rotateWithinDays <= 0` uploads expired packages and
  // reports success, `>= LAST_RESORT_LIFETIME_DAYS` makes every package born due for rotation,
  // negative `retainAfterExpiryDays` prunes still-valid records, and `NaN` in either disables
  // pruning while minting on every call. All accumulate or destroy secret key material.
  if (
    !Number.isFinite(rotateWithinDays) ||
    rotateWithinDays <= 0 ||
    rotateWithinDays >= LAST_RESORT_LIFETIME_DAYS
  ) {
    throw new Error(
      `mls-hub: rotateWithinDays must be a finite number greater than 0 and less than the ${LAST_RESORT_LIFETIME_DAYS}-day last-resort lifetime, got ${rotateWithinDays}`,
    )
  }
  if (!Number.isFinite(retainAfterExpiryDays) || retainAfterExpiryDays < 0) {
    throw new Error(
      `mls-hub: retainAfterExpiryDays must be a finite number of 0 or more, got ${retainAfterExpiryDays}`,
    )
  }

  const ownerDID = identity.id
  let inFlight: Promise<{ rotated: boolean; ref: string }> | null = null

  /** The record the hub's slot should hold: newest by lifetime, `ref` breaking a tie. */
  const pickCandidate = (records: Array<LastResortRecord>): LastResortRecord | null => {
    let best: LastResortRecord | null = null
    for (const record of records) {
      if (
        best == null ||
        record.notAfter > best.notAfter ||
        (record.notAfter === best.notAfter && record.ref > best.ref)
      ) {
        best = record
      }
    }
    return best
  }

  const mint = async (): Promise<LastResortRecord> => {
    const bundle = await createLastResortKeyPackageBundle(identity, options)
    const record: LastResortRecord = {
      ref: await keyPackageRef(bundle.publicPackage, options),
      keyPackage: encodeKeyPackage(bundle.publicPackage),
      privatePackage: encodePrivateKeyPackage(bundle.privatePackage),
      notAfter: Number(bundle.publicPackage.leafNode.lifetime.notAfter),
      uploadedAt: null,
    }
    // Durable before the upload. The reverse order has a crash window where the hub serves a
    // package whose private half was never written down — the silent "unaddable forever" outage
    // this slot exists to prevent. A crash here leaves a pending record the next call finishes.
    await store.put(ownerDID, record)
    return record
  }

  const upload = async (record: LastResortRecord): Promise<void> => {
    await client.uploadLastResortKeyPackage(record.keyPackage)
    await store.put(ownerDID, { ...record, uploadedAt: Date.now() })
  }

  /**
   * Drop records past their lifetime plus the retention grace, except the one this call settled on.
   *
   * That exception is load-bearing: `cutoff` re-reads the clock, so a forward correction between
   * the caller's `nowSeconds` and this read can put the just-uploaded record past the cutoff, and
   * deleting it would strand the hub serving a package whose private half is gone.
   */
  const prune = async (records: Array<LastResortRecord>, keepRef: string): Promise<void> => {
    const cutoff = Math.floor(Date.now() / 1000) - retainAfterExpiryDays * DAY_SECONDS
    for (const record of records) {
      if (record.ref !== keepRef && record.notAfter < cutoff) {
        await store.delete(ownerDID, record.ref)
      }
    }
  }

  const run = async (): Promise<{ rotated: boolean; ref: string }> => {
    const records = await store.list(ownerDID)
    const candidate = pickCandidate(records)
    const nowSeconds = Math.floor(Date.now() / 1000)

    // Resume an interrupted provision rather than minting, which would orphan the pending record on
    // every retry. Only while it is still worth uploading: one already inside the rotation window
    // falls through to a mint, since finishing its upload would report success over a dead slot.
    if (
      candidate != null &&
      candidate.uploadedAt == null &&
      candidate.notAfter - nowSeconds > rotateWithinDays * DAY_SECONDS
    ) {
      await upload(candidate)
      await prune(records, candidate.ref)
      return { rotated: true, ref: candidate.ref }
    }

    // An expired candidate needs no special case: the difference goes negative and falls through.
    if (candidate != null && candidate.notAfter - nowSeconds > rotateWithinDays * DAY_SECONDS) {
      // Prune on the no-op path too, or a daily caller never prunes between 90-day rotations.
      await prune(records, candidate.ref)
      return { rotated: false, ref: candidate.ref }
    }

    const minted = await mint()
    await upload(minted)
    await prune([...records, minted], minted.ref)
    return { rotated: true, ref: minted.ref }
  }

  return {
    async ensureProvisioned(): Promise<{ rotated: boolean; ref: string }> {
      // Single-flight: a second caller joins the first instead of minting a competing package.
      // Cross-process overlap is undefended by design — it yields one occupied slot and two valid
      // retained records.
      if (inFlight != null) return await inFlight
      const started = run().finally(() => {
        inFlight = null
      })
      inFlight = started
      return await started
    },
    async bundles(): Promise<Array<KeyPackageBundle>> {
      return toBundles(await store.list(ownerDID), ownerDID, 'last-resort')
    },
  }
}
