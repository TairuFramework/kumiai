import type { AppBatchBinding, BatchBudget, BatchKind, GroupCrypto } from '@kumiai/rpc'
import { appBatch, bindAppBatch } from '@kumiai/rpc'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { coordinatorBinding, entryCapability } from '../src/entry-capability.js'
import { createGroupBatchScheduler } from '../src/group-batch.js'
import { bindGroupBatchOptions, groupBatchFor } from '../src/group-batch-binding.js'
import { createMemoryDevicePersistence } from '../src/memory-device-persistence.js'
import { createMemoryTransaction } from '../src/memory-transaction.js'
import { createGroupHandleRegistry } from '../src/registry/registry.js'
import { deferred } from '../src/runtime.js'
import { createDevicePackages } from './fixtures/device-packages.js'

const idle = async () => {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve()
}

afterEach(() => vi.useRealTimers())

describe('group batch arbitration', () => {
  test('idle lone work starts without advancing batching timers', async () => {
    vi.useFakeTimers()
    const run = vi.fn(async () => 'result')
    const scheduler = createGroupBatchScheduler({})
    const result = scheduler.schedule({ source: 'A', kind: 'open', run })
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    await expect(result).resolves.toBe('result')
  })

  test('active arrivals coalesce without waiting beyond two milliseconds', async () => {
    vi.useFakeTimers()
    const scheduler = createGroupBatchScheduler({})
    const release = deferred<void>()
    const active = scheduler.schedule({ source: 'A', kind: 'open', run: () => release.promise })
    const frames = [1]
    const collected: Array<Array<number>> = []
    const next = scheduler.schedule({
      source: 'B',
      kind: 'open',
      async run(budget) {
        budget.begin()
        const batch: Array<number> = []
        while (frames.length && budget.take()) batch.push(frames.shift() as number)
        collected.push(batch)
      },
    })
    frames.push(...Array.from({ length: 69 }, (_, index) => index + 2))
    vi.advanceTimersByTime(100)
    expect(collected).toEqual([])
    release.resolve()
    await idle()
    expect(collected).toEqual([Array.from({ length: 64 }, (_, index) => index + 1)])
    expect(frames).toEqual([65, 66, 67, 68, 69, 70])
    await Promise.all([active, next])
    const rest = scheduler.schedule({
      source: 'B',
      kind: 'open',
      async run(budget) {
        budget.begin()
        while (frames.length && budget.take()) frames.shift()
      },
    })
    await rest
    expect(frames).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  test('count and staging work stop at the next operation boundary', async () => {
    let time = 0
    const scheduler = createGroupBatchScheduler({ now: () => time })
    const release = deferred<void>()
    const active = scheduler.schedule({ source: 'A', kind: 'open', run: () => release.promise })
    const result = scheduler.schedule({
      source: 'B',
      kind: 'completion',
      async run(budget) {
        expect(budget.maxFrames).toBe(64)
        expect(budget.maxWorkMs).toBe(8)
        expect(budget.now()).toBe(100)
        time = 200 // Owner-queue wait is outside staging.
        budget.begin()
        expect(budget.take()).toBe(true)
        time = 207.99
        expect(budget.take()).toBe(true)
        budget.begin()
        time = 208
        expect(budget.take()).toBe(false)
      },
    })
    time = 100
    release.resolve()
    await Promise.all([active, result])
    await scheduler.schedule({
      source: 'count',
      kind: 'completion',
      async run(budget) {
        budget.begin()
        for (let index = 0; index < 64; index++) expect(budget.take()).toBe(true)
        expect(budget.take()).toBe(false)
      },
    })
    await scheduler.schedule({
      source: 'setup',
      kind: 'settlement',
      async run(budget) {
        budget.begin()
        time += 9
        expect(budget.take()).toBe(true)
        expect(budget.take()).toBe(false)
      },
    })
  })

  test('fresh budget after clock rollback rejects after eight elapsed milliseconds', async () => {
    let time = 108
    const scheduler = createGroupBatchScheduler({ now: () => time })
    await scheduler.schedule({
      source: 'completion',
      kind: 'completion',
      async run(budget) {
        expect(budget.now()).toBe(108)
      },
    })
    time = 90
    await scheduler.schedule({
      source: 'completion',
      kind: 'completion',
      async run(budget) {
        budget.begin()
        expect(budget.take()).toBe(true)
        time = 98
        expect(budget.take()).toBe(false)
      },
    })
  })

  test('backward clock readings cannot revive an exhausted work budget', async () => {
    let time = 100
    const scheduler = createGroupBatchScheduler({ now: () => time })
    await scheduler.schedule({
      source: 'completion',
      kind: 'completion',
      async run(budget) {
        budget.begin()
        expect(budget.take()).toBe(true)
        time = 108
        expect(budget.take()).toBe(false)
        time = 90
        expect(budget.take()).toBe(false)
        expect(budget.now()).toBe(108)
        budget.begin()
        expect(budget.take()).toBe(false)
      },
    })
    await scheduler.schedule({
      source: 'completion',
      kind: 'completion',
      async run(budget) {
        expect(budget.now()).toBe(108)
        budget.begin()
        expect(budget.take()).toBe(true)
        time = 97.99
        expect(budget.take()).toBe(true)
        time = 98
        expect(budget.take()).toBe(false)
      },
    })
  })

  test('elapsed work retains the highest clock reading before a backward jump', async () => {
    let time = 100
    const scheduler = createGroupBatchScheduler({ now: () => time })
    await scheduler.schedule({
      source: 'completion',
      kind: 'completion',
      async run(budget) {
        budget.begin()
        expect(budget.take()).toBe(true)
        time = 108
        expect(budget.now()).toBe(108)
        time = 90
        expect(budget.take()).toBe(false)
        expect(budget.now()).toBe(108)
      },
    })
  })

  test('active A then control then B fits three batches', async () => {
    vi.useFakeTimers()
    const scheduler = createGroupBatchScheduler({})
    const entered: Array<string> = []
    const release = deferred<void>()
    const runs: Array<Promise<unknown>> = []
    const offerA = () =>
      scheduler.schedule({
        source: 'A',
        kind: 'open',
        async run() {
          entered.push('A')
          if (entered.length === 1) await release.promise
          if (entered.length < 5) runs.push(offerA())
        },
      })
    runs.push(offerA())
    runs.push(
      scheduler.schedule({
        source: 'B',
        kind: 'open',
        async run() {
          entered.push('B')
        },
      }),
    )
    runs.push(
      scheduler.schedule({
        source: 'control',
        kind: 'control',
        async run() {
          entered.push('control')
        },
      }),
    )
    release.resolve()
    await idle()
    expect(entered.slice(0, 3)).toEqual(['A', 'control', 'B'])
    expect(vi.getTimerCount()).toBe(0)
    await Promise.all(runs)
  })

  test('idle ends prior control service before a new burst', async () => {
    const scheduler = createGroupBatchScheduler({})
    await scheduler.schedule({ source: 'control', kind: 'control', async run() {} })
    const release = deferred<void>()
    const entered: Array<string> = []
    const active = scheduler.schedule({
      source: 'A',
      kind: 'open',
      async run() {
        entered.push('A')
        await release.promise
      },
    })
    const offer = (source: string, kind: BatchKind) =>
      scheduler.schedule({
        source,
        kind,
        async run() {
          entered.push(source)
        },
      })
    const b = offer('B', 'open')
    const control = offer('control', 'control')
    release.resolve()
    await Promise.all([active, b, control])
    expect(entered).toEqual(['A', 'control', 'B'])
  })

  test('each ready source gets one turn per round', async () => {
    const scheduler = createGroupBatchScheduler({})
    const release = deferred<void>()
    const entered: Array<string> = []
    const runs: Array<Promise<unknown>> = []
    const offer = (source: string, kind: BatchKind) =>
      scheduler.schedule({
        source,
        kind,
        async run() {
          entered.push(source)
          if (entered.length === 1) await release.promise
          if (source === 'A' && entered.length < 4) runs.push(offer(source, kind))
          if (source === 'control' && entered.length < 6) runs.push(offer(source, kind))
        },
      })
    runs.push(offer('A', 'open'))
    // A is ready again before the other ordinary sources advertise.
    runs.push(offer('A', 'open'))
    runs.push(offer('enqueue', 'enqueue'))
    runs.push(offer('completion', 'completion'))
    runs.push(offer('settlement', 'settlement'))
    runs.push(offer('accounting', 'accounting'))
    runs.push(offer('control', 'control'))
    release.resolve()
    for (let turn = 0; turn < 5; turn++) await idle()
    expect(entered.slice(0, 6)).toEqual([
      'A',
      'control',
      'enqueue',
      'completion',
      'settlement',
      'accounting',
    ])
    expect(entered.indexOf('A', 1)).toBeGreaterThan(5)
    expect(entered.indexOf('control', 2)).toBeGreaterThan(5)
    await Promise.all(runs)
  })

  test('later arrivals join the next round behind already-ready members', async () => {
    const scheduler = createGroupBatchScheduler({})
    const firstRelease = deferred<void>()
    const roundRelease = deferred<void>()
    const entered: Array<string> = []
    const offer = (source: string, kind: BatchKind, wait?: Promise<void>) =>
      scheduler.schedule({
        source,
        kind,
        async run() {
          entered.push(source)
          await wait
        },
      })
    const active = offer('A', 'open', firstRelease.promise)
    const firstMember = offer('X', 'open', roundRelease.promise)
    const waitingMember = offer('B', 'open')
    firstRelease.resolve()
    await idle()
    expect(entered).toEqual(['A', 'X'])
    const lateControl = offer('late control', 'control')
    const repeat = offer('A', 'open')
    roundRelease.resolve()
    await Promise.all([active, firstMember, waitingMember, lateControl, repeat])
    expect(entered).toEqual(['A', 'X', 'B', 'late control', 'A'])
  })

  test('already-waiting source runs within one round despite fresh sources', async () => {
    const scheduler = createGroupBatchScheduler({})
    const firstRelease = deferred<void>()
    const roundRelease = deferred<void>()
    const entered: Array<string> = []
    const runs: Array<Promise<unknown>> = []
    const offerFresh = (index: number): Promise<unknown> =>
      scheduler.schedule({
        source: `X${index}`,
        kind: 'open',
        async run() {
          entered.push(`X${index}`)
          if (index === 0) await roundRelease.promise
          if (index < 8) runs.push(offerFresh(index + 1))
        },
      })
    runs.push(
      scheduler.schedule({
        source: 'A',
        kind: 'open',
        async run() {
          entered.push('A')
          await firstRelease.promise
        },
      }),
    )
    runs.push(offerFresh(0))
    firstRelease.resolve()
    await idle()
    expect(entered).toEqual(['A', 'X0'])
    runs.push(
      scheduler.schedule({
        source: 'A',
        kind: 'open',
        async run() {
          entered.push('A')
        },
      }),
    )
    roundRelease.resolve()
    for (let turn = 0; turn < 4; turn++) await idle()
    await Promise.all(runs)
    expect(entered.slice(0, 3)).toEqual(['A', 'X0', 'A'])
    expect(entered).toHaveLength(11)
  })

  test('post-release accounting cannot overtake buffered control and B', async () => {
    const scheduler = createGroupBatchScheduler({})
    const release = deferred<void>()
    const entered: Array<string> = []
    const reads = vi.fn()
    const runs: Array<Promise<unknown>> = []
    const offer = (source: string, kind: BatchKind) =>
      scheduler.schedule({
        source,
        kind,
        async run() {
          reads(source)
          entered.push(source)
          if (source === 'A' && entered.length === 1) {
            await release.promise
            runs.push(offer('accounting', 'accounting'))
            runs.push(offer('A', 'open'))
          }
        },
      })
    runs.push(offer('A', 'open'))
    runs.push(offer('B', 'open'))
    runs.push(offer('control', 'control'))
    expect(reads.mock.calls).toEqual([['A']])
    release.resolve()
    for (let turn = 0; turn < 3; turn++) await idle()
    expect(entered).toEqual(['A', 'control', 'B', 'accounting', 'A'])
    await Promise.all(runs)
  })

  test('group B progresses while A is suspended', async () => {
    const binding = {}
    const a = groupBatchFor(binding, 'A')
    const b = groupBatchFor(binding, 'B')
    const otherBinding = groupBatchFor({}, 'A')
    expect(groupBatchFor(binding, 'A')).toBe(a)
    expect(b).not.toBe(a)
    expect(otherBinding).not.toBe(a)
    const release = deferred<void>()
    const active = a.schedule({ source: 'proof', kind: 'completion', run: () => release.promise })
    const done = vi.fn(async () => 'done')
    const work = b.schedule({ source: 'read', kind: 'accounting', run: done })
    const other = otherBinding.schedule({ source: 'read', kind: 'accounting', run: done })
    await idle()
    expect(done).toHaveBeenCalledTimes(2)
    await expect(work).resolves.toBe('done')
    await expect(other).resolves.toBe('done')
    release.resolve()
    await Promise.all([active, work, other])
  })

  test('invalid bounds refuse before ownership', async () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -1,
      1.5,
    ]) {
      expect(() => createGroupBatchScheduler({ options: { maxBatchFrames: value } })).toThrow()
    }
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1]) {
      expect(() => createGroupBatchScheduler({ options: { maxBatchWorkMs: value } })).toThrow()
    }
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      expect(() => createGroupBatchScheduler({ options: { maxBatchDelayMs: value } })).toThrow()
    }
    const binding = {}
    expect(() => bindGroupBatchOptions(binding, { maxBatchFrames: 0 })).toThrow()
    bindGroupBatchOptions(binding, { maxBatchDelayMs: 0, maxBatchWorkMs: 0.5 })
    await groupBatchFor(binding, 'A').schedule({
      source: 'valid',
      kind: 'open',
      async run(budget) {
        expect(budget.maxWorkMs).toBe(0.5)
      },
    })
  })

  test('binding options are immutable after scheduling and opens retain their hard cap', async () => {
    vi.useFakeTimers()
    const binding = {}
    const options = { maxBatchFrames: 100, maxBatchDelayMs: 0, maxBatchWorkMs: 0.25 }
    bindGroupBatchOptions(binding, options)
    const scheduler = groupBatchFor(binding, 'A')
    const release = deferred<void>()
    let activeBudget: BatchBudget | undefined
    const active = scheduler.schedule({
      source: 'completion',
      kind: 'completion',
      async run(budget) {
        activeBudget = budget
        budget.begin()
        expect(budget.maxFrames).toBe(100)
        await release.promise
      },
    })
    expect(() => bindGroupBatchOptions(binding, { ...options, maxBatchFrames: 101 })).toThrow()
    bindGroupBatchOptions(binding, { ...options })
    expect(groupBatchFor(binding, 'A')).toBe(scheduler)
    expect(activeBudget?.maxFrames).toBe(100)
    options.maxBatchFrames = 500
    release.resolve()
    await active
    await scheduler.schedule({
      source: 'open',
      kind: 'open',
      async run(budget) {
        expect(budget.maxFrames).toBe(64)
        const admissions = Array.from({ length: 65 }, () => budget.take())
        expect(admissions.filter(Boolean)).toHaveLength(64)
        expect(admissions[64]).toBe(false)
      },
    })
    await scheduler.schedule({
      source: 'completion',
      kind: 'completion',
      async run(budget) {
        expect(budget.maxFrames).toBe(100)
      },
    })
    const defaults = {}
    const existing = groupBatchFor(defaults, 'A')
    expect(() => bindGroupBatchOptions(defaults, { maxBatchFrames: 2 })).toThrow()
    bindGroupBatchOptions(defaults, { maxBatchFrames: 64, maxBatchDelayMs: 2, maxBatchWorkMs: 8 })
    expect(groupBatchFor(defaults, 'A')).toBe(existing)
  })

  test('closing a source cannot reroute queued work to a new incarnation', async () => {
    const scheduler = groupBatchFor({}, 'group')
    const release = deferred<void>()
    const entered: Array<string> = []
    const active = scheduler.schedule({
      source: 'active',
      kind: 'open',
      run: () => release.promise,
    })
    const cancellation = new AbortController()
    const reason = new Error('Runtime disposed')
    const oldKey = { groupID: 'group', incarnation: 1 }
    const newKey = { groupID: 'group', incarnation: 2 }
    const oldRun = vi.fn(async () => oldKey)
    const withdrawn = scheduler.schedule({
      source: 'open',
      kind: 'open',
      signal: cancellation.signal,
      run: oldRun,
    })
    const rejected = expect(withdrawn).rejects.toBe(reason)
    const cold = scheduler.schedule({
      source: 'owed',
      kind: 'completion',
      async run() {
        entered.push('cold')
        return oldKey
      },
    })
    cancellation.abort(reason)
    const fresh = scheduler.schedule({
      source: 'open',
      kind: 'open',
      async run() {
        entered.push('fresh')
        return newKey
      },
    })
    await rejected
    expect(oldRun).not.toHaveBeenCalled()
    release.resolve()
    await active
    await expect(cold).resolves.toBe(oldKey)
    await expect(fresh).resolves.toBe(newKey)
    expect(entered).toEqual(['cold', 'fresh'])
    await expect(
      scheduler.schedule({
        source: 'aborted',
        kind: 'open',
        signal: cancellation.signal,
        run: oldRun,
      }),
    ).rejects.toBe(reason)
    expect(oldRun).not.toHaveBeenCalled()
  })

  test('close rejects queued and future work while retaining active proof ownership', async () => {
    const scheduler = createGroupBatchScheduler({})
    const release = deferred<string>()
    const active = scheduler.schedule({
      source: 'proof',
      kind: 'completion',
      run: () => release.promise,
    })
    const queuedRun = vi.fn(async () => 'queued')
    const queued = scheduler.schedule({ source: 'queued', kind: 'open', run: queuedRun })
    const reason = new Error('Binding closed')
    const rejected = expect(queued).rejects.toBe(reason)
    scheduler.close(reason)
    await rejected
    await expect(
      scheduler.schedule({ source: 'future', kind: 'open', run: queuedRun }),
    ).rejects.toBe(reason)
    expect(queuedRun).not.toHaveBeenCalled()
    release.resolve('proven')
    await expect(active).resolves.toBe('proven')
  })

  test('each callback keeps its transaction and its own result after failure or withdrawal', async () => {
    const scheduler = createGroupBatchScheduler({})
    const release = deferred<void>()
    const cancellation = new AbortController()
    const active = scheduler.schedule({
      source: 'active',
      kind: 'completion',
      signal: cancellation.signal,
      run: () => release.promise,
    })
    cancellation.abort(new Error('Withdraw source'))
    const reason = new Error('Known rollback')
    const failed = scheduler.schedule({
      source: 'callback',
      kind: 'completion',
      async run() {
        throw reason
      },
    })
    const rejected = expect(failed).rejects.toBe(reason)
    const budgets: Array<BatchBudget> = []
    const run = vi.fn(async (budget: BatchBudget) => {
      budgets.push(budget)
      return budgets.length
    })
    const first = scheduler.schedule({ source: 'callback', kind: 'completion', run })
    const second = scheduler.schedule({ source: 'callback', kind: 'completion', run })
    expect(run).not.toHaveBeenCalled()
    release.resolve()
    await Promise.all([active, rejected])
    await expect(first).resolves.toBe(1)
    await expect(second).resolves.toBe(2)
    expect(run).toHaveBeenCalledTimes(2)
    expect(budgets[0]).not.toBe(budgets[1])
  })

  test('registry binds batch options before reads and preserves cold owed work on disposal', async () => {
    const unexpected = vi.fn(async (): Promise<never> => {
      throw new Error('Unexpected storage or crypto')
    })
    const identity = {
      id: 'did:example:owner' as const,
      get publicKey(): Uint8Array {
        throw new Error('Unexpected crypto')
      },
      get privateKey(): Uint8Array {
        throw new Error('Unexpected crypto')
      },
      signToken: unexpected,
      agreeKey: unexpected,
    }
    const persistence = createMemoryDevicePersistence({
      db: createMemoryTransaction({ rows: {} }),
      atRest: { seal: unexpected, open: unexpected },
      ownerDID: identity.id,
      providerID: 'batch-provider',
    })
    const binding = coordinatorBinding(persistence.groups)
    const capability = entryCapability(persistence.groups)
    if (binding === null || capability === null) throw new Error('Missing coordinator')
    const read = vi.spyOn(capability, 'read')
    const params = {
      persistence,
      providerID: persistence.providerID,
      packages: createDevicePackages(persistence),
      recovery: { identity, options: {} },
      restore: unexpected,
      restoreCandidate: unexpected,
      batch: { maxBatchFrames: 3, maxBatchWorkMs: 0.5, maxBatchDelayMs: 0 },
    }
    expect(() => createGroupHandleRegistry({ ...params, batch: { maxBatchFrames: 0 } })).toThrow()
    expect(read).not.toHaveBeenCalled()
    const registry = createGroupHandleRegistry(params)
    const scheduler = groupBatchFor(binding, 'group')
    await scheduler.schedule({
      source: 'completion',
      kind: 'completion',
      async run(budget) {
        expect([budget.maxFrames, budget.maxWorkMs]).toEqual([3, 0.5])
      },
    })
    expect(read).not.toHaveBeenCalled()
    expect(unexpected).not.toHaveBeenCalled()
    const release = deferred<void>()
    const active = scheduler.schedule({
      source: 'proof',
      kind: 'completion',
      run: () => release.promise,
    })
    const cold = scheduler.schedule({
      source: 'cold',
      kind: 'completion',
      async run() {
        return 'owed'
      },
    })
    await registry.dispose()
    expect(() => createGroupHandleRegistry({ ...params, batch: { maxBatchFrames: 4 } })).toThrow()
    release.resolve()
    await active
    await expect(cold).resolves.toBe('owed')
    const replacement = createGroupHandleRegistry(params)
    expect(groupBatchFor(binding, 'group')).toBe(scheduler)
    await replacement.dispose()
  })

  test('app coordination is bound to the original crypto object', () => {
    // No crypto operation is needed by the identity-only binding.
    const original = {} as GroupCrypto
    const wrapper = {} as GroupCrypto
    const binding: AppBatchBinding = {
      key: { groupID: 'group', incarnation: 1 },
      scheduler: createGroupBatchScheduler({}),
      async openReady() {
        return { consumed: 0, results: [] }
      },
    }
    expect(appBatch(original)).toBeUndefined()
    bindAppBatch(original, binding)
    bindAppBatch(original, binding)
    expect(appBatch(original)).toBe(binding)
    expect(appBatch(wrapper)).toBeUndefined()
    expect(() =>
      bindAppBatch(original, { ...binding, key: { ...binding.key, incarnation: 2 } }),
    ).toThrow()
    expect(appBatch(original)).toBe(binding)
  })
})

test('memory commands leave ready control and completion ahead of the next burst', async () => {
  const scheduler = createGroupBatchScheduler({})
  const release = deferred<void>()
  const order: Array<string> = []
  const active = scheduler.schedule({ source: 'burst', kind: 'open', run: () => release.promise })
  const offer = (source: string, kind: BatchKind) =>
    scheduler.schedule({
      source,
      kind,
      async run() {
        order.push(source)
      },
    })
  const queued = [
    offer('burst', 'open'),
    offer('inspect', 'accounting'),
    offer('completion', 'completion'),
    offer('control', 'control'),
  ]
  release.resolve()
  await Promise.all([active, ...queued])
  expect(order).toEqual(['control', 'inspect', 'completion', 'burst'])
})
