import type { ProtocolDefinition } from '@enkaku/protocol'
import { BroadcastClient, encodeEventFrame } from '@kumiai/broadcast'
import { afterEach, expect, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import { forkEventID, recoveryUnavailableEventID, type SafetyHold } from '../src/control/safety.js'
import type { Outcome, WelcomeObligation } from '../src/control/types.js'
import type { PendingAppFrame } from '../src/crypto.js'
import * as directedModule from '../src/directed.js'
import { GroupSafetyHeldError, SendNotAdmissibleError } from '../src/errors.js'
import type { HubMux } from '../src/hub-mux.js'
import * as logDeliveryModule from '../src/log-delivery.js'
import type { EpochRuntime, EpochRuntimeParams } from '../src/peer-epoch.js'
import * as epochRuntimeModule from '../src/peer-epoch.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import {
  buildInviteCommit,
  buildLedgerCommit,
  makeMLSPeer,
  seedBuiltOperation,
  type TestPeer,
} from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(43)
const reasons = ['fork-halted', 'recovery-unavailable'] as const
const peers: Array<TestPeer> = []
// Erase the generic factory for Vitest's recursive handler type inference.
const epochFactory = epochRuntimeModule as unknown as {
  createEpochRuntime: (
    params: EpochRuntimeParams<Record<string, ProtocolDefinition>>,
  ) => EpochRuntime
}
afterEach(async () => {
  for (const member of peers.splice(0)) {
    await member.peer.dispose()
    await member.peer.drained()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})
async function fixture() {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'bob', secret)
  peers.push(member)
  await member.peer.replay()
  return { hub, member }
}
function latch(member: TestPeer, reason: NonNullable<SafetyHold>) {
  vi.spyOn(member.mls, 'sendAdmission').mockReturnValue({
    admissible: false,
    reason,
    epoch: member.mls.epoch(),
  })
  expect(member.controlWalk.safetyHold()).toBe(reason)
}
async function persist(member: TestPeer, reason: NonNullable<SafetyHold>) {
  await member.control.apply(
    reason === 'fork-halted'
      ? {
          forkHalt: {
            eventID: forkEventID(member.control.key),
            evidence: {
              kind: 'unexplained-own-commit',
              epoch: 1,
              position: '000001',
              digest: 'own',
            },
            detectedAt: 1,
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
    'host-safety',
  )
}

test.each(
  reasons.flatMap((reason) => [false, true].map((committed) => [reason, committed] as const)),
)(
  'durable dispatch refuses pending and committed %s halt (committed=%s)',
  async (reason, committed) => {
    const { member } = await fixture()
    if (committed) {
      await persist(member, reason)
      await member.peer.replay()
    } else latch(member, reason)
    const put = vi.spyOn(member.appOutbox, 'put')
    await expect(
      member.peer.protocol('chat').dispatch('chat/posted', { data: {} }),
    ).rejects.toEqual(new SendNotAdmissibleError(reason))
    expect(put).not.toHaveBeenCalled()
    expect(await member.appOutbox.list()).toEqual([])
  },
)

test.each(['pending', 'failed'] as const)(
  'durable dispatch refuses a %s halt write with only the volatile latch',
  async (state) => {
    const { member } = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const apply = member.control.apply.bind(member.control)
    vi.spyOn(member.control, 'apply').mockImplementation(async (changes, id) => {
      if (changes.forkHalt === undefined) return apply(changes, id)
      entered.resolve()
      if (state === 'pending') await release.promise
      throw new Error('halt write failed')
    })
    const halting = member.controlWalk.haltFork({
      kind: 'unexplained-own-commit',
      epoch: 1,
      position: '000001',
      digest: 'own',
    })
    await entered.promise
    expect((await member.control.load()).forkHalt).toBeNull()
    const put = vi.spyOn(member.appOutbox, 'put')
    try {
      await expect(
        member.peer.protocol('chat').dispatch('chat/posted', { data: {} }),
      ).rejects.toEqual(new SendNotAdmissibleError('fork-halted'))
      expect(put).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await member.peer.dispose()
      await halting
    }
  },
)

test.each(reasons)('durable acceptance waits for initial %s readiness', async (reason) => {
  const { member, hub } = await fixture()
  await member.peer.dispose()
  await member.peer.drained()
  await persist(member, reason)
  const load = member.control.load.bind(member.control)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  vi.spyOn(member.control, 'load').mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    return load()
  })
  const restarted = makeMLSPeer(hub, 'bob', secret, { restartOf: member, control: member.control })
  peers.push(restarted)
  await entered.promise
  const put = vi.spyOn(member.appOutbox, 'put')
  const dispatch = restarted.peer
    .protocol('chat')
    .dispatch('chat/posted', { data: {} })
    .then(
      () => null,
      (error: unknown) => error,
    )
  await Promise.resolve()
  const earlyWrites = put.mock.calls.length
  release.resolve()
  expect(await dispatch).toEqual(new SendNotAdmissibleError(reason))
  expect(earlyWrites).toBe(0)
  expect(put).not.toHaveBeenCalled()
})

