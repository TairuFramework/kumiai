import type { ProtocolDefinition } from '@enkaku/protocol'
import { encodeEventFrame } from '@kumiai/broadcast'
import { afterEach, expect, test, vi } from 'vitest'

import { forkEventID, recoveryUnavailableEventID, type SafetyHold } from '../src/control/safety.js'
import type { ControlStore, WelcomeObligation } from '../src/control/types.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { asLogPosition } from '../src/cursor.js'
import { GroupSafetyHeldError, SendNotAdmissibleError } from '../src/errors.js'
import * as muxModule from '../src/hub-mux.js'
import type { EpochRuntime, EpochRuntimeParams } from '../src/peer-epoch.js'
import * as epochModule from '../src/peer-epoch.js'
import { commitTopic } from '../src/topic.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import {
  buildLedgerCommit,
  latchPeerSafety,
  type MakeMLSPeerOptions,
  makeMLSPeer,
  seedBuiltOperation,
  type TestPeer,
} from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0xc3)
const reasons = ['fork-halted', 'recovery-unavailable'] as const
const peers: Array<TestPeer> = []
const evidenceReads = new WeakMap<TestPeer, ReturnType<typeof vi.fn>>()

afterEach(async () => {
  const created = peers.splice(0)
  try {
    await Promise.all(created.map(({ peer }) => peer.dispose()))
    await Promise.all(created.map(({ peer }) => peer.drained()))
  } finally {
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})

async function persist(control: ControlStore, reason: NonNullable<SafetyHold>) {
  await control.apply(
    reason === 'fork-halted'
      ? {
          forkHalt: {
            eventID: forkEventID(control.key),
            detectedAt: 1,
            evidence: {
              kind: 'unexplained-own-commit',
              epoch: 1,
              position: '000001',
              digest: 'fork',
            },
          },
        }
      : {
          recoveryUnavailable: {
            id: recoveryUnavailableEventID(control.key),
            kind: 'group:recovery-unavailable',
            ...control.key,
            reason: 'trust-unreadable',
          },
        },
    'persist-safety',
  )
}

function observeMux() {
  const create = muxModule.createHubMux
  const retain = vi.fn()
  const start = vi.fn()
  vi.spyOn(muxModule, 'createHubMux').mockImplementation((params) => {
    const mux = create(params)
    const retainTopic = mux.retainTopic
    mux.retainTopic = (...args) => {
      retain(...args)
      retainTopic(...args)
    }
    const begin = mux.start
    mux.start = () => {
      start()
      begin()
    }
    return mux
  })
  return { retain, start }
}

function observeNetwork(hub: FakeHub) {
  return {
    receive: vi.spyOn(hub, 'receive'),
    subscribe: vi.spyOn(hub, 'subscribe'),
    fetch: vi.spyOn(hub, 'fetchTopic'),
    publish: vi.spyOn(hub, 'publish'),
    ...observeMux(),
  }
}

function observeRuntime() {
  const buildEpoch = vi.fn()
  const module = epochModule as unknown as {
    createEpochRuntime: (
      params: EpochRuntimeParams<Record<string, ProtocolDefinition>>,
    ) => EpochRuntime
  }
  const create = module.createEpochRuntime
  vi.spyOn(module, 'createEpochRuntime').mockImplementation((params) => {
    const runtime = create(params)
    const build = runtime.buildEpoch
    runtime.buildEpoch = async () => {
      buildEpoch()
      await build()
    }
    return runtime
  })
  return { buildEpoch }
}

function observeWork(member: TestPeer) {
  const evidence = evidenceReads.get(member)
  if (evidence === undefined) throw new Error('Missing evidence counter')
  evidence.mockClear()
  return {
    epoch: vi.spyOn(member.mls, 'readEpoch'),
    evidence,
    secret: vi.spyOn(member.crypto, 'exportSecret'),
    wrap: vi.spyOn(member.crypto, 'wrap'),
    unwrap: vi.spyOn(member.crypto, 'unwrap'),
    sealEntries: vi.spyOn(member.crypto, 'sealEntries'),
    openEntries: vi.spyOn(member.crypto, 'openEntries'),
    recoverySecret: vi.spyOn(member.mls, 'exportRecoverySecret'),
    process: vi.spyOn(member.mls, 'processCommit'),
    groupInfo: vi.spyOn(member.mls, 'sealGroupInfo'),
    ledger: vi.spyOn(member.mls, 'sealLedger'),
    verdict: vi.spyOn(member.mls, 'sealRecoveryVerdict'),
    request: vi.spyOn(member.mls, 'createRecoveryRequest'),
    validation: vi.spyOn(member.validation, 'restoreValidation'),
    build: vi.spyOn(member.mls, 'buildCommit'),
    adopt: vi.spyOn(member.mls, 'adoptOperation'),
  }
}

function assertZero(counters: Record<string, ReturnType<typeof vi.fn>>) {
  for (const [name, counter] of Object.entries(counters))
    expect(counter, name).not.toHaveBeenCalled()
}

function makePeer(hub: FakeHub, options: MakeMLSPeerOptions = {}): TestPeer {
  let member: TestPeer
  const readEvidence = vi.fn(async () => member.mls.readEvidence())
  member = makeMLSPeer(hub, 'alice', secret, { ...options, readEvidence })
  evidenceReads.set(member, readEvidence)
  return member
}

async function seed(options: MakeMLSPeerOptions = {}) {
  const hub = new FakeHub()
  const member = makePeer(hub, options)
  peers.push(member)
  await member.peer.outcomes()
  return { hub, member }
}

test.each(reasons)('persisted %s starts no network or new work', async (reason) => {
  const { hub, member } = await seed()
  await member.peer.dispose()
  await member.peer.drained()
  await persist(member.control, reason)
  const network = observeNetwork(hub)
  const runtime = observeRuntime()
  const again = makePeer(hub, { restartOf: member })
  const work = { ...observeWork(again), ...runtime }
  peers.push(again)
  vi.useFakeTimers()
  await again.peer.outcomes()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(again.controlWalk.safetyHold()).toBe(reason)
  assertZero(network)
  assertZero(work)
  expect(again.crypto.starts).toEqual({ wrap: 0, unwrap: 0, sealEntries: 0, openEntries: 0 })
})

test.each(['suspended', 'failed'] as const)(
  'initial safety read %s enables nothing',
  async (mode) => {
    const hub = new FakeHub()
    const mls = createMemoryGroupMLS({ localDID: 'alice', recoverySecret: secret })
    const load = mls.control().load
    const release = Promise.withResolvers<void>()
    const error = new Error('initial safety load failed')
    const control = {
      ...mls.control(),
      load: async () => {
        await release.promise
        if (mode === 'failed') throw error
        return load()
      },
    }
    const network = observeNetwork(hub)
    const runtime = observeRuntime()
    const member = makePeer(hub, { mls, control })
    const work = { ...observeWork(member), ...runtime }
    peers.push(member)
    const ready = member.peer.outcomes()
    const result = ready.catch((failure: unknown) => failure)
    const send = member.peer.protocol('chat').dispatch('chat/changed', { data: {} })
    const sent = send.catch((failure: unknown) => failure)
    try {
      await Promise.resolve()
      assertZero(network)
      assertZero(work)
    } finally {
      release.resolve()
    }
    if (mode === 'failed') {
      expect(await result).toBe(error)
      expect(await sent).toBe(error)
      assertZero(network)
      assertZero(work)
      expect(member.crypto.starts).toEqual({ wrap: 0, unwrap: 0, sealEntries: 0, openEntries: 0 })
    } else {
      await ready
      await send
      expect(network.receive).toHaveBeenCalledOnce()
      expect(network.start).toHaveBeenCalledOnce()
    }
  },
)

test('reauthorize throws before ready after persisted safety latches', async () => {
  const hub = new FakeHub()
  const mls = createMemoryGroupMLS({ localDID: 'alice', recoverySecret: secret })
  await persist(mls.control(), 'fork-halted')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let restoring = false
  const crypto = createFakeCrypto({
    localDID: 'alice',
    pending: {
      persistOpened: async () => {},
      list: async () => {
        restoring = true
        entered.resolve()
        await release.promise
        return []
      },
      complete: async () => {},
    },
  })
  const network = observeNetwork(hub)
  const member = makePeer(hub, { mls, crypto })
  peers.push(member)
  const ready = member.peer.outcomes()
  let readySettled = false
  void ready.then(() => {
    readySettled = true
  })
  try {
    await vi.waitFor(() => expect(member.controlWalk.safetyHold()).toBe('fork-halted'))
    expect(member.peer.reauthorize.bind(member.peer)).toThrow(
      new GroupSafetyHeldError('fork-halted'),
    )
    await vi.waitFor(() => expect(restoring).toBe(true))
    await entered.promise
    expect(readySettled).toBe(false)
    assertZero(network)
  } finally {
    release.resolve()
    await ready
  }
})

test.each(['enqueue', 'request', 'gather', 'to', 'resync'] as const)(
  '%s refuses before ready while a startup fork halt write keeps failing',
  async (entry) => {
    const hub = new FakeHub()
    const mls = createMemoryGroupMLS({ localDID: 'alice', recoverySecret: secret, epoch: 1 })
    const apply = mls.control().apply
    const haltWrites = vi.fn()
    const control: ControlStore = {
      ...mls.control(),
      apply: async (changes, mutationID) => {
        if (changes.forkHalt !== undefined) {
          haltWrites()
          throw new Error('halt storage unavailable')
        }
        return apply(changes, mutationID)
      },
    }
    const release = Promise.withResolvers<void>()
    const crypto = createFakeCrypto({
      localDID: 'alice',
      pending: {
        persistOpened: async () => {},
        list: async () => {
          await release.promise
          return []
        },
        complete: async () => {},
      },
    })
    vi.useFakeTimers()
    const member = makePeer(hub, { mls, control, crypto })
    peers.push(member)
    const halting = member.controlWalk.haltFork({
      kind: 'epoch-authenticator',
      epoch: 1,
      local: new Uint8Array([1]),
      remote: new Uint8Array([2]),
    })
    let readySettled = false
    const ready = member.peer
      .outcomes()
      .finally(() => {
        readySettled = true
      })
      .catch(() => {})
    const protocol = member.peer.protocol('chat')
    const calls: Record<typeof entry, () => Promise<unknown>> = {
      enqueue: () => member.peer.enqueue(buildLedgerCommit(member, [])),
      request: () => protocol.request('chat/echo', { param: {} }),
      gather: () => protocol.gather('chat/echo', { param: {} }),
      to: () => protocol.to('bob'),
      resync: () => member.peer.resync(),
    }
    const expected =
      entry === 'request' || entry === 'gather' || entry === 'to'
        ? new SendNotAdmissibleError('fork-halted')
        : new GroupSafetyHeldError('fork-halted')
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await vi.waitFor(() => expect(haltWrites.mock.calls.length).toBeGreaterThanOrEqual(2))
      expect(member.controlWalk.safetyHold()).toBe('fork-halted')
      expect((await control.load()).forkHalt).toBeNull()
      expect(readySettled).toBe(false)
      const pending = new Promise<string>((resolve) => {
        deadline = setTimeout(() => resolve('still waiting for ready'), 10)
      })
      await Promise.all([
        expect(Promise.race([calls[entry](), pending])).rejects.toEqual(expected),
        vi.advanceTimersByTimeAsync(10),
      ])
      expect(readySettled).toBe(false)
    } finally {
      clearTimeout(deadline)
      await member.peer.dispose()
      release.resolve()
      await halting
      await ready
    }
  },
)

