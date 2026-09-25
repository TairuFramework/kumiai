import { describe, expect, test, vi } from 'vitest'

import { createMemoryBus } from '../src/bus.js'
import { BroadcastClient, type GatheredReply } from '../src/client.js'
import { type BroadcastMessage, createBroadcastTransport } from '../src/transport.js'

const TOPIC = 'gather-stream'

function startResponder(
  bus: ReturnType<typeof createMemoryBus>,
  senderDID: string,
  reply: () => { ok?: unknown; err?: string } | Promise<{ ok?: unknown; err?: string }>,
): { dispose(): Promise<void> } {
  const transport = createBroadcastTransport({ topicID: TOPIC, bus })
  let running = true
  void (async () => {
    for await (const message of transport as AsyncIterable<BroadcastMessage>) {
      if (!running) break
      const data = message.payload.data as { kind?: string; rid?: string } | undefined
      if (message.payload.typ !== 'ctrl' || data?.kind !== 'req') continue
      const response = await reply()
      if (!running) break
      await transport.write({
        payload: {
          typ: 'ctrl',
          prc: message.payload.prc,
          data: { kind: 'res', rid: data.rid, ...response },
        },
        senderDID,
      })
    }
  })()
  return {
    async dispose() {
      running = false
      await transport.dispose()
    },
  }
}

function countAbortListeners(signal: AbortSignal): { added: () => number; removed: () => number } {
  let adds = 0
  let removes = 0
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  vi.spyOn(signal, 'addEventListener').mockImplementation((...args) => {
    if (args[0] === 'abort') adds += 1
    add(...args)
  })
  vi.spyOn(signal, 'removeEventListener').mockImplementation((...args) => {
    if (args[0] === 'abort') removes += 1
    remove(...args)
  })
  return { added: () => adds, removed: () => removes }
}

