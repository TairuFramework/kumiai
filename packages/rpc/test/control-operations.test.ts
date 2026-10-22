import { expect, test, vi } from 'vitest'

import {
  enqueueOperation,
  type OperationDeps,
  stepLiveBuild,
  stepOperation,
} from '../src/control/operations.js'
import { asLogPosition } from '../src/cursor.js'
import { StorageOutcomeUnknownError } from '../src/errors.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { buildLedgerCommit, makeMLSPeer, seedBuiltOperation } from './fixtures/peer.js'

async function preparationFixture() {
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(71))
  await member.peer.replay()
  const unreachable = async (): Promise<never> => {
    throw new Error('Unexpected operation path')
  }
  const deps: OperationDeps = {
    control: member.control,
    haltFork: unreachable,
    safetyHold: () => null,
    prepareBuild: unreachable,
    adopt: unreachable,
    frame: unreachable,
    readEvidence: unreachable,
    readHead: unreachable,
    publish: unreachable,
    pullToHead: async () => {},
    now: () => 123,
    newID: () => crypto.randomUUID(),
    emit: vi.fn(),
  }
  const op = await enqueueOperation(deps, buildLedgerCommit(member, ['prepare']))
  return { member, deps, op }
}

test.each(['not authorised', 'holder evidence refused'])(
  'explicit preparation rejection persists before notifying: %s',
  async (reason) => {
    const { member, deps, op } = await preparationFixture()
    try {
      deps.prepareBuild = async (operation) => ({ kind: 'rejected', operation, reason })
      deps.emit = vi.fn(async (outcome) => {
        expect((await member.control.load()).outcomes).toEqual([outcome])
      })
      expect(await stepOperation(deps, op)).toBeNull()
      expect((await member.control.load()).operations).toEqual([])
      expect((await member.control.load()).outcomes).toMatchObject([
        { opID: op.id, kind: 'rejected', reason },
      ])
      expect(deps.emit).toHaveBeenCalledOnce()
      await vi.mocked(deps.emit).mock.results[0]?.value
    } finally {
      await member.peer.dispose()
      await member.peer.drained()
    }
  },
)

test.each(['occupied', 'moved'] as const)(
  'preparation %s preserves the intent and writes no outcome',
  async (kind) => {
    const { member, deps, op } = await preparationFixture()
    try {
      deps.prepareBuild = async (operation) => ({ kind, operation })
      const before = await member.control.load()
      expect(await stepOperation(deps, op)).toEqual(op)
      expect(await member.control.load()).toEqual(before)
      expect(deps.emit).not.toHaveBeenCalled()
    } finally {
      await member.peer.dispose()
      await member.peer.drained()
    }
  },
)

