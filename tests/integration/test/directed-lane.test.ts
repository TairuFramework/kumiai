import { commitInvite } from '@kumiai/mls'
import { createLedgerEntrySlot } from '@kumiai/mls-rpc'
import { describe, expect, test } from 'vitest'

import {
  createEntryBodies,
  createFoundingGroup,
  joinFromWelcome,
  makeMember,
  mintInvite,
  newIdentity,
} from './app-lane-e2e.js'
import { createWireHub } from './log-hub-over-wire.js'

const flush = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * DIRECTED 1:1 RPC, end to end, with nothing substituted: the real `hub-server` over the real
 * Enkaku wire, real `@kumiai/mls` handles, and the real `GroupCrypto`/`GroupMLS`.
 *
 * This lane had never run against a real handle. Every test of it used a fake `unwrap` that was
 * a pure function — the same bytes opened as often as anyone asked — and under that fake it was
 * correct. On a real handle, opening SPENDS the frame's per-message ratchet key: the caller's
 * inbox had an acceptor and a directed client each holding an `unwrap`, they raced for the one
 * key, and a directed request was never answered. Two hundred and ninety-nine tests were green.
 *
 * So the lane is proved here, where the key really is spent, and not only in the unit suite.
 */
describe('directed RPC over real MLS, end to end', () => {
  test('a directed request reaches the member it names and its reply comes back', async () => {
    const hub = createWireHub()
    const bodies = createEntryBodies()

    const aliceID = newIdentity()
    const bobID = newIdentity()
    const aliceSlot = createLedgerEntrySlot()
    const bobSlot = createLedgerEntrySlot()
    for (const slot of [aliceSlot, bobSlot]) {
      slot.install(async (ids) =>
        ids.map((id) => {
          const token = bodies.get(id)
          if (token == null) throw new Error(`unknown ledger entry ${id}`)
          return token
        }),
      )
    }

    let aliceHandle = await createFoundingGroup(aliceID, 'directed-e2e', aliceSlot)
    const material = await mintInvite({
      admin: aliceHandle,
      adminIdentity: aliceID,
      invitee: bobID,
      bodies,
    })
    const addBob = await commitInvite(aliceHandle, material.bundle.publicPackage, material.invite)
    aliceHandle = addBob.newGroup
    const bobHandle = await joinFromWelcome({
      identity: bobID,
      invite: material.invite,
      welcome: addBob.welcomeMessage,
      bundle: material.bundle,
      ratchetTree: aliceHandle.state.ratchetTree,
      entrySlot: bobSlot,
    })

    const calls: Array<number> = []
    const alice = makeMember({ hub, identity: aliceID, group: aliceHandle, entrySlot: aliceSlot })
    const bob = makeMember({
      hub,
      identity: bobID,
      group: bobHandle,
      entrySlot: bobSlot,
      handlers: {
        'chat/double': (ctx: { param: { n: number } }) => {
          calls.push(ctx.param.n)
          return { n: ctx.param.n * 2 }
        },
      },
    })
    await flush()

    const reply = await alice.peer
      .protocol('chat')
      .to(bobID.id)
      .request('chat/double', { param: { n: 21 } })
    expect(reply).toEqual({ n: 42 })
    expect(calls).toEqual([21])

    await alice.peer.dispose()
    await bob.peer.dispose()
    await alice.disconnect()
    await bob.disconnect()
    await hub.dispose()
  })

  test('a second request on the same session is answered too', async () => {
    const hub = createWireHub()
    const bodies = createEntryBodies()

    const aliceID = newIdentity()
    const bobID = newIdentity()
    const aliceSlot = createLedgerEntrySlot()
    const bobSlot = createLedgerEntrySlot()
    for (const slot of [aliceSlot, bobSlot]) {
      slot.install(async (ids) =>
        ids.map((id) => {
          const token = bodies.get(id)
          if (token == null) throw new Error(`unknown ledger entry ${id}`)
          return token
        }),
      )
    }

    let aliceHandle = await createFoundingGroup(aliceID, 'directed-e2e-2', aliceSlot)
    const material = await mintInvite({
      admin: aliceHandle,
      adminIdentity: aliceID,
      invitee: bobID,
      bodies,
    })
    const addBob = await commitInvite(aliceHandle, material.bundle.publicPackage, material.invite)
    aliceHandle = addBob.newGroup
    const bobHandle = await joinFromWelcome({
      identity: bobID,
      invite: material.invite,
      welcome: addBob.welcomeMessage,
      bundle: material.bundle,
      ratchetTree: aliceHandle.state.ratchetTree,
      entrySlot: bobSlot,
    })

    const alice = makeMember({ hub, identity: aliceID, group: aliceHandle, entrySlot: aliceSlot })
    const bob = makeMember({
      hub,
      identity: bobID,
      group: bobHandle,
      entrySlot: bobSlot,
      handlers: {
        'chat/double': (ctx: { param: { n: number } }) => ({ n: ctx.param.n * 2 }),
      },
    })
    await flush()

    // The SECOND request is the one that matters. The directed client is cached per member, so
    // both run over one session and one inbox — every frame after the first is opened against a
    // ratchet the earlier frames have already advanced.
    const to = alice.peer.protocol('chat').to(bobID.id)
    const first = await to.request('chat/double', { param: { n: 1 } })
    const second = await to.request('chat/double', { param: { n: 2 } })
    expect([first, second]).toEqual([{ n: 2 }, { n: 4 }])

    await alice.peer.dispose()
    await bob.peer.dispose()
    await alice.disconnect()
    await bob.disconnect()
    await hub.dispose()
  })
})

