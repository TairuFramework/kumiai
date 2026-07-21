import type { StoredMessage } from '@kumiai/hub-protocol'
import type { HubReceiveSubscription, LogHub } from '@kumiai/hub-tunnel'
import { reset, setup } from '@sozai/log'
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
    const first = ended[0]
    if (first == null) throw new Error('expected one lane-ended report')
    expect((first.error as Error).message).toContain('already bound')
    await mux.dispose()
  })

  /**
   * A HOST THAT WIRED NOTHING STILL FINDS OUT. Both conditions leave a peer that looks healthy
   * and is not — every call keeps succeeding and the group merely appears to have gone quiet —
   * so the host least likely to notice is precisely the one that wired no handler.
   *
   * Routed through `@sozai/log`, and to the console only when logging is NOT configured — an
   * unconfigured logtape discards records, which would put this back where it started.
   */
  test('with no handler wired, the ending is warned rather than swallowed', async () => {
    const hub = new FakeHub()
    const wrapped = endableHub(hub, 'done')
    const warnings: Array<unknown> = []
    const warn = console.error
    console.error = (...args: Array<unknown>) => void warnings.push(args[0])
    try {
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
        // No onReceiveEnded.
      })
      mux.onInbound('topic:x', () => {})
      await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: new Uint8Array([1]) })
      await flush()
      expect(warnings).toEqual([])

      lane?.endLane()
      await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: new Uint8Array([2]) })
      await flush()

      expect(warnings).toHaveLength(1)
      expect(String(warnings[0])).toContain('push lane ended')
      await mux.dispose()
    } finally {
      console.error = warn
    }
  })

  test('a handler the host DID wire replaces the warning rather than adding to it', async () => {
    const hub = new FakeHub()
    const wrapped = endableHub(hub, 'done')
    const warnings: Array<unknown> = []
    const ended: Array<ReceiveLaneEnded> = []
    const warn = console.error
    console.error = (...args: Array<unknown>) => void warnings.push(args[0])
    try {
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

      // The host handled it, so the fallback stays out of the way — including an empty handler,
      // which is how a host says "handled" on purpose.
      expect(ended).toHaveLength(1)
      expect(warnings).toEqual([])
      await mux.dispose()
    } finally {
      console.error = warn
    }
  })

  /**
   * THE PATH AN APP ACTUALLY TAKES. An app configures `@sozai/log` and collects what this stack
   * reports; the console fallback exists only for the case where it has not. Asserted separately
   * because the two branches fail in opposite directions — a record that goes to the console when
   * logging IS configured is noise an app cannot route, and one that goes to the logger when it
   * is NOT is silence.
   */
  test('with logging configured, the report goes to the logger and not the console', async () => {
    const hub = new FakeHub()
    const wrapped = endableHub(hub, 'done')
    const records: Array<{ category: ReadonlyArray<string>; level: string }> = []
    const consoleErrors: Array<unknown> = []
    const realError = console.error
    console.error = (...args: Array<unknown>) => void consoleErrors.push(args[0])
    setup({
      sinks: {
        capture: (record) => {
          records.push({ category: record.category, level: record.level })
        },
      },
      loggers: [{ category: ['kumiai'], lowestLevel: 'debug', sinks: ['capture'] }],
    })
    try {
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
      })
      mux.onInbound('topic:x', () => {})
      await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: new Uint8Array([1]) })
      await flush()

      lane?.endLane()
      await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: new Uint8Array([2]) })
      await flush()

      expect(records).toHaveLength(1)
      expect(records[0]?.category).toEqual(['kumiai', 'rpc'])
      // ERROR, not warn: `@sozai/log`'s own default config admits error and drops warn, so a
      // warning would be discarded by the setup most apps start from.
      expect(records[0]?.level).toBe('error')
      expect(consoleErrors).toEqual([])
      await mux.dispose()
    } finally {
      console.error = realError
      reset()
    }
  })

  test('dispose ends the lane and says nothing, because the caller asked for it', async () => {
    const hub = new FakeHub()
    const ended: Array<ReceiveLaneEnded> = []
    const mux = createHubMux({
      hub,
      localDID: 'bob',
      onReceiveEnded: (event) => ended.push(event),
    })
    // Opened AND delivering first, so the silence below is a lane that ended quietly rather than
    // one that was never there — a mux that never called `receive` would also report nothing.
    const got: Array<string> = []
    mux.onInbound('topic:x', (message) => got.push(message.sequenceID))
    await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: new Uint8Array([1]) })
    await flush()
    expect(got).toHaveLength(1)

    await mux.dispose()
    await flush()
    expect(ended).toEqual([])
  })
})
