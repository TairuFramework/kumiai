import { HeadMismatchError } from '@kumiai/hub-protocol'
import { afterEach, expect, test, vi } from 'vitest'

import type { Outcome } from '../src/control/types.js'
import { asLogPosition } from '../src/cursor.js'
import {
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  HANDSHAKE_MAGIC,
  HANDSHAKE_VERSION,
} from '../src/handshake.js'
import { commitTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import {
  buildInviteCommit,
  buildLedgerCommit,
  buildRejoinRecord,
  makeMLSPeer,
  seedBuiltOperation,
  type TestPeer,
} from './fixtures/peer.js'

test('failed hold persistence keeps the runtime barrier across later control refreshes', async () => {
  const hub = new FakeHub()
  const database = createMemoryHostDatabase()
  const control = database.control('bob', { groupID: 'memory-group', incarnation: 1 })
  let failures = 0
  const bob = member(hub, {
    database,
    control: {
      ...control,
      apply: async (changes, id) => {
        if (changes.controlHold?.reason === 'unsupported-version') {
          failures++
          throw new Error('hold write failed')
        }
        await control.apply(changes, id)
      },
    },
  })
  await bob.peer.replay()
  const frame = encodeHandshakeFrame(HANDSHAKE_KIND.commit, new Uint8Array([1]))
  frame[HANDSHAKE_MAGIC.length] = HANDSHAKE_VERSION + 1
  await hub.publish({
    senderDID: 'alice',
    topicID: commitTopic(secret),
    payload: frame,
    retain: 'log',
  })
  await vi.waitFor(() => expect(failures).toBeGreaterThan(0))
  await bob.peer.enqueue(buildLedgerCommit(bob, ['held']))
  expect((await control.load()).controlHold).toBeNull()
  await expect(
    bob.peer.protocol('chat').dispatch('chat/changed', { data: {} }),
  ).rejects.toMatchObject({ name: 'RecoveryRequiredError' })
  const built = await buildRejoinRecord(bob)
  const confirmed = {
    ...built,
    stage: 'confirmed' as const,
    position: asLogPosition('001'),
    verdict: new Uint8Array([1]),
  }
  await control.apply({ putRejoin: confirmed }, 'confirmed-runtime-held')
  await bob.peer.replay()
  expect(bob.mls.epoch()).toBe(1)
  expect((await control.load()).rejoin).toEqual(confirmed)
})

test('uncommitted Welcome delivery refuses a strong hold detected during adoption', async () => {
  const hub = new FakeHub()
  const bob = member(hub, {
    adopt: async (_journal, expected) => {
      await bob.control.apply(
        {
          controlHold: { reason: 'unsupported-version', position: expected.acceptance.position },
          strand: { reason: 'unsupported-version' },
        },
        'hold-before-install',
      )
      return 'moved'
    },
  })
  await bob.peer.replay()
  const request = buildInviteCommit(bob, 'invitee')
  await bob.peer.enqueue(request)
  await vi.waitFor(async () =>
    expect((await bob.control.load()).commitOnceAcceptance).not.toBeNull(),
  )
  await bob.peer.replay()
  expect((await bob.control.load()).controlHold?.reason).toBe('unsupported-version')
  expect((await bob.control.load()).welcomes).toHaveLength(1)
  expect(bob.welcomes).toEqual([])
})

test('uncommitted Welcome delivery refuses a strand detected during adoption', async () => {
  vi.useFakeTimers()
  const hub = new FakeHub()
  const bob = member(hub, {
    adopt: async () => {
      await bob.control.apply({ strand: { reason: 'ahead' } }, 'ahead-before-install')
      return 'moved'
    },
  })
  await bob.peer.replay()
  const op = await seedBuiltOperation(bob, buildInviteCommit(bob, 'invitee'))
  await bob.controlWalk.stepOperation(op.id)
  expect(bob.welcomes).toEqual([])
  const snapshot = await bob.control.load()
  expect(snapshot.strand).toEqual({ reason: 'ahead' })
  expect(snapshot.commitOnce).not.toBeNull()
  expect(snapshot.welcomes).toEqual([
    { opID: op.id, welcome: op.slot.welcome?.bytes, recipients: ['invitee'] },
  ])
  expect(bob.mls.epoch()).toBe(op.slot.epoch)
})

test.each(['advancement', 'retirement', 'disposal', 'hard-hold'] as const)(
  'slot retries coalesce reconnect hints and cancel on %s',
  async (stop) => {
    vi.useFakeTimers()
    const hub = new FakeHub()
    const bob = member(hub)
    await bob.peer.replay()
    const restore = vi.spyOn(bob.validation, 'restoreValidation').mockResolvedValue(null)
    await bob.peer.enqueue(buildLedgerCommit(bob, ['retained']))
    await vi.waitFor(async () => expect((await bob.control.load()).commitOnce).not.toBeNull())
    await bob.peer.abandon()
    for (const outcome of await bob.peer.outcomes()) await bob.peer.ack(outcome.id)
    await vi.advanceTimersByTimeAsync(0)
    restore.mockClear()
    bob.peer.reauthorize()
    bob.peer.reauthorize()
    bob.peer.reauthorize()
    await vi.advanceTimersByTimeAsync(0)
    expect(restore).toHaveBeenCalledTimes(1)
    if (stop === 'disposal') {
      await bob.peer.dispose()
      await bob.peer.drained()
    } else if (stop === 'hard-hold') {
      await bob.control.apply(
        { controlHold: { reason: 'unsupported-version', position: null } },
        'hard-hold',
      )
      await bob.peer.ack('refresh-hold')
    } else {
      if (stop === 'retirement') bob.mls.evict('bob')
      else bob.mls.adopt(bob.mls.buildCommit([]))
      await bob.database.saveState('bob', bob.mls.serializeState())
      // Ack refreshes coherent evidence without a commit delivery.
      await bob.peer.ack('already-absent')
    }
    const timeouts = vi.spyOn(globalThis, 'setTimeout')
    timeouts.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    if (stop === 'hard-hold' || stop === 'retirement')
      expect(
        timeouts.mock.calls.filter(
          ([, delay]) =>
            delay === 15_000 ||
            delay === 1_000 ||
            delay === 2_000 ||
            delay === 4_000 ||
            delay === 8_000,
        ),
      ).toEqual([])
    expect(restore).toHaveBeenCalledTimes(1)
    expect((await bob.control.load()).operations).toEqual([])
    expect(hub.published.filter((row) => row.topicID === commitTopic(secret))).toEqual([])
  },
)

test.each(
  ['unknown', 'lost', 'abandon'].flatMap((prior) =>
    [true, false].map((acked) => [prior, acked] as const),
  ),
)('startup settles a late %s slot before own walking (acked=%s)', async (prior, acked) => {
  const hub = new FakeHub()
  const bob = member(hub)
  await bob.peer.replay()
  let builds = 0
  const op = await seedBuiltOperation(
    bob,
    buildInviteCommit(bob, 'invitee', {
      onBuild: () => {
        builds++
      },
    }),
  )
  await bob.control.apply(
    {
      deleteOperations: [op.id],
      putOutcomes: [
        { id: op.id, opID: op.id, kind: prior === 'lost' ? 'lost' : 'unknown', at: op.deadline },
      ],
    },
    'prior-settlement',
  )
  if (acked) await bob.control.apply({ deleteOutcomes: [op.id] }, 'ack')
  await bob.peer.dispose()
  await bob.peer.drained()
  const accepted = await hub.publish({
    senderDID: 'bob',
    topicID: commitTopic(secret),
    payload: op.slot.payload,
    publishID: op.slot.publishID,
    expectedHead: op.slot.expectedHead,
    retain: 'log',
  })
  const again = member(hub, { restartOf: bob })
  await again.peer.replay()
  const snapshot = await again.control.load()
  expect(snapshot.operations).toEqual([])
  expect(snapshot.outcomes).toHaveLength(1)
  expect(snapshot.outcomes.filter((row) => row.kind === 'landed')).toEqual([
    expect.objectContaining({
      id: JSON.stringify(['control:landed', op.id, op.slot.publishID, accepted.sequenceID]),
      opID: op.id,
      position: accepted.sequenceID,
    }),
  ])
  expect(snapshot.applied[0]?.payloadDigest).toBe(op.slot.payloadDigest)
  expect(snapshot.cursor?.position).toBe(accepted.sequenceID)
  expect(again.mls.epoch()).toBe(op.slot.epoch + 1)
  expect(again.welcomes).toEqual([op.id])
  expect(builds).toBe(1)
  expect(hub.published.filter((row) => row.topicID === commitTopic(secret))).toHaveLength(1)
})

test.each([false, true])(
  'current terminal state overrides misleading applied-row ordering: %s',
  async (terminal) => {
    const hub = new FakeHub()
    const bob = member(hub, { epoch: 20 })
    await bob.peer.replay()
    if (terminal) {
      bob.mls.adopt(bob.mls.buildCommit([], { removes: ['bob'] }))
      await bob.database.saveState('bob', bob.mls.serializeState())
    }
    await bob.control.apply(
      {
        putApplied: [
          {
            epoch: 18,
            digest: 'historical',
            payloadDigest: 'old-frame',
            sequenceID: '001',
            opID: null,
            removed: !terminal,
          },
        ],
      },
      'misleading-history',
    )
    await bob.peer.dispose()
    await bob.peer.drained()
    const again = member(hub, { restartOf: bob })
    await again.peer.replay()
    const request = buildLedgerCommit(again, ['current-state'])
    if (terminal) {
      await expect(again.peer.enqueue(request)).rejects.toMatchObject({ name: 'PeerRemovedError' })
      expect(hub.published).toEqual([])
    } else {
      await expect(again.peer.commit(request)).resolves.toHaveProperty('position')
      expect(again.mls.epoch()).toBe(21)
    }
  },
)

test.each(
  ['restore', 'header', 'resolver'].flatMap((input) =>
    ['unknown', 'ambiguous', 'abandon'].map((prior) => [input, prior] as const),
  ),
)(
  'orphan slot retries recovered %s input after %s without new delivery or host call',
  async (input, prior) => {
    vi.useFakeTimers()
    const hub = new FakeHub()
    let unavailable = false
    const publish = hub.publish.bind(hub)
    let handoffs = 0
    vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
      if (params.topicID === commitTopic(secret)) {
        handoffs++
        throw new Error('offline')
      }
      return publish(params)
    })
    const received: Array<unknown> = []
    const bob = member(hub, {
      operationTimeoutMs: 1_000,
      members: ['alice', 'bob'],
      handlers: {
        'chat/changed': (event: unknown) => {
          received.push(event)
        },
      },
    })
    const alice = makeMLSPeer(hub, 'alice', secret, { members: ['alice', 'bob'] })
    peers.push(alice)
    await alice.peer.replay()
    const restore = bob.validation.restoreValidation.bind(bob.validation)
    const attempts: Array<number> = []
    vi.spyOn(bob.validation, 'restoreValidation').mockImplementation(async (built) => {
      attempts.push(Date.now())
      if (unavailable && input === 'restore') return null
      const validation = await restore(built)
      if (validation === null) return null
      return {
        ...validation,
        readCommitHeader: async (commit) => {
          if (unavailable && input === 'header') throw new Error('retained header key unavailable')
          return validation.readCommitHeader(commit)
        },
        validateFrame: async (...args) =>
          unavailable && input === 'resolver'
            ? { kind: 'unavailable', reason: 'resolver' }
            : validation.validateFrame(...args),
      }
    })
    try {
      await bob.peer.replay()
      let builds = 0
      const request = buildInviteCommit(bob, 'invitee', {
        onBuild: () => {
          builds++
          unavailable = true
        },
      })
      await bob.peer.enqueue(request)
      await vi.waitFor(async () =>
        expect((await bob.control.load()).commitOnce?.opID).toBe(request.id),
      )
      const slot = (await bob.control.load()).commitOnce
      if (slot === null) throw new Error('missing slot')
      if (prior === 'ambiguous') {
        unavailable = false
        await bob.controlWalk.stepOperation(request.id)
        await vi.advanceTimersByTimeAsync(1_001)
        await bob.peer.replay()
        expect((await bob.peer.outcomes())[0]?.kind).toBe('unknown')
        unavailable = true
      }
      const accepted = await publish({
        senderDID: 'bob',
        topicID: commitTopic(secret),
        payload: slot.payload,
        publishID: slot.publishID,
        expectedHead: slot.expectedHead,
        retain: 'log',
      })
      if (prior === 'abandon') await bob.peer.abandon()
      else if (prior === 'unknown') await vi.advanceTimersByTimeAsync(1_001)
      await vi.waitFor(async () => expect((await bob.peer.outcomes())[0]?.kind).toBe('unknown'))
      for (const outcome of await bob.peer.outcomes()) await bob.peer.ack(outcome.id)
      expect((await bob.control.load()).operations).toEqual([])
      expect((await bob.control.load()).outcomes).toEqual([])
      await vi.advanceTimersByTimeAsync(0)
      const publications = handoffs
      const origin = Date.now()
      attempts.length = 0
      for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000, 15_000])
        await vi.advanceTimersByTimeAsync(delay)
      expect(attempts.map((at) => at - origin)).toEqual([
        1_000, 3_000, 7_000, 15_000, 30_000, 45_000,
      ])
      expect(bob.mls.epoch()).toBe(slot.epoch)
      unavailable = false
      await vi.advanceTimersByTimeAsync(15_000)
      expect((await bob.peer.outcomes())[0]).toMatchObject({
        kind: 'landed',
        opID: request.id,
        position: accepted.sequenceID,
        id: JSON.stringify(['control:landed', request.id, slot.publishID, accepted.sequenceID]),
      })
      expect(bob.mls.epoch()).toBe(slot.epoch + 1)
      expect(bob.welcomes).toEqual([request.id])
      await vi.waitFor(() => expect(alice.mls.epoch()).toBe(slot.epoch + 1))
      await alice.peer.protocol('chat').dispatch('chat/changed', { data: { afterOrphan: true } })
      await vi.waitFor(() => expect(received).toHaveLength(1))
      expect(builds).toBe(1)
      expect(handoffs).toBe(publications)
      const calls = attempts.length
      await vi.advanceTimersByTimeAsync(30_000)
      expect(attempts).toHaveLength(calls)
      expect(await bob.peer.outcomes()).toHaveLength(1)
    } finally {
      await bob.peer.dispose()
      await bob.peer.drained()
      vi.useRealTimers()
    }
  },
)

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
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test.each([false, true])(
  'an ahead prefix retains the built slot without publication or own adoption (own=%s)',
  async (own) => {
    vi.useFakeTimers()
    const hub = new FakeHub()
    const bob = member(hub)
    await bob.peer.replay()
    const op = await seedBuiltOperation(bob, buildInviteCommit(bob, 'invitee'))
    // Suppress push delivery so the runner itself meets the ahead frame in search.
    const ahead = await publishCommit({
      hub,
      senderDID: 'bob',
      committerDID: 'alice',
      signerDID: 'bob',
      recoverySecret: secret,
      epoch: op.slot.epoch + 1,
    })
    if (own)
      await hub.publish({
        senderDID: 'bob',
        topicID: commitTopic(secret),
        payload: op.slot.payload,
        publishID: op.slot.publishID,
        expectedHead: ahead.sequenceID,
        retain: 'log',
      })
    const publications = hub.published.length
    await bob.controlWalk.stepOperation(op.id)
    expect(hub.published).toHaveLength(publications)
    const snapshot = await bob.control.load()
    expect(snapshot.strand).toEqual({ reason: 'ahead' })
    expect(snapshot.cursor?.stranded).toBe(true)
    expect(snapshot.commitOnce).toEqual(op.slot)
    expect(snapshot.commitOnceAcceptance).toBeNull()
    expect(snapshot.applied).toEqual([])
    expect(snapshot.outcomes).toEqual([])
    expect(bob.mls.epoch()).toBe(op.slot.epoch)
    expect(bob.welcomes).toEqual([])
  },
)

