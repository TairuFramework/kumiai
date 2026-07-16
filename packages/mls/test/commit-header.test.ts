import { randomIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import { controlCapabilities } from '../src/anchor.js'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  exportGroupInfo,
  joinGroupExternal,
  processWelcome,
} from '../src/group.js'

async function twoMemberGroup() {
  const alice = randomIdentity()
  const bob = randomIdentity()
  const { group: aliceGroup } = await createGroup(alice, 'g', {
    capabilities: controlCapabilities(),
  })
  const bobBundle = await createKeyPackageBundle(bob, { capabilities: controlCapabilities() })
  const { invite } = await createInvite({
    group: aliceGroup,
    identity: alice,
    recipientDID: bob.id,
    permission: 'member',
  })
  const {
    welcomeMessage,
    commitMessage,
    newGroup: aliceAfterBob,
  } = await commitInvite(aliceGroup, bobBundle.publicPackage, invite)
  const { group: bobGroup, credential: bobCred } = await processWelcome({
    identity: bob,
    invite,
    welcome: welcomeMessage,
    keyPackageBundle: bobBundle,
  })
  // Bob applies Alice's add-commit is unnecessary — the Welcome lands him at the post-invite
  // epoch. Return the handles at that shared epoch.
  void commitMessage
  return { alice, bob, aliceAfterBob, bobGroup, bobCred }
}

describe('GroupHandle.readCommitHeader — member commit', () => {
  test('returns the MLS-authenticated committer DID and epoch', async () => {
    const { alice, aliceAfterBob, bobGroup } = await twoMemberGroup()
    const carol = randomIdentity()
    const carolBundle = await createKeyPackageBundle(carol, {
      capabilities: controlCapabilities(),
    })
    const { invite: carolInvite } = await createInvite({
      group: aliceAfterBob,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    // Alice authors this commit at the epoch Bob is at, so Bob can read it.
    const { commitMessage } = await commitInvite(
      aliceAfterBob,
      carolBundle.publicPackage,
      carolInvite,
    )

    const header = await bobGroup.readCommitHeader(commitMessage)
    expect(header).not.toBeNull()
    expect(header?.committerDID).toBe(alice.id)
    expect(header?.epoch).toBe(bobGroup.epoch)
    // A commit from a member that already holds a leaf is not external. Absent, not false.
    expect(header?.external).toBeUndefined()
    // The committer the reader resolved is the DID at that sender leaf in Bob's tree.
    expect(bobGroup.findMemberLeafIndex(alice.id)).toBeDefined()
  })

  test('is non-mutating — the handle epoch is unchanged after a read', async () => {
    const { alice, aliceAfterBob, bobGroup } = await twoMemberGroup()
    const carol = randomIdentity()
    const carolBundle = await createKeyPackageBundle(carol, {
      capabilities: controlCapabilities(),
    })
    const { invite: carolInvite } = await createInvite({
      group: aliceAfterBob,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    const { commitMessage } = await commitInvite(
      aliceAfterBob,
      carolBundle.publicPackage,
      carolInvite,
    )
    const before = bobGroup.epoch
    await bobGroup.readCommitHeader(commitMessage)
    expect(bobGroup.epoch).toBe(before)
  })
})

describe('GroupHandle.readCommitHeader — external commit and non-commit', () => {
  test('returns the rejoiner as committer for an external commit', async () => {
    const { bob, aliceAfterBob, bobCred } = await twoMemberGroup()
    // Bob rejoins externally (resync) at the epoch he already shares with Alice —
    // exercises the external-join commit path without needing to advance Alice first.
    const { groupInfo } = await exportGroupInfo({ group: aliceAfterBob })
    const { commitMessage } = await joinGroupExternal({
      identity: bob,
      groupInfo,
      credential: bobCred,
      resync: true,
    })

    const header = await aliceAfterBob.readCommitHeader(commitMessage)
    expect(header).not.toBeNull()
    expect(header?.committerDID).toBe(bob.id)
    // External commit's header epoch is the pre-commit (sending) epoch.
    expect(header?.epoch).toBe(aliceAfterBob.epoch)
    // The rejoin says so itself, because nothing else can say it for it: Bob keeps his id and
    // — the resync blanking his leaf and the new one taking the leftmost blank — his leaf
    // index, so no before/after diff of the roster moves. A reader that must know membership
    // shifted has only this flag.
    expect(header?.external).toBe(true)
    expect(aliceAfterBob.findMemberLeafIndex(bob.id)).toBeDefined()
  })

  test('returns null for a non-commit frame and for garbage bytes', async () => {
    const { aliceAfterBob, bobGroup } = await twoMemberGroup()
    // An application message is a PrivateMessage that is NOT a commit.
    const appMessage = await aliceAfterBob.encrypt(new TextEncoder().encode('hi'))
    expect(await bobGroup.readCommitHeader(appMessage)).toBeNull()
    expect(await bobGroup.readCommitHeader(new Uint8Array([0xff, 0xff]))).toBeNull()
    expect(await bobGroup.readCommitHeader(new Uint8Array())).toBeNull()
  })

  test('returns null (does not reject) for a truncated commit frame that makes ts-mls decode throw', async () => {
    const { alice, aliceAfterBob, bobGroup } = await twoMemberGroup()
    const carol = randomIdentity()
    const carolBundle = await createKeyPackageBundle(carol, {
      capabilities: controlCapabilities(),
    })
    const { invite: carolInvite } = await createInvite({
      group: aliceAfterBob,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    const { commitMessage } = await commitInvite(
      aliceAfterBob,
      carolBundle.publicPackage,
      carolInvite,
    )

    // Slicing 3 bytes off the end leaves an inner variable-length prefix claiming more
    // data than remains in the buffer. ts-mls `decode` throws a CodecError ("Data length
    // exceeds buffer") for this input rather than returning null — verified directly
    // against `decode(mlsMessageDecoder, truncated)` in a scratch check. readCommitHeader's
    // contract is "null for bytes that are not a Commit"; it must not let that throw
    // propagate as a rejection.
    const truncated = commitMessage.slice(0, commitMessage.length - 3)

    await expect(bobGroup.readCommitHeader(truncated)).resolves.toBeNull()
  })
})
