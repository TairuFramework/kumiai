import { afterEach, expect, test, vi } from 'vitest'

import { forkEventID, recoveryUnavailableEventID, type SafetyHold } from '../src/control/safety.js'
import type { ExternalResponse } from '../src/control/types.js'
import type { GroupMLS } from '../src/crypto.js'
import { asLogPosition } from '../src/cursor.js'
import { GroupSafetyHeldError, PeerDisposedError } from '../src/errors.js'
import { decodeHandshakeFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import type { RecoveryEvent } from '../src/peer-types.js'
import {
  decodeRecoveryRequest,
  encodeLedgerReply,
  encodeLedgerRequest,
  encodeRecoveryConfirmRequest,
  encodeRecoveryReply,
  encodeRecoveryRequest,
} from '../src/recovery.js'
import {
  type ConfirmationWaiter,
  responseOutcome,
  waitForRecoveryConfirmation,
} from '../src/recovery-confirmation.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit, publishedCommitDigest } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { buildRejoinRecord, latchPeerSafety, makeMLSPeer, type TestPeer } from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(51)
const reasons = ['fork-halted', 'recovery-unavailable'] as const
const peers: Array<TestPeer> = []
afterEach(async () => {
  for (const member of peers.splice(0)) {
    await member.peer.dispose()
    await member.peer.drained()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})
async function fixture(delay = 0) {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'bob', secret, {
    members: ['alice', 'bob'],
    recovery: { timeoutMs: 30, deadlineMs: 120, getDelayMs: () => delay },
  })
  peers.push(member)
  await member.peer.replay()
  return { hub, member }
}
async function responderRequest(
  hub: FakeHub,
  member: TestPeer,
  kind: 'groupInfo' | 'ledger' | 'verdict',
) {
  let position = '000000000001'
  let digest = 'external'
  if (kind === 'verdict') {
    const row = await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 1,
      external: true,
    })
    await member.peer.replay()
    position = row.sequenceID
    digest = publishedCommitDigest(hub, position)
  }
  const alice = createMemoryGroupMLS({
    localDID: 'alice',
    members: ['alice', 'bob'],
    recoverySecret: secret,
  })
  const requestID = `safety-${kind}`
  const { request } = await alice.createRecoveryRequest(requestID)
  const payload =
    kind === 'groupInfo'
      ? encodeHandshakeFrame(
          HANDSHAKE_KIND.recoveryRequest,
          encodeRecoveryRequest(requestID, request),
        )
      : kind === 'ledger'
        ? encodeHandshakeFrame(
            HANDSHAKE_KIND.ledgerRequest,
            encodeLedgerRequest(requestID, request),
          )
        : encodeHandshakeFrame(
            HANDSHAKE_KIND.recoveryConfirmRequest,
            encodeRecoveryConfirmRequest({ requestID, request, position, commitDigest: digest }),
          )
  return () => hub.publish({ senderDID: 'alice', topicID: rendezvousTopic(secret), payload })
}

test.each(reasons)('explicit recovery refuses safety (%s)', async (reason) => {
  const { member, hub } = await fixture()
  latchPeerSafety(member, reason)
  const prepare = vi.spyOn(member.mls, 'prepareRecovery')
  const read = vi.spyOn(member.mls, 'readEpoch')
  const request = vi.spyOn(member.mls, 'createRecoveryRequest')
  const publish = vi.spyOn(hub, 'publish')
  await expect(member.peer.recover()).rejects.toEqual(new GroupSafetyHeldError(reason))
  expect(prepare).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
  expect(publish).not.toHaveBeenCalled()
})

