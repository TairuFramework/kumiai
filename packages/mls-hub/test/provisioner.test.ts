import {
  createLastResortKeyPackageBundle,
  decodeKeyPackage,
  LAST_RESORT_LIFETIME_DAYS,
  nobleCryptoProvider,
} from '@kumiai/mls'
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

    // Pinned in SECONDS and at the real MLS lifetime: every rotation/retention test below
    // overwrites `notAfter` before it matters, so nothing else would catch a unit or magnitude
    // regression here (e.g. milliseconds instead of seconds) — the no-op branch would then be
    // taken forever, and the package would never rotate, with every other test still green.
    const expectedNotAfter = Math.floor(Date.now() / 1000) + LAST_RESORT_LIFETIME_DAYS * 86_400
    expect(records[0]?.notAfter).toBeGreaterThan(expectedNotAfter - 86_400)
    expect(records[0]?.notAfter).toBeLessThan(expectedNotAfter + 86_400)
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
    const records = await store.list(hub.identity.id)
    const refs = records.map((r) => r.ref).sort()
    expect(refs).toEqual([first.ref, second.ref].sort())

    // Not merely "the slot changed" — `.not.toBe(original.keyPackage)` is satisfied by ANY write,
    // including one that put some other package there. The slot must hold exactly the bytes of the
    // record the rotation reported.
    const rotated = records.find((r) => r.ref === second.ref)
    expect(rotated).toBeDefined()
    expect(await hub.hubStore.fetchLastResortKeyPackage(hub.identity.id)).toBe(rotated?.keyPackage)
    expect(rotated?.keyPackage).not.toBe(original.keyPackage)
  })

  /**
   * Brackets the 30-day default to within a day against the "just outside" test below: 10 days
   * (further up) and 31 days (below) leave everything in between undetermined, and mutating the
   * default by several days would still pass the whole suite without this.
   */
  test('a package one day inside the rotation window is rotated', async () => {
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
    // 29 days left: one day inside the default 30-day window.
    await store.put(hub.identity.id, { ...original, notAfter: secondsFromNow(29) })

    const second = await provisioner.ensureProvisioned()

    expect(second.rotated).toBe(true)
    expect(second.ref).not.toBe(first.ref)
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
    expect(original).toBeDefined()
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
    expect(original).toBeDefined()
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
    expect(live).toBeDefined()
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

  /**
   * Brackets the 7-day default retention grace to within two days against the pruned test above:
   * -8 days (pruned, above) and -3 days (kept, below) leave everything between undetermined, and a
   * default change from 7 to 5 would still pass the whole suite without this.
   */
  test('a record six days past its lifetime is kept', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    await provisioner.ensureProvisioned()
    const live = (await store.list(hub.identity.id))[0]
    expect(live).toBeDefined()
    if (live == null) return

    await store.put(hub.identity.id, {
      ...live,
      ref: 'six-day-ref',
      keyPackage: 'kp-six-day',
      notAfter: secondsFromNow(-6),
      uploadedAt: 1,
    })

    await provisioner.ensureProvisioned()

    expect((await store.list(hub.identity.id)).map((r) => r.ref).sort()).toEqual(
      [live.ref, 'six-day-ref'].sort(),
    )
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
    expect(live).toBeDefined()
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
    expect(live).toBeDefined()
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
    expect(original).toBeDefined()
    if (original == null) return
    await store.put(hub.identity.id, { ...original, notAfter: secondsFromNow(-1) })

    const second = await provisioner.ensureProvisioned()

    expect(second.rotated).toBe(true)
    expect(second.ref).not.toBe(first.ref)
  })

  /**
   * `prune` re-reads the wall clock instead of reusing the `nowSeconds` a call already computed, so
   * a candidate that was eligible to resume at the check can be past the retention cutoff by the
   * time `prune` actually runs — a forward clock correction (NTP, or a process suspended across the
   * upload's round trip) landing between the two reads. Simulated here by advancing `Date.now` by
   * 40 days from inside the upload mock: the resume guard passes at the check (31 days left is more
   * than the default 30-day rotation window), but by the time `prune` reads the clock the cutoff has
   * moved to +33 days, past the record's own +31. Without the `keepRef` exception this deletes the
   * private half of the package the call just told the hub to serve.
   */
  test('a resumed record survives its own prune when the clock advances during the upload', async () => {
    const store = createMemoryLastResortStore()
    const pendingRef = 'pending-ref'
    await store.put(hub.identity.id, {
      ref: pendingRef,
      keyPackage: 'kp-pending',
      privatePackage: 'priv-pending',
      notAfter: secondsFromNow(31),
      uploadedAt: null,
    })

    // A mutable offset on top of the real clock. NOT vi.useFakeTimers(): that interferes with the
    // enkaku transports the hub fixture builds.
    let offsetMs = 0
    const realNow = Date.now.bind(Date)
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs)

    const realUpload = hub.client.uploadLastResortKeyPackage.bind(hub.client)
    const uploadSpy = vi
      .spyOn(hub.client, 'uploadLastResortKeyPackage')
      .mockImplementation((keyPackage: string) => {
        const call = realUpload(keyPackage)
        // Fire-and-forget: advances the clock once the real upload settles, before the
        // provisioner's own `await` on this same call resumes.
        void call.then(() => {
          offsetMs += 40 * DAY * 1000
        })
        return call
      })

    try {
      const provisioner = createLastResortProvisioner({
        identity: hub.identity,
        client: hub.client,
        store,
      })

      const result = await provisioner.ensureProvisioned()

      expect(result).toEqual({ rotated: true, ref: pendingRef })
      expect((await store.list(hub.identity.id)).map((r) => r.ref)).toEqual([pendingRef])
      // The invariant is "the store still holds the private half of what the hub is serving" —
      // checking only the store half would be half a test.
      expect(await hub.hubStore.fetchLastResortKeyPackage(hub.identity.id)).toBe('kp-pending')
    } finally {
      uploadSpy.mockRestore()
      dateSpy.mockRestore()
    }
  })
})