test('nested competitor removal keeps its lost outcome when the stale runner expires', async () => {
  vi.useFakeTimers()
  const hub = new FakeHub()
  const seen: Array<Outcome> = []
  const bob = member(hub, {
    onOutcome: (outcome) => {
      seen.push(outcome)
    },
  })
  await bob.peer.replay()
  const op = await seedBuiltOperation(bob, buildInviteCommit(bob, 'invitee'))
  await publishCommit({
    hub,
    senderDID: 'bob',
    committerDID: 'alice',
    recoverySecret: secret,
    epoch: op.slot.epoch,
    removes: ['bob'],
  })
  const process = bob.mls.processCommit.bind(bob.mls)
  vi.spyOn(bob.mls, 'processCommit').mockImplementation(async (...args) => {
    const result = await process(...args)
    expect((await bob.control.load()).outcomes).toEqual([
      expect.objectContaining({ opID: op.id, kind: 'lost' }),
    ])
    vi.setSystemTime(op.deadline)
    return result
  })
  await bob.controlWalk.stepOperation(op.id)
  await vi.advanceTimersByTimeAsync(0)
  expect((await bob.control.load()).operations).toEqual([])
  expect((await bob.control.load()).outcomes).toEqual([
    expect.objectContaining({ opID: op.id, kind: 'lost' }),
  ])
  expect(seen).toEqual([expect.objectContaining({ opID: op.id, kind: 'lost' })])
  expect(bob.welcomes).toEqual([])
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
  expect(snapshot.operations).toEqual([
    { ...op, pendingPublish: { expectedHead: op.slot.expectedHead } },
  ])
  expect(snapshot.outcomes).toEqual([])
  expect(snapshot.applied).toEqual([])
  expect(snapshot.cursor?.position).toBe(hub.head(commitTopic(secret)))
})