test('clean safety load precedes exactly one receive', async () => {
  const hub = new FakeHub()
  const mls = createMemoryGroupMLS({ localDID: 'alice', recoverySecret: secret })
  const order: Array<string> = []
  const load = mls.control().load
  const control = {
    ...mls.control(),
    load: async () => {
      const snapshot = await load()
      order.push('safety-loaded')
      return snapshot
    },
  }
  const receive = hub.receive.bind(hub)
  vi.spyOn(hub, 'receive').mockImplementation((...args) => {
    order.push('receive')
    return receive(...args)
  })
  const mux = observeMux()
  const member = makePeer(hub, { mls, control })
  peers.push(member)
  await member.peer.outcomes()
  expect(order[0]).toBe('safety-loaded')
  expect(order.filter((stage) => stage === 'receive')).toHaveLength(1)
  expect(mux.start).toHaveBeenCalledOnce()
})

test('a halt discovered by the startup pull stops later runtime stages', async () => {
  const { hub, member } = await seed()
  await member.peer.dispose()
  await member.peer.drained()
  const fetch = hub.fetchTopic.bind(hub)
  let again: TestPeer | undefined
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
    if (params.topicID === commitTopic(secret)) {
      entered.resolve()
      await release.promise
      if (again === undefined) throw new Error('Missing restarted peer')
      latchPeerSafety(again, 'fork-halted')
    }
    return fetch(params)
  })
  const runtime = observeRuntime()
  const mux = observeMux()
  const deliver = vi.fn(async (_row: WelcomeObligation) => {})
  again = makePeer(hub, { restartOf: member, deliverWelcome: deliver })
  peers.push(again)
  const ready = again.peer.outcomes()
  await entered.promise
  const subscribe = vi.spyOn(hub, 'subscribe')
  mux.retain.mockClear()
  const lateEpoch = vi.spyOn(again.mls, 'readEpoch')
  const request = buildLedgerCommit(again, [])
  const owed: WelcomeObligation = {
    opID: 'owed-mid-startup',
    welcome: new Uint8Array([7]),
    recipients: ['bob'],
    committed: true,
  }
  await again.control.apply(
    {
      putOperations: [{ ...request, stage: 'intent', seq: 1, enqueuedAt: 0, deadline: 0 }],
      putWelcomes: [owed],
    },
    'mid-startup-obligations',
  )
  release.resolve()
  await ready
  expect(again.controlWalk.safetyHold()).toBe('fork-halted')
  assertZero({ subscribe, retain: mux.retain, lateEpoch, buildEpoch: runtime.buildEpoch })
  expect((await again.control.load()).operations).toEqual([])
  expect((await again.control.load()).outcomes).toMatchObject([{ opID: request.id, kind: 'lost' }])
  expect(deliver).toHaveBeenCalledExactlyOnceWith(owed)
  expect((await again.control.load()).welcomes).toEqual([])
})

