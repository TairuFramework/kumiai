import type { StoredMessage } from '@kumiai/hub-protocol'
import { describe, expect, test } from 'vitest'

import { createHandlers } from '../src/handlers.js'
import { createMemoryStore } from '../src/memoryStore.js'
import { HubClientRegistry } from '../src/registry.js'

const DID = 'did:key:receiver'
const TOPIC = 'topic-window'

type Frame = { sequenceID: string; payload: string }

/** An ack stream the test feeds by hand, standing in for the client's `channel.send({ ack })`. */
function ackFeed() {
  let controller!: ReadableStreamDefaultController<{ ack: Array<string> }>
  const readable = new ReadableStream<{ ack: Array<string> }>({
    start(c) {
      controller = c
    },
  })
  return { readable, ack: (ids: Array<string>) => controller.enqueue({ ack: ids }) }
}

function open(params: {
  handlers: ReturnType<typeof createHandlers>
  acks: ReadableStream<{ ack: Array<string> }>
  written: Array<Frame>
}) {
  const controller = new AbortController()
  const done = params.handlers['hub/v1/receive']({
    message: {
      header: {},
      payload: { typ: 'channel', prc: 'hub/v1/receive', rid: '1', iss: DID },
    },
    param: {},
    signal: controller.signal,
    writable: new WritableStream<Frame>({
      write(chunk) {
        params.written.push(chunk)
      },
    }),
    readable: params.acks,
  } as never) as Promise<void>
  return { controller, done }
}

async function seed(
  store: ReturnType<typeof createMemoryStore>,
  count: number,
  bytes = 1,
): Promise<Array<string>> {
  await store.subscribe({ subscriberDID: DID, topicID: TOPIC })
  const ids: Array<string> = []
  for (let i = 0; i < count; i++) {
    const { sequenceID } = await store.publish({
      senderDID: 'did:key:sender',
      topicID: TOPIC,
      payload: new Uint8Array(bytes),
    })
    ids.push(sequenceID)
  }
  return ids
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await settle(5)
  }
}

