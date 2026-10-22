import { HeadMismatchError } from '@kumiai/hub-protocol'
import { afterEach, expect, test, vi } from 'vitest'

import type { Outcome } from '../src/control/types.js'
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
import {
  buildInviteCommit,
  buildLedgerCommit,
  makeMLSPeer,
  seedBuiltOperation,
  type TestPeer,
} from './fixtures/peer.js'

// R3: readmission must close recovery work with final report identities.
test.todo('readmission closes recovery work with a fresh final unknown outcome')

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

// R3: build retry scheduling and cancellation require lifecycle service.
test.todo(
  'live-build retries coalesce reconnect hints and stop on lifecycle closure or a hard hold',
)

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

// R3: bounded local-input retry and D1 backstop replace orphan search retries; abandonment cannot reopen work.
test.todo('own-local input failures hold and retry the occurrence before compulsory D1 resync')

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

// R3: abandonment deletes independent obligations explicitly; consumption preserves every remaining obligation.
test.todo(
  'abandon deletes obligations explicitly and later competitor consumption preserves remaining obligations',
)

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

// R3: durable report routing after anchor-save failure needs the reporting service.
test.todo('a durable landed report emits once per process after anchor-save completion')

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

// R3: final reports use fresh IDs after provisional acknowledgement; abandoned builds never install.
test.todo(
  'an acknowledged provisional report is replaced by a fresh final report at own occurrence consumption',
)

// R3: clock-only expiry reports unknown during an unfinished drain and prevents later handoff.
test.todo(
  'deadline or lifecycle changes during submission drain prevent handoff while clock-only reporting continues',
)

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
  await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
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

// R3: acknowledgement must tolerate transient storage failure and avoid unnecessary validation reads.
test.todo(
  'outcome acknowledgement tolerates transient storage failure without redundant validation reads',
)

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
  await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: 1 })
  await bob.peer.replay()
  expect((await bob.control.load()).controlHold?.reason).toBe('unsupported-version')
  expect((await bob.control.load()).applied).toEqual([applied])
})

// Flush only work due now. Unlike vi.waitFor, this cannot advance into a retained backoff.
async function flushCurrentTasks() {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0)
}

// R3: provisional unknown retains the revoke hold across acknowledgement and restart until consumption or abandonment.
test.todo(
  'a provisional unknown revoke holds application sends across acknowledgement and restart until closure',
)

// R3: readmission preserves independent obligations and abandonment deletes them explicitly.
test.todo('readmission preserves independent obligations and abandon deletes them explicitly')

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
