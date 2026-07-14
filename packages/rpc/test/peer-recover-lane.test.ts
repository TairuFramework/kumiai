import type {
  HubFetchTopicParams,
  HubPublishParams,
  HubSubscribeOptions,
  LogHub,
} from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import { RecoveryRequiredError } from '../src/commit.js'
import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import {
  createMemoryGroupMLS,
  encodeMemoryCommit,
  type MemoryGroupMLS,
  memoryEntryID,
  memoryLedgerHead,
} from '../src/memory-group-mls.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryCommitJournal } from './fixtures/journal.js'
import { buildLedgerCommit, makeMLSPeer, type TestPeer } from './fixtures/peer.js'

const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms))

/** Fast rendezvous, so a heal that is going to happen happens inside a test. */
const recovery = { timeoutMs: 120, getDelayMs: () => 5, deadlineMs: 600 }

/** A responder seals only to a DID its own tree holds a leaf for. */
const members = ['alice', 'bob', 'carol', 'dave']

/** The external commits in the log, by committer: a rejoin is a commit like any other. */
function rejoins(hub: FakeHub, rs: Uint8Array): Array<unknown> {
  return hub.published.filter((m) => m.topicID === commitTopic(rs))
}

function recoveryRequests(hub: FakeHub, rs: Uint8Array): Array<unknown> {
  const topic = rendezvousTopic(rs)
  return hub.published.filter((m) => {
    if (m.topicID !== topic) return false
    try {
      return decodeHandshakeFrame(m.payload).kind === HANDSHAKE_KIND.recoveryRequest
    } catch {
      return false
    }
  })
}

/** The host's answer to a heal: re-enact whatever came back, with an ordinary commit. It is a
 *  SEPARATE lane operation, queued behind the one that handed the entries over — a host that
 *  could only do this from inside the peer would be committing under the lane's own mutex. */
async function reenactFrom(member: TestPeer, reenact: Array<string>): Promise<void> {
  if (reenact.length > 0) await member.peer.commit(buildLedgerCommit(member, reenact))
}

/**
 * Wake the commit lane without putting anything in the log: a mailbox frame on the commit
 * topic is delivered and never retained, and a delivery is only ever a wakeup — the frames
 * come from the pull. It is how a test says "read your log again" without writing to it.
 */
async function wakeLane(hub: FakeHub, rs: Uint8Array): Promise<void> {
  await hub.publish({
    senderDID: 'zoe',
    topicID: commitTopic(rs),
    payload: new Uint8Array([0]),
  })
  await flush(80)
}

