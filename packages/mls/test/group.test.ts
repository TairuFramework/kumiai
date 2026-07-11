import { createIdentity, normalizeDID, randomIdentity } from '@kokuin/token'
import {
  createCommit,
  decode,
  defaultProposalTypes,
  encode,
  type GroupContextExtension,
  joinGroupExternal as mlsJoinGroupExternal,
  mlsMessageDecoder,
  mlsMessageEncoder,
  type NodeLeaf,
  nodeTypes,
  protocolVersions,
  wireformats,
} from 'ts-mls'
import { describe, expect, it, test } from 'vitest'

import {
  GROUP_ANCHOR_EXTENSION_TYPE,
  LEDGER_HEAD_EXTENSION_TYPE,
  readGroupAnchor,
  readGroupAnchorExtension,
} from '../src/anchor.js'
import { encodeControlEnvelope } from '../src/envelope.js'
import {
  CommitRejectedError,
  commitInvite,
  commitLedgerEntries,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  exportGroupInfo,
  type GroupHandle,
  joinGroupExternal,
  processWelcome,
  readMessageEpoch,
  removeMember,
  restoreGroup,
} from '../src/group.js'
import {
  buildLedgerHeadExtension,
  computeHead,
  extendHead,
  LedgerIncompleteError,
  readLedgerHead,
} from '../src/head.js'
import { ledgerEntryDigest, signLedgerEntry, type VerifiedLedgerEntry } from '../src/ledger.js'
import { MissingLedgerEntriesError } from '../src/policy.js'
import { ROLE_ENTRY_TYPE } from '../src/roster.js'
import type { GroupOptions, Invite } from '../src/types.js'

/** Serve an invite's signed ledger tokens to a receiver's resolver. */
function publishInvite(tokens: Map<string, string>, invite: Invite): void {
  for (const token of invite.ledgerEntries) {
    tokens.set(ledgerEntryDigest(token), token)
  }
}

/** The invite's role entry naming the invitee: the group's ledger with that entry appended. */
function roleToken(invite: Invite): string {
  const token = invite.ledgerEntries.at(-1)
  if (token == null) throw new Error('expected the invite to carry a role entry')
  return token
}

describe('GroupHandle lifecycle', () => {
  test('creates a group with single member', async () => {
    const alice = randomIdentity()
    const { group, credential } = await createGroup(alice, 'test-group-1')

    expect(group.groupID).toBe('test-group-1')
    expect(group.epoch).toBe(0n)
    expect(group.memberCount).toBe(1)
    expect(credential.id).toBe(alice.id)
    expect(credential.groupID).toBe('test-group-1')
  })

  test('invites and adds a member', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const { group: aliceGroup } = await createGroup(alice, 'invite-group')

    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    expect(invite.groupID).toBe('invite-group')
    expect(invite.inviterID).toBe(alice.id)

    const bobKeyBundle = await createKeyPackageBundle(bob)
    const { welcomeMessage, newGroup: updatedAliceGroup } = await commitInvite(
      aliceGroup,
      bobKeyBundle.publicPackage,
      invite,
    )

    expect(updatedAliceGroup.epoch).toBe(1n)
    expect(updatedAliceGroup.memberCount).toBe(2)
    expect(welcomeMessage).toBeDefined()

    const { group: bobGroup, credential: bobCred } = await processWelcome({
      identity: bob,
      invite,
      welcome: welcomeMessage,
      keyPackageBundle: bobKeyBundle,
      ratchetTree: updatedAliceGroup.state.ratchetTree,
    })

    expect(bobGroup.epoch).toBe(1n)
    expect(bobGroup.memberCount).toBe(2)
    expect(bobCred.id).toBe(bob.id)
  })

  test('encrypts and decrypts messages between members', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const { group: aliceGroup } = await createGroup(alice, 'msg-group')
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKeyBundle = await createKeyPackageBundle(bob)
    const { welcomeMessage, newGroup: updatedAliceGroup } = await commitInvite(
      aliceGroup,
      bobKeyBundle.publicPackage,
      invite,
    )
    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite,
      welcome: welcomeMessage,
      keyPackageBundle: bobKeyBundle,
      ratchetTree: updatedAliceGroup.state.ratchetTree,
    })

    // Alice sends to Bob
    const { message } = await updatedAliceGroup.encrypt(new TextEncoder().encode('hello bob'))
    const decrypted = await bobGroup.decrypt(message)
    expect(new TextDecoder().decode(decrypted)).toBe('hello bob')

    // Bob sends to Alice
    const { message: replyMsg } = await bobGroup.encrypt(new TextEncoder().encode('hello alice'))
    const decryptedReply = await updatedAliceGroup.decrypt(replyMsg)
    expect(new TextDecoder().decode(decryptedReply)).toBe('hello alice')
  })

  test('removes a member with forward secrecy', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const { group: aliceGroup } = await createGroup(alice, 'remove-group')
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKeyBundle = await createKeyPackageBundle(bob)
    const { welcomeMessage, newGroup: groupWithBob } = await commitInvite(
      aliceGroup,
      bobKeyBundle.publicPackage,
      invite,
    )
    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite,
      welcome: welcomeMessage,
      keyPackageBundle: bobKeyBundle,
      ratchetTree: groupWithBob.state.ratchetTree,
    })

    const { newGroup: groupAfterRemoval } = await removeMember(groupWithBob, 1)
    expect(groupAfterRemoval.epoch).toBe(2n)
    expect(groupAfterRemoval.memberCount).toBe(1)

    const { message: secretMsg } = await groupAfterRemoval.encrypt(
      new TextEncoder().encode('secret'),
    )
    await expect(bobGroup.decrypt(secretMsg)).rejects.toThrow()
  })

  test('add device (self-invite)', async () => {
    const alice = randomIdentity()
    const aliceDevice2 = randomIdentity()

    const { group } = await createGroup(alice, 'alice-devices')
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: aliceDevice2.id,
      permission: 'admin',
    })
    const device2KeyBundle = await createKeyPackageBundle(aliceDevice2)
    const { welcomeMessage, newGroup: updatedGroup } = await commitInvite(
      group,
      device2KeyBundle.publicPackage,
      invite,
    )

    const { group: device2Group } = await processWelcome({
      identity: aliceDevice2,
      invite,
      welcome: welcomeMessage,
      keyPackageBundle: device2KeyBundle,
      ratchetTree: updatedGroup.state.ratchetTree,
    })

    const { message } = await updatedGroup.encrypt(new TextEncoder().encode('sync data'))
    const data = await device2Group.decrypt(message)
    expect(new TextDecoder().decode(data)).toBe('sync data')
  })

  test('three-member group with fan-out', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const charlie = randomIdentity()

    const { group: aliceGroup } = await createGroup(alice, '3-member')

    const { invite: bobInvite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const { welcomeMessage: bobWelcome, newGroup: groupWithBob } = await commitInvite(
      aliceGroup,
      bobKP.publicPackage,
      bobInvite,
    )
    await processWelcome({
      identity: bob,
      invite: bobInvite,
      welcome: bobWelcome,
      keyPackageBundle: bobKP,
      ratchetTree: groupWithBob.state.ratchetTree,
    })

    const { invite: charlieInvite } = await createInvite({
      group: groupWithBob,
      identity: alice,
      recipientDID: charlie.id,
      permission: 'member',
    })
    const charlieKP = await createKeyPackageBundle(charlie)
    const { welcomeMessage: charlieWelcome, newGroup: groupWith3 } = await commitInvite(
      groupWithBob,
      charlieKP.publicPackage,
      charlieInvite,
    )
    const { group: charlieGroup } = await processWelcome({
      identity: charlie,
      invite: charlieInvite,
      welcome: charlieWelcome,
      keyPackageBundle: charlieKP,
      ratchetTree: groupWith3.state.ratchetTree,
    })

    expect(groupWith3.memberCount).toBe(3)
    expect(charlieGroup.memberCount).toBe(3)
    expect(groupWith3.epoch).toBe(2n)

    const { message } = await groupWith3.encrypt(new TextEncoder().encode('hello everyone'))
    const decrypted = await charlieGroup.decrypt(message)
    expect(new TextDecoder().decode(decrypted)).toBe('hello everyone')
  })

  test('multi-epoch message exchange', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const { group: aliceGroup } = await createGroup(alice, 'epoch-test')
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const { welcomeMessage, newGroup: epoch1Group } = await commitInvite(
      aliceGroup,
      bobKP.publicPackage,
      invite,
    )
    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite,
      welcome: welcomeMessage,
      keyPackageBundle: bobKP,
      ratchetTree: epoch1Group.state.ratchetTree,
    })

    const { message: msg1 } = await epoch1Group.encrypt(new TextEncoder().encode('epoch-1-msg'))
    expect(new TextDecoder().decode(await bobGroup.decrypt(msg1))).toBe('epoch-1-msg')

    const charlie = randomIdentity()
    const { invite: charlieInvite } = await createInvite({
      group: epoch1Group,
      identity: alice,
      recipientDID: charlie.id,
      permission: 'member',
    })
    const charlieKP = await createKeyPackageBundle(charlie)
    const { newGroup: epoch2Group } = await commitInvite(
      epoch1Group,
      charlieKP.publicPackage,
      charlieInvite,
    )
    expect(epoch2Group.epoch).toBe(2n)

    const { message: msg2 } = await epoch2Group.encrypt(new TextEncoder().encode('epoch-2-msg'))
    await expect(bobGroup.decrypt(msg2)).rejects.toThrow()
  })

  test('commitInvite returns wire bytes + epoch; receiver joins and processes via bytes', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const charlie = randomIdentity()

    const tokens = new Map<string, string>()
    const { group: aliceGroup } = await createGroup(alice, 'wire-add')
    const { invite: bobInvite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const addBob = await commitInvite(aliceGroup, bobKP.publicPackage, bobInvite)

    // Wire-ready bytes + epoch contract.
    expect(addBob.commitMessage).toBeInstanceOf(Uint8Array)
    expect(addBob.welcomeMessage).toBeInstanceOf(Uint8Array)
    expect(addBob.epoch).toBe(addBob.newGroup.epoch)
    expect(addBob.epoch).toBe(1n)

    // Bytes decode back to framed MLSMessages of the expected wireformat.
    const decodedCommit = decode(mlsMessageDecoder, addBob.commitMessage)
    expect(decodedCommit?.wireformat).toBe(wireformats.mls_private_message)
    const decodedWelcome = decode(mlsMessageDecoder, addBob.welcomeMessage)
    expect(decodedWelcome?.wireformat).toBe(wireformats.mls_welcome)

    // Bob joins using welcome BYTES (processWelcome decode path).
    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite: bobInvite,
      welcome: addBob.welcomeMessage,
      keyPackageBundle: bobKP,
      ratchetTree: addBob.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries: mapResolver(tokens) },
    })
    expect(bobGroup.epoch).toBe(1n)

    // Alice adds Charlie; Bob applies the add commit as BYTES (processMessage decode path).
    const { invite: charlieInvite } = await createInvite({
      group: addBob.newGroup,
      identity: alice,
      recipientDID: charlie.id,
      permission: 'member',
    })
    publishInvite(tokens, charlieInvite)
    const charlieKP = await createKeyPackageBundle(charlie)
    const addCharlie = await commitInvite(addBob.newGroup, charlieKP.publicPackage, charlieInvite)
    expect(addCharlie.commitMessage).toBeInstanceOf(Uint8Array)

    await bobGroup.processMessage(addCharlie.commitMessage)
    expect(bobGroup.epoch).toBe(2n)
    expect(bobGroup.findMemberLeafIndex(charlie.id)).toBeDefined()
  })

  test('removeMember returns commit bytes + epoch; receiver applies via bytes', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const charlie = randomIdentity()

    // alice + bob + charlie group, with bob joined so he can receive the remove commit.
    const tokens = new Map<string, string>()
    const { group: aliceGroup } = await createGroup(alice, 'wire-remove')
    const { invite: bobInvite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const addBob = await commitInvite(aliceGroup, bobKP.publicPackage, bobInvite)
    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite: bobInvite,
      welcome: addBob.welcomeMessage,
      keyPackageBundle: bobKP,
      ratchetTree: addBob.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries: mapResolver(tokens) },
    })

    const { invite: charlieInvite } = await createInvite({
      group: addBob.newGroup,
      identity: alice,
      recipientDID: charlie.id,
      permission: 'member',
    })
    publishInvite(tokens, charlieInvite)
    const charlieKP = await createKeyPackageBundle(charlie)
    const addCharlie = await commitInvite(addBob.newGroup, charlieKP.publicPackage, charlieInvite)
    await bobGroup.processMessage(addCharlie.commitMessage)

    const charlieLeaf = addCharlie.newGroup.findMemberLeafIndex(charlie.id)
    expect(charlieLeaf).toBeDefined()
    const removeRes = await removeMember(addCharlie.newGroup, charlieLeaf as number)

    expect(removeRes.commitMessage).toBeInstanceOf(Uint8Array)
    expect(removeRes.epoch).toBe(removeRes.newGroup.epoch)
    expect(removeRes.epoch).toBe(3n) // addBob (1) + addCharlie (2) + remove (3)
    const decoded = decode(mlsMessageDecoder, removeRes.commitMessage)
    expect(decoded?.wireformat).toBe(wireformats.mls_private_message)

    await bobGroup.processMessage(removeRes.commitMessage)
    expect(bobGroup.epoch).toBe(3n)
    expect(bobGroup.findMemberLeafIndex(charlie.id)).toBeUndefined()
  })

  test('processWelcome rejects an invite whose role entry is signed by a non-admin', async () => {
    // The join is authorized by the ledger, not by who hands over the invite. A role
    // entry not issued by an admin is dead paper: it can never ride a real commit, so
    // it never enters the authenticated ledger head, and the roster fold drops it. An
    // invite carrying such an entry cannot reproduce the head the Welcome's GroupContext
    // commits to, so processWelcome refuses the join.
    const alice = randomIdentity()
    const bob = randomIdentity()
    const mallory = randomIdentity()

    const { group: aliceGroup } = await createGroup(alice, 'nonadmin-invite')
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const { welcomeMessage, newGroup } = await commitInvite(aliceGroup, bobKP.publicPackage, invite)

    // Mallory (never an admin) forges a role entry granting Bob membership and swaps
    // it in for the admin-signed entry the real invite carried.
    const forgedRole = await signLedgerEntry(mallory, {
      type: ROLE_ENTRY_TYPE,
      groupID: 'nonadmin-invite',
      subject: bob.id,
      value: 'member',
    })
    const forgedInvite: Invite = {
      groupID: 'nonadmin-invite',
      inviterID: mallory.id,
      ledgerEntries: [forgedRole],
    }

    await expect(
      processWelcome({
        identity: bob,
        invite: forgedInvite,
        welcome: welcomeMessage,
        keyPackageBundle: bobKP,
        ratchetTree: newGroup.state.ratchetTree,
      }),
    ).rejects.toThrow()
  })

  test('readMessageEpoch reads the handshake epoch from commit bytes', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const { group: aliceGroup } = await createGroup(alice, 'peek-epoch')
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const addBob = await commitInvite(aliceGroup, bobKP.publicPackage, invite)

    // A Commit is FRAMED at the sender's epoch BEFORE it advances the group
    // (RFC 9420 FramedContent.epoch). So the header epoch readMessageEpoch
    // returns is the pre-commit / sending epoch (== result.epoch - 1n) — which
    // is exactly the epoch a receiver must be at to process it, i.e. the value
    // to compare against handle.epoch for drop/buffer ordering. It is NOT the
    // post-commit newGroup.epoch carried in result.epoch.
    expect(addBob.epoch).toBe(1n)
    expect(readMessageEpoch(addBob.commitMessage)).toBe(0n)
    expect(readMessageEpoch(addBob.commitMessage)).toBe(addBob.epoch - 1n)

    const bobLeaf = addBob.newGroup.findMemberLeafIndex(bob.id)
    const removeRes = await removeMember(addBob.newGroup, bobLeaf as number)
    expect(readMessageEpoch(removeRes.commitMessage)).toBe(removeRes.epoch - 1n)

    // Garbage / non-message bytes yield undefined, not a throw.
    expect(readMessageEpoch(new Uint8Array([0, 1, 2, 3]))).toBeUndefined()

    // Oversized input makes ts-mls decode throw (CodecError, >64M bytes); the
    // advisory helper must still return undefined, never throw — it pre-filters
    // bytes from an untrusted Delivery Service.
    expect(readMessageEpoch(new Uint8Array(64_000_001))).toBeUndefined()
  })

  test('processMessage rejects a stale commit (bytes form) on a receiver past that epoch', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const charlie = randomIdentity()

    const tokens = new Map<string, string>()
    const { group: aliceGroup } = await createGroup(alice, 'wire-stale')
    const { invite: bobInvite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const addBob = await commitInvite(aliceGroup, bobKP.publicPackage, bobInvite)
    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite: bobInvite,
      welcome: addBob.welcomeMessage,
      keyPackageBundle: bobKP,
      ratchetTree: addBob.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries: mapResolver(tokens) },
    })

    // Alice produces an add commit advancing epoch 1->2 (the "stale" one Bob applies first).
    const { invite: charlieInvite } = await createInvite({
      group: addBob.newGroup,
      identity: alice,
      recipientDID: charlie.id,
      permission: 'member',
    })
    publishInvite(tokens, charlieInvite)
    const charlieKP = await createKeyPackageBundle(charlie)
    const addCharlie = await commitInvite(addBob.newGroup, charlieKP.publicPackage, charlieInvite)

    // Bob applies it, advancing to epoch 2.
    await bobGroup.processMessage(addCharlie.commitMessage)
    expect(bobGroup.epoch).toBe(2n)

    // Re-applying the same epoch-1->2 commit bytes must be rejected (Bob is now at epoch 2).
    await expect(bobGroup.processMessage(addCharlie.commitMessage)).rejects.toThrow()
  })
})

