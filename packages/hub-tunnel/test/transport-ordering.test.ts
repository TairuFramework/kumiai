import type { TransportType } from '@enkaku/transport'
import { describe, expect, test } from 'vitest'

import { decodeFrame, encodeFrame, type HubFrame, type HubFrameMessageBody } from '../src/frame.js'
import {
  createHubTunnelTransport,
  type HubReceiveOptions,
  type HubSubscribeOptions,
  type MailboxHub,
  type MailboxHubEvents,
} from '../src/transport.js'
import { FakeHub, type FakeHubPublishParams } from './fixtures/fake-hub.js'

type Msg = HubFrameMessageBody

/**
 * Hub double whose `subscribe` resolves on a delayed macrotask, standing in for a real wire where
 * the subscribe roundtrip has not landed yet. Delegates everything else to a wrapped {@link FakeHub}.
 * Records subscribe/unsubscribe/publish call order and every publish, so a test can assert both
 * "did the subscription end up live" and "in what order did the calls happen".
 */
class DelayedSubscribeHub implements MailboxHub {
  #inner = new FakeHub()
  #delayMs: number
  #live = new Set<string>()
  #publishCalls: Array<FakeHubPublishParams> = []
  order: Array<'subscribe' | 'unsubscribe' | 'publish'> = []

  constructor(delayMs = 20) {
    this.#delayMs = delayMs
  }

  get events(): MailboxHubEvents {
    return this.#inner.events
  }

  async subscribe(
    subscriberDID: string,
    topicID: string,
    options?: HubSubscribeOptions,
  ): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, this.#delayMs))
    this.#inner.subscribe(subscriberDID, topicID, options)
    this.#live.add(`${subscriberDID}::${topicID}`)
    this.order.push('subscribe')
  }

  unsubscribe(subscriberDID: string, topicID: string): void {
    this.#live.delete(`${subscriberDID}::${topicID}`)
    this.order.push('unsubscribe')
    this.#inner.unsubscribe(subscriberDID, topicID)
  }

  receive(subscriberDID: string, _options?: HubReceiveOptions) {
    return this.#inner.receive(subscriberDID)
  }

  async publish(params: FakeHubPublishParams): Promise<{ sequenceID: string }> {
    this.order.push('publish')
    this.#publishCalls.push(params)
    return this.#inner.publish(params)
  }

  /** Currently-registered `subscriberDID::topicID` pairs. */
  liveSubscriptions(): Array<string> {
    return [...this.#live]
  }

  /**
   * Publish calls carrying an application ('message') frame — excludes the best-effort
   * `session-end` frame that teardown always fires when a session is locked, which is orchestration
   * noise unrelated to what these tests check (whether the *write path* published after teardown).
   */
  publishCalls(): Array<FakeHubPublishParams> {
    return this.#publishCalls.filter((call) => {
      try {
        return decodeFrame(call.payload).kind === 'message'
      } catch {
        return false
      }
    })
  }
}

async function readFirstInbound(transport: TransportType<Msg, Msg>, timeoutMs = 200): Promise<Msg> {
  const result = await Promise.race([
    transport.read(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('readFirstInbound timed out')), timeoutMs)
    }),
  ])
  if (result.done) {
    throw new Error('readFirstInbound: stream closed with no value')
  }
  return result.value
}

