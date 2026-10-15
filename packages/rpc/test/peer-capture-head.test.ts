import { afterEach, expect, test, vi } from 'vitest'

import { asLogPosition } from '../src/cursor.js'
import { decodeHandshakeFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { decodeRecoveryReply, encodeRecoveryRequest } from '../src/recovery.js'
import { replyWithReconciledGroupInfo } from '../src/recovery-capture.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { latchPeerSafety, makeMLSPeer, type TestPeer } from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(93)
const peers: Array<TestPeer> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const member of peers.splice(0)) {
    await member.peer.dispose()
    await member.peer.drained()
  }
  vi.restoreAllMocks()
})

async function fixture() {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'bob', secret, {
    members: ['alice', 'bob'],
    recovery: { getDelayMs: () => 0 },
  })
  peers.push(member)
  await member.peer.replay()
  const requester = createMemoryGroupMLS({
    localDID: 'alice',
    members: ['alice', 'bob'],
    recoverySecret: secret,
  })
  const requestID = crypto.randomUUID()
  const held = await requester.createRecoveryRequest(requestID)
  return {
    hub,
    member,
    requester,
    requestID,
    ...held,
    async ask() {
      return await member.controlWalk.replyWithCapturedGroupInfo({
        requestID,
        request: held.request,
      })
    },
    async askLegacy() {
      await hub.publish({
        senderDID: 'alice',
        topicID: rendezvousTopic(secret),
        payload: encodeHandshakeFrame(
          HANDSHAKE_KIND.recoveryRequest,
          encodeRecoveryRequest(requestID, held.request),
        ),
      })
    },
    replies() {
      return hub.published.flatMap((row) => {
        const frame = decodeHandshakeFrame(row.payload)
        return frame.kind === HANDSHAKE_KIND.recoveryReply
          ? [decodeRecoveryReply(frame.payload)]
          : []
      })
    },
  }
}

test('a responder applies queued commits before handing off its reply', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const process = f.member.mls.processCommit.bind(f.member.mls)
  vi.spyOn(f.member.mls, 'processCommit').mockImplementation(async (...args) => {
    entered.resolve()
    await release.promise
    return await process(...args)
  })
  try {
    await publishCommit({ hub: f.hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
    await entered.promise
    vi.useFakeTimers()
    const replying = f.ask()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.replies()).toEqual([])
    release.resolve()
    await replying
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(f.replies()).toHaveLength(1))
    const reply = f.replies()[0]
    if (reply === undefined) throw new Error('Missing recovery reply')
    const pending = await f.requester.applyRecovery(reply.groupInfo, f.requestID, f.requestKey)
    expect(pending).toMatchObject({ epoch: 3 })
  } finally {
    release.resolve()
  }
})

test.each(['gap', 'unproven-tip', 'regressed-null'] as const)(
  'a responder publishes nothing for an incomplete prefix (%s)',
  async (fault) => {
    const f = await fixture()
    if (fault === 'regressed-null') {
      await publishCommit({ hub: f.hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
      await f.member.peer.replay()
    }
    const fetch = f.hub.fetchTopic.bind(f.hub)
    vi.spyOn(f.hub, 'fetchTopic').mockImplementation(async (params) => {
      const result = await fetch(params)
      return params.topicID !== commitTopic(secret)
        ? result
        : {
            messages: [],
            head: fault === 'regressed-null' ? null : 'unseen-head',
            oldest: null,
            gap: fault === 'gap',
          }
    })
    vi.useFakeTimers()
    await f.ask()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.replies()).toEqual([])
    expect((await f.member.control.load()).forkHalt).toBeNull()
  },
)

test('a proven empty prefix still serves the legacy reply', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  await f.askLegacy()
  await vi.advanceTimersByTimeAsync(1)
  expect(f.replies()).toHaveLength(1)
  const reply = f.replies()[0]
  if (reply === undefined) throw new Error('Missing recovery reply')
  expect(await f.requester.applyRecovery(reply.groupInfo, f.requestID, f.requestKey)).toMatchObject(
    {
      epoch: 2,
    },
  )
})