// Simulate JSON roundtrip effect: undefined array entries become null.
// In practice this happens when ratchet trees are transported as JSON between
describe('ratchet tree extension', () => {
  test('processWelcome joins without ratchetTree param (tree embedded in Welcome)', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const { group: aliceGroup } = await createGroup(alice, 'ext-join')
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const { welcomeMessage, newGroup: updatedAlice } = await commitInvite(
      aliceGroup,
      bobKP.publicPackage,
      invite,
    )

    // No ratchetTree param — tree comes from the Welcome message
    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite,
      welcome: welcomeMessage,
      keyPackageBundle: bobKP,
    })

    expect(bobGroup.memberCount).toBe(2)

    const { message } = await updatedAlice.encrypt(new TextEncoder().encode('no tree needed'))
    const decrypted = await bobGroup.decrypt(message)
    expect(new TextDecoder().decode(decrypted)).toBe('no tree needed')
  })

  test('3-member join without ratchetTree param', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const charlie = randomIdentity()

    const { group: g1 } = await createGroup(alice, 'ext-3m')

    const { invite: bobInvite } = await createInvite({
      group: g1,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const { welcomeMessage: bobWelcome, newGroup: g2 } = await commitInvite(
      g1,
      bobKP.publicPackage,
      bobInvite,
    )
    await processWelcome({
      identity: bob,
      invite: bobInvite,
      welcome: bobWelcome,
      keyPackageBundle: bobKP,
    })

    const { invite: charlieInvite } = await createInvite({
      group: g2,
      identity: alice,
      recipientDID: charlie.id,
      permission: 'member',
    })
    const charlieKP = await createKeyPackageBundle(charlie)
    const { welcomeMessage: charlieWelcome, newGroup: g3 } = await commitInvite(
      g2,
      charlieKP.publicPackage,
      charlieInvite,
    )
    const { group: charlieGroup } = await processWelcome({
      identity: charlie,
      invite: charlieInvite,
      welcome: charlieWelcome,
      keyPackageBundle: charlieKP,
    })

    expect(g3.memberCount).toBe(3)
    expect(charlieGroup.memberCount).toBe(3)

    const { message } = await g3.encrypt(new TextEncoder().encode('extension works'))
    const decrypted = await charlieGroup.decrypt(message)
    expect(new TextDecoder().decode(decrypted)).toBe('extension works')
  })
})

// Simulate JSON roundtrip effect: undefined array entries become null.
// In practice this happens when ratchet trees are transported as JSON between
// peers (e.g. Kubun's invite payloads use JSON.stringify with a custom replacer
// that handles Uint8Array/BigInt but not undefined array entries).
function nullifyTree(tree: ReadonlyArray<unknown>): Array<unknown> {
  return tree.map((entry) => (entry === undefined ? null : entry))
}

describe('JSON serialization null safety', () => {
  test('processWelcome joins and exchanges messages with nullified 2-member tree', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const { group: aliceGroup } = await createGroup(alice, 'null-2m')
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const { welcomeMessage, newGroup: updatedAlice } = await commitInvite(
      aliceGroup,
      bobKP.publicPackage,
      invite,
    )

    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite,
      welcome: welcomeMessage,
      keyPackageBundle: bobKP,
      ratchetTree: nullifyTree(updatedAlice.state.ratchetTree),
    })

    expect(bobGroup.memberCount).toBe(2)

    // Verify full participation — not just memberCount
    const { message } = await updatedAlice.encrypt(new TextEncoder().encode('hello bob'))
    const decrypted = await bobGroup.decrypt(message)
    expect(new TextDecoder().decode(decrypted)).toBe('hello bob')
  })

  test('processWelcome joins 3-member group with nullified tree', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const charlie = randomIdentity()

    const { group: aliceGroup } = await createGroup(alice, 'null-3m')

    // Add Bob normally
    const { invite: bobInvite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const { welcomeMessage: bobWelcome, newGroup: groupWithBob } = await commitInvite(
      aliceGroup,
      bobKP.publicPackage,
      bobInvite,
    )
    await processWelcome({
      identity: bob,
      invite: bobInvite,
      welcome: bobWelcome,
      keyPackageBundle: bobKP,
      ratchetTree: groupWithBob.state.ratchetTree,
    })

    // Add Charlie with nullified tree — tree has blank parent nodes
    const { invite: charlieInvite } = await createInvite({
      group: groupWithBob,
      identity: alice,
      recipientDID: charlie.id,
      permission: 'member',
    })
    const charlieKP = await createKeyPackageBundle(charlie)
    const { welcomeMessage: charlieWelcome, newGroup: groupWith3 } = await commitInvite(
      groupWithBob,
      charlieKP.publicPackage,
      charlieInvite,
    )

    const nullified = nullifyTree(groupWith3.state.ratchetTree)
    // Verify the tree actually has null entries (blank parent nodes)
    expect(nullified.some((entry) => entry === null)).toBe(true)

    const { group: charlieGroup } = await processWelcome({
      identity: charlie,
      invite: charlieInvite,
      welcome: charlieWelcome,
      keyPackageBundle: charlieKP,
      ratchetTree: nullified,
    })

    expect(charlieGroup.memberCount).toBe(3)

    const { message } = await groupWith3.encrypt(new TextEncoder().encode('to charlie'))
    const decrypted = await charlieGroup.decrypt(message)
    expect(new TextDecoder().decode(decrypted)).toBe('to charlie')
  })

  test('processWelcome joins after member removal with nullified tree', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const charlie = randomIdentity()
    const dave = randomIdentity()

    const { group: g1 } = await createGroup(alice, 'null-remove')

    // Add Bob
    const { invite: bobInvite } = await createInvite({
      group: g1,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const { welcomeMessage: bobWelcome, newGroup: g2 } = await commitInvite(
      g1,
      bobKP.publicPackage,
      bobInvite,
    )
    await processWelcome({
      identity: bob,
      invite: bobInvite,
      welcome: bobWelcome,
      keyPackageBundle: bobKP,
      ratchetTree: g2.state.ratchetTree,
    })

    // Add Charlie
    const { invite: charlieInvite } = await createInvite({
      group: g2,
      identity: alice,
      recipientDID: charlie.id,
      permission: 'member',
    })
    const charlieKP = await createKeyPackageBundle(charlie)
    const { newGroup: g3 } = await commitInvite(g2, charlieKP.publicPackage, charlieInvite)

    // Remove Bob — creates blank leaf node in tree
    const { newGroup: g4 } = await removeMember(g3, 1)
    expect(g4.memberCount).toBe(2)

    // Invite Dave — tree now has both blank leaf (from removal) and blank parents
    const { invite: daveInvite } = await createInvite({
      group: g4,
      identity: alice,
      recipientDID: dave.id,
      permission: 'member',
    })
    const daveKP = await createKeyPackageBundle(dave)
    const { welcomeMessage: daveWelcome, newGroup: g5 } = await commitInvite(
      g4,
      daveKP.publicPackage,
      daveInvite,
    )

    const nullified = nullifyTree(g5.state.ratchetTree)
    expect(nullified.some((entry) => entry === null)).toBe(true)

    const { group: daveGroup } = await processWelcome({
      identity: dave,
      invite: daveInvite,
      welcome: daveWelcome,
      keyPackageBundle: daveKP,
      ratchetTree: nullified,
    })

    expect(daveGroup.memberCount).toBe(3)

    const { message } = await g5.encrypt(new TextEncoder().encode('welcome dave'))
    const decrypted = await daveGroup.decrypt(message)
    expect(new TextDecoder().decode(decrypted)).toBe('welcome dave')
  })

  test('findMemberLeafIndex works with nullified tree entries', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const { group: aliceGroup } = await createGroup(alice, 'null-find')
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const { welcomeMessage, newGroup: updatedAlice } = await commitInvite(
      aliceGroup,
      bobKP.publicPackage,
      invite,
    )

    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite,
      welcome: welcomeMessage,
      keyPackageBundle: bobKP,
      ratchetTree: nullifyTree(updatedAlice.state.ratchetTree),
    })

    // findMemberLeafIndex should work on the joined group
    // (its internal tree was built by ts-mls from the sanitized input)
    expect(bobGroup.findMemberLeafIndex(bob.id)).toBe(1)
    expect(bobGroup.findMemberLeafIndex(alice.id)).toBe(0)
    expect(bobGroup.findMemberLeafIndex('did:key:unknown')).toBeUndefined()
  })
})

