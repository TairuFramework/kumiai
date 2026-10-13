import { registerMemoryFaults } from './memory-faults.js'
import {
  assertMemoryAccess,
  assertMemoryWrite,
  memoryTransactionChanged,
  memoryTransactionEntry,
  memoryTransactionFailureSignal,
  registerMemoryTransactionRows,
} from './memory-group-state.js'
import { groupOwnerKey } from './memory-incarnation-stores.js'
import {
  belongs,
  cloneValue,
  deviceNamespaces,
  groupNamespaces,
  type Scope,
} from './memory-rows.js'
import { ownerEntryFailureSignal } from './owner-queue.js'
import { PersistencePhaseError, StorageOutcomeUnknownError } from './persistence-errors.js'
import type {
  MemoryDatabase,
  MemoryStoreRows,
  MemoryTransaction,
  TransactionHookSettlement,
} from './persistence-types.js'
import { deferred } from './runtime.js'

type Owner = { active: boolean }
let invoking = false

// Each tail belongs to one owner; releasing it cannot unlock a later owner.
function queue() {
  let tail = Promise.resolve()
  return async (): Promise<() => void> => {
    const previous = tail
    const next = deferred<void>()
    tail = next.promise
    await previous
    return next.resolve
  }
}

function groupQueue() {
  const groups = new Map<string, ReturnType<typeof queue>>()
  return (groupID: string) => {
    let acquire = groups.get(groupID)
    if (acquire === undefined) {
      acquire = queue()
      groups.set(groupID, acquire)
    }
    return acquire()
  }
}

function assertRoot(): void {
  if (invoking) throw new Error('reentrant root work')
}

function overlaps(left: Scope, right: Scope): boolean {
  return (
    (left.devicePackages && right.devicePackages) ||
    (left.groupID !== null && left.groupID === right.groupID)
  )
}

function guardedMap(params: {
  rows: Map<string, unknown>
  assertActive(): void
  accepts(key: string): boolean
  write(key: string): void
  changed(): void
  read(): void
}): Map<string, unknown> {
  const { rows, assertActive, accepts, write, changed, read } = params
  let view: Map<string, unknown>
  function checkKey(key: string): void {
    if (!accepts(key)) throw new Error('Row outside transaction scope')
  }
  function iterator(mode: 'keys' | 'values' | 'entries') {
    const source = rows.entries()
    return {
      next() {
        assertActive()
        const item = source.next()
        if (item.done) return { done: true as const, value: undefined }
        const [key, value] = item.value
        return {
          done: false as const,
          value:
            mode === 'keys'
              ? key
              : mode === 'values'
                ? cloneValue(value)
                : [key, cloneValue(value)],
        }
      },
      [Symbol.iterator]() {
        return this
      },
    }
  }
  view = new Proxy(rows, {
    get(_target, property) {
      assertActive()
      if (property === 'size') {
        read()
        return rows.size
      }
      if (property === 'get' || property === 'has')
        return (key: string) => {
          assertActive()
          checkKey(key)
          read()
          return property === 'get' ? cloneValue(rows.get(key)) : rows.has(key)
        }
      if (property === 'set')
        return (key: string, value: unknown) => {
          assertActive()
          checkKey(key)
          const owned = cloneValue(value)
          write(key)
          rows.set(key, owned)
          changed()
          return view
        }
      if (property === 'delete')
        return (key: string) => {
          assertActive()
          checkKey(key)
          write(key)
          const removed = rows.delete(key)
          if (removed) changed()
          return removed
        }
      if (property === 'clear')
        return () => {
          assertActive()
          // A protected row must refuse the entire clear before any side row disappears.
          for (const key of rows.keys()) write(key)
          if (rows.size !== 0) {
            rows.clear()
            changed()
          }
        }
      if (property === 'forEach')
        return (fn: (value: unknown, key: string, map: Map<string, unknown>) => void) => {
          assertActive()
          read()
          for (const [key, value] of rows) {
            assertActive()
            fn(cloneValue(value), key, view)
          }
        }
      if (
        property === Symbol.iterator ||
        property === 'entries' ||
        property === 'keys' ||
        property === 'values'
      )
        return () => {
          assertActive()
          read()
          return iterator(property === 'keys' || property === 'values' ? property : 'entries')
        }
      if (property === Symbol.toStringTag) return 'Map'
      return undefined
    },
    set() {
      throw new Error('Cannot replace transaction map methods')
    },
    defineProperty() {
      throw new Error('Cannot replace transaction map methods')
    },
    deleteProperty() {
      throw new Error('Cannot replace transaction map methods')
    },
  })
  return view
}

