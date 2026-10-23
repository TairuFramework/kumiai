import { afterEach, expect, test, vi } from 'vitest'

import type { OperationRequest, Outcome } from '../src/control/types.js'
import { asLogPosition } from '../src/cursor.js'
import type { InternalOperations } from '../src/peer-types.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { buildLedgerCommit, makeMLSPeer, type TestPeer } from './fixtures/peer.js'

const peers: Array<TestPeer> = []
afterEach(async () => {
  for (const member of peers.splice(0)) {
    await member.peer.dispose()
    await member.peer.drained()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const secret = new Uint8Array(32).fill(71)

test('a report queued during drain finalisation is delivered without another flush', async () => {
  const observed: Array<string> = []
  const member = makeMLSPeer(new FakeHub(), 'alice', secret, {
    internalOperations: {
      bind: () => {},
      onOutcome: (outcome) => {
        observed.push(outcome.id)
      },
    },
  })
  peers.push(member)
  await member.peer.replay()
  const release = Promise.withResolvers<void>()
  const queue = globalThis.queueMicrotask
  const finish = Promise.prototype.finally
  let inMicrotask = false
  let held = false
  let finalising = false
  // Widen the cleanup window without depending on a fixed number of promise turns.
  const queueSpy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
    queue(() => {
      inMicrotask = true
      try {
        callback()
      } finally {
        inMicrotask = false
      }
    })
  })
  const finallySpy = vi.spyOn(Promise.prototype, 'finally').mockImplementation(function (
    this: Promise<unknown>,
    callback,
  ) {
    if (!inMicrotask || held) return finish.call(this, callback)
    held = true
    return finish.call(this, async () => {
      finalising = true
      await release.promise
      callback?.()
    })
  })
  const outcome = (id: string): Outcome => ({
    id,
    opID: `kumiai/internal/${id}`,
    kind: 'lost',
    at: 100,
  })
  try {
    await member.control.apply({ putOutcomes: [outcome('first')] }, 'save-first')
    await member.peer.replay()
    await vi.waitFor(() => expect(finalising).toBe(true))
    expect(observed).toEqual(['first'])
    await member.control.apply({ putOutcomes: [outcome('last')] }, 'save-last')
    await member.peer.replay()
    expect(observed).toEqual(['first'])
  } finally {
    queueSpy.mockRestore()
    finallySpy.mockRestore()
    release.resolve()
  }
  await vi.waitFor(() => expect(observed).toEqual(['first', 'last']))
  expect((await member.control.load()).outcomes).toEqual([])
})

test('internal deletion retries grow to a cap and retain the row until consumed', async () => {
  const observed = vi.fn()
  let enqueue!: (request: OperationRequest) => Promise<void>
  const member = makeMLSPeer(new FakeHub(), 'alice', secret, {
    internalOperations: {
      bind: (capability) => {
        enqueue = capability.enqueue
      },
      onOutcome: observed,
    },
  })
  peers.push(member)
  await member.peer.replay()
  const outcome: Outcome = {
    id: 'retry-report',
    opID: 'kumiai/internal/retry',
    kind: 'lost',
    at: 100,
  }
  await member.control.apply({ putOutcomes: [outcome] }, 'save-retry')
  const apply = member.control.apply.bind(member.control)
  let attempts = 0
  let unavailable = true
  vi.spyOn(member.control, 'apply').mockImplementation(async (changes, mutationID) => {
    if (changes.deleteOutcomes?.includes(outcome.id)) {
      attempts++
      if (unavailable) throw new Error('Storage unavailable')
    }
    await apply(changes, mutationID)
  })
  vi.useFakeTimers()
  await member.peer.replay()
  await vi.advanceTimersByTimeAsync(0)
  expect(attempts).toBe(1)
  await expect(
    enqueue({ ...buildLedgerCommit(member, []), id: 'kumiai/internal/retry' }),
  ).rejects.toMatchObject({ name: 'OperationRejectedError' })
  expect((await member.control.load()).operations).toEqual([])
  for (const delay of [250, 500, 1000, 2000, 4000, 8000, 15000, 15000]) {
    const before = attempts
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(attempts).toBe(before)
    expect((await member.control.load()).outcomes).toEqual([outcome])
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(before + 1)
  }
  expect(observed).not.toHaveBeenCalled()
  unavailable = false
  await vi.advanceTimersByTimeAsync(15000)
  expect(observed).toHaveBeenCalledExactlyOnceWith(outcome)
  expect((await member.control.load()).outcomes).toEqual([])
})

test.each(['landed', 'lost'] as const)(
  'internal %s replay is consumed before a callback that can enqueue',
  async (kind) => {
    const seed = makeMLSPeer(new FakeHub(), 'alice', secret)
    peers.push(seed)
    await seed.peer.replay()
    await seed.peer.dispose()
    await seed.peer.drained()
    const outcome: Outcome = {
      id: 'final-report',
      opID: 'kumiai/internal/rotation',
      at: 100,
      ...(kind === 'landed' ? { kind, position: asLogPosition('1') } : { kind }),
    }
    await seed.control.apply({ putOutcomes: [outcome] }, 'save-report')
    let enqueue!: (request: OperationRequest) => Promise<void>
    const onOutcome = vi.fn()
    let member: TestPeer
    const observed = vi.fn(async (value: Outcome) => {
      if (value.id !== outcome.id) return
      expect(value).toEqual(outcome)
      expect((await member.control.load()).outcomes).toEqual([])
      await enqueue({ ...buildLedgerCommit(member, []), id: 'kumiai/internal/next' })
    })
    const internalOperations: InternalOperations = {
      bind: (capability) => {
        enqueue = capability.enqueue
      },
      onOutcome: observed,
    }
    member = makeMLSPeer(new FakeHub(), 'alice', secret, {
      restartOf: seed,
      internalOperations,
      onOutcome,
    })
    peers.push(member)
    await member.peer.replay()
    expect(onOutcome).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(observed).toHaveBeenCalledOnce())
    await vi.waitFor(async () =>
      expect(
        (await member.control.load()).operations.some(({ id }) => id === 'kumiai/internal/next'),
      ).toBe(true),
    )
    await member.peer.replay()
    expect(observed.mock.calls.filter(([value]) => value.id === outcome.id)).toHaveLength(1)
    expect(onOutcome).not.toHaveBeenCalled()
    expect(await member.peer.outcomes()).toEqual([])
  },
)

test('the private capability checks namespace, disposal and recovery-only admission', async () => {
  for (const recoveryOnly of [false, true]) {
    let enqueue!: (request: OperationRequest) => Promise<void>
    const member = makeMLSPeer(new FakeHub(), 'alice', secret, {
      recoveryOnly,
      internalOperations: {
        bind: (capability) => {
          enqueue = capability.enqueue
        },
        onOutcome: vi.fn(),
      },
    })
    peers.push(member)
    await member.peer.replay()
    const request = buildLedgerCommit(member, [])
    await expect(enqueue(request)).rejects.toBeInstanceOf(TypeError)
    await expect(
      member.peer.enqueue({ ...request, id: 'kumiai/internal/public' }),
    ).rejects.toBeInstanceOf(TypeError)
    if (recoveryOnly)
      await expect(enqueue({ ...request, id: 'kumiai/internal/private' })).rejects.toThrow()
    await member.peer.dispose()
    await expect(enqueue({ ...request, id: 'kumiai/internal/disposed' })).rejects.toThrow()
  }
})