test.each([1_000, 60_000])(
  'an empty search below the reported head cannot prove absence with timeout %s',
  async (operationTimeoutMs) => {
    const hub = new FakeHub()
    const bob = member(hub, { operationTimeoutMs })
    await bob.peer.replay()
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const op = await seedBuiltOperation(bob, buildLedgerCommit(bob, ['retained-then-hidden']))
    if (op.stage !== 'built') throw new Error('Missing build')
    const accepted = await hub.publish({
      senderDID: 'bob',
      topicID: commitTopic(secret),
      payload: op.slot.payload,
      publishID: op.built.publishID,
      expectedHead: op.slot.expectedHead,
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
    expect((await bob.control.load()).operations).toEqual([op])
    now = op.deadline
    await bob.peer.replay()
    const snapshot = await bob.control.load()
    expect(snapshot.operations).toEqual([])
    expect(snapshot.outcomes).toEqual([expect.objectContaining({ opID: op.id, kind: 'unknown' })])
    expect(snapshot.applied).toEqual([])
    expect(snapshot.cursor?.position ?? null).toBeNull()
    expect(snapshot.commitOnce).toEqual(op.slot)
    expect(snapshot.controlHold?.reason).toBe('acceptance-unknown')
    clock.mockRestore()
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

test.each(['unknown', 'ambiguous', 'abandon'] as const)(
  'the own walker adopts an acked late %s slot before walking its occurrence',
  async (prior) => {
    vi.useFakeTimers()
    const hub = new FakeHub()
    const bob = member(hub)
    await bob.peer.replay()
    let builds = 0
    const op = await seedBuiltOperation(
      bob,
      buildInviteCommit(bob, 'invitee', {
        onBuild: () => {
          builds++
        },
      }),
    )
    const restore = bob.validation.restoreValidation.bind(bob.validation)
    let unavailable = true
    vi.spyOn(bob.validation, 'restoreValidation').mockImplementation((built) =>
      unavailable ? Promise.resolve(null) : restore(built),
    )
    if (prior === 'ambiguous') {
      unavailable = false
      const publish = hub.publish.bind(hub)
      const handoff = vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
        if (params.topicID === commitTopic(secret)) throw new Error('Reply lost')
        return publish(params)
      })
      await bob.controlWalk.stepOperation(op.id)
      vi.setSystemTime(op.deadline)
      await bob.controlWalk.stepOperation(op.id)
      expect(await bob.peer.outcomes()).toEqual([
        expect.objectContaining({ id: op.id, opID: op.id, kind: 'unknown' }),
      ])
      handoff.mockRestore()
      unavailable = true
    } else {
      await bob.control.apply(
        {
          deleteOperations: [op.id],
          putOutcomes: [{ id: op.id, opID: op.id, at: Date.now(), kind: 'unknown' }],
        },
        crypto.randomUUID(),
      )
    }
    const accepted = await hub.publish({
      senderDID: 'bob',
      topicID: commitTopic(secret),
      payload: op.slot.payload,
      publishID: op.slot.publishID,
      expectedHead: op.slot.expectedHead,
      retain: 'log',
    })
    await bob.peer.ack(op.id)
    await vi.advanceTimersByTimeAsync(0)
    expect((await bob.control.load()).outcomes).toEqual([])
    unavailable = false
    let fetches = 0
    let frames = 0
    await bob.controlWalk.walkCommits({
      through: asLogPosition(accepted.sequenceID),
      range: null,
      work: { takeFetch: () => ++fetches <= 16, takeFrame: () => ++frames <= 256 },
    })
    const settled = await bob.control.load()
    expect(bob.mls.epoch()).toBe(op.slot.epoch + 1)
    expect(settled.outcomes).toEqual([
      expect.objectContaining({ kind: 'landed', opID: op.id, position: accepted.sequenceID }),
    ])
    expect(settled.applied[0]?.payloadDigest).toBe(op.slot.payloadDigest)
    expect(settled.cursor?.position).toBe(accepted.sequenceID)
    expect(builds).toBe(1)
    expect(hub.published.filter((row) => row.topicID === commitTopic(secret))).toHaveLength(1)
  },
)

test.each(['expiry', 'terminal', 'divergence', 'strand'] as const)(
  '%s during submission drain prevents handoff',
  async (move) => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const hub = new FakeHub()
    const publish = hub.publish.bind(hub)
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    let appEntered = false
    let handoffs = 0
    vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
      if (params.topicID === commitTopic(secret)) handoffs++
      else if (params.retain === 'log') {
        appEntered = true
        await paused
      }
      return publish(params)
    })
    const bob = member(hub, { operationTimeoutMs: 1_000 })
    try {
      await bob.peer.replay()
      await bob.peer.protocol('chat').dispatch('chat/posted', { data: {} })
      await vi.waitFor(() => expect(appEntered).toBe(true))
      const allSettled = Promise.allSettled.bind(Promise)
      let draining = false
      vi.spyOn(Promise, 'allSettled').mockImplementation((values) => {
        const rows = Array.from(values)
        if (rows.length === 1) draining = true
        return allSettled(rows)
      })
      const request = buildLedgerCommit(bob, [], { revokes: true })
      await bob.peer.enqueue(request)
      await vi.waitFor(() => expect(draining).toBe(true))
      expect((await bob.control.load()).commitOnce?.opID).toBe(request.id)
      if (move === 'expiry') now = 2_000
      else if (move === 'strand')
        await bob.control.apply({ strand: { reason: 'ahead' } }, 'ahead-during-drain')
      else {
        if (move === 'terminal') bob.mls.adopt(bob.mls.buildCommit([], { removes: ['bob'] }))
        else {
          const changed = JSON.parse(new TextDecoder().decode(bob.mls.serializeState())) as Record<
            string,
            unknown
          >
          changed.epochIdentity = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
          bob.mls.restoreState(new TextEncoder().encode(JSON.stringify(changed)))
        }
        await bob.database.saveState('bob', bob.mls.serializeState())
      }
      release()
      if (move !== 'expiry') {
        await bob.peer.ack('drain-finished')
        expect(handoffs).toBe(0)
        now = 2_000
        await bob.peer.replay()
      }
      await vi.waitFor(async () =>
        expect((await bob.peer.outcomes())[0]?.kind).toBe(move === 'expiry' ? 'lost' : 'unknown'),
      )
      expect(handoffs).toBe(0)
      expect((await bob.control.load()).commitOnce?.opID).toBe(request.id)
    } finally {
      release()
      await bob.peer.dispose()
      await bob.peer.drained()
    }
  },
)

