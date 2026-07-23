import type { StoredMessage } from '@kumiai/hub-protocol'
import { toB64 } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { createEncryptedHubTunnelTransport } from '../src/encrypted-transport.js'
import { encodeEnvelope } from '../src/envelope.js'
import type { HubReceiveSubscription, MailboxHub } from '../src/transport.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

describe('the encrypting wrapper passes the receive scope inward', () => {
  test('scope survives the wrapper', async () => {
    const scopes: Array<string | undefined> = []
    const inner: MailboxHub = {
      publish: async () => ({ sequenceID: '1' }),
      subscribe: () => {},
      unsubscribe: () => {},
      receive: (_subscriberDID, options): HubReceiveSubscription => {
        scopes.push(options?.topicID)
        return {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<StoredMessage>>(() => {
                // never resolves: this test is about the members, not the stream
              }),
          }),
          return: () => {},
          // Whether the wrapper actually forwards a call through `ack` — rather than merely
          // preserving its presence — is proven end to end in transport-ack.test.ts (the happy
          // path) and below (the wrapper's own drop paths). This stream never resolves, so `ack`
          // could never be invoked here regardless.
          ack: () => {},
        }
      },
    }

    const transport = createEncryptedHubTunnelTransport({
      hub: inner,
      encryptor: {
        encrypt: async (bytes: Uint8Array) => bytes,
        decrypt: async (bytes: Uint8Array) => bytes,
      },
      groupID: 'group-1',
      sessionID: 'session-1',
      localDID: 'did:key:alice',
      sendTopicID: 'topic:out',
      receiveTopicID: 'topic:in',
    })

    // The wrapper re-writes the payload and nothing else. Dropping the scope option here would
    // silently widen every reader behind an encrypting hub to every topic.
    expect(scopes).toEqual(['topic:in'])

    await transport.dispose()
  })
})

describe('the encrypting wrapper acks its own drop paths', () => {
  test('a foreign-group envelope and undecodable envelope bytes are both acked to the inner hub', async () => {
    const acked: Array<string> = []
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

    const transport = createEncryptedHubTunnelTransport({
      hub: inner,
      encryptor: {
        encrypt: async (bytes: Uint8Array) => bytes,
        decrypt: async (bytes: Uint8Array) => bytes,
      },
      groupID: 'group-1',
      sessionID: 'session-1',
      localDID: 'did:key:alice',
      sendTopicID: 'topic:out',
      receiveTopicID: 'topic:in',
    })
    await flush()

    // Consumed off the inner subscription by the wrapper's own decode step, both of these never
    // reach the read pump's ack site — the only way either is acked at all is the wrapper doing
    // it itself.
    push?.({
      sequenceID: 'seq-foreign-group',
      senderDID: 'did:key:bob',
      topicID: 'topic:in',
      payload: encodeEnvelope({
        v: 1,
        groupID: 'other-group',
        ciphertext: toB64(new Uint8Array()),
      }),
    })
    await flush()

    push?.({
      sequenceID: 'seq-undecodable',
      senderDID: 'did:key:bob',
      topicID: 'topic:in',
      payload: new Uint8Array([0xff, 0xff, 0xff]),
    })
    await flush()

    expect(acked).toEqual(['seq-foreign-group', 'seq-undecodable'])

    await transport.dispose()
  })
})
