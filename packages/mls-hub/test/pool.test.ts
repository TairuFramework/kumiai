import { ORDINARY_KEY_PACKAGE_LIFETIME_DAYS } from '@kumiai/mls'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { HubRefusedError, HubRetryableError } from '../src/errors.js'
import { createKeyPackagePool } from '../src/pool.js'
import { createMemoryKeyPackagePoolStore, type KeyPackagePoolStore } from '../src/pool-store.js'
import { createTestHub, type TestHub } from './fixtures/hub.js'

let hub: TestHub

beforeEach(() => {
  hub = createTestHub()
})

afterEach(async () => {
  await hub.dispose()
})

describe('option validation', () => {
  test.each([
    ['target', { target: 0 }],
    ['target', { target: Number.NaN }],
    ['lowWater', { lowWater: -1 }],
    ['lowWater', { lowWater: 0 }],
    ['lowWater', { lowWater: 21 }],
    ['retainAfterExpiryDays', { retainAfterExpiryDays: -1 }],
  ])('rejects an out-of-range %s', (_name, overrides) => {
    expect(() =>
      createKeyPackagePool({
        identity: hub.identity,
        client: hub.client,
        store: createMemoryKeyPackagePoolStore(),
        ...overrides,
      }),
    ).toThrow(/mls-hub:/)
  })
})

