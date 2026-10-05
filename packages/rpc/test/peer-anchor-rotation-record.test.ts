import { expect, test } from 'vitest'

import type { AnchorSlot } from '../src/anchor.js'
import { digestAppliedCommit } from '../src/classify.js'
import { RecoveryRequiredError } from '../src/commit.js'
import type { PendingRecovery } from '../src/crypto.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { createMemoryAnchorStore } from './fixtures/anchor.js'
import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { fakeEpochSecret } from './fixtures/fake-crypto.js'
import { encodeMemoryCommit, memoryEntryID } from './fixtures/memory-group-mls.js'
import {
  adoptJournalledBlob,
  buildInviteCommit,
  buildLedgerCommit,
  buildRemoveCommit,
  makeMLSPeer,
} from './fixtures/peer.js'

const recoverySecret = new Uint8Array(32).fill(0x97)
const members = ['alice', 'bob', 'carol']
const topic = (epoch: number) =>
  protocolTopic(fakeEpochSecret(epoch, APP_TOPIC_LABEL), epoch, 'chat')

test('a failed rotation-record write prevents adoption', async () => {
  const hub = new DurableFakeHub()
  const written = createMemoryAnchorStore()
  let reject = false
  const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
    members,
    anchorStore: {
      ...written,
      save: async (slot) => {
        if (reject) throw new Error('slot unavailable')
        await written.save(slot)
      },
    },
  })
  await bob.peer.replay()
  reject = true
  await expect(bob.peer.commit(buildRemoveCommit(bob, 'carol'))).rejects.toThrow('slot unavailable')
  expect(bob.mls.epoch()).toBe(1)
  await bob.peer.dispose()
})

test('throwing after adoption captures the roster epoch before another advance', async () => {
  const hub = new DurableFakeHub()
  const seen: Array<unknown> = []
  const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
    members,
    handlers: { 'chat/posted': (ctx: { data: unknown }) => seen.push(ctx.data) },
  })
  const bob = makeMLSPeer(hub, 'bob', recoverySecret, { members })
  await Promise.all([alice.peer.replay(), bob.peer.replay()])
  const build = buildRemoveCommit(bob, 'carol')
  await expect(
    bob.peer.commit(async () => {
      const pending = await build()
      return {
        ...pending,
        onAccepted: async () => {
          await pending.onAccepted()
          throw new Error('adoption notification failed')
        },
      }
    }),
  ).rejects.toThrow('adoption notification failed')
  const epochBefore = 1
  const anchorAfterThrow = bob.anchorStore.stored()
  expect(anchorAfterThrow?.epoch).toBe(epochBefore + 1)
  await bob.peer.commit(buildLedgerCommit(bob, []))
  await alice.peer.resync()
  expect(bob.peer.anchorEpoch()).toBe(2)
  expect(alice.peer.anchorEpoch()).toBe(2)
  await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'repaired' } })
  await expect.poll(() => seen).toEqual([{ text: 'repaired' }])
  const repairedTopic = topic(bob.peer.anchorEpoch())
  const aliceTopic = topic(alice.peer.anchorEpoch())
  expect(repairedTopic).toBe(aliceTopic)
  await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
})

test('membership returning to the original roster still rotates on each advance', async () => {
  const hub = new DurableFakeHub()
  const seen: Array<unknown> = []
  const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
    members,
    handlers: { 'chat/posted': (ctx: { data: unknown }) => seen.push(ctx.data) },
  })
  const bob = makeMLSPeer(hub, 'bob', recoverySecret, { members })
  await Promise.all([alice.peer.replay(), bob.peer.replay()])
  const build = buildInviteCommit(bob, 'dave')
  await expect(
    bob.peer.commit(async () => {
      const pending = await build()
      return {
        ...pending,
        onAccepted: async () => {
          await pending.onAccepted()
          throw new Error('adopted')
        },
      }
    }),
  ).rejects.toThrow('adopted')
  expect(bob.peer.anchorEpoch()).toBe(2)
  await expect.poll(() => alice.peer.anchorEpoch()).toBe(2)
  await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'added' } })
  await expect.poll(() => seen).toEqual([{ text: 'added' }])
  await bob.peer.commit(buildRemoveCommit(bob, 'dave'))
  expect(bob.peer.anchorEpoch()).toBe(3)
  await expect.poll(() => alice.peer.anchorEpoch()).toBe(3)
  await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'removed' } })
  await expect.poll(() => seen).toEqual([{ text: 'added' }, { text: 'removed' }])
  await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
})

