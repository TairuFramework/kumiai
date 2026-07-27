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

  /**
   * A host that cannot reach the hub must be told, not left believing the floor is in place. The
   * rejection alone does not prove the failure was clean, so this also pins that nothing was
   * marked uploaded and nothing reached the hub's slot.
   */
  test('an upload failure propagates rather than resolving quietly', async () => {
    const store = createMemoryLastResortStore()
    vi.spyOn(hub.client, 'uploadLastResortKeyPackage').mockRejectedValue(new Error('hub refused'))
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    await expect(provisioner.ensureProvisioned()).rejects.toThrow('hub refused')

    expect((await store.list(hub.identity.id))[0]?.uploadedAt).toBeNull()
    expect(await hub.hubStore.fetchLastResortKeyPackage(hub.identity.id)).toBeNull()
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

const DAY = 86_400

function secondsFromNow(days: number): number {
  return Math.floor(Date.now() / 1000) + days * DAY
}

describe('rotation and retention', () => {
  /**
   * The rotation deadline exists because a last-resort package carries a real MLS lifetime and an
   * inviter enforces it. An unrotated slot stops working while the hub still reports it full.
   */
  test('a package inside the rotation window is replaced, and the old one is kept', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const first = await provisioner.ensureProvisioned()
    const original = (await store.list(hub.identity.id))[0]
    expect(original).toBeDefined()
    if (original == null) return

    // 10 days left: inside the 30-day window.
    await store.put(hub.identity.id, { ...original, notAfter: secondsFromNow(10) })

    const second = await provisioner.ensureProvisioned()

    expect(second.rotated).toBe(true)
    expect(second.ref).not.toBe(first.ref)
    // The retired record is RETAINED: an inviter may hold the package it names.
    const refs = (await store.list(hub.identity.id)).map((r) => r.ref).sort()
    expect(refs).toEqual([first.ref, second.ref].sort())
    expect(await hub.hubStore.fetchLastResortKeyPackage(hub.identity.id)).not.toBe(
      original.keyPackage,
    )
  })

  test('a package just outside the rotation window is left alone', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const first = await provisioner.ensureProvisioned()
    const original = (await store.list(hub.identity.id))[0]
    if (original == null) return
    await store.put(hub.identity.id, { ...original, notAfter: secondsFromNow(31) })

    const second = await provisioner.ensureProvisioned()

    expect(second).toEqual({ rotated: false, ref: first.ref })
  })

  test('rotateWithinDays is honoured when overridden', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
      rotateWithinDays: 5,
    })

    const first = await provisioner.ensureProvisioned()
    const original = (await store.list(hub.identity.id))[0]
    if (original == null) return
    // 10 days left: inside the default 30-day window, outside the configured 5-day one.
    await store.put(hub.identity.id, { ...original, notAfter: secondsFromNow(10) })

    expect(await provisioner.ensureProvisioned()).toEqual({ rotated: false, ref: first.ref })
  })

  /**
   * Retention is bounded: a record whose lifetime ended more than the grace ago can no longer be
   * the target of any Add an inviter could have built, so keeping its private half is pure risk.
   */
  test('a record past its lifetime plus the grace is pruned', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    await provisioner.ensureProvisioned()
    const live = (await store.list(hub.identity.id))[0]
    if (live == null) return

    await store.put(hub.identity.id, {
      ...live,
      ref: 'stale-ref',
      keyPackage: 'kp-stale',
      notAfter: secondsFromNow(-8),
      uploadedAt: 1,
    })

    const result = await provisioner.ensureProvisioned()

    expect(result).toEqual({ rotated: false, ref: live.ref })
    expect((await store.list(hub.identity.id)).map((r) => r.ref)).toEqual([live.ref])
  })

  /** Inside the grace it stays: a Welcome from an Add built just before expiry still needs it. */
  test('a record inside the retention grace is kept', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    await provisioner.ensureProvisioned()
    const live = (await store.list(hub.identity.id))[0]
    if (live == null) return

    await store.put(hub.identity.id, {
      ...live,
      ref: 'recent-ref',
      keyPackage: 'kp-recent',
      notAfter: secondsFromNow(-3),
      uploadedAt: 1,
    })

    await provisioner.ensureProvisioned()

    expect((await store.list(hub.identity.id)).map((r) => r.ref).sort()).toEqual(
      [live.ref, 'recent-ref'].sort(),
    )
  })

  test('retainAfterExpiryDays is honoured when overridden', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
      retainAfterExpiryDays: 1,
    })

    await provisioner.ensureProvisioned()
    const live = (await store.list(hub.identity.id))[0]
    if (live == null) return
    await store.put(hub.identity.id, {
      ...live,
      ref: 'stale-ref',
      keyPackage: 'kp-stale',
      notAfter: secondsFromNow(-3),
      uploadedAt: 1,
    })

    await provisioner.ensureProvisioned()

    expect((await store.list(hub.identity.id)).map((r) => r.ref)).toEqual([live.ref])
  })

  /**
   * An expired live package is not a special case in the code, and this is the test that says so:
   * the rotation arithmetic goes negative and falls through to a mint.
   */
  test('an expired package is rotated rather than reported as fine', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const first = await provisioner.ensureProvisioned()
    const original = (await store.list(hub.identity.id))[0]
    if (original == null) return
    await store.put(hub.identity.id, { ...original, notAfter: secondsFromNow(-1) })

    const second = await provisioner.ensureProvisioned()

    expect(second.rotated).toBe(true)
    expect(second.ref).not.toBe(first.ref)
  })

  /**
   * The `keepRef` exception in `prune` exists for the resume path: a record can be uploaded on this
   * very call and still be past the retention grace. `rotateWithinDays` is pushed negative so the
   * resume check ("more than `rotateWithinDays` left") accepts a candidate whose `notAfter` is
   * already 8 days in the past, while the default 7-day retention grace still puts it past the
   * prune cutoff — the one combination that exercises the exception rather than the ordinary
   * "still has plenty of life left" resume case.
   */
  test('a resumed record past the retention grace survives its own prune', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
      rotateWithinDays: -20,
    })

    const pendingRef = 'pending-ref'
    await store.put(hub.identity.id, {
      ref: pendingRef,
      keyPackage: 'kp-pending',
      privatePackage: 'priv-pending',
      notAfter: secondsFromNow(-8),
      uploadedAt: null,
    })

    const result = await provisioner.ensureProvisioned()

    expect(result).toEqual({ rotated: true, ref: pendingRef })
    expect((await store.list(hub.identity.id)).map((r) => r.ref)).toEqual([pendingRef])
  })
})
