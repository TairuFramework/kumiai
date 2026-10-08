import { createProposal, defaultProposalTypes, encode, mlsMessageEncoder } from 'ts-mls'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { deriveGroup } from '../src/group-handle.js'
import { renewLeaf } from '../src/group-lifecycle.js'
import { commitSelfRemovals, proposeSelfRemoval } from '../src/index.js'
import {
  agent,
  lowLevelWelcome,
  pipelineGroup,
  rawCommit,
  timedBinding,
} from './fixtures/lifecycle-pipeline.js'

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(150_000))
afterEach(() => vi.restoreAllMocks())

async function pair(peerIat = 100) {
  const setup = await pipelineGroup()
  const peer = agent(51)
  const fixture = await lowLevelWelcome(
    setup.group,
    peer,
    await timedBinding({ identity: peer, iat: peerIat, exp: 200 }),
  )
  return { ...fixture, identity: setup.identity, peer, tokens: setup.tokens }
}

test('selfRemovalCommittedByAnotherMemberKeepsSender', async () => {
  const { author, joined, peer, tokens } = await pair(120)
  const target = joined.state.privatePath.leafIndex
  const epoch = joined.epoch
  const withoutProposal = deriveGroup(author, structuredClone(author.state))
  const proposal = await proposeSelfRemoval(joined)
  expect(proposal.epoch).toBe(epoch)
  expect(joined.epoch).toBe(epoch)
  const expected = {
    proposal: { proposalType: defaultProposalTypes.remove, remove: { removed: target } },
    senderLeafIndex: target,
  }
  expect(Object.values(joined.state.unappliedProposals)).toEqual([expected])
  await author.processMessage(proposal.frame)
  expect(Object.values(author.state.unappliedProposals)).toEqual([expected])
  const snapshot = structuredClone(author.state)
  const committing = commitSelfRemovals(author)
  await expect(committing).resolves.toMatchObject({ epoch: epoch + 1n })
  const result = await committing
  expect(result).not.toBeNull()
  if (result == null) throw new Error('Missing commit')
  expect(result.epoch).toBe(epoch + 1n)
  expect(author.state).toEqual(snapshot)
  expect(result.newGroup.findMemberLeafIndex(peer.id)).toBeUndefined()
  expect(result.newGroup.listMembers().map(({ id }) => id)).toEqual([author.credential.id])
  for (const held of result.newGroup.ledger) tokens.set(held.entryID, held.token)
  expect(result.newGroup.registry.controllers.values().next().value?.timeFloor).toBe(120)
  let recorded: unknown
  await joined.processMessage(result.commitMessage, {
    commitPolicy: (incoming) => {
      recorded = incoming
      return 'accept'
    },
  })
  expect(recorded).toMatchObject({
    kind: 'commit',
    senderLeafIndex: author.state.privatePath.leafIndex,
    proposals: [
      expected,
      { proposal: { proposalType: defaultProposalTypes.group_context_extensions } },
    ],
  })
  expect(joined.state.groupActiveState.kind).toBe('removedFromGroup')
  await expect(withoutProposal.processMessage(result.commitMessage)).rejects.toMatchObject({
    name: 'CommitRejectedError',
    reason: 'invalid',
  })
  expect(await commitSelfRemovals(result.newGroup)).toBeNull()
})

test('selfRemovalByOwnCommitRefused', async () => {
  const { joined } = await pair()
  await proposeSelfRemoval(joined)
  const target = joined.state.privatePath.leafIndex
  const snapshot = structuredClone(joined.state)
  await expect(commitSelfRemovals(joined)).rejects.toMatchObject({
    name: 'CommitRejectedError',
    reason: 'invalid',
    senderLeafIndex: target,
    proposals: [
      {
        proposal: { proposalType: defaultProposalTypes.remove, remove: { removed: target } },
        senderLeafIndex: target,
      },
    ],
    cause: { message: 'Unauthorised Remove' },
  })
  expect(joined.state).toEqual(snapshot)
})

