import { encodeEventFrame } from '@kumiai/broadcast'
import { describe, expect, test } from 'vitest'

import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { createMemoryAnchorStore, type MemoryAnchorStore } from './fixtures/anchor.js'
import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { buildInviteCommit, buildRemoveCommit, makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 50))

const MEMBERS = ['alice', 'bob', 'carol']

/** The chat topic of the segment anchored at `epoch`: that epoch's secret, under that epoch. */
const chatTopic = (epoch: number): string =>
  protocolTopic(fakeEpochSecret(epoch, APP_TOPIC_LABEL), epoch, 'chat')

/**
 * A handle does not ratchet past an epoch until that epoch's frames are read and its anchor is
 * taken. Both are one-way doors — past the advance those frames are ciphertext forever, and that
 * epoch's secret can never be exported again — so the site that does the advancing is the only
 * thing in a position to hold either, and every site that advances has to hold both.
 *
 * The peer advances in four places, and only one of them is a commit arriving from the log. These
 * are the other three: a roster change this peer AUTHORS, one it adopts out of its journal on
 * restart, and the dispatch that races a rotation. Every one of them is a peer partitioning
 * silently from its own group — no error, no throw, no restart that heals it — so they are
 * asserted on the ANCHOR and on the WIRE: two peers that rotate differently still converge, still
 * agree on the roster, still reach the same epoch and still raise nothing, and the only thing that
 * says they have stopped hearing each other is a message that does not arrive.
 */
describe('the member that authors a roster change rotates with the members that apply it', () => {
  /**
   * The author is the one member that can never learn about its own roster change from the apply
   * site: MLS merges a pending commit, it does not process one, so the frame it published is a
   * frame it never applies. An evicting admin that did not rotate here would go on publishing to
   * the topic the member it just removed still holds.
   */
  test('a Remove this peer authors lands it on the anchor every applying member reaches', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x91)
    const aliceSaw: Array<unknown> = []
    const bobSaw: Array<unknown> = []

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
      epoch: 1,
      members: MEMBERS,
      handlers: { 'chat/posted': (ctx: { data: unknown }) => void aliceSaw.push(ctx.data) },
    })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
      epoch: 1,
      members: MEMBERS,
      handlers: { 'chat/posted': (ctx: { data: unknown }) => void bobSaw.push(ctx.data) },
    })
    await flush()
    expect(alice.peer.anchorEpoch()).toBe(1)
    expect(bob.peer.anchorEpoch()).toBe(1)

    // Alice evicts Carol herself, through `commit()`. Bob learns of it the ordinary way, by
    // applying the frame from the log.
    await alice.peer.commit(buildRemoveCommit(alice, 'carol'))
    await flush()

    expect(alice.mls.leaves()).not.toContain('carol')
    expect(bob.mls.leaves()).not.toContain('carol')
    expect(alice.mls.epoch()).toBe(2)
    expect(bob.mls.epoch()).toBe(2)

    // The agreement, and the author is the half of it nothing else can supply.
    expect(bob.peer.anchorEpoch()).toBe(2)
    expect(alice.peer.anchorEpoch()).toBe(2)
    expect(alice.anchorStore.stored()?.epoch).toBe(2)

    // On the wire, both ways: an author left behind at the old anchor still holds the roster Bob
    // holds and still sits at his epoch, and every assertion above this line passes while the two
    // of them talk into different topics forever.
    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'after' })
    await flush()
    expect(bobSaw).toEqual([{ text: 'after' }])

    await bob.peer.protocol('chat').dispatch('chat/posted', { text: 'reply' })
    await flush()
    expect(aliceSaw).toEqual([{ text: 'reply' }])

    // Both frames on the new segment's topic, and nothing at all on the one Carol kept.
    const landed = await hub.fetchTopic({ subscriberDID: 'bob', topicID: chatTopic(2) })
    expect(landed.messages).toHaveLength(2)
    const abandoned = await hub.fetchTopic({ subscriberDID: 'bob', topicID: chatTopic(1) })
    expect(abandoned.messages).toHaveLength(0)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  /**
   * An Add is the same hole from the other side, and it fails harder: the anchor secret is the
   * anchor epoch's exported secret and MLS ratchets forward, so an author sitting at an anchor
   * below the epoch it added someone at is on a topic the new member's handle cannot derive even
   * in principle.
   */
  test('an Add this peer authors lands it on the anchor every applying member reaches', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x92)
    const aliceSaw: Array<unknown> = []
    const bobSaw: Array<unknown> = []

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
      epoch: 1,
      members: MEMBERS,
      handlers: { 'chat/posted': (ctx: { data: unknown }) => void aliceSaw.push(ctx.data) },
    })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
      epoch: 1,
      members: MEMBERS,
      handlers: { 'chat/posted': (ctx: { data: unknown }) => void bobSaw.push(ctx.data) },
    })
    await flush()

    await alice.peer.commit(buildInviteCommit(alice, 'dave'))
    await flush()

    expect(alice.welcomes).toEqual(['dave'])
    expect(alice.mls.leaves()).toContain('dave')
    expect(bob.mls.leaves()).toContain('dave')

    // Dave's add epoch: the epoch he starts at, and so the only one all three of them can derive.
    expect(bob.peer.anchorEpoch()).toBe(2)
    expect(alice.peer.anchorEpoch()).toBe(2)
    expect(alice.anchorStore.stored()?.epoch).toBe(2)

    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'after' })
    await flush()
    expect(bobSaw).toEqual([{ text: 'after' }])

    await bob.peer.protocol('chat').dispatch('chat/posted', { text: 'reply' })
    await flush()
    expect(aliceSaw).toEqual([{ text: 'reply' }])

    const landed = await hub.fetchTopic({ subscriberDID: 'bob', topicID: chatTopic(2) })
    expect(landed.messages).toHaveLength(2)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })
})

