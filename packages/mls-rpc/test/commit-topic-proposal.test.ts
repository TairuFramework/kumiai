import { createUpdateProposal, encode, mlsMessageEncoder } from 'ts-mls'
import { expect, test, vi } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createGroupMLS } from '../src/mls.js'
import { buildRealCommit, createRealGroup } from './fixtures/real-group.js'

test('a Proposal on the commit topic cannot enter the next Commit', async () => {
  const group = await createRealGroup(2, 'commit-topic-proposal')
  const member = group.members[0]
  const observer = group.members[1]
  if (member == null || observer == null) throw new Error('missing members')

  const proposal = await createUpdateProposal({
    context: member.handle.context,
    state: member.handle.state,
  })
  const bytes = encode(mlsMessageEncoder, proposal.message)
  const adopt = vi.fn()
  const persist = vi.fn()
  const port = createGroupMLS({
    access: simpleHandleAccess({ handle: () => group.committer.handle, adopt, persist }),
    identity: group.committer.identity,
    entrySlot: group.committer.slot,
  })

  const before = group.committer.handle.epoch
  expect(await port.readCommitHeader(bytes)).toBeNull()
  expect(await port.processCommit(bytes, { senderDID: member.identity.id })).toMatchObject({
    advanced: false,
  })
  expect(group.committer.handle.epoch).toBe(before)
  expect(Object.keys(group.committer.handle.state.unappliedProposals)).toHaveLength(0)
  expect(persist).not.toHaveBeenCalled()
  expect(adopt).not.toHaveBeenCalled()

  const next = await buildRealCommit(group)
  expect(group.committer.handle.epoch).toBe(before + 1n)
  await observer.handle.processMessage(next)
  expect(observer.handle.epoch).toBe(before + 1n)
})

test('garbage and application messages on the commit topic leave the handle untouched', async () => {
  const group = await createRealGroup(1, 'commit-topic-non-commit')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const adopt = vi.fn()
  const persist = vi.fn()
  const port = createGroupMLS({
    access: simpleHandleAccess({ handle: () => member.handle, adopt, persist }),
    identity: member.identity,
    entrySlot: member.slot,
  })
  const before = member.handle.epoch
  const application = await group.committer.handle.encrypt(new TextEncoder().encode('message'))
  for (const bytes of [new Uint8Array([0xff, 0xff]), application]) {
    expect(await port.readCommitHeader(bytes)).toBeNull()
    expect(
      await port.processCommit(bytes, { senderDID: group.committer.identity.id }),
    ).toMatchObject({ advanced: false })
    expect(member.handle.epoch).toBe(before)
    expect(Object.keys(member.handle.state.unappliedProposals)).toHaveLength(0)
    expect(persist).not.toHaveBeenCalled()
    expect(adopt).not.toHaveBeenCalled()
  }
})
