import {
  encodeMultibase,
  normalizeDID,
  type OwnIdentity,
  randomIdentity,
  stringifyToken,
} from '@kokuin/token'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  type ClientState,
  createCommit,
  defaultProposalTypes,
  type GroupContextExtension,
  generateKeyPackageWithKey,
  type KeyPackage,
  type MlsContext,
  makeCustomExtension,
  createGroup as mlsCreateGroup,
} from 'ts-mls'
import { describe, expect, test } from 'vitest'

import {
  buildCurrentGroupAnchorExtension,
  controlCapabilities,
  GROUP_ANCHOR_EXTENSION_TYPE,
  readGroupAnchorExtension,
} from '../src/anchor.js'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  exportGroupInfo,
  GroupHandle,
  joinGroupExternal,
  makeMLSCredential,
  processWelcome,
  removeMember,
} from '../src/group.js'
import { buildLedgerHeadExtension, genesisHead } from '../src/head.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import {
  createRecoveryRequest,
  openSealedGroupInfo,
  RECOVERY_GROUPINFO_TYPE,
  SEALED_GROUP_INFO_VERSION,
  SealedGroupInfoError,
  sealGroupInfo,
} from '../src/recovery.js'
import type { Invite } from '../src/types.js'

// ---------------------------------------------------------------------------
// The recovery rendezvous seals its GroupInfo reply in HPKE base mode over an
// AAD whose every field — group id, requester DID, request id, ephemeral public
// key — rides the public request in the clear. Base mode needs only the public
// ephemeral key, so an observer of one request can seal a reply that OPENS. On
// the GroupInfo path that used to be a full compromise: nothing bound the offered
// GroupInfo to the group being healed, and the peer's own completeness invariant
// certified the hijack as healthy.
//
// Two mechanisms close it, and they are not alternatives:
//   (a) the offered GroupInfo's group id and immutable genesis anchor must match
//       the group being healed — byte comparisons the requester already holds;
//   (b) the responder must prove membership: it signs the reply with its DID
//       identity key, and the open side requires the signer to hold a leaf in the
//       requester's own last-known ratchet tree.
//
// These tests forge replies exactly as an attacker would — hpke.seal directly over
// the wire-reconstructed AAD and info — and assert each attacker class is refused.
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder()

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

/** Alice (admin) plus Bob and Carol (members), all at one epoch. */
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

/** The AAD a sealed GroupInfo reply is bound to, rebuilt from the PUBLIC request
 *  fields alone — exactly what an observer reconstructs off the wire. */