test.each(reasons)('held confirmation refusal latches after abandon (%s)', async (reason) => {
  const hub = new FakeHub()
  const alice = makeMLSPeer(hub, 'alice', secret, { members: ['alice', 'bob'] })
  const member = makeMLSPeer(hub, 'bob', secret, {
    members: ['alice', 'bob'],
    recovery: { timeoutMs: 1000, deadlineMs: 3000, getDelayMs: () => 0 },
  })
  peers.push(alice, member)
  await alice.peer.replay()
  await member.peer.replay()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<never>()
  vi.spyOn(member.mls, 'openRecoveryVerdict').mockImplementation(async () => {
    entered.resolve()
    return await release.promise
  })
  const recovering = member.peer.recover().catch((error: unknown) => error)
  await entered.promise
  expect((await member.control.load()).rejoin?.stage).toBe('published')
  await member.peer.abandon()
  expect((await member.control.load()).rejoin).toBeNull()
  await alice.peer.dispose()
  await alice.peer.drained()
  const fetch = vi.spyOn(hub, 'fetchTopic')
  const publish = hub.publish.bind(hub)
  const handoff = vi.spyOn(hub, 'publish')
  const methods = [
    'readCommitHeader',
    'processCommit',
    'prepareRecovery',
    'createRecoveryRequest',
    'applyRecovery',
    'restoreRecovery',
    'confirmationKey',
    'openRecoveryVerdict',
    'sealGroupInfo',
    'sealLedger',
    'openSealedLedger',
    'sealRecoveryVerdict',
  ] as const
  const starts = methods.map((method) => vi.spyOn(member.mls, method).mockClear())
  const cryptoStarts = member.crypto.starts
  release.reject(new GroupSafetyHeldError(reason))
  const error = await recovering
  expect(member.controlWalk.safetyHold()).toBe(reason)
  expect(error).toBeInstanceOf(GroupSafetyHeldError)
  await publish({
    senderDID: 'alice',
    topicID: commitTopic(secret),
    payload: new Uint8Array([255]),
    retain: 'log',
  })
  await member.peer.replay()
  await expect(member.peer.recover()).rejects.toEqual(new GroupSafetyHeldError(reason))
  expect(fetch).not.toHaveBeenCalled()
  expect(handoff).not.toHaveBeenCalled()
  for (const start of starts) expect(start).not.toHaveBeenCalled()
  expect(member.crypto.starts).toEqual(cryptoStarts)
})

test.each(
  reasons.flatMap((reason) =>
    (['consumer', 'automatic'] as const).flatMap((trigger) =>
      (['disposed', 'error'] as const).map((failure) => [reason, trigger, failure] as const),
    ),
  ),
)(
  'latched recovery preserves non-safety failure (%s, %s, %s)',
  async (reason, trigger, failure) => {
    const hub = new FakeHub()
    const events: Array<RecoveryEvent> = []
    const member = makeMLSPeer(hub, 'bob', secret, {
      members: ['alice', 'bob'],
      recovery: { timeoutMs: 1000, deadlineMs: 3000, getDelayMs: () => 0 },
      onRecovery: (event) => {
        events.push(event)
      },
    })
    peers.push(member)
    await member.peer.replay()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<never>()
    vi.spyOn(member.mls, 'createRecoveryRequest').mockImplementation(async () => {
      entered.resolve()
      return await release.promise
    })
    const recovering =
      trigger === 'consumer' ? member.peer.recover().catch((error: unknown) => error) : undefined
    if (trigger === 'automatic')
      await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 3 })
    await entered.promise
    latchPeerSafety(member, reason)
    const error =
      failure === 'disposed'
        ? new PeerDisposedError('Peer is disposed')
        : new Error('request failed')
    const dispose = failure === 'disposed' && trigger === 'consumer'
    if (dispose) await member.peer.dispose()
    release.reject(error)
    if (recovering !== undefined) expect(await recovering).toBe(error)
    if (dispose) {
      await member.peer.drained()
      expect(events.map((event) => event.phase)).toEqual(['started'])
    } else {
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({ trigger, phase: 'failed', reason: failure }),
        ),
      )
    }
  },
)

test.each(
  reasons.flatMap((reason) =>
    (['groupInfo', 'ledger', 'verdict'] as const).map((kind) => [reason, kind] as const),
  ),
)('recovery responders stay silent (%s, %s)', async (reason, kind) => {
  const { member, hub } = await fixture()
  const send = await responderRequest(hub, member, kind)
  latchPeerSafety(member, reason)
  const seal = vi.spyOn(
    member.mls,
    kind === 'groupInfo'
      ? 'sealGroupInfo'
      : kind === 'ledger'
        ? 'sealLedger'
        : 'sealRecoveryVerdict',
  )
  await send()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(seal).not.toHaveBeenCalled()
  expect(hub.published.filter((row) => row.senderDID === 'bob')).toEqual([])
})

