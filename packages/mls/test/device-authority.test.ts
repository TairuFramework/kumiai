import { createIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import type { GroupAnchor } from '../src/anchor.js'
import type { FoldInput } from '../src/fold.js'
import { createGroup, type GroupHandle, removeMember, restoreGroup } from '../src/group.js'
import { commitLedgerEntries } from '../src/group-commit.js'
import { announceControllerBeacon, registerDevice, revokeDevice } from '../src/group-device.js'
import { buildCommitPolicyContext } from '../src/group-handle.js'
import { signLedgerEntry } from '../src/ledger.js'
import {
  controllerOf,
  DEVICE_ENTRY_TYPE,
  type DeviceValue,
  denySetOf,
  foldControl,
} from '../src/registry.js'
import { ROLE_ENTRY_TYPE } from '../src/roster.js'
import { publishTokens, twoDeviceProfileGroup } from './fixtures/device-harness.js'

const GROUP = 'device-authority-group'

/**
 * Enacts a real sequence of `kumiai.device` + `kumiai.role` entries through the write API — D
 * (bound device of profile P) self-registers, the creator grants P admin, D revokes its
 * co-device (giving the deny set real content) — then has D, the AUTHOR of the register/add/
 * revoke entries above, leave the group outright (a plain admin `removeMember`, not a revoke:
 * D's own registry record must survive as a live, non-denied binding). Returns the creator's
 * handle — the only member still standing — as `live`.
 */
async function enactDeviceHistoryThenAuthorLeaves(): Promise<{ live: GroupHandle }> {
  const {
    managerGroup,
    managerIdentity,
    controllerID,
    targetDeviceID,
    capability,
    creatorIdentity,
    creatorGroup: creatorGroup0,
    tokens,
  } = await twoDeviceProfileGroup()
  let creatorGroup = creatorGroup0
  let deviceGroup = managerGroup

  // D self-registers: its OWN registry record, distinct from the leaf-embedded binding.
  const selfReg = await registerDevice(deviceGroup, managerIdentity, {
    device: managerIdentity.id,
    controller: controllerID,
  })
  deviceGroup = selfReg.newGroup
  publishTokens(tokens, deviceGroup)
  await creatorGroup.processMessage(selfReg.commitMessage)

  // The creator grants the PROFILE (not the device) admin — a kumiai.role entry.
  const roleToken = await signLedgerEntry(creatorIdentity, {
    type: ROLE_ENTRY_TYPE,
    groupID: creatorGroup.groupID,
    subject: controllerID,
    value: 'admin',
  })
  const roleGrant = await commitLedgerEntries(creatorGroup, [roleToken])
  creatorGroup = roleGrant.newGroup
  publishTokens(tokens, creatorGroup)
  await deviceGroup.processMessage(roleGrant.commitMessage)

  // D revokes its co-device (target) — the deny set gains a real, non-author member.
  const revoke = await revokeDevice(deviceGroup, managerIdentity, {
    device: targetDeviceID,
    capability,
  })
  deviceGroup = revoke.newGroup
  publishTokens(tokens, deviceGroup)
  await creatorGroup.processMessage(revoke.commitMessage)

  // D — the author of every kumiai.device entry above — leaves the group outright.
  const dLeaf = creatorGroup.findMemberLeafIndex(managerIdentity.id)
  if (dLeaf === undefined) throw new Error('test setup: D has no leaf to remove')
  const leave = await removeMember(creatorGroup, dLeaf)
  creatorGroup = leave.newGroup

  return { live: creatorGroup }
}

describe('GroupHandle device registry', () => {
  test('currentDenySet is empty on a fresh group', async () => {
    const creator = await createIdentity({
      keys: [{ purpose: 'sig', alg: 'EdDSA' }],
      didMethod: 'key',
    })
    const { group } = await createGroup(creator, GROUP)
    expect(group.currentDenySet().size).toBe(0)
    expect(group.registry.devices.size).toBe(0)
  })

  test('a folded register binding is readable through controllerOf/denySetOf', () => {
    // Ruling override (2026-08-17): the brief's original version of this test committed an
    // un-owned kumiai.device register through commitLedgerEntries, authored by a leaf that is
    // not a bound device of the profile it registers. Task 5 adds an authoring device-proof
    // gate inside commitWithEntries (which commitLedgerEntries routes through) that rejects
    // exactly that shape, so this asserts the combined fold directly instead of routing through
    // the real commit path — Task 3 pins the fold/accessor wiring only. Dedicated
    // register-through-a-gated-commit coverage lands in Tasks 8-10 with the bound-device write
    // API.
    const anchor: GroupAnchor = { creatorDID: 'did:key:zCreator', version: 1 }
    const input: FoldInput<DeviceValue> = {
      verified: {
        issuer: 'did:key:zDeviceX',
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: 'did:key:zDeviceX',
          value: { op: 'register', controller: 'did:kokuin:profileP' },
        },
      },
      entryID: 'e1',
    }
    const { registry } = foldControl([input], anchor, GROUP)
    // normalizeDID only folds did:peer:4 (see @kokuin/token); did:kokuin passes through
    // unchanged, so the controller reads back exactly as registered.
    expect(controllerOf(registry, 'did:key:zDeviceX')).toBe('did:kokuin:profileP')
    expect(denySetOf(registry).size).toBe(0)
  })

  test('denySetOf answers `has` correctly for both a revoked and an active device (matched, never enumerated)', () => {
    const anchor: GroupAnchor = { creatorDID: 'did:key:zCreator', version: 1 }
    const entries: Array<FoldInput<DeviceValue>> = [
      {
        verified: {
          issuer: 'did:key:zDeviceX',
          entry: {
            type: DEVICE_ENTRY_TYPE,
            groupID: GROUP,
            subject: 'did:key:zDeviceX',
            value: { op: 'register', controller: 'did:kokuin:profileP' },
          },
        },
        entryID: 'e1',
      },
      {
        verified: {
          issuer: 'did:key:zDeviceX',
          entry: {
            type: DEVICE_ENTRY_TYPE,
            groupID: GROUP,
            subject: 'did:key:zDeviceY',
            value: { op: 'register', controller: 'did:kokuin:profileP' },
          },
        },
        entryID: 'e2',
      },
      {
        verified: {
          issuer: 'did:key:zDeviceX',
          entry: {
            type: DEVICE_ENTRY_TYPE,
            groupID: GROUP,
            subject: 'did:key:zDeviceY',
            value: { op: 'revoke' },
          },
        },
        entryID: 'e3',
      },
    ]
    const { registry } = foldControl(entries, anchor, GROUP)
    const deny = denySetOf(registry)
    expect(deny.has('did:key:zDeviceY')).toBe(true)
    expect(deny.has('did:key:zDeviceX')).toBe(false)
  })
})

