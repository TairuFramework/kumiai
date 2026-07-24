import type { FetchParams, FetchResult, HubStore, StoredMessage } from '@kumiai/hub-protocol'
import { describe, expect, test, vi } from 'vitest'

import { createHandlers } from '../src/handlers.js'
import { createMemoryStore } from '../src/memoryStore.js'
import { HubClientRegistry } from '../src/registry.js'

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
  fetchCalls: () => number
} {
  let call = 0
  const store = {
    ...createMemoryStore(),
    async fetch(_params: FetchParams): Promise<FetchResult> {
      const index = call++
      if (index === 0) await gate // pause during the first page so a live push can race in
      const messages = pages[index] ?? []
      const cursor = messages.length > 0 ? messages[messages.length - 1].sequenceID : null
      const hasMore = index < pages.length - 1
      return hasMore ? { messages, cursor, hasMore: true } : { messages, cursor }
    },
  } as HubStore
  return { store, fetchCalls: () => call }
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
})
