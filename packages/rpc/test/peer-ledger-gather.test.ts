import { fromUTF } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { decodeHandshakeFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { decodeLedgerReply, encodeLedgerRequest } from '../src/recovery.js'
import { rendezvousTopic } from '../src/topic.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS, memoryEntryID } from './fixtures/memory-group-mls.js'
import { buildLedgerCommit, buildRemoveCommit, makeMLSPeer } from './fixtures/peer.js'

const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms))

const recovery = { timeoutMs: 150, getDelayMs: () => 5, deadlineMs: 800 }
const members = ['alice', 'bob', 'carol']

/**
 * Did the hub ever carry this body in the clear? The same question `peer-ledger-bodies` asks
 * of the commit frame, asked of the heal: these are the SAME signed tokens, and the lane that
 * protects them on the way in must not hand them over on the way out.
 */
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

/** The sealed ledger replies on the wire, by the request they answer. */
function ledgerReplies(hub: FakeHub, rs: Uint8Array, requestID?: string): Array<Uint8Array> {
  const topic = rendezvousTopic(rs)
  return hub.published.flatMap((m) => {
    if (m.topicID !== topic) return []
    try {
      const frame = decodeHandshakeFrame(m.payload)
      if (frame.kind !== HANDSHAKE_KIND.ledgerReply) return []
      const reply = decodeLedgerReply(frame.payload)
      if (requestID != null && reply.requestID !== requestID) return []
      return [reply.sealed]
    } catch {
      return []
    }
  })
}

/** Put a ledger request on the rendezvous topic directly: it is public and secretless, so
 *  anyone who knows it can — the hub, a removed member, a stranger who never was one. */
async function askForTheLedger(
  hub: FakeHub,
  rs: Uint8Array,
  senderDID: string,
  requestID: string,
  request: Uint8Array,
): Promise<void> {
  await hub.publish({
    senderDID,
    topicID: rendezvousTopic(rs),
    payload: encodeHandshakeFrame(
      HANDSHAKE_KIND.ledgerRequest,
      encodeLedgerRequest(requestID, request),
    ),
  })
  await flush(120)
}

