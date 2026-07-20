import { describe, expect, test } from 'vitest'

import { RecoveryRequiredError } from '../src/commit.js'
import {
  decodeHandshakeFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  HANDSHAKE_MAGIC,
  HANDSHAKE_VERSION,
} from '../src/handshake.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms))

/** Fast rendezvous, so a heal that is going to happen happens inside a test — and a heal that
 *  will find nobody gives up inside one too. */
const recovery = { timeoutMs: 60, getDelayMs: () => 5, deadlineMs: 250 }

/** A responder seals only to a DID its own tree holds a leaf for. */
const members = ['alice', 'bob', 'carol']

/**
 * A frame from a LATER build of this protocol: today's magic, today's commit kind, a version
 * byte this build has never seen — and therefore a payload it cannot read a single field of.
 * The bytes after the header are deliberately meaningless here: the whole point is that a peer
 * running today's code must decide what to do about this frame WITHOUT reading them.
 */
function futureVersionFrame(): Uint8Array {
  const frame = encodeHandshakeFrame(HANDSHAKE_KIND.commit, Uint8Array.from([9, 9, 9, 9, 9, 9]))
  frame[HANDSHAKE_MAGIC.length] = HANDSHAKE_VERSION + 1
  return frame
}

/** Put one on the commit log, as any member of the group may. */
function publishFutureFrame(hub: FakeHub, rs: Uint8Array): Promise<{ sequenceID: string }> {
  return hub.publish({
    senderDID: 'zoe',
    topicID: commitTopic(rs),
    payload: futureVersionFrame(),
    retain: 'log',
  })
}

/** The recovery requests THIS peer put on the wire: a heal it asked for, not somebody else's. */
function healsBy(hub: FakeHub, rs: Uint8Array, did: string): Array<unknown> {
  const topic = rendezvousTopic(rs)
  return hub.published.filter((m) => {
    if (m.topicID !== topic || m.senderDID !== did) return false
    try {
      return decodeHandshakeFrame(m.payload).kind === HANDSHAKE_KIND.recoveryRequest
    } catch {
      return false
    }
  })
}

const commitFrames = (hub: FakeHub, rs: Uint8Array): number =>
  hub.published.filter((m) => m.topicID === commitTopic(rs)).length

/**
 * A frame whose handshake version this build does not know is the one unreadable frame that
 * means something: on the COMMIT topic it is evidence the group moved to a format this build
 * cannot read. It must take the `ahead` path — step over, heal, strand.
 *
 * Filing it as poison is the failure this suite exists to catch, and it is silent. After a
 * version bump EVERY frame is unreadable, so there is never a "next frame" to heal from: the
 * peer steps over the group's entire future, drains to the end of the log, records the live
 * tip, and reports itself fully reconciled at an epoch nobody else is at. No error, no heal,
 * and no restart that fixes it.
 */
describe('a frame whose handshake version this build does not know', () => {
  test('on the commit topic: the peer heals, and its epoch moves', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x71)

    const { sequenceID } = await publishFutureFrame(hub, rs)
    // Carol runs the build that WROTE that frame, so it says nothing to her and she stays on
    // the group's line — the live member able to answer Bob's rendezvous. Modelled by keeping
    // the frame out of her log, since a fixture cannot run two builds at once.
    hub.hideFrom('carol', sequenceID)
    const carol = makeMLSPeer(hub, 'carol', rs, { epoch: 1, members, recovery })
    await flush()
    expect(carol.mls.epoch()).toBe(1)

    // Bob runs today's build and meets it.
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
    await flush(500)

    // The assertion is the heal ACTUALLY happening — a rendezvous Bob asked for, and an epoch
    // that moved — not the absence of an error. A peer that files the frame as poison throws
    // nothing at all.
    expect(healsBy(hub, rs, 'bob')).toHaveLength(1)
    expect(bob.mls.epoch()).toBeGreaterThan(1)
    // And he landed on the group's line, not a branch of his own: his rejoin is an external
    // commit like any other, so it takes Carol with him.
    expect(bob.mls.epoch()).toBe(carol.mls.epoch())

    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('the cursor does not step over it as poison: the peer is stranded, not reconciled', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x72)

    await publishFutureFrame(hub, rs)
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
    // The heal has already run and found nobody. Bob's only evidence he is off the group's line
    // is now the in-memory strand: the frame that raised it is behind his cursor and the live
    // tip is recorded, exactly as on the `ahead` path.
    await flush(220)

    const headBefore = hub.head(commitTopic(rs))
    const framesBefore = commitFrames(hub, rs)

    // THIS is the poison failure made observable. A peer that stepped over the frame and called
    // itself reconciled would commit happily here, win the compare-and-set at a dead epoch, and
    // land a commit on a branch of one.
    await expect(bob.peer.commit(buildLedgerCommit(bob, ['role:zoe=admin']))).rejects.toThrow(
      RecoveryRequiredError,
    )

    expect(commitFrames(hub, rs)).toBe(framesBefore)
    expect(hub.head(commitTopic(rs))).toBe(headBefore)
    expect(bob.mls.epoch()).toBe(1)
    expect(bob.journal.slot()).toBeNull()

    await bob.peer.dispose()
  })
})
