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
  | { kind: 'hang' }
  | { kind: 'reject'; error: unknown }
  | { kind: 'throw'; error: unknown }

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
            case 'hang': {
              // Never settles, no timer (unlike 'delay'), so no open handle. Models the real wire
              // hub during teardown, where return() parks behind the in-flight next().
              return new Promise<never>(() => {})
            }
            case 'reject': {
              const { error } = returnBehavior
              return Promise.reject(error)
            }
            case 'throw': {
              // Genuinely SYNCHRONOUS — thrown before any Promise is even constructed, unlike
              // 'reject' above (an async rejection). Exercises the `iterator.return?.()` call-site
              // guard in `releaseResources()`, which a rejecting promise never reaches.
              const { error } = returnBehavior
              throw error
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

  test('pre-aborted signal: hub-status listener is never left registered (Slice 2, Finding A)', async () => {
    const { hub, fake, unsubscribed } = controllableHub()
    const onSpy = vi.spyOn(fake.events, 'on')

    const c = new AbortController()
    c.abort(new Error('pre-aborted'))

    createHubTunnelTransport({
      hub,
      sessionID: 'teardown-pre-aborted',
      localDID: 'did:key:local',
      sendTopicID: 'topic:out',
      receiveTopicID: 'topic:in',
      reconnectTimeoutMs: 30,
      signal: c.signal,
    })
    await flush()

    // `start()` sees the already-aborted signal and tears down synchronously DURING
    // construction — before the hub-status registration block below it runs. Nothing ever
    // clears a listener registered after that point, so the guard must skip it entirely.
    expect(onSpy).not.toHaveBeenCalled()
    expect(unsubscribed).toHaveLength(1)

    // Defense in depth: even a later 'reconnecting' emission (were a listener somehow still
    // registered) triggers no further teardown work.
    fake.simulateReconnecting()
    await flush(60)
    expect(unsubscribed).toHaveLength(1)
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

  describe('exception-safety (Slice 2, Finding E)', () => {
    test('unsubscribeEvents() throws synchronously: releaseResources() still completes the rest of cleanup', async () => {
      const { hub, fake, unsubscribed, published } = controllableHub()
      // `hub.events.on('status', …)` is real (so a later status event still exercises real
      // arm/clear logic), but the "off" function it hands back to the transport — what
      // `unsubscribeEvents` becomes — throws SYNCHRONOUSLY when called. This is the sync-throw
      // half of Finding E; the existing rejecting-`return()` doubles are async and never reach
      // the `unsubscribeEvents()` try/catch at transport.ts (~lines 285-292).
      const originalOn = fake.events.on.bind(fake.events)
      vi.spyOn(fake.events, 'on').mockImplementation((name, listener, options) => {
        originalOn(name, listener, options)
        return () => {
          throw new Error('unsubscribeEvents boom')
        }
      })

      const controller = new AbortController()
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')

      const transport = createHubTunnelTransport({
        hub,
        sessionID: 'teardown-unsub-events-throw',
        localDID: 'did:key:local',
        sendTopicID: 'topic:out',
        receiveTopicID: 'topic:in',
        reconnectTimeoutMs: 30,
        signal: controller.signal,
      })
      await flush()

      // Dispose must still resolve (Disposer's own contract warns and resolves rather than
      // rethrowing — see the Finding D test above), and everything AFTER the throwing
      // `unsubscribeEvents()` call in `releaseResources()` must still have run.
      await transport.dispose().catch(() => {})
      await flush()

      // Abort listener removed (comes right after the guarded call).
      expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
      // hub.unsubscribe scheduled (comes after that).
      expect(unsubscribed).toContainEqual(['did:key:local', 'topic:in'])
      // sendSessionEnd() — teardown()'s caller-side step after releaseResources() returns —
      // still ran too.
      const endFrames = published
        .filter((params) => params.topicID === 'topic:out')
        .map((params) => decodeFrame(params.payload) as HubFrame)
        .filter((frame) => frame.kind === 'session-end')
      expect(endFrames).toHaveLength(1)

      // Reconnect timer cleared: a later 'reconnecting' emission (the real listener is still
      // technically registered, since our throwing "off" never actually unsubscribed it) arms
      // no new teardown-triggered work — `torndown` guards it, and no leaked timer resurrects
      // a second teardown pass.
      fake.simulateReconnecting()
      await flush(60)
      expect(unsubscribed.length).toBe(1)
      expect(
        published
          .filter((params) => params.topicID === 'topic:out')
          .map((params) => decodeFrame(params.payload) as HubFrame)
          .filter((frame) => frame.kind === 'session-end'),
      ).toHaveLength(1)
    })

    test('iterator.return() throws synchronously: releaseResources() still completes the rest of cleanup', async () => {
      const { hub, unsubscribed, published, setReturnBehavior } = controllableHub()
      const returnError = new Error('sync return boom')
      // A genuinely synchronous throw from `return()` itself — not a rejecting promise (already
      // covered by the Finding D tests below) — which is what the `iterator.return?.()` call-site
      // try/catch in `releaseResources()` (~lines 301-312) exists to guard.
      setReturnBehavior({ kind: 'throw', error: returnError })

      const transport = createHubTunnelTransport({
        hub,
        sessionID: 'teardown-return-throw',
        localDID: 'did:key:local',
        sendTopicID: 'topic:out',
        receiveTopicID: 'topic:in',
      })
      await flush()

      await transport.dispose().catch(() => {})
      await flush()

      // hub.unsubscribe scheduling precedes the throwing `iterator.return()` call in
      // `releaseResources()`'s own ordering, so it is unaffected either way — asserted here for
      // completeness (Finding E's own list of "the rest of cleanup").
      expect(unsubscribed).toContainEqual(['did:key:local', 'topic:in'])

      // What THIS guard actually protects: `releaseResources()` returning normally at all, so
      // `teardown()`'s next step — `sendSessionEnd()` — still runs. An unguarded synchronous
      // throw here propagates out of `releaseResources()` and strands that publish.
      const endFrames = published
        .filter((params) => params.topicID === 'topic:out')
        .map((params) => decodeFrame(params.payload) as HubFrame)
        .filter((frame) => frame.kind === 'session-end')
      expect(endFrames).toHaveLength(1)
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

  describe('drain close is fire-and-forget, never awaited (Slice 2)', () => {
    test('ordinary dispose(): resolves without awaiting the drain close', async () => {
      const { hub, setReturnBehavior, returnCallCount } = controllableHub()
      // A never-settling return() (the real wire hub's teardown shape). The old awaited close
      // deadlocked here.
      setReturnBehavior({ kind: 'hang' })

      const transport = createHubTunnelTransport({
        hub,
        sessionID: 'teardown-drain-dispose',
        localDID: 'did:key:local',
        sendTopicID: 'topic:out',
        receiveTopicID: 'topic:in',
      })
      await flush()

      // Would time out (deadlock) if dispose() awaited the parked close.
      await expect(transport.dispose()).resolves.toBeUndefined()
      // The close was still initiated once (fire-and-forget ≠ never-called).
      expect(returnCallCount()).toBe(1)
    })

    test('remote session-end then dispose(): dispose() resolves without awaiting the drain close', async () => {
      const { hub, setReturnBehavior, returnCallCount } = controllableHub()
      setReturnBehavior({ kind: 'hang' })

      const transport = createHubTunnelTransport({
        hub,
        sessionID: 'teardown-drain-session-end',
        localDID: 'did:key:local',
        sendTopicID: 'topic:out',
        receiveTopicID: 'topic:in',
      })
      await flush()

      // The remote session-end already tears down (and fires the hung close) once.
      await publishSessionEnd(hub, 'teardown-drain-session-end', 'did:key:remote', 'topic:in')
      await flush(10)
      expect(returnCallCount()).toBe(1)

      // A following dispose() still resolves — it neither awaits the hung close nor re-closes.
      await expect(transport.dispose()).resolves.toBeUndefined()
      expect(returnCallCount()).toBe(1)
    })
  })

  test('voluntary dispose (Finding D): a rejecting return() is swallowed fire-and-forget, not warned or unhandled', async () => {
    const { hub, setReturnBehavior } = controllableHub()
    const returnError = new Error('return boom')
    setReturnBehavior({ kind: 'reject', error: returnError })

    const caught: Array<unknown> = []
    const onUnhandledRejection = (reason: unknown): void => {
      caught.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)

    const transport = createHubTunnelTransport({
      hub,
      sessionID: 'teardown-reject-dispose',
      localDID: 'did:key:local',
      sendTopicID: 'topic:out',
      receiveTopicID: 'topic:in',
    })
    await flush()

    // The drain close is fire-and-forget on every path — `releaseResources()`'s no-op catch swallows
    // a rejecting `return()`, and nothing awaits it. So the voluntary path matches the involuntary
    // one below: no unhandled rejection, and no Disposer warn (which an awaited close would produce).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(transport.dispose()).resolves.toBeUndefined()
      // Give the rejected return() promise a full turn to surface as unhandled if it were unguarded.
      await flush(60)
      expect(caught).toHaveLength(0)
      expect(warnSpy).not.toHaveBeenCalledWith('Disposer dispose callback rejected', returnError)
    } finally {
      warnSpy.mockRestore()
      process.off('unhandledRejection', onUnhandledRejection)
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
        // transport.dispose() resolves rather than rejects here (enkaku's Disposer base swallows a
        // rejecting dispose callback into console.warn), so this catch is belt-and-suspenders — not
        // what this test is about; only the process-level unhandledRejection matters here.
      })
    }
  })
})
