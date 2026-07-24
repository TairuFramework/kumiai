import { describe, expect, test } from 'vitest'

import type { BroadcastBus } from '../src/bus.js'
import type { Unwrap } from '../src/transport.js'
import { type BroadcastMessage, createBroadcastTransport, encodeFrame } from '../src/transport.js'

function makeFrame(prc: string, data: Record<string, unknown>): Uint8Array {
  return encodeFrame({ payload: { typ: 'event', prc, data } })
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 30))

/**
 * A `BroadcastBus` fake that hands the test direct control over delivery and the `ack` it
 * carries — `createMemoryBus` never redelivers, so it has no ack to observe at all.
 */
function createAckingBus(): {
  bus: BroadcastBus
  deliver: (payload: Uint8Array) => void
  acked: Array<string>
} {
  let handler: ((payload: Uint8Array, ack?: () => void) => void) | undefined
  const acked: Array<string> = []
  const bus: BroadcastBus = {
    publish: async () => {},
    subscribe: (_topicID, onMessage) => {
      handler = onMessage
      return () => {
        handler = undefined
      }
    },
  }
  let nextID = 0
  return {
    bus,
    deliver: (payload) => {
      const id = String(nextID++)
      handler?.(payload, () => acked.push(id))
    },
    acked,
  }
}

describe('createBroadcastTransport acks what it delivers', () => {
  test('a frame that reaches the consumer is acked', async () => {
    const { bus, deliver, acked } = createAckingBus()
    const transport = createBroadcastTransport<BroadcastMessage, BroadcastMessage>({
      topicID: 't',
      bus,
    })

    const readPromise = transport.read()
    deliver(makeFrame('hello', {}))
    const result = await readPromise
    expect(result.done).not.toBe(true)
    await flush()

    expect(acked).toEqual(['0'])
    await transport.dispose()
  })

  test('a frame dropped for failing to decrypt is still acked', async () => {
    const { bus, deliver, acked } = createAckingBus()
    const unwrap: Unwrap = async () => {
      throw new Error('not this epoch')
    }
    const transport = createBroadcastTransport<BroadcastMessage, BroadcastMessage>({
      topicID: 't',
      bus,
      unwrap,
    })

    deliver(new Uint8Array([9]))
    await flush()

    // Ordinary on a shared topic — another group's or epoch's frame. Leaving it unacked would
    // redeliver the same undecryptable bytes on every reconnect, forever.
    expect(acked).toEqual(['0'])
    await transport.dispose()
  })

  test('a frame in flight when the transport disposes is NOT acked', async () => {
    const { bus, deliver, acked } = createAckingBus()
    let resolveUnwrap: (() => void) | undefined
    const unwrap: Unwrap = () =>
      new Promise<Uint8Array>((resolve) => {
        resolveUnwrap = () => resolve(makeFrame('hello', {}))
      })
    const transport = createBroadcastTransport<BroadcastMessage, BroadcastMessage>({
      topicID: 't',
      bus,
      unwrap,
    })

    // Park a read: `Transport.dispose()` only closes the writable (and so the readable) once
    // something has read or written through it.
    const readPromise = transport.read()
    await flush()

    deliver(new Uint8Array([1]))
    await flush()

    // Transport tears down while the async unwrap is still in flight.
    await transport.dispose()
    resolveUnwrap?.()
    await flush()

    // `controller.enqueue` throws against the now-closed readable. The frame never reached a
    // consumer, so it must not be told upstream as durably handled — the pre-fix behaviour acked
    // it anyway, permanently losing it (`memoryStore.deliveries` is keyed by recipient DID, so an
    // unacked frame redelivers on the next `receive`, but an acked one is gone for good).
    expect(acked).toEqual([])

    await readPromise.catch(() => {})
  })
})