describe('a heal re-enacts by ledger membership', () => {
  test('an entry the group already holds is not re-enacted, and a later admin is not reverted', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x51)

    // A body only Bob holds. The commit that enacts it names it and does not carry it, so Bob
    // applies that frame and Alice — who was never given the body — cannot.
    const gap = 'role:carol=admin'
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, bodies: [gap], recovery })

    // Alice's journal survives her process. It is the only reason her commit is not lost — and
    // it is why, after she comes back, she is holding the very entry the group already has.
    let dying = true
    const journal = createMemoryCommitJournal({
      onMarkAccepted: () => {
        if (!dying) return
        dying = false
        throw new Error('the process died between the hub answering and the durable write')
      },
    })
    const dead = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members, journal, recovery })
    await flush()

    // Admin A commits `circle x -> Foo`. The hub ACCEPTS it — that is what defines this path —
    // and she dies before adopting it.
    await expect(dead.peer.commit(buildLedgerCommit(dead, ['circle:x=Foo']))).rejects.toThrow(
      /the process died/,
    )
    await flush()
    expect(bob.mls.fold().get('circle:x')).toBe('Foo')
    expect(dead.mls.epoch()).toBe(1) // she never adopted it
    await dead.peer.dispose()

    // The group moves on without her. First a commit whose body she cannot resolve — she drops
    // it as poison and stays where she is, while Bob, who holds the body, applies it...
    await publishCommit({
      hub,
      senderDID: 'zoe',
      recoverySecret: rs,
      epoch: 2,
      commit: encodeMemoryCommit(2, 'zoe', [memoryEntryID(gap)], {
        head: memoryLedgerHead([memoryEntryID('circle:x=Foo'), memoryEntryID(gap)]),
      }),
    })
    await flush()
    expect(bob.mls.epoch()).toBe(3)

    // ...and then admin B overwrites the same subject. Everyone applies it. The circle is "Bar".
    await bob.peer.commit(buildLedgerCommit(bob, ['circle:x=Bar']))
    await flush()
    expect(bob.mls.fold().get('circle:x')).toBe('Bar')

    // Alice restarts over the same handle and the same journal. Replay settles her commit — it
    // landed, so she adopts it and now HOLDS the entry — and then the log tells her the group
    // went on without her: she meets a frame framed ahead of her, and heals.
    const alice = makeMLSPeer(hub, 'alice', rs, {
      mls: dead.mls,
      crypto: dead.crypto,
      journal,
      members,
      recovery,
    })
    await flush(500)

    expect(alice.mls.epoch()).toBe(bob.mls.epoch())
    // The host does what a host does with a heal's leftovers: it re-enacts them.
    const { reenact = [] } = await alice.peer.replay()
    await reenactFrom(alice, reenact)
    await flush()

    // B's change STANDS. Re-enacting "Foo" would append it a second time, at the end of the
    // log, where the fold is last-write-wins by position — the ledger would read
    // [Foo, Bar, Foo], the circle would be "Foo" again, and nothing anywhere would have raised
    // an error. Assert the VALUE: the wrong implementation throws nothing.
    expect(bob.mls.fold().get('circle:x')).toBe('Bar')
    expect(alice.mls.fold().get('circle:x')).toBe('Bar')
    // Because the entry is already in the group's authenticated ledger, and the rule is
    // membership, never provenance.
    expect(reenact).toEqual([])
    const fooID = memoryEntryID('circle:x=Foo')
    expect(bob.mls.ledgerIDs().filter((id) => id === fooID)).toHaveLength(1)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('an entry the group does not hold IS re-enacted, and lands in a later commit', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x52)

    // Alice's own commit was accepted on a branch the group discarded — the losing side of a
    // hub that double-accepted. She merged it, so she holds its entry; nobody else does, and
    // the group's authenticated ledger has never carried it.
    const aliceCrypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const aliceMLS: MemoryGroupMLS = createMemoryGroupMLS({
      recoverySecret: rs,
      epoch: 1,
      localDID: 'alice',
      members,
      onAdvance: (e) => aliceCrypto.setEpoch(e),
    })
    aliceMLS.adopt(aliceMLS.buildCommit(['circle:x=Alice']))

    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
    await flush()
    await bob.peer.commit(buildLedgerCommit(bob, ['circle:x=Bob']))
    await flush()

    const alice = makeMLSPeer(hub, 'alice', rs, {
      mls: aliceMLS,
      crypto: aliceCrypto,
      members,
      recovery,
    })
    await flush()

    const { advanced, reenact } = await alice.peer.recover()
    await flush()

    expect(advanced).toBe(true)
    // The entry is not in the group's ledger — it never landed there — so it comes back, and
    // an implementation that re-enacts nothing loses it silently.
    expect(reenact).toEqual(['circle:x=Alice'])
    // The rejoin carried NONE of it: a heal is two commits, and the peer never makes the
    // second one. The host does, with an ordinary commit that contends like any other.
    expect(bob.mls.fold().get('circle:x')).toBe('Bob')

    await reenactFrom(alice, reenact)
    await flush()

    expect(bob.mls.fold().get('circle:x')).toBe('Alice')
    expect(alice.mls.fold().get('circle:x')).toBe('Alice')
    // Bob's entry was not lost, and Alice's was not duplicated.
    expect(bob.mls.ledgerIDs()).toEqual([
      memoryEntryID('circle:x=Bob'),
      memoryEntryID('circle:x=Alice'),
    ])

    await alice.peer.dispose()
    await bob.peer.dispose()
  })
})