describe('determinism: incremental fold vs bootstrap re-fold', () => {
  test('incremental fold equals bootstrap re-fold, even after the author left', async () => {
    const { live } = await enactDeviceHistoryThenAuthorLeaves()
    const tokens = await live.getLedger()

    // Reconstruct a fresh handle purely from the ledger tokens: an empty-ledger restoreGroup
    // (seeding roster/registry from the anchor alone) over the SAME post-removal state, then
    // bootstrapLedger over the raw tokens — the head-verified re-fold path, not a shortcut
    // through foldControl directly.
    const bootstrapped = await restoreGroup({ state: live.state, credential: live.credential })
    await bootstrapped.bootstrapLedger(tokens)

    expect([...bootstrapped.registry.devices.entries()]).toEqual([
      ...live.registry.devices.entries(),
    ])
    expect([...bootstrapped.currentDenySet()]).toEqual([...live.currentDenySet()])
    expect([...bootstrapped.roster.roles.entries()]).toEqual([...live.roster.roles.entries()])

    // Non-vacuous: the author (D) is gone from the tree, yet its own self-register binding and
    // its co-device's revoke both persist in the re-folded registry/deny set.
    expect(bootstrapped.registry.devices.size).toBeGreaterThan(0)
    expect(bootstrapped.currentDenySet().size).toBeGreaterThan(0)
  })

  test('incremental fold equals bootstrap re-fold for the controllers projection, after a beacon and a revoke', async () => {
    const { managerGroup, managerIdentity, controllerID, targetDeviceID, capability } =
      await twoDeviceProfileGroup()

    const revoke = await revokeDevice(managerGroup, managerIdentity, {
      device: targetDeviceID,
      capability,
    })
    const beacon = await announceControllerBeacon(revoke.newGroup, managerIdentity, {
      controller: controllerID,
      logLength: 7,
      headDigest: 'zDet7',
    })
    const live = beacon.newGroup
    const tokens = await live.getLedger()

    const bootstrapped = await restoreGroup({ state: live.state, credential: live.credential })
    await bootstrapped.bootstrapLedger(tokens)

    expect([...bootstrapped.registry.controllers.entries()]).toEqual([
      ...live.registry.controllers.entries(),
    ])
    expect(bootstrapped.revokedDevices()).toEqual(live.revokedDevices())

    // Non-vacuous: the beacon projection and the deny set both carry real content, not two
    // empty maps agreeing vacuously.
    expect(bootstrapped.registry.controllers.size).toBeGreaterThan(0)
    expect(bootstrapped.revokedDevices().length).toBeGreaterThan(0)
  })
})

describe('commit-policy admin resolution honors revoked status (Fix 2 residual)', () => {
  // Drives the REAL exported buildCommitPolicyContext provider on a REAL handle: an active device
  // of an admin profile resolves to its controller (admin), a revoked device resolves to undefined
  // (isAdmin's `controllerOf ?? id` then falls back to the device's own DID — not admin), while the
  // shared raw controllerOf still returns the controller for the revoked device.
  function ctxArgs(handle: GroupHandle) {
    return {
      baseRoster: handle.roster,
      candidateRoster: handle.roster,
      entryIDs: [] as Array<string>,
      enactedDeviceEntries: [] as Array<{ subject: string; op: DeviceValue['op'] }>,
    }
  }

  test('active device → controller; revoked device → undefined (raw controllerOf unchanged)', async () => {
    const { managerGroup, managerIdentity, controllerID, targetDeviceID, capability } =
      await twoDeviceProfileGroup()

    // Active: the target device is bound to controllerID (P) via addDevice.
    const activeCtx = buildCommitPolicyContext(managerGroup, ctxArgs(managerGroup))
    expect(activeCtx.controllerOf(targetDeviceID)).toBe(controllerID)

    // Revoke the target, then resolve again on the post-revoke handle.
    const { newGroup: afterRevoke } = await revokeDevice(managerGroup, managerIdentity, {
      device: targetDeviceID,
      capability,
    })
    const revokedCtx = buildCommitPolicyContext(afterRevoke, ctxArgs(afterRevoke))
    // The policy provider drops a revoked device to undefined → not admin.
    expect(revokedCtx.controllerOf(targetDeviceID)).toBeUndefined()
    // The shared raw controllerOf still returns the controller (emission + revoke gate rely on it).
    expect(controllerOf(afterRevoke.registry, targetDeviceID)).toBe(controllerID)
  })
})