test.each([false, true])(
  'startup resolves a durable rotation record, landed=%s',
  async (landed) => {
    const hub = new DurableFakeHub()
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { members })
    await bob.peer.replay()
    await bob.peer.dispose()
    const commit = bob.mls.buildCommit([], { removes: ['carol'] })
    const anchor = bob.anchorStore.stored()
    if (anchor == null) throw new Error('missing initial anchor')
    await bob.anchorStore.save({
      anchor,
      pending: {
        epochBefore: 1,
        epochAfter: 2,
        rosterBefore: members,
        forced: false,
        advance: digestAppliedCommit(commit),
      },
    })
    if (landed) bob.mls.adopt(commit)
    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob })
    await restarted.peer.replay()
    expect(restarted.peer.anchorEpoch()).toBe(landed ? 2 : 1)
    expect(await restarted.anchorStore.load()).toEqual({ anchor: restarted.anchorStore.stored() })
    await restarted.peer.dispose()
  },
)

test('missing-ledger poison clears its record before a different commit advances', async () => {
  const hub = new DurableFakeHub()
  const bob = makeMLSPeer(hub, 'bob', recoverySecret, { members })
  await bob.peer.replay()
  await publishCommit({
    hub,
    senderDID: 'alice',
    recoverySecret,
    epoch: 1,
    commit: encodeMemoryCommit(1, 'alice', [memoryEntryID('missing body')]),
  })
  await bob.peer.resync()
  expect(bob.mls.epoch()).toBe(1)
  expect((await bob.anchorStore.load())?.pending).toBeUndefined()
  await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1 })
  await bob.peer.resync()
  expect(bob.mls.epoch()).toBe(2)
  expect((await bob.anchorStore.load())?.pending).toBeUndefined()
  await bob.peer.dispose()
})

test('confirmed recovery records the speculative target and retry never captures it twice', async () => {
  const hub = new DurableFakeHub()
  const recovery = { timeoutMs: 100, deadlineMs: 10_000, getDelayMs: () => 0 }
  const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 4, members, recovery })
  const bob = makeMLSPeer(hub, 'bob', recoverySecret, { members, recovery })
  await Promise.all([alice.peer.replay(), bob.peer.replay()])
  const apply = bob.mls.applyRecovery
  let pendingRecovery: PendingRecovery | undefined
  let captured = 0
  const exportSecret = bob.crypto.exportSecret
  bob.crypto.exportSecret = async (label) => {
    if (label === APP_TOPIC_LABEL) captured++
    return exportSecret(label)
  }
  const save = bob.anchorStore.save
  let savedPending: AnchorSlot['pending']
  bob.anchorStore.save = async (slot) => {
    if (slot.pending != null) savedPending = slot.pending
    await save(slot)
  }
  let throwOnce = true
  bob.mls.applyRecovery = async (...args) => {
    const candidate = await apply(...args)
    if (candidate == null || 'renewalRequired' in candidate) return candidate
    pendingRecovery = candidate
    return {
      ...candidate,
      onAccepted: async () => {
        await candidate.onAccepted()
        if (throwOnce) {
          throwOnce = false
          throw new Error('rejoin notification failed')
        }
      },
    }
  }
  await expect(bob.peer.recover()).rejects.toThrow('rejoin notification failed')
  if (savedPending == null || pendingRecovery == null) throw new Error('Missing recovery record')
  expect(savedPending.epochAfter).toBe(pendingRecovery.epoch)
  expect(pendingRecovery.epoch).toBe(5)
  expect(captured).toBe(1)
  await bob.peer.replay()
  expect(captured).toBe(1)
  expect(bob.peer.anchorEpoch()).toBe(alice.peer.anchorEpoch())
  await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
})

