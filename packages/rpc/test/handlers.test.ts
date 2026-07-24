import { EventEmitter } from '@sozai/event'
import { describe, expect, test, vi } from 'vitest'

import { adaptBusHandlers } from '../src/handlers.js'

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
    const { requestHandlers } = adaptBusHandlers(protocol as never, {
      compute: ({ param }: { param: number }) => param + 1,
    })
    await expect(Promise.resolve(requestHandlers.compute('not-a-number', {}))).rejects.toThrow()
  })

  test('accepts a request whose param passes validation', async () => {
    const { requestHandlers } = adaptBusHandlers(protocol as never, {
      compute: ({ param }: { param: number }) => param + 1,
    })
    await expect(Promise.resolve(requestHandlers.compute(41, {}))).resolves.toBe(42)
  })

  test('drops an event whose data fails validation and never calls the handler', async () => {
    const handler = vi.fn()
    const { events } = adaptBusHandlers(protocol as never, { notify: handler })
    await events.emit('notify', { data: { id: 123 }, senderDID: 'did:x' }) // id must be a string
    expect(handler).not.toHaveBeenCalled()
  })

  test('delivers a valid event to the handler with the authenticated sender', async () => {
    const seen: Array<unknown> = []
    const { events } = adaptBusHandlers(protocol as never, {
      notify: (ctx: { data?: unknown; message: { payload: { iss?: string } } }) => {
        seen.push({ data: ctx.data, iss: ctx.message.payload.iss })
      },
    })
    await events.emit('notify', { data: { id: 'abc' }, senderDID: 'did:sender' })
    expect(seen).toEqual([{ data: { id: 'abc' }, iss: 'did:sender' }])
  })

  test('forwards the responder-supplied signal into the request handler', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const { requestHandlers } = adaptBusHandlers(protocol as never, {
      compute: ({ signal }: { signal?: AbortSignal }) => {
        seen = signal
        return 0
      },
    })
    await Promise.resolve(requestHandlers.compute(1, { signal: controller.signal }))
    expect(seen).toBe(controller.signal)
  })

  test('events is an EventEmitter', () => {
    const { events } = adaptBusHandlers(protocol as never, {})
    expect(events).toBeInstanceOf(EventEmitter)
  })

  test('omits stream and channel procedures from requestHandlers and eventHandlers', () => {
    const { requestHandlers } = adaptBusHandlers(protocolWithStreamChannel as never, {
      streamProc: () => {},
      channelProc: () => {},
    })
    expect(Object.keys(requestHandlers)).not.toContain('streamProc')
    expect(Object.keys(requestHandlers)).not.toContain('channelProc')
  })

  test('tags request handlers suppressible when a suppress config is given', () => {
    const { requestHandlers } = adaptBusHandlers(
      protocol as never,
      { compute: ({ param }: { param: number }) => param },
      { jitterMs: 50 },
    )
    expect((requestHandlers.compute as { suppress?: unknown }).suppress).toBeDefined()
  })
})