describe('ensureStocked', () => {
  test('an empty pool mints up to target in one upload', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const upload = vi.spyOn(hub.client, 'uploadKeyPackages')
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 3,
      lowWater: 2,
    })

    const result = await pool.ensureStocked().value

    expect(result).toEqual({ minted: 3, depth: 3 })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(await hub.hubStore.countKeyPackages(hub.identity.id)).toBe(3)

    const records = await store.list(hub.identity.id)
    expect(records).toHaveLength(3)

    // Pinned in SECONDS at the real lifetime: a milliseconds regression would make every record
    // look decades-fresh, nothing would ever be pruned, and every other test here would stay green.
    const expected = Math.floor(Date.now() / 1000) + ORDINARY_KEY_PACKAGE_LIFETIME_DAYS * 86_400
    for (const stored of records) {
      expect(stored.notAfter).toBeGreaterThan(expected - 86_400)
      expect(stored.notAfter).toBeLessThan(expected + 86_400)
    }
  })

  test('the uploaded bytes are the records own, and carry the expiry', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const upload = vi.spyOn(hub.client, 'uploadKeyPackages')
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 1,
      lowWater: 1,
    })

    await pool.ensureStocked().value

    const records = await store.list(hub.identity.id)
    expect(await hub.hubStore.fetchKeyPackages(hub.identity.id, 1)).toEqual([
      records[0]?.keyPackage,
    ])

    // Omitting notAfter makes the hub hold entries forever, so a stale pool charges the per-DID cap
    // against every future upload — the wedge this branch exists to remove.
    const uploadedNotAfter = upload.mock.calls[0]?.[1]
    expect(uploadedNotAfter).toBe(Math.min(...records.map((record) => record.notAfter)))
    // Pinned in SECONDS: a milliseconds regression would still equal the batch min above.
    const expected = Math.floor(Date.now() / 1000) + ORDINARY_KEY_PACKAGE_LIFETIME_DAYS * 86_400
    expect(uploadedNotAfter).toBeGreaterThan(expected - 86_400)
    expect(uploadedNotAfter).toBeLessThan(expected + 86_400)
  })

  test('does nothing while depth is at or above lowWater', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 4,
      lowWater: 2,
    })
    await pool.ensureStocked().value
    const upload = vi.spyOn(hub.client, 'uploadKeyPackages')

    const result = await pool.ensureStocked().value

    expect(result).toEqual({ minted: 0, depth: 4 })
    expect(upload).not.toHaveBeenCalled()
  })

  test('does nothing while depth sits between lowWater and target', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 4,
      lowWater: 2,
    })
    await pool.ensureStocked().value
    // Consume exactly one: depth 3 sits strictly between lowWater (2) and target (4).
    await hub.hubStore.fetchKeyPackages(hub.identity.id, 1)
    const upload = vi.spyOn(hub.client, 'uploadKeyPackages')

    const result = await pool.ensureStocked().value

    // A one-package top-up here would drip on every call while depth is in this band, burning the
    // hub's upload rate limit and cap for no benefit.
    expect(result).toEqual({ minted: 0, depth: 3 })
    expect(upload).not.toHaveBeenCalled()
  })

  test('tops up only the deficit once consumption drops depth below lowWater', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 4,
      lowWater: 3,
    })
    await pool.ensureStocked().value
    // Someone fetched two of them.
    await hub.hubStore.fetchKeyPackages(hub.identity.id, 2)

    const result = await pool.ensureStocked().value

    expect(result).toEqual({ minted: 2, depth: 4 })
  })

  test('persists a record before uploading it', async () => {
    const inner = createMemoryKeyPackagePoolStore()
    const store = { ...inner, put: vi.fn(inner.put) }
    const upload = vi.spyOn(hub.client, 'uploadKeyPackages')
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 1,
      lowWater: 1,
    })

    await pool.ensureStocked().value

    // Upload-then-persist has a crash window in which the hub serves a package whose private half
    // was never written down, and every Welcome built from it fails at the joiner.
    expect(store.put.mock.invocationCallOrder[0]).toBeLessThan(
      upload.mock.invocationCallOrder[0] as number,
    )
  })

  test('abandons an un-uploaded record instead of re-uploading it', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 1,
      lowWater: 1,
    })
    // A record written before a crash: in the store, never counted by the hub.
    await store.put(hub.identity.id, {
      kind: 'ordinary',
      ref: 'orphan',
      keyPackage: 'kp-orphan',
      privatePackage: 'priv-orphan',
      notAfter: Math.floor(Date.now() / 1000) + 86_400,
    })

    await pool.ensureStocked().value

    // Re-uploading it would risk a second copy of one init key in the pool — both would be served.
    // Minting fresh costs one key generation; the orphan stays readable for a late Welcome and is
    // pruned at expiry.
    expect(await hub.hubStore.fetchKeyPackages(hub.identity.id, 5)).not.toContain('kp-orphan')
    expect((await store.list(hub.identity.id)).map((entry) => entry.ref)).toContain('orphan')
  })

  test('prunes a record past its expiry plus the grace, including on the no-op path', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 1,
      lowWater: 1,
      retainAfterExpiryDays: 7,
    })
    await pool.ensureStocked().value
    const nowSeconds = Math.floor(Date.now() / 1000)
    await store.put(hub.identity.id, {
      kind: 'ordinary',
      ref: 'stale',
      keyPackage: 'kp-stale',
      privatePackage: 'priv-stale',
      notAfter: nowSeconds - 8 * 86_400,
    })
    await store.put(hub.identity.id, {
      kind: 'ordinary',
      ref: 'within-grace',
      keyPackage: 'kp-grace',
      privatePackage: 'priv-grace',
      notAfter: nowSeconds - 6 * 86_400,
    })

    // Depth is already at target, so this takes the no-op branch — which must still prune, or a
    // daily caller never prunes between refreshes.
    await pool.ensureStocked().value

    const refs = (await store.list(hub.identity.id)).map((entry) => entry.ref)
    expect(refs).not.toContain('stale')
    expect(refs).toContain('within-grace')
  })

  /**
   * `prune` re-reads the wall clock instead of reusing a timestamp the call already computed, so a
   * record minted moments ago can be past the retention cutoff by the time `prune` runs — a forward
   * clock correction (NTP, or a suspended process) landing between mint and prune. The ordinary
   * pool's 30-day lifetime plus the default 7-day grace is 37 days; simulated here by advancing
   * `Date.now` by 40 days from inside the upload mock, once the upload settles but before the call's
   * own `prune` reads the clock. Mirrors `LastResortProvisioner`'s `keepRef` guard.
   */
  test('a just-minted record survives its own prune when the clock advances during the upload', async () => {
    const store = createMemoryKeyPackagePoolStore()

    // A mutable offset on top of the real clock. NOT vi.useFakeTimers(): that interferes with the
    // enkaku transports the hub fixture builds.
    let offsetMs = 0
    const realNow = Date.now.bind(Date)
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs)

    const realUpload = hub.client.uploadKeyPackages.bind(hub.client)
    const uploadSpy = vi
      .spyOn(hub.client, 'uploadKeyPackages')
      .mockImplementation((keyPackages: Array<string>, notAfter?: number) => {
        const call = realUpload(keyPackages, notAfter)
        // Fire-and-forget: advances the clock once the real upload settles, before the pool's own
        // `await` on this same call resumes and reaches `prune`.
        void call.then(() => {
          offsetMs += 40 * 86_400 * 1000
        })
        return call
      })

    try {
      const pool = createKeyPackagePool({
        identity: hub.identity,
        client: hub.client,
        store,
        target: 1,
        lowWater: 1,
      })

      const result = await pool.ensureStocked().value

      expect(result.minted).toBe(1)
      // Without the keepRefs exception this would be empty: the just-minted record's notAfter
      // (now + 30 days, at mint time) is already past the post-jump cutoff (now + 40 - 7 days).
      const refs = (await store.list(hub.identity.id)).map((entry) => entry.ref)
      expect(refs).toHaveLength(1)
    } finally {
      uploadSpy.mockRestore()
      dateSpy.mockRestore()
    }
  })

  test('is single-flight', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const upload = vi.spyOn(hub.client, 'uploadKeyPackages')
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 2,
      lowWater: 2,
    })

    const [first, second] = await Promise.all([
      pool.ensureStocked().value,
      pool.ensureStocked().value,
    ])

    expect(first).toEqual(second)
    expect(upload).toHaveBeenCalledTimes(1)
  })
})

