import { AuthorizationDeniedError } from '@kumiai/hub-protocol'
import type { LogHub } from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import type { SubscribeFailure } from '../src/hub-mux.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { buildRemoveCommit, makeMLSPeer } from './fixtures/peer.js'

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

describe('dispose against a queued commit-tail rebuild', () => {
  test('a subscribe still in flight when dispose returns does not report to the disposed host', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x84)
    // A third member so a Remove is a real roster change: bob's applying it rotates the anchor
    // (`peer.ts`'s `advanceHandle` captures a fresh one only when the roster diff says so), and a
    // rotated anchor means `buildEpoch`'s topics are ones the hub has never been asked for — unlike
    // a same-roster ledger commit, where the rebuild re-asks for topics already held (Task 5's
    // finding) and the mux's `attemptSubscribe` never runs at all.
    const threeMembers = ['alice', 'bob', 'carol']

    const initialTopics = new Set<string>()
    // The hub's answer to bob's post-rotation subscribes is held back until the test releases it —
    // modelling a subscribe still in flight (real transports do not answer inside a microtask) at
    // the exact moment `dispose()` returns. `disposeReturned` splits "answered during teardown" from
    // "answered after teardown finished", and only the second is the guards' job to swallow.
    let disposeReturned = false
    // Subscribes seen before the roster change are the peers' own life-of-membership topics
    // (commit, rendezvous, initial chat, initial self-inbox) — real, and let straight through. Only
    // a topic neither peer has ever asked for before is one the rotation minted, and those are the
    // ones this test holds open.
    let capturingInitial = true
    const pendingRejects: Array<() => void> = []
    const failures: Array<SubscribeFailure> = []

    const hub: LogHub = {
      publish: (params) => fake.publish(params),
      subscribe: (subscriberDID, topicID, options) => {
        if (capturingInitial) {
          initialTopics.add(topicID)
          return fake.subscribe(subscriberDID, topicID, options)
        }
        if (subscriberDID === 'bob' && !initialTopics.has(topicID)) {
          return new Promise<void>((_resolve, reject) => {
            pendingRejects.push(() =>
              reject(new AuthorizationDeniedError(`refused after dispose: ${topicID}`)),
            )
          })
        }
        return fake.subscribe(subscriberDID, topicID, options)
      },
      unsubscribe: (subscriberDID, topicID) => fake.unsubscribe(subscriberDID, topicID),
      receive: (subscriberDID) => fake.receive(subscriberDID),
      fetchTopic: (params) => fake.fetchTopic(params),
    }

    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members: threeMembers })
    const bob = makeMLSPeer(hub, 'bob', rs, {
      epoch: 1,
      members: threeMembers,
      // A disposed peer's caller cannot see this any other way: `resync()` and every protocol
      // entry point refuse outright once `disposed` is set (`assertLive`, `peer.ts:729`), but the
      // inbound-commit rebuild (`onCommitDelivery`, `peer.ts:1346-1363`) carries no such guard —
      // it is queued behind `runSerial` and `dispose()` never joins that queue. This callback is
      // the only remaining way anything downstream of that rebuild can be observed post-dispose.
      onSubscribeFailed: (failure) => {
        if (disposeReturned) failures.push(failure)
      },
    })
    await flush()
    capturingInitial = false

    // Alice evicts Carol: a real roster change. Bob applies it off the log — the inbound-Commit
    // path, not `commit()` — which queues exactly the rebuild this test is about.
    void alice.peer.commit(buildRemoveCommit(alice, 'carol'))
    await flush()

    // Bob's rebuild has, by now, asked the hub for his new chat and self-inbox topics — both
    // captured above rather than answered, so both are still open questions when dispose runs.
    expect(pendingRejects.length).toBeGreaterThan(0)

    await bob.peer.dispose()
    disposeReturned = true

    // The hub finally answers "no" to every subscribe it was still holding — after dispose returned.
    for (const reject of pendingRejects) reject()
    await flush(50)

    expect(failures).toEqual([])

    await alice.peer.dispose()
  })
})
