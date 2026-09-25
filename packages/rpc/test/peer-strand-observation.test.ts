import { describe, expect, test, vi } from 'vitest'

import { COMMIT_FRAME_VERSION, encodeCommitFrame } from '../src/commit-frame.js'
import {
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  HANDSHAKE_MAGIC,
  HANDSHAKE_VERSION,
} from '../src/handshake.js'
import type { RecoveryEvent, StrandObservation } from '../src/peer.js'
import { commitTopic } from '../src/topic.js'
import { publishCommit, publishedCommitDigest } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import {
  createMemoryGroupMLS,
  decodeMemoryCommit,
  encodeMemoryCommit,
} from './fixtures/memory-group-mls.js'
import { makeMLSPeer } from './fixtures/peer.js'

const recovery = { timeoutMs: 10, deadlineMs: 30, getDelayMs: () => 0 }
const members = ['alice', 'bob', 'carol']
const secret = (byte: number) => new Uint8Array(32).fill(byte)

async function publishUnreadable(
  hub: FakeHub,
  rs: Uint8Array,
  layer: 'handshake' | 'commit-frame',
): Promise<string> {
  const payload = encodeCommitFrame(new Uint8Array([1]), new Uint8Array())
  if (layer === 'commit-frame') payload[0] = COMMIT_FRAME_VERSION + 1
  const frame = encodeHandshakeFrame(HANDSHAKE_KIND.commit, payload)
  if (layer === 'handshake') {
    frame[HANDSHAKE_MAGIC.length] = HANDSHAKE_VERSION + 1
    frame[HANDSHAKE_MAGIC.length + 1] = 0xee
  }
  return (
    await hub.publish({ senderDID: 'zoe', topicID: commitTopic(rs), payload: frame, retain: 'log' })
  ).sequenceID
}