test('growing head yields bounded search and deadline settlement without starving the lane', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  const hub = new FakeHub()
  const publish = hub.publish.bind(hub)
  const fetch = hub.fetchTopic.bind(hub)
  let growing = false
  let handoffs = 0
  let fetches = 0
  let searchCalls = 0
  let action: Promise<void> | undefined
  let actionSearch = 0
  let actionFetches = 0
  vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
    if (params.topicID === commitTopic(secret)) handoffs++
    return publish(params)
  })
  const bob = member(hub, { operationTimeoutMs: 1_000 })
  const restore = bob.validation.restoreValidation.bind(bob.validation)
  vi.spyOn(bob.validation, 'restoreValidation').mockImplementation((built) => {
    searchCalls++
    fetches = 0
    return restore(built)
  })
  vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
    if (growing && params.topicID === commitTopic(secret)) {
      fetches++
      if (fetches > 64) throw new Error('discovery did not yield within its budget')
      if (action === undefined) {
        vi.setSystemTime(2_000)
        action = bob.peer.ack('queued-lane-action').then(() => {
          actionSearch = searchCalls
          actionFetches = fetches
        })
      }
      await publish({
        senderDID: 'bob',
        topicID: commitTopic(secret),
        payload: new Uint8Array([0]),
        retain: 'log',
      })
    }
    return fetch(params)
  })
  await bob.peer.replay()
  let builds = 0
  const request = buildInviteCommit(bob, 'invitee', {
    onBuild: () => {
      builds++
      growing = true
    },
  })
  await bob.peer.enqueue(request)
  await vi.waitFor(() => expect(actionSearch).toBe(1))
  await action
  expect(actionFetches).toBeLessThanOrEqual(16)
  expect((await bob.peer.outcomes())[0]).toMatchObject({ opID: request.id, kind: 'unknown' })
  const retained = (await bob.control.load()).commitOnce
  if (retained === null) throw new Error('Missing retained slot')
  expect(handoffs).toBe(0)
  await bob.peer.ack(request.id)
  const accepted = await publish({
    senderDID: 'bob',
    topicID: commitTopic(secret),
    payload: retained.payload,
    publishID: retained.publishID,
    expectedHead: hub.head(commitTopic(secret)),
    retain: 'log',
  })
  await vi.advanceTimersByTimeAsync(15_000)
  expect((await bob.peer.outcomes())[0]).toMatchObject({
    opID: request.id,
    kind: 'landed',
    position: accepted.sequenceID,
  })
  expect(bob.mls.epoch()).toBe(retained.epoch + 1)
  expect(bob.welcomes).toEqual([request.id])
  expect(builds).toBe(1)
  expect(handoffs).toBe(0)
  expect(growing).toBe(true)
})

