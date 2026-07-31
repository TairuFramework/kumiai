import { randomIdentity } from '@kokuin/token'
import { createCommit, defaultProposalTypes, encode, mlsMessageEncoder } from 'ts-mls'
import { describe, expect, test } from 'vitest'

import {
  CommitRejectedError,
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
} from '../src/group.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import type { Invite } from '../src/types.js'

/**
 * Alice (admin) plus bob (member), sharing a ledger-entry resolver. The same shape
 * `app-message.test.ts` uses — repeated rather than shared, because a helper that grows a
 * parameter for every caller is worse than two short ones.
 */
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
  return { alice, bob, aliceGroup: added.newGroup, bobGroup, resolveLedgerEntries }
}

/**
 * A raw Add commit, built past `commitInvite`'s admin guard — it stands in for a client that
 * skipped that guard, so the RECEIVING side has to reject it on its own.
 */
async function addCommitBytes(
  group: { context: unknown; state: unknown },
  keyPackage: unknown,
): Promise<Uint8Array> {
  const result = await createCommit({
    context: group.context as Parameters<typeof createCommit>[0]['context'],
    state: group.state as Parameters<typeof createCommit>[0]['state'],
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: keyPackage as never },
      },
    ] as Parameters<typeof createCommit>[0]['extraProposals'],
  })
  return encode(mlsMessageEncoder, result.commit)
}

/**
 * Every other CommitRejectedError test in this package asserts `instanceof` or `toThrow`, so
 * nothing reads a field off the caught error and the capture could regress to an empty object
 * undetected. These two read the fields.
 */
describe('CommitRejectedError carries the rejected commit', () => {
  test('the default policy path captures proposals and the sender leaf index', async () => {
    const { aliceGroup, bobGroup } = await twoMemberGroup('rejected-payload-default')
    const carol = randomIdentity()
    const carolKP = await createKeyPackageBundle(carol)
    const bobCommit = await addCommitBytes(bobGroup, carolKP.publicPackage)

    // `rejects.toThrow` cannot reach the fields — the whole point here is the caught object.
    expect.assertions(4)
    try {
      await aliceGroup.processMessage(bobCommit)
    } catch (error) {
      expect(error).toBeInstanceOf(CommitRejectedError)
      const rejected = error as CommitRejectedError
      expect(rejected.proposals).toHaveLength(1)
      // `ProposalWithSender.proposal.proposalType` is a numeric literal (`typeof
      // defaultProposalTypes.add`), not the string 'add' — ts-mls has no string form.
      expect(rejected.proposals[0]?.proposal.proposalType).toBe(defaultProposalTypes.add)
      // Bob is the second leaf: alice created the group, bob was added to it.
      expect(rejected.senderLeafIndex).toBe(1)
    }
  })

  test('a caller commit policy rejecting captures the same payload', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const tokens = new Map<string, string>()
    const resolveLedgerEntries = async (ids: Array<string>) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error(`unknown ledger entry ${id}`)
        return token
      })

    // A policy that refuses every incoming commit. It replaces nothing: `wrapCommitPolicy`
    // wraps the COMBINED default-plus-caller callback, so this exercises the caller branch of
    // the same capture the default path uses.
    const commitPolicy = () => 'reject' as const

    const { group: created } = await createGroup(alice, 'rejected-payload-caller', {
      resolveLedgerEntries,
    })
    const { invite } = await createInvite({
      group: created,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
    const bundle = await createKeyPackageBundle(bob)
    const added = await commitInvite(created, bundle.publicPackage, invite)
    // Bob joins with the refusing policy in place, so HIS handle rejects what alice commits.
    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: added.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries, commitPolicy },
    })

    const carol = randomIdentity()
    const carolKP = await createKeyPackageBundle(carol)
    // Alice is admin, so this commit is valid — only the caller policy stands against it.
    const aliceCommit = await addCommitBytes(added.newGroup, carolKP.publicPackage)

    expect.assertions(4)
    try {
      await bobGroup.processMessage(aliceCommit)
    } catch (error) {
      expect(error).toBeInstanceOf(CommitRejectedError)
      const rejected = error as CommitRejectedError
      expect(rejected.proposals).toHaveLength(1)
      expect(rejected.proposals[0]?.proposal.proposalType).toBe(defaultProposalTypes.add)
      // Alice is the first leaf: she created the group.
      expect(rejected.senderLeafIndex).toBe(0)
    }
  })
})