describe('createHubTunnelTransport ordering', () => {
  test('first send waits for the subscription to land', async () => {
    const hub = new DelayedSubscribeHub()
    const sessionID = 's1'
    const localDID = 'did:peer:local'
    const peerDID = 'did:peer:remote'
    const sendTopicID = 'topic:a'
    const receiveTopicID = 'topic:b'

    const transport = createHubTunnelTransport<Msg, Msg>({
      hub,
      sessionID,
      localDID,
      sendTopicID,
      receiveTopicID,
    })

    try {
      // With the gate in place this resolves only once `hub.subscribe` has landed. Without it,
      // it resolves immediately, racing ahead of the delayed subscribe below.
      await transport.write({ header: {}, payload: { typ: 'test', msg: 'req' } })

      const replyBody: Msg = { header: {}, payload: { typ: 'test', msg: 'reply' } }
      const replyFrame: HubFrame = { v: 1, sessionID, kind: 'message', seq: 0, body: replyBody }
      await hub.publish({
        senderDID: peerDID,
        topicID: receiveTopicID,
        payload: encodeFrame(replyFrame),
      })

      const first = await readFirstInbound(transport)
      expect(first).toEqual(replyBody)
    } finally {
      try {
        await transport.dispose()
      } catch {
        // ignore
      }
    }
  })

  test('teardown unsubscribe is ordered after an in-flight subscribe', async () => {
    const hub = new DelayedSubscribeHub()
    const localDID = 'did:peer:local'
    const sendTopicID = 'topic:a'
    const receiveTopicID = 'topic:b'

    const transport = createHubTunnelTransport<Msg, Msg>({
      hub,
      // auto: never locking a session keeps teardown's best-effort `session-end` publish a
      // no-op, so `hub.order` records only subscribe/unsubscribe.
      sessionID: { auto: true },
      localDID,
      sendTopicID,
      receiveTopicID,
    })

    // Tear down while the subscribe (20ms delay) is still in flight. `dispose()` closes the
    // writable with nothing queued ahead of it, so it settles well before the subscribe does.
    await transport.dispose()

    // Let the delayed subscribe land and its chained unsubscribe run.
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(hub.liveSubscriptions()).toEqual([])
    expect(hub.order).toEqual(['subscribe', 'unsubscribe'])
  })

  test('a write parked on a delayed subscribe does not publish after teardown', async () => {
    const hub = new DelayedSubscribeHub()
    const controller = new AbortController()
    const localDID = 'did:peer:local'
    const sessionID = 's1'
    const sendTopicID = 'topic:a'
    const receiveTopicID = 'topic:b'

    const transport = createHubTunnelTransport<Msg, Msg>({
      hub,
      sessionID,
      localDID,
      sendTopicID,
      receiveTopicID,
      signal: controller.signal,
    })

    const pendingWrite = transport.write({ header: {}, payload: { typ: 'test', msg: 'parked' } })

    // Give the write a moment to reach and park on `await subscribed` (well before the 20ms
    // subscribe delay elapses), then tear down via the abort signal — a path independent of the
    // writable stream's write queue, so it can run while the write is still parked.
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()

    await expect(pendingWrite).rejects.toThrow(/torn down/i)

    // Let the delayed subscribe settle: an unguarded write would resume here and publish.
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(hub.publishCalls()).toEqual([])
  })

  test('duplicate frame redelivery is deduped silently', async () => {
    const hub = new FakeHub()
    const sessionID = 's1'
    const localDID = 'did:peer:local'
    const peerDID = 'did:peer:remote'
    const topicA = 'topic:a'
    const topicB = 'topic:b'

    const localTransport = createHubTunnelTransport<Msg, Msg>({
      hub,
      sessionID,
      localDID,
      sendTopicID: topicB,
      receiveTopicID: topicA,
    })
    const peerTransport = createHubTunnelTransport<Msg, Msg>({
      hub,
      sessionID,
      localDID: peerDID,
      sendTopicID: topicA,
      receiveTopicID: topicB,
    })

    try {
      const total = 5
      hub.duplicateNext(total)

      for (let i = 0; i < total; i++) {
        await peerTransport.write({ header: {}, payload: { typ: 'test', msg: `m-${i}` } })
      }

      const received: Array<string> = []
      for (let i = 0; i < total; i++) {
        const result = await localTransport.read()
        if (result.done) break
        received.push((result.value as Msg).payload.msg as string)
      }

      expect(received).toEqual(['m-0', 'm-1', 'm-2', 'm-3', 'm-4'])

      const raceResult = await Promise.race([
        localTransport.read().then(() => 'read'),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
      ])
      expect(raceResult).toBe('timeout')
    } finally {
      try {
        await localTransport.dispose()
      } catch {
        // ignore
      }
      try {
        await peerTransport.dispose()
      } catch {
        // ignore
      }
      hub.disconnect(localDID)
      hub.disconnect(peerDID)
    }
  })

  test('forward seq gaps are tolerated without tearing down the session', async () => {
    const hub = new FakeHub()
    const sessionID = 's1'
    const localDID = 'did:peer:local'
    const peerDID = 'did:peer:remote'
    const topicA = 'topic:a'
    const topicB = 'topic:b'

    const localTransport = createHubTunnelTransport<Msg, Msg>({
      hub,
      sessionID,
      localDID,
      sendTopicID: topicB,
      receiveTopicID: topicA,
    })
    const peerTransport = createHubTunnelTransport<Msg, Msg>({
      hub,
      sessionID,
      localDID: peerDID,
      sendTopicID: topicA,
      receiveTopicID: topicB,
    })

    try {
      expect(hub.subscriberCount(localDID)).toBe(1)

      const total = 5
      hub.dropNext(1)
      // The first outbound frame (seq=0) is dropped by the hub. Subsequent frames
      // (seq=1..4) should still be accepted by the receiver despite the missing seq=0.
      for (let i = 0; i < total; i++) {
        await peerTransport.write({ header: {}, payload: { typ: 'test', msg: `m-${i}` } })
      }

      const received: Array<string> = []
      for (let i = 0; i < total - 1; i++) {
        const result = await localTransport.read()
        if (result.done) break
        received.push((result.value as Msg).payload.msg as string)
      }

      expect(received).toEqual(['m-1', 'm-2', 'm-3', 'm-4'])
      expect(hub.subscriberCount(localDID)).toBe(1)
    } finally {
      try {
        await localTransport.dispose()
      } catch {
        // ignore
      }
      try {
        await peerTransport.dispose()
      } catch {
        // ignore
      }
      hub.disconnect(localDID)
      hub.disconnect(peerDID)
    }
  })
})
