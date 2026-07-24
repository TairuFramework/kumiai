import type { StoredMessage } from '@kumiai/hub-protocol'
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