/**
 * The only non-default ciphersuite `@kumiai/mls`'s crypto provider actually implements:
 * `MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519`, IANA id 3, against the default's id 1.
 * `createNobleCryptoProvider` supports ids 1 and 3 and nothing else, so a suite with a different
 * HASH (which would have made the two mutations below separable by ref length) is not reachable —
 * both supported suites hash with SHA-256, and a ref derived under either is byte-identical.
 */
const NON_DEFAULT_CIPHERSUITE = 'MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519'
/**
 * The IANA MLS ciphersuite id for the suite above (0x0003; the default is 0x0001). A literal rather
 * than an import, because this package must not depend on `ts-mls`; the registry value is fixed by
 * RFC 9420 and cannot drift.
 */
const NON_DEFAULT_CIPHERSUITE_ID = 3

/**
 * A `CryptoProvider` that records every ciphersuite resolution and delegates to the real one. It is
 * what makes the `keyPackageRef` half of the passthrough observable at all: the ref VALUE is the
 * same under both supported suites, but a `keyPackageRef` call that dropped `options` would resolve
 * its suite through the DEFAULT provider and never touch this one.
 */
function probeProvider(calls: Array<number>) {
  return {
    getCiphersuiteImpl: async (id: number) => {
      calls.push(id)
      return await nobleCryptoProvider.getCiphersuiteImpl(id)
    },
  }
}

describe('the options passthrough', () => {
  /**
   * Without this, `options` is threaded but never exercised: deleting it from either call site in
   * `mint` passes the rest of the suite. The mint mutation is the serious one — a host configured
   * for a non-default suite would silently mint packages under the default suite, unusable by its
   * own inviters, with the hub and the store both reporting success.
   */
  test('mints and refs under the configured ciphersuite rather than the default', async () => {
    // Baseline: how many suite resolutions ONE mint costs, MEASURED rather than assumed, so the
    // assertion below pins the extra resolution `keyPackageRef` makes without also pinning
    // @kumiai/mls internals.
    const mintCalls: Array<number> = []
    await createLastResortKeyPackageBundle(hub.identity, {
      ciphersuiteName: NON_DEFAULT_CIPHERSUITE,
      cryptoProvider: probeProvider(mintCalls),
    })
    expect(mintCalls.length).toBeGreaterThan(0)

    const calls: Array<number> = []
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
      options: { ciphersuiteName: NON_DEFAULT_CIPHERSUITE, cryptoProvider: probeProvider(calls) },
    })

    const result = await provisioner.ensureProvisioned()
    const record = (await store.list(hub.identity.id))[0]
    expect(record).toBeDefined()
    if (record == null) return

    // `options` reached `createLastResortKeyPackageBundle`: the minted package carries the
    // configured suite rather than the default.
    expect(decodeKeyPackage(record.keyPackage)?.cipherSuite).toBe(NON_DEFAULT_CIPHERSUITE_ID)

    // `options` reached `keyPackageRef`: exactly one resolution beyond what the mint alone needs,
    // and it asked for the configured suite.
    expect(calls).toEqual([...mintCalls, NON_DEFAULT_CIPHERSUITE_ID])
    expect(record.ref).toBe(result.ref)
  })
})

