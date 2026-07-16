import { describe, expect, test } from 'vitest'

import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { commitTopic, protocolTopic, rendezvousTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { makeMLSPeer } from './fixtures/peer.js'

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms))

function recoveryReplyCount(hub: FakeHub, recoverySecret: Uint8Array): number {
  const topic = rendezvousTopic(recoverySecret)
  return hub.published.filter(
    (m) =>
      m.topicID === topic && decodeHandshakeFrame(m.payload).kind === HANDSHAKE_KIND.recoveryReply,
  ).length
}

describe('recovery rendezvous', () => {
  test('a stranded peer rejoins by external commit, and one responder wins', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x77)
    const members = ['carol', 'dave', 'eve']
    const carol = makeMLSPeer(hub, 'carol', rs, {
      epoch: 3,
      members,
      recovery: { getDelayMs: () => 5 },
    })
    const dave = makeMLSPeer(hub, 'dave', rs, {
      epoch: 3,
      members,
      recovery: { getDelayMs: () => 60 },
    })
    const eve = makeMLSPeer(hub, 'eve', rs, { epoch: 1, members })
    await flush()

    const result = await eve.peer.recover()
    await flush(120)

    expect(result).toEqual({ advanced: true, reenact: [] })
    // The rejoin is a COMMIT: it changes the ratchet tree, so it lands on the commit log and
    // every member applies it. Eve leaves the group's epoch, and so does everybody else.
    expect(eve.mls.epoch()).toBe(4)
    expect(carol.mls.epoch()).toBe(4)
    expect(hub.published.filter((m) => m.topicID === commitTopic(rs))).toHaveLength(1)
    const secret = await eve.crypto.exportSecret()
    // Eve was stranded, never evicted, so the roster held her DID throughout: her rejoin REPLACES
    // her leaf and the DID set is identical before and after it. The anchor is rotated by a change
    // in that set, so no member rotates here — not Eve, and not the members applying her external
    // commit. Her app lane stays on the topic her anchor names, and nobody moves onto a topic named
    // by the epoch the rejoin reached.
    expect(eve.peer.anchorEpoch()).toBe(1)
    expect(hub.subscriberCount(protocolTopic(secret, 1, 'chat'))).toBeGreaterThanOrEqual(1)
    expect(hub.subscriberCount(protocolTopic(secret, 4, 'chat'))).toBe(0)
    // And that leaves Eve and Carol anchored apart — 1 against 3 — which is asserted here rather
    // than left to be discovered, because it is the one place the anchor does NOT deliver
    // agreement. The two causes are separate. Carol anchors at 3 because she BOOTED at 3 and
    // re-seeds from the live handle: nothing in this segment's history reaches her, so the two
    // peers were already apart before the heal, and the rejoin's job was to close that. It does
    // not: a rejoin that changes no DID is invisible to the diff, so the heal that reunites Eve's
    // MLS state with the group leaves her app lane exactly where it was.
    expect(carol.peer.anchorEpoch()).toBe(3)
    expect(dave.peer.anchorEpoch()).toBe(3)
    // Carol (fast) replies; Dave (slow) observes that reply and suppresses his own.
    expect(recoveryReplyCount(hub, rs)).toBe(1)
    // The group's tree holds ONE leaf for the rejoined member, not two.
    expect(carol.mls.leaves().filter((did) => did === 'eve')).toHaveLength(1)

    await carol.peer.dispose()
    await dave.peer.dispose()
    await eve.peer.dispose()
  })

  test('no responder: the deadline burns and the peer stays degraded, and does not throw', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x88)
    // Heal is a rendezvous. It REQUIRES another member, online, holding the group and able to
    // seal a GroupInfo — and there is nobody here. That is a "try later", not an error.
    const eve = makeMLSPeer(hub, 'eve', rs, {
      epoch: 1,
      recovery: { timeoutMs: 40, deadlineMs: 80 },
    })
    await flush()

    const result = await eve.peer.recover()
    expect(result).toEqual({ advanced: false, reenact: [] })
    expect(eve.mls.epoch()).toBe(1)
    // Nothing was published on the commit log: a rejoin nobody could seal is a rejoin that
    // never got built.
    expect(hub.published.filter((m) => m.topicID === commitTopic(rs))).toHaveLength(0)

    await eve.peer.dispose()
  })
})
