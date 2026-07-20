import { encodeEventFrame } from '@kumiai/broadcast'
import { describe, expect, test } from 'vitest'

import type { AppWindowPruned } from '../src/app-cursor.js'
import { APP_TOPIC_LABEL, commitTopic, protocolTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { makeMLSPeer } from './fixtures/peer.js'

const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms))

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
    const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')

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
   * a cursor may not pass it — across restart after restart, for as long as the peer stays behind.
   *
   * The frame is sealed at epoch 4 and reaches a peer sitting at epoch 1 — a publisher the group
   * has carried further than this reader. `unwrap` refuses it exactly as it refuses a frame from an
   * epoch already spent, and that is the whole difficulty: one of those will open later and the
   * other never will, and only the frame's own cleartext epoch tells them apart. A drain that
   * treated "will not open" as done would write a position past this frame, and the next restart
   * would fetch after it and never see it again. Nothing would report that.
   *
   * THE FRAME MUST BE JUSTIFIED, and that is what shapes the staging below. A claim to be ahead is
   * only honoured as far as the group's own commit log can vouch for it — a member seals at epoch 4
   * only after applying the commit that produced 4, so that commit is in the log — and a claim the
   * log cannot justify is dead, not waiting. So the log here really does carry the group to epoch
   * 4, and the reader really is a member that cannot get there.
   *
   * WHICH MAKES THE READER A STRANDED ONE, necessarily. A peer that merely lags reads the log,
   * applies what is in it, and arrives — the very commits that justify the frame are the ones that
   * carry it to the frame's epoch, so the wait lasts one walk and no longer (that is the case
   * `peer-app-drain-integrity` covers). For the wait to survive a restart the peer has to be unable
   * to apply what it can see, which is a strand: here, bob meets his OWN un-merged commit at the
   * head of his walk, the drain stops dead on it, and no restart gets him past it while no
   * responder exists to heal him.
   *
   * The frame is never delivered in this test, and that is not an omission. A stranded peer's only
   * exit is a rejoin, a rejoin rotates the anchor, and a rotation moves the group to a new topic and
   * drops this buffer — so "delivered when the walk reaches it" belongs to the lagging peer, not to
   * this one. What this holds is the half that is real for a strand: it is not his to skip, it is
   * his to wait for, and the cursor never passes it.
   */
  test('a justified frame ahead of a stranded peer is never passed, however often it restarts', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x82)
    const seen: Array<unknown> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }
    const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
    // Fast enough that a heal which will find nobody gives up inside the test.
    const recovery = { timeoutMs: 60, getDelayMs: () => 5, deadlineMs: 250 }

    // Bob's own commit, accepted by the hub at epoch 1, with his process dead before he adopted it
    // and no journal to repair him. He can never apply the frame that is his own commit.
    await publishCommit({ hub, senderDID: 'bob', recoverySecret, epoch: 1 })
    // The group applied it and carried on without him: commits framed at 2 and 3 leave it at epoch
    // 4. This is what makes the frame below justified — and none of it is reachable by bob, whose
    // walk stops at his own commit before it ever reads these.
    await publishCommit({ hub, senderDID: 'zoe', recoverySecret, epoch: 2 })
    await publishCommit({ hub, senderDID: 'zoe', recoverySecret, epoch: 3 })

    // Two app frames on the segment's topic — the anchor never moves, since no commit here touches
    // a leaf. One at bob's own epoch, one at the epoch the group reached.
    const atOne = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const atFour = createFakeCrypto({ epoch: 4, localDID: 'alice' })
    for (const [crypto, text] of [
      [atOne, 'at epoch one'],
      [atFour, 'from epoch four'],
    ] as const) {
      await hub.publish({
        senderDID: 'alice',
        topicID,
        retain: 'log',
        payload: await crypto.wrap(encodeEventFrame('chat/posted', { text })),
      })
    }
    const posted = hub.published.filter((m) => m.topicID === topicID)
    expect(posted).toHaveLength(2)

    // Bob comes up at epoch 1 and strands: nobody is live to answer his rendezvous, so the heal
    // finds no responder and he stays exactly where he is.
    const first = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers, recovery })
    await flush(300)
    expect(first.mls.epoch()).toBe(1)

    // He read what his epoch opens, and stopped: the position sits on the frame he delivered and
    // NOT on the one he could not.
    expect(seen).toEqual([{ text: 'at epoch one' }])
    expect(first.appCursorStore.stored(topicID)).toBe(posted[0]?.sequenceID)

    // Restart after restart over the same durable state changes nothing and loses nothing. The
    // frame is neither delivered nor gone, and the position never moves past it — which is the only
    // reason a later epoch could still open it.
    let previous = first
    for (let restart = 0; restart < 2; restart++) {
      await previous.peer.dispose()
      const next = makeMLSPeer(hub, 'bob', recoverySecret, {
        restartOf: previous,
        handlers,
        recovery,
      })
      await flush(300)
      expect(next.mls.epoch()).toBe(1)
      expect(seen).toEqual([{ text: 'at epoch one' }])
      expect(next.appCursorStore.stored(topicID)).toBe(posted[0]?.sequenceID)
      previous = next
    }

    // And the frame is still on the hub, still sealed, still waiting: nothing consumed it.
    expect(hub.published.filter((m) => m.topicID === topicID)).toHaveLength(2)

    await previous.peer.dispose()
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
    const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')

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