test('a competitor delivered between runner attempts clears the slot and permits one fresh build', async () => {
  vi.useFakeTimers()
  const hub = new FakeHub()
  const publish = hub.publish.bind(hub)
  let attempts = 0
  vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
    if (
      params.topicID === commitTopic(secret) &&
      params.senderDID === 'bob' &&
      bob.mls.epoch() === 1
    ) {
      attempts++
      throw new HeadMismatchError('competitor changed the head')
    }
    return publish(params)
  })
  const bob = member(hub)
  await bob.peer.replay()
  const builds: Array<number> = []
  const request = buildLedgerCommit(bob, ['revalidated'], {
    revokes: true,
    onBuild: () => {
      builds.push(bob.mls.epoch())
    },
  })
  await bob.peer.enqueue(request)
  await vi.waitFor(() => expect(attempts).toBeGreaterThan(0))
  expect((await bob.control.load()).operations[0]?.stage).toBe('built')
  await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
  await vi.waitFor(() => expect(bob.mls.epoch()).toBe(2))
  expect((await bob.control.load()).commitOnce).toBeNull()
  await vi.advanceTimersByTimeAsync(1_000)
  await vi.waitFor(async () => expect((await bob.peer.outcomes())[0]?.kind).toBe('landed'))
  expect(builds).toEqual([1, 2])
  expect((await bob.control.load()).operations).toEqual([])
  await expect(
    bob.peer.protocol('chat').dispatch('chat/changed', { data: {} }),
  ).resolves.toBeUndefined()
})

