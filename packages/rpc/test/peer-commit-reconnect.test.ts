import type { ProtocolDefinition } from '@enkaku/protocol'
import { describe, expect, test } from 'vitest'

import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { createGroupPeer } from '../src/peer.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { createMemoryAnchorStore } from './fixtures/anchor.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { createMemoryCommitJournal } from './fixtures/journal.js'
import { createMemoryGroupMLS, memoryEntryID } from './fixtures/memory-group-mls.js'
import { adoptJournalledBlob, makeMLSPeer } from './fixtures/peer.js'

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/** Every recovery request this group put on the wire — every time a peer asked to be healed
 *  instead of catching up by itself. */
function heals(hub: DurableFakeHub, recoverySecret: Uint8Array): Array<unknown> {
  const topic = rendezvousTopic(recoverySecret)
  return hub.published.filter((m) => {
    if (m.topicID !== topic) return false
    try {
      return decodeHandshakeFrame(m.payload).kind === HANDSHAKE_KIND.recoveryRequest
    } catch {
      return false
    }
  })
}

/** Fast rendezvous, so a heal that is going to happen happens inside the test. */
const fastRecovery = { timeoutMs: 100, getDelayMs: () => 5, deadlineMs: 300 }

const chat = {
  'chat/changed': { type: 'event', data: { type: 'object' } },
} as const satisfies ProtocolDefinition

type Protocols = { chat: typeof chat }

function makeDurablePeer(hub: DurableFakeHub, localDID: string, recoverySecret: Uint8Array) {
  const crypto = createFakeCrypto({ epoch: 1, localDID })
  const mls = createMemoryGroupMLS({
    recoverySecret,
    epoch: 1,
    onAdvance: (e) => crypto.setEpoch(e),
  })
  const peer = createGroupPeer<Protocols>({
    hub,
    crypto,
    mls,
    journal: createMemoryCommitJournal(),
    anchorStore: createMemoryAnchorStore(),
    appCursorStore: createMemoryAppCursorStore(),
    adoptJournalled: async (blob) => {
      adoptJournalledBlob(mls, blob)
    },
    localDID,
    protocols: { chat },
    handlers: { chat: {} } as never,
  })
  return { peer, crypto, mls }
}

describe('the commit lane across a disconnect', () => {
  test('a redelivered commit is not applied twice; a missed one is caught up by the pull', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x66)
    const bob = makeDurablePeer(hub, 'bob', recoverySecret)
    await flush()

    // Online: a Commit is delivered, and applied once.
    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1 })
    await flush()
    expect(bob.mls.epoch()).toBe(2)
    expect(bob.mls.commits()).toBe(1)

    // Redelivery is just another wakeup. The cursor is already past that frame, so the
    // pull returns nothing and the Commit is not applied a second time — even when the
    // hub pushes it again. Redelivery has stopped mattering for commits.
    hub.redeliver('bob')
    await flush()
    expect(bob.mls.epoch()).toBe(2)
    expect(bob.mls.commits()).toBe(1)

    // Offline: a Commit lands while bob is detached, so no push reaches him.
    hub.detach('bob')
    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 2 })
    await flush()
    expect(bob.mls.epoch()).toBe(2)

    // Back online: the next wakeup makes him pull, and he takes the missed frame from
    // the log rather than from the delivery it happens to arrive on.
    hub.reattach('bob')
    hub.redeliver('bob')
    await flush()
    expect(bob.mls.epoch()).toBe(3)
    expect(bob.mls.commits()).toBe(2)

    await bob.peer.dispose()
  })

  test('a member offline for the retention window resumes by pulling, and heals from nobody', async () => {
    const hub = new DurableFakeHub()
    const rs = new Uint8Array(32).fill(0x67)
    const topicID = commitTopic(rs)
    const bob = makeMLSPeer(hub, 'bob', rs, {
      epoch: 1,
      members: ['alice', 'bob'],
      recovery: fastRecovery,
    })
    await flush()

    // Online for the group's first enacting commit.
    const first = 'role:carol=admin'
    const landed = await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: rs,
      epoch: 1,
      entries: [first],
    })
    await flush()
    expect(bob.mls.epoch()).toBe(2)

    // Then he goes offline, and stays offline while the group enacts three more entries.
    // Nothing will ever be pushed at him for any of them: he was not there to receive them.
    hub.detach('bob')
    const second = 'role:dave=admin'
    const third = 'role:erin=member'
    const fourth = 'role:dave=member'
    const backlog = await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: rs,
      epoch: 2,
      entries: [second],
      ledgerBefore: [first],
    })
    await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: rs,
      epoch: 3,
      entries: [third],
      ledgerBefore: [first, second],
    })
    const tip = await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: rs,
      epoch: 4,
      entries: [fourth],
      ledgerBefore: [first, second, third],
    })
    await flush()
    expect(bob.mls.epoch()).toBe(2) // he heard none of it

    // The hub sweeps the log to its retention window, and bob was away for exactly the
    // window's duration: everything older than the frames he still needs is gone, and the
    // frames he needs are the OLDEST ones left. Without this the test would be about a log
    // that was simply never trimmed, and would pass against a hub that retains everything
    // forever — which is not the hub anybody runs.
    hub.trim(topicID, backlog.sequenceID)
    expect(hub.oldest(topicID)).toBe(backlog.sequenceID) // his backlog survived...
    expect(landed.sequenceID < backlog.sequenceID).toBe(true) // ...and the frame he had is gone
    expect(hub.head(topicID)).toBe(tip.sequenceID) // the head outlives the sweep

    hub.reattach('bob')
    hub.redeliver('bob')
    await flush(120)

    // He converged by READING, and the state MOVED: every commit he slept through applied,
    // the group's epoch is his, and the bodies he had never seen — each one sealed under an
    // epoch he was not at when it was published — are enacted in his ledger, in order.
    expect(bob.mls.commits()).toBe(4)
    expect(bob.mls.epoch()).toBe(5)
    expect(bob.mls.ledgerIDs()).toEqual([first, second, third, fourth].map(memoryEntryID))
    // The fold is last-write-wins by position, so this is also the order being right: dave
    // was promoted and then demoted, and a peer that applied those two entries the other way
    // round would report him an admin.
    expect(bob.mls.fold().get('role:dave')).toBe('member')

    // And he asked NOBODY for help. A member whose frames are still in the log needs no live
    // responder to rescue it: that is the whole of what the retention window buys, and a peer
    // that healed here would have spent a rendezvous, a sealed GroupInfo and an external
    // commit to learn what the log was holding for it all along.
    expect(heals(hub, rs)).toHaveLength(0)

    await bob.peer.dispose()
  })
})
