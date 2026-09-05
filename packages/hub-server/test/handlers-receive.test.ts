import type { FetchParams, FetchResult, HubStore, StoredMessage } from '@kumiai/hub-protocol'
import { HUB_ERROR_CODES } from '@kumiai/hub-protocol'
import { describe, expect, test, vi } from 'vitest'

import { createHandlers } from '../src/handlers.js'
import { createMemoryStore } from '../src/memoryStore.js'
import { HubClientRegistry } from '../src/registry.js'

type AuthorizeRequestAction = Parameters<
  NonNullable<Parameters<typeof createHandlers>[0]['authorize']>
>[0]['action']

const DID = 'did:key:receiver'

function receiveCtx(params: {
  did?: string
  after?: string
  acks: ReadableStream<{ ack: Array<string> }>
  signal?: AbortSignal
  writable: WritableStream<StoredMessage>
}) {
  return {
    message: {
      header: {},
      payload: { typ: 'channel', prc: 'hub/v1/receive', rid: '1', iss: params.did ?? DID },
    },
    param: params.after != null ? { after: params.after } : {},
    signal: params.signal ?? new AbortController().signal,
    writable: params.writable,
    readable: params.acks,
  } as never
}

/** A writable that records every frame written and resolves each write immediately. */
function collectingWritable(sink: Array<unknown>): WritableStream {
  return new WritableStream({
    write(chunk) {
      sink.push(chunk)
    },
  })
}

/** A readable that emits the given ack messages then closes. */
function ackStream(acks: Array<{ ack: Array<string> }>): ReadableStream<{ ack: Array<string> }> {
  return new ReadableStream({
    start(controller) {
      for (const ack of acks) controller.enqueue(ack)
      controller.close()
    },
  })
}

describe('hub/v1/receive connect gate', () => {
  test('a receive deny rejects the channel and registers no state', async () => {
    const store = createMemoryStore()
    const registry = new HubClientRegistry()
    const handlers = createHandlers({
      registry,
      store,
      authorize: (req) => req.action !== 'receive',
    })

    const written: Array<unknown> = []
    await expect(
      handlers['hub/v1/receive'](
        receiveCtx({ acks: ackStream([]), writable: collectingWritable(written) }),
      ),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.authorizationDenied })

    expect(registry.isWriterBound(DID)).toBe(false)
    expect(registry.getClient(DID)).toBeUndefined()
    expect(written).toEqual([])
  })

  test('a receive allow lets the channel open (empty backlog drains clean)', async () => {
    const store = createMemoryStore()
    const registry = new HubClientRegistry()
    const seen: Array<AuthorizeRequestAction> = []
    const handlers = createHandlers({
      registry,
      store,
      authorize: (req) => {
        seen.push(req.action)
        return true
      },
    })

    const controller = new AbortController()
    const done = handlers['hub/v1/receive'](
      receiveCtx({
        acks: ackStream([]),
        signal: controller.signal,
        writable: collectingWritable([]),
      }),
    )
    await new Promise((r) => setTimeout(r, 20))
    controller.abort()
    await done

    expect(seen).toContain('receive')
  })
})

describe('hub/v1/receive ack loop', () => {
  test('a store.ack failure does not stop later acks from being applied', async () => {
    const store = createMemoryStore()
    const applied: Array<Array<string>> = []
    let calls = 0
    vi.spyOn(store, 'ack').mockImplementation(async (params) => {
      calls++
      if (calls === 1) throw new Error('transient ack failure')
      applied.push(params.sequenceIDs)
    })
    const registry = new HubClientRegistry()
    const handlers = createHandlers({ registry, store })

    const controller = new AbortController()
    const written: Array<unknown> = []
    const done = handlers['hub/v1/receive'](
      receiveCtx({
        acks: ackStream([{ ack: ['000000000001'] }, { ack: ['000000000002'] }]),
        signal: controller.signal,
        writable: collectingWritable(written),
      }),
    )

    // Let the drain (empty backlog) finish and the ack loop consume both messages.
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await done

    // First ack threw; the second was still applied — the loop did not exit on the failure.
    expect(applied).toEqual([['000000000002']])
  })
})

