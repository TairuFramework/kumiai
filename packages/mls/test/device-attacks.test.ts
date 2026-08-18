import { audienceConfirmation, now } from '@kokuin/capability'
import {
  createSigningIdentity,
  createUnsignedToken,
  normalizeDID,
  stringifyToken,
} from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import { MLS_DEVICES_ACT, MLS_DEVICES_RES } from '../src/authentication.js'
import { parseMLSCredentialIdentity } from '../src/credential.js'
import { commitLedgerEntries } from '../src/group-commit.js'
import {
  addDevice,
  announceControllerBeacon,
  registerDevice,
  revokeDevice,
} from '../src/group-device.js'
import { signLedgerEntry } from '../src/ledger.js'
import { ROLE_ENTRY_TYPE } from '../src/roster.js'
import { buildBoundLeaf } from './fixtures/bound-leaf.js'
import {
  buildBoundKeyPackageBundle,
  joinBoundDevice,
  publishTokens,
  twoDeviceProfileGroup,
} from './fixtures/device-harness.js'

/**
 * The did:kokuin device write path's attack matrix: each case is independently built through the
 * REAL write API (registerDevice/addDevice/revokeDevice/commitLedgerEntries), and asserts the
 * WHOLE commit is rejected — a thrown error on the authoring path (commitWithEntries's proof gate
 * runs before a commit is ever produced) or CommitRejectedError on a second member's receive path.
 * One case (stolen manager, within `exp`) is a pinned ACCEPT: the named Slice-2 boundary, not a bug.
 */

describe('attack: thief holds only an authenticate capability', () => {
  test('a bound device presenting its OWN leaf-authenticate capability cannot revoke another device', async () => {
    const { managerGroup, managerIdentity, controllerID, targetDeviceID, capability } =
      await twoDeviceProfileGroup()

    // Build thief-A: a genuine bound co-device of the SAME profile P (so bindingOfDID(A) resolves
    // and controller===authorizedProfile matches) — added by the legitimate manager D, using D's
    // real management capability. A itself is never granted a management capability.
    const attackerSeed = new Uint8Array(32).fill(71)
    const attackerLeaf = await buildBoundLeaf({ deviceSeed: attackerSeed })
    const attackerBundle = await buildBoundKeyPackageBundle(attackerLeaf, attackerSeed)
    const attackerIdentity = createSigningIdentity(attackerSeed)

    const { newGroup: withAttacker } = await addDevice(managerGroup, managerIdentity, {
      keyPackage: attackerBundle.publicPackage,
      device: attackerLeaf.deviceID,
      controller: controllerID,
      capability,
    })

    // A's OWN leaf-embedded grant: act: 'authenticate', res: 'kumiai/mls-leaf' — the Slice 1
    // capability every bound leaf carries for its own MLS validation, NOT a management capability.
    const attackerAuthCap = parseMLSCredentialIdentity(attackerLeaf.identity).controller?.capability
    if (attackerAuthCap == null) {
      throw new Error('test setup: expected a bound leaf carrying an authenticate capability')
    }

    await expect(
      revokeDevice(withAttacker, attackerIdentity, {
        device: targetDeviceID,
        capability: attackerAuthCap,
      }),
    ).rejects.toThrow(/proof verification failed/)
  })
})

describe('attack: forged register', () => {
  test('a bound member cannot register a device it does not own, with no management capability', async () => {
    const { deviceGroup, deviceIdentity, controllerID } = await joinBoundDevice()
    await expect(
      registerDevice(deviceGroup, deviceIdentity, {
        device: 'did:key:zSomeoneElsesDevice',
        controller: controllerID,
        // capability deliberately omitted — not self-register (subject !== issuer), and no proof.
      }),
    ).rejects.toThrow(/proof verification failed/)
  })
})

describe('attack: stolen manager (named, accepted limitation)', () => {
  test('an unexpired management capability is honored regardless of who holds it', async () => {
    // The gate checks only the capability's own signature/exp/cnf — a thief holding a still-valid
    // grant is indistinguishable from the legitimate manager. This is the accepted Slice-2
    // boundary (expiry and revoking the MANAGER's own device are the only closes), not a defect:
    // pinned here as a passing ACCEPT, not treated as something to fix.
    const { managerGroup, managerIdentity, targetDeviceID, capability } =
      await twoDeviceProfileGroup()
    const { newGroup } = await revokeDevice(managerGroup, managerIdentity, {
      device: targetDeviceID,
      capability,
    })
    expect(newGroup.currentDenySet().has(normalizeDID(targetDeviceID))).toBe(true)
  })
})

