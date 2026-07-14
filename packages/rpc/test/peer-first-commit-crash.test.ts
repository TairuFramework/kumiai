import type {
  HubFetchTopicParams,
  HubFetchTopicResult,
  HubPublishParams,
  LogHub,
} from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import { memoryEntryID } from '../src/memory-group-mls.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryCommitJournal } from './fixtures/journal.js'
import {
  adoptJournalledBlob,
  buildInviteCommit,
  buildLedgerCommit,
  makeMLSPeer,
  type TestPeer,
} from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

/**
 * A hub that records every commit-log frame a pull hands the peer.
 *
 * The whole question is whether the sole member meets its OWN un-merged commit on the way up.
 * That frame is sitting in the log it is about to read, it can never be applied, and the row
 * that classifies it asks for a heal — from a group whose only other prospective member is
 * the invitee whose Welcome was never sent. Nothing else observes what the pull actually saw,
 * so this does.
 */
function recordingHub(hub: FakeHub, topicID: string, pulled: Array<string>): LogHub {
  return {
    publish: (params: HubPublishParams) => hub.publish(params),
    subscribe: (did, topic, options) => hub.subscribe(did, topic, options),
    unsubscribe: (did, topic) => hub.unsubscribe(did, topic),
    receive: (did) => hub.receive(did),
    fetchTopic: async (params: HubFetchTopicParams): Promise<HubFetchTopicResult> => {
      const result = await hub.fetchTopic(params)
      if (params.topicID === topicID) {
        for (const message of result.messages) pulled.push(message.sequenceID)
      }
      return result
    },
  }
}

function commitFrames(hub: FakeHub, recoverySecret: Uint8Array) {
  return hub.published.filter((m) => m.topicID === commitTopic(recoverySecret))
}

/**
 * Every frame this peer ever put on the rendezvous topic. A heal is a rendezvous, and a
 * rendezvous starts with a publish — so this counts the heals, including the ones that ask
 * the void for help and time out looking successful.
 */
function rendezvousFrames(hub: FakeHub, recoverySecret: Uint8Array) {
  return hub.published.filter((m) => m.topicID === rendezvousTopic(recoverySecret))
}

/**
 * Sweep the commit log away entirely: every frame gone, the head and the publish record kept.
 * That separation is the mechanism under test — the log is retention-bound, and what the hub
 * remembers about a publishID it accepted is not.
 */
function sweepCommitLog(hub: FakeHub, recoverySecret: Uint8Array): void {
  const topicID = commitTopic(recoverySecret)
  const head = hub.head(topicID)
  if (head == null) return
  hub.trim(topicID, String(Number(head) + 1).padStart(head.length, '0'))
}

/**
 * The creator's invite reached the hub, and the process died before the acceptance reached
 * the disk. The slot carries NO `acceptedAs`: a restart cannot adopt from it, and has to
 * republish under the original publishID and let the store's dedup record say what happened.
 * It is the only crash that touches that record.
 */
async function crashBeforeTheAcceptanceWasRecorded(
  hub: LogHub,
  recoverySecret: Uint8Array,
): Promise<TestPeer> {
  let dying = true
  const journal = createMemoryCommitJournal({
    onMarkAccepted: () => {
      if (!dying) return
      dying = false
      throw new Error('the process died here')
    },
  })
  const alice = makeMLSPeer(hub, 'alice', recoverySecret, { journal })
  await flush()

  await expect(alice.peer.commit(buildInviteCommit(alice, 'dave'))).rejects.toThrow(
    'the process died here',
  )
  await alice.peer.dispose()
  return alice
}

/**
 * The acceptance was recorded, and the process died before the host adopted. The slot carries
 * the sequenceID the commit landed as, so a restart adopts straight out of it — no republish,
 * no dedup record, no network at all.
 */
async function crashBeforeTheHostAdopted(
  hub: LogHub,
  recoverySecret: Uint8Array,
): Promise<TestPeer> {
  const alice = makeMLSPeer(hub, 'alice', recoverySecret)
  await flush()

  const build = buildInviteCommit(alice, 'dave')
  await expect(
    alice.peer.commit(async () => ({
      ...(await build()),
      onAccepted: async () => {
        throw new Error('the process died here')
      },
    })),
  ).rejects.toThrow('the process died here')
  await alice.peer.dispose()
  return alice
}

/**
 * The restart: a new peer over the same durable state — the same handle, the same journal.
 * `adoptJournalled` is the restart half of `onAccepted`, and for an invite it is where the
 * Welcome goes out: the peer never had one and cannot produce one, so a host that adopts the
 * handle and stops there has added a member and never told them.
 */
function restart(hub: LogHub, recoverySecret: Uint8Array, seed: TestPeer): TestPeer {
  return makeMLSPeer(hub, 'alice', recoverySecret, {
    mls: seed.mls,
    crypto: seed.crypto,
    journal: seed.journal,
    welcomes: seed.welcomes,
    adoptJournalled: (blob) => {
      adoptJournalledBlob(seed.mls, blob)
      seed.welcomes.push('dave')
    },
    // Short, so a peer that DOES go looking for a responder that cannot exist gives up fast
    // rather than holding the lane for the default half-minute. It changes nothing on the path
    // where no heal is requested at all, which is the path under test.
    recovery: { timeoutMs: 100, deadlineMs: 300 },
  })
}

/**
 * The group of one is alive, and it got there without asking anybody. Every clause is
 * load-bearing, and the first most of all: a `recover()` with no responder RESOLVES — it has
 * a deadline, and a timeout is not an exception — so "the group converged" and "no error was
 * raised" are both true of a peer that was bricked and got lucky. The only thing that
 * separates recovery from luck is that the rendezvous was never asked.
 */
