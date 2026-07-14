import { normalizeDID, randomIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
  processWelcomeOnce,
} from '../src/group.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import type { GroupOptions, Invite } from '../src/types.js'

function mapResolver(tokens: Map<string, string>): GroupOptions['resolveLedgerEntries'] {
  return async (ids) => ids.map((id) => tokens.get(id)).filter((t): t is string => t != null)
}

/** Serve an invite's signed ledger tokens to a receiver's resolver. */
function publishInvite(tokens: Map<string, string>, invite: Invite): void {
  for (const token of invite.ledgerEntries) {
    tokens.set(ledgerEntryDigest(token), token)
  }
}

/**
 * A Welcome can reach its invitee more than once: any sender that journals a commit and
 * delivers the Welcome after the hub accepts it will re-deliver on a crash between those
 * two steps.
 *
 * These tests pin what MLS actually does with the repeat, because it is NOT a no-op and
 * the difference is load-bearing for anyone building the delivery path. `processWelcome`
 * is a pure function of (Welcome bytes, key package, private keys) — nothing in it, and
 * nothing in ts-mls's `joinGroup` beneath it, consults whether this identity already holds
 * a handle for the group. There is no "already joined" state to consult.
 *
 * So the second call SUCCEEDS, and hands back a whole second group state frozen at the
 * epoch the Welcome was minted for. Adopting it is a silent rollback. Dedup is the
 * receiving host's job, and it must happen BEFORE `processWelcome`, keyed on the group id:
 * nothing in the result distinguishes the duplicate from a first join.
 */
describe('a Welcome delivered a second time', () => {
  test('builds a second group state at the stale epoch: it neither throws nor no-ops', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const carol = randomIdentity()
    const tokens = new Map<string, string>()

    const { group: aliceGroup } = await createGroup(alice, 'welcome-redelivery')
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    publishInvite(tokens, invite)
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
      options: { resolveLedgerEntries: mapResolver(tokens) },
    })
    expect(bobGroup.epoch).toBe(1n)
    expect(bobGroup.memberCount).toBe(2)

    // The group moves on past the join, and Bob's live handle moves with it.
    const { invite: carolInvite } = await createInvite({
      group: groupWithBob,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    publishInvite(tokens, carolInvite)
    const carolKP = await createKeyPackageBundle(carol)
    const { commitMessage: addCarol, newGroup: groupWithCarol } = await commitInvite(
      groupWithBob,
      carolKP.publicPackage,
      carolInvite,
    )
    await bobGroup.processMessage(addCarol)
    expect(bobGroup.epoch).toBe(2n)
    expect(bobGroup.memberCount).toBe(3)

    // The same Welcome bytes arrive again. This does not throw.
    const { group: rejoined } = await processWelcome({
      identity: bob,
      invite,
      welcome: welcomeMessage,
      keyPackageBundle: bobKeyBundle,
      ratchetTree: groupWithBob.state.ratchetTree,
      options: { resolveLedgerEntries: mapResolver(tokens) },
    })

    // It is a SECOND handle, not the live one, and it is frozen at the joining epoch:
    // one epoch and one member behind the group Bob is actually in.
    expect(rejoined).not.toBe(bobGroup)
    expect(rejoined.epoch).toBe(1n)
    expect(rejoined.memberCount).toBe(2)
    expect(bobGroup.epoch).toBe(2n)
    expect(bobGroup.memberCount).toBe(3)

    // Its roster is the joining roster: Carol, who joined after the Welcome was minted,
    // is not in it. A host that adopts this handle has silently un-seen her.
    expect([...rejoined.roster.roles.keys()].sort()).toEqual(
      [normalizeDID(alice.id), normalizeDID(bob.id)].sort(),
    )
    expect(bobGroup.roster.roles.has(normalizeDID(carol.id))).toBe(true)
    expect(rejoined.roster.roles.has(normalizeDID(carol.id))).toBe(false)

    // Nothing in the result marks it as a duplicate — same group id as the live handle.
    // The only way to tell the two apart is state the receiver already holds.
    expect(rejoined.groupID).toBe(bobGroup.groupID)

    // And the rollback is not cosmetic: the stale handle cannot read the group's traffic.
    const message = await groupWithCarol.encrypt(new TextEncoder().encode('after the join'))
    await expect(rejoined.processMessage(message)).rejects.toThrow()
    // The live handle, untouched by the re-delivery, still can.
    const same = await groupWithCarol.encrypt(new TextEncoder().encode('after the join'))
    expect(new TextDecoder().decode((await bobGroup.processMessage(same)) as Uint8Array)).toBe(
      'after the join',
    )
  })

  test('the repeat is accepted even when the invitee is still at the joining epoch', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const tokens = new Map<string, string>()

    const { group: aliceGroup } = await createGroup(alice, 'welcome-redelivery-same-epoch')
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    publishInvite(tokens, invite)
    const bobKeyBundle = await createKeyPackageBundle(bob)
    const { welcomeMessage, newGroup: groupWithBob } = await commitInvite(
      aliceGroup,
      bobKeyBundle.publicPackage,
      invite,
    )

    const join = {
      identity: bob,
      invite,
      welcome: welcomeMessage,
      keyPackageBundle: bobKeyBundle,
      ratchetTree: groupWithBob.state.ratchetTree,
      options: { resolveLedgerEntries: mapResolver(tokens) },
    }
    const first = await processWelcome(join)
    const second = await processWelcome(join)

    // Two independent handles over one membership. The Welcome is not consumed by the
    // first join, so a receiver that keys its groups by handle identity ends up holding
    // the group twice — the duplicate the delivery path has to prevent for itself.
    expect(second.group).not.toBe(first.group)
    expect(second.group.groupID).toBe(first.group.groupID)
    expect(second.group.epoch).toBe(first.group.epoch)
    expect(second.group.memberCount).toBe(first.group.memberCount)
  })
})