describe('bundles', () => {
  test('returns every retained bundle, newest first', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 2,
      lowWater: 2,
    })
    await pool.ensureStocked().value

    const bundles = await pool.bundles()

    expect(bundles).toHaveLength(2)
    for (const bundle of bundles) {
      expect(bundle.ownerDID).toBe(hub.identity.id)
    }
    const notAfters = bundles.map((bundle) =>
      Number(bundle.publicPackage.leafNode.lifetime.notAfter),
    )
    expect(notAfters).toEqual([...notAfters].sort((a, b) => b - a))
  })

  test('throws on a record that does not round-trip, rather than skipping it', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 1,
      lowWater: 1,
    })
    await pool.ensureStocked().value
    await store.put(hub.identity.id, {
      kind: 'ordinary',
      ref: 'corrupt',
      keyPackage: 'not-a-key-package',
      privatePackage: 'not-a-private-package',
      notAfter: Math.floor(Date.now() / 1000) + 86_400,
    })

    // Narrowing a corrupt store to "you appear to have fewer packages" recreates the silent failure
    // this whole feature removes. Names the ref, never the material.
    await expect(pool.bundles()).rejects.toThrow(/key package record corrupt did not decode/)
  })
})

describe('a store failure minting a record', () => {
  /**
   * `mint`'s durable write sits outside the upload's try/catch, so a failing `store.put` there is a
   * raw store failure, never folded into the hub outcome. Mirrors the same contract pinned for
   * `LastResortProvisioner.ensureProvisioned` in `test/provisioner.test.ts`.
   */
  test('propagates the raw store error rather than resolving as a retryable Result', async () => {
    const inner = createMemoryKeyPackagePoolStore()
    const storeError = new Error('disk full')
    const store: KeyPackagePoolStore = {
      list: (ownerDID) => inner.list(ownerDID),
      delete: (ownerDID, ref) => inner.delete(ownerDID, ref),
      put: () => Promise.reject(storeError),
    }
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 1,
      lowWater: 1,
    })

    await expect(pool.ensureStocked()).rejects.toBe(storeError)
  })
})

