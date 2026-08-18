import { normalizeDID } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import { labelDevice, revokeDevice } from '../src/group-device.js'
import { publishTokens, twoDeviceProfileGroup } from './fixtures/device-harness.js'

/**
 * The EventEmitter surface (Task 4): revokedDevices() as a folded-state accessor, and
 * deviceRevoked firing on the receive path (an existing member's processMessage of a revoke
 * commit). The write side's own local fire (deriveGroup + emitControlEvents on the sender's
 * derived handle) is Task 5's — not exercised here.
 */
describe('device events', () => {
  test('revokedDevices() lists a revoked binding with its controller', async () => {
    const g = await twoDeviceProfileGroup()
    const res = await revokeDevice(g.managerGroup, g.managerIdentity, {
      device: g.targetDeviceID,
      capability: g.capability,
    })
    const revoked = res.newGroup.revokedDevices()
    expect(revoked.map((r) => r.device)).toContain(normalizeDID(g.targetDeviceID))
    expect(revoked.find((r) => r.device === normalizeDID(g.targetDeviceID))?.controller).toBe(
      normalizeDID(g.controllerID),
    )
  })

  test('a receiver fires deviceRevoked exactly once when it processes a revoke commit', async () => {
    const g = await twoDeviceProfileGroup()
    const seen: Array<Array<{ device: string; controller: string }>> = []
    g.creatorGroup.events.on('deviceRevoked', (batch) => {
      seen.push(batch)
    })

    const res = await revokeDevice(g.managerGroup, g.managerIdentity, {
      device: g.targetDeviceID,
      capability: g.capability,
    })
    publishTokens(g.tokens, res.newGroup)
    await g.creatorGroup.processMessage(res.commitMessage)

    expect(seen.length).toBe(1)
    expect(seen[0]?.map((r) => r.device)).toContain(normalizeDID(g.targetDeviceID))
  })

  test('a receiver processing a register/add-only commit fires no deviceRevoked', async () => {
    const g = await twoDeviceProfileGroup()
    const seen: Array<Array<{ device: string; controller: string }>> = []
    g.creatorGroup.events.on('deviceRevoked', (batch) => {
      seen.push(batch)
    })

    const res = await labelDevice(g.managerGroup, g.managerIdentity, {
      device: g.targetDeviceID,
      label: 'laptop',
      capability: g.capability,
    })
    publishTokens(g.tokens, res.newGroup)
    await g.creatorGroup.processMessage(res.commitMessage)

    expect(seen.length).toBe(0)
  })
})
