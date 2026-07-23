import { toB64 } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { createEncryptedHubTunnelTransport } from '../src/encrypted-transport.js'
import { encodeEnvelope, type TunnelEnvelope } from '../src/envelope.js'
import { BackpressureError } from '../src/errors.js'
import { encodeFrame, type HubFrame, type HubFrameMessageBody } from '../src/frame.js'
import {
  createHubTunnelTransport,
  type HubReceiveSubscription,
  type MailboxHub,
} from '../src/transport.js'
import { FakeEncryptor } from './fixtures/fake-encryptor.js'
import { FakeHub } from './fixtures/fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

describe('the tunnel acks what it has handled', () => {
  test('an accepted frame and a dropped frame are both acked', async () => {
    const fakeHub = new FakeHub()
    const acked: Array<string> = []
    // Delegating explicitly, not spreading: `FakeHub` is a class, and `{...instance}` copies own
    // enumerable properties only — every prototype method would be lost.
    const ackingHub: MailboxHub = {
      publish: (params) => fakeHub.publish(params),
      subscribe: (subscriberDID, topicID, options) =>
        fakeHub.subscribe(subscriberDID, topicID, options),
      unsubscribe: (subscriberDID, topicID) => fakeHub.unsubscribe(subscriberDID, topicID),
      receive: (subscriberDID): HubReceiveSubscription => {
        const inner = fakeHub.receive(subscriberDID)
        return {
          [Symbol.asyncIterator]: () => inner[Symbol.asyncIterator](),
          return: () => inner.return?.(),
          ack: (sequenceID: string) => void acked.push(sequenceID),
        }
      },
    }

    const transport = createHubTunnelTransport({
      hub: ackingHub,
      sessionID: 'session-1',
      localDID: 'did:key:alice',
      sendTopicID: 'topic:out',
      receiveTopicID: 'topic:in',
    })
    await flush()

    const frame: HubFrame = {
      v: 1,
      sessionID: 'session-1',
      kind: 'message',
      seq: 0,
      body: { header: {}, payload: { typ: 'test' } },
    }
    await fakeHub.publish({
      senderDID: 'did:key:bob',
      topicID: 'topic:in',
      payload: encodeFrame(frame),
    })
    await flush()

    // Undecodable bytes on the same topic: dropped, but handled. Leaving them unacked redelivers
    // the same garbage on every reconnect until it ages out.
    await fakeHub.publish({
      senderDID: 'did:key:bob',
      topicID: 'topic:in',
      payload: new Uint8Array([0xff, 0xff, 0xff]),
    })
    await flush()

    expect(acked).toHaveLength(2)

    await transport.dispose()
  })

  test('the encrypting wrapper forwards ack through to the inner hub', async () => {
    const fakeHub = new FakeHub()
    const acked: Array<string> = []
    // Same delegation pattern as above, recording ack calls made against the INNER (unencrypted)
    // hub — the only place that proves the wrapper forwards `ack` rather than swallowing it.
    const ackingHub: MailboxHub = {
      publish: (params) => fakeHub.publish(params),
      subscribe: (subscriberDID, topicID, options) =>
        fakeHub.subscribe(subscriberDID, topicID, options),
      unsubscribe: (subscriberDID, topicID) => fakeHub.unsubscribe(subscriberDID, topicID),
      receive: (subscriberDID): HubReceiveSubscription => {
        const inner = fakeHub.receive(subscriberDID)
        return {
          [Symbol.asyncIterator]: () => inner[Symbol.asyncIterator](),
          return: () => inner.return?.(),
          ack: (sequenceID: string) => void acked.push(sequenceID),
        }
      },
    }

    const encryptor = new FakeEncryptor()
    const transport = createEncryptedHubTunnelTransport({
      hub: ackingHub,
      encryptor,
      groupID: 'group-1',
      sessionID: 'session-1',
      localDID: 'did:key:alice',
      sendTopicID: 'topic:out',
      receiveTopicID: 'topic:in',
    })
    await flush()

    const frame: HubFrame = {
      v: 1,
      sessionID: 'session-1',
      kind: 'message',
      seq: 0,
      body: { header: {}, payload: { typ: 'test' } },
    }
    const ciphertext = await encryptor.encrypt(encodeFrame(frame))
    const envelope: TunnelEnvelope = { v: 1, groupID: 'group-1', ciphertext: toB64(ciphertext) }
    const { sequenceID } = await fakeHub.publish({
      senderDID: 'did:key:bob',
      topicID: 'topic:in',
      payload: encodeEnvelope(envelope),
    })
    await flush()

    expect(acked).toEqual([sequenceID])

    await transport.dispose()
  })

  test('a frame that trips backpressure overflow is not acked', async () => {
    const fakeHub = new FakeHub()
    const acked: Array<string> = []
    const ackingHub: MailboxHub = {
      publish: (params) => fakeHub.publish(params),
      subscribe: (subscriberDID, topicID, options) =>
        fakeHub.subscribe(subscriberDID, topicID, options),
      unsubscribe: (subscriberDID, topicID) => fakeHub.unsubscribe(subscriberDID, topicID),
      receive: (subscriberDID): HubReceiveSubscription => {
        const inner = fakeHub.receive(subscriberDID)
        return {
          [Symbol.asyncIterator]: () => inner[Symbol.asyncIterator](),
          return: () => inner.return?.(),
          ack: (sequenceID: string) => void acked.push(sequenceID),
        }
      },
    }

    const transport = createHubTunnelTransport({
      hub: ackingHub,
      sessionID: 'session-overflow',
      localDID: 'did:key:erin',
      sendTopicID: 'topic:out-overflow',
      receiveTopicID: 'topic:in-overflow',
      // One slot: the first frame fills it, so the second is the one the pump finds no room
      // for — its ack must not fire even though it was already popped off the subscription.
      inboxCapacity: 1,
    })
    await flush()

    const frameOf = (seq: number): HubFrame => ({
      v: 1,
      sessionID: 'session-overflow',
      kind: 'message',
      seq,
      body: { header: {}, payload: { typ: 'test' } },
    })

    const { sequenceID: keptID } = await fakeHub.publish({
      senderDID: 'did:key:frank',
      topicID: 'topic:in-overflow',
      payload: encodeFrame(frameOf(0)),
    })
    await flush()

    const { sequenceID: overflowID } = await fakeHub.publish({
      senderDID: 'did:key:frank',
      topicID: 'topic:in-overflow',
      payload: encodeFrame(frameOf(1)),
    })
    await flush()

    await expect(transport.read()).rejects.toBeInstanceOf(BackpressureError)
    expect(acked).toEqual([keptID])
    expect(acked).not.toContain(overflowID)

    await transport.dispose()
  })

  test('an ack that throws synchronously does not kill the read pump', async () => {
    const fakeHub = new FakeHub()
    // No delegation to a real ack at all: every call throws synchronously, exercising the
    // guard `Promise.resolve(subscription.ack?.(...))` alone cannot provide, since the throw
    // happens before `Promise.resolve` is ever reached.
    const throwingHub: MailboxHub = {
      publish: (params) => fakeHub.publish(params),
      subscribe: (subscriberDID, topicID, options) =>
        fakeHub.subscribe(subscriberDID, topicID, options),
      unsubscribe: (subscriberDID, topicID) => fakeHub.unsubscribe(subscriberDID, topicID),
      receive: (subscriberDID): HubReceiveSubscription => {
        const inner = fakeHub.receive(subscriberDID)
        return {
          [Symbol.asyncIterator]: () => inner[Symbol.asyncIterator](),
          return: () => inner.return?.(),
          ack: (): void => {
            throw new Error('ack exploded')
          },
        }
      },
    }

    const transport = createHubTunnelTransport({
      hub: throwingHub,
      sessionID: 'session-throw',
      localDID: 'did:key:grace',
      sendTopicID: 'topic:out-throw',
      receiveTopicID: 'topic:in-throw',
    })
    await flush()

    const bodyOf = (msg: string): HubFrameMessageBody => ({
      header: {},
      payload: { typ: 'test', msg },
    })
    const firstFrame: HubFrame = {
      v: 1,
      sessionID: 'session-throw',
      kind: 'message',
      seq: 0,
      body: bodyOf('first'),
    }
    const secondFrame: HubFrame = {
      v: 1,
      sessionID: 'session-throw',
      kind: 'message',
      seq: 1,
      body: bodyOf('second'),
    }

    await fakeHub.publish({
      senderDID: 'did:key:heidi',
      topicID: 'topic:in-throw',
      payload: encodeFrame(firstFrame),
    })
    await fakeHub.publish({
      senderDID: 'did:key:heidi',
      topicID: 'topic:in-throw',
      payload: encodeFrame(secondFrame),
    })

    // The first frame's ack throwing synchronously must not stop the pump from reaching the
    // second: both are delivered despite every ack call failing.
    const first = await transport.read()
    expect((first.value as HubFrameMessageBody).payload.msg).toBe('first')
    const second = await transport.read()
    expect((second.value as HubFrameMessageBody).payload.msg).toBe('second')

    await transport.dispose()
  })
})
