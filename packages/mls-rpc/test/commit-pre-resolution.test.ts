import { MissingLedgerEntriesError, readCommitEntryIDs } from '@kumiai/mls'
import { expect, test, vi } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createGroupCrypto } from '../src/crypto.js'
import { createGroupMLS } from '../src/mls.js'
import { buildRealCommit, createRealGroup } from './fixtures/real-group.js'

test('a commit resolves entries through access.read without re-entering mutate', async () => {
  const group = await createRealGroup(1, 'pre-resolve-real-commit')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const access = simpleHandleAccess({
    handle: () => member.handle,
    adopt: (next) => {
      member.handle = next
    },
  })
  const crypto = createGroupCrypto({ access })
  const mls = createGroupMLS({ access, identity: member.identity, entrySlot: member.slot })
  const commit = await buildRealCommit(group)
  expect(readCommitEntryIDs(commit).length).toBeGreaterThan(0)
  const resolver = vi.fn(async (ids: Array<string>) => {
    await access.read((handle) => handle.epoch)
    const sealed = await crypto.sealEntries(new TextEncoder().encode(JSON.stringify(ids)))
    await crypto.openEntries(sealed)
    return await group.resolveLedgerEntries(ids)
  })
  await expect(
    mls.processCommit(commit, {
      senderDID: group.committer.identity.id,
      resolveLedgerEntries: resolver,
    }),
  ).resolves.toEqual({ advanced: true })
  expect(resolver).toHaveBeenCalledOnce()
}, 3000)

test('an empty entry list skips the resolver', async () => {
  const group = await createRealGroup(2, 'pre-resolve-empty')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const access = simpleHandleAccess({ handle: () => member.handle, adopt: () => {} })
  const mls = createGroupMLS({ access, identity: member.identity, entrySlot: member.slot })
  const commit = await buildRealCommit(group, { removes: 1 })
  expect(readCommitEntryIDs(commit)).toEqual([])
  const resolver = vi.fn(group.resolveLedgerEntries)
  await mls.processCommit(commit, {
    senderDID: group.committer.identity.id,
    resolveLedgerEntries: resolver,
  })
  expect(resolver).not.toHaveBeenCalled()
})

test('an epoch move during pre-resolution rejects without applying the old commit', async () => {
  const group = await createRealGroup(1, 'pre-resolve-epoch-move')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const access = simpleHandleAccess({
    handle: () => member.handle,
    adopt: (next) => {
      member.handle = next
    },
  })
  const mls = createGroupMLS({ access, identity: member.identity, entrySlot: member.slot })
  const commit = await buildRealCommit(group)
  const resolver = async (ids: Array<string>) => {
    await access.replace(group.committer.handle)
    return await group.resolveLedgerEntries(ids)
  }
  await expect(
    mls.processCommit(commit, {
      senderDID: group.committer.identity.id,
      resolveLedgerEntries: resolver,
    }),
  ).rejects.toThrow('commit epoch changed during entry resolution')
  expect(member.handle).toBe(group.committer.handle)
})

test('wrong-epoch and non-Commit frames never open entry bodies', async () => {
  const group = await createRealGroup(1, 'pre-resolve-wrong-epoch')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const access = simpleHandleAccess({
    handle: () => member.handle,
    adopt: (next) => {
      member.handle = next
    },
  })
  const mls = createGroupMLS({ access, identity: member.identity, entrySlot: member.slot })
  const commit = await buildRealCommit(group)
  const opened = vi.fn(group.resolveLedgerEntries)
  await access.replace(group.committer.handle)
  await expect(
    mls.processCommit(commit, {
      senderDID: group.committer.identity.id,
      resolveLedgerEntries: opened,
    }),
  ).resolves.toEqual({ advanced: false })
  await expect(
    mls.processCommit(new Uint8Array([0]), {
      senderDID: group.committer.identity.id,
      resolveLedgerEntries: opened,
    }),
  ).resolves.toEqual({ advanced: false })
  expect(readCommitEntryIDs(new Uint8Array([0]))).toEqual([])
  expect(opened).not.toHaveBeenCalled()
})

test('resolver faults and missing bodies retain their error boundary', async () => {
  const group = await createRealGroup(1, 'pre-resolve-errors')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const access = simpleHandleAccess({ handle: () => member.handle, adopt: () => {} })
  const mls = createGroupMLS({ access, identity: member.identity, entrySlot: member.slot })
  const commit = await buildRealCommit(group)
  const fault = new Error('blob open failed')
  await expect(
    mls.processCommit(commit, {
      senderDID: group.committer.identity.id,
      resolveLedgerEntries: async () => {
        throw fault
      },
    }),
  ).rejects.toBe(fault)
  await expect(
    mls.processCommit(commit, {
      senderDID: group.committer.identity.id,
      resolveLedgerEntries: async () => [],
    }),
  ).rejects.toBeInstanceOf(MissingLedgerEntriesError)
})
