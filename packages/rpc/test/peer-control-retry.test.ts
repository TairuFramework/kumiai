import { afterEach, expect, test, vi } from 'vitest'

import { digestAppliedCommit } from '../src/classify.js'
import { decodeCommitFrame, encodeCommitFrame } from '../src/commit-frame.js'
import type { ControlSnapshot } from '../src/control/types.js'
import { PeerDisposedError } from '../src/errors.js'
import { FrameTooLargeError } from '../src/frame-size.js'
import { decodeHandshakeFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { APP_TOPIC_LABEL, commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'
import {
  buildLedgerCommit,
  makeMLSPeer,
  rejoinSourceEpoch,
  type TestPeer,
} from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0xa3)
const peers: Array<TestPeer> = []
afterEach(async () => {
  await Promise.all(peers.map(({ peer }) => peer.dispose()))
  await Promise.all(peers.splice(0).map(({ peer }) => peer.drained()))
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test.each(['ordinary', 'restarted'] as const)(
  '%s peer binds its control store to the MLS source key rather than its storage alias',
  async (kind) => {
    const hub = new FakeHub()
    const original = makeMLSPeer(hub, 'alice', secret)
    peers.push(original)
    await original.peer.replay()
    let member = original
    if (kind === 'restarted') {
      await original.database.saveState('alice', original.mls.serializeState())
      await original.peer.dispose()
      await original.peer.drained()
      member = makeMLSPeer(hub, 'alice', secret, { restartOf: original })
      peers.push(member)
      await member.peer.replay()
    }
    const source = await member.mls.readRecoverySource()
    expect(source.key).toEqual({ groupID: 'memory-group', incarnation: 1 })
    expect(member.control.key).toEqual(source.key)
    expect(member.mls.control().key).toEqual(source.key)
    const leaked = member.control.key
    leaked.groupID = 'storage-alias'
    expect(member.control.key).toEqual(source.key)
  },
)

test.each(['ambiguous', 'uncommitted'] as const)(
  'startup retries an %s landed anchor save without releasing sends early',
  async (failure) => {
    const hub = new FakeHub()
    const seed = makeMLSPeer(hub, 'bob', secret, { members: ['alice', 'bob', 'carol'] })
    peers.push(seed)
    await seed.peer.replay()
    await seed.peer.dispose()
    await seed.peer.drained()
    const anchor = seed.anchorStore.stored()
    if (anchor == null) throw new Error('Missing anchor')
    const commit = seed.mls.buildCommit([], { removes: ['carol'] })
    seed.mls.adopt(commit)
    await seed.database.saveState('bob', seed.mls.serializeState())
    await seed.anchorStore.save({
      anchor,
      pending: {
        epochBefore: 1,
        epochAfter: 2,
        rosterBefore: ['alice', 'bob', 'carol'],
        forced: false,
        advance: digestAppliedCommit(commit),
        landed: true,
      },
    })
    if (failure === 'ambiguous') seed.database.commitThenRejectNext('anchor')
    else seed.database.failNext('mid-anchor')
    const save = seed.anchorStore.save
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    let saves = 0
    seed.anchorStore.save = async (slot) => {
      saves++
      if (saves > 1) await paused
      await save(slot)
    }
    const again = makeMLSPeer(hub, 'bob', secret, { restartOf: seed })
    peers.push(again)
    const exported = vi.spyOn(again.crypto, 'exportSecret')
    const replay = again.peer.replay()
    void replay.catch(() => {})
    const before = hub.published.length
    const send = again.peer.protocol('chat').dispatch('chat/posted', { data: { repaired: true } })
    void send.catch(() => {})
    try {
      await vi.waitFor(() => expect(saves).toBeGreaterThan(1))
      expect(again.peer.anchorEpoch()).toBe(1)
      expect(hub.published).toHaveLength(before)
    } finally {
      release()
    }
    await expect(replay).resolves.toEqual({})
    await send
    await expect(again.peer.outcomes()).resolves.toEqual([])
    await expect(again.peer.resync()).resolves.toBeUndefined()
    expect(again.peer.anchorEpoch()).toBe(2)
    expect((await again.anchorStore.load())?.pending).toBeUndefined()
    expect(exported.mock.calls.filter(([label]) => label === APP_TOPIC_LABEL)).toHaveLength(1)
    expect(hub.published.filter((row) => row.topicID !== commitTopic(secret))).toHaveLength(1)
  },
)

test('the FIFO writer leaves successors as intents while guarded adoption has moved', async () => {
  const hub = new FakeHub()
  const database = createMemoryHostDatabase()
  const control = database.control('bob', { groupID: 'memory-group', incarnation: 1 })
  const snapshots: Array<ControlSnapshot> = []
  const options = {
    members: ['alice', 'bob'],
    recovery: { timeoutMs: 200, deadlineMs: 2000, getDelayMs: () => 0 },
  }
  const alice = makeMLSPeer(hub, 'alice', secret, options)
  peers.push(alice)
  const seed = makeMLSPeer(hub, 'bob', secret, {
    ...options,
    database,
    adopt: async () => 'moved',
    control: {
      ...control,
      apply: async (changes, mutationID) => {
        await control.apply(changes, mutationID)
        const snapshot = await control.load()
        snapshots.push(snapshot)
        if (snapshot.rejoin?.stage === 'built') {
          expect(rejoinSourceEpoch(snapshot.rejoin)).toBe(seed.mls.epoch())
          void seed.peer.dispose()
        }
      },
    },
  })
  peers.push(seed)
  await Promise.all([alice.peer.replay(), seed.peer.replay()])
  const first = buildLedgerCommit(seed, ['first'])
  const second = buildLedgerCommit(seed, ['second'])
  await Promise.all([seed.peer.enqueue(first), seed.peer.enqueue(second)])
  await vi.waitFor(async () =>
    expect((await control.load()).controlHold?.reason).toBe('acceptance-unknown'),
  )
  expect(await control.load()).toMatchObject({
    operations: [
      { id: first.id, stage: 'accepted' },
      { id: second.id, stage: 'intent' },
    ],
    rejoin: null,
    controlHold: { reason: 'acceptance-unknown' },
  })
  expect(
    snapshots.every((snapshot) =>
      snapshot.operations.slice(1).every((op) => op.stage === 'intent'),
    ),
  ).toBe(true)
  const held = await control.load()
  expect(held.controlHold?.position).toBe(held.commitOnceAcceptance?.position)
  expect(
    hub.published.filter(
      (message) => message.topicID === rendezvousTopic(secret) && message.senderDID === 'bob',
    ),
  ).toEqual([])
  await seed.peer.dispose()
  await seed.peer.drained()
  const again = makeMLSPeer(hub, 'bob', secret, { ...options, restartOf: seed })
  peers.push(again)
  await vi.waitFor(async () => expect((await again.control.load()).operations).toEqual([]))
  expect(await again.peer.outcomes()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ opID: first.id, kind: 'landed' }),
      expect.objectContaining({ opID: second.id, kind: 'landed' }),
    ]),
  )
})

