import { fromUTF, toUTF } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { createMemoryBus } from '../src/bus.js'
import { BroadcastClient } from '../src/client.js'
import { createBroadcastResponder } from '../src/responder.js'
import {
  BROADCAST_VERSION,
  type BroadcastMessage,
  createBroadcastTransport,
  decodeFrame,
  encodeFrame,
  type Unwrap,
} from '../src/transport.js'

const TOPIC = 'topic:reply-identity'
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Toy "MLS": wrap frames [didLen][did][payload]; unwrap recovers the sender from
// inside the ciphertext. Only the holder of a member's `wrap` can produce bytes
// that unwrap to that member — which is the whole property under test.
function stampWrap(did: string) {
  return (bytes: Uint8Array): Uint8Array => {
    const d = fromUTF(did)
    const out = new Uint8Array(2 + d.length + bytes.length)
    new DataView(out.buffer).setUint16(0, d.length, true)
    out.set(d, 2)
    out.set(bytes, 2 + d.length)
    return out
  }
}
const recoverUnwrap: Unwrap = (bytes) => {
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, true)
  return { payload: bytes.subarray(2 + len), senderDID: toUTF(bytes.subarray(2, 2 + len)) }
}

function memberTransport(bus: ReturnType<typeof createMemoryBus>, did: string) {
  return createBroadcastTransport<BroadcastMessage, BroadcastMessage>({
    topicID: TOPIC,
    bus,
    wrap: stampWrap(did),
    unwrap: recoverUnwrap,
  })
}

/**
 * A member who answers requests with a reply body of the caller's choosing — including one that
 * names somebody else. Her frames are sealed under her OWN identity, because that is the only
 * identity she can produce bytes for; everything inside the frame is hers to lie about.
 */
function forger(
  bus: ReturnType<typeof createMemoryBus>,
  did: string,
  prc: string,
  body: Record<string, unknown>,
): { dispose: () => Promise<void> } {
  const transport = memberTransport(bus, did)
  let running = true
  void (async () => {
    for await (const msg of transport as AsyncIterable<BroadcastMessage>) {
      if (!running) break
      const data = msg.payload.data as { kind?: string; rid?: string } | undefined
      if (msg.payload.typ !== 'event' || msg.payload.prc !== prc || data?.kind !== 'req') continue
      await transport
        .write({
          payload: { typ: 'event', prc, data: { kind: 'res', rid: data.rid, ...body } },
        })
        .catch(() => {})
    }
  })().catch(() => {})
  return {
    dispose: async () => {
      running = false
      await transport.dispose()
    },
  }
}