test.each(reasons.flatMap((reason) => [false, true].map((restart) => [reason, restart] as const)))(
  'opened plaintext completes under %s, restart=%s',
  async (reason, restart) => {
    const hub = new FakeHub()
    const record: PendingAppFrame = {
      frame: {
        id: 'opened',
        topicID: 'owed-app-topic',
        protocol: 'chat',
        segment: 1,
        position: '000001',
      },
      payload: encodeEventFrame('chat/posted', { text: 'owed plaintext' }),
      senderDID: 'bob',
    }
    const records = new Map([[record.frame.id, record]])
    const complete = vi.fn(async (id: string) => {
      records.delete(id)
    })
    const crypto = createFakeCrypto({
      localDID: 'alice',
      pending: {
        persistOpened: async () => {},
        list: async () => [...records.values()],
        complete,
      },
    })
    let available = false
    const handler = vi.fn(async () => {
      if (!available) throw new Error('handler unavailable')
    })
    const member = makePeer(hub, {
      crypto,
      handlers: { 'chat/posted': handler },
    })
    peers.push(member)
    await member.peer.outcomes()
    await vi.waitFor(() => expect(handler).toHaveBeenCalled())
    if (restart) {
      await member.peer.dispose()
      await member.peer.drained()
    }
    await persist(member.control, reason)
    if (!restart) latchPeerSafety(member, reason)
    available = true
    handler.mockClear()
    const network = observeNetwork(hub)
    const runtime = observeRuntime()
    const before = crypto.starts
    const runner = restart
      ? makePeer(hub, {
          restartOf: member,
          handlers: { 'chat/posted': handler },
        })
      : member
    const work = { ...observeWork(runner), ...runtime }
    if (restart) peers.push(runner)
    await runner.peer.outcomes()
    if (!restart) await runner.peer.retryAppDelivery()
    await vi.waitFor(() => expect(records.size).toBe(0))
    expect(handler).toHaveBeenCalledWith({
      data: { text: 'owed plaintext' },
      message: { payload: { iss: 'bob' } },
      frame: record.frame,
    })
    expect(complete).toHaveBeenCalledExactlyOnceWith('opened')
    assertZero(network)
    assertZero(work)
    expect(crypto.starts).toEqual(before)
    if (restart)
      expect(runner.crypto.starts).toEqual({ wrap: 0, unwrap: 0, sealEntries: 0, openEntries: 0 })
  },
)

