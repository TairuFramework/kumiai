import { expect, test, vi } from 'vitest'

import type {
  MemoryStoreRows,
  MemoryTransaction,
  TransactionHookSettlement,
} from '../src/persistence-types.js'
import { createMemoryTransaction, memoryFaults } from '../src/testing.js'

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function namespace(rows: MemoryStoreRows, name: string): Map<string, unknown> {
  const map = rows[name]
  if (map === undefined) throw new Error(`Missing namespace: ${name}`)
  return map
}

const scope = { groupID: 'group-A', devicePackages: false }
const otherScope = { groupID: 'group-B', devicePackages: false }
const key = JSON.stringify(['group-A', 1, 'current'])
const otherKey = JSON.stringify(['group-B', 1, 'current'])
const sealedA = new Uint8Array([97, 1])
const sealedB = new Uint8Array([98, 2])

test.each(
  (['seed', 'snapshot', 'transaction-read', 'rollback', 'transaction-write'] as const).flatMap(
    (boundary) => (['state', 'effects'] as const).map((name) => [boundary, name] as const),
  ),
)('isolates shared bytes at the %s boundary in %s rows', async (boundary, name) => {
  const bytes = new Uint8Array(new SharedArrayBuffer(4), 1, 2)
  bytes.set(sealedA)
  const rowKey = name === 'state' ? key : 'effect-A'
  const wrap = (bytes: Uint8Array): unknown => (name === 'state' ? bytes : { nested: { bytes } })
  const unwrap = (value: unknown): Uint8Array =>
    name === 'state'
      ? (value as Uint8Array)
      : (value as { nested: { bytes: Uint8Array } }).nested.bytes
  const db = createMemoryTransaction({ rows: { [name]: new Map([[rowKey, wrap(bytes)]]) } })
  const snapshotBytes = () => unwrap(namespace(db.snapshot(), name).get(rowKey))

  if (boundary === 'seed') {
    bytes[0] = 42
    expect(snapshotBytes()[0]).toBe(97)
  } else if (boundary === 'snapshot') {
    const snapshot = snapshotBytes()
    snapshot[0] = 43
    expect(snapshotBytes()[0]).toBe(97)
    expect(snapshot.buffer).toBeInstanceOf(ArrayBuffer)
  } else if (boundary === 'transaction-read') {
    await db.transact(scope, async (tx) => {
      const rows = namespace(tx.rows, name)
      const read = unwrap(rows.get(rowKey))
      read[0] = 23
      expect(unwrap(rows.get(rowKey))[0]).toBe(97)
      expect(read.buffer).toBeInstanceOf(ArrayBuffer)
    })
    expect(snapshotBytes()[0]).toBe(97)
  } else if (boundary === 'rollback') {
    await expect(
      db.transact(scope, async (tx) => {
        unwrap(namespace(tx.rows, name).get(rowKey))[0] = 23
        throw new Error('rollback shared read')
      }),
    ).rejects.toThrow('rollback shared read')
    expect(snapshotBytes()[0]).toBe(97)
  } else {
    bytes[0] = 98
    await db.transact(scope, async (tx) => {
      const rows = namespace(tx.rows, name)
      rows.set(rowKey, wrap(bytes))
      bytes[0] = 44
      expect(unwrap(rows.get(rowKey))[0]).toBe(98)
    })
    bytes[0] = 45
    expect(snapshotBytes()[0]).toBe(98)
  }
})

