import { describe, expect, test } from 'vitest'

import { classifyCommit } from '../src/classify.js'
import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit, publishedCommitDigest } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { encodeMemoryCommit } from './fixtures/memory-group-mls.js'
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
    // Captured before the replay so the assertions below can pin that the port is never handed
    // the frame a second time — `commits()` alone cannot show that: it counts only what
    // `processCommit` APPLIED, and a mutant that routed the replay to `processCommit` anyway
    // would return `{ advanced: false }` (epoch 1 against a handle at epoch 2) and leave
    // `commits()` exactly where it is.
    const seenAfterRejoin = alice.mls.seen()

    const replayed = await replayCommitFrame(hub, rs, original)
    // A fixture precondition, not the conclusion: the hub-conformance floor guarantees the
    // replay lands at or above the original, and this just confirms the fixture produced that
    // shape before the assertions below lean on it. The conclusion is the classification.
    expect(replayed > original).toBe(true)
    await flush(200)

    // Not applied: the epoch is unmoved, `commits()` is unmoved, and the port was never handed
    // the frame at all — `seen()` counts every `processCommit` call, applied or not, so this is
    // the assertion that actually pins "never handed to the port a second time".
    expect(alice.mls.epoch()).toBe(2)
    expect(alice.mls.commits()).toBe(1)
    expect(alice.mls.seen()).toBe(seenAfterRejoin)
    expect([...(await alice.mls.rosterDIDs())].sort()).toEqual(['alice', 'bob'])
    // The steer that would have mattered. `advanceHandle` rotates the anchor on
    // `result.advanced && header.external === true`; a replay that never advances never rotates,
    // so the app-lane topic every member derives stays where it is.
    expect(alice.peer.anchorEpoch()).toBe(anchorAfterRejoin)
    // And no heal: `winning` sets neither `healRequested` nor `stranded`.
    expect(recoveryRequests(hub, rs)).toHaveLength(0)
    // THE VERDICT, directly — `history` is observationally identical from outside the lane to the
    // `fork`/`winning` this used to read (both step over the frame, move the head, heal nothing),
    // so every assertion above holds either way. This pins that Alice recognised the replay as the
    // commit she already enacted, rather than as a fork she happened to be on the winning side of.
    expect(
      classifyCommit(
        { epoch: 1, committerDID: 'bob' },
        replayed,
        publishedCommitDigest(hub, replayed),
        {
          localDID: 'alice',
          epoch: alice.mls.epoch(),
          appliedByEpoch: new Map([
            [1, { sequenceID: original, digest: publishedCommitDigest(hub, original) }],
          ]),
        },
      ),
    ).toEqual({ row: 'history' })

    // The cursor moved PAST the replay rather than parking on it — a frame re-read on every pull
    // is the permanent heal loop the forged-rejoin fix closed, arriving by another door.
    await wakeLane(hub, rs)
    await flush(300)
    expect(alice.mls.epoch()).toBe(2)
    expect(alice.mls.commits()).toBe(1)
    expect(alice.mls.seen()).toBe(seenAfterRejoin)
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
    // Not load-bearing here at all — unlike the sibling test, nothing below turns on the
    // replay's sequenceID relative to the original: Carol has no record for epoch 1 either way,
    // so both frames read as `history` regardless of which arrived first or which is higher.
    const replayed = await replayCommitFrame(hub, rs, original)

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
    // The port was never handed either frame — `history` is settled on the epoch alone, before
    // the lane ever reaches the port. `commits()` alone would not show this (a mutant routing a
    // `history` frame to `processCommit` still gets `{ advanced: false }` for the epoch
    // mismatch, leaving `commits()` unmoved); `seen()` counts the `processCommit` call itself.
    expect(carol.mls.seen()).toBe(0)
    expect(recoveryRequests(hub, rs)).toHaveLength(0)
    // THE VERDICT, directly. `history` and a winning fork are indistinguishable from outside the
    // lane, so this is what actually pins that Carol classified the replay as `history` rather
    // than inventing a fork she has no record to judge.
    expect(
      classifyCommit({ epoch: 1, committerDID: 'bob' }, replayed, null, {
        localDID: 'carol',
        epoch: carol.mls.epoch(),
        appliedByEpoch: new Map(),
      }),
    ).toEqual({ row: 'history' })

    // Stepped over for good, not re-read: history advances the cursor like every other row.
    await wakeLane(hub, rs)
    await flush(300)
    expect(carol.mls.epoch()).toBe(2)
    expect(carol.mls.commits()).toBe(0)
    expect(carol.mls.seen()).toBe(0)
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    await carol.peer.dispose()
  })

  test('a replay served BEFORE the original is not a fork the original loses', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x83)

    // Both copies land before Alice exists, so the order she is SERVED them is the hub's choice
    // alone — which is the whole point. The hub-conformance floor bounds where a replay's
    // sequenceID lands; it says nothing about the order a reader is handed the log.
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

    // The hub withholds the original and shows Alice the replay first.
    hub.hideFrom('alice', original)
    const alice = makeMLSPeer(hub, 'alice', rs, {
      epoch: 1,
      members: ['alice', 'bob'],
      recovery,
    })
    await flush(200)

    // She applied the replay — it is a genuine commit at her epoch, and nothing about it says
    // otherwise. Her record for epoch 1 now names the replay's position, not the original's.
    expect(alice.mls.epoch()).toBe(2)
    expect(alice.mls.commits()).toBe(1)
    const anchorAfterApply = alice.peer.anchorEpoch()
    const seenAfterApply = alice.mls.seen()
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    // Now the original arrives, below her cursor and below the position she recorded.
    hub.revealTo('alice', original)
    await wakeLane(hub, rs)
    await flush(300)

    // The same commit she already enacted, so: history. Comparing POSITIONS instead reads
    // `fork`/`losing` (the original carries the lower sequenceID), which heals the peer, rejoins
    // it with an external commit, and rotates the app-lane anchor for every member — one
    // group-wide storm per replay, for bytes the group already delivered once.
    expect(recoveryRequests(hub, rs)).toHaveLength(0)
    expect(alice.peer.anchorEpoch()).toBe(anchorAfterApply)
    expect(alice.mls.epoch()).toBe(2)
    expect(alice.mls.commits()).toBe(1)
    expect(alice.mls.seen()).toBe(seenAfterApply)

    // THE VERDICT, directly. Every assertion above is an absence, and a peer that simply never
    // reached the frame would satisfy all of them; this asks the classifier about the scenario's
    // own two frames at the positions the hub gave them.
    expect(
      classifyCommit(
        { epoch: 1, committerDID: 'bob' },
        original,
        publishedCommitDigest(hub, original),
        {
          localDID: 'alice',
          epoch: alice.mls.epoch(),
          appliedByEpoch: new Map([
            [1, { sequenceID: replayed, digest: publishedCommitDigest(hub, replayed) }],
          ]),
        },
      ),
    ).toEqual({ row: 'history' })

    await alice.peer.dispose()
  })

  test('two DIFFERENT commits at one epoch still fork, served in the same order', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x84)

    // Bob's and Yolanda's commits, both framed at epoch 1: the hub accepted two, which it can only
    // do by breaking its own compare-and-set. Bob's lands first, so it carries the lower
    // sequenceID and is the branch that stands.
    const { sequenceID: loserSeq } = await publishCommit({
      hub,
      senderDID: 'bob',
      recoverySecret: rs,
      epoch: 1,
      committerDID: 'bob',
      external: true,
    })
    const { sequenceID: winnerSeq } = await publishCommit({
      hub,
      senderDID: 'yolanda',
      recoverySecret: rs,
      epoch: 1,
      committerDID: 'yolanda',
      external: true,
    })
    expect(winnerSeq > loserSeq).toBe(true)
    // Different commits, so different digests — the premise the fork check now rests on.
    expect(publishedCommitDigest(hub, winnerSeq)).not.toBe(publishedCommitDigest(hub, loserSeq))

    // Alice is shown Yolanda's first and applies it, exactly as in the replay test.
    hub.hideFrom('alice', loserSeq)
    const alice = makeMLSPeer(hub, 'alice', rs, {
      epoch: 1,
      members: ['alice', 'bob'],
      recovery,
    })
    await flush(200)
    expect(alice.mls.epoch()).toBe(2)
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    // Bob's arrives below her cursor. Different bytes at an epoch she holds a record for: a fork,
    // and she is on the losing side, so she heals. Polled, not slept on — a fixed wait for
    // something that must HAPPEN is the flaky shape.
    hub.revealTo('alice', loserSeq)
    await wakeLane(hub, rs)
    for (let i = 0; i < 40 && recoveryRequests(hub, rs).length === 0; i++) await flush(25)
    expect(recoveryRequests(hub, rs).length).toBeGreaterThan(0)

    // THE VERDICT, directly — the recovery-request assertion above proves only that A heal
    // fired, not why: anything that triggered a heal for a different reason would satisfy it
    // just as well. This pins that the heal was specifically the `fork` row, on the LOSING
    // branch, against the sequenceID Alice actually recorded for the commit she applied.
    expect(
      classifyCommit(
        { epoch: 1, committerDID: 'bob' },
        loserSeq,
        publishedCommitDigest(hub, loserSeq),
        {
          localDID: 'alice',
          epoch: 2,
          appliedByEpoch: new Map([
            [1, { sequenceID: winnerSeq, digest: publishedCommitDigest(hub, winnerSeq) }],
          ]),
        },
      ),
    ).toEqual({ row: 'fork', appliedSequenceID: winnerSeq, branch: 'losing' })

    await alice.peer.dispose()
  })

  test('a re-sealed copy of an applied commit is history, not a fork', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x85)

    // The same Commit bytes, published twice under two different sealed entry blobs. This is
    // NOT the byte-for-byte replay above — it models a legitimate re-seal: the derived blob
    // riding the frame re-encrypted from a different entries list. (The fake seal is
    // deterministic — a keystream XOR plus a ciphertext-dependent tag, no nonce involved — so
    // it is the entries CONTENT that makes the two blobs differ, not any freshness in the
    // sealing itself.) A re-seal is legal because the blob is derived from the Commit and never
    // signed as part of it. Only the Commit itself is authenticated; the digest this branch keys
    // the fork check on has to track that boundary, or a re-seal that changes nothing MLS cares
    // about would read as a different commit and fork the whole group on it.
    const commit = encodeMemoryCommit(1, 'bob', [], { external: true })
    const { sequenceID: original } = await publishCommit({
      hub,
      senderDID: 'bob',
      recoverySecret: rs,
      epoch: 1,
      committerDID: 'bob',
      external: true,
      commit,
      entries: ['e1'],
    })
    const { sequenceID: resealed } = await publishCommit({
      hub,
      senderDID: 'bob',
      recoverySecret: rs,
      epoch: 1,
      committerDID: 'bob',
      external: true,
      commit,
      entries: ['e2'],
    })
    expect(resealed > original).toBe(true)

    // Premise check, not yet the guard: the two published FRAMES actually differ on the wire.
    // Without this, a future change that stopped `entries` from affecting the sealed blob would
    // silently collapse this test into a duplicate of the byte-identical replay test above —
    // still green, but with none of its mutation sensitivity, and nothing here would say so.
    const originalMessage = hub.published.find((m) => m.sequenceID === original)
    const resealedMessage = hub.published.find((m) => m.sequenceID === resealed)
    if (originalMessage == null || resealedMessage == null) {
      throw new Error('published frame missing')
    }
    expect(resealedMessage.payload).not.toEqual(originalMessage.payload)

    // What this actually pins: the two published COMMITS are byte-identical, so `digestAppliedCommit`
    // (which only ever hashes the commit half) agrees on them despite the frames around them
    // differing, per the assertion just above. It does NOT pin the frame-wide invariant this test
    // exists for — `publishedCommitDigest` always digests `commitFrame.commit`
    // (`test/fixtures/commits.ts`), so a frame-wide digest inside `peer.ts` couldn't move this
    // assertion either way. That invariant is held up only by the behavioural half below, which
    // exercises the peer's OWN digest computation rather than the fixture's.
    expect(publishedCommitDigest(hub, original)).toBe(publishedCommitDigest(hub, resealed))

    // The hub withholds the LOWER-sequenceID original and shows Alice the re-sealed copy first —
    // the same "served out of position" shape as the replay test above, and deliberately so: a
    // frame-wide digest recovers its old (wrong) verdict only through the position comparison it
    // falls back to, and that fallback only fires when the later-applied record sits at a HIGHER
    // sequenceID than the frame still to arrive. Applying the two in sequenceID order would let a
    // frame-wide digest hide behind `branch: 'winning'`, which heals nothing and is invisible to
    // every assertion below — exactly the blind spot this test exists to close.
    hub.hideFrom('alice', original)
    const alice = makeMLSPeer(hub, 'alice', rs, {
      epoch: 1,
      members: ['alice', 'bob'],
      recovery,
    })
    await flush(200)

    // She applied the re-sealed copy — it is a genuine commit at her epoch — and her record for
    // epoch 1 now names ITS position and ITS frame, not the original's.
    expect(alice.mls.epoch()).toBe(2)
    expect(alice.mls.commits()).toBe(1)
    const anchorAfterApply = alice.peer.anchorEpoch()
    const seenAfterApply = alice.mls.seen()
    expect(recoveryRequests(hub, rs)).toHaveLength(0)

    // Now the original arrives, below her cursor and below the position she recorded — the same
    // Commit bytes under a different sealed blob than the one she applied.
    hub.revealTo('alice', original)
    await wakeLane(hub, rs)
    await flush(300)

    // Not applied a second time, and no heal: the port was never handed the original a second
    // time (`seen()` unmoved), the anchor did not rotate, and no recovery was requested. Keying
    // the digest on the frame instead of the Commit would read this as two different commits at
    // one epoch, with the original's LOWER sequenceID on the losing side — a heal, a rejoin, and
    // an app-lane anchor rotation for every member, over a re-seal that changed nothing MLS cares
    // about.
    expect(recoveryRequests(hub, rs)).toHaveLength(0)
    expect(alice.peer.anchorEpoch()).toBe(anchorAfterApply)
    expect(alice.mls.epoch()).toBe(2)
    expect(alice.mls.commits()).toBe(1)
    expect(alice.mls.seen()).toBe(seenAfterApply)

    // THE VERDICT, directly. This pins that Alice recognised the original as the commit she
    // already enacted (under the re-seal's blob), keyed on the Commit's bytes rather than the
    // blob riding either frame.
    expect(
      classifyCommit(
        { epoch: 1, committerDID: 'bob' },
        original,
        publishedCommitDigest(hub, original),
        {
          localDID: 'alice',
          epoch: alice.mls.epoch(),
          appliedByEpoch: new Map([
            [1, { sequenceID: resealed, digest: publishedCommitDigest(hub, resealed) }],
          ]),
        },
      ),
    ).toEqual({ row: 'history' })

    await alice.peer.dispose()
  })
})
