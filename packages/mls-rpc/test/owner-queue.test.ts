import { afterEach, describe, expect, test, vi } from 'vitest'

import type { EntryPhase, OwnerEntry, OwnerQueues, ProofOutcome } from '../src/owner-queue.js'
import { createOwnerQueues } from '../src/owner-queue.js'
import {
  GroupStateConflictError,
  PersistencePhaseError,
  ReentrantOwnershipError,
} from '../src/persistence-errors.js'

const group = { ownerDID: null, groupID: 'group-A' }
const device = { ownerDID: 'device-A', groupID: null }
const combined = { ownerDID: 'device-A', groupID: 'group-A' }
const phases: Array<EntryPhase> = [
  'queued',
  'prepare',
  'work',
  'finalise',
  'effects',
  'account',
  'outcome',
  'ambiguous',
  'settled',
  'released',
]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve()
}

async function advance(entry: OwnerEntry, target: EntryPhase) {
  for (const phase of ['prepare', 'work', 'finalise', 'effects', 'account', 'outcome'] as const) {
    await entry.enter(phase)
    if (phase === target) return
  }
}

async function finish(entry: OwnerEntry, outcome: ProofOutcome = 'committed') {
  await advance(entry, 'outcome')
  entry.settle(outcome)
}

function read(queues: OwnerQueues, label: string, order: Array<string>, groupID = 'group-A') {
  return queues.run('read', { ownerDID: null, groupID }, async (entry) => {
    await entry.enter('work')
    order.push(label)
    return label
  })
}

afterEach(() => vi.useRealTimers())

