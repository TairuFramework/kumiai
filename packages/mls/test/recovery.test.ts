import { encodeMultibase, type OwnIdentity, randomIdentity } from '@kokuin/token'
import { type ClientState, nodeTypes } from 'ts-mls'
import { describe, expect, test } from 'vitest'

import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  exportGroupInfo,
  type GroupHandle,
  inspectGroupInfo,
  joinGroupExternal,
  processWelcome,
  removeMember,
} from '../src/group.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import {
  createRecoveryRequest,
  openSealedGroupInfo,
  RecoveryRequestError,
  SealedGroupInfoError,
  sealGroupInfo,
} from '../src/recovery.js'
import type { Invite } from '../src/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Fixture = {
  publish: (invite: Invite) => void
  resolveLedgerEntries: (ids: Array<string>) => Promise<Array<string>>
}

function createFixture(): Fixture {
  const tokens = new Map<string, string>()
  return {
    publish: (invite: Invite) => {
      for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
    },
    resolveLedgerEntries: async (ids: Array<string>) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error(`unknown ledger entry ${id}`)
        return token
      }),
  }
}

/**
 * Admin invites `invitee`, commits the add, and hands the commit to every
 * `others` handle so the whole group stays at one epoch. Returns the admin's
 * post-commit handle and the invitee's fresh one.
 */
async function inviteMember(
  fixture: Fixture,
  admin: GroupHandle,
  adminIdentity: OwnIdentity,
  invitee: OwnIdentity,
  others: Array<GroupHandle> = [],
): Promise<{ admin: GroupHandle; group: GroupHandle }> {
  const { invite } = await createInvite({
    group: admin,
    identity: adminIdentity,
    recipientDID: invitee.id,
    permission: 'member',
  })
  fixture.publish(invite)
  const bundle = await createKeyPackageBundle(invitee)
  const commit = await commitInvite(admin, bundle.publicPackage, invite)
  for (const other of others) {
    await other.processMessage(commit.commitMessage)
  }
  const { group } = await processWelcome({
    identity: invitee,
    invite,
    welcome: commit.welcomeMessage,
    keyPackageBundle: bundle,
    ratchetTree: commit.newGroup.state.ratchetTree,
    options: { resolveLedgerEntries: fixture.resolveLedgerEntries },
  })
  return { admin: commit.newGroup, group }
}

/** Alice (admin) plus Bob and Carol (members), all at the same epoch. */
async function threeMemberGroup(groupID: string) {
  const fixture = createFixture()
  const alice = randomIdentity()
  const bob = randomIdentity()
  const carol = randomIdentity()

  const { group: created } = await createGroup(alice, groupID, {
    resolveLedgerEntries: fixture.resolveLedgerEntries,
  })
  const withBob = await inviteMember(fixture, created, alice, bob)
  const withCarol = await inviteMember(fixture, withBob.admin, alice, carol, [withBob.group])

  return {
    fixture,
    alice,
    bob,
    carol,
    aliceGroup: withCarol.admin,
    bobGroup: withBob.group,
    carolGroup: withCarol.group,
  }
}

/** Leaf `i` lives at node index `2i` in the RFC 9420 array-encoded ratchet tree. */
function leafPublicKey(state: ClientState, leafIndex: number): Uint8Array {
  const node = state.ratchetTree[leafIndex * 2]
  if (node == null || node.nodeType !== nodeTypes.leaf) {
    throw new Error(`no leaf node at leaf index ${leafIndex}`)
  }
  return node.leaf.hpkePublicKey
}

/** The private half of a member's own leaf key — held only in its own state. */
function ownLeafPrivateKey(state: ClientState): Uint8Array {
  const key = state.privatePath.privateKeys[state.privatePath.leafIndex * 2]
  if (key == null) throw new Error('client state holds no private key for its own leaf')
  return key
}

/** Re-sign nothing: rewrite a token's payload and keep the original signature.
 *  Asserts the payload bytes actually changed, so a rewrite that happened to be a
 *  no-op cannot masquerade as a forgery the verifier caught. */
