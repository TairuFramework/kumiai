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

  test('a permanently unopenable frame is acked', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })

    const path = createOpenOncePath<Uint8Array>({
      mux,
      topicID: 'topic:app',
      unwrap: async () => {
        throw new Error('another group, an epoch already passed, or not a frame at all')
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

    // Permanently unopenable frames are ordinary on a shared log. Leaving them unacked
    // redelivers the same undecryptable bytes on every reconnect, forever.
    expect(hub.ackedCount('bob')).toBe(1)

    await mux.dispose()
  })

  test('a frame from an epoch not yet reached is retained, not acked', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })

    const path = createOpenOncePath<Uint8Array>({
      mux,
      topicID: 'topic:app',
      unwrap: async () => {
        // Real MLS: `unwrap` refuses any epoch the handle hasn't reached. `retainOnFailure`
        // stands in for reading the frame's own cleartext epoch against the handle's current one
        // (see `peer.ts`'s wiring) without needing a real crypto port here.
        throw new Error('epoch not reached yet')
      },
      retainOnFailure: () => true,
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

    // A peer one commit behind the sender must still see this frame once it catches up. Acking
    // it here — the pre-fix behaviour — is the store reclaiming a frame that was never handled:
    // permanent data loss for the ordinary send-then-apply race, not a corrupt or foreign frame.
    expect(hub.ackedCount('bob')).toBe(0)

    await mux.dispose()
  })
})
