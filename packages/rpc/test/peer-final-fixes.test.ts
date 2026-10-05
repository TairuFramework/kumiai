import { afterEach, expect, test, vi } from 'vitest'

import { digestAppliedCommit } from '../src/classify.js'
import { decodeCommitFrame } from '../src/commit-frame.js'
import { decodeHandshakeFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import type { RecoveryEvent, StrandObservation } from '../src/peer.js'
import { encodeRecoveryConfirmRequest } from '../src/recovery.js'
import { APP_TOPIC_LABEL, commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryAppOutbox } from './fixtures/outbox.js'
import { buildLedgerCommit, makeMLSPeer, type TestPeer } from './fixtures/peer.js'
import { controlRecoveryClock, drainUntil } from './fixtures/recovery-clock.js'

const secret = new Uint8Array(32).fill(19)
const peers: Array<TestPeer> = []
afterEach(async () => {
  await Promise.all(
    peers.splice(0).map(async ({ peer }) => {
      await peer.dispose()
      await peer.drained()
    }),
  )
  vi.restoreAllMocks()
})
function member(hub: FakeHub, options: Parameters<typeof makeMLSPeer>[3] = {}) {
  const peer = makeMLSPeer(hub, 'bob', secret, options)
  peers.push(peer)
  return peer
}

test('a mismatched durable commit cursor is discarded before the first fetch', async () => {
  controlRecoveryClock()
  const hub = new FakeHub()
  const store = createMemoryAppOutbox()
  await store.putCommitCursor({ position: 'stale-position', epoch: 8 })
  const fetch = vi.spyOn(hub, 'fetchTopic')
  const bob = member(hub, { appOutbox: store, epoch: 1 })
  await bob.peer.resync()
  const calls = fetch.mock.calls
    .map(([params]) => params)
    .filter((params) => params.topicID === commitTopic(secret))
  expect(calls.length).toBeGreaterThan(0)
  expect(calls[0]?.after).toBeUndefined()
  expect(await store.getCommitCursor()).toBeNull()
})

test('a restart at the same epoch rediscovers a strand the durable cursor never stepped over', async () => {
  controlRecoveryClock()
  const hub = new FakeHub()
  const store = createMemoryAppOutbox()
  const recovery = { timeoutMs: 50, deadlineMs: 100, getDelayMs: () => 60_000 }
  const strands: Array<StrandObservation> = []
  const bob = member(hub, {
    appOutbox: store,
    members: ['alice', 'bob'],
    recovery,
    onStrand: (observation) => {
      strands.push(observation)
    },
  })
  await bob.peer.resync()
  const applied = await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
  await drainUntil(async () => (await bob.mls.readEpoch()) === 2, 'applied commit')
  expect(await store.getCommitCursor()).toEqual({ position: applied.sequenceID, epoch: 2 })
  const ahead = await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 5 })
  await drainUntil(() => strands.length === 1, 'ahead strand')
  expect(strands[0]).toMatchObject({ position: ahead.sequenceID, kind: 'ahead' })
  expect(await store.getCommitCursor()).toEqual({
    position: applied.sequenceID,
    epoch: 2,
    stranded: true,
  })
  await bob.peer.dispose()
  await bob.peer.drained()
  peers.splice(peers.indexOf(bob), 1)
  const restarted: Array<StrandObservation> = []
  const again = member(hub, {
    restartOf: bob,
    recovery,
    onStrand: (observation) => {
      restarted.push(observation)
    },
  })
  await again.peer.resync()
  await drainUntil(() => restarted.length === 1, 'rediscovered strand')
  expect(restarted[0]).toMatchObject({ position: ahead.sequenceID, kind: 'ahead' })
})

test('a losing fork strand survives a restart through the durable cursor', async () => {
  const hub = new FakeHub()
  hub.acceptAtAnyHead()
  const members = ['alice', 'bob', 'carol']
  const recovery = { timeoutMs: 10, deadlineMs: 30, getDelayMs: () => 60_000 }
  const winner = await publishCommit({
    hub,
    senderDID: 'carol',
    recoverySecret: secret,
    epoch: 1,
    entries: ['role:carol=admin'],
  })
  const loser = await publishCommit({
    hub,
    senderDID: 'alice',
    recoverySecret: secret,
    epoch: 1,
    entries: ['role:alice=admin'],
  })
  hub.hideFrom('bob', winner.sequenceID)
  const store = createMemoryAppOutbox()
  const strands: Array<StrandObservation> = []
  const bob = member(hub, {
    appOutbox: store,
    members,
    recovery,
    onStrand: (observation) => {
      strands.push(observation)
    },
  })
  await vi.waitFor(() => expect(bob.mls.epoch()).toBe(2))
  expect(await store.getCommitCursor()).toEqual({ position: loser.sequenceID, epoch: 2 })
  hub.revealTo('bob', winner.sequenceID)
  await hub.publish({
    senderDID: 'zoe',
    topicID: commitTopic(secret),
    payload: new Uint8Array([0]),
  })
  await vi.waitFor(() => expect(strands.map((strand) => strand.kind)).toEqual(['fork-losing']))
  expect(await store.getCommitCursor()).toMatchObject({ epoch: 2, stranded: true })
  await bob.peer.dispose()
  await bob.peer.drained()
  peers.splice(peers.indexOf(bob), 1)
  const recoveries: Array<RecoveryEvent> = []
  const again = member(hub, {
    restartOf: bob,
    members,
    recovery,
    onRecovery: (event) => {
      recoveries.push(event)
    },
  })
  await again.peer.resync()
  await vi.waitFor(() => expect(recoveries.some((event) => event.phase === 'started')).toBe(true))
})

