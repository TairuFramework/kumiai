import { describe, expect, test } from 'vitest'

import { RecoveryRequiredError } from '../src/commit.js'
import { commitTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { encodeMemoryCommit, memoryEntryID } from './fixtures/memory-group-mls.js'
import { buildLedgerCommit, makeMLSPeer, type TestPeer } from './fixtures/peer.js'

const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms))

/** Fast rendezvous, so a heal that is going to happen happens inside a test — and a heal that
 *  will find nobody gives up inside one too. */
const recovery = { timeoutMs: 60, getDelayMs: () => 5, deadlineMs: 250 }

/** A responder seals only to a DID its own tree holds a leaf for. */
const members = ['alice', 'bob', 'carol', 'dave']

/** Wake the commit lane without writing to the log: a mailbox frame is a wakeup, nothing more. */
async function wakeLane(hub: FakeHub, rs: Uint8Array): Promise<void> {
  await hub.publish({ senderDID: 'zoe', topicID: commitTopic(rs), payload: new Uint8Array([0]) })
  await flush(80)
}

/** The host's answer to a heal: re-enact whatever came back, with an ordinary commit. */
async function reenactFrom(member: TestPeer, reenact: Array<string>): Promise<void> {
  if (reenact.length > 0) await member.peer.commit(buildLedgerCommit(member, reenact))
}

type Armed = { bob: TestPeer; responder?: TestPeer; staleEpoch: number }
type Arm = (hub: FakeHub, rs: Uint8Array, withResponder: boolean) => Promise<Armed>

/**
 * Bob meets his OWN un-merged commit: the hub accepted it, the group moved on it, and his
 * process died before he adopted it — with no journal to repair him. He can never apply the
 * frame that is his own commit, so the cursor stops on it and he heals.
 */
const armOwnUnmerged: Arm = async (hub, rs, withResponder) => {
  await publishCommit({ hub, senderDID: 'bob', recoverySecret: rs, epoch: 1 })
  let responder: TestPeer | undefined
  if (withResponder) {
    // Carol applies Bob's commit and carries the group forward — a live member that can answer
    // the rendezvous and seal a GroupInfo that takes Bob's leaf.
    responder = makeMLSPeer(hub, 'carol', rs, { epoch: 1, members, recovery })
    await flush()
  }
  const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
  await flush(withResponder ? 500 : 220)
  return { bob, responder, staleEpoch: 1 }
}

/**
 * The reviewer's reproduction: the group ran to epoch 3 and the log was swept to its last
 * frame. Bob returns at epoch 1 and the only frame he can read is framed AHEAD of him — his
 * cursor drains to the end and takes the live tip, so the ONLY thing standing between him and a
 * compare-and-set at a stale epoch is the strand flag.
 */
const armAhead: Arm = async (hub, rs, withResponder) => {
  await publishCommit({ hub, senderDID: 'zoe', recoverySecret: rs, epoch: 1 })
  await publishCommit({ hub, senderDID: 'zoe', recoverySecret: rs, epoch: 2 })
  const { sequenceID: s3 } = await publishCommit({
    hub,
    senderDID: 'zoe',
    recoverySecret: rs,
    epoch: 3,
  })
  hub.trim(commitTopic(rs), s3)
  let responder: TestPeer | undefined
  if (withResponder) {
    responder = makeMLSPeer(hub, 'carol', rs, { epoch: 3, members, recovery })
    await flush()
  }
  const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
  await flush(withResponder ? 500 : 220)
  return { bob, responder, staleEpoch: 1 }
}

/**
 * A hub forked the log, and Bob is on the losing branch — the one whose commit carries the
 * HIGHER sequenceID. Shown the branch he lost, he heals; unhealed he sits at epoch 2 on a
 * branch of his own.
 */
const armForkLosing: Arm = async (hub, rs, withResponder) => {
  hub.acceptAtAnyHead()
  const winner = 'role:carol=admin'
  const loser = 'role:bob=admin'
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
  expect(winnerSeq < loserSeq).toBe(true)
  hub.hideFrom('bob', winnerSeq)
  let responder: TestPeer | undefined
  if (withResponder) {
    hub.hideFrom('carol', loserSeq)
    responder = makeMLSPeer(hub, 'carol', rs, { epoch: 1, members, recovery })
    await flush(80)
  }
  const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
  await flush(80)
  // Bob applied the loser branch (the winner was hidden). Now show him the branch he lost.
  hub.revealTo('bob', winnerSeq)
  await wakeLane(hub, rs)
  await flush(withResponder ? 500 : 220)
  return { bob, responder, staleEpoch: 2 }
}

