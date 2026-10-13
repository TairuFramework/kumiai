import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import { afterEach, expect, test, vi } from 'vitest'

import { asLogPosition } from '../src/cursor.js'
import { GroupControlUnsettledError } from '../src/errors.js'
import { encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { encodeRecoveryConfirmRequest } from '../src/recovery.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit, publishedCommitDigest } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { encodeMemoryCommit, memoryEntryID } from './fixtures/memory-group-mls.js'
import {
  buildLedgerCommit,
  buildRejoinRecord,
  makeMLSPeer,
  seedBuiltOperation,
  type TestPeer,
} from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0x91)
const members = ['alice', 'bob', 'carol']
const peers: Array<TestPeer> = []
function member(hub: FakeHub, options: Parameters<typeof makeMLSPeer>[3] = {}) {
  const result = makeMLSPeer(hub, 'bob', secret, { members, ...options })
  peers.push(result)
  return result
}
afterEach(async () => {
  await Promise.all(peers.map(({ peer }) => peer.dispose()))
  await Promise.all(peers.splice(0).map(({ peer }) => peer.drained()))
  vi.restoreAllMocks()
})

test.each([false, true])(
  'incoming adoption commits row and cursor, ambiguous=%s',
  async (ambiguous) => {
    const hub = new FakeHub()
    const bob = member(hub)
    await bob.peer.replay()
    if (ambiguous) bob.database.commitThenRejectNext('save')
    else
      bob.database.seam('after-save', () => {
        void bob.peer.dispose()
      })
    const result = await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 1,
    })
    await vi.waitFor(async () => expect((await bob.control.load()).applied).toHaveLength(1))
    await bob.peer.dispose()
    await bob.peer.drained()
    const snapshot = await bob.control.load()
    const message = hub.published.find((row) => row.sequenceID === result.sequenceID)
    if (message == null) throw new Error('Missing commit')
    expect(snapshot.applied).toEqual([
      {
        epoch: 1,
        digest: publishedCommitDigest(hub, result.sequenceID),
        payloadDigest: toB64U(sha256(message.payload)),
        sequenceID: result.sequenceID,
        opID: null,
        removed: false,
      },
    ])
    expect(snapshot.cursor).toEqual({ position: result.sequenceID, epoch: 2 })
    const restarted = member(hub, { restartOf: bob })
    await restarted.peer.replay()
    expect(restarted.mls.epoch()).toBe(2)
    expect((await restarted.control.load()).applied).toEqual(snapshot.applied)
    await restarted.peer.dispose()
    await restarted.peer.drained()
    const observer = member(hub, { restartOf: restarted })
    await observer.peer.replay()
    const before = await observer.control.load()
    const conflict = await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 1,
      external: true,
      adds: ['dave'],
    })
    await vi.waitFor(async () => expect((await observer.control.load()).forkHalt).not.toBeNull())
    const after = await observer.control.load()
    expect(after.forkHalt?.evidence).toEqual({
      kind: 'digest-divergence',
      epoch: 1,
      position: conflict.sequenceID,
      localDigest: publishedCommitDigest(hub, result.sequenceID),
      remoteDigest: publishedCommitDigest(hub, conflict.sequenceID),
    })
    expect(after.responses).toEqual(before.responses)
    expect(after.cursor).toEqual(before.cursor)
    expect(after.applied).toEqual(before.applied)
  },
)

test('ambiguous acceptance writes one accepted operation and lands once', async () => {
  const hub = new FakeHub()
  const bob = member(hub)
  await bob.peer.replay()
  const request = buildLedgerCommit(bob, [])
  await seedBuiltOperation(bob, request)
  bob.database.commitThenRejectNext('apply')
  await bob.peer.replay()
  expect(await bob.peer.outcomes()).toEqual([
    expect.objectContaining({ opID: request.id, kind: 'landed' }),
  ])
  expect((await bob.control.load()).applied).toHaveLength(1)
  expect(hub.published.filter((row) => row.topicID === commitTopic(secret))).toHaveLength(1)
})

