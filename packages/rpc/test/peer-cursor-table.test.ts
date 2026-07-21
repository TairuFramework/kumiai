import { describe, expect, test } from 'vitest'

import { RecoveryRequiredError } from '../src/commit.js'
import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { encodeMemoryCommit, memoryEntryID } from './fixtures/memory-group-mls.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/** Every recovery request this group put on the wire. A heal is not free — it is a
 *  rendezvous, a sealed GroupInfo from every responder, an external commit and a
 *  compare-and-set — so counting them is counting what an attacker gets for a publish. */
function heals(hub: FakeHub, recoverySecret: Uint8Array): Array<unknown> {
  const topic = rendezvousTopic(recoverySecret)
  return hub.published.filter((m) => {
    if (m.topicID !== topic) return false
    try {
      return decodeHandshakeFrame(m.payload).kind === HANDSHAKE_KIND.recoveryRequest
    } catch {
      return false
    }
  })
}

/** Fast rendezvous, so a heal that is going to happen happens inside a test. */
const fastRecovery = { timeoutMs: 100, getDelayMs: () => 5, deadlineMs: 300 }

/** A responder answers only a DID its own tree still holds a leaf for, so a peer that expects
 *  to be healed has to be in the group it is asking. */
const members = ['alice', 'bob', 'carol']

describe('a peer that meets its own un-merged commit', () => {
  test('heals, and its epoch advances — with no journal to repair it', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x41)

    // Alice's commit, framed at epoch 1. The hub accepted it and the group advanced on it —
    // and her process died before she adopted it, taking the pending state with it. Her
    // journal is gone too: this is the peer the journal cannot repair.
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: rs, epoch: 1 })

    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery: fastRecovery })
    await flush()
    expect(bob.mls.epoch()).toBe(2)

    // Alice comes back at the epoch she died at, holding an empty journal, and reads the log.
    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members, recovery: fastRecovery })
    await flush(200)

    // She healed, by rejoining: the external commit is a commit like any other, so it lands on
    // the log and takes the whole group to the next epoch with her. The assertion is her
    // EPOCH, not the absence of an error — a peer missing this row files its own commit as
    // poison, walks cheerfully to the end of the log, and reports itself fully reconciled,
    // stuck at epoch 1 forever with a clean bill of health.
    expect(alice.mls.epoch()).toBe(3)
    expect(bob.mls.epoch()).toBe(3)
    expect(heals(hub, rs)).toHaveLength(1)

    // And the port was never even asked about that frame. The un-merged own-commit row is
    // settled BEFORE the frame is handed over, which is what stops the answer — "I could not
    // apply this" — deciding the classification.
    expect(alice.mls.seen()).toBe(0)
    expect(alice.mls.commits()).toBe(0)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('applies none of the commits it jumped over, and heals only once', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x42)

    // Alice's orphaned commit at epoch 1...
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: rs, epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery: fastRecovery })
    await flush()
    // ...and the group commits again on top of it, at epoch 2.
    const token = 'signed-token: bob enacted this while alice was dead'
    await bob.peer.commit(buildLedgerCommit(bob, [token]))
    await flush()
    expect(bob.mls.epoch()).toBe(3)

    // Alice restarts at epoch 1 and heals to the group's epoch. The rejoin moves her epoch; it
    // does not move her cursor over the frames she skipped, and at the epoch she lands on they
    // are history.
    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members, recovery: fastRecovery })
    await flush(300)

    expect(alice.mls.epoch()).toBe(4)
    expect(bob.mls.epoch()).toBe(4)
    // She applied NEITHER of the frames she jumped over. At the epoch she landed on they are
    // frames from epochs she holds no record for — history — so the cursor walks them and the
    // port is never asked. A peer that re-applied them would advance twice on commits the
    // group counted once.
    expect(alice.mls.seen()).toBe(0)
    expect(alice.mls.commits()).toBe(0)
    // She did not APPLY bob's commit — and she holds what it enacted anyway. The rejoined
    // handle came back with an empty ledger, and bootstrap refolded the group's whole ledger
    // into it, head-verified.
    expect(alice.mls.ledgerIDs()).toEqual([memoryEntryID(token)])
    // And she does not heal again on the way past her own commit: authorship matches, but
    // the epoch no longer does.
    expect(heals(hub, rs)).toHaveLength(1)

    // Her lane is live at the epoch she landed on: the next commit reaches her and applies.
    await publishCommit({ hub, senderDID: 'zoe', recoverySecret: rs, epoch: 4 })
    await flush(80)
    expect(alice.mls.seen()).toBe(1)
    expect(alice.mls.commits()).toBe(1)
    expect(alice.mls.epoch()).toBe(5)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })
})