test('a rejoin that lands on the stranded epoch number clears the strand', async () => {
  controlRecoveryClock(5)
  const hub = new FakeHub()
  const members = ['alice', 'bob', 'carol']
  const recovery = { timeoutMs: 60, deadlineMs: 250, getDelayMs: () => 5 }
  const carol = makeMLSPeer(hub, 'carol', secret, { epoch: 2, members, recovery })
  peers.push(carol)
  await carol.peer.resync()
  // Bob stranded on a losing branch one epoch past the group: the rejoin lands on epoch 3 again.
  const store = createMemoryAppOutbox()
  await store.putCommitCursor({ position: null, epoch: 3, stranded: true })
  const events: Array<RecoveryEvent> = []
  const bob = member(hub, {
    appOutbox: store,
    epoch: 3,
    members,
    recovery,
    onRecovery: (event) => {
      events.push(event)
    },
  })
  await drainUntil(() => events.some((event) => event.phase === 'succeeded'), 'rejoin')
  expect(await bob.mls.readEpoch()).toBe(3)
  expect((await store.getCommitCursor())?.stranded).toBeUndefined()
  await bob.peer.commit(buildLedgerCommit(bob, []))
  expect(await bob.mls.readEpoch()).toBe(4)
})

test('a rejoin that lands on the same epoch number captures a new app anchor', async () => {
  controlRecoveryClock(5)
  const hub = new FakeHub()
  const members = ['alice', 'bob', 'carol']
  const recovery = { timeoutMs: 60, deadlineMs: 250, getDelayMs: () => 5 }
  const carol = makeMLSPeer(hub, 'carol', secret, { epoch: 2, members, recovery })
  peers.push(carol)
  await carol.peer.resync()
  const bob = member(hub, { epoch: 3, members, recovery })
  await bob.peer.resync()
  const exportSecret = vi.spyOn(bob.crypto, 'exportSecret')
  expect((await bob.peer.recover()).advanced).toBe(true)
  expect(await bob.mls.readEpoch()).toBe(3)
  // The forced rotation landed on the same number: the app anchor is captured again, not kept.
  expect(exportSecret).toHaveBeenCalledWith(APP_TOPIC_LABEL)
})

test('an ambiguous same-number anchor record found at startup asks for confirmed recovery', async () => {
  controlRecoveryClock()
  const hub = new FakeHub()
  const recovery = { timeoutMs: 50, deadlineMs: 100, getDelayMs: () => 60_000 }
  const bob = member(hub, { members: ['alice', 'bob'], recovery })
  await bob.peer.resync()
  await bob.peer.dispose()
  await bob.peer.drained()
  peers.splice(peers.indexOf(bob), 1)
  const slot = await bob.anchorStore.load()
  if (slot == null) throw new Error('Missing anchor')
  // A forced rejoin that would land on its old epoch number, interrupted before it resolved.
  await bob.anchorStore.save({
    anchor: slot.anchor,
    pending: {
      epochBefore: 1,
      epochAfter: 1,
      rosterBefore: ['alice', 'bob'],
      forced: true,
      advance: 'same-number-rejoin',
    },
  })
  const events: Array<RecoveryEvent> = []
  const again = member(hub, {
    restartOf: bob,
    members: ['alice', 'bob'],
    recovery,
    onRecovery: (event) => {
      events.push(event)
    },
  })
  await drainUntil(() => events.some((event) => event.phase === 'started'), 'recovery start')
  await expect(again.peer.commit(buildLedgerCommit(again, []))).rejects.toThrow(
    'app anchor requires confirmed recovery',
  )
})