async function expectRecoveredFromTheJournalAlone(
  hub: FakeHub,
  recoverySecret: Uint8Array,
  restarted: TestPeer,
): Promise<void> {
  expect(rendezvousFrames(hub, recoverySecret)).toHaveLength(0)
  expect(restarted.welcomes).toEqual(['dave'])
  expect(restarted.mls.epoch()).toBe(2)
  expect(restarted.journal.slot()).toBeNull()
  // The store recognised the publishID and appended nothing: one frame, not two.
  expect(commitFrames(hub, recoverySecret)).toHaveLength(1)

  // And it can still commit. A group that cannot take a second commit is not alive; it is a
  // corpse at the right epoch.
  const token = 'signed-token: dave is an admin'
  expect(await restarted.peer.commit(buildLedgerCommit(restarted, [token]))).toEqual({})
  expect(restarted.mls.epoch()).toBe(3)
  expect(restarted.mls.ledgerIDs()).toEqual([memoryEntryID(token)])
  expect(commitFrames(hub, recoverySecret)).toHaveLength(2)
  expect(rendezvousFrames(hub, recoverySecret)).toHaveLength(0)
}

describe('the group of one survives the crash on its first commit', () => {
  test('the hub took the commit and the process died before the acceptance was recorded: the journal republishes, and nobody is asked', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x41)
    const commits = commitTopic(recoverySecret)

    const seed = await crashBeforeTheAcceptanceWasRecorded(hub, recoverySecret)
    expect(seed.journal.slot()?.acceptedAs).toBeUndefined() // the outcome was never learned
    expect(seed.mls.epoch()).toBe(1) // and the host never adopted: the record lands first
    expect(seed.welcomes).toEqual([]) // Dave was added to the tree and never told

    // The frame the restarting peer is about to read: its own un-merged commit, in the log,
    // with no other member in existence to heal from.
    const log = await hub.fetchTopic({ subscriberDID: 'alice', topicID: commits })
    expect(log.messages).toHaveLength(1)

    const pulled: Array<string> = []
    const restarted = restart(recordingHub(hub, commits, pulled), recoverySecret, seed)
    await flush()

    // The journal is settled at step 0 of the seed, strictly ahead of the pull, and the cursor
    // it leaves behind carries the pull over this peer's own frame. The pull reads NOTHING —
    // which is why the own-unmerged row, whose only repair is a heal from a group of one, is
    // never reached.
    expect(pulled).toEqual([])
    await expectRecoveredFromTheJournalAlone(hub, recoverySecret, restarted)

    await restarted.peer.dispose()
  })

  test('the log is trimmed before the restart: replay still returns the original sequenceID, and the peer still adopts', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x42)
    const commits = commitTopic(recoverySecret)

    const seed = await crashBeforeTheAcceptanceWasRecorded(hub, recoverySecret)
    expect(seed.journal.slot()?.acceptedAs).toBeUndefined()

    // The hub sweeps the log past its retention while the creator is down. Nothing about the
    // commit survives except what the hub remembers of the publishID that carried it.
    sweepCommitLog(hub, recoverySecret)
    const log = await hub.fetchTopic({ subscriberDID: 'alice', topicID: commits })
    expect(log.messages).toEqual([])
    expect(log.oldest).toBeNull()
    expect(log.head).not.toBeNull() // the head outlives the frame it names

    const pulled: Array<string> = []
    const restarted = restart(recordingHub(hub, commits, pulled), recoverySecret, seed)
    await flush()

    // The republish is answered out of the dedup record alone — the frame it named is gone.
    expect(pulled).toEqual([])
    await expectRecoveredFromTheJournalAlone(hub, recoverySecret, restarted)

    await restarted.peer.dispose()
  })

  test('the acceptance was recorded and the process died before the host adopted: the peer adopts from the slot, and touches no network', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x43)
    const commits = commitTopic(recoverySecret)

    const seed = await crashBeforeTheHostAdopted(hub, recoverySecret)
    expect(seed.journal.slot()?.acceptedAs).toBeDefined() // it landed, and this peer wrote it down
    expect(seed.mls.epoch()).toBe(1)
    expect(seed.welcomes).toEqual([])

    const log = await hub.fetchTopic({ subscriberDID: 'alice', topicID: commits })
    expect(log.messages).toHaveLength(1)

    const pulled: Array<string> = []
    const restarted = restart(recordingHub(hub, commits, pulled), recoverySecret, seed)
    await flush()

    expect(pulled).toEqual([])
    await expectRecoveredFromTheJournalAlone(hub, recoverySecret, restarted)

    await restarted.peer.dispose()
  })

  test('the acceptance was recorded and the log is trimmed: the slot alone is enough, and the trim changes nothing', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x44)
    const commits = commitTopic(recoverySecret)

    const seed = await crashBeforeTheHostAdopted(hub, recoverySecret)
    expect(seed.journal.slot()?.acceptedAs).toBeDefined()

    sweepCommitLog(hub, recoverySecret)
    const log = await hub.fetchTopic({ subscriberDID: 'alice', topicID: commits })
    expect(log.messages).toEqual([])
    expect(log.oldest).toBeNull()

    const pulled: Array<string> = []
    const restarted = restart(recordingHub(hub, commits, pulled), recoverySecret, seed)
    await flush()

    // Nothing here goes near the hub's memory of the publish: the acceptance is in the slot,
    // and a trimmed log cannot change an adopt that never asked the hub anything.
    expect(pulled).toEqual([])
    await expectRecoveredFromTheJournalAlone(hub, recoverySecret, restarted)

    await restarted.peer.dispose()
  })
})
