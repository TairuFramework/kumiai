import { randomIdentity } from '@kokuin/token'
import { commitInvite, decodeClientState, restoreGroup, signLedgerEntry } from '@kumiai/mls'
import { createLedgerEntrySlot } from '@kumiai/mls-rpc'
import {
  APP_TOPIC_LABEL,
  commitTopic,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  HANDSHAKE_KIND,
  protocolTopic,
  type RecoveryEvent,
} from '@kumiai/rpc'
import { testAnchorStoreConformance } from '@kumiai/rpc-conformance'
import { afterEach, expect, test, vi } from 'vitest'

import {
  buildLedgerCommit,
  buildRemoveCommit,
  createEntryBodies,
  createFoundingGroup,
  createMemoryAnchorStore,
  customOperation,
  joinFromWelcome,
  type Member,
  makeMember,
  mintInvite,
  operationIntent,
  operationRequest,
  restoreMemberHandle,
} from './app-lane-e2e.js'
import { drainUntil } from './fixtures/drain.js'
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
    alice.hostHooks.afterAdopt = async () => {
      throw new Error('notification failed')
    }
    await expect(alice.peer.commit(build)).resolves.toMatchObject({})
    alice.hostHooks.afterAdopt = undefined
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

test('fresh startup with a lost anchor secret retains unexplained acceptance while ordinary recovery runs', async () => {
  const state = await setup({ deadlineMs: 10_000, adminBob: true })
  const { alice, bob, carolID, received, events } = state
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
  await bob.peer.dispose()
  await bob.peer.drained()
  const deferred = operationRequest('ledger', { tokens: [deferredBody] })
  const intent = operationIntent(deferred)
  await bob.control.apply({ putOperations: [intent] }, crypto.randomUUID())
  const prepared = await bob.prepareBuild(intent, async (built, seal) => {
    const sealed = await seal(encodeLedgerEntries(built.bodies))
    return {
      payload: encodeHandshakeFrame(
        HANDSHAKE_KIND.commit,
        encodeCommitFrame(built.commit, sealed.sealed),
      ),
      publishID: crypto.randomUUID(),
      expectedHead: (await bob.control.load()).cursor?.position ?? null,
    }
  })
  expect(prepared.kind).toBe('saved')
  const retained = (await bob.control.load()).commitOnce
  if (retained === null) throw new Error('Missing guarded slot')
  let removedCommit: Uint8Array = new Uint8Array()
  const build = buildRemoveCommit(alice, carolID.id)
  await alice.peer.commit(
    customOperation(alice, async (_op, supplied) => {
      const pending = await alice.build(operationIntent(build), supplied)
      removedCommit = pending.commit
      return pending
    }),
  )
  await bob.handle().processMessage(removedCommit)
  await bob.adopt(bob.handle())
  // Both advances happened outside peer settlement; the saved source has no applied evidence.
  const next = await alice.build(
    operationIntent(buildLedgerCommit(alice, alice.identity, bob.identity.id, 'member')),
  )
  const decoded = JSON.parse(new TextDecoder().decode(next.journal)) as {
    state: Array<number>
    ledger: Array<string>
  }
  const nextState = decodeClientState(new Uint8Array(decoded.state))
  if (nextState == null) throw new Error('Invalid candidate')
  await alice.adopt(
    await restoreGroup({
      state: nextState,
      credential: alice.handle().credential,
      ledgerEntries: decoded.ledger,
    }),
  )
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
      landed: true,
    },
  })
  await bob.appOutbox.put({
    seq: 0,
    protocol: 'chat',
    prc: 'chat/posted',
    data: encodeEventFrame('chat/posted', { text: 'held' }),
    lastAttempt: null,
  })
  const restarted = await state.restart()
  await restarted.peer.replay()
  await expect
    .poll(async () => (await restarted.control.load()).controlHold)
    .toMatchObject({ reason: 'acceptance-unknown', position: null })
  const held = await restarted.control.load()
  expect(held.commitOnce).toEqual(retained)
  expect(held.operations[0]?.id).toBe(deferred.id)
  expect(held.outcomes).toEqual([])
  expect(events).toContainEqual(expect.objectContaining({ phase: 'started', trigger: 'automatic' }))
  expect(Number(restarted.handle().epoch)).toBe(epochBefore + 2)
  expect(restarted.peer.anchorEpoch()).toBe(original.epoch)
  expect(await restarted.mls.getLedger()).not.toContain(deferredBody)
  expect(received).toEqual([])
  const again = await state.restart(restarted)
  await again.peer.replay()
  expect((await again.control.load()).controlHold).toEqual(held.controlHold)
  expect((await again.control.load()).commitOnce).toEqual(retained)
  expect(events).toContainEqual(expect.objectContaining({ phase: 'started', trigger: 'automatic' }))
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
  await expect(alice.peer.commit(buildRemoveCommit(alice, carolID.id))).resolves.toMatchObject({})
  expect((await alice.control.load()).outcomes).toContainEqual(
    expect.objectContaining({ kind: 'landed' }),
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
  await expect(alice.peer.commit(buildRemoveCommit(alice, carolID.id))).resolves.toMatchObject({})
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

test.each([false, true])(
  'losing the rotation secret holds sealing until confirmed recovery, unwalked source commit=%s',
  async (unwalked) => {
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
    const { hub, alice, bob, carolID, received, events } = await setup({ deadlineMs: 10_000 })
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
      'pending anchor rotation',
    )
    expect(await bob.anchorStore.load()).toMatchObject({ pending: { epochAfter: epochBefore + 1 } })
    await drainUntil(
      () => Number(bob.handle().epoch) === epochBefore + 1,
      'Bob handle epoch advance',
    )
    expect(Number(bob.handle().epoch)).toBe(epochBefore + 1)
    // The host moves the handle outside the peer, making the recorded epoch's secret unavailable.
    const next = await alice.build(
      operationIntent(buildLedgerCommit(alice, alice.identity, bob.identity.id, 'member')),
    )
    const decoded = JSON.parse(new TextDecoder().decode(next.journal)) as {
      state: Array<number>
      ledger: Array<string>
    }
    const nextState = decodeClientState(new Uint8Array(decoded.state))
    if (nextState == null) throw new Error('Invalid candidate')
    await alice.adopt(
      await restoreGroup({
        state: nextState,
        credential: alice.handle().credential,
        ledgerEntries: decoded.ledger,
      }),
    )
    await alice.control.apply(
      {
        cursor: {
          position: (await alice.control.load()).cursor?.position ?? null,
          epoch: Number(nextState.groupContext.epoch),
        },
      },
      crypto.randomUUID(),
    )
    bob.entrySlot.install(async () => next.bodies)
    await bob.handle().processMessage(next.commit)
    await bob.adopt(bob.handle())
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'in process repair' } })
    if (unwalked) {
      let confirmed = false
      const apply = bob.control.apply.bind(bob.control)
      vi.spyOn(bob.control, 'apply').mockImplementation(async (changes, id) => {
        if (changes.putRejoin?.stage === 'confirmed') {
          confirmed = true
          const record = changes.putRejoin
          expect('format' in record ? record.source.identity?.epoch : record.source.epoch).toBe(
            Number(bob.handle().epoch),
          )
          if ('format' in record) expect(record.target.groupInfoEpoch + 1).toBe(record.epochAfter)
        }
        await apply(changes, id)
      })
      await alice.peer.commit(buildLedgerCommit(alice, alice.identity, bob.identity.id, 'member'))
      const blockingPosition = (await alice.control.load()).applied.find(
        (row) => row.epoch === epochBefore + 2,
      )?.sequenceID
      expect(blockingPosition).toBeDefined()
      await drainUntil(
        () => events.some((event) => event.phase === 'failed'),
        'source re-check invalidation',
      )
      expect(events).toContainEqual(
        expect.objectContaining({
          phase: 'failed',
          reason: 'invalidated',
          anchorRecovery: true,
          blockingPosition,
        }),
      )
      expect(confirmed).toBe(true)
      expect(events.some((event) => event.phase === 'succeeded')).toBe(false)
      expect(Number(bob.handle().epoch)).toBe(epochBefore + 2)
      expect(bob.peer.anchorEpoch()).toBe(epochBefore)
      expect(exported).not.toContain(epochBefore + 2)
      expect((await bob.control.load()).rejoin).toBeNull()
      expect(await bob.appOutbox.list()).toHaveLength(1)
      expect(received).toEqual([])
      return
    }
    const wake = hub.connect(randomIdentity())
    await wake.publish({
      senderDID: alice.identity.id,
      topicID: commitTopic(await bob.mls.exportRecoverySecret()),
      payload: new Uint8Array([0]),
      retain: 'log',
    })
    await drainUntil(
      () => events.some((event) => event.phase === 'succeeded'),
      'recovery success event',
    )
    expect(events.some((event) => event.phase === 'succeeded')).toBe(true)
    expect(events.find((event) => event.phase === 'started')?.trigger).toBe('automatic')
    expect(exported).not.toContain(epochBefore + 2)
    expect(topic(bob)).toBe(topic(alice))
    expect(bob.peer.anchorEpoch()).toBe(epochBefore + 3)
    await drainUntil(
      () => received.some((message) => (message as { text: string }).text === 'in process repair'),
      'in-process repair delivery',
    )
    expect(received).toContainEqual({ text: 'in process repair' })
  },
)