test('a refused external advance clears forced before an ordinary commit, including across restart', async () => {
  const hub = new DurableFakeHub()
  const seen: Array<unknown> = []
  const options = {
    members: [...members, 'dave'],
    acceptsCommitter: (did: string) => did !== 'carol',
  }
  const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
    ...options,
    handlers: { 'chat/posted': (ctx: { data: unknown }) => seen.push(ctx.data) },
  })
  const bob = makeMLSPeer(hub, 'bob', recoverySecret, options)
  const dave = makeMLSPeer(hub, 'dave', recoverySecret, options)
  await Promise.all([alice.peer.replay(), bob.peer.replay(), dave.peer.replay()])
  await publishCommit({ hub, senderDID: 'carol', recoverySecret, epoch: 1, external: true })
  await expect.poll(() => bob.mls.seen()).toBe(1)
  await expect.poll(() => dave.mls.seen()).toBe(1)
  expect((await bob.anchorStore.load())?.pending).toBeUndefined()
  await dave.peer.dispose()
  const restarted = makeMLSPeer(hub, 'dave', recoverySecret, { restartOf: dave })
  await alice.peer.commit(buildLedgerCommit(alice, []))
  await expect.poll(() => bob.mls.epoch()).toBe(2)
  await expect.poll(() => restarted.mls.epoch()).toBe(2)
  expect(alice.peer.anchorEpoch()).toBe(1)
  expect(bob.peer.anchorEpoch()).toBe(1)
  expect(restarted.peer.anchorEpoch()).toBe(1)
  await restarted.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'same segment' } })
  await expect.poll(() => seen).toContainEqual({ text: 'same segment' })
  await Promise.all([alice.peer.dispose(), bob.peer.dispose(), restarted.peer.dispose()])
})

test('an ambiguous record admits only its own digest retry and retains its pre-advance roster', async () => {
  const hub = new DurableFakeHub()
  const bob = makeMLSPeer(hub, 'bob', recoverySecret, { members })
  await bob.peer.replay()
  hub.detach('bob')
  const process = bob.mls.processCommit
  let refuse = true
  let processes = 0
  bob.mls.processCommit = async (...args) => {
    processes++
    if (refuse) throw new Error('resolver unavailable')
    return process(...args)
  }
  await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1, removes: ['carol'] })
  await expect(bob.peer.commit(buildLedgerCommit(bob, []))).rejects.toThrow('resolver unavailable')
  const pending = (await bob.anchorStore.load())?.pending
  expect(pending).toMatchObject({
    epochBefore: 1,
    epochAfter: 2,
    forced: false,
    rosterBefore: members,
  })
  const message = hub.published.at(-1)
  if (message == null) throw new Error('Missing commit')
  const original = message.payload
  await publishCommit({
    hub: {
      publish: async (value) => {
        message.payload = value.payload
        return { sequenceID: message.sequenceID }
      },
    },
    senderDID: 'alice',
    recoverySecret,
    epoch: 1,
    external: true,
  })
  await expect(bob.peer.commit(buildLedgerCommit(bob, []))).rejects.toThrow(
    'earlier anchor rotation is unresolved',
  )
  expect(processes).toBe(1)
  expect((await bob.anchorStore.load())?.pending).toEqual(pending)
  message.payload = original
  refuse = false
  await bob.peer.commit(buildLedgerCommit(bob, []))
  expect(processes).toBe(2)
  expect(bob.mls.epoch()).toBe(3)
  expect(bob.peer.anchorEpoch()).toBe(2)
  expect((await bob.anchorStore.load())?.pending).toBeUndefined()
  await bob.peer.dispose()
})

