import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import { expect, test, vi } from 'vitest'

import { decodeCommitFrame } from '../src/commit-frame.js'
import type { CertifiedControlRange } from '../src/control/search.js'
import { asLogPosition } from '../src/cursor.js'
import { decodeHandshakeFrame } from '../src/handshake.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { makeMLSPeer } from './fixtures/peer.js'

test.each(['key', 'epoch', 'position', 'payload'] as const)(
  'bounded peer walk skips listed losers but classifies unlisted %s divergence',
  async (fault) => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(87)
    const mls = createMemoryGroupMLS({
      localDID: 'bob',
      recoverySecret: rs,
      epoch: 1,
      members: ['alice', 'bob', 'carol'],
    })
    const source = await mls.readRecoverySource()
    const winner = await publishCommit({ hub, senderDID: 'carol', recoverySecret: rs, epoch: 1 })
    const loser = await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: rs,
      epoch: 1,
      external: true,
    })
    const divergent = await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: rs,
      epoch: 1,
      adds: ['dave'],
      external: true,
    })
    let bounded = false
    const fetch = hub.fetchTopic.bind(hub)
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
      const page = await fetch(params)
      return bounded
        ? page
        : {
            ...page,
            messages: page.messages.filter((row) => row.sequenceID === winner.sequenceID),
            head: winner.sequenceID,
          }
    })
    const bob = makeMLSPeer(hub, 'bob', rs, { mls, members: ['alice', 'bob', 'carol'] })
    try {
      await vi.waitFor(async () =>
        expect((await bob.control.load()).cursor?.position).toBe(winner.sequenceID),
      )
      const applied = (await bob.control.load()).applied[0]
      if (applied === undefined) throw new Error('missing winner')
      const row = hub.published.find((entry) => entry.sequenceID === loser.sequenceID)
      if (row === undefined) throw new Error('missing loser')
      const range: CertifiedControlRange = {
        key: source.key,
        source: { ...source.key, epoch: source.epoch, authenticator: source.authenticator },
        from: null,
        through: asLogPosition(loser.sequenceID),
        winner: {
          position: asLogPosition(winner.sequenceID),
          payloadDigest: applied.payloadDigest,
        },
        losers: [
          { position: asLogPosition(loser.sequenceID), payloadDigest: toB64U(sha256(row.payload)) },
        ],
      }
      bounded = true
      const headers = vi.spyOn(mls, 'readCommitHeader')
      const work = { takeFetch: vi.fn(() => true), takeFrame: vi.fn(() => true) }
      await bob.controlWalk.walkCommits({ through: range.through, range, work })
      expect((await bob.control.load()).cursor?.position).toBe(loser.sequenceID)
      expect(bob.controlWalk.head()).toBe(loser.sequenceID)
      expect(headers).toHaveBeenCalledOnce()
      expect(work.takeFrame).toHaveBeenCalledOnce()
      expect((await bob.control.load()).responses).toEqual([])
      const divergentRow = hub.published.find((entry) => entry.sequenceID === divergent.sequenceID)
      if (divergentRow === undefined) throw new Error('missing divergence')
      const winnerRow = hub.published.find((entry) => entry.sequenceID === winner.sequenceID)
      if (winnerRow === undefined) throw new Error('missing winner frame')
      const nextRange: CertifiedControlRange = {
        ...range,
        key: fault === 'key' ? { ...range.key, incarnation: range.key.incarnation + 1 } : range.key,
        source: fault === 'epoch' ? { ...range.source, epoch: 2 } : range.source,
        through: asLogPosition(divergent.sequenceID),
        losers: [
          {
            position:
              fault === 'position'
                ? asLogPosition(loser.sequenceID)
                : asLogPosition(divergent.sequenceID),
            payloadDigest:
              fault === 'payload' ? 'different-bytes' : toB64U(sha256(divergentRow.payload)),
          },
        ],
      }
      const before = await bob.control.load()
      const head = bob.controlWalk.head()
      await bob.controlWalk.walkCommits({
        through: asLogPosition(divergent.sequenceID),
        range: nextRange,
        work,
      })
      const after = await bob.control.load()
      expect(after.forkHalt?.evidence).toEqual({
        kind: 'digest-divergence',
        epoch: 1,
        position: divergent.sequenceID,
        localDigest: toB64U(
          sha256(decodeCommitFrame(decodeHandshakeFrame(winnerRow.payload).payload).commit),
        ),
        remoteDigest: toB64U(
          sha256(decodeCommitFrame(decodeHandshakeFrame(divergentRow.payload).payload).commit),
        ),
      })
      expect(after.cursor).toEqual(before.cursor)
      expect(after.applied).toEqual(before.applied)
      expect(after.responses).toEqual(before.responses)
      expect(bob.controlWalk.head()).toBe(head)
      expect(headers).toHaveBeenCalledTimes(2)
    } finally {
      await bob.peer.dispose()
    }
  },
)

test('operation step refuses a retained expired intent whose outcome already landed', async () => {
  const hub = new FakeHub()
  const bob = makeMLSPeer(hub, 'bob', new Uint8Array(32).fill(87))
  try {
    await bob.peer.resync()
    const intent = {
      id: 'settled-operation',
      kind: 'rotation' as const,
      revokes: false,
      body: new TextEncoder().encode(JSON.stringify({ tokens: [] })),
      seq: 1,
      enqueuedAt: 0,
      deadline: 1,
      stage: 'intent' as const,
    }
    const landed = {
      id: intent.id,
      opID: intent.id,
      at: 1,
      kind: 'landed' as const,
      position: asLogPosition('000000000001'),
    }
    await bob.control.apply({ putOperations: [intent], putOutcomes: [landed] }, 'settled')
    const refusal = await bob.controlWalk.stepOperation(intent.id).then(
      () => null,
      (error: unknown) => error,
    )
    expect((await bob.control.load()).outcomes).toEqual([landed])
    expect(refusal).toEqual(new Error('Operation already settled'))
    expect((await bob.control.load()).operations).toEqual([intent])
    expect(hub.published).toEqual([])
  } finally {
    await bob.peer.dispose()
  }
})

test('operation step refuses missing and stale FIFO heads', async () => {
  const bob = makeMLSPeer(new FakeHub(), 'bob', new Uint8Array(32).fill(87))
  try {
    await bob.peer.resync()
    await expect(bob.controlWalk.stepOperation('missing')).rejects.toThrow(
      'Missing queued operation',
    )
    const head = {
      id: 'fifo-head',
      kind: 'rotation' as const,
      revokes: false,
      body: new TextEncoder().encode(JSON.stringify({ tokens: [] })),
      seq: 1,
      enqueuedAt: Date.now(),
      deadline: Date.now() + 30_000,
      stage: 'intent' as const,
    }
    const next = { ...head, id: 'fifo-next', seq: 2 }
    await bob.control.apply({ putOperations: [head, next] }, 'queue')
    await expect(bob.controlWalk.stepOperation(next.id)).rejects.toThrow(
      'Stale operation: not the durable FIFO head',
    )
    expect((await bob.control.load()).operations).toEqual([head, next])
    expect((await bob.control.load()).outcomes).toEqual([])
  } finally {
    await bob.peer.dispose()
  }
})
