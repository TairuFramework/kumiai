import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import type { ClientState } from 'ts-mls'
import { describe, expect, test } from 'vitest'

import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  type GroupHandle,
  processWelcome,
  removeMember,
} from '../src/group.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import {
  createRecoveryRequest,
  openSealedGroupInfo,
  openSealedLedger,
  RecoveryRequestError,
  SealedGroupInfoError,
  SealedLedgerError,
  sealGroupInfo,
  sealLedger,
} from '../src/recovery.js'
import type { Invite } from '../src/types.js'

// ---------------------------------------------------------------------------
// Fixtures — the same three-member group the GroupInfo rendezvous is tested on.
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

/** The private half of a member's own leaf key — held only in its own state. */
function ownLeafPrivateKey(state: ClientState): Uint8Array {
  const key = state.privatePath.privateKeys[state.privatePath.leafIndex * 2]
  if (key == null) throw new Error('client state holds no private key for its own leaf')
  return key
}

/** The AAD a sealed LEDGER reply is bound to, rebuilt independently of the implementation —
 *  the ledger's own domain separator, then each field length-framed. Lets a test hold
 *  everything a responder held except the ephemeral private key. */
function ledgerAAD(groupID: string, requesterDID: string, requestID: string): Uint8Array {
  const utf8 = new TextEncoder()
  const parts = [utf8.encode('kumiai/mls/recovery-ledger-aad/v1')]
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

/** The group's whole ordered authority state — every role, every promotion, every demotion. */
const LEDGER = ['role:carol=admin', 'role:dave=member', 'role:carol=member']

describe('sealed ledger gather', () => {
  test('a sealed ledger opens for its requester, in order, and for nobody else', async () => {
    const { bob, aliceGroup, bobGroup, carolGroup } = await threeMemberGroup('ledger-happy')

    const { request, ephemeralPrivateKey } = await createRecoveryRequest({
      group: bobGroup,
      identity: bob,
      requestID: 'req-1',
    })
    const sealed = await sealLedger({ group: aliceGroup, request, entries: LEDGER })

    // The order comes back as it went in: the head is a chain digest, so a permuted list of
    // the same tokens folds to a different head and the caller's head check rejects it.
    await expect(
      openSealedLedger({ group: bobGroup, sealed, requestID: 'req-1', ephemeralPrivateKey }),
    ).resolves.toEqual(LEDGER)

    // Another member, holding her own keys — her MLS leaf private key is the closest thing to
    // a "group key" she has — opens nothing.
    await expect(
      openSealedLedger({
        group: carolGroup,
        sealed,
        requestID: 'req-1',
        ephemeralPrivateKey: ownLeafPrivateKey(carolGroup.state),
      }),
    ).rejects.toThrow(SealedLedgerError)

    // Neither does the responder that sealed it, nor the requester's own leaf key — the key a
    // leaf-sealing design would have used. The reply is bound to the ephemeral key alone.
    await expect(
      openSealedLedger({
        group: aliceGroup,
        sealed,
        requestID: 'req-1',
        ephemeralPrivateKey: ownLeafPrivateKey(aliceGroup.state),
      }),
    ).rejects.toThrow(SealedLedgerError)
    await expect(
      openSealedLedger({
        group: bobGroup,
        sealed,
        requestID: 'req-1',
        ephemeralPrivateKey: ownLeafPrivateKey(bobGroup.state),
      }),
    ).rejects.toMatchObject({ reason: 'not-for-me' })
  })

  test('the hub holds every input but the key, and the ledger stays shut', async () => {
    const { bob, aliceGroup, bobGroup } = await threeMemberGroup('ledger-hub')

    const { request, ephemeralPrivateKey } = await createRecoveryRequest({
      group: bobGroup,
      identity: bob,
      requestID: 'req-1',
    })
    const sealed = await sealLedger({ group: aliceGroup, request, entries: LEDGER })

    // The hub holds no group state, so it cannot even form the call: it attacks the bytes.
    // Every input it could actually have is granted to it — the request rides the wire in the
    // clear, so the group id, the requester's DID and the request id are all known to it, and
    // it rebuilds the exact AAD and info the responder used. Only the ephemeral private key is
    // missing, and that is enough.
    const { hpke } = aliceGroup.context.cipherSuite
    const info = new TextEncoder().encode('kumiai/mls/recovery-ledger/v1')
    const aad = ledgerAAD(bobGroup.groupID, bob.id, 'req-1')
    const enc = sealed.slice(1, 33)
    const ct = sealed.slice(33)
    const hubKeyPair = await hpke.generateKeyPair()
    await expect(hpke.open(hubKeyPair.privateKey, enc, ct, info, aad)).rejects.toThrow()

    // Positive control on the attack itself: that same reconstructed AAD and info, with the
    // ephemeral private key, DO open the ciphertext. So the hub's failure is the missing key —
    // not a test that reconstructed the wrong AAD and would have "passed" against any input.
    await expect(
      hpke.open(await hpke.importPrivateKey(ephemeralPrivateKey), enc, ct, info, aad),
    ).resolves.toBeInstanceOf(Uint8Array)

    // And the plaintext is nowhere in the frame: the tokens are the bodies the commit lane
    // seals under the epoch secret, and the heal lane gives the relay no more than it does.
    const wire = new TextDecoder().decode(sealed)
    for (const token of LEDGER) expect(wire).not.toContain(token)
  })

  test('a sealed GroupInfo does not open as a ledger, and a sealed ledger does not open as a GroupInfo', async () => {
    const { alice, bob, aliceGroup, bobGroup } = await threeMemberGroup('ledger-domain')

    // ONE request: the same group, the same member, the same request id, and the same ephemeral
    // key. So the AADs differ in nothing but the domain — the separation cannot be coming from
    // the request ids happening to differ, which is what a caller could stop being true.
    const { request, ephemeralPrivateKey } = await createRecoveryRequest({
      group: bobGroup,
      identity: bob,
      requestID: 'req-1',
    })
    const sealedGroupInfo = await sealGroupInfo({ group: aliceGroup, identity: alice, request })
    const sealedLedger = await sealLedger({ group: aliceGroup, request, entries: LEDGER })

    const asLedger = openSealedLedger({
      group: bobGroup,
      sealed: sealedGroupInfo,
      requestID: 'req-1',
      ephemeralPrivateKey,
    })
    await expect(asLedger).rejects.toThrow(SealedLedgerError)
    // `not-for-me`, and not `malformed`: the AEAD refuses before a byte of plaintext exists.
    // A design that separated the two by inspecting what came out would have had to decrypt it
    // first.
    await expect(asLedger).rejects.toMatchObject({ reason: 'not-for-me' })

    const asGroupInfo = openSealedGroupInfo({
      group: bobGroup,
      sealed: sealedLedger,
      requestID: 'req-1',
      ephemeralPrivateKey,
    })
    await expect(asGroupInfo).rejects.toThrow(SealedGroupInfoError)
    await expect(asGroupInfo).rejects.toMatchObject({ reason: 'not-for-me' })

    // Each still opens as what it is: the refusals above are the domains, not a broken seal.
    await expect(
      openSealedLedger({
        group: bobGroup,
        sealed: sealedLedger,
        requestID: 'req-1',
        ephemeralPrivateKey,
      }),
    ).resolves.toEqual(LEDGER)
    await expect(
      openSealedGroupInfo({
        group: bobGroup,
        sealed: sealedGroupInfo,
        requestID: 'req-1',
        ephemeralPrivateKey,
      }),
    ).resolves.toBeInstanceOf(Uint8Array)
  })

  test('a requester with no leaf in the current tree is refused the ledger', async () => {
    const { carol, aliceGroup, bobGroup, carolGroup } = await threeMemberGroup('ledger-roster')

    // A DID that was never in the group. Its request is validly signed for this group id — the
    // signature verifies; the tree is what refuses it. A seal WITHOUT this check would hand the
    // group's whole authority state to any stranger, encrypted neatly to the stranger's key.
    const outsider = randomIdentity()
    const { group: outsiderGroup } = await createGroup(outsider, 'ledger-roster')
    const outsiderRequest = await createRecoveryRequest({
      group: outsiderGroup,
      identity: outsider,
      requestID: 'req-1',
    })
    const refusal = sealLedger({
      group: aliceGroup,
      request: outsiderRequest.request,
      entries: LEDGER,
    })
    await expect(refusal).rejects.toThrow(RecoveryRequestError)
    await expect(refusal).rejects.toMatchObject({ reason: 'not-a-member' })

    // A removed member is refused by the same check, and by nothing else: removal takes her
    // leaf out of the tree, so there is no policy for a host to forget.
    const carolLeaf = aliceGroup.findMemberLeafIndex(carol.id)
    expect(carolLeaf).toBeDefined()
    const removal = await removeMember(aliceGroup, carolLeaf as number)
    const carolRequest = await createRecoveryRequest({
      group: carolGroup,
      identity: carol,
      requestID: 'req-2',
    })
    await expect(
      sealLedger({ group: removal.newGroup, request: carolRequest.request, entries: LEDGER }),
    ).rejects.toMatchObject({ reason: 'not-a-member' })

    // Authorization is only as fresh as the responder's own tree: bob has not applied the
    // removal, so he still answers her. The window closes for each responder as it applies the
    // commit, and not the instant the removal is issued.
    await expect(
      sealLedger({ group: bobGroup, request: carolRequest.request, entries: LEDGER }),
    ).resolves.toBeInstanceOf(Uint8Array)
    await bobGroup.processMessage(removal.commitMessage)
    await expect(
      sealLedger({ group: bobGroup, request: carolRequest.request, entries: LEDGER }),
    ).rejects.toMatchObject({ reason: 'not-a-member' })

    // Garbage, and a request signed for another group, are refused too — the ledger gather is
    // authorized on exactly the terms the GroupInfo rendezvous is.
    await expect(
      sealLedger({ group: aliceGroup, request: 'not-a-token', entries: LEDGER }),
    ).rejects.toMatchObject({ reason: 'unverified' })
    const { group: elsewhere } = await createGroup(outsider, 'ledger-roster-other')
    const elsewhereRequest = await createRecoveryRequest({
      group: elsewhere,
      identity: outsider,
      requestID: 'req-3',
    })
    await expect(
      sealLedger({ group: aliceGroup, request: elsewhereRequest.request, entries: LEDGER }),
    ).rejects.toMatchObject({ reason: 'group-mismatch' })
  })

  test('a reply sealed for one request does not open for another', async () => {
    const { bob, aliceGroup, bobGroup } = await threeMemberGroup('ledger-request')

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
    const sealed = await sealLedger({ group: aliceGroup, request: first.request, entries: LEDGER })

    // Same member, same group, same ephemeral key — only the request id differs.
    await expect(
      openSealedLedger({
        group: bobGroup,
        sealed,
        requestID: 'req-2',
        ephemeralPrivateKey: first.ephemeralPrivateKey,
      }),
    ).rejects.toMatchObject({ reason: 'not-for-me' })

    // And the other request's key does not open this one's reply.
    await expect(
      openSealedLedger({
        group: bobGroup,
        sealed,
        requestID: 'req-1',
        ephemeralPrivateKey: second.ephemeralPrivateKey,
      }),
    ).rejects.toMatchObject({ reason: 'not-for-me' })
  })

  test('an empty ledger seals and opens as an empty ledger', async () => {
    const { bob, aliceGroup, bobGroup } = await threeMemberGroup('ledger-empty')

    // A group whose ledger is genuinely empty is not the same thing as a peer that could not
    // gather one, and the codec must not blur them: the head check is what tells them apart.
    const { request, ephemeralPrivateKey } = await createRecoveryRequest({
      group: bobGroup,
      identity: bob,
      requestID: 'req-1',
    })
    const sealed = await sealLedger({ group: aliceGroup, request, entries: [] })
    await expect(
      openSealedLedger({ group: bobGroup, sealed, requestID: 'req-1', ephemeralPrivateKey }),
    ).resolves.toEqual([])
  })

  test('a truncated or unversioned reply is malformed, not silently ignored', async () => {
    const { bob, aliceGroup, bobGroup } = await threeMemberGroup('ledger-frame')

    const { request, ephemeralPrivateKey } = await createRecoveryRequest({
      group: bobGroup,
      identity: bob,
      requestID: 'req-1',
    })
    const sealed = await sealLedger({ group: aliceGroup, request, entries: LEDGER })

    await expect(
      openSealedLedger({
        group: bobGroup,
        sealed: sealed.slice(0, 20),
        requestID: 'req-1',
        ephemeralPrivateKey,
      }),
    ).rejects.toMatchObject({ reason: 'malformed' })

    const wrongVersion = sealed.slice()
    wrongVersion[0] = 2
    await expect(
      openSealedLedger({
        group: bobGroup,
        sealed: wrongVersion,
        requestID: 'req-1',
        ephemeralPrivateKey,
      }),
    ).rejects.toMatchObject({ reason: 'malformed' })

    // A flipped ciphertext byte is an AEAD failure, and reads as "not mine" rather than as
    // corruption — the AEAD cannot tell the two apart, and neither can we.
    const flipped = sealed.slice()
    // biome-ignore lint/style/noNonNullAssertion: index is within bounds
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 0xff
    await expect(
      openSealedLedger({
        group: bobGroup,
        sealed: flipped,
        requestID: 'req-1',
        ephemeralPrivateKey,
      }),
    ).rejects.toMatchObject({ reason: 'not-for-me' })
  })
})