function tamperPayload(token: string, edit: (payload: Record<string, unknown>) => void): string {
  const [header, payload, signature] = token.split('.')
  const decoded = JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8'))
  edit(decoded)
  const forged = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
  expect(forged).not.toBe(payload)
  return [header, forged, signature].join('.')
}

/** The AAD a sealed reply is bound to, rebuilt independently of the implementation:
 *  the domain separator, then each field length-framed. Lets a test hold everything
 *  a responder held except the ephemeral private key. */
function recoveryAAD(groupID: string, requesterDID: string, requestID: string): Uint8Array {
  const utf8 = new TextEncoder()
  const parts = [utf8.encode('kumiai/mls/recovery-aad/v1')]
  for (const field of [groupID, requesterDID, requestID]) {
    const bytes = utf8.encode(field)
    const framed = new Uint8Array(4 + bytes.length)
    new DataView(framed.buffer).setUint32(0, bytes.length, false)
    framed.set(bytes, 4)
    parts.push(framed)
  }
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('sealed GroupInfo recovery', () => {
  test('a sealed reply opens for its requester and feeds joinGroupExternal unchanged', async () => {
    const { fixture, bob, aliceGroup, bobGroup } = await threeMemberGroup('recovery-happy')

    const { request, ephemeralPrivateKey } = await createRecoveryRequest({
      group: bobGroup,
      identity: bob,
      requestID: 'req-1',
    })

    const sealed = await sealGroupInfo({ group: aliceGroup, request })
    const groupInfo = await openSealedGroupInfo({
      group: bobGroup,
      sealed,
      requestID: 'req-1',
      ephemeralPrivateKey,
    })

    // The plaintext is the group state the responder holds, framed as the
    // MLSMessage(GroupInfo) exportGroupInfo produces.
    const inspected = inspectGroupInfo(groupInfo)
    expect(inspected.epoch).toBe(aliceGroup.epoch)
    expect(inspected.treeHash).toEqual(aliceGroup.treeHash)
    expect(groupInfo).toEqual((await exportGroupInfo({ group: aliceGroup })).groupInfo)

    // And it feeds the external join with no adaptation: the commit it produces is
    // accepted by the group it was sealed from.
    const { commitMessage, group: bobRejoined } = await joinGroupExternal({
      identity: bob,
      groupInfo,
      credential: bobGroup.credential,
      resync: true,
      options: { resolveLedgerEntries: fixture.resolveLedgerEntries },
    })
    await aliceGroup.processMessage(commitMessage)
    expect(aliceGroup.epoch).toBe(bobRejoined.epoch)

    const message = await aliceGroup.encrypt(new TextEncoder().encode('back in the group'))
    const received = await bobRejoined.processMessage(message)
    expect(new TextDecoder().decode(received as Uint8Array)).toBe('back in the group')
  })

  // -------------------------------------------------------------------------
  // Refusal: nobody but the requester
  // -------------------------------------------------------------------------

  test('a sealed reply does not open for another member, or for a non-member holding the bytes', async () => {
    const { bob, carol, aliceGroup, bobGroup, carolGroup } =
      await threeMemberGroup('recovery-others')

    const { request, ephemeralPrivateKey } = await createRecoveryRequest({
      group: bobGroup,
      identity: bob,
      requestID: 'req-1',
    })
    const sealed = await sealGroupInfo({ group: aliceGroup, request })

    // Another member, holding her own keys: nothing she has opens it. Her own MLS
    // leaf private key is the closest thing to a "group key" she holds.
    await expect(
      openSealedGroupInfo({
        group: carolGroup,
        sealed,
        requestID: 'req-1',
        ephemeralPrivateKey: ownLeafPrivateKey(carolGroup.state),
      }),
    ).rejects.toThrow(SealedGroupInfoError)

    // Even the responder itself cannot read back what it sealed.
    await expect(
      openSealedGroupInfo({
        group: aliceGroup,
        sealed,
        requestID: 'req-1',
        ephemeralPrivateKey: ownLeafPrivateKey(aliceGroup.state),
      }),
    ).rejects.toThrow(SealedGroupInfoError)

    // And the requester's own leaf key — the key a leaf-sealing design would have
    // used — opens nothing either: the reply is bound to the ephemeral key alone.
    await expect(
      openSealedGroupInfo({
        group: bobGroup,
        sealed,
        requestID: 'req-1',
        ephemeralPrivateKey: ownLeafPrivateKey(bobGroup.state),
      }),
    ).rejects.toThrow(SealedGroupInfoError)

    // The hub holds no group state, so it cannot even form the call: it attacks the
    // bytes directly. Every input it could possibly have is granted to it — the
    // request rides the wire in the clear, so the group id, the requester's DID and
    // the request id are all known to it, and it rebuilds the exact AAD and info the
    // responder used. Only the ephemeral private key is missing, and that is enough.
    const { hpke } = aliceGroup.context.cipherSuite
    const info = new TextEncoder().encode('kumiai/mls/recovery/v1')
    const aad = recoveryAAD(bobGroup.groupID, bob.id, 'req-1')
    const enc = sealed.slice(1, 33)
    const ct = sealed.slice(33)
    const hubKeyPair = await hpke.generateKeyPair()
    await expect(hpke.open(hubKeyPair.privateKey, enc, ct, info, aad)).rejects.toThrow()

    // Positive control on the attack itself: that same reconstructed AAD and info,
    // with the ephemeral private key, do open the ciphertext. So the hub's failure is
    // the missing key — not a test that reconstructed the wrong AAD and would have
    // "passed" against any input at all.
    await expect(
      hpke.open(await hpke.importPrivateKey(ephemeralPrivateKey), enc, ct, info, aad),
    ).resolves.toBeInstanceOf(Uint8Array)

    // Sanity: the seal is sound — the requester's retained ephemeral key opens it.
    await expect(
      openSealedGroupInfo({ group: bobGroup, sealed, requestID: 'req-1', ephemeralPrivateKey }),
    ).resolves.toBeInstanceOf(Uint8Array)

    // Carol is a member in good standing; the refusal above is about the reply, not
    // about her standing — a request she signs herself is answered.
    const carolRequest = await createRecoveryRequest({
      group: carolGroup,
      identity: carol,
      requestID: 'req-2',
    })
    await expect(
      sealGroupInfo({ group: aliceGroup, request: carolRequest.request }),
    ).resolves.toBeInstanceOf(Uint8Array)
  })

  // -------------------------------------------------------------------------
  // Refusal: the AAD binds group, member, and request
  // -------------------------------------------------------------------------

  test('a reply replayed at another member does not open, even with the ephemeral key', async () => {
    const { bob, aliceGroup, bobGroup, carolGroup } =
      await threeMemberGroup('recovery-replay-member')

    const { request, ephemeralPrivateKey } = await createRecoveryRequest({
      group: bobGroup,
      identity: bob,
      requestID: 'req-1',
    })
    const sealed = await sealGroupInfo({ group: aliceGroup, request })

    // Hand Carol the ephemeral private key itself — the strongest form of the
    // replay. The AAD binds Bob's DID, which Carol's handle cannot reproduce, so
    // the AEAD refuses: the binding is cryptographic, not a field compared after
    // decryption.
    const replayed = openSealedGroupInfo({
      group: carolGroup,
      sealed,
      requestID: 'req-1',
      ephemeralPrivateKey,
    })
    await expect(replayed).rejects.toThrow(SealedGroupInfoError)
    await expect(replayed).rejects.toMatchObject({ reason: 'not-for-me' })
  })

  test('a reply sealed for one request does not open for another', async () => {
    const { bob, aliceGroup, bobGroup } = await threeMemberGroup('recovery-replay-request')

    const first = await createRecoveryRequest({
      group: bobGroup,
      identity: bob,
      requestID: 'req-1',
    })
    const second = await createRecoveryRequest({
      group: bobGroup,
      identity: bob,
      requestID: 'req-2',
    })
    const sealedForFirst = await sealGroupInfo({ group: aliceGroup, request: first.request })

    // Same member, same group, same ephemeral key — only the request id differs.
    const wrongRequest = openSealedGroupInfo({
      group: bobGroup,
      sealed: sealedForFirst,
      requestID: 'req-2',
      ephemeralPrivateKey: first.ephemeralPrivateKey,
    })
    await expect(wrongRequest).rejects.toMatchObject({ reason: 'not-for-me' })

    // And the second request's own key does not open the first request's reply.
    await expect(
      openSealedGroupInfo({
        group: bobGroup,
        sealed: sealedForFirst,
        requestID: 'req-1',
        ephemeralPrivateKey: second.ephemeralPrivateKey,
      }),
    ).rejects.toMatchObject({ reason: 'not-for-me' })

    // Both requests, answered on their own terms, still work.
    const sealedForSecond = await sealGroupInfo({ group: aliceGroup, request: second.request })
    await expect(
      openSealedGroupInfo({
        group: bobGroup,
        sealed: sealedForSecond,
        requestID: 'req-2',
        ephemeralPrivateKey: second.ephemeralPrivateKey,
      }),
    ).resolves.toBeInstanceOf(Uint8Array)
  })

  test('a request signed for another group is refused', async () => {
    const { aliceGroup } = await threeMemberGroup('recovery-group-a')

    // Bob holds a handle in a group of his own. The request it mints is validly
    // signed — it just names another group.
    const mallory = randomIdentity()
    const { group: otherGroup } = await createGroup(mallory, 'recovery-group-b')
    const { request } = await createRecoveryRequest({
      group: otherGroup,
      identity: mallory,
      requestID: 'req-1',
    })

    const refusal = sealGroupInfo({ group: aliceGroup, request })
    await expect(refusal).rejects.toThrow(RecoveryRequestError)
    await expect(refusal).rejects.toMatchObject({ reason: 'group-mismatch' })
  })

  // -------------------------------------------------------------------------
  // Refusal: authorization is the ratchet tree
  // -------------------------------------------------------------------------

  test('a requester with no leaf in the current tree is refused', async () => {
    const { carol, aliceGroup, bobGroup, carolGroup } = await threeMemberGroup('recovery-roster')

    // A DID that was never in the group. It signs a well-formed request for this
    // group id — the signature verifies; the tree is what refuses it.
    const outsider = randomIdentity()
    const { group: outsiderGroup } = await createGroup(outsider, 'recovery-roster')
    const outsiderRequest = await createRecoveryRequest({
      group: outsiderGroup,
      identity: outsider,
      requestID: 'req-1',
    })
    const outsiderRefusal = sealGroupInfo({ group: aliceGroup, request: outsiderRequest.request })
    await expect(outsiderRefusal).rejects.toThrow(RecoveryRequestError)
    await expect(outsiderRefusal).rejects.toMatchObject({ reason: 'not-a-member' })

    // A removed member is refused the same way, and by the same check: removal takes
    // her leaf out of the tree, so there is no policy for a host to forget.
    const carolLeaf = aliceGroup.findMemberLeafIndex(carol.id)
    expect(carolLeaf).toBeDefined()
    const removal = await removeMember(aliceGroup, carolLeaf as number)
    expect(removal.newGroup.findMemberLeafIndex(carol.id)).toBeUndefined()

    const carolRequest = await createRecoveryRequest({
      group: carolGroup,
      identity: carol,
      requestID: 'req-2',
    })
    const removedRefusal = sealGroupInfo({ group: removal.newGroup, request: carolRequest.request })
    await expect(removedRefusal).rejects.toThrow(RecoveryRequestError)
    await expect(removedRefusal).rejects.toMatchObject({ reason: 'not-a-member' })

    // Authorization is only as fresh as the responder's own tree. Bob has not yet
    // applied the removal, so he still answers her — the window closes for each
    // responder as it applies the commit, not the instant the removal is issued.
    await expect(
      sealGroupInfo({ group: bobGroup, request: carolRequest.request }),
    ).resolves.toBeInstanceOf(Uint8Array)
    await bobGroup.processMessage(removal.commitMessage)
    await expect(
      sealGroupInfo({ group: bobGroup, request: carolRequest.request }),
    ).rejects.toMatchObject({ reason: 'not-a-member' })
  })

  // -------------------------------------------------------------------------
  // Refusal: the signature
  // -------------------------------------------------------------------------

  test('a request with a bad signature is refused', async () => {
    const { bob, aliceGroup, bobGroup } = await threeMemberGroup('recovery-signature')

    const { request } = await createRecoveryRequest({
      group: bobGroup,
      identity: bob,
      requestID: 'req-1',
    })

    // The signature no longer covers the payload: the request id was rewritten.
    const rewritten = tamperPayload(request, (payload) => {
      payload.requestID = 'req-2'
    })
    await expect(sealGroupInfo({ group: aliceGroup, request: rewritten })).rejects.toMatchObject({
      reason: 'unverified',
    })

    // The attack the signature exists to stop: swapping the ephemeral public key in
    // a member's genuine request for the attacker's own, so the reply would be sealed
    // to a key the attacker holds. The recipient key comes from inside the signed
    // payload, so this is a forgery, not a substitution.
    const { hpke } = aliceGroup.context.cipherSuite
    const attackerKeyPair = await hpke.generateKeyPair()
    const attackerKey = await hpke.exportPublicKey(attackerKeyPair.publicKey)
    const substituted = tamperPayload(request, (payload) => {
      payload.ephemeralKey = encodeMultibase(attackerKey)
    })
    await expect(sealGroupInfo({ group: aliceGroup, request: substituted })).rejects.toMatchObject({
      reason: 'unverified',
    })

    // Impersonation: an outsider signs a request of its own, then rewrites the issuer
    // to a real member's DID — so the payload names a DID that does have a leaf, and
    // only the signature stands between it and the group's state. The verified issuer
    // is the one the signature checks against, so this is caught as a forgery and the
    // roster check is never reached.
    const mallory = randomIdentity()
    const { group: malloryGroup } = await createGroup(mallory, 'recovery-signature')
    const malloryRequest = await createRecoveryRequest({
      group: malloryGroup,
      identity: mallory,
      requestID: 'req-3',
    })
    const impersonated = tamperPayload(malloryRequest.request, (payload) => {
      payload.iss = bob.id
    })
    await expect(sealGroupInfo({ group: aliceGroup, request: impersonated })).rejects.toMatchObject(
      {
        reason: 'unverified',
      },
    )

    // Garbage is refused as unverified, not as a crash.
    await expect(
      sealGroupInfo({ group: aliceGroup, request: 'not-a-token' }),
    ).rejects.toMatchObject({ reason: 'unverified' })
  })

  test('a truncated or unversioned reply is malformed, not silently ignored', async () => {
    const { bob, aliceGroup, bobGroup } = await threeMemberGroup('recovery-frame')

    const { request, ephemeralPrivateKey } = await createRecoveryRequest({
      group: bobGroup,
      identity: bob,
      requestID: 'req-1',
    })
    const sealed = await sealGroupInfo({ group: aliceGroup, request })

    await expect(
      openSealedGroupInfo({
        group: bobGroup,
        sealed: sealed.slice(0, 20),
        requestID: 'req-1',
        ephemeralPrivateKey,
      }),
    ).rejects.toMatchObject({ reason: 'malformed' })

    const wrongVersion = sealed.slice()
    wrongVersion[0] = 2
    await expect(
      openSealedGroupInfo({
        group: bobGroup,
        sealed: wrongVersion,
        requestID: 'req-1',
        ephemeralPrivateKey,
      }),
    ).rejects.toMatchObject({ reason: 'malformed' })

    // A flipped ciphertext byte is an AEAD failure, and reads as "not mine" rather
    // than as corruption — the AEAD cannot tell the two apart, and neither can we.
    const flipped = sealed.slice()
    // biome-ignore lint/style/noNonNullAssertion: index is within bounds
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 0xff
    await expect(
      openSealedGroupInfo({
        group: bobGroup,
        sealed: flipped,
        requestID: 'req-1',
        ephemeralPrivateKey,
      }),
    ).rejects.toMatchObject({ reason: 'not-for-me' })
  })

  // -------------------------------------------------------------------------
  // The case leaf-sealing cannot serve
  // -------------------------------------------------------------------------

  test('a peer whose own commit was accepted and then lost recovers from a sealed reply', async () => {
    const fixture = createFixture()
    const alice = randomIdentity()
    const bob = randomIdentity()
    const dave = randomIdentity()

    const { group: created } = await createGroup(alice, 'recovery-stranded', {
      resolveLedgerEntries: fixture.resolveLedgerEntries,
    })
    const { admin: aliceGroup, group: bobGroup } = await inviteMember(fixture, created, alice, bob)

    // Alice commits (adding Dave) and dies before adopting the returned handle. The
    // commit reaches the hub and the hub accepts it: Bob applies it. All Alice still
    // holds is her pre-commit handle — and the leaf private key that commit replaced.
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: dave.id,
      permission: 'member',
    })
    fixture.publish(invite)
    const daveBundle = await createKeyPackageBundle(dave)
    const accepted = await commitInvite(aliceGroup, daveBundle.publicPackage, invite)
    await bobGroup.processMessage(accepted.commitMessage)
    expect(bobGroup.epoch).toBe(2n)
    expect(aliceGroup.epoch).toBe(1n)

    const aliceLeaf = bobGroup.findMemberLeafIndex(alice.id)
    expect(aliceLeaf).toBeDefined()

    // Her leaf in the tree every responder sees is not the leaf whose private half
    // she holds: her own commit rotated it, and the new private key died with the
    // handle she never adopted. A reply sealed to her leaf would be unopenable —
    // this is the peer leaf-sealing strands.
    const staleLeafPrivateKey = ownLeafPrivateKey(aliceGroup.state)
    const treeLeafPublicKey = leafPublicKey(bobGroup.state, aliceLeaf as number)
    expect(treeLeafPublicKey).not.toEqual(leafPublicKey(aliceGroup.state, aliceLeaf as number))

    // Recovery: she mints a fresh ephemeral keypair, signs the request with the DID
    // identity key her crash did not touch, and Bob seals to that key.
    const { request, ephemeralPrivateKey } = await createRecoveryRequest({
      group: aliceGroup,
      identity: alice,
      requestID: 'heal-1',
    })
    const sealed = await sealGroupInfo({ group: bobGroup, request })

    // The stale leaf key she still holds opens nothing — the contrast that justifies
    // the ephemeral key.
    await expect(
      openSealedGroupInfo({
        group: aliceGroup,
        sealed,
        requestID: 'heal-1',
        ephemeralPrivateKey: staleLeafPrivateKey,
      }),
    ).rejects.toMatchObject({ reason: 'not-for-me' })

    // The ephemeral key does. She gets the GroupInfo at the epoch her own lost commit
    // produced, and rejoins with a fresh leaf.
    const groupInfo = await openSealedGroupInfo({
      group: aliceGroup,
      sealed,
      requestID: 'heal-1',
      ephemeralPrivateKey,
    })
    expect(inspectGroupInfo(groupInfo).epoch).toBe(bobGroup.epoch)

    const { commitMessage, group: aliceRejoined } = await joinGroupExternal({
      identity: alice,
      groupInfo,
      credential: aliceGroup.credential,
      resync: true,
      options: { resolveLedgerEntries: fixture.resolveLedgerEntries },
    })
    await bobGroup.processMessage(commitMessage)
    expect(bobGroup.epoch).toBe(3n)
    expect(aliceRejoined.epoch).toBe(bobGroup.epoch)
    expect(aliceRejoined.treeHash).toEqual(bobGroup.treeHash)

    // She is back: traffic flows both ways at the new epoch, which no amount of
    // ledger-policy short-circuiting could fake.
    const fromBob = await bobGroup.encrypt(new TextEncoder().encode('you are back'))
    expect(
      new TextDecoder().decode((await aliceRejoined.processMessage(fromBob)) as Uint8Array),
    ).toBe('you are back')
    const fromAlice = await aliceRejoined.encrypt(new TextEncoder().encode('thanks'))
    expect(new TextDecoder().decode((await bobGroup.processMessage(fromAlice)) as Uint8Array)).toBe(
      'thanks',
    )
  })
})