test.each(reasons)('queued durable send is preserved under %s', async (reason) => {
  const { member, hub } = await fixture()
  vi.useFakeTimers()
  await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'queued' } })
  latch(member, reason)
  const wrap = vi.spyOn(member.crypto, 'wrap')
  const publish = vi.spyOn(hub, 'publish')
  const fetch = vi.spyOn(hub, 'fetchTopic')
  await vi.advanceTimersByTimeAsync(1_000)
  expect(wrap).not.toHaveBeenCalled()
  expect(publish).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  expect(await member.appOutbox.list()).toMatchObject([{ lastAttempt: null }])
})

test.each([
  ['fork-halted', false],
  ['recovery-unavailable', false],
  ['fork-halted', true],
] as const)(
  'seal barrier retry starts no new wrap under %s (failed halt write=%s)',
  async (reason, failedWrite) => {
    const barrier = Promise.withResolvers<void>()
    const waiting = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    let pendingBarrier: Promise<void> | undefined
    const createEpoch = epochFactory.createEpochRuntime
    vi.spyOn(epochFactory, 'createEpochRuntime').mockImplementation((params) => {
      return createEpoch({
        ...params,
        sealBarrier: () => {
          if (pendingBarrier != null) waiting.resolve()
          return pendingBarrier ?? params.sealBarrier()
        },
      })
    })
    const createDelivery = logDeliveryModule.createLogDelivery
    vi.spyOn(logDeliveryModule, 'createLogDelivery').mockImplementation((params) =>
      createDelivery({
        ...params,
        seal: (entry) => params.seal(entry).finally(() => finished.resolve()),
      }),
    )
    const { member, hub } = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const wrap = member.crypto.wrap.bind(member.crypto)
    const wraps = vi.spyOn(member.crypto, 'wrap').mockImplementationOnce(async (...args) => {
      const payload = await wrap(...args)
      entered.resolve()
      await release.promise
      return payload
    })
    const publish = vi.spyOn(hub, 'publish')
    let halting: Promise<void> | undefined
    try {
      await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'queued' } })
      await entered.promise
      pendingBarrier = barrier.promise
      if (failedWrite) {
        const write = Promise.withResolvers<void>()
        const apply = member.control.apply.bind(member.control)
        vi.spyOn(member.control, 'apply').mockImplementation(async (changes, id) => {
          if (changes.forkHalt === undefined) return apply(changes, id)
          write.resolve()
          throw new Error('halt write failed')
        })
        halting = member.controlWalk.haltFork({
          kind: 'unexplained-own-commit',
          epoch: 1,
          position: '000001',
          digest: 'own',
        })
        await write.promise
        expect((await member.control.load()).forkHalt).toBeNull()
        expect(member.controlWalk.safetyHold()).toBe('fork-halted')
      } else {
        latch(member, reason)
      }
      // The peer latch must guard retries even when MLS itself still admits sends.
      vi.spyOn(member.mls, 'sendAdmission').mockReturnValue({ admissible: true, epoch: 1 })
      release.resolve()
      await waiting.promise
      pendingBarrier = undefined
      barrier.resolve()
      await finished.promise
      expect(wraps).toHaveBeenCalledOnce()
      expect(publish).not.toHaveBeenCalled()
      expect(await member.appOutbox.list()).toMatchObject([{ lastAttempt: null }])
    } finally {
      release.resolve()
      pendingBarrier = undefined
      barrier.resolve()
      if (halting != null) {
        await member.peer.dispose()
        await halting
      }
    }
  },
)