test('forgedSelfRemovalRefused', async () => {
  const { author, joined } = await pair()
  const target = author.state.privatePath.leafIndex
  const sender = joined.state.privatePath.leafIndex
  expect(sender).not.toBe(target)
  const proposal = { proposalType: defaultProposalTypes.remove, remove: { removed: target } }
  const forgedProposal = await createProposal({
    context: joined.context,
    state: joined.state,
    proposal,
  })
  const snapshot = structuredClone(author.state)
  const forgedCommit = await rawCommit({ group: joined, proposals: [proposal] })
  await expect(
    author.processMessage(encode(mlsMessageEncoder, forgedCommit.commit)),
  ).rejects.toMatchObject({
    name: 'CommitRejectedError',
    reason: 'invalid',
    senderLeafIndex: sender,
    proposals: [{ proposal, senderLeafIndex: sender }],
  })
  expect(author.state).toEqual(snapshot)
  await expect(
    author.processMessage(encode(mlsMessageEncoder, forgedProposal.message)),
  ).rejects.toMatchObject({ name: 'CommitRejectedError', reason: 'invalid' })
  expect(author.state).toEqual(snapshot)
  expect(author.findMemberLeafIndex(author.credential.id)).toBe(target)
  const forgedPending = deriveGroup(joined, forgedProposal.newState)
  const pendingSnapshot = structuredClone(forgedPending.state)
  expect(Object.values(forgedPending.state.unappliedProposals)).toEqual([
    {
      proposal,
      senderLeafIndex: sender,
    },
  ])
  expect(await commitSelfRemovals(forgedPending)).toBeNull()
  expect(forgedPending.state).toEqual(pendingSnapshot)
})

test('staleEpochProposalIgnored', async () => {
  const { author, joined, identity, peer } = await pair()
  const proposal = await proposeSelfRemoval(joined)
  const publicProposal = await createProposal({
    context: joined.context,
    state: joined.state,
    wireAsPublicMessage: true,
    proposal: {
      proposalType: defaultProposalTypes.remove,
      remove: { removed: joined.state.privatePath.leafIndex },
    },
  })
  const advanced = await renewLeaf(author, await timedBinding({ identity, iat: 150, exp: 250 }))
  const snapshot = structuredClone(advanced.newGroup.state)
  const persist = vi.fn()
  for (const frame of [proposal.frame, encode(mlsMessageEncoder, publicProposal.message)]) {
    await expect(advanced.newGroup.processMessage(frame, { persist })).resolves.toBeNull()
  }
  expect(persist).not.toHaveBeenCalled()
  expect(advanced.newGroup.state).toEqual(snapshot)
  expect(advanced.newGroup.epoch).toBe(proposal.epoch + 1n)
  expect(Object.values(advanced.newGroup.state.unappliedProposals)).toEqual([])
  expect(await commitSelfRemovals(advanced.newGroup)).toBeNull()
  expect(advanced.newGroup.findMemberLeafIndex(peer.id)).toBe(joined.state.privatePath.leafIndex)
})

test('twoSelfRemovalsOneCommit', async () => {
  const first = await pair()
  const third = agent(61)
  const second = await lowLevelWelcome(
    first.author,
    third,
    await timedBinding({ identity: third, iat: 100, exp: 200 }),
  )
  await first.joined.processMessage(second.message)
  const epoch = second.author.epoch
  const proposals = await Promise.all([
    proposeSelfRemoval(first.joined),
    proposeSelfRemoval(second.joined),
  ])
  for (const proposal of proposals) {
    await second.author.processMessage(proposal.frame)
  }
  const [firstProposal, secondProposal] = proposals
  if (firstProposal == null || secondProposal == null) throw new Error('Missing proposal')
  await first.joined.processMessage(secondProposal.frame)
  await second.joined.processMessage(firstProposal.frame)
  const expected = Object.values(second.author.state.unappliedProposals)
  expect(expected.map(({ senderLeafIndex }) => senderLeafIndex).sort()).toEqual(
    [first.joined.state.privatePath.leafIndex, second.joined.state.privatePath.leafIndex].sort(),
  )
  const result = await commitSelfRemovals(second.author)
  if (result == null) throw new Error('Missing commit')
  expect(result.epoch).toBe(epoch + 1n)
  expect(result.newGroup.listMembers().map(({ id }) => id)).toEqual([first.identity.id])
  for (const leaver of [first.joined, second.joined]) {
    let recorded: unknown
    await leaver.processMessage(result.commitMessage, {
      commitPolicy: (incoming) => {
        recorded = incoming
        return 'accept'
      },
    })
    expect(recorded).toMatchObject({ kind: 'commit', proposals: expected })
    expect(leaver.state.groupActiveState.kind).toBe('removedFromGroup')
  }
})
