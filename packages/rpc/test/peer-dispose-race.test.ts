import { BroadcastClient } from '@kumiai/broadcast'
import { AuthorizationDeniedError, type StoredMessage } from '@kumiai/hub-protocol'
import type { HubReceiveSubscription, LogHub } from '@kumiai/hub-tunnel'
import { describe, expect, test, vi } from 'vitest'

import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import type { SubscribeFailure } from '../src/hub-mux.js'
import { PeerDisposedError } from '../src/index.js'
import { createFakeCrypto, type FakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryCommitJournal, type MemoryCommitJournal } from './fixtures/journal.js'
import { createMemoryGroupMLS, type MemoryGroupMLS } from './fixtures/memory-group-mls.js'
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

    await expect(pending).rejects.toBeInstanceOf(PeerDisposedError)
  })

  test('a call made after dispose names the disposal, not a missing protocol', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x82)
    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members })
    await flush()
    await alice.peer.dispose()

    // The other ordering, where teardown has already emptied `runtimes`: without the disposed
    // check this reports `Unknown protocol: chat` — the protocol is fine, the peer is gone.
    await expect(
      alice.peer.protocol('chat').dispatch('chat/changed', { data: {} }),
    ).rejects.toBeInstanceOf(PeerDisposedError)
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
    await expect(alice.peer.resync()).rejects.toBeInstanceOf(PeerDisposedError)
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
    await expect(op).rejects.toBeInstanceOf(PeerDisposedError)
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
    await expect(op).rejects.toBeInstanceOf(PeerDisposedError)
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
    await expect(op).rejects.toBeInstanceOf(PeerDisposedError)
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

describe('dispose against a ledger reply whose timer already fired', () => {
  test('the sealed ledger is not published after dispose', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x89)

    const recorder = createRecordingHub(fake)

    // The gate goes on the SEAL, not the publish: it parks bob's reply IIFE exactly where the
    // window is — timer fired, so it has already deleted itself from `pendingLedgerReplies` and
    // dispose()'s clear sweep cannot reach it, but the publish has not happened yet.
    let sealEntered = false
    let sealResumed = false
    let openGate = (): void => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })

    const bobCrypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    const bobInner = createMemoryGroupMLS({
      recoverySecret: rs,
      epoch: 1,
      localDID: 'bob',
      members,
      onAdvance: (e) => bobCrypto.setEpoch(e),
    })
    const bobMLS: MemoryGroupMLS = {
      ...bobInner,
      async sealLedger(request: Uint8Array) {
        sealEntered = true
        await gate
        sealResumed = true
        return await bobInner.sealLedger(request)
      },
    }

    const bob = makeMLSPeer(recorder.hub, 'bob', rs, {
      mls: bobMLS,
      crypto: bobCrypto,
      members,
      // Delay 0 so the reply timer fires within the test rather than under jitter.
      recovery: { timeoutMs: 120, getDelayMs: () => 0, deadlineMs: 600 },
    })
    await flush()
    // `handleLedgerRequest` checks `isLedgerComplete()` BEFORE sealing, so without an entry bob
    // returns early and never reaches the gate.
    await bob.peer.commit(buildLedgerCommit(bob, ['circle:x=Bob']))
    await flush()

    // Alice takes the bare hub: only the peer under test is recorded. Built plainly, exactly as
    // `peer-dispose-heal.test.ts:79-85` builds its rejoining peer — she needs no pre-adopted
    // commit, because it is her bootstrap and not a divergence that sends the requests.
    const alice = makeMLSPeer(fake, 'alice', rs, {
      epoch: 1,
      members,
      recovery: { timeoutMs: 120, getDelayMs: () => 0, deadlineMs: 600 },
    })
    await flush()

    // Her rejoin publishes a recoveryRequest (bob answers it — sealGroupInfo is NOT gated), then
    // gathers the ledger, which is the request bob parks on. It resolves once that gather times
    // out, so by the time it returns bob's timer has long since fired.
    await alice.peer.recover()

    // The proof the window is open. Without it, a delivery that stopped arriving would leave the
    // recording empty and this test would pass for nothing.
    expect(sealEntered).toBe(true)

    await bob.peer.dispose()
    recorder.start()

    openGate()
    await flush(80)

    // The parked IIFE resumed and reached the guard. Without this, a continuation that never ran
    // would leave the recording empty and the assertion below would pass for nothing.
    expect(sealResumed).toBe(true)

    // Unguarded, the parked IIFE resumes and publishes the sealed ledger to the rendezvous topic
    // from a peer its host tore down several awaits ago.
    expect(recorder.calls()).toEqual([])

    await alice.peer.dispose()
  })
})

