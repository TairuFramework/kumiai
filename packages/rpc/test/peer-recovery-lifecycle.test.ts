import { describe, expect, test, vi } from 'vitest'

import { RecoveryRequiredError } from '../src/commit.js'
import { PeerDisposedError } from '../src/errors.js'
import { decodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import type { RecoveryEvent, StrandObservation } from '../src/peer.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const members = ['alice', 'bob', 'carol']
const secret = (byte: number) => new Uint8Array(32).fill(byte)
const eventsOf = (events: Array<RecoveryEvent>) => events.map((event) => event.phase)

describe('recovery lifecycle', () => {
  test.each([
    { timeoutMs: 10, deadlineMs: 100, reason: 'no-responder' },
    { timeoutMs: 100, deadlineMs: 10, reason: 'deadline' },
  ] as const)(
    'a silent rendezvous emits $reason once',
    async ({ timeoutMs, deadlineMs, reason }) => {
      // Keep the absolute deadline fixed while the real rendezvous timer runs.
      // A stalled runner cannot turn a per-request timeout into a deadline timeout.
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
      try {
        const hub = new FakeHub()
        const rs = secret(reason === 'deadline' ? 0xb1 : 0xb2)
        const events: Array<RecoveryEvent> = []
        const bob = makeMLSPeer(hub, 'bob', rs, {
          members,
          recovery: { timeoutMs, deadlineMs },
          onRecovery: (e) => {
            events.push(e)
          },
        })
        expect(await bob.peer.recover()).toEqual({ advanced: false, reenact: [] })
        expect(eventsOf(events)).toEqual(['started', 'failed'])
        expect(events[1]).toMatchObject({
          reason,
          trigger: 'consumer',
          attemptID: events[0]?.attemptID,
          groupID: commitTopic(rs),
        })
        await bob.peer.dispose()
      } finally {
        now.mockRestore()
      }
    },
  )

  test('two callers before ready join one attempt and share its result', async () => {
    const hub = new FakeHub()
    const rs = secret(0xb3)
    const events: Array<RecoveryEvent> = []
    const bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery: { timeoutMs: 10, deadlineMs: 100 },
      onRecovery: (e) => {
        events.push(e)
      },
    })
    const first = bob.peer.recover()
    const second = bob.peer.recover()
    expect(await Promise.all([first, second])).toEqual([
      { advanced: false, reenact: [] },
      { advanced: false, reenact: [] },
    ])
    expect(eventsOf(events)).toEqual(['started', 'failed'])
    await bob.peer.dispose()
  })

  test('a responder makes one consumer attempt succeed', async () => {
    const hub = new FakeHub()
    const rs = secret(0xb4)
    const carol = makeMLSPeer(hub, 'carol', rs, {
      epoch: 2,
      members,
      recovery: { getDelayMs: () => 0 },
    })
    const events: Array<RecoveryEvent> = []
    const bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery: { timeoutMs: 100, deadlineMs: 300 },
      onRecovery: (e) => {
        events.push(e)
      },
    })
    expect((await bob.peer.recover()).advanced).toBe(true)
    expect(eventsOf(events)).toEqual(['started', 'succeeded'])
    expect(events[1]).toMatchObject({ trigger: 'consumer', attemptID: events[0]?.attemptID })
    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('automatic heal emits its own trigger and closes the strand episode', async () => {
    const hub = new FakeHub()
    const rs = secret(0xb5)
    const first = await publishCommit({ hub, senderDID: 'zoe', recoverySecret: rs, epoch: 3 })
    hub.hideFrom('carol', first.sequenceID)
    const carol = makeMLSPeer(hub, 'carol', rs, {
      epoch: 3,
      members,
      recovery: { getDelayMs: () => 0 },
    })
    const events: Array<RecoveryEvent> = []
    const strands: Array<StrandObservation> = []
    const bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery: { timeoutMs: 100, deadlineMs: 300, getDelayMs: () => 0 },
      onRecovery: (e) => {
        events.push(e)
      },
      onStrand: (o) => {
        strands.push(o)
      },
    })
    await vi.waitFor(() => expect(eventsOf(events)).toEqual(['started', 'succeeded']))
    expect(events[0]).toMatchObject({ trigger: 'automatic', groupID: commitTopic(rs) })
    expect(strands).toHaveLength(1)
    const next = await publishCommit({
      hub,
      senderDID: 'zoe',
      recoverySecret: rs,
      epoch: bob.mls.epoch() + 1,
    })
    await vi.waitFor(() => expect(strands).toHaveLength(2))
    expect(strands[1]?.position).toBe(next.sequenceID)
    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('publish failure reports error and rejects the shared attempt', async () => {
    const hub = new FakeHub()
    const rs = secret(0xb6)
    const error = new Error('publish refused')
    const original = hub.publish.bind(hub)
    hub.publish = async (params) => {
      if (
        params.topicID === rendezvousTopic(rs) &&
        decodeHandshakeFrame(params.payload).kind === HANDSHAKE_KIND.recoveryRequest
      )
        throw error
      return original(params)
    }
    const events: Array<RecoveryEvent> = []
    const bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      onRecovery: (e) => {
        events.push(e)
      },
    })
    const first = bob.peer.recover()
    const second = bob.peer.recover()
    expect((await Promise.allSettled([first, second])).map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
    ])
    expect(eventsOf(events)).toEqual(['started', 'failed'])
    expect(events[1]).toMatchObject({ reason: 'error', error })
    await bob.peer.dispose()
  })

  test('a new ledger entry after a failed pre-adoption attempt is reenacted once', async () => {
    const hub = new FakeHub()
    const rs = secret(0xcb)
    const bob = makeMLSPeer(hub, 'bob', rs, { epoch: 2, members })
    const alice = makeMLSPeer(hub, 'alice', rs, { members })
    const original = hub.publish.bind(hub)
    let failRejoin = true
    hub.publish = async (params) => {
      if (
        failRejoin &&
        params.topicID === commitTopic(rs) &&
        params.senderDID === 'alice' &&
        params.retain === 'log'
      ) {
        failRejoin = false
        throw new Error('rejoin publish failed')
      }
      return original(params)
    }
    await expect(alice.peer.recover()).rejects.toThrow('rejoin publish failed')
    const newer = 'circle:new=Alice'
    await alice.peer.commit(buildLedgerCommit(alice, [newer]))
    expect(await alice.peer.recover()).toEqual({ advanced: true, reenact: [newer] })
    expect(await alice.peer.replay()).toEqual({})
    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('recover called synchronously from a terminal observer starts a new attempt', async () => {
    const hub = new FakeHub()
    const rs = secret(0xcc)
    const events: Array<RecoveryEvent> = []
    let retry: Promise<{ advanced: boolean; reenact: Array<string> }> | undefined
    let bob: ReturnType<typeof makeMLSPeer>
    bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery: { timeoutMs: 10, deadlineMs: 100 },
      onRecovery: (event) => {
        events.push(event)
        if (event.phase === 'failed' && retry == null) retry = bob.peer.recover()
      },
    })
    expect(await bob.peer.recover()).toEqual({ advanced: false, reenact: [] })
    expect(await retry).toEqual({ advanced: false, reenact: [] })
    expect(eventsOf(events)).toEqual(['started', 'failed', 'started', 'failed'])
    expect(events[0]?.attemptID).not.toBe(events[2]?.attemptID)
    await bob.peer.dispose()
  })

  test('dispose during rendezvous reports disposed and rejects', async () => {
    const hub = new FakeHub()
    const rs = secret(0xb7)
    const events: Array<RecoveryEvent> = []
    const bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery: { timeoutMs: 5000, deadlineMs: 10000 },
      onRecovery: (e) => {
        events.push(e)
      },
    })
    const attempt = bob.peer.recover()
    await vi.waitFor(() =>
      expect(hub.published.some((m) => m.topicID === rendezvousTopic(rs))).toBe(true),
    )
    await bob.peer.dispose()
    await expect(attempt).rejects.toBeInstanceOf(PeerDisposedError)
    expect(eventsOf(events)).toEqual(['started', 'failed'])
    expect(events[1]).toMatchObject({ reason: 'disposed' })
  })

  test('started reaches the host while rendezvous is still pending', async () => {
    const hub = new FakeHub()
    const rs = secret(0xcf)
    const events: Array<RecoveryEvent> = []
    const bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery: { timeoutMs: 5000, deadlineMs: 10000 },
      onRecovery: (event) => {
        events.push(event)
      },
    })
    const attempt = bob.peer.recover()
    await vi.waitFor(() =>
      expect(hub.published.some((m) => m.topicID === rendezvousTopic(rs))).toBe(true),
    )
    await vi.waitFor(() => expect(eventsOf(events)).toEqual(['started']))
    await bob.peer.dispose()
    await expect(attempt).rejects.toBeInstanceOf(PeerDisposedError)
    expect(eventsOf(events)).toEqual(['started', 'failed'])
  })

  test('dispose after accepted recovery publish prevents adoption', async () => {
    const hub = new FakeHub()
    const rs = secret(0xd0)
    const carol = makeMLSPeer(hub, 'carol', rs, {
      epoch: 2,
      members,
      recovery: { getDelayMs: () => 0 },
    })
    const bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery: { timeoutMs: 5000, deadlineMs: 10000 },
    })
    const accepted = hub.publish.bind(hub)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let published = false
    hub.publish = async (params) => {
      const result = await accepted(params)
      if (
        params.topicID === commitTopic(rs) &&
        params.senderDID === 'bob' &&
        params.retain === 'log'
      ) {
        published = true
        await gate
      }
      return result
    }
    const readHeader = vi.spyOn(bob.mls, 'readCommitHeader')
    const attempt = bob.peer.recover().catch((error: unknown) => error)
    await vi.waitFor(() => expect(published).toBe(true))
    const readsAtPublish = readHeader.mock.calls.length
    const disposal = bob.peer.dispose()
    release()
    await disposal
    expect(await attempt).toBeInstanceOf(PeerDisposedError)
    expect(readHeader).toHaveBeenCalledTimes(readsAtPublish)
    expect(bob.mls.epoch()).toBe(1)
    await carol.peer.dispose()
  })

  test('dispose settles a ledger gather and clears its deadline timer', async () => {
    const hub = new FakeHub()
    const rs = secret(0xce)
    const timing = { timeoutMs: 5000, deadlineMs: 10000, getDelayMs: () => 0 }
    const bobCrypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    const bobMLS = createMemoryGroupMLS({
      recoverySecret: rs,
      epoch: 1,
      localDID: 'bob',
      members,
      serveLedger: (ledger) => ledger.slice(0, ledger.length - 1),
      onAdvance: (epoch) => bobCrypto.setEpoch(epoch),
    })
    const bob = makeMLSPeer(hub, 'bob', rs, {
      mls: bobMLS,
      crypto: bobCrypto,
      members,
      recovery: timing,
    })
    await bob.peer.commit(buildLedgerCommit(bob, ['role:alice=admin']))
    const events: Array<RecoveryEvent> = []
    const alice = makeMLSPeer(hub, 'alice', rs, {
      members,
      recovery: timing,
      onRecovery: (event) => {
        events.push(event)
      },
    })
    const setTimer = vi.spyOn(globalThis, 'setTimeout')
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout')
    const attempt = alice.peer.recover().then(
      () => 'resolved',
      (error: unknown) => error,
    )
    await vi.waitFor(() =>
      expect(
        hub.published.some(
          (message) =>
            message.topicID === rendezvousTopic(rs) &&
            message.senderDID === 'alice' &&
            decodeHandshakeFrame(message.payload).kind === HANDSHAKE_KIND.ledgerRequest,
        ),
      ).toBe(true),
    )
    const gatherTimerIndex = setTimer.mock.calls.findLastIndex((call) => (call[1] ?? 0) > 8000)
    expect(gatherTimerIndex).toBeGreaterThanOrEqual(0)
    const gatherTimer = setTimer.mock.results[gatherTimerIndex]?.value
    await alice.peer.dispose()
    let promptTimer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      attempt,
      new Promise((resolve) => {
        promptTimer = setTimeout(() => resolve('still gathering'), 200)
      }),
    ])
    clearTimeout(promptTimer)
    expect(outcome).toBeInstanceOf(PeerDisposedError)
    expect(eventsOf(events)).toEqual(['started', 'failed'])
    expect(events[1]).toMatchObject({ reason: 'disposed' })
    expect(clearTimer).toHaveBeenCalledWith(gatherTimer)
    setTimer.mockRestore()
    clearTimer.mockRestore()
    await bob.peer.dispose()
  })

  test('an automatic attempt and consumer call share one terminal event', async () => {
    const hub = new FakeHub()
    const rs = secret(0xb8)
    await publishCommit({ hub, senderDID: 'zoe', recoverySecret: rs, epoch: 3 })
    const events: Array<RecoveryEvent> = []
    const bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery: { timeoutMs: 100, deadlineMs: 200 },
      onRecovery: (e) => {
        events.push(e)
      },
    })
    await vi.waitFor(() =>
      expect(hub.published.some((m) => m.topicID === rendezvousTopic(rs))).toBe(true),
    )
    expect(await bob.peer.recover()).toEqual({ advanced: false, reenact: [] })
    expect(eventsOf(events)).toEqual(['started', 'failed'])
    expect(events[0]).toMatchObject({ trigger: 'automatic' })
    await bob.peer.dispose()
  })

  test('throwing and rejecting observers cannot change the recovery result', async () => {
    const hub = new FakeHub()
    const rs = secret(0xb9)
    const carol = makeMLSPeer(hub, 'carol', rs, {
      epoch: 2,
      members,
      recovery: { getDelayMs: () => 0 },
    })
    const events: Array<RecoveryEvent> = []
    const bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery: { timeoutMs: 100, deadlineMs: 300 },
      onRecovery: (e) => {
        events.push(e)
        if (e.phase === 'started') throw new Error('observer threw')
        return Promise.reject(new Error('observer rejected'))
      },
    })
    expect((await bob.peer.recover()).advanced).toBe(true)
    expect(eventsOf(events)).toEqual(['started', 'succeeded'])
    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('bootstrap failure reports failed rather than succeeded', async () => {
    const hub = new FakeHub()
    const rs = secret(0xba)
    const carolCrypto = createFakeCrypto({ epoch: 1, localDID: 'carol' })
    const carolMLS = createMemoryGroupMLS({
      recoverySecret: rs,
      epoch: 1,
      localDID: 'carol',
      members,
      serveLedger: (ledger) => ledger.slice(0, ledger.length - 1),
      onAdvance: (epoch) => carolCrypto.setEpoch(epoch),
    })
    const carol = makeMLSPeer(hub, 'carol', rs, {
      mls: carolMLS,
      crypto: carolCrypto,
      members,
      recovery: { timeoutMs: 30, deadlineMs: 100, getDelayMs: () => 0 },
    })
    await carol.peer.commit(buildLedgerCommit(carol, ['role:alice=admin']))
    const events: Array<RecoveryEvent> = []
    const bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery: { timeoutMs: 30, deadlineMs: 100, getDelayMs: () => 0 },
      onRecovery: (e) => {
        events.push(e)
      },
    })
    expect(await bob.peer.recover()).toEqual({ advanced: false, reenact: [] })
    expect(eventsOf(events)).toEqual(['started', 'failed'])
    expect(events[1]).toMatchObject({ reason: 'bootstrap-failed' })
    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('a consumer joining automatic heal drains its owed entries once', async () => {
    const hub = new FakeHub()
    const rs = secret(0xbb)
    const carol = makeMLSPeer(hub, 'carol', rs, {
      members,
      recovery: { timeoutMs: 200, deadlineMs: 400, getDelayMs: () => 40 },
    })
    await carol.peer.commit(buildLedgerCommit(carol, ['circle:x=Carol']))
    const ahead = await publishCommit({ hub, senderDID: 'zoe', recoverySecret: rs, epoch: 3 })
    hub.hideFrom('carol', ahead.sequenceID)

    const bobCrypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    const bobMLS = createMemoryGroupMLS({
      recoverySecret: rs,
      epoch: 1,
      localDID: 'bob',
      members,
      onAdvance: (epoch) => bobCrypto.setEpoch(epoch),
    })
    bobMLS.adopt(bobMLS.buildCommit(['circle:x=Bob']))
    const events: Array<RecoveryEvent> = []
    const bob = makeMLSPeer(hub, 'bob', rs, {
      mls: bobMLS,
      crypto: bobCrypto,
      members,
      recovery: { timeoutMs: 200, deadlineMs: 400, getDelayMs: () => 40 },
      onRecovery: (e) => {
        events.push(e)
      },
    })
    await vi.waitFor(() =>
      expect(
        hub.published.some((m) => m.topicID === rendezvousTopic(rs) && m.senderDID === 'bob'),
      ).toBe(true),
    )
    const result = await bob.peer.recover()
    expect(result).toEqual({ advanced: true, reenact: ['circle:x=Bob'] })
    expect(eventsOf(events)).toEqual(['started', 'succeeded'])
    expect(events[0]).toMatchObject({ trigger: 'automatic' })
    expect((await bob.peer.replay()).reenact).toBeUndefined()
    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('started observer may dispose an attempt during rendezvous', async () => {
    const hub = new FakeHub()
    const rs = secret(0xbc)
    const carol = makeMLSPeer(hub, 'carol', rs, {
      epoch: 2,
      members,
      recovery: { getDelayMs: () => 20 },
    })
    let bob: ReturnType<typeof makeMLSPeer>
    const events: Array<RecoveryEvent> = []
    bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery: { timeoutMs: 100, deadlineMs: 300 },
      onRecovery: (event) => {
        events.push(event)
        if (event.phase === 'started') void bob.peer.dispose()
      },
    })
    await expect(bob.peer.recover()).rejects.toBeInstanceOf(PeerDisposedError)
    expect(eventsOf(events)).toEqual(['started', 'failed'])
    expect(events[1]).toMatchObject({ reason: 'disposed' })
    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('a strand observer that disposes the peer cannot change the walk result', async () => {
    const hub = new FakeHub()
    const rs = secret(0xbd)
    let bob: ReturnType<typeof makeMLSPeer>
    const strands: Array<StrandObservation> = []
    bob = makeMLSPeer(hub, 'bob', rs, {
      members,
      recovery: { timeoutMs: 10, deadlineMs: 30 },
      onStrand: (observation) => {
        strands.push(observation)
        void bob.peer.dispose()
      },
    })
    await bob.peer.replay()
    await publishCommit({ hub, senderDID: 'bob', recoverySecret: rs, epoch: 3 })
    await expect(
      bob.peer.commit(buildLedgerCommit(bob, ['role:alice=admin'])),
    ).rejects.toBeInstanceOf(RecoveryRequiredError)
    expect(strands).toHaveLength(1)
    await bob.peer.dispose()
  })
})
