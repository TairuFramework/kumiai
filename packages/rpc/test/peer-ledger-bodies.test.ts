import { fromUTF } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { encodeMemoryCommit, memoryEntryID } from '../src/memory-group-mls.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

/** Everything this group put on the wire that was NOT a commit frame: an ask of any kind
 *  — a gather on the app lane, a recovery request on the rendezvous — shows up here. */
function asksOnTheWire(hub: FakeHub, recoverySecret: Uint8Array): Array<string> {
  return hub.published.flatMap((m) =>
    m.topicID === commitTopic(recoverySecret) ? [] : [`${m.senderDID} -> ${m.topicID}`],
  )
}

/** Did the hub ever carry this body in the clear? */
function leakedBody(hub: FakeHub, token: string): boolean {
  const needle = fromUTF(token)
  return hub.published.some((m) => {
    const hay = m.payload
    for (let i = 0; i + needle.length <= hay.length; i++) {
      let hit = true
      for (let j = 0; j < needle.length; j++) {
        if (hay[i + j] !== needle[j]) {
          hit = false
          break
        }
      }
      if (hit) return true
    }
    return false
  })
}

describe('the bodies ride the commit', () => {
  test('a member that has never seen a body applies the commit that enacts it, first time, with no gather', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x21)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret)
    const carol = makeMLSPeer(hub, 'carol', recoverySecret)
    await flush()

    // Alice enacts a ledger entry. Carol has never seen this body, and nobody published it
    // ahead of the commit: it rides the commit's own frame, sealed under the epoch every
    // member that can apply that commit is at.
    const token = 'signed-token: carol is an admin'
    await alice.peer.commit(buildLedgerCommit(alice, [token]))
    await flush()

    const entryID = memoryEntryID(token)
    // Every member enacted it on first delivery of the commit.
    expect(carol.mls.ledgerIDs()).toEqual([entryID])
    expect(carol.mls.epoch()).toBe(2)
    expect(bob.mls.ledgerIDs()).toEqual([entryID])
    expect(alice.mls.ledgerIDs()).toEqual([entryID])

    // And nobody had to ask anybody for anything: the only thing on the wire is the commit.
    expect(asksOnTheWire(hub, recoverySecret)).toEqual([])
    expect(hub.published.filter((m) => m.topicID === commitTopic(recoverySecret))).toHaveLength(1)

    // The hub carried the body, and never saw it.
    expect(leakedBody(hub, token)).toBe(false)

    await alice.peer.dispose()
    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('a late joiner walks the commit that added it — a frame it can never open — and calls none of it malformed', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x22)

    // The group at epoch 0. Alice adds dave: the commit that enacts his role entry is
    // framed at epoch 0, and its bodies are sealed under epoch 0's secret.
    const daveRole = 'signed-token: dave is a member'
    await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret,
      epoch: 0,
      entries: [daveRole],
    })
    // Then, at epoch 1, she enacts another entry. Dave was a member for this one.
    const laterEntry = 'signed-token: dave is an admin'
    await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret,
      epoch: 1,
      entries: [laterEntry],
    })

    // Dave joins from the Welcome, at epoch 1, holding the history it carried — including
    // his own role entry. What he does NOT hold is the epoch-0 secret: the blob on the
    // commit that added him is sealed under the epoch before he was a member, and he can
    // never open it. He reads the whole log anyway.
    const dave = makeMLSPeer(hub, 'dave', recoverySecret, { epoch: 1, ledger: [daveRole] })
    await flush()

    // Both frames were READ as commits and handed to MLS — including the one whose blob he
    // cannot open. A frame a peer cannot open is history, not poison.
    expect(dave.mls.seen()).toBe(2)
    // He applied only the one he was at the epoch for; the other is a commit he was never
    // in a position to apply, and it is not an error that he wasn't.
    expect(dave.mls.commits()).toBe(1)
    expect(dave.mls.epoch()).toBe(2)
    // And the entry that commit enacted came out of its own frame.
    expect(dave.mls.ledgerIDs()).toEqual([memoryEntryID(laterEntry)])

    // He asked nobody for help: no heal, no gather.
    expect(asksOnTheWire(hub, recoverySecret)).toEqual([])

    await dave.peer.dispose()
  })

  test('a commit whose bodies are not in its frame does not advance the cursor, and is read again', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x23)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret)
    await flush()

    // A commit that names an entry whose body is nowhere: not in bob's ledger, and not in
    // the frame (the shape a rejoin by external commit leaves behind — its GroupInfo
    // carries no ledger). The port raises, and the lane leaves the cursor put.
    const orphan = memoryEntryID('a body nobody delivered')
    await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret,
      epoch: 1,
      commit: encodeMemoryCommit(1, [orphan]),
    })
    await flush()

    expect(bob.mls.epoch()).toBe(1)
    expect(bob.mls.commits()).toBe(0)
    expect(bob.mls.seen()).toBe(1)

    // The cursor did not move, so the next wakeup reads that same frame again — the lane
    // retries it rather than stepping over it. (What answers it is a gather from the
    // members that hold the body; the peer has no such ask yet.)
    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1 })
    await flush()
    expect(bob.mls.seen()).toBeGreaterThan(1)
    expect(bob.mls.epoch()).toBe(1)

    await bob.peer.dispose()
  })

  test('the hub is handed a frame it cannot read, and a peer is handed one it can', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x24)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret)
    await flush()

    const token = 'signed-token: a body'
    await alice.peer.commit(buildLedgerCommit(alice, [token]))
    await flush()

    const published = hub.published.filter((m) => m.topicID === commitTopic(recoverySecret))
    expect(published).toHaveLength(1)
    // What the hub holds is a commit frame: the commit in the clear (MLS is its own
    // envelope) and a blob it has no key for.
    const frame = decodeHandshakeFrame(published[0].payload)
    expect(frame.kind).toBe(HANDSHAKE_KIND.commit)
    expect(leakedBody(hub, token)).toBe(false)
    // Nothing was published on the rendezvous: enacting an entry is not a recovery.
    expect(hub.published.some((m) => m.topicID === rendezvousTopic(recoverySecret))).toBe(false)

    await alice.peer.dispose()
  })

  test('a build() that adopts cannot seal the bodies, and is told so', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x25)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret)
    await flush()

    const token = 'signed-token: a body'
    // A commit is adopted in onAccepted and nowhere else. A build() that adopts has rotated
    // the group past the epoch its own commit is framed at, so its bodies can no longer be
    // sealed for the members about to receive it — and a blob no member can open looks
    // exactly like a healthy commit until the first receiver fails to resolve it.
    await expect(
      alice.peer.commit(async () => {
        const commit = alice.mls.buildCommit([token])
        alice.mls.adopt(commit)
        return {
          commit,
          bodies: [token],
          kind: 'ledger' as const,
          journal: commit,
          onAccepted: async () => {},
        }
      }),
    ).rejects.toThrow(/already advanced past the epoch/)

    await alice.peer.dispose()
  })
})