const triggers: Array<{ name: string; arm: Arm }> = [
  { name: 'its own un-merged commit', arm: armOwnUnmerged },
  { name: 'a frame framed ahead of it', arm: armAhead },
  { name: 'the losing side of a fork', arm: armForkLosing },
]

const commitFrames = (hub: FakeHub, rs: Uint8Array): number =>
  hub.published.filter((m) => m.topicID === commitTopic(rs)).length

describe('a heal trigger under a failed heal', () => {
  for (const trigger of triggers) {
    test(`${trigger.name}: no responder — commit() refuses, and nothing lands`, async () => {
      const hub = new FakeHub()
      const rs = new Uint8Array(32).fill(0x61)
      const { bob, staleEpoch } = await trigger.arm(hub, rs, false)

      // The heal has already run and found nobody. Its only evidence it is off the group's line
      // is now this in-memory strand — the frame that raised it is behind the cursor, and
      // `commitLogHead` is the live tip. A peer that forgot it would race the compare-and-set at
      // a stale epoch and WIN, landing a commit on a branch of one.
      const headBefore = hub.head(commitTopic(rs))
      const framesBefore = commitFrames(hub, rs)

      await expect(bob.peer.commit(buildLedgerCommit(bob, ['role:zoe=admin']))).rejects.toThrow(
        RecoveryRequiredError,
      )

      // Belief, not the absence of an error: nothing was published to the log, the head did not
      // move, the peer did not advance onto its own branch, and nothing was journalled.
      expect(commitFrames(hub, rs)).toBe(framesBefore)
      expect(hub.head(commitTopic(rs))).toBe(headBefore)
      expect(bob.mls.epoch()).toBe(staleEpoch)
      expect(bob.journal.slot()).toBeNull()

      await bob.peer.dispose()
    })

    test(`${trigger.name}: a responder answers — the peer heals, then commits`, async () => {
      const hub = new FakeHub()
      const rs = new Uint8Array(32).fill(0x62)
      const { bob, responder, staleEpoch } = await trigger.arm(hub, rs, true)

      // The control column: with a responder the heal lands, the strand clears, and the very
      // commit that was refused above now goes through.
      expect(responder).toBeDefined()
      const carol = responder as TestPeer
      expect(bob.mls.epoch()).toBeGreaterThan(staleEpoch)
      expect(bob.mls.epoch()).toBe(carol.mls.epoch())

      const { reenact = [] } = await bob.peer.replay()
      await reenactFrom(bob, reenact)
      await flush(80)
      await bob.peer.commit(buildLedgerCommit(bob, ['role:zoe=admin']))
      await flush(80)
      expect(bob.mls.fold().get('role:zoe')).toBe('admin')

      await bob.peer.dispose()
      await carol.peer.dispose()
    })
  }
})

describe('poison is not evidence of being stranded', () => {
  test('a peer that has only stepped over poison still commits', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x63)

    // A frame framed at Bob's own epoch, naming a body no member holds — the case the Q3.4
    // decision log fears. Nobody can apply it, so the group never moves past this epoch: it is
    // dead in the log, not a peer moving on without Bob. He steps over it and is NOT stranded.
    const orphan = memoryEntryID('a body nobody can supply')
    await publishCommit({
      hub,
      senderDID: 'mallory',
      recoverySecret: rs,
      epoch: 1,
      commit: encodeMemoryCommit(1, 'mallory', [orphan]),
    })
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
    await flush(200)

    // He is the honest next commit: framed at the same epoch, landing behind the dead frame.
    // Gating him here — refusing on poison rather than on positive `ahead` evidence — would be
    // the group-death hazard rebuilt: every honest member would refuse, and no one could publish
    // the commit that unsticks the group.
    await bob.peer.commit(buildLedgerCommit(bob, ['role:zoe=admin']))
    await flush(80)
    expect(bob.mls.epoch()).toBe(2)
    expect(bob.mls.fold().get('role:zoe')).toBe('admin')

    await bob.peer.dispose()
  })
})