test('a committed acknowledgement tolerates transient evidence failure and unchanged refreshes avoid evidence reads', async () => {
  const hub = new FakeHub()
  const mls = createMemoryGroupMLS({ localDID: 'bob', recoverySecret: secret, epoch: 1 })
  const read = mls.readEvidence
  let fail = false
  let reads = 0
  mls.readEvidence = async () => {
    reads++
    if (fail) throw new Error('transient evidence failure')
    return read()
  }
  const bob = member(hub, { mls })
  await bob.peer.replay()
  const op = await seedBuiltOperation(bob, buildLedgerCommit(bob, []))
  await bob.control.apply(
    {
      deleteOperations: [op.id],
      putOutcomes: [{ id: 'ack-me', opID: op.id, kind: 'unknown', at: 0 }],
    },
    'orphan',
  )
  fail = true
  await expect(bob.peer.ack('ack-me')).resolves.toBeUndefined()
  expect((await bob.control.load()).outcomes).toEqual([])
  fail = false
  await bob.peer.ack('refresh-evidence')
  const before = reads
  await bob.peer.ack('unchanged-1')
  await bob.peer.ack('unchanged-2')
  expect(reads).toBe(before)
})

test('a hard hold preserves applied history and keeps the first hard reason', async () => {
  const hub = new FakeHub()
  const bob = member(hub)
  await bob.peer.replay()
  const applied = {
    epoch: 0,
    digest: 'prior-commit',
    payloadDigest: 'prior-payload',
    sequenceID: '000',
    opID: null,
    removed: false,
  }
  await bob.control.apply(
    { cursor: { position: null, epoch: 1 }, putApplied: [applied] },
    'history-before-hold',
  )
  const frame = encodeHandshakeFrame(HANDSHAKE_KIND.commit, new Uint8Array([1]))
  frame[HANDSHAKE_MAGIC.length] = HANDSHAKE_VERSION + 1
  await hub.publish({
    senderDID: 'alice',
    topicID: commitTopic(secret),
    payload: frame,
    retain: 'log',
  })
  await vi.waitFor(async () =>
    expect((await bob.control.load()).controlHold?.reason).toBe('unsupported-version'),
  )
  expect((await bob.control.load()).applied).toEqual([applied])
  await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: 1 })
  await bob.peer.replay()
  expect((await bob.control.load()).controlHold?.reason).toBe('unsupported-version')
  expect((await bob.control.load()).applied).toEqual([applied])
})

test('pre-adoption Welcome delivery reuses the proof just checked in its settlement pass', async () => {
  vi.useFakeTimers()
  const hub = new FakeHub()
  let reads = 0
  let readsAtAdoption = 0
  const bob = member(hub, {
    adopt: async () => {
      readsAtAdoption = reads
      return 'moved'
    },
  })
  await bob.peer.replay()
  const restore = bob.validation.restoreValidation.bind(bob.validation)
  vi.spyOn(bob.validation, 'restoreValidation').mockImplementation(async (built) => {
    reads++
    return restore(built)
  })
  const request = buildInviteCommit(bob, 'invitee')
  await bob.peer.enqueue(request)
  await vi.waitFor(() => expect(bob.welcomes).toEqual([request.id]))
  expect(readsAtAdoption).toBeGreaterThan(0)
  expect(reads).toBe(readsAtAdoption)
})