test.each(
  reasons.flatMap((reason) =>
    (['groupInfo', 'ledger', 'verdict'] as const).map((kind) => [reason, kind] as const),
  ),
)('queued responder/verdict timers stay silent (%s, %s)', async (reason, kind) => {
  const { member, hub } = await fixture(20)
  const send = await responderRequest(hub, member, kind)
  vi.useFakeTimers()
  await send()
  await vi.advanceTimersByTimeAsync(0)
  latchPeerSafety(member, reason)
  const sealInfo = vi.spyOn(member.mls, 'sealGroupInfo')
  const sealLedger = vi.spyOn(member.mls, 'sealLedger')
  const sealVerdict = vi.spyOn(member.mls, 'sealRecoveryVerdict')
  await vi.advanceTimersByTimeAsync(100)
  expect(sealInfo).not.toHaveBeenCalled()
  expect(sealLedger).not.toHaveBeenCalled()
  expect(sealVerdict).not.toHaveBeenCalled()
  expect(hub.published.filter((row) => row.senderDID === 'bob')).toEqual([])
})

test.each(
  reasons.flatMap((reason) =>
    (['groupInfo', 'ledger', 'verdict'] as const).map((kind) => [reason, kind] as const),
  ),
)('mid-flight responder sealing cannot hand off (%s, %s)', async (reason, kind) => {
  const { member, hub } = await fixture()
  const send = await responderRequest(hub, member, kind)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const method =
    kind === 'groupInfo'
      ? 'sealGroupInfo'
      : kind === 'ledger'
        ? 'sealLedger'
        : 'sealRecoveryVerdict'
  vi.spyOn(member.mls, method).mockImplementation(async () => {
    entered.resolve()
    await release.promise
    return new Uint8Array([1])
  })
  await send()
  await entered.promise
  latchPeerSafety(member, reason)
  release.resolve()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(hub.published.filter((row) => row.senderDID === 'bob')).toEqual([])
})

test.each(reasons)('ledger request stops after request creation await (%s)', async (reason) => {
  const { member, hub } = await fixture()
  vi.spyOn(member.mls, 'isLedgerComplete').mockResolvedValue(false)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const create = member.mls.createRecoveryRequest.bind(member.mls)
  vi.spyOn(member.mls, 'createRecoveryRequest').mockImplementation(async (...args) => {
    const request = await create(...args)
    entered.resolve()
    await release.promise
    return request
  })
  const open = vi.spyOn(member.mls, 'openSealedLedger')
  const bootstrap = vi.spyOn(member.mls, 'bootstrapLedger')
  const replay = member.peer.replay()
  await entered.promise
  latchPeerSafety(member, reason)
  const publish = vi.spyOn(hub, 'publish')
  release.resolve()
  await replay
  expect(publish).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  expect(bootstrap).not.toHaveBeenCalled()
})

test.each(reasons)(
  'automatic recovery continuation stops after request creation (%s)',
  async (reason) => {
    const { member, hub } = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const create = member.mls.createRecoveryRequest.bind(member.mls)
    vi.spyOn(member.mls, 'createRecoveryRequest').mockImplementation(async (...args) => {
      const request = await create(...args)
      entered.resolve()
      await release.promise
      return request
    })
    const apply = vi.spyOn(member.mls, 'applyRecovery')
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 3 })
    await entered.promise
    latchPeerSafety(member, reason)
    const publish = vi.spyOn(hub, 'publish')
    release.resolve()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(publish).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  },
)

