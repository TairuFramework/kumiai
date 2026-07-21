import { describe, expect, test } from 'vitest'

import { RecoveryRequiredError } from '../src/commit.js'
import {
  decodeHandshakeFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  HANDSHAKE_MAGIC,
  HANDSHAKE_VERSION,
} from '../src/handshake.js'
import { decodeRecoveryRequest, encodeRecoveryReply } from '../src/recovery.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
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
 * The recovery request bob's own heal put on the wire, decoded — so a reply can be forged
 * against its EXACT requestID and the ephemeral key inside it. Throws if there is none, rather
 * than handing back `undefined` for a test to silently forge a reply nobody was waiting for.
 */
function bobsRecoveryRequest(
  hub: FakeHub,
  rs: Uint8Array,
): { requestID: string; request: Uint8Array } {
  const topic = rendezvousTopic(rs)
  const message = hub.published.find((m) => m.topicID === topic && m.senderDID === 'bob')
  if (message == null) throw new Error('bob never published a recovery request')
  const frame = decodeHandshakeFrame(message.payload)
  if (frame.kind !== HANDSHAKE_KIND.recoveryRequest) {
    throw new Error('bob published something other than a recovery request on the rendezvous')
  }
  return decodeRecoveryRequest(frame.payload)
}

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
    // Short of the 250ms deadline, so the heal may still be retrying — nobody is there to answer
    // it either way. Bob's only evidence he is off the group's line is the in-memory strand: the
    // frame that raised it is behind his cursor and the live tip is recorded, exactly as on the
    // `ahead` path.
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

  test('on the rendezvous topic: a well-formed reply is dropped, not routed to the heal', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x74)

    await publishFutureFrame(hub, rs)
    // A short per-attempt timeout, deliberately: `commit()` and `recover()` share one
    // non-reentrant mutex, so the assertion below cannot run until bob's OWN heal attempt gives
    // up waiting for a reply — and with the default 5s timeout that outlasts vitest's own test
    // timeout. 350ms is short enough to give the mutex back quickly and long enough that this
    // test's own reply-forging (well under it) is still the live request when the forged reply
    // arrives.
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery: { timeoutMs: 350 } })
    await flush(100)

    const { requestID, request } = bobsRecoveryRequest(hub, rs)

    // A genuine responder answers bob's exact request: sealed to the ephemeral key bob's own
    // request carried, over group state that is unremarkable in every way that matters here.
    // `sealGroupInfo` is the very port call `handleRecoveryRequest` makes to build a real reply —
    // called directly, rather than standing up a second live peer whose own correctly-versioned
    // reply would race this test's forged one and heal bob anyway, for a reason unrelated to the
    // version check this test exists to pin.
    const responder = createMemoryGroupMLS({ recoverySecret: rs, epoch: 1, members })
    const groupInfo = await responder.sealGroupInfo(request)

    // Today's kind, today's envelope — `encodeRecoveryReply`, exactly as the real responder path
    // builds one — wrapping a genuinely sealed reply to bob's own outstanding request. Only the
    // version byte is wrong. If `peer.ts`'s version check were gone, this decodes, opens with the
    // ephemeral key bob's own request minted, and lands his rejoin — the same path exercised by
    // `handleRecoveryReply` (peer.ts:1003) and the rejoin-landing block that clears `stranded`
    // (peer.ts:2440-2469).
    const forged = encodeHandshakeFrame(
      HANDSHAKE_KIND.recoveryReply,
      encodeRecoveryReply(requestID, groupInfo),
    )
    forged[HANDSHAKE_MAGIC.length] = HANDSHAKE_VERSION + 1

    await hub.publish({
      senderDID: 'zoe',
      topicID: rendezvousTopic(rs),
      payload: forged,
    })
    // Past bob's own 350ms per-attempt timeout: his heal has already given up waiting for a
    // reply and released the lane mutex `commit()` shares with it, so the assertion below is not
    // itself waiting out that timeout.
    await flush(500)

    // Dropped: bob's epoch never moved, and — the assertion `healsBy`/`epoch()` alone cannot
    // make here, since nothing else in this test was ever going to answer bob for real either —
    // he is still refusing commits exactly as test 2's genuinely-stranded bob does, not merely
    // un-healed by coincidence of timing.
    expect(bob.mls.epoch()).toBe(1)
    await expect(bob.peer.commit(buildLedgerCommit(bob, ['role:zoe=admin']))).rejects.toThrow(
      RecoveryRequiredError,
    )

    await bob.peer.dispose()
  })
})