export function createMemoryTransaction(params: { rows: MemoryStoreRows }): MemoryDatabase {
  const committed = cloneValue(params.rows)
  const acquireGroup = groupQueue()
  const acquireDevice = queue()
  const pending = new Set<{ scope: Scope; waiting(): void }>()
  const barriers = new Set<Scope>()
  async function acquire(scope: Scope): Promise<() => void> {
    const releases: Array<() => void> = []
    if (scope.devicePackages) releases.push(await acquireDevice())
    if (scope.groupID !== null) releases.push(await acquireGroup(scope.groupID))
    return () => {
      for (const release of releases.reverse()) release()
    }
  }
  const db: MemoryDatabase = {
    snapshot(groupID) {
      if (groupID === undefined) return cloneValue(committed)
      const rows: MemoryStoreRows = {}
      const scope = { groupID, devicePackages: false }
      for (const namespace of groupNamespaces) {
        const source = new Map<string, unknown>()
        for (const [key, value] of committed[namespace] ?? [])
          if (belongs(namespace, key, scope)) source.set(key, value)
        rows[namespace] = source
      }
      return cloneValue(rows)
    },
    async completionBarrier(requestedScope) {
      assertRoot()
      const scope = { ...requestedScope }
      let delay = 100
      for (;;) {
        barriers.add(scope)
        for (const owner of pending) if (overlaps(owner.scope, scope)) owner.waiting()
        const release = await acquire(scope)
        barriers.delete(scope)
        const failed = faults.take('status-read')
        if (!failed && scope.groupID !== null) {
          const rows = committed['group-owner'] ?? new Map<string, unknown>()
          committed['group-owner'] = rows
          const key = groupOwnerKey(scope.groupID)
          if (!rows.has(key)) rows.set(key, { mutationID: null, revision: 0 })
        }
        release()
        if (!failed) return
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delay)
        })
        delay = Math.min(delay * 2, 15000)
      }
    },
    async transact(requestedScope, fn, options) {
      assertRoot()
      const scope = { ...requestedScope }
      const release = await acquire(scope)
      const owner: Owner = { active: true }
      const commits: Array<() => void> = []
      const rollbacks: Array<() => void> = []
      const touched = new Map<string, { rows: Map<string, unknown>; keys: Set<string> }>()
      const names = new Set(Object.keys(committed))
      if (scope.groupID !== null) for (const name of groupNamespaces) names.add(name)
      if (scope.devicePackages) for (const name of deviceNamespaces) names.add(name)
      let writeFailure: Error | undefined
      const assertActive = () => {
        assertMemoryAccess(rows)
        if (!owner.active) throw new Error('expired transaction view')
      }
      const views: MemoryStoreRows = {}
      const privateMaps: Array<[string, Parameters<typeof guardedMap>[0]]> = []
      for (const name of names) {
        if (groupNamespaces.has(name) && scope.groupID === null) continue
        if (deviceNamespaces.has(name) && !scope.devicePackages) continue
        const rows = new Map<string, unknown>()
        for (const [key, value] of committed[name] ?? []) {
          if (belongs(name, key, scope)) rows.set(key, cloneValue(value))
        }
        const mapParams: Parameters<typeof guardedMap>[0] = {
          rows,
          assertActive,
          accepts: (key) => belongs(name, key, scope),
          write(key) {
            assertMemoryWrite(
              tx,
              ['lifetime', 'trust', 'state', 'group-owner', 'device-owner', 'device'].includes(
                name,
              ) ||
                (name === 'meta' && JSON.parse(key)[2] === JSON.stringify(['state-version']))
                ? 'domain'
                : 'side',
            )
            let changed = touched.get(name)
            if (changed === undefined) {
              changed = { rows, keys: new Set() }
              touched.set(name, changed)
            }
            changed.keys.add(key)
          },
          changed() {
            memoryTransactionChanged(tx.rows)
            if (faults.take('after-first-write', tx)) {
              writeFailure = new Error('Injected after-first-write failure')
              throw writeFailure
            }
          },
          read() {
            if (faults.take('status-read', tx)) throw new Error('Injected status-read failure')
          },
        }
        views[name] = guardedMap(mapParams)
        privateMaps.push([name, mapParams])
      }
      const rows = new Proxy(views, {
        get(target, property) {
          assertActive()
          return Reflect.get(target, property)
        },
        set() {
          throw new Error('Cannot replace transaction namespaces')
        },
        defineProperty() {
          throw new Error('Cannot replace transaction namespaces')
        },
        deleteProperty() {
          throw new Error('Cannot replace transaction namespaces')
        },
      })
      registerMemoryTransactionRows(rows, views, (assertLive) => {
        const check = () => {
          assertLive()
          if (!owner.active) throw new Error('expired transaction view')
        }
        const maps: MemoryStoreRows = {}
        for (const [name, params] of privateMaps) {
          maps[name] = guardedMap({
            ...params,
            assertActive: check,
            write(key) {
              check()
              // Only the private view bypasses public phase admission.
              let changed = touched.get(name)
              if (changed === undefined) {
                changed = { rows: params.rows, keys: new Set() }
                touched.set(name, changed)
              }
              changed.keys.add(key)
            },
          })
        }
        return new Proxy(maps, {
          get(target, property) {
            check()
            return Reflect.get(target, property)
          },
        })
      })
      const tx: MemoryTransaction = {
        providerID: 'memory',
        groupID: scope.groupID,
        rows,
        onCommit(hook) {
          assertActive()
          const entry = memoryTransactionEntry(rows)
          if (entry === undefined) commits.push(hook)
          else entry.onCommit(hook)
        },
        onRollback(hook) {
          assertActive()
          const entry = memoryTransactionEntry(rows)
          if (entry === undefined) rollbacks.push(hook)
          else entry.onRollback(hook)
        },
      }
      let backendOutcome: 'committed' | 'rolled-back' | undefined
      let outcome: 'committed' | 'rolled-back' | undefined
      const settlement: TransactionHookSettlement = {
        settle(next) {
          if (backendOutcome !== next) throw new Error('Backend ownership conflict')
          if (outcome !== undefined) {
            if (outcome !== next) throw new Error('Transaction ownership conflict')
            return
          }
          outcome = next
          for (const hook of next === 'committed' ? commits : rollbacks) {
            try {
              hook()
            } catch {
              /* A failed hook must not skip remaining hooks. */
            }
          }
          commits.length = 0
          rollbacks.length = 0
        },
      }
      const merge = () => {
        for (const [name, { rows, keys }] of touched) {
          const target = committed[name] ?? new Map<string, unknown>()
          committed[name] = target
          for (const key of keys) {
            if (rows.has(key)) target.set(key, cloneValue(rows.get(key)))
            else target.delete(key)
          }
        }
      }
      let retained = false
      let disposed = false
      let released = false
      let failureSignal: AbortSignal | undefined
      let backendOwner: { scope: Scope; waiting(): void } | undefined
      const failed = deferred<never>()
      const completed = deferred<void>()
      function releaseBackend(): void {
        failureSignal?.removeEventListener('abort', dispose)
        if (released) return
        released = true
        release()
        completed.resolve()
      }
      function dispose(): void {
        if (backendOutcome !== undefined) return
        disposed = true
        owner.active = false
        commits.length = 0
        rollbacks.length = 0
        touched.clear()
        backendOutcome = 'rolled-back'
        if (backendOwner !== undefined) pending.delete(backendOwner)
        releaseBackend()
        const reason = failureSignal?.reason
        failed.reject(reason instanceof PersistencePhaseError ? (reason.cause ?? reason) : reason)
      }
      try {
        let work: ReturnType<typeof fn>
        invoking = true
        try {
          work = fn(tx)
        } finally {
          invoking = false
        }
        memoryTransactionEntry(rows)?.trackBackend(completed.promise)
        failureSignal = memoryTransactionFailureSignal(rows)
        failureSignal?.addEventListener('abort', dispose, { once: true })
        if (failureSignal?.aborted) dispose()
        // Factory failure completes the backend independently of suspended host code.
        const value = await (failureSignal === undefined
          ? work
          : Promise.race([failed.promise, work]))
        if (disposed) {
          const reason = failureSignal?.reason
          throw reason instanceof PersistencePhaseError ? (reason.cause ?? reason) : reason
        }
        owner.active = false
        if (writeFailure !== undefined) throw writeFailure
        if (faults.take('before-commit', tx)) throw new Error('Injected before-commit failure')
        const fault = faults.takeCommit(tx)
        if (fault !== undefined) {
          retained = true
          if (fault === 'reject') {
            merge()
            backendOutcome = 'committed'
            releaseBackend()
          } else {
            backendOwner = { scope, waiting: fault.waiting }
            pending.add(backendOwner)
            for (const barrier of barriers) if (overlaps(scope, barrier)) backendOwner.waiting()
            fault.reject((outcome) => {
              if (disposed) return
              if (outcome === 'commit') merge()
              backendOutcome = outcome === 'commit' ? 'committed' : 'rolled-back'
              if (backendOwner !== undefined) pending.delete(backendOwner)
              releaseBackend()
            })
          }
          try {
            options?.onUnknown(settlement)
          } catch {
            /* Ambiguity still owns its hook queues. */
          }
          throw new StorageOutcomeUnknownError('Memory commit outcome unknown')
        }
        merge()
        backendOutcome = 'committed'
        settlement.settle('committed')
        return value
      } catch (error) {
        owner.active = false
        if (!retained && !disposed) {
          backendOutcome = 'rolled-back'
          settlement.settle('rolled-back')
        }
        throw error
      } finally {
        owner.active = false
        if (!retained) releaseBackend()
        if (disposed) {
          const entry = memoryTransactionEntry(rows)
          if (
            entry !== undefined &&
            (entry.kind !== 'read' || ownerEntryFailureSignal(entry)?.aborted)
          )
            await entry.backendSettled()
        }
      }
    },
  }
  const faults = registerMemoryFaults(db, (namespace, key, value) => {
    const rows = committed[namespace] ?? new Map<string, unknown>()
    committed[namespace] = rows
    if (value === undefined) rows.delete(key)
    else rows.set(key, cloneValue(value))
  })
  return db
}