test.each(reasons)(
  'held durable seal refusal latches %s and preserves the queue',
  async (reason) => {
    const { member, hub } = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const wrap = vi.spyOn(member.crypto, 'wrap').mockImplementation(async () => {
      entered.resolve()
      await release.promise
      throw new GroupSafetyHeldError(reason)
    })
    await member.peer.protocol('chat').dispatch('chat/posted', { data: {} })
    await entered.promise
    expect(member.controlWalk.safetyHold()).toBeNull()
    release.resolve()
    await vi.waitFor(() => expect(member.controlWalk.safetyHold()).toBe(reason))
    const fetch = vi.spyOn(hub, 'fetchTopic')
    await member.peer.retryAppDelivery()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fetch).not.toHaveBeenCalled()
    expect(wrap).toHaveBeenCalledOnce()
    expect(await member.appOutbox.list()).toMatchObject([{ lastAttempt: null }])
  },
)

test.each(reasons)('seal entry refusal under %s never consumes an attempt', async (reason) => {
  const createDelivery = logDeliveryModule.createLogDelivery
  let member: TestPeer
  const refusals: Array<unknown> = []
  vi.spyOn(logDeliveryModule, 'createLogDelivery').mockImplementation((params) =>
    createDelivery({
      ...params,
      seal: async (entry) => {
        latch(member, reason)
        try {
          return await params.seal(entry)
        } catch (error) {
          refusals.push(error)
          throw error
        }
      },
    }),
  )
  const hub = new FakeHub()
  member = makeMLSPeer(hub, 'bob', secret)
  peers.push(member)
  await member.peer.replay()
  vi.useFakeTimers()
  const wrap = vi.spyOn(member.crypto, 'wrap')
  const publish = vi.spyOn(hub, 'publish')
  const put = vi.spyOn(member.appOutbox, 'put')
  const remove = vi.spyOn(member.appOutbox, 'remove')
  await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'queued' } })
  const before = await member.appOutbox.list()
  put.mockClear()
  await vi.advanceTimersByTimeAsync(0)
  expect(refusals).toEqual([new SendNotAdmissibleError(reason)])
  await vi.advanceTimersByTimeAsync(120_000)
  expect(await member.appOutbox.list()).toEqual(before)
  expect(await member.appOutbox.list()).toMatchObject([{ lastAttempt: null }])
  expect(put).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
  expect(wrap).not.toHaveBeenCalled()
  expect(publish).not.toHaveBeenCalled()
})

test.each(reasons)('final append handoff checks the current %s latch', async (reason) => {
  const handoff = Promise.withResolvers<void>()
  const create = logDeliveryModule.createLogDelivery
  let member: TestPeer
  vi.spyOn(logDeliveryModule, 'createLogDelivery').mockImplementation((params) =>
    create({
      ...params,
      publish: (frame) => {
        latch(member, reason)
        vi.spyOn(member.mls, 'sendAdmission').mockReturnValue({ admissible: true, epoch: 1 })
        const submission = params.publish(frame)
        handoff.resolve()
        return submission
      },
    }),
  )
  const hub = new FakeHub()
  member = makeMLSPeer(hub, 'bob', secret)
  peers.push(member)
  await member.peer.replay()
  const publish = vi.spyOn(hub, 'publish')
  await member.peer.protocol('chat').dispatch('chat/posted', { data: {} })
  await handoff.promise
  expect(publish).not.toHaveBeenCalled()
  expect(await member.appOutbox.list()).toHaveLength(1)
})

test.each(
  reasons.flatMap((reason) => ['seal', 'put'].map((boundary) => [reason, boundary] as const)),
)('halt between %s and handoff under %s prevents append', async (reason, boundary) => {
  const { member, hub } = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  if (boundary === 'seal') {
    const wrap = member.crypto.wrap.bind(member.crypto)
    vi.spyOn(member.crypto, 'wrap').mockImplementation(async (...args) => {
      const sealed = await wrap(...args)
      entered.resolve()
      await release.promise
      return sealed
    })
  } else {
    const put = member.appOutbox.put.bind(member.appOutbox)
    vi.spyOn(member.appOutbox, 'put').mockImplementation(async (entry) => {
      await put(entry)
      if (entry.lastAttempt !== null) {
        entered.resolve()
        await release.promise
      }
    })
  }
  const publish = vi.spyOn(hub, 'publish')
  await member.peer.protocol('chat').dispatch('chat/posted', { data: {} })
  await entered.promise
  latch(member, reason)
  // Restore MLS admission to prove that the peer uses its latch at the final boundary.
  vi.spyOn(member.mls, 'sendAdmission').mockReturnValue({ admissible: true, epoch: 1 })
  release.resolve()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(publish).not.toHaveBeenCalled()
  expect(await member.appOutbox.list()).toHaveLength(1)
})

