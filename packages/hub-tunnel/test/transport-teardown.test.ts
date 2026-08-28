import type { StoredMessage } from '@kumiai/hub-protocol'
import { TimeoutInterruption } from '@sozai/async'
import { describe, expect, test, vi } from 'vitest'

import { decodeFrame, encodeFrame, type HubFrame } from '../src/frame.js'
import type {
  HubPublishParams,
  HubReceiveSubscription,
  HubSubscribeOptions,
  MailboxHub,
} from '../src/transport.js'
import { createHubTunnelTransport } from '../src/transport.js'
import { FakeHub } from './fixtures/fake-hub.js'

const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

type Recorder = {
  hub: MailboxHub
  published: Array<HubPublishParams>
  unsubscribed: Array<[string, string]>
}

/**
 * FakeHub with the two teardown effects recorded. Wrapping rather than reading FakeHub's
 * internals: the contract is what the transport CALLS, and a recorder states that directly.
 */
function recordingHub(): Recorder {
  const fake = new FakeHub()
  const published: Array<HubPublishParams> = []
  const unsubscribed: Array<[string, string]> = []
  const hub: MailboxHub = {
    publish: (params) => {
      published.push(params)
      return fake.publish(params)
    },
    subscribe: (subscriberDID: string, topicID: string, options?: HubSubscribeOptions) =>
      fake.subscribe(subscriberDID, topicID, options),
    unsubscribe: (subscriberDID: string, topicID: string) => {
      unsubscribed.push([subscriberDID, topicID])
      return fake.unsubscribe(subscriberDID, topicID)
    },
    receive: (subscriberDID: string) => fake.receive(subscriberDID),
  }
  return { hub, published, unsubscribed }
}

type ReturnBehavior =
  | { kind: 'delegate' }
  | { kind: 'delay'; ms: number }
  | { kind: 'reject'; error: unknown }

type ControllableRecorder = {
  hub: MailboxHub
  fake: FakeHub
  published: Array<HubPublishParams>
  unsubscribed: Array<[string, string]>
  acked: Array<string>
  setReturnBehavior: (behavior: ReturnBehavior) => void
  rejectNextOnce: (error: unknown) => void
  returnCallCount: () => number
}

/**
 * `recordingHub()` plus a receive double whose iterator `return()` is controllable (delayed /
 * rejecting) and whose `next()` can be made to reject once — the two knobs Slice 2's five tests
 * need. `next` and `return` still delegate to a real `FakeHub` iterator by default, so every
 * other transport behavior (message delivery, `result.done` on disconnect) stays real.
 */
function controllableHub(): ControllableRecorder {
  const fake = new FakeHub()
  const published: Array<HubPublishParams> = []
  const unsubscribed: Array<[string, string]> = []
  const acked: Array<string> = []
  let returnBehavior: ReturnBehavior = { kind: 'delegate' }
  let nextRejection: { error: unknown } | undefined
  let returnCalls = 0

  const hub: MailboxHub = {
    publish: (params) => {
      published.push(params)
      return fake.publish(params)
    },
    subscribe: (subscriberDID: string, topicID: string, options?: HubSubscribeOptions) =>
      fake.subscribe(subscriberDID, topicID, options),
    unsubscribe: (subscriberDID: string, topicID: string) => {
      unsubscribed.push([subscriberDID, topicID])
      return fake.unsubscribe(subscriberDID, topicID)
    },
    receive: (subscriberDID: string): HubReceiveSubscription => {
      const inner = fake.receive(subscriberDID)
      const innerIterator = inner[Symbol.asyncIterator]()
      const iterator: AsyncIterator<StoredMessage> = {
        next: () => {
          if (nextRejection != null) {
            const { error } = nextRejection
            nextRejection = undefined
            return Promise.reject(error)
          }
          return innerIterator.next()
        },
        return: () => {
          returnCalls++
          switch (returnBehavior.kind) {
            case 'delegate':
              return Promise.resolve(innerIterator.return?.() ?? { value: undefined, done: true })
            case 'delay': {
              const { ms } = returnBehavior
              return new Promise((resolve) => {
                setTimeout(() => {
                  resolve({ value: undefined, done: true })
                }, ms)
              })
            }
            case 'reject': {
              const { error } = returnBehavior
              return Promise.reject(error)
            }
          }
        },
      }
      return {
        [Symbol.asyncIterator]: () => iterator,
        ack: (sequenceID: string) => {
          acked.push(sequenceID)
        },
      }
    },
    events: fake.events,
  }

  return {
    hub,
    fake,
    published,
    unsubscribed,
    acked,
    setReturnBehavior: (behavior) => {
      returnBehavior = behavior
    },
    rejectNextOnce: (error) => {
      nextRejection = { error }
    },
    returnCallCount: () => returnCalls,
  }
}

