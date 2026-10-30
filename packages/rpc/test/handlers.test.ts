import { EventEmitter } from '@sozai/event'
import { describe, expect, onTestFinished, test, vi } from 'vitest'

import { adaptBusHandlers, combineDurableHandlers, groupHandlerMetadata } from '../src/handlers.js'
import { createTestCompletion } from './fixtures/fake-crypto.js'

// A minimal protocol: one request with an integer `param`, one event with an
// object `data` requiring a string `id`.
const protocol = {
  compute: {
    type: 'request',
    param: { type: 'integer' },
    result: { type: 'integer' },
  },
  notify: {
    type: 'event',
    data: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
} as const

// The base protocol plus a `stream` and a `channel` procedure, neither of which
// `adaptBusHandlers` should ever turn into a request or event handler.
const protocolWithStreamChannel = {
  ...protocol,
  streamProc: {
    type: 'stream',
    param: { type: 'object' },
    receive: { type: 'object' },
    result: { type: 'object' },
  },
  channelProc: {
    type: 'channel',
    param: { type: 'object' },
    send: { type: 'object' },
    receive: { type: 'object' },
    result: { type: 'object' },
  },
} as const

describe('adaptBusHandlers', () => {
  test('rejects a request whose param fails schema validation', async () => {
    const { requestHandlers } = adaptBusHandlers(
      protocol as never,
      {
        compute: ({ param }: { param: number }) => param + 1,
      } as never,
      { completion: createTestCompletion() },
    )
    const { compute } = requestHandlers
    if (compute === undefined) throw new Error('compute handler missing')
    await expect(Promise.resolve(compute('not-a-number', { epoch: 7 } as never))).rejects.toThrow()
  })

  test('accepts a request whose param passes validation', async () => {
    const { requestHandlers } = adaptBusHandlers(
      protocol as never,
      {
        compute: ({ param }: { param: number }) => param + 1,
      } as never,
      { completion: createTestCompletion() },
    )
    const { compute } = requestHandlers
    if (compute === undefined) throw new Error('compute handler missing')
    await expect(Promise.resolve(compute(41, { epoch: 7 } as never))).resolves.toBe(42)
  })

  test('drops an event whose data fails validation and never calls the handler', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => {
      const calls = diagnostic.mock.calls
      diagnostic.mockRestore()
      expect(calls.length).toBeGreaterThan(0)
    })
    const handler = vi.fn()
    const { events } = adaptBusHandlers(protocol as never, { notify: handler } as never, {
      completion: createTestCompletion(),
    })
    await events.emit('notify', { data: { id: 123 }, senderDID: 'did:x', epoch: 7 } as never) // id must be a string
    expect(handler).not.toHaveBeenCalled()
  })

  test('delivers a valid event to the handler with the authenticated sender', async () => {
    const seen: Array<unknown> = []
    const { events } = adaptBusHandlers(
      protocol as never,
      {
        notify: (ctx: { data?: unknown; message: { payload: { iss?: string } } }) => {
          seen.push({ data: ctx.data, iss: ctx.message.payload.iss })
        },
      } as never,
      { completion: createTestCompletion() },
    )
    await events.emit('notify', { data: { id: 'abc' }, senderDID: 'did:sender', epoch: 7 } as never)
    expect(seen).toEqual([{ data: { id: 'abc' }, iss: 'did:sender' }])
  })

  test('forwards the responder-supplied signal into the request handler', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const { requestHandlers } = adaptBusHandlers(
      protocol as never,
      {
        compute: ({ signal }: { signal?: AbortSignal }) => {
          seen = signal
          return 0
        },
      } as never,
      { completion: createTestCompletion() },
    )
    const { compute } = requestHandlers
    if (compute === undefined) throw new Error('compute handler missing')
    await Promise.resolve(compute(1, { signal: controller.signal, epoch: 7 } as never))
    expect(seen).toBe(controller.signal)
  })

  test('events is an EventEmitter', () => {
    const { events } = adaptBusHandlers(protocol as never, {} as never, {
      completion: createTestCompletion(),
    })
    expect(events).toBeInstanceOf(EventEmitter)
  })

  test('omits stream and channel procedures from requestHandlers and eventHandlers', () => {
    const { requestHandlers } = adaptBusHandlers(
      protocolWithStreamChannel as never,
      {
        streamProc: () => {},
        channelProc: () => {},
      } as never,
      { completion: createTestCompletion() },
    )
    expect(Object.keys(requestHandlers)).not.toContain('streamProc')
    expect(Object.keys(requestHandlers)).not.toContain('channelProc')
  })

  test('tags request handlers suppressible when a suppress config is given', () => {
    const { requestHandlers } = adaptBusHandlers(
      protocol as never,
      { compute: ({ param }: { param: number }) => param } as never,
      { completion: createTestCompletion(), suppress: { jitterMs: 50 } },
    )
    expect((requestHandlers.compute as { suppress?: unknown }).suppress).toBeDefined()
  })
})