test('copies shared buffers throughout cyclic side rows and preserves view aliases', async () => {
  const buffer = new SharedArrayBuffer(8)
  const bytes = new Uint8Array(buffer, 2, 2)
  bytes.set(sealedA)
  const value = {
    buffer,
    bytes,
    view: new DataView(buffer, 2, 2),
    words: new Uint16Array(buffer, 2, 1),
    map: new Map([[buffer, bytes]]),
    set: new Set([buffer]),
    self: undefined as unknown,
  }
  value.self = value
  const db = createMemoryTransaction({ rows: { effects: new Map([['effect-A', value]]) } })
  await db.transact(scope, async (tx) => {
    const rows = namespace(tx.rows, 'effects')
    rows.set('effect-A', value)
    bytes.fill(0)
    const copy = rows.get('effect-A') as typeof value
    expect(copy.buffer).toBeInstanceOf(ArrayBuffer)
    expect(copy.bytes).toEqual(sealedA)
    expect(copy.bytes.byteOffset).toBe(2)
    expect(copy.view.byteLength).toBe(2)
    expect(copy.view.getUint8(0)).toBe(97)
    expect(copy.words).toBeInstanceOf(Uint16Array)
    expect(copy.words.length).toBe(1)
    expect(copy.bytes.buffer).toBe(copy.buffer)
    expect(copy.view.buffer).toBe(copy.buffer)
    expect(copy.words.buffer).toBe(copy.buffer)
    expect(copy.map.get(copy.buffer)).toBe(copy.bytes)
    expect(copy.set.has(copy.buffer)).toBe(true)
    expect(copy.self).toBe(copy)
    copy.view.setUint8(0, 42)
    expect((rows.get('effect-A') as typeof value).bytes).toEqual(sealedA)
  })
  const snapshot = namespace(db.snapshot(), 'effects').get('effect-A') as typeof value
  snapshot.bytes.fill(0)
  expect((namespace(db.snapshot(), 'effects').get('effect-A') as typeof value).bytes).toEqual(
    sealedA,
  )
})

test.each(['synchronous', 'asynchronous'] as const)(
  'isolates groups and rejects nested root work without losing a concurrent commit (%s)',
  async (mode) => {
    const db = createMemoryTransaction({ rows: {} })
    const pause = deferred()
    const entered = deferred()
    const first = db.transact(scope, async (tx) => {
      if (mode === 'asynchronous') await Promise.resolve()
      for (const nestedScope of [scope, otherScope, { groupID: null, devicePackages: true }]) {
        await expect(db.transact(nestedScope, async () => 1)).rejects.toThrow('reentrant')
        await expect(db.completionBarrier(nestedScope)).rejects.toThrow('reentrant')
      }
      entered.resolve()
      await pause.promise
      namespace(tx.rows, 'state').set(key, sealedA)
    })
    await entered.promise
    await db.transact(otherScope, async (tx) => {
      namespace(tx.rows, 'state').set(otherKey, sealedB)
    })
    pause.resolve()
    await first
    expect(db.snapshot().state).toEqual(
      new Map([
        [key, sealedA],
        [otherKey, sealedB],
      ]),
    )
  },
)

test.each([false, true])(
  'queues same-group calls in FIFO order (device=%s)',
  async (devicePackages) => {
    const db = createMemoryTransaction({ rows: {} })
    const pause = deferred()
    const entered = deferred()
    const order: Array<number> = []
    const currentScope = { ...scope, devicePackages }
    const first = db.transact(currentScope, async (tx) => {
      entered.resolve()
      await pause.promise
      namespace(tx.rows, 'state').set(key, sealedA)
      order.push(1)
    })
    await entered.promise
    const second = db.transact(currentScope, async (tx) => {
      expect(namespace(tx.rows, 'state').get(key)).toEqual(sealedA)
      order.push(2)
    })
    const third = db.transact(currentScope, async () => {
      order.push(3)
    })
    expect(order).toEqual([])
    pause.resolve()
    await Promise.all([first, second, third])
    expect(order).toEqual([1, 2, 3])
  },
)

test.each(['commit', 'rollback'] as const)(
  'retains private writes and hooks until late completion proof (%s)',
  async (outcome) => {
    const db = createMemoryTransaction({ rows: {} })
    const fault = memoryFaults(db).rejectCommitPending()
    const hooks: Array<string> = []
    let settlement!: TransactionHookSettlement
    const result = db.transact(
      scope,
      async (tx) => {
        tx.onCommit(() => {
          hooks.push('commit')
        })
        tx.onRollback(() => {
          hooks.push('rollback')
        })
        namespace(tx.rows, 'state').set(key, sealedA)
      },
      {
        onUnknown: (value) => {
          settlement = value
        },
      },
    )
    const rejection = expect(result).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' })
    await fault.rejected
    await rejection
    expect(db.snapshot().state?.get(key)).toBeUndefined()
    expect(hooks).toEqual([])
    const barrier = db.completionBarrier(scope)
    await fault.barrierWaiting
    await fault.finish(outcome)
    await barrier
    expect(hooks).toEqual([])
    settlement.settle(outcome === 'commit' ? 'committed' : 'rolled-back')
    settlement.settle(outcome === 'commit' ? 'committed' : 'rolled-back')
    expect(() => settlement.settle(outcome === 'commit' ? 'rolled-back' : 'committed')).toThrow(
      'ownership',
    )
    expect(hooks).toEqual([outcome])
    expect(db.snapshot().state?.get(key)).toEqual(outcome === 'commit' ? sealedA : undefined)
  },
)

