import { encodeEventFrame } from '@kumiai/broadcast'
import { expect, test } from 'vitest'

import type { AppOutboxEntry } from '../src/app-outbox.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'

async function setup() {
  const groupID = crypto.randomUUID()
  const db = createMemoryHostDatabase()
  const mls = createMemoryGroupMLS({ groupID, hostDB: db, localDID: 'alice', members: ['alice'] })
  await mls.persistInitialState()
  const source = await mls.readRecoverySource()
  if (source.identity === null) throw new Error('Missing identity')
  const outbox = db.appOutbox(groupID, source.key)
  const entry: AppOutboxEntry = {
    seq: 0,
    protocol: 'chat',
    prc: 'posted',
    data: encodeEventFrame('posted', {}),
    status: 'accepted',
    lastAttempt: {
      incarnation: source.key.incarnation,
      epoch: source.identity.epoch,
      attempts: 1,
      floor: null,
      publishID: crypto.randomUUID(),
      segment: source.identity.epoch,
      topicID: 'chat-topic',
    },
  }
  await outbox.put(entry)
  if (entry.lastAttempt === null) throw new Error('Missing attempt')
  const expected = {
    identity: structuredClone(source.identity),
    stateVersion: source.stateVersion,
    attemptID: entry.lastAttempt.publishID,
  }
  const obligation = {
    sequenceID: 'accepted-position',
    attemptID: expected.attemptID,
    topicID: entry.lastAttempt.topicID,
    outcome: 'published' as const,
  }
  const inventory = async () => {
    return {
      state: await db.snapshot(groupID),
      entries: await outbox.list(),
      events: await outbox.events(),
      obligation: await outbox.loadSettlement(0),
    }
  }
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  db.seam('before-apply', async () => {
    entered.resolve()
    await release.promise
  })
  return { db, mls, outbox, groupID, entry, expected, obligation, inventory, entered, release }
}

test.each([
  ['version', 'state-version-changed'],
  ['identity', 'identity-changed'],
  ['attempt', 'attempt-changed'],
  ['entry', 'entry-missing'],
] as const)(
  'host certification revalidates acquired %s and leaves refusal unchanged',
  async (kind, reason) => {
    const f = await setup()
    const pending = f.outbox.recordSettlement(0, f.obligation, f.expected)
    try {
      await f.entered.promise
      if (kind === 'version') await f.db.saveState(f.groupID, f.mls.serializeState())
      else if (kind === 'identity') {
        f.mls.adopt(f.mls.buildCommit())
        await f.db.saveState(f.groupID, f.mls.serializeState())
      } else if (kind === 'attempt') {
        if (f.entry.lastAttempt === null) throw new Error('Missing attempt')
        await f.outbox.put({
          ...f.entry,
          lastAttempt: { ...f.entry.lastAttempt, publishID: crypto.randomUUID() },
        })
      } else await f.outbox.remove(0)
      const before = await f.inventory()
      let effects = 0
      f.db.seam('after-apply', () => {
        effects++
      })
      f.release.resolve()
      expect(await pending).toEqual({ recorded: false, reason })
      expect(await f.inventory()).toEqual(before)
      expect(effects).toBe(0)
    } finally {
      f.release.resolve()
      await pending
    }
  },
)

test('host certification captures expected state and obligation before waiting', async () => {
  const f = await setup()
  const original = structuredClone(f.obligation)
  const pending = f.outbox.recordSettlement(0, f.obligation, f.expected)
  try {
    await f.entered.promise
    f.expected.identity.authenticator.fill(0)
    f.expected.stateVersion++
    f.expected.attemptID = crypto.randomUUID()
    f.obligation.sequenceID = 'mutated-position'
    f.obligation.attemptID = crypto.randomUUID()
    f.obligation.topicID = 'mutated-topic'
    f.release.resolve()
    expect(await pending).toEqual({ recorded: true })
    expect(await f.outbox.loadSettlement(0)).toEqual(original)
  } finally {
    f.release.resolve()
    await pending
  }
})
