import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type {
  CoordinatorToken,
  EntryPhase,
  OwnerAttempt,
  OwnerEntry,
  OwnerQueues,
  OwnershipContextPort,
  ProofOutcome,
} from '../src/owner-queue.js'
import { createOwnerQueues } from '../src/owner-queue.js'
import {
  GroupStateConflictError,
  PersistencePhaseError,
  ReentrantOwnershipError,
} from '../src/persistence-errors.js'

function contextPort(): OwnershipContextPort {
  const context = new AsyncLocalStorage<object>()
  return { run: (token, fn) => context.run(token, fn), get: () => context.getStore() }
}

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

describe('runtime helpers', () => {
  test('deferred resolves with the supplied value', async () => {
    const { deferred } = await import('../src/runtime.js')
    const pending = deferred<number>()
    pending.resolve(7)
    pending.reject(new Error('ignored'))
    await expect(pending.promise).resolves.toBe(7)
  })

  test('deferred rejects with the supplied reason', async () => {
    const { deferred } = await import('../src/runtime.js')
    const pending = deferred<number>()
    const reason = new Error('rejected')
    const rejected = expect(pending.promise).rejects.toBe(reason)
    pending.reject(reason)
    pending.resolve(7)
    await rejected
  })

  test.each(['dispose', 'abort', 'already-aborted', 'empty'] as const)(
    'anySignal removes all listeners on %s',
    async (mode) => {
      const { anySignal } = await import('../src/runtime.js')
      const first = new AbortController()
      const second = new AbortController()
      const reason = new Error('aborted')
      if (mode === 'already-aborted') second.abort(reason)
      const listeners = [first.signal, second.signal].map(listenerCount)
      const binding = anySignal(mode === 'empty' ? [] : [first.signal, second.signal])
      if (mode === 'abort') second.abort(reason)
      if (mode === 'dispose') binding.dispose()
      if (mode === 'abort' || mode === 'already-aborted') {
        expect(binding.signal.aborted).toBe(true)
        expect(binding.signal.reason).toBe(reason)
      } else expect(binding.signal.aborted).toBe(false)
      expect(listeners.map((count) => count())).toEqual([0, 0])
      binding.dispose()
      first.abort(new Error('later'))
      if (mode === 'dispose') expect(binding.signal.aborted).toBe(false)
      if (mode === 'abort') expect(binding.signal.reason).toBe(reason)
    },
  )
})

function listenerCount(signal: AbortSignal): () => number {
  const listeners = new Set<EventListenerOrEventListenerObject>()
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  vi.spyOn(signal, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'abort' && listener !== null) listeners.add(listener)
    add(type, listener, options)
  })
  vi.spyOn(signal, 'removeEventListener').mockImplementation((type, listener, options) => {
    if (type === 'abort' && listener !== null) listeners.delete(listener)
    remove(type, listener, options)
  })
  return () => listeners.size
}

