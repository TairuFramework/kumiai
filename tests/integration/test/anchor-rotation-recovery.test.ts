import { setImmediate } from 'node:timers/promises'
import { randomIdentity } from '@kokuin/token'
import { commitInvite, commitLedgerEntries, signLedgerEntry } from '@kumiai/mls'
import { createLedgerEntrySlot } from '@kumiai/mls-rpc'
import {
  APP_TOPIC_LABEL,
  decodeHandshakeFrame,
  digestAppliedCommit,
  HANDSHAKE_KIND,
  protocolTopic,
  type RecoveryEvent,
  RecoveryRequiredError,
} from '@kumiai/rpc'
import { testAnchorStoreConformance } from '@kumiai/rpc-conformance'
import { afterEach, expect, test, vi } from 'vitest'

import {
  buildLedgerCommit,
  buildRemoveCommit,
  createEntryBodies,
  createFoundingGroup,
  createMemoryAnchorStore,
  encodeJournal,
  joinFromWelcome,
  type Member,
  makeMember,
  mintInvite,
  restoreMemberHandle,
} from './app-lane-e2e.js'
import { createWireHub } from './log-hub-over-wire.js'

const { encodeEventFrame } = (await import(
  new URL('../../../packages/broadcast/src/event-frame.ts', import.meta.url).href
)) as { encodeEventFrame(prc: string, data: Record<string, unknown>): Uint8Array }

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup({
  deadlineMs,
  beforeAdopt,
  adminBob = false,
}: {
  deadlineMs: number
  beforeAdopt?: Member['adopt']
  adminBob?: boolean
}) {
  const hub = createWireHub()
  cleanup.push(() => hub.dispose())
  const bodies = createEntryBodies()
  const aliceID = randomIdentity()
  const bobID = randomIdentity()
  const carolID = randomIdentity()
  const aliceSlot = createLedgerEntrySlot()
  const bobSlot = createLedgerEntrySlot()
  for (const slot of [aliceSlot, bobSlot])
    slot.install(async (ids) =>
      ids.map((id) => {
        const token = bodies.get(id)
        if (token == null) throw new Error('Missing entry')
        return token
      }),
    )
  let group = await createFoundingGroup(aliceID, 'anchor-repair', aliceSlot)
  const bobInvite = await mintInvite({
    admin: group,
    adminIdentity: aliceID,
    invitee: bobID,
    bodies,
  })
  const added = await commitInvite(group, bobInvite.bundle.publicPackage, bobInvite.invite)
  group = added.newGroup
  const bobGroup = await joinFromWelcome({
    identity: bobID,
    invite: bobInvite.invite,
    welcome: added.welcomeMessage,
    bundle: bobInvite.bundle,
    ratchetTree: group.state.ratchetTree,
    entrySlot: bobSlot,
  })
  const carolInvite = await mintInvite({
    admin: group,
    adminIdentity: aliceID,
    invitee: carolID,
    bodies,
  })
  const third = await commitInvite(group, carolInvite.bundle.publicPackage, carolInvite.invite)
  group = third.newGroup
  await bobGroup.processMessage(third.commitMessage)
  const received: Array<unknown> = []
  const bobReceived: Array<unknown> = []
  const events: Array<RecoveryEvent> = []
  const recovery = { deadlineMs, timeoutMs: 500, getDelayMs: () => 0 }
  const alice = makeMember({
    hub,
    identity: aliceID,
    group,
    entrySlot: aliceSlot,
    recovery,
    beforeAdopt,
    handlers: { 'chat/posted': (ctx: { data: unknown }) => received.push(ctx.data) },
  })
  const bob = makeMember({
    hub,
    identity: bobID,
    group: bobGroup,
    entrySlot: bobSlot,
    recovery,
    handlers: { 'chat/posted': (ctx: { data: unknown }) => bobReceived.push(ctx.data) },
    onRecovery: (event) => {
      events.push(event)
    },
  })
  const tracked = [alice, bob]
  cleanup.push(async () => {
    await Promise.all(tracked.map((member) => member.peer.dispose()))
    await Promise.all(tracked.map((member) => member.peer.drained()))
  })
  await Promise.all([alice.peer.resync(), bob.peer.resync()])
  if (adminBob) {
    await alice.peer.commit(buildLedgerCommit(alice, alice.identity, bob.identity.id, 'admin'))
    await expect.poll(() => Number(bob.handle().epoch)).toBe(Number(alice.handle().epoch))
  }
  const restart = async (member = bob) => {
    await member.peer.dispose()
    await member.peer.drained()
    await member.disconnect()
    const group = await restoreMemberHandle(member, member.entrySlot)
    const next = makeMember({
      hub,
      identity: member.identity,
      group,
      entrySlot: member.entrySlot,
      restartOf: member,
      recovery,
      onRecovery: (event) => {
        events.push(event)
      },
      handlers: {
        'chat/posted': (ctx: { data: unknown }) => {
          ;(member === alice ? received : bobReceived).push(ctx.data)
        },
      },
    })
    tracked.push(next)
    return next
  }
  return { hub, alice, bob, carolID, received, bobReceived, events, restart }
}