test('contains throwing hooks and releases only the completed owner', async () => {
  const db = createMemoryTransaction({ rows: { state: new Map([[otherKey, sealedB]]) } })
  const before = db.snapshot()
  const hooks: Array<string> = []
  await expect(
    db.transact(scope, async (tx) => {
      tx.onRollback(() => {
        throw new Error('hook failed')
      })
      tx.onRollback(() => {
        hooks.push('rollback-after-throw')
      })
      namespace(tx.rows, 'state').set(key, sealedA)
      throw new Error('callback failed')
    }),
  ).rejects.toThrow('callback failed')
  expect(hooks).toEqual(['rollback-after-throw'])
  expect(db.snapshot()).toEqual(before)
  await db.transact(scope, async (tx) => {
    tx.onCommit(() => {
      throw new Error('hook failed')
    })
    tx.onCommit(() => {
      hooks.push('commit-after-throw')
    })
  })
  expect(hooks).toEqual(['rollback-after-throw', 'commit-after-throw'])
})

test.each(['set', 'delete', 'clear', 'read', 'hook', 'iterator', 'foreign-callback'] as const)(
  'rejects expired transaction access (%s)',
  async (operation) => {
    const db = createMemoryTransaction({ rows: {} })
    let expired!: MemoryTransaction
    let map!: Map<string, unknown>
    let iterator!: IterableIterator<[string, unknown]>
    await db.transact(scope, async (tx) => {
      expired = tx
      map = namespace(tx.rows, 'state')
      map.set(key, sealedA)
      iterator = map.entries()
    })
    const act = () => {
      switch (operation) {
        case 'set':
          map.set(key, sealedB)
          break
        case 'delete':
          map.delete(key)
          break
        case 'clear':
          map.clear()
          break
        case 'read':
          namespace(expired.rows, 'state').get(key)
          break
        case 'hook':
          expired.onCommit(() => {})
          break
        case 'iterator':
          iterator.next()
          break
        case 'foreign-callback':
          map.set(key, sealedB)
          break
      }
    }
    if (operation === 'foreign-callback') {
      await db.transact(otherScope, async () => {
        expect(act).toThrow('expired')
      })
    } else expect(act).toThrow('expired')
    expect(namespace(db.snapshot(), 'state').get(key)).toEqual(sealedA)
  },
)

test.each(['set', 'delete', 'malformed-key', 'device-row', 'replace-namespace'] as const)(
  'rejects out-of-scope writes (%s)',
  async (operation) => {
    const db = createMemoryTransaction({ rows: { state: new Map([[otherKey, sealedB]]) } })
    await expect(
      db.transact(scope, async (tx) => {
        switch (operation) {
          case 'set':
            namespace(tx.rows, 'state').set(otherKey, sealedA)
            break
          case 'delete':
            namespace(tx.rows, 'state').delete(otherKey)
            break
          case 'malformed-key':
            namespace(tx.rows, 'state').set('group-A/current', sealedA)
            break
          case 'device-row':
            namespace(tx.rows, 'device-package').set(
              JSON.stringify(['device-A', null, 'ref']),
              sealedA,
            )
            break
          case 'replace-namespace':
            tx.rows.state = new Map([[otherKey, sealedA]])
            break
        }
      }),
    ).rejects.toThrow()
    expect(db.snapshot().state).toEqual(new Map([[otherKey, sealedB]]))
  },
)

