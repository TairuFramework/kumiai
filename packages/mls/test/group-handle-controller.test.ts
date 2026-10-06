import { normalizeDID } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import { twoDeviceProfileGroup } from './fixtures/device-harness.js'

// The member projection maps each leaf's parsed identity to GroupMember. Assert it against a REAL
// handle's listMembers() (the production #iterateMembers generator), not a local reimplementation:
// a bound leaf surfaces its controller DID, a floating (id-only) leaf surfaces none. The harness
// gives both in one group — the manager joined with a bound-leaf credential (controller = P),
// the creator has an id-only leaf (no controller binding).
describe('GroupMember controller surfacing', () => {
  test('a bound leaf surfaces the controller DID; a floating leaf surfaces none', async () => {
    const g = await twoDeviceProfileGroup()
    const members = g.managerGroup.listMembers()

    const manager = members.find((m) => normalizeDID(m.id) === normalizeDID(g.managerIdentity.id))
    // The generator surfaces the controller DID as embedded in the leaf (raw); compare normalized.
    expect(manager?.controller).toBeDefined()
    expect(normalizeDID(manager?.controller as string)).toBe(normalizeDID(g.controllerID))

    const creator = members.find((m) => normalizeDID(m.id) === normalizeDID(g.creatorIdentity.id))
    expect(creator).toBeDefined()
    expect(creator).not.toHaveProperty('controller')
  })
})
