import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createLastResortProvisioner } from '../src/provisioner.js'
import { createMemoryLastResortStore } from '../src/store.js'
import { createTestHub, type TestHub } from './fixtures/hub.js'

let hub: TestHub

beforeEach(() => {
  hub = createTestHub()
})

afterEach(async () => {
  await hub.dispose()
})

describe('ensureProvisioned', () => {
  test('an empty store mints, uploads once, and records the upload', async () => {
    const store = createMemoryLastResortStore()
    const upload = vi.spyOn(hub.client, 'uploadLastResortKeyPackage')
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const result = await provisioner.ensureProvisioned()

    expect(result.rotated).toBe(true)
    expect(upload).toHaveBeenCalledTimes(1)

    const records = await store.list(hub.identity.id)
    expect(records).toHaveLength(1)
    expect(records[0]?.ref).toBe(result.ref)
    expect(records[0]?.uploadedAt).toBeTypeOf('number')

    // The bytes in the hub's slot are the record's, not some re-encoding of them.
    expect(await hub.hubStore.fetchLastResortKeyPackage(hub.identity.id)).toBe(
      records[0]?.keyPackage,
    )
  })

  test('a second call inside the validity window uploads nothing', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const first = await provisioner.ensureProvisioned()
    const upload = vi.spyOn(hub.client, 'uploadLastResortKeyPackage')
    const second = await provisioner.ensureProvisioned()

    expect(second).toEqual({ rotated: false, ref: first.ref })
    expect(upload).not.toHaveBeenCalled()
    expect(await store.list(hub.identity.id)).toHaveLength(1)
  })

  /**
   * Two overlapping callers must not both mint: each would generate its own package, each would
   * overwrite the other's slot, and the store would carry a record whose package the hub no longer
   * holds. The second caller joins the first instead.
   */
  test('overlapping calls produce one rotation and one upload', async () => {
    const store = createMemoryLastResortStore()
    const upload = vi.spyOn(hub.client, 'uploadLastResortKeyPackage')
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const [a, b] = await Promise.all([
      provisioner.ensureProvisioned(),
      provisioner.ensureProvisioned(),
    ])

    expect(a).toEqual(b)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(await store.list(hub.identity.id)).toHaveLength(1)
  })

  /**
   * A pending record (`uploadedAt: null`) left behind by a crash is normally finished by the next
   * call. But a pending record already inside the rotation window is stale enough that finishing
   * its upload would report `rotated: true` — signalling the floor is in place — while leaving the
   * slot holding a package no inviter will accept. That case must fall through to a fresh mint
   * instead of resuming the stale one.
   */
  test('a stale pending record is not resumed; a fresh package is minted instead', async () => {
    const store = createMemoryLastResortStore()
    const staleRef = 'stale-ref'
    await store.put(hub.identity.id, {
      ref: staleRef,
      keyPackage: 'kp-stale',
      privatePackage: 'priv-stale',
      notAfter: Math.floor(Date.now() / 1000) + 10 * 86_400,
      uploadedAt: null,
    })
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const result = await provisioner.ensureProvisioned()

    expect(result.rotated).toBe(true)
    expect(result.ref).not.toBe(staleRef)

    const records = await store.list(hub.identity.id)
    const fresh = records.find((record) => record.ref === result.ref)
    expect(fresh?.uploadedAt).toBeTypeOf('number')

    // The hub's slot holds the fresh package's bytes, not the stale one's.
    expect(await hub.hubStore.fetchLastResortKeyPackage(hub.identity.id)).toBe(fresh?.keyPackage)
  })
})

describe('an interrupted provision', () => {
  /**
   * The crash window between persisting a record and uploading it. The next call must finish THAT
   * package rather than mint a second one, or every retry leaves another orphan behind.
   */
  test('is resumed by uploading the pending record, not by minting', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    // Produce a genuine pending record by failing the first upload.
    const failing = vi
      .spyOn(hub.client, 'uploadLastResortKeyPackage')
      .mockRejectedValueOnce(new Error('offline'))
    await expect(provisioner.ensureProvisioned()).rejects.toThrow('offline')

    const pending = await store.list(hub.identity.id)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.uploadedAt).toBeNull()
    // Nothing reached the hub, which is the point of persisting first.
    expect(await hub.hubStore.fetchLastResortKeyPackage(hub.identity.id)).toBeNull()

    failing.mockRestore()
    const result = await provisioner.ensureProvisioned()

    expect(result).toEqual({ rotated: true, ref: pending[0]?.ref })
    const settled = await store.list(hub.identity.id)
    expect(settled).toHaveLength(1)
    expect(settled[0]?.uploadedAt).toBeTypeOf('number')
    expect(await hub.hubStore.fetchLastResortKeyPackage(hub.identity.id)).toBe(
      pending[0]?.keyPackage,
    )
  })

  /**
   * The other crash window: the upload landed but the confirming write did not. Re-uploading the
   * same bytes must be harmless, because the slot is replace-on-upload.
   */
  test('re-uploading an already-served package is a no-op on the slot', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const first = await provisioner.ensureProvisioned()
    const record = (await store.list(hub.identity.id))[0]
    expect(record).toBeDefined()
    if (record == null) return

    // Simulate the lost confirmation.
    await store.put(hub.identity.id, { ...record, uploadedAt: null })

    const result = await provisioner.ensureProvisioned()

    expect(result).toEqual({ rotated: true, ref: first.ref })
    expect(await store.list(hub.identity.id)).toHaveLength(1)
    expect(await hub.hubStore.fetchLastResortKeyPackage(hub.identity.id)).toBe(record.keyPackage)
  })

  /** A host that cannot reach the hub must be told, not left believing the floor is in place. */
  test('an upload failure propagates rather than resolving quietly', async () => {
    const store = createMemoryLastResortStore()
    vi.spyOn(hub.client, 'uploadLastResortKeyPackage').mockRejectedValue(new Error('hub refused'))
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    await expect(provisioner.ensureProvisioned()).rejects.toThrow('hub refused')
  })

  /** A failed call must not wedge the single-flight slot shut for every later caller. */
  test('a failed call does not block the next one', async () => {
    const store = createMemoryLastResortStore()
    const spy = vi
      .spyOn(hub.client, 'uploadLastResortKeyPackage')
      .mockRejectedValueOnce(new Error('offline'))
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    await expect(provisioner.ensureProvisioned()).rejects.toThrow('offline')
    spy.mockRestore()

    await expect(provisioner.ensureProvisioned()).resolves.toMatchObject({ rotated: true })
  })
})
