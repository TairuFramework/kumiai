import { describe, expect, test } from 'vitest'

import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 50))

/**
 * A retained app frame is sealed at the epoch it was sent at and lives on the topic that epoch's
 * segment is anchored to. A peer coming back walks the commit log forward through both — so the
 * walk is the thing in a position to destroy the messages it was sent, by ratcheting its handle
 * past the epochs that open them.
 *
 * It does not, because it reads each epoch's frames BEFORE the commit that leaves that epoch, and
 * moves to the next segment's topic when the anchor rotates under it. These assert the PLAINTEXT
 * that reached the host's handlers, and the order it arrived in: a peer that silently loses these
 * still converges, still matches the roster, still reaches the right epoch and still raises
 * nothing.
 */
describe('a returning peer reads the retained app frames of every epoch it walks past', () => {
  test('frames from several epochs inside one segment all arrive, each read at its own epoch', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x71)
    const seen: Array<unknown> = []

    // Alice is the group; bob is the member who will go away and come back. No roster change
    // happens anywhere in this test, so the anchor never moves: one segment, one topic, and the
    // epochs run on underneath it. That is what makes this about PER-EPOCH decryption — a drain
    // that pulled once per segment and opened everything at the anchor's epoch reads only the
    // first message and calls the rest unreadable.
    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1, members: ['alice', 'bob'] })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
      epoch: 1,
      members: ['alice', 'bob'],
      handlers: { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) },
    })
    await flush()
    expect(bob.peer.anchorEpoch()).toBe(1)

    // Bob's process dies. The hub keeps his subscriptions and keeps his frames.
    await bob.peer.dispose()
    hub.detach('bob')

    // Alice posts at epoch 1, commits (nothing touches a leaf, so the anchor stays put), posts at
    // epoch 2, commits, posts at epoch 3. Three frames, three different sealing epochs, one topic.
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'at one' })
    await alice.peer.commit(buildLedgerCommit(alice, []))
    await flush()
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'at two' })
    await alice.peer.commit(buildLedgerCommit(alice, []))
    await flush()
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'at three' })
    await flush()

    expect(alice.mls.epoch()).toBe(3)
    expect(alice.peer.anchorEpoch()).toBe(1) // still the one segment
    expect(seen).toEqual([]) // none of it reached him: a backlog, not a live delivery

    // Bob comes back up cold, over the durable state his dead process left: the same handle (still
    // at epoch 1), the same anchor store. He walks 1 -> 3, and must read each frame on the way.
    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, {
      restartOf: bob,
      handlers: { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) },
    })
    hub.reattach('bob')
    await flush()

    expect(restarted.mls.epoch()).toBe(3)
    expect(restarted.peer.anchorEpoch()).toBe(1)
    expect(seen).toEqual([{ text: 'at one' }, { text: 'at two' }, { text: 'at three' }])

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })

  test('frames from two segments either side of a roster change all arrive, in publish order', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x72)
    const seen: Array<unknown> = []

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
      epoch: 1,
      members: ['alice', 'bob', 'carol'],
    })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
      epoch: 1,
      members: ['alice', 'bob', 'carol'],
      handlers: { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) },
    })
    await flush()
    expect(bob.peer.anchorEpoch()).toBe(1)

    await bob.peer.dispose()
    hub.detach('bob')

    // SEGMENT ONE, anchored at epoch 1. Alice posts at epoch 1, then a no-op commit runs the epoch
    // to 2 without moving the anchor, and she posts again at epoch 2 — still the same topic.
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'first segment, epoch 1' })
    await alice.peer.commit(buildLedgerCommit(alice, []))
    await flush()
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'first segment, epoch 2' })
    await flush()
    expect(alice.mls.epoch()).toBe(2)
    expect(alice.peer.anchorEpoch()).toBe(1)

    // THE ROSTER CHANGE: an off-stage admin evicts carol at epoch 2. Every member applying it
    // rotates the anchor to epoch 3, and the group's messages move to a new topic with it.
    await publishCommit({
      hub,
      senderDID: 'admin',
      recoverySecret,
      epoch: 2,
      removes: ['carol'],
    })
    await flush()
    expect(alice.mls.epoch()).toBe(3)
    expect(alice.peer.anchorEpoch()).toBe(3)

    // SEGMENT TWO, anchored at epoch 3, on a topic the first segment's frames are not on.
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'second segment, epoch 3' })
    await alice.peer.commit(buildLedgerCommit(alice, []))
    await flush()
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'second segment, epoch 4' })
    await flush()
    expect(alice.mls.epoch()).toBe(4)
    expect(alice.peer.anchorEpoch()).toBe(3)
    expect(seen).toEqual([])

    // Bob comes back cold at epoch 1, anchored at 1. He must walk both segments: read segment
    // one's epochs off segment one's topic, rotate his anchor onto segment two's topic when he
    // applies the remove, and read the rest there.
    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, {
      restartOf: bob,
      handlers: { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) },
    })
    hub.reattach('bob')
    await flush()

    expect(restarted.mls.epoch()).toBe(4)
    expect(restarted.peer.anchorEpoch()).toBe(3) // he rotated onto the second segment
    expect(restarted.mls.leaves()).not.toContain('carol')
    expect(seen).toEqual([
      { text: 'first segment, epoch 1' },
      { text: 'first segment, epoch 2' },
      { text: 'second segment, epoch 3' },
      { text: 'second segment, epoch 4' },
    ])

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })
})
