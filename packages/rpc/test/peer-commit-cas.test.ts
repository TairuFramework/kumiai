import type {
  HubFetchTopicParams,
  HubPublishParams,
  HubSubscribeOptions,
  LogHub,
} from '@kumiai/hub-tunnel'
import { fromUTF } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { CommitDeadlineError } from '../src/commit.js'
import { createGroupPeer } from '../src/peer.js'
import { commitTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryCommitJournal } from './fixtures/journal.js'
import { createMemoryGroupMLS, memoryEntryID } from './fixtures/memory-group-mls.js'
import {
  buildInviteCommit,
  buildLedgerCommit,
  chat,
  makeMLSPeer,
  type Protocols,
} from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

/** A hub view that can hold a publish open, and record the order things happened in. */
function gatedHub(
  hub: FakeHub,
  onPublish?: (params: HubPublishParams) => Promise<void> | void,
): LogHub {
  return {
    publish: async (params: HubPublishParams) => {
      await onPublish?.(params)
      return hub.publish(params)
    },
    subscribe: (did: string, topicID: string, options?: HubSubscribeOptions) =>
      hub.subscribe(did, topicID, options),
    unsubscribe: (did: string, topicID: string) => hub.unsubscribe(did, topicID),
    receive: (did: string) => hub.receive(did),
    fetchTopic: (params: HubFetchTopicParams) => hub.fetchTopic(params),
  }
}

/** The commit frames actually in the log, in order. A fork would put two at one epoch. */
function commitFrames(hub: FakeHub, recoverySecret: Uint8Array) {
  return hub.published.filter((m) => m.topicID === commitTopic(recoverySecret))
}