test('unknown-version poison completes the prefix and permits captured sealing', async () => {
  const f = await fixture()
  const poison = encodeHandshakeFrame(HANDSHAKE_KIND.commit, new Uint8Array())
  poison[0] = 99
  const { sequenceID } = await f.hub.publish({
    senderDID: 'alice',
    topicID: commitTopic(secret),
    payload: poison,
    retain: 'log',
  })
  const prefix = await f.member.controlWalk.reconcileCommitPrefix()
  const evidence = await f.member.mls.readEvidence()
  expect(prefix).toEqual({
    kind: 'complete',
    ...evidence.source,
    head: sequenceID,
  })
  const replies: Array<Uint8Array> = []
  expect(
    await replyWithReconciledGroupInfo({
      reconcileCommitPrefix: f.member.controlWalk.reconcileCommitPrefix,
      sealGroupInfo: (head) => f.member.mls.sealGroupInfo(f.request, head),
      blocked: () => f.member.controlWalk.safetyHold() !== null,
      publish: async (sealed) => replies.push(sealed),
    }),
  ).toBe(true)
  expect(replies).toHaveLength(1)
  expect((await f.member.control.load()).cursor?.position).toBe(sequenceID)
})

test('a cursor that moves after reconciliation refuses the sampled capture head', async () => {
  const f = await fixture()
  const prefix = await f.member.controlWalk.reconcileCommitPrefix()
  expect(prefix).toMatchObject({ kind: 'complete', head: null })
  await publishCommit({ hub: f.hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
  await f.member.peer.replay()
  await expect(f.member.mls.sealGroupInfo(f.request, null)).rejects.toThrow()
  const next = await f.member.controlWalk.reconcileCommitPrefix()
  expect(next).toMatchObject({
    kind: 'complete',
    head: asLogPosition(f.hub.head(commitTopic(secret)) as string),
    identity: { epoch: 2 },
  })
})

test('an empty gap waits without inventing a cursor and a fresh complete read permits retry', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  const fetch = f.hub.fetchTopic.bind(f.hub)
  let gap = true
  let fetches = 0
  vi.spyOn(f.hub, 'fetchTopic').mockImplementation(async (params) => {
    const page = await fetch(params)
    if (params.topicID !== commitTopic(secret)) return page
    fetches++
    return gap ? { messages: [], head: 'unseen-head', oldest: null, gap: true } : page
  })
  const replies: Array<Uint8Array> = []
  const respond = () =>
    replyWithReconciledGroupInfo({
      reconcileCommitPrefix: f.member.controlWalk.reconcileCommitPrefix,
      sealGroupInfo: (head) => f.member.mls.sealGroupInfo(f.request, head),
      blocked: () => f.member.controlWalk.safetyHold() !== null,
      publish: async (sealed) => replies.push(sealed),
    })
  expect(await respond()).toBe(false)
  expect(fetches).toBe(1)
  expect(replies).toEqual([])
  expect((await f.member.control.load()).cursor).toBeNull()
  gap = false
  expect(await respond()).toBe(true)
  expect(fetches).toBe(2)
  expect(replies).toHaveLength(1)
})

test.each(['fork-halted', 'recovery-unavailable'] as const)(
  'suspended captured sealing hands off nothing after a local safety latch (%s)',
  async (reason) => {
    const f = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const seal = f.member.mls.sealGroupInfo.bind(f.member.mls)
    vi.spyOn(f.member.mls, 'sealGroupInfo').mockImplementation(async (request, head) => {
      const sealed = head === undefined ? await seal(request) : await seal(request, head)
      entered.resolve()
      await release.promise
      return sealed
    })
    const replying = f.ask()
    try {
      await entered.promise
      latchPeerSafety(f.member, reason)
      release.resolve()
      expect(await replying).toBe(false)
      expect(f.replies()).toEqual([])
    } finally {
      release.resolve()
      await replying
    }
  },
)
