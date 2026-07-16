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
    // her leaf and the DID set is identical before and after it. Nothing a roster diff reads moves
    // — so the rotation rides the commit's own external flag, and every member lands on the epoch
    // the rejoin reached. Eve sets the same anchor from her rejoined handle, which is the only way
    // she can: she never applies her own commit.
    //
    // Eve, Carol and Dave were anchored apart before the heal — Eve at 1, the two of them at 3,
    // since they booted there and seeded off the live handle — and the heal is what closes it. The
    // anchor must be >= every current member's effective join, and Eve's effective join is her
    // rejoin epoch: her rejoined handle can export no secret from before it, so an anchor left at
    // 1 is one she could never derive.
    expect(eve.peer.anchorEpoch()).toBe(4)
    expect(carol.peer.anchorEpoch()).toBe(4)
    expect(dave.peer.anchorEpoch()).toBe(4)
    // And the app lane went with it, on the wire: all THREE are on the topic the rejoin epoch
    // names. (The topics they left keep their subscriptions — a rotation tears down the listeners
    // and never the subscription, or a peer would delete its own unread messages — so what is
    // decisive here is that the rejoin epoch's topic is the one they share.)
    expect(hub.subscriberCount(protocolTopic(secret, 4, 'chat'))).toBe(3)
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
