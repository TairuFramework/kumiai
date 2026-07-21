import type { LogHub } from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import { createGroupPeer } from '../src/peer.js'
import { defineGroupProtocol } from '../src/protocol.js'
import { APP_TOPIC_LABEL, commitTopic, protocolTopic } from '../src/topic.js'
import { createMemoryAnchorStore } from './fixtures/anchor.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { publishCommit } from './fixtures/commits.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryCommitJournal } from './fixtures/journal.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { adoptJournalledBlob } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 50))

/**
 * The app topic is derived from the ANCHOR, not the live epoch: it is stable within a
 * roster-change-bounded segment, and every roster change — an Add as much as a Remove — rotates
 * it. Epochs advance for reasons that have nothing to do with who can read the group — an update,
 * a no-op, a ledger enact — and a topic that rotated on each of them would move the group's
 * messages off a topic no member asked to leave, for nothing.
 *
 * The anchor sits at the last roster change because that is the only epoch that satisfies both
 * constraints at once. A Remove must move it: the evicted member keeps every topic ID it ever
 * derived, so the group has to stop using them. An Add must move it too: the anchor secret is the
 * anchor epoch's exported secret and MLS ratchets forward, so a member added at epoch E cannot
 * export the secret of anything earlier — an anchor left behind is one the newest member could
 * never derive, and it would be silently partitioned onto a topic of its own.
 *
 * These assert the topic IDENTITY as well as the delivery. A peer that rotated on every commit
 * still delivers — both members rebuild together and land on the same new topic — so delivery
 * alone cannot tell the two designs apart. The topic ID is what can.
 *
 * The anchor's two halves come from ONE epoch — the secret exported at it and its number — so
 * `roomTopic(anchorEpoch)` below names the topic the frames must actually land on, and
 * `fetchTopic` on that ID is what ties the assertion to the wire. Pairing one epoch's secret with
 * another epoch's number derives a topic no member is on, which is why neither half is read from
 * a live handle that has run past the anchor.
 */
const room = defineGroupProtocol({
  'room/posted': { type: 'event', retain: 'log', data: { type: 'object' } },
})

type Protocols = { room: typeof room }

const MEMBERS = ['alice', 'bob', 'carol']

/** The room topic of the segment anchored at `epoch`: that epoch's secret, under that epoch. */
const roomTopic = (epoch: number): string =>
  protocolTopic(fakeEpochSecret(epoch, APP_TOPIC_LABEL), epoch, 'room')

/** A member of the group at `epoch`, wired with an MLS port so commits can drive its epoch. */
function makeRoomPeer(
  hub: LogHub,
  localDID: string,
  recoverySecret: Uint8Array,
  handlers: Record<string, unknown>,
  options: {
    epoch?: number
    members?: Array<string>
    recovery?: { timeoutMs?: number; getDelayMs?: () => number; deadlineMs?: number }
  } = {},
) {
  const epoch = options.epoch ?? 1
  const crypto = createFakeCrypto({ epoch, localDID })
  const mls = createMemoryGroupMLS({
    recoverySecret,
    epoch,
    localDID,
    members: options.members ?? MEMBERS,
    onAdvance: (e) => crypto.setEpoch(e),
  })
  const journal = createMemoryCommitJournal()
  const anchorStore = createMemoryAnchorStore()
  const appCursorStore = createMemoryAppCursorStore()
  const peer = createGroupPeer<Protocols>({
    hub,
    crypto,
    mls,
    journal,
    anchorStore,
    appCursorStore,
    adoptJournalled: async (blob) => {
      adoptJournalledBlob(mls, blob)
    },
    localDID,
    protocols: { room },
    handlers: { room: handlers } as never,
    ...(options.recovery != null ? { recovery: options.recovery } : {}),
  })
  return { peer, crypto, mls, anchorStore, appCursorStore }
}

