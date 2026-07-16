import { describe, expect, test } from 'vitest'
import { createGroupPeer } from '../src/peer.js'
import { commitTopic, protocolTopic, rendezvousTopic } from '../src/topic.js'
import { createMemoryAnchorStore } from './fixtures/anchor.js'
import { publishCommit } from './fixtures/commits.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryCommitJournal } from './fixtures/journal.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import {
  adoptJournalledBlob,
  buildLedgerCommit,
  chat,
  makeMLSPeer,
  type Protocols,
} from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

describe('control lane lifecycle', () => {
  test('commit and rendezvous are subscribed once at init, and survive resync and dispose', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x33)
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const mls = createMemoryGroupMLS({
      recoverySecret,
      epoch: 1,
      localDID: 'alice',
      members: ['alice', 'carol'],
      onAdvance: (e) => crypto.setEpoch(e),
    })
    const peer = createGroupPeer<Protocols>({
      hub,
      crypto,
      mls,
      journal: createMemoryCommitJournal(),
      anchorStore: createMemoryAnchorStore(),
      adoptJournalled: async (blob) => {
        adoptJournalledBlob(mls, blob)
      },
      localDID: 'alice',
      protocols: { chat },
      handlers: { chat: {} } as never,
    })
    await flush()

    const commits = commitTopic(recoverySecret)
    const rendezvous = rendezvousTopic(recoverySecret)
    expect(commits).not.toBe(rendezvous)
    // The app topic of the segment anchored at an epoch: that epoch's secret, under that epoch —
    // the pair the anchor holds, and the only pair any member is on.
    const chatTopic = (epoch: number): string =>
      protocolTopic(fakeEpochSecret(epoch), epoch, 'chat')
    expect(hub.subscriberCount(commits)).toBe(1)
    expect(hub.subscriberCount(rendezvous)).toBe(1)
    expect(hub.subscriberCount(chatTopic(1))).toBe(1)

    // A resync rebuilds the app lane onto the SAME topic — it is bound to the anchor, and a
    // resync moves no anchor — and both control topics persist.
    await peer.resync()
    await flush()

    expect(hub.subscriberCount(commits)).toBe(1)
    expect(hub.subscriberCount(rendezvous)).toBe(1)
    expect(hub.subscriberCount(chatTopic(1))).toBe(1)

    // Evicting carol is what rotates the app lane: the topic moves, both control topics stay.
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 1, removes: ['carol'] })
    await flush()

    expect(hub.subscriberCount(commits)).toBe(1)
    expect(hub.subscriberCount(rendezvous)).toBe(1)
    expect(hub.subscriberCount(chatTopic(2))).toBe(1)
    // The topic it rotated OFF is one it no longer LISTENS on — and still subscribes to. At the
    // hub, unsubscribing frees this member's undelivered frames; a peer that dropped the
    // subscription as it rotated would delete its own unread mail on the way past.
    expect(hub.subscriberCount(chatTopic(1))).toBe(1)

    // Disposing stops this process reading. It does not resign the member's subscriptions —
    // not the control topics, and not the app topics it rotated through. The hub goes on
    // holding what it has been sent, which is what lets it come back and find its mail.
    await peer.dispose()
    await flush()
    expect(hub.subscriberCount(commits)).toBe(1)
    expect(hub.subscriberCount(rendezvous)).toBe(1)
    expect(hub.subscriberCount(chatTopic(1))).toBe(1)
    expect(hub.subscriberCount(chatTopic(2))).toBe(1)
  })

  test('the commit topic is subscribed with the log retention window', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x34)
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const mls = createMemoryGroupMLS({ recoverySecret })
    const peer = createGroupPeer<Protocols>({
      hub,
      crypto,
      mls,
      journal: createMemoryCommitJournal(),
      anchorStore: createMemoryAnchorStore(),
      adoptJournalled: async (blob) => {
        adoptJournalledBlob(mls, blob)
      },
      localDID: 'alice',
      protocols: { chat },
      handlers: { chat: {} } as never,
      commitLogRetentionSeconds: 1234,
    })
    await flush()

    expect(hub.requestedRetention(commitTopic(recoverySecret))).toBe(1234)
    // The rendezvous lane is a mailbox: it takes the hub's default window.
    expect(hub.requestedRetention(rendezvousTopic(recoverySecret))).toBeUndefined()

    await peer.dispose()
  })

  test('no control subscriptions when mls is omitted', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x33)
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const peer = createGroupPeer<Protocols>({
      hub,
      crypto,
      localDID: 'alice',
      protocols: { chat },
      handlers: { chat: {} } as never,
    })
    await flush()

    expect(hub.subscriberCount(commitTopic(recoverySecret))).toBe(0)
    expect(hub.subscriberCount(rendezvousTopic(recoverySecret))).toBe(0)
    await peer.dispose()
  })

  test('a Commit advances and resyncs every receiver', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x44)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret)
    const carol = makeMLSPeer(hub, 'carol', recoverySecret)
    await flush()

    const secret = await bob.crypto.exportSecret()
    expect(hub.subscriberCount(protocolTopic(secret, 1, 'chat'))).toBe(2)

    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1 })
    await flush()

    expect(bob.mls.epoch()).toBe(2)
    expect(carol.mls.epoch()).toBe(2)
    // The Commit touched no leaf, so both rebuilt onto the topic they were already on: an
    // epoch advancing is not a reason to move the group's messages. And the topic a live-epoch
    // derivation would have moved them to — epoch 2's secret, under epoch 2 — was never reached
    // for at all.
    expect(hub.subscriberCount(protocolTopic(secret, 1, 'chat'))).toBe(2)
    expect(hub.subscriberCount(protocolTopic(fakeEpochSecret(2), 2, 'chat'))).toBe(0)

    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('a no-op Commit does not resync', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x44)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret)
    await flush()

    const secret = await bob.crypto.exportSecret()
    // A Commit with no bytes: read as a frame, but nothing a member can apply.
    await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret,
      epoch: 1,
      commit: new Uint8Array(),
    })
    await flush()

    expect(bob.mls.epoch()).toBe(1)
    expect(bob.mls.commits()).toBe(0)
    expect(hub.subscriberCount(protocolTopic(secret, 1, 'chat'))).toBe(1)

    await bob.peer.dispose()
  })

  test('an accepted commit appends to the log and resyncs the sender', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x55)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret)
    await flush()

    const secret = await alice.crypto.exportSecret()
    expect(hub.subscriberCount(protocolTopic(secret, 1, 'chat'))).toBe(2)

    // Alice builds a Commit and does NOT adopt it: the group is still at the epoch it was
    // framed at, which is the epoch its bodies must be sealed under. She adopts it in
    // onAccepted, once the hub has taken the frame.
    await alice.peer.commit(buildLedgerCommit(alice, []))
    await flush()

    // Bob pulled the Commit, advanced, and resynced; Alice rebuilt at epoch 2. Neither app
    // lane moved with them — a ledger commit touches no leaf.
    expect(bob.mls.epoch()).toBe(2)
    expect(hub.subscriberCount(protocolTopic(secret, 1, 'chat'))).toBe(2)
    expect(hub.subscriberCount(protocolTopic(secret, 2, 'chat'))).toBe(0)
    // It went to the log, not the mailbox: it moved the topic's head, so it is still
    // there for a member invited tomorrow.
    const committed = hub.published.filter((m) => m.topicID === commitTopic(recoverySecret))
    expect(committed).toHaveLength(1)
    expect(hub.head(commitTopic(recoverySecret))).toBe(committed[0].sequenceID)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('a peer without an MLS port has no commit lane to replay', async () => {
    const hub = new FakeHub()
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const peer = createGroupPeer<Protocols>({
      hub,
      crypto,
      localDID: 'alice',
      protocols: { chat },
      handlers: { chat: {} } as never,
    })
    await flush()
    await expect(peer.replay()).resolves.toEqual({})
    await peer.dispose()
  })
})
