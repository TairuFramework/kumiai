import { describe, expect, test } from 'vitest'

import { RecoveryRequiredError } from '../src/commit.js'
import { COMMIT_FRAME_VERSION, encodeCommitFrame } from '../src/commit-frame.js'
import { decodeHandshakeFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms))

/** Fast rendezvous, so a heal that is going to happen happens inside a test — and a heal that
 *  will find nobody gives up inside one too. */
const recovery = { timeoutMs: 60, getDelayMs: () => 5, deadlineMs: 250 }

const members = ['alice', 'bob', 'carol']

/**
 * A frame whose HANDSHAKE header this build reads perfectly — today's magic, today's version,
 * today's commit kind — carrying a commit frame from a LATER build of this protocol. Only the
 * commit frame's own version byte is unknown, so the failure lands one layer below the header
 * check, inside `decodeCommitFrame`.
 *
 * The bytes behind that version byte are deliberately meaningless: under an unknown commit-frame
 * version the length field and the section boundaries do not mean what this build thinks they
 * mean either, which is the whole reason the peer must decide what to do WITHOUT reading them.
 */
function futureCommitFrame(): Uint8Array {
  const payload = encodeCommitFrame(Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5]))
  payload[0] = COMMIT_FRAME_VERSION + 1
  return encodeHandshakeFrame(HANDSHAKE_KIND.commit, payload)
}

/** Bytes that are not a commit frame at all: shorter than its five-byte header. */
function shortCommitFrame(): Uint8Array {
  return encodeHandshakeFrame(HANDSHAKE_KIND.commit, Uint8Array.from([COMMIT_FRAME_VERSION, 0]))
}

function publish(
  hub: FakeHub,
  rs: Uint8Array,
  payload: Uint8Array,
): Promise<{ sequenceID: string }> {
  return hub.publish({ senderDID: 'zoe', topicID: commitTopic(rs), payload, retain: 'log' })
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
 * The commit frame's version byte is the SECOND place a version bump can strand a peer, and the
 * more dangerous of the two: it is read before the commit bytes are extracted, so — unlike the
 * sealed ledger-entry blob, whose failure lands after the commit has been read — there is no next
 * frame to heal from. Dropping it as malformed means that after a `COMMIT_FRAME_VERSION` bump the
 * peer steps over the group's entire future, drains to an empty page, records the live tip, and
 * reports itself fully reconciled at an epoch nobody else is at. Silent, and no restart fixes it.
 *
 * A unit test on `decodeCommitFrame` cannot see any of that: it proves only that the throw
 * happens, and the throw happened all along. These are lane-level for that reason.
 */
describe('a frame whose commit-frame version this build does not know', () => {
  test('on the commit topic: the peer heals, and its epoch moves', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x81)

    const { sequenceID } = await publish(hub, rs, futureCommitFrame())
    // Carol runs the build that WROTE that frame, so it says nothing to her and she stays on the
    // group's line — the live member able to answer Bob's rendezvous. Modelled by keeping the
    // frame out of her log, since a fixture cannot run two builds at once.
    hub.hideFrom('carol', sequenceID)
    const carol = makeMLSPeer(hub, 'carol', rs, { epoch: 1, members, recovery })
    await flush()
    expect(carol.mls.epoch()).toBe(1)

    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
    await flush(500)

    // The heal ACTUALLY happening — a rendezvous Bob asked for, and an epoch that moved. A peer
    // that drops the frame as malformed throws nothing at all, which is why the assertion cannot
    // be the absence of an error.
    expect(healsBy(hub, rs, 'bob')).toHaveLength(1)
    expect(bob.mls.epoch()).toBeGreaterThan(1)
    expect(bob.mls.epoch()).toBe(carol.mls.epoch())

    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('the cursor does not step over it as malformed: the peer is stranded, not reconciled', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x82)

    await publish(hub, rs, futureCommitFrame())
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
    // Short of the 250ms deadline, so the heal may still be retrying — nobody is there to answer
    // it either way. Bob's only evidence he is off the group's line is the in-memory strand.
    await flush(220)

    const headBefore = hub.head(commitTopic(rs))
    const framesBefore = commitFrames(hub, rs)

    // THIS is the silent failure made observable. A peer that stepped over the frame and called
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

  test('bytes that are not a commit frame at all are still dropped, not healed from', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x83)

    await publish(hub, rs, shortCommitFrame())
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
    await flush(220)

    // The distinction the fix rests on: "a frame from the future" heals, "not a frame" does not.
    // Collapsing the two the other way would let anything able to publish two junk bytes here
    // strand every member of the group.
    expect(healsBy(hub, rs, 'bob')).toHaveLength(0)
    expect(bob.mls.epoch()).toBe(1)
    await expect(bob.peer.commit(buildLedgerCommit(bob, ['role:zoe=admin']))).resolves.toBeDefined()

    await bob.peer.dispose()
  })
})
