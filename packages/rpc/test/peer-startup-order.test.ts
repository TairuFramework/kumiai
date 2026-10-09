import { afterEach, expect, test, vi } from 'vitest'

import { asLogPosition } from '../src/cursor.js'
import { decodeHandshakeFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { decodeRecoveryVerdict, encodeRecoveryConfirmRequest } from '../src/recovery.js'
import { APP_TOPIC_LABEL, commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import {
  buildLedgerCommit,
  buildRejoinRecord,
  makeMLSPeer,
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
  'startup settles hub-accepted own work before the seed walk, forget=%s',
  async (forget) => {
    const hub = new FakeHub()
    const seed = makeMLSPeer(hub, 'alice', secret)
    peers.push(seed)
    await seed.peer.replay()
    const op = await seedBuiltOperation(seed, buildLedgerCommit(seed, []))
    if (op.stage !== 'built') throw new Error('Missing built operation')
    await seed.peer.dispose()
    await seed.peer.drained()
    await hub.publish({
      senderDID: 'alice',
      topicID: commitTopic(secret),
      payload: op.built.payload,
      publishID: op.built.publishID,
      expectedHead: op.built.expectedHead,
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
    expect(epochs).not.toContain(1)
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
  const subscribe = vi.spyOn(hub, 'subscribe')
  const again = makeMLSPeer(hub, 'bob', secret, { restartOf: seed })
  peers.push(again)
  const exported = vi.spyOn(again.crypto, 'exportSecret')
  await again.peer.outcomes()
  expect(exported).not.toHaveBeenCalled()
  expect(subscribe).not.toHaveBeenCalled()
})

test.each(['built', 'published', 'confirmed'] as const)(
  'startup restores the %s rejoin barrier before walking',
  async (stage) => {
    const hub = new FakeHub()
    const seed = makeMLSPeer(hub, 'bob', secret)
    peers.push(seed)
    await seed.peer.replay()
    const rejoin = await buildRejoinRecord(seed)
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
    await again.peer.replay()
    expect((await again.control.load()).rejoin).toMatchObject({
      stage: stage === 'built' ? 'published' : stage,
      position: published.sequenceID,
    })
    expect((await again.control.load()).cursor).toBeNull()
    expect(strands).not.toHaveBeenCalled()
  },
)

test.each(['published', 'confirmed'] as const)(
  'restart gates saved confirmation responses at and beyond a %s rejoin barrier',
  async (stage) => {
    const hub = new FakeHub()
    const seed = makeMLSPeer(hub, 'bob', secret, {
      members: ['bob', 'carol'],
      acceptsCommitter: () => false,
    })
    peers.push(seed)
    await seed.peer.replay()
    for (let index = 0; index < 3; index++) {
      await publishCommit({
        hub,
        senderDID: 'carol',
        recoverySecret: secret,
        epoch: 1,
        external: true,
        adds: [`member-${index}`],
      })
    }
    await vi.waitFor(async () => expect((await seed.control.load()).responses).toHaveLength(3))
    const responses = (await seed.control.load()).responses
    const barrier = responses[1]
    if (barrier == null) throw new Error('Missing barrier position')
    const rejoin = await buildRejoinRecord(seed)
    await seed.peer.dispose()
    await seed.peer.drained()
    await seed.control.apply(
      { putRejoin: { ...rejoin, stage, position: barrier.position } },
      'responder-rejoin-barrier',
    )
    vi.useFakeTimers()
    const again = makeMLSPeer(hub, 'bob', secret, {
      restartOf: seed,
      members: ['bob', 'carol'],
      recovery: { getDelayMs: () => 0 },
    })
    peers.push(again)
    await again.peer.replay()
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
          encodeRecoveryConfirmRequest({
            requestID,
            request,
            position: response.position,
            commitDigest: response.digest,
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