describe('a hub that forked the log', () => {
  // The losing branch exists for ONE reason: a hub broke the compare-and-set, accepted two
  // commits at one head, and served divergent logs. A hub that will do that will also serve a
  // peer a frame its cursor has already passed — `after` is a contract, and the party it binds
  // is the one this design does not trust. A peer can only ever learn it lost by being shown
  // the branch it lost to, and the honest hub can never show it: an exclusive cursor means
  // every frame it delivers carries a HIGHER sequenceID than the one the peer applied, and the
  // tiebreak reads the LOWER one as the winner. The whole row is unreachable against a fixture
  // that cannot lie, and reachable exactly as written against the hub the design names.
  const setUpFork = async (
    hub: FakeHub,
    rs: Uint8Array,
  ): Promise<{ winner: string; loser: string; winnerSeq: string; loserSeq: string }> => {
    hub.acceptAtAnyHead()
    const winner = 'role:carol=admin'
    const loser = 'role:bob=admin'
    // Both framed at epoch 1, both compare-and-set at the SAME head. An honest hub takes one
    // and answers the other with a head mismatch; this one takes both.
    const { sequenceID: winnerSeq } = await publishCommit({
      hub,
      senderDID: 'xavier',
      recoverySecret: rs,
      epoch: 1,
      entries: [winner],
      expectedHead: null,
    })
    const { sequenceID: loserSeq } = await publishCommit({
      hub,
      senderDID: 'yolanda',
      recoverySecret: rs,
      epoch: 1,
      entries: [loser],
      expectedHead: null,
    })
    // The lower sequenceID is the winner — a tiebreak both sides can evaluate alone, once they
    // have seen both frames. Which is the hard part.
    expect(winnerSeq < loserSeq).toBe(true)
    // Carol is served one branch and Bob the other. Neither can see the fork yet.
    hub.hideFrom('carol', loserSeq)
    hub.hideFrom('bob', winnerSeq)
    return { winner, loser, winnerSeq, loserSeq }
  }

  test('the losing branch rejoins the winner, and re-enacts the entries the winner never had', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x58)
    const { winner, loser, winnerSeq } = await setUpFork(hub, rs)

    const carol = makeMLSPeer(hub, 'carol', rs, { epoch: 1, members, recovery })
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
    await flush(80)

    // Each applied the only commit it was shown, at epoch 1, and each holds a ledger the other
    // has never heard of. Nobody has done anything wrong, and the group has two histories.
    expect(carol.mls.fold().get('role:carol')).toBe('admin')
    expect(bob.mls.fold().get('role:bob')).toBe('admin')
    expect(bob.mls.fold().get('role:carol')).toBeUndefined()
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    // Now the hub shows Bob the branch he lost — a frame BELOW his own cursor, at an epoch he
    // has a record for, with a sequenceID that is not the one he applied there.
    hub.revealTo('bob', winnerSeq)
    await wakeLane(hub, rs)
    await flush(400)

    // He heals: he is on the higher-sequenceID branch, so he is the loser, and he rejoins onto
    // the winner's. Carol, on the winning branch, does nothing.
    expect(recoveryRequests(hub, rs)).toHaveLength(1)
    expect(bob.mls.epoch()).toBe(carol.mls.epoch())
    expect(carol.mls.leaves().filter((did) => did === 'bob')).toHaveLength(1)
    // The rejoin left him folding the WINNER's ledger, and his own branch's entry is gone from
    // his handle entirely — the rejoined ledger is the group's, head-verified.
    expect(bob.mls.fold().get('role:carol')).toBe('admin')

    // ...and his entry comes back to be re-enacted, because the group's authenticated ledger
    // does not contain it: it only ever landed on a branch the group discarded. This is where
    // the membership filter earns its keep in the other direction — an implementation that
    // re-enacts nothing loses Bob's admin grant with no error anywhere.
    const { reenact = [] } = await bob.peer.replay()
    expect(reenact).toEqual([loser])
    await reenactFrom(bob, reenact)
    await flush(80)

    // Both branches' entries are now in one ledger, once each, and both peers agree.
    expect(bob.mls.fold().get('role:bob')).toBe('admin')
    expect(bob.mls.fold().get('role:carol')).toBe('admin')
    expect(carol.mls.fold().get('role:bob')).toBe('admin')
    expect(carol.mls.ledgerIDs()).toEqual([memoryEntryID(winner), memoryEntryID(loser)])

    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('the winning branch sees the same fork and does not heal', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x59)
    const { winner, loserSeq } = await setUpFork(hub, rs)

    const carol = makeMLSPeer(hub, 'carol', rs, { epoch: 1, members, recovery })
    await flush(80)
    expect(carol.mls.epoch()).toBe(2)

    // The hub shows Carol the other branch too. She holds the LOWER sequenceID at that epoch,
    // so the tiebreak says she is the winner: she steps over the frame and stays exactly where
    // she is. Both sides evaluate the same rule on the same two frames and reach opposite
    // conclusions, which is the whole point of the tiebreak — an implementation that healed on
    // both sides would rejoin the two halves of the group onto each other forever.
    hub.revealTo('carol', loserSeq)
    await wakeLane(hub, rs)
    await flush(200)

    expect(recoveryRequests(hub, rs)).toHaveLength(0)
    expect(carol.mls.epoch()).toBe(2)
    expect(carol.mls.commits()).toBe(1)
    expect(carol.mls.ledgerIDs()).toEqual([memoryEntryID(winner)])
    expect(carol.mls.fold().get('role:bob')).toBeUndefined()

    await carol.peer.dispose()
  })
})

