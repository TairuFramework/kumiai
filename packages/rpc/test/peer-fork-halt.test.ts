import { afterEach, expect, test, vi } from 'vitest'

import type { ForkHalt, GroupForkEvidence, SafetyHold } from '../src/control/safety.js'
import { forkEventID, recoveryUnavailableEventID } from '../src/control/safety.js'
import { ControlSafetyImmutableError, StorageOutcomeUnknownError } from '../src/errors.js'
import { commitTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
import {
  buildLedgerCommit,
  makeMLSPeer,
  seedBuiltOperation,
  type TestPeer,
} from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(42)
const peers: Array<TestPeer> = []
afterEach(async () => {
  for (const member of peers.splice(0)) {
    await member.peer.dispose()
    await member.peer.drained()
  }
  vi.useRealTimers()
})
const evidence: GroupForkEvidence = {
  kind: 'unexplained-own-commit',
  epoch: 1,
  position: '000001',
  digest: 'own',
}
async function fixture(onSafetyEvent = vi.fn()) {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret, { onSafetyEvent })
  peers.push(member)
  await member.peer.replay()
  return { member, hub, onSafetyEvent }
}

test('fork halt latches immediately, persists only safety, and notifies once after proof', async () => {
  const { member, onSafetyEvent } = await fixture()
  const before = await member.control.load()
  const apply = vi.spyOn(member.control, 'apply')
  await member.controlWalk.haltFork(evidence)
  expect(member.controlWalk.safetyHold()).toBe('fork-halted')
  const after = await member.control.load()
  expect(after.forkHalt).toEqual({
    eventID: forkEventID(member.control.key),
    evidence,
    detectedAt: expect.any(Number),
  })
  expect(after.cursor).toEqual(before.cursor)
  expect(after.strand).toEqual(before.strand)
  await vi.waitFor(() => expect(onSafetyEvent).toHaveBeenCalledOnce())
  await member.controlWalk.haltFork({ ...evidence, digest: 'second' })
  expect(apply.mock.calls.filter(([changes]) => changes.forkHalt !== undefined)).toHaveLength(1)
  expect(onSafetyEvent).toHaveBeenCalledWith({
    ...member.control.key,
    id: forkEventID(member.control.key),
    kind: 'group:fork',
    halt: after.forkHalt,
  })
})

test('two detectors before delayed proof keep one defensive body and emit nothing pending', async () => {
  const { member, onSafetyEvent } = await fixture()
  const written = Promise.withResolvers<void>()
  const proof = Promise.withResolvers<string | null>()
  const apply = member.control.apply.bind(member.control)
  let mutationID: string | null = null
  const attempts = vi.spyOn(member.control, 'apply').mockImplementation(async (changes, id) => {
    if (changes.forkHalt === undefined) return apply(changes, id)
    mutationID = id
    await apply(changes, id)
    written.resolve()
    throw new StorageOutcomeUnknownError()
  })
  vi.spyOn(member.control, 'lastMutation').mockImplementation(() => proof.promise)
  const mutable: GroupForkEvidence = {
    kind: 'epoch-authenticator',
    epoch: 1,
    local: new Uint8Array([1]),
    remote: new Uint8Array([2]),
  }
  const halting = member.controlWalk.haltFork(mutable)
  expect(member.controlWalk.safetyHold()).toBe('fork-halted')
  mutable.local.fill(9)
  await written.promise
  await member.controlWalk.haltFork(evidence)
  expect(onSafetyEvent).not.toHaveBeenCalled()
  expect(attempts.mock.calls.filter(([changes]) => changes.forkHalt !== undefined)).toHaveLength(1)
  proof.resolve(mutationID)
  await halting
  await vi.waitFor(() => expect(onSafetyEvent).toHaveBeenCalledOnce())
  expect((await member.control.load()).forkHalt?.evidence).toMatchObject({
    local: new Uint8Array([1]),
  })
})

test('proven rollback retries storage with the same body and fresh mutation ID', async () => {
  const { member, onSafetyEvent } = await fixture()
  const original = member.control.apply.bind(member.control)
  const writes: Array<{ body: ForkHalt; id: string }> = []
  vi.spyOn(member.control, 'apply').mockImplementation(async (changes, id) => {
    if (changes.forkHalt === undefined) return original(changes, id)
    writes.push({ body: changes.forkHalt, id })
    if (writes.length === 1) throw new StorageOutcomeUnknownError()
    return original(changes, id)
  })
  await member.controlWalk.haltFork(evidence)
  expect(writes).toHaveLength(2)
  expect(writes[0]?.body).toEqual(writes[1]?.body)
  expect(writes[0]?.id).not.toBe(writes[1]?.id)
  await vi.waitFor(() => expect(onSafetyEvent).toHaveBeenCalledOnce())
})

