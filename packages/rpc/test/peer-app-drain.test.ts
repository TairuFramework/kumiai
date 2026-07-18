import { describe, expect, test } from 'vitest'

import { commitTopic, protocolTopic } from '../src/topic.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { fakeEpochSecret } from './fixtures/fake-crypto.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 50))

/**
 * An app frame is sealed under the epoch it was sent at, and it lives on a topic derived from
 * that epoch. A peer that walks the commit log forward walks past both — so the frames it was
 * sent, and has not read yet, are exactly what the commit lane is in a position to destroy.
 *
 * These assert the PLAINTEXT, and nothing else. A peer that loses these messages converges,
 * matches the roster, reaches the right epoch and raises nothing: every other assertion in this
 * suite passes while a week of messages goes missing.
 */
describe('app frames outlive the commits that leave their epoch', () => {
  /**
   * A retained frame sealed at the peer's own epoch, and a process that died before reading it.
   *
   * Nothing pushes it at him: it was published while he was gone, and a subscription back-fills
   * nothing — so the pull is the only thing in a position to deliver it, and the assertion below
   * is on the drain and on nothing else. The restarted handle comes back at the epoch the frame
   * was sealed at, which is what makes the key its to hold; the seed pull reads the segment's
   * topic before the walk ratchets the handle off that epoch, which is what makes the key its to
   * USE. Neither half alone delivers anything.
   */
  test('a peer that was restarted still reads the messages sent at its epoch', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x40)
    const seen: Array<unknown> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers })
    await flush()

    // Bob's process dies — a phone in a pocket, not a dropped socket. It is never disposed, so
    // the hub still holds his subscriptions and still keeps his frames for him.
    hub.detach('bob')

    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'before lunch' })
    for (let i = 0; i < 10; i++) {
      await alice.peer.commit(buildLedgerCommit(alice, []))
    }
    await flush()
    expect(alice.mls.epoch()).toBe(11)
    expect(seen).toEqual([]) // nothing reached him: this is a backlog, not a live delivery

    // He comes back up over the same handle. He is still at epoch 1, and he still holds epoch
    // 1's secret — the key that opens the message is in his hand.
    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, {
      restartOf: bob,
      handlers,
    })
    hub.reattach('bob')
    await flush()

    expect(restarted.mls.epoch()).toBe(11)
    expect(seen).toEqual([{ text: 'before lunch' }])

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })

  /**
   * A frame sealed at an epoch this peer was never online for. It is the walk that delivers it:
   * the handle holds every epoch between where it starts and the head, one at a time, and the
   * frame is read at the epoch that seals it — before the commit that ratchets past it.
   *
   * No roster change happens, so the anchor never moves and every frame here is on one topic.
   * The only thing separating the delivered frame from the undelivered one is the epoch it was
   * sealed under, which is what makes this about per-epoch reads and not about topics.
   */
  test('a peer reads the messages sent at an epoch it was never online for', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x41)
    const seen: Array<unknown> = []

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    await flush()

    // Alice runs the group to epoch 3, posts there, and runs on to 6.
    for (let i = 0; i < 2; i++) {
      await alice.peer.commit(buildLedgerCommit(alice, []))
    }
    expect(alice.mls.epoch()).toBe(3)
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'sent at epoch three' })
    for (let i = 0; i < 3; i++) {
      await alice.peer.commit(buildLedgerCommit(alice, []))
    }
    await flush()
    expect(alice.mls.epoch()).toBe(6)
    expect(alice.peer.anchorEpoch()).toBe(1) // one segment, one topic

    // Bob comes up at epoch 1. Epoch 3 is one he was never at: no subscription of his was ever
    // live while the group was there, and his handle can export that epoch's secret only once
    // the walk has carried it there.
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
      epoch: 1,
      handlers: { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) },
    })
    await flush()

    expect(bob.mls.epoch()).toBe(6)
    expect(seen).toEqual([{ text: 'sent at epoch three' }])

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  /**
   * A frame sealed at this peer's own epoch that reaches the log AFTER the commit that leaves
   * that epoch — the publisher had not applied the commit yet, so it sealed under an epoch the
   * committer had already left.
   *
   * Whether it is delivered turns on the READER's epoch and never on where the frame sits in the
   * log relative to that commit: the drain reads a segment's topic whole, and it reads it ahead
   * of every apply. A reader still at the sealing epoch opens it. A reader already past it never
   * will — and that half is inherent to sealing under an epoch the group has left, not something
   * an ordering here could repair.
   */
  test('a peer reads a message sent at its own epoch that reached the log after the commit leaving it', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x42)
    const seen: Array<unknown> = []

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const carol = makeMLSPeer(hub, 'carol', recoverySecret, { epoch: 1 })
    await flush()

    // Alice's connection is behind, so the commit that takes the group off epoch 1 lands in the
    // log while she is still at epoch 1 and has not applied it.
    hub.detach('alice')
    await carol.peer.commit(buildLedgerCommit(carol, []))
    await flush()
    expect(carol.mls.epoch()).toBe(2)
    expect(alice.mls.epoch()).toBe(1)

    // So she posts at epoch 1, and the frame enters the log behind the commit that left epoch 1.
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'raced the commit' })

    const commits = hub.published.filter((m) => m.topicID === commitTopic(recoverySecret))
    const posted = hub.published.filter(
      (m) => m.topicID === protocolTopic(fakeEpochSecret(1), 1, 'chat'),
    )
    expect(commits).toHaveLength(1)
    expect(posted).toHaveLength(1)
    expect(posted[0].sequenceID > commits[0].sequenceID).toBe(true) // the ordering IS the scenario

    // Bob is at epoch 1 too, so the frame is sealed under a key he holds — and he reads it before
    // he applies the commit that would take that key away from him.
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
      epoch: 1,
      handlers: { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) },
    })
    await flush()

    expect(bob.mls.epoch()).toBe(2)
    expect(seen).toEqual([{ text: 'raced the commit' }])

    await alice.peer.dispose()
    await carol.peer.dispose()
    await bob.peer.dispose()
  })

  /**
   * Retention is the protocol's declaration, and it is the whole of what decides this. Both
   * procedures are on one protocol and one topic, so a returning member handed the logged
   * history and none of the ephemeral history cannot be topic separation doing the work: the
   * ephemeral frame is on the very topic the drain just pulled, and it is not in that topic's
   * log to be pulled.
   */
  test('a returning peer is given the logged history and none of the ephemeral history', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x43)
    const posted: Array<unknown> = []
    const changed: Array<unknown> = []
    const handlers = {
      'chat/posted': (ctx: { data: unknown }) => void posted.push(ctx.data),
      'chat/changed': (ctx: { data: unknown }) => void changed.push(ctx.data),
    }

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers })
    await flush()

    await bob.peer.dispose()
    hub.detach('bob')

    // One ephemeral event and one logged one, dispatched at the same epoch onto the same topic.
    await alice.peer.protocol('chat').dispatch('chat/changed', { text: 'alice is typing' })
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'alice said something' })
    await alice.peer.commit(buildLedgerCommit(alice, []))
    await flush()
    expect(posted).toEqual([])
    expect(changed).toEqual([])

    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob, handlers })
    hub.reattach('bob')
    await flush()

    expect(restarted.mls.epoch()).toBe(2)
    expect(posted).toEqual([{ text: 'alice said something' }])
    expect(changed).toEqual([]) // an ephemeral event leaves no history to come back to

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })
})