function recoveryAAD(groupID: string, requesterDID: string, requestID: string): Uint8Array {
  const parts = [utf8.encode('kumiai/mls/recovery-aad/v1')]
  for (const field of [groupID, normalizeDID(requesterDID), requestID]) {
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

/**
 * Build a forged control group under `groupID` carrying `anchorExtension`, its ledger
 * head parked at genesis, with `splice`d into its tree as a second leaf. Raw ts-mls,
 * so the anchor is whatever the attacker chooses — including a byte copy of the real
 * one, which `createGroup` would refuse. The genesis head is what makes the victim's
 * empty-ledger completeness invariant read `true`.
 */
async function forgeGroupState(opts: {
  creator: OwnIdentity
  groupID: string
  anchorExtension: GroupContextExtension
  context: MlsContext
  splice: KeyPackage
}): Promise<ClientState> {
  const extensions = [opts.anchorExtension, buildLedgerHeadExtension(genesisHead(opts.groupID))]
  const creatorPackage = await generateKeyPackageWithKey({
    credential: makeMLSCredential(opts.creator),
    signatureKeyPair: { signKey: opts.creator.privateKey, publicKey: opts.creator.publicKey },
    cipherSuite: opts.context.cipherSuite,
    capabilities: controlCapabilities(),
  })
  const state = await mlsCreateGroup({
    context: opts.context,
    groupId: utf8.encode(opts.groupID),
    keyPackage: creatorPackage.publicPackage,
    privateKeyPackage: creatorPackage.privatePackage,
    extensions,
  })
  // A plain Add — no control envelope, no group-context-extensions proposal — so the
  // ledger head stays at genesis. A key_package-source leaf binds neither group id nor
  // leaf index, so the victim's published key package splices straight in.
  const added = await createCommit({
    context: opts.context,
    state,
    extraProposals: [{ proposalType: defaultProposalTypes.add, add: { keyPackage: opts.splice } }],
    ratchetTreeExtension: true,
  })
  return added.newState
}

/**
 * Seal a forged GroupInfo reply the way an observer of the request would: hpke.seal
 * directly over the AAD and info reconstructed from the public request, with an
 * attestation the attacker signs with its OWN DID key framed in front of the bytes.
 * No real group state is touched.
 */
async function sealForgedReply(opts: {
  requesterGroup: GroupHandle
  signer: OwnIdentity
  ephemeralPublicKey: Uint8Array
  groupID: string
  requesterDID: string
  requestID: string
  groupInfo: Uint8Array
}): Promise<Uint8Array> {
  const signed = await opts.signer.signToken(
    {
      type: RECOVERY_GROUPINFO_TYPE,
      groupID: opts.groupID,
      requestID: opts.requestID,
      groupInfoDigest: encodeMultibase(sha256(opts.groupInfo)),
    },
    { embedLongForm: true },
  )
  const token = utf8.encode(stringifyToken(signed))
  const plaintext = new Uint8Array(4 + token.length + opts.groupInfo.length)
  new DataView(plaintext.buffer).setUint32(0, token.length, false)
  plaintext.set(token, 4)
  plaintext.set(opts.groupInfo, 4 + token.length)

  const { hpke } = opts.requesterGroup.context.cipherSuite
  const info = utf8.encode('kumiai/mls/recovery/v1')
  const aad = recoveryAAD(opts.groupID, opts.requesterDID, opts.requestID)
  const { ct, enc } = await hpke.seal(
    await hpke.importPublicKey(opts.ephemeralPublicKey),
    plaintext,
    info,
    aad,
  )
  const sealed = new Uint8Array(1 + enc.length + ct.length)
  sealed[0] = SEALED_GROUP_INFO_VERSION
  sealed.set(enc, 1)
  sealed.set(ct, 1 + enc.length)
  return sealed
}

async function exportForged(
  state: ClientState,
  creator: OwnIdentity,
  groupID: string,
  context: MlsContext,
  cache: GroupHandle['cache'],
): Promise<Uint8Array> {
  const handle = new GroupHandle({
    state,
    credential: { id: creator.id, groupID },
    context,
    cache,
  })
  return (await exportGroupInfo({ group: handle })).groupInfo
}

describe('a forged GroupInfo reply is refused', () => {
  test('(b) an observer with no group state cannot answer: not in the requester tree', async () => {
    const { bob, bobGroup, carolGroup } = await threeMemberGroup('forgery-never-member')
    const mallory = randomIdentity()

    const { request, ephemeralPublicKey, ephemeralPrivateKey } = await createRecoveryRequest({
      group: bobGroup,
      identity: bob,
      requestID: 'heal-1',
    })
    void request

    // Mallory fabricates a group under the same id, with its OWN anchor, splicing bob's
    // published key package, and signs the attestation with its own DID key.
    const bobBundle = await createKeyPackageBundle(bob)
    const state = await forgeGroupState({
      creator: mallory,
      groupID: bobGroup.groupID,
      anchorExtension: buildCurrentGroupAnchorExtension(mallory.id),
      context: carolGroup.context,
      splice: bobBundle.publicPackage,
    })
    const forgedGroupInfo = await exportForged(
      state,
      mallory,
      bobGroup.groupID,
      carolGroup.context,
      carolGroup.cache,
    )
    const sealed = await sealForgedReply({
      requesterGroup: bobGroup,
      signer: mallory,
      ephemeralPublicKey,
      groupID: bobGroup.groupID,
      requesterDID: bob.id,
      requestID: 'heal-1',
      groupInfo: forgedGroupInfo,
    })

    const opening = openSealedGroupInfo({
      group: bobGroup,
      sealed,
      requestID: 'heal-1',
      ephemeralPrivateKey,
    })
    await expect(opening).rejects.toThrow(SealedGroupInfoError)
    // Caught by (b): mallory holds no leaf in bob's tree. (a) would refuse it too — its
    // anchor is mallory's, not the real one — so neither check alone is what saves bob here.
    await expect(opening).rejects.toMatchObject({ reason: 'unauthenticated' })
  })

  test('(a) a current member cannot redirect a healer to a different group', async () => {
    const { carol, bob, bobGroup, carolGroup } = await threeMemberGroup('forgery-wrong-anchor')

    // Carol is a member in good standing — she holds a leaf in bob's tree, so she passes the
    // responder check. She forges a group under the right id but her OWN anchor, and signs the
    // attestation honestly as herself.
    const { ephemeralPublicKey, ephemeralPrivateKey } = await createRecoveryRequest({
      group: bobGroup,
      identity: bob,
      requestID: 'heal-1',
    })
    const bobBundle = await createKeyPackageBundle(bob)
    const state = await forgeGroupState({
      creator: carol,
      groupID: bobGroup.groupID,
      anchorExtension: buildCurrentGroupAnchorExtension(carol.id),
      context: carolGroup.context,
      splice: bobBundle.publicPackage,
    })
    const forgedGroupInfo = await exportForged(
      state,
      carol,
      bobGroup.groupID,
      carolGroup.context,
      carolGroup.cache,
    )
    const sealed = await sealForgedReply({
      requesterGroup: bobGroup,
      signer: carol,
      ephemeralPublicKey,
      groupID: bobGroup.groupID,
      requesterDID: bob.id,
      requestID: 'heal-1',
      groupInfo: forgedGroupInfo,
    })

    const opening = openSealedGroupInfo({
      group: bobGroup,
      sealed,
      requestID: 'heal-1',
      ephemeralPrivateKey,
    })
    await expect(opening).rejects.toThrow(SealedGroupInfoError)
    // The responder check passes — carol IS in bob's tree. Only the anchor binding (a) refuses
    // her: the fabricated group's anchor is not the one bob already holds.
    await expect(opening).rejects.toMatchObject({ reason: 'group-mismatch' })
  })

  test('(b) a removed member cannot answer, even holding the real anchor and the victim leaf', async () => {
    const { alice, carol, bob, aliceGroup, bobGroup, carolGroup } =
      await threeMemberGroup('forgery-removed-member')

    // Carol is removed, and bob APPLIES the removal — carol is now absent from bob's own tree.
    const carolLeaf = aliceGroup.findMemberLeafIndex(carol.id)
    expect(carolLeaf).toBeDefined()
    const removal = await removeMember(aliceGroup, carolLeaf as number)
    await bobGroup.processMessage(removal.commitMessage)
    expect(bobGroup.findMemberLeafIndex(carol.id)).toBeUndefined()

    const { ephemeralPublicKey, ephemeralPrivateKey } = await createRecoveryRequest({
      group: bobGroup,
      identity: bob,
      requestID: 'heal-1',
    })

    // Carol still holds the real anchor from her membership — a byte copy passes (a). She
    // fabricates a group with it, splices bob's leaf, and signs the attestation as herself.
    const realAnchor = readGroupAnchorExtension(bobGroup)
    expect(realAnchor).not.toBeNull()
    const anchorCopy = makeCustomExtension({
      extensionType: GROUP_ANCHOR_EXTENSION_TYPE,
      extensionData: (realAnchor as GroupContextExtension).extensionData as Uint8Array,
    })
    const bobBundle = await createKeyPackageBundle(bob)
    const state = await forgeGroupState({
      creator: carol,
      groupID: bobGroup.groupID,
      anchorExtension: anchorCopy,
      context: carolGroup.context,
      splice: bobBundle.publicPackage,
    })
    const forgedGroupInfo = await exportForged(
      state,
      carol,
      bobGroup.groupID,
      carolGroup.context,
      carolGroup.cache,
    )
    const sealed = await sealForgedReply({
      requesterGroup: bobGroup,
      signer: carol,
      ephemeralPublicKey,
      groupID: bobGroup.groupID,
      requesterDID: bob.id,
      requestID: 'heal-1',
      groupInfo: forgedGroupInfo,
    })

    const opening = openSealedGroupInfo({
      group: bobGroup,
      sealed,
      requestID: 'heal-1',
      ephemeralPrivateKey,
    })
    await expect(opening).rejects.toThrow(SealedGroupInfoError)
    // (a) passes — the anchor is the real one. Only the responder check (b) refuses carol:
    // her removal took her leaf out of bob's tree.
    await expect(opening).rejects.toMatchObject({ reason: 'unauthenticated' })
    void alice
  })

  test('an honest heal still works, and names the responders the fix now refuses', async () => {
    const fixture = createFixture()
    const alice = randomIdentity()
    const bob = randomIdentity()
    const dave = randomIdentity()

    const { group: created } = await createGroup(alice, 'forgery-availability', {
      resolveLedgerEntries: fixture.resolveLedgerEntries,
    })
    const withBob = await inviteMember(fixture, created, alice, bob)
    let aliceGroup = withBob.admin
    const bobGroup = withBob.group

    // Bob heals. His last-known tree is {alice, bob}. Alice is in it.
    const { request, ephemeralPrivateKey } = await createRecoveryRequest({
      group: bobGroup,
      identity: bob,
      requestID: 'heal-1',
    })

    // An honest responder present in bob's last-known tree heals him — even though her own
    // tree has since moved on: the check is against BOB's tree, and alice is in it.
    const withDave = await inviteMember(fixture, aliceGroup, alice, dave, [])
    aliceGroup = withDave.admin
    const daveGroup = withDave.group

    const honest = await sealGroupInfo({ group: aliceGroup, identity: alice, request })
    const groupInfo = await openSealedGroupInfo({
      group: bobGroup,
      sealed: honest,
      requestID: 'heal-1',
      ephemeralPrivateKey,
    })
    const { commitMessage, group: bobRejoined } = await joinGroupExternal({
      identity: bob,
      groupInfo,
      credential: bobGroup.credential,
      resync: true,
      options: { resolveLedgerEntries: fixture.resolveLedgerEntries },
    })
    await aliceGroup.processMessage(commitMessage)
    expect(bobRejoined.epoch).toBe(aliceGroup.epoch)
    const traffic = await aliceGroup.encrypt(utf8.encode('welcome back'))
    expect(
      new TextDecoder().decode((await bobRejoined.processMessage(traffic)) as Uint8Array),
    ).toBe('welcome back')

    // The residual availability cost, named: a responder who joined AFTER bob's last-known
    // epoch is NOT in bob's stale tree, so the fix refuses her honest reply. In a group whose
    // only online member joined after the requester left, heal is unavailable until a
    // still-known member comes online.
    const daveRequest = await createRecoveryRequest({
      group: bobGroup,
      identity: bob,
      requestID: 'heal-2',
    })
    const fromDave = await sealGroupInfo({
      group: daveGroup,
      identity: dave,
      request: daveRequest.request,
    })
    const refusedDave = openSealedGroupInfo({
      group: bobGroup,
      sealed: fromDave,
      requestID: 'heal-2',
      ephemeralPrivateKey: daveRequest.ephemeralPrivateKey,
    })
    await expect(refusedDave).rejects.toMatchObject({ reason: 'unauthenticated' })
  })
})
