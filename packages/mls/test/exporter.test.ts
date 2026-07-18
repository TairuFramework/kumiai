import { randomIdentity } from '@kokuin/token'
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
import type { Invite } from '../src/types.js'

const LABEL = 'kumiai/app-topic/v1'
const CONTEXT = new TextEncoder().encode('room')

/**
 * Alice (admin, leaf 0), Bob (member, leaf 1) and Carol (member, leaf 2) at epoch 3,
 * plus the shared entry resolver every receiver folds commits through.
 */
async function threeMemberGroup(groupID: string) {
  const alice = randomIdentity()
  const bob = randomIdentity()
  const carol = randomIdentity()
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

  const join = async (
    admin: GroupHandle,
    identity: ReturnType<typeof randomIdentity>,
  ): Promise<{ adminGroup: GroupHandle; joined: GroupHandle; commit: Uint8Array }> => {
    const { invite } = await createInvite({
      group: admin,
      identity: alice,
      recipientDID: identity.id,
      permission: 'member',
    })
    publish(invite)
    const bundle = await createKeyPackageBundle(identity)
    const added = await commitInvite(admin, bundle.publicPackage, invite)
    const { group: joined } = await processWelcome({
      identity,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: added.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries },
    })
    return { adminGroup: added.newGroup, joined, commit: added.commitMessage }
  }

  const addBob = await join(created, bob)
  const addCarol = await join(addBob.adminGroup, carol)
  // Bob has to walk the commit that added Carol to reach the same epoch.
  await addBob.joined.processMessage(addCarol.commit)

  return {
    alice,
    aliceGroup: addCarol.adminGroup,
    bobGroup: addBob.joined,
    carolGroup: addCarol.joined,
  }
}

describe('MLS exporter secret', () => {
  test('every member at an epoch exports the same secret; a member at another epoch does not', async () => {
    const { aliceGroup, bobGroup, carolGroup } = await threeMemberGroup('exporter-agreement')

    expect(aliceGroup.epoch).toBe(2n)
    expect(bobGroup.epoch).toBe(2n)
    expect(carolGroup.epoch).toBe(2n)

    const fromAlice = await aliceGroup.exportSecret(LABEL, CONTEXT)
    expect(await bobGroup.exportSecret(LABEL, CONTEXT)).toEqual(fromAlice)
    expect(await carolGroup.exportSecret(LABEL, CONTEXT)).toEqual(fromAlice)
    expect(fromAlice.length).toBe(32)

    // Alice removes Bob (leaf 1). Alice and Carol move to the next epoch; Bob's own handle
    // stays where it was, since the commit's UpdatePath excludes his leaf. Same label, same
    // context, different epoch: different bytes.
    const removed = await removeMember(aliceGroup, 1)
    await carolGroup.processMessage(removed.commitMessage)
    expect(removed.newGroup.epoch).toBe(3n)
    expect(carolGroup.epoch).toBe(3n)
    expect(bobGroup.epoch).toBe(2n)

    const atFour = await removed.newGroup.exportSecret(LABEL, CONTEXT)
    expect(await carolGroup.exportSecret(LABEL, CONTEXT)).toEqual(atFour)
    expect(atFour).not.toEqual(fromAlice)

    // Bob, removed, keeps epoch 3's secret for life and cannot follow it forward.
    expect(await bobGroup.exportSecret(LABEL, CONTEXT)).toEqual(fromAlice)
    expect(await bobGroup.exportSecret(LABEL, CONTEXT)).not.toEqual(atFour)
  })

  test('the label and the context each separate the secret', async () => {
    const { aliceGroup } = await threeMemberGroup('exporter-domain-separation')

    const base = await aliceGroup.exportSecret(LABEL, CONTEXT)
    expect(await aliceGroup.exportSecret('kumiai/inbox/v1', CONTEXT)).not.toEqual(base)
    expect(await aliceGroup.exportSecret(LABEL, new TextEncoder().encode('other'))).not.toEqual(
      base,
    )
    expect(await aliceGroup.exportSecret(LABEL, CONTEXT, 64)).toHaveLength(64)
  })
})