describe('recover() is a compare-and-set loop of its own', () => {
  test('losing the race discards the GroupInfo, not just the commit, and the rejoin still lands', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x53)
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 2, members, recovery })
    await flush()

    // A commit lands between Alice's GroupInfo and her external-commit publish — the ordinary
    // case, not the exotic one: a heal runs precisely when the group is under commit pressure.
    let raced = false
    const racingHub: LogHub = {
      subscribe: (did: string, topicID: string, options?: HubSubscribeOptions) =>
        hub.subscribe(did, topicID, options),
      unsubscribe: (did: string, topicID: string) => hub.unsubscribe(did, topicID),
      fetchTopic: (params: HubFetchTopicParams) => hub.fetchTopic(params),
      receive: (did: string) => hub.receive(did),
      publish: async (params: HubPublishParams) => {
        if (!raced && params.topicID === commitTopic(rs) && params.retain === 'log') {
          raced = true
          await bob.peer.commit(buildLedgerCommit(bob, ['role:carol=admin']))
          await flush()
        }
        return hub.publish(params)
      },
    }
    const alice = makeMLSPeer(racingHub, 'alice', rs, { epoch: 1, members, recovery })
    await flush()

    const { advanced } = await alice.peer.recover()
    await flush(100)

    expect(advanced).toBe(true)
    // She asked TWICE. The first GroupInfo described a ratchet tree the winning commit had
    // already changed, so the commit built from it was one no member could apply: it is
    // discarded WITH the GroupInfo, and the rejoin is rebuilt from a fresh one. A peer that
    // merely retried the commit would have published against the changed tree, adopted its own
    // handle, and believed it had rejoined a group that never took its leaf.
    expect(recoveryRequests(hub, rs)).toHaveLength(2)
    // It landed FOR THE GROUP, which is the only place it counts: Bob applied the rejoin, so
    // the epoch moved past his own commit and Alice's tree and his are the same one. Asserting
    // that her own call merely resolved would pass against a peer that published a commit
    // against a tree the group had already changed, adopted its own derived handle, and sat
    // alone on a branch believing it had rejoined.
    expect(bob.mls.epoch()).toBe(4)
    expect(alice.mls.epoch()).toBe(4)
    expect(bob.mls.leaves().filter((did) => did === 'alice')).toHaveLength(1)
    // And she folded the ledger the winning commit enacted while she was rejoining.
    expect(alice.mls.fold().get('role:carol')).toBe('admin')

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('two peers healing at once both converge, and neither loses its entries', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x54)
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 2, members, recovery })

    const strand = (did: string, token: string): TestPeer => {
      const crypto = createFakeCrypto({ epoch: 1, localDID: did })
      const mls = createMemoryGroupMLS({
        recoverySecret: rs,
        epoch: 1,
        localDID: did,
        members,
        onAdvance: (e) => crypto.setEpoch(e),
      })
      mls.adopt(mls.buildCommit([token]))
      return makeMLSPeer(hub, did, rs, { mls, crypto, members, recovery })
    }
    const alice = strand('alice', 'role:alice=admin')
    const dave = strand('dave', 'role:dave=admin')
    await flush()

    // Both hold a GroupInfo at the same epoch, and both publish an external commit at the same
    // head. One wins; the other takes the head mismatch, re-requests, and rebuilds.
    const [aliceResult, daveResult] = await Promise.all([alice.peer.recover(), dave.peer.recover()])
    await flush(150)

    expect(aliceResult.advanced).toBe(true)
    expect(daveResult.advanced).toBe(true)
    // Both ended up in the group's tree, once each.
    expect(bob.mls.leaves().filter((did) => did === 'alice')).toHaveLength(1)
    expect(bob.mls.leaves().filter((did) => did === 'dave')).toHaveLength(1)
    expect(alice.mls.epoch()).toBe(bob.mls.epoch())
    expect(dave.mls.epoch()).toBe(bob.mls.epoch())

    // And neither lost its entries: each is handed back, and each lands on the host's own
    // ordinary commit.
    expect(aliceResult.reenact).toEqual(['role:alice=admin'])
    expect(daveResult.reenact).toEqual(['role:dave=admin'])
    await reenactFrom(alice, aliceResult.reenact)
    await reenactFrom(dave, daveResult.reenact)
    await flush(100)

    expect(bob.mls.fold().get('role:alice')).toBe('admin')
    expect(bob.mls.fold().get('role:dave')).toBe('admin')

    await alice.peer.dispose()
    await dave.peer.dispose()
    await bob.peer.dispose()
  })
})