describe('hub/v1/receive pre-aborted signal', () => {
  test('an already-aborted signal runs cleanup and resolves without leaking the writer', async () => {
    const store = createMemoryStore()
    const registry = new HubClientRegistry()
    const handlers = createHandlers({ registry, store })

    const controller = new AbortController()
    controller.abort() // aborted BEFORE the handler runs

    const written: Array<unknown> = []
    const done = handlers['hub/v1/receive'](
      receiveCtx({
        acks: ackStream([]),
        signal: controller.signal,
        writable: collectingWritable(written),
      }),
    )

    // Resolves promptly (cleanup ran); does not hang forever.
    await Promise.race([
      done,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('handler leaked: never resolved')), 100),
      ),
    ])

    // The registry entry is gone — no bound writer left behind.
    expect(registry.isWriterBound(DID)).toBe(false)
    expect(registry.getClient(DID)).toBeUndefined()
  })
})

/** A store whose `fetch` returns a controllable multi-page backlog and pauses on a gate. */
function drainGateStore(
  pages: Array<Array<StoredMessage>>,
  gate: Promise<void>,
): {
  store: HubStore
} {
  let call = 0
  const store = {
    ...createMemoryStore(),
    async fetch(_params: FetchParams): Promise<FetchResult> {
      const index = call++
      if (index === 0) await gate // pause during the first page so a live push can race in
      const messages = pages[index] ?? []
      const cursor = messages.at(-1)?.sequenceID ?? null
      const hasMore = index < pages.length - 1
      return hasMore ? { messages, cursor, hasMore: true } : { messages, cursor }
    },
  } as HubStore
  return { store }
}

function frame(seq: string, topic = 'topic:1'): StoredMessage {
  return {
    sequenceID: seq,
    senderDID: 'did:key:alice',
    topicID: topic,
    payload: new Uint8Array([1]),
  }
}

describe('hub/v1/receive delivery ordering (H1)', () => {
  test('a frame pushed live during the drain is delivered once, after the backlog, in order', async () => {
    let openGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    const { store } = drainGateStore([[frame('000000000001'), frame('000000000002')]], gate)
    const registry = new HubClientRegistry()
    const handlers = createHandlers({ registry, store })

    const controller = new AbortController()
    const written: Array<{ sequenceID: string }> = []
    const done = handlers['hub/v1/receive'](
      receiveCtx({
        acks: ackStream([]),
        signal: controller.signal,
        writable: collectingWritable(written) as WritableStream,
      }),
    )

    // While the drain is paused on the gate, a publish live-pushes seq 3 (newer than the backlog).
    await new Promise((resolve) => setTimeout(resolve, 10))
    registry.getClient(DID)?.sendMessage?.(frame('000000000003'))
    openGate()

    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort()
    await done

    // Exactly once each, in sequence order: backlog (1,2) then the live frame (3). No duplicate 3.
    expect(written.map((m) => m.sequenceID)).toEqual([
      '000000000001',
      '000000000002',
      '000000000003',
    ])
  })

  test('a live frame that is ALSO in the backlog is delivered once (deduped by lastServed)', async () => {
    let openGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    // seq 2 is both pushed live during the drain AND present in the second backlog page.
    const { store } = drainGateStore([[frame('000000000001')], [frame('000000000002')]], gate)
    const registry = new HubClientRegistry()
    const handlers = createHandlers({ registry, store })

    const controller = new AbortController()
    const written: Array<{ sequenceID: string }> = []
    const done = handlers['hub/v1/receive'](
      receiveCtx({
        acks: ackStream([]),
        signal: controller.signal,
        writable: collectingWritable(written) as WritableStream,
      }),
    )

    await new Promise((resolve) => setTimeout(resolve, 10))
    registry.getClient(DID)?.sendMessage?.(frame('000000000002')) // duplicate of the 2nd page
    openGate()

    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort()
    await done

    expect(written.map((m) => m.sequenceID)).toEqual(['000000000001', '000000000002'])
  })

  test('a live frame pushed during the flush write window is delivered, in order (not stranded)', async () => {
    let openDrain: () => void = () => {}
    const drainGate = new Promise<void>((resolve) => {
      openDrain = resolve
    })
    const { store } = drainGateStore([[frame('000000000001')]], drainGate)
    const registry = new HubClientRegistry()
    const handlers = createHandlers({ registry, store })

    // A writable that gates the write of seq2 (the flushed frame) so seq3 can race into the flush
    // window while phase is still 'draining'.
    let openFlushWrite: () => void = () => {}
    const flushWriteGate = new Promise<void>((resolve) => {
      openFlushWrite = resolve
    })
    let sawSeq3Pushed = false
    const written: Array<{ sequenceID: string }> = []
    const writable = new WritableStream<{ sequenceID: string }>({
      async write(chunk) {
        written.push(chunk)
        if (chunk.sequenceID === '000000000002') {
          registry.getClient(DID)?.sendMessage?.(frame('000000000003'))
          sawSeq3Pushed = true
          await flushWriteGate
        }
      },
    })

    const controller = new AbortController()
    const done = handlers['hub/v1/receive'](
      receiveCtx({
        acks: ackStream([]),
        signal: controller.signal,
        writable: writable as WritableStream,
      }),
    )

    await new Promise((resolve) => setTimeout(resolve, 10))
    registry.getClient(DID)?.sendMessage?.(frame('000000000002')) // buffered during draining
    openDrain()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sawSeq3Pushed).toBe(true) // seq3 raced into the flush write window
    openFlushWrite()

    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await done

    // seq3 arrived during the flush write of seq2; it must still be delivered, in order — not stranded.
    expect(written.map((m) => m.sequenceID)).toEqual([
      '000000000001',
      '000000000002',
      '000000000003',
    ])
  })
})