test('an adopted external response survives restart and answers confirmation', async () => {
  const hub = new FakeHub()
  const bob = member(hub, { recovery: { getDelayMs: () => 0 } })
  await bob.peer.replay()
  bob.database.seam('after-save', () => {
    void bob.peer.dispose()
  })
  const result = await publishCommit({
    hub,
    senderDID: 'carol',
    recoverySecret: secret,
    epoch: 1,
    external: true,
  })
  await vi.waitFor(async () => expect((await bob.control.load()).applied).toHaveLength(1))
  await bob.peer.dispose()
  await bob.peer.drained()
  const digest = publishedCommitDigest(hub, result.sequenceID)
  expect((await bob.control.load()).responses).toEqual([
    {
      position: result.sequenceID,
      epoch: 1,
      epochAfter: 2,
      digest,
      kind: 'applied',
    },
  ])
  const again = member(hub, { restartOf: bob, recovery: { getDelayMs: () => 0 } })
  await again.peer.replay()
  const requester = makeMLSPeer(hub, 'carol', secret, { members, epoch: 2 })
  peers.push(requester)
  const { request } = await requester.mls.createRecoveryRequest('durable-confirmation')
  const seal = vi.spyOn(again.mls, 'sealRecoveryVerdict')
  await hub.publish({
    senderDID: 'carol',
    topicID: rendezvousTopic(secret),
    payload: encodeHandshakeFrame(
      HANDSHAKE_KIND.recoveryConfirmRequest,
      encodeRecoveryConfirmRequest({
        requestID: 'durable-confirmation',
        request,
        position: result.sequenceID,
        commitDigest: digest,
      }),
    ),
  })
  await vi.waitFor(() =>
    expect(seal).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ verdict: 'confirmed', epoch: 2 }),
    ),
  )
})

test('responder refusal and cursor skip commit in one apply', async () => {
  const hub = new FakeHub()
  const bob = member(hub, { acceptsCommitter: () => false })
  await bob.peer.replay()
  bob.database.seam('after-apply', () => {
    void bob.peer.dispose()
  })
  const result = await publishCommit({
    hub,
    senderDID: 'carol',
    recoverySecret: secret,
    epoch: 1,
    external: true,
  })
  await vi.waitFor(async () => expect((await bob.control.load()).cursor).not.toBeNull())
  await bob.peer.dispose()
  await bob.peer.drained()
  expect(await bob.control.load()).toMatchObject({
    applied: [],
    cursor: { position: result.sequenceID, epoch: 1 },
    responses: [{ position: result.sequenceID, epoch: 1, kind: 'refused', reason: 'policy' }],
  })
  const again = member(hub, { restartOf: bob })
  await again.peer.replay()
  expect(again.mls.seen()).toBe(0)
})

test('an unresolvable external commit records refusal with its cursor skip', async () => {
  const hub = new FakeHub()
  const bob = member(hub)
  await bob.peer.replay()
  bob.database.seam('after-apply', () => {
    void bob.peer.dispose()
  })
  const result = await publishCommit({
    hub,
    senderDID: 'carol',
    recoverySecret: secret,
    epoch: 1,
    commit: encodeMemoryCommit(1, 'carol', [memoryEntryID('missing-body')], { external: true }),
  })
  await vi.waitFor(async () => expect((await bob.control.load()).cursor).not.toBeNull())
  await bob.peer.dispose()
  await bob.peer.drained()
  expect(await bob.control.load()).toMatchObject({
    applied: [],
    cursor: { position: result.sequenceID, epoch: 1 },
    responses: [{ position: result.sequenceID, epoch: 1, kind: 'refused', reason: 'invalid' }],
  })
})

test('self-removal committed before its effect is terminal on restart', async () => {
  const hub = new FakeHub()
  const bob = member(hub)
  await bob.peer.replay()
  await bob.appOutbox.put({
    seq: 1,
    protocol: 'chat',
    prc: 'chat/posted',
    data: new Uint8Array([1]),
    lastAttempt: null,
  })
  bob.database.seam('after-save', () => {
    void bob.peer.dispose()
  })
  await publishCommit({
    hub,
    senderDID: 'alice',
    recoverySecret: secret,
    epoch: 1,
    removes: ['bob'],
  })
  await vi.waitFor(async () => expect((await bob.control.load()).applied).toHaveLength(1))
  await bob.peer.dispose()
  await bob.peer.drained()
  expect((await bob.control.load()).applied).toEqual([
    expect.objectContaining({ epoch: 1, removed: true }),
  ])
  expect((await bob.anchorStore.load())?.pending?.landed).toBeUndefined()
  const request = buildLedgerCommit(bob, [])
  await bob.control.apply(
    {
      putOperations: [
        {
          ...request,
          stage: 'intent',
          seq: 1,
          enqueuedAt: Date.now(),
          deadline: Date.now() + 30_000,
        },
      ],
    },
    'post-removal-intent',
  )
  const cleared = vi.fn()
  const again = member(hub, { restartOf: bob, onAppOutboxCleared: cleared })
  await again.peer.outcomes()
  await vi.waitFor(async () => expect(await again.appOutbox.list()).toEqual([]))
  expect(await again.peer.outcomes()).toEqual([
    expect.objectContaining({ opID: request.id, kind: 'unknown' }),
  ])
  expect((await again.control.load()).operations).toEqual([])
  expect(await again.database.loadState('bob')).not.toBeNull()
  expect(cleared).toHaveBeenCalledTimes(1)
  await expect(again.peer.enqueue(buildLedgerCommit(again, []))).rejects.toMatchObject({
    name: 'PeerRemovedError',
  })
})

