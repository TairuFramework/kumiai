import { describe, expect, test } from 'vitest'

import { decodeFrame, type HubFrame } from '../src/frame.js'
import type { HubPublishParams, HubSubscribeOptions, MailboxHub } from '../src/transport.js'
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
})
