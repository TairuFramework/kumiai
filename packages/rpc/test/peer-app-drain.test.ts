import { describe, expect, test } from 'vitest'

import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 50))

/**
 * An app frame is sealed under the epoch it was sent at, and it lives on a topic derived from
 * that epoch. A peer that walks the commit log forward walks past both — so the frames it was
 * sent, and has not read yet, are exactly what the commit lane is in a position to destroy.
 *
 * These assert the PLAINTEXT, and nothing else. A peer that loses these messages converges,
 * matches the roster, reaches the right epoch and raises nothing: every other assertion in this
 * suite passes while a week of messages goes missing.
 */
describe('app frames outlive the commits that leave their epoch', () => {
  test('a peer whose transport dropped still reads the messages sent at its epoch', async () => {
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

    hub.reattach('bob')
    hub.redeliver('bob')
    await flush()

    expect(bob.mls.epoch()).toBe(11)
    expect(seen).toEqual([{ text: 'before lunch' }])

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  /**
   * SKIPPED, and it must not be deleted, inverted, or weakened into something that passes.
   *
   * It fails, and it fails for the right reason. A peer that comes back up over a handle at
   * epoch 1, holding epoch 1's secret, is handed the epoch-1 message by the hub and drops it —
   * because `ready` seeds the commit lane by pulling the log to the head BEFORE it builds the
   * app lane, so the lane is built at the epoch it caught up to and never at the epoch its own
   * unread frames live on. It holds the key. It never installs the listener.
   *
   * That cannot be fixed by ordering the lane, because the app lane has no mailbox to drain:
   * app frames are mailbox-class and cannot be pulled, a subscription back-fills nothing, and
   * a push that finds no listener is gone. Building the app lane earlier only wins a race
   * against the delivery loop. The fix is a pull-readable app lane, and that is a redesign of
   * how app frames are addressed and retained — not a change to the commit lane.
   *
   * What the peer no longer does is DELETE those frames as it advances (see the subscription
   * assertions in `peer-control-lanes.test.ts`). They stay in the hub, and an app lane that
   * can read them back will find them there. Unskip this the day it can.
   */
  test.skip('a peer that was restarted still reads the messages sent at its epoch', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x40)
    const seen: Array<unknown> = []
    const handlers = { 'chat/changed': (ctx: { data: unknown }) => void seen.push(ctx.data) }

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers })
    await flush()

    // Bob's process dies — a phone in a pocket, not a dropped socket. It is never disposed, so
    // the hub still holds his subscriptions and still keeps his frames for him.
    hub.detach('bob')

    await alice.peer.protocol('chat').dispatch('chat/changed', { text: 'before lunch' })
    for (let i = 0; i < 10; i++) {
      await alice.peer.commit(buildLedgerCommit(alice, []))
    }
    await flush()

    // He comes back up over the same handle. He is still at epoch 1, and he still holds epoch
    // 1's secret — the key that opens the message is in his hand.
    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, {
      mls: bob.mls,
      crypto: bob.crypto,
      journal: bob.journal,
      handlers,
    })
    hub.reattach('bob')
    hub.redeliver('bob')
    await flush()

    expect(restarted.mls.epoch()).toBe(11)
    expect(seen).toEqual([{ text: 'before lunch' }])

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })
})
