import { describe, expect, test } from 'vitest'

import { createHubMux } from '../src/hub-mux.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { hubWithAckOverride } from './fixtures/hub-with-ack-override.js'

const flush = () => new Promise((r) => setTimeout(r, 30))
const payload = () => new Uint8Array([1])

describe('the mux refcounts acks across its holders', () => {
  test('one holder acking does not ack upstream while another still holds the message', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })

    let ackFirst: (() => void) | undefined
    let ackSecond: (() => void) | undefined
    mux.onInbound('topic:x', (_message, ack) => {
      ackFirst = ack
    })
    mux.onInbound('topic:x', (_message, ack) => {
      ackSecond = ack
    })
    await flush()

    await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: payload() })
    await flush()

    ackFirst?.()
    await flush()
    // Still held by the second listener. Acking here would let the hub drop a frame a live
    // consumer has not finished with.
    expect(hub.ackedCount('bob')).toBe(0)

    ackSecond?.()
    await flush()
    expect(hub.ackedCount('bob')).toBe(1)

    await mux.dispose()
  })

  test('a holder acking twice does not free a message another holder still holds', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })

    let ackFirst: (() => void) | undefined
    mux.onInbound('topic:x', (_message, ack) => {
      ackFirst = ack
    })
    mux.onInbound('topic:x', () => {})
    await flush()

    await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: payload() })
    await flush()

    // The set is keyed by holder identity, not by a count. A counter would reach zero here.
    ackFirst?.()
    ackFirst?.()
    await flush()
    expect(hub.ackedCount('bob')).toBe(0)

    await mux.dispose()
  })

  test('a message no holder is interested in is acked immediately', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })
    mux.retainTopic('topic:unwatched')
    await flush()

    await hub.publish({ senderDID: 'alice', topicID: 'topic:unwatched', payload: payload() })
    await flush()

    // Nothing will ever handle it, so nothing will ever ack it. Leaving it pending would hold a
    // frame in the hub mailbox until its age bound, for no reader.
    expect(hub.ackedCount('bob')).toBe(1)

    await mux.dispose()
  })

  test('an expired claim is pruned without acking upstream', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({
      hub,
      localDID: 'bob',
      onSubscribeFailed: () => {},
      ackTTLMs: 0,
    })

    let ackFirst: (() => void) | undefined
    mux.onInbound('topic:x', (_message, ack) => {
      // `??=`, not `=`: the second message calls this listener too, and reassigning would leave
      // `ackFirst` pointing at the second message's claim — which is live, so the test would ack
      // it and read 1 for the wrong reason.
      ackFirst ??= ack
    })
    await flush()

    await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: payload() })
    await flush()
    // A second message drives the sweep, which is lazy — see the implementation note.
    await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: payload() })
    await flush()

    // The first claim expired. Acking on give-up would report a broken holder as durable success;
    // the hub's own age bound reclaims the frame instead.
    ackFirst?.()
    await flush()
    expect(hub.ackedCount('bob')).toBe(0)

    await mux.dispose()
  })

  test('a listener acking synchronously does not free a message a live sink still holds', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })
    const sub = mux.mailbox.receive('bob')
    void (async () => {
      for await (const _ of sub) {
        /* holds it */
      }
    })()
    mux.onInbound('topic:x', (_message, ack) => {
      ack()
    })
    await flush()

    await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: payload() })
    await flush()

    expect(hub.ackedCount('bob')).toBe(0)
    await mux.dispose()
  })

  test('a synchronously-throwing upstream ack does not break the drain', async () => {
    const instance = new DurableFakeHub()
    const hub = hubWithAckOverride(instance, () => {
      throw new Error('ack boom')
    })
    const mux = createHubMux({ hub, localDID: 'bob', onSubscribeFailed: () => {} })

    const received: Array<string> = []
    mux.onInbound('topic:x', (message, ack) => {
      received.push(message.sequenceID)
      // The whole point: this must not throw back out at the caller, whatever the upstream
      // hub's own ack does.
      ack()
    })
    await flush()

    await instance.publish({ senderDID: 'alice', topicID: 'topic:x', payload: payload() })
    await flush()
    expect(received).toHaveLength(1)

    // The drain must still be running: a second message, published after the throw, is still
    // delivered rather than silently lost.
    await instance.publish({ senderDID: 'alice', topicID: 'topic:x', payload: payload() })
    await flush()
    expect(received).toHaveLength(2)

    await mux.dispose()
  })
})
