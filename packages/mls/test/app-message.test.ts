import { randomIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  type GroupHandle,
  processWelcome,
  readMessageEpoch,
  removeMember,
} from '../src/group.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import type { Invite } from '../src/types.js'

const utf8 = new TextEncoder()

async function twoMemberGroup(groupID: string) {
  const alice = randomIdentity()
  const bob = randomIdentity()
  const tokens = new Map<string, string>()
  const resolveLedgerEntries = async (ids: Array<string>) =>
    ids.map((id) => {
      const token = tokens.get(id)
      if (token == null) throw new Error(`unknown ledger entry ${id}`)
      return token
    })
  const publish = (invite: Invite) => {
    for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
  }

  const { group: created } = await createGroup(alice, groupID, { resolveLedgerEntries })
  const { invite } = await createInvite({
    group: created,
    identity: alice,
    recipientDID: bob.id,
    permission: 'member',
  })
  publish(invite)
  const bundle = await createKeyPackageBundle(bob)
  const added = await commitInvite(created, bundle.publicPackage, invite)
  const { group: bobGroup } = await processWelcome({
    identity: bob,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: bundle,
    ratchetTree: added.newGroup.state.ratchetTree,
    options: { resolveLedgerEntries },
  })
  return { alice, bob, aliceGroup: added.newGroup, bobGroup }
}

describe('GroupHandle.decrypt', () => {
  test('opens a peer application message and names its authenticated sender', async () => {
    const { alice, aliceGroup, bobGroup } = await twoMemberGroup('app-message-roundtrip')

    const sealed = await aliceGroup.encrypt(utf8.encode('hello from alice'))
    const opened = await bobGroup.decrypt(sealed)

    expect(new TextDecoder().decode(opened.payload)).toBe('hello from alice')
    // The DID comes from Bob's own ratchet tree at the leaf the AEAD vouched for, not
    // from anything the frame carried.
    expect(opened.senderDID).toBe(alice.id)
  })

  test('refuses a frame sealed at an epoch this handle does not hold', async () => {
    const { aliceGroup, bobGroup } = await twoMemberGroup('app-message-epoch')

    const sealedAtOne = await aliceGroup.encrypt(utf8.encode('epoch one'))
    expect(readMessageEpoch(sealedAtOne)).toBe(1n)

    // Alice removes Bob and ratchets to epoch 2. Bob never applies it.
    const removed = await removeMember(aliceGroup, 1)
    expect(removed.newGroup.epoch).toBe(2n)
    const sealedAtTwo = await removed.newGroup.encrypt(utf8.encode('epoch two'))
    expect(readMessageEpoch(sealedAtTwo)).toBe(2n)

    // Bob, still at epoch 1, cannot open the post-removal frame. The throw is how the
    // frame says "not my epoch" — it is not a claim the bytes are corrupt.
    expect(bobGroup.epoch).toBe(1n)
    await expect(bobGroup.decrypt(sealedAtTwo)).rejects.toThrow()

    // And the handle that HAS ratcheted past epoch 1 cannot go back for the epoch-1 frame.
    await expect(removed.newGroup.decrypt(sealedAtOne)).rejects.toThrow()
  })

  test('refuses bytes that are not an application frame', async () => {
    const { aliceGroup, bobGroup } = await twoMemberGroup('app-message-not-app')
    const removed = await removeMember(aliceGroup, 1)
    // A commit is a PrivateMessage too, and readMessageEpoch answers for it — but it is
    // not this handle's to open as application bytes.
    await expect(bobGroup.decrypt(removed.commitMessage)).rejects.toThrow(
      'not a PrivateMessage application frame',
    )
    await expect(bobGroup.decrypt(new Uint8Array([1, 2, 3]))).rejects.toThrow()
  })
})

/** Guards the claim `decrypt`'s doc makes about a caller walking a mixed log. */
describe('GroupHandle.decrypt against a retained log', () => {
  test('a stale handle can tell a frame it has not reached from one it can never open', async () => {
    const { aliceGroup, bobGroup } = await twoMemberGroup('app-message-log-walk')

    const atOne = await aliceGroup.encrypt(utf8.encode('one'))
    const removed = await removeMember(aliceGroup, 1)
    const atTwo = await removed.newGroup.encrypt(utf8.encode('two'))

    // Bob at epoch 1 opens the frame at his epoch and refuses the one above it — and
    // readMessageEpoch, which needs no key at all, tells him which is which.
    expect(bobGroup.epoch).toBe(1n)
    expect(readMessageEpoch(atOne)).toBe(1n)
    expect(readMessageEpoch(atTwo)).toBe(2n)
    await expect(bobGroup.decrypt(atOne)).resolves.toMatchObject({})
    await expect(bobGroup.decrypt(atTwo)).rejects.toThrow()
  })
})

/** Keeps the type surface honest: decrypt is the declared counterpart of encrypt. */
export type _DecryptShape = ReturnType<GroupHandle['decrypt']>