const publishSessionEnd = async (
  hub: MailboxHub,
  sessionID: string,
  peerDID: string,
  receiveTopicID: string,
  seq = 0,
): Promise<void> => {
  const frame: HubFrame = { v: 1, sessionID, kind: 'session-end', seq }
  await hub.publish({
    senderDID: peerDID,
    topicID: receiveTopicID,
    payload: encodeFrame(frame),
  })
}

/**
 * The LOCAL teardown path. `transport-ack.test.ts:301` already covers a PEER's session-end
 * reaching `onSessionEnd`; nothing covered this side of it — that tearing down announces
 * itself and releases the subscription.
 */
describe('createHubTunnelTransport teardown', () => {
  test('dispose publishes a session-end frame and unsubscribes', async () => {
    const { hub, published, unsubscribed } = recordingHub()
    // A STRING sessionID, so `lockedSessionID` is set at construction: `sendSessionEnd` returns
    // early on a null session ID, and a transport that has seen no traffic would publish
    // nothing at all — the test would then assert against a vacuum and pass for the wrong reason.
    const transport = createHubTunnelTransport({
      hub,
      sessionID: 'teardown-dispose',
      localDID: 'did:key:local',
      sendTopicID: 'topic:out',
      receiveTopicID: 'topic:in',
    })
    await flush()

    await transport.dispose()
    await flush()

    const endFrames = published
      .filter((params) => params.topicID === 'topic:out')
      .map((params) => decodeFrame(params.payload) as HubFrame)
      .filter((frame) => frame.kind === 'session-end')
    expect(endFrames).toHaveLength(1)
    expect(endFrames[0]?.sessionID).toBe('teardown-dispose')

    expect(unsubscribed).toContainEqual(['did:key:local', 'topic:in'])
  })

  test('an aborted signal takes the same teardown path', async () => {
    const { hub, published, unsubscribed } = recordingHub()
    const controller = new AbortController()
    const transport = createHubTunnelTransport({
      hub,
      sessionID: 'teardown-abort',
      localDID: 'did:key:local',
      sendTopicID: 'topic:out',
      receiveTopicID: 'topic:in',
      signal: controller.signal,
    })
    await flush()

    controller.abort(new Error('user cancel'))
    await flush()

    const endFrames = published
      .filter((params) => params.topicID === 'topic:out')
      .map((params) => decodeFrame(params.payload) as HubFrame)
      .filter((frame) => frame.kind === 'session-end')
    expect(endFrames).toHaveLength(1)
    expect(unsubscribed).toContainEqual(['did:key:local', 'topic:in'])

    // Teardown is once-only (`torndown`), so disposing after an abort must not publish a second.
    await transport.dispose().catch(() => {})
    await flush()
    expect(
      published
        .filter((params) => params.topicID === 'topic:out')
        .map((params) => decodeFrame(params.payload) as HubFrame)
        .filter((frame) => frame.kind === 'session-end'),
    ).toHaveLength(1)
  })

  describe('cleanup-bypass (Slice 2)', () => {
    test('next() rejection path: dispose() after still runs full cleanup', async () => {
      const { hub, unsubscribed, rejectNextOnce, fake } = controllableHub()
      rejectNextOnce(new Error('next boom'))

      const transport = createHubTunnelTransport({
        hub,
        sessionID: 'teardown-next-reject',
        localDID: 'did:key:local',
        sendTopicID: 'topic:out',
        receiveTopicID: 'topic:in',
        reconnectTimeoutMs: 30,
      })

      await expect(transport.read()).rejects.toThrow('next boom')

      await transport.dispose().catch(() => {})
      await flush()

      expect(unsubscribed).toContainEqual(['did:key:local', 'topic:in'])

      // The hub-status listener must have been removed by the (now-routed-through)
      // releaseResources() — a later 'reconnecting' emission arms no reconnect timer, so no
      // second teardown-triggered publish follows.
      fake.simulateReconnecting()
      await flush(60)
      expect(unsubscribed.length).toBe(1)
    })

    test('result.done path: dispose() after still runs full cleanup', async () => {
      const { hub, unsubscribed, fake } = controllableHub()

      const transport = createHubTunnelTransport({
        hub,
        sessionID: 'teardown-result-done',
        localDID: 'did:key:local',
        sendTopicID: 'topic:out',
        receiveTopicID: 'topic:in',
        reconnectTimeoutMs: 30,
      })
      await flush()

      const readPromise = transport.read()
      fake.disconnect('did:key:local')
      const result = await readPromise
      expect(result.done).toBe(true)

      await transport.dispose().catch(() => {})
      await flush()

      expect(unsubscribed).toContainEqual(['did:key:local', 'topic:in'])

      fake.simulateReconnecting()
      await flush(60)
      expect(unsubscribed.length).toBe(1)
    })

    test('remote session-end path: dispose() after still runs full cleanup', async () => {
      const { hub, unsubscribed, fake } = controllableHub()

      const transport = createHubTunnelTransport({
        hub,
        sessionID: 'teardown-session-end',
        localDID: 'did:key:local',
        sendTopicID: 'topic:out',
        receiveTopicID: 'topic:in',
        reconnectTimeoutMs: 30,
      })
      await flush()

      await publishSessionEnd(hub, 'teardown-session-end', 'did:key:remote', 'topic:in')
      await flush()

      await transport.dispose().catch(() => {})
      await flush()

      expect(unsubscribed).toContainEqual(['did:key:local', 'topic:in'])

      fake.simulateReconnecting()
      await flush(60)
      expect(unsubscribed.length).toBe(1)
    })
  })

  test('session-end: ack is observed before iterator.return() resolves', async () => {
    const { hub, acked, setReturnBehavior, returnCallCount } = controllableHub()
    // A delayed return() opens a window: if the ack landed only AFTER return() resolved, it
    // would still be empty at the midpoint check below. Ordering is a spec requirement — the
    // subscription-close comment at transport.ts (ack before iterator.return()) — not an
    // artifact of both settling in the same microtask.
    setReturnBehavior({ kind: 'delay', ms: 50 })

    const transport = createHubTunnelTransport({
      hub,
      sessionID: 'teardown-ack-order',
      localDID: 'did:key:local',
      sendTopicID: 'topic:out',
      receiveTopicID: 'topic:in',
    })
    await flush()

    await publishSessionEnd(hub, 'teardown-ack-order', 'did:key:remote', 'topic:in', 0)

    // Midpoint: well before the 50ms return() delay settles, ack must already have landed.
    await flush(15)
    expect(acked).toHaveLength(1)
    expect(returnCallCount()).toBe(1)

    await flush(60)
    await transport.dispose().catch(() => {})
  })

  describe('drain-await ordering (Slice 2)', () => {
    test('ordinary dispose(): does not resolve until return() settles', async () => {
      const { hub, setReturnBehavior } = controllableHub()
      setReturnBehavior({ kind: 'delay', ms: 80 })

      const transport = createHubTunnelTransport({
        hub,
        sessionID: 'teardown-drain-dispose',
        localDID: 'did:key:local',
        sendTopicID: 'topic:out',
        receiveTopicID: 'topic:in',
      })
      await flush()

      let disposed = false
      const disposePromise = transport.dispose().then(() => {
        disposed = true
      })

      await flush(20)
      expect(disposed).toBe(false)

      await flush(90)
      expect(disposed).toBe(true)

      await disposePromise
    })

    test('remote session-end then dispose(): dispose() waits for the delayed return()', async () => {
      const { hub, setReturnBehavior } = controllableHub()
      setReturnBehavior({ kind: 'delay', ms: 80 })

      const transport = createHubTunnelTransport({
        hub,
        sessionID: 'teardown-drain-session-end',
        localDID: 'did:key:local',
        sendTopicID: 'topic:out',
        receiveTopicID: 'topic:in',
      })
      await flush()

      await publishSessionEnd(hub, 'teardown-drain-session-end', 'did:key:remote', 'topic:in')
      await flush(10)

      let disposed = false
      const disposePromise = transport.dispose().then(() => {
        disposed = true
      })

      await flush(30)
      expect(disposed).toBe(false)

      await flush(90)
      expect(disposed).toBe(true)

      await disposePromise
    })
  })

  test('rejection propagation (Finding D): a rejecting return() surfaces, not silently lost', async () => {
    const { hub, setReturnBehavior } = controllableHub()
    const returnError = new Error('return boom')
    setReturnBehavior({ kind: 'reject', error: returnError })

    const transport = createHubTunnelTransport({
      hub,
      sessionID: 'teardown-reject-dispose',
      localDID: 'did:key:local',
      sendTopicID: 'topic:out',
      receiveTopicID: 'topic:in',
    })
    await flush()

    // `@enkaku/transport`'s `Transport` is a `@sozai/async` `Disposer`: by THAT class's own
    // contract (`disposer.js` — `params.dispose(...).then(resolve, (error) => { warn(); resolve() })`),
    // its `dispose()` promise always resolves, even when the dispose callback rejects — a
    // rejection is warned, never rethrown to the caller. So the async `'disposed'` listener's
    // `await receiveClosed` rejection cannot propagate past that boundary (unlike hand-rolled
    // `dispose()` in rpc's `hub-mux.ts`, which has no such swallowing layer). What IS verifiable,
    // and is the reachable half of Finding D for this base class, is that the rejection is
    // surfaced through Disposer's own warning channel with the exact error — not silently lost
    // the way an unawaited `iterator.return?.()` was before this fix.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(transport.dispose()).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith('Disposer dispose callback rejected', returnError)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('involuntary path (Finding D): a rejecting return() with no dispose() is not unhandled', async () => {
    const { hub, setReturnBehavior } = controllableHub()
    const returnError = new Error('idle return boom')
    setReturnBehavior({ kind: 'reject', error: returnError })

    const caught: Array<unknown> = []
    const onUnhandledRejection = (reason: unknown): void => {
      caught.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)

    const transport = createHubTunnelTransport({
      hub,
      sessionID: 'teardown-idle-unhandled',
      localDID: 'did:key:local',
      sendTopicID: 'topic:out',
      receiveTopicID: 'topic:in',
      idleTimeoutMs: 20,
    })

    try {
      await expect(transport.read()).rejects.toBeInstanceOf(TimeoutInterruption)
      // Give the rejected return() promise's settlement a full turn to surface as unhandled.
      await flush(60)
      expect(caught).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
      await transport.dispose().catch(() => {
        // dispose() itself may reject with the same error once it awaits receiveClosed — not
        // what this test is about; only the process-level unhandledRejection matters here.
      })
    }
  })
})
