import { describe, expect, test, vi } from 'vitest'

import { decodeHandshakeFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import {
  decodeRecoveryConfirmRequest,
  decodeRecoveryVerdict,
  encodeRecoveryConfirmRequest,
} from '../src/recovery.js'
import { APP_TOPIC_LABEL, commitTopic, protocolTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit, publishedCommitDigest } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
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
  test('a losing fork followed by an applicable external commit produces no confirmation', async () => {
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(0x45)
    const winning = await publishCommit({
      hub,
      senderDID: 'carol',
      recoverySecret: secret,
      epoch: 1,
    })
    hub.hideFrom('alice', winning.sequenceID)
    const alice = makeMLSPeer(hub, 'alice', secret, {
      members: ['alice', 'bob', 'carol'],
      recovery: { timeoutMs: 60, deadlineMs: 1000, getDelayMs: () => 0 },
    })
    const bob = createMemoryGroupMLS({
      localDID: 'bob',
      members: ['alice', 'bob', 'carol'],
      recoverySecret: secret,
    })
    try {
      await alice.peer.resync()
      await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: 1 })
      await vi.waitFor(() => expect(alice.mls.epoch()).toBe(2))
      const key = vi.spyOn(alice.mls, 'confirmationKey')
      const seal = vi.spyOn(alice.mls, 'sealRecoveryVerdict')
      hub.revealTo('alice', winning.sequenceID)
      const external = await publishCommit({
        hub,
        senderDID: 'bob',
        recoverySecret: secret,
        epoch: 2,
        external: true,
      })
      await vi.waitFor(() => expect(alice.mls.epoch()).toBe(3))
      const requestID = 'stranded-confirm'
      const request = await bob.createRecoveryRequest(requestID)
      await hub.publish({
        senderDID: 'bob',
        topicID: rendezvousTopic(secret),
        payload: encodeHandshakeFrame(
          HANDSHAKE_KIND.recoveryConfirmRequest,
          encodeRecoveryConfirmRequest({
            requestID,
            request,
            position: external.sequenceID,
            commitDigest: publishedCommitDigest(hub, external.sequenceID),
          }),
        ),
      })
      await flush(100)
      expect(key).not.toHaveBeenCalled()
      expect(seal).not.toHaveBeenCalled()
      expect(
        hub.published.filter(
          (message) =>
            decodeHandshakeFrame(message.payload).kind === HANDSHAKE_KIND.recoveryVerdict,
        ),
      ).toHaveLength(0)
    } finally {
      await alice.peer.dispose()
    }
  })
  test('a failed verdict seal is retried and a successful seal is cached', async () => {
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(0x46)
    const options = {
      members: ['alice', 'bob'],
      recovery: { timeoutMs: 60, deadlineMs: 500, getDelayMs: () => 0 },
    }
    const alice = makeMLSPeer(hub, 'alice', secret, options)
    const bob = makeMLSPeer(hub, 'bob', secret, options)
    const seal = vi
      .spyOn(alice.mls, 'sealRecoveryVerdict')
      .mockRejectedValueOnce(new Error('transient seal failure'))
    const publish = hub.publish.bind(hub)
    let dropped = false
    vi.spyOn(hub, 'publish').mockImplementation(async (value) => {
      if (!dropped && decodeHandshakeFrame(value.payload).kind === HANDSHAKE_KIND.recoveryVerdict) {
        dropped = true
        return publish({ ...value, payload: new Uint8Array([0]) })
      }
      return publish(value)
    })
    try {
      expect((await bob.peer.recover()).advanced).toBe(true)
      expect(dropped).toBe(true)
      expect(seal).toHaveBeenCalledTimes(2)
    } finally {
      await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
    }
  })
  test('a later historical reread preserves the originally applied confirmation outcome', async () => {
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(0x43)
    const options = {
      members: ['alice', 'bob'],
      recovery: { timeoutMs: 60, deadlineMs: 1000, getDelayMs: () => 0 },
    }
    const alice = makeMLSPeer(hub, 'alice', secret, options)
    const bob = makeMLSPeer(hub, 'bob', secret, options)
    try {
      expect((await bob.peer.recover()).advanced).toBe(true)
      const publication = hub.published.find(
        (message) =>
          decodeHandshakeFrame(message.payload).kind === HANDSHAKE_KIND.recoveryConfirmRequest,
      )
      if (publication == null) throw new Error('No confirmation request')
      const original = decodeRecoveryConfirmRequest(
        decodeHandshakeFrame(publication.payload).payload,
      )
      expect((await bob.peer.recover()).advanced).toBe(true)
      hub.revealTo('alice', original.position)
      await hub.publish({
        senderDID: 'observer',
        topicID: commitTopic(secret),
        payload: encodeHandshakeFrame(HANDSHAKE_KIND.recoveryRequest, new Uint8Array([0])),
      })
      await flush(60)
      const requestID = 'historical-retransmit'
      const request = await bob.mls.createRecoveryRequest(requestID)
      await hub.publish({
        senderDID: 'bob',
        topicID: rendezvousTopic(secret),
        payload: encodeHandshakeFrame(
          HANDSHAKE_KIND.recoveryConfirmRequest,
          encodeRecoveryConfirmRequest({ ...original, requestID, request }),
        ),
      })
      await vi.waitFor(() =>
        expect(
          hub.published.some((message) => {
            const frame = decodeHandshakeFrame(message.payload)
            return (
              frame.kind === HANDSHAKE_KIND.recoveryVerdict &&
              decodeRecoveryVerdict(frame.payload).requestID === requestID
            )
          }),
        ).toBe(true),
      )
      const response = hub.published.find((message) => {
        const frame = decodeHandshakeFrame(message.payload)
        return (
          frame.kind === HANDSHAKE_KIND.recoveryVerdict &&
          decodeRecoveryVerdict(frame.payload).requestID === requestID
        )
      })
      if (response == null) throw new Error('No historical verdict')
      const { sealed } = decodeRecoveryVerdict(decodeHandshakeFrame(response.payload).payload)
      expect(await bob.mls.openRecoveryVerdict(sealed, requestID)).toMatchObject({
        verdict: { verdict: 'confirmed' },
      })
    } finally {
      await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
    }
  })
  test('a confirmed rejoin captures its anchor once', async () => {
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(0x42)
    const options = {
      members: ['alice', 'bob'],
      recovery: { timeoutMs: 60, deadlineMs: 500, getDelayMs: () => 0 },
    }
    const alice = makeMLSPeer(hub, 'alice', secret, options)
    const bob = makeMLSPeer(hub, 'bob', secret, options)
    try {
      await bob.peer.resync()
      const before = bob.anchorStore.captures()
      expect((await bob.peer.recover()).advanced).toBe(true)
      expect(bob.anchorStore.captures() - before).toBe(1)
    } finally {
      await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
    }
  })
  test('an ambiguous confirmed adoption is retried before the next lane operation without another rejoin', async () => {
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(0x39)
    const options = {
      members: ['alice', 'bob'],
      recovery: { timeoutMs: 60, deadlineMs: 500, getDelayMs: () => 0 },
    }
    const alice = makeMLSPeer(hub, 'alice', secret, options)
    const bob = makeMLSPeer(hub, 'bob', secret, options)
    bob.mls.failNextRecoveryAdopt()
    try {
      const before = bob.mls.epoch()
      await expect(bob.peer.recover()).rejects.toThrow('the process died in the acceptance window')
      expect(bob.mls.epoch()).toBe(before)
      await bob.peer.replay()
      expect(bob.mls.epoch()).toBe(alice.mls.epoch())
      expect(
        hub.published.filter((message) => message.topicID === commitTopic(secret)),
      ).toHaveLength(1)
    } finally {
      await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
    }
  })

  test('a commit waits for the entire active recovery before building', async () => {
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(0x40)
    const options = {
      members: ['alice', 'bob'],
      recovery: { timeoutMs: 60, deadlineMs: 500, getDelayMs: () => 0 },
    }
    const alice = makeMLSPeer(hub, 'alice', secret, options)
    const bob = makeMLSPeer(hub, 'bob', secret, options)
    let release = () => {}
    const pause = new Promise<void>((resolve) => {
      release = resolve
    })
    const seal = alice.mls.sealRecoveryVerdict.bind(alice.mls)
    const sealing = vi
      .spyOn(alice.mls, 'sealRecoveryVerdict')
      .mockImplementation(async (...args) => {
        await pause
        return seal(...args)
      })
    const build = vi.fn(async () => {
      throw new Error('build reached')
    })
    const recovery = bob.peer.recover()
    void recovery.catch(() => {})
    try {
      await vi.waitFor(() => expect(sealing).toHaveBeenCalled())
      const committing = bob.peer.commit(build)
      void committing.catch(() => {})
      await flush()
      expect(build).not.toHaveBeenCalled()
      release()
      expect((await recovery).advanced).toBe(true)
      await expect(committing).rejects.toThrow('build reached')
      expect(build).toHaveBeenCalledTimes(1)
    } finally {
      release()
      await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
    }
  })
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
    const { secret } = await eve.crypto.exportSecret(APP_TOPIC_LABEL)
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