describe('a hostile commit cannot make an honest peer do expensive work', () => {
  // Mallory was removed from the group. She keeps the commit topic and her subscription to
  // it forever — the topic is derived from a secret that does not rotate — and the hub is
  // blind and cannot judge a commit. So she can always publish one.
  const removed = (did: string): boolean => did !== 'mallory'

  test('a removed member’s policy-refused commit is poison, and nobody heals', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x43)
    const bob = makeMLSPeer(hub, 'bob', rs, { acceptsCommitter: removed, recovery: fastRecovery })
    const carol = makeMLSPeer(hub, 'carol', rs, {
      acceptsCommitter: removed,
      recovery: fastRecovery,
    })
    await flush()

    // One well-formed commit, at the current head, that every honest peer deliberately
    // refuses. It is exactly "a valid frame at my current epoch that I cannot apply" — and
    // that is not a description of a crash victim, it is a description of this.
    await publishCommit({ hub, senderDID: 'mallory', recoverySecret: rs, epoch: 1 })
    await flush(200)

    // They read it, judged it, refused it, and stepped over it.
    expect(bob.mls.seen()).toBe(1)
    expect(bob.mls.commits()).toBe(0)
    expect(bob.mls.epoch()).toBe(1)
    expect(carol.mls.seen()).toBe(1)
    expect(carol.mls.epoch()).toBe(1)

    // Nobody healed. A trigger keyed on "I cannot apply this" would have sent the whole group
    // into recovery at once — a rendezvous, a sealed GroupInfo from every responder, an
    // external commit and compare-and-set contention, from every member, for the price of one
    // publish, repeatable at will.
    expect(heals(hub, rs)).toHaveLength(0)

    // And the lane is not wedged behind the poison: the group's next commit lands and applies.
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: rs, epoch: 1 })
    await flush(80)
    expect(bob.mls.epoch()).toBe(2)
    expect(carol.mls.epoch()).toBe(2)
    expect(heals(hub, rs)).toHaveLength(0)

    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('and still nobody heals when the hub swears each peer sent it themselves', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x44)
    // The hub stamps every commit frame with its READER's own DID. `senderDID` is the hub's
    // word about who handed a frame over, and this hub is not trusted — a peer that read
    // authorship out of it has quietly moved authorship to the hub, and this is the bill.
    hub.lieAboutSender((message, readerDID) =>
      message.topicID === commitTopic(rs) ? readerDID : message.senderDID,
    )

    const bob = makeMLSPeer(hub, 'bob', rs, { acceptsCommitter: removed, recovery: fastRecovery })
    const carol = makeMLSPeer(hub, 'carol', rs, {
      acceptsCommitter: removed,
      recovery: fastRecovery,
    })
    await flush()

    await publishCommit({ hub, senderDID: 'mallory', recoverySecret: rs, epoch: 1 })
    await flush(200)

    // The lie bought the hub nothing. The committer is read out of the commit, where MLS
    // authenticates it, so it still says `mallory` — the frame is still poison, and the
    // group-wide recovery storm the hub was reaching for does not happen.
    expect(heals(hub, rs)).toHaveLength(0)
    expect(bob.mls.epoch()).toBe(1)
    expect(bob.mls.commits()).toBe(0)
    expect(carol.mls.epoch()).toBe(1)

    // And the lie DID land — the peers were each told they published the frame themselves,
    // and classified it on the commit's word rather than the hub's anyway. Without this the
    // test would pass on a hub that never lied.
    expect(bob.mls.lastSender()).toBe('bob')
    expect(carol.mls.lastSender()).toBe('carol')

    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('a frame whose bodies nobody can supply is poison, and nobody heals', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x45)
    const bob = makeMLSPeer(hub, 'bob', rs, { recovery: fastRecovery })
    const carol = makeMLSPeer(hub, 'carol', rs, { recovery: fastRecovery })
    await flush()

    // A member publishes a well-formed commit naming an entry whose body it simply leaves out
    // of the frame. Nobody can resolve it — and a peer that healed here would hand that member
    // the whole group's recovery machinery for the price of one publish, which is the same
    // attack the refused-commit row already refuses to fund.
    const orphan = memoryEntryID('a body nobody can supply')
    await publishCommit({
      hub,
      senderDID: 'mallory',
      recoverySecret: rs,
      epoch: 1,
      commit: encodeMemoryCommit(1, 'mallory', [orphan]),
    })
    await flush(250)

    // Read once, dropped, stepped over. No retry: a retry can only succeed if some member at
    // this epoch can open a blob none of them can, and it buys nothing but a delay.
    expect(bob.mls.seen()).toBe(1)
    expect(bob.mls.commits()).toBe(0)
    expect(bob.mls.epoch()).toBe(1)
    expect(carol.mls.epoch()).toBe(1)

    // And NOBODY healed. The frame is simply dead in the log: nobody applied it, so the group
    // never moved past this epoch, and the whole cost is one wasted slot in the serialization
    // lane — a write capability any member has anyway.
    expect(heals(hub, rs)).toHaveLength(0)

    // The next honest commit is framed at the same epoch, lands behind the dead frame, and
    // everyone applies it. The lane is not wedged and the group is not stormed.
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: rs, epoch: 1 })
    await flush(80)
    expect(bob.mls.commits()).toBe(1)
    expect(bob.mls.epoch()).toBe(2)
    expect(carol.mls.epoch()).toBe(2)
    expect(heals(hub, rs)).toHaveLength(0)

    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('a commit that can never be applied is read ONCE, and the cursor never walks back over it', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x46)
    const bob = makeMLSPeer(hub, 'bob', rs, { acceptsCommitter: removed, recovery: fastRecovery })
    await flush()

    // Two frames that no member at this epoch can ever apply, and that no retry could ever
    // discover anything new about: one the policy refuses, one whose bodies are nowhere. They
    // arrive separately, so each is the last frame of the pull that reads it — a cursor that
    // failed to step over EITHER is caught, rather than covered for by the other's advance.
    await publishCommit({ hub, senderDID: 'mallory', recoverySecret: rs, epoch: 1 })
    await flush(80)
    expect(bob.mls.seen()).toBe(1)

    const orphan = memoryEntryID('a body nobody can supply')
    await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: rs,
      epoch: 1,
      commit: encodeMemoryCommit(1, 'alice', [orphan]),
    })
    await flush(80)
    expect(bob.mls.seen()).toBe(2)
    expect(bob.mls.commits()).toBe(0)
    expect(bob.mls.epoch()).toBe(1)

    // The group's next commit wakes bob and makes him pull AGAIN. That second pull is the only
    // observation that can tell "dropped once" from "retried forever": a peer whose cursor
    // stopped dead on the poison reads it again here, converges anyway — the honest frame is
    // right behind it — and reports itself perfectly healthy while re-reading a dead frame on
    // every wakeup it will ever have. Every other assertion in this suite passes for it.
    const token = 'signed-token: carol is an admin'
    await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: rs,
      epoch: 1,
      entries: [token],
    })
    await flush(80)

    // Three frames on the topic; three reads, ever.
    expect(bob.mls.seen()).toBe(3)
    // And the state MOVED: the honest commit applied over the top of the dead frames, and its
    // entry is in the ledger.
    expect(bob.mls.commits()).toBe(1)
    expect(bob.mls.epoch()).toBe(2)
    expect(bob.mls.ledgerIDs()).toEqual([memoryEntryID(token)])
    expect(heals(hub, rs)).toHaveLength(0)

    await bob.peer.dispose()
  })

  test('a forged epoch claim buys exactly ONE heal per frame, and does not wedge or loop', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x4a)
    const bob = makeMLSPeer(hub, 'bob', rs, { members, recovery: fastRecovery })
    await flush()
    const healthy = bob.mls.epoch()

    // The `ahead` row is decided on the commit's CLEARTEXT epoch, because the committer needs a
    // secret a fallen-behind peer does not have. So mallory can claim any epoch she likes, and
    // this is the bill: one publish, one heal, from every peer that reads it. It is accepted
    // rather than closed because it cannot be closed — any signal that says "you fell out of the
    // group" is one a peer outside the group cannot authenticate — and because it is not new:
    // an EXTERNAL commit's header needs no secret at all, so this exact frame with `external`
    // set has always reached this row.
    await publishCommit({
      hub,
      senderDID: 'mallory',
      recoverySecret: rs,
      epoch: 0,
      commit: encodeMemoryCommit(healthy + 999, 'mallory', []),
    })
    await flush(300)

    // What is bounded is the AMOUNT. The frame is stepped over before the heal is asked for, so
    // it is read once and never again: one heal, not a rejoin loop, and not a peer that re-reads
    // the lie on every wakeup it will ever have. That bound is the whole reason this is
    // survivable, and it is what this assertion protects.
    expect(heals(hub, rs)).toHaveLength(1)
    // And the peer landed back on the group's real epoch, not on the forged one.
    expect(bob.mls.epoch()).toBeLessThan(healthy + 999)

    // The lane is not wedged behind it either: the group's next honest commit lands and applies.
    const before = bob.mls.epoch()
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: rs, epoch: before })
    await flush(200)
    expect(bob.mls.epoch()).toBe(before + 1)
    // Still one heal. The forged frame did not come back.
    expect(heals(hub, rs)).toHaveLength(1)

    await bob.peer.dispose()
  })
})

