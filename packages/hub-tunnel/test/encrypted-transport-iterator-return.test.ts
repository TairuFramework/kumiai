import type { StoredMessage } from '@kumiai/hub-protocol'
import { toB64 } from '@sozai/codec'
import { expect, test, vi } from 'vitest'

import { createEncryptedHubTunnelTransport } from '../src/encrypted-transport.js'
import { encodeEnvelope } from '../src/envelope.js'
import type { HubReceiveSubscription, MailboxHub } from '../src/transport.js'

const captured = vi.hoisted(() => ({ hub: undefined as MailboxHub | undefined }))
vi.mock('../src/transport.js', () => ({
  createHubTunnelTransport: (params: { hub: MailboxHub }) => {
    captured.hub = params.hub
    return { events: { on: () => {} } }
  },
}))

test('the wrapped iterator never yields a message after return starts', async () => {
  let releaseDecrypt = () => {}
  let decryptStarted = () => {}
  const started = new Promise<void>((resolve) => {
    decryptStarted = resolve
  })
  const released = new Promise<void>((resolve) => {
    releaseDecrypt = resolve
  })
  const acked: Array<string> = []
  const message: StoredMessage = {
    sequenceID: 'spent',
    senderDID: 'did:peer:remote',
    topicID: 'topic:in',
    payload: encodeEnvelope({ v: 1, groupID: 'group-1', ciphertext: toB64(new Uint8Array([1])) }),
  }
  const hub: MailboxHub = {
    publish: async () => ({ sequenceID: 'outbound' }),
    subscribe: () => {},
    receive: (): HubReceiveSubscription => {
      let read = false
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (!read) {
              read = true
              return { done: false, value: message }
            }
            return await new Promise<IteratorResult<StoredMessage>>(() => {})
          },
          return: async () => ({ done: true, value: undefined }),
        }),
        ack: (sequenceID) => void acked.push(sequenceID),
      }
    },
  }
  createEncryptedHubTunnelTransport({
    hub,
    encryptor: {
      encrypt: async (bytes) => bytes,
      decrypt: async (bytes) => {
        decryptStarted()
        await released
        return bytes
      },
    },
    groupID: 'group-1',
    sessionID: 'session-1',
    localDID: 'did:peer:local',
    sendTopicID: 'topic:out',
    receiveTopicID: 'topic:in',
  })
  const subscription = captured.hub?.receive('did:peer:local')
  if (subscription == null) throw new Error('wrapped subscription missing')
  const iterator = subscription[Symbol.asyncIterator]()
  const next = iterator.next()
  await started
  const returned = iterator.return?.()
  expect(await iterator.next()).toEqual({ done: true, value: undefined })
  releaseDecrypt()
  expect(await next).toEqual({ done: true, value: undefined })
  expect(await returned).toEqual({ done: true, value: undefined })
  expect(acked).toEqual(['spent'])
})
