import { encodeEventFrame } from '@kumiai/broadcast'
import { afterEach, expect, test, vi } from 'vitest'

import type { PendingAppFrame } from '../src/crypto.js'
import { asLogPosition } from '../src/cursor.js'
import { decodeHandshakeFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import * as logDeliveryModule from '../src/log-delivery.js'
import { decodeRecoveryVerdict } from '../src/recovery.js'
import { APP_TOPIC_LABEL, commitTopic, rendezvousTopic } from '../src/topic.js'
import {
  encodeSignedRecoveryConfirmation,
  publishCommit,
  publishedCommitBytes,
  publishedCommitDigest,
} from './fixtures/commits.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import {
  buildLedgerCommit,
  buildRejoinRecord,
  latchPeerSafety,
  makeMLSPeer,
  rejoinSourceEpoch,
  seedBuiltOperation,
  type TestPeer,
} from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0x92)
const peers: Array<TestPeer> = []
afterEach(async () => {
  await Promise.all(peers.map(({ peer }) => peer.dispose()))
  await Promise.all(peers.splice(0).map(({ peer }) => peer.drained()))
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test.each([false, true])(
  'startup walks hub-accepted own work from the durable cursor, forget=%s',
  async (forget) => {
    const hub = new FakeHub()
    const seed = makeMLSPeer(hub, 'alice', secret)
    peers.push(seed)
    await seed.peer.replay()
    const op = await seedBuiltOperation(seed, buildLedgerCommit(seed, []))
    expect((await seed.control.load()).operations).toEqual([])
    await seed.peer.dispose()
    await seed.peer.drained()
    await hub.publish({
      senderDID: 'alice',
      topicID: commitTopic(secret),
      payload: op.slot.payload,
      publishID: op.slot.publishID,
      expectedHead: op.slot.expectedHead,
      retain: 'log',
    })
    if (forget) hub.forgetPublishRecords()
    const again = makeMLSPeer(hub, 'alice', secret, { restartOf: seed })
    peers.push(again)
    const epochs: Array<number> = []
    const fetch = hub.fetchTopic.bind(hub)
    hub.fetchTopic = async (params) => {
      if (params.topicID === commitTopic(secret) && params.after != null)
        epochs.push(again.mls.epoch())
      return fetch(params)
    }
    await again.peer.replay()
    expect(await again.peer.outcomes()).toEqual([expect.objectContaining({ kind: 'landed' })])
    expect(epochs.length).toBeGreaterThan(0)
    expect(again.mls.epoch()).toBe(2)
    expect((await again.control.load()).commitOnce).toBeNull()
    expect(hub.published.filter((row) => row.topicID === rendezvousTopic(secret))).toEqual([])
  },
)

test.each([false, true])(
  'same-number anchor resolves solely from the landed mark, landed=%s',
  async (landed) => {
    const hub = new FakeHub()
    const seed = makeMLSPeer(hub, 'bob', secret)
    peers.push(seed)
    await seed.peer.replay()
    await seed.peer.dispose()
    await seed.peer.drained()
    const stored = await seed.anchorStore.load()
    if (stored == null) throw new Error('Missing anchor')
    await seed.anchorStore.save({
      anchor: stored.anchor,
      pending: {
        epochBefore: 1,
        epochAfter: 1,
        rosterBefore: ['bob'],
        forced: true,
        advance: 'same-number',
        ...(landed ? { landed: true } : {}),
      },
    })
    const again = makeMLSPeer(hub, 'bob', secret, { restartOf: seed })
    peers.push(again)
    const exported = vi.spyOn(again.crypto, 'exportSecret')
    await again.peer.replay()
    expect((await again.anchorStore.load())?.pending).toBeUndefined()
    expect(exported.mock.calls.filter(([label]) => label === APP_TOPIC_LABEL)).toHaveLength(
      landed ? 1 : 0,
    )
    await again.peer.protocol('chat').dispatch('chat/changed', { data: {} })
  },
)

test('an idle restart builds the epoch after anchor resolution', async () => {
  const hub = new FakeHub()
  const seed = makeMLSPeer(hub, 'bob', secret)
  peers.push(seed)
  await seed.peer.replay()
  await seed.peer.dispose()
  await seed.peer.drained()
  const again = makeMLSPeer(hub, 'bob', secret, { restartOf: seed })
  peers.push(again)
  await again.peer.protocol('chat').dispatch('chat/changed', { data: { restart: true } })
  expect(hub.published.at(-1)?.topicID).not.toBe(commitTopic(secret))
})

test('startup retries unavailable terminal evidence before starting the mux', async () => {
  vi.useFakeTimers()
  const hub = new FakeHub()
  const seed = makeMLSPeer(hub, 'bob', secret)
  peers.push(seed)
  await seed.peer.replay()
  await seed.peer.dispose()
  await seed.peer.drained()
  const receive = vi.spyOn(hub, 'receive')
  const subscribe = vi.spyOn(hub, 'subscribe')
  let attempts = 0
  const again: TestPeer = makeMLSPeer(hub, 'bob', secret, {
    restartOf: seed,
    readEvidence: async () => {
      if (++attempts === 1) throw new Error('Terminal evidence temporarily unavailable')
      return again.mls.readEvidence()
    },
  })
  peers.push(again)
  let ready = false
  const starting = again.peer.replay().then(() => {
    ready = true
  })
  void starting.catch(() => {})
  await vi.advanceTimersByTimeAsync(0)
  expect(ready).toBe(false)
  expect(receive).not.toHaveBeenCalled()
  expect(subscribe).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(100)
  await starting
  expect(attempts).toBeGreaterThanOrEqual(2)
  await again.peer.protocol('chat').dispatch('chat/changed', { data: { started: true } })
  expect(receive).toHaveBeenCalled()
  expect(subscribe).toHaveBeenCalled()
})

test.each([false, true])(
  'startup evidence errors are diagnosed once while readiness waits, dispose=%s',
  async (dispose) => {
    vi.useFakeTimers()
    const hub = new FakeHub()
    const receive = vi.spyOn(hub, 'receive')
    const diagnostic = vi.fn(async () => {
      throw new Error('Observer failed')
    })
    let failure: string | null = 'Invalid evidence port'
    const readEvidence = vi.fn(async () => {
      if (failure !== null) throw new TypeError(failure)
      return again.mls.readEvidence()
    })
    const again: TestPeer = makeMLSPeer(hub, 'bob', secret, {
      readEvidence,
      onControlPublishError: diagnostic,
    })
    peers.push(again)
    let state = 'pending'
    const starting = again.peer.outcomes().then(
      () => {
        state = 'resolved'
      },
      (error: unknown) => {
        state = 'rejected'
        throw error
      },
    )
    void starting.catch(() => {})
    await vi.advanceTimersByTimeAsync(300)
    expect(readEvidence).toHaveBeenCalledTimes(3)
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
      opID: null,
      error: expect.objectContaining({ name: 'TypeError', message: failure }),
    })
    failure = 'Different evidence failure'
    await vi.advanceTimersByTimeAsync(400)
    expect(diagnostic).toHaveBeenCalledTimes(2)
    expect(diagnostic.mock.calls[1]).toEqual([
      {
        opID: null,
        error: expect.objectContaining({ name: 'TypeError', message: failure }),
      },
    ])
    failure = 'Invalid evidence port'
    await vi.advanceTimersByTimeAsync(39800)
    expect(readEvidence).toHaveBeenCalledTimes(10)
    await vi.advanceTimersByTimeAsync(15000)
    expect(readEvidence).toHaveBeenCalledTimes(11)
    expect(diagnostic).toHaveBeenCalledTimes(2)
    expect(state).toBe('pending')
    expect(receive).not.toHaveBeenCalled()
    if (dispose) {
      await again.peer.dispose()
      await expect(starting).rejects.toThrow('Peer is disposed')
      await vi.advanceTimersByTimeAsync(30000)
      expect(readEvidence).toHaveBeenCalledTimes(11)
    } else {
      failure = null
      await vi.advanceTimersByTimeAsync(15000)
      await starting
      expect(state).toBe('resolved')
      expect(receive).toHaveBeenCalled()
    }
  },
)

