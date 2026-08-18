import { createFullIdentity, normalizeDID, type OwnIdentity } from '@kokuin/token'
import {
  createCommit,
  defaultCredentialTypes,
  defaultProposalTypes,
  encode,
  mlsMessageEncoder,
} from 'ts-mls'
import { describe, expect, test } from 'vitest'

import { LEDGER_HEAD_EXTENSION_TYPE } from '../src/anchor.js'
import type { MLSCredentialIdentity } from '../src/credential.js'
import { encodeControlEnvelope } from '../src/envelope.js'
import { CommitRejectedError, createKeyPackageBundle } from '../src/group.js'
import { addDevice, registerDevice, revokeDevice } from '../src/group-device.js'
import { buildLedgerHeadExtension, extendHead, readLedgerHead } from '../src/head.js'
import { ledgerEntryDigest, signLedgerEntry } from '../src/ledger.js'
import { controllerOf, DEVICE_ENTRY_TYPE } from '../src/registry.js'
import { buildBoundLeaf } from './fixtures/bound-leaf.js'
import {
  buildBoundKeyPackageBundle,
  joinBoundDevice,
  publishTokens,
  twoDeviceProfileGroup,
} from './fixtures/device-harness.js'
import { buildManagementCapability } from './fixtures/management-capability.js'

describe('addDevice / revokeDevice', () => {
  test('addDevice brings a bound co-device into the group without an admin', async () => {
    const { managerGroup, targetDeviceID, controllerID } = await twoDeviceProfileGroup()
    expect(managerGroup.findMemberLeafIndex(targetDeviceID)).toBeTypeOf('number')
    expect(controllerOf(managerGroup.registry, targetDeviceID)).toBe(normalizeDID(controllerID))
  })

  test('revokeDevice removes the target leaf AND adds it to the deny set', async () => {
    const { managerGroup, managerIdentity, targetDeviceID, capability } =
      await twoDeviceProfileGroup()
    const before = managerGroup.findMemberLeafIndex(targetDeviceID)
    expect(before).toBeTypeOf('number')
    const { newGroup } = await revokeDevice(managerGroup, managerIdentity, {
      device: targetDeviceID,
      capability,
    })
    expect(newGroup.findMemberLeafIndex(targetDeviceID)).toBeUndefined()
    expect(newGroup.currentDenySet().has(normalizeDID(targetDeviceID))).toBe(true)
  })

  test('revokeDevice of a floating (leafless) device adds it to the deny set with no Remove', async () => {
    const { managerGroup, managerIdentity, controllerID, capability } =
      await twoDeviceProfileGroup()
    // Register a device that is NOT in the group, then revoke it.
    const floatDID = 'did:key:zFloatingDevice'
    const registered = await registerDevice(managerGroup, managerIdentity, {
      device: floatDID,
      controller: controllerID,
      capability,
    })
    const { newGroup } = await revokeDevice(registered.newGroup, managerIdentity, {
      device: floatDID,
      capability,
    })
    expect(newGroup.currentDenySet().has(normalizeDID(floatDID))).toBe(true)
  })
})

describe('registerDevice / labelDevice', () => {
  test("registerDevice (self) records the caller's own binding without admin", async () => {
    const { deviceGroup, deviceIdentity, deviceID, controllerID } = await joinBoundDevice()
    const { newGroup } = await registerDevice(deviceGroup, deviceIdentity, {
      device: deviceID,
      controller: controllerID,
    })
    expect(controllerOf(newGroup.registry, deviceID)).toBe(normalizeDID(controllerID))
  })
})