test('copies committed snapshots, limits clear to its group and merges supplied side rows', async () => {
  const seed = {
    state: new Map([
      [key, sealedA],
      [otherKey, sealedB],
    ]),
    effects: new Map<string, unknown>(),
  }
  const db = createMemoryTransaction({ rows: seed })
  sealedA[0] = 42
  const before = db.snapshot()
  sealedA[0] = 97
  expect(namespace(before, 'state').get(key)).toEqual(sealedA)
  seed.state.clear()
  ;(namespace(before, 'state').get(key) as Uint8Array).fill(0)
  namespace(before, 'state').clear()
  const pause = deferred()
  const entered = deferred()
  const first = db.transact(scope, async (tx) => {
    namespace(tx.rows, 'state').clear()
    namespace(tx.rows, 'effects').set('effect-A', sealedA)
    entered.resolve()
    await pause.promise
  })
  await entered.promise
  await db.transact(otherScope, async (tx) => {
    namespace(tx.rows, 'effects').set('effect-B', sealedB)
  })
  pause.resolve()
  await first
  expect(db.snapshot().state).toEqual(new Map([[otherKey, sealedB]]))
  expect(db.snapshot().effects).toEqual(
    new Map([
      ['effect-A', sealedA],
      ['effect-B', sealedB],
    ]),
  )
})

test.each(['after-first-write', 'before-commit', 'callback'] as const)(
  'rolls back every namespace and side row (%s)',
  async (point) => {
    const db = createMemoryTransaction({ rows: { effects: new Map() } })
    const before = db.snapshot()
    if (point !== 'callback') memoryFaults(db).failNext(point)
    const hooks: Array<string> = []
    await expect(
      db.transact({ ...scope, devicePackages: true }, async (tx) => {
        tx.onRollback(() => {
          hooks.push('rollback')
        })
        namespace(tx.rows, 'state').set(key, sealedA)
        if (point === 'callback') throw new Error('after first domain write')
        namespace(tx.rows, 'control').set(key, sealedA)
        namespace(tx.rows, 'effects').set('effect-A', sealedA)
        namespace(tx.rows, 'device-package').set(JSON.stringify(['device-A', null, 'ref']), sealedA)
      }),
    ).rejects.toThrow()
    expect(db.snapshot()).toEqual(before)
    expect(hooks).toEqual(['rollback'])
    await db.transact(scope, async () => {})
  },
)

test('injects after-first-write on owner markers even if the callback catches it', async () => {
  const db = createMemoryTransaction({ rows: {} })
  memoryFaults(db).failNext('after-first-write')
  await expect(
    db.transact(scope, async (tx) => {
      expect(() =>
        namespace(tx.rows, 'group-owner').set(JSON.stringify(['group-A', null, 'current']), 1),
      ).toThrow('after-first-write')
      namespace(tx.rows, 'state').set(key, sealedA)
    }),
  ).rejects.toThrow('after-first-write')
  expect(db.snapshot()).toEqual({})
})

