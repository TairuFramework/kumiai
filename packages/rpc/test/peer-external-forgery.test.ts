import { describe, expect, test } from 'vitest'

import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { makeMLSPeer } from './fixtures/peer.js'

const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms))

/** Fast rendezvous, so a heal that is going to happen happens inside the test. */
const recovery = { timeoutMs: 120, getDelayMs: () => 5, deadlineMs: 600 }

/** Every recovery request this peer put on the wire — one per heal it asked for. */
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

/**
 * Wake the commit lane without writing to the log: a mailbox frame on the commit topic is
 * delivered, never retained, and a delivery is only ever a wakeup. It is how a test says
 * "read your log again" — which is the whole question when asking whether a frame is re-read.
 */
async function wakeLane(hub: FakeHub, rs: Uint8Array): Promise<void> {
  await hub.publish({ senderDID: 'zoe', topicID: commitTopic(rs), payload: new Uint8Array([0]) })
  await flush(80)
}

describe('an external commit cannot name its reader as its author unless it authenticates', () => {
  test('a forged rejoin claiming the reader heals it at most once, and the cursor moves past it', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x71)

    // Alice is healthy and current at epoch 1. Nothing is wrong with her.
    const alice = makeMLSPeer(hub, 'alice', rs, {
      epoch: 1,
      members: ['alice', 'bob'],
      recovery,
    })
    await flush()
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    // The forgery. Anyone who can publish to the commit topic — a removed member who keeps it
    // forever, or the untrusted hub — takes an external commit it observed and rewrites the leaf
    // credential naming its author to ALICE's DID, framed at ALICE's own current epoch. It cannot
    // re-sign, so the frame is signed by somebody else.
    //
    // Every field the lane reads without a key says "Alice's own rejoin, at the epoch she is still
    // at" — which is the one shape that makes a peer heal AND hold its cursor, so left
    // unauthenticated this frame is re-read and re-healed on every pull, forever, for one publish.
    await publishCommit({
      hub,
      senderDID: 'mallory',
      recoverySecret: rs,
      epoch: 1,
      committerDID: 'alice',
      signerDID: 'mallory',
      external: true,
    })
    await flush(200)

    // The committer does not authenticate, so the frame is a commit at this peer's epoch with no
    // author: poison. Stepped over, never retried, and NOT treated as her own unmerged commit.
    const afterFirst = recoveryRequests(hub, rs).length
    expect(afterFirst).toBe(0)

    // The cursor moved past it. Wake the lane repeatedly: a peer that had held its cursor on the
    // frame would re-read it and heal again every time, which is the loop this refuses.
    await wakeLane(hub, rs)
    await wakeLane(hub, rs)
    await wakeLane(hub, rs)
    expect(recoveryRequests(hub, rs)).toHaveLength(afterFirst)

    // And she was not knocked off the group in the process.
    expect(alice.mls.epoch()).toBe(1)

    await alice.peer.dispose()
  })

  test('a forged rejoin claiming a THIRD party is not applied either', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x72)

    const alice = makeMLSPeer(hub, 'alice', rs, {
      epoch: 1,
      members: ['alice', 'bob'],
      recovery,
    })
    await flush()

    // Same forgery, naming Bob rather than the reader. It would otherwise reach the port as an
    // applicable commit and rotate the anchor on a rejoin that never happened.
    await publishCommit({
      hub,
      senderDID: 'mallory',
      recoverySecret: rs,
      epoch: 1,
      committerDID: 'bob',
      signerDID: 'mallory',
      external: true,
    })
    await flush(200)

    // Poison, not apply: the epoch does not advance, and no heal is asked for.
    expect(alice.mls.epoch()).toBe(1)
    expect(alice.mls.commits()).toBe(0)
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    await alice.peer.dispose()
  })

  test('a GENUINE rejoin at the reader epoch still applies and still rotates the anchor', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x73)

    const alice = makeMLSPeer(hub, 'alice', rs, {
      epoch: 1,
      members: ['alice', 'bob'],
      recovery,
    })
    await flush()
    const anchorBefore = alice.peer.anchorEpoch()

    // Bob genuinely rejoins at the epoch Alice is at: claimed author and signer agree, which is
    // what a member that holds its own leaf key produces and a forger cannot.
    await publishCommit({
      hub,
      senderDID: 'bob',
      recoverySecret: rs,
      epoch: 1,
      committerDID: 'bob',
      external: true,
    })
    await flush(200)

    // Applied. The signature check closes the forgery without closing the feature.
    expect(alice.mls.epoch()).toBe(2)
    expect(alice.mls.commits()).toBe(1)
    // A rejoin rotates the anchor from a member the roster diff cannot see — it replaces a leaf
    // the roster already holds, so no DID and no leaf index moves. That still happens.
    expect(alice.peer.anchorEpoch()).toBe(2)
    expect(alice.peer.anchorEpoch()).not.toBe(anchorBefore)
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    await alice.peer.dispose()
  })

  test('a genuine rejoin framed AHEAD still heals the peer it left behind', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x74)

    // Alice is behind: the group is at epoch 4, she is at 1. She holds no group context for
    // epoch 4, so she cannot check that frame's signature and reads no committer off it — and
    // must still heal, because the epoch alone is what says she fell out.
    const alice = makeMLSPeer(hub, 'alice', rs, {
      epoch: 1,
      members: ['alice', 'bob'],
      recovery,
    })
    await flush()

    await publishCommit({
      hub,
      senderDID: 'bob',
      recoverySecret: rs,
      epoch: 4,
      committerDID: 'bob',
      external: true,
    })
    await flush(300)

    // She asked for help. Refusing an unverifiable committer must never cost the ahead signal:
    // a peer that filed the group's future as poison would step over all of it and report itself
    // reconciled while permanently stuck.
    expect(recoveryRequests(hub, rs).length).toBeGreaterThanOrEqual(1)

    await alice.peer.dispose()
  })
})