test.each([false, true])(
  'a failed resolved-slot save is repaired before a later advance, restart=%s',
  async (restart) => {
    const hub = new DurableFakeHub()
    const written = createMemoryAnchorStore()
    let refuse = false
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
      members,
      anchorStore: {
        ...written,
        save: async (slot) => {
          if (refuse && slot.pending == null) throw new Error('resolved slot unavailable')
          await written.save(slot)
        },
      },
    })
    await bob.peer.replay()
    refuse = true
    await expect(bob.peer.commit(buildRemoveCommit(bob, 'carol'))).rejects.toThrow(
      'resolved slot unavailable',
    )
    expect(written.stored()?.epoch).toBe(1)
    expect((await written.load())?.pending?.epochAfter).toBe(2)
    expect(bob.peer.anchorEpoch()).toBe(2)
    if (restart) await bob.peer.dispose()
    refuse = false
    const current = restart ? makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob }) : bob
    await current.peer.commit(buildLedgerCommit(current, []))
    expect(current.mls.epoch()).toBe(3)
    expect(written.stored()?.epoch).toBe(2)
    expect((await written.load())?.pending).toBeUndefined()
    await current.peer.dispose()
  },
)

test('a persisted replacement not adopted keeps the record until restart resolves the durable handle', async () => {
  const hub = new DurableFakeHub()
  const bob = makeMLSPeer(hub, 'bob', recoverySecret, { members })
  await bob.peer.replay()
  const pending = await buildRemoveCommit(bob, 'carol')()
  await expect(
    bob.peer.commit(async () => ({
      ...pending,
      onAccepted: async () => {
        throw new Error('durable replacement not adopted')
      },
    })),
  ).rejects.toThrow('durable replacement not adopted')
  expect(bob.mls.epoch()).toBe(1)
  expect((await bob.anchorStore.load())?.pending).toMatchObject({ epochBefore: 1, epochAfter: 2 })
  await bob.peer.dispose()
  bob.mls.adopt(pending.commit)
  const restarted = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob })
  await restarted.peer.replay()
  expect(restarted.peer.anchorEpoch()).toBe(2)
  expect((await restarted.anchorStore.load())?.pending).toBeUndefined()
  await restarted.peer.dispose()
})

test('a secret lost in process holds sealing until an automatic confirmed rejoin', async () => {
  const hub = new DurableFakeHub()
  const seen: Array<unknown> = []
  const events: Array<{ phase: string; trigger: string }> = []
  const recovery = { timeoutMs: 100, deadlineMs: 10_000, getDelayMs: () => 0 }
  const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
    members,
    recovery,
    handlers: { 'chat/posted': (ctx: { data: unknown }) => seen.push(ctx.data) },
  })
  const adoptsAt: Array<number> = []
  const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
    members,
    recovery,
    onRecovery: (event) => {
      events.push(event)
    },
    adoptJournalled: (blob) => {
      adoptsAt.push(bob.mls.epoch())
      adoptJournalledBlob(bob.mls, blob)
    },
  })
  await Promise.all([alice.peer.replay(), bob.peer.replay()])
  const exportSecret = bob.crypto.exportSecret
  const exported: Array<number> = []
  bob.crypto.exportSecret = async (label) => {
    if (label === APP_TOPIC_LABEL) {
      exported.push(bob.mls.epoch())
      if (bob.mls.epoch() === 2) throw new Error('capture interrupted')
    }
    return exportSecret(label)
  }
  await expect(bob.peer.commit(buildRemoveCommit(bob, 'carol'))).rejects.toThrow(
    'capture interrupted',
  )
  await expect.poll(() => alice.mls.epoch()).toBe(2)
  hub.detach('bob')
  await alice.peer.commit(buildLedgerCommit(alice, []))
  bob.mls.adopt(bob.mls.buildCommit([]))
  await bob.peer
    .protocol('chat')
    .dispatch('chat/posted', { data: { text: 'after coordinated repair' } })
  await expect(bob.peer.commit(buildLedgerCommit(bob, []))).rejects.toBeInstanceOf(
    RecoveryRequiredError,
  )
  expect(adoptsAt).not.toContain(3)
  hub.reattach('bob')
  await expect.poll(() => events.some((event) => event.phase === 'succeeded')).toBe(true)
  expect(events.find((event) => event.phase === 'started')?.trigger).toBe('automatic')
  expect(exported).not.toContain(3)
  expect(bob.peer.anchorEpoch()).toBe(4)
  expect(alice.peer.anchorEpoch()).toBe(4)
  await expect.poll(() => seen).toContainEqual({ text: 'after coordinated repair' })
  await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
})
