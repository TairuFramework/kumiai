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

  test('an ack releases every frame written before it (frames the client never acks do not hold the window)', async () => {
    const store = createMemoryStore()
    const ids = await seed(store, 200)
    const handlers = createHandlers({ registry: new HubClientRegistry(), store, receiveWindow: 64 })
    const feed = ackFeed()
    const written: Array<Frame> = []
    const { controller, done } = open({ handlers, acks: feed.readable, written })

    await settle()
    expect(written).toHaveLength(64)
    // The client acks only the 64th frame. The stream is ordered, so it has read all 64: the hub
    // counts none of them in flight any more, though 63 stay unacked in the store.
    feed.ack([ids[63] as string])
    await until(() => written.length === 128)
    await settle()
    expect(written).toHaveLength(128)
    expect((await store.fetch({ recipientDID: DID, limit: 500 })).messages).toHaveLength(199)

    controller.abort()
    await done
  })

  test('frames a live client never acks (no sink claims them) cannot livelock the channel', async () => {
    const store = createMemoryStore()
    await store.subscribe({ subscriberDID: DID, topicID: TOPIC })
    await store.subscribe({ subscriberDID: DID, topicID: 'unclaimed' })
    // Each claimed frame sits behind three unclaimed ones: the client acks only the claimed.
    const claimed: Array<string> = []
    for (let i = 0; i < 50; i++) {
      for (let k = 0; k < 3; k++) {
        await store.publish({
          senderDID: 'did:key:sender',
          topicID: 'unclaimed',
          payload: new Uint8Array(1),
          retain: 'log',
        })
      }
      const { sequenceID } = await store.publish({
        senderDID: 'did:key:sender',
        topicID: TOPIC,
        payload: new Uint8Array(1),
      })
      claimed.push(sequenceID)
    }
    const handlers = createHandlers({ registry: new HubClientRegistry(), store, receiveWindow: 8 })
    const feed = ackFeed()
    const written: Array<Frame & { topicID: string }> = []
    const { controller, done } = open({
      handlers,
      acks: feed.readable,
      written: written as Array<Frame>,
    })

    let seen = 0
    await until(() => {
      for (; seen < written.length; seen++) {
        const frame = written[seen]
        if (frame?.topicID === TOPIC) feed.ack([frame.sequenceID])
      }
      return written.length === 200
    })
    await until(async () => {
      const left = (await store.fetch({ recipientDID: DID, limit: 500 })).messages
      return left.every((m) => m.topicID === 'unclaimed') && left.length === 150
    })
    controller.abort()
    await done
  })

  test('a full window with no ack at all stops counting after the ack timeout and the drain goes on', async () => {
    const store = createMemoryStore()
    const ids = await seed(store, 20)
    const registry = new HubClientRegistry()
    const handlers = createHandlers({
      registry,
      store,
      receiveWindow: 5,
      receiveAckTimeout: 100,
    })
    const feed = ackFeed()
    const written: Array<Frame> = []
    const { controller, done } = open({ handlers, acks: feed.readable, written })

    // The first 5 frames are never acked (e.g. a topic no sink on the device claims).
    await settle(50)
    expect(written).toHaveLength(5)
    // After the timeout the hub stops counting them, keeps the channel, and writes the next 5.
    await until(() => written.length === 10)
    expect(registry.isWriterBound(DID)).toBe(true)
    // Acks from then on pace the drain as usual.
    feed.ack(ids.slice(5, 10))
    await until(() => written.length === 15)
    expect(written.map((f) => f.sequenceID)).toEqual(ids.slice(0, 15))
    // Nothing was acked but frames 6-10: the unacked ones stay for the next connect.
    expect((await store.fetch({ recipientDID: DID, limit: 500 })).messages).toHaveLength(15)
    controller.abort()
    await done
  })

  test('acks that keep arriving keep resetting the ack timeout', async () => {
    const store = createMemoryStore()
    const ids = await seed(store, 40)
    const handlers = createHandlers({
      registry: new HubClientRegistry(),
      store,
      receiveWindow: 4,
      receiveAckTimeout: 80,
    })
    const feed = ackFeed()
    const written: Array<Frame> = []
    const { controller, done } = open({ handlers, acks: feed.readable, written })

    // One ack every 50 ms: never 80 ms without progress, though the run takes 400 ms. Each ack
    // frees exactly one slot; a timeout would have released the whole window at once.
    for (let i = 0; i < 8; i++) {
      await settle(50)
      feed.ack([ids[i] as string])
    }
    await settle(10)
    expect(written).toHaveLength(12)
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