test('a failed seed-walk anchor save is retried on the next idle replay', async () => {
  const hub = new FakeHub()
  const seed = makeMLSPeer(hub, 'bob', secret, { members: ['alice', 'bob'] })
  peers.push(seed)
  await seed.peer.replay()
  await seed.peer.dispose()
  await seed.peer.drained()
  await publishCommit({
    hub,
    senderDID: 'alice',
    recoverySecret: secret,
    epoch: 1,
    adds: ['carol'],
  })
  let blocked = true
  const save = seed.anchorStore.save
  seed.anchorStore.save = async (slot) => {
    if (blocked && slot.pending == null && slot.anchor.epoch === 2)
      throw new Error('Anchor save unavailable')
    await save(slot)
  }
  const again = makeMLSPeer(hub, 'bob', secret, { restartOf: seed })
  peers.push(again)
  await again.peer.outcomes()
  expect(again.peer.anchorEpoch()).toBe(1)
  expect((await again.anchorStore.load())?.pending?.landed).toBe(true)
  blocked = false
  await again.peer.replay()
  expect(again.peer.anchorEpoch()).toBe(2)
  expect((await again.anchorStore.load())?.pending).toBeUndefined()
  await again.peer.protocol('chat').dispatch('chat/changed', { data: { repaired: true } })
})