describe('a peer that adopts a journalled roster change reads its backlog and rotates', () => {
  /**
   * The restart half of the same advance, and it carries both halves of the invariant. Bob comes
   * back holding a commit whose fate he never learned; adopting it is what ratchets him past the
   * epoch his backlog is sealed at, and past the roster change that moves the group's topic.
   *
   * A peer that adopted first would mark the whole backlog at that epoch dead — its own drain
   * reads the segment afterwards, from a handle that can no longer open a frame of it — and
   * persist a position past every one of them.
   */
  test('the adopt reads the epoch it leaves and takes the anchor the roster change moved', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x93)
    const seen: Array<unknown> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }

    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, members: MEMBERS, handlers })
    await flush()

    // The hub takes Bob's eviction of Carol and the process dies before he adopts it. The slot
    // carries the sequenceID it landed as, so the restart adopts straight out of it.
    const build = buildRemoveCommit(bob, 'carol')
    await expect(
      bob.peer.commit(async () => ({
        ...(await build()),
        onAccepted: async () => {
          throw new Error('the process died here')
        },
      })),
    ).rejects.toThrow('the process died here')
    expect(bob.mls.epoch()).toBe(1) // it never adopted
    expect(bob.peer.anchorEpoch()).toBe(1)
    expect(bob.journal.slot()?.acceptedAs).toBeDefined()

    await bob.peer.dispose()
    hub.detach('bob')

    // Alice talks to the group at the epoch Bob's handle is stuck at, on the segment he is still
    // anchored to. Nothing pushes it at him — he is gone — so the drain is the only thing that can
    // ever deliver it, and it has exactly one chance: before the adopt below.
    const alice = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    await hub.publish({
      senderDID: 'alice',
      topicID: chatTopic(1),
      retain: 'log',
      payload: await alice.wrap(encodeEventFrame('chat/posted', { text: 'while he was gone' })),
    })

    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob, handlers })
    hub.reattach('bob')
    await flush()

    // He adopted: the eviction is real and his handle is past the epoch the frame above is sealed
    // at. He read it on the way through all the same.
    expect(restarted.mls.epoch()).toBe(2)
    expect(restarted.mls.leaves()).not.toContain('carol')
    expect(seen).toEqual([{ text: 'while he was gone' }])
    // And he took the anchor the roster change moved — the same one every member applying his
    // commit from the log reaches.
    expect(restarted.peer.anchorEpoch()).toBe(2)
    expect(restarted.journal.slot()).toBeNull()

    await restarted.peer.dispose()
  })
})

