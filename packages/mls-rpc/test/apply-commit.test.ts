import {
  commitLedgerEntries,
  ledgerEntryDigest,
  MissingLedgerEntriesError,
  restoreGroup,
  signLedgerEntry,
} from '@kumiai/mls'
import { expect, test, vi } from 'vitest'

import { applyCommit } from '../src/apply-commit.js'
import {
  buildRealCommit,
  createRealGroup,
  type RealGroup,
  type RealMember,
} from './fixtures/real-group.js'

function member(group: RealGroup, index = 0): RealMember {
  const found = group.members[index]
  if (found == null) throw new Error(`no member at ${index}`)
  return found
}

async function noteCommit(group: RealGroup, values: Array<string>): Promise<Uint8Array> {
  const tokens: Array<string> = []
  for (const value of values) {
    const token = await signLedgerEntry(group.committer.identity, {
      type: 'app.note',
      groupID: group.committer.handle.groupID,
      subject: group.committer.identity.id,
      value,
    })
    group.bodies.set(ledgerEntryDigest(token), token)
    tokens.push(token)
  }
  const authored = await commitLedgerEntries(group.committer.handle, tokens)
  group.committer.handle = authored.newGroup
  return authored.commitMessage
}

function context(group: RealGroup, self: RealMember, resolve = group.resolveLedgerEntries) {
  return {
    senderDID: group.committer.identity.id,
    resolveLedgerEntries: resolve,
    entrySlot: self.slot,
    ownDID: self.identity.id,
  }
}

test('an accepted commit reports rosters, ledger length, committer and surfaced entries', async () => {
  const group = await createRealGroup(1, 'apply-commit-accepted')
  const self = member(group)
  const commit = await noteCommit(group, ['same', 'same'])
  const before = self.handle.epoch
  const ledgerLength = self.handle.ledger.length
  const persist = vi.fn(async () => {})

  const result = await applyCommit(self.handle, commit, context(group, self), persist)

  expect(result).toMatchObject({
    advanced: true,
    epochBefore: Number(before),
    epochAfter: Number(before) + 1,
    ledgerLengthBefore: ledgerLength,
    committerDID: group.committer.identity.id,
  })
  expect(result.surfacedEntries.map((v) => [v.entry.type, v.entry.value])).toEqual([
    ['app.note', 'same'],
    ['app.note', 'same'],
  ])
  expect(result.rosterAfter).toEqual(result.rosterBefore)
  expect(persist).toHaveBeenCalledOnce()
  expect(self.handle.epoch).toBe(before + 1n)
})

test('an Add reports the new roster and surfaces no control entries', async () => {
  const group = await createRealGroup(1, 'apply-commit-add')
  const self = member(group)
  const commit = await buildRealCommit(group)

  const result = await applyCommit(self.handle, commit, context(group, self))

  expect(result.advanced).toBe(true)
  expect(result.rosterAfter).toHaveLength(result.rosterBefore.length + 1)
  expect(result.surfacedEntries).toEqual([])
})

test('non-Commit and wrong-epoch frames are refused before resolver or mutation', async () => {
  const group = await createRealGroup(2, 'apply-commit-refused')
  const self = member(group)
  const past = await buildRealCommit(group)
  await self.handle.processMessage(past)
  await noteCommit(group, ['current'])
  const future = await noteCommit(group, ['ahead'])
  const application = await group.committer.handle.encrypt(new TextEncoder().encode('message'))
  for (const bytes of [new Uint8Array([0xff, 0xff]), application, past, future]) {
    const resolve = vi.fn(group.resolveLedgerEntries)
    const persist = vi.fn(async () => {})
    const before = self.handle.epoch
    const result = await applyCommit(self.handle, bytes, context(group, self, resolve), persist)
    expect(result).toMatchObject({
      advanced: false,
      epochBefore: Number(before),
      epochAfter: Number(before),
      surfacedEntries: [],
    })
    expect(result.rosterAfter).toEqual(result.rosterBefore)
    expect(resolve).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    expect(self.handle.epoch).toBe(before)
  }
})

test('an own authenticated commit is refused and names its committer', async () => {
  const group = await createRealGroup(1, 'apply-commit-own')
  const self = group.committer
  const token = await signLedgerEntry(self.identity, {
    type: 'app.note',
    groupID: self.handle.groupID,
    subject: self.identity.id,
    value: 'own',
  })
  group.bodies.set(ledgerEntryDigest(token), token)
  // Built from the live handle and not adopted, so it is framed at this handle's epoch.
  const own = (await commitLedgerEntries(self.handle, [token])).commitMessage
  const resolve = vi.fn(group.resolveLedgerEntries)
  const before = self.handle.epoch

  const result = await applyCommit(self.handle, own, context(group, self, resolve))

  expect(result).toMatchObject({ advanced: false, committerDID: self.identity.id })
  expect(resolve).not.toHaveBeenCalled()
  expect(self.handle.epoch).toBe(before)
})

test('a commit that removes this member does not advance and reports the tree it left', async () => {
  const group = await createRealGroup(2, 'apply-commit-removed')
  const self = member(group)
  const commit = await buildRealCommit(group, { removes: 0 })
  const before = self.handle.epoch

  const result = await applyCommit(self.handle, commit, context(group, self))

  expect(result.advanced).toBe(false)
  expect(result.epochAfter).toBe(Number(before))
  expect(result.rosterAfter.map((e) => e.did)).not.toContain(self.identity.id)
})

test('a failed persist propagates and leaves the handle at its epoch', async () => {
  const group = await createRealGroup(1, 'apply-commit-persist')
  const self = member(group)
  const commit = await noteCommit(group, ['x'])
  const before = self.handle.epoch
  await expect(
    applyCommit(self.handle, commit, context(group, self), async () => {
      throw new Error('disk failed')
    }),
  ).rejects.toThrow('disk failed')
  expect(self.handle.epoch).toBe(before)
})

test('missing entry bodies propagate for the caller to classify', async () => {
  const group = await createRealGroup(1, 'apply-commit-missing')
  const self = member(group)
  const commit = await noteCommit(group, ['x'])
  const before = self.handle.epoch
  await expect(
    applyCommit(
      self.handle,
      commit,
      context(group, self, async () => []),
    ),
  ).rejects.toBeInstanceOf(MissingLedgerEntriesError)
  expect(self.handle.epoch).toBe(before)
})

test('a host callback throwing after durable acceptance still reports the advance', async () => {
  const group = await createRealGroup(1, 'apply-commit-callback')
  const self = member(group)
  self.handle = await restoreGroup({
    state: self.handle.state,
    credential: self.handle.credential,
    ledgerEntries: self.handle.ledgerTokens,
    options: {
      resolveLedgerEntries: self.slot.resolve,
      onLedgerEntries: () => {
        throw new Error('host callback failed')
      },
    },
  })
  const commit = await noteCommit(group, ['x'])
  const persist = vi.fn(async () => {})
  const result = await applyCommit(self.handle, commit, context(group, self), persist)
  expect(result.advanced).toBe(true)
  expect(persist).toHaveBeenCalledOnce()
})
