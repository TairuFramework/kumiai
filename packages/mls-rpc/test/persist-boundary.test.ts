import { expect, test, vi } from 'vitest'

import { createGroupMLS } from '../src/mls.js'
import { buildRealCommit, createRealGroup } from './fixtures/real-group.js'

test('processCommit keeps the handle at its old epoch on failed persist and retries', async () => {
  const group = await createRealGroup(1, 'rpc-persist-commit')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const adopt = vi.fn()
  let fail = true
  const persist = vi.fn(async () => {
    if (fail) throw new Error('disk failed')
  })
  const port = createGroupMLS({
    handle: () => member.handle,
    adopt,
    identity: member.identity,
    entrySlot: member.slot,
    persist,
  })
  const commit = await buildRealCommit(group)
  const before = { epoch: member.handle.epoch, ledger: member.handle.ledgerTokens }
  const context = {
    senderDID: group.committer.identity.id,
    resolveLedgerEntries: group.resolveLedgerEntries,
  }
  await expect(port.processCommit(commit, context)).rejects.toThrow('disk failed')
  expect(member.handle.epoch).toBe(before.epoch)
  expect(member.handle.ledgerTokens).toEqual(before.ledger)
  expect(adopt).not.toHaveBeenCalled()
  fail = false
  await expect(port.processCommit(commit, context)).resolves.toEqual({ advanced: true })
  expect(member.handle.epoch).toBe(before.epoch + 1n)
  expect(persist).toHaveBeenCalledTimes(2)
})

test('recovery persists before adoption and bootstrap retries after a failed persist', async () => {
  const group = await createRealGroup(1, 'rpc-persist-recovery')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const old = member.handle
  await buildRealCommit(group)
  // The requester missed this commit; the responder holds the newer epoch.
  const adopt = vi.fn((next: typeof old) => {
    member.handle = next
  })
  let fail = true
  const persist = vi.fn(async () => {
    if (fail) throw new Error('disk failed')
  })
  const requester = createGroupMLS({
    handle: () => member.handle,
    adopt,
    identity: member.identity,
    entrySlot: member.slot,
    persist,
  })
  const responder = createGroupMLS({
    handle: () => group.committer.handle,
    adopt: vi.fn(),
    identity: group.committer.identity,
    entrySlot: group.committer.slot,
  })
  const requestID = 'persist-recovery-request'
  const request = await requester.createRecoveryRequest(requestID)
  const sealed = await responder.sealGroupInfo(request)
  const pending = await requester.applyRecovery(sealed, requestID)
  if (pending == null) throw new Error('expected recovery')
  await expect(pending.onAccepted()).rejects.toThrow('disk failed')
  expect(adopt).not.toHaveBeenCalled()
  expect(member.handle).toBe(old)
  expect(member.handle.epoch).toBe(old.epoch)
  fail = false
  await pending.onAccepted()
  expect(adopt).toHaveBeenCalledOnce()
  expect(member.handle).not.toBe(old)
  const rejoined = member.handle
  const before = { epoch: rejoined.epoch, ledger: rejoined.ledgerTokens }
  expect(await requester.isLedgerComplete()).toBe(false)
  fail = true
  const tokens = await group.committer.handle.getLedger()
  await expect(requester.bootstrapLedger(tokens)).rejects.toThrow('disk failed')
  expect(member.handle).toBe(rejoined)
  expect(member.handle.epoch).toBe(before.epoch)
  expect(member.handle.ledgerTokens).toEqual(before.ledger)
  fail = false
  await requester.bootstrapLedger(tokens)
  expect(member.handle.ledgerTokens).toEqual(tokens)
})
