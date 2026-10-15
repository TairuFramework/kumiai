import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import { afterEach, expect, test, vi } from 'vitest'

import { decodeCommitFrame } from '../src/commit-frame.js'
import type { ForkHalt, GroupForkEvidence, SafetyHold } from '../src/control/safety.js'
import { forkEventID, recoveryUnavailableEventID } from '../src/control/safety.js'
import type { WelcomeObligation } from '../src/control/types.js'
import { asLogPosition } from '../src/cursor.js'
import { ControlSafetyImmutableError, StorageOutcomeUnknownError } from '../src/errors.js'
import {
  decodeHandshakeFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  HANDSHAKE_MAGIC,
  HANDSHAKE_VERSION,
} from '../src/handshake.js'
import * as logDeliveryModule from '../src/log-delivery.js'
import { commitTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import {
  buildInviteCommit,
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
  vi.restoreAllMocks()
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

async function writeSafety(member: TestPeer, reason: NonNullable<SafetyHold>) {
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
    'host-safety',
  )
}

test.each(['fork-halted', 'recovery-unavailable'] as const)(
  'storage-written %s blocks an uncommitted Welcome with cached acceptance before refresh',
  async (reason) => {
    const hub = new FakeHub()
    const member = makeMLSPeer(hub, 'alice', secret, { adopt: async () => 'moved' })
    peers.push(member)
    await member.peer.replay()
    const op = await seedBuiltOperation(member, buildInviteCommit(member, 'bob'))
    const restore = vi.spyOn(member.validation, 'restoreValidation')
    const fetch = vi.spyOn(hub, 'fetchTopic')
    const apply = member.control.apply.bind(member.control)
    let wroteSafety = false
    vi.spyOn(member.control, 'apply').mockImplementation(async (changes, id) => {
      await apply(changes, id)
      if (changes.controlHold?.reason === 'acceptance-unknown' && !wroteSafety) {
        wroteSafety = true
        await writeSafety(member, reason)
        expect(member.controlWalk.safetyHold()).toBeNull()
        restore.mockClear()
        fetch.mockClear()
      }
    })
    await member.controlWalk.stepOperation(op.id)
    expect(wroteSafety).toBe(true)
    expect(member.welcomes).toEqual([])
    expect(restore).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect((await member.control.load()).welcomes).toMatchObject([{ opID: op.id }])
    expect((await member.control.load()).welcomes[0]?.committed).not.toBe(true)
    expect(member.controlWalk.safetyHold()).toBe(reason)
  },
)

test.each(
  (['fork-halted', 'recovery-unavailable'] as const).flatMap((reason) =>
    [false, true].map((committed) => [reason, committed] as const),
  ),
)(
  'storage-written %s gates Welcome retry before refresh (committed=%s)',
  async (reason, committed) => {
    const hub = new FakeHub()
    let unavailable = true
    const deliver = vi.fn(async (row: WelcomeObligation) => {
      if (unavailable) throw new Error('Transport unavailable')
      member.welcomes.push(row.opID)
    })
    const member = makeMLSPeer(hub, 'alice', secret, { deliverWelcome: deliver })
    peers.push(member)
    await member.peer.replay()
    vi.useFakeTimers()
    const request = buildInviteCommit(member, 'bob')
    await member.peer.commit(request)
    await vi.advanceTimersByTimeAsync(0)
    let opID = request.id
    if (!committed) {
      const op = await seedBuiltOperation(
        member,
        buildInviteCommit(member, 'carol'),
        '000000000002',
      )
      if (op.slot.welcome === null) throw new Error('Missing Welcome')
      opID = op.id
      await member.control.apply(
        {
          deleteWelcomes: [request.id],
          putWelcomes: [
            { opID, welcome: op.slot.welcome.bytes, recipients: op.slot.welcome.recipients },
          ],
        },
        'uncommitted-welcome',
      )
    }
    await writeSafety(member, reason)
    expect(member.controlWalk.safetyHold()).toBeNull()
    const restore = vi.spyOn(member.validation, 'restoreValidation')
    const fetch = vi.spyOn(hub, 'fetchTopic')
    deliver.mockClear()
    unavailable = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(restore).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(deliver).toHaveBeenCalledTimes(committed ? 1 : 0)
    expect(member.welcomes).toEqual(committed ? [opID] : [])
    expect((await member.control.load()).welcomes).toHaveLength(committed ? 0 : 1)
    expect(member.controlWalk.safetyHold()).toBe(reason)
  },
)

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

test('matching stored halt notifies once when mutation proof no longer names the landed write', async () => {
  const { member, onSafetyEvent } = await fixture()
  const apply = member.control.apply.bind(member.control)
  const writes = vi.spyOn(member.control, 'apply').mockImplementation(async (changes, id) => {
    await apply(changes, id)
    if (changes.forkHalt !== undefined) {
      await apply({}, 'later-control-write')
      expect(onSafetyEvent).not.toHaveBeenCalled()
      throw new StorageOutcomeUnknownError()
    }
  })
  await member.controlWalk.haltFork(evidence)
  await member.controlWalk.haltFork({ ...evidence, digest: 'second' })
  expect(writes.mock.calls.filter(([changes]) => changes.forkHalt !== undefined)).toHaveLength(1)
  expect(onSafetyEvent).toHaveBeenCalledOnce()
  expect(onSafetyEvent).toHaveBeenCalledWith({
    ...member.control.key,
    id: forkEventID(member.control.key),
    kind: 'group:fork',
    halt: (await member.control.load()).forkHalt,
  })
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

test.each(['fork-halted', 'recovery-unavailable'] as const)(
  'storage-written %s cleanup of a lingering applied operation preserves a real strand',
  async (reason) => {
    const { member, hub } = await fixture()
    const op = await seedBuiltOperation(member, buildLedgerCommit(member, []))
    const position = asLogPosition('000001')
    await member.control.apply(
      {
        strand: { reason: 'ahead' },
        cursor: { position, epoch: op.slot.epoch + 1, stranded: true },
        putApplied: [
          {
            epoch: op.slot.epoch,
            digest: op.slot.digest,
            payloadDigest: op.slot.payloadDigest,
            sequenceID: position,
            opID: op.id,
            removed: false,
          },
        ],
        putOutcomes: [{ id: op.id, opID: op.id, at: 1, kind: 'landed', position }],
      },
      'applied-with-real-strand',
    )
    const before = await member.control.load()
    await writeSafety(member, reason)
    expect(member.controlWalk.safetyHold()).toBeNull()
    const epoch = vi.spyOn(member.mls, 'readEpoch')
    const read = vi.spyOn(member.mls, 'readEvidence')
    const restore = vi.spyOn(member.validation, 'restoreValidation')
    const recovery = vi.spyOn(member.mls, 'createRecoveryRequest')
    const fetch = vi.spyOn(hub, 'fetchTopic')
    const publish = vi.spyOn(hub, 'publish')
    await member.peer.replay()
    await member.peer.replay()
    const after = await member.control.load()
    expect(after.operations).toEqual([])
    expect(after.cursor).toEqual(before.cursor)
    expect(after.strand).toEqual(before.strand)
    expect(after.commitOnce).toEqual(before.commitOnce)
    expect(after.applied).toEqual(before.applied)
    expect(after.outcomes).toEqual(before.outcomes)
    expect(member.controlWalk.safetyHold()).toBe(reason)
    expect(epoch).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    expect(recovery).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  },
)

test('a late unsupported-version hold persists alongside the safety latch', async () => {
  const { member, hub } = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const position = asLogPosition('000001')
  const payload = encodeHandshakeFrame(HANDSHAKE_KIND.commit, new Uint8Array())
  payload[HANDSHAKE_MAGIC.length] = HANDSHAKE_VERSION + 1
  vi.spyOn(hub, 'fetchTopic').mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    return {
      gap: false,
      head: position,
      oldest: position,
      messages: [{ topicID: commitTopic(secret), sequenceID: position, senderDID: 'bob', payload }],
    }
  })
  const walking = member.controlWalk.walkCommits({
    through: position,
    range: null,
    work: { takeFetch: () => true, takeFrame: () => true },
  })
  await entered.promise
  const halting = member.controlWalk.haltFork(evidence)
  expect(member.controlWalk.safetyHold()).toBe('fork-halted')
  await vi.waitFor(async () => expect((await member.control.load()).forkHalt).not.toBeNull())
  const before = await member.control.load()
  const epoch = vi.spyOn(member.mls, 'readEpoch')
  release.resolve()
  await walking
  await halting
  const after = await member.control.load()
  // Exclude the incoming frame classifier's epoch read before hold persistence.
  expect(
    epoch.mock.calls.slice(1),
    'ControlHold persistence must not read MLS after safety latches',
  ).toHaveLength(0)
  expect(after.controlHold).toEqual({ reason: 'unsupported-version', position })
  expect(after.forkHalt).toEqual(before.forkHalt)
  expect(after.cursor).toEqual(before.cursor)
  expect(after.strand).toEqual(before.strand)
  expect(member.controlWalk.safetyHold()).toBe('fork-halted')
})

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

async function observedFork(branch: 'losing' | 'winning') {
  const hub = new FakeHub()
  const first = await publishCommit({
    hub,
    senderDID: 'bob',
    recoverySecret: secret,
    epoch: 1,
    external: true,
  })
  const second = await publishCommit({
    hub,
    senderDID: 'carol',
    recoverySecret: secret,
    epoch: 1,
    external: true,
  })
  const applied = branch === 'losing' ? second : first
  const remote = branch === 'losing' ? first : second
  const next = await publishCommit({
    hub,
    senderDID: 'bob',
    recoverySecret: secret,
    epoch: 2,
    adds: ['dave'],
  })
  hub.hideFrom('alice', remote.sequenceID)
  hub.hideFrom('alice', next.sequenceID)
  let revealed = false
  const fetch = hub.fetchTopic.bind(hub)
  vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
    const page = await fetch(params)
    return !revealed && params.topicID === commitTopic(secret)
      ? { ...page, head: applied.sequenceID }
      : page
  })
  const createDelivery = logDeliveryModule.createLogDelivery
  const deliveries: Array<ReturnType<typeof createDelivery>> = []
  const create = vi.spyOn(logDeliveryModule, 'createLogDelivery').mockImplementation((params) => {
    const delivery = createDelivery(params)
    deliveries.push(delivery)
    return delivery
  })
  const onStrand = vi.fn()
  const onRecovery = vi.fn()
  const onSafetyEvent = vi.fn()
  const member = makeMLSPeer(hub, 'alice', secret, {
    members: ['alice', 'bob', 'carol'],
    onStrand,
    onRecovery,
    onSafetyEvent,
    recovery: { timeoutMs: 10, deadlineMs: 30, getDelayMs: () => 0 },
  })
  peers.push(member)
  create.mockRestore()
  await member.peer.replay()
  expect(member.mls.epoch()).toBe(2)
  const delivery = deliveries[0]
  if (delivery === undefined) throw new Error('Missing log delivery')
  const certify = vi.spyOn(delivery, 'certify')
  const commitDigest = (position: string) => {
    const row = hub.published.find((row) => row.sequenceID === position)
    if (row === undefined) throw new Error('Missing published commit')
    return toB64U(sha256(decodeCommitFrame(decodeHandshakeFrame(row.payload).payload).commit))
  }
  const expected = {
    kind: 'digest-divergence' as const,
    epoch: 1,
    position: remote.sequenceID,
    localDigest: commitDigest(applied.sequenceID),
    remoteDigest: commitDigest(remote.sequenceID),
  }
  expect(expected.localDigest).not.toBe(expected.remoteDigest)
  return {
    member,
    hub,
    onStrand,
    onRecovery,
    onSafetyEvent,
    certify,
    expected,
    reveal: async () => {
      revealed = true
      hub.revealTo('alice', remote.sequenceID)
      hub.revealTo('alice', next.sequenceID)
      return member.controlWalk.walkCommits({
        through: asLogPosition(next.sequenceID),
        range: null,
        work: { takeFetch: () => true, takeFrame: () => true },
      })
    },
  }
}

