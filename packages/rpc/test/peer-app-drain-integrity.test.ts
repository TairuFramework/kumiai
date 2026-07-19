import { encodeEventFrame } from '@kumiai/broadcast'
import type { HubFetchTopicParams, HubFetchTopicResult } from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import type { AppWindowPruned } from '../src/app-cursor.js'
import { protocolTopic } from '../src/topic.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 50))

/**
 * A hub whose topic fetch fails ONCE per armed topic, then behaves. The transient outage — the
 * connection dropped between two reads of the same walk — is otherwise unreachable from a test,
 * and it is the only way to ask what a drain does with an epoch it did not manage to read.
 */
class FlakyFetchHub extends DurableFakeHub {
  #failOnce = new Set<string>()

  /** Arm the next fetch of this topic to fail. Consumed by that fetch, whoever makes it. */
  failNextFetch(topicID: string): void {
    this.#failOnce.add(topicID)
  }

  override async fetchTopic(params: HubFetchTopicParams): Promise<HubFetchTopicResult> {
    if (this.#failOnce.delete(params.topicID)) {
      throw new Error(`the hub is unreachable for ${params.topicID}`)
    }
    return super.fetchTopic(params)
  }
}

/**
 * What the returning-member drain does with a frame it cannot open yet, an epoch it failed to
 * read, and a frame that lands while it is still walking.
 *
 * One safety property underneath all three: A CURSOR MAY ONLY PASS A FRAME THAT IS DELIVERED OR
 * DEAD, and A HANDLE MAY NOT RATCHET PAST AN EPOCH WHOSE FRAMES WERE NOT READ. Both are one-way
 * doors — the position is durable and the handle never comes back — so every question here is
 * decided before the door shuts, not after.
 */