describe('ensureStocked failure paths', () => {
  test('a transport failure at the status stage returns a retryable error and prunes', async () => {
    const store = createMemoryKeyPackagePoolStore()
    // An expired record the prune must still remove even though the hub call failed.
    await store.put(hub.identity.id, {
      kind: 'ordinary',
      ref: 'dead',
      keyPackage: 'a',
      privatePackage: 'b',
      notAfter: Math.floor(Date.now() / 1000) - 30 * 86_400,
    })
    vi.spyOn(hub.client, 'keyPackageStatus').mockRejectedValue(new Error('socket closed'))
    const pool = createKeyPackagePool({ identity: hub.identity, client: hub.client, store })

    const result = await pool.ensureStocked()

    expect(result.isError()).toBe(true)
    expect(result.error).toBeInstanceOf(HubRetryableError)
    expect(result.error?.stage).toBe('status')
    // Prune is local and independent of the hub. A caller that only ever hits transient failures
    // would otherwise never prune at all.
    expect(await store.list(hub.identity.id)).toHaveLength(0)
  })

  test('a transport failure at the upload stage returns a retryable error and keeps the records', async () => {
    const store = createMemoryKeyPackagePoolStore()

    // Same mutable-offset trick as the success-path clock-jump test: jump the clock forward past
    // the retention cutoff (30-day lifetime + 7-day grace) from inside the rejected upload, so the
    // records' own `notAfter` no longer explains their survival — only the catch block's `keepRefs`
    // does. Without it this test would stay green even if `keepRefs` were dropped or swapped for an
    // empty set at the call site.
    let offsetMs = 0
    const realNow = Date.now.bind(Date)
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs)
    vi.spyOn(hub.client, 'uploadKeyPackages').mockImplementation(() => {
      offsetMs += 40 * 86_400 * 1000
      // Cast: the real return type is a RequestCall, but the pool only ever awaits it, and this
      // rejection is what the test needs it to do.
      return Promise.reject(new Error('socket closed')) as unknown as ReturnType<
        typeof hub.client.uploadKeyPackages
      >
    })

    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 3,
      lowWater: 2,
    })

    try {
      const result = await pool.ensureStocked()

      expect(result.isError()).toBe(true)
      expect(result.error?.stage).toBe('upload')
      // The upload may have landed. Deleting these would strand the hub serving packages whose
      // private halves are gone — the outage this store exists to prevent.
      expect(await store.list(hub.identity.id)).toHaveLength(3)
    } finally {
      dateSpy.mockRestore()
    }
  })

  // The path a host actually hits, end to end through a real hub. The refusal arrives as an enkaku
  // RequestError whose `code` is HUB_AUTHORIZATION_DENIED and which is not an instance of
  // AuthorizationDeniedError — classifying by `instanceof` alone would return it as retryable and
  // the host would retry a settled refusal forever.
  test('a real hub refusal throws instead of returning', async () => {
    const denying = createTestHub(hub.identity, (req) => req.action !== 'keypackage/status')
    try {
      const pool = createKeyPackagePool({
        identity: denying.identity,
        client: denying.client,
        store: createMemoryKeyPackagePoolStore(),
      })

      await expect(pool.ensureStocked()).rejects.toThrow(HubRefusedError)
    } finally {
      await denying.dispose()
    }
  })

  // The reorder this pins: prune runs before the classifier, so it still executes even though the
  // classifier throws instead of returning for a settled refusal.
  test('a refusal at the status stage still prunes an expired record', async () => {
    const store = createMemoryKeyPackagePoolStore()
    // An expired record the prune must still remove even though the hub call was refused.
    await store.put(hub.identity.id, {
      kind: 'ordinary',
      ref: 'dead',
      keyPackage: 'a',
      privatePackage: 'b',
      notAfter: Math.floor(Date.now() / 1000) - 30 * 86_400,
    })
    vi.spyOn(hub.client, 'keyPackageStatus').mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'HUB_AUTHORIZATION_DENIED' }),
    )
    const pool = createKeyPackagePool({ identity: hub.identity, client: hub.client, store })

    await expect(pool.ensureStocked()).rejects.toThrow(HubRefusedError)

    expect(await store.list(hub.identity.id)).toHaveLength(0)
  })

  test('a refused call reports its code and stage', async () => {
    const denying = createTestHub(hub.identity, (req) => req.action !== 'keypackage/status')
    try {
      const pool = createKeyPackagePool({
        identity: denying.identity,
        client: denying.client,
        store: createMemoryKeyPackagePoolStore(),
      })

      await pool.ensureStocked()
      expect.unreachable('expected a throw')
    } catch (error) {
      expect((error as HubRefusedError).code).toBe('HUB_AUTHORIZATION_DENIED')
      expect((error as HubRefusedError).stage).toBe('status')
    } finally {
      await denying.dispose()
    }
  })

  // An oversized batch cannot reach the store at all: the upload schema caps `keyPackages` at 50
  // entries, and nothing validates `target` against it. Retrying would re-mint a doomed batch on
  // every call, so this has to be refused rather than returned.
  test('a batch over the wire schema limit is refused', async () => {
    const store = createMemoryKeyPackagePoolStore()
    // 51 is the smallest deficit that trips the schema's `maxItems: 50`. Keep it at the minimum:
    // every extra package is real key generation.
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 51,
      lowWater: 51,
    })

    try {
      await pool.ensureStocked()
      expect.unreachable('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(HubRefusedError)
      // Pin the wire code: without it this test cannot distinguish EK08 from EK06 or EK02, and a
      // future schema or limit change could silently re-route it.
      expect((error as HubRefusedError).code).toBe('EK08')
    }
  })

  test('a quota refusal from the real hub is retryable, not a throw', async () => {
    // Fill the hub to its per-DID cap of 100 through the raw client, then let the pool try.
    await hub.client.uploadKeyPackages(Array.from({ length: 50 }, (_, index) => `a-${index}`))
    await hub.client.uploadKeyPackages(Array.from({ length: 50 }, (_, index) => `b-${index}`))
    const store = createMemoryKeyPackagePoolStore()
    // The hub reports 100 live packages, so force a top-up by raising the floor above it.
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 110,
      lowWater: 105,
    })

    const result = await pool.ensureStocked()

    expect(result.isError()).toBe(true)
    expect(result.error).toBeInstanceOf(HubRetryableError)
    expect(result.error?.code).toBe('HUB_KEYPACKAGE_QUOTA')
  })

  test('the next call mints against the hub count rather than re-uploading a failed batch', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const upload = vi
      .spyOn(hub.client, 'uploadKeyPackages')
      .mockRejectedValueOnce(new Error('socket closed'))
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 3,
      lowWater: 2,
    })

    expect((await pool.ensureStocked()).isError()).toBe(true)
    const stranded = (await store.list(hub.identity.id)).map((record) => record.ref)

    const second = await pool.ensureStocked()

    expect(second.value).toEqual({ minted: 3, depth: 3 })
    // A fresh batch, never the stranded one: the hub does not dedupe, so re-uploading a package
    // that did land would hand one init key to two inviters.
    const secondUpload = upload.mock.calls[1]?.[0] as Array<string>
    const strandedPackages = new Set(
      (await store.list(hub.identity.id))
        .filter((record) => stranded.includes(record.ref))
        .map((record) => record.keyPackage),
    )
    expect(secondUpload.some((keyPackage) => strandedPackages.has(keyPackage))).toBe(false)
    // The stranded records survive: that upload may have landed.
    expect(await store.list(hub.identity.id)).toHaveLength(6)
  })

  test('concurrent callers share one failing run and one error instance', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const status = vi
      .spyOn(hub.client, 'keyPackageStatus')
      .mockRejectedValue(new Error('socket closed'))
    const pool = createKeyPackagePool({ identity: hub.identity, client: hub.client, store })

    const [first, second] = await Promise.all([pool.ensureStocked(), pool.ensureStocked()])

    expect(status).toHaveBeenCalledTimes(1)
    expect(first.error).toBe(second.error)
  })
})
