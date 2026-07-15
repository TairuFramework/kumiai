import { randomIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import { controlCapabilities } from '../src/anchor.js'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
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
  const { group: bobGroup } = await processWelcome({
    identity: bob,
    invite,
    welcome: welcomeMessage,
    keyPackageBundle: bobBundle,
  })
  // Bob applies Alice's add-commit is unnecessary — the Welcome lands him at the post-invite
  // epoch. Return the handles at that shared epoch.
  void commitMessage
  return { alice, bob, aliceAfterBob, bobGroup }
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
