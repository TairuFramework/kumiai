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
import { AsyncResult, Result } from '@sozai/result'

import { attempt, type HubRetryableError } from './errors.js'
import type { KeyPackagePoolStore, KeyPackageRecord } from './pool-store.js'
import { assertKind, toBundles } from './records.js'

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
  /** Top up once the hub reports fewer than this many. Default 10, must be `1 <= n <= target`. */
  lowWater?: number
  /** Keep a record this many days past its `notAfter`. Default 7, must be `>= 0`. */
  retainAfterExpiryDays?: number
}

export type StockResult = Result<{ minted: number; depth: number }, HubRetryableError>

export type KeyPackagePool = {
  /**
   * Bring the hub's ordinary pool back up to `target` when it has fallen below `lowWater`, and prune
   * records whose lifetime plus the retention grace has passed. Pruning happens on every path,
   * including the failure paths — it is local and owes nothing to the hub.
   *
   * `depth` is what this call left behind — the depth the hub reported plus `minted` — not a second
   * status read.
   *
   * An error `Result` means the hub could not be reached or gave an answer that clears on its own;
   * nothing needs fixing and the next call self-corrects. A `HubRefusedError` is thrown instead,
   * because it will never succeed until the app or the operator changes something.
   */
  ensureStocked(): AsyncResult<{ minted: number; depth: number }, HubRetryableError>
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
  // 0 is rejected, not a legal floor: `count < 0` is never true, so the pool would silently never
  // restock and the host would quietly fall back to reusing its last-resort init key — this
  // feature's own defect, arriving through a config value that looks reasonable.
  if (!Number.isInteger(lowWater) || lowWater < 1 || lowWater > target) {
    throw new Error(
      `mls-hub: lowWater must be an integer between 1 and the target of ${target}, got ${lowWater}`,
    )
  }
  if (!Number.isFinite(retainAfterExpiryDays) || retainAfterExpiryDays < 0) {
    throw new Error(
      `mls-hub: retainAfterExpiryDays must be a finite number of 0 or more, got ${retainAfterExpiryDays}`,
    )
  }

  const ownerDID = identity.id
  let inFlight: Promise<StockResult> | null = null

  /** Every read of the store goes through here, so a last-resort record cannot enter any path. */
  const listRecords = async (): Promise<Array<KeyPackageRecord>> =>
    assertKind(await store.list(ownerDID), 'ordinary')

  const mint = async (): Promise<KeyPackageRecord> => {
    const bundle = await createKeyPackageBundle(identity, options)
    const record: KeyPackageRecord = {
      kind: 'ordinary',
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

  /**
   * Drop records past their lifetime plus the retention grace, except any just minted by this call.
   *
   * That exclusion is load-bearing: `cutoff` re-reads the clock, so a forward correction between
   * `mint` and this read can put a just-uploaded record past the cutoff, and deleting it would
   * strand the hub serving a package whose private half is gone. Mirrors the same guard in
   * `LastResortProvisioner.prune`.
   */
  const prune = async (
    records: Array<KeyPackageRecord>,
    keepRefs: ReadonlySet<string>,
  ): Promise<void> => {
    const cutoff = Math.floor(Date.now() / 1000) - retainAfterExpiryDays * DAY_SECONDS
    // Concurrent: each delete names a distinct ref, so they neither order nor conflict.
    await Promise.all(
      records
        .filter((record) => !keepRefs.has(record.ref) && record.notAfter < cutoff)
        .map((record) => store.delete(ownerDID, record.ref)),
    )
  }

  const run = async (): Promise<StockResult> => {
    // Prune anyway on failure: it is local, and a caller that only ever hits transient failures
    // would otherwise never prune at all.
    const status = await attempt(
      'status',
      () => client.keyPackageStatus(),
      async () => prune(await listRecords(), new Set()),
    )
    if (status.isError()) return Result.error(status.error)
    const { count } = status.value

    let minted: Array<KeyPackageRecord> = []
    if (count < lowWater) {
      // Mint the whole deficit before uploading any of it, so one upload call carries the batch and
      // one `notAfter` describes it.
      const wanted = target - count
      // Concurrent: key generation dominates a mint, and each one writes its own ref. Store-before-
      // upload still holds — every `put` settles before the upload below.
      const records = await Promise.all(Array.from({ length: wanted }, () => mint()))
      // One expiry for the batch: they were minted together under one lifetime, and the smallest is
      // the only one that keeps the hub from serving a package the inviter would reject.
      const notAfter = Math.min(...records.map((record) => record.notAfter))
      const keepRefs = new Set(records.map((record) => record.ref))
      // The records stay on failure: the upload may have landed, and deleting them would strand the
      // hub serving packages whose private halves are gone.
      const uploaded = await attempt(
        'upload',
        () =>
          client.uploadKeyPackages(
            records.map((record) => record.keyPackage),
            notAfter,
          ),
        async () => prune(await listRecords(), keepRefs),
      )
      if (uploaded.isError()) return Result.error(uploaded.error)
      minted = records
    }
    // Prune on the no-op path too, or a daily caller never prunes between top-ups.
    await prune(await listRecords(), new Set(minted.map((record) => record.ref)))
    return Result.ok({ minted: minted.length, depth: count + minted.length })
  }

  return {
    ensureStocked(): AsyncResult<{ minted: number; depth: number }, HubRetryableError> {
      // Single-flight: a second caller joins the first rather than minting a competing batch against
      // the same reported depth. Cross-process overlap is undefended by design — it overshoots the
      // target, which costs cap headroom and nothing else.
      //
      // The shared promise holds a `Result`, not an `AsyncResult`, so every joiner sees the same
      // settled outcome and the same error instance. A refusal rejects it, as it should.
      if (inFlight == null) {
        const started = run().finally(() => {
          inFlight = null
        })
        inFlight = started
        // Bookkeeping copy only: `inFlight` is never awaited by a caller, so an unattached rejection
        // on it would surface as an unhandledRejection. The promise returned below is the one a
        // caller awaits, and it must still reject.
        started.catch(() => {})
      }
      return new AsyncResult(inFlight)
    },
    async bundles(): Promise<Array<KeyPackageBundle>> {
      // Sorting, decoding and the loud throw on a corrupt record are shared with the last-resort
      // provisioner via `./records.js`; only the label differs.
      return toBundles(await listRecords(), ownerDID, 'key package')
    },
    async release(ref: string): Promise<void> {
      await store.delete(ownerDID, ref)
    },
  }
}
