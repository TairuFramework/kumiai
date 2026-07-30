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
 * "read your log again" — which is the whole question when asking whether the cursor moved.
 */
async function wakeLane(hub: FakeHub, rs: Uint8Array): Promise<void> {
  await hub.publish({ senderDID: 'zoe', topicID: commitTopic(rs), payload: new Uint8Array([0]) })
  await flush(80)
}

/**
 * The attack: an already-published commit frame, re-published BYTE FOR BYTE by somebody who
 * merely observed it. No key, no signature, no forged credential — a signature check proves
 * possession of a key, never authorization to use it, so these bytes verify exactly as they did
 * the first time. Returns the sequenceID the replay landed at.
 */
async function replayCommitFrame(
  hub: FakeHub,
  rs: Uint8Array,
  sequenceID: string,
): Promise<string> {
  const original = hub.published.find((m) => m.sequenceID === sequenceID)
  if (original == null) throw new Error(`no published frame at ${sequenceID}`)
  const result = await hub.publish({
    // The untrusted hub itself, or any removed member — both keep the topic forever.
    senderDID: 'mallory',
    topicID: commitTopic(rs),
    payload: original.payload,
    retain: 'log',
  })
  return result.sequenceID
}

describe('a genuine external commit re-published by the hub steers nothing', () => {
  test('a replay after the group moved on is stepped over, and the anchor does not follow it', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x81)

    const alice = makeMLSPeer(hub, 'alice', rs, {
      epoch: 1,
      members: ['alice', 'bob'],
      recovery,
    })
    await flush()

    // Bob genuinely rejoins at Alice's epoch: claimed author and signer agree. She applies it and
    // rotates the anchor, which is the baseline the replay is measured against.
    const { sequenceID: original } = await publishCommit({
      hub,
      senderDID: 'bob',
      recoverySecret: rs,
      epoch: 1,
      committerDID: 'bob',
      external: true,
    })
    await flush(200)

    expect(alice.mls.epoch()).toBe(2)
    expect(alice.mls.commits()).toBe(1)
    const anchorAfterRejoin = alice.peer.anchorEpoch()

    const replayed = await replayCommitFrame(hub, rs, original)
    // The whole conclusion rests on this one comparison. Alice recorded `appliedByEpoch[1] =
    // original`; the replay lands above it, so `sequenceID < applied ? 'losing' : 'winning'`
    // settles `winning` and the lane steps over it. Pinned at the hub layer by
    // `hub-conformance`'s clause "a re-published payload under a fresh publishID never lands
    // below the original".
    expect(replayed > original).toBe(true)
    await flush(200)

    // Not applied: the epoch is unmoved and the port was never handed the commit a second time.
    expect(alice.mls.epoch()).toBe(2)
    expect(alice.mls.commits()).toBe(1)
    expect([...(await alice.mls.rosterDIDs())].sort()).toEqual(['alice', 'bob'])
    // The steer that would have mattered. `advanceHandle` rotates the anchor on
    // `result.advanced && header.external === true`; a replay that never advances never rotates,
    // so the app-lane topic every member derives stays where it is.
    expect(alice.peer.anchorEpoch()).toBe(anchorAfterRejoin)
    // And no heal: `winning` sets neither `healRequested` nor `stranded`.
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    // The cursor moved PAST the replay rather than parking on it — a frame re-read on every pull
    // is the permanent heal loop the forged-rejoin fix closed, arriving by another door.
    await wakeLane(hub, rs)
    expect(alice.mls.epoch()).toBe(2)
    expect(alice.mls.commits()).toBe(1)
    expect(alice.peer.anchorEpoch()).toBe(anchorAfterRejoin)
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    await alice.peer.dispose()
  })

  test('a peer holding no record for that epoch reads both copies as history', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x82)

    // Both copies land before any peer exists, so nobody has recorded applying either.
    const { sequenceID: original } = await publishCommit({
      hub,
      senderDID: 'bob',
      recoverySecret: rs,
      epoch: 1,
      committerDID: 'bob',
      external: true,
    })
    const replayed = await replayCommitFrame(hub, rs, original)
    expect(replayed > original).toBe(true)

    // Carol is already at epoch 2 — restarted, re-seeded, or a late joiner. `appliedByEpoch` is
    // in-memory BY DESIGN, so she holds no record for epoch 1: both frames are below her epoch
    // with nothing to compare against, which is `history`, not a fork she would invent.
    const carol = makeMLSPeer(hub, 'carol', rs, {
      epoch: 2,
      members: ['alice', 'bob', 'carol'],
      recovery,
    })
    await flush(200)

    expect(carol.mls.epoch()).toBe(2)
    expect(carol.mls.commits()).toBe(0)
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    // Stepped over for good, not re-read: history advances the cursor like every other row.
    await wakeLane(hub, rs)
    expect(carol.mls.epoch()).toBe(2)
    expect(carol.mls.commits()).toBe(0)
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    await carol.peer.dispose()
  })
})
