import { describe, expect, test } from 'vitest'

import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms))

const members = ['alice', 'bob', 'carol']

/** Resolve to the settled value, or to `'HUNG'` if `promise` has not settled by `ms`. */
async function settleOrHang<T>(promise: Promise<T>, ms: number): Promise<T | 'HUNG'> {
  return await Promise.race([
    promise.then(
      (value) => value,
      () => 'settled (rejected)' as unknown as T,
    ),
    new Promise<'HUNG'>((resolve) => setTimeout(() => resolve('HUNG'), ms)),
  ])
}

describe('dispose during an in-flight heal', () => {
  test('settles recover(), and the lane operation queued behind it', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x71)

    // A long rendezvous window, so requestGroupInfo is genuinely in flight — awaiting a reply
    // that never comes — when dispose() fires. Nobody else is on the topic to answer it.
    const bob = makeMLSPeer(hub, 'bob', rs, {
      epoch: 1,
      members,
      recovery: { timeoutMs: 5000, getDelayMs: () => 5, deadlineMs: 10000 },
    })
    await flush()

    // A heal that will find no responder, and a second lane operation queued behind it on the
    // commit mutex. `dispose()` clears the rendezvous TIMEOUT — the only other thing that could
    // resolve the waiter — so without a drain the waiter is never called: recover() never
    // settles, commitTail never resolves, and the queued replay() hangs behind it forever.
    const healing = bob.peer.recover()
    const queued = bob.peer.replay()
    await flush(80)

    await bob.peer.dispose()

    expect(await settleOrHang(healing, 1500)).not.toBe('HUNG')
    expect(await settleOrHang(queued, 1500)).not.toBe('HUNG')
  })

  test('the ledger gather settles on its own timer, needing no drain', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x72)

    // The only responder withholds the last ledger entry: every gathered reply fails the head
    // check, so the requester never bootstraps and its gather waits out the whole window. This
    // is the ledger-side analogue of the recovery rendezvous — and the check here is that it
    // does NOT depend on a timer dispose() clears.
    const bobCrypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    const bobMLS = createMemoryGroupMLS({
      recoverySecret: rs,
      epoch: 1,
      localDID: 'bob',
      members,
      serveLedger: (ledger) => ledger.slice(0, ledger.length - 1),
      onAdvance: (e) => bobCrypto.setEpoch(e),
    })
    const bob = makeMLSPeer(hub, 'bob', rs, {
      mls: bobMLS,
      crypto: bobCrypto,
      members,
      recovery: { timeoutMs: 300, getDelayMs: () => 5, deadlineMs: 800 },
    })
    await flush()
    await bob.peer.commit(buildLedgerCommit(bob, ['role:carol=admin', 'role:dave=admin']))
    await flush()

    // Alice rejoins against the lying responder: her external commit lands, but her bootstrap
    // cannot complete, so she is left with an empty ledger against a live head. Her next lane
    // operation gathers again, and waits.
    const alice = makeMLSPeer(hub, 'alice', rs, {
      epoch: 1,
      members,
      recovery: { timeoutMs: 300, getDelayMs: () => 5, deadlineMs: 800 },
    })
    await flush()
    await alice.peer.recover()
    expect(await alice.mls.isLedgerComplete()).toBe(false)

    // A lane operation whose ledger gather is in flight, disposed mid-wait. It must still
    // settle — bounded by the gather's own timeout, which is a local timer dispose() never
    // touches — rather than hang the way an undrained recovery waiter would.
    const queued = alice.peer.replay()
    await flush(40)
    await alice.peer.dispose()

    expect(await settleOrHang(queued, 1500)).not.toBe('HUNG')

    await bob.peer.dispose()
  })
})