test('restart builds the epoch after a resolved anchor save interrupted runtime rebuilding', async () => {
  const hub = new FakeHub()
  const seed = makeMLSPeer(hub, 'bob', secret, { members: ['alice', 'bob'] })
  peers.push(seed)
  await seed.peer.replay()
  const save = seed.anchorStore.save
  seed.anchorStore.save = async (slot) => {
    await save(slot)
    if (slot.pending == null && slot.anchor.epoch === 2) void seed.peer.dispose()
  }
  await publishCommit({
    hub,
    senderDID: 'alice',
    recoverySecret: secret,
    epoch: 1,
    adds: ['carol'],
  })
  await vi.waitFor(async () => expect((await seed.anchorStore.load())?.anchor.epoch).toBe(2))
  await seed.peer.dispose()
  await seed.peer.drained()
  const again = makeMLSPeer(hub, 'bob', secret, { restartOf: seed })
  peers.push(again)
  await again.peer.protocol('chat').dispatch('chat/changed', { data: { resolved: true } })
  expect(again.peer.anchorEpoch()).toBe(2)
  expect((await again.anchorStore.load())?.pending).toBeUndefined()
})

test('terminal startup serves outcomes without anchor export or control subscription', async () => {
  const hub = new FakeHub()
  const seed = makeMLSPeer(hub, 'bob', secret)
  peers.push(seed)
  await seed.peer.replay()
  await seed.peer.dispose()
  await seed.peer.drained()
  await seed.control.apply(
    {
      putApplied: [
        {
          epoch: 1,
          digest: 'removed',
          payloadDigest: 'removed-frame',
          sequenceID: '000000000001',
          opID: null,
          removed: true,
        },
      ],
    },
    'removed',
  )
  seed.mls.adopt(seed.mls.buildCommit([], { removes: ['bob'] }))
  await seed.database.saveState('bob', seed.mls.serializeState())
  const subscribe = vi.spyOn(hub, 'subscribe')
  const again = makeMLSPeer(hub, 'bob', secret, { restartOf: seed })
  peers.push(again)
  const exported = vi.spyOn(again.crypto, 'exportSecret')
  await again.peer.outcomes()
  expect(exported).not.toHaveBeenCalled()
  expect(subscribe).not.toHaveBeenCalled()
})

