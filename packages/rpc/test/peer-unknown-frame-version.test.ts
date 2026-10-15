import { describe, expect, test, vi } from 'vitest'

import { asLogPosition } from '../src/cursor.js'
import {
  decodeHandshakeFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  HANDSHAKE_MAGIC,
  HANDSHAKE_VERSION,
} from '../src/handshake.js'
import { decodeRecoveryRequest, encodeRecoveryReply } from '../src/recovery.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { assertCommitPoison, assertDurableControlHold } from './fixtures/control-hold.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

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

describe('a frame whose handshake version this build does not know', () => {
  test.each([false, true])(
    'unsupported outer version advances across restart (unknown kind: %s)',
    async (unknownKind) => {
      const hub = new FakeHub()
      const rs = new Uint8Array(32).fill(0x75)
      const frame = futureVersionFrame()
      if (unknownKind) frame[HANDSHAKE_MAGIC.length + 1] = 0xee
      const { sequenceID } = await hub.publish({
        senderDID: 'zoe',
        topicID: commitTopic(rs),
        payload: frame,
        retain: 'log',
      })
      const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
      await assertCommitPoison(bob, hub, rs, 'bob', sequenceID)
      expect(healsBy(hub, rs, 'bob')).toEqual([])
    },
  )

  test('private control completes after an unsupported handshake frame', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x72)
    await publishFutureFrame(hub, rs)
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

  test('a saved unsupported-version hold remains immutable across reconstruction', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x76)
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
    await bob.peer.replay()
    const position = '000000000099'
    await bob.control.apply(
      {
        controlHold: { reason: 'unsupported-version', position: asLogPosition(position) },
        strand: { reason: 'unsupported-version' },
        cursor: { position: null, epoch: 1, stranded: true },
      },
      'saved-legacy-hold',
    )
    await bob.peer.ack('refresh-saved-hold')
    const before = await bob.control.load()
    const framesBefore = commitFrames(hub, rs)
    const request = buildLedgerCommit(bob, ['held'])
    const committing = bob.peer.commit(request)
    void committing.catch(() => {})
    await vi.waitFor(async () => {
      expect((await bob.control.load()).operations).toContainEqual(
        expect.objectContaining({ id: request.id, stage: 'intent' }),
      )
    })
    await expect(bob.controlWalk.stepOperation(request.id)).resolves.toMatchObject({
      id: request.id,
      stage: 'intent',
    })
    expect(commitFrames(hub, rs)).toBe(framesBefore)
    expect(bob.mls.epoch()).toBe(1)
    const delivered = await publishFutureFrame(hub, rs)
    expect(delivered.sequenceID).not.toBe(position)
    await bob.peer.replay()
    const after = await bob.control.load()
    expect(after.controlHold).toEqual(before.controlHold)
    expect(after.cursor).toEqual(before.cursor)
    expect(after.strand).toEqual(before.strand)
    expect(after.operations).toContainEqual(
      expect.objectContaining({ id: request.id, stage: 'intent' }),
    )
    expect(commitFrames(hub, rs)).toBe(framesBefore + 1)
    expect(bob.mls.epoch()).toBe(1)
    await assertDurableControlHold(bob, hub, rs, 'bob', { reason: 'unsupported-version', position })
    await expect(committing).rejects.toThrow()
  })

  test('on the rendezvous topic: a well-formed reply is dropped, not routed to the heal', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x74)

    await publishCommit({ hub, senderDID: 'alice', recoverySecret: rs, epoch: 3 })
    // The forged reply must arrive while the request is live; the clock advances only after it.
    vi.useFakeTimers()
    const bob = makeMLSPeer(hub, 'bob', rs, {
      epoch: 1,
      members,
      recovery: { timeoutMs: 5000, deadlineMs: 10000 },
    })
    try {
      await vi.waitFor(() => expect(healsBy(hub, rs, 'bob')).toHaveLength(1))

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
      await vi.advanceTimersByTimeAsync(5000)

      // Dropped: bob's epoch never moved, and — the assertion `healsBy`/`epoch()` alone cannot
      // make here, since nothing else in this test was ever going to answer bob for real either —
      // he is still refusing commits exactly as test 2's genuinely-stranded bob does, not merely
      // un-healed by coincidence of timing.
      expect(bob.mls.epoch()).toBe(1)
      await bob.peer.enqueue(buildLedgerCommit(bob, ['role:zoe=admin']))
    } finally {
      vi.useRealTimers()
    }

    await bob.peer.dispose()
  })
})
