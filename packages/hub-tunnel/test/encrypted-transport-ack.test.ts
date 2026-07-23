import type { StoredMessage } from '@kumiai/hub-protocol'
import { describe, expect, test } from 'vitest'

import { createEncryptedHubTunnelTransport } from '../src/encrypted-transport.js'
import type { HubReceiveSubscription, MailboxHub } from '../src/transport.js'

describe('the encrypting wrapper forwards the ack', () => {
  test('ack and scope survive the wrapper', async () => {
    const acked: Array<string> = []
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
          ack: (sequenceID) => void acked.push(sequenceID),
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

    // The wrapper re-writes the payload and nothing else. Dropping `ack` here severs the durable
    // contract for every lane behind an encrypting hub, exactly as dropping `logPosition` would.
    expect(scopes).toEqual(['topic:in'])

    await transport.dispose()
  })
})