test.each(['losing', 'winning'] as const)(
  '%s past divergence permits following commits',
  async (branch) => {
    const { member, hub, reveal, expected, onStrand, onSafetyEvent } = await observedFork(branch)
    const before = await member.control.load()
    expect(await reveal()).toBe(true)
    const after = await member.control.load()
    expect(after.forkHalt).toBeNull()
    expect(member.controlWalk.safetyHold()).toBeNull()
    expect(after.cursor?.epoch).toBe(3)
    expect(member.mls.epoch()).toBe(3)
    expect(after.applied.slice(0, before.applied.length)).toEqual(before.applied)
    expect(after.outcomes).toEqual(before.outcomes)
    expect(after.strand).toBeNull()
    expect(hub.published).toHaveLength(3)
    expect(onStrand).toHaveBeenCalledExactlyOnceWith({
      groupID: commitTopic(secret),
      position: expected.position,
      commitDigest: expected.remoteDigest,
      localEpoch: 2,
      claimedEpoch: 1,
      kind: 'past-epoch-divergence',
      confidence: 'claimed',
    })
    expect(onSafetyEvent).not.toHaveBeenCalled()
  },
)

test.each(['losing', 'winning'] as const)(
  '%s branch never heals after delayed retries',
  async (branch) => {
    const { member, hub, reveal, onRecovery } = await observedFork(branch)
    vi.useFakeTimers()
    const request = vi.spyOn(member.mls, 'createRecoveryRequest')
    const rejoin = vi.spyOn(member.mls, 'applyRecovery')
    const prepare = vi.spyOn(member.mls, 'prepareRecovery')
    await reveal()
    const published = hub.published.length
    await vi.advanceTimersByTimeAsync(60_000)
    await member.peer.replay()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(request).not.toHaveBeenCalled()
    expect(rejoin).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(onRecovery).not.toHaveBeenCalled()
    expect(hub.published).toHaveLength(published)
    expect((await member.control.load()).rejoin).toBeNull()
    expect((await member.control.load()).cursor?.stranded).not.toBe(true)
  },
)

