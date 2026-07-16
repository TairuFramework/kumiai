import type { LogHub } from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import { createGroupPeer } from '../src/peer.js'
import { defineGroupProtocol } from '../src/protocol.js'
import { protocolTopic } from '../src/topic.js'
import { createMemoryAnchorStore } from './fixtures/anchor.js'
import { publishCommit } from './fixtures/commits.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryCommitJournal } from './fixtures/journal.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { adoptJournalledBlob } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 50))

/**
 * A removed member keeps the recovery secret for life and every topic ID it ever derived — the
 * group cannot take any of that back, and never tries to. It is the PER-EPOCH secret it cannot
 * follow: the rotation the removal forces re-derives the app topic from the secret exported at
 * the post-removal epoch, an epoch the removed member's handle can never reach. That is the whole
 * of what cuts it off, and it is load-bearing in one exact place — the anchor must be sealed from
 * `exportSecret()`. An anchor sealed from the recovery secret would rotate onto a topic the
 * removed member derives from what it still holds plus an epoch NUMBER, and epoch numbers are
 * counters: it would walk straight back on.
 *
 * So the topic ID is the assertion, not the delivery. The removed member's own peer is silent
 * either way — it is stranded at its last epoch and derives its own topic whatever the anchor is
 * sealed from — and silence proves nothing about what it could reach if it tried. What proves it
 * is that NOTHING she holds names the topic the group moved to.
 *
 * The group's topic is read from a member's own anchor store rather than recomputed here, so the
 * comparison follows the lane to wherever it actually sealed the anchor from.
 */
const room = defineGroupProtocol({
  'room/posted': { type: 'event', retain: 'log', data: { type: 'object' } },
})

type Protocols = { room: typeof room }

const MEMBERS = ['alice', 'bob', 'carol']

function makeRoomPeer(
  hub: LogHub,
  localDID: string,
  recoverySecret: Uint8Array,
  handlers: Record<string, unknown>,
) {
  const crypto = createFakeCrypto({ epoch: 1, localDID })
  const mls = createMemoryGroupMLS({
    recoverySecret,
    epoch: 1,
    localDID,
    members: MEMBERS,
    onAdvance: (e) => crypto.setEpoch(e),
  })
  const anchorStore = createMemoryAnchorStore()
  const peer = createGroupPeer<Protocols>({
    hub,
    crypto,
    mls,
    journal: createMemoryCommitJournal(),
    anchorStore,
    adoptJournalled: async (blob) => {
      adoptJournalledBlob(mls, blob)
    },
    localDID,
    protocols: { room },
    handlers: { room: handlers } as never,
  })
  return { peer, crypto, mls, anchorStore }
}

describe('a member removed at the rotation cannot reach the topic the group rotates onto', () => {
  test('nothing the removed member still holds derives the new topic, and nothing reaches her', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x71)
    const aliceSaw: Array<unknown> = []
    const bobSaw: Array<unknown> = []
    const carolSaw: Array<unknown> = []

    const alice = makeRoomPeer(hub, 'alice', recoverySecret, {
      'room/posted': (ctx: { data: unknown }) => void aliceSaw.push(ctx.data),
    })
    const bob = makeRoomPeer(hub, 'bob', recoverySecret, {
      'room/posted': (ctx: { data: unknown }) => void bobSaw.push(ctx.data),
    })
    const carol = makeRoomPeer(hub, 'carol', recoverySecret, {
      'room/posted': (ctx: { data: unknown }) => void carolSaw.push(ctx.data),
    })
    await flush()

    // Carol is a member, and her handlers are really wired: she hears the group before she is
    // removed. Without this her silence afterwards would be indistinguishable from a peer that
    // was never listening at all.
    await alice.peer.protocol('room').dispatch('room/posted', { said: 'while carol is here' })
    await flush()
    expect(carolSaw).toEqual([{ said: 'while carol is here' }])

    // What Carol keeps, and keeps forever: the epoch-independent recovery secret, the per-epoch
    // secret of the last epoch her handle holds, and the topic she was on.
    const carolRecoverySecret = await carol.mls.exportRecoverySecret()
    const carolEpochSecret = await carol.crypto.exportSecret()
    const carolTopic = protocolTopic(carolEpochSecret, carol.peer.anchorEpoch(), 'room')

    // The eviction. An admin off-stage commits it; every member that can apply it rotates.
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
    expect(alice.peer.anchorEpoch()).toBe(2)
    expect(bob.peer.anchorEpoch()).toBe(2)
    // Carol's handle never advanced: the commit that removes a member excludes it from its own
    // path, so there is nothing in it for her to derive epoch 2 from. She is left at 1, holding
    // her stale view of a group that has moved.
    expect(carol.mls.epoch()).toBe(1)
    expect(carol.peer.anchorEpoch()).toBe(1)

    // The group's topic, taken from the anchor the lane actually sealed — whatever it sealed it
    // from. The rotation moved it off the one Carol is on.
    const anchor = alice.anchorStore.stored()
    if (anchor == null) throw new Error('alice anchored nothing')
    const groupTopic = protocolTopic(anchor.secret, anchor.epoch, 'room')
    expect(groupTopic).not.toBe(carolTopic)
    expect(bob.anchorStore.stored()?.secret).toEqual(anchor.secret)

    await alice.peer.protocol('room').dispatch('room/posted', { said: 'after the eviction' })
    await flush()
    await bob.peer.protocol('room').dispatch('room/posted', { said: 'and again' })
    await flush()

    // The two remaining members go on hearing each other, in plaintext, across the rotation.
    expect(bobSaw).toEqual([{ said: 'while carol is here' }, { said: 'after the eviction' }])
    expect(aliceSaw).toEqual([{ said: 'and again' }])
    // Carol heard neither. Her handlers are the same ones that took the first event.
    expect(carolSaw).toEqual([{ said: 'while carol is here' }])

    // THE ASSERTION. Every secret Carol still holds, against every epoch number she can name —
    // and they are counters, so she can name all of them, including the one the group is at.
    // None of it is the topic the group moved to.
    const held = [
      ['the recovery secret, hers for life', carolRecoverySecret],
      ['the per-epoch secret of the last epoch she holds', carolEpochSecret],
    ] as const
    for (const [what, secret] of held) {
      for (let epoch = 0; epoch <= 6; epoch++) {
        expect(
          protocolTopic(secret, epoch, 'room'),
          `carol derives the group's topic from ${what}, at epoch ${epoch}`,
        ).not.toBe(groupTopic)
      }
    }

    // And the topic is where the frames are, so it is not an unused derivation being compared:
    // both post-eviction events are on it, retained and readable by a member.
    const landed = await hub.fetchTopic({ subscriberDID: 'bob', topicID: groupTopic })
    expect(landed.messages).toHaveLength(2)
    // Carol's own topic never received them. She is subscribed to it, listening, and it holds
    // only the event from when she was a member.
    const hers = await hub.fetchTopic({ subscriberDID: 'carol', topicID: carolTopic })
    expect(hers.messages).toHaveLength(1)
    // She is not a subscriber of the group's topic either, and could not have become one: she
    // has no way to name it.
    expect(hub.subscriberCount(groupTopic)).toBe(2)

    await alice.peer.dispose()
    await bob.peer.dispose()
    await carol.peer.dispose()
  })
})
