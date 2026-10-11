import { encodeClientState } from '@kumiai/mls'
import {
  type AdoptionWrite,
  type AnchorSlot,
  ControlWriteNotCommittedError,
  type StagedAdoption,
} from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createGroupMLS } from '../src/mls.js'
import { buildRealCommit, createRealGroup, testHandleAccess } from './fixtures/real-group.js'
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
  const access = testHandleAccess({
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

test('readControl returns the host version and a defensive single-incarnation identity', async () => {
  const group = await createRealGroup(1, 'group-A')
  const member = group.members[0]
  if (member == null) throw new Error('missing member')
  const store = createTransactionalStore(member.handle)
  const db = {
    loadVersion: async (groupID: string) => {
      if (groupID !== member.handle.groupID) throw new Error('wrong group')
      return store.snapshot().revision
    },
    saveState: async (_groupID: string, state: Uint8Array, write?: AdoptionWrite) =>
      store.save(store.snapshot().revision, state, member.handle.ledgerTokens, undefined, write),
  }
  await db.saveState('group-A', encodeClientState(member.handle.state))
  const access = simpleHandleAccess({
    handle: () => member.handle,
    stateVersion: () => db.loadVersion('group-A'),
    adopt: (next) => {
      member.handle = next
    },
    persist: (handle, write) => db.saveState('group-A', encodeClientState(handle.state), write),
  })
  const mls = createGroupMLS({ access, identity: member.identity, entrySlot: member.slot })
  const source = await mls.readRecoverySource()
  expect(source.key).toEqual({ groupID: 'group-A', incarnation: 1 })
  expect(source.stateVersion).toBe(await db.loadVersion('group-A'))
  expect(source.identity).toEqual({
    ...source.key,
    epoch: source.epoch,
    authenticator: source.authenticator,
  })
  expect(source.authenticator).toEqual(member.handle.state.keySchedule.epochAuthenticator)
  expect(source).not.toHaveProperty('lineage')
  source.key.incarnation = 9
  source.authenticator.fill(0)
  source.identity?.authenticator.fill(0)
  expect((await mls.readRecoverySource()).key.incarnation).toBe(1)
  expect((await mls.readRecoverySource()).authenticator).toEqual(
    member.handle.state.keySchedule.epochAuthenticator,
  )
  await access.readControl(async (scope) => {
    await db.saveState('group-A', encodeClientState(member.handle.state))
    const refreshed = await scope.refresh()
    expect(refreshed.source.stateVersion).toBe(await db.loadVersion('group-A'))
  })
  const staged: Array<StagedAdoption> = []
  const commit = await buildRealCommit(group)
  await mls.processCommit(commit, {
    resolveLedgerEntries: group.resolveLedgerEntries,
    adoption: (summary) => {
      staged.push(summary)
      return { mutationID: 'advance', changes: {} }
    },
  })
  expect(staged[0]?.incarnation).toBe(1)
})

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

test.each(['mutate', 'replace'] as const)(
  '%s rejects an adoption factory without persistence before changing state',
  async (operation) => {
    const group = await createRealGroup(1, `adoption-write-no-persist-${operation}`)
    const member = group.members[0]
    if (member == null) throw new Error('missing member')
    const access = testHandleAccess({
      handle: () => member.handle,
      adopt: (next) => {
        member.handle = next
      },
    })
    const previous = member.handle
    const before = {
      state: encodeClientState(previous.state),
      roster: previous.listMembers(),
      ledger: previous.ledgerTokens,
      admission: access.admission(),
    }
    const commit = await buildRealCommit(group)
    const next = group.committer.handle
    const confirm = vi.spyOn(next, 'confirmAdopted')
    let mutationCalls = 0
    let factoryCalls = 0
    const mutate = async () => {
      mutationCalls++
      await member.handle.processMessage(commit)
    }
    const adoption = () => {
      factoryCalls++
      return { mutationID: crypto.randomUUID(), changes: {} }
    }
    await expect(
      operation === 'mutate' ? access.mutate(mutate, adoption) : access.replace(next, adoption),
    ).rejects.toThrow(ControlWriteNotCommittedError)

    expect(mutationCalls).toBe(0)
    expect(factoryCalls).toBe(0)
    expect(confirm).not.toHaveBeenCalled()
    expect(member.handle).toBe(previous)
    expect(encodeClientState(previous.state)).toEqual(before.state)
    expect(previous.listMembers()).toEqual(before.roster)
    expect(previous.ledgerTokens).toEqual(before.ledger)
    expect(access.admission()).toEqual(before.admission)
    expect(access.epoch()).toBe(before.admission.epoch)

    // Existing callers without an adoption write still work, including after a rejection.
    if (operation === 'mutate') await access.mutate(mutate)
    else await access.replace(next)
    expect(access.epoch()).toBe(before.admission.epoch + 1)
  },
)

function pendingAnchor(epoch: number, roster: Array<string>): AnchorSlot {
  return {
    anchor: { epoch, secret: crypto.getRandomValues(new Uint8Array(32)) },
    pending: {
      epochBefore: epoch,
      epochAfter: epoch + 1,
      rosterBefore: roster,
      forced: false,
      advance: crypto.randomUUID(),
    },
  }
}

test.each(['mutate', 'replace'] as const)(
  'transactional %s co-commits state, control, mutation ID and anchor landed mark',
  async (operation) => {
    const group = await createRealGroup(1, `adoption-write-transactional-${operation}`)
    const member = group.members[0]
    if (member == null) throw new Error('missing member')
    const anchorSlot = pendingAnchor(
      Number(member.handle.epoch),
      member.handle.listMembers().map((entry) => entry.id),
    )
    const store = createTransactionalStore(member.handle, anchorSlot)
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
        anchorLanded: anchorSlot.pending?.advance,
        changes: {
          putOutcomes: [{ id: crypto.randomUUID(), opID: null, at: 100, kind: 'unknown' as const }],
        },
      }),
    }
    const adopt = () =>
      operation === 'mutate'
        ? mls.processCommit(commit, context)
        : host.access.replace(group.committer.handle, context.adoption)
    const before = store.snapshot()
    const live = host.live()
    const admission = host.access.admission()
    store.beforeWrite = () => {
      throw new Error('save failed')
    }
    await expect(adopt()).rejects.toThrow('save failed')
    expect(store.snapshot()).toBe(before)
    expect(store.snapshot().anchorSlot?.pending?.landed).toBeUndefined()
    expect(host.live()).toBe(live)
    expect(encodeClientState(host.live().state)).toEqual(before.state)
    expect(host.access.admission()).toEqual(admission)
    store.beforeWrite = undefined
    await adopt()
    expect(store.snapshot().mutationID).toBe(mutationID)
    expect(store.snapshot().control.outcomes).toHaveLength(1)
    expect(store.snapshot().state).toEqual(encodeClientState(host.live().state))
    expect(store.snapshot().state).not.toEqual(before.state)
    expect(store.snapshot().revision).toBe(before.revision + 1)
    expect(store.snapshot().anchorSlot?.pending?.landed).toBe(true)
    expect(before.anchorSlot?.pending?.landed).toBeUndefined()
    expect((await store.fork()).snapshot().anchorSlot?.pending?.landed).toBe(true)
  },
)

test.each([undefined, 'different-advance'])(
  'transactional saves keep an unmatched pending anchor unlanded (%s)',
  async (anchorLanded) => {
    const group = await createRealGroup(1, `adoption-write-anchor-unmatched-${anchorLanded}`)
    const member = group.members[0]
    if (member == null) throw new Error('missing member')
    const anchorSlot = pendingAnchor(
      Number(member.handle.epoch),
      member.handle.listMembers().map((entry) => entry.id),
    )
    const store = createTransactionalStore(member.handle, anchorSlot)
    const host = await createTransactionalAccess(member, store)
    const mutationID = crypto.randomUUID()
    await host.access.mutate(
      async () => {},
      () => ({ mutationID, changes: {}, anchorLanded }),
    )
    expect(store.snapshot().mutationID).toBe(mutationID)
    expect(store.snapshot().anchorSlot).toEqual(anchorSlot)
    expect(store.snapshot().anchorSlot?.pending?.landed).toBeUndefined()
  },
)