describe('the drain bounds what a frame may claim, and passes no epoch it failed to read', () => {
  /**
   * A frame's cleartext epoch is the untrusted hub's relay of a publisher's word, and the drain
   * waits on a frame that claims to be ahead of the walk. Unbounded, that word is a way to pin the
   * cursor forever: one injected frame claiming an epoch no group will ever reach holds the
   * position behind it for the segment's whole life, and a roster-stable group never rotates out
   * from under it.
   *
   * The bound is the group's OWN commit log: a member seals at an epoch only after applying the
   * commit that produced it, so a claim the log cannot justify is one no member could have made.
   * Not ahead — DEAD, and dead is done.
   */
  test('a frame claiming an epoch the commit log cannot justify is dead, and the cursor passes it', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x91)
    const seen: Array<unknown> = []
    const pruned: Array<AppWindowPruned> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }
    const topicID = protocolTopic(fakeEpochSecret(1), 1, 'chat')

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers })
    await flush()
    await bob.peer.dispose()
    hub.detach('bob')

    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'at epoch one' })
    // The injected frame. Its bytes claim epoch 65535 while the group's commit log holds no
    // commit at all — nothing anywhere says the group ever left epoch 1.
    const forged = createFakeCrypto({ epoch: 65535, localDID: 'mallory' })
    await hub.publish({
      senderDID: 'mallory',
      topicID,
      retain: 'log',
      payload: await forged.wrap(encodeEventFrame('chat/posted', { text: 'from nowhere' })),
    })
    await flush()

    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, {
      restartOf: bob,
      handlers,
      onAppWindowPruned: (event) => void pruned.push(event),
    })
    hub.reattach('bob')
    await flush()

    expect(seen).toEqual([{ text: 'at epoch one' }])

    // The whole assertion is on the PERSISTED position: the forged frame is not merely undelivered
    // (it never could be), it is behind the cursor, so it is out of the buffer and out of every
    // future pull. Nothing about it survives to be re-fetched or re-reported.
    const posted = hub.published.filter((m) => m.topicID === topicID)
    expect(posted).toHaveLength(2)
    expect(bob.appCursorStore.stored(topicID)).toBe(posted[1]?.sequenceID)
    expect(pruned).toEqual([])

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })

  /**
   * The other side of that bound, and the loss it must not cause: a frame sealed GENUINELY ahead —
   * its commit is in the log, so the group really is where the frame says it is — keeps its bytes
   * and its place until the walk reaches its epoch.
   *
   * Two epochs ahead, not one, because a bound taken from this peer's own handle rather than from
   * the log would still admit the first and eat the second: a returning member is behind by
   * however long it was away, and every epoch it has not reached yet is one the log already
   * justifies.
   */
  test('a frame the commit log justifies keeps its place, and the cursor passes it only on delivery', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x92)
    const seen: Array<unknown> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }
    const topicID = protocolTopic(fakeEpochSecret(1), 1, 'chat')

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers })
    await flush()
    await bob.peer.dispose()
    hub.detach('bob')

    // One frame at epoch 1, then two commits carrying the group to epoch 3 — no roster change, so
    // one anchor and one topic throughout — and a frame sealed at 3. Bob is still at 1.
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'at epoch one' })
    await alice.peer.commit(buildLedgerCommit(alice, []))
    await flush()
    await alice.peer.commit(buildLedgerCommit(alice, []))
    await flush()
    expect(alice.mls.epoch()).toBe(3)
    expect(alice.peer.anchorEpoch()).toBe(1)
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'at epoch three' })
    await flush()

    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob, handlers })
    hub.reattach('bob')
    await flush()

    expect(restarted.mls.epoch()).toBe(3)
    expect(seen).toEqual([{ text: 'at epoch one' }, { text: 'at epoch three' }])

    // Every position the store was ever told about, in order: the walk stopped behind the ahead
    // frame first and only passed it once its epoch arrived. A cursor that had gone straight to
    // the second position would have passed an undelivered frame on its way there.
    const posted = hub.published.filter((m) => m.topicID === topicID)
    expect(posted).toHaveLength(2)
    expect(bob.appCursorStore.history(topicID)).toEqual([
      posted[0]?.sequenceID,
      posted[1]?.sequenceID,
    ])

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })

  /**
   * BYTES THAT ARE NOT A FRAME AT ALL, whose first two happen to read as an epoch the commit log
   * does justify. Nothing about them is a publisher's claim — no member wrote them — but a reader
   * that answers "what epoch does this claim?" structurally, without asking whether the bytes are
   * a frame, mints one out of the noise and then honours it.
   *
   * The cost is the cursor: a claim of AHEAD-and-justified is the one answer that makes a frame
   * keep its place, so the position sits behind the garbage for every epoch between here and the
   * claim, and every frame delivered in that window is re-read and re-delivered by a restart. The
   * port's answer for bytes that are not a readable sealed frame is `null`, which is DEAD, and
   * dead is done at the first epoch that sees it.
   */
  test('bytes that are not a frame claim no epoch, however their leading bytes read', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x97)
    const seen: Array<unknown> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }
    const topicID = protocolTopic(fakeEpochSecret(1), 1, 'chat')

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers })
    await flush()
    await bob.peer.dispose()
    hub.detach('bob')

    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'at epoch one' })
    // `03 00` little-endian is epoch 3, and the two commits below carry the group there — so the
    // log justifies the number, and only the shape of the rest can refuse it.
    await hub.publish({
      senderDID: 'mallory',
      topicID,
      retain: 'log',
      payload: new Uint8Array([0x03, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    })
    await alice.peer.commit(buildLedgerCommit(alice, []))
    await flush()
    await alice.peer.commit(buildLedgerCommit(alice, []))
    await flush()
    expect(alice.mls.epoch()).toBe(3)
    expect(alice.peer.anchorEpoch()).toBe(1) // one segment, one topic

    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob, handlers })
    hub.reattach('bob')
    await flush()

    expect(restarted.mls.epoch()).toBe(3)
    expect(seen).toEqual([{ text: 'at epoch one' }])

    // ONE write, and it is the last position: the garbage was resolved at the same epoch as the
    // frame in front of it, so the cursor never rested behind it. A second, earlier write is the
    // stall — the window in which a restart re-delivers everything the drain had already handed
    // over.
    const frames = hub.published.filter((m) => m.topicID === topicID)
    expect(frames).toHaveLength(2)
    expect(bob.appCursorStore.history(topicID)).toEqual([frames[1]?.sequenceID])

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })

  /**
   * A hub that drops one fetch mid-walk. The pull is a retry and can be made again; the DELIVERY
   * cannot — the walk that carries on ratchets the handle past every epoch it then passes, and
   * those frames are ciphertext forever. So a failed pull stalls the walk rather than being
   * stepped over: no epoch is passed unread, and the retry finds the backlog whole.
   */
  test('a drain whose pull fails does not ratchet past the epoch it could not read', async () => {
    const hub = new FlakyFetchHub()
    const recoverySecret = new Uint8Array(32).fill(0x93)
    const seen: Array<unknown> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }
    const topicID = protocolTopic(fakeEpochSecret(1), 1, 'chat')

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers })
    await flush()
    await bob.peer.dispose()
    hub.detach('bob')

    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'at epoch one' })
    await alice.peer.commit(buildLedgerCommit(alice, []))
    await flush()
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'at epoch two' })
    await flush()
    expect(alice.mls.epoch()).toBe(2)

    // Bob comes back into an outage: the app topic's first fetch of his life fails, which is the
    // fetch the drain makes before the commit that would leave epoch 1.
    hub.failNextFetch(topicID)
    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob, handlers })
    hub.reattach('bob')
    await flush()

    // Nothing read, so nothing passed: the handle is still at the epoch whose frames it owes, and
    // the position was never written. A stalled walk is the accepted cost.
    expect(seen).toEqual([])
    expect(restarted.mls.epoch()).toBe(1)
    expect(bob.appCursorStore.stored(topicID)).toBeNull()

    // The next wakeup retries the pull, and the backlog is whole: the epoch-1 frame is still
    // openable because the handle never left epoch 1.
    await alice.peer.commit(buildLedgerCommit(alice, []))
    await flush()

    expect(seen).toEqual([{ text: 'at epoch one' }, { text: 'at epoch two' }])
    expect(restarted.mls.epoch()).toBe(3)

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })

  /**
   * The log GROWS while the walk is walking. A drain that pulls the segment once reads the log as
   * it stood when the walk began, and every frame published in between is one no later pull ever
   * asks for — dropped-if-not-listening, reintroduced inside the very drain that exists to end it.
   *
   * What used to make the re-pull unaffordable — and kept this test skipped — was that only the
   * drain's own deliveries moved the read position, so an online peer's second pull re-read every
   * frame the LIVE lane had already handed the host. The push now carries its own log position
   * (`StoredMessage.logPosition`), the live lane takes that position, and a re-pull returns only
   * what was never delivered. The last assertion is the half that could not be written before: the
   * cursor ends on the mid-walk frame, so a restart does not read it again.
   */
  test('a frame published while the walk is still walking is picked up by it', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x94)
    const seen: Array<unknown> = []
    const topicID = protocolTopic(fakeEpochSecret(1), 1, 'chat')

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1 })
    await flush()
    await bob.peer.dispose()
    hub.detach('bob')

    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'at epoch one' })
    await alice.peer.commit(buildLedgerCommit(alice, []))
    await flush()
    expect(alice.mls.epoch()).toBe(2)

    // The mid-walk publish, hung off the delivery of the epoch-1 frame: at that moment bob's walk
    // has pulled the segment and has not yet applied the commit that leaves epoch 1. Published
    // while he is not listening — the live lane must not be what saves this.
    let injected = false
    const handlers = {
      'chat/posted': async (ctx: { data: unknown }) => {
        seen.push(ctx.data)
        if (injected) return
        injected = true
        const atTwo = createFakeCrypto({ epoch: 2, localDID: 'alice' })
        hub.detach('bob')
        await hub.publish({
          senderDID: 'alice',
          topicID,
          retain: 'log',
          payload: await atTwo.wrap(encodeEventFrame('chat/posted', { text: 'mid-walk, at two' })),
        })
        hub.reattach('bob')
      },
    }

    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob, handlers })
    hub.reattach('bob')
    await flush()

    expect(restarted.mls.epoch()).toBe(2)
    expect(seen).toEqual([{ text: 'at epoch one' }, { text: 'mid-walk, at two' }])

    const posted = hub.published.filter((m) => m.topicID === topicID)
    expect(posted).toHaveLength(2)
    expect(bob.appCursorStore.stored(topicID)).toBe(posted[1]?.sequenceID)

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })
})

