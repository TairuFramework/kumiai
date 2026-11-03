import type { StoredMessage } from '@kumiai/hub-protocol'
import { toB64 } from '@sozai/codec'
import { expect, test } from 'vitest'

import { createEncryptedHubTunnelTransport } from '../src/encrypted-transport.js'
import { encodeEnvelope } from '../src/envelope.js'
import { ExpiredFrameError } from '../src/errors.js'
import type { ObservabilityEvent } from '../src/events.js'
import { encodeFrame } from '../src/frame.js'
import type { HubReceiveSubscription, MailboxHub } from '../src/transport.js'

type Msg = { header: Record<string, unknown>; payload: { typ: string; msg: string } }

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('a frame whose key the encryptor no longer holds is acked and dropped as expired, not as a decrypt failure', async () => {
  const acked: Array<string> = []
  const events: Array<ObservabilityEvent> = []
  let push: ((message: StoredMessage) => void) | undefined
  const inner: MailboxHub = {
    publish: async () => ({ sequenceID: '1' }),
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
      // Like a ratchet that moved past the first frame's generation and dropped its key.
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
  await flush()

  const frame = (msg: string, seq: number) =>
    encodeEnvelope({
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
    })
  push?.({
    sequenceID: 'seq-1',
    senderDID: 'did:key:bob',
    topicID: 'topic:in',
    payload: frame('m-0', 0),
  })
  push?.({
    sequenceID: 'seq-2',
    senderDID: 'did:key:bob',
    topicID: 'topic:in',
    payload: frame('old', 1),
  })
  push?.({
    sequenceID: 'seq-3',
    senderDID: 'did:key:bob',
    topicID: 'topic:in',
    payload: frame('m-1', 2),
  })

  const read: Array<unknown> = []
  for (let i = 0; i < 2; i++) {
    const result = await transport.read()
    if (result.done) break
    read.push(result.value.payload)
  }
  await flush()

  expect(read).toEqual([
    { typ: 'event', msg: 'm-0' },
    { typ: 'event', msg: 'm-1' },
  ])
  expect(events.filter((event) => event.type === 'decrypt-failed')).toEqual([])
  expect(events.flatMap((event) => (event.type === 'frame-dropped' ? [event.reason] : []))).toEqual(
    ['expired'],
  )
  expect(events.filter((event) => event.type === 'frame-expired')).toHaveLength(1)
  expect(acked).toContain('seq-2')

  await transport.dispose()
})