test.each(['build', 'frame'] as const)(
  'an oversized %s rejects durably before restart and releases the FIFO and revoke hold',
  async (phase) => {
    const hub = new FakeHub()
    const seed = makeMLSPeer(hub, 'bob', secret, { operationTimeoutMs: 30_000 })
    peers.push(seed)
    await seed.peer.replay()
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() - 10_000)
    const oversized = buildLedgerCommit(seed, [], {
      revokes: true,
      ...(phase === 'build'
        ? {
            onBuild: () => {
              throw new FrameTooLargeError({ rawBytes: 786433 })
            },
          }
        : { transform: (built) => ({ ...built, commit: new Uint8Array(786433) }) }),
    })
    const successor = buildLedgerCommit(seed, ['valid-successor'])
    const stopAfterRejection = (): void => {
      seed.database.seam('after-apply', async () => {
        if ((await seed.control.load()).outcomes.some((outcome) => outcome.id === oversized.id))
          void seed.peer.dispose()
        else stopAfterRejection()
      })
    }
    stopAfterRejection()
    await Promise.all([
      seed.peer.enqueue(oversized),
      seed.peer.enqueue(successor),
      seed.peer.protocol('chat').dispatch('chat/posted', { data: { afterRejection: true } }),
    ])
    await vi.advanceTimersByTimeAsync(0)
    const snapshot = await seed.control.load()
    expect(snapshot.outcomes).toEqual([
      expect.objectContaining({
        id: oversized.id,
        kind: 'rejected',
        reason: expect.stringContaining('exceeds'),
      }),
    ])
    expect(snapshot.operations).toEqual([
      expect.objectContaining({ id: successor.id, stage: 'intent' }),
    ])
    expect(hub.published).toHaveLength(0)
    await seed.peer.dispose()
    await seed.peer.drained()
    vi.useRealTimers()
    const again = makeMLSPeer(hub, 'bob', secret, { restartOf: seed, operationTimeoutMs: 0 })
    peers.push(again)
    await vi.waitFor(async () => {
      expect(await again.peer.outcomes()).toEqual([
        snapshot.outcomes[0],
        expect.objectContaining({ opID: successor.id, kind: 'landed' }),
      ])
      expect(hub.published.filter((row) => row.topicID !== commitTopic(secret))).toHaveLength(1)
    })
    expect(again.mls.epoch()).toBe(2)
    expect(await again.mls.getLedger()).toEqual(['valid-successor'])
    expect((await again.control.load()).operations).toEqual([])
    expect(hub.published.filter((row) => row.topicID === commitTopic(secret))).toHaveLength(1)
  },
)