describe('hub/v1/receive backpressure (H3)', () => {
  test('a stalled writer over the buffer limit tears down and releases the registry writer', async () => {
    const store = createMemoryStore()
    const registry = new HubClientRegistry()
    const handlers = createHandlers({ registry, store, receiveBufferLimit: 4 })

    const controller = new AbortController()
    // A writable whose writes never resolve: the write queue backs up.
    const stalled = new WritableStream({
      write() {
        return new Promise<void>(() => {})
      },
    })
    const done = handlers['hub/v1/receive'](
      receiveCtx({ acks: ackStream([]), signal: controller.signal, writable: stalled }),
    )

    await new Promise((resolve) => setTimeout(resolve, 10)) // empty backlog → live phase
    // Push more than the limit; the queue exceeds receiveBufferLimit and teardown fires.
    for (let i = 1; i <= 8; i++) {
      registry.getClient(DID)?.sendMessage?.(frame(String(i).padStart(12, '0')))
    }

    await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('never tore down')), 200)),
    ])

    expect(registry.isWriterBound(DID)).toBe(false)
  })

  test('a stalled reader during the drain does not grow liveBuffer without bound (H3 during draining)', async () => {
    // Backlog present; the write of the first backlog frame stalls, so the drain never leaves 'draining'.
    const { store } = drainGateStore([[frame('000000000001')]], Promise.resolve())
    const registry = new HubClientRegistry()
    const handlers = createHandlers({ registry, store, receiveBufferLimit: 4 })

    const controller = new AbortController()
    const stalled = new WritableStream({
      write() {
        return new Promise<void>(() => {})
      },
    })
    // Not awaited: per the Streams spec, aborting a stream never preempts an in-flight underlying-
    // sink write, so the handler's own returned promise cannot settle while this write is stuck —
    // that's inherent to a genuinely wedged transport, not something `finish()` can fix. The
    // observable side effect under test (the registry writer release) runs synchronously inside
    // `finish()` as soon as the cap is hit, so assert on that directly instead of on `done`.
    void handlers['hub/v1/receive'](
      receiveCtx({ acks: ackStream([]), signal: controller.signal, writable: stalled }),
    )

    await new Promise((resolve) => setTimeout(resolve, 10)) // drain reaches the stalled write, stays draining
    // Push more live frames than the cap while draining; the buffer must not grow unbounded — teardown fires.
    for (let i = 2; i <= 10; i++) {
      registry.getClient(DID)?.sendMessage?.(frame(String(i).padStart(12, '0')))
    }

    const deadline = Date.now() + 200
    while (registry.isWriterBound(DID) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(registry.isWriterBound(DID)).toBe(false)
  })
})

function backlogStore(messages: Array<StoredMessage>): HubStore {
  let done = false
  return {
    ...createMemoryStore(),
    async fetch(): Promise<FetchResult> {
      if (done) return { messages: [], cursor: null }
      done = true
      const cursor = messages.at(-1)?.sequenceID ?? null
      return { messages, cursor } // no hasMore -> single page
    },
  } as HubStore
}

