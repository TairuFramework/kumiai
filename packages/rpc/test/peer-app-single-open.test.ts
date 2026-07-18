import { describe, expect, test } from 'vitest'

import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, type FakeCrypto } from './fixtures/fake-crypto.js'
import { makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 50))

/**
 * A live app frame is OPENED EXACTLY ONCE.
 *
 * Opening is a CONSUMING operation on a real MLS handle — it spends the frame's own per-message
 * ratchet key — so the same bytes open once and every later open of them fails. A lane with two
 * consumers on one topic must therefore open the frame once and fan the plaintext out, never hand
 * each consumer an `unwrap` of its own.
 *
 * Counted rather than inferred from delivery, because the two consumers race: whichever opens
 * first wins and the frame still reaches a handler, so a scenario test passes either way. Against
 * a fake whose `unwrap` is a pure function it passes even when both of them open it. The count is
 * the only thing that sees the difference, and it is the property that has to hold.
 */
describe('the app lane opens each live frame once', () => {
  test('one published frame costs the receiver exactly one unwrap', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x51)
    const seen: Array<unknown> = []

    const base = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    const opens: Array<number> = []
    const counting: FakeCrypto = {
      ...base,
      unwrap: (bytes) => {
        opens.push(bytes.length)
        return base.unwrap(bytes)
      },
    }

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
      epoch: 1,
      crypto: counting,
      handlers: { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) },
    })
    await flush()

    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'once' })
    await flush()

    // Delivered, and the count is what the assertion is about.
    expect(seen).toEqual([{ text: 'once' }])
    expect(opens).toHaveLength(1)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })
})