describe('the lane is never re-entered', () => {
  test('a heal triggered while commit() is pulling does not deadlock: it unwinds, then heals', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x55)

    // Alice's own commit, in the log, un-merged: her pull will meet it and ask to heal — from
    // INSIDE commit(), which is holding the very mutex the heal needs.
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: rs, epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
    await flush()

    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members, recovery })
    // The commit unwinds rather than waiting: the trigger RECORDS, the pull finishes, the lane
    // is released, and the heal runs behind it as its own operation. A peer that awaited the
    // heal here would wait on a queue containing itself, and this call would never return.
    await expect(alice.peer.commit(buildLedgerCommit(alice, ['circle:x=Alice']))).rejects.toThrow(
      RecoveryRequiredError,
    )
    await flush(400)

    // The heal ran, on its own lane operation, after commit() let go.
    expect(alice.mls.epoch()).toBe(bob.mls.epoch())
    expect(bob.mls.leaves().filter((did) => did === 'alice')).toHaveLength(1)

    // And the host's re-issued commit — the SECOND commit of the heal — lands.
    await alice.peer.commit(buildLedgerCommit(alice, ['circle:x=Alice']))
    await flush()
    expect(bob.mls.fold().get('circle:x')).toBe('Alice')

    await alice.peer.dispose()
    await bob.peer.dispose()
  })
})

