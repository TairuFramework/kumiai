import { randomIdentity } from '@kokuin/token'
import { decode, encode, mlsMessageDecoder, mlsMessageEncoder, wireformats } from 'ts-mls'
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
  // epoch. Return the handles at that shared epoch, and the add-commit itself: it is framed at
  // epoch 0, BELOW both of them, which is the shape a peer walking history reads.
  return { alice, bob, aliceAfterBob, bobGroup, bobCred, addBobCommit: commitMessage }
}

/** A commit by alice adding a fresh member, framed at `group`'s current epoch. */
async function addSomeone(
  group: Awaited<ReturnType<typeof createGroup>>['group'],
  alice: ReturnType<typeof randomIdentity>,
) {
  const newcomer = randomIdentity()
  const bundle = await createKeyPackageBundle(newcomer, { capabilities: controlCapabilities() })
  const { invite } = await createInvite({
    group,
    identity: alice,
    recipientDID: newcomer.id,
    permission: 'member',
  })
  return await commitInvite(group, bundle.publicPackage, invite)
}

/**
 * Forge an external commit that CLAIMS `did`: re-encode a genuine one with only the UpdatePath
 * leaf's credential identity replaced. The leaf's signature key is untouched, so the frame still
 * carries the original signer's key and its signature no longer matches its content — exactly what
 * a publisher who holds no key can produce from a frame it observed.
 */
function rewriteExternalCommitIdentity(commit: Uint8Array, did: string): Uint8Array {
  const decoded = decode(mlsMessageDecoder, commit)
  if (decoded == null || decoded.wireformat !== wireformats.mls_public_message) {
    throw new Error('not a public message')
  }
  const content = decoded.publicMessage.content as unknown as {
    commit: { path: { leafNode: { credential: { identity: Uint8Array } } } }
  }
  const path = content.commit.path
  return encode(mlsMessageEncoder, {
    ...decoded,
    publicMessage: {
      ...decoded.publicMessage,
      content: {
        ...content,
        commit: {
          ...content.commit,
          path: {
            ...path,
            leafNode: {
              ...path.leafNode,
              credential: {
                ...path.leafNode.credential,
                identity: new TextEncoder().encode(JSON.stringify({ id: did })),
              },
            },
          },
        },
      },
    },
  } as never)
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

describe('GroupHandle.readCommitHeader — a commit framed at another epoch', () => {
  // The committer needs this epoch's sender-data secret and the epoch does not, so a commit
  // framed anywhere but here yields the epoch and no committer. Answering `null` instead is
  // what makes a peer read the group's future as garbage: `null` is filed as poison and stepped
  // over, so a peer that fell behind would walk the whole log, heal off nothing, and report
  // itself fully reconciled at a dead epoch.

  test('a commit framed AHEAD reports its epoch, and no committer', async () => {
    const { alice, aliceAfterBob, bobGroup } = await twoMemberGroup()
    // Alice commits once (Bob does not apply it, so he stays put) and then again. The second
    // commit is framed one epoch ABOVE Bob — the frame that tells a fallen-behind peer so.
    const first = await addSomeone(aliceAfterBob, alice)
    const second = await addSomeone(first.newGroup, alice)
    expect(second.newGroup.epoch).toBeGreaterThan(bobGroup.epoch + 1n)

    const header = await bobGroup.readCommitHeader(second.commitMessage)
    // It IS a commit, and it says so — that is the whole point.
    expect(header).not.toBeNull()
    expect(header?.epoch).toBe(bobGroup.epoch + 1n)
    // And Bob cannot vouch for who wrote it: the sender-data is sealed under an epoch secret he
    // does not hold. Absent, never guessed — not from a leaf, not from the transport.
    expect(header?.committerDID).toBeUndefined()
  })

  test('a commit framed BELOW reports its epoch, and no committer', async () => {
    const { bobGroup, addBobCommit } = await twoMemberGroup()
    // The commit that added Bob, framed at epoch 0 — below the epoch his Welcome landed him at.
    // Every healthy peer reads frames like this: a joiner's first pull is nothing else.
    expect(bobGroup.epoch).toBeGreaterThan(0n)

    const header = await bobGroup.readCommitHeader(addBobCommit)
    expect(header).not.toBeNull()
    expect(header?.epoch).toBe(0n)
    // A ratcheted-past epoch's secret is as gone as one never reached. Same answer, same reason.
    expect(header?.committerDID).toBeUndefined()
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

  test('reports NO committer for an external commit whose leaf credential was rewritten', async () => {
    const { alice, bob, aliceAfterBob, bobCred } = await twoMemberGroup()
    const { groupInfo } = await exportGroupInfo({ group: aliceAfterBob })
    const { commitMessage } = await joinGroupExternal({
      identity: bob,
      groupInfo,
      credential: bobCred,
      resync: true,
    })

    // The forgery this check exists for: take a genuine external commit and rewrite ONLY the
    // UpdatePath leaf's credential identity, to the DID of the peer that will read it. Nothing
    // else moves, so the frame stays structurally a valid external commit framed at Alice's own
    // epoch — but the signature is now over content that no longer matches, and the key that
    // signed it is still Bob's. Left unauthenticated, this is a frame that names its reader as
    // its own author, which is the one claim a reader acts on by healing.
    const forged = rewriteExternalCommitIdentity(commitMessage, alice.id)

    const header = await aliceAfterBob.readCommitHeader(forged)
    // Still a commit, and still recognizably external: both facts are cleartext and neither
    // depends on who signed. The epoch is reported, because the epoch rows are entitled to it.
    expect(header).not.toBeNull()
    expect(header?.epoch).toBe(aliceAfterBob.epoch)
    expect(header?.external).toBe(true)
    // The committer is what a forger does not get to choose.
    expect(header?.committerDID).toBeUndefined()
  })

  test('reports NO committer for an external commit framed at an epoch this handle is not at', async () => {
    const { alice, bob, aliceAfterBob, bobCred } = await twoMemberGroup()
    const { groupInfo } = await exportGroupInfo({ group: aliceAfterBob })
    const { commitMessage } = await joinGroupExternal({
      identity: bob,
      groupInfo,
      credential: bobCred,
      resync: true,
    })
    // Genuine and readable where it was framed.
    expect((await aliceAfterBob.readCommitHeader(commitMessage))?.committerDID).toBe(bob.id)

    // Alice moves on. An external commit's signature is bound to the GroupContext it was made
    // against, so from her new epoch she holds nothing to check this one with — and reports no
    // committer rather than the DID the bytes claim. Same rule as a member commit off-epoch.
    const { newGroup: aliceAhead } = await addSomeone(aliceAfterBob, alice)
    const header = await aliceAhead.readCommitHeader(commitMessage)
    expect(header?.epoch).toBe(aliceAfterBob.epoch)
    expect(header?.external).toBe(true)
    expect(header?.committerDID).toBeUndefined()
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