describe('GroupHandle.listMembers', () => {
  test('enumerates all members in ascending leaf-index order', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const charlie = randomIdentity()

    const { group: aliceGroup } = await createGroup(alice, 'list-members')

    const { invite: bobInvite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const { newGroup: groupWithBob } = await commitInvite(
      aliceGroup,
      bobKP.publicPackage,
      bobInvite,
    )

    const { invite: charlieInvite } = await createInvite({
      group: groupWithBob,
      identity: alice,
      recipientDID: charlie.id,
      permission: 'member',
    })
    const charlieKP = await createKeyPackageBundle(charlie)
    const { newGroup: groupWith3 } = await commitInvite(
      groupWithBob,
      charlieKP.publicPackage,
      charlieInvite,
    )

    const members = groupWith3.listMembers()
    expect(members).toHaveLength(3)
    expect(members.map((m) => m.leafIndex)).toEqual([0, 1, 2])
    const ids = members.map((m) => m.id)
    expect(ids).toContain(alice.id)
    expect(ids).toContain(bob.id)
    expect(ids).toContain(charlie.id)
    for (const member of members) {
      expect(groupWith3.findMemberLeafIndex(member.id)).toBe(member.leafIndex)
    }
  })

  test('reflects add and remove after processMessage on the receiver', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const charlie = randomIdentity()

    // Alice creates, adds Bob. Bob joins via Welcome.
    const tokens = new Map<string, string>()
    const { group: aliceGroup } = await createGroup(alice, 'diff-group')
    const { invite: bobInvite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const { welcomeMessage: bobWelcome, newGroup: aliceWithBob } = await commitInvite(
      aliceGroup,
      bobKP.publicPackage,
      bobInvite,
    )
    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite: bobInvite,
      welcome: bobWelcome,
      keyPackageBundle: bobKP,
      ratchetTree: aliceWithBob.state.ratchetTree,
      options: { resolveLedgerEntries: mapResolver(tokens) },
    })

    // --- ADD: Alice adds Charlie ONCE; Bob receives that same commit and diffs.
    // Alice and Bob must advance along the SAME commit chain, so the add commit
    // Bob processes is the one that produced Alice's aliceWith3 handle.
    const { invite: charlieInvite } = await createInvite({
      group: aliceWithBob,
      identity: alice,
      recipientDID: charlie.id,
      permission: 'member',
    })
    publishInvite(tokens, charlieInvite)
    const charlieKP = await createKeyPackageBundle(charlie)
    const { commitMessage: addCommit, newGroup: aliceWith3 } = await commitInvite(
      aliceWithBob,
      charlieKP.publicPackage,
      charlieInvite,
    )

    const beforeAdd = new Set(bobGroup.listMembers().map((m) => m.id))
    await bobGroup.processMessage(addCommit)
    const afterAdd = new Set(bobGroup.listMembers().map((m) => m.id))
    const added = [...afterAdd].filter((id) => !beforeAdd.has(id))
    expect(added).toEqual([charlie.id])

    // --- REMOVE: Alice removes Charlie from her epoch-2 handle (same chain Bob
    // is now on); Bob receives that commit and diffs.
    const charlieLeaf = aliceWith3.findMemberLeafIndex(charlie.id)
    expect(charlieLeaf).toBeDefined()
    const { commitMessage: removeCommit } = await removeMember(aliceWith3, charlieLeaf as number)

    const beforeRemove = new Set(bobGroup.listMembers().map((m) => m.id))
    await bobGroup.processMessage(removeCommit)
    const afterRemove = new Set(bobGroup.listMembers().map((m) => m.id))
    const removed = [...beforeRemove].filter((id) => !afterRemove.has(id))
    expect(removed).toEqual([charlie.id])
  })

  test('skips a leaf whose credential identity fails to parse', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const { group: aliceGroup } = await createGroup(alice, 'garbage-leaf')
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const { newGroup: groupWithBob } = await commitInvite(aliceGroup, bobKP.publicPackage, invite)

    expect(groupWithBob.listMembers()).toHaveLength(2)

    // Corrupt one leaf's credential identity to non-JSON bytes.
    const tree = groupWithBob.state.ratchetTree
    const leaf = tree.find((node) => node != null && node.nodeType === nodeTypes.leaf) as NodeLeaf
    const credential = leaf.leaf.credential
    if (!('identity' in credential)) throw new Error('expected a basic credential')
    credential.identity = new TextEncoder().encode('not-json-garbage')

    // Enumeration tolerates the bad leaf: it is skipped, not thrown.
    const members = groupWithBob.listMembers()
    expect(members).toHaveLength(1)
    expect(() => groupWithBob.listMembers()).not.toThrow()
  })
})

async function makePeer4(sigKeys = 1) {
  return await createIdentity({
    keys: Array.from({ length: sigKeys }, () => ({
      purpose: 'sig' as const,
      alg: 'EdDSA' as const,
    })),
    didMethod: 'peer:4',
  })
}

describe('peer4 MLS group end-to-end', () => {
  it('two peer4 members exchange application messages', async () => {
    const alice = await makePeer4()
    const bob = await makePeer4()
    const { group: aliceGroup } = await createGroup(alice, 'g-peer4-1')

    const bobBundle = await createKeyPackageBundle(bob)
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const commit = await commitInvite(aliceGroup, bobBundle.publicPackage, invite)

    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite,
      welcome: commit.welcomeMessage,
      keyPackageBundle: bobBundle,
    })

    const plaintext = new TextEncoder().encode('hello bob')
    const { message } = await commit.newGroup.encrypt(plaintext)
    const decrypted = await bobGroup.decrypt(message)
    expect(new TextDecoder().decode(decrypted)).toBe('hello bob')
  })

  it('mixes peer4 admin with did:key member', async () => {
    const alice = await makePeer4()
    const bob = await createIdentity({
      keys: [{ purpose: 'sig', alg: 'EdDSA' }],
      didMethod: 'key',
    })
    const { group: aliceGroup } = await createGroup(alice, 'g-mixed-1')
    const bobBundle = await createKeyPackageBundle(bob)
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const commit = await commitInvite(aliceGroup, bobBundle.publicPackage, invite)
    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite,
      welcome: commit.welcomeMessage,
      keyPackageBundle: bobBundle,
    })

    const { message } = await commit.newGroup.encrypt(new TextEncoder().encode('hi'))
    const decrypted = await bobGroup.decrypt(message)
    expect(new TextDecoder().decode(decrypted)).toBe('hi')
  })

  it('binds an MLS leaf for a peer4 identity with multiple sig keys', async () => {
    const alice = await makePeer4(2)
    const { group: aliceGroup } = await createGroup(alice, 'g-multisig-1')
    // group creation succeeds → auth service bound the primary sig key successfully.
    expect(aliceGroup.memberCount).toBe(1)
    expect(aliceGroup.findMemberLeafIndex(alice.id)).toBe(0)
  })

  it('removes a peer4 member and rejects subsequent traffic from them', async () => {
    const alice = await makePeer4()
    const bob = await makePeer4()
    const { group: aliceGroup0 } = await createGroup(alice, 'g-remove-1')
    const bobBundle = await createKeyPackageBundle(bob)
    const { invite } = await createInvite({
      group: aliceGroup0,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const addCommit = await commitInvite(aliceGroup0, bobBundle.publicPackage, invite)
    await processWelcome({
      identity: bob,
      invite,
      welcome: addCommit.welcomeMessage,
      keyPackageBundle: bobBundle,
    })

    const bobLeaf = addCommit.newGroup.findMemberLeafIndex(bob.id)
    if (bobLeaf == null) throw new Error('bob leaf not found')
    const removeResult = await removeMember(addCommit.newGroup, bobLeaf)
    expect(removeResult.newGroup.memberCount).toBe(1)
    expect(removeResult.newGroup.findMemberLeafIndex(bob.id)).toBeUndefined()
  })
})

/** The creator leaf's advertised GroupContext extension types. */
function creatorLeafExtensions(state: { ratchetTree: ReadonlyArray<unknown> }): Array<number> {
  const leaf = state.ratchetTree.find(
    (node) => node != null && (node as NodeLeaf).nodeType === nodeTypes.leaf,
  ) as NodeLeaf
  return leaf.leaf.capabilities.extensions
}