test.each(['stored', 'immutable'] as const)(
  'a foreign %s halt stops retries without peer notification',
  async (kind) => {
    const { member, onSafetyEvent } = await fixture()
    const foreign = {
      eventID: forkEventID(member.control.key),
      evidence: { ...evidence, digest: 'host' },
      detectedAt: 1,
    }
    if (kind === 'stored') await member.control.apply({ forkHalt: foreign }, 'host')
    const apply = vi.spyOn(member.control, 'apply')
    if (kind === 'immutable') apply.mockRejectedValue(new ControlSafetyImmutableError('forkHalt'))
    await member.controlWalk.haltFork(evidence)
    await member.controlWalk.haltFork(evidence)
    expect(member.controlWalk.safetyHold()).toBe('fork-halted')
    expect(apply).toHaveBeenCalledTimes(kind === 'stored' ? 0 : 1)
    expect(onSafetyEvent).not.toHaveBeenCalled()
    if (kind === 'stored') expect((await member.control.load()).forkHalt).toEqual(foreign)
  },
)

test.each(['throw', 'reject'] as const)('safety notification %s is contained', async (kind) => {
  const callback = vi.fn(() => {
    if (kind === 'throw') throw new Error('callback')
    return Promise.reject(new Error('callback'))
  })
  const { member } = await fixture(callback)
  await expect(member.controlWalk.haltFork(evidence)).resolves.toBeUndefined()
  await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())
})

test.each(['fork-halted', 'recovery-unavailable'] as const)(
  'storage-written %s refresh starts no MLS work and preserves a real strand',
  async (reason) => {
    const { member, hub } = await fixture()
    await member.control.apply(
      { strand: { reason: 'ahead' }, cursor: { position: null, epoch: 1, stranded: true } },
      'real-strand',
    )
    await member.control.apply(
      reason === 'fork-halted'
        ? { forkHalt: { eventID: forkEventID(member.control.key), evidence, detectedAt: 1 } }
        : {
            recoveryUnavailable: {
              ...member.control.key,
              id: recoveryUnavailableEventID(member.control.key),
              kind: 'group:recovery-unavailable',
              reason: 'trust-unreadable',
            },
          },
      'host-halt',
    )
    const before = await member.control.load()
    const epoch = vi.spyOn(member.mls, 'readEpoch')
    const recovery = vi.spyOn(member.mls, 'createRecoveryRequest')
    const fetch = vi.spyOn(hub, 'fetchTopic')
    await member.peer.replay()
    await member.peer.replay()
    expect(member.controlWalk.safetyHold()).toBe(reason)
    expect(epoch).not.toHaveBeenCalled()
    expect(recovery).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect((await member.control.load()).cursor).toEqual(before.cursor)
    expect((await member.control.load()).strand).toEqual(before.strand)
    await expect(
      member.peer.protocol('chat').dispatch('chat/changed', { data: {} }),
    ).rejects.toMatchObject({ name: 'SendNotAdmissibleError', reason })
  },
)

test.each(['fork-halted', 'recovery-unavailable'] as const)(
  'admission %s latches synchronously and stops repeated control wakes',
  async (reason) => {
    const { member, hub } = await fixture()
    vi.spyOn(member.mls, 'sendAdmission').mockReturnValue({ epoch: 1, admissible: false, reason })
    expect(member.controlWalk.safetyHold()).toBe(reason satisfies NonNullable<SafetyHold>)
    const fetch = vi.spyOn(hub, 'fetchTopic')
    const recovery = vi.spyOn(member.mls, 'createRecoveryRequest')
    await member.peer.replay()
    await member.peer.replay()
    expect(fetch).not.toHaveBeenCalled()
    expect(recovery).not.toHaveBeenCalled()
  },
)

test.each(['intent', 'built', 'pending', 'accepted'] as const)(
  'live and restarted %s deadlines under halt use storage only',
  async (stage) => {
    for (const restart of [false, true]) {
      const { member, hub } = await fixture()
      const request = buildLedgerCommit(member, [])
      const prepared =
        stage === 'intent'
          ? { ...request, stage: 'intent' as const, seq: 1, enqueuedAt: 0, deadline: 0 }
          : await seedBuiltOperation(
              member,
              request,
              stage === 'accepted' ? '000000000001' : undefined,
            )
      const op = {
        ...prepared,
        deadline: 0,
        ...(stage === 'pending' ? { pendingPublish: { expectedHead: null } } : {}),
      }
      await member.control.apply({ putOperations: [op] }, 'expired')
      await member.controlWalk.haltFork(evidence)
      const before = await member.control.load()
      let runner = member
      if (restart) {
        await member.peer.dispose()
        await member.peer.drained()
        runner = makeMLSPeer(hub, 'alice', secret, { restartOf: member })
        peers.push(runner)
      }
      const fetch = vi.spyOn(hub, 'fetchTopic')
      const publish = vi.spyOn(hub, 'publish')
      const epoch = vi.spyOn(runner.mls, 'readEpoch')
      const read = vi.spyOn(runner.mls, 'readEvidence')
      const recover = vi.spyOn(runner.mls, 'createRecoveryRequest')
      await runner.peer.replay()
      await vi.waitFor(async () => expect((await runner.control.load()).operations).toEqual([]))
      const after = await runner.control.load()
      expect(after.outcomes).toMatchObject([{ kind: stage === 'intent' ? 'lost' : 'unknown' }])
      expect(after.commitOnce).toEqual(before.commitOnce)
      expect(after.forkHalt).toEqual(before.forkHalt)
      expect(after.cursor).toEqual(before.cursor)
      expect(after.strand).toEqual(before.strand)
      expect(fetch).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
      expect(epoch).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
      expect(recover).not.toHaveBeenCalled()
      await runner.peer.ack(after.outcomes[0]?.id ?? request.id)
      expect((await runner.control.load()).commitOnce).toEqual(before.commitOnce)
      fetch.mockRestore()
      publish.mockRestore()
    }
  },
)