test.each(reasons)(
  'saved rejoin publication stays held live and after restart (%s)',
  async (reason) => {
    const { member, hub } = await fixture()
    const record = await buildRejoinRecord(member)
    await member.control.apply({ putRejoin: record }, 'saved-rejoin')
    latchPeerSafety(member, reason)
    await member.control.apply(
      reason === 'fork-halted'
        ? {
            forkHalt: {
              eventID: forkEventID(member.control.key),
              detectedAt: 1,
              evidence: {
                kind: 'unexplained-own-commit',
                epoch: 1,
                position: '000000000001',
                digest: 'own',
              },
            },
          }
        : {
            recoveryUnavailable: {
              ...member.control.key,
              id: recoveryUnavailableEventID(member.control.key),
              kind: 'group:recovery-unavailable',
              reason: 'trust-unreadable',
            },
          },
      'safety',
    )
    const publish = vi.spyOn(hub, 'publish')
    await member.peer.replay()
    expect((await member.control.load()).rejoin).toEqual(record)
    await member.peer.dispose()
    await member.peer.drained()
    const restarted = makeMLSPeer(hub, 'bob', secret, { restartOf: member })
    peers.push(restarted)
    await restarted.peer.replay()
    expect(publish).not.toHaveBeenCalled()
    expect((await restarted.control.load()).rejoin).toEqual(record)
  },
)

test.each(reasons)('response key derivation stops after epoch read (%s)', async (reason) => {
  const port = createMemoryGroupMLS({ epoch: 2, localDID: 'bob' })
  let safety: SafetyHold = null
  vi.spyOn(port, 'readEpoch').mockImplementation(async () => {
    safety = reason
    return 2
  })
  const key = vi.spyOn(port, 'confirmationKey')
  const guardedOutcome: (
    port: GroupMLS,
    response: ExternalResponse,
    safetyHold?: () => SafetyHold,
  ) => ReturnType<typeof responseOutcome> = responseOutcome
  const outcome = await guardedOutcome(
    port,
    {
      position: asLogPosition('000000000001'),
      digest: 'commit',
      epoch: 1,
      epochAfter: 2,
      kind: 'applied',
    },
    () => safety,
  )
  expect(outcome).toBeUndefined()
  expect(key).not.toHaveBeenCalled()
})

test.each(reasons)('queued confirmation opens and repeat sends stop (%s)', async (reason) => {
  const options = { members: ['alice', 'bob'], recoverySecret: secret }
  const alice = createMemoryGroupMLS({ ...options, localDID: 'alice' })
  const bob = createMemoryGroupMLS({ ...options, localDID: 'bob' })
  const requestID = 'held-confirmation'
  const { request, requestKey } = await bob.createRecoveryRequest(requestID)
  const pending = await bob.applyRecovery(await alice.sealGroupInfo(request), requestID, requestKey)
  if (pending == null || 'renewalRequired' in pending) throw new Error('No candidate')
  const key = await pending.confirmationKey('000000000001', 'commit')
  const waiters = new Map<string, ConfirmationWaiter>()
  let safety: SafetyHold = null
  const send = vi.fn(async () => {})
  const open = vi.spyOn(bob, 'openRecoveryVerdict')
  const judge = vi.spyOn(pending, 'judgeVerdict')
  vi.useFakeTimers()
  const waiting = waitForRecoveryConfirmation({
    port: bob,
    pending,
    groupID: 'group',
    requestID,
    requestKey,
    position: '000000000001',
    commitDigest: 'commit',
    key,
    deadline: Date.now() + 100,
    timeoutMs: 10,
    send,
    waiters,
    ...{ safetyHold: () => safety },
  })
  const receiver = waiters.get(requestID)
  receiver?.receive(new Uint8Array([1]))
  safety = reason
  await vi.advanceTimersByTimeAsync(100)
  await waiting
  expect(open).not.toHaveBeenCalled()
  expect(judge).not.toHaveBeenCalled()
  expect(send).toHaveBeenCalledOnce()
})