describe('GroupHandle control state', () => {
  test('createGroup seeds the roster, anchor, and ledger head from the genesis anchor', async () => {
    const alice = randomIdentity()
    const { group } = await createGroup(alice, 'seeded')

    expect([...group.roster.roles.entries()]).toEqual([[normalizeDID(alice.id), 'admin']])
    expect(group.anchor.creatorDID).toBe(alice.id)
    expect(readLedgerHead(group)).not.toBeNull()
    expect(readGroupAnchor(group)).not.toBeNull()

    const extensions = creatorLeafExtensions(group.state)
    expect(extensions).toContain(GROUP_ANCHOR_EXTENSION_TYPE)
    expect(extensions).toContain(LEDGER_HEAD_EXTENSION_TYPE)
  })

  test('applyLedgerEntries promotes a member and appends a repeated token', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const { group } = await createGroup(alice, 'promote')

    const token = await signLedgerEntry(alice, {
      type: 'group.role',
      groupID: group.groupID,
      subject: bob.id,
      value: 'admin',
    })

    await group.applyLedgerEntries([token])
    expect(group.roster.roles.get(normalizeDID(bob.id))).toBe('admin')

    // The log records the second enactment at its own position — the roster is
    // unchanged because re-applying the same claim is what it folds to, not because
    // the entry was skipped.
    await group.applyLedgerEntries([token])
    expect(group.roster.roles.get(normalizeDID(bob.id))).toBe('admin')
    expect(group.roster.roles.size).toBe(2)
    expect(group.ledgerTokens).toEqual([token, token])
  })

  test('applyLedgerEntries drops cross-group and member-signed tokens without throwing', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const charlie = randomIdentity()
    const { group } = await createGroup(alice, 'defensive')

    // Signed for a different group — a replayed grant, dropped on the groupID guard.
    const crossGroup = await signLedgerEntry(alice, {
      type: 'group.role',
      groupID: 'some-other-group',
      subject: bob.id,
      value: 'admin',
    })
    // Signed by a non-admin — authority fails against the seeded roster.
    const memberSigned = await signLedgerEntry(bob, {
      type: 'group.role',
      groupID: group.groupID,
      subject: charlie.id,
      value: 'admin',
    })

    await expect(group.applyLedgerEntries([crossGroup, memberSigned])).resolves.toBeUndefined()
    expect([...group.roster.roles.entries()]).toEqual([[normalizeDID(alice.id), 'admin']])
  })

  test('a handle derived by commitInvite carries the ledger, so a promotion survives', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const carol = randomIdentity()
    const { group: aliceGroup } = await createGroup(alice, 'derived-ledger')

    const promoteBob = await signLedgerEntry(alice, {
      type: 'group.role',
      groupID: aliceGroup.groupID,
      subject: bob.id,
      value: 'admin',
    })
    const { newGroup: alicePromoted } = await commitLedgerEntries(aliceGroup, [promoteBob])
    expect(alicePromoted.roster.roles.get(normalizeDID(bob.id))).toBe('admin')

    const { invite } = await createInvite({
      group: alicePromoted,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    const carolKP = await createKeyPackageBundle(carol)
    const { newGroup } = await commitInvite(alicePromoted, carolKP.publicPackage, invite)

    // The derived handle folds the parent's ledger, not the anchor alone.
    expect(newGroup.roster.roles.get(normalizeDID(bob.id))).toBe('admin')
    expect(newGroup.roster.roles.get(normalizeDID(alice.id))).toBe('admin')
  })

  test('restoreGroup over an anchorless state fails closed', async () => {
    const alice = randomIdentity()
    const { group, credential } = await createGroup(alice, 'strip-anchor')

    // Hand-strip the anchor extension from the restored state. Without a seed the
    // roster cannot be established, so construction must throw rather than install
    // a permissive policy.
    const stripped = {
      ...group.state,
      groupContext: {
        ...group.state.groupContext,
        extensions: group.state.groupContext.extensions.filter(
          (ext) => ext.extensionType !== GROUP_ANCHOR_EXTENSION_TYPE,
        ),
      },
    }

    await expect(restoreGroup({ state: stripped, credential })).rejects.toThrow(/anchor/)
  })

  test('restoreGroup rehydrates the roster from persisted ledger entries', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const { group, credential } = await createGroup(alice, 'rehydrate')

    const token = await signLedgerEntry(alice, {
      type: 'group.role',
      groupID: group.groupID,
      subject: bob.id,
      value: 'admin',
    })
    await group.applyLedgerEntries([token])

    const restored = await restoreGroup({
      state: group.state,
      credential,
      ledgerEntries: [token],
    })

    expect(restored.roster.roles.get(normalizeDID(bob.id))).toBe('admin')
    expect(restored.roster.roles.get(normalizeDID(alice.id))).toBe('admin')
  })
})

/**
 * Build an Alice(admin) + Bob(member) group at epoch 1, both handles live on the
 * same commit chain. `bobOptions`/`aliceOptions` seed each side's GroupHandle so a
 * test can install a resolver, an onLedgerEntries sink, or a caller commitPolicy.
 */
async function twoMemberGroup(opts?: { aliceOptions?: GroupOptions; bobOptions?: GroupOptions }) {
  const alice = randomIdentity()
  const bob = randomIdentity()
  const groupID = `enforce-${Math.random().toString(36).slice(2)}`
  const { group: aliceGroup0 } = await createGroup(alice, groupID, opts?.aliceOptions)
  const { invite } = await createInvite({
    group: aliceGroup0,
    identity: alice,
    recipientDID: bob.id,
    permission: 'member',
  })
  const bobKP = await createKeyPackageBundle(bob)
  const { welcomeMessage, newGroup: aliceGroup } = await commitInvite(
    aliceGroup0,
    bobKP.publicPackage,
    invite,
  )
  const { group: bobGroup } = await processWelcome({
    identity: bob,
    invite,
    welcome: welcomeMessage,
    keyPackageBundle: bobKP,
    ratchetTree: aliceGroup.state.ratchetTree,
    options: opts?.bobOptions,
  })
  return { alice, bob, aliceGroup, bobGroup, groupID }
}

/** Build a PrivateMessage commit (path-only key rotation) carrying `authenticatedData`. */
async function pathCommitBytes(
  group: { context: unknown; state: unknown },
  authenticatedData?: Uint8Array,
): Promise<Uint8Array> {
  const result = await createCommit({
    context: group.context as Parameters<typeof createCommit>[0]['context'],
    state: group.state as Parameters<typeof createCommit>[0]['state'],
    extraProposals: [],
    ...(authenticatedData != null && { authenticatedData }),
  })
  return encode(mlsMessageEncoder, result.commit)
}

/**
 * A commit enacting `tokens`: the envelope naming them plus the head move they imply.
 * Stands in for a client that skipped the write path's own fold — the receivers must
 * reject such a commit on the entries themselves, not on the committer's good behaviour.
 */
async function entryCommitBytes(group: GroupHandle, tokens: Array<string>): Promise<Uint8Array> {
  const entryIDs = tokens.map(ledgerEntryDigest)
  const current = readLedgerHead(group)
  if (current == null) throw new Error('expected the group to carry a ledger head')
  const head = buildLedgerHeadExtension(extendHead(current.head, entryIDs))
  const result = await createCommit({
    context: group.context,
    state: group.state,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.group_context_extensions,
        groupContextExtensions: {
          extensions: group.state.groupContext.extensions.map(
            (ext: GroupContextExtension): GroupContextExtension =>
              ext.extensionType === LEDGER_HEAD_EXTENSION_TYPE ? head : ext,
          ),
        },
      },
    ],
    authenticatedData: encodeControlEnvelope({ v: 1, entries: entryIDs }),
  })
  return encode(mlsMessageEncoder, result.commit)
}

/** A commit proposing an Add of `keyPackage`, optionally carrying an envelope. */
async function addCommitBytes(
  group: { context: unknown; state: unknown },
  keyPackage: unknown,
  authenticatedData?: Uint8Array,
): Promise<Uint8Array> {
  const result = await createCommit({
    context: group.context as Parameters<typeof createCommit>[0]['context'],
    state: group.state as Parameters<typeof createCommit>[0]['state'],
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: keyPackage as never },
      },
    ] as Parameters<typeof createCommit>[0]['extraProposals'],
    ...(authenticatedData != null && { authenticatedData }),
  })
  return encode(mlsMessageEncoder, result.commit)
}

/** A commit carrying a group_context_extensions proposal, optionally with an envelope. */
async function gceCommitBytes(
  group: { context: unknown; state: unknown },
  extensions: Array<GroupContextExtension>,
  authenticatedData?: Uint8Array,
): Promise<Uint8Array> {
  const result = await createCommit({
    context: group.context as Parameters<typeof createCommit>[0]['context'],
    state: group.state as Parameters<typeof createCommit>[0]['state'],
    extraProposals: [
      {
        proposalType: defaultProposalTypes.group_context_extensions,
        groupContextExtensions: { extensions },
      },
    ] as Parameters<typeof createCommit>[0]['extraProposals'],
    ...(authenticatedData != null && { authenticatedData }),
  })
  return encode(mlsMessageEncoder, result.commit)
}

/** A resolver backed by a mutable token map the test fills after signing. */
function mapResolver(tokens: Map<string, string>): GroupOptions['resolveLedgerEntries'] {
  return async (ids) => ids.map((id) => tokens.get(id)).filter((t): t is string => t != null)
}

/** The ordered entry ids a handle holds — the list its head must fold to. */
function ledgerIDs(group: { ledgerTokens: Array<string> }): Array<string> {
  return group.ledgerTokens.map(ledgerEntryDigest)
}

/** The head a handle's GroupContext authenticates. */
function head(group: Parameters<typeof readLedgerHead>[0]): Uint8Array {
  const value = readLedgerHead(group)
  if (value == null) throw new Error('expected the group to carry a ledger head')
  return value.head
}

