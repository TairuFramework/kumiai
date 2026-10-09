import { HeadMismatchError } from '@kumiai/hub-protocol'
import { afterEach, expect, test, vi } from 'vitest'

import type { Outcome } from '../src/control/types.js'
import { commitTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
import {
  buildLedgerCommit,
  makeMLSPeer,
  seedBuiltOperation,
  type TestPeer,
} from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0xb4)
const peers: Array<TestPeer> = []
function member(hub: FakeHub, options: Parameters<typeof makeMLSPeer>[3] = {}) {
  const peer = makeMLSPeer(hub, 'bob', secret, options)
  peers.push(peer)
  return peer
}
afterEach(async () => {
  await Promise.all(peers.map(({ peer }) => peer.dispose()))
  await Promise.all(peers.splice(0).map(({ peer }) => peer.drained()))
  vi.restoreAllMocks()
})

test('a publish success with different retained bytes cannot install or settle the operation', async () => {
  const hub = new FakeHub()
  const bob = member(hub)
  await bob.peer.replay()
  const request = buildLedgerCommit(bob, ['unlogged'])
  const publish = hub.publish.bind(hub)
  vi.spyOn(hub, 'publish').mockImplementation((params) => {
    return publish(
      params.topicID === commitTopic(secret) ? { ...params, payload: new Uint8Array([0]) } : params,
    )
  })
  const op = await seedBuiltOperation(bob, request)
  await bob.peer.replay().catch((error) => {
    expect(error).toMatchObject({ name: 'RecoveryRequiredError' })
  })
  expect(bob.mls.epoch()).toBe(1)
  expect(await bob.mls.getLedger()).toEqual([])
  const snapshot = await bob.control.load()
  expect(snapshot.operations).toEqual([op])
  expect(snapshot.outcomes).toEqual([])
  expect(snapshot.applied).toEqual([])
  expect(snapshot.cursor?.position ?? null).toBeNull()
})

test.each([0, 60_000])(
  'an empty search below the reported head cannot prove absence with timeout %s',
  async (operationTimeoutMs) => {
    const hub = new FakeHub()
    const bob = member(hub, { operationTimeoutMs })
    await bob.peer.replay()
    const op = await seedBuiltOperation(bob, buildLedgerCommit(bob, ['retained-then-hidden']))
    if (op.stage !== 'built') throw new Error('Missing build')
    const accepted = await hub.publish({
      senderDID: 'bob',
      topicID: commitTopic(secret),
      payload: op.built.payload,
      publishID: op.built.publishID,
      expectedHead: op.built.expectedHead,
      retain: 'log',
    })
    hub.trim(commitTopic(secret), '999999999999')
    const fetch = hub.fetchTopic.bind(hub)
    vi.spyOn(hub, 'fetchTopic').mockImplementation((params) => {
      return params.topicID === commitTopic(secret)
        ? Promise.resolve({ messages: [], head: accepted.sequenceID, oldest: null, gap: false })
        : fetch(params)
    })
    const publish = hub.publish.bind(hub)
    vi.spyOn(hub, 'publish').mockImplementation((params) => {
      if (params.topicID === commitTopic(secret)) throw new HeadMismatchError('Incorrect mismatch')
      return publish(params)
    })
    await bob.peer.replay()
    const snapshot = await bob.control.load()
    expect(snapshot.operations).toEqual([])
    expect(snapshot.outcomes).toEqual([expect.objectContaining({ opID: op.id, kind: 'unknown' })])
    expect(snapshot.applied).toEqual([])
    expect(snapshot.cursor?.position ?? null).toBeNull()
  },
)

test.each(['uncommitted', 'ambiguous'] as const)(
  'a durable landed outcome is emitted once after an %s anchor-save failure',
  async (failure) => {
    const hub = new FakeHub()
    const seen: Array<Outcome> = []
    const bob = member(hub, {
      onOutcome: (outcome) => {
        seen.push(outcome)
      },
    })
    await bob.peer.replay()
    bob.database.seam('after-save', () => {
      if (failure === 'ambiguous') bob.database.commitThenRejectNext('anchor')
      else bob.database.failNext('mid-anchor')
    })
    const request = buildLedgerCommit(bob, ['durable-outcome'])
    const committing = bob.peer.commit(request)
    void committing.catch(() => {})
    await expect
      .poll(async () => (await bob.control.load()).outcomes)
      .toEqual([expect.objectContaining({ opID: request.id, kind: 'landed' })])
    await bob.peer.replay()
    await expect(committing).resolves.toEqual({ position: hub.head(commitTopic(secret)) })
    await expect
      .poll(() => seen)
      .toEqual([expect.objectContaining({ opID: request.id, kind: 'landed' })])
    await expect
      .poll(
        async () => {
          return { epoch: bob.peer.anchorEpoch(), pending: (await bob.anchorStore.load())?.pending }
        },
        { timeout: 5000 },
      )
      .toEqual({ epoch: 1, pending: undefined })
    await bob.peer.replay()
    await bob.peer.replay()
    expect(seen).toEqual(await bob.peer.outcomes())
    await bob.peer.dispose()
    await bob.peer.drained()
    const again = member(hub, {
      restartOf: bob,
      onOutcome: (outcome) => {
        seen.push(outcome)
      },
    })
    await again.peer.replay()
    await expect.poll(() => seen.length).toBe(2)
    await again.peer.ack(request.id)
    await again.peer.replay()
    expect(seen).toHaveLength(2)
  },
)

test.each(['enqueue', 'commit'] as const)(
  '%s schedules a committed revoke intent when its post-write refresh fails',
  async (method) => {
    const hub = new FakeHub()
    const bob = member(hub)
    await bob.peer.replay()
    const load = bob.control.load.bind(bob.control)
    const apply = bob.control.apply.bind(bob.control)
    const request = buildLedgerCommit(bob, ['revoked'], { revokes: true })
    let failRead = false
    let failedReads = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(bob.control, 'load').mockImplementation(async () => {
      if (failRead) {
        failRead = false
        failedReads++
        throw new Error('Transient post-write read failure')
      }
      return load()
    })
    vi.spyOn(bob.control, 'apply').mockImplementation(async (changes, id) => {
      await apply(changes, id)
      if (changes.putOperations?.some((op) => op.id === request.id && op.stage === 'intent')) {
        await gate
        failRead = true
      }
    })
    const submitting = bob.peer[method](request)
    void submitting.catch(() => {})
    await expect.poll(async () => (await load()).operations[0]?.stage).toBe('intent')
    const sending = bob.peer
      .protocol('chat')
      .dispatch('chat/posted', { data: { afterRevoke: true } })
    void sending.catch(() => {})
    await expect.poll(async () => (await bob.appOutbox.list()).length).toBe(1)
    expect(hub.published).toEqual([])
    release()
    const result = await submitting
    expect(result).toEqual(
      method === 'enqueue' ? undefined : { position: hub.head(commitTopic(secret)) },
    )
    await expect
      .poll(async () => (await load()).outcomes, { timeout: 5000 })
      .toEqual([expect.objectContaining({ opID: request.id, kind: 'landed' })])
    await sending
    await expect.poll(async () => (await bob.appOutbox.list()).length).toBe(0)
    expect(failedReads).toBe(1)
    expect(bob.mls.epoch()).toBe(2)
    expect(hub.published.filter((row) => row.topicID !== commitTopic(secret))).toHaveLength(1)
  },
)