describe('an ephemeral dispatch lands on the segment that contains its seal epoch', () => {
  /**
   * The same window as the logged dispatch below, and the same requirement: a frame is opened at
   * the epoch it was sealed at, so it must be published to the topic that epoch's segment is
   * anchored to. The retention class changes what a mismatch COSTS — a mailbox frame is dropped
   * rather than retained, so it is a lost event or an RPC that times out and never a segment left
   * holding bytes nobody can open — and changes nothing about what is correct.
   *
   * Asserted on the PUBLISH and not on a delivery, because a mailbox frame reaches only the
   * members subscribed at publish time: mid-rotation that is a set the test would be racing to
   * arrange, and the frame landing on the segment that contains its seal epoch is true whether or
   * not anyone was there to hear it.
   */
  test('an ephemeral dispatch racing a rotation is published to the segment it is sealed under', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x95)

    let raceTheRotation: (() => Promise<void>) | null = null
    const written = createMemoryAnchorStore()
    const anchorStore: MemoryAnchorStore = {
      ...written,
      save: async (next) => {
        await written.save(next)
        const race = raceTheRotation
        raceTheRotation = null
        await race?.()
      },
    }

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
      epoch: 1,
      members: MEMBERS,
      anchorStore,
    })
    await flush()

    // The anchor store's write is the window: the anchor and the handle are already at epoch 2 and
    // the lane Alice still holds was built for the segment anchored at 1.
    raceTheRotation = async () => {
      await alice.peer.protocol('chat').dispatch('chat/changed', { text: 'mid-rotation' })
    }
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 1, removes: ['carol'] })
    await flush()

    expect(alice.peer.anchorEpoch()).toBe(2)
    expect(raceTheRotation).toBeNull() // the race did run

    // One frame on a chat topic, and it is on the segment anchored at 2 — the segment that
    // CONTAINS the epoch it was sealed under. The segment the group just left was published to
    // never.
    const onChat = hub.published.filter(
      (message) => message.topicID === chatTopic(1) || message.topicID === chatTopic(2),
    )
    expect(onChat.map((message) => message.topicID)).toEqual([chatTopic(2)])

    await alice.peer.dispose()
  })
})

describe('a logged dispatch lands on the segment that contains its seal epoch', () => {
  /**
   * The rotation is not a moment: the anchor and the handle move together inside the commit walk,
   * under the commit mutex, and the app lane is rebuilt only once the whole walk returns. A
   * dispatch takes no mutex, so it can run in between — sealing under the epoch the group has just
   * moved to.
   *
   * A frame is opened at the epoch it was sealed at and lives on the topic that epoch's segment is
   * anchored to, so those two halves have to come from one segment. Split them and the frame is
   * readable by nobody, ever: the members on the new topic are not listening on the old one, the
   * members still on the old topic cannot open the new seal, and the publisher's own drain never
   * pulls the segment it left again. Not the laggard, whose seal and topic are at least CONSISTENT
   * and who another laggard can still read.
   *
   * The anchor store's write is the window itself — it is what `captureAnchor` awaits, with the
   * anchor already moved and the lane not yet rebuilt — so dispatching from inside it is the race,
   * run deterministically rather than hoped for.
   */
  test('a dispatch racing a rotation is published where the rotated member can read it', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x94)
    const seen: Array<unknown> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }

    let raceTheRotation: (() => Promise<void>) | null = null
    const written = createMemoryAnchorStore()
    const anchorStore: MemoryAnchorStore = {
      ...written,
      save: async (next) => {
        await written.save(next)
        const race = raceTheRotation
        raceTheRotation = null
        await race?.()
      },
    }

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
      epoch: 1,
      members: MEMBERS,
      anchorStore,
    })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, members: MEMBERS, handlers })
    await flush()

    // Bob's process dies, so his own rotation is a cold walk of the log afterwards and nothing
    // about this turns on the order two live peers happen to run in.
    await bob.peer.dispose()
    hub.detach('bob')

    // Alice dispatches from inside her own rotation: her handle and her anchor are at epoch 2, and
    // the lane she still holds was built for the segment anchored at 1.
    raceTheRotation = async () => {
      await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'mid-rotation' })
    }
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 1, removes: ['carol'] })
    await flush()

    expect(alice.peer.anchorEpoch()).toBe(2)
    expect(raceTheRotation).toBeNull() // the race did run

    // The frame is sealed at epoch 2 and it is on the segment anchored at 2 — the segment that
    // CONTAINS epoch 2. The segment the group just left holds nothing.
    const landed = await hub.fetchTopic({ subscriberDID: 'alice', topicID: chatTopic(2) })
    expect(landed.messages).toHaveLength(1)
    const abandoned = await hub.fetchTopic({ subscriberDID: 'alice', topicID: chatTopic(1) })
    expect(abandoned.messages).toHaveLength(0)

    // And a member reads it: Bob comes back cold at epoch 1, applies the same Remove, rotates onto
    // the same segment and drains it. Landing anywhere else is a frame nobody ever opens.
    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob, handlers })
    hub.reattach('bob')
    await flush()

    expect(restarted.mls.epoch()).toBe(2)
    expect(restarted.peer.anchorEpoch()).toBe(2)
    expect(seen).toEqual([{ text: 'mid-rotation' }])

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })
})