describe('the app topic is stable within a roster-change-bounded segment', () => {
  test('epochs advancing without a roster change leave the app topic put, and delivery continues', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x51)
    const bobSaw: Array<unknown> = []
    const aliceSaw: Array<unknown> = []

    const alice = makeRoomPeer(hub, 'alice', recoverySecret, {
      'room/posted': (ctx: { data: unknown }) => void aliceSaw.push(ctx.data),
    })
    const bob = makeRoomPeer(hub, 'bob', recoverySecret, {
      'room/posted': (ctx: { data: unknown }) => void bobSaw.push(ctx.data),
    })
    await flush()

    const genesisTopic = roomTopic(1)
    expect(alice.peer.anchorEpoch()).toBe(1)
    expect(roomTopic(alice.peer.anchorEpoch())).toBe(genesisTopic)

    await alice.peer.protocol('room').dispatch('room/posted', { n: 1 })
    await flush()
    expect(bobSaw).toEqual([{ n: 1 }])

    // An update / no-op commit: the epoch advances, the roster does not move.
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 1 })
    await flush()
    expect(alice.mls.epoch()).toBe(2)
    expect(bob.mls.epoch()).toBe(2)

    await bob.peer.protocol('room').dispatch('room/posted', { n: 2 })
    await flush()
    expect(aliceSaw).toEqual([{ n: 2 }])

    // A ledger-only commit: it enacts an entry and touches no leaf.
    await publishCommit({
      hub,
      senderDID: 'admin',
      recoverySecret,
      epoch: 2,
      entries: ['role:dave=member'],
    })
    await flush()
    expect(alice.mls.epoch()).toBe(3)
    expect(bob.mls.epoch()).toBe(3)

    await alice.peer.protocol('room').dispatch('room/posted', { n: 3 })
    await flush()
    expect(bobSaw).toEqual([{ n: 1 }, { n: 3 }])

    // Two epochs passed under both members, neither touching the roster — so the anchor never
    // moved, and the topic every frame above was published to is still the genesis one.
    expect(alice.peer.anchorEpoch()).toBe(1)
    expect(bob.peer.anchorEpoch()).toBe(1)
    expect(roomTopic(alice.peer.anchorEpoch())).toBe(genesisTopic)

    // Tie it to the wire, not just to the derivation: all three logged frames are on the ONE
    // topic. A per-epoch derivation would have scattered them across three.
    const drained = await hub.fetchTopic({ subscriberDID: 'bob', topicID: genesisTopic })
    expect(drained.messages).toHaveLength(3)
    // The per-epoch topics the group would otherwise have moved onto were never even reached
    // for: nobody subscribed to them, so there is nothing on them to fetch.
    for (const staleEpoch of [2, 3]) {
      expect(hub.subscriberCount(roomTopic(staleEpoch))).toBe(0)
    }

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('a Remove rotates the app topic onto a new ID, and delivery continues across it', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x52)
    const bobSaw: Array<unknown> = []
    const aliceSaw: Array<unknown> = []

    const alice = makeRoomPeer(hub, 'alice', recoverySecret, {
      'room/posted': (ctx: { data: unknown }) => void aliceSaw.push(ctx.data),
    })
    const bob = makeRoomPeer(hub, 'bob', recoverySecret, {
      'room/posted': (ctx: { data: unknown }) => void bobSaw.push(ctx.data),
    })
    await flush()

    const beforeTopic = roomTopic(alice.peer.anchorEpoch())

    await alice.peer.protocol('room').dispatch('room/posted', { n: 'before' })
    await flush()
    expect(bobSaw).toEqual([{ n: 'before' }])

    // Carol is evicted. She keeps every topic ID she derived, so the group must leave them.
    await publishCommit({
      hub,
      senderDID: 'admin',
      recoverySecret,
      epoch: 1,
      removes: ['carol'],
    })
    await flush()

    expect(alice.mls.leaves()).not.toContain('carol')
    expect(bob.mls.leaves()).not.toContain('carol')
    // Both members rotated their anchor onto the post-commit epoch, independently and alike —
    // they must agree, or they would rotate onto different topics and stop hearing each other.
    expect(alice.peer.anchorEpoch()).toBe(2)
    expect(bob.peer.anchorEpoch()).toBe(2)

    const afterTopic = roomTopic(alice.peer.anchorEpoch())
    expect(afterTopic).not.toBe(beforeTopic)

    // Delivery continues across the rotation, both ways.
    await alice.peer.protocol('room').dispatch('room/posted', { n: 'after' })
    await flush()
    expect(bobSaw).toEqual([{ n: 'before' }, { n: 'after' }])

    await bob.peer.protocol('room').dispatch('room/posted', { n: 'reply' })
    await flush()
    expect(aliceSaw).toEqual([{ n: 'reply' }])

    // On the NEW topic, and nothing more landed on the old one: the post-Remove frames are
    // exactly the two sent after it, and the pre-Remove topic still holds only the one.
    const after = await hub.fetchTopic({ subscriberDID: 'bob', topicID: afterTopic })
    expect(after.messages).toHaveLength(2)
    const before = await hub.fetchTopic({ subscriberDID: 'bob', topicID: beforeTopic })
    expect(before.messages).toHaveLength(1)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('an add-only commit rotates the app topic too, and delivery continues across it', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x53)
    const bobSaw: Array<unknown> = []
    const aliceSaw: Array<unknown> = []

    const alice = makeRoomPeer(hub, 'alice', recoverySecret, {
      'room/posted': (ctx: { data: unknown }) => void aliceSaw.push(ctx.data),
    })
    const bob = makeRoomPeer(hub, 'bob', recoverySecret, {
      'room/posted': (ctx: { data: unknown }) => void bobSaw.push(ctx.data),
    })
    await flush()

    const beforeTopic = roomTopic(alice.peer.anchorEpoch())

    await alice.peer.protocol('room').dispatch('room/posted', { n: 'before' })
    await flush()
    expect(bobSaw).toEqual([{ n: 'before' }])

    // Nobody leaves — Dave arrives. The group loses no reader here, and it still has to move: the
    // topic it is on is derived from a secret Dave's handle can never export.
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 1, adds: ['dave'] })
    await flush()

    expect(alice.mls.leaves()).toContain('dave')
    expect(bob.mls.leaves()).toContain('dave')
    expect(alice.mls.leaves()).toContain('carol') // and nothing was dropped
    // Both rotated onto Dave's add epoch — the epoch he starts at, so the only one all three can
    // derive — and they got there from the commit alone, without asking each other.
    expect(alice.peer.anchorEpoch()).toBe(2)
    expect(bob.peer.anchorEpoch()).toBe(2)

    const afterTopic = roomTopic(alice.peer.anchorEpoch())
    expect(afterTopic).not.toBe(beforeTopic)

    await alice.peer.protocol('room').dispatch('room/posted', { n: 'after' })
    await flush()
    expect(bobSaw).toEqual([{ n: 'before' }, { n: 'after' }])

    await bob.peer.protocol('room').dispatch('room/posted', { n: 'reply' })
    await flush()
    expect(aliceSaw).toEqual([{ n: 'reply' }])

    const after = await hub.fetchTopic({ subscriberDID: 'bob', topicID: afterTopic })
    expect(after.messages).toHaveLength(2)
    const before = await hub.fetchTopic({ subscriberDID: 'bob', topicID: beforeTopic })
    expect(before.messages).toHaveLength(1)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })
})

