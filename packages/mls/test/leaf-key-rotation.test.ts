import { randomIdentity } from '@kokuin/token'
import { type ClientState, nodeTypes } from 'ts-mls'
import { describe, expect, test } from 'vitest'

import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  type GroupHandle,
  processWelcome,
} from '../src/group.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import type { Invite } from '../src/types.js'

const INFO = new TextEncoder().encode('sealed-reply')

/** Leaf `i` lives at node index `2i` in the RFC 9420 array-encoded ratchet tree. */
function leafNodeIndex(leafIndex: number): number {
  return leafIndex * 2
}

/** A leaf's HPKE public key as it stands in the tree the holder of `state` sees. */
function leafPublicKey(state: ClientState, leafIndex: number): Uint8Array {
  const node = state.ratchetTree[leafNodeIndex(leafIndex)]
  if (node == null || node.nodeType !== nodeTypes.leaf) {
    throw new Error(`no leaf node at leaf index ${leafIndex}`)
  }
  return node.leaf.hpkePublicKey
}

/** The private half of a member's own leaf key — held only in its own ClientState. */
function ownLeafPrivateKey(state: ClientState): Uint8Array {
  const key = state.privatePath.privateKeys[leafNodeIndex(state.privatePath.leafIndex)]
  if (key == null) {
    throw new Error('client state holds no private key for its own leaf')
  }
  return key
}

type Sealed = { ct: Uint8Array; enc: Uint8Array }

/** Seal to a leaf key with the same HPKE the group's ciphersuite uses. */
async function sealToLeafKey(
  group: GroupHandle,
  publicKey: Uint8Array,
  plaintext: Uint8Array,
): Promise<Sealed> {
  const { hpke } = group.context.cipherSuite
  return await hpke.seal(await hpke.importPublicKey(publicKey), plaintext, INFO)
}

async function openWithLeafKey(
  group: GroupHandle,
  privateKey: Uint8Array,
  sealed: Sealed,
): Promise<Uint8Array> {
  const { hpke } = group.context.cipherSuite
  return await hpke.open(await hpke.importPrivateKey(privateKey), sealed.enc, sealed.ct, INFO)
}

/**
 * Alice (admin, leaf 0) and Bob (member, leaf 1) in a group at epoch 1, plus the
 * signed ledger tokens every receiver needs to fold the commits that follow.
 */
async function twoMemberGroup(groupID: string) {
  const alice = randomIdentity()
  const bob = randomIdentity()
  const tokens = new Map<string, string>()
  const publish = (invite: Invite) => {
    for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
  }
  const resolveLedgerEntries = async (ids: Array<string>) =>
    ids.map((id) => {
      const token = tokens.get(id)
      if (token == null) throw new Error(`unknown ledger entry ${id}`)
      return token
    })

  const { group: created } = await createGroup(alice, groupID, { resolveLedgerEntries })
  const { invite } = await createInvite({
    group: created,
    identity: alice,
    recipientDID: bob.id,
    permission: 'member',
  })
  publish(invite)
  const bobBundle = await createKeyPackageBundle(bob)
  const addBob = await commitInvite(created, bobBundle.publicPackage, invite)
  const { group: bobGroup } = await processWelcome({
    identity: bob,
    invite,
    welcome: addBob.welcomeMessage,
    keyPackageBundle: bobBundle,
    ratchetTree: addBob.newGroup.state.ratchetTree,
    options: { resolveLedgerEntries },
  })

  return { alice, aliceGroup: addBob.newGroup, bobGroup, publish }
}

