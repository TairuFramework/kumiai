import { describe, expect, test } from 'vitest'

import { FakeHub } from './fixtures/fake-hub.js'
import { makeMLSPeer } from './fixtures/peer.js'

const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const members = ['alice', 'bob']

describe('dispose against an establishing directed session', () => {
  test('to() queued behind init does not hand back a client after dispose', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x81)
    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members })

    // Queued behind `ready` and never flushed. `withReady` awaits `ready` and `dispose()` awaits
    // a promise DERIVED from it, so the queued continuation always resumes first: it builds and
    // registers a directed client, and teardown — one microtask later — disposes it out from
    // under the caller. The caller is handed a live-looking handle whose transport is already
    // aborted, and only finds out by using it. Refuse the call instead.
    const pending = alice.peer.protocol('chat').to('bob')
    await alice.peer.dispose()

    await expect(pending).rejects.toThrow(/disposed/i)
  })

  test('a call made after dispose names the disposal, not a missing protocol', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x82)
    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members })
    await flush()
    await alice.peer.dispose()

    // The other ordering, where teardown has already emptied `runtimes`: without the disposed
    // check this reports `Unknown protocol: chat` — the protocol is fine, the peer is gone.
    await expect(alice.peer.protocol('chat').dispatch('chat/changed', {})).rejects.toThrow(
      /disposed/i,
    )
  })

  test('resync() after dispose refuses rather than rebuilding onto a disposed mux', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x83)
    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members })
    await flush()
    await alice.peer.dispose()

    // `resync()` is the one entry point that REBUILDS. Unguarded it runs `buildEpoch` against a
    // mux whose `dispose()` has already cleared `listeners` and `refcount`, re-registering into
    // maps whose drain has stopped and which no second teardown will reach — the peer keeps a
    // whole rebuilt epoch nothing will ever release.
    //
    // The REFUSAL is the observable, and it is the only one: recording every FakeHub method
    // across an unguarded post-dispose `resync()` showed ZERO hub calls. No fresh `hub.subscribe`
    // lands, because `mux.dispose()` deliberately leaves `subscriptions` standing ("Listeners go,
    // the drain stops, SUBSCRIPTIONS STAND") so `retain` finds every topic already `held` and
    // returns early. The leak is entirely internal to a mux this package does not let a test
    // reach. Asserting on hub traffic here would be a decoration that never bites.
    await expect(alice.peer.resync()).rejects.toThrow(/disposed/i)
  })
})
