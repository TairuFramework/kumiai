import { encodeEventFrame } from '@kumiai/broadcast'
import { describe, expect, onTestFinished, test, vi } from 'vitest'

import { bindAppBatch } from '../src/app-batch.js'
import * as laneModule from '../src/app-lane.js'
import * as boundaryModule from '../src/host-boundary.js'
import * as openedModule from '../src/opened-delivery.js'
import { bindOpenedDelivery } from '../src/opened-delivery.js'
import { createGroupPeer } from '../src/peer.js'
import {
  completeTestRecord,
  createFakeCrypto,
  createTestCompletion,
} from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { openedDeliveryContext } from './fixtures/opened-delivery.js'
import { makeMLSPeer } from './fixtures/peer.js'

vi.mock('../src/app-lane.js', async (original) => {
  const module = await original<typeof laneModule>()
  return { ...module, createAppLane: vi.fn(module.createAppLane) }
})
vi.mock('../src/opened-delivery.js', async (original) => {
  const module = await original<typeof openedModule>()
  return { ...module, createOpenedAppHandler: vi.fn(module.createOpenedAppHandler) }
})
vi.mock('../src/host-boundary.js', async (original) => {
  const module = await original<typeof boundaryModule>()
  return { ...module, wrapPeerHost: vi.fn(module.wrapPeerHost) }
})

test('peer captures original coordination before host wrapping', async () => {
  const record = completeTestRecord(
    {
      frame: {
        id: 'original-record',
        topicID: 'retained-topic',
        position: '1',
        protocol: 'chat',
        segment: 1,
      },
      payload: encodeEventFrame('chat/posted', { text: 'saved' }),
      senderDID: 'alice',
    },
    { groupID: 'memory-group', incarnation: 1 },
    'chat/posted',
    1,
  )
  let pending = true
  const complete = vi.fn(async () => {
    pending = false
  })
  const crypto = createFakeCrypto({ localDID: 'bob' })
  crypto.pending = { list: async () => (pending ? [record] : []), complete }
  const batch = {
    key: { groupID: 'memory-group', incarnation: 1 },
    scheduler: { schedule: vi.fn(), close() {} },
    openReady: vi.fn(),
  }
  bindAppBatch(crypto, batch)
  const handle = vi.fn(async () => {})
  let constructed: ReturnType<typeof makeMLSPeer> | undefined
  expect(() => {
    constructed = makeMLSPeer(new FakeHub(), 'bob', new Uint8Array(32).fill(88), {
      crypto,
      handlers: { 'chat/posted': handle },
    })
  }).not.toThrow()
  const member = constructed
  if (member === undefined) throw new Error('Missing constructed peer')
  onTestFinished(async () => {
    await member.peer.dispose()
    await member.peer.drained()
  })
  await member.peer.drainOpened()
  const input = vi.mocked(boundaryModule.wrapPeerHost).mock.calls.at(-1)?.[1] as {
    completion: unknown
    openedDeliveryContext: unknown
  }
  const dispatcher = vi.mocked(openedModule.createOpenedAppHandler).mock.calls.at(-1)?.[0]
  const lane = vi.mocked(laneModule.createAppLane).mock.calls.at(-1)?.[0]
  expect(lane?.completion).toBe(input.completion)
  expect(lane?.batch).toBe(batch)
  expect(lane?.openedHandler?.completion).toBe(input.completion)
  expect(dispatcher?.completion).toBe(input.completion)
  expect(dispatcher?.openedDeliveryContext).toBe(input.openedDeliveryContext)
  expect(handle).toHaveBeenCalledOnce()
  expect(complete).toHaveBeenCalledExactlyOnceWith(record.frame.id)
})

describe('peer coordination key validation', () => {
  test.each(['opened', 'batch'] as const)('wrong %s key rejects before registration', (kind) => {
    const crypto = createFakeCrypto({ localDID: 'bob' })
    const key = { groupID: 'wrong-origin', incarnation: 3 }
    const untouched = vi.fn()
    if (kind === 'opened') {
      crypto.pending = { list: async () => [], complete: async () => {} }
      bindOpenedDelivery(crypto.pending, {
        key,
        list: async () => [],
        complete: async () => {},
        claim: async () => false,
        attach: untouched,
      })
    } else
      bindAppBatch(crypto, {
        key,
        scheduler: { schedule: untouched, close() {} },
        openReady: untouched,
      })
    const hub = new FakeHub()
    const subscribe = vi.spyOn(hub, 'subscribe')
    const installed = vi.mocked(openedModule.createOpenedAppHandler).mock.calls.length
    expect(() =>
      createGroupPeer({
        crypto,
        mls: kind === 'opened' ? ({} as never) : undefined,
        hub,
        localDID: 'bob',
        completion: createTestCompletion(),
        protocols: {},
        handlers: {},
        openedDeliveryContext,
      }),
    ).toThrow('coordination key mismatch')
    expect(untouched).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    expect(vi.mocked(openedModule.createOpenedAppHandler)).toHaveBeenCalledTimes(installed)
  })
})

