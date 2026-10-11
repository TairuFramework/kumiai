import { toUTF } from '@sozai/codec'
import { expect, test } from 'vitest'

import type { StagedAdoption } from '../src/control/types.js'
import { asLogPosition } from '../src/cursor.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'
import { createMemoryGroupMLS, memoryEntryID } from './fixtures/memory-group-mls.js'

test.each([false, true])(
  'competing rotation prevents own candidate settlement (restart %s)',
  async (restart) => {
    const groupID = `competing-adoption-${restart}`
    const hostDB = createMemoryHostDatabase()
    const options = { groupID, members: ['alice', 'bob'] }
    const alice = createMemoryGroupMLS({ ...options, localDID: 'alice' })
    let bob = createMemoryGroupMLS({ ...options, hostDB, localDID: 'bob' })
    const source = await bob.readRecoverySource()
    const expected = {
      epoch: source.epoch,
      authenticatorBefore: source.authenticator,
      incarnation: source.key.incarnation,
    }
    const before = bob.serializeState()
    const ownCommit = bob.buildCommit()
    bob.adopt(ownCommit)
    const candidate = bob.serializeState()
    const ownAuthenticator = bob.authenticator()
    bob.restoreState(before)
    const otherCommit = alice.buildCommit()
    expect(ownCommit).not.toEqual(otherCommit)
    await bob.processCommit(otherCommit, {})
    if (restart) {
      const saved = await hostDB.loadState(groupID)
      if (saved == null) throw new Error('missing saved state')
      bob = createMemoryGroupMLS({ ...options, hostDB, localDID: 'bob' })
      bob.restoreState(saved)
    }
    const current = bob.serializeState()
    const write = { mutationID: 'wrong-branch', changes: { deleteOperations: ['rotation'] } }
    expect(await bob.adoptOperation(candidate, expected, write)).toBe('moved')
    expect(bob.authenticator()).not.toEqual(ownAuthenticator)
    expect(bob.serializeState()).toEqual(current)
    expect(await hostDB.loadState(groupID)).toEqual(current)
    expect(await hostDB.control(groupID).lastMutation()).toBeNull()
  },
)

test('own rotation identity survives installation and idempotent replay after restart', async () => {
  const groupID = 'rotation-replay'
  const hostDB = createMemoryHostDatabase()
  const options = { groupID, hostDB, localDID: 'bob', members: ['alice', 'bob'] }
  const bob = createMemoryGroupMLS(options)
  const source = await bob.readRecoverySource()
  const expected = {
    epoch: source.epoch,
    authenticatorBefore: source.authenticator,
    incarnation: source.key.incarnation,
  }
  const before = bob.serializeState()
  bob.adopt(bob.buildCommit())
  const candidate = bob.serializeState()
  const authenticator = bob.authenticator()
  bob.restoreState(before)
  const write = { mutationID: 'own-branch', changes: {} }
  expect(await bob.adoptOperation(candidate, expected, write)).toBe('installed')
  const saved = await hostDB.loadState(groupID)
  if (saved == null) throw new Error('missing saved state')
  const restored = createMemoryGroupMLS(options)
  restored.restoreState(saved)
  expect(restored.authenticator()).toEqual(authenticator)
  expect(await restored.adoptOperation(candidate, expected, write)).toBe('noop')
})

test.each([false, true])(
  'memory MLS co-commits staged state and control (removal %s)',
  async (removed) => {
    const hostDB = createMemoryHostDatabase()
    const groupID = `adoption-${removed}`
    const reader = createMemoryGroupMLS({
      groupID,
      hostDB,
      localDID: 'reader',
      members: ['admin', 'reader'],
    })
    const author = createMemoryGroupMLS({ localDID: 'admin', members: ['admin', 'reader'] })
    const token = 'role:reader=member'
    const commit = author.buildCommit([token], { removes: removed ? ['reader'] : [] })
    const staged: Array<StagedAdoption> = []
    const mutationID = crypto.randomUUID()
    const result = await reader.processCommit(commit, {
      resolveLedgerEntries: async () => [token],
      adoption: (summary) => {
        expect(reader.epoch()).toBe(0)
        expect(reader.leaves()).toContain('reader')
        expect(reader.ledgerIDs()).toEqual([])
        staged.push(summary)
        return {
          mutationID,
          changes: { cursor: { position: asLogPosition('1'), epoch: summary.epochAfter } },
        }
      },
    })
    const epochAfter = removed ? 0 : 1
    expect(result).toEqual({ applied: true, advanced: !removed, epochBefore: 0, epochAfter })
    expect(staged).toHaveLength(1)
    expect(staged[0]).toMatchObject({ epochAfter, removed })
    expect(staged[0]?.epochAuthenticator).toBeInstanceOf(Uint8Array)
    expect(reader.ledgerIDs()).toEqual([memoryEntryID(token)])
    const state = await hostDB.loadState(groupID)
    if (state == null) throw new Error('state was not saved')
    expect(JSON.parse(toUTF(state))).toMatchObject({ epoch: epochAfter })
    expect(await hostDB.control(groupID).lastMutation()).toBe(mutationID)
    expect((await hostDB.control(groupID).load()).cursor).toEqual({
      position: '1',
      epoch: epochAfter,
    })
  },
)

test.each([false, true])(
  'memory MLS failed save leaves state and control unchanged (removal %s)',
  async (removed) => {
    const hostDB = createMemoryHostDatabase()
    const groupID = `adoption-failed-${removed}`
    const reader = createMemoryGroupMLS({
      groupID,
      hostDB,
      localDID: 'reader',
      members: ['admin', 'reader'],
    })
    const author = createMemoryGroupMLS({ localDID: 'admin' })
    const token = 'role:reader=member'
    const commit = author.buildCommit([token], { removes: removed ? ['reader'] : [] })
    hostDB.failNext('mid-save')
    const context = {
      resolveLedgerEntries: async () => [token],
      adoption: () => ({
        mutationID: crypto.randomUUID(),
        changes: { cursor: { position: asLogPosition('1'), epoch: 1 } },
      }),
    }
    await expect(reader.processCommit(commit, context)).rejects.toThrow(
      'Injected transaction failure',
    )
    expect(reader.epoch()).toBe(0)
    expect(reader.leaves()).toEqual(['admin', 'reader'])
    expect(reader.ledgerIDs()).toEqual([])
    expect(reader.commits()).toBe(0)
    expect(await reader.getLedger()).toEqual([])
    expect(await hostDB.loadState(groupID)).toBeNull()
    expect(await hostDB.control(groupID).lastMutation()).toBeNull()
    expect((await hostDB.control(groupID).load()).cursor).toBeNull()
    // Resolved bodies must roll back too: retry still needs the frame's resolver.
    await expect(reader.processCommit(commit, {})).rejects.toThrow(/missing ledger entries/)
    await expect(reader.processCommit(commit, context)).resolves.toMatchObject({ applied: true })
  },
)
