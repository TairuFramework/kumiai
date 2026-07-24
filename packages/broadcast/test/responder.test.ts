import { fromUTF } from '@sozai/codec'
import { EventEmitter } from '@sozai/event'
import { createRuntime } from '@sozai/runtime'
import { describe, expect, test, vi } from 'vitest'

import { createMemoryBus } from '../src/bus.js'
import { BroadcastClient } from '../src/client.js'
import { createBroadcastResponder, suppressible } from '../src/responder.js'
import { createBroadcastTransport, encodeFrame } from '../src/transport.js'

const TOPIC = 'group-topic'

describe('createBroadcastResponder', () => {
  test('answers a request from the client', async () => {
    const bus = createMemoryBus()
    const responder = createBroadcastResponder({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
      from: 'peer-1',
      requestHandlers: { add: (prm) => (prm as { n: number }).n + 1 },
    })
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    })

    const result = await client.request('add', { n: 41 }, { timeoutMs: 1000 })
    expect(result).toBe(42)

    await client.dispose()
    await responder.dispose()
  })

  test('reports a thrown handler error as an error reply', async () => {
    const bus = createMemoryBus()
    const responder = createBroadcastResponder({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
      from: 'peer-1',
      requestHandlers: {
        boom: () => {
          throw new Error('kaboom')
        },
      },
    })
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    })

    await expect(
      client.request('boom', {}, { errorThreshold: 1, timeoutMs: 1000 }),
    ).rejects.toThrow(/error/i)

    await client.dispose()
    await responder.dispose()
  })

  test('keeps answering valid requests after a malformed inbound message', async () => {
    const bus = createMemoryBus()
    const responder = createBroadcastResponder({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
      from: 'peer-1',
      requestHandlers: { ping: () => 'pong' },
    })
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    })

    // Inject raw non-JSON bytes directly onto the bus, bypassing the transport's
    // write() guard. This simulates an undecryptable message from another group.
    bus.publish(TOPIC, fromUTF('not-valid-json{{{{'))

    // Let the failing decode settle — the stream must NOT die.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    // The responder and client transports should still be functional.
    const result = await client.request('ping', {}, { timeoutMs: 1000 })
    expect(result).toBe('pong')

    await client.dispose()
    await responder.dispose()
  })

  test('suppressible: a slow responder stays silent once it sees another reply', async () => {
    const bus = createMemoryBus()
    // Deterministic jitter: peer-1 replies immediately, peer-2 waits long enough
    // to observe peer-1's reply and suppress itself.
    const fast = createBroadcastResponder({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
      from: 'peer-1',
      requestHandlers: { catchup: suppressible(() => 'answer', { jitterMs: 100 }) },
      getJitterMs: () => 0,
    })
    const slowHandler = vi.fn(() => 'answer')
    const slow = createBroadcastResponder({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
      from: 'peer-2',
      requestHandlers: { catchup: suppressible(slowHandler, { jitterMs: 100 }) },
      getJitterMs: () => 50,
    })
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    })

    const result = await client.request('catchup', {}, { timeoutMs: 200 })
    expect(result).toBe('answer')
    expect(slowHandler).not.toHaveBeenCalled()

    await client.dispose()
    await fast.dispose()
    await slow.dispose()
  })

  test('suppressible: a fast erroring responder does not suppress a slower successful one', async () => {
    const bus = createMemoryBus()
    // peer-1 replies first (jitter 0) but THROWS. peer-2 waits (jitter 50) and succeeds.
    // With the bug, peer-1's error reply marks the rid replied and peer-2 stays silent,
    // so the client times out. Fixed: an error reply never suppresses.
    const failing = createBroadcastResponder({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
      from: 'peer-1',
      requestHandlers: {
        ask: suppressible(
          () => {
            throw new Error('nope')
          },
          { jitterMs: 100 },
        ),
      },
      getJitterMs: () => 0,
    })
    const healthy = createBroadcastResponder({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
      from: 'peer-2',
      requestHandlers: { ask: suppressible(() => 'ok', { jitterMs: 100 }) },
      getJitterMs: () => 50,
    })
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    })

    const result = await client.request('ask', {}, { timeoutMs: 500 })
    expect(result).toBe('ok')

    await client.dispose()
    await failing.dispose()
    await healthy.dispose()
  })

  test('an observed error reply does not suppress this responder', async () => {
    const bus = createMemoryBus()
    const rid = 'fixed-rid'
    const responder = createBroadcastResponder({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
      from: 'peer-1',
      requestHandlers: { ping: suppressible(() => 'pong', { jitterMs: 0 }) },
      getJitterMs: () => 0,
    })
    // A raw error `res` frame is injected onto the bus for the exact rid the client is
    // about to use, before the real request reaches the responder. If the observe-loop
    // suppressed on it (pre-fix), the responder would silently ignore that request.
    bus.publish(
      TOPIC,
      encodeFrame({
        payload: { typ: 'event', prc: 'ping', data: { kind: 'res', rid, err: 'boom' } },
      }),
    )
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
      runtime: createRuntime({ getRandomID: () => rid }),
    })

    const result = await client.request('ping', {}, { timeoutMs: 500 })
    expect(result).toBe('pong')

    await client.dispose()
    await responder.dispose()
  })

  test('dispatches a fire-and-forget event to the events emitter', async () => {
    const bus = createMemoryBus()
    const events = new EventEmitter<{ note: { data: unknown; senderDID?: string } }>()
    const received: Array<{ data: unknown; senderDID?: string }> = []
    events.on('note', (e) => {
      received.push(e)
    })
    const responder = createBroadcastResponder({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
      from: 'peer-1',
      requestHandlers: {},
      events,
    })
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    })

    await client.dispatch('note', { hello: 'world' })
    await new Promise<void>((resolve) => setTimeout(resolve, 10))

    expect(received).toHaveLength(1)
    expect(received[0]?.data).toEqual({ hello: 'world' })

    await client.dispose()
    await responder.dispose()
  })

  test('drops a malformed control frame instead of forwarding it to events', async () => {
    const bus = createMemoryBus()
    const events = new EventEmitter<{ note: { data: unknown; senderDID?: string } }>()
    const received: Array<{ data: unknown; senderDID?: string }> = []
    events.on('note', (e) => {
      received.push(e)
    })
    const responder = createBroadcastResponder({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
      from: 'peer-1',
      requestHandlers: {},
      events,
    })

    // A control frame (`kind: 'req'`) whose `rid` is not a string fails both the
    // 'res' and 'req' guards and must NOT fall through to the events emitter.
    bus.publish(
      TOPIC,
      encodeFrame({
        payload: { typ: 'event', prc: 'note', data: { kind: 'req', rid: 123, prm: {} } },
      }),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 10))

    expect(received).toHaveLength(0)

    await responder.dispose()
  })

  test('aborts an in-flight request handler on dispose', async () => {
    const bus = createMemoryBus()
    let capturedSignal: AbortSignal | undefined
    let release: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    const responder = createBroadcastResponder({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
      from: 'peer-1',
      requestHandlers: {
        slow: (_prm, context) => {
          capturedSignal = context?.signal
          release()
          // Never resolves on its own; the test disposes the responder to abort it.
          return new Promise((resolve) => {
            context?.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
          })
        },
      },
    })
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    })

    void client.request('slow', {}, { timeoutMs: 1000 }).catch(() => {})
    await started
    expect(capturedSignal?.aborted).toBe(false)

    await responder.dispose()
    expect(capturedSignal?.aborted).toBe(true)

    await client.dispose()
  })

  test('does not register a stray suppress timer or write when a handler resolves on abort after dispose', async () => {
    const bus = createMemoryBus()
    let release: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    const responder = createBroadcastResponder({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
      from: 'peer-1',
      requestHandlers: {
        slow: (_prm, context) => {
          release()
          // Resolves ON abort, the exact pattern that resumes `handleRequest` after
          // `dispose()` has already cleared `suppressTimers`/`inFlight`.
          return new Promise((resolve) => {
            context?.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
          })
        },
      },
    })
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    })

    void client.request('slow', {}, { timeoutMs: 1000 }).catch(() => {})
    await started

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    await responder.dispose()
    // Flush the microtask queue so the abort-resumed `handleRequest` continuation (if any)
    // has run before we inspect what timers it registered.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const registeredSuppressTimer = setTimeoutSpy.mock.calls.some(([, ms]) => ms === 30_000)
    expect(registeredSuppressTimer).toBe(false)
    setTimeoutSpy.mockRestore()

    await client.dispose()
  })
})
