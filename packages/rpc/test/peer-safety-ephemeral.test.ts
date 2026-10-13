import type { ProtocolDefinition } from '@enkaku/protocol'
import { encodeEventFrame } from '@kumiai/broadcast'
import { encodeFrame } from '@kumiai/hub-tunnel'
import { afterEach, expect, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import type { SafetyHold } from '../src/control/safety.js'
import {
  createDirectedClient,
  createUnroutedTagResponder,
  type OpenedInbound,
} from '../src/directed.js'
import { encodeDirectedPayload } from '../src/directed-tag.js'
import { GroupSafetyHeldError, SendNotAdmissibleError } from '../src/errors.js'
import { createHubMux } from '../src/hub-mux.js'
import { APP_TOPIC_LABEL, inboxTopic, protocolTopic } from '../src/topic.js'
import { createFakeCrypto, type FakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { latchPeerSafety, makeMLSPeer, type TestPeer } from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(50)
const reasons = ['fork-halted', 'recovery-unavailable'] as const
const peers: Array<TestPeer> = []
afterEach(async () => {
  for (const member of peers.splice(0)) {
    await member.peer.dispose()
    await member.peer.drained()
  }
  vi.restoreAllMocks()
})
async function fixture(handlers: Record<string, unknown> = {}, crypto?: FakeCrypto) {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'bob', secret, {
    handlers,
    ...(crypto == null ? {} : { crypto }),
  })
  peers.push(member)
  await member.peer.replay()
  return { hub, member }
}

test.each(reasons)(
  'dispatch/request/gather/retained directed traffic refuses (%s)',
  async (reason) => {
    const { hub, member } = await fixture()
    const directed = await member.peer.protocol('chat').to('alice')
    latchPeerSafety(member, reason)
    const starts = member.crypto.starts
    const publish = vi.spyOn(hub, 'publish')
    const surface = member.peer.protocol('chat')
    await expect(surface.dispatch('chat/changed', { data: {} })).rejects.toEqual(
      new SendNotAdmissibleError(reason),
    )
    await expect(surface.request('chat/echo', { param: {}, timeoutMs: 20 })).rejects.toEqual(
      new SendNotAdmissibleError(reason),
    )
    await expect(surface.gather('chat/echo', { param: {}, timeoutMs: 20 })).rejects.toEqual(
      new SendNotAdmissibleError(reason),
    )
    await expect(
      directed.request('chat/echo', { param: {}, signal: AbortSignal.timeout(100) }),
    ).rejects.toEqual(new SendNotAdmissibleError(reason))
    expect(member.crypto.starts.wrap).toBe(starts.wrap)
    expect(publish).not.toHaveBeenCalled()
  },
)

test.each(
  reasons.flatMap((reason) => ['broadcast', 'directed'].map((path) => [reason, path] as const)),
)('directed and broadcast handoffs recheck (%s, %s)', async (reason, path) => {
  const { hub, member } = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const wrap = member.crypto.wrap.bind(member.crypto)
  vi.spyOn(member.crypto, 'wrap').mockImplementation(async (...args) => {
    const bytes = await wrap(...args)
    entered.resolve()
    await release.promise
    return bytes
  })
  const directed = await member.peer.protocol('chat').to('alice')
  const publish = vi.spyOn(hub, 'publish')
  const sending = (
    path === 'broadcast'
      ? member.peer.protocol('chat').dispatch('chat/changed', { data: {} })
      : directed.request('chat/echo', { param: {}, signal: AbortSignal.timeout(100) })
  ).then(
    () => null,
    (error: unknown) => error,
  )
  await entered.promise
  latchPeerSafety(member, reason)
  release.resolve()
  expect(await sending).toEqual(new SendNotAdmissibleError(reason))
  expect(publish).not.toHaveBeenCalled()
})

test.each(reasons)('protocol and inbox inbound frames stay unopened (%s)', async (reason) => {
  const handler = vi.fn()
  const { hub, member } = await fixture({ 'chat/changed': handler, 'chat/echo': handler })
  latchPeerSafety(member, reason)
  const starts = member.crypto.starts
  const sender = createFakeCrypto({ localDID: 'alice' })
  const anchor = fakeEpochSecret(1, APP_TOPIC_LABEL)
  const topic = protocolTopic(anchor, 1, 'chat')
  const inbox = inboxTopic(anchor, 1, 'bob')
  for (const [topicID, bytes] of [
    [topic, encodeEventFrame('chat/changed', {})],
    [
      inbox,
      encodeDirectedPayload(
        'chat',
        encodeFrame({
          v: 1,
          seq: 0,
          sessionID: 'held-inbound',
          kind: 'message',
          body: {
            header: {},
            payload: { typ: 'request', prc: 'chat/echo', rid: 'held-request', prm: {} },
          },
        }),
      ),
    ],
  ] as const) {
    await hub.publish({
      senderDID: 'alice',
      topicID,
      payload: await sender.wrap(bytes, { aad: encodeAppAAD({ topicID, intent: 'ephemeral' }) }),
    })
  }
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(member.crypto.starts.unwrap).toBe(starts.unwrap)
  expect(handler).not.toHaveBeenCalled()
})

const directedProtocol = {
  unary: { type: 'request', param: { type: 'object' }, result: { type: 'object' } },
  stream: {
    type: 'stream',
    param: { type: 'object' },
    receive: { type: 'object' },
    result: { type: 'object' },
  },
  channel: {
    type: 'channel',
    param: { type: 'object' },
    send: { type: 'object' },
    receive: { type: 'object' },
    result: { type: 'object' },
  },
} as const satisfies ProtocolDefinition
test.each(
  reasons.flatMap((reason) =>
    ['unary', 'stream', 'channel'].map((kind) => [reason, kind] as const),
  ),
)('raw directed %s refuses %s before wrap', async (reason, kind) => {
  const hub = new FakeHub()
  const mux = createHubMux({ hub, localDID: 'alice' })
  const crypto = createFakeCrypto({ localDID: 'alice' })
  const wrap = vi.fn(crypto.wrap)
  const created = createDirectedClient<typeof directedProtocol>({
    mux,
    localDID: 'alice',
    memberDID: 'bob',
    sendTopicID: 'bob-inbox',
    receiveTopicID: 'alice-inbox',
    inbound: () => () => {},
    protocol: 'rpc',
    wrap,
    ...{ safetyHold: () => reason },
  })
  try {
    const sending =
      kind === 'unary'
        ? created.client.request('unary', { param: {}, signal: AbortSignal.timeout(100) })
        : kind === 'stream'
          ? created.client.createStream('stream', { param: {}, signal: AbortSignal.timeout(100) })
          : created.client.createChannel('channel', { param: {}, signal: AbortSignal.timeout(100) })
    await expect(Promise.resolve(sending)).rejects.toEqual(new SendNotAdmissibleError(reason))
    expect(wrap).not.toHaveBeenCalled()
    expect(hub.published).toEqual([])
  } finally {
    await created.dispose()
    await mux.dispose()
  }
})

test.each(reasons)('unrouted NACK handoff rechecks after sealing (%s)', async (reason) => {
  const hub = new FakeHub()
  const mux = createHubMux({ hub, localDID: 'bob' })
  let safety: SafetyHold = null
  let receive: ((message: OpenedInbound) => void) | undefined
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const responder = createUnroutedTagResponder({
    mux,
    localDID: 'bob',
    inbound: (listener) => {
      receive = listener
      return () => {}
    },
    isRegistered: () => false,
    sealReply: async () => {
      entered.resolve()
      await release.promise
      return { topicID: 'alice-inbox', payload: new Uint8Array([1]) }
    },
    ...{ safetyHold: () => safety },
  })
  receive?.({
    sequenceID: '1',
    senderDID: 'alice',
    topicID: 'bob-inbox',
    protocol: 'missing',
    payload: encodeFrame({
      v: 1,
      seq: 0,
      sessionID: 'unrouted',
      kind: 'message',
      body: {
        header: {},
        payload: { typ: 'request', rid: 'unrouted-request', prc: 'unary', prm: {} },
      },
    }),
  })
  await entered.promise
  safety = reason
  release.resolve()
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(hub.published).toEqual([])
  responder.dispose()
  await mux.dispose()
})

test.each(
  reasons.flatMap((reason) =>
    (['directed', 'broadcast'] as const).map((path) => [reason, path] as const),
  ),
)(
  'already opened handler completes but its new reply is suppressed (%s, %s)',
  async (reason, path) => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const completed = vi.fn()
    const { hub, member } = await fixture({
      'chat/echo': async () => {
        entered.resolve()
        await release.promise
        completed()
        return { done: true }
      },
    })
    const alice = makeMLSPeer(hub, 'alice', secret)
    peers.push(alice)
    await alice.peer.replay()
    const client = await alice.peer.protocol('chat').to('bob')
    const request = (
      path === 'directed'
        ? client.request('chat/echo', { param: {}, signal: AbortSignal.timeout(100) })
        : alice.peer.protocol('chat').request('chat/echo', { param: {}, timeoutMs: 100 })
    ).catch(() => {})
    await entered.promise
    latchPeerSafety(member, reason)
    const starts = member.crypto.starts
    release.resolve()
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce())
    await request
    expect(member.crypto.starts.wrap).toBe(starts.wrap)
    expect(hub.published.filter((row) => row.senderDID === 'bob').length).toBe(0)
  },
)

