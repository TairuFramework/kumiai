import { commitLedgerEntries, ledgerEntryDigest, restoreGroup, signLedgerEntry } from '@kumiai/mls'
import { expect, test, vi } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createGroupMLS } from '../src/mls.js'
import { buildRealCommit, buildRealExternalCommit, createRealGroup } from './fixtures/real-group.js'

test('a refused commit does not save unchanged state', async () => {
  const group = await createRealGroup(1, 'rpc-refused-save')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const persist = vi.fn()
  const access = simpleHandleAccess({ handle: () => member.handle, adopt: () => {}, persist })
  const port = createGroupMLS({ access, identity: member.identity, entrySlot: member.slot })
  const { forged } = await buildRealExternalCommit(group, {
    rejoining: 0,
    forgeAs: 'did:key:forged',
  })
  await expect(port.processCommit(forged, { senderDID: 'did:key:forged' })).resolves.toEqual({
    advanced: false,
  })
  expect(persist).not.toHaveBeenCalled()
})

test('processCommit keeps the handle at its old epoch on failed persist and retries', async () => {
  const group = await createRealGroup(1, 'rpc-persist-commit')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const adopt = vi.fn()
  let fail = true
  const persist = vi.fn(async () => {
    if (fail) throw new Error('disk failed')
  })
  const access = simpleHandleAccess({ handle: () => member.handle, adopt, persist })
  const port = createGroupMLS({
    access,
    identity: member.identity,
    entrySlot: member.slot,
  })
  const commit = await buildRealCommit(group)
  const before = { epoch: member.handle.epoch, ledger: member.handle.ledgerTokens }
  const context = {
    senderDID: group.committer.identity.id,
    resolveLedgerEntries: group.resolveLedgerEntries,
  }
  await expect(port.processCommit(commit, context)).rejects.toThrow('disk failed')
  expect(member.handle.epoch).toBe(before.epoch)
  expect(access.epoch()).toBe(Number(before.epoch))
  expect(member.handle.ledgerTokens).toEqual(before.ledger)
  expect(adopt).not.toHaveBeenCalled()
  fail = false
  await expect(port.processCommit(commit, context)).resolves.toEqual({ advanced: true })
  expect(member.handle.epoch).toBe(before.epoch + 1n)
  expect(access.epoch()).toBe(Number(before.epoch + 1n))
  expect(persist).toHaveBeenCalledTimes(2)
})

test('processCommit reports an advance when a post-persist host callback throws', async () => {
  const group = await createRealGroup(1, 'rpc-callback-advance')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  member.handle = await restoreGroup({
    state: member.handle.state,
    credential: member.handle.credential,
    ledgerEntries: member.handle.ledgerTokens,
    options: {
      resolveLedgerEntries: member.slot.resolve,
      onLedgerEntries: () => {
        throw new Error('host callback failed')
      },
    },
  })
  const persist = vi.fn()
  const port = createGroupMLS({
    access: simpleHandleAccess({ handle: () => member.handle, adopt: vi.fn(), persist }),
    identity: member.identity,
    entrySlot: member.slot,
  })
  const note = await signLedgerEntry(group.committer.identity, {
    type: 'note',
    groupID: member.handle.groupID,
    subject: member.identity.id,
    value: 'callback',
  })
  group.bodies.set(ledgerEntryDigest(note), note)
  const authored = await commitLedgerEntries(group.committer.handle, [note])
  group.committer.handle = authored.newGroup
  const commit = authored.commitMessage
  const before = member.handle.epoch
  await expect(
    port.processCommit(commit, {
      senderDID: group.committer.identity.id,
      resolveLedgerEntries: group.resolveLedgerEntries,
    }),
  ).resolves.toEqual({ advanced: true })
  expect(persist).toHaveBeenCalledOnce()
  expect(member.handle.epoch).toBe(before + 1n)
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
    access: simpleHandleAccess({ handle: () => member.handle, adopt, persist }),
    identity: member.identity,
    entrySlot: member.slot,
  })
  const responder = createGroupMLS({
    access: simpleHandleAccess({ handle: () => group.committer.handle, adopt: vi.fn() }),
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

test('a recovery key expires without another request', async () => {
  const group = await createRealGroup(1, 'rpc-recovery-ttl')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const requester = createGroupMLS({
    access: simpleHandleAccess({
      handle: () => member.handle,
      adopt: (next) => {
        member.handle = next
      },
    }),
    identity: member.identity,
    entrySlot: member.slot,
  })
  const responder = createGroupMLS({
    access: simpleHandleAccess({ handle: () => group.committer.handle, adopt: vi.fn() }),
    identity: group.committer.identity,
    entrySlot: group.committer.slot,
  })
  vi.useFakeTimers()
  try {
    const requestID = 'expires-without-sweep'
    const request = await requester.createRecoveryRequest(requestID)
    const sealed = await responder.sealGroupInfo(request)
    await vi.advanceTimersByTimeAsync(120_001)
    expect(await requester.applyRecovery(sealed, requestID)).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

test('accepting an older recovery cannot delete a replacement request key', async () => {
  const group = await createRealGroup(1, 'rpc-recovery-replaced-key')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const requester = createGroupMLS({
    access: simpleHandleAccess({
      handle: () => member.handle,
      adopt: (next) => {
        member.handle = next
      },
    }),
    identity: member.identity,
    entrySlot: member.slot,
  })
  const responder = createGroupMLS({
    access: simpleHandleAccess({ handle: () => group.committer.handle, adopt: vi.fn() }),
    identity: group.committer.identity,
    entrySlot: group.committer.slot,
  })
  const id = 'reused-request-id'
  const first = await requester.createRecoveryRequest(id)
  const firstPending = await requester.applyRecovery(await responder.sealGroupInfo(first), id)
  if (firstPending == null) throw new Error('expected first recovery')
  const replacement = await requester.createRecoveryRequest(id)
  const replacementReply = await responder.sealGroupInfo(replacement)
  await firstPending.onAccepted()
  expect(await requester.applyRecovery(replacementReply, id)).not.toBeNull()
})