describe('the ledger gather does not hand the group to the relay', () => {
  test('the hub carries a gathered ledger, and never sees a body', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x61)

    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
    await flush()
    const role = 'role:carol=admin'
    await bob.peer.commit(buildLedgerCommit(bob, [role]))
    await flush()

    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members, recovery })
    await flush()

    const result = await alice.peer.recover()
    await flush(100)

    // MOVED STATE, not "no error was raised": the ledger is in her handle, folded, and the
    // head her own group state attests to accepts it.
    expect(result.advanced).toBe(true)
    expect(await alice.mls.isLedgerComplete()).toBe(true)
    expect(alice.mls.ledgerIDs()).toEqual([memoryEntryID(role)])
    expect(alice.mls.fold().get('role:carol')).toBe('admin')

    // The gather HAPPENED — a reply was carried — and the hub carried every byte of it
    // without seeing one.
    expect(ledgerReplies(hub, rs)).toHaveLength(1)
    expect(leakedBody(hub, role)).toBe(false)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('a stranger who mints a request gets nothing, and a member still does', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x62)

    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
    const carol = makeMLSPeer(hub, 'carol', rs, { epoch: 1, members, recovery })
    await flush()
    await bob.peer.commit(buildLedgerCommit(bob, ['role:carol=admin']))
    await flush()

    // A request from nobody: no signed blob at all, which is what the lane used to send and
    // what anyone reading the topic could have replayed.
    await askForTheLedger(hub, rs, 'mallory', 'anon-1', new Uint8Array())
    expect(ledgerReplies(hub, rs, 'anon-1')).toHaveLength(0)

    // And a request that is perfectly well-formed, minted by a DID that simply has no leaf in
    // anybody's tree. This is the one that matters: sealing without authorizing would answer
    // it, and seal the group's whole authority state neatly to the stranger's own key.
    const mallory = createMemoryGroupMLS({ recoverySecret: rs, localDID: 'mallory' })
    await askForTheLedger(
      hub,
      rs,
      'mallory',
      'anon-2',
      await mallory.createRecoveryRequest('anon-2'),
    )
    expect(ledgerReplies(hub, rs, 'anon-2')).toHaveLength(0)

    // The silence is about MALLORY, and not about a group that answers nobody: the same
    // rendezvous, asked by a DID the responders' trees do hold a leaf for, is answered twice.
    const aliceMLS = createMemoryGroupMLS({ recoverySecret: rs, localDID: 'alice' })
    await askForTheLedger(
      hub,
      rs,
      'alice',
      'member-1',
      await aliceMLS.createRecoveryRequest('member-1'),
    )
    expect(ledgerReplies(hub, rs, 'member-1')).toHaveLength(2)

    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('a removed member gets nothing from a responder that has applied the removal', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x63)

    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 1, members, recovery })
    await flush()
    await bob.peer.commit(buildLedgerCommit(bob, ['role:carol=admin']))
    await flush()

    // Carol is still in bob's tree, so bob answers her.
    const carol = createMemoryGroupMLS({ recoverySecret: rs, localDID: 'carol' })
    await askForTheLedger(hub, rs, 'carol', 'carol-1', await carol.createRecoveryRequest('carol-1'))
    expect(ledgerReplies(hub, rs, 'carol-1')).toHaveLength(1)

    // Bob commits her removal and adopts the post-commit handle: her leaf is gone from the
    // tree he authorizes against. Authorization is roster-intrinsic — nothing was configured,
    // and there is no policy for a host to forget.
    await bob.peer.commit(buildRemoveCommit(bob, 'carol'))
    await flush()
    expect(bob.mls.leaves()).not.toContain('carol')

    await askForTheLedger(hub, rs, 'carol', 'carol-2', await carol.createRecoveryRequest('carol-2'))
    expect(ledgerReplies(hub, rs, 'carol-2')).toHaveLength(0)

    await bob.peer.dispose()
  })

  test('a requester at an older epoch than the responder still bootstraps', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x64)
    const pair = ['alice', 'bob']

    // Bob is the only responder, and he withholds everything until told otherwise: alice's
    // first bootstrap fails, which leaves her REJOINED and degraded — an empty ledger against
    // a live head — which is exactly the peer that crashed between its rejoin and its gather.
    let serving = false
    let bobEpochAtReply = -1
    const bobCrypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    const bobMLS = createMemoryGroupMLS({
      recoverySecret: rs,
      epoch: 1,
      localDID: 'bob',
      members: pair,
      serveLedger: (ledger) => {
        bobEpochAtReply = bobMLS.epoch()
        return serving ? ledger : []
      },
      onAdvance: (e) => bobCrypto.setEpoch(e),
    })
    const bob = makeMLSPeer(hub, 'bob', rs, { mls: bobMLS, crypto: bobCrypto, recovery })
    await flush()
    const role = 'role:carol=admin'
    await bob.peer.commit(buildLedgerCommit(bob, [role]))
    await flush()

    const aliceCrypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const aliceMLS = createMemoryGroupMLS({
      recoverySecret: rs,
      epoch: 1,
      localDID: 'alice',
      members: pair,
      onAdvance: (e) => aliceCrypto.setEpoch(e),
    })
    const stranded = makeMLSPeer(hub, 'alice', rs, {
      mls: aliceMLS,
      crypto: aliceCrypto,
      recovery,
    })
    await flush()

    expect(await stranded.peer.recover()).toEqual({ advanced: false, reenact: [] })
    await flush(100)
    expect(await aliceMLS.isLedgerComplete()).toBe(false)
    const strandedAt = aliceMLS.epoch()
    await stranded.peer.dispose()

    // The group moves on WITHOUT changing the ledger: two commits that enact nothing. The head
    // alice's rejoined handle authenticates still stands; the epoch she authenticates it at
    // does not.
    serving = true
    await bob.peer.commit(buildLedgerCommit(bob, []))
    await bob.peer.commit(buildLedgerCommit(bob, []))
    await flush()
    expect(bobMLS.epoch()).toBeGreaterThan(strandedAt)

    // She restarts over the same handle. The lane gathers BEFORE it pulls — so she asks while
    // she is still behind, and this is the peer a reply sealed under the responder's current
    // epoch secret would strand: she does not hold that epoch's secret and never will, because
    // she is about to leave it behind by catching up.
    let aliceEpochAtBootstrap = -1
    const alice = makeMLSPeer(hub, 'alice', rs, {
      mls: {
        ...aliceMLS,
        bootstrapLedger: async (tokens) => {
          aliceEpochAtBootstrap = aliceMLS.epoch()
          await aliceMLS.bootstrapLedger(tokens)
        },
      },
      crypto: aliceCrypto,
      recovery,
    })
    await flush(200)

    // The ephemeral seal is epoch-independent, and here is the proof: she opened a reply
    // sealed by a responder two epochs ahead of the epoch she was at when she opened it.
    expect(aliceEpochAtBootstrap).toBe(strandedAt)
    expect(bobEpochAtReply).toBeGreaterThan(aliceEpochAtBootstrap)
    expect(await aliceMLS.isLedgerComplete()).toBe(true)
    expect(aliceMLS.fold().get('role:carol')).toBe('admin')
    // And nothing of it reached the hub.
    expect(leakedBody(hub, role)).toBe(false)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('a responder that withholds an entry is rejected, and the next honest reply is folded', async () => {
    const hub = new FakeHub()
    const rs = new Uint8Array(32).fill(0x65)

    // Bob answers first, and lies: he drops the last entry. Every token he serves is perfectly
    // well signed — omission is what a signature does not catch and what the head chain does.
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
      recovery: { ...recovery, getDelayMs: () => 5 },
    })
    // Carol answers second, and honestly. There is no storm-collapse on this gather precisely
    // so that she does: the requester needs a second answer to fall through to.
    const carol = makeMLSPeer(hub, 'carol', rs, {
      epoch: 1,
      members,
      recovery: { ...recovery, getDelayMs: () => 60 },
    })
    await flush()

    const entries = ['role:carol=admin', 'role:dave=member', 'role:carol=member']
    await bob.peer.commit(buildLedgerCommit(bob, entries))
    await flush()

    const alice = makeMLSPeer(hub, 'alice', rs, { epoch: 1, members, recovery })
    await flush()

    const result = await alice.peer.recover()
    await flush(150)

    // Both responders answered, and only one of them was folded.
    expect(ledgerReplies(hub, rs)).toHaveLength(2)
    expect(result.advanced).toBe(true)
    expect(await alice.mls.isLedgerComplete()).toBe(true)
    expect(alice.mls.ledgerIDs()).toEqual(entries.map(memoryEntryID))
    // The withheld entry is the DEMOTION. A bootstrap that took bob's word for it would leave
    // alice believing carol is an admin — and nothing anywhere would have raised an error.
    expect(alice.mls.fold().get('role:carol')).toBe('member')

    await alice.peer.dispose()
    await bob.peer.dispose()
    await carol.peer.dispose()
  })
})
