import { describe, expect, test, vi } from 'vitest'

import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import type { RecoveryEvent } from '../src/peer.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const members = ['alice', 'bob', 'carol']
const owed = 'circle:x=Alice'

async function setup(byte: number) {
  const hub = new FakeHub()
  const rs = new Uint8Array(32).fill(byte)
  let lying = true
  const bobCrypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
  const bobMLS = createMemoryGroupMLS({
    recoverySecret: rs,
    epoch: 1,
    localDID: 'bob',
    members,
    serveLedger: (ledger) => (lying ? ledger.slice(0, ledger.length - 1) : ledger),
    onAdvance: (epoch) => bobCrypto.setEpoch(epoch),
  })
  const recovery = { timeoutMs: 40, deadlineMs: 140, getDelayMs: () => 10 }
  const bob = makeMLSPeer(hub, 'bob', rs, { mls: bobMLS, crypto: bobCrypto, members, recovery })
  await bob.peer.commit(buildLedgerCommit(bob, ['circle:x=Bob']))

  const aliceCrypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
  const aliceMLS = createMemoryGroupMLS({
    recoverySecret: rs,
    epoch: 1,
    localDID: 'alice',
    members,
    onAdvance: (epoch) => aliceCrypto.setEpoch(epoch),
  })
  aliceMLS.adopt(aliceMLS.buildCommit([owed]))
  const events: Array<RecoveryEvent> = []
  const alice = makeMLSPeer(hub, 'alice', rs, {
    mls: aliceMLS,
    crypto: aliceCrypto,
    members,
    recovery,
    onRecovery: (event) => {
      events.push(event)
    },
  })
  const recoveryRequests = () =>
    hub.published.filter(
      (m) =>
        m.topicID === rendezvousTopic(rs) &&
        m.senderDID === 'alice' &&
        decodeHandshakeFrame(m.payload).kind === HANDSHAKE_KIND.recoveryRequest,
    ).length
  return {
    hub,
    rs,
    bob,
    alice,
    events,
    recoveryRequests,
    stopLying: () => {
      lying = false
    },
  }
}

describe('delayed ledger bootstrap', () => {
  test('replay finalizes an earlier attempt and returns its owed entry exactly once', async () => {
    const state = await setup(0xc1)
    const { alice, bob, events } = state
    expect(await alice.peer.recover()).toEqual({ advanced: false, reenact: [] })
    expect(events.map((e) => e.phase)).toEqual(['started', 'failed'])
    expect(events[1]).toMatchObject({ reason: 'bootstrap-failed' })
    const attemptID = events[0]?.attemptID
    state.stopLying()
    expect(await alice.peer.replay()).toEqual({ reenact: [owed] })
    expect(events[2]).toMatchObject({ phase: 'bootstrapped', attemptID, trigger: 'consumer' })
    expect(await alice.peer.replay()).toEqual({})
    expect(events.filter((e) => e.phase === 'bootstrapped')).toHaveLength(1)
    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('a second rejoin keeps the first snapshot and supersedes its pending bootstrap', async () => {
    const state = await setup(0xc2)
    const { hub, rs, alice, bob, events } = state
    expect(await alice.peer.recover()).toEqual({ advanced: false, reenact: [] })
    const original = hub.publish.bind(hub)
    hub.publish = async (params) => {
      if (
        params.topicID === rendezvousTopic(rs) &&
        params.senderDID === 'alice' &&
        decodeHandshakeFrame(params.payload).kind === HANDSHAKE_KIND.recoveryRequest
      ) {
        state.stopLying()
      }
      return original(params)
    }
    expect(await alice.peer.recover()).toEqual({ advanced: true, reenact: [owed] })
    expect(events.map((e) => e.phase)).toEqual(['started', 'failed', 'started', 'succeeded'])
    expect(events.filter((e) => e.phase === 'bootstrapped')).toHaveLength(0)
    expect(await alice.peer.replay()).toEqual({})
    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('after two failed bootstraps the later attempt owns delayed completion', async () => {
    const state = await setup(0xc5)
    const { alice, bob, events } = state
    expect(await alice.peer.recover()).toEqual({ advanced: false, reenact: [] })
    const firstID = events[0]?.attemptID
    expect(await alice.peer.recover()).toEqual({ advanced: false, reenact: [] })
    const secondID = events[2]?.attemptID
    expect(secondID).not.toBe(firstID)
    state.stopLying()
    expect(await alice.peer.replay()).toEqual({ reenact: [owed] })
    expect(events.map((e) => e.phase)).toEqual([
      'started',
      'failed',
      'started',
      'failed',
      'bootstrapped',
    ])
    expect(events[4]).toMatchObject({ attemptID: secondID, trigger: 'consumer' })
    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('a wakeup finalizes bootstrap without a redundant rejoin', async () => {
    const state = await setup(0xc3)
    const { hub, rs, alice, bob, events, recoveryRequests } = state
    expect(await alice.peer.recover()).toEqual({ advanced: false, reenact: [] })
    const requestsBefore = recoveryRequests()
    state.stopLying()
    await hub.publish({ senderDID: 'zoe', topicID: commitTopic(rs), payload: new Uint8Array([0]) })
    await vi.waitFor(() => expect(events.map((e) => e.phase)).toContain('bootstrapped'))
    expect((await alice.peer.replay()).reenact).toEqual([owed])
    expect(recoveryRequests()).toBe(requestsBefore)
    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('a new strand in the bootstrap wakeup still starts a heal', async () => {
    const state = await setup(0xc4)
    const { hub, rs, alice, bob, events, recoveryRequests } = state
    expect(await alice.peer.recover()).toEqual({ advanced: false, reenact: [] })
    const requestsBefore = recoveryRequests()
    state.stopLying()
    await publishCommit({
      hub,
      senderDID: 'bob',
      committerDID: 'zoe',
      recoverySecret: rs,
      epoch: alice.mls.epoch() + 2,
    })
    await vi.waitFor(() => expect(events.map((e) => e.phase)).toContain('bootstrapped'))
    await vi.waitFor(() => expect(recoveryRequests()).toBeGreaterThan(requestsBefore))
    await alice.peer.dispose()
    await bob.peer.dispose()
  })
})
