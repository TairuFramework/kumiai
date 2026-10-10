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
import { PersistencePhaseError, StorageOutcomeUnknownError } from './persistence-errors.js'
import type {
  MemoryDatabase,
  MemoryStoreRows,
  MemoryTransaction,
  TransactionHookSettlement,
} from './persistence-types.js'
import { deferred } from './runtime.js'

type Scope = { groupID: string | null; devicePackages: boolean }
type Owner = { active: boolean }
let invoking = false

const groupNamespaces = new Set([
  'lifetime',
  'trust',
  'state',
  'control',
  'anchor',
  'pending',
  'poison',
  'cursor',
  'outbox',
  'meta',
  'group-owner',
])
const deviceNamespaces = new Set([
  'device',
  'device-owner',
  'device-package',
  'device-last-resort',
  'device-receipt',
  'device-cleanup',
  'device-restore',
])

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

function belongs(namespace: string, key: string, scope: Scope): boolean {
  if (!groupNamespaces.has(namespace) && !deviceNamespaces.has(namespace)) return true
  let address: unknown
  try {
    address = JSON.parse(key)
  } catch {
    return false
  }
  if (
    !Array.isArray(address) ||
    address.length !== 3 ||
    typeof address[0] !== 'string' ||
    (address[1] !== null && (!Number.isSafeInteger(address[1]) || address[1] < 1)) ||
    typeof address[2] !== 'string'
  )
    return false
  return deviceNamespaces.has(namespace)
    ? scope.devicePackages && address[1] === null
    : scope.groupID !== null && address[0] === scope.groupID
}

function overlaps(left: Scope, right: Scope): boolean {
  return (
    (left.devicePackages && right.devicePackages) ||
    (left.groupID !== null && left.groupID === right.groupID)
  )
}

function cloneValue<TValue>(value: TValue): TValue {
  const copies = new Map<object, object>()
  function copyBuffer(buffer: ArrayBufferLike): ArrayBuffer {
    const existing = copies.get(buffer)
    if (existing !== undefined) return existing as ArrayBuffer
    const copy = new Uint8Array(buffer).slice().buffer
    copies.set(buffer, copy)
    return copy
  }
  function copy(value: unknown): unknown {
    if (typeof value === 'function' || typeof value === 'symbol') {
      throw new TypeError('Unsupported memory row value')
    }
    if (typeof value !== 'object' || value === null) return value
    // Shared storage is accepted only through views, never as an exposed row value.
    if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
      throw new TypeError('Unsupported memory row value')
    const existing = copies.get(value)
    if (existing !== undefined) return existing
    if (ArrayBuffer.isView(value)) {
      const buffer = copyBuffer(value.buffer)
      if (value instanceof DataView) {
        const view = new DataView(buffer, value.byteOffset, value.byteLength)
        copies.set(value, view)
        return view
      }
      const View = [
        Int8Array,
        Uint8Array,
        Uint8ClampedArray,
        Int16Array,
        Uint16Array,
        Int32Array,
        Uint32Array,
        ...(typeof Float16Array === 'undefined' ? [] : [Float16Array]),
        Float32Array,
        Float64Array,
        BigInt64Array,
        BigUint64Array,
      ].find((View) => value instanceof View)
      if (View === undefined) throw new TypeError('Unsupported memory row view')
      const view = new View(
        buffer,
        value.byteOffset,
        (value as unknown as { length: number }).length,
      )
      copies.set(value, view)
      return view
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype === ArrayBuffer.prototype) return copyBuffer(value as ArrayBuffer)
    if (prototype === Date.prototype) {
      const date = new Date((value as Date).getTime())
      copies.set(value, date)
      return date
    }
    if (prototype === Map.prototype) {
      const map = new Map<unknown, unknown>()
      copies.set(value, map)
      for (const [key, item] of value as Map<unknown, unknown>) map.set(copy(key), copy(item))
      return map
    }
    if (prototype === Set.prototype) {
      const set = new Set<unknown>()
      copies.set(value, set)
      for (const item of value as Set<unknown>) set.add(copy(item))
      return set
    }
    if (prototype === Object.prototype || prototype === null || Array.isArray(value)) {
      const object = Array.isArray(value) ? new Array(value.length) : Object.create(prototype)
      copies.set(value, object)
      for (const key of Reflect.ownKeys(value)) {
        if (Array.isArray(value) && key === 'length') continue
        Object.defineProperty(object, key, {
          value: copy(Reflect.get(value, key)),
          enumerable: Object.prototype.propertyIsEnumerable.call(value, key),
          configurable: true,
          writable: true,
        })
      }
      return object
    }
    throw new TypeError('Unsupported memory row value')
  }
  return copy(value) as TValue
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
    snapshot() {
      return cloneValue(committed)
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
            if (faults.take('after-first-write')) {
              writeFailure = new Error('Injected after-first-write failure')
              throw writeFailure
            }
          },
          read() {
            if (faults.take('status-read')) throw new Error('Injected status-read failure')
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
        if (faults.take('before-commit')) throw new Error('Injected before-commit failure')
        const fault = faults.takeCommit()
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
        if (disposed) await memoryTransactionEntry(rows)?.backendSettled()
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