test('retained frame metadata survives runtime advance', async () => {
  const { createAppLane } = await import('../src/app-lane.js')
  const { testAppLaneParams } = await import('./fixtures/app-lane.js')
  const { encodeAppAAD } = await import('../src/app-aad.js')
  const { protocolTopic, APP_TOPIC_LABEL } = await import('../src/topic.js')
  const { fakeEpochSecret } = await import('./fixtures/fake-crypto.js')
  const rows = new Map<string, ReturnType<typeof completeTestRecord>>()
  const pending = {
    persistOpened: async (_state: Uint8Array, record: ReturnType<typeof completeTestRecord>) => {
      rows.set(record.frame.id, record)
    },
    list: async () => [...rows.values()],
    complete: async (id: string) => {
      rows.delete(id)
    },
  }
  const receiver = createFakeCrypto({ epoch: 4, retainedEpochs: 16, localDID: 'bob', pending })
  receiver.setEpoch(9)
  const sender = createFakeCrypto({ epoch: 4, localDID: 'alice' })
  const anchor = { epoch: 4, secret: fakeEpochSecret(4, APP_TOPIC_LABEL) }
  const topicID = protocolTopic(anchor.secret, 4, 'chat')
  const sealed = await sender.wrap(encodeEventFrame('posted', { text: 'retained' }), {
    aad: encodeAppAAD({ topicID, intent: 'log' }),
  })
  const handle = vi.fn(async () => {})
  const lane = createAppLane(
    testAppLaneParams({
      groupKey: { groupID: 'metadata-group', incarnation: 3 },
      mux: {
        retainTopic() {},
        fetchTopic: async () => ({
          messages: [{ sequenceID: '1', payload: sealed }],
          head: '1',
          oldest: '1',
        }),
      } as never,
      crypto: receiver,
      localDID: 'bob',
      protocols: { chat: { posted: { type: 'event', retain: 'log' } } },
      handlers: { chat: { posted: handle } },
      anchor: () => anchor,
      groupID: () => 'metadata-group',
      appliedEpoch: () => 9,
      retentionSeconds: 60,
    }),
  )
  onTestFinished(() => lane.dispose())
  await lane.deliver()
  await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce())
  expect(handle.mock.calls).toMatchObject([
    [
      {
        epoch: 4,
        incarnation: 3,
        frame: {
          id: laneModule.frameID(topicID, sealed),
          groupID: 'metadata-group',
          incarnation: 3,
          topicID,
          position: '1',
          protocol: 'chat',
          procedure: 'posted',
        },
        idempotencyKey: JSON.stringify([
          'kumiai/frame/v1',
          'metadata-group',
          3,
          topicID,
          '1',
          'chat',
          'posted',
        ]),
      },
    ],
  ])
  expect(receiver.starts.unwrap).toBe(1)
  await lane.idle()
  expect(rows.size).toBe(0)
})

