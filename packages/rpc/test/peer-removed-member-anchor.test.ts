import { describe, expect, test } from 'vitest'

import { createMemoryAnchorStore } from './fixtures/anchor.js'
import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 50))

/**
 * A REMOVED MEMBER DOES NOT RE-ANCHOR — and the reason it nearly did is worth stating, because
 * this is the one case where a roster change and an epoch change come apart.
 *
 * `advanceHandle` decides the rotation by diffing the roster across the advance. For every other
 * commit that is exactly right: a roster change is a commit, and a commit this handle applied
 * moved its epoch. The commit that removes this member is the exception. There is no epoch it can
 * move to — the commit's path excludes the leaf it drops — and yet real MLS still applies the
 * commit's proposals to the tree, so the handle reports a roster WITHOUT this member at an epoch
 * that did not move. Measured against ts-mls, not reasoned about: `processMessage` returns
 * without throwing, the epoch stays, and `listMembers()` has lost the member's own leaf. The
 * double models it that way for the same reason.
 *
 * Asserted on the anchor STORE rather than on the anchor's value, because a capture at an
 * unchanged epoch re-derives the value it already holds — the write is the only visible thing,
 * and it is not the only thing that happens. `captureAnchor` also clears the segment buffer, on
 * the reasoning that a rotation makes undelivered frames unopenable forever; true of a rotation,
 * false here, where the handle is still at the epoch those frames were sealed at.
 */
describe('a member removed by a commit it applies keeps its anchor', () => {
  test('the removal writes no new anchor, because nothing rotated', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x77)
    const seen: Array<unknown> = []
    const anchorStore = createMemoryAnchorStore()
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
      epoch: 1,
      members: ['alice', 'bob'],
    })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
      epoch: 1,
      members: ['alice', 'bob'],
      anchorStore,
      handlers,
    })
    await flush()

    // The founding capture, and the baseline the removal is measured against.
    const savesBefore = anchorStore.saves()
    expect(savesBefore).toBeGreaterThan(0)
    const anchoredAt = anchorStore.stored()
    expect(anchoredAt?.epoch).toBe(1)

    // A message bob has not read, waiting in the log, and then the commit that removes him.
    await bob.peer.dispose()
    hub.detach('bob')
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'owed to bob' })
    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1, removes: ['bob'] })
    await flush()

    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, {
      restartOf: bob,
      members: ['alice', 'bob'],
      handlers,
    })
    hub.reattach('bob')
    await flush()

    // His handle could not follow the commit, so his epoch is where it was and his roster is what
    // the commit left him: the tree applied, his own leaf gone.
    expect(restarted.crypto.epoch()).toBe(1)
    expect(await restarted.mls.rosterDIDs()).toEqual(['alice'])

    // And no anchor was written for it. A capture here would re-derive the value already stored
    // and clear the segment buffer on the way — a rotation's cleanup for something that did not
    // rotate.
    expect(anchorStore.saves()).toBe(savesBefore)
    expect(anchorStore.stored()?.epoch).toBe(1)
    expect(anchorStore.stored()?.secret).toEqual(anchoredAt?.secret)

    // The control: the drain ran and delivered, so the silence about the anchor is the gate and
    // not a peer that did nothing.
    expect(seen).toEqual([{ text: 'owed to bob' }])

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })
})
