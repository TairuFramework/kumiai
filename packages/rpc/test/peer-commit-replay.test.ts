import type { HubFetchTopicParams, HubPublishParams, LogHub } from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import { type JournalEntry, JournalEpochError, type LostCommit } from '../src/commit.js'
import { commitTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryCommitJournal, type MemoryCommitJournal } from './fixtures/journal.js'
import { memoryEntryID } from './fixtures/memory-group-mls.js'
import {
  adoptJournalledBlob,
  buildInviteCommit,
  buildLedgerCommit,
  buildRemoveCommit,
  makeMLSPeer,
  type TestPeer,
} from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

/** A hub whose publish can be made to fail, modelling a process that never learns the outcome. */
function faultyHub(hub: FakeHub, shouldFail: (params: HubPublishParams) => boolean): LogHub {
  return {
    publish: async (params: HubPublishParams) => {
      if (shouldFail(params)) throw new Error('the hub went away')
      return hub.publish(params)
    },
    subscribe: (did, topicID, options) => hub.subscribe(did, topicID, options),
    unsubscribe: (did, topicID) => hub.unsubscribe(did, topicID),
    receive: (did) => hub.receive(did),
    fetchTopic: (params: HubFetchTopicParams) => hub.fetchTopic(params),
  }
}

function commitFrames(hub: FakeHub, recoverySecret: Uint8Array) {
  return hub.published.filter((m) => m.topicID === commitTopic(recoverySecret))
}

/**
 * A commit that was journalled and whose process died before the frame ever reached the
 * hub. Seeding the slot IS the crash: the journal is the one thing that survives it, and
 * everything the peer knows about the commit on restart is what is in there.
 */
async function journalledButNeverPublished(
  member: TestPeer,
  entry: Pick<JournalEntry, 'expectedHead' | 'kind' | 'bodies'>,
): Promise<MemoryCommitJournal> {
  const commit = member.mls.buildCommit(entry.bodies)
  return createMemoryCommitJournal({
    slot: {
      publishID: 'publish-that-never-landed',
      expectedHead: entry.expectedHead,
      // Framed at the epoch the handle is at now, and carrying no acceptance: the outcome
      // was never learned. That is the whole of what a crashed process leaves behind.
      epoch: member.mls.epoch(),
      commit,
      bodies: entry.bodies,
      kind: entry.kind,
      journal: commit,
    },
  })
}