const retainedProtocol = {
  posted: { type: 'event', retain: 'log' },
  typing: { type: 'event', retain: 'ephemeral' },
  ask: { type: 'request' },
  watch: { type: 'stream', receive: { type: 'string' } },
  chat: { type: 'channel', send: { type: 'string' }, receive: { type: 'string' } },
} as const

test('mixed durable listener policies refuse before registration', async () => {
  const installed = vi.spyOn(EventEmitter.prototype, 'on')
  try {
    const handle = vi.fn(async () => {})
    expect(() => combineDurableHandlers([{ handle }, { mode: 'transactional', handle }])).toThrow()
    expect(() => combineDurableHandlers([] as never)).toThrow()
    expect(() => combineDurableHandlers([{ mode: 'invalid', handle }] as never)).toThrow()
    expect(() =>
      adaptBusHandlers(
        retainedProtocol,
        { posted: handle, typing: { mode: 'transactional', handle } } as never,
        { completion: createTestCompletion() },
      ),
    ).toThrow()
    expect(installed).not.toHaveBeenCalled()
    expect(handle).not.toHaveBeenCalled()
    const order: Array<number> = []
    const combined = combineDurableHandlers([
      {
        async handle() {
          order.push(1)
        },
      },
      {
        async handle() {
          order.push(2)
        },
      },
    ])
    await combined.handle({} as never)
    expect(order).toEqual([1, 2])
  } finally {
    installed.mockRestore()
  }
})
test('retained event listeners cannot bypass completion policy', () => {
  const { events } = adaptBusHandlers(retainedProtocol, {} as never, {
    completion: createTestCompletion(),
  })
  expect(() => events.on('posted', () => {})).toThrow()
  expect(() => events.on('typing', () => {})).not.toThrow()
})
test('ephemeral handlers never invoke completion', async () => {
  const complete = vi.fn(async () => {})
  const transact = vi.fn(async () => {})
  const completion = { ...createTestCompletion(), complete, transact }
  const contexts: Array<unknown> = []
  const handler = vi.fn((context) => {
    contexts.push(context)
  })
  const { events, requestHandlers } = adaptBusHandlers(
    retainedProtocol,
    { posted: handler, typing: handler, ask: handler, watch: handler, chat: handler },
    { completion },
  )
  await events.emit('typing', {
    data: {},
    epoch: 7,
    frame: { id: 'forged' },
    idempotencyKey: 'forged',
    tx: {},
  } as never)
  await requestHandlers.ask?.({}, { epoch: 7, frame: {}, tx: {} } as never)
  await events.emit('posted', { data: {}, epoch: 7 } as never)
  expect(handler).toHaveBeenCalledTimes(2)
  for (const context of contexts)
    for (const field of ['frame', 'idempotencyKey', 'tx']) expect(context).not.toHaveProperty(field)
  expect(complete).not.toHaveBeenCalled()
  expect(transact).not.toHaveBeenCalled()
  for (const prc of ['typing', 'ask', 'watch', 'chat'])
    expect(() =>
      adaptBusHandlers(
        retainedProtocol,
        { [prc]: { mode: 'transactional', handle: async () => {} } } as never,
        { completion },
      ),
    ).toThrow()
})
test('handler adapter projects authenticated event and request transit', async () => {
  const completion = createTestCompletion({ groupID: 'metadata', incarnation: 3 })
  expect(groupHandlerMetadata({ epoch: 7 }, completion.key)).toEqual({ epoch: 7, incarnation: 3 })
  expect(() => groupHandlerMetadata({}, completion.key)).toThrow()
  const event = vi.fn()
  const request = vi.fn()
  const maps = adaptBusHandlers(retainedProtocol, { typing: event, ask: request } as never, {
    completion,
  })
  await maps.events.emit('typing', { data: {}, epoch: 7, incarnation: 99 } as never)
  await maps.requestHandlers.ask?.({}, { epoch: 7, incarnation: 99 } as never)
  expect(event.mock.calls[0]?.[0]).toMatchObject({ epoch: 7, incarnation: 3 })
  expect(request.mock.calls[0]?.[0]).toMatchObject({ epoch: 7, incarnation: 3 })
  await expect(maps.events.emit('typing', { data: {} })).rejects.toThrow()
  await expect(Promise.resolve(maps.requestHandlers.ask?.({}, {}))).rejects.toThrow()
  expect(event).toHaveBeenCalledOnce()
  expect(request).toHaveBeenCalledOnce()
})
