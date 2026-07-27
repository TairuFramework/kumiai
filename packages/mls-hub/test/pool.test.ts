import { ORDINARY_KEY_PACKAGE_LIFETIME_DAYS } from '@kumiai/mls'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createKeyPackagePool } from '../src/pool.js'
import { createMemoryKeyPackagePoolStore } from '../src/pool-store.js'
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

    const result = await pool.ensureStocked()

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

    await pool.ensureStocked()

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
    await pool.ensureStocked()
    const upload = vi.spyOn(hub.client, 'uploadKeyPackages')

    const result = await pool.ensureStocked()

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
    await pool.ensureStocked()
    // Consume exactly one: depth 3 sits strictly between lowWater (2) and target (4).
    await hub.hubStore.fetchKeyPackages(hub.identity.id, 1)
    const upload = vi.spyOn(hub.client, 'uploadKeyPackages')

    const result = await pool.ensureStocked()

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
    await pool.ensureStocked()
    // Someone fetched two of them.
    await hub.hubStore.fetchKeyPackages(hub.identity.id, 2)

    const result = await pool.ensureStocked()

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

    await pool.ensureStocked()

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
      ref: 'orphan',
      keyPackage: 'kp-orphan',
      privatePackage: 'priv-orphan',
      notAfter: Math.floor(Date.now() / 1000) + 86_400,
    })

    await pool.ensureStocked()

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
    await pool.ensureStocked()
    const nowSeconds = Math.floor(Date.now() / 1000)
    await store.put(hub.identity.id, {
      ref: 'stale',
      keyPackage: 'kp-stale',
      privatePackage: 'priv-stale',
      notAfter: nowSeconds - 8 * 86_400,
    })
    await store.put(hub.identity.id, {
      ref: 'within-grace',
      keyPackage: 'kp-grace',
      privatePackage: 'priv-grace',
      notAfter: nowSeconds - 6 * 86_400,
    })

    // Depth is already at target, so this takes the no-op branch — which must still prune, or a
    // daily caller never prunes between refreshes.
    await pool.ensureStocked()

    const refs = (await store.list(hub.identity.id)).map((entry) => entry.ref)
    expect(refs).not.toContain('stale')
    expect(refs).toContain('within-grace')
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

    const [first, second] = await Promise.all([pool.ensureStocked(), pool.ensureStocked()])

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
    await pool.ensureStocked()

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
    await pool.ensureStocked()
    await store.put(hub.identity.id, {
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