test('terminal clearing requires pending restoration when safety latches just after removal', async () => {
  vi.useFakeTimers()
  const hub = new FakeHub()
  const seed = makeMLSPeer(hub, 'bob', secret)
  peers.push(seed)
  await seed.peer.replay()
  await seed.peer.dispose()
  await seed.peer.drained()
  seed.mls.adopt(seed.mls.buildCommit([], { removes: ['bob'] }))
  await seed.database.saveState('bob', seed.mls.serializeState())
  await seed.appOutbox.put({
    seq: 1,
    protocol: 'chat',
    prc: 'chat/posted',
    data: new Uint8Array([1]),
    lastAttempt: null,
  })
  const record: PendingAppFrame = {
    frame: {
      id: 'opened-before-removal',
      topicID: 'old-topic',
      protocol: 'chat',
      segment: 1,
      position: '000000000001',
    },
    senderDID: 'alice',
    payload: encodeEventFrame('chat/posted', { restored: true }),
  }
  const records = new Map([[record.frame.id, record]])
  const restore = Promise.withResolvers<void>()
  const handler = Promise.withResolvers<void>()
  const list = vi.fn(async () => {
    await restore.promise
    return [...records.values()]
  })
  const crypto = createFakeCrypto({
    localDID: 'bob',
    pending: {
      persistOpened: async (_state, opened) => {
        records.set(opened.frame.id, opened)
      },
      list,
      complete: async (id) => {
        records.delete(id)
      },
    },
  })
  const seen = vi.fn(async () => {
    await handler.promise
  })
  const create = logDeliveryModule.createLogDelivery
  let earlyCleared = false
  let earlyError: unknown
  let earlyClear: Promise<void> | undefined
  vi.spyOn(logDeliveryModule, 'createLogDelivery').mockImplementation((params) => {
    const delivery = create(params)
    const removed = delivery.removed
    delivery.removed = () => {
      removed()
      latchPeerSafety(again, 'fork-halted')
      // Exercise the barrier independently of readiness and its storage-only finally path.
      earlyClear = params.clear().then(
        () => {
          earlyCleared = true
        },
        (error: unknown) => {
          earlyError = error
        },
      )
    }
    return delivery
  })
  const again = makeMLSPeer(hub, 'bob', secret, {
    restartOf: seed,
    crypto,
    handlers: { 'chat/posted': seen },
  })
  peers.push(again)
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(again.controlWalk.safetyHold()).toBe('fork-halted')
    expect(list).toHaveBeenCalled()
    expect(earlyCleared).toBe(false)
    expect(earlyError).toMatchObject({ message: 'Pending application records are not restored' })
    expect(await again.appOutbox.list()).toHaveLength(1)
    restore.resolve()
    await again.peer.outcomes()
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toHaveBeenCalledOnce()
    expect(await again.appOutbox.list()).toHaveLength(1)
    handler.resolve()
    await vi.advanceTimersByTimeAsync(1000)
    expect(records.size).toBe(0)
    expect(await again.appOutbox.list()).toEqual([])
    await earlyClear
  } finally {
    restore.resolve()
    handler.resolve()
  }
})

test.each(['built', 'published', 'confirmed'] as const)(
  'startup restores the %s rejoin barrier before walking',
  async (stage) => {
    const hub = new FakeHub()
    const seed = makeMLSPeer(hub, 'bob', secret)
    peers.push(seed)
    await seed.peer.replay()
    const rejoin = await buildRejoinRecord(seed)
    expect(rejoinSourceEpoch(rejoin)).toBe(seed.mls.epoch())
    await seed.peer.dispose()
    await seed.peer.drained()
    const published = await hub.publish({
      senderDID: 'bob',
      topicID: commitTopic(secret),
      payload: rejoin.payload,
      publishID: rejoin.publishID,
      expectedHead: null,
      retain: 'log',
    })
    await seed.control.apply(
      {
        putRejoin: {
          ...rejoin,
          stage,
          ...(stage === 'built' ? {} : { position: asLogPosition(published.sequenceID) }),
        },
      },
      'pending-rejoin',
    )
    const strands = vi.fn()
    const again = makeMLSPeer(hub, 'bob', secret, { restartOf: seed, onStrand: strands })
    peers.push(again)
    if (stage === 'confirmed')
      vi.spyOn(again.mls.capturedRecovery ?? again.mls, 'restoreRecovery').mockRejectedValue(
        new Error('Pause adoption'),
      )
    await again.peer.outcomes()
    await expect
      .poll(async () => (await again.control.load()).rejoin)
      .toMatchObject({
        stage: stage === 'built' ? 'published' : stage,
        position: published.sequenceID,
      })
    expect((await again.control.load()).cursor).toBeNull()
    expect(strands).not.toHaveBeenCalled()
  },
)

