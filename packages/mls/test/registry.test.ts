import { normalizeDID } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import type { GroupAnchor } from '../src/anchor.js'
import type { FoldInput } from '../src/fold.js'
import {
  authority,
  beaconOf,
  type ControllerBeacon,
  controllerOf,
  DEVICE_ENTRY_TYPE,
  type DeviceValue,
  denySetOf,
  foldControl,
  isDeviceValue,
  registryApply,
  registrySeed,
} from '../src/registry.js'
import { ROLE_ENTRY_TYPE, type RoleValue } from '../src/roster.js'

const GROUP = 'group-1'
const CREATOR = 'did:key:zCreator'
const PROFILE = 'did:kokuin:profileP'
const DEV_A = 'did:key:zDeviceA'
const DEV_B = 'did:key:zDeviceB'

function deviceInput(
  issuer: string,
  subject: string,
  value: DeviceValue,
  entryID: string,
  groupID = GROUP,
): FoldInput<DeviceValue> {
  return {
    verified: {
      issuer: normalizeDID(issuer),
      entry: { type: DEVICE_ENTRY_TYPE, groupID, subject, value },
    },
    entryID,
  }
}

function roleInput(
  issuer: string,
  subject: string,
  value: RoleValue,
  entryID: string,
  groupID = GROUP,
): FoldInput<RoleValue> {
  return {
    verified: {
      issuer: normalizeDID(issuer),
      entry: { type: ROLE_ENTRY_TYPE, groupID, subject, value },
    },
    entryID,
  }
}

describe('registryApply', () => {
  test('register binds a device to a controller, active', () => {
    const r = registryApply(
      {
        issuer: normalizeDID(DEV_A),
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: DEV_A,
          value: { op: 'register', controller: PROFILE },
        },
      },
      registrySeed(),
    )
    expect(controllerOf(r, DEV_A)).toBe(normalizeDID(PROFILE))
    expect(r.devices.get(normalizeDID(DEV_A))?.status).toBe('active')
  })

  test('revoke flips status and populates the deny set, keeping the controller', () => {
    let r = registryApply(
      {
        issuer: normalizeDID(PROFILE),
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: DEV_A,
          value: { op: 'register', controller: PROFILE },
        },
      },
      registrySeed(),
    )
    r = registryApply(
      {
        issuer: normalizeDID(PROFILE),
        entry: { type: DEVICE_ENTRY_TYPE, groupID: GROUP, subject: DEV_A, value: { op: 'revoke' } },
      },
      r,
    )
    expect(r.devices.get(normalizeDID(DEV_A))?.status).toBe('revoked')
    expect(controllerOf(r, DEV_A)).toBe(normalizeDID(PROFILE))
    expect(denySetOf(r).has(normalizeDID(DEV_A))).toBe(true)
  })

  test('revocation is terminal: a later register/add does not re-activate a revoked subject', () => {
    let r = registryApply(
      {
        issuer: normalizeDID(PROFILE),
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: DEV_A,
          value: { op: 'register', controller: PROFILE },
        },
      },
      registrySeed(),
    )
    r = registryApply(
      {
        issuer: normalizeDID(PROFILE),
        entry: { type: DEVICE_ENTRY_TYPE, groupID: GROUP, subject: DEV_A, value: { op: 'revoke' } },
      },
      r,
    )
    // A second register of the revoked subject must NOT clear its revoked status or deny-set bit.
    r = registryApply(
      {
        issuer: normalizeDID(PROFILE),
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: DEV_A,
          value: { op: 'register', controller: PROFILE },
        },
      },
      r,
    )
    expect(r.devices.get(normalizeDID(DEV_A))?.status).toBe('revoked')
    expect(denySetOf(r).has(normalizeDID(DEV_A))).toBe(true)
    // An `add` of the revoked subject is likewise a no-op against the revoked status.
    r = registryApply(
      {
        issuer: normalizeDID(PROFILE),
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: DEV_A,
          value: { op: 'add', controller: PROFILE },
        },
      },
      r,
    )
    expect(r.devices.get(normalizeDID(DEV_A))?.status).toBe('revoked')
    expect(denySetOf(r).has(normalizeDID(DEV_A))).toBe(true)
  })

  test('label sets a label without changing binding or status', () => {
    let r = registryApply(
      {
        issuer: normalizeDID(PROFILE),
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: DEV_A,
          value: { op: 'register', controller: PROFILE },
        },
      },
      registrySeed(),
    )
    r = registryApply(
      {
        issuer: normalizeDID(PROFILE),
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: DEV_A,
          value: { op: 'label', label: 'laptop' },
        },
      },
      r,
    )
    expect(r.devices.get(normalizeDID(DEV_A))?.label).toBe('laptop')
    expect(r.devices.get(normalizeDID(DEV_A))?.status).toBe('active')
  })
})

