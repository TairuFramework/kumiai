import { createInception, didFromInception, type SignedEvent } from '@kokuin/controller'
import { createSigningIdentity, normalizeDID } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import type { DeviceProofContext, LeafBinding } from '../src/device-proof.js'
import { verifyDeviceEntry } from '../src/device-proof.js'
import { DEVICE_ENTRY_TYPE, type DeviceValue } from '../src/registry.js'
import { buildManagementCapability } from './fixtures/management-capability.js'

const GROUP = 'g'
const CONTROLLER_SEED = new Uint8Array(32).fill(31)
const inception = createInception(CONTROLLER_SEED, 0)
const PROFILE = didFromInception(inception.event)
const PREFIX: Array<SignedEvent> = [inception]

const manager = createSigningIdentity(new Uint8Array(32).fill(51))
const other = createSigningIdentity(new Uint8Array(32).fill(61))

function entry(issuer: string, subject: string, value: DeviceValue) {
  return { issuer, entry: { type: DEVICE_ENTRY_TYPE, groupID: GROUP, subject, value } }
}

function ctx(
  overrides: Partial<DeviceProofContext> & { bindings: Record<string, LeafBinding> },
): DeviceProofContext {
  return {
    bindingOfDID: (did) => overrides.bindings[did],
    controllerOf: overrides.controllerOf ?? (() => undefined),
  }
}

describe('verifyDeviceEntry — self-register (leaf attestation)', () => {
  test('accepts when the issuer leaf binds to value.controller', async () => {
    const c = ctx({
      bindings: {
        [manager.id]: { controller: PROFILE, prefix: PREFIX, leafKey: manager.publicKey },
      },
    })
    expect(
      await verifyDeviceEntry(
        entry(manager.id, manager.id, { op: 'register', controller: PROFILE }),
        c,
      ),
    ).toBe(true)
  })

  test('rejects when the issuer leaf is floating (no controller)', async () => {
    const c = ctx({ bindings: { [manager.id]: { leafKey: manager.publicKey } } })
    expect(
      await verifyDeviceEntry(
        entry(manager.id, manager.id, { op: 'register', controller: PROFILE }),
        c,
      ),
    ).toBe(false)
  })

  test('rejects when the issuer leaf binds to a different profile (forged register)', async () => {
    const c = ctx({
      bindings: {
        [manager.id]: {
          controller: 'did:kokuin:someoneElse',
          prefix: PREFIX,
          leafKey: manager.publicKey,
        },
      },
    })
    expect(
      await verifyDeviceEntry(
        entry(manager.id, manager.id, { op: 'register', controller: PROFILE }),
        c,
      ),
    ).toBe(false)
  })
})

describe('verifyDeviceEntry — manage ops (management capability)', () => {
  test('accepts a co-device register by a manager device holding the grant', async () => {
    const cap = await buildManagementCapability({
      managerDID: manager.id,
      managerKey: manager.publicKey,
      controllerSeed: CONTROLLER_SEED,
    })
    const c = ctx({
      bindings: {
        [manager.id]: { controller: PROFILE, prefix: PREFIX, leafKey: manager.publicKey },
      },
    })
    const value: DeviceValue = { op: 'register', controller: PROFILE, capability: cap.capability }
    expect(await verifyDeviceEntry(entry(manager.id, 'did:key:zNewDevice', value), c)).toBe(true)
  })

  test('rejects a manage op with no capability', async () => {
    const c = ctx({
      bindings: {
        [manager.id]: { controller: PROFILE, prefix: PREFIX, leafKey: manager.publicKey },
      },
    })
    expect(
      await verifyDeviceEntry(
        entry(manager.id, 'did:key:zNewDevice', { op: 'add', controller: PROFILE }),
        c,
      ),
    ).toBe(false)
  })

  test('revoke is authorized against controllerOf(subject)', async () => {
    const cap = await buildManagementCapability({
      managerDID: manager.id,
      managerKey: manager.publicKey,
      controllerSeed: CONTROLLER_SEED,
    })
    const c = ctx({
      bindings: {
        [manager.id]: { controller: PROFILE, prefix: PREFIX, leafKey: manager.publicKey },
      },
      controllerOf: (did) => (did === 'did:key:zTarget' ? PROFILE : undefined),
    })
    const value: DeviceValue = { op: 'revoke', capability: cap.capability }
    expect(await verifyDeviceEntry(entry(manager.id, 'did:key:zTarget', value), c)).toBe(true)
  })

  test('rejects a revoke by a device of a DIFFERENT profile (thief holds only authenticate)', async () => {
    // `other` presents a grant issued by PROFILE but its OWN leaf binds to a different profile, so
    // it is not a device of PROFILE — the binding->authorizedProfile check fails.
    const cap = await buildManagementCapability({
      managerDID: other.id,
      managerKey: other.publicKey,
      controllerSeed: CONTROLLER_SEED,
    })
    const c = ctx({
      bindings: {
        [other.id]: {
          controller: 'did:kokuin:otherProfile',
          prefix: PREFIX,
          leafKey: other.publicKey,
        },
      },
      controllerOf: () => PROFILE,
    })
    const value: DeviceValue = { op: 'revoke', capability: cap.capability }
    expect(await verifyDeviceEntry(entry(other.id, 'did:key:zTarget', value), c)).toBe(false)
  })
})