describe('broadcast reply identity', () => {
  test('gather attributes a reply to the authenticated sender, not to the body', async () => {
    const bus = createMemoryBus()
    // The seal says bob; every self-description the responder makes says otherwise.
    const bob = createBroadcastResponder({
      transport: memberTransport(bus, 'did:key:bob'),
      from: 'did:key:impostor',
      requestHandlers: { census: () => 'bob-answer' },
    })
    const client = new BroadcastClient({ transport: memberTransport(bus, 'did:key:alice') })

    const replies = await client.gather('census', {}, { timeoutMs: 300 })
    expect(replies).toEqual([{ senderDID: 'did:key:bob', value: 'bob-answer' }])

    await client.dispose()
    await bob.dispose()
  })

  test('a forged sender cannot displace a real member from the gathered set', async () => {
    const bus = createMemoryBus()
    // Mallory answers first, claiming in the body to be Bob. Under identity-by-assertion this
    // takes Bob's slot in `seen` and Bob's own reply is discarded as a duplicate.
    const mallory = forger(bus, 'did:key:mallory', 'census', {
      from: 'did:key:bob',
      ok: 'forged',
    })
    // Bob is slow enough that the forgery is always first — the race is decided, not sampled.
    const bob = createBroadcastResponder({
      transport: memberTransport(bus, 'did:key:bob'),
      from: 'did:key:bob',
      requestHandlers: {
        census: async () => {
          await sleep(40)
          return 'real'
        },
      },
    })
    const client = new BroadcastClient({ transport: memberTransport(bus, 'did:key:alice') })

    const replies = await client.gather('census', {}, { timeoutMs: 300 })
    const byDID = new Map(replies.map((reply) => [reply.senderDID, reply.value]))

    // Bob's real reply survived the forgery that arrived under his name...
    expect(byDID.get('did:key:bob')).toBe('real')
    // ...and the forgery counted as exactly what it is: one reply from Mallory.
    expect(byDID.get('did:key:mallory')).toBe('forged')
    expect(replies).toHaveLength(2)

    await client.dispose()
    await bob.dispose()
    await mallory.dispose()
  })

  test('one member cannot inflate a quorum by replying under many names', async () => {
    const bus = createMemoryBus()
    const client = new BroadcastClient({ transport: memberTransport(bus, 'did:key:alice') })
    const transport = memberTransport(bus, 'did:key:mallory')
    let running = true
    void (async () => {
      for await (const msg of transport as AsyncIterable<BroadcastMessage>) {
        if (!running) break
        const data = msg.payload.data as { kind?: string; rid?: string } | undefined
        if (data?.kind !== 'req') continue
        for (const name of ['did:key:bob', 'did:key:carol', 'did:key:dave']) {
          await transport
            .write({
              payload: {
                typ: 'event',
                prc: 'census',
                data: { kind: 'res', rid: data.rid, from: name, ok: name },
              },
            })
            .catch(() => {})
        }
      }
    })().catch(() => {})

    // Three replies on the wire, one sender behind them: a quorum of three must NOT be reached.
    const replies = await client.gather('census', {}, { quorum: 3, timeoutMs: 300 })
    expect(replies).toEqual([{ senderDID: 'did:key:mallory', value: 'did:key:bob' }])

    running = false
    await transport.dispose()
    await client.dispose()
  })

  test('an authenticating transport discards a wire-carried senderDID', async () => {
    const bus = createMemoryBus()
    const rx = createBroadcastTransport<BroadcastMessage, BroadcastMessage>({
      topicID: TOPIC,
      bus,
      unwrap: recoverUnwrap,
    })
    const reader = rx[Symbol.asyncIterator]()
    const tx = memberTransport(bus, 'did:key:mallory')

    // The frame is sealed by Mallory and says, in its own body, that it is from Bob.
    await tx.write({
      payload: { typ: 'event', prc: 'x', data: { n: 1 } },
      senderDID: 'did:key:bob',
    })
    const { value } = await reader.next()
    expect((value as BroadcastMessage).senderDID).toBe('did:key:mallory')

    await rx.dispose()
    await tx.dispose()
  })

  test('an authenticating transport that recovers no sender reports none', async () => {
    const bus = createMemoryBus()
    const rx = createBroadcastTransport<BroadcastMessage, BroadcastMessage>({
      topicID: TOPIC,
      bus,
      // Authenticating — it just could not recover a sender from THIS frame. The wire's own
      // claim does not get to fill the gap.
      unwrap: (bytes) => ({ payload: bytes }),
    })
    const reader = rx[Symbol.asyncIterator]()
    const tx = createBroadcastTransport<BroadcastMessage, BroadcastMessage>({ topicID: TOPIC, bus })

    await tx.write({ payload: { typ: 'event', prc: 'x', data: {} }, senderDID: 'did:key:bob' })
    const { value } = await reader.next()
    expect((value as BroadcastMessage).senderDID).toBeUndefined()

    await rx.dispose()
    await tx.dispose()
  })

  test('a reply with no authenticated sender is not gathered', async () => {
    const bus = createMemoryBus()
    const client = new BroadcastClient({
      transport: createBroadcastTransport<BroadcastMessage, BroadcastMessage>({
        topicID: TOPIC,
        bus,
        wrap: stampWrap('did:key:alice'),
        // Authenticating, but this frame's sender cannot be recovered.
        unwrap: (bytes) => {
          const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
            0,
            true,
          )
          return { payload: bytes.subarray(2 + len) }
        },
      }),
    })
    const bob = createBroadcastResponder({
      transport: memberTransport(bus, 'did:key:bob'),
      from: 'did:key:bob',
      requestHandlers: { census: () => 'answer' },
    })

    const replies = await client.gather('census', {}, { timeoutMs: 150 })
    expect(replies).toEqual([])

    await client.dispose()
    await bob.dispose()
  })
})

describe('broadcast wire version', () => {
  test('round-trips the current version', () => {
    const bytes = encodeFrame({ payload: { typ: 'event', prc: 'x', data: { n: 1 } } })
    expect(JSON.parse(toUTF(bytes)).v).toBe(BROADCAST_VERSION)
    expect(decodeFrame(bytes)).toEqual({ payload: { typ: 'event', prc: 'x', data: { n: 1 } } })
  })

  test('rejects an unknown version with a message naming it', () => {
    const bytes = fromUTF(JSON.stringify({ v: 99, payload: { typ: 'event', prc: 'x' } }))
    expect(() => decodeFrame(bytes)).toThrow(/version 99/)
  })

  test('rejects a frame carrying no version at all', () => {
    const bytes = fromUTF(JSON.stringify({ payload: { typ: 'event', prc: 'x' } }))
    expect(() => decodeFrame(bytes)).toThrow(/version/i)
  })

  test('a frame of an unknown version is dropped without killing the subscription', async () => {
    const bus = createMemoryBus()
    const rx = createBroadcastTransport<BroadcastMessage, BroadcastMessage>({
      topicID: TOPIC,
      bus,
    })
    const reader = rx[Symbol.asyncIterator]()

    await bus.publish(
      TOPIC,
      fromUTF(JSON.stringify({ v: 99, payload: { typ: 'event', prc: 'future', data: {} } })),
    )
    await sleep(0)

    const tx = createBroadcastTransport<BroadcastMessage, BroadcastMessage>({
      topicID: TOPIC,
      bus,
    })
    await tx.write({ payload: { typ: 'event', prc: 'now', data: { n: 2 } } })

    const { value } = await reader.next()
    // The v99 frame was skipped, not delivered — and the stream survived it.
    expect((value as BroadcastMessage).payload.prc).toBe('now')

    await rx.dispose()
    await tx.dispose()
  })
})