test('live self-removal keeps the anchor and clears its pending rotation', async () => {
  const hub = new FakeHub()
  const bob = member(hub)
  await bob.peer.replay()
  await publishCommit({
    hub,
    senderDID: 'alice',
    recoverySecret: secret,
    epoch: 1,
    removes: ['bob'],
  })
  await vi.waitFor(async () =>
    expect((await bob.control.load()).applied.at(-1)?.removed).toBe(true),
  )
  await vi.waitFor(async () => expect((await bob.anchorStore.load())?.pending).toBeUndefined())
  expect(bob.peer.anchorEpoch()).toBe(1)
  expect(bob.mls.epoch()).toBe(1)
})

test.each(['capture', 'keep', 'ambiguous'] as const)(
  'a failed %s anchor save keeps memory pending until durable resolution',
  async (mode) => {
    const hub = new FakeHub()
    const bob = member(hub)
    await bob.peer.replay()
    const save = bob.anchorStore.save
    let blocked = true
    bob.anchorStore.save = async (slot) => {
      if (slot.pending == null && blocked) {
        if (mode === 'ambiguous') await save(slot)
        throw new Error('resolved anchor unavailable')
      }
      await save(slot)
    }
    const result = await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 1,
      ...(mode === 'keep' ? {} : { adds: ['dave'] }),
    })
    await vi.waitFor(() => expect(bob.mls.epoch()).toBe(2))
    expect(bob.peer.anchorEpoch()).toBe(1)
    expect((await bob.control.load()).cursor?.position).toBe(result.sequenceID)
    if (mode !== 'ambiguous') expect((await bob.anchorStore.load())?.pending?.landed).toBe(true)
    blocked = false
    await bob.peer.replay()
    expect((await bob.anchorStore.load())?.pending).toBeUndefined()
    expect(bob.peer.anchorEpoch()).toBe(mode === 'keep' ? 1 : 2)
    await bob.peer.protocol('chat').dispatch('chat/changed', { data: {} })
  },
)

test('host deletion is refused until abandon and outcome acknowledgement', async () => {
  const hub = new FakeHub()
  const bob = member(hub, { deliverWelcome: async () => {} })
  await bob.peer.replay()
  const request = buildLedgerCommit(bob, [])
  const rejoin = await buildRejoinRecord(bob)
  await bob.control.apply(
    {
      putRejoin: rejoin,
      putOperations: [
        {
          ...request,
          seq: 1,
          enqueuedAt: Date.now(),
          deadline: Date.now() + 30_000,
          stage: 'intent',
        },
      ],
      putWelcomes: [
        { opID: request.id, welcome: new Uint8Array([1]), recipients: ['carol'], committed: true },
      ],
    },
    'unsettled',
  )
  await expect(bob.database.delete('bob')).rejects.toBeInstanceOf(GroupControlUnsettledError)
  await bob.peer.abandon()
  expect(await bob.control.load()).toMatchObject({
    operations: [],
    welcomes: [{ opID: request.id, committed: true }],
    rejoin: null,
  })
  const outcomes = await bob.peer.outcomes()
  expect(outcomes).toEqual([
    expect.objectContaining({ opID: request.id, kind: 'unknown' }),
    expect.objectContaining({ id: rejoin.id, opID: null, kind: 'unknown' }),
  ])
  await expect(bob.database.delete('bob')).rejects.toBeInstanceOf(GroupControlUnsettledError)
  for (const outcome of outcomes) await bob.peer.ack(outcome.id)
  await bob.peer.dispose()
  await bob.peer.drained()
  const again = member(hub, { restartOf: bob, deliverWelcome: async () => {} })
  await again.peer.replay()
  await expect.poll(async () => (await bob.control.load()).welcomes).toEqual([])
  await bob.database.delete('bob')
  expect(await bob.database.loadState('bob')).toBeNull()
})