describe('hub/v1/receive ack window', () => {
  test('the drain stops at the frame window and resumes as acks arrive', async () => {
    const store = createMemoryStore()
    const ids = await seed(store, 300)
    const handlers = createHandlers({ registry: new HubClientRegistry(), store, receiveWindow: 64 })
    const feed = ackFeed()
    const written: Array<Frame> = []
    const { controller, done } = open({ handlers, acks: feed.readable, written })

    await settle()
    expect(written).toHaveLength(64)

    feed.ack(ids.slice(0, 10))
    await until(() => written.length === 74)
    await settle()
    expect(written).toHaveLength(74)

    controller.abort()
    await done
  })

  test('the drain stops at the byte budget, but always lets one frame through', async () => {
    const store = createMemoryStore()
    // 3000 raw bytes encode to 4000 base64 characters per frame, ~4300 counted with its envelope.
    const ids = await seed(store, 10, 3000)
    const handlers = createHandlers({
      registry: new HubClientRegistry(),
      store,
      receiveWindowBytes: 10_000,
    })
    const feed = ackFeed()
    const written: Array<Frame> = []
    const { controller, done } = open({ handlers, acks: feed.readable, written })

    await settle()
    expect(written).toHaveLength(2)

    feed.ack(ids.slice(0, 2))
    await until(() => written.length === 4)
    controller.abort()
    await done

    // A frame larger than the whole budget is still delivered when nothing else is in flight.
    const big = createMemoryStore()
    await seed(big, 2, 30_000)
    const bigWritten: Array<Frame> = []
    const bigRun = open({
      handlers: createHandlers({
        registry: new HubClientRegistry(),
        store: big,
        receiveWindowBytes: 10_000,
      }),
      acks: ackFeed().readable,
      written: bigWritten,
    })
    await settle()
    expect(bigWritten).toHaveLength(1)
    bigRun.controller.abort()
    await bigRun.done
  })

  test('batched acks (10 at a time) drain a backlog many times the window, in order', async () => {
    const store = createMemoryStore()
    const ids = await seed(store, 600)
    const handlers = createHandlers({ registry: new HubClientRegistry(), store, receiveWindow: 32 })
    const feed = ackFeed()
    const written: Array<Frame> = []
    const { controller, done } = open({ handlers, acks: feed.readable, written })

    let acked = 0
    await until(async () => {
      while (written.length - acked >= 10) {
        feed.ack(written.slice(acked, acked + 10).map((f) => f.sequenceID))
        acked += 10
      }
      return acked === 600
    }, 5000)
    await until(async () => (await store.fetch({ recipientDID: DID })).messages.length === 0)

    expect(written.map((f) => f.sequenceID)).toEqual(ids)
    controller.abort()
    await done
  })

  test('a client that never acks ends the channel after the ack timeout, not before', async () => {
    const store = createMemoryStore()
    await seed(store, 20)
    const registry = new HubClientRegistry()
    const handlers = createHandlers({
      registry,
      store,
      receiveWindow: 5,
      receiveAckTimeout: 100,
    })
    const written: Array<Frame> = []
    const { done } = open({ handlers, acks: ackFeed().readable, written })

    await settle(50)
    expect(registry.isWriterBound(DID)).toBe(true)
    await done // resolves through teardown
    expect(written).toHaveLength(5)
    expect(registry.isWriterBound(DID)).toBe(false)
    // Nothing was acked: the whole backlog stays for the next connect.
    expect((await store.fetch({ recipientDID: DID })).messages).toHaveLength(20)
  })

  test('acks that keep arriving keep resetting the ack timeout', async () => {
    const store = createMemoryStore()
    const ids = await seed(store, 12)
    const registry = new HubClientRegistry()
    const handlers = createHandlers({
      registry,
      store,
      receiveWindow: 4,
      receiveAckTimeout: 80,
    })
    const feed = ackFeed()
    const written: Array<Frame> = []
    const { controller, done } = open({ handlers, acks: feed.readable, written })

    // One ack every 50 ms: never 80 ms without progress, though the whole run takes longer.
    for (let i = 0; i < 8; i++) {
      await settle(50)
      feed.ack([ids[i] as string])
    }
    await until(() => written.length === 12)
    expect(registry.isWriterBound(DID)).toBe(true)
    controller.abort()
    await done
  })

  test('live frames also wait for window room, then flow in order', async () => {
    const store = createMemoryStore()
    await store.subscribe({ subscriberDID: DID, topicID: TOPIC })
    const registry = new HubClientRegistry()
    const handlers = createHandlers({ registry, store, receiveWindow: 4 })
    const feed = ackFeed()
    const written: Array<Frame> = []
    const { controller, done } = open({ handlers, acks: feed.readable, written })
    await settle() // empty drain: live

    const live: Array<string> = []
    for (let i = 0; i < 10; i++) {
      const message: StoredMessage = {
        sequenceID: String(i + 1).padStart(12, '0'),
        senderDID: 'did:key:sender',
        topicID: TOPIC,
        payload: new Uint8Array([1]),
      }
      live.push(message.sequenceID)
      registry.getClient(DID)?.sendMessage?.(message as never)
    }
    await settle()
    expect(written).toHaveLength(4)

    feed.ack(live.slice(0, 4))
    await until(() => written.length === 8)
    feed.ack(live.slice(4, 8))
    await until(() => written.length === 10)
    expect(written.map((f) => f.sequenceID)).toEqual(live)
    expect(registry.isWriterBound(DID)).toBe(true)
    controller.abort()
    await done
  })

  test('acks during the drain land (the ack loop runs from connect, not after the drain)', async () => {
    const store = createMemoryStore()
    const ids = await seed(store, 100)
    const handlers = createHandlers({ registry: new HubClientRegistry(), store, receiveWindow: 10 })
    const feed = ackFeed()
    const written: Array<Frame> = []
    const { controller, done } = open({ handlers, acks: feed.readable, written })
    await settle()
    feed.ack(ids.slice(0, 10))
    await until(async () => (await store.fetch({ recipientDID: DID })).messages.length === 90)
    controller.abort()
    await done
  })
})
