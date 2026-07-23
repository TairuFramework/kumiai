import { describe, expect, test } from 'vitest'

import { createHubMux } from '../src/hub-mux.js'
import { createOpenOncePath } from '../src/open-once.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

describe('the open-once path acks what it opens', () => {
  test('an opened frame is acked', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })
    const opened: Array<Uint8Array> = []

    const path = createOpenOncePath<Uint8Array>({
      mux,
      topicID: 'topic:app',
      unwrap: async (payload) => payload,
      project: (_message, result) => result.payload,
    })
    path((value) => opened.push(value))
    await flush()

    await hub.publish({
      senderDID: 'alice',
      topicID: 'topic:app',
      payload: new Uint8Array([1]),
    })
    await flush()

    expect(opened).toHaveLength(1)
    expect(hub.ackedCount('bob')).toBe(1)

    await mux.dispose()
  })

  test('a frame that cannot be opened is acked too', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })

    const path = createOpenOncePath<Uint8Array>({
      mux,
      topicID: 'topic:app',
      unwrap: async () => {
        throw new Error('another epoch')
      },
      project: (_message, result) => result.payload,
    })
    path(() => {})
    await flush()

    await hub.publish({
      senderDID: 'alice',
      topicID: 'topic:app',
      payload: new Uint8Array([1]),
    })
    await flush()

    // Unopenable frames are ordinary on a shared log. Leaving them unacked redelivers the same
    // undecryptable bytes on every reconnect, forever.
    expect(hub.ackedCount('bob')).toBe(1)

    await mux.dispose()
  })
})