test('the registry resolves ambiguous incoming adoption before publishing the live handle', async () => {
  const hub = new FakeHub()
  const bob = member(hub)
  await bob.peer.replay()
  bob.database.commitThenRejectNext('save')
  await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
  await vi.waitFor(() => expect(bob.mls.epoch()).toBe(2))
  await vi.waitFor(async () => expect((await bob.anchorStore.load())?.pending).toBeUndefined())
  expect((await bob.control.load()).applied).toHaveLength(1)
  await bob.peer.replay()
  expect(bob.mls.commits()).toBe(1)
})

test('incoming adoption co-settles a matching accepted operation and reports it once', async () => {
  const hub = new FakeHub()
  const seed = member(hub)
  await seed.peer.replay()
  const request = buildLedgerCommit(seed, [])
  const op = await seedBuiltOperation(seed, request, '000000000001')
  if (op.stage !== 'accepted') throw new Error('Missing accepted operation')
  await seed.peer.dispose()
  await seed.peer.drained()
  const result = await hub.publish({
    senderDID: 'alice',
    topicID: commitTopic(secret),
    payload: op.slot.payload,
    publishID: op.slot.publishID,
    expectedHead: op.slot.expectedHead,
    retain: 'log',
  })
  const notice = vi.fn()
  const again = member(hub, { restartOf: seed, onOutcome: notice })
  await again.peer.replay()
  expect(await again.control.load()).toMatchObject({
    operations: [],
    applied: [{ opID: request.id, sequenceID: result.sequenceID, removed: false }],
    outcomes: [{ opID: request.id, kind: 'landed', position: result.sequenceID }],
    cursor: { position: result.sequenceID, epoch: 2 },
  })
  expect(notice).toHaveBeenCalledTimes(1)
})

test('adoptions retain exactly the newest 64 epochs of rows and responses', async () => {
  const hub = new FakeHub()
  for (let epoch = 1; epoch <= 65; epoch++) {
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch, external: true })
  }
  const bob = member(hub)
  await bob.peer.replay()
  const snapshot = await bob.control.load()
  const epochs = Array.from({ length: 64 }, (_, index) => index + 2)
  expect(snapshot.applied.map((row) => row.epoch)).toEqual(epochs)
  expect(snapshot.responses.map((row) => row.epoch)).toEqual(epochs)
  expect(snapshot.cursor).toMatchObject({ epoch: 66 })
  await bob.peer.dispose()
  await bob.peer.drained()
  const again = member(hub, { restartOf: bob })
  await again.peer.replay()
  const old = await publishCommit({
    hub,
    senderDID: 'alice',
    recoverySecret: secret,
    epoch: 1,
    external: true,
    adds: ['old'],
  })
  await vi.waitFor(async () =>
    expect((await again.control.load()).cursor?.position).toBe(old.sequenceID),
  )
  expect((await again.control.load()).responses).toHaveLength(64)
  const conflict = await publishCommit({
    hub,
    senderDID: 'alice',
    recoverySecret: secret,
    epoch: 2,
    external: true,
    adds: ['conflict'],
  })
  await vi.waitFor(async () => expect((await again.control.load()).forkHalt).not.toBeNull())
  const halted = await again.control.load()
  expect(halted.forkHalt?.evidence).toMatchObject({
    kind: 'digest-divergence',
    epoch: 2,
    position: conflict.sequenceID,
  })
  expect(halted.responses).toEqual(snapshot.responses)
  expect(halted.cursor).toEqual({ position: old.sequenceID, epoch: 66 })
  expect((await again.control.load()).applied).toEqual(snapshot.applied)
})

test.each([false, true])(
  'terminal removal settles a pending rejoin before Welcome delivery, accepted=%s',
  async (accepted) => {
    const hub = new FakeHub()
    const bob = member(hub)
    await bob.peer.replay()
    const rejoin = await buildRejoinRecord(bob)
    await bob.peer.dispose()
    await bob.peer.drained()
    await bob.control.apply(
      {
        putRejoin: rejoin,
        putWelcomes: [
          { opID: rejoin.id, welcome: rejoin.payload, recipients: ['carol'], committed: true },
        ],
        putApplied: [
          {
            epoch: 1,
            digest: rejoin.digest,
            payloadDigest: rejoin.payloadDigest,
            sequenceID: '000000000001',
            opID: null,
            removed: true,
          },
        ],
      },
      'terminal-rejoin',
    )
    bob.mls.adopt(bob.mls.buildCommit([], { removes: ['bob'] }))
    await bob.database.saveState('bob', bob.mls.serializeState())
    const settledBeforeDelivery = vi.fn()
    const subscribe = vi.spyOn(hub, 'subscribe')
    const again = member(hub, {
      restartOf: bob,
      deliverWelcome: async () => {
        settledBeforeDelivery(await bob.control.load())
        if (!accepted) throw new Error('Invitation transport unavailable')
      },
    })
    const exported = vi.spyOn(again.crypto, 'exportSecret')
    const outcome = { id: rejoin.id, opID: null, kind: 'unknown' }
    expect(await again.peer.outcomes()).toEqual([expect.objectContaining(outcome)])
    await vi.waitFor(() => expect(settledBeforeDelivery).toHaveBeenCalledTimes(1))
    expect(settledBeforeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        rejoin: null,
        outcomes: [expect.objectContaining(outcome)],
        welcomes: [expect.objectContaining({ opID: rejoin.id })],
      }),
    )
    await vi.waitFor(async () => {
      expect(await again.control.load()).toMatchObject({
        rejoin: null,
        welcomes: accepted ? [] : [{ opID: rejoin.id }],
      })
    })
    expect(exported).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
  },
)

