import { audienceConfirmation, now } from '@kokuin/capability'
import { createControllerIdentity } from '@kokuin/controller'
import { createSigningIdentity } from '@kokuin/token'
import { describe, expect, test, vi } from 'vitest'

import { verifyManagementCapability } from '../src/authentication.js'
import { buildManagementCapability } from './fixtures/management-capability.js'

const manager = createSigningIdentity(new Uint8Array(32).fill(51))

describe('verifyManagementCapability', () => {
  test('accepts a valid manage/kumiai-devices grant', async () => {
    const cap = await buildManagementCapability({
      managerDID: manager.id,
      managerKey: manager.publicKey,
    })
    expect(
      await verifyManagementCapability({
        capability: cap.capability,
        prefix: cap.prefix,
        controllerID: cap.controllerID,
        audience: manager.id,
        leafKey: manager.publicKey,
      }),
    ).toBe(true)
  })

  test('rejects a grant lacking the devices permission', async () => {
    const cap = await buildManagementCapability({
      managerDID: manager.id,
      managerKey: manager.publicKey,
      capabilityOverrides: { act: 'authenticate', res: 'kumiai/mls-leaf' },
    })
    expect(
      await verifyManagementCapability({
        capability: cap.capability,
        prefix: cap.prefix,
        controllerID: cap.controllerID,
        audience: manager.id,
        leafKey: manager.publicKey,
      }),
    ).toBe(false)
  })

  test('rejects a grant whose expiry precedes issuance', async () => {
    const cap = await buildManagementCapability({
      managerDID: manager.id,
      managerKey: manager.publicKey,
      capabilityOverrides: { exp: now() - 10 },
    })
    expect(
      await verifyManagementCapability({
        capability: cap.capability,
        prefix: cap.prefix,
        controllerID: cap.controllerID,
        audience: manager.id,
        leafKey: manager.publicKey,
      }),
    ).toBe(false)
  })

  test('rejects when cnf pins a different key', async () => {
    const cap = await buildManagementCapability({
      managerDID: manager.id,
      managerKey: new Uint8Array(32).fill(9),
    })
    expect(
      await verifyManagementCapability({
        capability: cap.capability,
        prefix: cap.prefix,
        controllerID: cap.controllerID,
        audience: manager.id,
        leafKey: manager.publicKey,
      }),
    ).toBe(false)
  })

  test('rejects when the audience is a different device', async () => {
    const cap = await buildManagementCapability({
      managerDID: 'did:key:zSomeoneElse',
      managerKey: manager.publicKey,
    })
    expect(
      await verifyManagementCapability({
        capability: cap.capability,
        prefix: cap.prefix,
        controllerID: cap.controllerID,
        audience: manager.id,
        leafKey: manager.publicKey,
      }),
    ).toBe(false)
  })
})

test('rejects a management grant naming another subject', async () => {
  const f = await buildManagementCapability({
    managerDID: manager.id,
    managerKey: manager.publicKey,
  })
  const controller = createControllerIdentity({
    seed: new Uint8Array(32).fill(31),
    profile: 0,
    log: f.prefix,
  })
  const token = await controller.signToken({
    sub: manager.id,
    aud: manager.id,
    act: 'manage',
    res: 'kumiai/devices',
    iat: 1000,
    exp: 2000,
    cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: manager.publicKey }),
  })
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1500000)
  try {
    expect(
      await verifyManagementCapability({
        ...f,
        capability: `${token.data}.${token.signature}`,
        audience: manager.id,
        leafKey: manager.publicKey,
      }),
    ).toBe(false)
  } finally {
    clock.mockRestore()
  }
})

test('management verdicts use issuance time rather than receiver clocks', async () => {
  const f = await buildManagementCapability({
    managerDID: manager.id,
    managerKey: manager.publicKey,
    capabilityOverrides: { iat: 1000, nbf: 1000, exp: 2000 },
  })
  const clock = vi.spyOn(Date, 'now')
  const verify = () =>
    verifyManagementCapability({ ...f, audience: manager.id, leafKey: manager.publicKey })
  try {
    clock.mockReturnValue(0)
    const a = await verify()
    clock.mockReturnValue(100000000)
    const b = await verify()
    expect(a).toBe(true)
    expect(a).toEqual(b)
    clock.mockImplementation(() => {
      throw new Error('verification read the clock')
    })
    expect(await verify()).toBe(true)
  } finally {
    clock.mockRestore()
  }
})