describe('dispose against a recovery reply whose timer already fired', () => {
  test('the sealed group info is not published after dispose', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x8a)

    const recorder = createRecordingHub(fake)

    // Same gate placement as the ledger reply, on this responder's own seal.
    let sealEntered = false
    let sealResumed = false
    let openGate = (): void => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })

    const bobCrypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    const bobInner = createMemoryGroupMLS({
      recoverySecret: rs,
      epoch: 1,
      localDID: 'bob',
      members,
      onAdvance: (e) => bobCrypto.setEpoch(e),
    })
    const bobMLS: MemoryGroupMLS = {
      ...bobInner,
      async sealGroupInfo(request: Uint8Array) {
        sealEntered = true
        await gate
        sealResumed = true
        return await bobInner.sealGroupInfo(request)
      },
    }

    const bob = makeMLSPeer(recorder.hub, 'bob', rs, {
      mls: bobMLS,
      crypto: bobCrypto,
      members,
      recovery: { timeoutMs: 120, getDelayMs: () => 0, deadlineMs: 600 },
    })
    await flush()

    // Bare hub, built plainly — same as the ledger test.
    const alice = makeMLSPeer(fake, 'alice', rs, {
      epoch: 1,
      members,
      recovery: { timeoutMs: 120, getDelayMs: () => 0, deadlineMs: 600 },
    })
    await flush()

    // NOT awaited, unlike the ledger test: bob's groupInfo seal is the thing being held, so no
    // reply can reach her and this settles only on her own recovery timeout. The `.catch` owns
    // whichever way it settles — an unowned rejection fails the run somewhere else entirely.
    const rejoin = alice.peer.recover().catch(() => {})
    await flush(80)

    expect(sealEntered).toBe(true)

    await bob.peer.dispose()
    recorder.start()

    openGate()
    await flush(80)

    // The parked IIFE resumed and reached the guard. Without this, a continuation that never ran
    // would leave the recording empty and the assertion below would pass for nothing.
    expect(sealResumed).toBe(true)

    // Unguarded, the parked IIFE publishes a sealed GroupInfo to the rendezvous topic.
    expect(recorder.calls()).toEqual([])

    await rejoin
    await alice.peer.dispose()
  })
})