test('a post-adoption host failure resolves commit from its co-committed landed outcome', async () => {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'bob', secret)
  peers.push(member)
  const request = buildLedgerCommit(member, ['durable'], {
    onAdopt: async (adopt) => {
      await adopt()
      throw new Error('Notification failed after durable adoption')
    },
  })
  const result = await member.peer.commit(request)
  expect(await member.peer.outcomes()).toEqual([
    expect.objectContaining({ opID: request.id, kind: 'landed', position: result.position }),
  ])
  expect(member.mls.epoch()).toBe(2)
  expect((await member.control.load()).operations).toEqual([])
})

test('a commit lands after skipping an orphaned own copy', async () => {
  const hub = new FakeHub()
  await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: 1 })
  const member = makeMLSPeer(hub, 'bob', secret, {
    recovery: { timeoutMs: 20, deadlineMs: 100, getDelayMs: () => 0 },
  })
  peers.push(member)
  await member.peer.replay()
  const request = buildLedgerCommit(member, ['wait-for-recovery'])
  await member.peer.commit(request)
  expect(member.controlWalk.safetyHold()).toBeNull()
  expect(member.mls.epoch()).toBe(2)
  expect((await member.control.load()).operations).toEqual([])
  await member.peer.dispose()
})

test.each([false, true])(
  'tampered own named-entry copy preserves identical retry and receiver application (restart=%s)',
  async (restart) => {
    const hub = new FakeHub()
    const receiver = makeMLSPeer(hub, 'bob', secret)
    const author = makeMLSPeer(hub, 'alice', secret)
    peers.push(receiver, author)
    await Promise.all([receiver.peer.replay(), author.peer.replay()])
    const publish = hub.publish.bind(hub)
    let allow = false
    let poison: string | undefined
    const handoffs: Array<{ payload: Uint8Array; publishID?: string }> = []
    vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
      if (params.topicID !== commitTopic(secret) || params.senderDID !== 'alice')
        return publish(params)
      handoffs.push({ payload: params.payload.slice(), publishID: params.publishID })
      if (poison === undefined) {
        const frame = decodeCommitFrame(decodeHandshakeFrame(params.payload).payload)
        expect(frame.sealedEntries.length).toBeGreaterThan(0)
        const last = frame.sealedEntries.length - 1
        frame.sealedEntries[last] = (frame.sealedEntries[last] ?? 0) ^ 1
        poison = (
          await publish({
            ...params,
            publishID: 'tampered-copy',
            payload: encodeHandshakeFrame(
              HANDSHAKE_KIND.commit,
              encodeCommitFrame(frame.commit, frame.sealedEntries),
            ),
          })
        ).sequenceID
      }
      if (!allow)
        throw Object.assign(new Error('copy changed the head'), { name: 'HeadMismatchError' })
      return publish(params)
    })
    const build = vi.fn()
    const request = buildLedgerCommit(author, ['saved-named-entry'], { onBuild: build })
    await author.peer.enqueue(request)
    await vi.waitFor(async () => {
      expect(poison).toBeDefined()
      expect((await author.control.load()).cursor?.position).toBe(poison)
      expect((await receiver.control.load()).cursor?.position).toBe(poison)
    })
    const saved = await author.control.load()
    expect(saved.commitOnce).not.toBeNull()
    expect(saved.operations[0]?.stage).toBe('built')
    expect(saved.forkHalt).toBeNull()
    expect(saved.outcomes).toEqual([])
    expect(receiver.mls.epoch()).toBe(1)
    let runner = author
    if (restart) {
      await author.peer.dispose()
      await author.peer.drained()
      runner = makeMLSPeer(hub, 'alice', secret, { restartOf: author })
      peers.push(runner)
    }
    allow = true
    await vi.waitFor(async () => {
      await runner.peer.resync()
      await receiver.peer.resync()
      expect(runner.mls.epoch()).toBe(2)
      expect(receiver.mls.epoch()).toBe(2)
    })
    expect(await receiver.mls.getLedger()).toEqual(['saved-named-entry'])
    expect(await runner.peer.outcomes()).toEqual([
      expect.objectContaining({ opID: request.id, kind: 'landed' }),
    ])
    expect(handoffs.length).toBeGreaterThanOrEqual(2)
    for (const handoff of handoffs) {
      expect(handoff.payload).toEqual(saved.commitOnce?.payload)
      expect(handoff.publishID).toBe(saved.commitOnce?.publishID)
    }
    expect(build).toHaveBeenCalledOnce()
    expect((await runner.control.load()).forkHalt).toBeNull()
  },
)

