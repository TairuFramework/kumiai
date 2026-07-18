import { randomIdentity } from '@kokuin/token'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  type GroupHandle,
  type Invite,
  ledgerEntryDigest,
  processWelcome,
  removeMember,
} from '@kumiai/mls'
import { describe, expect, test } from 'vitest'

import { createGroupCrypto } from '../src/crypto.js'

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

/** A crypto over a handle slot, so a test can swap the handle the way a peer does. */
function cryptoOver(initial: GroupHandle) {
  let handle = initial
  return {
    crypto: createGroupCrypto({ handle: () => handle }),
    adopt: (next: GroupHandle) => {
      handle = next
    },
    current: () => handle,
  }
}

describe('createGroupCrypto', () => {
  test('epoch and exportSecret follow the live handle, and every member at an epoch agrees', async () => {
    const { aliceGroup, bobGroup } = await twoMemberGroup('ports-export')
    const alice = cryptoOver(aliceGroup)
    const bob = cryptoOver(bobGroup)

    expect(alice.crypto.epoch()).toBe(1)
    expect(bob.crypto.epoch()).toBe(1)
    const shared = await alice.crypto.exportSecret()
    expect(await bob.crypto.exportSecret()).toEqual(shared)

    // The handle swap a peer makes when it adopts its own commit: the port follows it, and the
    // secret moves with the epoch. A crypto closing over the handle it was built with would
    // still be exporting the line above.
    const removed = await removeMember(aliceGroup, 1)
    alice.adopt(removed.newGroup)
    expect(alice.crypto.epoch()).toBe(2)
    const rotated = await alice.crypto.exportSecret()
    expect(rotated).not.toEqual(shared)

    // Bob, removed, is left holding the old one for life and cannot reach the new one. This is
    // the property the whole app-lane topic rests on, and the only implementation that has it.
    expect(await bob.crypto.exportSecret()).toEqual(shared)
    expect(await bob.crypto.exportSecret()).not.toEqual(rotated)
  })

  test('wrap and unwrap round-trip and name the authenticated sender', async () => {
    const { alice: aliceID, aliceGroup, bobGroup } = await twoMemberGroup('ports-roundtrip')
    const alice = cryptoOver(aliceGroup)
    const bob = cryptoOver(bobGroup)

    const sealed = await alice.crypto.wrap(utf8.encode('hello'))
    const opened = await bob.crypto.unwrap(sealed)
    const result = opened as { payload: Uint8Array; senderDID?: string }
    expect(new TextDecoder().decode(result.payload)).toBe('hello')
    expect(result.senderDID).toBe(aliceID.id)
  })

  /**
   * DIVERGENCE FROM THE FAKE, and the one that matters most. The fake's `unwrap` is a pure
   * XOR: opening the same frame twice gives the same answer, for free, forever. Real MLS
   * consumes the message's ratchet key on the first open and refuses the second.
   *
   * OPENING IS A CONSUMING OPERATION, and this is where that is pinned. A caller that opens a
   * frame twice loses it here while passing against the fake, so anything with two consumers on
   * one topic must open once and fan the plaintext out, and anything that must open re-entrantly
   * (the ledger-entry blob, below) must not use this surface at all.
   */
  test('unwrap is SINGLE-USE per frame: the second open of the same bytes is refused', async () => {
    const { aliceGroup, bobGroup } = await twoMemberGroup('ports-single-use')
    const alice = cryptoOver(aliceGroup)
    const bob = cryptoOver(bobGroup)

    const sealed = await alice.crypto.wrap(utf8.encode('once'))
    await expect(bob.crypto.unwrap(sealed)).resolves.toBeDefined()
    await expect(bob.crypto.unwrap(sealed)).rejects.toThrow()
  })

  /** DIVERGENCE: the fake's `wrap` is pure; this one consumes a ratchet key. */
  test('wrap is not pure: the same plaintext seals to different bytes each time', async () => {
    const { aliceGroup } = await twoMemberGroup('ports-wrap-impure')
    const alice = cryptoOver(aliceGroup)
    const first = await alice.crypto.wrap(utf8.encode('same'))
    const second = await alice.crypto.wrap(utf8.encode('same'))
    expect(first).not.toEqual(second)
  })

  test('unwrap refuses every epoch but the handle current one', async () => {
    const { aliceGroup, bobGroup } = await twoMemberGroup('ports-epoch')
    const alice = cryptoOver(aliceGroup)
    const bob = cryptoOver(bobGroup)

    const atOne = await alice.crypto.wrap(utf8.encode('epoch one'))
    const removed = await removeMember(aliceGroup, 1)
    alice.adopt(removed.newGroup)
    const atTwo = await alice.crypto.wrap(utf8.encode('epoch two'))

    // Bob never applied the removal, so he is still at epoch 1.
    expect(bob.crypto.epoch()).toBe(1)
    await expect(bob.crypto.unwrap(atTwo)).rejects.toThrow()
    // And the handle that ratcheted forward cannot go back for the epoch-1 frame.
    await expect(alice.crypto.unwrap(atOne)).rejects.toThrow()
  })

  /**
   * The ledger-entry seal. It exists as its own surface because the MLS port opens the blob from
   * INSIDE the apply of the commit that carries it, and `wrap`/`unwrap` cannot be used there: they
   * consume a ratchet generation and mutate the handle. The three properties below are what make
   * the derived key a correct replacement, and each is required rather than incidental.
   */
  describe('the ledger-entry seal', () => {
    test('is PER-EPOCH: a member at another epoch cannot open the blob', async () => {
      const { aliceGroup, bobGroup } = await twoMemberGroup('ports-entry-per-epoch')
      const alice = cryptoOver(aliceGroup)
      const bob = cryptoOver(bobGroup)

      const atOne = await alice.crypto.sealEntries(utf8.encode('entries at one'))
      const removed = await removeMember(aliceGroup, 1)
      alice.adopt(removed.newGroup)
      const atTwo = await alice.crypto.sealEntries(utf8.encode('entries at two'))

      // The removal boundary, and it rests on this exactly as the app-lane anchor does: Bob keeps
      // epoch 1's key for life and it opens nothing the group sealed after he left.
      expect(bob.crypto.epoch()).toBe(1)
      expect(new TextDecoder().decode(await bob.crypto.openEntries(atOne))).toBe('entries at one')
      await expect(bob.crypto.openEntries(atTwo)).rejects.toThrow()
      // And the handle that ratcheted forward derives a different key too.
      await expect(alice.crypto.openEntries(atOne)).rejects.toThrow()
    })

    test('is AGREED: every member at an epoch opens what any other sealed, with nothing exchanged', async () => {
      const { aliceGroup, bobGroup } = await twoMemberGroup('ports-entry-agreed')
      const alice = cryptoOver(aliceGroup)
      const bob = cryptoOver(bobGroup)

      // Both directions: the key is derived from shared epoch state, not from the sealer.
      const fromAlice = await alice.crypto.sealEntries(utf8.encode('alice sealed'))
      expect(new TextDecoder().decode(await bob.crypto.openEntries(fromAlice))).toBe('alice sealed')
      const fromBob = await bob.crypto.sealEntries(utf8.encode('bob sealed'))
      expect(new TextDecoder().decode(await alice.crypto.openEntries(fromBob))).toBe('bob sealed')
    })

    test('is PURE: opening twice gives the same answer and consumes no ratchet generation', async () => {
      const { aliceGroup, bobGroup } = await twoMemberGroup('ports-entry-pure')
      const alice = cryptoOver(aliceGroup)
      const bob = cryptoOver(bobGroup)

      const sealed = await alice.crypto.sealEntries(utf8.encode('opened twice'))
      expect(await bob.crypto.openEntries(sealed)).toEqual(await bob.crypto.openEntries(sealed))

      // Nothing the open could have spent: an application frame sealed after those opens still
      // opens, which it would not if the entry open had taken a generation off the same chain.
      const frame = await alice.crypto.wrap(utf8.encode('still works'))
      const opened = (await bob.crypto.unwrap(frame)) as { payload: Uint8Array }
      expect(new TextDecoder().decode(opened.payload)).toBe('still works')
    })
  })

  describe('frameEpoch', () => {
    test('answers for an app frame and for a commit alike, from cleartext, at any epoch', async () => {
      const { aliceGroup, bobGroup } = await twoMemberGroup('ports-frame-epoch')
      const alice = cryptoOver(aliceGroup)
      const bob = cryptoOver(bobGroup)

      const appFrame = await alice.crypto.wrap(utf8.encode('framed'))
      expect(alice.crypto.frameEpoch(appFrame)).toBe(1)

      const removed = await removeMember(aliceGroup, 1)
      alice.adopt(removed.newGroup)
      const laterFrame = await alice.crypto.wrap(utf8.encode('later'))

      // A COMMIT is an MLSMessage too and carries the same field: one format, one epoch.
      expect(alice.crypto.frameEpoch(removed.commitMessage)).toBe(1)
      expect(alice.crypto.frameEpoch(laterFrame)).toBe(2)

      // Keyless: bob, at epoch 1, reads the epoch of a frame he can never open. That is the
      // whole point — it is what lets a reader tell "ahead of me" from "below me".
      expect(bob.crypto.epoch()).toBe(1)
      expect(bob.crypto.frameEpoch(laterFrame)).toBe(2)
      await expect(bob.crypto.unwrap(laterFrame)).rejects.toThrow()
    })

    test('never throws, and answers null for bytes that are not a readable frame', async () => {
      const { aliceGroup } = await twoMemberGroup('ports-frame-epoch-garbage')
      const alice = cryptoOver(aliceGroup)
      for (const bytes of [
        new Uint8Array(),
        new Uint8Array([0]),
        new Uint8Array([1, 2, 3, 4, 5]),
        new Uint8Array(64).fill(0xff),
      ]) {
        expect(alice.crypto.frameEpoch(bytes)).toBeNull()
      }
    })
  })
})
