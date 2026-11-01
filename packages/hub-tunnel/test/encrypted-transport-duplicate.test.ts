import type { StoredMessage } from '@kumiai/hub-protocol'
import { toB64 } from '@sozai/codec'
import { expect, test } from 'vitest'

import { createEncryptedHubTunnelTransport } from '../src/encrypted-transport.js'
import { encodeEnvelope } from '../src/envelope.js'
import { DuplicateFrameError } from '../src/errors.js'
import type { ObservabilityEvent } from '../src/events.js'
import { encodeFrame } from '../src/frame.js'
import type { HubReceiveSubscription, MailboxHub } from '../src/transport.js'

type Msg = { header: Record<string, unknown>; payload: { typ: string; msg: string } }

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('a frame the encryptor already opened is acked and dropped as dedup, not as a decrypt failure', async () => {
  const acked: Array<string> = []
  const events: Array<ObservabilityEvent> = []
  const opened = new Set<string>()
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
      // Like a ratchet: each ciphertext opens once, and a second delivery cannot open again.
      decrypt: async (bytes: Uint8Array) => {
        const key = toB64(bytes)
        if (opened.has(key)) throw new DuplicateFrameError('frame already opened')
        opened.add(key)
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
  const first = frame('m-0', 0)
  // The hub redelivers a frame whose ack was lost: same bytes, a new delivery.
  push?.({ sequenceID: 'seq-1', senderDID: 'did:key:bob', topicID: 'topic:in', payload: first })
  push?.({ sequenceID: 'seq-2', senderDID: 'did:key:bob', topicID: 'topic:in', payload: first })
  push?.({
    sequenceID: 'seq-3',
    senderDID: 'did:key:bob',
    topicID: 'topic:in',
    payload: frame('m-1', 1),
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
    ['dedup'],
  )
  expect(acked).toContain('seq-2')

  await transport.dispose()
})