describe('authority', () => {
  test('resolves a bound device to its controller', () => {
    const r = registryApply(
      {
        issuer: normalizeDID(DEV_A),
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: DEV_A,
          value: { op: 'register', controller: PROFILE },
        },
      },
      registrySeed(),
    )
    expect(authority(r, DEV_A)).toBe(normalizeDID(PROFILE))
  })

  test('falls back to the issuer when unbound', () => {
    expect(authority(registrySeed(), DEV_A)).toBe(normalizeDID(DEV_A))
  })

  test('a revoked device confers no authority, though its raw binding and deny-set membership persist', () => {
    let r = registryApply(
      {
        issuer: normalizeDID(DEV_A),
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: DEV_A,
          value: { op: 'register', controller: PROFILE },
        },
      },
      registrySeed(),
    )
    r = registryApply(
      {
        issuer: normalizeDID(PROFILE),
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: DEV_A,
          value: { op: 'revoke' },
        },
      },
      r,
    )
    // authority drops to the device's own DID: a revoked binding confers no authority.
    expect(authority(r, DEV_A)).toBe(normalizeDID(DEV_A))
    // but the raw binding is deliberately preserved (deviceRevoked emission + revoke gate read it)…
    expect(controllerOf(r, DEV_A)).toBe(normalizeDID(PROFILE))
    // …and the device stays in the deny set.
    expect(denySetOf(r).has(normalizeDID(DEV_A))).toBe(true)
  })
})

describe('foldControl', () => {
  const anchor: GroupAnchor = { creatorDID: CREATOR, version: 1 }

  test('empty ledger seeds creator-admin and an empty registry', () => {
    const { roster, registry } = foldControl([], anchor, GROUP)
    expect(roster.roles.get(normalizeDID(CREATOR))).toBe('admin')
    expect(registry.devices.size).toBe(0)
  })

  test('admin-as-controller: a device of an admin profile authors a role entry', () => {
    // Creator makes PROFILE an admin; DEV_A registers under PROFILE; DEV_A (a device of the
    // admin profile) promotes DEV_B's controller. authority(DEV_A) === PROFILE === admin.
    const { roster } = foldControl(
      [
        roleInput(CREATOR, PROFILE, 'admin', 'e1'),
        deviceInput(DEV_A, DEV_A, { op: 'register', controller: PROFILE }, 'e2'),
        roleInput(DEV_A, DEV_B, 'member', 'e3'),
      ],
      anchor,
      GROUP,
    )
    expect(roster.roles.get(normalizeDID(DEV_B))).toBe('member')
  })

  test('a device of a NON-admin profile cannot author a role entry (dropped)', () => {
    const drops: Array<{ entryID: string }> = []
    const { roster } = foldControl(
      [
        deviceInput(DEV_A, DEV_A, { op: 'register', controller: PROFILE }, 'e1'),
        roleInput(DEV_A, DEV_B, 'admin', 'e2'),
      ],
      anchor,
      GROUP,
      (d) => drops.push(d),
    )
    expect(roster.roles.get(normalizeDID(DEV_B))).toBeUndefined()
    expect(drops.map((d) => d.entryID)).toContain('e2')
  })

  test('registry-so-far, not final: a role entry authored BEFORE its issuer registers is dropped', () => {
    // Order matters — determinism. The role entry at e1 must NOT resolve authority against a
    // binding registered later at e2.
    const { roster } = foldControl(
      [
        roleInput(CREATOR, PROFILE, 'admin', 'a0'),
        roleInput(DEV_A, DEV_B, 'member', 'e1'),
        deviceInput(DEV_A, DEV_A, { op: 'register', controller: PROFILE }, 'e2'),
      ],
      anchor,
      GROUP,
    )
    expect(roster.roles.get(normalizeDID(DEV_B))).toBeUndefined()
  })

  test('a role entry that would empty the admin set is dropped; the last admin survives', () => {
    // Creator is the only admin. An admin may author role entries, so creator demoting itself
    // to member passes the authority gate — but adminCount(next) === 0 trips the floor, so the
    // entry is dropped (never thrown) and creator stays admin. This is the invariant guarding
    // against a group locking itself out of all membership authority.
    const drops: Array<{ entryID: string }> = []
    const { roster } = foldControl(
      [roleInput(CREATOR, CREATOR, 'member', 'e1')],
      anchor,
      GROUP,
      (d) => drops.push(d),
    )
    expect(roster.roles.get(normalizeDID(CREATOR))).toBe('admin')
    expect(drops.map((d) => d.entryID)).toContain('e1')
  })

  test('a cross-group entry is dropped by both projections', () => {
    const { roster, registry } = foldControl(
      [deviceInput(DEV_A, DEV_A, { op: 'register', controller: PROFILE }, 'e1', 'other-group')],
      anchor,
      GROUP,
    )
    expect(registry.devices.size).toBe(0)
    expect(roster.roles.get(normalizeDID(CREATOR))).toBe('admin')
  })
})