test('incomplete ledgers skip commit processing and later wakeups can retry', async () => {
  controlRecoveryClock()
  const hub = new FakeHub()
  const bob = member(hub, { recovery: { timeoutMs: 50, deadlineMs: 100, getDelayMs: () => 0 } })
  await bob.peer.resync()
  const requests = vi.spyOn(bob.mls, 'createRecoveryRequest')
  const process = vi.spyOn(bob.mls, 'processCommit')
  const complete = vi.spyOn(bob.mls, 'isLedgerComplete').mockResolvedValue(false)
  vi.spyOn(bob.mls, 'openSealedLedger').mockResolvedValue(null)
  await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
  const retry = bob.peer.resync()
  await drainUntil(() => complete.mock.calls.length > 0, 'ledger check')
  await vi.advanceTimersByTimeAsync(50)
  await retry
  expect(requests).toHaveBeenCalledWith(expect.any(String), 100)
  expect(process).not.toHaveBeenCalled()
  expect(await bob.mls.readEpoch()).toBe(1)
  complete.mockResolvedValue(true)
  // The next commit delivery is the later wakeup: its pull walks the skipped commit as well.
  await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 2 })
  await drainUntil(() => process.mock.calls.length === 2, 'retried commit processing')
  expect(await bob.mls.readEpoch()).toBe(3)
})

test('an incomplete ledger retries the skipped commit on its own backoff in a quiet group', async () => {
  controlRecoveryClock()
  const hub = new FakeHub()
  const bob = member(hub, { recovery: { timeoutMs: 50, deadlineMs: 100, getDelayMs: () => 0 } })
  await bob.peer.resync()
  const process = vi.spyOn(bob.mls, 'processCommit')
  const complete = vi.spyOn(bob.mls, 'isLedgerComplete').mockResolvedValue(false)
  vi.spyOn(bob.mls, 'openSealedLedger').mockResolvedValue(null)
  await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
  await drainUntil(() => complete.mock.calls.length > 0, 'ledger check')
  await vi.advanceTimersByTimeAsync(100)
  expect(process).not.toHaveBeenCalled()
  // No later delivery: the responder comes back and only the retry timer can find it.
  complete.mockResolvedValue(true)
  await vi.advanceTimersByTimeAsync(1000)
  await drainUntil(() => process.mock.calls.length === 1, 'retried commit processing')
  expect(await bob.mls.readEpoch()).toBe(2)
})

test('a strand found by the ledger retry starts a heal', async () => {
  controlRecoveryClock()
  const hub = new FakeHub()
  const events: Array<RecoveryEvent> = []
  const bob = member(hub, {
    recovery: { timeoutMs: 50, deadlineMs: 100, getDelayMs: () => 0 },
    onRecovery: (event) => {
      events.push(event)
    },
  })
  await bob.peer.resync()
  const complete = vi.spyOn(bob.mls, 'isLedgerComplete').mockResolvedValue(false)
  vi.spyOn(bob.mls, 'openSealedLedger').mockResolvedValue(null)
  await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 5 })
  await drainUntil(() => complete.mock.calls.length > 0, 'ledger check')
  await vi.advanceTimersByTimeAsync(100)
  expect(events).toEqual([])
  complete.mockResolvedValue(true)
  await vi.advanceTimersByTimeAsync(1000)
  await drainUntil(() => events.some((event) => event.phase === 'started'), 'heal start')
})

test('a walker without an applied epoch record stays silent for an external history commit', async () => {
  controlRecoveryClock()
  const hub = new FakeHub()
  const published = await publishCommit({
    hub,
    senderDID: 'alice',
    recoverySecret: secret,
    epoch: 1,
    external: true,
  })
  const bob = member(hub, { epoch: 2, members: ['alice', 'bob'] })
  await bob.peer.resync()
  const verdict = vi.spyOn(bob.mls, 'sealRecoveryVerdict')
  const request = new TextEncoder().encode('signed-request')
  const verify = vi
    .spyOn(bob.mls, 'verifyRecoveryRequest')
    .mockResolvedValue({ groupID: 'group', requestID: 'history', requesterDID: 'alice' })
  const message = hub.published[0]
  if (message == null) throw new Error('Missing published commit')
  const framed = decodeHandshakeFrame(message.payload)
  if (framed == null) throw new Error('Missing frame')
  const commit = decodeCommitFrame(framed.payload).commit
  await hub.publish({
    senderDID: 'alice',
    topicID: rendezvousTopic(secret),
    payload: encodeHandshakeFrame(
      HANDSHAKE_KIND.recoveryConfirmRequest,
      encodeRecoveryConfirmRequest({
        requestID: 'history',
        request,
        position: published.sequenceID,
        commitDigest: digestAppliedCommit(commit),
      }),
    ),
  })
  await drainUntil(() => verify.mock.calls.length > 0, 'confirmation request')
  await bob.peer.resync()
  await vi.advanceTimersByTimeAsync(0)
  expect(verdict).not.toHaveBeenCalled()
})

test('a removed live peer refuses log dispatch with a removal error', async () => {
  controlRecoveryClock()
  const hub = new FakeHub()
  const bob = member(hub, { members: ['alice', 'bob'] })
  await bob.peer.resync()
  await publishCommit({
    hub,
    senderDID: 'alice',
    recoverySecret: secret,
    epoch: 1,
    removes: ['bob'],
  })
  await bob.peer.resync()
  await expect(
    bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'removed' } }),
  ).rejects.toMatchObject({ name: 'PeerRemovedError' })
  expect(await bob.appOutbox.list()).toEqual([])
})
