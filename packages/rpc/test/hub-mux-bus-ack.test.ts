import { describe, expect, test } from 'vitest'

import { createHubMux } from '../src/hub-mux.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

describe('the bus view relays its ack', () => {
  test('a bus subscriber can ack the frame it was handed', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })

    let release: (() => void) | undefined
    mux.bus.subscribe('topic:x', (_payload, ack) => {
      release = ack
    })
    await flush()

    await hub.publish({
      senderDID: 'alice',
      topicID: 'topic:x',
      payload: new Uint8Array([1]),
    })
    await flush()

    expect(hub.ackedCount('bob')).toBe(0)
    release?.()
    await flush()
    expect(hub.ackedCount('bob')).toBe(1)

    await mux.dispose()
  })
})
