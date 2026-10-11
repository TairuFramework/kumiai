import { randomIdentity } from '@kokuin/token'

import { decodeClientState, encodeClientState } from '../../src/codec.js'
import type { GroupHandle, Invite } from '../../src/index.js'
import * as mls from '../../src/index.js'

export async function restore(group: GroupHandle) {
  const state = decodeClientState(encodeClientState(group.state))
  if (state == null) throw new Error('failed to decode state')
  return mls.restoreGroup({ state, credential: group.credential })
}

export async function carryReceiveFixture(groupID: string) {
  const alice = randomIdentity()
  const bob = randomIdentity()
  const tokens = new Map<string, string>()
  const resolveLedgerEntries = async (ids: Array<string>) => {
    return ids.map((id) => {
      const token = tokens.get(id)
      if (token == null) throw new Error(`unknown ledger entry ${id}`)
      return token
    })
  }
  const buildInvite = async (group: GroupHandle, recipientDID: string) => {
    const { invite } = await mls.createInvite({
      group,
      identity: alice,
      recipientDID,
      permission: 'member',
    })
    for (const token of invite.ledgerEntries) tokens.set(mls.ledgerEntryDigest(token), token)
    return invite
  }
  const { group: created } = await mls.createGroup(alice, groupID, { resolveLedgerEntries })
  const earlierSender = await restore(created)
  const invite: Invite = await buildInvite(created, bob.id)
  const bundle = await mls.createKeyPackageBundle(bob)
  const added = await mls.commitInvite(created, bundle.publicPackage, invite)
  const { group: bobGroup } = await mls.processWelcome({
    identity: bob,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: bundle,
    ratchetTree: added.newGroup.state.ratchetTree,
    options: { resolveLedgerEntries },
  })
  const aliceGroup = added.newGroup
  const charlie = randomIdentity()
  const nextInvite = await buildInvite(aliceGroup, charlie.id)
  const nextBundle = await mls.createKeyPackageBundle(charlie)
  const { newGroup: candidate } = await mls.commitInvite(
    aliceGroup,
    nextBundle.publicPackage,
    nextInvite,
  )
  return { aliceGroup, bobGroup, candidate, earlierSender }
}