describe('the commit loop converges, serializes and journals', () => {
  test('two admins commit at the same epoch: one wins, the loser rebases, and BOTH land', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x21)

    // Bob's first publish is held until Alice's has landed, so both peers demonstrably
    // built against epoch 1 — the race is constructed, not hoped for.
    let bobPublishes = 0
    let releaseBob: (() => void) | undefined
    const aliceLanded = new Promise<void>((resolve) => {
      releaseBob = resolve
    })
    let bobBuilt: (() => void) | undefined
    const bobHasBuilt = new Promise<void>((resolve) => {
      bobBuilt = resolve
    })

    const alice = makeMLSPeer(
      gatedHub(hub, async (params) => {
        // Alice does not get to publish until Bob has framed his commit at epoch 1.
        if (params.publishID != null) await bobHasBuilt
      }),
      'alice',
      recoverySecret,
    )
    const bob = makeMLSPeer(
      gatedHub(hub, async (params) => {
        if (params.publishID == null) return
        bobPublishes += 1
        if (bobPublishes === 1) await aliceLanded
      }),
      'bob',
      recoverySecret,
    )
    await flush()

    const aliceToken = 'signed-token: carol is an admin'
    const bobToken = 'signed-token: dave is an admin'
    const bobFramedAt: Array<number> = []

    const aliceCommit = alice.peer.commit(buildLedgerCommit(alice, [aliceToken]))
    const bobCommit = bob.peer.commit(
      buildLedgerCommit(bob, [bobToken], {
        framedAt: bobFramedAt,
        onBuild: () => {
          bobBuilt?.()
        },
      }),
    )
    void aliceCommit.then(() => releaseBob?.())
    await Promise.all([aliceCommit, bobCommit])
    await flush()

    // Bob framed at epoch 1, lost the compare-and-set, pulled Alice's commit, and framed
    // the SECOND attempt at epoch 2 — against the handle her commit rebased him onto.
    expect(bobFramedAt).toEqual([1, 2])
    expect(bob.journal.puts()).toBe(2) // one per attempt: the loser wrote, cleared, wrote again

    // No fork: two commits in the log, at consecutive epochs, and nothing left pending.
    expect(commitFrames(hub, recoverySecret)).toHaveLength(2)
    expect(alice.journal.slot()).toBeNull()
    expect(bob.journal.slot()).toBeNull()

    // The loser's entries LANDED — in the winner's ledger, not just in his own. This is
    // the assertion the question exists for: a commit that framed at a superseded epoch
    // would be dropped by every other member and this would hold only Alice's token.
    const ledger = [memoryEntryID(aliceToken), memoryEntryID(bobToken)]
    expect(alice.mls.ledgerIDs()).toEqual(ledger)
    expect(bob.mls.ledgerIDs()).toEqual(ledger)
    expect(alice.mls.epoch()).toBe(3)
    expect(bob.mls.epoch()).toBe(3)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('two commits on ONE device serialize: neither builds against a superseded handle', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x22)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret)
    await flush()

    const first = 'signed-token: carol is an admin'
    const second = 'signed-token: dave is an admin'
    const framedAt: Array<number> = []

    // Both calls are made before either can finish. The compare-and-set cannot help here —
    // it resolves races between devices, and these are two callers on one.
    await Promise.all([
      alice.peer.commit(buildLedgerCommit(alice, [first], { framedAt })),
      alice.peer.commit(buildLedgerCommit(alice, [second], { framedAt })),
    ])
    await flush()

    // The second build ran at epoch 2: it saw the first commit adopted. Two builds against
    // one handle would both read epoch 1 and frame two commits at the same epoch.
    expect(framedAt).toEqual([1, 2])
    // Neither lost a compare-and-set — they never raced — and the single journal slot was
    // never occupied by two commits at once.
    expect(alice.journal.puts()).toBe(2)
    expect(alice.journal.putWhileOccupied()).toBe(0)

    expect(alice.mls.ledgerIDs()).toEqual([memoryEntryID(first), memoryEntryID(second)])
    expect(alice.mls.epoch()).toBe(3)
    expect(commitFrames(hub, recoverySecret)).toHaveLength(2)

    await alice.peer.dispose()
  })

  test('the journal is written before the publish, and cleared after it — on both outcomes', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x23)
    const trace: Array<string> = []
    const journal = createMemoryCommitJournal({ trace })

    // A competing admin lands a commit while this peer's first attempt is in flight, so
    // the run covers both terminal outcomes: a lost compare-and-set, then an accepted one.
    let seenPublishes = 0
    const hubView = gatedHub(hub, async (params) => {
      if (params.publishID == null) return
      seenPublishes += 1
      if (seenPublishes === 1) {
        await publishCommit({ hub, senderDID: 'zoe', recoverySecret, epoch: 1 })
      }
      trace.push('hub.publish')
    })
    const alice = makeMLSPeer(hubView, 'alice', recoverySecret, { journal })
    await flush()

    const token = 'signed-token: carol is an admin'
    await alice.peer.commit(buildLedgerCommit(alice, [token]))

    // The ordering, not merely the presence of both. The write is durable BEFORE the frame
    // can reach the hub — that is the window a crash lands in — and the slot is cleared
    // only once the hub has answered, whichever way it answered.
    expect(trace.map((step) => step.split(':')[0])).toEqual([
      'journal.put', // attempt 1: journalled...
      'hub.publish', // ...then published, and lost the compare-and-set
      'journal.clear', // the loser's slot is cleared, and the commit dropped untouched
      'journal.put', // attempt 2, rebased onto the winner
      'hub.publish',
      'journal.markAccepted', // the hub's answer, written down before the host adopts it
      'journal.clear', // accepted: cleared after onAccepted ran
    ])
    expect(journal.slot()).toBeNull()
    expect(alice.mls.ledgerIDs()).toEqual([memoryEntryID(token)])

    await alice.peer.dispose()
  })

  test('losing several compare-and-sets in a row is not an error path', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x24)

    // Five consecutive losses. On a busy group with several active admins this is ordinary
    // contention, and an attempt count would turn it into a thrown error.
    let attempts = 0
    const hubView = gatedHub(hub, async (params) => {
      if (params.publishID == null) return
      attempts += 1
      if (attempts <= 5) {
        await publishCommit({ hub, senderDID: 'zoe', recoverySecret, epoch: attempts })
      }
    })
    const alice = makeMLSPeer(hubView, 'alice', recoverySecret)
    await flush()

    const token = 'signed-token: carol is an admin'
    const framedAt: Array<number> = []
    await expect(
      alice.peer.commit(buildLedgerCommit(alice, [token], { framedAt })),
    ).resolves.toEqual({})
    await flush()

    // It rebased five times and landed on the sixth, without throwing.
    expect(framedAt).toEqual([1, 2, 3, 4, 5, 6])
    expect(alice.journal.puts()).toBe(6)
    expect(alice.journal.slot()).toBeNull()
    expect(alice.mls.epoch()).toBe(7)
    expect(alice.mls.ledgerIDs()).toEqual([memoryEntryID(token)])

    await alice.peer.dispose()
  })

  test('the retry bound is a deadline, not an attempt count', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x25)

    // A group this peer can never win: someone else commits ahead of every attempt.
    let attempts = 0
    const hubView = gatedHub(hub, async (params) => {
      if (params.publishID == null) return
      attempts += 1
      await publishCommit({ hub, senderDID: 'zoe', recoverySecret, epoch: attempts })
    })
    // A zero deadline: the first loss is already past it. It is a bound on TIME spent
    // rebasing, so it still gets one full attempt — it never refuses to try.
    const alice = makeMLSPeer(hubView, 'alice', recoverySecret, { commitDeadlineMs: 0 })
    await flush()

    const framedAt: Array<number> = []
    await expect(
      alice.peer.commit(
        buildLedgerCommit(alice, ['signed-token: carol is an admin'], { framedAt }),
      ),
    ).rejects.toThrow(CommitDeadlineError)

    expect(framedAt).toEqual([1]) // one attempt was made, and its loss was past the deadline
    expect(alice.journal.slot()).toBeNull() // the loser's slot is cleared, never left behind

    await alice.peer.dispose()
  })

  test("an invite's Welcome is delivered by onAccepted, and by nothing else", async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x26)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret)
    await flush()

    // The peer holds the journalled blob and an adopt hook for it, and adopting is all a
    // ledger commit's onAccepted does — so a peer that adopts the blob itself on acceptance
    // looks right. The Welcome is what it silently drops: it lives in the host's onAccepted,
    // not in `bodies`, and the peer cannot produce one.
    await alice.peer.commit(buildInviteCommit(alice, 'dave'))
    await flush()

    expect(alice.welcomes).toEqual(['dave'])
    expect(alice.mls.epoch()).toBe(2)
    expect(alice.journal.slot()).toBeNull()

    await alice.peer.dispose()
  })

  test('a mailbox frame on the commit topic does not wedge the lane', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x27)
    const topicID = commitTopic(recoverySecret)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { commitDeadlineMs: 0 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { commitDeadlineMs: 0 })
    await flush()

    // Anyone who can publish to the commit topic can choose the retention class, and a
    // removed member keeps the topic. One mailbox frame is the whole attack: it does not
    // move the head, so a peer that read it out of the log would step its cursor onto a
    // position the head can never equal — and every later commit would compare-and-set
    // against a sequenceID that can never match, forever, on a frame that is not even
    // retained. The bytes do not have to be a commit: the cursor steps over whatever it
    // processed, including what it dropped.
    await hub.publish({
      senderDID: 'mallory',
      topicID,
      payload: fromUTF('not a commit'),
      retain: 'mailbox',
    })
    await flush()

    // The commit must LAND. There is nothing to rebase against here, so one attempt is all
    // it should ever need — and the zero deadline says so: a wrong anchor fails at once
    // instead of rebasing against a head it can never reach until it runs out of time.
    const token = 'signed-token: carol is an admin'
    await expect(alice.peer.commit(buildLedgerCommit(alice, [token]))).resolves.toEqual({})
    await flush()

    expect(alice.mls.ledgerIDs()).toEqual([memoryEntryID(token)])
    expect(alice.mls.epoch()).toBe(2)
    expect(alice.journal.slot()).toBeNull()
    // And it landed for the GROUP, not just for its author: the head names Alice's frame,
    // and Bob pulled it out of the log and enacted it.
    expect(hub.head(topicID)).not.toBeNull()
    expect(bob.mls.ledgerIDs()).toEqual([memoryEntryID(token)])
    expect(bob.mls.epoch()).toBe(2)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('a member whose commit log has been swept still commits: the anchor is the head', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x29)
    const topicID = commitTopic(recoverySecret)

    // The group's history, then the hub sweeping it past its retention. The head survives
    // the frames it named — an empty log still has a tip — so a member reading this topic
    // finds no frames and a head that is a real sequenceID.
    const zoe = await publishCommit({ hub, senderDID: 'zoe', recoverySecret, epoch: 1 })
    hub.trim(topicID, '999999999999')
    expect(hub.head(topicID)).toBe(zoe.sequenceID)

    // A member joining from a Welcome: its handle is current — the group is at epoch 2 —
    // and it has no backlog to read, because there is none left to read.
    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 2, commitDeadlineMs: 0 })
    await flush()

    const token = 'signed-token: carol is an admin'
    await expect(alice.peer.commit(buildLedgerCommit(alice, [token]))).resolves.toEqual({})
    await flush()

    // Its cursor is null: it processed nothing, because there was nothing there. Anchoring
    // the compare-and-set on it would offer `null` — "this topic has never had a log
    // publish" — to a topic whose head is Zoe's frame, and lose that race forever.
    expect(alice.mls.ledgerIDs()).toEqual([memoryEntryID(token)])
    expect(alice.mls.epoch()).toBe(3)
    expect(hub.head(topicID)).not.toBe(zoe.sequenceID)
    expect(alice.journal.slot()).toBeNull()

    await alice.peer.dispose()
  })

  test('a peer with no MLS port has no group to commit to, and says so', async () => {
    const hub = new FakeHub()
    const peer = createGroupPeer<Protocols>({
      hub,
      crypto: createFakeCrypto({ epoch: 1, localDID: 'bob' }),
      localDID: 'bob',
      protocols: { chat },
      handlers: { chat: {} } as never,
    })
    // No group, so nothing to commit to and nothing to replay. A no-op `commit` that
    // resolved would tell a host its commit landed when there is no group at all.
    await expect(peer.commit(async () => ({}) as never)).rejects.toThrow(/no MLS port/)
    await expect(peer.replay()).resolves.toEqual({})
    await peer.dispose()
  })

  test('an MLS port cannot be wired without a journal', () => {
    const hub = new FakeHub()
    const mls = createMemoryGroupMLS({ recoverySecret: new Uint8Array(32).fill(0x28) })
    // A peer with a group and no journal loses every commit whose process died in the
    // acceptance window — silently, and with no way to ever merge the orphan frame it left
    // in the log. Never invoked: the assertion IS the compile error, checked by `test:types`.
    const wire = (): void => {
      // @ts-expect-error an MLS port arrives with its journal, or it does not arrive
      createGroupPeer<Protocols>({
        hub,
        crypto: createFakeCrypto({ epoch: 1, localDID: 'bob' }),
        mls,
        localDID: 'bob',
        protocols: { chat },
        handlers: { chat: {} } as never,
      })
    }
    expect(wire).toBeTypeOf('function')
  })
})