/**
 * RECONNECTING BEFORE THE OLD CONNECTION IS TORN DOWN.
 *
 * This is what a phone does: the socket dies, the client dials again, and the server is the last
 * to know the old one is gone — it still holds a receive writer pointing at it. The rule used to
 * be that the second `hub/v1/receive` for a DID was refused, so the reconnect made precisely because
 * the connection broke was the one turned away, and the refusal arrived on a channel promise
 * nothing awaited: no push lane, and no error either.
 *
 * Modelled the strict way — the old connection is NEVER dropped — because that is the shape the
 * old rule failed on. Over the real wire and the real hub server.
 */
describe('a member that reconnects while its old connection is still up', () => {
  test('takes over the push lane and receives what is published after it', async () => {
    const hub = createWireHub()
    const bodies = createEntryBodies()

    const aliceID = newIdentity()
    const bobID = newIdentity()
    const aliceSlot = createLedgerEntrySlot()
    const bobSlot = createLedgerEntrySlot()
    for (const slot of [aliceSlot, bobSlot]) {
      slot.install(async (ids) =>
        ids.map((id) => {
          const token = bodies.get(id)
          if (token == null) throw new Error(`unknown ledger entry ${id}`)
          return token
        }),
      )
    }

    let aliceHandle = await createFoundingGroup(aliceID, 'reconnect-e2e', aliceSlot)
    const material = await mintInvite({
      admin: aliceHandle,
      adminIdentity: aliceID,
      invitee: bobID,
      bodies,
    })
    const addBob = await commitInvite(aliceHandle, material.bundle.publicPackage, material.invite)
    aliceHandle = addBob.newGroup
    const bobHandle = await joinFromWelcome({
      identity: bobID,
      invite: material.invite,
      welcome: addBob.welcomeMessage,
      bundle: material.bundle,
      ratchetTree: aliceHandle.state.ratchetTree,
      entrySlot: bobSlot,
    })

    const alice = makeMember({ hub, identity: aliceID, group: aliceHandle, entrySlot: aliceSlot })
    const first: Array<unknown> = []
    const bob = makeMember({
      hub,
      identity: bobID,
      group: bobHandle,
      entrySlot: bobSlot,
      handlers: { 'chat/posted': (ctx: { data: unknown }) => void first.push(ctx.data) },
    })
    await flush()

    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'before' })
    await flush()
    expect(first).toEqual([{ text: 'before' }])

    // The process dies. Its peer stops, its SOCKET DOES NOT — nothing calls `disconnect` — so the
    // hub still believes the old receive writer is good.
    await bob.peer.dispose()

    const second: Array<unknown> = []
    const reconnected = makeMember({
      hub,
      identity: bobID,
      group: bobHandle,
      entrySlot: bobSlot,
      restartOf: bob,
      handlers: { 'chat/posted': (ctx: { data: unknown }) => void second.push(ctx.data) },
    })
    await flush()

    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'after' })
    await flush()

    // The new connection has the lane, and the stale one is not holding anything back.
    expect(second).toEqual([{ text: 'after' }])
    expect(first).toEqual([{ text: 'before' }])

    await alice.peer.dispose()
    await reconnected.peer.dispose()
    await alice.disconnect()
    await bob.disconnect()
    await reconnected.disconnect()
    await hub.dispose()
  })
})