test('control publication rechecks safety after suspended source evidence', async () => {
  const hub = new FakeHub()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let suspend = false
  const member = makeMLSPeer(hub, 'alice', secret, {
    readEvidence: async () => {
      const value = await member.mls.readEvidence()
      if (suspend && (await member.control.load()).operations[0]?.pendingPublish !== undefined) {
        entered.resolve()
        await release.promise
      }
      return value
    },
  })
  peers.push(member)
  await member.peer.replay()
  const op = await seedBuiltOperation(member, buildLedgerCommit(member, []))
  const publish = vi.spyOn(hub, 'publish')
  suspend = true
  const stepping = member.controlWalk.stepOperation(op.id)
  await entered.promise
  const halting = member.controlWalk.haltFork(evidence)
  release.resolve()
  await stepping
  await halting
  expect(publish).not.toHaveBeenCalled()
  expect((await member.control.load()).operations[0]?.pendingPublish).toBeDefined()
})

test('a differing halt loaded after rollback stops all further writes', async () => {
  const { member, onSafetyEvent } = await fixture()
  const original = member.control.apply.bind(member.control)
  const foreign = {
    eventID: forkEventID(member.control.key),
    evidence: { ...evidence, digest: 'host' },
    detectedAt: 1,
  }
  const writes = vi.spyOn(member.control, 'apply').mockImplementation(async (changes, id) => {
    if (changes.forkHalt === undefined) return original(changes, id)
    await original({ forkHalt: foreign }, 'host')
    throw new StorageOutcomeUnknownError()
  })
  await member.controlWalk.haltFork(evidence)
  expect(writes.mock.calls.filter(([changes]) => changes.forkHalt !== undefined)).toHaveLength(1)
  expect(onSafetyEvent).not.toHaveBeenCalled()
  expect(member.controlWalk.safetyHold()).toBe('fork-halted')
  expect((await member.control.load()).forkHalt).toEqual(foreign)
})

test('held commit wakeups perform storage service without starting MLS work', async () => {
  const { member, hub } = await fixture()
  await member.controlWalk.haltFork(evidence)
  const complete = vi.spyOn(member.mls, 'isLedgerComplete')
  const epoch = vi.spyOn(member.mls, 'readEpoch')
  const process = vi.spyOn(member.mls, 'processCommit')
  await hub.publish({
    topicID: commitTopic(secret),
    senderDID: 'bob',
    payload: new Uint8Array([0]),
    retain: 'log',
  })
  await member.peer.replay()
  await member.peer.replay()
  expect(complete).not.toHaveBeenCalled()
  expect(epoch).not.toHaveBeenCalled()
  expect(process).not.toHaveBeenCalled()
})

test('fork rollback backoff doubles from 100 ms and caps at 15 seconds', async () => {
  const { member, onSafetyEvent } = await fixture()
  vi.useFakeTimers()
  const original = member.control.apply.bind(member.control)
  const at: Array<number> = []
  const bodies: Array<ForkHalt> = []
  const mutations: Array<string> = []
  vi.spyOn(member.control, 'apply').mockImplementation(async (changes, id) => {
    if (changes.forkHalt === undefined) return original(changes, id)
    at.push(Date.now())
    bodies.push(changes.forkHalt)
    mutations.push(id)
    if (at.length <= 10) {
      expect(onSafetyEvent).not.toHaveBeenCalled()
      throw new StorageOutcomeUnknownError()
    }
    return original(changes, id)
  })
  const halting = member.controlWalk.haltFork(evidence)
  await vi.advanceTimersByTimeAsync(0)
  for (const delay of [100, 200, 400, 800, 1600, 3200, 6400, 12800, 15000, 15000])
    await vi.advanceTimersByTimeAsync(delay)
  await halting
  expect(at.slice(1).map((time, index) => time - (at[index] ?? time))).toEqual([
    100, 200, 400, 800, 1600, 3200, 6400, 12800, 15000, 15000,
  ])
  expect(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true)
  expect(new Set(mutations).size).toBe(11)
  expect(onSafetyEvent).toHaveBeenCalledOnce()
})