test.each(['commit', 'rollback'] as const)(
  'keeps queued A behind the backend barrier while B progresses (%s)',
  async (outcome) => {
    const db = createMemoryTransaction({ rows: {} })
    const fault = memoryFaults(db).rejectCommitPending()
    let settlement!: TransactionHookSettlement
    await expect(
      db.transact(
        scope,
        async (tx) => {
          namespace(tx.rows, 'state').set(key, sealedA)
        },
        {
          onUnknown(value) {
            settlement = value
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' })
    let queuedEntered = false
    const queued = db.transact(scope, async (tx) => {
      queuedEntered = true
      expect(namespace(tx.rows, 'state').get(key)).toEqual(
        outcome === 'commit' ? sealedA : undefined,
      )
    })
    const barrier = db.completionBarrier(scope)
    const completion = Promise.allSettled([queued, barrier])
    try {
      await fault.barrierWaiting
      await db.transact(otherScope, async (tx) => {
        namespace(tx.rows, 'state').set(otherKey, sealedB)
      })
      expect(queuedEntered).toBe(false)
      expect(namespace(db.snapshot(), 'state').get(key)).toBeUndefined()
      await fault.finish(outcome)
      await Promise.all([barrier, queued])
      expect(namespace(db.snapshot(), 'state').get(otherKey)).toEqual(sealedB)
    } finally {
      await fault.finish(outcome)
      await completion
      settlement.settle(outcome === 'commit' ? 'committed' : 'rolled-back')
    }
  },
)

test('keeps coordinator gates until hook settlement after backend completion', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const fault = memoryFaults(db).rejectCommitPending()
  const hooks: Array<string> = []
  let settlement!: TransactionHookSettlement
  await expect(
    db.mutationGate.run('group-A', () =>
      db.transact(
        scope,
        async (tx) => {
          tx.onCommit(() => {
            hooks.push('commit')
          })
          namespace(tx.rows, 'state').set(key, sealedA)
        },
        {
          onUnknown(value) {
            settlement = value
          },
        },
      ),
    ),
  ).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' })
  let entered = false
  const queued = db.mutationGate.run('group-A', async () => {
    entered = true
    expect(hooks).toEqual(['commit'])
  })
  const barrier = db.completionBarrier(scope)
  await fault.barrierWaiting
  await db.mutationGate.run('group-B', async () => {})
  expect(entered).toBe(false)
  await fault.finish('commit')
  await barrier
  expect(entered).toBe(false)
  settlement.settle('committed')
  await queued
  expect(entered).toBe(true)
})

test('rejects nested gates and retains explicit completion holds', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const held = deferred()
  await db.mutationGate.run('group-A', async () => {
    await expect(db.mutationGate.run('group-B', async () => {})).rejects.toThrow('reentrant')
    db.mutationGate.holdUntil('group-A', held.promise)
  })
  let entered = false
  const queued = db.mutationGate.run('group-A', async () => {
    entered = true
  })
  await db.mutationGate.run('group-B', async () => {})
  expect(entered).toBe(false)
  held.resolve()
  await queued
  expect(entered).toBe(true)
})

test('acquires device ownership before group ownership and fences both', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const entered = deferred()
  const pause = deferred()
  const device = { groupID: null, devicePackages: true }
  const first = db.transact(device, async () => {
    entered.resolve()
    await pause.promise
  })
  await entered.promise
  let combinedEntered = false
  const combined = db.transact({ ...scope, devicePackages: true }, async () => {
    combinedEntered = true
  })
  await db.transact(scope, async (tx) => {
    namespace(tx.rows, 'state').set(key, sealedA)
  })
  expect(combinedEntered).toBe(false)
  pause.resolve()
  await Promise.all([first, combined])
  const fault = memoryFaults(db).rejectCommitPending()
  await expect(
    db.transact({ ...scope, devicePackages: true }, async (tx) => {
      namespace(tx.rows, 'state').set(key, sealedB)
      namespace(tx.rows, 'device-receipt').set(
        JSON.stringify(['device-A', null, 'receipt']),
        sealedB,
      )
    }),
  ).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' })
  let deviceEntered = false
  const queuedDevice = db.transact(device, async () => {
    deviceEntered = true
  })
  const barrier = db.completionBarrier({ ...scope, devicePackages: true })
  await fault.barrierWaiting
  await db.transact(otherScope, async () => {})
  expect(deviceEntered).toBe(false)
  await fault.finish('rollback')
  await Promise.all([queuedDevice, barrier])
  expect(namespace(db.snapshot(), 'state').get(key)).toEqual(sealedA)
  expect(db.snapshot()['device-receipt']).toBeUndefined()
})

test('commits before an ambiguous rejection without settling hooks', async () => {
  const db = createMemoryTransaction({ rows: {} })
  memoryFaults(db).commitThenReject()
  let settlement!: TransactionHookSettlement
  const hooks: Array<string> = []
  await expect(
    db.transact(
      scope,
      async (tx) => {
        tx.onCommit(() => {
          throw new Error('hook failure')
        })
        tx.onCommit(() => {
          hooks.push('commit')
        })
        namespace(tx.rows, 'state').set(key, sealedA)
      },
      {
        onUnknown(value) {
          settlement = value
        },
      },
    ),
  ).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' })
  expect(namespace(db.snapshot(), 'state').get(key)).toEqual(sealedA)
  expect(hooks).toEqual([])
  await db.completionBarrier(scope)
  settlement.settle('committed')
  expect(hooks).toEqual(['commit'])
})

test('retries barrier faults outside transactions with capped backoff while B progresses', async () => {
  vi.useFakeTimers()
  try {
    const db = createMemoryTransaction({ rows: {} })
    const faults = memoryFaults(db)
    const fault = faults.rejectCommitPending()
    let settlement!: TransactionHookSettlement
    await expect(
      db.mutationGate.run('group-A', () =>
        db.transact(scope, async () => {}, {
          onUnknown(value) {
            settlement = value
          },
        }),
      ),
    ).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' })
    faults.failNext('status-read')
    let completed = false
    const barrier = db.completionBarrier(scope).then(() => {
      completed = true
    })
    await fault.barrierWaiting
    await fault.finish('rollback')
    for (const delay of [100, 200, 400, 800, 1600, 3200, 6400, 12800, 15000, 15000]) {
      await vi.advanceTimersByTimeAsync(0)
      expect(completed).toBe(false)
      expect(vi.getTimerCount()).toBe(1)
      await db.transact(otherScope, async () => {})
      faults.failNext('status-read')
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(completed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
    }
    await vi.advanceTimersByTimeAsync(15000)
    await barrier
    settlement.settle('rolled-back')
    expect(completed).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

test('pins the declared scope even when the caller mutates its input', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const declared = { ...scope }
  await db.transact(declared, async (tx) => {
    declared.groupID = 'group-B'
    expect(() => namespace(tx.rows, 'state').set(otherKey, sealedB)).toThrow('scope')
    namespace(tx.rows, 'state').set(key, sealedA)
  })
  expect(db.snapshot().state).toEqual(new Map([[key, sealedA]]))
})

test.each(['commit', 'rollback'] as const)(
  'rejects settlement before backend completion or against its outcome (%s)',
  async (outcome) => {
    const db = createMemoryTransaction({ rows: {} })
    const fault = memoryFaults(db).rejectCommitPending()
    const hooks: Array<string> = []
    let settlement!: TransactionHookSettlement
    await expect(
      db.transact(
        scope,
        async (tx) => {
          tx.onCommit(() => {
            hooks.push('commit')
          })
          tx.onRollback(() => {
            hooks.push('rollback')
          })
          namespace(tx.rows, 'state').set(key, sealedA)
        },
        {
          onUnknown(value) {
            settlement = value
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' })
    expect(() => settlement.settle('committed')).toThrow('ownership')
    expect(() => settlement.settle('rolled-back')).toThrow('ownership')
    expect(hooks).toEqual([])
    const barrier = db.completionBarrier(scope)
    await fault.barrierWaiting
    await fault.finish(outcome)
    await barrier
    expect(() => settlement.settle(outcome === 'commit' ? 'rolled-back' : 'committed')).toThrow(
      'ownership',
    )
    settlement.settle(outcome === 'commit' ? 'committed' : 'rolled-back')
    expect(hooks).toEqual([outcome])
  },
)

test('releases A without releasing an independently unfinished B', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const faults = memoryFaults(db)
  const a = faults.rejectCommitPending()
  await expect(
    db.transact(scope, async (tx) => {
      namespace(tx.rows, 'state').set(key, sealedA)
    }),
  ).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' })
  const b = faults.rejectCommitPending()
  await expect(
    db.transact(otherScope, async (tx) => {
      namespace(tx.rows, 'state').set(otherKey, sealedB)
    }),
  ).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' })
  const aBarrier = db.completionBarrier(scope)
  const bBarrier = db.completionBarrier(otherScope)
  await Promise.all([a.barrierWaiting, b.barrierWaiting])
  let bEntered = false
  const queuedB = db.transact(otherScope, async () => {
    bEntered = true
  })
  await a.finish('rollback')
  await aBarrier
  await db.transact(scope, async (tx) => {
    namespace(tx.rows, 'state').set(key, sealedA)
  })
  expect(bEntered).toBe(false)
  await b.finish('commit')
  await Promise.all([bBarrier, queuedB])
  expect(db.snapshot().state).toEqual(
    new Map([
      [key, sealedA],
      [otherKey, sealedB],
    ]),
  )
})

test('recognizes a barrier already queued when backend rejection becomes unknown', async () => {
  const db = createMemoryTransaction({ rows: {} })
  const fault = memoryFaults(db).rejectCommitPending()
  const entered = deferred()
  const pause = deferred()
  const result = db.transact(scope, async (tx) => {
    namespace(tx.rows, 'state').set(key, sealedA)
    entered.resolve()
    await pause.promise
  })
  const rejection = expect(result).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' })
  await entered.promise
  const barrier = db.completionBarrier(scope)
  pause.resolve()
  await rejection
  await fault.barrierWaiting
  await fault.finish('commit')
  await barrier
  expect(namespace(db.snapshot(), 'state').get(key)).toEqual(sealedA)
})
