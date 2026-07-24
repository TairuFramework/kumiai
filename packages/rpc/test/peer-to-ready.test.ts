import type { ProtocolDefinition } from '@enkaku/protocol'
import { describe, expect, test } from 'vitest'

import { createGroupPeer } from '../src/peer.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'

const chat = {
  'chat/echo': { type: 'request', param: { type: 'object' }, result: { type: 'object' } },
} as const satisfies ProtocolDefinition

type Protocols = { chat: typeof chat }

describe('to() is gated on readiness', () => {
  test('to() called before init resolves instead of throwing Unknown protocol', async () => {
    const hub = new FakeHub()
    const peer = createGroupPeer<Protocols>({
      hub,
      crypto: createFakeCrypto({ epoch: 1, localDID: 'alice' }),
      localDID: 'alice',
      protocols: { chat },
      handlers: { chat: {} } as never,
    })

    // No flush: this is the timing bug. `to()` is reached while `runtimes` is still empty and
    // `inboxLane` is still null, so the unwrapped version throws `Unknown protocol: chat` for a
    // name that is perfectly valid — a misleading error for a caller that is merely early.
    const client = await peer.protocol('chat').to('bob')
    expect(client).toBeDefined()

    await peer.dispose()
  })
})