describe('restart replay closes the crash window', () => {
  test('accepted, then the process died before it recorded the outcome: the peer adopts and is whole', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x31)
    const journal = createMemoryCommitJournal()
    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { journal })
    await flush()

    const token = 'signed-token: carol is an admin'
    // The hub accepts the frame, and the process dies inside onAccepted — before it
    // adopted, and before it could clear the slot.
    const build = buildLedgerCommit(alice, [token])
    await expect(
      alice.peer.commit(async () => {
        const pending = await build()
        return {
          ...pending,
          onAccepted: async () => {
            throw new Error('the process died here')
          },
        }
      }),
    ).rejects.toThrow('the process died here')
    await alice.peer.dispose()

    // The frame is in the log. The group has moved on and this peer has not: it is at the
    // pre-commit epoch, holding a slot it never resolved.
    expect(commitFrames(hub, recoverySecret)).toHaveLength(1)
    expect(alice.mls.epoch()).toBe(1)
    expect(journal.slot()).not.toBeNull()

    // Restart: a new peer over the same durable state — the same handle, the same journal.
    const restarted = makeMLSPeer(hub, 'alice', recoverySecret, {
      mls: alice.mls,
      crypto: alice.crypto,
      journal,
    })
    const result = await restarted.peer.replay()

    // The store recognised the publishID, returned the original sequenceID, and appended
    // NOTHING. Nothing was lost — the commit had landed all along.
    expect(result).toEqual({})
    expect(commitFrames(hub, recoverySecret)).toHaveLength(1)
    expect(restarted.mls.epoch()).toBe(2)
    expect(restarted.mls.ledgerIDs()).toEqual([memoryEntryID(token)])
    expect(journal.slot()).toBeNull()

    await restarted.peer.dispose()
  })

  test('a peer whose group is past its first epoch settles its journalled commit at startup, with the host calling nothing', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x3a)
    // The process dies between the hub's answer and the durable write, so the slot records NO
    // acceptance: replay cannot adopt from it, it has to republish — which means re-sealing the
    // bodies, which means the lane has to know what epoch the handle is at.
    let dying = true
    const journal = createMemoryCommitJournal({
      onMarkAccepted: () => {
        if (!dying) return
        dying = false
        throw new Error('the process died here')
      },
    })
    // A group PAST its first epoch — which is every group that has ever committed, and the only
    // kind a crash can happen in. The epoch the lane compares against is the HANDLE's, and it
    // must be asked for it before the first lane operation runs: replay is step 0 of the SEED,
    // which happens before the app lane is built. A lane that assumed it was still at epoch 0
    // refuses its own replay — for having "already advanced past" the commit it is holding, on
    // a handle that has advanced past nothing — and the throw takes the seed pull down with it.
    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 3, journal })
    await flush()

    const token = 'signed-token: carol is an admin'
    await expect(alice.peer.commit(buildLedgerCommit(alice, [token]))).rejects.toThrow(
      'the process died here',
    )
    await alice.peer.dispose()
    expect(journal.slot()?.acceptedAs).toBeUndefined()
    expect(alice.mls.epoch()).toBe(3)

    // Restart, and then call NOTHING. The host does not know it crashed — that is the whole
    // premise of a crash — so the peer's own first lane operation has to settle this. A peer
    // that only recovered when the host happened to ask for a lane operation would come up
    // holding an unsettled commit and an unseeded cursor, silently.
    const restarted = makeMLSPeer(hub, 'alice', recoverySecret, {
      mls: alice.mls,
      crypto: alice.crypto,
      journal,
    })
    await flush()

    expect(restarted.mls.epoch()).toBe(4)
    expect(restarted.mls.ledgerIDs()).toEqual([memoryEntryID(token)])
    expect(journal.slot()).toBeNull()
    // The store recognised the publishID and appended nothing: one frame, not two.
    expect(commitFrames(hub, recoverySecret)).toHaveLength(1)

    await restarted.peer.dispose()
  })

  test('the commit is applied exactly once across the restart — never once by replay and again by the pull', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x32)
    const journal = createMemoryCommitJournal()
    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { journal })
    await flush()

    const token = 'signed-token: carol is an admin'
    const build = buildLedgerCommit(alice, [token])
    await expect(
      alice.peer.commit(async () => ({
        ...(await build()),
        onAccepted: async () => {
          throw new Error('the process died here')
        },
      })),
    ).rejects.toThrow()
    await alice.peer.dispose()

    // The restarted peer's log contains its OWN un-merged commit, and its cursor is empty:
    // nothing in memory remembers that it published it. Replay runs ahead of the pull, and
    // the cursor it sets is what carries the pull over the frame.
    const restarted = makeMLSPeer(hub, 'alice', recoverySecret, {
      mls: alice.mls,
      crypto: alice.crypto,
      journal,
    })
    await restarted.peer.replay()
    await flush()

    // Once. Not adopted by replay AND applied again by the pull.
    expect(restarted.mls.epoch()).toBe(2)
    expect(restarted.mls.ledgerIDs()).toEqual([memoryEntryID(token)])
    expect(restarted.mls.commits()).toBe(0) // it was adopted, never processed as somebody else's

    await restarted.peer.dispose()
  })

  test('never accepted, and nobody else committed: the replay wins the compare-and-set and lands', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x33)
    const token = 'signed-token: carol is an admin'

    const seed = makeMLSPeer(hub, 'alice', recoverySecret)
    const journal = await journalledButNeverPublished(seed, {
      expectedHead: null, // the first commit of this group's life
      kind: 'ledger',
      bodies: [token],
    })
    await seed.peer.dispose()

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
      mls: seed.mls,
      crypto: seed.crypto,
      journal,
    })
    const result = await alice.peer.replay()

    // The republish was an ordinary compare-and-set, and it won. This is the sole-member
    // group whose creator crashed mid-commit: no responder exists, and none is needed.
    expect(result).toEqual({})
    expect(commitFrames(hub, recoverySecret)).toHaveLength(1)
    expect(alice.mls.epoch()).toBe(2)
    expect(alice.mls.ledgerIDs()).toEqual([memoryEntryID(token)])
    expect(journal.slot()).toBeNull()

    await alice.peer.dispose()
  })

  test('never accepted, and someone else won: a ledger commit hands back its tokens', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x34)
    const token = 'signed-token: carol is an admin'

    const seed = makeMLSPeer(hub, 'alice', recoverySecret)
    const journal = await journalledButNeverPublished(seed, {
      expectedHead: null,
      kind: 'ledger',
      bodies: [token],
    })
    await seed.peer.dispose()

    // While this peer was down, another admin committed. Its journalled expectedHead is
    // stale, and its publishID is unknown to the store — so the republish is an ordinary
    // compare-and-set, and it loses.
    await publishCommit({ hub, senderDID: 'zoe', recoverySecret, epoch: 1 })

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
      mls: seed.mls,
      crypto: seed.crypto,
      journal,
    })
    const result = await alice.peer.replay()

    // The tokens are signed and epoch-independent, so the WORK survived the restart even
    // though the commit did not. There is no build() to call again — the process that held
    // it is gone — so the peer hands the tokens back and the host re-issues them.
    expect(result.lost).toEqual({ kind: 'ledger', tokens: [token] })
    expect(journal.slot()).toBeNull() // cleared, and surfaced. Never cleared silently.
    expect(commitFrames(hub, recoverySecret)).toHaveLength(1) // only the winner's
    expect(alice.mls.ledgerIDs()).toEqual([]) // this commit did not happen

    await alice.peer.dispose()
  })

  test('never accepted, and someone else won: an invite hands back a failure notice, and no tokens', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x35)

    const seed = makeMLSPeer(hub, 'alice', recoverySecret)
    const journal = await journalledButNeverPublished(seed, {
      expectedHead: null,
      kind: 'invite',
      bodies: [], // the intent is in the Add proposal and the KeyPackage, not here
    })
    await seed.peer.dispose()
    await publishCommit({ hub, senderDID: 'zoe', recoverySecret, epoch: 1 })

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
      mls: seed.mls,
      crypto: seed.crypto,
      journal,
    })
    const result = await alice.peer.replay()

    // This did not happen, and it cannot be given back: the peer never had the Welcome, and
    // it cannot construct one. The host must re-issue the invite or tell the user. The one
    // thing that must not happen is a silent clear — for a remove, that is an admin who
    // believes a member was evicted when they were not.
    expect(result.lost).toEqual({ kind: 'invite' })
    expect(alice.welcomes).toEqual([]) // nothing was re-enacted behind the host's back
    expect(journal.slot()).toBeNull()

    await alice.peer.dispose()
  })

  test('a remove that lands evicts the member', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x3a)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { members: ['alice', 'mallory'] })
    await flush()

    await alice.peer.commit(buildRemoveCommit(alice, 'mallory'))

    // The control the failed remove below is measured against: when the commit lands, the host
    // adopts in onAccepted and the leaf is gone. Eviction is that adoption and nothing else.
    expect(alice.mls.leaves()).not.toContain('mallory')
    expect(alice.journal.slot()).toBeNull()

    await alice.peer.dispose()
  })

  test('a remove that never landed is surfaced, and the member is STILL IN THE GROUP', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x36)

    // Mallory is in the tree, and the commit that was going to evict her never reached the hub.
    const seed = makeMLSPeer(hub, 'alice', recoverySecret, { members: ['alice', 'mallory'] })
    const journal = await journalledButNeverPublished(seed, {
      expectedHead: null,
      kind: 'remove',
      bodies: [],
    })
    await seed.peer.dispose()
    await publishCommit({ hub, senderDID: 'zoe', recoverySecret, epoch: 1 })

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
      mls: seed.mls,
      crypto: seed.crypto,
      journal,
      // The blob a remove journals is its POST-commit handle — the one whose tree no longer
      // holds Mallory. Adopting it is the eviction, and nothing else is. So a peer that
      // adopts a commit it has not been told landed evicts her here, on a group that still
      // holds her, and this test is the thing that catches it.
      adoptJournalled: (blob) => {
        adoptJournalledBlob(seed.mls, blob)
        seed.mls.evict('mallory')
      },
    })
    const { lost } = await alice.peer.replay()

    // Two failures are possible and they are NOT the same. Silence, and an admin believes an
    // eviction happened that did not. Or a notice over a handle Mallory is already gone from,
    // and the admin is told the removal failed while this device quietly acts as if it did —
    // it stops sealing to her, and diverges from a group that still holds her leaf. Only the
    // pair of assertions below can tell those apart, and both must hold.
    expect(lost).toEqual({ kind: 'remove' })
    expect(alice.mls.leaves()).toContain('mallory')
    expect(commitFrames(hub, recoverySecret)).toHaveLength(1) // only zoe's: the remove never landed
    expect(journal.slot()).toBeNull() // surfaced, then cleared. Never cleared silently.

    await alice.peer.dispose()
  })

  test('the obvious host handler answers a loss by committing — and does not deadlock', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x37)
    const token = 'signed-token: carol is an admin'

    const seed = makeMLSPeer(hub, 'alice', recoverySecret)
    const journal = await journalledButNeverPublished(seed, {
      expectedHead: null,
      kind: 'ledger',
      bodies: [token],
    })
    await seed.peer.dispose()
    await publishCommit({ hub, senderDID: 'zoe', recoverySecret, epoch: 1 })

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
      mls: seed.mls,
      crypto: seed.crypto,
      journal,
    })

    // This is the handler a host will write, and the reason `lost` is a return value.
    // Replay runs at lane step 0, INSIDE the peer's commit mutex, and this answers it by
    // calling commit() — which takes that same mutex. Returning it means the host acts
    // after the lane has released, so its follow-up commit is a separate lane operation.
    // Handed to the host as a callback fired under the lock, this line would deadlock.
    const startup = async (): Promise<LostCommit | undefined> => {
      const { lost } = await alice.peer.replay()
      if (lost?.kind === 'ledger') {
        await alice.peer.commit(buildLedgerCommit(alice, lost.tokens))
      }
      return lost
    }

    // The whole handler, under a timeout: a deadlock cannot pass this.
    const lost = await Promise.race([
      startup(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('the lane deadlocked: commit() never took the mutex')),
          2000,
        ),
      ),
    ])
    await flush()

    expect(lost).toEqual({ kind: 'ledger', tokens: [token] })
    // Re-issued and landed: the work survived the restart intact, and nothing was lost.
    expect(alice.mls.ledgerIDs()).toEqual([memoryEntryID(token)])
    expect(alice.mls.epoch()).toBe(3) // zoe's commit, then the re-issued one
    expect(journal.slot()).toBeNull()

    await alice.peer.dispose()
  })

  test('an unknown publish outcome keeps the slot: the peer asks the store again', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x38)
    const token = 'signed-token: carol is an admin'

    // The publish fails in a way that says NOTHING about whether the hub accepted it —
    // a timeout, a dropped connection. Clearing the slot here would discard a commit that
    // may be in the log; the only safe move is to keep it and ask the store again.
    let failing = true
    const alice = makeMLSPeer(
      faultyHub(hub, (params) => failing && params.publishID != null),
      'alice',
      recoverySecret,
    )
    await flush()

    await expect(alice.peer.commit(buildLedgerCommit(alice, [token]))).rejects.toThrow(
      'the hub went away',
    )
    expect(alice.journal.slot()).not.toBeNull() // kept, because the outcome is unknown
    expect(commitFrames(hub, recoverySecret)).toHaveLength(0)

    // The hub comes back. The next lane operation replays the slot, and the commit lands.
    failing = false
    expect(await alice.peer.replay()).toEqual({})
    expect(alice.mls.ledgerIDs()).toEqual([memoryEntryID(token)])
    expect(alice.journal.slot()).toBeNull()

    await alice.peer.dispose()
  })

  test('replay is idempotent: running it twice adopts once and delivers a Welcome once', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x39)
    const journal = createMemoryCommitJournal()
    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { journal })
    await flush()

    // Accepted, then the process died in onAccepted — after the Welcome went out. The peer
    // cannot tell that from a process that died before it, so replay runs onAccepted's work
    // again. Both halves have to tolerate the repeat, and the host's do.
    const build = buildInviteCommit(alice, 'dave')
    await expect(
      alice.peer.commit(async () => {
        const pending = await build()
        return {
          ...pending,
          onAccepted: async () => {
            await pending.onAccepted()
            throw new Error('the process died after the Welcome went out')
          },
        }
      }),
    ).rejects.toThrow()
    expect(alice.welcomes).toEqual(['dave'])
    expect(alice.mls.epoch()).toBe(2) // it DID adopt before it died
    // And the peer wrote the hub's answer down BEFORE the host adopted, so the slot names
    // the sequenceID this commit landed as. Nothing about this restart is a guess.
    expect(journal.slot()?.acceptedAs).toBeDefined()

    // The restarted peer's hub is UNREACHABLE: every publish throws. A replay that has to
    // ask the store what happened to its commit cannot get past this — and it must not need
    // to. The acceptance is in the slot, so this is a local adopt and nothing else.
    const restarted = makeMLSPeer(
      faultyHub(hub, () => true),
      'alice',
      recoverySecret,
      { mls: alice.mls, crypto: alice.crypto, journal, welcomes: alice.welcomes },
    )
    await restarted.peer.replay()
    await restarted.peer.replay()

    // Adopting a fixed serialized handle twice is harmless. Re-delivering a Welcome is not,
    // and the host is the one that has to make it a no-op — the peer cannot.
    expect(restarted.mls.epoch()).toBe(2)
    expect(restarted.welcomes).toEqual(['dave'])
    expect(commitFrames(hub, recoverySecret)).toHaveLength(1)
    expect(journal.slot()).toBeNull()

    await restarted.peer.dispose()
    await alice.peer.dispose()
  })

  test('the process died between the hub accepting the commit and the journal recording it', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x3a)
    // The one window the acceptance record does not close: the hub answered, and the
    // process died before that answer reached the disk. The slot holds no acceptance — and
    // the host has NOT adopted either, because the record lands first, so the handle is
    // still at the epoch the commit was framed at.
    let dead = true
    const journal = createMemoryCommitJournal({
      onMarkAccepted: () => {
        if (dead) throw new Error('the process died here')
      },
    })
    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { journal })
    await flush()

    const token = 'signed-token: carol is an admin'
    await expect(alice.peer.commit(buildLedgerCommit(alice, [token]))).rejects.toThrow(
      'the process died here',
    )
    await alice.peer.dispose()

    expect(commitFrames(hub, recoverySecret)).toHaveLength(1) // the frame IS in the log
    expect(journal.slot()?.acceptedAs).toBeUndefined() // and this peer does not know it
    expect(alice.mls.epoch()).toBe(1) // it never adopted: the record lands before the adopt

    // Restart. The epochs match, so replay republishes — and the store's idempotency is
    // what answers: the publishID is known, so it returns the ORIGINAL sequenceID and
    // appends nothing. This is the seam between the new local record and the old dedup, and
    // the commit still applies exactly once.
    dead = false
    const restarted = makeMLSPeer(hub, 'alice', recoverySecret, {
      mls: alice.mls,
      crypto: alice.crypto,
      journal,
    })
    expect(await restarted.peer.replay()).toEqual({})

    expect(commitFrames(hub, recoverySecret)).toHaveLength(1) // one frame, not two
    expect(restarted.mls.epoch()).toBe(2)
    expect(restarted.mls.ledgerIDs()).toEqual([memoryEntryID(token)])
    expect(restarted.mls.commits()).toBe(0) // adopted, never processed as somebody else's
    expect(journal.slot()).toBeNull()

    await restarted.peer.dispose()
  })

  test('a host that adopted outside onAccepted is refused: its commit cannot be re-sealed', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x3b)
    const poison = 'signed-token: carol is an admin'

    // The misbehaving host: it adopts its own commit out of band, while the publish is
    // still in flight, and dies without ever learning whether the publish landed. Its
    // journal holds a commit framed at epoch 1 with no acceptance recorded, and its handle
    // is at epoch 2.
    const seed = makeMLSPeer(hub, 'alice', recoverySecret)
    const journal = await journalledButNeverPublished(seed, {
      expectedHead: null,
      kind: 'ledger',
      bodies: [poison],
    })
    const slot = journal.slot() as JournalEntry
    seed.mls.adopt(slot.commit) // adopted somewhere other than onAccepted
    await seed.peer.dispose()
    expect(slot.epoch).toBe(1)
    expect(seed.mls.epoch()).toBe(2)

    const bob = makeMLSPeer(hub, 'bob', recoverySecret)
    const carol = makeMLSPeer(hub, 'carol', recoverySecret)
    await flush()

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
      mls: seed.mls,
      crypto: seed.crypto,
      journal,
    })

    // Replaying would mean re-sealing the bodies under epoch 2, and every member that can
    // apply a commit framed at epoch 1 is at epoch 1 — none of them could open it. The peer
    // refuses instead, and says what the host did wrong.
    await expect(alice.peer.replay()).rejects.toThrow(JournalEpochError)
    await flush()

    // The refusal is not the point. THIS is: the unopenable frame never reached the group.
    // A member that applied it could never resolve the entries it names, its cursor would
    // never advance past it, and the commit lane would be dead for everyone still at that
    // epoch — on a frame nobody can ever get past.
    expect(commitFrames(hub, recoverySecret)).toHaveLength(0)
    expect(journal.slot()).not.toBeNull() // refused, and kept: never silently cleared

    // And the group is alive. Bob commits over a lane the poison would have wedged, and
    // Carol enacts it.
    const token = 'signed-token: dave is an admin'
    await expect(bob.peer.commit(buildLedgerCommit(bob, [token]))).resolves.toEqual({})
    await flush()

    expect(bob.mls.ledgerIDs()).toEqual([memoryEntryID(token)])
    expect(carol.mls.ledgerIDs()).toEqual([memoryEntryID(token)])
    expect(carol.mls.epoch()).toBe(2)

    await alice.peer.dispose()
    await bob.peer.dispose()
    await carol.peer.dispose()
  })
})