test.each(reasons.flatMap((reason) => [false, true].map((restart) => [reason, restart] as const)))(
  'exact applied cleanup emits and acks outcomes under %s, restart=%s',
  async (reason, restart) => {
    const onOutcome = vi.fn()
    const { hub, member } = await seed({ onOutcome })
    const op = await seedBuiltOperation(member, buildLedgerCommit(member, []))
    const position = asLogPosition('000001')
    const outcome = { id: op.id, opID: op.id, at: 1, kind: 'landed' as const, position }
    await member.control.apply(
      {
        cursor: { epoch: 99, position, stranded: true },
        strand: { reason: 'ahead' },
        putApplied: [
          {
            epoch: op.slot.epoch,
            digest: op.slot.digest,
            payloadDigest: op.slot.payloadDigest,
            sequenceID: position,
            opID: op.id,
            removed: false,
          },
        ],
        putOutcomes: [outcome],
      },
      'exact-applied',
    )
    if (restart) {
      await member.peer.dispose()
      await member.peer.drained()
    }
    await persist(member.control, reason)
    const before = await member.control.load()
    const network = observeNetwork(hub)
    const runtime = observeRuntime()
    const runner = restart ? makePeer(hub, { restartOf: member, onOutcome }) : member
    const work = { ...observeWork(runner), ...runtime }
    if (restart) peers.push(runner)
    await runner.peer.outcomes()
    if (!restart) await runner.peer.replay()
    expect((await runner.control.load()).operations).toEqual([])
    await vi.waitFor(() => expect(onOutcome).toHaveBeenCalledWith(outcome))
    expect(await runner.peer.outcomes()).toEqual([outcome])
    await runner.peer.ack(outcome.id)
    const after = await runner.control.load()
    expect(after.outcomes).toEqual([])
    expect(after.commitOnce).toEqual(before.commitOnce)
    expect(after.applied).toEqual(before.applied)
    expect(after.cursor).toEqual(before.cursor)
    expect(after.strand).toEqual(before.strand)
    expect(after.forkHalt).toEqual(before.forkHalt)
    expect(after.recoveryUnavailable).toEqual(before.recoveryUnavailable)
    assertZero(network)
    assertZero(work)
  },
)

