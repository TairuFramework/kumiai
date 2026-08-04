import { AuthorizationDeniedError } from '@kumiai/hub-protocol'
import type { LogHub } from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import type { SubscribeFailure } from '../src/hub-mux.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryCommitJournal, type MemoryCommitJournal } from './fixtures/journal.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { buildLedgerCommit, buildRemoveCommit, makeMLSPeer } from './fixtures/peer.js'
import { createRecordingHub } from './fixtures/recording-hub.js'

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

describe('dispose against an in-flight subscribe', () => {
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
      // A disposed peer's caller cannot see this any other way: `resync()` and every protocol entry
      // point refuse outright once `disposed` is set (`assertLive`, `peer.ts:734`), and the
      // inbound-commit rebuild is now refused too (`onCommitDelivery`). What this test watches is
      // NOT a post-dispose rebuild — bob's rebuild runs below, while he is still live — but the
      // subscribes it left in flight, answered only after `dispose()` returned.
      onSubscribeFailed: (failure) => {
        if (disposeReturned) failures.push(failure)
      },
    })
    await flush()
    capturingInitial = false

    // Alice evicts Carol: a real roster change. Bob applies it off the log — the inbound-Commit
    // path, not `commit()` — which queues exactly the rebuild this test is about.
    // Owned, not floated: alice's commit is still in flight while both peers are disposed below,
    // and an unowned rejection surfaces as a cross-file unhandled rejection rather than a failure
    // here. Awaited at the end so a timing change fails loudly instead of escaping the test.
    const aliceCommit = alice.peer.commit(buildRemoveCommit(alice, 'carol')).catch(() => {})
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
    await aliceCommit
  })
})

describe('dispose against a commit made afterwards', () => {
  test('commit() after dispose writes nothing to the hub', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x85)

    // Flipped only once `dispose()` has RETURNED, so the list holds post-dispose traffic and
    // nothing else — every subscribe, publish and fetch of a live peer's init and teardown is
    // let through unrecorded.
    let recording = false
    const calls: Array<string> = []
    const record = (call: string): void => {
      if (recording) calls.push(call)
    }

    const hub: LogHub = {
      publish: (params) => {
        record(`publish:${params.topicID}`)
        return fake.publish(params)
      },
      subscribe: (subscriberDID, topicID, options) => {
        record(`subscribe:${topicID}`)
        return fake.subscribe(subscriberDID, topicID, options)
      },
      unsubscribe: (subscriberDID, topicID) => {
        record(`unsubscribe:${topicID}`)
        return fake.unsubscribe(subscriberDID, topicID)
      },
      receive: (subscriberDID) => {
        record('receive')
        return fake.receive(subscriberDID)
      },
      fetchTopic: (params) => {
        record(`fetchTopic:${params.topicID}`)
        return fake.fetchTopic(params)
      },
    }

    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members })
    await flush()
    await alice.peer.dispose()
    recording = true

    // `commit()` is the entry point with the loudest post-dispose observable, and the only one
    // whose damage escapes the process: `assertLive` gone, it runs the whole lane — `ensureLedger`
    // pulls the commit log and the rendezvous topic, then `mux.publish` (which carries NO disposed
    // check of its own, `hub-mux.ts:665`) writes the commit to the hub. A disposed peer publishing
    // a commit is a live group moved by a device its host has already torn down.
    const op = alice.peer.commit(buildLedgerCommit(alice, ['post-dispose']))
    // Owned immediately: the hub-traffic assertion runs BEFORE the rejection is awaited, because
    // an unguarded `commit()` does not reject promptly — it settles on the commit deadline, long
    // after the publish has landed. Asserting the rejection first would turn "it published" into a
    // bare timeout that names nothing.
    const owned = op.catch(() => {})
    await flush()

    expect(calls).toEqual([])
    await expect(op).rejects.toThrow(/disposed/i)
    await owned
  })
})