describe('owner queues', { timeout: 2000 }, () => {
  test('groups admit FIFO while another group proceeds independently', async () => {
    const queues = createOwnerQueues()
    const held = deferred<void>()
    const entered = deferred<void>()
    const order: Array<string> = []
    const first = queues.run('transition', group, async (entry) => {
      await entry.enter('prepare')
      order.push('first')
      entered.resolve()
      await held.promise
      await entry.enter('work')
      await entry.enter('outcome')
      entry.settle('committed')
    })
    await entered.promise
    const second = read(queues, 'second', order)
    const third = read(queues, 'third', order)
    await read(queues, 'independent', order, 'group-B')
    expect(order).toEqual(['first', 'independent'])
    held.resolve()
    await Promise.all([first, second, third])
    expect(order).toEqual(['first', 'independent', 'second', 'third'])
  })

  test('a failed read releases immediately without retaining an unknown outcome', async () => {
    const queues = createOwnerQueues()
    const failure = new Error('unknown read outcome')
    await expect(
      queues.run('read', group, async (entry) => {
        await entry.enter('work')
        throw failure
      }),
    ).rejects.toBe(failure)
    await expect(read(queues, 'next', [])).resolves.toBe('next')
  })

  test('five reads remain FIFO behind retained ownership until proof settles hooks', async () => {
    const queues = createOwnerQueues()
    const proof = deferred<ProofOutcome>()
    const retained = deferred<void>()
    const order: Array<string> = []
    const unknown = new Error('unknown')
    const owner = queues.run(
      'transition',
      group,
      async (entry) => {
        entry.onCommit(() => order.push('hook'))
        await advance(entry, 'outcome')
        void entry.retain(() => proof.promise)
        retained.resolve()
        throw unknown
      },
      { mutationID: 'mutation-A' },
    )
    const rejection = expect(owner).rejects.toBe(unknown)
    await retained.promise
    await rejection
    const reads = [1, 2, 3, 4, 5].map((number) => read(queues, String(number), order))
    await flush()
    expect(order).toEqual([])
    proof.resolve('committed')
    await Promise.all(reads)
    expect(order).toEqual(['hook', '1', '2', '3', '4', '5'])
  })

  test('combined entries hold the device while waiting for their group', async () => {
    const queues = createOwnerQueues()
    const release = deferred<void>()
    const entered = deferred<void>()
    const order: Array<string> = []
    const owner = queues.run('read', group, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const first = queues.run('combined', combined, async (entry) => {
      order.push('combined-A')
      await finish(entry)
    })
    const second = queues.run('combined', { ...combined, groupID: 'group-B' }, async (entry) => {
      order.push('combined-B')
      await finish(entry)
    })
    const deviceRead = queues.run('read', device, async () => order.push('device'))
    await read(queues, 'group-B-read', order, 'group-B')
    expect(order).toEqual(['group-B-read'])
    release.resolve()
    await Promise.all([owner, first, second, deviceRead])
    expect(order).toEqual(['group-B-read', 'combined-A', 'combined-B', 'device'])
  })

  test('aborting a combined group waiter withdraws it and releases its device slot', async () => {
    const queues = createOwnerQueues()
    const release = deferred<void>()
    const entered = deferred<void>()
    const owner = queues.run('read', group, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const signal = new AbortController()
    const body = vi.fn(async (entry: OwnerEntry) => finish(entry))
    const waiting = queues.run('combined', combined, body, { signal: signal.signal })
    const abortError = new Error('cancelled group wait')
    const rejected = expect(waiting).rejects.toBe(abortError)
    await flush()
    signal.abort(abortError)
    await rejected
    await queues.run('read', device, async () => undefined)
    release.resolve()
    await owner
    await read(queues, 'after', [])
    expect(body).not.toHaveBeenCalled()
  })

  test.each(['device', 'group'] as const)(
    'an abort racing a %s grant releases the granted slot',
    async (slot) => {
      const queues = createOwnerQueues()
      const controller = new AbortController()
      const body = vi.fn(async (entry: OwnerEntry) => finish(entry))
      // A synchronous abort races the initial device grant. A microtask races the group grant.
      const run = queues.run('combined', combined, body, { signal: controller.signal })
      const rejected = expect(run).rejects.toBeInstanceOf(DOMException)
      if (slot === 'group') await Promise.resolve()
      controller.abort()
      await rejected
      await queues.run('read', device, async () => undefined)
      await read(queues, 'after', [])
      expect(body).not.toHaveBeenCalled()
    },
  )

  test('a group holder requesting a device rejects before waiting', async () => {
    const queues = createOwnerQueues()
    await queues.run('transition', group, async (entry) => {
      await entry.enter('prepare')
      await expect(queues.run('transition', device, async () => undefined)).rejects.toBeInstanceOf(
        ReentrantOwnershipError,
      )
      await entry.enter('work')
      await entry.enter('outcome')
      entry.settle('committed')
    })
  })

  test.each(['prepare', 'work', 'finalise', 'effects', 'account'] as const)(
    'root calls reject from %s and current follows asynchronous continuations',
    async (phase) => {
      const queues = createOwnerQueues()
      expect(queues.current()).toBeUndefined()
      await queues.run('transition', group, async (entry) => {
        await advance(entry, phase)
        await Promise.resolve()
        expect(queues.current()).toBe(entry)
        await expect(
          queues.run('read', { ownerDID: null, groupID: 'group-B' }, async () => undefined),
        ).rejects.toBeInstanceOf(ReentrantOwnershipError)
        await entry.enter('outcome')
        entry.settle('committed')
      })
      expect(queues.current()).toBeUndefined()
    },
  )

  test('root calls reject inside proof and completion hooks', async () => {
    const queues = createOwnerQueues()
    const hookRejections: Array<Promise<unknown>> = []
    await queues.run('transition', group, async (entry) => {
      entry.onCommit(() => {
        expect(queues.current()).toBe(entry)
        hookRejections.push(
          expect(queues.run('read', group, async () => undefined)).rejects.toBeInstanceOf(
            ReentrantOwnershipError,
          ),
        )
      })
      await advance(entry, 'outcome')
      await entry.retain(async () => {
        expect(queues.current()).toBe(entry)
        await expect(queues.run('read', group, async () => undefined)).rejects.toBeInstanceOf(
          ReentrantOwnershipError,
        )
        return 'committed'
      })
    })
    await Promise.all(hookRejections)
  })

  test('phase order refuses skips and reversals, while reads may skip prepare', async () => {
    const queues = createOwnerQueues()
    await queues.run('transition', group, async (entry) => {
      await expect(entry.enter('work')).rejects.toBeInstanceOf(PersistencePhaseError)
      await expect(entry.enter('ambiguous')).rejects.toBeInstanceOf(PersistencePhaseError)
      await entry.enter('prepare')
      await expect(entry.enter('effects')).rejects.toBeInstanceOf(PersistencePhaseError)
      await entry.enter('work')
      await expect(entry.enter('prepare')).rejects.toBeInstanceOf(PersistencePhaseError)
      await entry.enter('finalise')
      await expect(entry.enter('account')).rejects.toBeInstanceOf(PersistencePhaseError)
      await entry.enter('effects')
      await entry.enter('account')
      await entry.enter('outcome')
      entry.settle('committed')
      await expect(entry.enter('work')).rejects.toBeInstanceOf(PersistencePhaseError)
    })
    await queues.run('read', group, async (entry) => {
      await entry.enter('work')
      await entry.enter('outcome')
      await expect(entry.enter('ambiguous')).rejects.toBeInstanceOf(PersistencePhaseError)
      expect(() => entry.retain(async () => 'committed')).toThrow(PersistencePhaseError)
    })
  })

  test.each(phases)('write permissions in %s match the phase matrix', async (phase) => {
    const queues = createOwnerQueues()
    const check = (entry: OwnerEntry) => {
      expect(entry.phase).toBe(phase)
      for (const target of ['domain', 'side', 'coordinator'] as const) {
        const allowed =
          target === 'domain'
            ? phase === 'work'
            : target === 'side'
              ? phase === 'work' || phase === 'effects'
              : phase === 'finalise' || phase === 'account'
        if (allowed) expect(() => entry.assertWrite(target)).not.toThrow()
        else expect(() => entry.assertWrite(target)).toThrow(PersistencePhaseError)
      }
    }
    let captured!: OwnerEntry
    await queues.run('transition', group, async (entry) => {
      captured = entry
      if (phase === 'queued') check(entry)
      else if (phase === 'ambiguous') {
        await advance(entry, 'outcome')
        await entry.retain(async () => {
          check(entry)
          return 'committed'
        })
        return
      } else if (phase !== 'settled' && phase !== 'released') {
        await advance(entry, phase)
        check(entry)
      }
      if (entry.phase === 'queued') await advance(entry, 'outcome')
      else if (entry.phase !== 'outcome') await entry.enter('outcome')
      entry.settle('committed')
      if (phase === 'settled') check(entry)
    })
    if (phase === 'released') check(captured)
  })

  test('the sequencer serialises suspended work and outcome drains after caller rejection', async () => {
    const queues = createOwnerQueues()
    const suspended = deferred<void>()
    const operationStarted = deferred<void>()
    const outcomeStarted = deferred<void>()
    const callerError = new Error('caller abandoned operation')
    const order: Array<string> = []
    let closing!: Promise<void>
    const owner = queues.run('transition', group, async (entry) => {
      await advance(entry, 'work')
      void entry.sequence(async () => {
        order.push('first-start')
        operationStarted.resolve()
        await suspended.promise
        order.push('first-end')
      })
      void entry.sequence(async () => {
        order.push('second')
      })
      await operationStarted.promise
      closing = entry.enter('outcome').then(() => {
        order.push('outcome')
        entry.settle('rolled-back')
      })
      outcomeStarted.resolve()
      throw callerError
    })
    const rejected = expect(owner).rejects.toBe(callerError)
    await outcomeStarted.promise
    await rejected
    const next = read(queues, 'read', order)
    await flush()
    expect(order).toEqual(['first-start'])
    suspended.resolve()
    await closing
    await next
    expect(order).toEqual(['first-start', 'first-end', 'second', 'outcome', 'read'])
  })

  test('a rejected operation does not strand later sequence reservations or outcome', async () => {
    const queues = createOwnerQueues()
    const failure = new Error('operation failed')
    await queues.run('transition', group, async (entry) => {
      await advance(entry, 'work')
      const failed = entry.sequence(async () => {
        throw failure
      })
      const later = entry.sequence(async () => 7)
      await expect(failed).rejects.toBe(failure)
      await expect(later).resolves.toBe(7)
      await entry.enter('outcome')
      await expect(entry.sequence(async () => undefined)).rejects.toBeInstanceOf(
        PersistencePhaseError,
      )
      entry.settle('rolled-back')
    })
  })

  test.each(['committed', 'rolled-back'] as const)(
    'settle contains hooks and is idempotent for %s',
    async (outcome) => {
      const queues = createOwnerQueues()
      const hooks: Array<string> = []
      await queues.run('transition', group, async (entry) => {
        entry.onCommit(() => {
          hooks.push('commit-throw')
          throw new Error('hook')
        })
        entry.onCommit(() => hooks.push('commit-last'))
        entry.onRollback(() => {
          hooks.push('rollback-throw')
          throw new Error('hook')
        })
        entry.onRollback(() => hooks.push('rollback-last'))
        await advance(entry, 'outcome')
        entry.settle(outcome)
        entry.settle(outcome)
        expect(() => entry.settle(outcome === 'committed' ? 'rolled-back' : 'committed')).toThrow(
          GroupStateConflictError,
        )
      })
      expect(hooks).toEqual(
        outcome === 'committed'
          ? ['commit-throw', 'commit-last']
          : ['rollback-throw', 'rollback-last'],
      )
    },
  )

  test('proof failures back off from 100 ms to repeated 15 s, retaining all slots', async () => {
    vi.useFakeTimers()
    const queues = createOwnerQueues()
    const attempts: Array<number> = []
    const entered = deferred<void>()
    const delays = [100, 200, 400, 800, 1600, 3200, 6400, 12800, 15000, 15000]
    const order: Array<string> = []
    const owner = queues.run(
      'combined',
      combined,
      async (entry) => {
        await advance(entry, 'outcome')
        const proof = entry.retain(async () => {
          attempts.push(Date.now())
          if (attempts.length <= delays.length) throw new Error('barrier failed')
          return 'rolled-back'
        })
        entered.resolve()
        return proof
      },
      { mutationID: 'mutation-A' },
    )
    await entered.promise
    await flush()
    const groupRead = read(queues, 'group', order)
    const deviceRead = queues.run('read', device, async () => order.push('device'))
    let previous = Date.now()
    for (const delay of delays) {
      const count = attempts.length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(attempts).toHaveLength(count)
      expect(order).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(attempts).toHaveLength(count + 1)
      const latest = attempts.at(-1)
      if (latest === undefined) throw new Error('Missing proof attempt')
      expect(latest - previous).toBe(delay)
      previous = latest
    }
    await expect(owner).resolves.toBe('rolled-back')
    await Promise.all([groupRead, deviceRead])
    expect(order.sort()).toEqual(['device', 'group'])
  })

  test('joinProof matches mutation and either owner without queueing', async () => {
    const queues = createOwnerQueues()
    const proof = deferred<ProofOutcome>()
    const entered = deferred<void>()
    let retained!: Promise<ProofOutcome>
    const owner = queues.run(
      'combined',
      combined,
      async (entry) => {
        await advance(entry, 'outcome')
        retained = entry.retain(() => proof.promise)
        entered.resolve()
        return retained
      },
      { mutationID: 'mutation-A' },
    )
    await entered.promise
    expect(queues.joinProof({ groupID: 'group-A' }, 'mutation-A')).toBe(retained)
    expect(queues.joinProof({ ownerDID: 'device-A' }, 'mutation-A')).toBe(retained)
    expect(queues.joinProof({ groupID: 'group-A' }, 'other')).toBeNull()
    expect(queues.joinProof({ groupID: 'group-B' }, 'mutation-A')).toBeNull()
    proof.resolve('committed')
    await expect(owner).resolves.toBe('committed')
    expect(queues.joinProof({ groupID: 'group-A' }, 'mutation-A')).toBeNull()
  })

  test('rollback then work retains the slot across two provider attempts', async () => {
    const queues = createOwnerQueues()
    const firstOutcome = deferred<void>()
    const retry = deferred<void>()
    const finalOutcome = deferred<void>()
    const finishRetry = deferred<void>()
    const order: Array<string> = []
    const owner = queues.run('transition', group, async (entry) => {
      await advance(entry, 'outcome')
      firstOutcome.resolve()
      await retry.promise
      await entry.enter('work')
      order.push('retry')
      await entry.enter('outcome')
      finalOutcome.resolve()
      await finishRetry.promise
      entry.settle('committed')
    })
    await firstOutcome.promise
    const next = read(queues, 'read', order)
    await flush()
    expect(order).toEqual([])
    retry.resolve()
    await finalOutcome.promise
    expect(order).toEqual(['retry'])
    finishRetry.resolve()
    await Promise.all([owner, next])
    expect(order).toEqual(['retry', 'read'])
  })

  test('fail-stop rejects active, queued, retained, joined and later callers atomically without hooks', async () => {
    const queues = createOwnerQueues()
    const activeEntered = deferred<void>()
    const retainedEntered = deferred<void>()
    const activeFinish = deferred<void>()
    const proof = deferred<ProofOutcome>()
    const hooks: Array<string> = []
    let captured!: OwnerEntry
    const active = queues.run('transition', { ...group, groupID: 'group-B' }, async (entry) => {
      captured = entry
      entry.onCommit(() => {
        hooks.push('throw')
        throw new Error('hook')
      })
      entry.onRollback(() => hooks.push('rollback'))
      await advance(entry, 'work')
      activeEntered.resolve()
      await activeFinish.promise
      await entry.enter('outcome')
      entry.settle('committed')
    })
    const retained = queues.run(
      'transition',
      group,
      async (entry) => {
        entry.onCommit(() => hooks.push('retained'))
        await advance(entry, 'outcome')
        const result = entry.retain(() => proof.promise)
        retainedEntered.resolve()
        return result
      },
      { mutationID: 'mutation-A' },
    )
    await Promise.all([activeEntered.promise, retainedEntered.promise])
    const queued = read(queues, 'queued', hooks)
    const joined = queues.joinProof({ groupID: 'group-A' }, 'mutation-A')
    if (joined === null) throw new Error('Missing retained proof')
    const error = new GroupStateConflictError('conflicted marker')
    const rejections = [active, retained, queued, joined].map((promise) =>
      expect(promise).rejects.toBe(error),
    )
    queues.failStop(error)
    await Promise.all(rejections)
    expect(queues.failure).toBe(error)
    expect(() => captured.assertWrite('domain')).toThrow(error)
    await expect(queues.run('read', device, async () => hooks.push('later'))).rejects.toBe(error)
    activeFinish.resolve()
    proof.resolve('committed')
    await flush()
    expect(hooks).toEqual([])
  })

  test('fail-stop cancels proof backoff and drops pending sequencer reservations', async () => {
    vi.useFakeTimers()
    const queues = createOwnerQueues()
    const entered = deferred<void>()
    let attempts = 0
    const owner = queues.run('transition', group, async (entry) => {
      await advance(entry, 'outcome')
      const retained = entry.retain(async () => {
        attempts++
        throw new Error('retry')
      })
      entered.resolve()
      return retained
    })
    await entered.promise
    await flush()
    const error = new GroupStateConflictError()
    const rejected = expect(owner).rejects.toBe(error)
    queues.failStop(error)
    await rejected
    await vi.advanceTimersByTimeAsync(30000)
    expect(attempts).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each(['queued', 'prepare', 'work'] as const)(
    'a callback failure in %s settles rollback before the next entry',
    async (phase) => {
      const queues = createOwnerQueues()
      const hooks: Array<string> = []
      const failure = new Error('callback failed')
      await expect(
        queues.run('transition', group, async (entry) => {
          entry.onRollback(() => hooks.push('rollback'))
          if (phase !== 'queued') await advance(entry, phase)
          throw failure
        }),
      ).rejects.toBe(failure)
      await read(queues, 'next', hooks)
      expect(hooks).toEqual(['rollback', 'next'])
    },
  )

  test('fail-stop rejects suspended operations and prevents a reserved operation from starting', async () => {
    const queues = createOwnerQueues()
    const entered = deferred<void>()
    const suspended = deferred<void>()
    const bodyFinish = deferred<void>()
    const order: Array<string> = []
    let first!: Promise<void>
    let reserved!: Promise<void>
    const owner = queues.run('transition', group, async (entry) => {
      await advance(entry, 'work')
      first = entry.sequence(async () => {
        entered.resolve()
        await suspended.promise
      })
      reserved = entry.sequence(async () => {
        order.push('reserved')
      })
      await bodyFinish.promise
    })
    await entered.promise
    const error = new GroupStateConflictError()
    const rejected = [owner, first, reserved].map((promise) => expect(promise).rejects.toBe(error))
    queues.failStop(error)
    await Promise.all(rejected)
    suspended.resolve()
    bodyFinish.resolve()
    await flush()
    expect(order).toEqual([])
  })

  test('startup tracking is separate for arbitrary scope keys', () => {
    const queues = createOwnerQueues()
    expect(queues.started('group-A')).toBe(false)
    queues.markStarted('group-A')
    expect(queues.started('group-A')).toBe(true)
    expect(queues.started('device-A')).toBe(false)
    expect(createOwnerQueues().started('group-A')).toBe(false)
  })
})
