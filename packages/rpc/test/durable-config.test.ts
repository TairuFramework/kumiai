import { describe, expect, test } from 'vitest'

import { createGroupPeer } from '../src/peer.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { chat } from './fixtures/peer.js'

describe('durable peer configuration', () => {
  test('pending records require an MLS commit lane', () => {
    const crypto = createFakeCrypto({
      localDID: 'bob',
      pending: {
        async persistOpened() {},
        async list() {
          return []
        },
        async complete() {},
      },
    })
    expect(() =>
      createGroupPeer({
        hub: new DurableFakeHub(),
        crypto,
        localDID: 'bob',
        protocols: { chat },
        handlers: { chat: { 'chat/changed': () => {}, 'chat/posted': () => {} } },
      }),
    ).toThrow(/pending.*mls/i)
  })
})