function msg(seq: string, topicID: string): StoredMessage {
  return { sequenceID: seq, senderDID: 'did:key:sender', topicID, payload: new Uint8Array([1]) }
}

async function runReceive(handlers: ReturnType<typeof createHandlers>, written: Array<unknown>) {
  const controller = new AbortController()
  const done = handlers['hub/v1/receive'](
    receiveCtx({
      acks: ackStream([]),
      signal: controller.signal,
      writable: collectingWritable(written),
    }),
  )
  await new Promise((r) => setTimeout(r, 20))
  return { controller, done }
}

describe('hub/v1/receive per-frame gate', () => {
  test('a receive/deliver deny drops that topic from the backlog drain', async () => {
    const store = backlogStore([msg('000000000001', 'topicX'), msg('000000000002', 'topicY')])
    const registry = new HubClientRegistry()
    const handlers = createHandlers({
      registry,
      store,
      authorize: (req) => !(req.action === 'receive/deliver' && req.topicID === 'topicX'),
    })
    const written: Array<{ topicID: string }> = []
    const { controller, done } = await runReceive(handlers, written)
    controller.abort()
    await done
    expect(written.map((f) => f.topicID)).toEqual(['topicY'])
  })

  test('topic isolation on a live stream: denied topic dropped, allowed topic delivered', async () => {
    const store = backlogStore([])
    const registry = new HubClientRegistry()
    const handlers = createHandlers({
      registry,
      store,
      authorize: (req) => !(req.action === 'receive/deliver' && req.topicID === 'topicX'),
    })
    const written: Array<{ topicID: string }> = []
    const { controller, done } = await runReceive(handlers, written) // drains empty -> phase live
    registry.getClient(DID)?.sendMessage?.(msg('000000000003', 'topicX') as never)
    registry.getClient(DID)?.sendMessage?.(msg('000000000004', 'topicY') as never)
    await new Promise((r) => setTimeout(r, 20))
    controller.abort()
    await done
    expect(written.map((f) => f.topicID)).toEqual(['topicY'])
  })

  test('a hook that rejects mid-stream fails closed and tears the channel down', async () => {
    const store = backlogStore([msg('000000000001', 'topicX')])
    const registry = new HubClientRegistry()
    const handlers = createHandlers({
      registry,
      store,
      authorize: (req) => {
        if (req.action === 'receive/deliver') throw new Error('hook exploded')
        return true
      },
    })
    const written: Array<unknown> = []
    const { done } = await runReceive(handlers, written)
    await done // resolves via finish(), does not hang
    expect(registry.isWriterBound(DID)).toBe(false)
    expect(written).toEqual([])
  })

  test('a receive/deliver deny during the buffered-live-flush drops that topic', async () => {
    let openGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    const { store } = drainGateStore([[frame('000000000001', 'topicY')]], gate)
    const registry = new HubClientRegistry()
    const handlers = createHandlers({
      registry,
      store,
      authorize: (req) => !(req.action === 'receive/deliver' && req.topicID === 'topicX'),
    })
    const written: Array<{ topicID: string }> = []
    const controller = new AbortController()
    const done = handlers['hub/v1/receive'](
      receiveCtx({
        acks: ackStream([]),
        signal: controller.signal,
        writable: collectingWritable(written) as WritableStream,
      }),
    )

    // While the drain is paused on the first page, buffer a denied and an allowed live frame.
    await new Promise((resolve) => setTimeout(resolve, 10))
    registry.getClient(DID)?.sendMessage?.(frame('000000000002', 'topicX'))
    registry.getClient(DID)?.sendMessage?.(frame('000000000003', 'topicZ'))
    openGate()

    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort()
    await done

    // topicX never appears; the backlog frame and the allowed buffered frame both do, in order.
    expect(written.map((f) => f.topicID)).toEqual(['topicY', 'topicZ'])
  })

  test('a denied high-seq frame does not advance lastServed past a later allowed lower-seq frame', async () => {
    let openGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    // Backlog carries a DENIED frame at a HIGH sequenceID (topicX, seq 5).
    const { store } = drainGateStore([[frame('000000000005', 'topicX')]], gate)
    const registry = new HubClientRegistry()
    const handlers = createHandlers({
      registry,
      store,
      authorize: (req) => !(req.action === 'receive/deliver' && req.topicID === 'topicX'),
    })
    const written: Array<{ sequenceID: string; topicID: string }> = []
    const controller = new AbortController()
    const done = handlers['hub/v1/receive'](
      receiveCtx({
        acks: ackStream([]),
        signal: controller.signal,
        writable: collectingWritable(written) as WritableStream,
      }),
    )

    // While the drain is paused on the denied seq-5 page, buffer an ALLOWED frame at a LOWER
    // sequenceID (topicY, seq 3). If a deny wrongly advanced `lastServed` to 5, the flush's
    // `sequenceID > lastServed` dedup would wrongly drop this lower-seq frame as "already served".
    await new Promise((resolve) => setTimeout(resolve, 10))
    registry.getClient(DID)?.sendMessage?.(frame('000000000003', 'topicY'))
    openGate()

    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort()
    await done

    // The lower-seq allowed frame must still be delivered — a deny must not advance lastServed.
    expect(written.map((f) => f.sequenceID)).toEqual(['000000000003'])
  })
})

