import { describe, expect, test, vi } from 'vitest'

import { COMMIT_FRAME_VERSION, encodeCommitFrame } from '../src/commit-frame.js'
import { decodeHandshakeFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { assertCommitPoison } from './fixtures/control-hold.js'
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

describe('a frame whose commit-frame version this build does not know', {
  concurrent: false,
}, () => {
  test('unsupported inner version advances durably without a hold or heal', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x81)
    const { sequenceID } = await publish(hub, rs, futureCommitFrame())
    const onStrand = vi.fn()
    const onRecovery = vi.fn()
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery, onStrand, onRecovery })
    await bob.peer.replay()
    expect(onStrand).toHaveBeenCalledWith(
      expect.objectContaining({
        position: sequenceID,
        kind: 'unknown-version',
        confidence: 'claimed',
      }),
    )
    expect(onRecovery).not.toHaveBeenCalled()
    expect(healsBy(hub, rs, 'bob')).toEqual([])
    await assertCommitPoison(bob, hub, rs, 'bob', sequenceID)
  })

  test('private control completes after an unsupported commit frame', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x82)
    await publish(hub, rs, futureCommitFrame())
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
    await bob.peer.replay()
    const framesBefore = commitFrames(hub, rs)
    await expect(bob.peer.commit(buildLedgerCommit(bob, ['role:zoe=admin']))).resolves.toBeDefined()
    expect(commitFrames(hub, rs)).toBe(framesBefore + 1)
    expect(bob.mls.epoch()).toBe(2)
    expect((await bob.control.load()).controlHold).toBeNull()
    expect(healsBy(hub, rs, 'bob')).toEqual([])
    await bob.peer.dispose()
  })

  test('bytes that are not a commit frame at all are still dropped, not healed from', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x83)

    await publish(hub, rs, shortCommitFrame())
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
    await flush(220)

    expect(healsBy(hub, rs, 'bob')).toHaveLength(0)
    expect(bob.mls.epoch()).toBe(1)
    await expect(bob.peer.commit(buildLedgerCommit(bob, ['role:zoe=admin']))).resolves.toBeDefined()

    await bob.peer.dispose()
  })
})
