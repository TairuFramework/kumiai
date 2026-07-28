import type { OwnIdentity } from '@kokuin/token'
import type { HubClient } from '@kumiai/hub-client'
import { keyPackageDigest } from '@kumiai/hub-protocol'
import {
  createLastResortKeyPackageBundle,
  encodeKeyPackage,
  encodePrivateKeyPackage,
  type GroupOptions,
  type KeyPackageBundle,
  keyPackageRef,
  LAST_RESORT_LIFETIME_DAYS,
} from '@kumiai/mls'
import { AsyncResult, Result } from '@sozai/result'

import { type HubRetryableError, toRetryableOrThrow } from './errors.js'
import { toBundles } from './records.js'
import type { LastResortRecord, LastResortStore } from './store.js'

const DAY_SECONDS = 86_400
const DEFAULT_ROTATE_WITHIN_DAYS = 30
const DEFAULT_RETAIN_AFTER_EXPIRY_DAYS = 7

export type LastResortProvisionerParams = {
  /** The identity the package is minted for; also the store's owner key. */
  identity: OwnIdentity
  client: Pick<HubClient, 'uploadLastResortKeyPackage' | 'keyPackageStatus'>
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
   * `ref` names the package this call left in the slot. Pruning happens on every path, including
   * the failure paths — it is local and owes nothing to the hub.
   *
   * An error `Result` means the hub could not be reached or gave an answer that clears on its own:
   * the local record is left untouched, so the next call redoes the readback and repairs the slot
   * if the hub disagrees. A `HubRefusedError` is thrown instead, because it will never succeed
   * until the app or the operator changes something.
   */
  ensureProvisioned(): AsyncResult<{ rotated: boolean; ref: string }, HubRetryableError>
  /** Every retained bundle, `notAfter` descending, for `processWelcome`. */
  bundles(): Promise<Array<KeyPackageBundle>>
  /**
   * A no-op, so a provisioner can stand in as a `BundleSource`. A last-resort package is reusable by
   * design — the same one is handed to every inviter until it rotates — so a Welcome must not
   * consume it. Deleting it here would make the owner silently unaddable forever.
   */
  release(ref: string): Promise<void>
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

  type ProvisionResult = Result<{ rotated: boolean; ref: string }, HubRetryableError>

  const ownerDID = identity.id
  let inFlight: Promise<ProvisionResult> | null = null

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

  const run = async (): Promise<ProvisionResult> => {
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
      try {
        await upload(candidate)
      } catch (error) {
        const retryable = toRetryableOrThrow(error, 'upload')
        await prune(records, candidate.ref)
        return Result.error(retryable)
      }
      await prune(records, candidate.ref)
      return Result.ok({ rotated: true, ref: candidate.ref })
    }

    // An expired candidate needs no special case: the difference goes negative and falls through.
    if (candidate != null && candidate.notAfter - nowSeconds > rotateWithinDays * DAY_SECONDS) {
      // The record says this package was uploaded; the hub is the only authority on whether it is
      // still there. Without this readback a hub that lost or replaced the slot is reported as
      // provisioned until the next rotation falls due — the floor is gone and nothing says so.
      // Re-uploading is safe here precisely because the slot replaces in place, which is why the
      // ordinary pool cannot do the same thing.
      let lastResort: string | null
      try {
        ;({ lastResort } = await client.keyPackageStatus())
      } catch (error) {
        const retryable = toRetryableOrThrow(error, 'status')
        // Skip the repair, write nothing that would suppress it: the record is left exactly as it
        // was, so the next successful call performs the readback instead.
        await prune(records, candidate.ref)
        return Result.error(retryable)
      }
      if (lastResort !== (await keyPackageDigest(candidate.keyPackage))) {
        try {
          await upload(candidate)
        } catch (error) {
          const retryable = toRetryableOrThrow(error, 'upload')
          await prune(records, candidate.ref)
          return Result.error(retryable)
        }
        await prune(records, candidate.ref)
        return Result.ok({ rotated: true, ref: candidate.ref })
      }
      // Prune on the no-op path too, or a daily caller never prunes between 90-day rotations.
      await prune(records, candidate.ref)
      return Result.ok({ rotated: false, ref: candidate.ref })
    }

    const minted = await mint()
    try {
      await upload(minted)
    } catch (error) {
      const retryable = toRetryableOrThrow(error, 'upload')
      // `minted.ref` is kept: a forward clock correction between the mint and the prune's own clock
      // read could otherwise put the just-minted record past the cutoff and delete the private half
      // of a package the hub may already be serving.
      await prune([...records, minted], minted.ref)
      return Result.error(retryable)
    }
    await prune([...records, minted], minted.ref)
    return Result.ok({ rotated: true, ref: minted.ref })
  }

  return {
    ensureProvisioned(): AsyncResult<{ rotated: boolean; ref: string }, HubRetryableError> {
      // Single-flight: a second caller joins the first instead of minting a competing package.
      // Cross-process overlap is undefended by design — it yields one occupied slot and two valid
      // retained records.
      //
      // The shared promise holds a `Result`, so every joiner sees the same settled outcome and the
      // same error instance. A refusal rejects it, as it should.
      if (inFlight == null) {
        const started = run().finally(() => {
          inFlight = null
        })
        inFlight = started
      }
      return new AsyncResult(inFlight)
    },
    async bundles(): Promise<Array<KeyPackageBundle>> {
      return toBundles(await store.list(ownerDID), ownerDID, 'last-resort')
    },
    async release(_ref: string): Promise<void> {},
  }
}