describe('dispose against a requester ledger reply already in its IIFE', () => {
  test('bootstrapLedger is not called after dispose', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x8b)

    // The gate goes on ALICE's own `openSealedLedger` — the requester side of `ensureLedger`'s
    // waiter, which runs OUTSIDE the commit mutex and writes into the host handle via
    // `bootstrapLedger`. Distinct from the two tests above, which gate a RESPONDER's seal and
    // assert nothing is published: this is a host WRITE with no publish, so only a spy on the
    // requester's own port can see it.
    let openEntered = false
    let openResumed = false
    let bootstrapCalls = 0
    let openGate = (): void => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })

    const aliceCrypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const aliceInner = createMemoryGroupMLS({
      recoverySecret: rs,
      epoch: 1,
      localDID: 'alice',
      members,
      onAdvance: (e) => aliceCrypto.setEpoch(e),
    })
    const aliceMLS: MemoryGroupMLS = {
      ...aliceInner,
      async openSealedLedger(sealed: Uint8Array, requestID: string) {
        openEntered = true
        await gate
        openResumed = true
        return await aliceInner.openSealedLedger(sealed, requestID)
      },
      async bootstrapLedger(tokens: Array<string>) {
        bootstrapCalls++
        return await aliceInner.bootstrapLedger(tokens)
      },
    }

    // Bob serves a COMPLETE ledger so alice's `requestLedger` waiter reaches `openSealedLedger`.
    const bob = makeMLSPeer(fake, 'bob', rs, {
      epoch: 1,
      members,
      recovery: { timeoutMs: 120, getDelayMs: () => 0, deadlineMs: 600 },
    })
    await flush()
    await bob.peer.commit(buildLedgerCommit(bob, ['circle:x=Bob']))
    await flush()

    const alice = makeMLSPeer(fake, 'alice', rs, {
      mls: aliceMLS,
      crypto: aliceCrypto,
      members,
      recovery: { timeoutMs: 120, getDelayMs: () => 0, deadlineMs: 600 },
    })
    await flush()

    // Not awaited: alice's own gather is the thing being held, so `recover()` settles only once
    // its local ledger-gather timeout fires. The `.catch` owns whichever way it settles — an
    // unowned rejection fails the run somewhere else entirely.
    const rejoin = alice.peer.recover().catch(() => {})

    // The proof the window is open. Poll rather than wait a fixed delay: on a slow CI host the
    // gather's round-trip to Bob and back can exceed any fixed budget, leaving `openEntered` false
    // for timing reasons alone. Without reaching here, a gather that never entered
    // `openSealedLedger` would leave `bootstrapCalls` at 0 for nothing.
    await vi.waitFor(() => expect(openEntered).toBe(true), { timeout: 2000, interval: 10 })

    await alice.peer.dispose()
    openGate()
    // Await the recovery flow's own settlement rather than a fixed delay — deterministic, and it
    // guarantees the parked IIFE resumed AND reached its post-open bootstrap decision before the
    // assertions below.
    await rejoin

    // The parked IIFE resumed and reached the guard. Without this, a continuation that never ran
    // would leave `bootstrapCalls` at 0 for nothing.
    expect(openResumed).toBe(true)

    // Unguarded, the parked IIFE resumes and writes the opened tokens into the host-owned MLS
    // handle via `bootstrapLedger`, several awaits after this peer's host tore it down.
    expect(bootstrapCalls).toBe(0)

    await rejoin
    await bob.peer.dispose()
  })
})

// Wraps a hub's `receive` so the FIRST ledgerReply frame is intercepted and HELD instead of
// delivered, then re-emitted on demand by `deliverHeld()`. The re-emit resolves the drain's parked
// `next()` DIRECTLY (one microtask), which is what lets the test land the delivery inside dispose's
// own window — after `disposed = true`, before `ledgerWaiters.clear()`.
type HeldReceive = {
  hub: LogHub
  /** Resolves once a ledgerReply has been intercepted and is being held. */
  whenHeld: Promise<void>
  /** Synchronously push the held ledgerReply into the drain's parked `next()`. */
  deliverHeld: () => void
}

const hubHoldingLedgerReply = (fake: FakeHub, holderDID: string): HeldReceive => {
  let resolveHeld: () => void = () => {}
  const whenHeld = new Promise<void>((r) => {
    resolveHeld = r
  })
  let deliverHeld: () => void = () => {}

  const wrap = (inner: HubReceiveSubscription): HubReceiveSubscription => {
    const innerIter = inner[Symbol.asyncIterator]()
    const queue: Array<StoredMessage> = []
    let resolveNext: ((r: IteratorResult<StoredMessage>) => void) | undefined
    let closed = false
    let held: StoredMessage | undefined

    const emit = (message: StoredMessage): void => {
      if (resolveNext != null) {
        const resolve = resolveNext
        resolveNext = undefined
        resolve({ value: message, done: false })
      } else {
        queue.push(message)
      }
    }
    const end = (): void => {
      closed = true
      if (resolveNext != null) {
        const resolve = resolveNext
        resolveNext = undefined
        resolve({ value: undefined as unknown as StoredMessage, done: true })
      }
    }
    const isLedgerReply = (message: StoredMessage): boolean => {
      try {
        return decodeHandshakeFrame(message.payload).kind === HANDSHAKE_KIND.ledgerReply
      } catch {
        return false
      }
    }

    void (async () => {
      while (true) {
        let result: IteratorResult<StoredMessage>
        try {
          result = await innerIter.next()
        } catch {
          end()
          return
        }
        if (result.done) {
          end()
          return
        }
        // Hold the FIRST ledgerReply and nothing else: the recoveryReply that precedes it must pass
        // through, or alice's `recover()` never reaches `ensureLedger` to register the waiter.
        if (held == null && isLedgerReply(result.value)) {
          held = result.value
          resolveHeld()
          continue
        }
        emit(result.value)
      }
    })()

    deliverHeld = (): void => {
      if (held == null) return
      const message = held
      held = undefined
      emit(message)
    }

    const iterator: AsyncIterator<StoredMessage> = {
      next: () => {
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift() as StoredMessage, done: false })
        }
        if (closed)
          return Promise.resolve({ value: undefined as unknown as StoredMessage, done: true })
        return new Promise((resolve) => {
          resolveNext = resolve
        })
      },
      return: () => {
        inner.return?.()
        return Promise.resolve({ value: undefined as unknown as StoredMessage, done: true })
      },
    }
    return {
      [Symbol.asyncIterator]: () => iterator,
      return: () => inner.return?.(),
      ack: inner.ack?.bind(inner),
    }
  }

  const hub: LogHub = {
    publish: (params) => fake.publish(params),
    subscribe: (subscriberDID, topicID, options) => fake.subscribe(subscriberDID, topicID, options),
    unsubscribe: (subscriberDID, topicID) => fake.unsubscribe(subscriberDID, topicID),
    receive: (subscriberDID) => {
      const inner = fake.receive(subscriberDID)
      return subscriberDID === holderDID ? wrap(inner) : inner
    },
    fetchTopic: (params) => fake.fetchTopic(params),
  }

  return { hub, whenHeld, deliverHeld: () => deliverHeld() }
}

