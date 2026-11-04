import type { StoredMessage } from '@kumiai/hub-protocol'
import { fromB64, toB64 } from '@sozai/codec'
import { expect, test } from 'vitest'

import { createEncryptedHubTunnelTransport } from '../src/encrypted-transport.js'
import { decodeEnvelope, encodeEnvelope } from '../src/envelope.js'
import { ExpiredFrameError } from '../src/errors.js'
import type { ObservabilityEvent } from '../src/events.js'
import { decodeFrame, encodeFrame, type HubFrame } from '../src/frame.js'
import type { HubReceiveSubscription, MailboxHub } from '../src/transport.js'

type Msg = { header: Record<string, unknown>; payload: { typ: string; msg: string } }

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// Hub sequence IDs as the hub mints them: one zero-padded counter across publishes and deliveries.
function harness() {
  const acked: Array<string> = []
  const events: Array<ObservabilityEvent> = []
  const published: Array<HubFrame> = []
  let counter = 0
  const nextID = () => String(++counter).padStart(12, '0')
  let push: ((message: StoredMessage) => void) | undefined
  const inner: MailboxHub = {
    publish: async (params) => {
      published.push(decodeFrame(fromB64(decodeEnvelope(params.payload).ciphertext)))
      return { sequenceID: nextID() }
    },
    subscribe: () => {},
    unsubscribe: () => {},
    receive: (): HubReceiveSubscription => {
      const queue: Array<StoredMessage> = []
      let resolveNext: ((result: IteratorResult<StoredMessage>) => void) | undefined
      push = (message) => {
        if (resolveNext != null) {
          const resolve = resolveNext
          resolveNext = undefined
          resolve({ value: message, done: false })
        } else {
          queue.push(message)
        }
      }
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift() as StoredMessage, done: false })
            }
            return new Promise<IteratorResult<StoredMessage>>((resolve) => {
              resolveNext = resolve
            })
          },
        }),
        return: () => {},
        ack: (sequenceID: string) => void acked.push(sequenceID),
      }
    },
  }

  const transport = createEncryptedHubTunnelTransport<Msg, Msg>({
    hub: inner,
    encryptor: {
      encrypt: async (bytes: Uint8Array) => bytes,
      // Like a ratchet that moved past the frame's generation and dropped its key.
      decrypt: async (bytes: Uint8Array) => {
        if (new TextDecoder().decode(bytes).includes('old')) {
          throw new ExpiredFrameError('frame key no longer retained')
        }
        return bytes
      },
    },
    groupID: 'group-1',
    sessionID: 'session-1',
    localDID: 'did:key:alice',
    sendTopicID: 'topic:out',
    receiveTopicID: 'topic:in',
    onEvent: (event) => {
      events.push(event)
    },
  })

  const deliver = (msg: string, seq: number): string => {
    const sequenceID = nextID()
    push?.({
      sequenceID,
      senderDID: 'did:key:bob',
      topicID: 'topic:in',
      payload: encodeEnvelope({
        v: 1,
        groupID: 'group-1',
        ciphertext: toB64(
          encodeFrame({
            v: 1,
            sessionID: 'session-1',
            seq,
            kind: 'message',
            body: { header: {}, payload: { typ: 'event', msg } },
          } as never),
        ),
      }),
    })
    return sequenceID
  }
  return { transport, deliver, acked, events, published }
}

test('an expired frame sequenced before the session is acked and dropped as expired, and the session goes on', async () => {
  const h = harness()
  await flush()
  // A backlog frame from before this session sent or received anything.
  const expired = h.deliver('old', 0)
  h.deliver('m-0', 1)

  const result = await h.transport.read()
  expect(result.done).toBe(false)
  expect(result.value?.payload).toEqual({ typ: 'event', msg: 'm-0' })
  await flush()

  expect(h.events.filter((event) => event.type === 'decrypt-failed')).toEqual([])
  expect(
    h.events.flatMap((event) => (event.type === 'frame-dropped' ? [event.reason] : [])),
  ).toEqual(['expired'])
  expect(h.events.filter((event) => event.type === 'frame-expired')).toHaveLength(1)
  expect(h.acked).toContain(expired)

  await h.transport.dispose()
})

test('an expired frame after the session published fails it at once and ends it for the peer', async () => {
  const h = harness()
  await flush()
  await h.transport.write({ header: {}, payload: { typ: 'request', msg: 'q' } })
  const expired = h.deliver('old', 0)

  const failure = await h.transport.read().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).cause).toBeInstanceOf(ExpiredFrameError)
  await flush()
  expect(h.acked).toContain(expired)
  expect(h.published.map((frame) => frame.kind)).toEqual(['message', 'session-end'])
})
