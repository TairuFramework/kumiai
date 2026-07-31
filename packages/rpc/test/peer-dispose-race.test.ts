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
})