// residual #6, EARLY guard: the ledger-waiter IIFE's early-out `if (settled || disposed) return`
// runs BEFORE `openSealedLedger`. The existing test above parks INSIDE `openSealedLedger`, so it
// only exercises the SECOND guard; removing the `disposed` term from the early-out leaves that test
// green. This one fires the waiter in the one window where the early `disposed` term is the only
// thing standing between the reply and a wasted decrypt: after `dispose()` set `disposed = true`
// but before it reached `ledgerWaiters.clear()`. The reply is held at alice's receive and delivered
// synchronously one statement before `dispose()`, so its drain microtask runs before dispose's
// post-`await settled` continuation (the unsubscribe + clear). The waiter then fires with
// `disposed === true` and the gather's own `settled === false`, and the early guard must return
// without entering `openSealedLedger`.
describe('dispose against a ledger reply delivered inside the dispose window', () => {
  test('the early guard drops the reply before openSealedLedger', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x8f)
    const held = hubHoldingLedgerReply(fake, 'alice')

    let openEntered = false

    const aliceCrypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const aliceInner = createMemoryGroupMLS({
      recoverySecret: rs,
      epoch: 1,
      localDID: 'alice',
      members,
      onAdvance: (e) => aliceCrypto.setEpoch(e),
    })
    const aliceMLS: MemoryGroupMLS = {
      ...aliceInner,
      async openSealedLedger(sealed: Uint8Array, requestID: string) {
        // Flipped BEFORE the first await: if the early guard returns, this is never reached and the
        // flag stays false. Removing the early `disposed` term flips it true — the mutation bite.
        openEntered = true
        return await aliceInner.openSealedLedger(sealed, requestID)
      },
    }

    // Bob serves a COMPLETE ledger so alice's `ensureLedger` waiter has a real reply to receive.
    const bob = makeMLSPeer(fake, 'bob', rs, {
      epoch: 1,
      members,
      recovery: { timeoutMs: 120, getDelayMs: () => 0, deadlineMs: 600 },
    })
    await flush()
    await bob.peer.commit(buildLedgerCommit(bob, ['circle:x=Bob']))
    await flush()

    const alice = makeMLSPeer(held.hub, 'alice', rs, {
      mls: aliceMLS,
      crypto: aliceCrypto,
      members,
      recovery: { timeoutMs: 120, getDelayMs: () => 0, deadlineMs: 600 },
    })
    await flush()

    // Not awaited: her recover registers the ledger waiter and publishes the request, then parks —
    // bob's reply is intercepted and HELD by the wrapper, so her gather never settles here.
    const rejoin = alice.peer.recover().catch(() => {})

    // The reply reached alice and is being held: the waiter is registered and the gather is pending.
    await held.whenHeld
    await flush()
    expect(openEntered).toBe(false)

    // The window, opened deliberately. `deliverHeld()` resolves the drain's parked `next()` — its
    // delivery microtask is now queued. `dispose()`, called synchronously right after, sets
    // `disposed = true` and queues its own continuation (unsubscribe + `ledgerWaiters.clear()`)
    // AFTER that delivery. So the waiter fires — disposed, gather not yet settled — and the early
    // guard is the only thing between the reply and `openSealedLedger`.
    held.deliverHeld()
    const disposing = alice.peer.dispose()
    await disposing
    await flush(40)

    // The early guard returned: the reply was dropped before the decrypt. Under the mutation that
    // removes the `disposed` term from the early-out, this flips true (the second guard, still
    // intact, would then stop the write — but the wasted decrypt has already happened).
    expect(openEntered).toBe(false)

    await rejoin
    await bob.peer.dispose()
  })
})