describe('deny seam', () => {
  test('revoke denies the target only from the NEXT epoch, while the revoke commit itself lands', async () => {
    // Pins the Slice-2 deny-timing invariant end to end through a real gated revoke commit (the
    // vacuous predecessor signed a token, never committed it, and asserted only `size === 0` on a
    // fresh group). Two facts a revoke must keep in exactly this order:
    //   (1) the deny is a NEXT-EPOCH effect — the target is not denied pre-commit, and the revoke
    //       commit's OWN validation did NOT deny the leaf it removed (else the Remove could not
    //       have landed): the commit succeeds AND the leaf is gone in newGroup;
    //   (2) the deny is deterministic across peers — a second member folding the same commit lands
    //       on the same deny set.
    const g = await twoDeviceProfileGroup()

    // Pre-commit: the target is a member in good standing, not yet denied.
    expect(g.managerGroup.findMemberLeafIndex(g.targetDeviceID)).toBeTypeOf('number')
    expect(g.managerGroup.currentDenySet().has(normalizeDID(g.targetDeviceID))).toBe(false)

    const res = await revokeDevice(g.managerGroup, g.managerIdentity, {
      device: g.targetDeviceID,
      capability: g.capability,
    })

    // (1) The revoke commit LANDED: the Remove applied (leaf gone from newGroup) even though the
    // device becomes denied only from the next epoch. The commit's own validation therefore did
    // not treat the removed leaf as already-denied — a deny that bit at commit time would have
    // had to reject its own Remove target's leaf.
    expect(res.newGroup.findMemberLeafIndex(g.targetDeviceID)).toBeUndefined()
    // ...and from that next epoch onward the device IS in the deny set.
    expect(res.newGroup.currentDenySet().has(normalizeDID(g.targetDeviceID))).toBe(true)

    // (2) A second existing member folds the same commit and reaches the same post-commit state:
    // the leaf is gone AND the device is denied — deny is deterministic across peers.
    publishTokens(g.tokens, res.newGroup)
    await g.creatorGroup.processMessage(res.commitMessage)
    expect(g.creatorGroup.findMemberLeafIndex(g.targetDeviceID)).toBeUndefined()
    expect(g.creatorGroup.currentDenySet().has(normalizeDID(g.targetDeviceID))).toBe(true)
  })

  test('a revoked device cannot re-authenticate on the bound path; a floating leaf is unaffected', async () => {
    // A second BOUND device of P (not the floating target twoDeviceProfileGroup builds), added
    // and then revoked, so the deny check inside validateBoundLeaf actually has something to bite:
    // a floating credential of the SAME DID never reaches that check at all (no `.controller`).
    const { deviceGroup, deviceIdentity, controllerID, creatorGroup, tokens } =
      await joinBoundDevice()
    const { capability } = await buildManagementCapability({
      managerDID: deviceIdentity.id,
      managerKey: deviceIdentity.publicKey,
    })

    const targetSeed = new Uint8Array(32).fill(53)
    const targetLeaf = await buildBoundLeaf({ deviceSeed: targetSeed })
    const targetBundle = await buildBoundKeyPackageBundle(targetLeaf, targetSeed)

    const { newGroup: added, commitMessage: addCommit } = await addDevice(
      deviceGroup,
      deviceIdentity,
      {
        keyPackage: targetBundle.publicPackage,
        device: targetLeaf.deviceID,
        controller: controllerID,
        capability,
      },
    )
    publishTokens(tokens, added)
    await creatorGroup.processMessage(addCommit)

    const { newGroup: revoked } = await revokeDevice(added, deviceIdentity, {
      device: targetLeaf.deviceID,
      capability,
    })

    const authService = revoked.context.authService
    const boundCredential = {
      credentialType: defaultCredentialTypes.basic,
      identity: targetLeaf.identity,
    }
    const floatingIdentity: MLSCredentialIdentity = { id: targetLeaf.deviceID }
    const floatingCredential = {
      credentialType: defaultCredentialTypes.basic,
      identity: new TextEncoder().encode(JSON.stringify(floatingIdentity)),
    }

    expect(await authService.validateCredential(boundCredential, targetLeaf.deviceKey)).toBe(false)
    expect(await authService.validateCredential(floatingCredential, targetLeaf.deviceKey)).toBe(
      true,
    )
  })
})

/**
 * The load-bearing coverage the committer-side tests above cannot give: every write's commit
 * must be ACCEPTED by a second existing member's real receive path (`processMessage`), not just
 * self-consistent on the authoring side. `defaultCommitPolicy` is an independent receive-side
 * gate — see the symmetric device carve-out in policy.ts (`evaluateProposal`'s `add`, `remove`,
 * and `group_context_extensions` cases).
 */
