import { encodeEventFrame } from '@kumiai/broadcast'
import { describe, expect, test } from 'vitest'

import type { AppWindowPruned } from '../src/app-cursor.js'
import { commitTopic, protocolTopic } from '../src/topic.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 50))

/**
 * Where a returning peer starts reading its app history from, and what it is told about the part
 * that is no longer there.
 *
 * Two invariants, and they hold each other up. A CURSOR MAY ONLY PASS A FRAME THAT IS DELIVERED OR
 * DEAD: a frame sealed at an epoch the walk has not reached yet is neither, it opens once the walk
 * gets there, and a position that passed it would drop it on the next restart — the exact loss the
 * position exists to stop. And A GAP BELOW RETENTION IS REPORTED, NEVER SILENT: the distance
 * between where this peer read to and where the hub's log now begins is the only place a missing
 * history is knowable at all, and it is knowable only because the position survived.
 */
describe('the app-lane drain reads from a durable position and reports what aged out below it', () => {
  /**
   * The position is what stops the re-read. Without it the drain pulls the segment from the hub's
   * oldest retained frame every time it comes up, and everything the handle can still open is
   * delivered to the host again — a returning member watching its own history replay.
   */
  test('a restarted peer reads from its position, and does not re-deliver what it delivered', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x81)
    const seen: Array<unknown> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }
    const topicID = protocolTopic(fakeEpochSecret(1), 1, 'chat')

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers })
    await flush()

    // Bob's process dies, and the group talks past him. Nothing pushes these at him later — a
    // subscription back-fills nothing — so the drain is the only thing that can deliver them.
    await bob.peer.dispose()
    hub.detach('bob')
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'one' })
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'two' })
    await flush()
    expect(seen).toEqual([])

    const first = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob, handlers })
    hub.reattach('bob')
    await flush()
    expect(seen).toEqual([{ text: 'one' }, { text: 'two' }])

    // Both frames are delivered, so both are done, so the position sits on the second of them.
    const posted = hub.published.filter((m) => m.topicID === topicID)
    expect(posted).toHaveLength(2)
    expect(bob.appCursorStore.stored(topicID)).toBe(posted[1]?.sequenceID)

    // He dies again and comes back over the same durable state — the same handle at the same
    // epoch, so every one of those frames is still openable by him. The position is the only
    // thing standing between the host and a second copy of its own history.
    await first.peer.dispose()
    const second = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: first, handlers })
    hub.reattach('bob')
    await flush()

    expect(seen).toEqual([{ text: 'one' }, { text: 'two' }])

    await alice.peer.dispose()
    await second.peer.dispose()
  })

  /**
   * THE ADVANCE RULE, and the test that holds it: a frame sealed AHEAD of the walk is not done, and
   * a cursor may not pass it.
   *
   * The frame here is sealed at epoch 4 and reaches a peer sitting at epoch 1 — a publisher the
   * group has carried further than this reader. `unwrap` refuses it exactly as it refuses a frame
   * from an epoch already spent, and that is the whole difficulty: one of those will open later and
   * the other never will, and only the frame's own cleartext epoch tells them apart. A drain that
   * treated "will not open" as done would write a position past this frame, and the next restart
   * would fetch after it and never see it again. Nothing would report that.
   */
  test('a frame sealed ahead of the walk survives restarts and is delivered when the walk reaches it', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x82)
    const seen: Array<unknown> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }
    const topicID = protocolTopic(fakeEpochSecret(1), 1, 'chat')

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers })
    await flush()
    await bob.peer.dispose()
    hub.detach('bob')

    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'at epoch one' })
    // A frame sealed at epoch 4, onto the segment's topic, while the group's log has no commit
    // that leaves epoch 1. Its publisher is a member the group carried on without this reader.
    const future = createFakeCrypto({ epoch: 4, localDID: 'alice' })
    await hub.publish({
      senderDID: 'alice',
      topicID,
      retain: 'log',
      payload: await future.wrap(encodeEventFrame('chat/posted', { text: 'from epoch four' })),
    })
    await flush()

    // Bob comes back at epoch 1 and walks nowhere: there is nothing in the commit log to apply.
    const first = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob, handlers })
    hub.reattach('bob')
    await flush()
    expect(first.mls.epoch()).toBe(1)
    expect(seen).toEqual([{ text: 'at epoch one' }])

    // The position stopped at the frame he read and did NOT pass the one he could not: it is not
    // his to skip, it is his to wait for.
    const posted = hub.published.filter((m) => m.topicID === topicID)
    expect(posted).toHaveLength(2)
    expect(bob.appCursorStore.stored(topicID)).toBe(posted[0]?.sequenceID)

    // A restart that reaches no further epoch than the last one changes nothing, and loses
    // nothing: the frame is neither delivered nor gone.
    await first.peer.dispose()
    const second = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: first, handlers })
    hub.reattach('bob')
    await flush()
    expect(second.mls.epoch()).toBe(1)
    expect(seen).toEqual([{ text: 'at epoch one' }])
    await second.peer.dispose()

    // Now the group's log carries him to the epoch the frame was sealed at, across yet another
    // restart. The frame's key is finally his, and the frame is still there for it.
    for (let i = 0; i < 3; i++) {
      await alice.peer.commit(buildLedgerCommit(alice, []))
    }
    await flush()
    expect(alice.mls.epoch()).toBe(4)
    expect(alice.peer.anchorEpoch()).toBe(1) // no roster change: one segment, one topic

    const third = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: second, handlers })
    hub.reattach('bob')
    await flush()

    expect(third.mls.epoch()).toBe(4)
    expect(seen).toEqual([{ text: 'at epoch one' }, { text: 'from epoch four' }])
    expect(bob.appCursorStore.stored(topicID)).toBe(posted[1]?.sequenceID)

    await alice.peer.dispose()
    await third.peer.dispose()
  })

  /**
   * The hub's retention floor moves past the place a peer had read to. The frames in between are
   * gone — no member, no epoch and no key brings them back — so the only question left is whether
   * anybody says so. The peer's own position is the sole evidence: without it, a log starting at
   * the floor and a log this peer had read to the floor look identical.
   */
  test('a window pruned below the position is delivered around and reported, naming the group', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x83)
    const seen: Array<unknown> = []
    const pruned: Array<AppWindowPruned> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }
    const topicID = protocolTopic(fakeEpochSecret(1), 1, 'chat')

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers })
    await flush()

    await bob.peer.dispose()
    hub.detach('bob')
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'read before the gap' })
    await flush()

    // Bob reads that one and records where he got to. The gap below is measured from here.
    const first = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob, handlers })
    hub.reattach('bob')
    await flush()
    expect(seen).toEqual([{ text: 'read before the gap' }])
    await first.peer.dispose()
    hub.detach('bob')

    // He is away long enough for the group to talk and for the hub's window to close over part of
    // it: the frame he read, and one he never did, both age out. The survivor is still his.
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'aged out unread' })
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'still retained' })
    await flush()
    const posted = hub.published.filter((m) => m.topicID === topicID)
    expect(posted).toHaveLength(3)
    const survivor = posted[2]?.sequenceID as string
    hub.trim(topicID, survivor)
    expect(hub.oldest(topicID)).toBe(survivor)

    const second = makeMLSPeer(hub, 'bob', recoverySecret, {
      restartOf: first,
      handlers,
      onAppWindowPruned: (event) => void pruned.push(event),
    })
    hub.reattach('bob')
    await flush()

    // (a) What survived is still delivered. A gap is a notice, not a reason to hand a returning
    // member less than the hub still holds.
    expect(seen).toEqual([{ text: 'read before the gap' }, { text: 'still retained' }])

    // (b) And the gap is reported, naming the group it is in and both of its edges: the place this
    // peer read to, and the place the hub's log now begins. No date — the host renders "messages
    // since <when>" from its own clock, off positions rpc can actually vouch for.
    expect(pruned).toHaveLength(1)
    expect(pruned[0]?.groupID).toBe(commitTopic(recoverySecret))
    expect(pruned[0]?.protocol).toBe('chat')
    expect(pruned[0]?.cursor).toBe(posted[0]?.sequenceID)
    expect(pruned[0]?.oldest).toBe(survivor)

    await alice.peer.dispose()
    await second.peer.dispose()
  })
})
