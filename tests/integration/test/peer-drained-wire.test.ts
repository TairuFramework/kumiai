import { randomIdentity } from '@kokuin/token'
import { createGroupCrypto, createLedgerEntrySlot, simpleHandleAccess } from '@kumiai/mls-rpc'
import { APP_TOPIC_LABEL, createGroupPeer, protocolTopic } from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import { createFoundingGroup } from './app-lane-e2e.js'
import { createWireHub } from './log-hub-over-wire.js'

describe('peer drain over the wire hub', () => {
  test('drainedResolvesWithParkedWireReceive', async () => {
    const wire = createWireHub()
    const identity = randomIdentity()
    const connection = wire.connect(identity)
    const publisherIdentity = randomIdentity()
    const publisher = wire.connect(publisherIdentity)
    const group = await createFoundingGroup(identity, 'peer-drain-wire', createLedgerEntrySlot())
    const crypto = createGroupCrypto({
      access: simpleHandleAccess({ handle: () => group, adopt: () => {} }),
    })
    const { secret, epoch } = await crypto.exportSecret(APP_TOPIC_LABEL)
    const topicID = protocolTopic(secret, epoch, 'chat')
    let nextPending = false
    let returnPending = false
    let disposed = false
    let hostCallsAfterDispose = 0
    for (const key of [
      'epoch',
      'exportSecret',
      'wrap',
      'unwrap',
      'frameAAD',
      'frameEpoch',
      'sealEntries',
      'openEntries',
    ] as const) {
      const original = crypto[key]
      vi.spyOn(crypto, key).mockImplementation(((...args: Array<unknown>) => {
        if (disposed) hostCallsAfterDispose++
        return Reflect.apply(original, crypto, args)
      }) as never)
    }
    const chat = { 'chat/changed': { type: 'event', data: { type: 'object' } } } as const
    const peer = createGroupPeer({
      hub: {
        publish: (params) => connection.publish(params),
        subscribe: (did, topic, options) => connection.subscribe(did, topic, options),
        unsubscribe: (did, topic) => connection.unsubscribe?.(did, topic),
        fetchTopic: (params) => connection.fetchTopic(params),
        receive: (did) => {
          const inner = connection.receive(did)
          const iterator = inner[Symbol.asyncIterator]()
          return {
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                nextPending = true
                try {
                  return await iterator.next()
                } finally {
                  nextPending = false
                }
              },
              return: async () => {
                returnPending = true
                try {
                  return iterator.return == null
                    ? { done: true as const, value: undefined }
                    : await iterator.return()
                } finally {
                  returnPending = false
                }
              },
            }),
            ack: inner.ack?.bind(inner),
          }
        },
      },
      crypto,
      localDID: identity.id,
      protocols: { chat },
      handlers: {
        chat: {
          'chat/changed': () => {
            if (disposed) hostCallsAfterDispose++
          },
        },
      },
    })
    try {
      await vi.waitFor(() => expect(nextPending).toBe(true))
      await new Promise((resolve) => setTimeout(resolve, 100))
      disposed = true
      await peer.dispose()
      let drainSettledWithParkedTransport = false
      await peer.drained().then(() => {
        drainSettledWithParkedTransport = true
      })
      expect(drainSettledWithParkedTransport).toBe(true)
      expect(nextPending).toBe(true)
      expect(returnPending).toBe(true)
      await publisher.publish({
        senderDID: publisherIdentity.id,
        topicID,
        payload: new Uint8Array([1, 2, 3]),
      })
      await vi.waitFor(() => expect(nextPending).toBe(false))
      await vi.waitFor(() => expect(returnPending).toBe(false))
      expect(hostCallsAfterDispose).toBe(0)
    } finally {
      await peer.dispose()
      await wire.dispose()
    }
  })
})