describe('beacon', () => {
  test('a beacon op records the controller log head in the controllers projection', () => {
    const r = registryApply(
      {
        issuer: normalizeDID(DEV_A),
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: PROFILE, // subject is the CONTROLLER, not a device
          value: { op: 'beacon', logLength: 7, headDigest: 'zHead1' },
        },
      },
      registrySeed(),
    )
    const expected: ControllerBeacon = { logLength: 7, headDigest: 'zHead1' }
    expect(beaconOf(r, PROFILE)).toEqual(expected)
    // A beacon touches only the controllers projection, never devices or the deny set.
    expect(r.devices.size).toBe(0)
    expect(denySetOf(r).size).toBe(0)
  })

  test('a later beacon overwrites the earlier one (last-write-wins)', () => {
    let r = registryApply(
      {
        issuer: normalizeDID(DEV_A),
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: PROFILE,
          value: { op: 'beacon', logLength: 3, headDigest: 'zOld' },
        },
      },
      registrySeed(),
    )
    r = registryApply(
      {
        issuer: normalizeDID(DEV_A),
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: PROFILE,
          value: { op: 'beacon', logLength: 9, headDigest: 'zNew' },
        },
      },
      r,
    )
    expect(beaconOf(r, PROFILE)).toEqual({ logLength: 9, headDigest: 'zNew' })
  })

  test('a device register/revoke leaves the controllers projection untouched', () => {
    let r = registryApply(
      {
        issuer: normalizeDID(DEV_A),
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: DEV_A,
          value: { op: 'register', controller: PROFILE },
        },
      },
      registrySeed(),
    )
    r = registryApply(
      {
        issuer: normalizeDID(DEV_A),
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: PROFILE,
          value: { op: 'beacon', logLength: 2, headDigest: 'zH' },
        },
      },
      r,
    )
    r = registryApply(
      {
        issuer: normalizeDID(PROFILE),
        entry: { type: DEVICE_ENTRY_TYPE, groupID: GROUP, subject: DEV_A, value: { op: 'revoke' } },
      },
      r,
    )
    // The revoke changed device status but not the controller beacon.
    expect(beaconOf(r, PROFILE)).toEqual({ logLength: 2, headDigest: 'zH' })
    expect(r.devices.get(normalizeDID(DEV_A))?.status).toBe('revoked')
  })

  test('isDeviceValue accepts a well-formed beacon and rejects a malformed one', () => {
    expect(isDeviceValue({ op: 'beacon', logLength: 1, headDigest: 'z' })).toBe(true)
    expect(isDeviceValue({ op: 'beacon', logLength: 1 })).toBe(false) // missing headDigest
    expect(isDeviceValue({ op: 'beacon', headDigest: 'z' })).toBe(false) // missing logLength
    expect(isDeviceValue({ op: 'beacon', logLength: '1', headDigest: 'z' })).toBe(false) // wrong type
  })
})