test.each(['losing', 'winning'] as const)(
  '%s divergence preserves progress after restart',
  async (branch) => {
    const { member, hub, reveal } = await observedFork(branch)
    await reveal()
    const before = await member.control.load()
    await member.peer.dispose()
    await member.peer.drained()
    const again = makeMLSPeer(hub, 'alice', secret, { restartOf: member })
    peers.push(again)
    await again.peer.replay()
    expect((await again.control.load()).applied).toEqual(before.applied)
    expect((await again.control.load()).cursor).toEqual(before.cursor)
    expect(again.controlWalk.safetyHold()).toBeNull()
    expect(again.mls.epoch()).toBe(3)
  },
)

test('past commits with no applied history stay non-fork', async () => {
  const hub = new FakeHub()
  const first = await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: 1 })
  const second = await publishCommit({ hub, senderDID: 'carol', recoverySecret: secret, epoch: 1 })
  const onStrand = vi.fn()
  const member = makeMLSPeer(hub, 'alice', secret, { epoch: 2, onStrand })
  peers.push(member)
  await member.peer.replay()
  const after = await member.control.load()
  expect(first.sequenceID).not.toBe(second.sequenceID)
  expect(after.cursor?.position).toBe(second.sequenceID)
  expect(after.applied).toEqual([])
  expect(after.forkHalt).toBeNull()
  expect(member.controlWalk.safetyHold()).toBeNull()
  expect(member.mls.seen()).toBe(0)
  expect(onStrand).not.toHaveBeenCalled()
})