test.each(reasons)('automatic recovery stops after a reply wait (%s)', async (reason) => {
  const { member, hub } = await fixture()
  const created = Promise.withResolvers<{ requestID: string; request: Uint8Array }>()
  const create = member.mls.createRecoveryRequest.bind(member.mls)
  vi.spyOn(member.mls, 'createRecoveryRequest').mockImplementation(async (requestID, ...args) => {
    const result = await create(requestID, ...args)
    created.resolve({ requestID, request: result.request })
    return result
  })
  await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 3 })
  const { requestID, request } = await created.promise
  await vi.waitFor(() => expect(hub.published.some((row) => row.senderDID === 'bob')).toBe(true))
  const alice = createMemoryGroupMLS({
    localDID: 'alice',
    members: ['alice', 'bob'],
    recoverySecret: secret,
  })
  const reply = await alice.sealGroupInfo(request)
  latchPeerSafety(member, reason)
  const apply = vi.spyOn(member.mls, 'applyRecovery')
  const restore = vi.spyOn(member.mls, 'restoreRecovery')
  const published = hub.published.filter((row) => row.senderDID === 'bob').length
  await hub.publish({
    senderDID: 'alice',
    topicID: rendezvousTopic(secret),
    payload: encodeHandshakeFrame(
      HANDSHAKE_KIND.recoveryReply,
      encodeRecoveryReply(requestID, reply),
    ),
  })
  await new Promise((resolve) => setTimeout(resolve, 40))
  expect(apply).not.toHaveBeenCalled()
  expect(restore).not.toHaveBeenCalled()
  expect(hub.published.filter((row) => row.senderDID === 'bob')).toHaveLength(published)
})

test.each(reasons)('armed recovery retry never requests healing (%s)', async (reason) => {
  const { member, hub } = await fixture()
  vi.useFakeTimers()
  const create = vi.spyOn(member.mls, 'createRecoveryRequest')
  const recovering = member.peer.recover()
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(120)
  await recovering
  expect(create).toHaveBeenCalled()
  latchPeerSafety(member, reason)
  create.mockClear()
  const publish = vi.spyOn(hub, 'publish')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(create).not.toHaveBeenCalled()
  expect(publish).not.toHaveBeenCalled()
})

test.each(reasons)(
  'confirmation open continuation starts no pending verdict work (%s)',
  async (reason) => {
    const options = {
      groupID: 'in-flight-confirmation-group',
      members: ['alice', 'bob'],
      recoverySecret: secret,
    }
    const alice = createMemoryGroupMLS({ ...options, localDID: 'alice' })
    const bob = createMemoryGroupMLS({ ...options, localDID: 'bob' })
    const requestID = 'in-flight-confirmation'
    const { request, requestKey } = await bob.createRecoveryRequest(requestID)
    const pending = await bob.applyRecovery(
      await alice.sealGroupInfo(request),
      requestID,
      requestKey,
    )
    if (pending == null || 'renewalRequired' in pending) throw new Error('No candidate')
    const key = await pending.confirmationKey('000000000001', 'commit')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let safety: SafetyHold = null
    const sealed = await alice.sealRecoveryVerdict(request, {
      groupID: 'in-flight-confirmation-group',
      requestID,
      position: '000000000001',
      commitDigest: 'commit',
      verdict: 'superseded',
    })
    const open = bob.openRecoveryVerdict.bind(bob)
    vi.spyOn(bob, 'openRecoveryVerdict').mockImplementation(async (...args) => {
      const value = await open(...args)
      entered.resolve()
      await release.promise
      return value
    })
    const judge = vi.spyOn(pending, 'judgeVerdict')
    const waiters = new Map<string, ConfirmationWaiter>()
    const send = vi.fn(async () => {})
    vi.useFakeTimers()
    const waiting = waitForRecoveryConfirmation({
      port: bob,
      pending,
      groupID: 'in-flight-confirmation-group',
      requestID,
      requestKey,
      position: '000000000001',
      commitDigest: 'commit',
      key,
      deadline: Date.now() + 100,
      timeoutMs: 10,
      send,
      waiters,
      ...{ safetyHold: () => safety },
    })
    waiters.get(requestID)?.receive(sealed)
    await entered.promise
    safety = reason
    release.resolve()
    await vi.advanceTimersByTimeAsync(100)
    await waiting
    expect(judge).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledOnce()
  },
)

