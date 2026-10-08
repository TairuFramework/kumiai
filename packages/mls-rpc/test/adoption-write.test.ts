import { encodeClientState } from '@kumiai/mls'
import type { AdoptionWrite, StagedAdoption } from '@kumiai/rpc'
import { expect, test } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createGroupMLS } from '../src/mls.js'
import { buildRealCommit, createRealGroup } from './fixtures/real-group.js'
import {
  createTransactionalAccess,
  createTransactionalStore,
} from './fixtures/transactional-access.js'

async function fixture(id: string) {
  const group = await createRealGroup(1, id)
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const saves: Array<{ state: Uint8Array; write: AdoptionWrite | undefined }> = []
  let failSave = false
  const access = simpleHandleAccess({
    handle: () => member.handle,
    adopt: (next) => {
      member.handle = next
    },
    persist: (handle, write) => {
      if (failSave) throw new Error('save failed')
      saves.push({ state: encodeClientState(handle.state), write })
    },
  })
  return {
    group,
    member,
    access,
    saves,
    failSave: () => {
      failSave = true
    },
    mls: createGroupMLS({ access, identity: member.identity, entrySlot: member.slot }),
  }
}

test('persist receives the write once and the factory sees the staged epoch', async () => {
  const host = await fixture('adoption-write-advance')
  const before = Number(host.member.handle.epoch)
  const commit = await buildRealCommit(host.group)
  const staged: Array<StagedAdoption> = []
  const write: AdoptionWrite = { mutationID: crypto.randomUUID(), changes: {} }
  const result = await host.mls.processCommit(commit, {
    resolveLedgerEntries: host.group.resolveLedgerEntries,
    adoption: (summary) => {
      staged.push(summary)
      return write
    },
  })

  expect(host.saves).toHaveLength(1)
  expect(host.saves[0]?.write?.mutationID).toBe(write.mutationID)
  expect(staged).toHaveLength(1)
  expect(staged[0]).toMatchObject({ epochAfter: before + 1, removed: false })
  expect(staged[0]?.epochAuthenticator).toEqual(
    host.member.handle.state.keySchedule.epochAuthenticator,
  )
  expect(result).toEqual({
    applied: true,
    advanced: true,
    epochBefore: before,
    epochAfter: before + 1,
  })
})

test('self-removal is applied and saved with removed true without advancing', async () => {
  const host = await fixture('adoption-write-removal')
  const before = Number(host.member.handle.epoch)
  const commit = await buildRealCommit(host.group, { removes: 0 })
  const staged: Array<StagedAdoption> = []
  const write: AdoptionWrite = { mutationID: crypto.randomUUID(), changes: {} }
  const result = await host.mls.processCommit(commit, {
    resolveLedgerEntries: host.group.resolveLedgerEntries,
    adoption: (summary) => {
      staged.push(summary)
      return write
    },
  })

  expect(result).toEqual({
    applied: true,
    advanced: false,
    epochBefore: before,
    epochAfter: before,
  })
  expect(staged[0]).toMatchObject({ epochAfter: before, removed: true })
  expect(host.member.handle.listMembers().map((entry) => entry.id)).not.toContain(
    host.member.identity.id,
  )
  expect(host.saves).toHaveLength(1)
  expect(host.saves[0]?.write).toEqual(write)
})

test.each([false, true])(
  'failed save leaves epoch, roster and ledger unchanged (removal %s)',
  async (removal) => {
    const host = await fixture(`adoption-write-rollback-${removal}`)
    const handle = host.member.handle
    const before = {
      state: encodeClientState(handle.state),
      roster: handle.listMembers(),
      ledger: handle.ledgerTokens,
    }
    const commit = await buildRealCommit(host.group, removal ? { removes: 0 } : {})
    host.failSave()
    await expect(
      host.mls.processCommit(commit, {
        resolveLedgerEntries: host.group.resolveLedgerEntries,
        adoption: () => ({ mutationID: crypto.randomUUID(), changes: {} }),
      }),
    ).rejects.toThrow('save failed')

    expect(host.member.handle).toBe(handle)
    expect(encodeClientState(handle.state)).toEqual(before.state)
    expect(handle.listMembers()).toEqual(before.roster)
    expect(handle.ledgerTokens).toEqual(before.ledger)
    expect(host.access.epoch()).toBe(Number(handle.epoch))
    expect(host.saves).toEqual([])
  },
)

test('refused commits never run the adoption factory or persist', async () => {
  const host = await fixture('adoption-write-refused')
  const before = Number(host.member.handle.epoch)
  const commit = await buildRealCommit(host.group)
  let calls = 0
  const context = {
    resolveLedgerEntries: host.group.resolveLedgerEntries,
    adoption: () => {
      calls++
      return { mutationID: crypto.randomUUID(), changes: {} }
    },
  }
  await host.mls.processCommit(commit, context)
  host.saves.length = 0
  calls = 0
  for (const bytes of [commit, new Uint8Array([0])]) {
    expect(await host.mls.processCommit(bytes, context)).toEqual({
      applied: false,
      advanced: false,
      epochBefore: before + 1,
      epochAfter: before + 1,
    })
  }
  expect(calls).toBe(0)
  expect(host.saves).toEqual([])
})

test('replacement saves its staged write before publishing the new handle', async () => {
  const host = await fixture('adoption-write-replace')
  const previous = host.member.handle
  await buildRealCommit(host.group)
  const next = host.group.committer.handle
  const write: AdoptionWrite = { mutationID: crypto.randomUUID(), changes: {} }
  await host.access.replace(next, (summary) => {
    expect(host.member.handle).toBe(previous)
    expect(summary).toMatchObject({ epochAfter: Number(next.epoch), removed: false })
    expect(summary.epochAuthenticator).toEqual(next.state.keySchedule.epochAuthenticator)
    return write
  })
  expect(host.saves[0]?.write).toEqual(write)
  expect(host.member.handle).toBe(next)
})

test('transactional access co-commits the adoption write with its staged state', async () => {
  const group = await createRealGroup(1, 'adoption-write-transactional')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const store = createTransactionalStore(member.handle)
  const host = await createTransactionalAccess(member, store)
  const mls = createGroupMLS({
    access: host.access,
    identity: member.identity,
    entrySlot: member.slot,
  })
  const commit = await buildRealCommit(group)
  const mutationID = crypto.randomUUID()
  const context = {
    resolveLedgerEntries: group.resolveLedgerEntries,
    adoption: () => ({
      mutationID,
      changes: {
        putOutcomes: [{ id: crypto.randomUUID(), opID: null, at: 100, kind: 'unknown' as const }],
      },
    }),
  }
  const before = store.snapshot()
  store.beforeWrite = () => {
    throw new Error('save failed')
  }
  await expect(mls.processCommit(commit, context)).rejects.toThrow('save failed')
  expect(store.snapshot()).toBe(before)
  store.beforeWrite = undefined
  await mls.processCommit(commit, context)
  expect(store.snapshot().mutationID).toBe(mutationID)
  expect(store.snapshot().control.outcomes).toHaveLength(1)
  expect(store.snapshot().state).toEqual(encodeClientState(host.live().state))
})
