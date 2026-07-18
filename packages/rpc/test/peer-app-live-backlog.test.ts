import { describe, expect, test } from 'vitest'

import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 50))

/**
 * The LIVE lane, on the one path that hands a member a frame it was sent while it could not be
 * pushed to: the mailbox backlog replayed when a dropped transport comes back.
 *
 * Not the drain, and it cannot be. The frame here is an EPHEMERAL one, so no log holds it and no
 * pull could ever ask for it; and the peer's process never died, so its segment pull is latched
 * from a startup where the log was empty and never runs again. The mailbox replay is the only
 * thing in a position to deliver this, which is why the test lives here and not in the drain
 * suite — a drain made into a no-op leaves this green.
 */
describe('the live lane replays a reconnecting member its mailbox backlog', () => {
  test('a peer whose transport dropped still reads the ephemeral messages sent at its epoch', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x37)
    const seen: Array<unknown> = []

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
      epoch: 1,
      handlers: { 'chat/changed': (ctx: { data: unknown }) => void seen.push(ctx.data) },
    })
    await flush()

    // Bob's connection drops. The process is still up and still holds its app lane, so the
    // topic keeps its listener; the hub simply has nowhere to push.
    hub.detach('bob')

    await alice.peer.protocol('chat').dispatch('chat/changed', { text: 'before lunch' })
    for (let i = 0; i < 10; i++) {
      await alice.peer.commit(buildLedgerCommit(alice, []))
    }
    await flush()
    expect(alice.mls.epoch()).toBe(11)
    expect(seen).toEqual([]) // nothing reached him: this is a backlog, not a live delivery

    // The replay hands him everything he was not pushed, and he opens the frame: the handle is
    // still at the epoch that sealed it, because the ten commits behind it are only applied as
    // the walk gets to them.
    hub.reattach('bob')
    hub.redeliver('bob')
    await flush()

    expect(bob.mls.epoch()).toBe(11)
    expect(seen).toEqual([{ text: 'before lunch' }])

    await alice.peer.dispose()
    await bob.peer.dispose()
  })
})
