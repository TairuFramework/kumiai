import type { ProtocolDefinition } from '@enkaku/protocol'
import { describe, expect, test } from 'vitest'

import { createGroupPeer } from '../src/peer.js'
import { createFakeCrypto, type FakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

const chat = {
  'chat/changed': { type: 'event', data: { type: 'object' } },
  'chat/double': { type: 'request', param: { type: 'object' }, result: { type: 'object' } },
} as const satisfies ProtocolDefinition

type Protocols = { chat: typeof chat }

/** Record every `unwrap` by the bytes it was given, so a second open of one frame is visible. */
function countingCrypto(base: FakeCrypto): { crypto: FakeCrypto; opens: Array<string> } {
  const opens: Array<string> = []
  const crypto: FakeCrypto = {
    ...base,
    unwrap: (bytes) => {
      opens.push(Buffer.from(bytes).toString('base64'))
      return base.unwrap(bytes)
    },
  }
  return { crypto, opens }
}

function makePeer(hub: FakeHub, localDID: string, handlers: Record<string, unknown>) {
  const { crypto, opens } = countingCrypto(createFakeCrypto({ epoch: 1, localDID }))
  const peer = createGroupPeer<Protocols>({
    hub,
    crypto,
    localDID,
    protocols: { chat },
    handlers: { chat: handlers } as never,
  })
  return { peer, opens }
}

/**
 * NO LANE OPENS A FRAME TWICE — and the inbox lane is the one with the most consumers.
 *
 * A member's inbox topic is read by its acceptor (one per protocol) AND by every directed client
 * it has open, because a reply comes back on the caller's own inbox whoever it is talking to.
 * Each of those holding an `unwrap` of its own means they race for one per-message key: the
 * winner opens the frame, the loser sees a frame it cannot open and drops it silently.
 *
 * Against a fake whose `unwrap` was a pure function, both opens succeeded and every test passed.
 * Against real MLS a directed request was never answered — the acceptor and the client each
 * opened, and whichever lost had nothing to work with. This is the same defect the app lane had
 * (`peer-app-single-open.test.ts`), found in a lane a review had declared correct, which is why
 * the count is asserted per lane rather than inferred from a request completing.
 *
 * Counted rather than inferred, for that reason: a request that succeeds proves one consumer
 * opened the frame, never that only one did.
 */
describe('the inbox lane opens each frame once', () => {
  test('a directed round trip costs each side exactly one unwrap per frame', async () => {
    const hub = new FakeHub()
    const alice = makePeer(hub, 'alice', {})
    const bob = makePeer(hub, 'bob', {
      'chat/double': (ctx: { param: { n: number } }) => ({ n: ctx.param.n * 2 }),
    })
    await flush()

    const client = await alice.peer.protocol('chat').to('bob')
    const result = await client.request('chat/double', {
      param: { n: 21 },
    })
    expect(result).toEqual({ n: 42 })

    // Both sides opened frames — this is the control, so an empty count cannot pass — and neither
    // opened any single frame more than once.
    expect(alice.opens.length).toBeGreaterThan(0)
    expect(bob.opens.length).toBeGreaterThan(0)
    expect(new Set(alice.opens).size).toBe(alice.opens.length)
    expect(new Set(bob.opens).size).toBe(bob.opens.length)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('a second directed client on the same inbox does not double-open the first one’s replies', async () => {
    const hub = new FakeHub()
    const alice = makePeer(hub, 'alice', {})
    const bob = makePeer(hub, 'bob', {
      'chat/double': (ctx: { param: { n: number } }) => ({ n: ctx.param.n * 2 }),
    })
    const carol = makePeer(hub, 'carol', {
      'chat/double': (ctx: { param: { n: number } }) => ({ n: ctx.param.n * 3 }),
    })
    await flush()

    // Two directed clients, both receiving on alice's ONE inbox topic. Each reply must be opened
    // once and reach the client it belongs to — the other client sees an authenticated sender
    // that is not its peer and leaves the frame alone rather than consuming it.
    const bobClient = await alice.peer.protocol('chat').to('bob')
    const carolClient = await alice.peer.protocol('chat').to('carol')
    const [fromBob, fromCarol] = await Promise.all([
      bobClient.request('chat/double', { param: { n: 21 } }),
      carolClient.request('chat/double', { param: { n: 21 } }),
    ])
    expect(fromBob).toEqual({ n: 42 })
    expect(fromCarol).toEqual({ n: 63 })
    expect(new Set(alice.opens).size).toBe(alice.opens.length)

    await alice.peer.dispose()
    await bob.peer.dispose()
    await carol.peer.dispose()
  })
})