// residual #7: `peer.dispose()` awaits `settled` but never the commit mutex, so an op that
// already passed `assertLive` keeps running inside `runSerial` and can still reach `mux.publish`
// (or `bus.publish` / `mailbox.publish`) after `dispose()` has returned. The three tests below
// each park an op mid-flight on a different one of the mux's three routes to the wire, dispose,
// then release it.
//
// BOUNDARY, documented once here for all three: the guard stops a publish that has NOT YET
// entered the mux. A publish already awaiting `hub.publish` is on the wire and is out of scope —
// closing that window would need draining the commit mutex in `dispose()`, which Task 4's brief
// rejects as unsafe (`build()`/`onAccepted()` are host-supplied and unbounded; draining can hang
// dispose or self-deadlock a host that calls dispose from its own callback).
describe('dispose against a lane op already inside the commit mutex', () => {
  test('an in-flight publish is refused, not written to the hub', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x8c)
    const recorder = createRecordingHub(fake)

    let buildEntered = false
    let releaseBuild = (): void => {}
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve
    })

    const alice = makeMLSPeer(recorder.hub, 'alice', rs, { epoch: 1, members })
    await flush()

    const op = alice.peer.commit(
      buildLedgerCommit(alice, ['post-dispose'], {
        onBuild: async () => {
          buildEntered = true
          await buildGate // park the op AFTER assertLive, BEFORE mux.publish
        },
      }),
    )
    const owned = op.catch(() => {})
    await flush()
    expect(buildEntered).toBe(true)

    const disposing = alice.peer.dispose()
    recorder.start()
    releaseBuild()

    await expect(op).rejects.toBeInstanceOf(PeerDisposedError)
    await disposing
    await owned
    expect(recorder.calls()).toEqual([]) // no publish reached the hub
  })
})

describe('dispose against a lane op parked before the mux bus-publish route', () => {
  test('an in-flight broadcast parked on wrap before dispose is refused after dispose, not written to the hub', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x8d)
    const recorder = createRecordingHub(fake)

    // Gated on the SEAL, not on `mux.bus.publish` itself: `segmentBoundTransport`'s `wrap`
    // (peer.ts) calls `crypto.wrap` before ever reaching the mux, which is where a real host's
    // encrypt/wrap step would park an op mid-flight too.
    let wrapEntered = false
    let releaseWrap = (): void => {}
    const wrapGate = new Promise<void>((resolve) => {
      releaseWrap = resolve
    })
    let gateArmed = false

    const aliceCrypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const gatedCrypto: FakeCrypto = {
      ...aliceCrypto,
      wrap: async (bytes) => {
        if (gateArmed) {
          gateArmed = false
          wrapEntered = true
          await wrapGate // park the op AFTER the seal starts, BEFORE bus.publish
        }
        return aliceCrypto.wrap(bytes)
      },
    }

    const alice = makeMLSPeer(recorder.hub, 'alice', rs, {
      crypto: gatedCrypto,
      epoch: 1,
      members,
    })
    await flush()

    // Armed only now: peer init and the acceptor's own construction call `crypto.wrap` for
    // nothing, but gating from the start would be fragile against that changing.
    gateArmed = true
    const op = alice.peer
      .protocol('chat')
      .dispatch('chat/changed', { data: { text: 'post-dispose' } })
    const owned = op.catch(() => {})
    await flush()
    expect(wrapEntered).toBe(true)

    const disposing = alice.peer.dispose()
    recorder.start()
    releaseWrap()

    await expect(op).rejects.toBeInstanceOf(PeerDisposedError)
    await disposing
    await owned
    expect(recorder.calls()).toEqual([]) // no publish reached the hub
  })
})