test.each(reasons.flatMap((reason) => [false, true].map((restart) => [reason, restart] as const)))(
  'committed Welcome handoff alone is allowed under %s, restart=%s',
  async (reason, restart) => {
    const deliver = vi.fn(async (_row: WelcomeObligation) => {})
    const { hub, member } = await seed({ deliverWelcome: deliver })
    const owed: WelcomeObligation = {
      opID: 'committed',
      welcome: new Uint8Array([1, 3, 5]),
      recipients: ['bob'],
      committed: true,
    }
    const blocked: WelcomeObligation = {
      opID: 'uncommitted',
      welcome: new Uint8Array([2, 4, 6]),
      recipients: ['carol'],
    }
    if (restart) {
      await member.peer.dispose()
      await member.peer.drained()
    }
    await member.control.apply({ putWelcomes: [owed, blocked] }, 'owed-welcomes')
    await persist(member.control, reason)
    const network = observeNetwork(hub)
    const runtime = observeRuntime()
    const runner = restart
      ? makePeer(hub, {
          restartOf: member,
          deliverWelcome: deliver,
        })
      : member
    const work = { ...observeWork(runner), ...runtime }
    if (restart) peers.push(runner)
    await runner.peer.outcomes()
    if (!restart) await runner.peer.replay()
    await vi.waitFor(async () => expect((await runner.control.load()).welcomes).toEqual([blocked]))
    expect(deliver).toHaveBeenCalledExactlyOnceWith(owed)
    assertZero(network)
    assertZero(work)
  },
)