test('wire and header metadata cannot override authenticated transit facts', async () => {
  const { encodeFrame } = await import('@kumiai/broadcast')
  const { encodeAppAAD } = await import('../src/app-aad.js')
  const { APP_TOPIC_LABEL, protocolTopic } = await import('../src/topic.js')
  const hub = new FakeHub()
  const receiver = createFakeCrypto({ epoch: 4, retainedEpochs: 16, localDID: 'bob' })
  receiver.setEpoch(9)
  const sender = createFakeCrypto({ epoch: 4, localDID: 'alice' })
  let authenticated = true
  const unwrap = receiver.unwrap
  receiver.unwrap = async (...args) => {
    const opened = await unwrap(...args)
    return { ...opened, frameEpoch: authenticated ? opened.frameEpoch : (undefined as never) }
  }
  const complete = vi.fn(async () => {})
  const transact = vi.fn(async () => {})
  const handle = vi.fn(async () => {})
  const peer = createGroupPeer({
    hub,
    crypto: receiver,
    localDID: 'bob',
    completion: {
      ...createTestCompletion({ groupID: 'metadata-group', incarnation: 3 }),
      complete,
      transact,
    },
    protocols: { chat: { changed: { type: 'event' } } },
    handlers: { chat: { changed: handle } },
  })
  onTestFinished(() => peer.dispose())
  const { secret } = await receiver.exportSecret(APP_TOPIC_LABEL)
  const topicID = protocolTopic(secret, 9, 'chat')
  await vi.waitFor(() => expect(hub.subscribeAttempts(topicID)).toBeGreaterThan(0))
  for (const valid of [true, false]) {
    authenticated = valid
    await hub.publish({
      senderDID: 'forged-hub',
      topicID,
      payload: await sender.wrap(
        encodeFrame({
          senderDID: 'forged-wire',
          epoch: 99,
          ...{ incarnation: 99 },
          payload: { typ: 'event', prc: 'changed', data: {} },
        }),
        { aad: encodeAppAAD({ topicID, intent: 'ephemeral' }) },
      ),
    })
    if (valid) await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce())
    else await new Promise((resolve) => setTimeout(resolve, 30))
  }
  expect(handle).toHaveBeenCalledExactlyOnceWith({
    data: {},
    message: { payload: { iss: 'alice' } },
    epoch: 4,
    incarnation: 3,
  })
  expect(complete).not.toHaveBeenCalled()
  expect(transact).not.toHaveBeenCalled()
})

test('anycast metadata survives suppression delay', async () => {
  const { createMemoryBus, createBroadcastTransport, createBroadcastResponder, encodeFrame } =
    await import('@kumiai/broadcast')
  const { adaptBusHandlers } = await import('../src/handlers.js')
  const sleeping = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const bus = createMemoryBus()
  const handle = vi.fn(async () => 42)
  const completion = createTestCompletion({ groupID: 'anycast-metadata', incarnation: 3 })
  const maps = adaptBusHandlers(
    { ping: { type: 'request', param: { type: 'object' }, result: { type: 'number' } } },
    { ping: handle },
    {
      completion,
      suppress: { jitterMs: 10 },
    },
  )
  let epoch = 7
  const responder = createBroadcastResponder({
    transport: createBroadcastTransport({
      topicID: 'anycast-metadata',
      bus,
      unwrap: (payload) => ({ payload, senderDID: 'alice', epoch }),
    }),
    from: 'bob',
    requestHandlers: maps.requestHandlers,
    sleep: async () => {
      sleeping.resolve()
      await release.promise
    },
  })
  try {
    await bus.publish(
      'anycast-metadata',
      encodeFrame({
        payload: { typ: 'ctrl', prc: 'ping', data: { kind: 'req', rid: 'invocation', prm: {} } },
      }),
    )
    await sleeping.promise
    epoch = 9
    release.resolve()
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce())
    expect(handle.mock.calls).toMatchObject([
      [
        {
          epoch: 7,
          incarnation: 3,
          message: { payload: { iss: 'alice' } },
          signal: expect.any(AbortSignal),
        },
      ],
    ])
  } finally {
    release.resolve()
    await responder.dispose()
  }
})

test.each(['origin', 'batch', 'missing-handler'] as const)(
  'app lane refuses mismatched coordination before registration: %s',
  async (kind) => {
    const { createAppLane } = await import('../src/app-lane.js')
    const { testAppLaneParams } = await import('./fixtures/app-lane.js')
    const { createDurableTestCrypto } = await import('./fixtures/fake-crypto.js')
    const register = vi.fn()
    const params = testAppLaneParams({
      groupKey: { groupID: 'lane-origin', incarnation: 3 },
      mux: { retainTopic: register } as never,
      crypto: createDurableTestCrypto({ localDID: 'bob' }),
      localDID: 'bob',
      protocols: {},
      eventHandlers: new Map(),
      retentionSeconds: 60,
      anchor: () => ({ epoch: 1, secret: new Uint8Array(32).fill(7) }),
      groupID: () => 'lane-origin',
      appliedEpoch: () => 1,
    })
    if (kind === 'origin') params.groupKey = { groupID: 'other-origin', incarnation: 3 }
    if (kind === 'batch')
      params.batch = {
        key: { groupID: 'lane-origin', incarnation: 4 },
        scheduler: { schedule: register, close() {} },
        openReady: register,
      }
    if (kind === 'missing-handler') params.openedHandler = undefined
    expect(() => createAppLane(params)).toThrow(TypeError)
    expect(register).not.toHaveBeenCalled()
  },
)
