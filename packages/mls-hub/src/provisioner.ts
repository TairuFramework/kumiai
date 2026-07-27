import type { OwnIdentity } from '@kokuin/token'
import type { HubClient } from '@kumiai/hub-client'
import {
  createLastResortKeyPackageBundle,
  decodeKeyPackage,
  decodePrivateKeyPackage,
  encodeKeyPackage,
  encodePrivateKeyPackage,
  type GroupOptions,
  type KeyPackageBundle,
  keyPackageRef,
} from '@kumiai/mls'

import type { LastResortRecord, LastResortStore } from './store.js'

const DAY_SECONDS = 86_400
const DEFAULT_ROTATE_WITHIN_DAYS = 30
const DEFAULT_RETAIN_AFTER_EXPIRY_DAYS = 7

export type LastResortProvisionerParams = {
  /** The identity the package is minted for; also the store's owner key. */
  identity: OwnIdentity
  /** Narrowed to the one method used, so nothing else about the client is coupled here. */
  client: Pick<HubClient, 'uploadLastResortKeyPackage'>
  store: LastResortStore
  /** Threaded into `createLastResortKeyPackageBundle` and `keyPackageRef`. */
  options?: GroupOptions
  /** Rotate once the live package has fewer than this many days left. Default 30. */
  rotateWithinDays?: number
  /** Keep a retired record this many days past its `notAfter`. Default 7. */
  retainAfterExpiryDays?: number
}

export type LastResortProvisioner = {
  /**
   * Bring the hub's last-resort slot up to date, doing nothing when it already is.
   *
   * `rotated` means THE SLOT WAS WRITTEN BY THIS CALL — true both for a fresh mint and for
   * completing an interrupted upload, false when the live package was good enough to leave alone.
   * `ref` names the package the slot holds on return.
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
    // DURABLE BEFORE THE UPLOAD, and this order is the load-bearing decision of the whole design.
    // Upload-then-persist has a crash window in which the hub serves a package whose private half
    // was never written down — the silent "unaddable forever" outage this slot exists to prevent.
    // A crash here instead leaves an un-uploaded record, which the next call finishes.
    await store.put(ownerDID, record)
    return record
  }

  const upload = async (record: LastResortRecord): Promise<void> => {
    await client.uploadLastResortKeyPackage(record.keyPackage)
    await store.put(ownerDID, { ...record, uploadedAt: Date.now() })
  }

  /**
   * Drop records past their lifetime plus the retention grace, EXCEPT the one this call settled on.
   * `cutoff` is computed from the CURRENT clock, not the `nowSeconds` the caller already read, so a
   * record that was eligible at the check can be past the cutoff by the time this runs — a forward
   * clock correction (NTP, or a process suspended across the upload's round trip) landing between
   * the two reads. The exception stops that from deleting the private half of the package this very
   * call just told the hub to serve.
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

    // Resume an interrupted provision rather than minting: a retry that minted would leave the
    // orphan behind on every attempt. But only when the pending package is still worth uploading —
    // a pending record already inside the rotation window is stale enough that finishing its upload
    // would report success while leaving the slot holding a package no inviter will accept. That
    // case falls through to a fresh mint instead.
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
      // Pruning runs even here. A host calling daily would otherwise never prune between
      // rotations, which are 90 days apart.
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
      // Cross-PROCESS overlap is not prevented and needs no defence — the outcome is one occupied
      // slot and two valid retained records.
      if (inFlight != null) return await inFlight
      const started = run().finally(() => {
        inFlight = null
      })
      inFlight = started
      return await started
    },
    async bundles(): Promise<Array<KeyPackageBundle>> {
      const records = await store.list(ownerDID)
      const ordered = [...records].sort((a, b) => {
        if (a.notAfter !== b.notAfter) return b.notAfter - a.notAfter
        return a.ref < b.ref ? 1 : a.ref > b.ref ? -1 : 0
      })
      return ordered.map((record) => {
        const publicPackage = decodeKeyPackage(record.keyPackage)
        const privatePackage = decodePrivateKeyPackage(record.privatePackage)
        if (publicPackage == null || privatePackage == null) {
          // Loud, not skipped: silently narrowing a corrupt store to "no last-resort package" is
          // the failure mode this whole feature exists to remove. `ensureProvisioned` reads only
          // `notAfter` and never decodes, so rotation still works past a corrupt record — only the
          // join path stops. The message names the ref and NEVER the material.
          throw new Error(
            `mls-hub: stored last-resort record ${record.ref} did not decode; the store returned bytes it did not round-trip`,
          )
        }
        return { publicPackage, privatePackage, ownerDID }
      })
    },
  }
}