function topic(member: Member): string {
  const anchor = member.anchorStore.stored()
  if (anchor == null) throw new Error('Missing anchor')
  return protocolTopic(anchor.secret, anchor.epoch, 'chat')
}

test.each([false, true])(
  'throwing adoption repairs the exact epoch, restart=%s',
  async (restart) => {
    const state = await setup({ deadlineMs: 10_000 })
    const { alice, bob, carolID, bobReceived } = state
    const epochBefore = Number(alice.handle().epoch)
    const build = buildRemoveCommit(alice, carolID.id)
    await expect(
      alice.peer.commit(async () => {
        const pending = await build()
        return {
          ...pending,
          onAccepted: async () => {
            await pending.onAccepted()
            throw new Error('notification failed')
          },
        }
      }),
    ).rejects.toThrow('notification failed')
    const anchorAfterThrow = alice.anchorStore.stored()
    expect(anchorAfterThrow?.epoch).toBe(epochBefore + 1)
    const sender = restart ? await state.restart(alice) : alice
    await sender.peer.commit(buildLedgerCommit(sender, alice.identity, bob.identity.id, 'member'))
    await expect.poll(() => Number(bob.handle().epoch)).toBe(epochBefore + 2)
    expect(sender.peer.anchorEpoch()).toBe(epochBefore + 1)
    const repairedTopic = topic(sender)
    const aliceTopic = topic(bob)
    expect(repairedTopic).toBe(aliceTopic)
    await sender.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'after repair' } })
    await expect.poll(() => bobReceived).toContainEqual({ text: 'after repair' })
  },
)