describe('runtime-neutral owner operations', { timeout: 2000 }, () => {
  test('registration freezes queued work before the lock and effects reopens admission', async () => {
    const queues = createOwnerQueues()
    const suspended = deferred<void>()
    const started = deferred<void>()
    const order: Array<string> = []
    let captured!: OwnerEntry
    const owner = queues.run('transition', group, async (entry) => {
      captured = entry
      await advance(entry, 'work')
      const attempt = entry.attempt()
      const first = entry.operation(attempt, async (live) => {
        order.push(`first-start:${entry.phase}`)
        started.resolve()
        await suspended.promise
        live.assertLive()
        order.push(`first-end:${entry.phase}`)
      })
      const second = entry.operation(attempt, async () => order.push(`second:${entry.phase}`))
      const boundary = entry.enter('finalise').then(() => order.push(`entered:${entry.phase}`))
      await expect(entry.operation(attempt, async () => order.push('late'))).rejects.toBeInstanceOf(
        PersistencePhaseError,
      )
      await Promise.all([first, second, boundary])
      await expect(entry.operation(attempt, async () => undefined)).rejects.toBeInstanceOf(
        PersistencePhaseError,
      )
      await entry.enter('effects')
      await entry.operation(attempt, async () => order.push(`effect:${entry.phase}`))
      await entry.enter('outcome')
      entry.settle('committed')
    })
    await started.promise
    await flush()
    expect(captured.phase).toBe('work')
    expect(order).toEqual(['first-start:work'])
    suspended.resolve()
    await owner
    expect(order).toEqual([
      'first-start:work',
      'first-end:work',
      'second:work',
      'entered:finalise',
      'effect:effects',
    ])
  })

  test('public and coordinator reservations share serial order', async () => {
    const queues = createOwnerQueues()
    const order: Array<string> = []
    await queues.run('transition', group, async (entry) => {
      await advance(entry, 'work')
      await Promise.all([
        entry.operation(entry.attempt(), async () => {
          await Promise.resolve()
          order.push('public')
        }),
        entry.operation(entry.attempt(), async () => {
          order.push('second-public')
        }),
      ])
      await entry.enter('finalise')
      const token = entry.coordinator(entry.attempt())
      await Promise.all([
        entry.coordinate(token, async () => {
          await Promise.resolve()
          order.push('coordinator')
        }),
        entry.coordinate(token, async () => {
          order.push('second-coordinator')
        }),
      ])
      await entry.enter('outcome')
      entry.settle('committed')
    })
    expect(order).toEqual(['public', 'second-public', 'coordinator', 'second-coordinator'])
  })

  test.each(phases)(
    'coordinator and public admission in %s follows the phase matrix',
    async (phase) => {
      const queues = createOwnerQueues()
      let token!: CoordinatorToken
      let attempt!: OwnerAttempt
      let captured!: OwnerEntry
      const check = async (entry: OwnerEntry) => {
        const operation = vi.fn(async () => 7)
        const coordinated = entry.coordinate(token, operation)
        if (phase === 'finalise' || phase === 'account') await expect(coordinated).resolves.toBe(7)
        else await expect(coordinated).rejects.toBeInstanceOf(PersistencePhaseError)
        const publicResult = entry.operation(attempt, operation)
        if (['prepare', 'work', 'effects'].includes(phase))
          await expect(publicResult).resolves.toBe(7)
        else await expect(publicResult).rejects.toBeInstanceOf(PersistencePhaseError)
        await expect(
          entry.coordinate(Object.freeze({}) as CoordinatorToken, operation),
        ).rejects.toBeInstanceOf(PersistencePhaseError)
      }
      await queues.run('transition', group, async (entry) => {
        captured = entry
        attempt = entry.attempt()
        token = entry.coordinator(attempt)
        expect(Object.isFrozen(token)).toBe(true)
        expect(Object.keys(token)).toEqual([])
        if (phase === 'queued') await check(entry)
        else if (phase === 'ambiguous') {
          await advance(entry, 'outcome')
          await entry.retain(async () => {
            await check(entry)
            return 'committed'
          })
          return
        } else if (phase !== 'settled' && phase !== 'released') {
          await advance(entry, phase)
          await check(entry)
        }
        if (entry.phase === 'queued') await advance(entry, 'outcome')
        else if (entry.phase !== 'outcome') await entry.enter('outcome')
        entry.settle('committed')
        if (phase === 'settled') await check(entry)
      })
      if (phase === 'released') await check(captured)
    },
  )

  test('coordinator rejects foreign-entry and expired-attempt tokens', async () => {
    const queues = createOwnerQueues()
    let foreign!: CoordinatorToken
    await queues.run('transition', group, async (entry) => {
      foreign = entry.coordinator(entry.attempt())
      await finish(entry)
    })
    await queues.run('transition', group, async (entry) => {
      await advance(entry, 'finalise')
      const old = entry.attempt()
      const expired = entry.coordinator(old)
      await expect(entry.coordinate(foreign, async () => 1)).rejects.toBeInstanceOf(
        PersistencePhaseError,
      )
      await entry.enter('outcome')
      await entry.enter('work')
      expect(old.revoked).toBe(true)
      expect(entry.attempt().id).toBeGreaterThan(old.id)
      expect(entry.attempt()).not.toBe(old)
      await expect(entry.operation(old, async () => 1)).rejects.toBeInstanceOf(
        PersistencePhaseError,
      )
      await entry.enter('finalise')
      await expect(entry.coordinate(expired, async () => 1)).rejects.toBeInstanceOf(
        PersistencePhaseError,
      )
      await expect(
        entry.coordinate(entry.coordinator(entry.attempt()), async () => 7),
      ).resolves.toBe(7)
      await entry.enter('outcome')
      entry.settle('committed')
    })
  })

  test.each(['abandoned', 'caught'] as const)(
    'fatal failure remains rollback-only when %s',
    async (mode) => {
      const queues = createOwnerQueues()
      const reason = new Error('seal failed')
      await queues.run('transition', group, async (entry) => {
        await advance(entry, 'work')
        expect(entry.rollbackOnly).toBe(false)
        await expect(
          entry.operation(entry.attempt(), async () => {
            throw new Error('no rows changed')
          }),
        ).rejects.toThrow('no rows changed')
        expect(entry.rollbackOnly).toBe(false)
        const failing = entry.operation(entry.attempt(), async () => {
          entry.fail(reason)
          throw reason
        })
        if (mode === 'caught') await expect(failing).rejects.toBe(reason)
        else void failing.catch(() => undefined)
        await entry.enter('finalise')
        expect(entry.rollbackOnly).toBe(true)
        await entry.enter('outcome')
        expect(entry.rollbackOnly).toBe(true)
        entry.settle('rolled-back')
        expect(entry.rollbackOnly).toBe(true)
      })
    },
  )

  test('revocation rejects active and queued operations and drains while late writes are discarded', async () => {
    const queues = createOwnerQueues()
    const suspended = deferred<void>()
    const started = deferred<void>()
    const late = deferred<void>()
    const writes: Array<string> = []
    let captured!: OwnerEntry
    let attempt!: OwnerAttempt
    let active!: Promise<void>
    let queued!: Promise<void>
    const owner = queues.run('transition', group, async (entry) => {
      captured = entry
      await advance(entry, 'work')
      attempt = entry.attempt()
      active = entry.operation(attempt, async (live) => {
        started.resolve()
        try {
          await suspended.promise
          live.assertLive()
          writes.push('late')
        } finally {
          late.resolve()
        }
      })
      queued = entry.operation(attempt, async () => {
        writes.push('queued')
      })
      await started.promise
      await entry.enter('outcome')
      entry.settle('rolled-back')
    })
    await started.promise
    const reason = new PersistencePhaseError('read failed')
    const rejected = [active, queued].map((p) => expect(p).rejects.toBe(reason))
    attempt.revoke(reason)
    expect(attempt.revoked).toBe(true)
    expect(attempt.signal.aborted).toBe(true)
    expect(attempt.signal.reason).toBe(reason)
    expect(() => attempt.assertLive()).toThrow(reason)
    await Promise.all(rejected)
    await owner
    await expect(captured.operation(attempt, async () => 1)).rejects.toBeInstanceOf(
      PersistencePhaseError,
    )
    suspended.resolve()
    await late.promise
    expect(writes).toEqual([])
  })

  test('a failed read releases its slot before suspended callbacks or tracked backend completion', async () => {
    const queues = createOwnerQueues()
    const suspended = deferred<void>()
    const backend = deferred<void>()
    const started = deferred<void>()
    const late = deferred<void>()
    const writes: Array<string> = []
    let captured!: OwnerEntry
    const reason = new PersistencePhaseError('read failed')
    await expect(
      queues.run('read', group, async (entry) => {
        captured = entry
        await entry.enter('work')
        entry.trackBackend(backend.promise)
        const operation = entry.operation(entry.attempt(), async (live) => {
          started.resolve()
          try {
            await suspended.promise
            live.assertLive()
            writes.push('late')
          } finally {
            late.resolve()
          }
        })
        void operation.catch(() => undefined)
        await started.promise
        entry.attempt().revoke(reason)
        entry.release()
        throw reason
      }),
    ).rejects.toBe(reason)
    await expect(read(queues, 'next', writes)).resolves.toBe('next')
    let backendDone = false
    const completion = captured.backendSettled().then(() => {
      backendDone = true
    })
    await flush()
    expect(backendDone).toBe(false)
    backend.resolve()
    await completion
    expect(backendDone).toBe(true)
    suspended.resolve()
    await late.promise
    expect(writes).toEqual(['next'])
  })

  test('fail-stop rejects active operations, queued operations and drains with one conflict', async () => {
    const queues = createOwnerQueues()
    const started = deferred<void>()
    const suspended = deferred<void>()
    const backend = deferred<void>()
    const writes: Array<string> = []
    let active!: Promise<void>
    let queued!: Promise<void>
    let drain!: Promise<void>
    let captured!: OwnerEntry
    const owner = queues.run('transition', group, async (entry) => {
      captured = entry
      await advance(entry, 'work')
      entry.trackBackend(backend.promise)
      active = entry.operation(entry.attempt(), async (live) => {
        started.resolve()
        await suspended.promise
        live.assertLive()
        writes.push('late')
      })
      queued = entry.operation(entry.attempt(), async () => {
        writes.push('queued')
      })
      drain = entry.enter('finalise')
      await drain
    })
    await started.promise
    const reason = new GroupStateConflictError('conflict')
    const rejected = [owner, active, queued, drain].map((p) => expect(p).rejects.toBe(reason))
    queues.failStop(reason)
    await Promise.all(rejected)
    expect(captured.attempt().signal.reason).toBe(reason)
    let completed = false
    const completion = captured.backendSettled().then(() => {
      completed = true
    })
    await flush()
    expect(completed).toBe(false)
    backend.reject(new Error('rollback completed with rejection'))
    await completion
    suspended.resolve()
    await flush()
    expect(writes).toEqual([])
  })

  test.each([
    'prepare',
    'work',
    'finalise',
    'effects',
    'account',
    'outcome',
    'ambiguous',
    'settled',
  ] as const)(
    'the synchronous callback marker diagnoses roots in %s without a port',
    async (phase) => {
      const queues = createOwnerQueues()
      const entered = deferred<void>()
      const suspended = deferred<void>()
      const proof = deferred<ProofOutcome>()
      let captured!: OwnerEntry
      let hook!: Promise<unknown>
      const owner = queues.run('transition', group, async (entry) => {
        captured = entry
        entry.onCommit(() => {
          expect(queues.current()).toBe(entry)
          hook = queues.run('read', device, async () => undefined)
        })
        await advance(entry, phase === 'ambiguous' || phase === 'settled' ? 'outcome' : phase)
        entered.resolve()
        await suspended.promise
        if (entry.phase !== 'settled') {
          if (entry.phase !== 'outcome') await entry.enter('outcome')
          entry.settle('committed')
        }
      })
      await entered.promise
      let retained: Promise<ProofOutcome> | undefined
      if (phase === 'ambiguous') retained = captured.retain(() => proof.promise)
      if (phase === 'settled') captured.settle('committed')
      expect(captured.phase).toBe(phase)
      expect(queues.current()).toBeUndefined()
      const rejected = captured.callback(() => {
        expect(queues.current()).toBe(captured)
        return queues.run('read', device, async () => undefined)
      })
      expect(queues.current()).toBeUndefined()
      await expect(rejected).rejects.toBeInstanceOf(ReentrantOwnershipError)
      expect(() =>
        captured.callback(() => {
          throw new Error('host callback')
        }),
      ).toThrow('host callback')
      expect(queues.current()).toBeUndefined()
      proof.resolve('committed')
      await retained
      suspended.resolve()
      await owner
      await expect(hook).rejects.toBeInstanceOf(ReentrantOwnershipError)
    },
  )

  test('the port retains asynchronous ownership in operation callbacks', async () => {
    const queues = createOwnerQueues({ ownershipContext: contextPort() })
    await queues.run('read', group, async (entry) => {
      await entry.enter('work')
      expect(queues.current()).toBe(entry)
      await entry.operation(entry.attempt(), async () => {
        await Promise.resolve()
        expect(queues.current()).toBe(entry)
      })
    })
  })

  test('synchronous markers restore after a throwing callback from an unrelated caller', async () => {
    const queues = createOwnerQueues()
    const entered = deferred<void>()
    const suspended = deferred<void>()
    let captured!: OwnerEntry
    const owner = queues.run('read', group, async (entry) => {
      captured = entry
      entered.resolve()
      await suspended.promise
    })
    await entered.promise
    expect(queues.current()).toBeUndefined()
    expect(() =>
      captured.callback(() => {
        expect(queues.current()).toBe(captured)
        throw new Error('host callback')
      }),
    ).toThrow('host callback')
    expect(queues.current()).toBeUndefined()
    await expect(read(queues, 'independent', [], 'group-B')).resolves.toBe('independent')
    suspended.resolve()
    await owner
  })

  test('port tokens are opaque and nested bindings restore after throwing callbacks', async () => {
    const port = contextPort()
    const queues = createOwnerQueues({ ownershipContext: port })
    const external = Object.freeze({})
    await port.run(external, async () => {
      await queues.run('read', group, async (entry) => {
        const token = port.get()
        expect(token).toBeDefined()
        expect(token).not.toBe(external)
        expect(token).not.toBe(entry)
        expect(Object.isFrozen(token)).toBe(true)
        expect(Object.keys(token ?? {})).toEqual([])
        await Promise.resolve()
        expect(queues.current()).toBe(entry)
        expect(() =>
          port.run(external, () =>
            entry.callback(() => {
              expect(port.get()).toBe(token)
              throw new Error('accessor failed')
            }),
          ),
        ).toThrow('accessor failed')
        expect(port.get()).toBe(token)
      })
      expect(port.get()).toBe(external)
      expect(queues.current()).toBeUndefined()
    })
  })

  test('the synchronous marker takes precedence over the context port', async () => {
    const port = contextPort()
    const queues = createOwnerQueues({ ownershipContext: port })
    await queues.run('read', group, async (entry) => {
      const get = vi.spyOn(port, 'get').mockImplementation(() => {
        throw new Error('port diagnostics unavailable')
      })
      try {
        expect(entry.callback(() => queues.current())).toBe(entry)
        expect(get).not.toHaveBeenCalled()
      } finally {
        get.mockRestore()
      }
    })
  })

  test('the port preserves callback ownership after await without legacy context', async () => {
    const queues = createOwnerQueues({ ownershipContext: contextPort() })
    const entered = deferred<void>()
    const suspended = deferred<void>()
    let captured!: OwnerEntry
    const owner = queues.run('read', group, async (entry) => {
      captured = entry
      entered.resolve()
      await suspended.promise
    })
    await entered.promise
    expect(queues.current()).toBeUndefined()
    await captured.callback(async () => {
      await Promise.resolve()
      expect(queues.current()).toBe(captured)
      await expect(queues.run('read', device, async () => undefined)).rejects.toBeInstanceOf(
        ReentrantOwnershipError,
      )
    })
    expect(queues.current()).toBeUndefined()
    suspended.resolve()
    await owner
  })

  test.each([false, true])(
    'unrelated callers and released tokens stay unbound (port: %s)',
    async (withPort) => {
      const queues = createOwnerQueues(withPort ? { ownershipContext: contextPort() } : undefined)
      const entered = deferred<void>()
      const suspended = deferred<void>()
      let continuation!: Promise<void>
      const owner = queues.run('read', group, async (entry) => {
        continuation = entry.callback(async () => {
          await suspended.promise
          expect(queues.current()).toBeUndefined()
        })
        entry.release()
        expect(entry.callback(() => queues.current())).toBeUndefined()
        entered.resolve()
        await suspended.promise
      })
      await entered.promise
      expect(queues.current()).toBeUndefined()
      await expect(read(queues, 'same-scope', [])).resolves.toBe('same-scope')
      await expect(read(queues, 'independent', [], 'group-B')).resolves.toBe('independent')
      suspended.resolve()
      await Promise.all([owner, continuation])
    },
  )

  test.each(['success', 'rejection', 'cancellation'] as const)(
    'entry signal listeners are disposed after %s',
    async (mode) => {
      const queues = createOwnerQueues()
      const controller = new AbortController()
      const count = listenerCount(controller.signal)
      const held = deferred<void>()
      const entered = deferred<void>()
      let first: Promise<unknown> | undefined
      if (mode === 'cancellation') {
        first = queues.run('read', group, async () => {
          entered.resolve()
          await held.promise
        })
        await entered.promise
      }
      const reason = new Error('cancelled or rejected')
      const run = queues.run(
        'read',
        group,
        async () => {
          expect(count()).toBe(1)
          if (mode === 'rejection') throw reason
        },
        { signal: controller.signal },
      )
      if (mode === 'cancellation') {
        await flush()
        expect(count()).toBe(1)
        const rejected = expect(run).rejects.toBe(reason)
        controller.abort(reason)
        await rejected
      } else if (mode === 'rejection') await expect(run).rejects.toBe(reason)
      else await run
      expect(count()).toBe(0)
      held.resolve()
      await first
    },
  )

  test('ownership context binding is stable and first binding waits for idle entries', async () => {
    const queues = createOwnerQueues()
    const port = contextPort()
    queues.bindOwnershipContext(undefined)
    await queues.run('read', group, async () => {
      expect(() => queues.bindOwnershipContext(port)).toThrow(TypeError)
    })
    queues.bindOwnershipContext(port)
    queues.bindOwnershipContext(port)
    queues.bindOwnershipContext(undefined)
    expect(() => queues.bindOwnershipContext(contextPort())).toThrow(
      new TypeError('ownershipContext differs from the port bound to this database'),
    )
    await queues.run('read', group, async (entry) => {
      queues.bindOwnershipContext(port)
      await Promise.resolve()
      expect(queues.current()).toBe(entry)
    })
  })
})

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
    const queues = createOwnerQueues({ ownershipContext: contextPort() })
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
      const queues = createOwnerQueues({ ownershipContext: contextPort() })
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
    const hookEntries: Array<OwnerEntry | undefined> = []
    let captured!: OwnerEntry
    await queues.run('transition', group, async (entry) => {
      captured = entry
      entry.onCommit(() => {
        hookEntries.push(queues.current())
        hookRejections.push(queues.run('read', group, async () => undefined))
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
    expect(hookEntries).toEqual([captured])
    expect(hookRejections).toHaveLength(1)
    await expect(hookRejections[0]).rejects.toBeInstanceOf(ReentrantOwnershipError)
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

  test.each([
    ['work', 'finalise'],
    ['finalise', 'effects'],
  ] as const)('%s operations drain before entering %s', async (phase, next) => {
    const queues = createOwnerQueues()
    const suspended = deferred<void>()
    const boundaryStarted = deferred<void>()
    const order: Array<string> = []
    let captured!: OwnerEntry
    const owner = queues.run('transition', group, async (entry) => {
      captured = entry
      await advance(entry, phase)
      const reserve = <T>(work: () => Promise<T>) =>
        phase === 'finalise'
          ? entry.coordinate(entry.coordinator(entry.attempt()), work)
          : entry.operation(entry.attempt(), work)
      const first = reserve(async () => {
        order.push(`first-start:${entry.phase}`)
        await suspended.promise
        order.push(`first-end:${entry.phase}`)
      })
      const second = reserve(async () => {
        order.push(`second:${entry.phase}`)
      })
      const boundary = entry.enter(next).then(() => order.push(`entered:${entry.phase}`))
      boundaryStarted.resolve()
      await Promise.all([first, second, boundary])
      await entry.enter('outcome')
      entry.settle('committed')
    })
    await boundaryStarted.promise
    await flush()
    const suspendedPhase = captured.phase
    const suspendedOrder = [...order]
    suspended.resolve()
    await owner
    expect(suspendedPhase).toBe(phase)
    expect(suspendedOrder).toEqual([`first-start:${phase}`])
    expect(order).toEqual([
      `first-start:${phase}`,
      `first-end:${phase}`,
      `second:${phase}`,
      `entered:${next}`,
    ])
  })

  test('the operation lock serialises suspended work and outcome drains after caller rejection', async () => {
    const queues = createOwnerQueues()
    const suspended = deferred<void>()
    const operationStarted = deferred<void>()
    const outcomeStarted = deferred<void>()
    const callerError = new Error('caller abandoned operation')
    const order: Array<string> = []
    let closing!: Promise<void>
    const owner = queues.run('transition', group, async (entry) => {
      await advance(entry, 'work')
      void entry.operation(entry.attempt(), async () => {
        order.push('first-start')
        operationStarted.resolve()
        await suspended.promise
        order.push('first-end')
      })
      void entry.operation(entry.attempt(), async () => {
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

  test('caller rejection during a phase change drains work and settles rollback before release', async () => {
    const queues = createOwnerQueues()
    const suspended = deferred<void>()
    const boundaryStarted = deferred<void>()
    const callerError = new Error('caller abandoned finalisation')
    const order: Array<string> = []
    let boundary!: Promise<void>
    const owner = queues.run('transition', group, async (entry) => {
      await advance(entry, 'work')
      entry.onRollback(() => order.push('rollback'))
      void entry.operation(entry.attempt(), async () => {
        order.push('work-start')
        await suspended.promise
        order.push('work-end')
      })
      boundary = entry.enter('finalise')
      boundaryStarted.resolve()
      throw callerError
    })
    const rejected = expect(owner).rejects.toBe(callerError)
    await boundaryStarted.promise
    await rejected
    const next = read(queues, 'read', order)
    await flush()
    const suspendedOrder = [...order]
    suspended.resolve()
    await boundary
    await next
    expect(suspendedOrder).toEqual(['work-start'])
    expect(order).toEqual(['work-start', 'work-end', 'rollback', 'read'])
  })

  test('a rejected operation does not strand later operation reservations or outcome', async () => {
    const queues = createOwnerQueues()
    const failure = new Error('operation failed')
    await queues.run('transition', group, async (entry) => {
      await advance(entry, 'work')
      const failed = entry.operation(entry.attempt(), async () => {
        throw failure
      })
      const later = entry.operation(entry.attempt(), async () => 7)
      await expect(failed).rejects.toBe(failure)
      await expect(later).resolves.toBe(7)
      await entry.enter('outcome')
      await expect(entry.operation(entry.attempt(), async () => undefined)).rejects.toBeInstanceOf(
        PersistencePhaseError,
      )
      entry.settle('rolled-back')
    })
  })

  test('a phase change refuses new operations while draining the registered set', async () => {
    const queues = createOwnerQueues()
    await queues.run('transition', group, async (entry) => {
      await advance(entry, 'work')
      const operation = entry.operation(entry.attempt(), async () => {})
      const boundary = entry.enter('finalise')
      await expect(entry.operation(entry.attempt(), async () => {})).rejects.toBeInstanceOf(
        PersistencePhaseError,
      )
      await Promise.all([operation, boundary])
      await entry.enter('outcome')
      entry.settle('committed')
    })
  })

  test.each([
    ['work', 'finalise'],
    ['finalise', 'effects'],
    ['effects', 'account'],
    ['account', 'outcome'],
  ] as const)('started nested descendants drain before %s enters %s', async (phase, next) => {
    const queues = createOwnerQueues()
    const reached = deferred<void>()
    const resume = deferred<void>()
    const order: Array<string> = []
    let captured!: OwnerEntry
    let child!: Promise<void>
    const owner = queues.run('transition', group, async (entry) => {
      captured = entry
      await advance(entry, phase)
      const parent = entry.sequence(async () => {
        child = entry.sequence(async () => {
          reached.resolve()
          await resume.promise
          order.push(`child:${entry.phase}`)
        })
        await reached.promise
      })
      await reached.promise
      const boundary = entry.enter(next).then(() => {
        order.push(`entered:${entry.phase}`)
      })
      await Promise.all([parent, boundary])
      if (next !== 'outcome') await entry.enter('outcome')
      entry.settle('committed')
    })
    await reached.promise
    await flush()
    const heldPhase = captured.phase
    const heldOrder = [...order]
    resume.resolve()
    await Promise.all([owner, child])
    expect(heldPhase).toBe(phase)
    expect(heldOrder).toEqual([])
    expect(order).toEqual([`child:${phase}`, `entered:${next}`])
  })

  test('a phase drain permits an already reserved operation to compose nested work', async () => {
    const queues = createOwnerQueues()
    await queues.run('transition', group, async (entry) => {
      await advance(entry, 'work')
      const parent = entry.sequence(() => entry.sequence(async () => 7))
      const boundary = entry.enter('finalise')
      await expect(parent).resolves.toBe(7)
      await boundary
      await entry.enter('outcome')
      entry.settle('committed')
    })
  })

  test('a nested sequenced operation runs inline within its parent', async () => {
    const queues = createOwnerQueues()
    const order: Array<string> = []
    await queues.run('transition', group, async (entry) => {
      await advance(entry, 'work')
      const outer = entry.sequence(async () => {
        order.push('outer-start')
        const inner = await entry.sequence(async () => {
          order.push('inner')
          return 2
        })
        order.push('outer-end')
        return inner + 1
      })
      const later = entry.sequence(async () => {
        order.push('later')
      })
      await expect(outer).resolves.toBe(3)
      await later
      await entry.enter('outcome')
      entry.settle('committed')
    })
    expect(order).toEqual(['outer-start', 'inner', 'outer-end', 'later'])
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
      first = entry.operation(entry.attempt(), async () => {
        entered.resolve()
        await suspended.promise
      })
      reserved = entry.operation(entry.attempt(), async () => {
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