test('transport retries exact saved bytes before expiry and makes no handoff at expiry', async () => {
  const { member, deps } = await preparationFixture()
  try {
    await member.control.apply(
      { deleteOperations: (await member.control.load()).operations.map(({ id }) => id) },
      'discard-fixture-intent',
    )
    const saved = await seedBuiltOperation(member, buildLedgerCommit(member, ['saved']))
    let now = saved.enqueuedAt
    let head = asLogPosition('head-1')
    deps.now = () => now
    deps.readEvidence = async () => ({
      source: await member.mls.readRecoverySource(),
      applied: [],
      cursor: null,
      terminal: false,
    })
    deps.readHead = async () => head
    deps.publish = vi.fn(async () => {
      throw new Error('Transport unavailable')
    })
    await stepLiveBuild(deps)
    head = asLogPosition('head-2')
    await member.database.saveState('alice', member.mls.serializeState())
    await stepLiveBuild(deps)
    expect(deps.publish).toHaveBeenCalledTimes(2)
    expect(
      vi.mocked(deps.publish).mock.calls.map(([payload, publishID]) => ({ payload, publishID })),
    ).toEqual([
      { payload: saved.slot.payload, publishID: saved.slot.publishID },
      { payload: saved.slot.payload, publishID: saved.slot.publishID },
    ])
    now = saved.deadline
    head = asLogPosition('head-3')
    await stepLiveBuild(deps)
    expect(deps.publish).toHaveBeenCalledTimes(2)
    expect((await member.control.load()).commitOnce?.publishID).toBe(saved.slot.publishID)
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

async function liveFixture() {
  const fixture = await preparationFixture()
  await fixture.member.control.apply({ deleteOperations: [fixture.op.id] }, 'discard-intent')
  const saved = await seedBuiltOperation(
    fixture.member,
    buildLedgerCommit(fixture.member, ['saved']),
  )
  const { deps, member } = fixture
  deps.now = () => saved.enqueuedAt
  deps.readEvidence = async () => ({
    source: await member.mls.readRecoverySource(),
    applied: [],
    cursor: null,
    terminal: false,
  })
  deps.readHead = async () => asLogPosition('retry-head')
  deps.publish = vi.fn(async () => ({ sequenceID: 'accepted' }))
  return { ...fixture, saved }
}

test('proposal changes preserve identical saved bytes and publishID', async () => {
  const { member, deps, saved } = await liveFixture()
  try {
    await member.database.saveState('alice', member.mls.serializeState())
    await stepLiveBuild(deps)
    expect(deps.publish).toHaveBeenCalledWith(
      saved.slot.payload,
      saved.slot.publishID,
      asLogPosition('retry-head'),
    )
    expect((await member.control.load()).commitOnce).toMatchObject({
      journal: saved.slot.journal,
      head: saved.slot.head,
    })
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('a saved absolute deadline survives restart with changed timeout configuration', async () => {
  const { member, deps, saved } = await liveFixture()
  try {
    deps.operationTimeoutMs = 1_000_000
    deps.now = () => saved.deadline
    await stepLiveBuild(deps)
    expect((await member.control.load()).commitOnce).toMatchObject({
      deadline: saved.deadline,
      reported: true,
    })
    expect(deps.publish).not.toHaveBeenCalled()
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('an in-flight handoff may land after deadline without another handoff', async () => {
  const { member, deps, saved } = await liveFixture()
  try {
    const accepting = Promise.withResolvers<{ sequenceID: string }>()
    deps.publish = vi.fn(() => accepting.promise)
    const running = stepLiveBuild(deps)
    await vi.waitFor(() => expect(deps.publish).toHaveBeenCalledOnce())
    deps.now = () => saved.deadline
    accepting.resolve({ sequenceID: 'late-accepted' })
    await running
    await stepLiveBuild(deps)
    expect((await member.control.load()).commitOnce).toMatchObject({
      acceptedAs: 'late-accepted',
      reported: true,
    })
    expect(deps.publish).toHaveBeenCalledOnce()
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('a refused handoff cannot erase earlier ambiguous acceptance', async () => {
  const { member, deps, saved } = await liveFixture()
  try {
    deps.publish = vi.fn(async () => {
      const built = (await member.control.load()).commitOnce
      if (built === null) throw new Error('Missing build')
      await member.control.apply(
        { commitOnce: { ...built, acceptedAs: asLogPosition('earlier') } },
        'concurrent-ack',
      )
      throw new Error('Refused handoff')
    })
    await stepLiveBuild(deps)
    await stepLiveBuild(deps)
    expect((await member.control.load()).commitOnce).toMatchObject({
      acceptedAs: 'earlier',
      payload: saved.slot.payload,
    })
    expect(deps.publish).toHaveBeenCalledOnce()
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('expiry under a safety hold uses storage only and reports once', async () => {
  const { member, deps, saved } = await liveFixture()
  try {
    deps.now = () => saved.deadline
    deps.safetyHold = () => 'fork-halted'
    deps.pullToHead = vi.fn()
    deps.readEvidence = vi.fn()
    await stepLiveBuild(deps)
    const first = (await member.control.load()).outcomes
    await member.control.apply({ deleteOutcomes: first.map(({ id }) => id) }, 'ack')
    await stepLiveBuild(deps)
    expect(first).toMatchObject([{ opID: saved.id, kind: 'unknown' }])
    expect((await member.control.load()).outcomes).toEqual([])
    expect(deps.pullToHead).not.toHaveBeenCalled()
    expect(deps.readEvidence).not.toHaveBeenCalled()
    expect(deps.emit).toHaveBeenCalledOnce()
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('publication errors emit diagnostics while retaining the live build', async () => {
  const { member, deps, saved } = await liveFixture()
  try {
    const error = new Error('Transport unavailable')
    deps.publish = vi.fn(async () => {
      throw error
    })
    deps.publishFailed = vi.fn()
    await stepLiveBuild(deps)
    expect(deps.publishFailed).toHaveBeenCalledWith(saved.id, error)
    expect((await member.control.load()).commitOnce?.payload).toEqual(saved.slot.payload)
    expect((await member.control.load()).outcomes).toEqual([])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('an intent expiring during a held or terminal source read loses without preparation', async () => {
  const { member, deps, op } = await preparationFixture()
  try {
    deps.pullToHead = async () => {
      deps.now = () => op.deadline
    }
    deps.prepareBuild = vi.fn()
    await stepOperation(deps, op)
    expect((await member.control.load()).outcomes).toMatchObject([{ opID: op.id, kind: 'lost' }])
    expect(deps.prepareBuild).not.toHaveBeenCalled()
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('a final report is preserved when an obsolete runner expires', async () => {
  const { member, deps, op } = await preparationFixture()
  try {
    const final = {
      id: 'final',
      opID: op.id,
      at: 1,
      kind: 'landed' as const,
      position: asLogPosition('winner'),
    }
    await member.control.apply({ deleteOperations: [op.id], putOutcomes: [final] }, 'closed')
    deps.now = () => op.deadline
    await stepOperation(deps, op)
    await stepLiveBuild(deps)
    expect((await member.control.load()).outcomes).toEqual([final])
    expect(deps.emit).not.toHaveBeenCalled()
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('same-epoch authenticator divergence never republishes saved bytes', async () => {
  const { member, deps } = await preparationFixture()
  try {
    await member.control.apply(
      { deleteOperations: (await member.control.load()).operations.map(({ id }) => id) },
      'discard-fixture-intent',
    )
    const saved = await seedBuiltOperation(member, buildLedgerCommit(member, ['saved']))
    const source = await member.mls.readRecoverySource()
    if (source.identity === null) throw new Error('Missing source')
    const identity = source.identity
    deps.now = () => saved.enqueuedAt
    deps.readEvidence = async () => ({
      source: { ...source, identity: { ...identity, authenticator: new Uint8Array([255]) } },
      applied: [],
      cursor: null,
      terminal: false,
    })
    deps.publish = vi.fn()
    await stepLiveBuild(deps)
    expect(deps.publish).not.toHaveBeenCalled()
    expect((await member.control.load()).commitOnce).toEqual(saved.slot)
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('transient preparation failure preserves the intent without reporting', async () => {
  const { member, deps, op } = await preparationFixture()
  try {
    const failure = new Error('Temporary local preparation failure')
    deps.prepareBuild = async () => {
      throw failure
    }
    const before = await member.control.load()
    await expect(stepOperation(deps, op)).rejects.toBe(failure)
    expect(await member.control.load()).toEqual(before)
    expect(deps.emit).not.toHaveBeenCalled()
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('a rolled-back rejection emits only after a durable retry', async () => {
  const { member, deps, op } = await preparationFixture()
  try {
    deps.prepareBuild = async (operation) => ({ kind: 'rejected', operation, reason: 'policy' })
    const failure = new Error('Storage rolled back')
    const apply = member.control.apply.bind(member.control)
    vi.spyOn(member.control, 'apply').mockRejectedValueOnce(failure)
    await expect(stepOperation(deps, op)).rejects.toBe(failure)
    expect(deps.emit).not.toHaveBeenCalled()
    expect((await member.control.load()).operations).toEqual([op])
    expect((await member.control.load()).outcomes).toEqual([])
    vi.mocked(member.control.apply).mockImplementation(apply)
    expect(await stepOperation(deps, op)).toBeNull()
    expect(deps.emit).toHaveBeenCalledWith((await member.control.load()).outcomes[0])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('enqueue persists an absolute deadline and FIFO order through ambiguous completion', async () => {
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(68))
  try {
    await member.peer.replay()
    const apply = member.control.apply.bind(member.control)
    let ambiguous = true
    vi.spyOn(member.control, 'apply').mockImplementation(async (changes, mutationID) => {
      await apply(changes, mutationID)
      if (ambiguous) {
        ambiguous = false
        throw new StorageOutcomeUnknownError()
      }
    })
    const deps = {
      control: member.control,
      now: () => 123,
      newID: () => crypto.randomUUID(),
      operationTimeoutMs: 456,
    }
    const first = await enqueueOperation(deps, buildLedgerCommit(member, ['one']))
    const second = await enqueueOperation(deps, buildLedgerCommit(member, ['two']))
    expect(first).toMatchObject({ enqueuedAt: 123, deadline: 579, stage: 'intent' })
    expect(second.seq).toBe(first.seq + 1)
    expect((await member.control.load()).operations).toEqual([first, second])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('an expired unbuilt intent loses without preparation', async () => {
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(69))
  try {
    await member.peer.replay()
    const request = buildLedgerCommit(member, ['one'])
    const op = await enqueueOperation(
      {
        control: member.control,
        now: () => 1,
        newID: () => crypto.randomUUID(),
        operationTimeoutMs: 1,
      },
      request,
    )
    await member.controlWalk.stepOperation(op.id)
    const snapshot = await member.control.load()
    expect(snapshot.operations).toEqual([])
    expect(snapshot.commitOnce).toBeNull()
    expect(snapshot.outcomes).toMatchObject([{ opID: op.id, kind: 'lost' }])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('the enqueue default expires exactly thirty seconds after enqueue', async () => {
  const { member, deps, op } = await preparationFixture()
  try {
    expect(op.deadline).toBe(30_123)
    deps.prepareBuild = vi.fn(async (operation) => ({ kind: 'moved' as const, operation }))
    deps.now = () => 30_122
    expect(await stepOperation(deps, op)).toEqual(op)
    expect((await member.control.load()).outcomes).toEqual([])
    deps.now = () => 30_123
    expect(await stepOperation(deps, op)).toBeNull()
    expect(deps.prepareBuild).toHaveBeenCalledOnce()
    expect((await member.control.load()).outcomes).toMatchObject([{ opID: op.id, kind: 'lost' }])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('an expired saved build reports once and stays live across acknowledgement', async () => {
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(70))
  try {
    await member.peer.replay()
    const saved = await seedBuiltOperation(member, buildLedgerCommit(member, ['one']))
    const clock = vi.spyOn(Date, 'now').mockReturnValue(saved.deadline)
    try {
      await member.controlWalk.stepOperation(saved.id)
      const snapshot = await member.control.load()
      expect(snapshot.commitOnce).toMatchObject({ reported: true, publishID: saved.slot.publishID })
      expect(snapshot.outcomes).toMatchObject([{ opID: saved.id, kind: 'unknown' }])
      const outcome = snapshot.outcomes[0]
      if (outcome === undefined) throw new Error('Missing provisional outcome')
      await member.peer.ack(outcome.id)
      await member.controlWalk.stepOperation(saved.id)
      expect((await member.control.load()).outcomes).toEqual([])
      expect((await member.control.load()).commitOnce).not.toBeNull()
    } finally {
      clock.mockRestore()
    }
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})
