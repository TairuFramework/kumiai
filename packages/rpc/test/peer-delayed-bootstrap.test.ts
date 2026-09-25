import { BroadcastClient } from '@kumiai/broadcast'
import { describe, expect, test, vi } from 'vitest'

import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import type { RecoveryEvent, StrandObservation } from '../src/peer.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const members = ['alice', 'bob', 'carol']
const owed = 'circle:x=Alice'

async function setup(byte: number, onStrand?: (observation: StrandObservation) => void) {
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
  const recovery = { timeoutMs: 400, deadlineMs: 1200, getDelayMs: () => 10 }
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
    ...(onStrand != null ? { onStrand } : {}),
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
  test('an adopted rejoin records its commit before acceptance rejects', async () => {
    const observations: Array<StrandObservation> = []
    const state = await setup(0xcd, (observation) => {
      observations.push(observation)
    })
    const { hub, rs, alice, bob, events, recoveryRequests } = state
    hub.acceptAtAnyHead()
    vi.spyOn(bob.mls, 'processCommit').mockResolvedValue({ advanced: false })
    const competing = await publishCommit({
      hub,
      senderDID: 'carol',
      recoverySecret: rs,
      epoch: bob.mls.epoch(),
    })
    hub.hideFrom('alice', competing.sequenceID)
    hub.hideFrom('bob', competing.sequenceID)
    state.stopLying()
    const error = new Error('persist failed after adoption')
    const applyRecovery = alice.mls.applyRecovery.bind(alice.mls)
    const spy = vi.spyOn(alice.mls, 'applyRecovery').mockImplementation(async (...args) => {
      const pending = await applyRecovery(...args)
      if (pending == null) return null
      return {
        ...pending,
        onAccepted: async () => {
          await pending.onAccepted()
          throw error
        },
      }
    })
    await expect(alice.peer.recover()).rejects.toBe(error)
    spy.mockRestore()
    const requestsBefore = recoveryRequests()
    hub.revealTo('alice', competing.sequenceID)
    await alice.peer.replay()
    expect(events.map((event) => event.phase)).toContain('bootstrapped')
    await hub.publish({
      senderDID: 'zoe',
      topicID: commitTopic(rs),
      payload: new Uint8Array([0]),
    })
    await vi.waitFor(() =>
      expect(observations.map((observation) => observation.kind)).toContain('fork-losing'),
    )
    await vi.waitFor(() => expect(recoveryRequests()).toBeGreaterThan(requestsBefore))
    expect(events.some((event) => event.phase === 'bootstrapped')).toBe(true)
    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('adoption followed by an acceptance error keeps the owed snapshot', async () => {
    const state = await setup(0xc9)
    const { alice, bob, events } = state
    state.stopLying()
    const error = new Error('persist failed after adoption')
    const applyRecovery = alice.mls.applyRecovery.bind(alice.mls)
    vi.spyOn(alice.mls, 'applyRecovery').mockImplementation(async (...args) => {
      const pending = await applyRecovery(...args)
      if (pending == null) return null
      return {
        ...pending,
        onAccepted: async () => {
          await pending.onAccepted()
          throw error
        },
      }
    })

    await expect(alice.peer.recover()).rejects.toBe(error)
    expect(alice.mls.epoch()).toBe(bob.mls.epoch())
    expect(events.map((event) => event.phase)).toEqual(['started', 'failed'])
    expect(await alice.peer.replay()).toEqual({ reenact: [owed] })
    expect(await alice.peer.replay()).toEqual({})
    expect(events.map((event) => event.phase)).toEqual(['started', 'failed', 'bootstrapped'])
    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('a failed anchor save after adoption repairs the runtime before bootstrapped', async () => {
    let armFailure = false
    const state = await setup(0xca, () => {
      armFailure = true
    })
    const { alice, bob, events } = state
    state.stopLying()
    const error = new Error('anchor save failed')
    const save = alice.anchorStore.save.bind(alice.anchorStore)
    vi.spyOn(alice.anchorStore, 'save').mockImplementation(async (anchor) => {
      if (armFailure) {
        armFailure = false
        throw error
      }
      return save(anchor)
    })
    // Her own unmerged commit establishes the strand gate without stranding the responder.
    await publishCommit({
      hub: state.hub,
      senderDID: 'alice',
      committerDID: 'alice',
      recoverySecret: state.rs,
      epoch: alice.mls.epoch(),
    })
    await vi.waitFor(() => expect(events.some((event) => event.phase === 'failed')).toBe(true))
    expect(events[1]).toMatchObject({ phase: 'failed', reason: 'error', error })
    expect(await alice.peer.replay()).toEqual({ reenact: [owed] })
    expect(events.filter((event) => event.phase === 'bootstrapped')).toHaveLength(1)
    expect(alice.peer.anchorEpoch()).toBe(alice.mls.epoch())
    await expect(
      alice.peer.commit(buildLedgerCommit(alice, ['circle:y=Alice'])),
    ).resolves.toBeDefined()
    await alice.peer.dispose()
    await bob.peer.dispose()
  })
  test('replay drains the owed entry once when the post-bootstrap ledger read throws', async () => {
    const state = await setup(0xc7)
    const { alice, bob, events } = state
    state.stopLying()
    const error = new Error('transient post-bootstrap ledger read')
    const getLedger = alice.mls.getLedger.bind(alice.mls)
    let reads = 0
    const spy = vi.spyOn(alice.mls, 'getLedger').mockImplementation(async () => {
      if (++reads === 2) throw error
      return getLedger()
    })

    await expect(alice.peer.recover()).rejects.toBe(error)
    spy.mockRestore()
    expect(reads).toBe(2)
    expect(events.map((event) => event.phase)).toEqual(['started', 'failed'])
    expect(events[1]).toMatchObject({ reason: 'error', error })
    expect(await alice.peer.replay()).toEqual({ reenact: [owed] })
    expect(await alice.peer.replay()).toEqual({})
    expect(events.map((event) => event.phase)).toEqual(['started', 'failed', 'bootstrapped'])
    expect(events[2]).toMatchObject({ attemptID: events[0]?.attemptID, trigger: 'consumer' })
    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('replay drains the owed entry once when epoch rebuild throws after adoption', async () => {
    const state = await setup(0xc8)
    const { alice, bob, events } = state
    state.stopLying()
    const error = new Error('transient epoch teardown')
    const spy = vi
      .spyOn(BroadcastClient.prototype, 'dispose')
      .mockImplementationOnce(() => Promise.reject(error))

    await expect(alice.peer.recover()).rejects.toMatchObject({
      message: 'Group epoch teardown failed',
      errors: [error],
    })
    spy.mockRestore()
    expect(events.map((event) => event.phase)).toEqual(['started', 'failed'])
    expect(events[1]).toMatchObject({ reason: 'error' })
    expect(await alice.peer.replay()).toEqual({ reenact: [owed] })
    expect(await alice.peer.replay()).toEqual({})
    expect(events.map((event) => event.phase)).toEqual(['started', 'failed', 'bootstrapped'])
    expect(events[2]).toMatchObject({ attemptID: events[0]?.attemptID, trigger: 'consumer' })
    await alice.peer.dispose()
    await bob.peer.dispose()
  })

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

  test('recover queued behind a successful bootstrap sees the new generation', async () => {
    const state = await setup(0xc6)
    const { hub, rs, alice, bob, events, recoveryRequests } = state
    expect(await alice.peer.recover()).toEqual({ advanced: false, reenact: [] })
    const requestsBefore = recoveryRequests()
    state.stopLying()
    let releaseReply: () => void = () => {}
    const replyGate = new Promise<void>((resolve) => {
      releaseReply = resolve
    })
    let replyHeld = false
    const original = hub.publish.bind(hub)
    hub.publish = async (params) => {
      if (
        !replyHeld &&
        params.topicID === rendezvousTopic(rs) &&
        params.senderDID === 'bob' &&
        decodeHandshakeFrame(params.payload).kind === HANDSHAKE_KIND.ledgerReply
      ) {
        replyHeld = true
        await replyGate
      }
      return original(params)
    }
    const replay = alice.peer.replay()
    await vi.waitFor(() => expect(replyHeld).toBe(true))
    const queued = alice.peer.recover()
    releaseReply()
    expect(await replay).toEqual({ reenact: [owed] })
    expect(await queued).toEqual({ advanced: true, reenact: [] })
    expect(events.map((event) => event.phase)).toEqual(['started', 'failed', 'bootstrapped'])
    expect(recoveryRequests()).toBe(requestsBefore)
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