describe('receiveAuthCacheTTL', () => {
  test('within the TTL, repeated same-topic frames consult the hook once', async () => {
    const store = backlogStore([])
    const registry = new HubClientRegistry()
    let deliverCalls = 0
    const handlers = createHandlers({
      registry,
      store,
      receiveAuthCacheTTL: 5000,
      authorize: (req) => {
        if (req.action === 'receive/deliver') deliverCalls++
        return true
      },
    })
    const written: Array<unknown> = []
    const { controller, done } = await runReceive(handlers, written)
    registry.getClient(DID)?.sendMessage?.(msg('000000000001', 'topicX') as never)
    registry.getClient(DID)?.sendMessage?.(msg('000000000002', 'topicX') as never)
    await new Promise((r) => setTimeout(r, 20))
    controller.abort()
    await done
    expect(written.length).toBe(2)
    expect(deliverCalls).toBe(1) // second frame hit the cache
  })

  test('TTL 0 disables reuse: every frame consults the hook', async () => {
    const store = backlogStore([])
    const registry = new HubClientRegistry()
    let deliverCalls = 0
    const handlers = createHandlers({
      registry,
      store,
      receiveAuthCacheTTL: 0,
      authorize: (req) => {
        if (req.action === 'receive/deliver') deliverCalls++
        return true
      },
    })
    const written: Array<unknown> = []
    const { controller, done } = await runReceive(handlers, written)
    registry.getClient(DID)?.sendMessage?.(msg('000000000001', 'topicX') as never)
    registry.getClient(DID)?.sendMessage?.(msg('000000000002', 'topicX') as never)
    await new Promise((r) => setTimeout(r, 20))
    controller.abort()
    await done
    expect(deliverCalls).toBe(2)
  })

  test('a negative TTL falls back to the default (caches, does not disable reuse)', async () => {
    const store = backlogStore([])
    const registry = new HubClientRegistry()
    let deliverCalls = 0
    const handlers = createHandlers({
      registry,
      store,
      receiveAuthCacheTTL: -1,
      authorize: (req) => {
        if (req.action === 'receive/deliver') deliverCalls++
        return true
      },
    })
    const written: Array<unknown> = []
    const { controller, done } = await runReceive(handlers, written)
    registry.getClient(DID)?.sendMessage?.(msg('000000000001', 'topicX') as never)
    registry.getClient(DID)?.sendMessage?.(msg('000000000002', 'topicX') as never)
    await new Promise((r) => setTimeout(r, 20))
    controller.abort()
    await done
    expect(deliverCalls).toBe(1)
  })

  test('Number.POSITIVE_INFINITY falls back to the default, not a permanent allow', async () => {
    const store = backlogStore([])
    const registry = new HubClientRegistry()
    let deliverCalls = 0
    const handlers = createHandlers({
      registry,
      store,
      receiveAuthCacheTTL: Number.POSITIVE_INFINITY,
      authorize: (req) => {
        if (req.action === 'receive/deliver') deliverCalls++
        return true
      },
    })
    const written: Array<unknown> = []
    const { controller, done } = await runReceive(handlers, written)
    registry.getClient(DID)?.sendMessage?.(msg('000000000001', 'topicX') as never)
    registry.getClient(DID)?.sendMessage?.(msg('000000000002', 'topicX') as never)
    await new Promise((r) => setTimeout(r, 20))
    controller.abort()
    await done
    expect(deliverCalls).toBe(1)
  })
})