describe('receive-path acceptance (the symmetric device carve-out)', () => {
  test("registerDevice's commit is accepted by a second existing member", async () => {
    const { deviceGroup, deviceIdentity, deviceID, controllerID, creatorGroup, tokens } =
      await joinBoundDevice()
    const { commitMessage, newGroup } = await registerDevice(deviceGroup, deviceIdentity, {
      device: deviceID,
      controller: controllerID,
    })

    publishTokens(tokens, newGroup)
    await creatorGroup.processMessage(commitMessage)

    expect(controllerOf(creatorGroup.registry, deviceID)).toBe(normalizeDID(controllerID))
  })

  test("addDevice's commit is accepted by a second existing member", async () => {
    const { deviceGroup, deviceIdentity, deviceID, controllerID, creatorGroup, tokens } =
      await joinBoundDevice()
    const { capability } = await buildManagementCapability({
      managerDID: deviceID,
      managerKey: deviceIdentity.publicKey,
    })

    const targetSeed = new Uint8Array(32).fill(43)
    const targetIdentity: OwnIdentity = {
      ...createFullIdentity(targetSeed),
      privateKey: targetSeed,
    }
    const targetKeyPackageBundle = await createKeyPackageBundle(targetIdentity)

    const { commitMessage, newGroup } = await addDevice(deviceGroup, deviceIdentity, {
      keyPackage: targetKeyPackageBundle.publicPackage,
      device: targetIdentity.id,
      controller: controllerID,
      capability,
    })

    publishTokens(tokens, newGroup)
    await creatorGroup.processMessage(commitMessage)

    expect(creatorGroup.findMemberLeafIndex(targetIdentity.id)).toBeTypeOf('number')
    expect(controllerOf(creatorGroup.registry, targetIdentity.id)).toBe(normalizeDID(controllerID))
  })

  test("revokeDevice's commit is accepted by a second existing member", async () => {
    const { managerGroup, managerIdentity, targetDeviceID, capability, creatorGroup, tokens } =
      await twoDeviceProfileGroup()

    const { commitMessage, newGroup } = await revokeDevice(managerGroup, managerIdentity, {
      device: targetDeviceID,
      capability,
    })

    publishTokens(tokens, newGroup)
    await creatorGroup.processMessage(commitMessage)

    expect(creatorGroup.findMemberLeafIndex(targetDeviceID)).toBeUndefined()
    expect(creatorGroup.currentDenySet().has(normalizeDID(targetDeviceID))).toBe(true)
  })

  test('a commit carrying a device entry whose proof FAILS is rejected by an honest receiver', async () => {
    // GAP A: drive the RECEIVE-side device-proof gate — the loop in group-handle's commit
    // pipeline (#prepareCommitPipeline) that runs `verifyDeviceEntry` on every accepted device
    // entry and sets `precomputedReject` on any false. Every device-entry REJECTION test elsewhere
    // trips the symmetric AUTHOR gate in `commitWithEntries` (a thrown `/proof verification
    // failed/`), so that receive-side loop is otherwise exercised only by commits that PASS it —
    // deleting it would leave every other test green. It is the real defense against a peer who
    // patched out its own author gate.
    //
    // FEASIBILITY: no PUBLIC API produces a bad-but-committed device entry — registerDevice /
    // addDevice / revokeDevice / labelDevice / announceControllerBeacon / commitLedgerEntries all
    // route through `commitWithEntries`, which runs the author gate before a commit is ever
    // produced. So we take the honest LOWER-LEVEL route the malicious peer would: build the commit
    // directly with ts-mls `createCommit`, attaching the same control envelope + head-move
    // `commitWithEntries` attaches, but WITHOUT the author gate. `foldEnvelope` applies a
    // kumiai.device entry structurally (authorization-free — proofs are the pipeline's job), so the
    // forged entry folds and reaches the receiver's `verifyDeviceEntry` loop, which must reject.
    const g = await twoDeviceProfileGroup()

    // The manager (a bound device of profile P) forges a `register` binding a brand-new device to a
    // FOREIGN controller Q it is not a device of. verifyDeviceEntry (register, subject !== issuer):
    // authorizedProfile = Q, but bindingOfDID(manager).controller = P !== Q ⇒ false. The author
    // gate would throw on this; here we bypass it and hand the commit to an honest receiver.
    const foreignController = 'did:kokuin:profileQ'
    const forgedSubject = 'did:key:zForgedForeignDevice'
    const token = await signLedgerEntry(g.managerIdentity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: g.managerGroup.groupID,
      subject: forgedSubject,
      value: { op: 'register', controller: foreignController, capability: g.capability },
    })
    const entryID = ledgerEntryDigest(token)

    // Reproduce `extensionsWithHead`: the current extension list with only the ledger-head entry
    // advanced by this envelope's id — exactly what a genuine device commit installs, so the
    // head-move itself is valid and cannot be the reason the receiver rejects.
    const currentHead = readLedgerHead(g.managerGroup)
    if (currentHead == null) throw new Error('test setup: manager group has no ledger head')
    const nextHead = buildLedgerHeadExtension(extendHead(currentHead.head, [entryID]))
    const extensions = g.managerGroup.state.groupContext.extensions.map((ext) =>
      ext.extensionType === LEDGER_HEAD_EXTENSION_TYPE ? nextHead : ext,
    )

    const crafted = await createCommit({
      context: g.managerGroup.context,
      state: g.managerGroup.state,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.group_context_extensions,
          groupContextExtensions: { extensions },
        },
      ],
      authenticatedData: encodeControlEnvelope({ v: 1, entries: [entryID] }),
    })
    const craftedCommit = encode(mlsMessageEncoder, crafted.commit)

    // Make the forged entry resolvable to the receiver (its own envelope names the id; the body is
    // published exactly as a genuine write would publish it), then feed it to an honest member.
    g.tokens.set(entryID, token)
    const epochBefore = g.creatorGroup.epoch
    await expect(g.creatorGroup.processMessage(craftedCommit)).rejects.toThrow(CommitRejectedError)
    // Nothing applied: the epoch did not advance and the forged binding never entered the registry.
    expect(g.creatorGroup.epoch).toBe(epochBefore)
    expect(controllerOf(g.creatorGroup.registry, forgedSubject)).toBeUndefined()
    // RED: this commit carries ONLY the head-move (device-only ⇒ enactsOnlyDeviceEntries), whose
    // group-context-extensions rule accepts a correct head-move without an admin sender. So with
    // the receive-side verifyDeviceEntry loop removed, precomputedReject stays false and
    // defaultCommitPolicy ACCEPTS this commit — the loop is the sole gate this test pins.
  })

  test('a non-device, non-admin commit is still rejected on receive', async () => {
    // Negative guard: the carve-out must not loosen the general admin rule. The manager device is
    // a plain (non-admin) member; removing the target leaf with NO kumiai.device entry at all —
    // no envelope, nothing for verifyDeviceEntry to have authorized upstream — must still reject.
    // This proves the carve-out fires only on a matching enacted device entry, never structurally
    // for any commit a non-admin device happens to author.
    const { managerGroup, targetDeviceID, creatorGroup } = await twoDeviceProfileGroup()
    const targetLeaf = managerGroup.findMemberLeafIndex(targetDeviceID)
    expect(targetLeaf).toBeTypeOf('number')

    const result = await createCommit({
      context: managerGroup.context,
      state: managerGroup.state,
      extraProposals: [
        { proposalType: defaultProposalTypes.remove, remove: { removed: targetLeaf as number } },
      ],
    })
    const bareRemoveCommit = encode(mlsMessageEncoder, result.commit)

    const epochBefore = creatorGroup.epoch
    await expect(creatorGroup.processMessage(bareRemoveCommit)).rejects.toThrow(CommitRejectedError)
    expect(creatorGroup.epoch).toBe(epochBefore)
    expect(creatorGroup.findMemberLeafIndex(targetDeviceID)).toBeTypeOf('number')
  })
})