describe('every member agrees on the anchor, including one that boots after it', () => {
  /**
   * The decisive case, and the one a per-peer live-epoch seed gets wrong. Alice is at the group's
   * genesis; the group then advances twice without touching the roster, so her anchor stays at 1
   * while her live epoch runs to 3. Dave is added at epoch 3 and his peer boots over a handle
   * already at 4 — a live epoch a whole segment ahead of where Alice booted.
   *
   * Neither of them can reach the other's starting point: Alice cannot know Dave's boot epoch, and
   * Dave's handle can export no secret from before his add. The add is the one thing they both
   * see, and it is what puts them on the same topic — Alice rotates to it, Dave seeds at it.
   */
  test('a member booting at a later epoch than the anchor derives the same topic and exchanges events', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x54)
    const aliceSaw: Array<unknown> = []
    const daveSaw: Array<unknown> = []

    const alice = makeRoomPeer(
      hub,
      'alice',
      recoverySecret,
      { 'room/posted': (ctx: { data: unknown }) => void aliceSaw.push(ctx.data) },
      { members: ['alice', 'bob'] },
    )
    await flush()

    expect(alice.peer.anchorEpoch()).toBe(1)

    // Advance the group twice without touching the roster: an update and a ledger enact. Alice's
    // live epoch runs ahead; her anchor does not follow it.
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 1 })
    await flush()
    await publishCommit({
      hub,
      senderDID: 'admin',
      recoverySecret,
      epoch: 2,
      entries: ['role:bob=member'],
    })
    await flush()

    expect(alice.mls.epoch()).toBe(3)
    expect(alice.peer.anchorEpoch()).toBe(1) // a whole segment behind her live epoch

    // Dave is added at epoch 3. Every existing member rotates to it on applying the add.
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 3, adds: ['dave'] })
    await flush()

    expect(alice.mls.epoch()).toBe(4)
    expect(alice.mls.leaves()).toContain('dave')
    // She rotated forward THREE epochs in one step — 1 to 4 — skipping the two her live epoch had
    // already walked through. The anchor tracks roster changes, not distance travelled.
    expect(alice.peer.anchorEpoch()).toBe(4)

    // Dave's peer boots over the handle his Welcome gave him: already at epoch 4, the epoch the
    // add advanced the group to, and two epochs past where Alice's peer booted. He seeds his
    // anchor from that handle and never sees the add commit as a frame he can apply — it is
    // framed at 3, and he is at 4.
    const dave = makeRoomPeer(
      hub,
      'dave',
      recoverySecret,
      { 'room/posted': (ctx: { data: unknown }) => void daveSaw.push(ctx.data) },
      { epoch: 4, members: ['alice', 'bob', 'dave'] },
    )
    await flush()

    // The agreement, and neither of them did anything to reach it: Dave seeded at the only epoch
    // his handle has ever held, and Alice was carried to that same epoch by the add itself.
    expect(dave.peer.anchorEpoch()).toBe(4)
    expect(alice.peer.anchorEpoch()).toBe(4)

    const aliceTopic = roomTopic(alice.peer.anchorEpoch())
    const daveTopic = roomTopic(dave.peer.anchorEpoch())
    expect(daveTopic).toBe(aliceTopic)

    // And the wire agrees with the derivation, in both directions.
    await alice.peer.protocol('room').dispatch('room/posted', { n: 'to-dave' })
    await flush()
    expect(daveSaw).toEqual([{ n: 'to-dave' }])

    await dave.peer.protocol('room').dispatch('room/posted', { n: 'from-dave' })
    await flush()
    expect(aliceSaw).toEqual([{ n: 'from-dave' }])

    // Both frames landed on the one topic, and that topic is the one Dave's own peer subscribed
    // to — reading it back as Dave is what makes the agreement a fact about the wire.
    const landed = await hub.fetchTopic({ subscriberDID: 'dave', topicID: aliceTopic })
    expect(landed.messages).toHaveLength(2)

    await alice.peer.dispose()
    await dave.peer.dispose()
  })
})