test('identical re-sealed commit stays history below the cursor', async () => {
  const hub = new FakeHub()
  const first = await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: 1 })
  const original = hub.published.find((row) => row.sequenceID === first.sequenceID)
  if (original === undefined) throw new Error('Missing original')
  const commit = decodeCommitFrame(decodeHandshakeFrame(original.payload).payload).commit
  const second = await publishCommit({
    hub,
    senderDID: 'bob',
    recoverySecret: secret,
    epoch: 1,
    commit,
    entries: ['different-seal'],
  })
  expect(hub.published.find((row) => row.sequenceID === second.sequenceID)?.payload).not.toEqual(
    original.payload,
  )
  hub.hideFrom('alice', first.sequenceID)
  const onStrand = vi.fn()
  const member = makeMLSPeer(hub, 'alice', secret, { onStrand })
  peers.push(member)
  await member.peer.replay()
  const before = await member.control.load()
  hub.revealTo('alice', first.sequenceID)
  await member.controlWalk.walkCommits({
    through: asLogPosition(second.sequenceID),
    range: null,
    work: { takeFetch: () => true, takeFrame: () => true },
  })
  await member.peer.replay()
  const after = await member.control.load()
  expect(after.forkHalt).toBeNull()
  expect(member.controlWalk.safetyHold()).toBeNull()
  expect(after.applied).toEqual(before.applied)
  expect(after.cursor).toEqual(before.cursor)
  expect(member.mls.epoch()).toBe(2)
  expect(member.mls.seen()).toBe(1)
  expect(onStrand).not.toHaveBeenCalled()
})
