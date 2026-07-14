import { describe, expect, test } from 'vitest'

import { RecoveryRequiredError } from '../src/commit.js'
import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { encodeMemoryCommit, memoryEntryID } from '../src/memory-group-mls.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
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
const fastRecovery = { timeoutMs: 100, getDelayMs: () => 5 }

describe('a peer that meets its own un-merged commit', () => {
  test('heals, and its epoch advances — with no journal to repair it', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x41)

    // Alice's commit, framed at epoch 1. The hub accepted it and the group advanced on it —
    // and her process died before she adopted it, taking the pending state with it. Her
    // journal is gone too: this is the peer the journal cannot repair.
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: rs, epoch: 1 })

    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, recovery: fastRecovery })
    await flush()
    expect(bob.mls.epoch()).toBe(2)

    // Alice comes back at the epoch she died at, holding an empty journal, and reads the log.
    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, recovery: fastRecovery })
    await flush(200)

    // She healed. The assertion is her EPOCH, not the absence of an error: a peer missing
    // this row files its own commit as poison, walks cheerfully to the end of the log, and
    // reports itself fully reconciled — stuck at epoch 1 forever with a clean bill of health.
    expect(alice.mls.epoch()).toBe(2)
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
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, recovery: fastRecovery })
    await flush()
    // ...and the group commits again on top of it, at epoch 2.
    const token = 'signed-token: bob enacted this while alice was dead'
    await bob.peer.commit(buildLedgerCommit(bob, [token]))
    await flush()
    expect(bob.mls.epoch()).toBe(3)

    // Alice restarts at epoch 1 and heals to the group's epoch. The jump moves her epoch; it
    // does not move her cursor, so both commits she skipped are still in the log ahead of it.
    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, recovery: fastRecovery })
    await flush(200)

    expect(alice.mls.epoch()).toBe(3)
    // She applied NEITHER. At the epoch she landed on they are frames from epochs she holds
    // no record for — history — so the cursor walks them and the port is never asked. A peer
    // that re-applied them would advance twice on commits the group counted once.
    expect(alice.mls.seen()).toBe(0)
    expect(alice.mls.commits()).toBe(0)
    expect(alice.mls.ledgerIDs()).toEqual([])
    // And she does not heal again on the way past her own commit: authorship matches, but
    // the epoch no longer does.
    expect(heals(hub, rs)).toHaveLength(1)

    // Her lane is live at the epoch she landed on: the next commit reaches her and applies.
    await publishCommit({ hub, senderDID: 'zoe', recoverySecret: rs, epoch: 3 })
    await flush(80)
    expect(alice.mls.seen()).toBe(1)
    expect(alice.mls.commits()).toBe(1)
    expect(alice.mls.epoch()).toBe(4)

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
    const carol = makeMLSPeer(hub, 'carol', rs, { epoch: 3, recovery: fastRecovery })
    await flush()

    // Bob comes to the log at epoch 1, without that body. He drops the frame he cannot
    // resolve — in silence, because as far as he can tell nobody else could resolve it
    // either — and then meets the NEXT frame, framed at epoch 2, ahead of him. That is the
    // observation that says the fault was his alone.
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, recovery: fastRecovery })
    await flush(250)

    // He healed, and the assertion is his epoch: a peer missing this row calls the ahead
    // frame "history", advances over it, reaches the end of the log, and reports itself fully
    // reconciled — stuck at a dead epoch forever with a clean bill of health.
    expect(bob.mls.epoch()).toBe(3)
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
      ledger: [daveRole],
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