test('a moved accepted own slot rechecks proof and lands on restart', async () => {
  const hub = new FakeHub()
  const bob = member(hub, { adopt: async () => 'moved' })
  await bob.peer.replay()
  const request = buildLedgerCommit(bob, [])
  const op = await seedBuiltOperation(bob, request)
  const result = await hub.publish({
    senderDID: 'alice',
    topicID: commitTopic(secret),
    payload: op.slot.payload,
    publishID: op.slot.publishID,
    expectedHead: op.slot.expectedHead,
    retain: 'log',
  })
  await vi.waitFor(async () =>
    expect((await bob.control.load()).operations[0]?.stage).toBe('accepted'),
  )
  await bob.peer.dispose()
  await bob.peer.drained()
  const again = member(hub, { restartOf: bob })
  await again.peer.replay()
  expect(await again.peer.outcomes()).toEqual([
    expect.objectContaining({ opID: request.id, kind: 'landed' }),
  ])
  expect((await again.control.load()).applied).toEqual([
    expect.objectContaining({
      epoch: 1,
      payloadDigest: op.slot.payloadDigest,
      sequenceID: result.sequenceID,
      opID: request.id,
    }),
  ])
  expect((await again.control.load()).cursor?.position).toBe(asLogPosition(result.sequenceID))
})

test('a moved acceptance with rewrapped payload stays accepted and strands the peer', async () => {
  const hub = new FakeHub()
  const bob = member(hub, { adopt: async () => 'moved' })
  await bob.peer.replay()
  const result = await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
  await vi.waitFor(() => expect(bob.mls.epoch()).toBe(2))
  const op = await seedBuiltOperation(bob, buildLedgerCommit(bob, []), result.sequenceID)
  if (op.stage !== 'accepted') throw new Error('Missing acceptance')
  const snapshot = await bob.control.load()
  const row = snapshot.applied[0]
  if (row == null) throw new Error('Missing incoming adoption')
  expect(op.built.payloadDigest).not.toBe(row.payloadDigest)
  const accepted = { ...op, built: { ...op.built, epoch: 1 } }
  await bob.control.apply({ putOperations: [accepted] }, 'rewrapped-acceptance')
  await bob.peer.replay()
  expect(await bob.control.load()).toMatchObject({
    operations: [accepted],
    outcomes: [],
    applied: snapshot.applied,
    forkHalt: {
      evidence: {
        kind: 'digest-divergence',
        epoch: 1,
        position: row.sequenceID,
        localDigest: row.payloadDigest,
        remoteDigest: accepted.built.payloadDigest,
      },
    },
    strand: snapshot.strand,
    cursor: snapshot.cursor,
  })
  await expect(bob.peer.enqueue(buildLedgerCommit(bob, []))).rejects.toMatchObject({
    name: 'GroupSafetyHeldError',
    reason: 'fork-halted',
  })
  const held = await bob.control.load()
  const recoveryRequests = () =>
    hub.published.filter(
      (message) => message.topicID === rendezvousTopic(secret) && message.senderDID === 'bob',
    )
  expect(recoveryRequests()).toEqual([])
  await bob.peer.dispose()
  await bob.peer.drained()
  hub.trim(commitTopic(secret), '999999999999')
  const again = member(hub, { restartOf: bob })
  await again.peer.replay()
  const restarted = await again.control.load()
  expect(restarted.controlHold).toEqual(held.controlHold)
  expect(restarted.strand).toEqual(held.strand)
  expect(restarted.cursor).toEqual(held.cursor)
  expect(restarted.commitOnce).toEqual(held.commitOnce)
  expect(recoveryRequests()).toEqual([])
})