describe('GroupHandle commit enforcement (default-on)', () => {
  test("rejects a non-admin member's privileged commit with no caller policy", async () => {
    const { bob, aliceGroup, bobGroup } = await twoMemberGroup()
    const carol = randomIdentity()

    // Bob (member) commits an Add of Carol. commitInvite refuses to build it for a
    // non-admin, so the raw commit stands in for a client that skipped that guard —
    // the receiving side must reject it on its own.
    const carolKP = await createKeyPackageBundle(carol)
    const bobCommit = await addCommitBytes(bobGroup, carolKP.publicPackage)

    const epochBefore = aliceGroup.epoch
    const rosterBefore = [...aliceGroup.roster.roles.entries()]
    await expect(aliceGroup.processMessage(bobCommit)).rejects.toThrow(CommitRejectedError)
    expect(aliceGroup.epoch).toBe(epochBefore)
    expect([...aliceGroup.roster.roles.entries()]).toEqual(rosterBefore)
    // Bob is still a member — nothing was applied.
    expect(aliceGroup.roster.roles.get(normalizeDID(bob.id))).toBe('member')
  })

  test("accepts an admin's Add", async () => {
    const tokens = new Map<string, string>()
    const { alice, aliceGroup, bobGroup } = await twoMemberGroup({
      bobOptions: { resolveLedgerEntries: mapResolver(tokens) },
    })
    const carol = randomIdentity()

    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    publishInvite(tokens, invite)
    const carolKP = await createKeyPackageBundle(carol)
    const addCarol = await commitInvite(aliceGroup, carolKP.publicPackage, invite)

    await bobGroup.processMessage(addCarol.commitMessage)
    expect(bobGroup.epoch).toBe(2n)
    expect(bobGroup.findMemberLeafIndex(carol.id)).toBeDefined()
  })

  test('a role entry updates the roster on accept; a non-role entry surfaces', async () => {
    const tokens = new Map<string, string>()
    const surfaced: Array<VerifiedLedgerEntry> = []
    const { alice, bob, aliceGroup, bobGroup, groupID } = await twoMemberGroup({
      bobOptions: {
        resolveLedgerEntries: async (ids) =>
          ids.map((id) => tokens.get(id)).filter((t): t is string => t != null),
        onLedgerEntries: (entries) => {
          surfaced.push(...entries)
        },
      },
    })

    const roleToken = await signLedgerEntry(alice, {
      type: 'group.role',
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    const appToken = await signLedgerEntry(alice, {
      type: 'note',
      groupID,
      subject: bob.id,
      value: 'welcome',
    })
    tokens.set(ledgerEntryDigest(roleToken), roleToken)
    tokens.set(ledgerEntryDigest(appToken), appToken)

    const { commitMessage } = await commitLedgerEntries(aliceGroup, [roleToken, appToken])

    await bobGroup.processMessage(commitMessage)

    expect(bobGroup.epoch).toBe(2n)
    expect(bobGroup.roster.roles.get(normalizeDID(bob.id))).toBe('admin')
    // Only the non-role entry surfaces to the consumer.
    expect(surfaced.map((e) => e.entry.type)).toEqual(['note'])
    expect(surfaced.map((e) => e.entry.value)).toEqual(['welcome'])
  })

  test('MissingLedgerEntriesError names the entry, leaves epoch, then retries green', async () => {
    const { alice, bob, aliceGroup, bobGroup, groupID } = await twoMemberGroup()

    const roleToken = await signLedgerEntry(alice, {
      type: 'group.role',
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    const roleID = ledgerEntryDigest(roleToken)
    const { commitMessage } = await commitLedgerEntries(aliceGroup, [roleToken])

    const epochBefore = bobGroup.epoch
    await expect(bobGroup.processMessage(commitMessage)).rejects.toMatchObject({
      name: 'MissingLedgerEntriesError',
      ids: [roleID],
    })
    expect(bobGroup.epoch).toBe(epochBefore)

    // Supply the body and re-process the same commit — now accepted.
    await bobGroup.applyLedgerEntries([roleToken])
    await bobGroup.processMessage(commitMessage)
    expect(bobGroup.epoch).toBe(2n)
    expect(bobGroup.roster.roles.get(normalizeDID(bob.id))).toBe('admin')
  })

  test('rejects an unknown envelope version', async () => {
    const { aliceGroup, bobGroup } = await twoMemberGroup()

    const ad = new TextEncoder().encode(JSON.stringify({ v: 2 }))
    const bytes = await pathCommitBytes(aliceGroup, ad)

    const epochBefore = bobGroup.epoch
    await expect(bobGroup.processMessage(bytes)).rejects.toThrow(CommitRejectedError)
    expect(bobGroup.epoch).toBe(epochBefore)
  })

  test('rejects a commit carrying a member-signed ledger entry', async () => {
    // Bob (a member) signs a role entry: the signature verifies, but the issuer is
    // not an admin, so the envelope fold rejects and the commit is refused.
    const surfaced: Array<VerifiedLedgerEntry> = []
    const bobTokenBox: { token?: string } = {}
    const { bob, aliceGroup, bobGroup, groupID } = await twoMemberGroup({
      bobOptions: {
        resolveLedgerEntries: async () => (bobTokenBox.token != null ? [bobTokenBox.token] : []),
        onLedgerEntries: (entries) => {
          surfaced.push(...entries)
        },
      },
    })

    const bobToken = await signLedgerEntry(bob, {
      type: 'group.role',
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    bobTokenBox.token = bobToken
    const bobID = ledgerEntryDigest(bobToken)

    const bytes = await pathCommitBytes(
      aliceGroup,
      encodeControlEnvelope({ v: 1, entries: [bobID] }),
    )

    const epochBefore = bobGroup.epoch
    await expect(bobGroup.processMessage(bytes)).rejects.toThrow(CommitRejectedError)
    expect(bobGroup.epoch).toBe(epochBefore)
    expect(surfaced).toEqual([])
  })

  test('application messages run no envelope work', async () => {
    const { aliceGroup, bobGroup } = await twoMemberGroup({
      bobOptions: {
        // If the pre-pass ran on an application message it would call this resolver.
        resolveLedgerEntries: async () => {
          throw new Error('resolver must not run for application messages')
        },
      },
    })

    const { message } = await aliceGroup.encrypt(new TextEncoder().encode('hi'))
    const decrypted = await bobGroup.decrypt(message)
    expect(new TextDecoder().decode(decrypted)).toBe('hi')
  })
})

describe('GroupHandle commit enforcement (caller policy override)', () => {
  test("a reject-all caller policy refuses an admin's valid commit", async () => {
    const tokens = new Map<string, string>()
    const { alice, aliceGroup, bobGroup } = await twoMemberGroup({
      bobOptions: { commitPolicy: () => 'reject', resolveLedgerEntries: mapResolver(tokens) },
    })
    const carol = randomIdentity()

    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    publishInvite(tokens, invite)
    const carolKP = await createKeyPackageBundle(carol)
    const addCarol = await commitInvite(aliceGroup, carolKP.publicPackage, invite)

    const epochBefore = bobGroup.epoch
    await expect(bobGroup.processMessage(addCarol.commitMessage)).rejects.toThrow(
      CommitRejectedError,
    )
    expect(bobGroup.epoch).toBe(epochBefore)
  })

  test("an accept-all caller policy accepts a member's commit the default would reject", async () => {
    // Alice receives with an accept-all policy; Bob (member) commits the Add as a
    // raw commit, since commitInvite refuses to build one for a non-admin.
    const { aliceGroup, bobGroup } = await twoMemberGroup({
      aliceOptions: { commitPolicy: () => 'accept' },
    })
    const carol = randomIdentity()

    const carolKP = await createKeyPackageBundle(carol)
    const bobCommit = await addCommitBytes(bobGroup, carolKP.publicPackage)

    await aliceGroup.processMessage(bobCommit)
    expect(aliceGroup.epoch).toBe(2n)
    expect(aliceGroup.findMemberLeafIndex(carol.id)).toBeDefined()
  })

  test('MissingLedgerEntriesError still throws under an accept-all caller policy', async () => {
    const { alice, bob, aliceGroup, bobGroup, groupID } = await twoMemberGroup({
      bobOptions: { commitPolicy: () => 'accept' },
    })
    void bob

    const roleToken = await signLedgerEntry(alice, {
      type: 'group.role',
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    const roleID = ledgerEntryDigest(roleToken)
    const bytes = await pathCommitBytes(
      aliceGroup,
      encodeControlEnvelope({ v: 1, entries: [roleID] }),
    )

    const epochBefore = bobGroup.epoch
    await expect(bobGroup.processMessage(bytes)).rejects.toThrow(MissingLedgerEntriesError)
    expect(bobGroup.epoch).toBe(epochBefore)
  })
})

describe('GroupHandle authority is state-so-far, not post-commit', () => {
  test('a member cannot self-bootstrap: a self-signed promotion in its own commit is rejected', async () => {
    const tokens = new Map<string, string>()
    const { bob, aliceGroup, bobGroup, groupID } = await twoMemberGroup({
      aliceOptions: { resolveLedgerEntries: mapResolver(tokens) },
    })

    // Bob signs his own promotion to admin and rides it in his own commit. The
    // entry resolves — so the rejection is the fold's authority rule, not a
    // missing body: the issuer is judged against the state so far, where Bob is
    // not an admin, so the whole commit is rejected. Bob cannot lift himself.
    const selfPromote = await signLedgerEntry(bob, {
      type: 'group.role',
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    tokens.set(ledgerEntryDigest(selfPromote), selfPromote)
    const bytes = await pathCommitBytes(
      bobGroup,
      encodeControlEnvelope({ v: 1, entries: [ledgerEntryDigest(selfPromote)] }),
    )

    const epochBefore = aliceGroup.epoch
    await expect(aliceGroup.processMessage(bytes)).rejects.toThrow(CommitRejectedError)
    expect(aliceGroup.epoch).toBe(epochBefore)
    expect(aliceGroup.roster.roles.get(normalizeDID(bob.id))).toBe('member')
  })

  test('a valid promotion cannot authorize the same committer in the same commit', async () => {
    const tokens = new Map<string, string>()
    const { alice, bob, aliceGroup, bobGroup, groupID } = await twoMemberGroup({
      aliceOptions: { resolveLedgerEntries: mapResolver(tokens) },
    })

    // Alice (admin) validly promotes Bob, but the promotion rides a commit Bob
    // himself authors to Add Carol. The entry folds (Alice is admin), so the
    // candidate roster makes Bob admin — but the Add's sender authority is judged
    // against the base roster, where Bob is still a member, so it is rejected.
    const promoteBob = await signLedgerEntry(alice, {
      type: 'group.role',
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    tokens.set(ledgerEntryDigest(promoteBob), promoteBob)

    const carol = randomIdentity()
    const carolKP = await createKeyPackageBundle(carol)
    const bobAddCommit = await addCommitBytes(
      bobGroup,
      carolKP.publicPackage,
      encodeControlEnvelope({ v: 1, entries: [ledgerEntryDigest(promoteBob)] }),
    )

    const epochBefore = aliceGroup.epoch
    await expect(aliceGroup.processMessage(bobAddCommit)).rejects.toThrow(CommitRejectedError)
    expect(aliceGroup.epoch).toBe(epochBefore)
    // The rejected commit applied nothing: Bob is still a member, Carol was not added.
    expect(aliceGroup.roster.roles.get(normalizeDID(bob.id))).toBe('member')
  })

  test('the control: an admin committing the same Add and promotion is accepted', async () => {
    const tokens = new Map<string, string>()
    const { alice, bob, aliceGroup, bobGroup, groupID } = await twoMemberGroup({
      bobOptions: { resolveLedgerEntries: mapResolver(tokens) },
    })

    const promoteBob = await signLedgerEntry(alice, {
      type: 'group.role',
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    tokens.set(ledgerEntryDigest(promoteBob), promoteBob)

    const carol = randomIdentity()
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    // Alice — an admin in the base roster — commits the Add carrying the promotion:
    // both entries ride the one commit, and the head advances by both.
    const withPromotion: Invite = {
      ...invite,
      ledgerEntries: [...invite.ledgerEntries.slice(0, -1), promoteBob, roleToken(invite)],
    }
    publishInvite(tokens, withPromotion)
    const carolKP = await createKeyPackageBundle(carol)
    const addCarol = await commitInvite(aliceGroup, carolKP.publicPackage, withPromotion)

    await bobGroup.processMessage(addCarol.commitMessage)
    expect(bobGroup.epoch).toBe(2n)
    expect(bobGroup.roster.roles.get(normalizeDID(bob.id))).toBe('admin')
    expect(bobGroup.listMembers().some((m) => normalizeDID(m.id) === normalizeDID(carol.id))).toBe(
      true,
    )
  })
})

describe('an invite seeds the roster', () => {
  test("the inviter's handle holds the invitee's role after commitInvite", async () => {
    const { bob, aliceGroup } = await twoMemberGroup()

    expect(aliceGroup.roster.roles.get(normalizeDID(bob.id))).toBe('member')
  })

  test("the joiner's handle holds its own role and the creator's", async () => {
    const { alice, bob, bobGroup } = await twoMemberGroup()

    expect(bobGroup.roster.roles.get(normalizeDID(bob.id))).toBe('member')
    expect(bobGroup.roster.roles.get(normalizeDID(alice.id))).toBe('admin')
  })

  test('an existing receiver folds the new member in from the commit envelope', async () => {
    const tokens = new Map<string, string>()
    const { alice, aliceGroup, bobGroup } = await twoMemberGroup({
      bobOptions: { resolveLedgerEntries: mapResolver(tokens) },
    })
    const carol = randomIdentity()

    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    publishInvite(tokens, invite)
    const carolKP = await createKeyPackageBundle(carol)
    const addCarol = await commitInvite(aliceGroup, carolKP.publicPackage, invite)

    // The commit carries the entry id; Bob resolves the body out of band and folds it.
    await bobGroup.processMessage(addCarol.commitMessage)
    expect(bobGroup.roster.roles.get(normalizeDID(carol.id))).toBe('member')
    expect(addCarol.newGroup.roster.roles.get(normalizeDID(carol.id))).toBe('member')
  })

  test('a receiver that cannot resolve the invitee role entry refuses the add commit', async () => {
    // The envelope carries ids, not bodies: a receiver with no resolver and no local
    // copy of the entry cannot fold the commit and stays at its pre-commit epoch.
    const { alice, aliceGroup, bobGroup } = await twoMemberGroup()
    const carol = randomIdentity()

    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    const carolKP = await createKeyPackageBundle(carol)
    const addCarol = await commitInvite(aliceGroup, carolKP.publicPackage, invite)

    const epochBefore = bobGroup.epoch
    await expect(bobGroup.processMessage(addCarol.commitMessage)).rejects.toMatchObject({
      name: 'MissingLedgerEntriesError',
      ids: [ledgerEntryDigest(roleToken(invite))],
    })
    expect(bobGroup.epoch).toBe(epochBefore)
    expect(bobGroup.roster.roles.get(normalizeDID(carol.id))).toBeUndefined()
  })

  test('a member cannot invite', async () => {
    const { bob, bobGroup } = await twoMemberGroup()
    const carol = randomIdentity()

    await expect(
      createInvite({
        group: bobGroup,
        identity: bob,
        recipientDID: carol.id,
        permission: 'member',
      }),
    ).rejects.toThrow(/admin/)
  })

  test('a Welcome whose invite names someone else is refused', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const carol = randomIdentity()
    const { group: aliceGroup } = await createGroup(alice, 'wrong-invitee')

    // The Add is Bob's, but the invite handed to him names Carol.
    const { invite: carolInvite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const { welcomeMessage, newGroup } = await commitInvite(
      aliceGroup,
      bobKP.publicPackage,
      carolInvite,
    )

    await expect(
      processWelcome({
        identity: bob,
        invite: carolInvite,
        welcome: welcomeMessage,
        keyPackageBundle: bobKP,
        ratchetTree: newGroup.state.ratchetTree,
      }),
    ).rejects.toThrow(/role entry/)
  })
})

/** A roster as a stable, comparable value. */
function rosterEntries(group: { roster: { roles: ReadonlyMap<string, string> } }) {
  return [...group.roster.roles.entries()].sort(([a], [b]) => a.localeCompare(b))
}

describe('an invite carries the group ledger', () => {
  test('a joiner agrees with the group about a role change that predates its invite', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const carol = randomIdentity()
    const { group: aliceGroup } = await createGroup(alice, 'ledger-before-join')

    const promoteBob = await signLedgerEntry(alice, {
      type: 'group.role',
      groupID: aliceGroup.groupID,
      subject: bob.id,
      value: 'admin',
    })
    const { newGroup: alicePromoted } = await commitLedgerEntries(aliceGroup, [promoteBob])

    const { invite } = await createInvite({
      group: alicePromoted,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    const carolKP = await createKeyPackageBundle(carol)
    const addCarol = await commitInvite(alicePromoted, carolKP.publicPackage, invite)
    const { group: carolGroup } = await processWelcome({
      identity: carol,
      invite,
      welcome: addCarol.welcomeMessage,
      keyPackageBundle: carolKP,
      ratchetTree: addCarol.newGroup.state.ratchetTree,
    })

    // The invite carries the whole ledger, so a role change made before the invite
    // still reaches the joiner: her roster cannot fork from the group's.
    expect(carolGroup.roster.roles.get(normalizeDID(bob.id))).toBe('admin')
    expect(carolGroup.roster.roles.get(normalizeDID(alice.id))).toBe('admin')
    expect(carolGroup.roster.roles.get(normalizeDID(carol.id))).toBe('member')
  })

  test('a joiner accepts a commit from an admin promoted before it joined', async () => {
    // The fork's consequence: a joiner that never learned of Bob's promotion sees
    // his commits as unauthorized and rejects every one of them, forever.
    const tokens = new Map<string, string>()
    const { alice, bob, aliceGroup, bobGroup, groupID } = await twoMemberGroup({
      bobOptions: { resolveLedgerEntries: mapResolver(tokens) },
    })
    const carol = randomIdentity()
    const dave = randomIdentity()

    const promoteBob = await signLedgerEntry(alice, {
      type: 'group.role',
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    tokens.set(ledgerEntryDigest(promoteBob), promoteBob)
    const promotion = await commitLedgerEntries(aliceGroup, [promoteBob])
    await bobGroup.processMessage(promotion.commitMessage)

    // Carol joins after the promotion.
    const { invite: carolInvite } = await createInvite({
      group: promotion.newGroup,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    publishInvite(tokens, carolInvite)
    const carolKP = await createKeyPackageBundle(carol)
    const addCarol = await commitInvite(promotion.newGroup, carolKP.publicPackage, carolInvite)
    const { group: carolGroup } = await processWelcome({
      identity: carol,
      invite: carolInvite,
      welcome: addCarol.welcomeMessage,
      keyPackageBundle: carolKP,
      ratchetTree: addCarol.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries: mapResolver(tokens) },
    })
    await bobGroup.processMessage(addCarol.commitMessage)

    // Bob — an admin the group agrees on — adds Dave, and Carol applies his commit.
    const { invite: daveInvite } = await createInvite({
      group: bobGroup,
      identity: bob,
      recipientDID: dave.id,
      permission: 'member',
    })
    publishInvite(tokens, daveInvite)
    const daveKP = await createKeyPackageBundle(dave)
    const addDave = await commitInvite(bobGroup, daveKP.publicPackage, daveInvite)

    await carolGroup.processMessage(addDave.commitMessage)
    expect(carolGroup.epoch).toBe(addDave.newGroup.epoch)
    expect(carolGroup.findMemberLeafIndex(dave.id)).toBeDefined()
    expect(rosterEntries(carolGroup)).toEqual(rosterEntries(addDave.newGroup))
  })

  test('three members converge on one roster after a promotion and two joins', async () => {
    const tokens = new Map<string, string>()
    const { alice, bob, aliceGroup, bobGroup, groupID } = await twoMemberGroup({
      bobOptions: { resolveLedgerEntries: mapResolver(tokens) },
    })
    const carol = randomIdentity()

    const promoteBob = await signLedgerEntry(alice, {
      type: 'group.role',
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    tokens.set(ledgerEntryDigest(promoteBob), promoteBob)
    const promotion = await commitLedgerEntries(aliceGroup, [promoteBob])
    await bobGroup.processMessage(promotion.commitMessage)

    const { invite } = await createInvite({
      group: promotion.newGroup,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    publishInvite(tokens, invite)
    const carolKP = await createKeyPackageBundle(carol)
    const addCarol = await commitInvite(promotion.newGroup, carolKP.publicPackage, invite)
    const { group: carolGroup } = await processWelcome({
      identity: carol,
      invite,
      welcome: addCarol.welcomeMessage,
      keyPackageBundle: carolKP,
      ratchetTree: addCarol.newGroup.state.ratchetTree,
    })
    await bobGroup.processMessage(addCarol.commitMessage)

    const expected = [
      [normalizeDID(alice.id), 'admin'],
      [normalizeDID(bob.id), 'admin'],
      [normalizeDID(carol.id), 'member'],
    ].sort(([a], [b]) => (a as string).localeCompare(b as string))
    expect(rosterEntries(addCarol.newGroup)).toEqual(expected)
    expect(rosterEntries(bobGroup)).toEqual(expected)
    expect(rosterEntries(carolGroup)).toEqual(expected)
  })

  test('ledgerTokens round-trips through restoreGroup', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const carol = randomIdentity()
    const { group: aliceGroup } = await createGroup(alice, 'token-roundtrip')

    const promoteBob = await signLedgerEntry(alice, {
      type: 'group.role',
      groupID: aliceGroup.groupID,
      subject: bob.id,
      value: 'admin',
    })
    const { newGroup: alicePromoted } = await commitLedgerEntries(aliceGroup, [promoteBob])
    const { invite } = await createInvite({
      group: alicePromoted,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    const carolKP = await createKeyPackageBundle(carol)
    const { newGroup } = await commitInvite(alicePromoted, carolKP.publicPackage, invite)

    // The tokens are the ledger's whole persistent form: replaying them re-verifies
    // every entry and reproduces the roster, with no import path for the cache.
    const restored = await restoreGroup({
      state: newGroup.state,
      credential: newGroup.credential,
      ledgerEntries: newGroup.ledgerTokens,
    })

    expect(newGroup.ledgerTokens).toHaveLength(2)
    expect(restored.ledgerTokens).toEqual(newGroup.ledgerTokens)
    expect(rosterEntries(restored)).toEqual(rosterEntries(newGroup))
  })

  test('a member-signed entry smuggled into an invite is refused before it is committed', async () => {
    const { bob, aliceGroup, alice, groupID } = await twoMemberGroup()
    const carol = randomIdentity()
    const dave = randomIdentity()

    // Bob is only a member: his role entry verifies, but authority is rooted at the
    // anchor and grows only through admins-so-far, so no fold will ever apply it.
    const bobPromotesCarol = await signLedgerEntry(bob, {
      type: 'group.role',
      groupID,
      subject: carol.id,
      value: 'admin',
    })

    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: dave.id,
      permission: 'member',
    })
    const tampered: Invite = {
      ...invite,
      ledgerEntries: [...invite.ledgerEntries.slice(0, -1), bobPromotesCarol, roleToken(invite)],
    }

    // Alice is an honest admin, but the entries she would enact are not hers to vouch
    // for: she folds them as her receivers would and refuses to author a commit they
    // would reject. An entry the fold drops must never reach the head chain.
    const daveKP = await createKeyPackageBundle(dave)
    await expect(commitInvite(aliceGroup, daveKP.publicPackage, tampered)).rejects.toThrow(
      /cannot enact ledger entry/,
    )
    expect(aliceGroup.roster.roles.get(normalizeDID(carol.id))).toBeUndefined()
  })

  test('the ledger keeps its order across the wire: promote then demote folds to demoted', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const carol = randomIdentity()
    const { group: aliceGroup } = await createGroup(alice, 'ordered-ledger')

    const promoteBob = await signLedgerEntry(alice, {
      type: 'group.role',
      groupID: aliceGroup.groupID,
      subject: bob.id,
      value: 'admin',
    })
    const demoteBob = await signLedgerEntry(alice, {
      type: 'group.role',
      groupID: aliceGroup.groupID,
      subject: bob.id,
      value: 'member',
    })
    const { newGroup: aliceRotated } = await commitLedgerEntries(aliceGroup, [
      promoteBob,
      demoteBob,
    ])
    expect(aliceRotated.roster.roles.get(normalizeDID(bob.id))).toBe('member')

    const { invite } = await createInvite({
      group: aliceRotated,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    // Order survives the wire, so the joiner folds the pair the same way round.
    expect(invite.ledgerEntries.slice(0, 2)).toEqual([promoteBob, demoteBob])

    const carolKP = await createKeyPackageBundle(carol)
    const { welcomeMessage, newGroup } = await commitInvite(
      aliceRotated,
      carolKP.publicPackage,
      invite,
    )
    const { group: carolGroup } = await processWelcome({
      identity: carol,
      invite,
      welcome: welcomeMessage,
      keyPackageBundle: carolKP,
      ratchetTree: newGroup.state.ratchetTree,
    })

    expect(carolGroup.roster.roles.get(normalizeDID(bob.id))).toBe('member')
  })

  test('an invite after an admin rotation is accepted by an up-to-date receiver', async () => {
    // The invite carries the whole history, but the commit envelope must name only the
    // entries this commit enacts. Replaying the history would re-judge each past entry
    // against the present roster, and a grant issued by a since-demoted admin would read
    // as coming from a non-admin — freezing every group that ever rotated its admins.
    const alice = randomIdentity()
    const bob = randomIdentity()
    const carol = randomIdentity()
    const tokens = new Map<string, string>()
    const options: GroupOptions = { resolveLedgerEntries: mapResolver(tokens) }
    const publish = (list: Array<string>) => {
      for (const token of list) tokens.set(ledgerEntryDigest(token), token)
    }

    const { group: aliceGroup } = await createGroup(alice, 'rotation-group', options)
    const promoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID: aliceGroup.groupID,
      subject: bob.id,
      value: 'admin',
    })
    publish([promoteBob])
    const { newGroup: alicePromoted } = await commitLedgerEntries(aliceGroup, [promoteBob])

    const { invite: bobInvite } = await createInvite({
      group: alicePromoted,
      identity: alice,
      recipientDID: bob.id,
      permission: 'admin',
    })
    publish(bobInvite.ledgerEntries)
    const bobKP = await createKeyPackageBundle(bob)
    const addBob = await commitInvite(alicePromoted, bobKP.publicPackage, bobInvite)
    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite: bobInvite,
      welcome: addBob.welcomeMessage,
      keyPackageBundle: bobKP,
      ratchetTree: addBob.newGroup.state.ratchetTree,
      options,
    })

    // Bob, now an admin, demotes Alice. The demotion rides his commit, which Alice
    // applies — so she is an up-to-date receiver rather than a stale one, the case that
    // actually reproduces.
    const demoteAlice = await signLedgerEntry(bob, {
      type: ROLE_ENTRY_TYPE,
      groupID: bobGroup.groupID,
      subject: alice.id,
      value: 'member',
    })
    publish([demoteAlice])
    const demotion = await commitLedgerEntries(bobGroup, [demoteAlice])
    await addBob.newGroup.processMessage(demotion.commitMessage)
    expect(demotion.newGroup.roster.roles.get(normalizeDID(alice.id))).toBe('member')
    expect(addBob.newGroup.roster.roles.get(normalizeDID(alice.id))).toBe('member')

    // Bob — the sole admin — invites Carol. Alice must still accept his commit.
    const { invite: carolInvite } = await createInvite({
      group: demotion.newGroup,
      identity: bob,
      recipientDID: carol.id,
      permission: 'member',
    })
    publish(carolInvite.ledgerEntries)
    const carolKP = await createKeyPackageBundle(carol)
    const addCarol = await commitInvite(demotion.newGroup, carolKP.publicPackage, carolInvite)

    await addBob.newGroup.processMessage(addCarol.commitMessage)
    expect(addBob.newGroup.epoch).toBe(addCarol.newGroup.epoch)
    expect(addBob.newGroup.roster.roles.get(normalizeDID(carol.id))).toBe('member')
    expect(addBob.newGroup.roster.roles.get(normalizeDID(alice.id))).toBe('member')
  })
})

/**
 * Alice (admin) + Bob (member) + Carol (member), all three handles on the same commit
 * chain at epoch 2, every handle resolving entry bodies out of one shared store.
 */
async function threeMemberGroup() {
  const tokens = new Map<string, string>()
  const options: GroupOptions = { resolveLedgerEntries: mapResolver(tokens) }
  const { alice, bob, aliceGroup, bobGroup, groupID } = await twoMemberGroup({
    aliceOptions: options,
    bobOptions: options,
  })
  const carol = randomIdentity()
  const { invite } = await createInvite({
    group: aliceGroup,
    identity: alice,
    recipientDID: carol.id,
    permission: 'member',
  })
  publishInvite(tokens, invite)
  const carolKP = await createKeyPackageBundle(carol)
  const addCarol = await commitInvite(aliceGroup, carolKP.publicPackage, invite)
  const { group: carolGroup } = await processWelcome({
    identity: carol,
    invite,
    welcome: addCarol.welcomeMessage,
    keyPackageBundle: carolKP,
    ratchetTree: addCarol.newGroup.state.ratchetTree,
    options,
  })
  await bobGroup.processMessage(addCarol.commitMessage)
  return {
    alice,
    bob,
    carol,
    aliceGroup: addCarol.newGroup,
    bobGroup,
    carolGroup,
    groupID,
    tokens,
  }
}

describe('every ledger entry rides a commit, and the head proves it', () => {
  test('an admin promotes through commitLedgerEntries; the head advances with it', async () => {
    const { alice, bob, aliceGroup, bobGroup, carolGroup, groupID, tokens } =
      await threeMemberGroup()

    const promoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    tokens.set(ledgerEntryDigest(promoteBob), promoteBob)

    const before = head(aliceGroup)
    const { commitMessage, newGroup } = await commitLedgerEntries(aliceGroup, [promoteBob])
    await bobGroup.processMessage(commitMessage)
    await carolGroup.processMessage(commitMessage)

    // Committer and receivers agree on the new role...
    expect(newGroup.roster.roles.get(normalizeDID(bob.id))).toBe('admin')
    expect(bobGroup.roster.roles.get(normalizeDID(bob.id))).toBe('admin')
    expect(carolGroup.roster.roles.get(normalizeDID(bob.id))).toBe('admin')
    // ...and the head moved, in lockstep, to the fold over the whole ledger.
    expect(head(newGroup)).not.toEqual(before)
    expect(head(bobGroup)).toEqual(head(newGroup))
    expect(head(carolGroup)).toEqual(head(newGroup))
    expect(head(newGroup)).toEqual(computeHead(groupID, ledgerIDs(newGroup)))
  })

  test('the head still matches after an entry commit and an invite', async () => {
    const { alice, bob, aliceGroup, bobGroup, groupID, tokens } = await threeMemberGroup()
    const dave = randomIdentity()

    const promoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    tokens.set(ledgerEntryDigest(promoteBob), promoteBob)
    const promotion = await commitLedgerEntries(aliceGroup, [promoteBob])
    await bobGroup.processMessage(promotion.commitMessage)

    const { invite } = await createInvite({
      group: promotion.newGroup,
      identity: alice,
      recipientDID: dave.id,
      permission: 'member',
    })
    publishInvite(tokens, invite)
    const daveKP = await createKeyPackageBundle(dave)
    const addDave = await commitInvite(promotion.newGroup, daveKP.publicPackage, invite)
    const { group: daveGroup } = await processWelcome({
      identity: dave,
      invite,
      welcome: addDave.welcomeMessage,
      keyPackageBundle: daveKP,
      ratchetTree: addDave.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries: mapResolver(tokens) },
    })
    await bobGroup.processMessage(addDave.commitMessage)

    const expected = computeHead(groupID, invite.ledgerEntries.map(ledgerEntryDigest))
    expect(head(addDave.newGroup)).toEqual(expected)
    expect(head(bobGroup)).toEqual(expected)
    expect(head(daveGroup)).toEqual(expected)
    expect(ledgerIDs(daveGroup)).toEqual(ledgerIDs(addDave.newGroup))
  })

  test('a member cannot write a ledger entry', async () => {
    const { bob, bobGroup, groupID } = await twoMemberGroup()
    const carol = randomIdentity()

    const promoteCarol = await signLedgerEntry(bob, {
      type: ROLE_ENTRY_TYPE,
      groupID,
      subject: carol.id,
      value: 'admin',
    })
    await expect(commitLedgerEntries(bobGroup, [promoteCarol])).rejects.toThrow(/admin/)
  })

  test('commitLedgerEntries refuses to author a commit that enacts nothing', async () => {
    const { aliceGroup } = await twoMemberGroup()

    await expect(commitLedgerEntries(aliceGroup, [])).rejects.toThrow(/no ledger entries/)
  })

  test('an inviter that omits an entry is caught by the joiner', async () => {
    const { alice, bob, aliceGroup, groupID, tokens } = await threeMemberGroup()
    const dave = randomIdentity()

    // The entry the inviter would rather the joiner never folded: without it Dave reads
    // Bob as a plain member and refuses every commit Bob makes, forever.
    const promoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    tokens.set(ledgerEntryDigest(promoteBob), promoteBob)
    const { newGroup: afterPromotion } = await commitLedgerEntries(aliceGroup, [promoteBob])

    const { invite } = await createInvite({
      group: afterPromotion,
      identity: alice,
      recipientDID: dave.id,
      permission: 'member',
    })
    const daveKP = await createKeyPackageBundle(dave)
    const addDave = await commitInvite(afterPromotion, daveKP.publicPackage, invite)

    const truncated: Invite = {
      ...invite,
      ledgerEntries: invite.ledgerEntries.filter((token) => token !== promoteBob),
    }
    expect(truncated.ledgerEntries).toHaveLength(invite.ledgerEntries.length - 1)

    await expect(
      processWelcome({
        identity: dave,
        invite: truncated,
        welcome: addDave.welcomeMessage,
        keyPackageBundle: daveKP,
        ratchetTree: addDave.newGroup.state.ratchetTree,
      }),
    ).rejects.toThrow(LedgerIncompleteError)
  })

  test('an inviter that reorders the entries is caught by the joiner', async () => {
    const { alice, bob, aliceGroup, groupID, tokens } = await threeMemberGroup()
    const dave = randomIdentity()

    const promoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    tokens.set(ledgerEntryDigest(promoteBob), promoteBob)
    const { newGroup: afterPromotion } = await commitLedgerEntries(aliceGroup, [promoteBob])

    const { invite } = await createInvite({
      group: afterPromotion,
      identity: alice,
      recipientDID: dave.id,
      permission: 'member',
    })
    const daveKP = await createKeyPackageBundle(dave)
    const addDave = await commitInvite(afterPromotion, daveKP.publicPackage, invite)

    // The same entries, one pair swapped: the head is order-sensitive, so it cannot
    // be reproduced from a list whose order was rewritten.
    const entries = [...invite.ledgerEntries]
    const [first, second] = [entries[0] as string, entries[1] as string]
    entries[0] = second
    entries[1] = first
    const reordered: Invite = { ...invite, ledgerEntries: entries }

    await expect(
      processWelcome({
        identity: dave,
        invite: reordered,
        welcome: addDave.welcomeMessage,
        keyPackageBundle: daveKP,
        ratchetTree: addDave.newGroup.state.ratchetTree,
      }),
    ).rejects.toThrow(LedgerIncompleteError)
  })

  test('a commit that enacts entries without moving the head is rejected', async () => {
    const { alice, bob, aliceGroup, bobGroup, groupID, tokens } = await threeMemberGroup()

    const promoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    tokens.set(ledgerEntryDigest(promoteBob), promoteBob)

    // The envelope names the entry, but no group_context_extensions proposal carries the
    // head forward — so the head would stop covering the ledger and an omission would
    // become undetectable. Forged directly: commitLedgerEntries never builds this.
    const forged = await pathCommitBytes(
      aliceGroup,
      encodeControlEnvelope({ v: 1, entries: [ledgerEntryDigest(promoteBob)] }),
    )

    const epochBefore = bobGroup.epoch
    await expect(bobGroup.processMessage(forged)).rejects.toThrow(CommitRejectedError)
    expect(bobGroup.epoch).toBe(epochBefore)
    expect(bobGroup.roster.roles.get(normalizeDID(bob.id))).toBe('member')
  })

  test('a commit that moves the head to a value the envelope does not account for is rejected', async () => {
    const { alice, bob, aliceGroup, bobGroup, groupID, tokens } = await threeMemberGroup()

    const promoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    tokens.set(ledgerEntryDigest(promoteBob), promoteBob)

    // The anchor is copied verbatim and the entry is legitimate, but the head is
    // extended by an id the envelope never names.
    const anchor = readGroupAnchorExtension(aliceGroup)
    if (anchor == null) throw new Error('expected the group to carry an anchor')
    const forged = await gceCommitBytes(
      aliceGroup,
      [anchor, buildLedgerHeadExtension(extendHead(head(aliceGroup), ['not-in-the-envelope']))],
      encodeControlEnvelope({ v: 1, entries: [ledgerEntryDigest(promoteBob)] }),
    )

    const epochBefore = bobGroup.epoch
    await expect(bobGroup.processMessage(forged)).rejects.toThrow(CommitRejectedError)
    expect(bobGroup.epoch).toBe(epochBefore)
    expect(bobGroup.roster.roles.get(normalizeDID(bob.id))).toBe('member')
  })

  test('an admin can be removed when the demotion rides the same commit', async () => {
    const { alice, bob, aliceGroup, bobGroup, carolGroup, groupID, tokens } =
      await threeMemberGroup()

    const promoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    tokens.set(ledgerEntryDigest(promoteBob), promoteBob)
    const promotion = await commitLedgerEntries(aliceGroup, [promoteBob])
    await bobGroup.processMessage(promotion.commitMessage)
    await carolGroup.processMessage(promotion.commitMessage)

    // Removal must demote: without the demotion entry the removal is refused by every
    // receiver, because the target is still admin in the roster the commit folds to.
    const bobLeaf = promotion.newGroup.findMemberLeafIndex(bob.id)
    expect(bobLeaf).toBeDefined()
    const bare = await removeMember(promotion.newGroup, bobLeaf as number)
    const epochBefore = bobGroup.epoch
    await expect(bobGroup.processMessage(bare.commitMessage)).rejects.toThrow(CommitRejectedError)
    expect(bobGroup.epoch).toBe(epochBefore)

    // With the demotion riding the same commit, the removal goes through — even though
    // demoting Bob back to the role his invite granted him re-signs that very entry, so
    // the log carries the same content id twice. The later position is what counts.
    const demoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID,
      subject: bob.id,
      value: 'member',
    })
    tokens.set(ledgerEntryDigest(demoteBob), demoteBob)
    const removal = await removeMember(promotion.newGroup, bobLeaf as number, [demoteBob])

    await carolGroup.processMessage(removal.commitMessage)
    expect(carolGroup.epoch).toBe(removal.epoch)
    expect(carolGroup.findMemberLeafIndex(bob.id)).toBeUndefined()
    expect(carolGroup.roster.roles.get(normalizeDID(bob.id))).toBe('member')
    expect(removal.newGroup.roster.roles.get(normalizeDID(bob.id))).toBe('member')
    expect(head(carolGroup)).toEqual(head(removal.newGroup))
    expect(head(removal.newGroup)).toEqual(computeHead(groupID, ledgerIDs(removal.newGroup)))
  })
})

/**
 * Alice (admin) alone, having granted Bob `member`, promoted him, then demoted him back
 * — three commits, so her log carries the same content id at two positions.
 */
async function demotedThroughRepeat(groupID: string) {
  const alice = randomIdentity()
  const bob = randomIdentity()
  const { group, credential } = await createGroup(alice, groupID)
  const role = async (value: 'admin' | 'member') =>
    await signLedgerEntry(alice, { type: ROLE_ENTRY_TYPE, groupID, subject: bob.id, value })

  const granted = await commitLedgerEntries(group, [await role('member')])
  const promoted = await commitLedgerEntries(granted.newGroup, [await role('admin')])
  const demoted = await commitLedgerEntries(promoted.newGroup, [await role('member')])
  return { alice, bob, credential, group: demoted.newGroup }
}

describe('the ledger is an ordered log, not a set of claims', () => {
  test('an admin can be demoted back to a role they previously held', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const { group } = await createGroup(alice, 'redemotion')

    const grantMember = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID: group.groupID,
      subject: bob.id,
      value: 'member',
    })
    const promoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID: group.groupID,
      subject: bob.id,
      value: 'admin',
    })
    const demoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID: group.groupID,
      subject: bob.id,
      value: 'member',
    })
    // Signing is deterministic, so the demotion is the byte-identical token the first
    // grant was: the same claim at a later position, which is the only way a demotion
    // back to a previously-held role can express itself.
    expect(demoteBob).toBe(grantMember)

    const granted = await commitLedgerEntries(group, [grantMember])
    expect(granted.newGroup.roster.roles.get(normalizeDID(bob.id))).toBe('member')

    const promoted = await commitLedgerEntries(granted.newGroup, [promoteBob])
    expect(promoted.newGroup.roster.roles.get(normalizeDID(bob.id))).toBe('admin')

    const demoted = await commitLedgerEntries(promoted.newGroup, [demoteBob])
    expect(demoted.newGroup.roster.roles.get(normalizeDID(bob.id))).toBe('member')

    // The log holds the repeated claim at both positions, and the head chains both.
    expect(demoted.newGroup.ledgerTokens).toEqual([grantMember, promoteBob, demoteBob])
    expect(head(demoted.newGroup)).toEqual(computeHead(group.groupID, ledgerIDs(demoted.newGroup)))
  })

  test('every receiver folds the demotion the same way, and the head covers the repeat', async () => {
    const { alice, bob, aliceGroup, bobGroup, carolGroup, groupID, tokens } =
      await threeMemberGroup()

    const promoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    tokens.set(ledgerEntryDigest(promoteBob), promoteBob)
    const promotion = await commitLedgerEntries(aliceGroup, [promoteBob])
    await bobGroup.processMessage(promotion.commitMessage)
    await carolGroup.processMessage(promotion.commitMessage)
    expect(bobGroup.roster.roles.get(normalizeDID(bob.id))).toBe('admin')

    // Demoting Bob back to `member` re-signs the very entry his invite carried, so this
    // commit enacts a content id every receiver already holds.
    const demoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID,
      subject: bob.id,
      value: 'member',
    })
    tokens.set(ledgerEntryDigest(demoteBob), demoteBob)
    const demotion = await commitLedgerEntries(promotion.newGroup, [demoteBob])
    await bobGroup.processMessage(demotion.commitMessage)
    await carolGroup.processMessage(demotion.commitMessage)

    for (const receiver of [demotion.newGroup, bobGroup, carolGroup]) {
      expect(receiver.roster.roles.get(normalizeDID(bob.id))).toBe('member')
      expect(receiver.epoch).toBe(demotion.epoch)
      expect(head(receiver)).toEqual(computeHead(groupID, ledgerIDs(receiver)))
    }

    // The log and the head chain agree on a list holding one id twice.
    const ids = ledgerIDs(demotion.newGroup)
    expect(ids.at(-1)).toBe(ids[0])
    expect(new Set(ids).size).toBe(ids.length - 1)
  })

  test('an admin who was demoted cannot have an older token of theirs enacted', async () => {
    const { alice, bob, aliceGroup, bobGroup, carolGroup, groupID, tokens } =
      await threeMemberGroup()
    const dave = randomIdentity()

    // Alice signs a promotion of Dave while she is still an admin, and never commits it.
    const alicePromotesDave = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID,
      subject: dave.id,
      value: 'admin',
    })
    tokens.set(ledgerEntryDigest(alicePromotesDave), alicePromotesDave)

    const promoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    tokens.set(ledgerEntryDigest(promoteBob), promoteBob)
    const promotion = await commitLedgerEntries(aliceGroup, [promoteBob])
    await bobGroup.processMessage(promotion.commitMessage)
    await carolGroup.processMessage(promotion.commitMessage)

    const demoteAlice = await signLedgerEntry(bob, {
      type: ROLE_ENTRY_TYPE,
      groupID,
      subject: alice.id,
      value: 'member',
    })
    tokens.set(ledgerEntryDigest(demoteAlice), demoteAlice)
    const demotion = await commitLedgerEntries(bobGroup, [demoteAlice])
    await carolGroup.processMessage(demotion.commitMessage)
    await promotion.newGroup.processMessage(demotion.commitMessage)
    expect(carolGroup.roster.roles.get(normalizeDID(alice.id))).toBe('member')

    // Bob is a current admin, so he may enact entries — but every entry is judged by its
    // own issuer at its own position, and Alice is no longer an admin there. Her stale
    // token is dead, whoever carries it. The write path folds before it commits, so it
    // refuses to author a commit the group would reject rather than forking Bob off it.
    await expect(commitLedgerEntries(demotion.newGroup, [alicePromotesDave])).rejects.toThrow(
      /cannot enact ledger entry/,
    )
    expect(demotion.newGroup.roster.roles.get(normalizeDID(dave.id))).toBeUndefined()

    // And a client that skipped that guard gets nowhere: the receivers fold the entry
    // themselves and reject the commit on its issuer, not on who carried it.
    const forged = await entryCommitBytes(demotion.newGroup, [alicePromotesDave])
    const epochBefore = carolGroup.epoch
    await expect(carolGroup.processMessage(forged)).rejects.toThrow(CommitRejectedError)
    expect(carolGroup.epoch).toBe(epochBefore)
    expect(carolGroup.roster.roles.get(normalizeDID(dave.id))).toBeUndefined()
  })

  test('a member cannot enact an admin-signed entry naming himself', async () => {
    const { alice, bob, bobGroup, carolGroup, groupID, tokens } = await threeMemberGroup()

    const promoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID,
      subject: bob.id,
      value: 'admin',
    })
    tokens.set(ledgerEntryDigest(promoteBob), promoteBob)

    // Bob holds a genuine admin-signed promotion of himself. Enacting it means moving the
    // head, which takes a group-context-extensions proposal a member may not make — so
    // the best he can forge is a commit whose envelope names the entry and whose head
    // stands still, and that is exactly what the receivers refuse.
    const forged = await pathCommitBytes(
      bobGroup,
      encodeControlEnvelope({ v: 1, entries: [ledgerEntryDigest(promoteBob)] }),
    )

    const epochBefore = carolGroup.epoch
    await expect(carolGroup.processMessage(forged)).rejects.toThrow(CommitRejectedError)
    expect(carolGroup.epoch).toBe(epochBefore)
    expect(carolGroup.roster.roles.get(normalizeDID(bob.id))).toBe('member')
  })

  test('ledgerTokens round-trips a log with repeats through restoreGroup', async () => {
    const groupID = 'repeat-roundtrip'
    const { bob, credential, group } = await demotedThroughRepeat(groupID)

    const restored = await restoreGroup({
      state: group.state,
      credential,
      ledgerEntries: group.ledgerTokens,
    })

    expect(group.ledgerTokens).toHaveLength(3)
    expect(restored.ledgerTokens).toEqual(group.ledgerTokens)
    expect(rosterEntries(restored)).toEqual(rosterEntries(group))
    expect(restored.roster.roles.get(normalizeDID(bob.id))).toBe('member')
    expect(head(restored)).toEqual(computeHead(groupID, ledgerIDs(restored)))
  })

  test('an invite carries the repeats faithfully, and the joiner folds the same roster', async () => {
    const groupID = 'repeat-invite'
    const { alice, bob, group } = await demotedThroughRepeat(groupID)
    const carol = randomIdentity()

    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    expect(invite.ledgerEntries.slice(0, 3)).toEqual(group.ledgerTokens)

    const carolKP = await createKeyPackageBundle(carol)
    const addCarol = await commitInvite(group, carolKP.publicPackage, invite)
    // The joiner recomputes the head over the invite's list; a repeat that did not
    // reproduce it would throw LedgerIncompleteError here.
    const { group: carolGroup } = await processWelcome({
      identity: carol,
      invite,
      welcome: addCarol.welcomeMessage,
      keyPackageBundle: carolKP,
      ratchetTree: addCarol.newGroup.state.ratchetTree,
    })

    expect(carolGroup.ledgerTokens).toEqual(addCarol.newGroup.ledgerTokens)
    expect(rosterEntries(carolGroup)).toEqual(rosterEntries(addCarol.newGroup))
    expect(carolGroup.roster.roles.get(normalizeDID(bob.id))).toBe('member')
    expect(head(carolGroup)).toEqual(computeHead(groupID, ledgerIDs(carolGroup)))
  })
})

/** Decode framed GroupInfo bytes to the ts-mls GroupInfo the external-join API takes. */
function decodeGroupInfo(bytes: Uint8Array) {
  const message = decode(mlsMessageDecoder, bytes)
  if (message == null || message.wireformat !== wireformats.mls_group_info) {
    throw new Error('expected a framed MLSMessage(GroupInfo)')
  }
  return message.groupInfo
}

describe('GroupHandle external-join commit enforcement', () => {
  test('rejects a stranger external-joining with a leaked GroupInfo', async () => {
    // Alice + Bob are the whole roster. Mallory is in no roster and holds no leaf.
    const { aliceGroup } = await twoMemberGroup()
    const mallory = randomIdentity()

    // Mallory forges a plain external-join commit against a leaked GroupInfo: an
    // external_init that adds her own leaf, with no self-remove (she has no stale
    // leaf). This is the RFC join-via-external-commit flow a stranger would use.
    const { groupInfo } = await exportGroupInfo({ group: aliceGroup })
    const malloryKP = await createKeyPackageBundle(mallory)
    const { publicMessage } = await mlsJoinGroupExternal({
      context: aliceGroup.context,
      groupInfo: decodeGroupInfo(groupInfo),
      keyPackage: malloryKP.publicPackage,
      privateKeys: malloryKP.privatePackage,
      resync: false,
    })
    const commitBytes = encode(mlsMessageEncoder, {
      version: protocolVersions.mls10,
      wireformat: wireformats.mls_public_message,
      publicMessage,
    })

    const epochBefore = aliceGroup.epoch
    const rosterBefore = [...aliceGroup.roster.roles.entries()]
    await expect(aliceGroup.processMessage(commitBytes)).rejects.toThrow(CommitRejectedError)
    // Nothing moved: no epoch advance, no new member, roster unchanged.
    expect(aliceGroup.epoch).toBe(epochBefore)
    expect(aliceGroup.findMemberLeafIndex(mallory.id)).toBeUndefined()
    expect([...aliceGroup.roster.roles.entries()]).toEqual(rosterBefore)
  })

  test('accepts a legitimate member resync and keeps them in the roster', async () => {
    // Alice (admin) creates the group; Bob joins through Welcome, then falls behind
    // and external-rejoins. The rejoin proves control of Bob's roster DID and removes
    // his stale leaf, so it is accepted and Bob stays in the roster.
    const alice = randomIdentity()
    const bob = randomIdentity()
    const carol = randomIdentity()

    const { group: aliceGroup } = await createGroup(alice, 'resync-accept-group')
    const { invite: bobInvite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bobKP = await createKeyPackageBundle(bob)
    const { welcomeMessage: bobWelcome, newGroup: aliceAfterBob } = await commitInvite(
      aliceGroup,
      bobKP.publicPackage,
      bobInvite,
    )
    const { credential: bobCred } = await processWelcome({
      identity: bob,
      invite: bobInvite,
      welcome: bobWelcome,
      keyPackageBundle: bobKP,
      ratchetTree: aliceAfterBob.state.ratchetTree,
    })

    // Advance the epoch while Bob is offline: add Carol, then remove her.
    const { invite: carolInvite } = await createInvite({
      group: aliceAfterBob,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    const carolKP = await createKeyPackageBundle(carol)
    const { newGroup: aliceAfterCarol } = await commitInvite(
      aliceAfterBob,
      carolKP.publicPackage,
      carolInvite,
    )
    const carolLeaf = aliceAfterCarol.findMemberLeafIndex(carol.id)
    if (carolLeaf == null) throw new Error('expected Carol to hold a leaf')
    const { newGroup: aliceAdvanced } = await removeMember(aliceAfterCarol, carolLeaf)

    // Bob external-rejoins and Alice processes the commit: accepted, Bob still present.
    const { groupInfo } = await exportGroupInfo({ group: aliceAdvanced })
    const { commitMessage, group: bobRejoined } = await joinGroupExternal({
      identity: bob,
      groupInfo,
      credential: bobCred,
      resync: true,
    })

    const epochBefore = aliceAdvanced.epoch
    await aliceAdvanced.processMessage(commitMessage)
    expect(aliceAdvanced.epoch).toBe(epochBefore + 1n)
    expect(aliceAdvanced.epoch).toBe(bobRejoined.epoch)
    expect(aliceAdvanced.findMemberLeafIndex(bob.id)).toBeDefined()
    expect(aliceAdvanced.roster.roles.get(normalizeDID(bob.id))).toBe('member')
  })
})