describe("a crash in recover()'s own acceptance window", () => {
  test('converges by re-recovery, and the group holds exactly one leaf for the peer', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x56)

    await publishCommit({ hub, senderDID: 'alice', recoverySecret: rs, epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
    await flush()

    const aliceCrypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const aliceMLS = createMemoryGroupMLS({
      recoverySecret: rs,
      epoch: 1,
      localDID: 'alice',
      members,
      onAdvance: (e) => aliceCrypto.setEpoch(e),
    })
    // The window `recover()` leaves open on purpose: the hub takes the external commit, and the
    // process dies before the rejoined handle is adopted. It is deliberately unjournalled.
    aliceMLS.failNextRecoveryAdopt()
    const dead = makeMLSPeer(hub, 'alice', rs, {
      mls: aliceMLS,
      crypto: aliceCrypto,
      members,
      recovery,
    })
    await flush(400)

    // The orphan is in the log, and the group applied it: Bob's tree carries the leaf it added,
    // and Alice's handle knows nothing about it.
    expect(rejoins(hub, rs).length).toBeGreaterThanOrEqual(2)
    expect(bob.mls.leaves().filter((did) => did === 'alice')).toHaveLength(1)
    expect(aliceMLS.epoch()).toBe(1)
    await dead.peer.dispose()

    // She restarts, still broken, still holding her old handle. Her orphaned external commit is
    // in the log framed at the GROUP's epoch and not at her own, so the own-commit trigger —
    // authorship AND current epoch — stays quiet on it. Her original condition still holds, so
    // she trips again and rejoins with a FRESH external commit against a fresh GroupInfo.
    const alice = makeMLSPeer(hub, 'alice', rs, {
      mls: aliceMLS,
      crypto: aliceCrypto,
      members,
      recovery,
    })
    await flush(500)

    expect(alice.mls.epoch()).toBe(bob.mls.epoch())
    // EXACTLY ONE LEAF. The rejoin removes the prior leaf for the same identity, so the second
    // one collects the leaf the orphan left behind. Leaves do not accumulate.
    expect(bob.mls.leaves().filter((did) => did === 'alice')).toHaveLength(1)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })
})

describe('a bootstrap that cannot complete is a degraded state, not a heal', () => {
  test('recover() never reports advanced with an incomplete ledger, and the roster comes back later', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x57)

    const bobCrypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    const bobMLS = createMemoryGroupMLS({
      recoverySecret: rs,
      epoch: 1,
      localDID: 'bob',
      members,
      onAdvance: (e) => bobCrypto.setEpoch(e),
    })
    // The only responder withholds an entry. Every token it serves is perfectly well-formed —
    // omission is exactly what a signature does not protect and what the head chain does.
    let lying = true
    const responder: MemoryGroupMLS = {
      ...bobMLS,
      getLedger: async () => {
        const ledger = await bobMLS.getLedger()
        return lying ? ledger.slice(0, ledger.length - 1) : ledger
      },
    }
    const bob = makeMLSPeer(hub, 'bob', rs, {
      mls: responder,
      crypto: bobCrypto,
      members,
      recovery,
    })
    await flush()
    await bob.peer.commit(buildLedgerCommit(bob, ['role:carol=admin', 'role:dave=admin']))
    await flush()

    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members, recovery })
    await flush()

    const result = await alice.peer.recover()
    await flush(100)

    // The rejoin LANDED — she is in the tree — and she still must not be told she is healed:
    // her ledger is empty against a live head, which is a roster reset, and a peer that
    // reported this as a heal would hand its host a group with every role silently gone.
    expect(bob.mls.leaves().filter((did) => did === 'alice')).toHaveLength(1)
    expect(result).toEqual({ advanced: false, reenact: [] })
    expect(await alice.mls.isLedgerComplete()).toBe(false)
    expect(alice.mls.fold().get('role:carol')).toBeUndefined()

    // It is persistent, retryable and self-detecting: nothing remembers that she was mid-heal,
    // and the completeness invariant finds it again at her very next lane operation.
    lying = false
    await alice.peer.replay()
    await flush(100)

    expect(await alice.mls.isLedgerComplete()).toBe(true)
    expect(alice.mls.fold().get('role:carol')).toBe('admin')
    expect(alice.mls.fold().get('role:dave')).toBe('admin')

    await alice.peer.dispose()
    await bob.peer.dispose()
  })
})