test('fresh startup with a lost anchor secret resolves readiness before confirmed recovery', async () => {
  const state = await setup({ deadlineMs: 10_000, adminBob: true })
  const { alice, bob, carolID, received, events, hub } = state
  const original = bob.anchorStore.stored()
  if (original == null) throw new Error('Missing anchor')
  const rosterBefore = bob
    .handle()
    .listMembers()
    .map((entry) => entry.id)
  const epochBefore = Number(bob.handle().epoch)
  const deferredBody = await signLedgerEntry(bob.identity, {
    type: 'app.note',
    groupID: bob.handle().groupID,
    subject: bob.identity.id,
    value: 'deferred',
  })
  const abandoned = await commitLedgerEntries(bob.handle(), [deferredBody])
  let removedCommit: Uint8Array = new Uint8Array()
  const build = buildRemoveCommit(alice, carolID.id)
  await alice.peer.commit(async () => {
    const pending = await build()
    removedCommit = pending.commit
    return pending
  })
  await bob.peer.resync()
  await bob.peer.dispose()
  await bob.peer.drained()
  // A host advances outside the peer after the rotation record was persisted.
  const next = await buildLedgerCommit(alice, alice.identity, bob.identity.id, 'member')()
  await next.onAccepted()
  bob.entrySlot.install(async () => next.bodies)
  await bob.handle().processMessage(next.commit)
  await bob.adopt(bob.handle())
  await bob.anchorStore.save({
    anchor: original,
    pending: {
      epochBefore,
      epochAfter: epochBefore + 1,
      rosterBefore,
      forced: false,
      advance: digestAppliedCommit(removedCommit),
    },
  })
  await bob.journal.put({
    publishID: 'deferred-commit',
    expectedHead: null,
    epoch: epochBefore,
    kind: 'ledger',
    commit: abandoned.commitMessage,
    bodies: [deferredBody],
    journal: encodeJournal(abandoned.newGroup),
  })
  await bob.appOutbox.put({
    seq: 0,
    protocol: 'chat',
    prc: 'chat/posted',
    data: encodeEventFrame('chat/posted', { text: 'held' }),
    lastAttempt: null,
  })
  let release = () => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const connect = hub.connect.bind(hub)
  const published: Array<string> = []
  hub.connect = (identity) => {
    const connection = connect(identity)
    const publish = connection.publish.bind(connection)
    connection.publish = async (value) => {
      if (identity.id === bob.identity.id) {
        try {
          if (decodeHandshakeFrame(value.payload).kind === HANDSHAKE_KIND.recoveryRequest)
            await wait
        } catch {}
        if (value.retain === 'log') published.push(value.topicID)
      }
      return publish(value)
    }
    return connection
  }
  const restarted = await state.restart()
  let readyResolvedBeforeRecovery = false
  await restarted.peer.protocol('chat').to(alice.identity.id)
  readyResolvedBeforeRecovery = !events.some((event) => event.phase === 'succeeded')
  expect(readyResolvedBeforeRecovery).toBe(true)
  const buildForbidden = async () => {
    throw new Error('must not build')
  }
  await expect(restarted.peer.commit(buildForbidden)).rejects.toBeInstanceOf(RecoveryRequiredError)
  expect(restarted.peer.anchorEpoch()).toBe(original.epoch)
  expect(published).toEqual([])
  expect(Number(restarted.handle().epoch)).toBe(epochBefore + 2)
  expect((await restarted.journal.get())?.publishID).toBe('deferred-commit')
  release()
  await expect
    .poll(() => events.some((event) => event.phase === 'succeeded'), { timeout: 10_000 })
    .toBe(true)
  expect(events.find((event) => event.phase === 'started')?.trigger).toBe('automatic')
  expect(topic(restarted)).toBe(topic(alice))
  await expect.poll(() => received, { timeout: 10_000 }).toContainEqual({ text: 'held' })
  expect(restarted.peer.anchorEpoch()).toBe(Number(restarted.handle().epoch))
  expect((await restarted.anchorStore.load())?.pending).toBeUndefined()
  expect((await restarted.peer.replay()).reenact).toContain(deferredBody)
  expect(await restarted.journal.get()).toBeNull()
  expect(events.filter((event) => event.phase === 'succeeded')).toHaveLength(1)
})

testAnchorStoreConformance({
  label: 'integration host anchor store',
  createStore: createMemoryAnchorStore,
})

test('persisted but not adopted repairs from the durable handle before a queued send on restart', async () => {
  let refused = false
  const state = await setup({
    deadlineMs: 10_000,
    beforeAdopt: async () => {
      if (refused) throw new Error('adoption unavailable')
    },
  })
  const { alice, bob, carolID, bobReceived } = state
  const epochBefore = Number(alice.handle().epoch)
  refused = true
  await expect(alice.peer.commit(buildRemoveCommit(alice, carolID.id))).rejects.toThrow(
    'adoption unavailable',
  )
  expect(Number(alice.handle().epoch)).toBe(epochBefore)
  expect((await alice.anchorStore.load())?.pending).toMatchObject({
    epochBefore,
    epochAfter: epochBefore + 1,
  })
  await alice.peer.dispose()
  await alice.peer.drained()
  await alice.appOutbox.put({
    seq: 0,
    protocol: 'chat',
    prc: 'chat/posted',
    data: encodeEventFrame('chat/posted', { text: 'from durable replacement' }),
    lastAttempt: null,
  })
  const restarted = await state.restart(alice)
  await restarted.peer.protocol('chat').to(bob.identity.id)
  expect(Number(restarted.handle().epoch)).toBe(epochBefore + 1)
  expect(restarted.peer.anchorEpoch()).toBe(epochBefore + 1)
  await expect.poll(() => topic(bob)).toBe(topic(restarted))
  await expect.poll(() => bobReceived).toContainEqual({ text: 'from durable replacement' })
  expect((await restarted.anchorStore.load())?.pending).toBeUndefined()
})