describe('BroadcastClient.gather streaming', () => {
  test('onReply receives accepted replies in arrival order and the stored object', async () => {
    const bus = createMemoryBus()
    const responders = [
      startResponder(bus, 'did:a', () => ({ ok: 1 })),
      startResponder(bus, 'did:b', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { ok: 2 }
      }),
      startResponder(bus, 'did:c', () => ({ err: 'no' })),
    ]
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    })
    const seen: Array<GatheredReply> = []
    const replies = await client.gather(
      'census',
      {},
      {
        quorum: 2,
        timeoutMs: 1000,
        onReply: (reply) => {
          seen.push(reply)
        },
      },
    )
    expect(seen.map((reply) => reply.senderDID)).toEqual(['did:a', 'did:b'])
    expect(seen[0]).toBe(replies[0])
    expect(seen[1]).toBe(replies[1])
    await Promise.all([client.dispose(), ...responders.map((responder) => responder.dispose())])
  })

  test('duplicate senders and error replies do not invoke onReply', async () => {
    const bus = createMemoryBus()
    const responders = [
      startResponder(bus, 'did:a', () => ({ ok: 1 })),
      startResponder(bus, 'did:a', () => ({ ok: 2 })),
      startResponder(bus, 'did:err', () => ({ err: 'no' })),
    ]
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    })
    const onReply = vi.fn()
    const replies = await client.gather('census', {}, { quorum: 3, timeoutMs: 40, onReply })
    expect(replies).toHaveLength(1)
    expect(onReply).toHaveBeenCalledExactlyOnceWith(replies[0])
    await Promise.all([client.dispose(), ...responders.map((responder) => responder.dispose())])
  })

  test('the quorum reply invokes onReply before the promise resolves', async () => {
    const bus = createMemoryBus()
    const responder = startResponder(bus, 'did:a', () => ({ ok: 1 }))
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    })
    const order: Array<string> = []
    await client
      .gather(
        'census',
        {},
        {
          quorum: 1,
          onReply: () => {
            order.push('reply')
          },
        },
      )
      .then(() => {
        order.push('resolved')
      })
    expect(order).toEqual(['reply', 'resolved'])
    await Promise.all([client.dispose(), responder.dispose()])
  })

  test('a pre-aborted signal resolves empty without writing or adding a listener', async () => {
    const bus = createMemoryBus()
    const transport = createBroadcastTransport({ topicID: TOPIC, bus })
    const write = vi.spyOn(transport, 'write')
    const controller = new AbortController()
    controller.abort()
    const listeners = countAbortListeners(controller.signal)
    const client = new BroadcastClient({ transport })
    expect(await client.gather('census', {}, { signal: controller.signal })).toEqual([])
    expect(write).not.toHaveBeenCalled()
    expect(listeners.added()).toBe(0)
    await client.dispose()
  })

  test('abort resolves partial replies and ignores a later reply', async () => {
    const bus = createMemoryBus()
    const fast = startResponder(bus, 'did:fast', () => ({ ok: 1 }))
    const slow = startResponder(bus, 'did:slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      return { ok: 2 }
    })
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    })
    const controller = new AbortController()
    const seen: Array<GatheredReply> = []
    const replies = await client.gather(
      'census',
      {},
      {
        quorum: 3,
        timeoutMs: 1000,
        signal: controller.signal,
        onReply(reply) {
          seen.push(reply)
          controller.abort()
        },
      },
    )
    expect(replies).toEqual([{ senderDID: 'did:fast', value: 1 }])
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(seen).toHaveLength(1)
    expect(replies).toHaveLength(1)
    await Promise.all([client.dispose(), fast.dispose(), slow.dispose()])
  })

  test('caller-side global quorum aborts two independent gathers', async () => {
    const firstBus = createMemoryBus()
    const secondBus = createMemoryBus()
    const buses = [firstBus, secondBus]
    const responders = [
      startResponder(firstBus, 'did:a', () => ({ ok: 1 })),
      startResponder(secondBus, 'did:b', () => ({ ok: 2 })),
    ]
    const clients = buses.map(
      (bus) =>
        new BroadcastClient({
          transport: createBroadcastTransport({ topicID: TOPIC, bus }),
        }),
    )
    const controller = new AbortController()
    const seen = new Set<string>()
    const results = await Promise.all(
      clients.map((client) =>
        client.gather(
          'census',
          {},
          {
            quorum: 99,
            timeoutMs: 1000,
            signal: controller.signal,
            onReply(reply) {
              seen.add(reply.senderDID.toLowerCase())
              if (seen.size === 2) controller.abort()
            },
          },
        ),
      ),
    )
    expect(seen).toEqual(new Set(['did:a', 'did:b']))
    expect(results.map((replies) => replies.length)).toEqual([1, 1])
    await Promise.all([
      ...clients.map((client) => client.dispose()),
      ...responders.map((r) => r.dispose()),
    ])
  })

  test('timeout resolves collected replies and removes its abort listener', async () => {
    const bus = createMemoryBus()
    const responder = startResponder(bus, 'did:a', () => ({ ok: 1 }))
    const controller = new AbortController()
    const listeners = countAbortListeners(controller.signal)
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    })
    expect(
      await client.gather(
        'census',
        {},
        {
          quorum: 2,
          timeoutMs: 40,
          signal: controller.signal,
        },
      ),
    ).toEqual([{ senderDID: 'did:a', value: 1 }])
    expect(listeners.added()).toBe(listeners.removed())
    await Promise.all([client.dispose(), responder.dispose()])
  })

  test.each(['rejects', 'throws'] as const)(
    'a write that %s cleans up and rejects',
    async (mode) => {
      const bus = createMemoryBus()
      const transport = createBroadcastTransport({ topicID: TOPIC, bus })
      const error = new Error('write failed')
      const write = vi.spyOn(transport, 'write')
      if (mode === 'rejects') write.mockRejectedValueOnce(error)
      else
        write.mockImplementationOnce(() => {
          throw error
        })
      const controller = new AbortController()
      const listeners = countAbortListeners(controller.signal)
      const onReply = vi.fn()
      const clear = vi.spyOn(globalThis, 'clearTimeout')
      const client = new BroadcastClient({ transport })
      await expect(
        client.gather(
          'census',
          {},
          {
            timeoutMs: 1000,
            signal: controller.signal,
            onReply,
          },
        ),
      ).rejects.toBe(error)
      expect(clear).toHaveBeenCalled()
      expect(listeners.added()).toBe(listeners.removed())
      const request = write.mock.calls[0]?.[0] as BroadcastMessage
      const rid = (request.payload.data as { rid: string }).rid
      const sender = createBroadcastTransport({ topicID: TOPIC, bus })
      await sender.write({
        payload: { typ: 'ctrl', data: { kind: 'res', rid, ok: 1 } },
        senderDID: 'did:a',
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(onReply).not.toHaveBeenCalled()
      clear.mockRestore()
      await Promise.all([client.dispose(), sender.dispose()])
    },
  )

  test('dispose resolves partial replies and removes the abort listener', async () => {
    const bus = createMemoryBus()
    const responder = startResponder(bus, 'did:a', () => ({ ok: 1 }))
    const controller = new AbortController()
    const listeners = countAbortListeners(controller.signal)
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    })
    const gathered = client.gather(
      'census',
      {},
      {
        quorum: 2,
        timeoutMs: 1000,
        signal: controller.signal,
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    await client.dispose()
    expect(await gathered).toEqual([{ senderDID: 'did:a', value: 1 }])
    expect(listeners.added()).toBe(listeners.removed())
    await responder.dispose()
  })

  test('a throwing observer does not stop collection', async () => {
    const bus = createMemoryBus()
    const responders = [
      startResponder(bus, 'did:a', () => ({ ok: 1 })),
      startResponder(bus, 'did:b', () => ({ ok: 2 })),
    ]
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    })
    const onReply = vi.fn(() => {
      throw new Error('observer failed')
    })
    const replies = await client.gather('census', {}, { quorum: 2, onReply })
    expect(replies).toHaveLength(2)
    expect(onReply).toHaveBeenCalledTimes(2)
    await Promise.all([client.dispose(), ...responders.map((r) => r.dispose())])
  })

  test('disposing from onReply includes the current reply and settles once', async () => {
    const bus = createMemoryBus()
    const responder = startResponder(bus, 'did:a', () => ({ ok: 1 }))
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    })
    const onReply = vi.fn(() => {
      void client.dispose()
    })
    const replies = await client.gather('census', {}, { quorum: 1, onReply })
    expect(replies).toEqual([{ senderDID: 'did:a', value: 1 }])
    expect(onReply).toHaveBeenCalledTimes(1)
    await responder.dispose()
  })

  test('one signal shared by many settled gathers has no listeners left', async () => {
    const bus = createMemoryBus()
    const responder = startResponder(bus, 'did:a', () => ({ ok: 1 }))
    const controller = new AbortController()
    const listeners = countAbortListeners(controller.signal)
    const client = new BroadcastClient({
      transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    })
    for (let index = 0; index < 50; index += 1) {
      await client.gather(
        'census',
        {},
        {
          quorum: index % 2 === 0 ? 1 : 2,
          timeoutMs: 5,
          signal: controller.signal,
        },
      )
    }
    expect(listeners.added()).toBe(50)
    expect(listeners.removed()).toBe(50)
    await Promise.all([client.dispose(), responder.dispose()])
  })
})