test.each(reasons)(
  'enqueue, resync and synchronous reauthorize refuse %s without side effects',
  async (reason) => {
    const { member, hub } = await fixture()
    latch(member, reason)
    const before = await member.control.load()
    const apply = vi.spyOn(member.control, 'apply')
    const exportSecret = vi.spyOn(member.crypto, 'exportSecret')
    const subscribe = vi.spyOn(hub, 'subscribe')
    await expect(
      member.peer.enqueue({ ...buildLedgerCommit(member, []), revokes: true }),
    ).rejects.toEqual(new GroupSafetyHeldError(reason))
    await expect(member.peer.commit(buildLedgerCommit(member, []))).rejects.toEqual(
      new GroupSafetyHeldError(reason),
    )
    await expect(member.peer.resync()).rejects.toEqual(new GroupSafetyHeldError(reason))
    expect(() => member.peer.reauthorize()).toThrow(new GroupSafetyHeldError(reason))
    expect(apply).not.toHaveBeenCalled()
    expect(exportSecret).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    expect(await member.control.load()).toEqual(before)
  },
)

test.each(reasons)('resync builds no listeners after %s during teardown', async (reason) => {
  let mux: HubMux | undefined
  const createEpoch = epochFactory.createEpochRuntime
  vi.spyOn(epochFactory, 'createEpochRuntime').mockImplementation((params) => {
    mux = params.mux
    return createEpoch(params)
  })
  const { member, hub } = await fixture()
  if (mux == null) throw new Error('Epoch mux was not captured')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const dispose = BroadcastClient.prototype.dispose
  vi.spyOn(BroadcastClient.prototype, 'dispose').mockImplementationOnce(function (
    this: BroadcastClient,
  ) {
    const result = dispose.call(this)
    entered.resolve()
    return release.promise.then(() => result)
  })
  const resync = member.peer.resync().then(
    () => null,
    (error: unknown) => error,
  )
  try {
    await entered.promise
    latch(member, reason)
    vi.spyOn(member.mls, 'sendAdmission').mockReturnValue({ admissible: true, epoch: 1 })
    const buildInbox = vi.spyOn(directedModule, 'createInboxPath')
    const listen = vi.spyOn(mux, 'onInbound')
    const retain = vi.spyOn(mux, 'retainTopic')
    const subscribe = vi.spyOn(hub, 'subscribe')
    release.resolve()
    const error = await resync
    expect(buildInbox).not.toHaveBeenCalled()
    expect(listen).not.toHaveBeenCalled()
    expect(retain).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    expect(error).toEqual(new GroupSafetyHeldError(reason))
  } finally {
    release.resolve()
    await resync
  }
})

test.each(reasons)('replay skips its second phase under %s', async (reason) => {
  const { member, hub } = await fixture()
  latch(member, reason)
  const complete = vi.spyOn(member.mls, 'isLedgerComplete')
  const request = vi.spyOn(member.mls, 'createRecoveryRequest')
  const fetch = vi.spyOn(hub, 'fetchTopic')
  const exportSecret = vi.spyOn(member.crypto, 'exportSecret')
  await expect(member.peer.replay()).resolves.toEqual({})
  expect(complete).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  expect(exportSecret).not.toHaveBeenCalled()
})