describe('leaf HPKE key rotation on commit', () => {
  test('a commit rotates its author leaf HPKE key, stranding the pre-commit private key', async () => {
    const { alice, aliceGroup, bobGroup, publish } = await twoMemberGroup('rotation-committer')

    // What Alice holds before she commits: her leaf key as the group sees it, and the
    // private half in her own state.
    const preCommitPublicKey = leafPublicKey(aliceGroup.state, 0)
    const preCommitPrivateKey = ownLeafPrivateKey(aliceGroup.state)

    // Alice commits (adding Carol). She never adopts the resulting handle — her process
    // dies here — so all she still holds is the pre-commit `aliceGroup`.
    const carol = randomIdentity()
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    publish(invite)
    const carolBundle = await createKeyPackageBundle(carol)
    const commit = await commitInvite(aliceGroup, carolBundle.publicPackage, invite)

    // Bob applies the commit. The tree he now sees carries Alice's *new* leaf key — the
    // one a responder would seal a reply to.
    await bobGroup.processMessage(commit.commitMessage)
    expect(bobGroup.epoch).toBe(2n)
    const postCommitPublicKey = leafPublicKey(bobGroup.state, 0)

    // Half one: the committer's leaf key in the post-commit tree is not the one she kept.
    expect(postCommitPublicKey).not.toEqual(preCommitPublicKey)

    // Half two: the key she kept cannot open a seal made to the key the group can see.
    const plaintext = new TextEncoder().encode('sealed to the committer leaf')
    const sealed = await sealToLeafKey(bobGroup, postCommitPublicKey, plaintext)
    await expect(openWithLeafKey(aliceGroup, preCommitPrivateKey, sealed)).rejects.toThrow()

    // The seal itself is sound: the private half installed by Alice's own commit — the
    // half she dropped when she failed to adopt the new handle — opens it.
    const postCommitPrivateKey = ownLeafPrivateKey(commit.newGroup.state)
    expect(postCommitPrivateKey).not.toEqual(preCommitPrivateKey)
    await expect(openWithLeafKey(aliceGroup, postCommitPrivateKey, sealed)).resolves.toEqual(
      plaintext,
    )

    // Nor can she get that half back by replaying the commit she sent: an UpdatePath
    // encrypts its path secrets to every subtree *except* the author's own, so applying it
    // to the author's own stale state finds no key it can decrypt with, and the leaf secret
    // itself is never sent to anyone. The stale handle stays stranded at its old epoch.
    await expect(aliceGroup.processMessage(commit.commitMessage)).rejects.toThrow(
      'No overlap between provided private keys and update path',
    )
    expect(aliceGroup.epoch).toBe(1n)
    expect(ownLeafPrivateKey(aliceGroup.state)).toEqual(preCommitPrivateKey)
  })

  test('someone else commit leaves a non-committing member leaf HPKE key intact', async () => {
    const { alice, aliceGroup, bobGroup, publish } = await twoMemberGroup('rotation-bystander')

    // Bob commits nothing. His leaf key and its private half, before Alice's commit.
    const bobPreCommitPublicKey = leafPublicKey(bobGroup.state, 1)
    const bobPreCommitPrivateKey = ownLeafPrivateKey(bobGroup.state)

    const carol = randomIdentity()
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    publish(invite)
    const carolBundle = await createKeyPackageBundle(carol)
    const commit = await commitInvite(aliceGroup, carolBundle.publicPackage, invite)
    await bobGroup.processMessage(commit.commitMessage)

    // Alice's commit rotated her own leaf, not Bob's: the key she now sees for Bob is
    // the one Bob still holds the private half of.
    const bobPostCommitPublicKey = leafPublicKey(commit.newGroup.state, 1)
    expect(bobPostCommitPublicKey).toEqual(bobPreCommitPublicKey)

    // So a reply sealed to Bob's leaf as the group sees it opens with the key Bob kept.
    // This is the case leaf-sealing handles — and only this one.
    const plaintext = new TextEncoder().encode('sealed to a bystander leaf')
    const sealed = await sealToLeafKey(commit.newGroup, bobPostCommitPublicKey, plaintext)
    await expect(openWithLeafKey(bobGroup, bobPreCommitPrivateKey, sealed)).resolves.toEqual(
      plaintext,
    )
  })
})
