import { randomIdentity } from '@kokuin/token'
import {
  createCommit,
  defaultProposalTypes,
  encode,
  type IncomingMessageCallback,
  mlsMessageEncoder,
} from 'ts-mls'
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
 *
 * `bobOptions` threads extra `processWelcome` options — e.g. a caller `commitPolicy` — onto
 * bob's join alone; alice's side always runs under the anchored default. `publish` is
 * returned so a caller can fold a LATER invite's ledger entries into the same resolver both
 * handles already share, without duplicating the resolver/tokens setup.
 */
async function twoMemberGroup(
  groupID: string,
  bobOptions?: { commitPolicy?: IncomingMessageCallback },
) {
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
    options: { resolveLedgerEntries, ...bobOptions },
  })
  return { alice, bob, aliceGroup: added.newGroup, bobGroup, resolveLedgerEntries, publish }
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
    // A policy that refuses every incoming commit. `GroupOptions.commitPolicy` REPLACES the
    // anchored `defaultCommitPolicy` for the handle it's set on — it does not compose with it
    // (see the doc on `commitPolicy` in `../src/types.js`) — so this exercises the
    // caller-dispatch branch of `wrapCommitPolicy`'s shared capture (`group-handle.ts:801`),
    // distinct from the default-policy branch the test above covers.
    const commitPolicy = () => 'reject' as const
    const { alice, aliceGroup, bobGroup, publish } = await twoMemberGroup(
      'rejected-payload-caller',
      { commitPolicy },
    )

    const carol = randomIdentity()
    const carolKP = await createKeyPackageBundle(carol)
    // A REAL invite, not `addCommitBytes`'s bare raw commit (that's Task 1's shape, for a
    // commit `defaultCommitPolicy` also rejects — admin-valid but unrostered). Carol's role
    // grant rides this commit and folds into `candidateRoster`, so `defaultCommitPolicy`
    // would ACCEPT it. Only bob's caller policy stands against it, isolating that branch:
    // a regression that always fell through to the default policy would let this commit
    // through instead of rejecting it.
    const { invite: carolInvite } = await createInvite({
      group: aliceGroup,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    publish(carolInvite)
    const addedCarol = await commitInvite(aliceGroup, carolKP.publicPackage, carolInvite)

    expect.assertions(4)
    try {
      await bobGroup.processMessage(addedCarol.commitMessage)
    } catch (error) {
      expect(error).toBeInstanceOf(CommitRejectedError)
      const rejected = error as CommitRejectedError
      // Unlike Task 1's bare `addCommitBytes` commit, `commitInvite` also rides a
      // `group_context_extensions` proposal moving the ledger head — the Add proposal
      // (index 0; `commitWithEntries` appends the head-move proposal after it) plus that one.
      expect(rejected.proposals).toHaveLength(2)
      expect(rejected.proposals[0]?.proposal.proposalType).toBe(defaultProposalTypes.add)
      // Alice is the first leaf: she created the group.
      expect(rejected.senderLeafIndex).toBe(0)
    }
  })
})