test.each(
  reasons.flatMap((reason) => ['pull', 'pre-adoption'].map((path) => [reason, path] as const)),
)('two-frame %s drain stops at next open under %s', async (reason, path) => {
  const hub = new DurableFakeHub()
  const records = new Map<string, PendingAppFrame>()
  const reader = createFakeCrypto({
    localDID: 'bob',
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
  const member = makeMLSPeer(hub, 'bob', secret, { crypto: reader })
  peers.push(member)
  await member.peer.replay()
  hub.detach('bob')
  const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
  const sender = createFakeCrypto({ localDID: 'alice' })
  for (const text of ['first', 'second']) {
    await hub.publish({
      senderDID: 'alice',
      topicID,
      retain: 'log',
      payload: await sender.wrap(encodeEventFrame('chat/posted', { text }), {
        aad: encodeAppAAD({ topicID, intent: 'log' }),
      }),
    })
  }
  if (path === 'pre-adoption')
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const open = reader.unwrap.bind(reader)
  const unwrap = vi.spyOn(reader, 'unwrap').mockImplementation(async (...args) => {
    const result = await open(...args)
    entered.resolve()
    await release.promise
    return result
  })
  await member.peer.retryAppDelivery()
  await entered.promise
  latch(member, reason)
  release.resolve()
  await vi.waitFor(() => expect(records.size).toBe(0))
  expect(unwrap).toHaveBeenCalledOnce()
  expect(member.appCursorStore.stored(topicID)).not.toBe('000000000002')
  const fetch = vi.spyOn(hub, 'fetchTopic')
  unwrap.mockClear()
  await member.peer.retryAppDelivery()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(fetch).not.toHaveBeenCalled()
  expect(unwrap).not.toHaveBeenCalled()
})

test.each(reasons)('a held unwrap refusal latches %s before the next pull wake', async (reason) => {
  const hub = new DurableFakeHub()
  const reader = createFakeCrypto({
    localDID: 'bob',
    pending: {
      persistOpened: async () => {},
      list: async () => [],
      complete: async () => {},
    },
  })
  const member = makeMLSPeer(hub, 'bob', secret, { crypto: reader })
  peers.push(member)
  await member.peer.replay()
  hub.detach('bob')
  const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
  const sender = createFakeCrypto({ localDID: 'alice' })
  await hub.publish({
    senderDID: 'alice',
    topicID,
    retain: 'log',
    payload: await sender.wrap(encodeEventFrame('chat/posted', {}), {
      aad: encodeAppAAD({ topicID, intent: 'log' }),
    }),
  })
  const unwrap = vi.spyOn(reader, 'unwrap').mockRejectedValue(new GroupSafetyHeldError(reason))
  await member.peer.retryAppDelivery()
  await vi.waitFor(() => expect(member.controlWalk.safetyHold()).toBe(reason))
  expect(unwrap).toHaveBeenCalledOnce()
  expect(member.appCursorStore.stored(topicID)).toBeNull()
  const fetch = vi.spyOn(hub, 'fetchTopic')
  unwrap.mockClear()
  await member.peer.retryAppDelivery()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(fetch).not.toHaveBeenCalled()
  expect(unwrap).not.toHaveBeenCalled()
  const ledger = vi.spyOn(member.mls, 'isLedgerComplete')
  await member.peer.dropAppFrame(topicID, '000000000001')
  expect(member.appCursorStore.stored(topicID)).toBe('000000000001')
  expect(ledger).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

test.each(reasons)(
  'committed Welcome remains serviceable under %s with its original bytes',
  async (reason) => {
    const hub = new FakeHub()
    let available = false
    const deliver = vi.fn(async (_row: WelcomeObligation) => {
      if (!available) throw new Error('mailbox unavailable')
    })
    const member = makeMLSPeer(hub, 'bob', secret, { deliverWelcome: deliver })
    peers.push(member)
    await member.peer.replay()
    vi.useFakeTimers()
    await member.peer.commit(buildInviteCommit(member, 'alice'))
    const before = (await member.control.load()).welcomes[0]
    expect(before?.committed).toBe(true)
    latch(member, reason)
    await persist(member, reason)
    available = true
    deliver.mockClear()
    const fetch = vi.spyOn(hub, 'fetchTopic')
    const restore = vi.spyOn(member.validation, 'restoreValidation')
    const seal = vi.spyOn(member.crypto, 'sealEntries')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(deliver).toHaveBeenCalledWith(before)
    expect((await member.control.load()).welcomes).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    expect(seal).not.toHaveBeenCalled()
  },
)

test.each(reasons)(
  'outcomes emit and ack while %s leaves halt, slot and history unchanged',
  async (reason) => {
    const hub = new FakeHub()
    const onOutcome = vi.fn()
    const member = makeMLSPeer(hub, 'bob', secret, { onOutcome })
    peers.push(member)
    await member.peer.replay()
    await seedBuiltOperation(member, buildLedgerCommit(member, ['entry']))
    const outcome: Outcome = { id: 'owed', opID: null, at: 1, kind: 'unknown' }
    await member.control.apply({ putOutcomes: [outcome] }, 'owed-outcome')
    await persist(member, reason)
    await member.peer.replay()
    await vi.waitFor(() => expect(onOutcome).toHaveBeenCalledWith(outcome))
    const before = await member.control.load()
    expect(await member.peer.outcomes()).toContainEqual(outcome)
    await member.peer.ack(outcome.id)
    const after = await member.control.load()
    expect(after.commitOnce).toEqual(before.commitOnce)
    expect(after.forkHalt).toEqual(before.forkHalt)
    expect(after.recoveryUnavailable).toEqual(before.recoveryUnavailable)
    expect(after.applied).toEqual(before.applied)
    expect(after.cursor).toEqual(before.cursor)
    expect(after.outcomes).not.toContainEqual(outcome)
  },
)
