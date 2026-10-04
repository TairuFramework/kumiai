import { audienceConfirmation, now } from '@kokuin/capability'
import {
  createReset,
  createRevoke,
  createRevokeWithKey,
  createRotate,
  type SignedEvent,
} from '@kokuin/controller'
import {
  createSigningIdentity,
  createUnsignedToken,
  normalizeDID,
  stringifyToken,
} from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import { MLS_DEVICES_ACT, MLS_DEVICES_RES } from '../src/authentication.js'
import { readCapability } from '../src/capability.js'
import { parseMLSCredentialIdentity } from '../src/credential.js'
import { RevokeProofError, type RevokeProofReason } from '../src/errors.js'
import { commitLedgerEntries, commitWithEntries } from '../src/group-commit.js'
import {
  addDevice,
  announceControllerBeacon,
  registerDevice,
  revokeDevice,
} from '../src/group-device.js'
import { CommitRejectedError } from '../src/group-handle.js'
import { signLedgerEntry } from '../src/ledger.js'
import { DEVICE_ENTRY_TYPE, type DeviceValue } from '../src/registry.js'
import { ROLE_ENTRY_TYPE } from '../src/roster.js'
import { buildBoundLeaf } from './fixtures/bound-leaf.js'
import {
  buildBoundKeyPackageBundle,
  joinBoundDevice,
  publishTokens,
  twoDeviceProfileGroup,
} from './fixtures/device-harness.js'
import {
  addMember,
  agent,
  bindingFor,
  controllerID,
  controllerSeed,
  enact,
  inception,
  lifecycleGroup,
  publish,
  rawEnact,
} from './fixtures/lifecycle-ledger.js'

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

