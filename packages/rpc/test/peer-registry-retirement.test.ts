import { expect, test, vi } from 'vitest'

import { digestAppliedCommit } from '../src/classify.js'
import { RecoveryRequiredError } from '../src/commit.js'
import type { GroupMLS } from '../src/crypto.js'
import { asLogPosition } from '../src/cursor.js'
import { SendNotAdmissibleError } from '../src/errors.js'
import { encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import type { GroupPeer } from '../src/peer-types.js'
import {
  encodeLedgerReply,
  encodeLedgerRequest,
  encodeRecoveryReply,
  encodeRecoveryRequest,
  encodeRecoveryVerdict,
} from '../src/recovery.js'
import { recoveryOnlyMLS } from '../src/recovery-only-mls.js'
import type { CapturedRejoinRecord } from '../src/recovery-types.js'
import { rendezvousTopic } from '../src/topic.js'
import { encodeSignedRecoveryConfirmation, publishCommit } from './fixtures/commits.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS, encodeMemoryCommit } from './fixtures/memory-group-mls.js'
import type { Protocols, TestPeer } from './fixtures/peer.js'
import { buildLegacyRejoinRecord, makeMLSPeer } from './fixtures/peer.js'

test('recovery-only startup never reads lost private state or opens application work', async () => {
  const hub = new FakeHub()
  const mls = createMemoryGroupMLS({ localDID: 'alice' })
  const epoch = vi.spyOn(mls, 'readEpoch').mockRejectedValue(new Error('Private state unavailable'))
  const anchor = vi.spyOn(mls, 'exportRecoverySecret')
  const member = makeMLSPeer(hub, 'alice', new Uint8Array(32).fill(8), { mls, recoveryOnly: true })
  try {
    await member.peer.replay()
    expect(epoch).not.toHaveBeenCalled()
    expect(anchor).toHaveBeenCalled()
    expect(() => member.peer.protocol('chat')).toThrow(SendNotAdmissibleError)
    expect(hub.published).toEqual([])
    expect(await member.appOutbox.list()).toEqual([])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('recovery-only construction never asks application crypto for private state', async () => {
  const crypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
  const epoch = vi.spyOn(crypto, 'epoch').mockImplementation(() => {
    throw new Error('Private crypto state unavailable')
  })
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(9), {
    crypto,
    recoveryOnly: true,
  })
  try {
    await member.peer.replay()
    expect(epoch).not.toHaveBeenCalled()
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('recovery-only peers reject new control work without saving an intent', async () => {
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(10), {
    recoveryOnly: true,
  })
  try {
    await expect(
      member.peer.enqueue({
        id: 'rotation',
        kind: 'rotation',
        revokes: false,
        body: new Uint8Array([1]),
      }),
    ).rejects.toBeInstanceOf(SendNotAdmissibleError)
    expect((await member.control.load()).operations).toEqual([])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('recovery-only startup preserves queued control intents without invoking private MLS', async () => {
  const mls = createMemoryGroupMLS({ localDID: 'alice' })
  await mls.persistInitialState()
  const intent = {
    id: 'queued',
    kind: 'rotation' as const,
    revokes: false,
    body: new Uint8Array([1]),
    stage: 'intent' as const,
    seq: 1,
    enqueuedAt: Date.now(),
    deadline: Date.now() + 30_000,
  }
  await mls.control().apply({ putOperations: [intent] }, 'queued-intent')
  const epoch = vi.spyOn(mls, 'readEpoch').mockRejectedValue(new Error('Lost private state'))
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(11), {
    mls,
    recoveryOnly: true,
  })
  try {
    await member.peer.replay()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(epoch).not.toHaveBeenCalled()
    expect((await member.control.load()).operations).toEqual([intent])
    await expect(member.peer.resync()).rejects.toBeInstanceOf(SendNotAdmissibleError)
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('recovery-only peers ignore valid signed confirmation requests without private MLS work', async () => {
  const hub = new FakeHub()
  const secret = new Uint8Array(32).fill(12)
  const member = makeMLSPeer(hub, 'alice', secret, {
    members: ['alice', 'bob'],
    recoveryOnly: true,
  })
  try {
    await member.peer.replay()
    const bob = createMemoryGroupMLS({ localDID: 'bob', members: ['alice', 'bob'] })
    const requestID = 'lost-state-confirmation'
    const { request } = await bob.createRecoveryRequest(requestID)
    const commit = encodeMemoryCommit(1, 'bob', [], { external: true })
    const payload = await encodeSignedRecoveryConfirmation(bob, {
      requestID,
      request,
      position: 'p',
      commitDigest: digestAppliedCommit(commit),
      commit,
    })
    const epoch = vi.spyOn(member.mls, 'readEpoch')
    const complete = vi.spyOn(member.mls, 'isLedgerComplete')
    const validate = vi.spyOn(member.mls, 'validateRecoveryCommit')
    const build = vi.spyOn(member, 'buildOperation')
    const fetch = vi.spyOn(hub, 'fetchTopic')
    const before = await member.control.load()
    await hub.publish({
      senderDID: 'relay',
      topicID: rendezvousTopic(secret),
      payload: encodeHandshakeFrame(HANDSHAKE_KIND.recoveryConfirmRequest, payload),
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(epoch).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
    expect(build).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(await member.control.load()).toEqual(before)
    expect(hub.published).toHaveLength(1)
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test.each(['dropAppFrame', 'reconcileCommitPrefix', 'abandon'] as const)(
  'recovery-only %s preserves confirmed recovery without private MLS or control writes',
  async (method) => {
    const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(13), {
      recoveryOnly: true,
    })
    try {
      await member.peer.replay()
      const { source, conflictEpoch: _conflict, ...saved } = await buildLegacyRejoinRecord(member)
      const record: CapturedRejoinRecord = {
        ...saved,
        format: 2,
        source: {
          key: source.key,
          identity: { ...source.key, epoch: source.epoch, authenticator: source.authenticator },
          stateVersion: 1,
          lifetimeRevision: 1,
          trust: { retained: new Uint8Array([1, 2, 3]) },
          trustDigest: 'd'.repeat(43),
        },
        target: {
          targetID: 'recovery-hub',
          topicID: 'recovery-commits',
          groupInfoEpoch: source.epoch,
          groupInfoAuthenticator: source.authenticator.slice(),
          captureHead: null,
        },
        captureHead: null,
        searchFrom: null,
        trigger: 'automatic',
        authorisationID: null,
        switchMutationID: crypto.randomUUID(),
        destinationKey: null,
        ledgerBefore: ['owed-before-recovery'],
        stage: 'confirmed' as const,
        position: asLogPosition('confirmed-recovery'),
        verdict: new Uint8Array([1]),
      }
      await member.control.apply({ putRejoin: record }, 'confirmed-recovery')
      const before = await member.control.load()
      const epoch = vi.spyOn(member.mls, 'readEpoch')
      const complete = vi.spyOn(member.mls, 'isLedgerComplete')
      const ledger = vi.spyOn(member.mls, 'getLedger')
      const writes = vi.spyOn(member.control, 'apply')
      if (method === 'reconcileCommitPrefix') {
        await expect(member.controlWalk.reconcileCommitPrefix()).resolves.toEqual({
          kind: 'incomplete',
        })
      } else {
        await expect(
          method === 'abandon'
            ? member.peer.abandon()
            : member.peer.dropAppFrame('unopened-app-topic', 'blocked-position'),
        ).rejects.toBeInstanceOf(SendNotAdmissibleError)
      }
      expect(epoch).not.toHaveBeenCalled()
      expect(complete).not.toHaveBeenCalled()
      expect(ledger).not.toHaveBeenCalled()
      expect(writes).not.toHaveBeenCalled()
      expect(await member.control.load()).toEqual(before)
    } finally {
      await member.peer.dispose()
      await member.peer.drained()
    }
  },
)

const ordinaryMLSMethods = [
  'prepareRecovery',
  'applyRecovery',
  'restoreRecovery',
  'validateRecoveryCommit',
  'verifyRecoveryRequest',
  'verifyRecoveryConfirmation',
  'confirmationKey',
  'sealRecoveryVerdict',
  'readEpoch',
  'readRecoverySource',
  'rosterEntries',
  'readCommitHeader',
  'processCommit',
  'sealGroupInfo',
  'isLedgerComplete',
  'getLedger',
  'sealLedger',
  'openSealedLedger',
  'bootstrapLedger',
] as const satisfies Array<keyof GroupMLS>

const recoveryOnlyMethods = {
  protocol: (member) => member.peer.protocol('chat'),
  retryAppDelivery: (member) => member.peer.retryAppDelivery('unopened-app-topic'),
  dropAppFrame: (member) => member.peer.dropAppFrame('unopened-app-topic', 'blocked-position'),
  enqueue: (member) =>
    member.peer.enqueue({
      id: 'new-intent',
      kind: 'rotation',
      revokes: false,
      body: new Uint8Array([1]),
    }),
  outcomes: (member) => member.peer.outcomes(),
  ack: (member) => member.peer.ack('missing-outcome'),
  abandon: (member) => member.peer.abandon(),
  commit: (member) =>
    member.peer.commit({
      id: 'new-commit',
      kind: 'rotation',
      revokes: false,
      body: new Uint8Array([1]),
    }),
  replay: (member) => member.peer.replay(),
  recover: (member) => member.peer.recover(),
  resync: (member) => member.peer.resync(),
  anchorEpoch: (member) => member.peer.anchorEpoch(),
  reauthorize: (member) => member.peer.reauthorize(),
  dispose: (member) => member.peer.dispose(),
  drained: async (member) => {
    await member.peer.dispose()
    await member.peer.drained()
  },
} satisfies Record<keyof GroupPeer<Protocols>, (member: TestPeer) => unknown>

const internalRecoveryOnlyMethods = {
  reconcileCommitPrefix: (member) => member.controlWalk.reconcileCommitPrefix(),
  walkCommits: (member) =>
    member.controlWalk.walkCommits({
      through: asLogPosition('000000000001'),
      range: null,
      work: { takeFetch: () => true, takeFrame: () => true },
    }),
  stepOperation: (member) => member.controlWalk.stepOperation('retained-intent'),
  head: (member) => member.controlWalk.head(),
  safetyHold: (member) => member.controlWalk.safetyHold(),
  replyWithCapturedGroupInfo: (member) =>
    member.controlWalk.replyWithCapturedGroupInfo({
      requestID: 'unanswered',
      request: new Uint8Array([1]),
    }),
} satisfies Partial<Record<keyof TestPeer['controlWalk'], (member: TestPeer) => unknown>>

test.each(
  Object.keys(recoveryOnlyMethods).concat(Object.keys(internalRecoveryOnlyMethods), [
    'commit-delivery',
    'recovery-request',
    'recovery-reply',
    'ledger-request',
    'ledger-reply',
    'confirmation-request',
    'recovery-verdict',
    'idle-timers',
  ]),
)('recovery-only isolation covers %s without private MLS calls', async (entry) => {
  const hub = new FakeHub()
  const secret = new Uint8Array(32).fill(14)
  const mls = createMemoryGroupMLS({
    localDID: 'alice',
    members: ['alice', 'bob'],
    recoverySecret: secret,
  })
  await mls.persistInitialState()
  await mls.control().apply(
    {
      putOperations: [
        {
          id: 'retained-intent',
          kind: 'rotation',
          revokes: false,
          body: new TextEncoder().encode(JSON.stringify({ tokens: [] })),
          stage: 'intent',
          seq: 1,
          enqueuedAt: Date.now(),
          deadline: Date.now() + 300_000,
        },
      ],
    },
    'retained-intent',
  )
  await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: 1 })
  const spies = ordinaryMLSMethods.map((name) => [name, vi.spyOn(mls, name)] as const)
  vi.useFakeTimers()
  const member = makeMLSPeer(hub, 'alice', secret, { mls, recoveryOnly: true })
  try {
    await member.peer.replay()
    await vi.advanceTimersByTimeAsync(0)
    const timersBefore = vi.getTimerCount()
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    const actions: Record<string, (member: TestPeer) => unknown> = {
      ...recoveryOnlyMethods,
      ...internalRecoveryOnlyMethods,
    }
    const action = actions[entry]
    if (action != null) {
      const result = Promise.resolve().then(() => action(member))
      if (entry === 'walkCommits' || entry === 'stepOperation')
        await expect(result).rejects.toBeInstanceOf(RecoveryRequiredError)
      else if (
        [
          'protocol',
          'retryAppDelivery',
          'dropAppFrame',
          'enqueue',
          'abandon',
          'commit',
          'resync',
        ].includes(entry)
      )
        await expect(result).rejects.toBeInstanceOf(SendNotAdmissibleError)
      else await result
    } else if (entry === 'commit-delivery') {
      await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: 1 })
    } else if (entry !== 'idle-timers') {
      const bob = createMemoryGroupMLS({ localDID: 'bob', members: ['alice', 'bob'] })
      const requestID = 'recovery-only-inbound'
      const { request } = await bob.createRecoveryRequest(requestID)
      const commit = encodeMemoryCommit(1, 'bob', [], { external: true })
      const frames = {
        'recovery-request': [
          HANDSHAKE_KIND.recoveryRequest,
          encodeRecoveryRequest(requestID, request),
        ],
        'recovery-reply': [
          HANDSHAKE_KIND.recoveryReply,
          encodeRecoveryReply(requestID, new Uint8Array([1])),
        ],
        'ledger-request': [HANDSHAKE_KIND.ledgerRequest, encodeLedgerRequest(requestID, request)],
        'ledger-reply': [
          HANDSHAKE_KIND.ledgerReply,
          encodeLedgerReply(requestID, new Uint8Array([1])),
        ],
        'confirmation-request': [
          HANDSHAKE_KIND.recoveryConfirmRequest,
          await encodeSignedRecoveryConfirmation(bob, {
            requestID,
            request,
            position: 'p',
            commitDigest: digestAppliedCommit(commit),
            commit,
          }),
        ],
        'recovery-verdict': [
          HANDSHAKE_KIND.recoveryVerdict,
          encodeRecoveryVerdict(requestID, new Uint8Array([1])),
        ],
      } satisfies Record<string, [number, Uint8Array]>
      const frame = frames[entry as keyof typeof frames]
      await hub.publish({
        senderDID: 'bob',
        topicID: rendezvousTopic(secret),
        payload: encodeHandshakeFrame(frame[0], frame[1]),
      })
    }
    if (entry === 'retryAppDelivery') expect(vi.getTimerCount()).toBe(timersBefore)
    await vi.advanceTimersByTimeAsync(120_000)
    for (const [name, spy] of spies) expect(spy, name).not.toHaveBeenCalled()
    // Serial exits may wake the store-only outbox worker.
    if (!['ack', 'walkCommits', 'stepOperation'].includes(entry))
      expect(scheduled).not.toHaveBeenCalled()
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})

test.each(ordinaryMLSMethods)(
  'recovery-only MLS refuses %s before invoking the host',
  async (name) => {
    const mls = createMemoryGroupMLS({ localDID: 'alice' })
    const host = vi.spyOn(mls, name).mockImplementation(() => {
      throw new Error('Private MLS invoked')
    })
    try {
      const port = recoveryOnlyMLS(mls)
      await expect(
        Promise.resolve().then(() => Reflect.apply(port[name], port, [])),
      ).rejects.toBeInstanceOf(RecoveryRequiredError)
      expect(host).not.toHaveBeenCalled()
    } finally {
      host.mockRestore()
    }
  },
)

test.each([
  'ownCommitDigest',
  'sendAdmission',
  'exportRecoverySecret',
  'getRecoveryLedger',
  'createRecoveryRequest',
  'signRecoveryConfirmation',
  'openRecoveryVerdict',
] as const)('recovery-only MLS retains requester member %s', async (name) => {
  const mls = createMemoryGroupMLS({ localDID: 'alice' })
  const error = new Error('Requester provider failure')
  const host = vi.spyOn(mls, name).mockImplementation(() => {
    throw error
  })
  try {
    const port = recoveryOnlyMLS(mls)
    const method = port[name]
    if (method === undefined) throw new Error('Missing retained requester member')
    await expect(Promise.resolve().then(() => Reflect.apply(method, port, []))).rejects.toBe(error)
    expect(host).toHaveBeenCalledOnce()
  } finally {
    host.mockRestore()
  }
})

test.each(['applyRecovery', 'restoreRecovery', 'reconcileCapture', 'sealGroupInfo'] as const)(
  'recovery-only captured recovery isolates %s',
  async (name) => {
    const error = new Error('Captured recovery provider failure')
    const fail = vi.fn((): never => {
      throw error
    })
    const mls = createMemoryGroupMLS({ localDID: 'alice' })
    const port = recoveryOnlyMLS({
      ...mls,
      capturedRecovery: {
        applyRecovery: fail,
        restoreRecovery: fail,
        reconcileCapture: fail,
        sealGroupInfo: fail,
      },
    })
    const captured = port.capturedRecovery
    if (captured == null) throw new Error('Missing captured recovery')
    const result = Promise.resolve().then(() => Reflect.apply(captured[name], captured, []))
    if (name === 'sealGroupInfo') {
      await expect(result).rejects.toBeInstanceOf(RecoveryRequiredError)
      expect(fail).not.toHaveBeenCalled()
    } else {
      await expect(result).rejects.toBe(error)
      expect(fail).toHaveBeenCalledOnce()
    }
  },
)
