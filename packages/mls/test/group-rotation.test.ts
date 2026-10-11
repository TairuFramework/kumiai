import { randomIdentity } from '@kokuin/token'
import { createProposal, defaultProposalTypes } from 'ts-mls'
import { expect, test } from 'vitest'

import { commitInvite, createInvite } from '../src/group-commit.js'
import { createGroup } from '../src/group-create.js'
import { createKeyPackageBundle } from '../src/group-credential.js'
import { deriveGroup } from '../src/group-handle.js'
import { commitKeyRotation } from '../src/group-rotation.js'
import { processWelcome } from '../src/group-welcome.js'

// An empty rotation must use an update path even for a non-admin author.
test('rotation refuses local pending proposals and otherwise preserves roster and ledger', async () => {
  const alice = randomIdentity()
  const bob = randomIdentity()
  const { group } = await createGroup(alice, 'rotation')
  const { invite } = await createInvite({
    group,
    identity: alice,
    recipientDID: bob.id,
    permission: 'member',
  })
  const bundle = await createKeyPackageBundle(bob)
  const added = await commitInvite(group, bundle.publicPackage, invite)
  const { group: member } = await processWelcome({
    identity: bob,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: bundle,
  })
  const pending = await createProposal({
    context: member.context,
    state: member.state,
    proposal: {
      proposalType: defaultProposalTypes.remove,
      remove: { removed: added.newGroup.state.privatePath.leafIndex },
    },
  })
  const withPending = deriveGroup(member, pending.newState)
  const before = structuredClone(withPending.state)
  await expect(commitKeyRotation(withPending)).rejects.toThrow('pending proposals')
  expect(withPending.state).toEqual(before)
  const source = structuredClone(member.state)
  const rotated = await commitKeyRotation(member)
  expect(member.state).toEqual(source)
  expect(rotated.newGroup.epoch).toBe(member.epoch + 1n)
  expect(rotated.newGroup.ledgerTokens).toEqual(member.ledgerTokens)
  expect(rotated.newGroup.listMembers()).toEqual(member.listMembers())
  expect(rotated.newGroup.state.unappliedProposals).toEqual({})
  await added.newGroup.processMessage(rotated.commitMessage)
  expect(added.newGroup.state.keySchedule.epochAuthenticator).toEqual(
    rotated.newGroup.state.keySchedule.epochAuthenticator,
  )
  expect(added.newGroup.listMembers()).toEqual(rotated.newGroup.listMembers())
})