describe('dispose against a lane op parked before the mux mailbox-publish route', () => {
  test('an in-flight directed publish parked on wrap before dispose is refused after dispose, not written to the hub', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x8e)
    const recorder = createRecordingHub(fake)

    // Same placement as the bus test: gated on the directed client's own seal
    // (`createDirectedClient`'s `hub.publish`, directed.ts), which runs `wrap` before it ever
    // reaches `mux.mailbox.publish`.
    let wrapEntered = false
    let releaseWrap = (): void => {}
    const wrapGate = new Promise<void>((resolve) => {
      releaseWrap = resolve
    })
    let gateArmed = false

    const aliceCrypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const gatedCrypto: FakeCrypto = {
      ...aliceCrypto,
      wrap: async (bytes) => {
        if (gateArmed) {
          gateArmed = false
          wrapEntered = true
          await wrapGate // park the op AFTER the seal starts, BEFORE mailbox.publish
        }
        return aliceCrypto.wrap(bytes)
      },
    }

    const alice = makeMLSPeer(recorder.hub, 'alice', rs, {
      crypto: gatedCrypto,
      epoch: 1,
      members,
    })
    await flush()

    // `to('bob')` only derives topic names and builds the client — it calls `crypto.wrap`
    // nothing, so it is safe to build before arming the gate.
    const client = await alice.peer.protocol('chat').to('bob')
    gateArmed = true
    const op = client.sendEvent('chat/changed', { data: {} })
    const owned = op.catch(() => {})
    await flush()
    expect(wrapEntered).toBe(true)

    const disposing = alice.peer.dispose()
    recorder.start()
    releaseWrap()

    await expect(op).rejects.toBeInstanceOf(PeerDisposedError)
    await disposing
    await owned
    expect(recorder.calls()).toEqual([]) // no publish reached the hub
  })
})

// Delegates to `FakeHub` for everything except `receive`, whose async-iterator `return()` is
// counted and — via `gate` — can be made to reject. Mirrors Task 1's `controllableReceiveHub`
// (`hub-mux-dispose.test.ts`): `mux.dispose()`'s LAST act is this iterator's `return()`, so
// counting it is the only external signal that the mux teardown actually ran.
function controllableReceiveHub(
  gate: Promise<unknown> = Promise.resolve(),
  returnThrows?: unknown,
): {
  hub: LogHub
  returnCalls: () => number
} {
  gate.catch(() => {})
  const fake = new FakeHub()
  let returnCalls = 0
  const hub: LogHub = {
    subscribe: (subscriberDID, topicID, options) => fake.subscribe(subscriberDID, topicID, options),
    unsubscribe: (subscriberDID, topicID) => fake.unsubscribe(subscriberDID, topicID),
    publish: (params) => fake.publish(params),
    fetchTopic: (params) => fake.fetchTopic(params),
    receive: (subscriberDID) => {
      const inner = fake.receive(subscriberDID)
      const iterator = inner[Symbol.asyncIterator]()
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => iterator.next(),
          // `mux.dispose()` runs the `return()` call un-try/caught but no longer awaits its result,
          // so only a synchronously-throwing `return()` makes it reject; the async `gate` path just
          // counts the call.
          return: () => {
            returnCalls++
            if (returnThrows !== undefined) throw returnThrows
            return (async () => {
              await gate
              return iterator.return ? iterator.return() : { done: true as const, value: undefined }
            })()
          },
        }),
        ack: inner.ack?.bind(inner),
      }
    },
  }
  return { hub, returnCalls: () => returnCalls }
}

// The seam for "one child `teardownEpoch()` disposes rejects": every one of the four disposal
// categories it pushes (`directed` clients, the bus server, the acceptor, the outbound client)
// bottoms out either in an enkaku `Disposer`-based `dispose()` (`Client`, `Server`, `Transport`,
// and `BroadcastClient` itself) — which, by `@sozai/async`'s own design, NEVER rejects; a failing
// teardown callback is swallowed into a resolved `disposed` — or in a synchronous refcount-only
// unsubscribe that cannot throw. No hub or MLS double reaches either path, so the one seam left is
// the shared `BroadcastClient.prototype.dispose` (peer.ts's `runtime.client`, imported straight
// from `@kumiai/broadcast`, a direct dependency here): mocked for exactly one call, it stands in
// for a child whose real teardown failed, without touching peer.ts or the fixtures.
function rejectNextClientDispose(error: Error): () => void {
  const spy = vi
    .spyOn(BroadcastClient.prototype, 'dispose')
    .mockImplementationOnce(() => Promise.reject(error))
  return () => spy.mockRestore()
}