test.each(['published', 'confirmed'] as const)(
  'restart gates request-computed refusals at and beyond a %s rejoin barrier',
  async (stage) => {
    const hub = new FakeHub()
    const seed = makeMLSPeer(hub, 'bob', secret, {
      members: ['bob', 'carol'],
      acceptsCommitter: () => false,
    })
    peers.push(seed)
    await seed.peer.replay()
    const responses: Array<{ position: string; digest: string }> = []
    for (let index = 0; index < 3; index++) {
      const row = await publishCommit({
        hub,
        senderDID: 'carol',
        recoverySecret: secret,
        epoch: 1,
        external: true,
        adds: [`member-${index}`],
      })
      responses.push({
        position: row.sequenceID,
        digest: publishedCommitDigest(hub, row.sequenceID),
      })
    }
    await vi.waitFor(async () =>
      expect((await seed.control.load()).cursor?.position).toBe(responses[2]?.position),
    )
    expect((await seed.control.load()).responses).toEqual([])
    const barrier = responses[1]
    const first = responses[0]
    if (first == null || barrier == null) throw new Error('Missing barrier position')
    const rejoin = await buildRejoinRecord(seed)
    expect(rejoinSourceEpoch(rejoin)).toBe(seed.mls.epoch())
    await seed.peer.dispose()
    await seed.peer.drained()
    await seed.control.apply(
      {
        putRejoin: {
          ...('format' in rejoin
            ? rejoin
            : {
                ...rejoin,
                source: { ...rejoin.source, head: asLogPosition(first.position) },
              }),
          stage,
          position: asLogPosition(barrier.position),
        },
      },
      'responder-rejoin-barrier',
    )
    vi.useFakeTimers()
    const again = makeMLSPeer(hub, 'bob', secret, {
      restartOf: seed,
      members: ['bob', 'carol'],
      acceptsCommitter: () => false,
      recovery: { getDelayMs: () => 0 },
    })
    peers.push(again)
    if (stage === 'confirmed')
      vi.spyOn(again.mls.capturedRecovery ?? again.mls, 'restoreRecovery').mockRejectedValue(
        new Error('Pause adoption'),
      )
    await again.peer.outcomes()
    const requester = makeMLSPeer(hub, 'carol', secret, { members: ['bob', 'carol'] })
    peers.push(requester)
    for (const [index, response] of responses.entries()) {
      const requestID = `barrier-confirmation-${index}`
      const { request } = await requester.mls.createRecoveryRequest(requestID)
      await hub.publish({
        senderDID: 'carol',
        topicID: rendezvousTopic(secret),
        payload: encodeHandshakeFrame(
          HANDSHAKE_KIND.recoveryConfirmRequest,
          await encodeSignedRecoveryConfirmation(requester.mls, {
            requestID,
            request,
            position: response.position,
            commitDigest: response.digest,
            commit: publishedCommitBytes(hub, response.position),
          }),
        ),
      })
    }
    await vi.advanceTimersByTimeAsync(100)
    const verdicts = hub.published.filter(
      (message) =>
        message.senderDID === 'bob' &&
        message.topicID === rendezvousTopic(secret) &&
        decodeHandshakeFrame(message.payload).kind === HANDSHAKE_KIND.recoveryVerdict,
    )
    expect(
      verdicts.map(
        (message) => decodeRecoveryVerdict(decodeHandshakeFrame(message.payload).payload).requestID,
      ),
    ).toEqual(['barrier-confirmation-0'])
    expect((await again.control.load()).rejoin).toMatchObject({ stage, position: barrier.position })
  },
)