describe('verifyDeviceEntry — cross-profile rebind guard (Fix 1)', () => {
  const victim = 'did:key:zVictimDevice'
  const profileQ = normalizeDID('did:kokuin:profileQ')

  async function managerCtx(
    controllerOf: DeviceProofContext['controllerOf'],
  ): Promise<DeviceProofContext> {
    return ctx({
      bindings: {
        [manager.id]: { controller: PROFILE, prefix: PREFIX, leafKey: manager.publicKey },
      },
      controllerOf,
    })
  }

  test('rejects a co-device register whose subject is already bound to a DIFFERENT controller', async () => {
    const cap = await buildManagementCapability({
      managerDID: manager.id,
      managerKey: manager.publicKey,
      controllerSeed: CONTROLLER_SEED,
    })
    const c = await managerCtx((did) => (did === normalizeDID(victim) ? profileQ : undefined))
    const value: DeviceValue = { op: 'register', controller: PROFILE, capability: cap.capability }
    expect(await verifyDeviceEntry(entry(manager.id, victim, value), c)).toBe(false)
  })

  test('rejects a co-device add over a subject already bound to a DIFFERENT controller', async () => {
    const cap = await buildManagementCapability({
      managerDID: manager.id,
      managerKey: manager.publicKey,
      controllerSeed: CONTROLLER_SEED,
    })
    const c = await managerCtx((did) => (did === normalizeDID(victim) ? profileQ : undefined))
    const value: DeviceValue = { op: 'add', controller: PROFILE, capability: cap.capability }
    expect(await verifyDeviceEntry(entry(manager.id, victim, value), c)).toBe(false)
  })

  test('accepts a co-device register re-binding the subject to the SAME controller', async () => {
    const cap = await buildManagementCapability({
      managerDID: manager.id,
      managerKey: manager.publicKey,
      controllerSeed: CONTROLLER_SEED,
    })
    const c = await managerCtx((did) =>
      did === normalizeDID(victim) ? normalizeDID(PROFILE) : undefined,
    )
    const value: DeviceValue = { op: 'register', controller: PROFILE, capability: cap.capability }
    expect(await verifyDeviceEntry(entry(manager.id, victim, value), c)).toBe(true)
  })

  test('accepts a co-device register over a brand-new (unbound) subject', async () => {
    const cap = await buildManagementCapability({
      managerDID: manager.id,
      managerKey: manager.publicKey,
      controllerSeed: CONTROLLER_SEED,
    })
    const c = await managerCtx(() => undefined)
    const value: DeviceValue = { op: 'register', controller: PROFILE, capability: cap.capability }
    expect(await verifyDeviceEntry(entry(manager.id, victim, value), c)).toBe(true)
  })
})

describe('verifyDeviceEntry — beacon (self-scoped, no capability)', () => {
  const otherProfile = normalizeDID('did:kokuin:profileOther')

  test('accepts a beacon authored by a bound device of the subject controller — no capability', async () => {
    const c = ctx({
      bindings: {
        [manager.id]: { controller: PROFILE, prefix: PREFIX, leafKey: manager.publicKey },
      },
    })
    const value: DeviceValue = { op: 'beacon', logLength: 4, headDigest: 'zH' }
    expect(await verifyDeviceEntry(entry(manager.id, PROFILE, value), c)).toBe(true)
  })

  test('rejects a beacon whose issuer is bound to a DIFFERENT controller', async () => {
    const c = ctx({
      bindings: {
        [manager.id]: { controller: PROFILE, prefix: PREFIX, leafKey: manager.publicKey },
      },
    })
    const value: DeviceValue = { op: 'beacon', logLength: 4, headDigest: 'zH' }
    expect(await verifyDeviceEntry(entry(manager.id, otherProfile, value), c)).toBe(false)
  })

  test('rejects a beacon whose issuer holds no bound leaf', async () => {
    const c = ctx({ bindings: {} })
    const value: DeviceValue = { op: 'beacon', logLength: 4, headDigest: 'zH' }
    expect(await verifyDeviceEntry(entry('did:key:zFloating', PROFILE, value), c)).toBe(false)
  })
})
