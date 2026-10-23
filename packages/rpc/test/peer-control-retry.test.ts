import { afterEach, expect, test, vi } from 'vitest'

import { digestAppliedCommit } from '../src/classify.js'
import { decodeCommitFrame, encodeCommitFrame } from '../src/commit-frame.js'
import type { ControlSnapshot } from '../src/control/types.js'
import { asLogPosition } from '../src/cursor.js'
import { PeerDisposedError } from '../src/errors.js'
import { FrameTooLargeError } from '../src/frame-size.js'
import { decodeHandshakeFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { encodeLedgerEntries } from '../src/ledger-entries.js'
import { APP_TOPIC_LABEL, commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'
import {
  createMemoryGroupMLS,
  decodeMemoryCommit,
  memoryAuthenticator,
  tagMemoryCommit,
} from './fixtures/memory-group-mls.js'
import {
  buildLedgerCommit,
  makeMLSPeer,
  rejoinSourceEpoch,
  seedBuiltOperation,
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
  await vi.waitFor(async () => expect((await control.load()).commitOnce?.acceptedAs).toBeDefined())
  expect(await control.load()).toMatchObject({
    operations: [{ id: second.id, stage: 'intent' }],
    rejoin: null,
    commitOnce: { opID: first.id },
    controlHold: null,
  })
  expect(
    snapshots.every((snapshot) =>
      snapshot.operations.slice(1).every((op) => op.stage === 'intent'),
    ),
  ).toBe(true)
  const held = await control.load()
  expect(held.commitOnce?.acceptedAs).toBe(hub.head(commitTopic(secret)))
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
        if ((await seed.control.load()).outcomes.some((outcome) => outcome.opID === oversized.id))
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
        opID: oversized.id,
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
  await publishCommit({
    authenticator: memoryAuthenticator(
      createMemoryGroupMLS({ recoverySecret: secret, epoch: 1, localDID: 'bob' }),
    ),
    hub,
    senderDID: 'bob',
    recoverySecret: secret,
    epoch: 1,
  })
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

test.each(
  [false, true].flatMap((recovers) =>
    ['missing', 'restore', 'verify'].map((failure) => ({ recovers, failure })),
  ),
)(
  'local input and provider failures retain identity and retry policy ($failure, recovers=$recovers)',
  async ({ recovers, failure }) => {
    vi.useFakeTimers()
    const hub = new FakeHub()
    const author = makeMLSPeer(hub, 'alice', secret)
    peers.push(author)
    await author.peer.replay()
    const saved = await seedBuiltOperation(author, buildLedgerCommit(author, ['saved-entry']))
    const restore = author.validation.restoreValidation.bind(author.validation)
    let failures = 0
    vi.spyOn(author.validation, 'restoreValidation').mockImplementation(async (built) => {
      failures++
      if (recovers && failures > 1) return restore(built)
      if (failure === 'restore') throw new Error('Temporary local storage failure')
      if (failure === 'verify') {
        const local = await restore(built)
        if (local === null) throw new Error('Missing source validation')
        return {
          ...local,
          validateFrame: async () => {
            throw new Error('Temporary local verification failure')
          },
        }
      }
      return null
    })
    await hub.publish({
      senderDID: 'alice',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: saved.slot.payload,
      publishID: saved.slot.publishID,
    })
    await author.controlWalk.walkCommits()
    expect((await author.control.load()).strand).toBeNull()
    expect((await author.control.load()).cursor?.position ?? null).toBe(saved.slot.head)
    expect((await author.control.load()).commitOnce).toEqual(saved.slot)
    await author.controlWalk.walkCommits()
    expect(failures).toBe(1)
    for (let attempt = 0; attempt < 5 && author.mls.epoch() === 1; attempt++) {
      vi.setSystemTime(Date.now() + 1000)
      await author.controlWalk.walkCommits()
      if ((await author.control.load()).strand !== null) break
    }
    const result = await author.control.load()
    if (recovers) {
      expect(author.mls.epoch()).toBe(2)
      expect(result.commitOnce).toBeNull()
      expect(result.outcomes).toMatchObject([{ opID: saved.id, kind: 'landed' }])
    } else {
      expect(failures).toBeLessThanOrEqual(4)
      expect(result.strand).toEqual({ reason: 'unprocessable-gap' })
      expect(result.cursor?.stranded).toBe(true)
      expect(result.commitOnce?.skipped).toBeUndefined()
    }
  },
)

test('a changed own blob holds on unavailable header input and installs after local retry', async () => {
  const hub = new FakeHub()
  const author = makeMLSPeer(hub, 'alice', secret)
  peers.push(author)
  await author.peer.replay()
  vi.useFakeTimers()
  const saved = await seedBuiltOperation(author, buildLedgerCommit(author, ['saved-entry']))
  const frame = decodeCommitFrame(decodeHandshakeFrame(saved.slot.payload).payload)
  const resealed = await author.crypto.sealEntries(
    encodeLedgerEntries([...saved.slot.bodies, 'unreferenced-body']),
  )
  const payload = encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(frame.commit, resealed.sealed),
  )
  expect(payload).not.toEqual(saved.slot.payload)
  expect(author.mls.ownCommitDigest(frame.commit)).toBe(
    author.mls.ownCommitDigest(decodeCommitFrame(decodeHandshakeFrame(payload).payload).commit),
  )
  const unavailable = Object.assign(new Error('Local source read unavailable'), {
    name: 'CommitValidationUnavailableError',
  })
  vi.spyOn(author.mls, 'readCommitHeader').mockRejectedValueOnce(unavailable)
  const receive = vi.spyOn(author.mls, 'processCommit')
  const before = await author.control.load()
  const occurrence = await hub.publish({
    senderDID: 'replayer',
    topicID: commitTopic(secret),
    retain: 'log',
    payload,
  })
  await author.controlWalk.walkCommits()
  const held = await author.control.load()
  expect(held.strand).toBeNull()
  expect(held.cursor).toEqual(before.cursor)
  expect(held.commitOnce).toEqual(saved.slot)
  expect(held.applied).toEqual([])
  expect(held.outcomes).toEqual([])
  expect(author.mls.epoch()).toBe(1)
  await author.controlWalk.walkCommits()
  expect(await author.control.load()).toEqual(held)
  vi.setSystemTime(Date.now() + 100)
  await author.controlWalk.walkCommits()
  const installed = await author.control.load()
  expect(installed.commitOnce).toBeNull()
  expect(installed.strand).toBeNull()
  expect(installed.cursor?.position).toBe(occurrence.sequenceID)
  expect(installed.applied).toMatchObject([{ opID: saved.id, sequenceID: occurrence.sequenceID }])
  expect(installed.outcomes).toMatchObject([{ opID: saved.id, kind: 'landed' }])
  expect(author.mls.epoch()).toBe(2)
  expect(await author.mls.getLedger()).toEqual(['saved-entry'])
  expect(receive).not.toHaveBeenCalled()
})

test('an older saved skipped build never republishes after restart before its deadline', async () => {
  const hub = new FakeHub()
  const original = makeMLSPeer(hub, 'alice', secret)
  peers.push(original)
  await original.peer.replay()
  const saved = await seedBuiltOperation(original, buildLedgerCommit(original, ['saved-entry']))
  const occurrence = await hub.publish({
    senderDID: 'hub-copy',
    topicID: commitTopic(secret),
    retain: 'log',
    payload: new Uint8Array([255]),
  })
  // Persist the pre-distinction shape, with the failed copy already behind the cursor.
  await original.control.apply(
    {
      commitOnce: { ...saved.slot, skipped: true },
      cursor: { position: asLogPosition(occurrence.sequenceID), epoch: saved.slot.epoch },
    },
    'older-skip',
  )
  expect((await original.control.load()).commitOnce?.retryForbidden).toBeUndefined()
  await original.peer.dispose()
  await original.peer.drained()
  const again = makeMLSPeer(hub, 'alice', secret, { restartOf: original })
  peers.push(again)
  const publish = vi.spyOn(hub, 'publish')
  expect(Date.now()).toBeLessThan(saved.slot.deadline)
  await again.peer.replay()
  expect(publish).not.toHaveBeenCalled()
  await again.controlWalk.stepOperation(saved.id)
  expect(publish).not.toHaveBeenCalled()
  expect(again.mls.epoch()).toBe(saved.slot.epoch)
  expect((await again.control.load()).commitOnce).toMatchObject({
    payload: saved.slot.payload,
    publishID: saved.slot.publishID,
    skipped: true,
  })
})

test.each(
  [false, true].flatMap((restart) => {
    return ['unreadable', 'foreign-content'].map((kind) => ({ restart, kind }))
  }),
)(
  'coverage-only $kind skip permits identical saved host bytes after hub recovery (restart=$restart)',
  async ({ restart, kind }) => {
    // r28h: uncertainty affects settlement coverage, not identical-byte publication.
    const hub = new FakeHub()
    let author = makeMLSPeer(hub, 'alice', secret)
    peers.push(author)
    await author.peer.replay()
    const build = vi.fn()
    const saved = await seedBuiltOperation(
      author,
      buildLedgerCommit(author, ['saved-entry'], { onBuild: build }),
    )
    const submit = hub.publish.bind(hub)
    let recovered = false
    const publish = vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
      if (!recovered) throw new Error('Hub temporarily unavailable')
      return submit(params)
    })
    let payload: Uint8Array = new Uint8Array([255])
    if (kind === 'foreign-content') {
      const foreign = createMemoryGroupMLS({ recoverySecret: secret, epoch: 1, localDID: 'bob' })
      const commit = decodeMemoryCommit(foreign.buildCommit())
      if (commit === null) throw new Error('Missing foreign commit')
      const changed = tagMemoryCommit(
        new TextEncoder().encode(JSON.stringify({ ...commit, invalidContent: true })),
        memoryAuthenticator(foreign),
      )
      payload = encodeHandshakeFrame(
        HANDSHAKE_KIND.commit,
        encodeCommitFrame(changed, new Uint8Array()),
      )
    }
    const occurrence = await submit({
      senderDID: 'hub-copy',
      topicID: commitTopic(secret),
      retain: 'log',
      payload,
    })
    await author.controlWalk.walkCommits()
    const skipped = await author.control.load()
    expect(skipped.cursor?.position).toBe(occurrence.sequenceID)
    expect(skipped.commitOnce).toMatchObject({
      payload: saved.slot.payload,
      publishID: saved.slot.publishID,
      journal: saved.slot.journal,
      head: saved.slot.head,
      skipped: true,
      retryForbidden: false,
    })
    if (restart) {
      await author.peer.dispose()
      await author.peer.drained()
      author = makeMLSPeer(hub, 'alice', secret, { restartOf: author })
      peers.push(author)
    }
    recovered = true
    if (!restart) await author.controlWalk.stepOperation(saved.id)
    await author.peer.replay()
    await vi.waitFor(async () => expect((await author.control.load()).commitOnce).toBeNull())
    const copies = publish.mock.calls
      .map(([row]) => row)
      .filter((row) => row.publishID === saved.slot.publishID)
    expect(copies.length).toBeGreaterThan(0)
    for (const copy of copies) {
      expect(copy.payload).toEqual(saved.slot.payload)
      expect(copy.expectedHead).toBe(occurrence.sequenceID)
    }
    expect(
      hub.published.filter((row) => row.payload.length === saved.slot.payload.length),
    ).toHaveLength(1)
    expect(build).toHaveBeenCalledTimes(1)
    expect(author.mls.epoch()).toBe(saved.slot.epoch + 1)
    expect((await author.control.load()).commitOnce).toBeNull()
    expect(await author.peer.outcomes()).toMatchObject([{ opID: saved.id, kind: 'unknown' }])
  },
)