describe('commit strand observations', () => {
  test.each(['losing', 'winning'] as const)(
    '%s fork reports only when this peer loses',
    async (branch) => {
      const hub = new FakeHub()
      hub.acceptAtAnyHead()
      const rs = secret(branch === 'losing' ? 0x97 : 0x98)
      const winner = await publishCommit({
        hub,
        senderDID: 'carol',
        recoverySecret: rs,
        epoch: 1,
        entries: ['role:carol=admin'],
      })
      const loser = await publishCommit({
        hub,
        senderDID: 'alice',
        recoverySecret: rs,
        epoch: 1,
        entries: ['role:alice=admin'],
      })
      const hidden = branch === 'losing' ? winner : loser
      hub.hideFrom('bob', hidden.sequenceID)
      const observations: Array<StrandObservation> = []
      const bob = makeMLSPeer(hub, 'bob', rs, {
        members,
        recovery,
        onStrand: (o) => {
          observations.push(o)
        },
      })
      await vi.waitFor(() => expect(bob.mls.epoch()).toBe(2))
      hub.revealTo('bob', hidden.sequenceID)
      await hub.publish({
        senderDID: 'zoe',
        topicID: commitTopic(rs),
        payload: new Uint8Array([0]),
      })
      if (branch === 'losing') {
        await vi.waitFor(() => expect(observations).toHaveLength(1))
        expect(observations[0]).toEqual({
          groupID: commitTopic(rs),
          position: winner.sequenceID,
          commitDigest: publishedCommitDigest(hub, winner.sequenceID),
          localEpoch: 2,
          claimedEpoch: 1,
          kind: 'fork-losing',
          confidence: 'observed',
        })
      } else {
        await bob.peer.replay()
        expect(observations).toEqual([])
      }
      await bob.peer.dispose()
    },
  )

  test('own unmerged commit reports authenticated evidence once across pulls', async () => {
    const hub = new FakeHub()
    const rs = secret(0x91)
    const { sequenceID } = await publishCommit({
      hub,
      senderDID: 'bob',
      recoverySecret: rs,
      epoch: 1,
    })
    const observations: Array<StrandObservation> = []
    const recoveries: Array<RecoveryEvent> = []
    const bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery,
      onStrand: (o) => {
        observations.push(o)
      },
      onRecovery: (event) => {
        recoveries.push(event)
      },
    })
    await vi.waitFor(() => expect(observations).toHaveLength(1))
    expect(observations[0]).toEqual({
      groupID: commitTopic(rs),
      position: sequenceID,
      commitDigest: publishedCommitDigest(hub, sequenceID),
      localEpoch: 1,
      claimedEpoch: 1,
      kind: 'own-unmerged',
      confidence: 'authenticated',
    })
    await vi.waitFor(() =>
      expect(recoveries.filter((event) => event.phase === 'failed')).toHaveLength(1),
    )
    for (const expected of [2, 3]) {
      await hub.publish({
        senderDID: 'zoe',
        topicID: commitTopic(rs),
        payload: new Uint8Array([0]),
      })
      await vi.waitFor(() =>
        expect(recoveries.filter((event) => event.phase === 'failed')).toHaveLength(expected),
      )
    }
    expect(observations).toHaveLength(1)
    await bob.peer.dispose()
  })

  test('tampered commit content with valid own sender data remains authenticated and heals', async () => {
    const hub = new FakeHub()
    const rs = secret(0x9a)
    const original = decodeMemoryCommit(encodeMemoryCommit(1, 'bob'))
    if (original == null) throw new Error('missing memory commit')
    // The port double models a ciphertext edit beyond the sender-data sample: authorship is
    // still readable, while the commit content is invalid and cannot be processed.
    const tampered = new TextEncoder().encode(JSON.stringify({ ...original, invalidContent: true }))
    const reader = createMemoryGroupMLS({ recoverySecret: rs, epoch: 1, localDID: 'carol' })
    expect(await reader.readCommitHeader(tampered)).toEqual({ epoch: 1, committerDID: 'bob' })
    expect(await reader.processCommit(tampered, {})).toEqual({ advanced: false })

    const { sequenceID } = await publishCommit({
      hub,
      senderDID: 'zoe',
      recoverySecret: rs,
      epoch: 1,
      commit: tampered,
    })
    const observations: Array<StrandObservation> = []
    const recoveries: Array<RecoveryEvent> = []
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const bob = makeMLSPeer(hub, 'bob', rs, {
        members,
        recovery,
        onStrand: (observation) => {
          observations.push(observation)
        },
        onRecovery: (event) => {
          recoveries.push(event)
        },
      })
      await vi.waitFor(() => expect(observations).toHaveLength(1))
      expect(observations[0]).toEqual({
        groupID: commitTopic(rs),
        position: sequenceID,
        commitDigest: publishedCommitDigest(hub, sequenceID),
        localEpoch: 1,
        claimedEpoch: 1,
        kind: 'own-unmerged',
        confidence: 'authenticated',
      })
      await vi.waitFor(() =>
        expect(recoveries.some((event) => event.phase === 'started')).toBe(true),
      )
      await vi.waitFor(() =>
        expect(
          recoveries.some((event) => event.phase === 'failed' && event.reason === 'no-responder'),
        ).toBe(true),
      )
      await bob.peer.dispose()
    } finally {
      now.mockRestore()
    }
  })

  test('many ahead frames across pulls report one claimed observation', async () => {
    const hub = new FakeHub()
    const rs = secret(0x92)
    const first = await publishCommit({ hub, senderDID: 'zoe', recoverySecret: rs, epoch: 3 })
    const second = await publishCommit({ hub, senderDID: 'zoe', recoverySecret: rs, epoch: 4 })
    const observations: Array<StrandObservation> = []
    const recoveries: Array<RecoveryEvent> = []
    const bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery,
      onStrand: (o) => {
        observations.push(o)
      },
      onRecovery: (event) => {
        recoveries.push(event)
      },
    })
    await vi.waitFor(() => expect(observations).toHaveLength(1))
    expect(observations[0]).toEqual({
      groupID: commitTopic(rs),
      position: first.sequenceID,
      commitDigest: publishedCommitDigest(hub, first.sequenceID),
      localEpoch: 1,
      claimedEpoch: 3,
      kind: 'ahead',
      confidence: 'claimed',
    })
    await vi.waitFor(() =>
      expect(recoveries.filter((event) => event.phase === 'failed')).toHaveLength(1),
    )
    await publishCommit({ hub, senderDID: 'zoe', recoverySecret: rs, epoch: 5 })
    await vi.waitFor(() =>
      expect(recoveries.filter((event) => event.phase === 'failed')).toHaveLength(2),
    )
    expect(observations).toHaveLength(1)
    expect(second.sequenceID).not.toBe(first.sequenceID)
    await bob.peer.dispose()
  })

  test.each(['handshake', 'commit-frame'] as const)(
    '%s future version has no readable epoch or digest',
    async (layer) => {
      const hub = new FakeHub()
      const rs = secret(layer === 'handshake' ? 0x93 : 0x94)
      const position = await publishUnreadable(hub, rs, layer)
      const observations: Array<StrandObservation> = []
      const bob = makeMLSPeer(hub, 'bob', rs, {
        members,
        recovery,
        onStrand: (o) => {
          observations.push(o)
        },
      })
      await vi.waitFor(() => expect(observations).toHaveLength(1))
      expect(observations[0]).toEqual({
        groupID: commitTopic(rs),
        position,
        commitDigest: null,
        localEpoch: 1,
        claimedEpoch: null,
        kind: 'unknown-version',
        confidence: 'claimed',
      })
      await bob.peer.dispose()
    },
  )

  test('later own evidence upgrades an open ahead episode once', async () => {
    const hub = new FakeHub()
    const rs = secret(0x95)
    await publishCommit({ hub, senderDID: 'zoe', recoverySecret: rs, epoch: 3 })
    const observations: Array<StrandObservation> = []
    const bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery,
      onStrand: (o) => {
        observations.push(o)
      },
    })
    await vi.waitFor(() => expect(observations).toHaveLength(1))
    await publishCommit({ hub, senderDID: 'bob', recoverySecret: rs, epoch: 1 })
    await hub.publish({ senderDID: 'zoe', topicID: commitTopic(rs), payload: new Uint8Array([0]) })
    await vi.waitFor(() => expect(observations).toHaveLength(2))
    expect(observations.map((o) => o.kind)).toEqual(['ahead', 'own-unmerged'])
    await bob.peer.replay()
    expect(observations).toHaveLength(2)
    await bob.peer.dispose()
  })

  test('current unknown kind and malformed commit are silent', async () => {
    const hub = new FakeHub()
    const rs = secret(0x96)
    const unknown = new Uint8Array([...HANDSHAKE_MAGIC, HANDSHAKE_VERSION, 0xee, 9])
    await hub.publish({
      senderDID: 'zoe',
      topicID: commitTopic(rs),
      payload: unknown,
      retain: 'log',
    })
    await hub.publish({
      senderDID: 'zoe',
      topicID: commitTopic(rs),
      payload: encodeHandshakeFrame(HANDSHAKE_KIND.commit, new Uint8Array([COMMIT_FRAME_VERSION])),
      retain: 'log',
    })
    const observations: Array<StrandObservation> = []
    const bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery,
      onStrand: (o) => {
        observations.push(o)
      },
    })
    await bob.peer.replay()
    expect(observations).toEqual([])
    await bob.peer.dispose()
  })

  test('applied commits and replayed history never open an episode', async () => {
    const hub = new FakeHub()
    const rs = secret(0x99)
    const first = await publishCommit({ hub, senderDID: 'carol', recoverySecret: rs, epoch: 1 })
    const original = hub.published.find((message) => message.sequenceID === first.sequenceID)
    if (original == null) throw new Error('missing published commit')
    await hub.publish({
      senderDID: 'carol',
      topicID: commitTopic(rs),
      payload: original.payload,
      retain: 'log',
    })
    const observations: Array<StrandObservation> = []
    const bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery,
      onStrand: (o) => {
        observations.push(o)
      },
    })
    await vi.waitFor(() => expect(bob.mls.epoch()).toBe(2))
    await bob.peer.replay()
    expect(observations).toEqual([])
    await bob.peer.dispose()
  })
})
