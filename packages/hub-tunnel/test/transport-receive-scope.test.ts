import { describe, expect, test } from 'vitest'

import {
  createHubTunnelTransport,
  type HubReceiveSubscription,
  type MailboxHub,
} from '../src/transport.js'
import { FakeHub } from './fixtures/fake-hub.js'

describe('the tunnel scopes its receive', () => {
  test('the tunnel tells the hub which topic it reads', async () => {
    const fakeHub = new FakeHub()
    const scopes: Array<string | undefined> = []
    // Delegating explicitly, not spreading: `FakeHub` is a class, and `{...instance}` copies own
    // enumerable properties only — every prototype method would be lost. Same shape as
    // `transport-reconnect.test.ts:125`.
    const recordingHub: MailboxHub = {
      publish: (params) => fakeHub.publish(params),
      subscribe: (subscriberDID, topicID, options) =>
        fakeHub.subscribe(subscriberDID, topicID, options),
      unsubscribe: (subscriberDID, topicID) => fakeHub.unsubscribe(subscriberDID, topicID),
      receive: (subscriberDID, options): HubReceiveSubscription => {
        scopes.push(options?.topicID)
        return fakeHub.receive(subscriberDID)
      },
    }

    const transport = createHubTunnelTransport({
      hub: recordingHub,
      sessionID: 'session-1',
      localDID: 'did:key:alice',
      sendTopicID: 'topic:out',
      receiveTopicID: 'topic:in',
    })

    // A hub that knows the scope can refcount an ack against the consumers that will actually
    // handle a frame. Without it every sink is a candidate holder for every message.
    expect(scopes).toEqual(['topic:in'])

    await transport.dispose()
  })
})