test.each([false, true])(
  'failed own copy permits identical retry and later installation closes unknown (restart=%s)',
  async (restart) => {
    const hub = new FakeHub()
    let author = makeMLSPeer(hub, 'alice', secret)
    peers.push(author)
    await author.peer.replay()
    vi.useFakeTimers()
    const saved = await seedBuiltOperation(author, buildLedgerCommit(author, ['saved-entry']))
    const frame = decodeCommitFrame(decodeHandshakeFrame(saved.slot.payload).payload)
    const altered = encodeHandshakeFrame(
      HANDSHAKE_KIND.commit,
      encodeCommitFrame(frame.commit, new Uint8Array([255])),
    )
    const submit = hub.publish.bind(hub)
    const publish = vi.spyOn(hub, 'publish').mockRejectedValue(new Error('hub unavailable'))
    const occurrence = await submit({
      senderDID: 'replayer',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: altered,
    })
    await author.controlWalk.walkCommits()
    const skipped = await author.control.load()
    expect(skipped.cursor?.position).toBe(occurrence.sequenceID)
    expect(skipped.commitOnce).toMatchObject({
      ...saved.slot,
      expectedHead: occurrence.sequenceID,
      skipped: true,
      retryForbidden: false,
    })
    expect(skipped.outcomes).toEqual([])
    await author.controlWalk.stepOperation(saved.id)
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        publishID: saved.slot.publishID,
        payload: saved.slot.payload,
      }),
    )
    expect(author.mls.epoch()).toBe(1)
    if (restart) {
      await author.peer.dispose()
      await author.peer.drained()
      author = makeMLSPeer(hub, 'alice', secret, { restartOf: author })
      peers.push(author)
      await author.controlWalk.stepOperation(saved.id)
      expect(publish.mock.calls.length).toBeGreaterThan(1)
    }
    publish.mockImplementation(submit)
    const receive = vi.spyOn(author.mls, 'processCommit')
    const own = await hub.publish({
      senderDID: 'replayer',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: saved.slot.payload,
    })
    await author.controlWalk.walkCommits()
    const consumed = await author.control.load()
    expect(author.mls.epoch()).toBe(2)
    expect(consumed.commitOnce).toBeNull()
    expect(consumed.outcomes).toMatchObject([{ opID: saved.id, kind: 'unknown' }])
    expect(consumed.applied).toMatchObject([{ opID: saved.id, sequenceID: own.sequenceID }])
    expect(consumed.welcomes).toEqual([])
    expect(receive).not.toHaveBeenCalled()
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
    const release = Promise.withResolvers<void>()
    const failOnce = async (): Promise<void> => {
      if (failures === 0) {
        failures++
        await release.promise
        throw new Error('Temporary host failure')
      }
    }
    const first = buildLedgerCommit(member, ['first'], {
      ...(phase === 'build'
        ? { onBuild: failOnce }
        : {
            onAdopt: async (adopt) => {
              await failOnce()
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
    const pending = await member.control.load()
    expect(pending.operations.length + (pending.commitOnce === null ? 0 : 1)).toBe(2)
    release.resolve()
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