describe('a peer that must recover before it can commit', () => {
  test('is told so, and the commit does not happen', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x48)

    // Alice's orphaned commit at epoch 1, and no other member alive to answer a rendezvous —
    // so her heal cannot land, and she stays holding a frame she can never apply.
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: rs, epoch: 1 })
    const alice = makeMLSPeer(hub, 'alice', rs, {
      epoch: 1,
      recovery: { timeoutMs: 40, getDelayMs: () => 5 },
    })
    await flush(120)
    expect(alice.mls.epoch()).toBe(1)

    // Her host commits anyway. The lane will not race a head it has not reconciled to, and it
    // will not silently do nothing: it unwinds and says why.
    await expect(alice.peer.commit(buildLedgerCommit(alice, ['signed-token: a']))).rejects.toThrow(
      RecoveryRequiredError,
    )
    // Nothing was published, and nothing was journalled: the commit did not happen.
    expect(hub.published.filter((m) => m.topicID === commitTopic(rs))).toHaveLength(1)
    expect(alice.journal.slot()).toBeNull()

    await alice.peer.dispose()
  })
})

describe('a peer the group left behind', () => {
  test('learns it from a later frame, not from the one it could not apply, and heals', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x46)

    // A commit naming an entry whose body is not in its frame. Every member that already holds
    // that body applies it; a member that does not, cannot. Here the group could, and did.
    const token = 'signed-token: a body bob was never given'
    await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: rs,
      epoch: 1,
      commit: encodeMemoryCommit(1, 'alice', [memoryEntryID(token)]),
    })
    // ...and the group, now at epoch 2, committed again on top of it.
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: rs, epoch: 2 })

    // A live member, to answer a rendezvous.
    const carol = makeMLSPeer(hub, 'carol', rs, { epoch: 3, members, recovery: fastRecovery })
    await flush()

    // Bob comes to the log at epoch 1, without that body. He drops the frame he cannot
    // resolve — in silence, because as far as he can tell nobody else could resolve it
    // either — and then meets the NEXT frame, framed at epoch 2, ahead of him. That is the
    // observation that says the fault was his alone.
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery: fastRecovery })
    await flush(300)

    // He healed, and the assertion is his epoch: a peer missing this row calls the ahead
    // frame "history", advances over it, reaches the end of the log, and reports itself fully
    // reconciled — stuck at a dead epoch forever with a clean bill of health. He rejoined onto
    // the group's epoch, so the group moved with him.
    expect(bob.mls.epoch()).toBe(4)
    expect(carol.mls.epoch()).toBe(4)
    expect(heals(hub, rs)).toHaveLength(1)
    // The port was asked about exactly one frame: the one at his own epoch. The frame ahead of
    // him was classified and stepped over without ever being handed to it.
    expect(bob.mls.seen()).toBe(1)
    expect(bob.mls.commits()).toBe(0)

    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('a Welcome joiner reading history it was never part of does not heal on arrival', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x47)

    // The group's whole life, in the log: the commit that added dave (framed at epoch 0, and
    // sealed under an epoch he will never hold), and two more after it.
    const daveRole = 'signed-token: dave is a member'
    await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: rs,
      epoch: 0,
      entries: [daveRole],
    })
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: rs, epoch: 1 })
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: rs, epoch: 2 })

    // Dave arrives on a Welcome at epoch 1 and reads the log from its oldest frame. He walks
    // frames from below his epoch, applies the ones at it, and RISES with the log — an
    // accepted commit is the only thing that advances an epoch, and every one of them
    // compare-and-sets at the head, so the frames run in non-decreasing epoch order and the
    // next one is never ahead of him.
    const dave = makeMLSPeer(hub, 'dave', rs, {
      epoch: 1,
      bodies: [daveRole],
      recovery: fastRecovery,
    })
    await flush(250)

    expect(dave.mls.epoch()).toBe(3)
    expect(dave.mls.commits()).toBe(2)
    // He asked nobody for anything. A peer that healed here would mean every new member heals
    // on arrival — the storm, self-inflicted, on the group's happiest path.
    expect(heals(hub, rs)).toHaveLength(0)

    await dave.peer.dispose()
  })
})