describe('attack: admin-as-controller', () => {
  test('a device of the admin PROFILE authors an admin role entry — accepted on receive', async () => {
    const {
      managerGroup,
      managerIdentity,
      controllerID,
      creatorIdentity,
      creatorGroup: creatorGroup0,
      tokens,
    } = await twoDeviceProfileGroup()
    let creatorGroup = creatorGroup0

    // D self-registers: authority(D) must read the REGISTRY, never the leaf's own embedded
    // controller — this is what lets a device act with its profile's authority at all.
    const selfReg = await registerDevice(managerGroup, managerIdentity, {
      device: managerIdentity.id,
      controller: controllerID,
    })
    const deviceGroup = selfReg.newGroup
    publishTokens(tokens, deviceGroup)
    await creatorGroup.processMessage(selfReg.commitMessage)

    // The creator grants the PROFILE P — not the device — admin.
    const roleToken = await signLedgerEntry(creatorIdentity, {
      type: ROLE_ENTRY_TYPE,
      groupID: creatorGroup.groupID,
      subject: controllerID,
      value: 'admin',
    })
    const grant = await commitLedgerEntries(creatorGroup, [roleToken])
    creatorGroup = grant.newGroup
    publishTokens(tokens, creatorGroup)
    await deviceGroup.processMessage(grant.commitMessage)

    // D, a device of the now-admin profile, authors a further admin grant via commitLedgerEntries.
    const grantToken = await signLedgerEntry(managerIdentity, {
      type: ROLE_ENTRY_TYPE,
      groupID: deviceGroup.groupID,
      subject: 'did:key:zNewAdmin',
      value: 'admin',
    })
    const byDevice = await commitLedgerEntries(deviceGroup, [grantToken])
    publishTokens(tokens, byDevice.newGroup)

    await expect(creatorGroup.processMessage(byDevice.commitMessage)).resolves.not.toThrow()
    expect(creatorGroup.roster.roles.get(normalizeDID('did:key:zNewAdmin'))).toBe('admin')
  })

  test('a device of a NON-admin profile cannot author a role entry — rejected', async () => {
    const { deviceGroup, deviceIdentity, controllerID } = await joinBoundDevice()
    // P is never granted admin in this group — only the creator is.
    const selfReg = await registerDevice(deviceGroup, deviceIdentity, {
      device: deviceIdentity.id,
      controller: controllerID,
    })
    const grantToken = await signLedgerEntry(deviceIdentity, {
      type: ROLE_ENTRY_TYPE,
      groupID: selfReg.newGroup.groupID,
      subject: 'did:key:zNewAdmin',
      value: 'admin',
    })
    await expect(commitLedgerEntries(selfReg.newGroup, [grantToken])).rejects.toThrow(/admin/)
  })
})

describe('attack: beacon for a controller the issuer is not a device of', () => {
  test('a bound device of controller P is rejected announcing a beacon for a different controller Q', async () => {
    const g = await twoDeviceProfileGroup()
    // managerIdentity is a bound device of g.controllerID (P); announce a beacon naming an
    // unrelated controller DID (Q). The device-proof gate's beacon branch (verifyDeviceEntry,
    // device-proof.ts) requires normalizeDID(binding.controller) === subject, where subject is
    // the announced controller — P !== Q, so the entry is unauthorized.
    await expect(
      announceControllerBeacon(g.managerGroup, g.managerIdentity, {
        controller: 'did:kokuin:someoneElse',
        logLength: 1,
        headDigest: 'zX',
      }),
    ).rejects.toThrow(/proof verification failed/)

    // No receive-path variant: commitWithEntries (group-commit.ts) runs the SAME
    // verifyDeviceEntry gate on the AUTHORING side, against the author's OWN group state,
    // before a commit is ever produced — every real write API that could enact a
    // kumiai.device beacon entry (announceControllerBeacon, or a hand-signed token through
    // commitLedgerEntries) routes through it. There is no honest way to get a signed commit
    // carrying a mismatched-controller beacon out of this codebase for a receiver to reject;
    // the authoring throw above IS the whole-commit rejection, one step earlier. The pure
    // fold-level case (a receiver's foldEnvelope/verifyDeviceEntry pipeline given a
    // hand-crafted VerifiedLedgerEntry) is pinned directly in device-proof.test.ts (Task 3).
  })
})

describe('attack: unsigned management capability', () => {
  test('an alg:none capability is rejected even with an otherwise-valid payload', async () => {
    const { managerGroup, managerIdentity, controllerID, targetDeviceID } =
      await twoDeviceProfileGroup()

    const unsignedCapability = stringifyToken(
      createUnsignedToken({
        iss: controllerID,
        sub: controllerID,
        aud: managerIdentity.id,
        act: MLS_DEVICES_ACT,
        res: MLS_DEVICES_RES,
        exp: now() + 3600,
        cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: managerIdentity.publicKey }),
      }),
    )

    await expect(
      revokeDevice(managerGroup, managerIdentity, {
        device: targetDeviceID,
        capability: unsignedCapability,
      }),
    ).rejects.toThrow(/proof verification failed/)
  })
})