test.each(['backoff', 'read'] as const)(
  'disposal cancels ambiguous intent %s and preserves it for restart',
  async (pause) => {
    const hub = new FakeHub()
    const database = createMemoryHostDatabase()
    const control = database.control('bob', { groupID: 'memory-group', incarnation: 1 })
    let reads = 0
    let release!: () => void
    const paused = new Promise<never>((_resolve, reject) => {
      release = () => reject(new Error('Read unavailable'))
    })
    void paused.catch(() => {})
    const seed = makeMLSPeer(hub, 'bob', secret, {
      database,
      control: {
        ...control,
        lastMutation: async () => {
          reads++
          if (pause === 'read') return paused
          throw new Error('Read unavailable')
        },
      },
    })
    peers.push(seed)
    await seed.peer.replay()
    vi.useFakeTimers()
    database.commitThenRejectNext('apply')
    const request = buildLedgerCommit(seed, ['survives-disposal'])
    let failure: unknown
    const committing = seed.peer.commit(request).catch((error: unknown) => {
      failure = error
    })
    await vi.waitFor(() => expect(reads).toBe(1))
    try {
      await seed.peer.dispose()
      await vi.advanceTimersByTimeAsync(0)
      expect(failure).toBeInstanceOf(PeerDisposedError)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      release()
    }
    await seed.peer.drained()
    await committing
    expect((await control.load()).operations).toEqual([
      expect.objectContaining({ id: request.id, stage: 'intent' }),
    ])
    vi.useRealTimers()
    const again = makeMLSPeer(hub, 'bob', secret, { restartOf: seed })
    peers.push(again)
    await vi.waitFor(async () => {
      expect(await again.peer.outcomes()).toEqual([
        expect.objectContaining({ opID: request.id, kind: 'landed' }),
      ])
    })
    expect((await again.control.load()).operations).toEqual([])
  },
)

test.each(['build', 'adopt'] as const)(
  'transient %s failure keeps concurrent commit waiters tied to their own outcomes',
  async (phase) => {
    const hub = new FakeHub()
    const member = makeMLSPeer(hub, 'bob', secret)
    peers.push(member)
    await member.peer.replay()
    let failures = 0
    const failOnce = (): void => {
      if (failures === 0) {
        failures++
        throw new Error('Temporary host failure')
      }
    }
    const first = buildLedgerCommit(member, ['first'], {
      ...(phase === 'build'
        ? { onBuild: failOnce }
        : {
            onAdopt: async (adopt) => {
              failOnce()
              return await adopt()
            },
          }),
    })
    const second = buildLedgerCommit(member, ['second'])
    const settled: Array<string> = []
    const commits = [first, second].map((request) =>
      member.peer.commit(request).then(
        (result) => {
          settled.push(request.id)
          return result
        },
        (error: unknown) => {
          settled.push('rejected')
          throw error
        },
      ),
    )
    for (const commit of commits) void commit.catch(() => {})
    await vi.waitFor(() => expect(failures).toBe(1))
    expect(settled).toEqual([])
    expect((await member.control.load()).operations).toHaveLength(2)
    const results = await Promise.all(commits)
    expect(settled).toEqual([first.id, second.id])
    expect(await member.peer.outcomes()).toEqual([
      expect.objectContaining({ opID: first.id, kind: 'landed', position: results[0]?.position }),
      expect.objectContaining({ opID: second.id, kind: 'landed', position: results[1]?.position }),
    ])
    expect(await member.mls.getLedger()).toEqual(['first', 'second'])
    expect(hub.published.filter((row) => row.topicID === commitTopic(secret))).toHaveLength(2)
  },
)