describe('dispose against a replay made afterwards', () => {
  test('replay() after dispose asks the group for nothing', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x86)
    const healMembers = ['alice', 'bob', 'carol']

    // Only the DISPOSED peer is wrapped; bob is handed the FakeHub directly. Both still talk to
    // one hub, because the recorder delegates to it.
    const recorder = createRecordingHub(fake)

    // The only responder withholds the last ledger entry, so every reply alice gathers fails the
    // head check and her bootstrap never completes. Her ledger stays incomplete for the rest of
    // her life, which is what keeps `ensureLedger` reaching for the hub on every lane operation —
    // including one made after she is gone.
    const bobCrypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    const bobMLS = createMemoryGroupMLS({
      recoverySecret: rs,
      epoch: 1,
      localDID: 'bob',
      members: healMembers,
      serveLedger: (ledger) => ledger.slice(0, ledger.length - 1),
      onAdvance: (e) => bobCrypto.setEpoch(e),
    })
    const bob = makeMLSPeer(fake, 'bob', rs, {
      mls: bobMLS,
      crypto: bobCrypto,
      members: healMembers,
      recovery: { timeoutMs: 100, getDelayMs: () => 5, deadlineMs: 400 },
    })
    await flush()
    await bob.peer.commit(buildLedgerCommit(bob, ['role:carol=admin', 'role:dave=admin']))
    await flush()

    const alice = makeMLSPeer(recorder.hub, 'alice', rs, {
      epoch: 1,
      members: healMembers,
      recovery: { timeoutMs: 100, getDelayMs: () => 5, deadlineMs: 400 },
    })
    await flush()
    await alice.peer.recover()
    expect(await alice.mls.isLedgerComplete()).toBe(false)

    await alice.peer.dispose()
    recorder.start()

    // Owned before the traffic assertion, exactly as the commit test does it: unguarded, `replay()`
    // does not reject promptly — it publishes its ledgerRequest and then waits the gather window
    // out on a timer `dispose()` never clears. Awaiting the rejection first would turn "it asked
    // the group for the ledger" into a bare timeout that names nothing.
    const op = alice.peer.replay()
    const owned = op.catch(() => {})
    await flush(150)

    expect(recorder.calls()).toEqual([])
    await expect(op).rejects.toThrow(/disposed/i)
    await owned

    await bob.peer.dispose()
  })
})

describe('dispose against a recover made afterwards', () => {
  test('recover() after dispose asks the group for nothing', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x87)

    const recorder = createRecordingHub(fake)

    // A short rendezvous window, and the only member on the topic. Unguarded, `recover()` cannot be
    // answered and is not refused either: it pulls, publishes its request, waits the window out and
    // RESOLVES. The window is short so the mutation check does not sit on a timer.
    const alice = makeMLSPeer(recorder.hub, 'alice', rs, {
      epoch: 1,
      members,
      recovery: { timeoutMs: 50, getDelayMs: () => 5, deadlineMs: 200 },
    })
    await flush()
    await alice.peer.dispose()
    recorder.start()

    // Owned before the traffic assertion, for the same reason as the commit test: the damage lands
    // long before the promise settles.
    const op = alice.peer.recover()
    const owned = op.catch(() => {})
    await flush(120)

    expect(recorder.calls()).toEqual([])
    await expect(op).rejects.toThrow(/disposed/i)
    await owned
  })
})

describe('dispose against a commit delivery queued behind a lane operation', () => {
  test('a delivery that resumes after dispose does not pull the commit log', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x88)

    const recorder = createRecordingHub(fake)

    // The mutex holder, and the reason it is the JOURNAL that is gated rather than a hub call:
    // whatever holds the mutex keeps running after the gate opens, and anything it says to the hub
    // then would land in the recording. `replay()` over an empty journal and a complete ledger says
    // nothing at all — `replayJournal` returns at the empty slot and `ensureLedger` returns early.
    let openGate = (): void => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    let gateArmed = false
    const real = createMemoryCommitJournal()
    const journal: MemoryCommitJournal = {
      ...real,
      async get() {
        if (gateArmed) {
          gateArmed = false
          await gate
        }
        return await real.get()
      },
    }

    const alice = makeMLSPeer(fake, 'alice', rs, { epoch: 1, members })
    const bob = makeMLSPeer(recorder.hub, 'bob', rs, { epoch: 1, members, journal })
    await flush()

    // Armed only now: bob's init seed replays the journal too, and gating THAT would stop him ever
    // becoming ready.
    gateArmed = true
    const holder = bob.peer.replay()
    await flush()

    // Alice's commit reaches bob's commit listener, which acks and hands its lane operation to
    // `runSerial` — where it queues, because `replay()` still holds the mutex inside the gate.
    await alice.peer.commit(buildLedgerCommit(alice, ['queued-behind-the-lane']))
    await flush()

    // Returns without waiting on the mutex: dispose awaits `settled`, and the queued delivery is
    // not on that path. That is the hole this test is about.
    await bob.peer.dispose()
    recorder.start()

    openGate()
    await holder
    await flush(80)

    // The queued callback has now run, against a peer disposed several awaits ago. Unguarded it
    // runs the whole lane operation, and `pullCommits` is the part that reaches the hub.
    // Unlike the other tests here, this assertion has no paired rejection to keep it honest: its
    // bite depends entirely on the delivery still queueing, and the mutation check is the only
    // proof it does.
    expect(recorder.calls()).toEqual([])

    await alice.peer.dispose()
  })
})