/**
 * A drain hands the host what the LIVE lane would have handed it and nothing besides. The log is
 * the only place these two frames can come from — the live fan-out never produces either — so each
 * one is a way for a pull to deliver what a push never could.
 */
describe('the drain delivers only what the live lane would', () => {
  /**
   * Retention is the PROTOCOL's word about a procedure, not the frame's about itself. A frame
   * naming an ephemeral procedure that is nonetheless sitting in a topic's log was published
   * `retain: 'log'` by a member whose own dispatch would never do that — a hub or a member free to
   * choose the flag, promoting a procedure the group declared unretained into history.
   *
   * Both procedures are on one protocol and one topic, so nothing here is topic separation: the
   * ephemeral frame is in the very log the drain just pulled, sealed at the epoch the reader is
   * at, naming a procedure the reader has a handler for.
   */
  test('a retained frame naming an ephemeral procedure is not delivered', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x95)
    const posted: Array<unknown> = []
    const changed: Array<unknown> = []
    const handlers = {
      'chat/posted': (ctx: { data: unknown }) => void posted.push(ctx.data),
      'chat/changed': (ctx: { data: unknown }) => void changed.push(ctx.data),
    }
    const topicID = protocolTopic(fakeEpochSecret(1), 1, 'chat')

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers })
    await flush()
    await bob.peer.dispose()
    hub.detach('bob')

    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'a logged event' })
    // Alice's dispatch would never retain this one, so it is published around her peer: same
    // topic, same epoch key, same sender, `retain: 'log'` on a procedure that never declared it.
    const atOne = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    await hub.publish({
      senderDID: 'alice',
      topicID,
      retain: 'log',
      payload: await atOne.wrap(encodeEventFrame('chat/changed', { text: 'alice is typing' })),
    })
    await flush()

    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob, handlers })
    hub.reattach('bob')
    await flush()

    expect(posted).toEqual([{ text: 'a logged event' }])
    expect(changed).toEqual([])

    // And it is consumed rather than left to be re-offered: the cursor is past both frames.
    const frames = hub.published.filter((m) => m.topicID === topicID)
    expect(frames).toHaveLength(2)
    expect(bob.appCursorStore.stored(topicID)).toBe(frames[1]?.sequenceID)

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })

  /**
   * A member's own frames are in the log it drains — the hub retains one copy of a topic, not one
   * per reader — and the live fan-out never echoes a publisher its own broadcast. So a pull that
   * delivered them would hand the host its own sends back, and only on the paths that pull: the
   * same event would be seen once when online and twice across a restart.
   *
   * Alice's frame is the control. It proves the drain ran, opened this epoch's bytes and reached
   * the handler, so bob's silence about his own frame is the skip and not an empty pull.
   */
  test("a member's own frame in the log is not delivered back to it", async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x96)
    const seen: Array<unknown> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }
    const topicID = protocolTopic(fakeEpochSecret(1), 1, 'chat')

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers })
    await flush()

    // Bob publishes, and his own peer never sees it come back: the hub does not push a frame at
    // the member that sent it. Nothing has moved his read position past it.
    await bob.peer.protocol('chat').dispatch('chat/posted', { text: 'bob said this' })
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'alice said this' })
    await flush()
    expect(seen).toEqual([{ text: 'alice said this' }])

    await bob.peer.dispose()
    hub.detach('bob')
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'alice said more' })
    await flush()

    // The restart drains the whole topic from the cursor — his own frame included, because the
    // log holds it and the position never passed it.
    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob, handlers })
    hub.reattach('bob')
    await flush()

    // Bob's own frame is skipped, and alice's frames arrive in log order. Her FIRST one does not
    // arrive a second time: the live open spent its per-message key, and a restart carries the
    // handle's state forward rather than rewinding it, so the drain's re-open of those same bytes
    // fails the way any spent frame does. That is key exhaustion, not a delivery rule — the drain
    // is at-least-once against the live path, and a frame whose key outlived the restart may well
    // be handed over twice. The rule under test is the skip, asserted on its own below.
    expect(seen).toEqual([{ text: 'alice said this' }, { text: 'alice said more' }])
    expect(seen).not.toContainEqual({ text: 'bob said this' })

    const frames = hub.published.filter((m) => m.topicID === topicID)
    expect(frames).toHaveLength(3)
    expect(bob.appCursorStore.stored(topicID)).toBe(frames[2]?.sequenceID)

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })
})