describe('the safe join path', () => {
  test('a first join returns the handle; the repeat returns null and the live handle stands', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const carol = randomIdentity()
    const tokens = new Map<string, string>()

    const { group: aliceGroup } = await createGroup(alice, 'join-once')
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    publishInvite(tokens, invite)
    const bobKeyBundle = await createKeyPackageBundle(bob)
    const { welcomeMessage, newGroup: groupWithBob } = await commitInvite(
      aliceGroup,
      bobKeyBundle.publicPackage,
      invite,
    )

    const join = {
      identity: bob,
      invite,
      welcome: welcomeMessage,
      keyPackageBundle: bobKeyBundle,
      ratchetTree: groupWithBob.state.ratchetTree,
      options: { resolveLedgerEntries: mapResolver(tokens) },
    }

    // Bob holds nothing yet: this is an ordinary first join and it hands back the handle.
    const first = await processWelcomeOnce({ ...join, joined: [] })
    expect(first).not.toBeNull()
    const bobGroup = first?.group
    if (bobGroup == null) throw new Error('expected a handle for a first join')
    expect(bobGroup.groupID).toBe('join-once')
    expect(bobGroup.epoch).toBe(1n)

    // The group moves on, and Bob with it.
    const { invite: carolInvite } = await createInvite({
      group: groupWithBob,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    publishInvite(tokens, carolInvite)
    const carolKP = await createKeyPackageBundle(carol)
    const { commitMessage: addCarol, newGroup: groupWithCarol } = await commitInvite(
      groupWithBob,
      carolKP.publicPackage,
      carolInvite,
    )
    await bobGroup.processMessage(addCarol)
    expect(bobGroup.epoch).toBe(2n)

    // The Welcome is re-delivered. Bob holds this group, so nothing comes back — and no stale
    // handle is offered to be adopted by mistake.
    const repeat = await processWelcomeOnce({ ...join, joined: [bobGroup.groupID] })
    expect(repeat).toBeNull()

    // The live handle is untouched, still at the group's epoch, still reading its traffic.
    expect(bobGroup.epoch).toBe(2n)
    expect(bobGroup.memberCount).toBe(3)
    expect(bobGroup.roster.roles.has(normalizeDID(carol.id))).toBe(true)
    const message = await groupWithCarol.encrypt(new TextEncoder().encode('still here'))
    expect(new TextDecoder().decode((await bobGroup.processMessage(message)) as Uint8Array)).toBe(
      'still here',
    )
  })

  test('a Welcome for a group the member does not hold still joins', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const tokens = new Map<string, string>()

    const { group: aliceGroup } = await createGroup(alice, 'second-group')
    const { invite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    publishInvite(tokens, invite)
    const bobKeyBundle = await createKeyPackageBundle(bob)
    const { welcomeMessage, newGroup: groupWithBob } = await commitInvite(
      aliceGroup,
      bobKeyBundle.publicPackage,
      invite,
    )

    // Bob is already in other groups. The guard is per group id, not per member: an invite to
    // a group he does not hold is a first join however many others he is in.
    const result = await processWelcomeOnce({
      identity: bob,
      invite,
      welcome: welcomeMessage,
      keyPackageBundle: bobKeyBundle,
      ratchetTree: groupWithBob.state.ratchetTree,
      options: { resolveLedgerEntries: mapResolver(tokens) },
      joined: ['some-other-group', 'a-third-group'],
    })

    expect(result).not.toBeNull()
    expect(result?.group.groupID).toBe('second-group')
    expect(result?.group.epoch).toBe(1n)
    expect(result?.group.memberCount).toBe(2)
  })
})
