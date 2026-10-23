import { randomIdentity } from '@kokuin/token'
import { createGroup } from '@kumiai/mls'
import { createLedgerEntrySlot } from '@kumiai/mls-rpc'
import { testAppOutboxConformance } from '@kumiai/rpc-conformance'
import { expect, test, vi } from 'vitest'

import { createMemoryAppOutbox, createMemoryStateStore, makeMember } from './app-lane-e2e.js'
import { createWireHub } from './log-hub-over-wire.js'

testAppOutboxConformance({ label: 'integration host outbox', createOutbox: createMemoryAppOutbox })

testAppOutboxConformance({
  label: 'atomic integration host database',
  createOutbox: () => {
    const store = createMemoryStateStore({ groupID: crypto.randomUUID(), incarnation: 1 })
    return { ...store.appOutbox, failNextPut: () => store.database.failNext('mid-apply') }
  },
})

test('real MLS accepts pre-init dispatches in order and retains them across peer restart', async () => {
  const hub = createWireHub()
  const identity = randomIdentity()
  const group = (await createGroup(identity, 'outbox-restart')).group
  const entrySlot = createLedgerEntrySlot()
  const member = makeMember({ hub, identity, group, entrySlot })
  try {
    await Promise.all([
      member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'first' } }),
      member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'second' } }),
    ])
    const entries = await member.appOutbox.list()
    expect(entries.map((entry) => entry.seq)).toEqual([0, 1])
    expect(entries.map((entry) => entry.lastAttempt)).toEqual([null, null])
    await member.peer.dispose()
    await member.peer.drained()
    const replacement = makeMember({
      hub,
      identity,
      group: member.handle(),
      entrySlot,
      restartOf: member,
    })
    try {
      await replacement.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'third' } })
      expect((await replacement.appOutbox.list()).slice(0, 2)).toEqual(entries)
      expect((await replacement.appOutbox.list()).map((entry) => entry.seq)).toEqual([0, 1, 2])
    } finally {
      await replacement.peer.dispose()
      await replacement.peer.drained()
    }
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
    await hub.dispose()
  }
})

test('ambiguous application preparation returns only a committed attempt', async () => {
  const hub = createWireHub()
  const identity = randomIdentity()
  const group = (await createGroup(identity, 'outbox-ambiguous-preparation')).group
  const member = makeMember({ hub, identity, group, entrySlot: createLedgerEntrySlot() })
  try {
    await member.peer.replay()
    member.stateStore.database.commitThenRejectNext('save')
    await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'committed once' } })
    await vi.waitFor(async () => expect(await member.appOutbox.list()).toEqual([]), {
      timeout: 2500,
    })
    expect(
      (await member.appOutbox.events()).filter((event) => event.kind === 'accepted'),
    ).toHaveLength(1)
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
    await hub.dispose()
  }
})