// Counts real `BroadcastClient.dispose()` calls while still running the original — the
// "children disposed" half of test 4's "ran once" observable.
function countClientDisposes(): { count: () => number; restore: () => void } {
  const original = BroadcastClient.prototype.dispose
  let calls = 0
  const spy = vi.spyOn(BroadcastClient.prototype, 'dispose').mockImplementation(function (
    this: BroadcastClient,
    ...args: Parameters<typeof original>
  ) {
    calls++
    return original.apply(this, args)
  })
  return { count: () => calls, restore: () => spy.mockRestore() }
}

describe('dispose reaches mux teardown and is idempotent', () => {
  test('a child dispose failure still reaches mux teardown (Slice 1)', async () => {
    const { hub, returnCalls } = controllableReceiveHub()
    const rs = new Uint8Array(32).fill(0x90)
    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members })
    await flush()

    const childError = new Error('client dispose failed')
    const restore = rejectNextClientDispose(childError)
    let caught: unknown
    try {
      await alice.peer.dispose()
    } catch (error) {
      caught = error
    } finally {
      restore()
    }

    // Unwrapped: a LONE teardown failure rethrows `teardownEpoch()`'s own AggregateError rather
    // than wrapping it a second time in `peer.dispose()`'s own.
    expect(caught).toBeInstanceOf(AggregateError)
    const aggregate = caught as AggregateError
    expect(aggregate.message).toBe('Group epoch teardown failed')
    expect(aggregate.errors).toEqual([childError])

    // The mux teardown ran anyway — the observable a sequential `await teardownEpoch(); await
    // mux.dispose()` cannot produce, since it never reaches `mux.dispose()` on a rejection above.
    expect(returnCalls()).toBe(1)
  })

  test('both teardownEpoch and mux dispose failing surfaces an AggregateError of both (Slice 1)', async () => {
    const muxError = new Error('mux dispose failed')
    // A synchronously-throwing `return()` makes `mux.dispose()` reject (the only way it still does),
    // driving peer.dispose's two-failure aggregation.
    const { hub, returnCalls } = controllableReceiveHub(Promise.resolve(), muxError)
    const rs = new Uint8Array(32).fill(0x91)
    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members })
    await flush()

    const childError = new Error('client dispose failed')
    const restore = rejectNextClientDispose(childError)
    let caught: unknown
    try {
      await alice.peer.dispose()
    } catch (error) {
      caught = error
    } finally {
      restore()
    }

    expect(caught).toBeInstanceOf(AggregateError)
    const aggregate = caught as AggregateError
    expect(aggregate.message).toBe('Peer dispose failed')
    expect(aggregate.errors).toHaveLength(2)

    expect(returnCalls()).toBe(1)
  })

  test('dispose completes cleanly on a started peer and clears inboxLane (Slice 3)', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x92)
    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members })
    await flush()

    await expect(alice.peer.dispose()).resolves.toBeUndefined()

    // No getter on the private `inboxLane` closure var, so this is the indirect assertion the
    // spec calls for: `to()` is refused post-dispose — already covered elsewhere via `assertLive`
    // — with the light addition above that dispose itself completes cleanly.
    await expect(alice.peer.protocol('chat').to('bob')).rejects.toBeInstanceOf(PeerDisposedError)
  })

  test('concurrent dispose calls share one promise and run the body once (Slice 4/C)', async () => {
    const { hub, returnCalls } = controllableReceiveHub()
    const rs = new Uint8Array(32).fill(0x93)
    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members })
    await flush()

    const { count, restore } = countClientDisposes()
    let first: Promise<void>
    let second: Promise<void>
    try {
      first = alice.peer.dispose()
      second = alice.peer.dispose()
      // The decisive check: a shared promise, not two that merely settle alike.
      expect(second).toBe(first)
      await Promise.all([first, second])
    } finally {
      restore()
    }

    expect(returnCalls()).toBe(1)
    expect(count()).toBe(1)
  })
})