test('a failed anchor save repairs before the restarted worker seals and reaches the receiver', async () => {
  const state = await setup({ deadlineMs: 10_000 })
  const { alice, bob, carolID, bobReceived } = state
  const epochBefore = Number(alice.handle().epoch)
  const save = alice.anchorStore.save
  let refused = true
  alice.anchorStore.save = async (slot) => {
    if (refused && slot.pending == null) throw new Error('anchor save unavailable')
    await save(slot)
  }
  await expect(alice.peer.commit(buildRemoveCommit(alice, carolID.id))).rejects.toThrow(
    'anchor save unavailable',
  )
  expect(Number(alice.handle().epoch)).toBe(epochBefore + 1)
  expect(alice.anchorStore.stored()?.epoch).toBe(epochBefore)
  expect((await alice.anchorStore.load())?.pending?.epochAfter).toBe(epochBefore + 1)
  await alice.peer.dispose()
  await alice.peer.drained()
  await alice.appOutbox.put({
    seq: 0,
    protocol: 'chat',
    prc: 'chat/posted',
    data: encodeEventFrame('chat/posted', { text: 'after failed save' }),
    lastAttempt: null,
  })
  refused = false
  const restarted = await state.restart(alice)
  await restarted.peer.protocol('chat').to(bob.identity.id)
  expect(restarted.peer.anchorEpoch()).toBe(epochBefore + 1)
  await expect.poll(() => topic(bob)).toBe(topic(restarted))
  await expect.poll(() => bobReceived).toContainEqual({ text: 'after failed save' })
  expect((await restarted.anchorStore.load())?.pending).toBeUndefined()
})

test('losing the rotation secret in process forces automatic confirmed recovery before sealing', async () => {
  const nativeTimeout = globalThis.setTimeout
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    shouldClearNativeTimers: true,
  })
  const timedTimeout = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    return delay === 0
      ? nativeTimeout(callback, delay, ...args)
      : timedTimeout(callback, delay, ...args)
  })
  async function drainUntil(done: () => boolean | Promise<boolean>) {
    while (!(await done())) {
      await vi.advanceTimersByTimeAsync(0)
      await setImmediate()
    }
  }

  const { alice, bob, carolID, received, events } = await setup({ deadlineMs: 10_000 })
  const epochBefore = Number(bob.handle().epoch)
  const handle = bob.handle()
  const exportSecret = handle.exportSecret.bind(handle)
  const exported: Array<number> = []
  handle.exportSecret = async (label, context, length) => {
    if (label === APP_TOPIC_LABEL) {
      exported.push(Number(handle.epoch))
      if (Number(handle.epoch) === epochBefore + 1) throw new Error('anchor export interrupted')
    }
    return exportSecret(label, context, length)
  }
  await alice.peer.commit(buildRemoveCommit(alice, carolID.id))
  await drainUntil(
    async () => (await bob.anchorStore.load())?.pending?.epochAfter === epochBefore + 1,
  )
  expect(await bob.anchorStore.load()).toMatchObject({ pending: { epochAfter: epochBefore + 1 } })
  await drainUntil(() => Number(bob.handle().epoch) === epochBefore + 1)
  expect(Number(bob.handle().epoch)).toBe(epochBefore + 1)
  // The host moves the handle outside the peer, making the recorded epoch's secret unavailable.
  const next = await buildLedgerCommit(alice, alice.identity, bob.identity.id, 'member')()
  await next.onAccepted()
  bob.entrySlot.install(async () => next.bodies)
  await bob.handle().processMessage(next.commit)
  await bob.adopt(bob.handle())
  await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'in process repair' } })
  await alice.peer.commit(buildLedgerCommit(alice, alice.identity, bob.identity.id, 'member'))
  await drainUntil(() => events.some((event) => event.phase === 'succeeded'))
  expect(events.some((event) => event.phase === 'succeeded')).toBe(true)
  expect(events.find((event) => event.phase === 'started')?.trigger).toBe('automatic')
  expect(exported).not.toContain(epochBefore + 2)
  expect(topic(bob)).toBe(topic(alice))
  expect(bob.peer.anchorEpoch()).toBe(epochBefore + 4)
  await drainUntil(() =>
    received.some((message) => (message as { text: string }).text === 'in process repair'),
  )
  expect(received).toContainEqual({ text: 'in process repair' })
})
