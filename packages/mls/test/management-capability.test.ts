import { now } from '@kokuin/capability'
import { createSigningIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

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

  test('rejects an expired grant', async () => {
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