test.each(reasons)('gather callbacks cannot send after halt (%s)', async (reason) => {
  const { hub, member } = await fixture()
  const alice = makeMLSPeer(hub, 'alice', secret, {
    handlers: { 'chat/echo': () => ({ reply: true }) },
  })
  peers.push(alice)
  await alice.peer.replay()
  const result = Promise.withResolvers<unknown>()
  let wrapsAfterLatch = -1
  await member.peer.protocol('chat').gather('chat/echo', {
    param: {},
    quorum: 1,
    timeoutMs: 100,
    onReply: () => {
      latchPeerSafety(member, reason)
      const starts = member.crypto.starts
      void member.peer
        .protocol('chat')
        .dispatch('chat/changed', { data: {} })
        .catch((error: unknown) => {
          wrapsAfterLatch = member.crypto.starts.wrap - starts.wrap
          result.resolve(error)
        })
    },
  })
  expect(await result.promise).toEqual(new SendNotAdmissibleError(reason))
  expect(wrapsAfterLatch).toBe(0)
})

test.each(reasons)('a raw ephemeral wrap refusal latches safety (%s)', async (reason) => {
  const { member } = await fixture()
  const held = new GroupSafetyHeldError(reason)
  vi.spyOn(member.crypto, 'wrap').mockRejectedValue(held)
  const error = await member.peer
    .protocol('chat')
    .dispatch('chat/changed', { data: {} })
    .catch((error: unknown) => error)
  expect(error).toBeInstanceOf(SendNotAdmissibleError)
  expect(error).toMatchObject({ reason, cause: held })
  expect(member.controlWalk.safetyHold()).toBe(reason)
})

test.each(
  reasons.flatMap((reason) =>
    (['directed', 'broadcast'] as const).map((path) => [reason, path] as const),
  ),
)('automatic reply handoffs recheck after wrap (%s, %s)', async (reason, path) => {
  const crypto = createFakeCrypto({ localDID: 'bob' })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const wrap = crypto.wrap.bind(crypto)
  vi.spyOn(crypto, 'wrap').mockImplementation(async (...args) => {
    const sealed = await wrap(...args)
    entered.resolve()
    await release.promise
    return sealed
  })
  const { hub, member } = await fixture({ 'chat/echo': () => ({ reply: true }) }, crypto)
  const alice = makeMLSPeer(hub, 'alice', secret)
  peers.push(alice)
  await alice.peer.replay()
  const client = await alice.peer.protocol('chat').to('bob')
  const request = (
    path === 'directed'
      ? client.request('chat/echo', { param: {}, signal: AbortSignal.timeout(150) })
      : alice.peer.protocol('chat').request('chat/echo', { param: {}, timeoutMs: 150 })
  ).catch(() => {})
  await entered.promise
  latchPeerSafety(member, reason)
  release.resolve()
  await request
  expect(hub.published.filter((row) => row.senderDID === 'bob')).toEqual([])
})