test.each(reasons)(
  'automatic recovery continuation stops after reconciliation (%s)',
  async (reason) => {
    const { member, hub } = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let arm = false
    const fetch = hub.fetchTopic.bind(hub)
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
      const result = await fetch(params)
      if (arm && params.topicID === commitTopic(secret)) {
        arm = false
        entered.resolve()
        await release.promise
      }
      return result
    })
    const alice = createMemoryGroupMLS({
      localDID: 'alice',
      members: ['alice', 'bob'],
      recoverySecret: secret,
    })
    const publish = hub.publish.bind(hub)
    vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
      const result = await publish(params)
      if (params.senderDID === 'bob' && params.topicID === rendezvousTopic(secret)) {
        const frame = decodeHandshakeFrame(params.payload)
        if (frame.kind === HANDSHAKE_KIND.recoveryRequest) {
          const { requestID, request } = decodeRecoveryRequest(frame.payload)
          const reply = await alice.sealGroupInfo(request)
          arm = true
          await publish({
            senderDID: 'alice',
            topicID: rendezvousTopic(secret),
            payload: encodeHandshakeFrame(
              HANDSHAKE_KIND.recoveryReply,
              encodeRecoveryReply(requestID, reply),
            ),
          })
        }
      }
      return result
    })
    const apply = vi.spyOn(member.mls, 'applyRecovery')
    const restore = vi.spyOn(member.mls, 'restoreRecovery')
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 3 })
    await entered.promise
    latchPeerSafety(member, reason)
    const sent = hub.published.filter((row) => row.senderDID === 'bob').length
    release.resolve()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(apply).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    expect(hub.published.filter((row) => row.senderDID === 'bob')).toHaveLength(sent)
  },
)

test.each(reasons)(
  'external commits after halt start no processing or verdict work (%s)',
  async (reason) => {
    const { member, hub } = await fixture()
    latchPeerSafety(member, reason)
    const process = vi.spyOn(member.mls, 'processCommit')
    const fetch = vi.spyOn(hub, 'fetchTopic')
    const verdict = vi.spyOn(member.mls, 'sealRecoveryVerdict')
    await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 1,
      external: true,
    })
    await member.peer.replay()
    expect(process).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(verdict).not.toHaveBeenCalled()
  },
)

test.each(reasons)('ledger responder stops after its completeness await (%s)', async (reason) => {
  const { member, hub } = await fixture()
  const send = await responderRequest(hub, member, 'ledger')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  vi.spyOn(member.mls, 'isLedgerComplete').mockImplementation(async () => {
    entered.resolve()
    await release.promise
    return true
  })
  const seal = vi.spyOn(member.mls, 'sealLedger')
  await send()
  await entered.promise
  latchPeerSafety(member, reason)
  release.resolve()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(seal).not.toHaveBeenCalled()
  expect(hub.published.filter((row) => row.senderDID === 'bob')).toEqual([])
})

test.each(reasons)(
  'held ledger open refusal latches before the next reply (%s)',
  async (reason) => {
    const { member, hub } = await fixture()
    vi.spyOn(member.mls, 'isLedgerComplete').mockResolvedValue(false)
    let requestID: string | undefined
    const create = member.mls.createRecoveryRequest.bind(member.mls)
    vi.spyOn(member.mls, 'createRecoveryRequest').mockImplementation((id, ...args) => {
      requestID = id
      return create(id, ...args)
    })
    const open = vi
      .spyOn(member.mls, 'openSealedLedger')
      .mockRejectedValue(new GroupSafetyHeldError(reason))
    const bootstrap = vi.spyOn(member.mls, 'bootstrapLedger')
    const requested = Promise.withResolvers<void>()
    const publish = hub.publish.bind(hub)
    vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
      const result = await publish(params)
      if (
        params.senderDID === 'bob' &&
        decodeHandshakeFrame(params.payload).kind === HANDSHAKE_KIND.ledgerRequest
      )
        requested.resolve()
      return result
    })
    const replay = member.peer.replay()
    await requested.promise
    if (requestID === undefined) throw new Error('No ledger request')
    for (const byte of [1, 2]) {
      await hub.publish({
        senderDID: 'alice',
        topicID: rendezvousTopic(secret),
        payload: encodeHandshakeFrame(
          HANDSHAKE_KIND.ledgerReply,
          encodeLedgerReply(requestID, new Uint8Array([byte])),
        ),
      })
      if (byte === 1) {
        await replay
        expect(member.controlWalk.safetyHold()).toBe(reason)
      }
    }
    await replay
    expect(member.controlWalk.safetyHold()).toBe(reason)
    expect(open).toHaveBeenCalledOnce()
    expect(bootstrap).not.toHaveBeenCalled()
  },
)
