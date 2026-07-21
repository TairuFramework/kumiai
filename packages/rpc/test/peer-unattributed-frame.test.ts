import type { ProtocolDefinition } from '@enkaku/protocol'
import { describe, expect, test } from 'vitest'

import type { GroupCrypto } from '../src/crypto.js'
import { createGroupPeer } from '../src/peer.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

const chat = {
  'chat/changed': { type: 'event', data: { type: 'object' } },
  'chat/echo': { type: 'request', param: { type: 'object' }, result: { type: 'object' } },
} as const satisfies ProtocolDefinition

type Protocols = { chat: typeof chat }

function makePeer(
  hub: FakeHub,
  localDID: string,
  handlers: Record<string, unknown>,
  crypto: GroupCrypto = createFakeCrypto({ epoch: 1, localDID }),
) {
  return createGroupPeer<Protocols>({
    hub,
    crypto,
    localDID,
    protocols: { chat },
    handlers: { chat: handlers } as never,
  })
}

/**
 * A crypto that opens frames correctly and then DROPS the sender it recovered.
 *
 * Deliberately NOT conforming: `GroupUnwrapResult.senderDID` is required, and this returns a
 * result without it — which is why it needs a cast to compile at all. It is a fault injector, not
 * a double anything is meant to be tested against, and it exists for one question no conforming
 * implementation can ask: when the app lane is handed a frame it cannot attribute, does it refuse
 * the frame or deliver it unattributed? The port's `senderDID` being required makes this
 * unreachable from a correct implementation; the lane's guard is what makes it unreachable from an
 * incorrect one, and only an incorrect one can show the guard works.
 */
function senderStrippingCrypto(localDID: string): GroupCrypto {
  const inner = createFakeCrypto({ epoch: 1, localDID })
  return {
    ...inner,
    unwrap: async (bytes: Uint8Array) => {
      const { payload } = await inner.unwrap(bytes)
      return { payload } as unknown as { payload: Uint8Array; senderDID: string }
    },
  }
}

describe('app lane refuses a frame it cannot attribute', () => {
  test('an event whose open recovered no sender is not delivered', async () => {
    const hub = new FakeHub()
    const seen: Array<unknown> = []
    // Alice opens Bob's frames but loses the sender on the way. Nothing else about her differs.
    const alice = makePeer(
      hub,
      'alice',
      { 'chat/changed': (ctx: { data: unknown }) => void seen.push(ctx.data) },
      senderStrippingCrypto('alice'),
    )
    const bob = makePeer(hub, 'bob', {})
    await flush()

    await bob.protocol('chat').dispatch('chat/changed', { text: 'hi' })
    await flush()

    // Dropped at the lane, not handed to the handler with nobody attached to it.
    expect(seen).toEqual([])

    await alice.dispose()
    await bob.dispose()
  })

  test('the same event IS delivered when the open keeps the sender', async () => {
    // The control: identical wiring but a conforming crypto, so the assertion above is pinning
    // the missing sender and not some unrelated breakage in this fixture.
    const hub = new FakeHub()
    const seen: Array<unknown> = []
    const alice = makePeer(hub, 'alice', {
      'chat/changed': (ctx: { data: unknown }) => void seen.push(ctx.data),
    })
    const bob = makePeer(hub, 'bob', {})
    await flush()

    await bob.protocol('chat').dispatch('chat/changed', { text: 'hi' })
    await flush()

    expect(seen).toEqual([{ text: 'hi' }])

    await alice.dispose()
    await bob.dispose()
  })
})