/**
 * Both options are day counts fed straight into arithmetic over clock readings, so an out-of-range
 * value never fails loudly — it inverts a guard and the provisioner keeps reporting success. The
 * checks belong at construction, before any key material exists.
 */
describe('option validation', () => {
  test('rotateWithinDays of 0 is rejected', () => {
    expect(() =>
      createLastResortProvisioner({
        identity: hub.identity,
        client: hub.client,
        store: createMemoryLastResortStore(),
        rotateWithinDays: 0,
      }),
    ).toThrow('mls-hub: rotateWithinDays must be a finite number greater than 0, got 0')
  })

  /**
   * The failure this closes: a negative window makes `notAfter - now > rotateWithinDays * DAY`
   * true for an ALREADY-EXPIRED package, so the provisioner uploads a dead package and reports
   * `rotated: true`.
   */
  test('a negative rotateWithinDays is rejected', () => {
    expect(() =>
      createLastResortProvisioner({
        identity: hub.identity,
        client: hub.client,
        store: createMemoryLastResortStore(),
        rotateWithinDays: -1,
      }),
    ).toThrow('mls-hub: rotateWithinDays must be a finite number greater than 0, got -1')
  })

  /** NaN makes every comparison false: mint and upload on every call, pruning permanently off. */
  test('a NaN rotateWithinDays is rejected', () => {
    expect(() =>
      createLastResortProvisioner({
        identity: hub.identity,
        client: hub.client,
        store: createMemoryLastResortStore(),
        rotateWithinDays: Number.NaN,
      }),
    ).toThrow('mls-hub: rotateWithinDays must be a finite number greater than 0, got NaN')
  })

  /**
   * The worst of the three: a negative grace puts `prune`'s cutoff in the FUTURE, so every retained
   * record except the one the call settled on is deleted while still valid — destroying the private
   * halves of packages inviters may still hold, which is the outage this feature exists to close.
   */
  test('a negative retainAfterExpiryDays is rejected', () => {
    expect(() =>
      createLastResortProvisioner({
        identity: hub.identity,
        client: hub.client,
        store: createMemoryLastResortStore(),
        retainAfterExpiryDays: -1,
      }),
    ).toThrow('mls-hub: retainAfterExpiryDays must be a finite number of 0 or more, got -1')
  })

  test('a NaN retainAfterExpiryDays is rejected', () => {
    expect(() =>
      createLastResortProvisioner({
        identity: hub.identity,
        client: hub.client,
        store: createMemoryLastResortStore(),
        retainAfterExpiryDays: Number.NaN,
      }),
    ).toThrow('mls-hub: retainAfterExpiryDays must be a finite number of 0 or more, got NaN')
  })

  /**
   * Zero is NOT an error, and the boundary must land where the name says: "prune the moment the
   * lifetime ends". A record a minute past its `notAfter` goes (the default 7-day grace would have
   * kept it), one still inside its lifetime stays.
   */
  test('retainAfterExpiryDays of 0 is accepted and prunes at the lifetime boundary', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
      retainAfterExpiryDays: 0,
    })

    await provisioner.ensureProvisioned()
    const live = (await store.list(hub.identity.id))[0]
    expect(live).toBeDefined()
    if (live == null) return

    await store.put(hub.identity.id, {
      ...live,
      ref: 'just-expired-ref',
      keyPackage: 'kp-just-expired',
      notAfter: Math.floor(Date.now() / 1000) - 60,
      uploadedAt: 1,
    })
    await store.put(hub.identity.id, {
      ...live,
      ref: 'still-valid-ref',
      keyPackage: 'kp-still-valid',
      notAfter: secondsFromNow(1),
      uploadedAt: 1,
    })

    await provisioner.ensureProvisioned()

    expect((await store.list(hub.identity.id)).map((r) => r.ref).sort()).toEqual(
      [live.ref, 'still-valid-ref'].sort(),
    )
  })
})
