import type { StoredMessage } from '@kumiai/hub-protocol'
import type { HubReceiveSubscription, LogHub } from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import { createHubMux, type ReceiveLaneEnded } from '../src/hub-mux.js'
import { FakeHub } from './fixtures/fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 10))

/**
 * A drain the caller did not end is a lane that has to be reported.
 *
 * `receive` is ONE long-lived channel, drained once. When it ends — the hub refused it, the
 * connection dropped, the server handed the lane to a newer channel for the same DID — every
 * listener simply stops being called. Nothing throws, and a peer that is only READING a topic
 * calls nothing that could: it is indistinguishable from a group with nothing to say. The
 * connection belongs to the host, so the host is the only thing that can reconnect it, and this
 * notice is how it learns it must.
 *
 * This is the same silent-failure shape as the swallowed subscribe (`onSubscribeFailed`), one
 * level up: there a single topic went unread, here the whole lane does.
 */
describe('the mux reports a push lane that ended without being asked to', () => {
  /** A hub whose receive channel this test can end, in either of the two ways it can end. */
  function endableHub(hub: FakeHub, end: 'done' | 'throw'): LogHub {
    return {
      ...hub,
      publish: hub.publish.bind(hub),
      subscribe: hub.subscribe.bind(hub),
      unsubscribe: hub.unsubscribe.bind(hub),
      fetchTopic: hub.fetchTopic.bind(hub),
      receive(subscriberDID: string): HubReceiveSubscription {
        const inner = hub.receive(subscriberDID)
        const innerIterator = inner[Symbol.asyncIterator]()
        let ended = false
        return {
          [Symbol.asyncIterator]: () => ({
            async next(): Promise<IteratorResult<StoredMessage>> {
              if (ended) {
                if (end === 'throw') throw new Error('receive writer already bound')
                return { value: undefined as unknown as StoredMessage, done: true }
              }
              return await innerIterator.next()
            },
          }),
          return: inner.return?.bind(inner) ?? (() => {}),
          endLane: () => {
            ended = true
          },
        } as HubReceiveSubscription & { endLane: () => void }
      },
    } as unknown as LogHub
  }

  test('an ending channel is reported once, with no error', async () => {
    const hub = new FakeHub()
    const wrapped = endableHub(hub, 'done')
    const ended: Array<ReceiveLaneEnded> = []
    let lane: { endLane: () => void } | undefined
    const mux = createHubMux({
      hub: {
        ...wrapped,
        receive: (did: string) => {
          const subscription = wrapped.receive(did)
          lane = subscription as unknown as { endLane: () => void }
          return subscription
        },
      } as LogHub,
      localDID: 'bob',
      onReceiveEnded: (event) => ended.push(event),
    })

    // The control: the lane is live and delivering before it ends.
    const got: Array<string> = []
    mux.onInbound('topic:x', (message) => got.push(message.sequenceID))
    await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: new Uint8Array([1]) })
    await flush()
    expect(got).toHaveLength(1)
    expect(ended).toEqual([])

    // The lane ends under the mux, the way a server handing it to a newer channel does.
    lane?.endLane()
    await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: new Uint8Array([2]) })
    await flush()

    expect(ended).toEqual([{}])
    await mux.dispose()
  })

  test('a throwing channel is reported with what it threw', async () => {
    const hub = new FakeHub()
    const wrapped = endableHub(hub, 'throw')
    const ended: Array<ReceiveLaneEnded> = []
    let lane: { endLane: () => void } | undefined
    const mux = createHubMux({
      hub: {
        ...wrapped,
        receive: (did: string) => {
          const subscription = wrapped.receive(did)
          lane = subscription as unknown as { endLane: () => void }
          return subscription
        },
      } as LogHub,
      localDID: 'bob',
      onReceiveEnded: (event) => ended.push(event),
    })
    mux.onInbound('topic:x', () => {})
    await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: new Uint8Array([1]) })
    await flush()

    lane?.endLane()
    await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: new Uint8Array([2]) })
    await flush()

    expect(ended).toHaveLength(1)
    expect((ended[0]?.error as Error).message).toContain('already bound')
    await mux.dispose()
  })

  test('dispose ends the lane and says nothing, because the caller asked for it', async () => {
    const hub = new FakeHub()
    const ended: Array<ReceiveLaneEnded> = []
    const mux = createHubMux({
      hub,
      localDID: 'bob',
      onReceiveEnded: (event) => ended.push(event),
    })
    mux.onInbound('topic:x', () => {})
    await flush()
    await mux.dispose()
    await flush()
    expect(ended).toEqual([])
  })
})