describe('attack: cross-profile device rebind (Fix 1)', () => {
  // The load-bearing rejection coverage for the cross-profile hijack lives in device-proof.test.ts
  // ('cross-profile rebind guard'), which drives the exact verifyDeviceEntry gate the write path
  // (commitWithEntries) runs. A genuine second profile Q with its own bound device folded into the
  // SAME group would require multi-member cross-group MLS choreography the single-profile harness
  // does not provide; the fold-level unit test is the honest, load-bearing coverage. This e2e pins
  // the no-false-positive half through the REAL write API: a manager re-registering a device to its
  // OWN existing controller must NOT be blocked by the new guard.
  test('re-registering a device to its OWN existing controller through the real write path is accepted', async () => {
    const { managerGroup, managerIdentity, controllerID, targetDeviceID, capability } =
      await twoDeviceProfileGroup()
    // targetDeviceID is already bound to controllerID (P) via addDevice — same-controller re-register.
    await expect(
      registerDevice(managerGroup, managerIdentity, {
        device: targetDeviceID,
        controller: controllerID,
        capability,
      }),
    ).resolves.toBeDefined()
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

describe('attack: history hidden in advisory or clock entries', () => {
  const oversized = createRotate({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    prior: inception.event,
    options: { seal: 'a'.repeat(393216) },
  })
  const fields = [
    { proof: [inception, oversized] },
    { revoked: [{ did: agent(61).id }] },
    { proof: [inception, oversized], revoked: [{ did: agent(61).id }] },
  ]

  test.each(['clock', 'beacon'] as const)('author rejects hidden history on %s', async (op) => {
    const { group, identity } = await lifecycleGroup()
    const binding = group.bindingOfDID(identity.id)
    if (binding?.capability == null) throw new Error('Missing leaf capability')
    const base: DeviceValue =
      op === 'clock'
        ? {
            op,
            time: readCapability(binding.capability).payload.iat,
          }
        : { op, logLength: 2, headDigest: 'advisory' }
    for (const extra of fields) {
      const token = await signLedgerEntry(identity, {
        type: DEVICE_ENTRY_TYPE,
        groupID: group.groupID,
        subject: controllerID,
        value: { ...base, ...extra },
      })
      await expect(commitWithEntries(group, [], [token], { requireAdmin: false })).rejects.toThrow()
      expect(group.ledgerTokens).toEqual([])
      expect(group.registry.controllers.size).toBe(0)
    }
  })

  test.each(['clock', 'beacon'] as const)(
    'receiver rejects hidden history on %s despite an accepting caller policy',
    async (op) => {
      for (const extra of fields) {
        const { group, identity, tokens } = await lifecycleGroup()
        const recipient = agent(51)
        const members = await addMember(group, recipient, await bindingFor(recipient))
        const binding = members.group.bindingOfDID(identity.id)
        if (binding?.capability == null) throw new Error('Missing leaf capability')
        const base: DeviceValue =
          op === 'clock'
            ? {
                op,
                time: readCapability(binding.capability).payload.iat,
              }
            : { op, logLength: 2, headDigest: 'advisory' }
        const token = await signLedgerEntry(identity, {
          type: DEVICE_ENTRY_TYPE,
          groupID: group.groupID,
          subject: controllerID,
          value: { ...base, ...extra },
        })
        publish(tokens, [token])
        const message = await rawEnact(members.group, [token])
        const epoch = members.joined.epoch
        const registry = members.joined.registry
        await expect(members.joined.processMessage(message)).rejects.toThrow()
        expect(members.joined.epoch).toBe(epoch)
        expect(members.joined.registry).toBe(registry)
        expect(members.joined.ledgerTokens).toEqual([])
      }
    },
  )
})

function authorityRevoke(
  subject: string,
  prior: SignedEvent['event'] = inception.event,
  keyPosition = { gen: 0, seq: 0 },
) {
  return createRevoke({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    prior,
    target: subject,
    keyPosition,
  })
}

describe('attack: invalid lifecycle proofs keep their classifications', () => {
  const target = agent(61).id
  const firstSubject = agent(71).id
  const reset = createReset(controllerSeed, 0, 1)
  const oversized = createRotate({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    prior: inception.event,
    options: { seal: 'a'.repeat(393216) },
  })
  const rev = authorityRevoke(target)
  const skipped = {
    ...rev,
    event: { ...rev.event, t: 'future', crit: false },
    sigs: [],
  } as unknown as SignedEvent
  const foreign = createRevokeWithKey({
    privateKey: new Uint8Array(32).fill(61),
    did: controllerID,
    prior: inception.event,
    target,
  })
  const delegated = createRevokeWithKey({
    privateKey: new Uint8Array(32).fill(61),
    did: controllerID,
    prior: inception.event,
    target,
    cap: 'forged-grant',
  })
  const cases: Array<{
    attack: string
    reason: RevokeProofReason
    recorded?: boolean
    floor?: boolean
    proof: Array<SignedEvent>
    controller?: string
    revoked?: DeviceValue['revoked']
  }> = [
    { attack: 'missing revocation', reason: 'no-rev', proof: [inception] },
    { attack: 'empty proof', reason: 'no-rev', proof: [] },
    {
      attack: 'wrong controller',
      reason: 'wrong-controller',
      controller: 'did:kokuin:other',
      proof: [inception, authorityRevoke(target)],
    },
    {
      attack: 'detached suffix',
      reason: 'detached',
      recorded: true,
      proof: [authorityRevoke(target)],
    },
    {
      attack: 'unrecorded reset',
      reason: 'needs-reset',
      recorded: true,
      proof: [createReset(controllerSeed, 0, 1)],
    },
    {
      attack: 'missing authority signature',
      reason: 'not-authority-signed',
      proof: [inception, { ...authorityRevoke(target), sigs: [] }],
    },
    { attack: 'non-authority signer', reason: 'not-authority-signed', proof: [inception, foreign] },
    { attack: 'delegated revoke', reason: 'not-authority-signed', proof: [inception, delegated] },
    { attack: 'skipped event', reason: 'not-authority-signed', proof: [inception, skipped, rev] },
    {
      attack: 'pre-reset revocation',
      reason: 'generation-floor',
      floor: true,
      proof: [inception, rev],
    },
    {
      attack: 'over-horizon proof',
      reason: 'too-large',
      proof: [inception, oversized, authorityRevoke(target, oversized.event, { gen: 0, seq: 1 })],
    },
    {
      attack: 'forged effects',
      reason: 'effects-mismatch',
      proof: [inception, rev],
      revoked: [{ did: firstSubject }],
    },
  ]

  test.each(cases)(
    'author rejects $attack with $reason through commitWithEntries',
    async ({ reason, recorded, floor, proof, controller, revoked }) => {
      const setup = await lifecycleGroup(floor ? [inception, reset] : [inception])
      let group = setup.group
      if (floor) {
        const token = await signLedgerEntry(setup.identity, {
          type: DEVICE_ENTRY_TYPE,
          groupID: group.groupID,
          subject: controllerID,
          value: { op: 'reset', proof: [inception, reset], revoked: [] },
        })
        group = (await enact(group, [token])).group
      }
      if (recorded) {
        const first = await signLedgerEntry(setup.identity, {
          type: DEVICE_ENTRY_TYPE,
          groupID: group.groupID,
          subject: firstSubject,
          value: {
            op: 'revoke',
            proof: [inception, authorityRevoke(firstSubject)],
            revoked: [{ did: firstSubject }],
          },
        })
        group = (await enact(group, [first])).group
      }
      const token = await signLedgerEntry(setup.identity, {
        type: DEVICE_ENTRY_TYPE,
        groupID: group.groupID,
        subject: target,
        value: {
          op: 'revoke',
          proof,
          revoked: revoked ?? [{ did: target }],
          ...(controller == null ? {} : { controller }),
        },
      })
      const rejection = await commitWithEntries(group, [], [token], { requireAdmin: false }).catch(
        (error: unknown) => error,
      )
      expect(rejection).toBeInstanceOf(RevokeProofError)
      expect(rejection).toMatchObject({ reason })
    },
  )

  test.each(cases)(
    'receiver rejects $attack and retains $reason in the commit rejection cause',
    async ({ reason, recorded, floor, proof, controller, revoked }) => {
      const setup = await lifecycleGroup(floor ? [inception, reset] : [inception])
      const recipient = agent(51)
      const members = await addMember(
        setup.group,
        recipient,
        await bindingFor(recipient, floor ? [inception, reset] : [inception]),
      )
      let group = members.group
      if (floor) {
        const token = await signLedgerEntry(setup.identity, {
          type: DEVICE_ENTRY_TYPE,
          groupID: group.groupID,
          subject: controllerID,
          value: { op: 'reset', proof: [inception, reset], revoked: [] },
        })
        const accepted = await enact(group, [token])
        group = accepted.group
        publish(setup.tokens, [token])
        await members.joined.processMessage(accepted.message)
      }
      if (recorded) {
        const first = await signLedgerEntry(setup.identity, {
          type: DEVICE_ENTRY_TYPE,
          groupID: group.groupID,
          subject: firstSubject,
          value: {
            op: 'revoke',
            proof: [inception, authorityRevoke(firstSubject)],
            revoked: [{ did: firstSubject }],
          },
        })
        const accepted = await enact(group, [first])
        group = accepted.group
        publish(setup.tokens, [first])
        await members.joined.processMessage(accepted.message)
      }
      const token = await signLedgerEntry(setup.identity, {
        type: DEVICE_ENTRY_TYPE,
        groupID: group.groupID,
        subject: target,
        value: {
          op: 'revoke',
          proof,
          revoked: revoked ?? [{ did: target }],
          ...(controller == null ? {} : { controller }),
        },
      })
      publish(setup.tokens, [token])
      const message = await rawEnact(group, [token])
      const epoch = members.joined.epoch
      const rejection = await members.joined
        .processMessage(message)
        .catch((error: unknown) => error)
      expect(rejection).toBeInstanceOf(CommitRejectedError)
      if (!(rejection instanceof CommitRejectedError)) throw new Error('Expected commit rejection')
      expect(rejection.cause).toBeInstanceOf(RevokeProofError)
      expect(rejection.cause).toMatchObject({ reason })
      expect(members.joined.epoch).toBe(epoch)
    },
  )
})

describe('attack: reserved lifecycle entries', () => {
  test.each([ROLE_ENTRY_TYPE, 'kumiai.future'])(
    'author and receiver reject %s despite an accepting caller policy',
    async (type) => {
      const { group, identity, tokens } = await lifecycleGroup()
      const recipient = agent(51)
      const members = await addMember(group, recipient, await bindingFor(recipient))
      const token = await signLedgerEntry(identity, {
        type,
        groupID: group.groupID,
        subject: recipient.id,
        value: 'admin',
      })
      await expect(
        commitWithEntries(members.group, [], [token], { requireAdmin: false }),
      ).rejects.toThrow(/reserved/)
      publish(tokens, [token])
      const message = await rawEnact(members.group, [token])
      const epoch = members.joined.epoch
      await expect(members.joined.processMessage(message)).rejects.toThrow()
      expect(members.joined.epoch).toBe(epoch)
      expect(members.joined.roster.roles).toEqual(new Map([[controllerID, 'admin']]))
      expect(members.joined.ledgerTokens).toEqual([])
    },
  )
})
