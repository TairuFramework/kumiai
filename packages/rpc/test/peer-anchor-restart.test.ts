import type { LogHub } from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import { createGroupPeer } from '../src/peer.js'
import { defineGroupProtocol } from '../src/protocol.js'
import { protocolTopic } from '../src/topic.js'
import { createMemoryAnchorStore, type MemoryAnchorStore } from './fixtures/anchor.js'
import { publishCommit } from './fixtures/commits.js'
import { createFakeCrypto, type FakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryCommitJournal } from './fixtures/journal.js'
import { createMemoryGroupMLS, type MemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { adoptJournalledBlob, makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 50))

/**
 * The app-lane anchor is PERSISTED STATE, and it has to be: it sits at the last roster change,
 * the live handle runs on past it, and MLS ratchets forward — a rebooted handle can never
 * re-export the secret of the epoch the anchor sits at. There is nothing to recompute it from.
 *
 * A peer that seeded the anchor from its live handle at every construction would be correct at
 * genesis and wrong ever after: the first restart over a handle the group has carried past the
 * anchor would derive its own topic IDs, invisible to every member that stayed up and blind to
 * them. Nothing errors. Both halves keep publishing, into different topics, forever.
 *
 * So the drift here is the whole subject. The group must be moved PAST the anchor by commits
 * that do not touch the roster before the restart — with the anchor and the live epoch equal, a
 * peer that re-seeded and a peer that restored are indistinguishable and this proves nothing.
 *
 * The fake crypto's `exportSecret()` is epoch-independent, so the app topic varies with the
 * anchor EPOCH alone: `protocolTopic(secret, anchorEpoch, 'room')` is the topic frames actually
 * land on, and `fetchTopic` on that ID ties the assertion to the wire.
 */
const room = defineGroupProtocol({
  'room/posted': { type: 'event', retain: 'log', data: { type: 'object' } },
})

type Protocols = { room: typeof room }

const MEMBERS = ['alice', 'bob']

type RoomPeerOptions = {
  /** Reuse an existing handle — a restart is a new peer over the durable state of the old one. */
  mls?: MemoryGroupMLS
  crypto?: FakeCrypto
  /** Reuse an existing anchor store. It must OUTLIVE the peer: that is what durability means. */
  anchorStore?: MemoryAnchorStore
}