test.each(reasons)(
  'held restart retries failed cleanup under %s without network',
  async (reason) => {
    const onOutcome = vi.fn()
    const deliver = vi.fn(async (_row: WelcomeObligation) => {})
    const { hub, member } = await seed()
    const op = await seedBuiltOperation(member, buildLedgerCommit(member, []))
    await member.peer.dispose()
    await member.peer.drained()
    const position = asLogPosition('000001')
    const outcome = { id: op.id, opID: op.id, at: 1, kind: 'landed' as const, position }
    const owed: WelcomeObligation = {
      opID: 'separately-committed',
      welcome: new Uint8Array([1, 3, 5]),
      recipients: ['bob'],
      committed: true,
    }
    await member.control.apply(
      {
        cursor: { epoch: 99, position, stranded: true },
        strand: { reason: 'ahead' },
        putApplied: [
          {
            epoch: op.slot.epoch,
            digest: op.slot.digest,
            payloadDigest: op.slot.payloadDigest,
            sequenceID: position,
            opID: op.id,
            removed: false,
          },
        ],
        putOutcomes: [outcome],
        putWelcomes: [owed],
      },
      'cleanup-and-welcome',
    )
    await persist(member.control, reason)
    const before = await member.control.load()
    const apply = member.control.apply
    let available = false
    const cleanup = vi.fn()
    const error = new Error('cleanup storage unavailable')
    const control: ControlStore = {
      ...member.control,
      apply: async (changes, mutationID) => {
        if (changes.deleteOperations?.includes(op.id)) {
          cleanup()
          if (!available) throw error
        }
        await apply(changes, mutationID)
      },
    }
    const network = observeNetwork(hub)
    const runtime = observeRuntime()
    vi.useFakeTimers()
    const runner = makePeer(hub, { restartOf: member, control, onOutcome, deliverWelcome: deliver })
    const work = { ...observeWork(runner), ...runtime }
    peers.push(runner)
    expect(await runner.peer.outcomes().catch((failure: unknown) => failure)).toEqual([outcome])
    expect(cleanup).toHaveBeenCalledOnce()
    expect((await control.load()).operations).toHaveLength(1)
    assertZero(network)
    assertZero(work)

    available = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect((await control.load()).operations).toEqual([])
    expect(deliver).toHaveBeenCalledExactlyOnceWith(owed)
    expect((await control.load()).welcomes).toEqual([])
    expect(onOutcome).toHaveBeenCalledWith(outcome)
    expect(await runner.peer.outcomes()).toEqual([outcome])
    await runner.peer.ack(outcome.id)
    await runner.peer.replay()
    await vi.advanceTimersByTimeAsync(60_000)
    const after = await control.load()
    expect(after.outcomes).toEqual([])
    expect(after.commitOnce).toEqual(before.commitOnce)
    expect(after.applied).toEqual(before.applied)
    expect(after.cursor).toEqual(before.cursor)
    expect(after.strand).toEqual(before.strand)
    expect(after.forkHalt).toEqual(before.forkHalt)
    expect(after.recoveryUnavailable).toEqual(before.recoveryUnavailable)
    assertZero(network)
    assertZero(work)
  },
)

test('held storage failure preserves the startup error and retries without ready or operations', async () => {
  const { hub, member } = await seed()
  await member.peer.dispose()
  await member.peer.drained()
  const owed: WelcomeObligation = {
    opID: 'owed-after-startup-error',
    welcome: new Uint8Array([7, 9]),
    recipients: ['bob'],
    committed: true,
  }
  await member.control.apply({ putWelcomes: [owed] }, 'owed-after-startup-error')
  const startupError = new Error('anchor load failed')
  const storageError = new Error('held storage load failed')
  const load = member.control.load
  let failLoad = false
  const control: ControlStore = {
    ...member.control,
    load: async () => {
      if (failLoad) {
        failLoad = false
        throw storageError
      }
      return load()
    },
  }
  let runner: TestPeer
  vi.spyOn(member.anchorStore, 'load').mockImplementation(async () => {
    await persist(member.control, 'fork-halted')
    latchPeerSafety(runner, 'fork-halted')
    failLoad = true
    throw startupError
  })
  const deliver = vi.fn(async (_row: WelcomeObligation) => {})
  vi.useFakeTimers()
  runner = makePeer(hub, { restartOf: member, control, deliverWelcome: deliver })
  peers.push(runner)
  expect(await runner.peer.outcomes().catch((failure: unknown) => failure)).toBe(startupError)
  const network = observeNetwork(hub)
  const work = { ...observeWork(runner), ...observeRuntime() }
  await vi.advanceTimersByTimeAsync(1_000)
  expect(deliver).toHaveBeenCalledExactlyOnceWith(owed)
  expect((await control.load()).welcomes).toEqual([])
  expect((await control.load()).operations).toEqual([])
  expect(await runner.peer.outcomes().catch((failure: unknown) => failure)).toBe(startupError)
  assertZero(network)
  assertZero(work)
})
