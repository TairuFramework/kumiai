import { toUTF } from '@sozai/codec'
import { expect, test } from 'vitest'

import type { StagedAdoption } from '../src/control/types.js'
import { asLogPosition } from '../src/cursor.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'
import { createMemoryGroupMLS, memoryEntryID } from './fixtures/memory-group-mls.js'

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