describe('a rejoining member and the group agree on one app topic', () => {
  /**
   * The case no diff can reach. Eve is stranded on a stale epoch and rejoins by external commit —
   * and she is a member the roster never stopped holding, so her rejoin changes no DID and no
   * occupied leaf index (the resync blanks her old leaf, and her new one takes the leftmost blank:
   * the leaf it just blanked). There is nothing to diff. The rotation rides the applied commit's
   * own external flag, and Eve — who can never apply her own commit — sets her anchor from the
   * handle her rejoin derived.
   *
   * The group's anchor is DRIFTED behind its live epoch first, with commits that touch no leaf. It
   * is the whole point: if the anchor already sat at the epoch the rejoin lands on, agreement would
   * be an accident of arithmetic and would hold with no rotation at all.
   */
  test('a rejoin rotates the anchor: the group and the rejoiner land on the same post-commit epoch', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x55)
    const aliceSaw: Array<unknown> = []
    const eveSaw: Array<unknown> = []
    const members = ['alice', 'eve']

    const alice = makeRoomPeer(
      hub,
      'alice',
      recoverySecret,
      { 'room/posted': (ctx: { data: unknown }) => void aliceSaw.push(ctx.data) },
      { members, recovery: { getDelayMs: () => 5 } },
    )
    await flush()

    const anchoredTopic = roomTopic(1)
    expect(alice.peer.anchorEpoch()).toBe(1)

    // Drift: two commits that touch no leaf. Alice's live epoch runs to 3; her anchor stays at 1,
    // so the epoch a rejoin will land on is one nothing has taken the group to.
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 1 })
    await flush()
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 2 })
    await flush()
    expect(alice.mls.epoch()).toBe(3)
    expect(alice.peer.anchorEpoch()).toBe(1) // two epochs behind her live one

    // The hub sweeps the log past its retention — the head outlives the frames it named. This is
    // what strands Eve: she was offline while the group moved, and the backlog that would have
    // carried her is gone. Her handle is still at 1, and no pull can ever fix that.
    hub.trim(commitTopic(recoverySecret), '999999999999')

    const eve = makeRoomPeer(
      hub,
      'eve',
      recoverySecret,
      { 'room/posted': (ctx: { data: unknown }) => void eveSaw.push(ctx.data) },
      { epoch: 1, members },
    )
    await flush()

    // Eve is silently partitioned: two epochs below the group, anchored where she booted, and on
    // the same topic as Alice only because Alice has not moved either.
    expect(eve.mls.epoch()).toBe(1)
    expect(eve.peer.anchorEpoch()).toBe(1)
    expect(alice.mls.leaves()).toContain('eve') // the roster never stopped holding her

    const rejoined = await eve.peer.recover()
    await flush()
    expect(rejoined.advanced).toBe(true)

    // The rejoin was framed at 3 — the epoch Alice's GroupInfo described — so applying it carries
    // her to 4, and Eve's rejoined handle starts there too. The anchor is the POST-commit epoch,
    // not the epoch the commit is framed at.
    expect(alice.mls.epoch()).toBe(4)
    expect(eve.mls.epoch()).toBe(4)
    // Nothing about the roster moved across it, which is why no diff could have done this: one
    // leaf for Eve before, one leaf for Eve after, and the same DIDs either way.
    expect(alice.mls.leaves().filter((did) => did === 'eve')).toHaveLength(1)

    // The agreement. Alice rotated by applying Eve's external commit; Eve set hers from the handle
    // that commit derived — the only way she can, since she never applies her own commit. Both
    // left the anchor they shared at 1, and landed on the same one.
    expect(alice.peer.anchorEpoch()).toBe(4)
    expect(eve.peer.anchorEpoch()).toBe(4)

    const aliceTopic = roomTopic(alice.peer.anchorEpoch())
    const eveTopic = roomTopic(eve.peer.anchorEpoch())
    expect(eveTopic).toBe(aliceTopic)
    expect(aliceTopic).not.toBe(anchoredTopic) // and it is not where either of them started

    // And the wire agrees with the derivation, both ways.
    await alice.peer.protocol('room').dispatch('room/posted', { n: 'to-eve' })
    await flush()
    expect(eveSaw).toEqual([{ n: 'to-eve' }])

    await eve.peer.protocol('room').dispatch('room/posted', { n: 'from-eve' })
    await flush()
    expect(aliceSaw).toEqual([{ n: 'from-eve' }])

    // Both logged frames landed on the one topic, read back as Eve — the member whose agreement is
    // in question — and the topic the group would have stayed on holds neither.
    const landed = await hub.fetchTopic({ subscriberDID: 'eve', topicID: aliceTopic })
    expect(landed.messages).toHaveLength(2)
    const abandoned = await hub.fetchTopic({ subscriberDID: 'eve', topicID: anchoredTopic })
    expect(abandoned.messages).toHaveLength(0)

    await alice.peer.dispose()
    await eve.peer.dispose()
  })
})
