import { encodeEventFrame } from '@kumiai/broadcast'
import { afterEach, expect, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import { digestAppliedCommit } from '../src/classify.js'
import { forkEventID, recoveryUnavailableEventID, type SafetyHold } from '../src/control/safety.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { asLogPosition } from '../src/cursor.js'
import { GroupSafetyHeldError, SendNotAdmissibleError } from '../src/errors.js'
import { encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { encodeLedgerRequest, encodeRecoveryRequest } from '../src/recovery.js'
import { APP_TOPIC_LABEL, commitTopic, protocolTopic, rendezvousTopic } from '../src/topic.js'
import { encodeSignedRecoveryConfirmation, publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, type FakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS, encodeMemoryCommit } from './fixtures/memory-group-mls.js'
import { buildRejoinRecord, makeMLSPeer, type TestPeer } from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0x71)
const reasons = ['fork-halted', 'recovery-unavailable'] as const
const peers: Array<TestPeer> = []
afterEach(async () => {
  for (const { peer } of peers.splice(0)) {
    await peer.dispose()
    await peer.drained()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function safetySource(initial: SafetyHold = null) {
  let held = initial
  const listeners = new Set<(reason: NonNullable<SafetyHold>) => void>()
  return {
    listeners,
    subscribe(latch: (reason: NonNullable<SafetyHold>) => void) {
      listeners.add(latch)
      if (held !== null) latch(held)
      return () => {
        listeners.delete(latch)
      }
    },
    hold(reason: NonNullable<SafetyHold>) {
      held ??= reason
      for (const latch of listeners) latch(held)
    },
  }
}

function member(hub: FakeHub | DurableFakeHub, source = safetySource(), crypto?: FakeCrypto) {
  const mls = createMemoryGroupMLS({
    epoch: 1,
    localDID: 'alice',
    members: ['alice', 'bob'],
    recoverySecret: secret,
    onSafetyHold: source.subscribe,
  })
  const alice = makeMLSPeer(hub, 'alice', secret, {
    mls,
    crypto,
    recovery: { getDelayMs: () => 20, timeoutMs: 100, deadlineMs: 1000 },
  })
  peers.push(alice)
  return { alice, source }
}

test.each(reasons)(
  'late %s subscription gates startup before readiness and unregisters on dispose',
  async (reason) => {
    const source = safetySource(reason)
    const hub = new FakeHub()
    const { alice } = member(hub, source)
    const exportSecret = vi.spyOn(alice.crypto, 'exportSecret')
    const fetch = vi.spyOn(hub, 'fetchTopic')
    await alice.peer.replay()
    expect(source.listeners.size).toBe(1)
    await expect(alice.peer.resync()).rejects.toEqual(new GroupSafetyHeldError(reason))
    expect(exportSecret).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    await alice.peer.dispose()
    await alice.peer.drained()
    expect(source.listeners.size).toBe(0)
  },
)

test('a source incarnation hold cannot latch the destination peer', async () => {
  const source = safetySource()
  const destination = safetySource()
  const { alice } = member(new FakeHub(), destination)
  await alice.peer.replay()
  source.hold('fork-halted')
  await alice.peer.protocol('chat').dispatch('chat/posted', { data: { destination: true } })
  expect(await alice.appOutbox.list()).toHaveLength(1)
  destination.hold('recovery-unavailable')
  await expect(alice.peer.protocol('chat').dispatch('chat/posted', { data: {} })).rejects.toEqual(
    new SendNotAdmissibleError('recovery-unavailable'),
  )
})

test.each(reasons)(
  'a %s sink during destination ledger check stops anchor crypto',
  async (reason) => {
    const hub = new FakeHub()
    const { alice, source } = member(hub)
    await alice.peer.replay()
    await alice.peer.dispose()
    await alice.peer.drained()
    const record = {
      ...(await buildRejoinRecord(alice)),
      stage: 'adopted' as const,
      position: asLogPosition('installed'),
    }
    const destinationKey = { ...record.source.key, incarnation: 2 }
    const readSource = alice.mls.readRecoverySource.bind(alice.mls)
    vi.spyOn(alice.mls, 'readRecoverySource').mockImplementation(async () => ({
      ...(await readSource()),
      key: destinationKey,
    }))
    const stored = await alice.anchorStore.load()
    if (stored === null) throw new Error('Missing anchor')
    await alice.anchorStore.save({
      ...stored,
      pending: {
        epochBefore: 0,
        epochAfter: 1,
        rosterBefore: ['alice', 'bob'],
        forced: true,
        advance: 'installed',
        landed: true,
      },
    })
    const complete = alice.mls.isLedgerComplete.bind(alice.mls)
    vi.spyOn(alice.mls, 'isLedgerComplete').mockImplementationOnce(async () => {
      const result = await complete()
      source.hold(reason)
      return result
    })
    const roster = vi.spyOn(alice.mls, 'rosterEntries')
    const exportSecret = vi.spyOn(alice.crypto, 'exportSecret')
    const destination = makeMLSPeer(hub, 'alice', secret, {
      mls: alice.mls,
      crypto: alice.crypto,
      anchorStore: alice.anchorStore,
      continuation: { source: record.source.key, destination: destinationKey, record },
      completion: async () => {},
    })
    peers.push(destination)
    await destination.peer.replay()
    expect(destination.controlWalk.safetyHold()).toBe(reason)
    expect(roster).not.toHaveBeenCalled()
    expect(exportSecret).not.toHaveBeenCalled()
  },
)

test.each(reasons)(
  'a %s sink stops the next crypto handoff after suspended fetch without refresh',
  async (reason) => {
    const hub = new DurableFakeHub()
    const { alice, source } = member(hub)
    await alice.peer.replay()
    hub.detach('alice')
    await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: 1 })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const fetch = hub.fetchTopic.bind(hub)
    vi.spyOn(hub, 'fetchTopic').mockImplementationOnce(async (params) => {
      const result = await fetch(params)
      entered.resolve()
      await release.promise
      return result
    })
    const header = vi.spyOn(alice.mls, 'readCommitHeader')
    const replay = alice.controlWalk.reconcileCommitPrefix()
    try {
      await entered.promise
      source.hold(reason)
      alice.database.failNext('mid-apply')
      await expect(
        alice.control.apply(
          reason === 'fork-halted'
            ? {
                forkHalt: {
                  eventID: forkEventID(alice.control.key),
                  evidence: {
                    kind: 'unexplained-own-commit',
                    epoch: 1,
                    position: 'host',
                    digest: 'local-evidence',
                  },
                  detectedAt: 1,
                },
              }
            : {
                recoveryUnavailable: {
                  ...alice.control.key,
                  id: recoveryUnavailableEventID(alice.control.key),
                  kind: 'group:recovery-unavailable',
                  reason: 'trust-unreadable',
                },
              },
          'failed-host-safety',
        ),
      ).rejects.toThrow()
      expect((await alice.control.load()).forkHalt).toBeNull()
      expect((await alice.control.load()).recoveryUnavailable).toBeNull()
      release.resolve()
      await replay
      expect(header).not.toHaveBeenCalled()
      expect(alice.mls.epoch()).toBe(1)
    } finally {
      release.resolve()
      await replay
    }
  },
)

test.each(reasons)(
  'a %s sink during app seal preserves queued work without publishing',
  async (reason) => {
    const hub = new FakeHub()
    const { alice, source } = member(hub)
    await alice.peer.replay()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const wrap = alice.crypto.wrap.bind(alice.crypto)
    vi.spyOn(alice.crypto, 'wrap').mockImplementationOnce(async (...args) => {
      const sealed = await wrap(...args)
      entered.resolve()
      await release.promise
      return sealed
    })
    const publish = vi.spyOn(hub, 'publish')
    await alice.peer.protocol('chat').dispatch('chat/posted', { data: { queued: true } })
    try {
      await entered.promise
      source.hold(reason)
      release.resolve()
      await vi.waitFor(() => expect(alice.controlWalk.safetyHold()).toBe(reason))
      await alice.peer.replay()
      expect(publish).not.toHaveBeenCalled()
      expect(await alice.appOutbox.list()).toHaveLength(1)
    } finally {
      release.resolve()
    }
  },
)

test.each(reasons)(
  'a %s sink during body open allows completion but no second open',
  async (reason) => {
    const hub = new DurableFakeHub()
    const records = new Map<string, PendingAppFrame>()
    const reader = createFakeCrypto({
      localDID: 'alice',
      pending: {
        persistOpened: async (_state, record) => {
          records.set(record.frame.id, record)
        },
        list: async () => [...records.values()],
        complete: async (id) => {
          records.delete(id)
        },
      },
    })
    const { alice, source } = member(hub, safetySource(), reader)
    await alice.peer.replay()
    hub.detach('alice')
    const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
    const sender = createFakeCrypto({ localDID: 'bob' })
    for (const text of ['first', 'second'])
      await hub.publish({
        senderDID: 'bob',
        topicID,
        retain: 'log',
        payload: await sender.wrap(encodeEventFrame('chat/posted', { text }), {
          aad: encodeAppAAD({ topicID, intent: 'log' }),
        }),
      })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const open = alice.crypto.unwrap.bind(alice.crypto)
    const unwrap = vi.spyOn(alice.crypto, 'unwrap').mockImplementation(async (...args) => {
      const result = await open(...args)
      entered.resolve()
      await release.promise
      return result
    })
    await alice.peer.retryAppDelivery()
    try {
      await entered.promise
      source.hold(reason)
      release.resolve()
      await vi.waitFor(() => expect(records.size).toBe(0))
      expect(unwrap).toHaveBeenCalledOnce()
    } finally {
      release.resolve()
    }
  },
)

test.each(reasons.flatMap((reason) => ['group', 'ledger'].map((kind) => [reason, kind] as const)))(
  'a %s sink during %s responder seal prevents the reply',
  async (reason, kind) => {
    const hub = new FakeHub()
    const { alice, source } = member(hub)
    await alice.peer.replay()
    const bob = createMemoryGroupMLS({
      epoch: 1,
      localDID: 'bob',
      members: ['alice', 'bob'],
      recoverySecret: secret,
    })
    const { request } = await bob.createRecoveryRequest('suspended-reply')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const method = kind === 'group' ? 'sealGroupInfo' : 'sealLedger'
    const seal = alice.mls[method].bind(alice.mls)
    vi.spyOn(alice.mls, method).mockImplementation(async (request: Uint8Array) => {
      const result = await seal(request)
      entered.resolve()
      await release.promise
      return result
    })
    await hub.publish({
      senderDID: 'bob',
      topicID: rendezvousTopic(secret),
      payload: encodeHandshakeFrame(
        kind === 'group' ? HANDSHAKE_KIND.recoveryRequest : HANDSHAKE_KIND.ledgerRequest,
        (kind === 'group' ? encodeRecoveryRequest : encodeLedgerRequest)(
          'suspended-reply',
          request,
        ),
      ),
    })
    try {
      await entered.promise
      const publish = vi.spyOn(hub, 'publish')
      source.hold(reason)
      release.resolve()
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(publish).not.toHaveBeenCalled()
    } finally {
      release.resolve()
    }
  },
)

test.each([
  'ledger-evaluation',
  'ledger-outcome',
  'readEpoch',
  'sealRecoveryVerdict',
  'timer',
  'timer-ledger',
] as const)(
  'confirmation responder rechecks safety after %s before its next handoff',
  async (boundary) => {
    const hub = new FakeHub()
    const { alice, source } = member(hub)
    await alice.peer.replay()
    const bob = createMemoryGroupMLS({
      epoch: 1,
      localDID: 'bob',
      members: ['alice', 'bob'],
      recoverySecret: secret,
    })
    const commit = encodeMemoryCommit(1, 'bob', [], { external: true })
    // A policy refusal exercises a genuine signed ask without applying the candidate.
    let validated = false
    const validate = vi.spyOn(alice.mls, 'validateRecoveryCommit').mockImplementation(async () => {
      validated = true
      return { epoch: 1, refusal: 'policy', refusalAuthority: 'authenticated-commit' }
    })
    const { request } = await bob.createRecoveryRequest('confirmation-hold')
    const payload = encodeHandshakeFrame(
      HANDSHAKE_KIND.recoveryConfirmRequest,
      await encodeSignedRecoveryConfirmation(bob, {
        requestID: 'confirmation-hold',
        request,
        position: 'candidate',
        commitDigest: digestAppliedCommit(commit),
        commit,
      }),
    )
    const seal = vi.spyOn(alice.mls, 'sealRecoveryVerdict')
    const read = alice.mls.readEpoch.bind(alice.mls)
    const epoch = vi.spyOn(alice.mls, 'readEpoch')
    let timerArmed = false
    let latched = false
    const hold = () => {
      latched = true
      epoch.mockClear()
      source.hold('fork-halted')
    }
    vi.useFakeTimers()
    if (boundary !== 'timer') {
      if (boundary === 'sealRecoveryVerdict') {
        const seal = alice.mls.sealRecoveryVerdict.bind(alice.mls)
        vi.spyOn(alice.mls, 'sealRecoveryVerdict').mockImplementationOnce(async (...args) => {
          const result = await seal(...args)
          hold()
          return result
        })
      } else if (boundary === 'readEpoch') {
        let reconciled = false
        const fetch = hub.fetchTopic.bind(hub)
        vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
          const result = await fetch(params)
          if (params.topicID === commitTopic(secret)) reconciled = true
          return result
        })
        epoch.mockImplementation(async () => {
          const result = await read()
          if (reconciled) hold()
          return result
        })
      } else {
        const complete = alice.mls.isLedgerComplete.bind(alice.mls)
        vi.spyOn(alice.mls, 'isLedgerComplete').mockImplementation(async () => {
          const result = await complete()
          if (
            (boundary === 'ledger-evaluation' && !validated) ||
            (boundary === 'ledger-outcome' && validated) ||
            (boundary === 'timer-ledger' && timerArmed)
          )
            hold()
          return result
        })
      }
    }
    await hub.publish({ senderDID: 'bob', topicID: rendezvousTopic(secret), payload })
    await vi.advanceTimersByTimeAsync(0)
    const publish = vi.spyOn(hub, 'publish')
    timerArmed = true
    if (boundary === 'timer') {
      expect(seal).toHaveBeenCalledOnce()
      hold()
    }
    await vi.advanceTimersByTimeAsync(100)
    expect(latched).toBe(true)
    expect(publish).not.toHaveBeenCalled()
    expect(epoch).not.toHaveBeenCalled()
    if (boundary === 'ledger-evaluation' || boundary === 'readEpoch')
      expect(validate).not.toHaveBeenCalled()
    if (
      boundary === 'ledger-evaluation' ||
      boundary === 'ledger-outcome' ||
      boundary === 'readEpoch'
    )
      expect(seal).not.toHaveBeenCalled()
  },
)