function makeRoomPeer(
  hub: LogHub,
  localDID: string,
  recoverySecret: Uint8Array,
  handlers: Record<string, unknown>,
  options: RoomPeerOptions = {},
) {
  const crypto = options.crypto ?? createFakeCrypto({ epoch: 1, localDID })
  const mls =
    options.mls ??
    createMemoryGroupMLS({
      recoverySecret,
      epoch: 1,
      localDID,
      members: MEMBERS,
      onAdvance: (e) => crypto.setEpoch(e),
    })
  const anchorStore = options.anchorStore ?? createMemoryAnchorStore()
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

describe('the app-lane anchor survives a restart', () => {
  test('a peer restarted over a handle past the anchor restores it and stays on the group topic', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x61)
    const aliceSaw: Array<unknown> = []
    const bobSaw: Array<unknown> = []
    const bobHandlers = { 'room/posted': (ctx: { data: unknown }) => void bobSaw.push(ctx.data) }

    const alice = makeRoomPeer(hub, 'alice', recoverySecret, {
      'room/posted': (ctx: { data: unknown }) => void aliceSaw.push(ctx.data),
    })
    const bob = makeRoomPeer(hub, 'bob', recoverySecret, bobHandlers)
    await flush()

    const secret = await alice.crypto.exportSecret()
    const anchorTopic = protocolTopic(secret, 1, 'room')
    expect(bob.peer.anchorEpoch()).toBe(1)

    // Drift the group PAST the anchor: an update/no-op commit and a ledger-only commit, neither
    // touching the roster. The live epoch reaches 3; the anchor stays at 1, where the group's
    // topic is. Without this the restart below would prove nothing.
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 1 })
    await flush()
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
    expect(bob.peer.anchorEpoch()).toBe(1)

    // Bob's process dies and comes back over the same durable state: the same handle, at epoch 3,
    // and the same anchor store. Alice never restarted — she is the group.
    await bob.peer.dispose()
    const restarted = makeRoomPeer(hub, 'bob', recoverySecret, bobHandlers, {
      mls: bob.mls,
      crypto: bob.crypto,
      anchorStore: bob.anchorStore,
    })
    await flush()

    // The anchor came back from the store, at the epoch it was captured. The handle it booted
    // over is two epochs ahead of it, and could export nothing else: 3 here is a peer that
    // re-seeded from its live handle and partitioned.
    expect(restarted.mls.epoch()).toBe(3)
    expect(restarted.peer.anchorEpoch()).toBe(1)

    // Both ways, on the wire, with a member that never restarted.
    await alice.peer.protocol('room').dispatch('room/posted', { from: 'alice' })
    await flush()
    expect(bobSaw).toEqual([{ from: 'alice' }])

    await restarted.peer.protocol('room').dispatch('room/posted', { from: 'bob' })
    await flush()
    expect(aliceSaw).toEqual([{ from: 'bob' }])

    // Tie it to the topic ID, not only to the delivery: both frames are on the anchor's topic,
    // and the live epoch's topic was never reached for at all.
    const drained = await hub.fetchTopic({ subscriberDID: 'alice', topicID: anchorTopic })
    expect(drained.messages).toHaveLength(2)
    expect(hub.subscriberCount(protocolTopic(secret, 3, 'room'))).toBe(0)

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })

  test('an empty store is first boot: the peer seeds the anchor at its initial epoch and saves it', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x62)

    const alice = makeRoomPeer(hub, 'alice', recoverySecret, {})
    await flush()

    expect(alice.peer.anchorEpoch()).toBe(1)
    const stored = alice.anchorStore.stored()
    expect(stored?.epoch).toBe(1)
    expect(stored?.secret).toEqual(await alice.crypto.exportSecret())
    // Written once, at the seed. Nothing rotated it: the group has had no roster change.
    expect(alice.anchorStore.saves()).toBe(1)

    await alice.peer.dispose()
  })

  test('a roster change rotates the anchor and persists it, and a restart comes back on the new one', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x63)

    const bob = makeRoomPeer(hub, 'bob', recoverySecret, {})
    await flush()
    expect(bob.anchorStore.stored()?.epoch).toBe(1)

    // A Remove: the roster moves, so the anchor rotates to the post-commit epoch — and the store
    // must have it, or the restart below walks back onto the topic the evicted member holds.
    await publishCommit({
      hub,
      senderDID: 'admin',
      recoverySecret,
      epoch: 1,
      removes: ['alice'],
    })
    await flush()
    expect(bob.peer.anchorEpoch()).toBe(2)
    expect(bob.anchorStore.stored()?.epoch).toBe(2)

    // Drift past the rotated anchor, so the restart cannot land on it by accident.
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 2 })
    await flush()
    expect(bob.mls.epoch()).toBe(3)

    await bob.peer.dispose()
    const restarted = makeRoomPeer(
      hub,
      'bob',
      recoverySecret,
      {},
      {
        mls: bob.mls,
        crypto: bob.crypto,
        anchorStore: bob.anchorStore,
      },
    )
    await flush()
    expect(restarted.peer.anchorEpoch()).toBe(2)

    await restarted.peer.dispose()
  })

  /**
   * Every other restart in this suite restarts a peer whose anchor never rotated — and at an
   * unrotated anchor, restoring and re-seeding land on the same epoch and cannot be told apart.
   * So they carry the store forward and prove nothing by it: drop it from any of them and they
   * all still pass.
   *
   * This is the one that does not. It rotates the anchor first, so the store is the only thing
   * that knows where the group is, and it restarts through the shared fixture — `restartOf` is
   * what carries a dead peer's durable state, and this is what says the anchor is part of that.
   */
  test('the fixture restart carries the anchor store: a peer restarted after a rotation comes back on it', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x64)

    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { members: ['bob', 'alice'] })
    await flush()
    expect(bob.peer.anchorEpoch()).toBe(1)

    // A Remove moves the roster, so the anchor rotates to the post-commit epoch — and only the
    // store holds it. Then drift past it, so a re-seeding restart lands somewhere else and says
    // so, rather than landing back on the anchor by luck.
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 1, removes: ['alice'] })
    await flush()
    expect(bob.peer.anchorEpoch()).toBe(2)
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 2 })
    await flush()
    expect(bob.mls.epoch()).toBe(3)

    await bob.peer.dispose()
    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob })
    await flush()

    // 3 here — the live epoch — is a fixture that dropped the store on the way through.
    expect(restarted.peer.anchorEpoch()).toBe(2)

    await restarted.peer.dispose()
  })
})
