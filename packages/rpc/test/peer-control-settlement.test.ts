import { HeadMismatchError } from '@kumiai/hub-protocol'
import { afterEach, expect, test, vi } from 'vitest'

import { readmissionChanges } from '../src/control/store.js'
import type { Outcome } from '../src/control/types.js'
import {
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  HANDSHAKE_MAGIC,
  HANDSHAKE_VERSION,
} from '../src/handshake.js'
import { createGroupPeer } from '../src/peer.js'
import { commitTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'
import { memoryAuthenticator } from './fixtures/memory-group-mls.js'
import {
  buildInviteCommit,
  buildLedgerCommit,
  latchPeerSafety,
  makeMLSPeer,
  seedBuiltOperation,
  type TestPeer,
} from './fixtures/peer.js'

test('a synchronous report dependency failure releases the reporting latch for retry', async () => {
  vi.useFakeTimers()
  const hub = new FakeHub()
  const bob = member(hub)
  await bob.peer.replay()
  const saved = await seedBuiltOperation(bob, buildLedgerCommit(bob, ['report']))
  await bob.peer.dispose()
  await bob.peer.drained()
  const load = vi.spyOn(bob.control, 'load')
  // JavaScript hosts can supply control storage without the required MLS ports.
  const peer = createGroupPeer({
    hub,
    crypto: createFakeCrypto({ epoch: 1, localDID: 'bob' }),
    localDID: 'bob',
    protocols: {},
    handlers: {},
    ...({ control: bob.control } as object),
  })
  try {
    await peer.outcomes()
    await vi.advanceTimersByTimeAsync(saved.deadline - Date.now())
    const reads = load.mock.calls.length
    await vi.advanceTimersByTimeAsync(100)
    expect(load.mock.calls.length).toBeGreaterThan(reads)
    expect((await bob.control.load()).commitOnce?.reported).not.toBe(true)
  } finally {
    await peer.dispose()
    await peer.drained()
  }
})

test('readmission closes recovery work with a fresh final unknown outcome', async () => {
  const bob = member(new FakeHub())
  await bob.peer.replay()
  const saved = await seedBuiltOperation(bob, buildInviteCommit(bob, 'invitee'))
  const before = await bob.control.load()
  const changes = readmissionChanges({
    ...before,
    outcomes: [{ id: 'provisional', opID: saved.id, at: 1, kind: 'unknown' }],
  })
  expect(changes.commitOnce).toBeNull()
  expect(changes.spentSource).toBeNull()
  expect(changes.deleteOutcomes).toEqual(['provisional'])
  expect(changes.putOutcomes).toMatchObject([{ opID: saved.id, kind: 'unknown' }])
  expect(changes.putOutcomes?.[0]?.id).not.toBe('provisional')
})

test('unsupported delivery never attempts a hold write even when that write would fail', async () => {
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
  const { sequenceID } = await hub.publish({
    senderDID: 'alice',
    topicID: commitTopic(secret),
    payload: frame,
    retain: 'log',
  })
  await bob.peer.replay()
  expect((await control.load()).cursor?.position).toBe(sequenceID)
  expect(failures).toBe(0)
  await bob.peer.ack('refresh-after-poison')
  expect((await control.load()).controlHold).toBeNull()
  expect((await control.load()).strand).toBeNull()
  await expect(bob.peer.commit(buildLedgerCommit(bob, ['progress']))).resolves.toBeDefined()
  expect(bob.mls.epoch()).toBe(2)
})

test('a speculative Welcome stays embedded when adoption moves to a hard hold', async () => {
  const hub = new FakeHub()
  const bob = member(hub, {
    adopt: async (_journal, expected) => {
      await bob.control.apply(
        {
          controlHold: { reason: 'unsupported-version', position: expected.occurrence.position },
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
    expect((await bob.control.load()).controlHold?.reason).toBe('unsupported-version'),
  )
  await bob.peer.replay()
  expect((await bob.control.load()).controlHold?.reason).toBe('unsupported-version')
  expect((await bob.control.load()).welcomes).toEqual([])
  expect(bob.welcomes).toEqual([])
})

test('a speculative Welcome stays embedded when adoption moves to a strand', async () => {
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
  await bob.controlWalk.walkCommits()
  expect(bob.welcomes).toEqual([])
  const snapshot = await bob.control.load()
  expect(snapshot.strand).toEqual({ reason: 'ahead' })
  expect(snapshot.commitOnce).not.toBeNull()
  expect(snapshot.commitOnce?.welcome).toEqual(op.slot.welcome)
  expect(snapshot.welcomes).toEqual([])
  expect(bob.mls.epoch()).toBe(op.slot.epoch)
})

test('live-build retries coalesce reconnect hints and stop on lifecycle closure or a hard hold', async () => {
  vi.useFakeTimers()
  const hub = new FakeHub()
  const bob = member(hub)
  await bob.peer.replay()
  const saved = await seedBuiltOperation(bob, buildLedgerCommit(bob, ['retry']))
  const publish = vi.spyOn(hub, 'publish').mockRejectedValue(new Error('Disconnected'))
  await bob.controlWalk.stepOperation(saved.id)
  const initial = publish.mock.calls.length
  expect(initial).toBe(1)
  await bob.peer.ack('reconnect-one')
  await bob.peer.ack('reconnect-two')
  await flushCurrentTasks()
  expect(publish).toHaveBeenCalledTimes(initial + 1)
  await bob.control.apply(
    {
      controlHold: { reason: 'unsupported-version', position: null },
      strand: { reason: 'unsupported-version' },
    },
    'hard-hold',
  )
  await bob.peer.ack('refresh-hard-hold')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(publish).toHaveBeenCalledTimes(initial + 1)
  expect((await bob.control.load()).commitOnce?.opID).toBe(saved.id)
  await bob.peer.abandon()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(publish).toHaveBeenCalledTimes(initial + 1)
  expect((await bob.control.load()).commitOnce).toBeNull()
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

test('own-local input failures hold and retry the occurrence before compulsory D1 resync', async () => {
  vi.useFakeTimers()
  const hub = new FakeHub()
  const bob = member(hub)
  await bob.peer.replay()
  const saved = await seedBuiltOperation(bob, buildLedgerCommit(bob, ['unavailable']))
  vi.spyOn(bob.validation, 'restoreValidation').mockResolvedValue(null)
  await hub.publish({
    senderDID: 'bob',
    topicID: commitTopic(secret),
    retain: 'log',
    payload: saved.slot.payload,
  })
  await bob.controlWalk.walkCommits()
  expect((await bob.control.load()).strand).toBeNull()
  vi.setSystemTime(saved.deadline)
  await bob.controlWalk.stepOperation(saved.id)
  expect((await bob.control.load()).commitOnce?.reported).toBe(true)
  for (let i = 0; i < 4; i++) {
    vi.setSystemTime(Date.now() + 1000)
    await bob.controlWalk.walkCommits()
  }
  expect((await bob.control.load()).strand).toEqual({ reason: 'unprocessable-gap' })
  expect(await bob.peer.outcomes()).toMatchObject([{ opID: saved.id, kind: 'unknown' }])
})

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

test('abandon deletes obligations explicitly and later competitor consumption preserves remaining obligations', async () => {
  vi.useFakeTimers()
  const hub = new FakeHub()
  const bob = member(hub)
  await bob.peer.replay()
  await seedBuiltOperation(bob, buildInviteCommit(bob, 'speculative'))
  const owed = { opID: 'owed', welcome: new Uint8Array([3]), recipients: ['guest'] }
  await bob.control.apply({ putWelcomes: [owed] }, 'owed')
  await bob.peer.abandon()
  expect((await bob.control.load()).welcomes).toEqual([])
  await bob.control.apply({ putWelcomes: [owed] }, 'owed-later')
  await publishCommit({
    authenticator: memoryAuthenticator(bob.mls),
    hub,
    senderDID: 'alice',
    recoverySecret: secret,
    epoch: 1,
  })
  await bob.controlWalk.walkCommits()
  expect((await bob.control.load()).welcomes).toEqual([owed])
  expect((await bob.control.load()).spentSource).toBeNull()
})

test.each([false, true])(
  'an ahead prefix retains the built slot without publication or own adoption (own=%s)',
  async (own) => {
    vi.useFakeTimers()
    const hub = new FakeHub()
    const bob = member(hub)
    await bob.peer.replay()
    const op = await seedBuiltOperation(bob, buildInviteCommit(bob, 'invitee'))
    // The ordinary walker must meet the ahead frame before attempting own installation.
    const ahead = await publishCommit({
      authenticator: memoryAuthenticator(bob.mls),
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
    await bob.controlWalk.walkCommits()
    expect(hub.published).toHaveLength(publications)
    const snapshot = await bob.control.load()
    expect(snapshot.strand).toEqual({ reason: 'ahead' })
    expect(snapshot.cursor?.stranded).toBe(true)
    expect(snapshot.commitOnce).toEqual(op.slot)
    expect(snapshot.applied).toEqual([])
    expect(snapshot.outcomes).toEqual([])
    expect(bob.mls.epoch()).toBe(op.slot.epoch)
    expect(bob.welcomes).toEqual([])
  },
)

test('nested competitor removal keeps its terminal unknown when the stale runner expires', async () => {
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
    authenticator: memoryAuthenticator(bob.mls),
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
      expect.objectContaining({ opID: op.id, kind: 'unknown' }),
    ])
    vi.setSystemTime(op.deadline)
    return result
  })
  await bob.controlWalk.walkCommits()
  await vi.advanceTimersByTimeAsync(0)
  expect((await bob.control.load()).operations).toEqual([])
  expect((await bob.control.load()).outcomes).toEqual([
    expect.objectContaining({ opID: op.id, kind: 'unknown' }),
  ])
  expect(seen).toEqual([expect.objectContaining({ opID: op.id, kind: 'unknown' })])
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
  expect(snapshot.operations).toEqual([])
  expect(snapshot.commitOnce).toMatchObject({
    opID: op.id,
    skipped: true,
    acceptedAs: expect.any(String),
  })
  expect(snapshot.outcomes).toEqual([])
  expect(snapshot.applied).toEqual([])
  expect(snapshot.cursor?.position).toBe(hub.head(commitTopic(secret)))
})

test.each([1_000, 60_000])(
  'an empty ordinary walk below the reported head cannot prove absence with timeout %s',
  async (operationTimeoutMs) => {
    const hub = new FakeHub()
    const bob = member(hub, { operationTimeoutMs })
    await bob.peer.replay()
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const op = await seedBuiltOperation(bob, buildLedgerCommit(bob, ['retained-then-hidden']))
    const accepted = await hub.publish({
      senderDID: 'bob',
      topicID: commitTopic(secret),
      payload: op.slot.payload,
      publishID: op.slot.publishID,
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
    expect((await bob.control.load()).operations).toEqual([])
    now = op.deadline
    await bob.peer.replay()
    const snapshot = await bob.control.load()
    expect(snapshot.operations).toEqual([])
    expect(snapshot.outcomes).toEqual([expect.objectContaining({ opID: op.id, kind: 'unknown' })])
    expect(snapshot.applied).toEqual([])
    expect(snapshot.cursor?.position ?? null).toBeNull()
    expect(snapshot.commitOnce).toEqual({
      ...op.slot,
      expectedHead: accepted.sequenceID,
      reported: true,
    })
    expect(snapshot.controlHold).toBeNull()
    clock.mockRestore()
  },
)

test('a durable landed report survives anchor-save failure and emits once per process', async () => {
  const hub = new FakeHub()
  const onOutcome = vi.fn()
  const bob = member(hub, { onOutcome })
  await bob.peer.replay()
  const save = bob.anchorStore.save.bind(bob.anchorStore)
  let failures = 0
  vi.spyOn(bob.anchorStore, 'save').mockImplementation(async (slot) => {
    if (slot.anchor.epoch === 2 && slot.pending == null && failures === 0) {
      failures++
      throw new Error('Anchor save unavailable after adoption')
    }
    await save(slot)
  })
  const request = buildInviteCommit(bob, 'durable-outcome-invitee')
  await bob.peer.commit(request)
  expect(failures).toBe(1)
  await bob.peer.replay()
  expect(bob.peer.anchorEpoch()).toBe(2)
  expect((await bob.anchorStore.load())?.pending).toBeUndefined()
  await bob.peer.ack('unrelated')
  expect(onOutcome).toHaveBeenCalledTimes(1)
  const final = (await bob.peer.outcomes())[0]
  await bob.peer.dispose()
  await bob.peer.drained()
  const replay = vi.fn()
  const again = member(hub, { restartOf: bob, onOutcome: replay })
  await again.peer.replay()
  expect(replay).toHaveBeenCalledExactlyOnceWith(final)
})

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

test.each(['consume', 'abandon'] as const)(
  'an acknowledged provisional report is replaced by a fresh final report on %s',
  async (exit) => {
    vi.useFakeTimers()
    const hub = new FakeHub()
    const bob = member(hub)
    await bob.peer.replay()
    const saved = await seedBuiltOperation(bob, buildInviteCommit(bob, 'invitee'))
    vi.setSystemTime(saved.deadline)
    await bob.controlWalk.stepOperation(saved.id)
    const provisional = (await bob.peer.outcomes())[0]
    if (provisional === undefined) throw new Error('Missing provisional report')
    await bob.peer.ack(provisional.id)
    if (exit === 'abandon') await bob.peer.abandon()
    const own = await hub.publish({
      senderDID: 'bob',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: saved.slot.payload,
      publishID: saved.slot.publishID,
    })
    await bob.controlWalk.walkCommits()
    const final = (await bob.peer.outcomes())[0]
    expect(final).toMatchObject({ opID: saved.id, kind: exit === 'consume' ? 'landed' : 'unknown' })
    expect(final?.id).not.toBe(provisional.id)
    await bob.peer.ack(provisional.id)
    expect(await bob.peer.outcomes()).toEqual([final])
    const closed = await bob.control.load()
    expect(closed.commitOnce).toBeNull()
    expect(closed.cursor?.position).toBe(own.sequenceID)
    expect(bob.mls.epoch()).toBe(exit === 'consume' ? 2 : 1)
    if (exit === 'abandon') {
      expect(closed.spentSource).toEqual({ epoch: 1, opID: saved.id })
      const mutation = await bob.control.lastMutation()
      await bob.peer.abandon()
      expect(await bob.control.lastMutation()).toBe(mutation)
      await bob.peer.ack(final?.id ?? '')
      await bob.peer.dispose()
      await bob.peer.drained()
      const again = member(hub, { restartOf: bob })
      await again.peer.replay()
      expect((await again.control.load()).spentSource).toEqual({ epoch: 1, opID: saved.id })
      await expect(again.peer.enqueue(saved)).rejects.toMatchObject({
        name: 'OperationRejectedError',
      })
      const successor = buildLedgerCommit(again, ['no-generation-reuse'])
      await again.peer.enqueue(successor)
      await flushCurrentTasks()
      expect((await again.control.load()).commitOnce).toBeNull()
      expect((await again.control.load()).operations).toMatchObject([{ id: successor.id }])
      expect(again.mls.epoch()).toBe(1)
    }
  },
)

test('the clock reports once during an unfinished handoff and late acceptance can land once', async () => {
  vi.useFakeTimers()
  const hub = new FakeHub()
  const onOutcome = vi.fn()
  const accepted = Promise.withResolvers<void>()
  const publishing = Promise.withResolvers<void>()
  const publish = hub.publish.bind(hub)
  vi.spyOn(hub, 'publish').mockImplementation(async (request) => {
    if (request.topicID === commitTopic(secret)) {
      publishing.resolve()
      await accepted.promise
    }
    return publish(request)
  })
  const bob = member(hub, { operationTimeoutMs: 100, onOutcome })
  await bob.peer.replay()
  const op = buildLedgerCommit(bob, ['in-flight'], { revokes: true })
  await bob.peer.enqueue(op)
  await flushCurrentTasks()
  await publishing.promise
  try {
    await vi.advanceTimersByTimeAsync(100)
    const provisional = (await bob.control.load()).outcomes[0]
    expect(provisional).toMatchObject({ kind: 'unknown', opID: op.id })
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith(provisional)
    expect((await bob.control.load()).commitOnce?.reported).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect((await bob.control.load()).outcomes).toEqual([provisional])
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith(provisional)
  } finally {
    accepted.resolve()
    await flushCurrentTasks()
  }
  await vi.waitFor(async () => expect((await bob.control.load()).commitOnce).toBeNull())
  expect((await bob.peer.outcomes())[0]).toMatchObject({ kind: 'landed', opID: op.id })
  expect(onOutcome).toHaveBeenCalledTimes(2)
  expect(hub.published.filter((row) => row.topicID === commitTopic(secret))).toHaveLength(1)
})

test('abandon interrupts a revoke submission drain and keeps earlier submissions tracked', async () => {
  vi.useFakeTimers()
  const hub = new FakeHub()
  const release = Promise.withResolvers<void>()
  const submitting = Promise.withResolvers<void>()
  const publish = hub.publish.bind(hub)
  vi.spyOn(hub, 'publish').mockImplementation(async (request) => {
    if (request.topicID !== commitTopic(secret)) {
      submitting.resolve()
      await release.promise
    }
    return publish(request)
  })
  const bob = member(hub)
  await bob.peer.replay()
  await bob.peer.protocol('chat').dispatch('chat/posted', { data: { beforeRevoke: true } })
  await flushCurrentTasks()
  await submitting.promise
  const saved = await seedBuiltOperation(
    bob,
    buildLedgerCommit(bob, ['revoked'], { revokes: true }),
  )
  const stepping = bob.controlWalk.stepOperation(saved.id)
  let abandoned = false
  let abandoning: Promise<void> | undefined
  try {
    await flushCurrentTasks()
    abandoning = bob.peer.abandon().then(() => {
      abandoned = true
    })
    await flushCurrentTasks()
    expect(abandoned).toBe(true)
    expect((await bob.control.load()).commitOnce).toBeNull()
    expect(await bob.peer.outcomes()).toMatchObject([{ opID: saved.id, kind: 'unknown' }])
    expect((await bob.appOutbox.list()).length).toBe(1)
    // A later revoke must still drain the original, unresolved application submission.
    await publishCommit({
      authenticator: memoryAuthenticator(bob.mls),
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 1,
    })
    await bob.controlWalk.walkCommits()
    const next = await seedBuiltOperation(bob, buildLedgerCommit(bob, ['again'], { revokes: true }))
    let completed = false
    const retry = bob.controlWalk.stepOperation(next.id).then(() => {
      completed = true
    })
    await flushCurrentTasks()
    expect(completed).toBe(false)
    release.resolve()
    await retry
    expect(completed).toBe(true)
  } finally {
    release.resolve()
    await stepping
    await abandoning
  }
})

test('deadline reporting continues during submission drain and expiry prevents the later control handoff', async () => {
  vi.useFakeTimers()
  const hub = new FakeHub()
  const onOutcome = vi.fn()
  const release = Promise.withResolvers<void>()
  const submitting = Promise.withResolvers<void>()
  const publish = hub.publish.bind(hub)
  vi.spyOn(hub, 'publish').mockImplementation(async (request) => {
    if (request.topicID !== commitTopic(secret)) {
      submitting.resolve()
      await release.promise
    }
    return publish(request)
  })
  const bob = member(hub, { operationTimeoutMs: 100, onOutcome })
  await bob.peer.replay()
  await bob.peer.protocol('chat').dispatch('chat/posted', { data: { beforeRevoke: true } })
  await flushCurrentTasks()
  await submitting.promise
  const op = buildLedgerCommit(bob, ['revoke-after-drain'], { revokes: true })
  await bob.peer.enqueue(op)
  try {
    await flushCurrentTasks()
    await vi.advanceTimersByTimeAsync(100)
    expect((await bob.control.load()).outcomes).toMatchObject([{ kind: 'unknown', opID: op.id }])
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith((await bob.control.load()).outcomes[0])
    expect((await bob.control.load()).commitOnce?.reported).toBe(true)
    expect(hub.published.filter((row) => row.topicID === commitTopic(secret))).toEqual([])
  } finally {
    release.resolve()
    await flushCurrentTasks()
  }
  expect(hub.published.filter((row) => row.topicID === commitTopic(secret))).toEqual([])
  expect((await bob.control.load()).commitOnce?.opID).toBe(op.id)
})

test('abandon releases an unfinished handoff and a late hub acknowledgement cannot recreate its build', async () => {
  vi.useFakeTimers()
  const hub = new FakeHub()
  const accepted = Promise.withResolvers<void>()
  const publishing = Promise.withResolvers<void>()
  const publish = hub.publish.bind(hub)
  vi.spyOn(hub, 'publish').mockImplementation(async (request) => {
    if (request.topicID === commitTopic(secret)) {
      publishing.resolve()
      await accepted.promise
    }
    return publish(request)
  })
  const bob = member(hub)
  await bob.peer.replay()
  const op = buildLedgerCommit(bob, ['abandon-in-flight'])
  await bob.peer.enqueue(op)
  await flushCurrentTasks()
  await publishing.promise
  let abandoned = false
  const abandoning = bob.peer.abandon().then(() => {
    abandoned = true
  })
  try {
    await flushCurrentTasks()
    expect(abandoned).toBe(true)
    expect((await bob.control.load()).commitOnce).toBeNull()
    expect((await bob.control.load()).spentSource).toEqual({ epoch: 1, opID: op.id })
  } finally {
    accepted.resolve()
    await abandoning
    await flushCurrentTasks()
  }
  await bob.controlWalk.walkCommits()
  expect(await bob.peer.outcomes()).toMatchObject([{ opID: op.id, kind: 'unknown' }])
  expect((await bob.control.load()).commitOnce).toBeNull()
  expect(bob.mls.epoch()).toBe(1)
})

test('a competitor delivered between runner attempts clears the slot and settles the built operation lost', async () => {
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
  expect((await bob.control.load()).commitOnce?.opID).toBe(request.id)
  await publishCommit({
    authenticator: memoryAuthenticator(bob.mls),
    hub,
    senderDID: 'alice',
    recoverySecret: secret,
    epoch: 1,
  })
  await vi.waitFor(() => expect(bob.mls.epoch()).toBe(2))
  expect((await bob.control.load()).commitOnce).toBeNull()
  await vi.advanceTimersByTimeAsync(1_000)
  await vi.waitFor(async () => expect((await bob.peer.outcomes())[0]?.kind).toBe('lost'))
  expect(builds).toEqual([1])
  expect(bob.mls.epoch()).toBe(2)
  expect((await bob.control.load()).operations).toEqual([])
  await expect(
    bob.peer.protocol('chat').dispatch('chat/changed', { data: {} }),
  ).resolves.toBeUndefined()
})

test('outcome acknowledgement tolerates transient storage failure without redundant validation reads', async () => {
  const bob = member(new FakeHub())
  await bob.peer.replay()
  await bob.peer.commit(buildLedgerCommit(bob, ['acked']))
  const final = (await bob.peer.outcomes())[0]
  if (final === undefined) throw new Error('Missing final report')
  const validation = vi.spyOn(bob.validation, 'restoreValidation')
  bob.database.failNext('mid-apply')
  await expect(bob.peer.ack(final.id)).rejects.toThrow('Injected transaction failure')
  expect(await bob.peer.outcomes()).toEqual([final])
  await bob.peer.ack(final.id)
  expect(await bob.peer.outcomes()).toEqual([])
  expect(validation).not.toHaveBeenCalled()
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
  await bob.control.apply(
    {
      controlHold: { reason: 'unsupported-version', position: null },
      strand: { reason: 'unsupported-version' },
    },
    'saved-version-hold',
  )
  await bob.peer.ack('refresh-saved-hold')
  expect((await bob.control.load()).applied).toEqual([applied])
  await publishCommit({
    authenticator: memoryAuthenticator(bob.mls),
    hub,
    senderDID: 'bob',
    recoverySecret: secret,
    epoch: 1,
  })
  await bob.peer.replay()
  expect((await bob.control.load()).controlHold?.reason).toBe('unsupported-version')
  expect((await bob.control.load()).applied).toEqual([applied])
})

// Flush only work due now. Unlike vi.waitFor, this cannot advance into a retained backoff.
async function flushCurrentTasks() {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0)
}

test('a provisional unknown revoke holds application sends across acknowledgement and restart until closure', async () => {
  vi.useFakeTimers()
  const hub = new FakeHub()
  const bob = member(hub)
  await bob.peer.replay()
  const saved = await seedBuiltOperation(bob, buildLedgerCommit(bob, ['revoke'], { revokes: true }))
  vi.setSystemTime(saved.deadline)
  await bob.controlWalk.stepOperation(saved.id)
  const provisional = (await bob.peer.outcomes())[0]
  if (provisional === undefined) throw new Error('Missing provisional')
  await bob.peer.ack(provisional.id)
  await bob.peer.dispose()
  await bob.peer.drained()
  const again = member(hub, { restartOf: bob })
  await again.peer.replay()
  await again.peer.protocol('chat').dispatch('chat/posted', { data: {} })
  await flushCurrentTasks()
  expect(hub.published.filter((row) => row.topicID !== commitTopic(secret))).toEqual([])
  expect((await again.control.load()).commitOnce?.reported).toBe(true)
  expect(await again.peer.outcomes()).toEqual([])
  await again.peer.abandon()
  await again.peer.resync()
  await flushCurrentTasks()
  expect((await again.control.load()).commitOnce).toBeNull()
  expect(hub.published.filter((row) => row.topicID !== commitTopic(secret))).toHaveLength(1)
})

test('readmission preserves independent obligations and abandon deletes them explicitly', async () => {
  const bob = member(new FakeHub(), {
    deliverWelcome: async () => {
      throw new Error('Unavailable')
    },
  })
  await bob.peer.replay()
  const owed = { opID: 'owed', welcome: new Uint8Array([1, 2]), recipients: ['guest'] }
  await bob.control.apply({ putWelcomes: [owed] }, 'obligation')
  const reset = readmissionChanges(await bob.control.load())
  expect(reset.deleteWelcomes).toBeUndefined()
  await bob.peer.abandon()
  expect((await bob.control.load()).welcomes).toEqual([])
})

test('one control-walk step does not start another scheduler pass during refresh', async () => {
  vi.useFakeTimers()
  const bob = member(new FakeHub(), { operationTimeoutMs: 100 })
  await bob.peer.replay()
  const now = Date.now()
  const next = buildLedgerCommit(bob, ['visible-intent'])
  await bob.control.apply(
    { putOperations: [{ ...next, seq: 1, stage: 'intent', enqueuedAt: now, deadline: now + 100 }] },
    'durable-intent',
  )
  await bob.controlWalk.stepOperation(next.id)
  expect((await bob.control.load()).operations).toEqual([])
  expect((await bob.control.load()).commitOnce?.opID).toBe(next.id)
  await flushCurrentTasks()
  expect((await bob.peer.outcomes()).find((row) => row.opID === next.id)).toBeUndefined()
  expect((await bob.control.load()).commitOnce?.opID).toBe(next.id)
  await bob.peer.replay()
  await flushCurrentTasks()
  expect(Date.now()).toBe(now)
  expect((await bob.peer.outcomes()).find((row) => row.opID === next.id)?.kind).toBe('landed')
})

test('post-apply latch reconstructs committed control bookkeeping', async () => {
  const hub = new FakeHub()
  const bob = member(hub, { operationTimeoutMs: 100 })
  await bob.peer.replay()
  const saved = await seedBuiltOperation(bob, buildInviteCommit(bob, 'frozen-invitee'))
  const now = vi.spyOn(Date, 'now').mockReturnValue(saved.deadline)
  await bob.controlWalk.stepOperation(saved.id)
  now.mockRestore()
  const provisional = (await bob.peer.outcomes())[0]
  if (provisional === undefined) throw new Error('Missing provisional report')
  await bob.peer.ack(provisional.id)
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const adopt = bob.mls.adoptOperation.bind(bob.mls)
  const adopting = vi.spyOn(bob.mls, 'adoptOperation').mockImplementation(async (...args) => {
    const result = await adopt(...args)
    entered.resolve()
    await released.promise
    return result
  })
  await hub.publish({
    senderDID: 'bob',
    topicID: commitTopic(secret),
    retain: 'log',
    payload: saved.slot.payload,
    publishID: saved.slot.publishID,
  })
  const walking = bob.controlWalk.walkCommits().catch(() => {})
  try {
    await entered.promise
    const committed = await bob.control.load()
    const final = committed.outcomes[0]
    expect(final).toMatchObject({ opID: saved.id, kind: 'landed' })
    expect(final?.id).not.toBe(provisional.id)
    expect(committed.cursor?.epoch).toBe(2)
    expect(committed.welcomes).toHaveLength(1)
    latchPeerSafety(bob, 'fork-halted')
    await bob.control.apply(
      {
        forkHalt: {
          eventID: JSON.stringify(['group:fork', 'memory-group', 1]),
          detectedAt: 1,
          evidence: { kind: 'unexplained-own-commit', epoch: 1, position: '1', digest: 'fork' },
        },
      },
      crypto.randomUUID(),
    )
    await bob.peer.dispose()
    released.resolve()
    await walking
    await bob.peer.drained()
    adopting.mockRestore()
    const published = hub.published.length
    const replayed = vi.fn()
    const again = member(hub, { restartOf: bob, onOutcome: replayed })
    const secondAdopt = vi.spyOn(again.mls, 'adoptOperation')
    const readEpoch = vi.spyOn(again.mls, 'readEpoch')
    expect(await again.peer.outcomes()).toEqual([final])
    await again.peer.ack(provisional.id)
    expect(await again.peer.outcomes()).toEqual([final])
    await vi.waitFor(async () => expect((await again.control.load()).welcomes).toEqual([]))
    expect(again.welcomes).toContain(saved.id)
    expect((await again.control.load()).cursor).toEqual(committed.cursor)
    expect((await again.control.load()).commitOnce).toBeNull()
    expect(replayed).toHaveBeenCalledExactlyOnceWith(final)
    expect(secondAdopt).not.toHaveBeenCalled()
    expect(readEpoch).not.toHaveBeenCalled()
    expect(hub.published).toHaveLength(published)
  } finally {
    released.resolve()
    await walking
  }
})
