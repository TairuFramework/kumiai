/// <reference types="node" />

import { AsyncLocalStorage } from 'node:async_hooks'

import { registerMemoryFaults } from './memory-faults.js'
import { StorageOutcomeUnknownError } from './persistence-errors.js'
import type {
  GroupMutationGate,
  MemoryDatabase,
  MemoryStoreRows,
  MemoryTransaction,
  TransactionHookSettlement,
} from './persistence-types.js'

type Scope = { groupID: string | null; devicePackages: boolean }
type Owner = { active: boolean }
type GateOwner = { groupID: string; holds: Array<Promise<void>>; active: boolean }
const transactionContext = new AsyncLocalStorage<Owner>()
const gateContext = new AsyncLocalStorage<GateOwner>()

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

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// Each tail belongs to one owner; releasing it cannot unlock a later owner.
function queue() {
  let tail = Promise.resolve()
  return async (): Promise<() => void> => {
    const previous = tail
    const next = deferred()
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
  if (transactionContext.getStore() !== undefined) throw new Error('reentrant root work')
}

function createMutationGate(): GroupMutationGate {
  const acquire = groupQueue()
  return {
    async run(groupID, work) {
      assertRoot()
      if (gateContext.getStore() !== undefined) throw new Error('reentrant group gate')
      const release = await acquire(groupID)
      const owner: GateOwner = { groupID, holds: [], active: true }
      try {
        return await gateContext.run(owner, work)
      } finally {
        owner.active = false
        // Caller rejection can precede proof; the queue keeps ownership independently.
        void Promise.allSettled(owner.holds).then(release)
      }
    },
    holdUntil(groupID, completion) {
      const owner = gateContext.getStore()
      if (owner === undefined || !owner.active || owner.groupID !== groupID) {
        throw new Error('Group gate ownership conflict')
      }
      owner.holds.push(completion)
    },
  }
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

function guardedMap(params: {
  rows: Map<string, unknown>
  assertActive(): void
  accepts(key: string): boolean
  write(key: string): void
  read(): void
}): Map<string, unknown> {
  const { rows, assertActive, accepts, write, read } = params
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
                ? structuredClone(value)
                : [key, structuredClone(value)],
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
          return property === 'get' ? structuredClone(rows.get(key)) : rows.has(key)
        }
      if (property === 'set')
        return (key: string, value: unknown) => {
          assertActive()
          checkKey(key)
          rows.set(key, structuredClone(value))
          write(key)
          return view
        }
      if (property === 'delete')
        return (key: string) => {
          assertActive()
          checkKey(key)
          const deleted = rows.delete(key)
          write(key)
          return deleted
        }
      if (property === 'clear')
        return () => {
          assertActive()
          for (const key of rows.keys()) {
            rows.delete(key)
            write(key)
          }
        }
      if (property === 'forEach')
        return (fn: (value: unknown, key: string, map: Map<string, unknown>) => void) => {
          assertActive()
          read()
          for (const [key, value] of rows) {
            assertActive()
            fn(structuredClone(value), key, view)
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
  const committed = structuredClone(params.rows)
  const acquireGroup = groupQueue()
  const acquireDevice = queue()
  const pending = new Set<{ scope: Scope; waiting(): void }>()
  const barriers = new Set<Scope>()
  const mutationGate = createMutationGate()
  async function acquire(scope: Scope): Promise<() => void> {
    const releases: Array<() => void> = []
    if (scope.devicePackages) releases.push(await acquireDevice())
    if (scope.groupID !== null) releases.push(await acquireGroup(scope.groupID))
    return () => {
      for (const release of releases.reverse()) release()
    }
  }
  const db: MemoryDatabase = {
    mutationGate,
    snapshot() {
      return structuredClone(committed)
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
        if (!owner.active || transactionContext.getStore() !== owner)
          throw new Error('expired transaction view')
      }
      const views: MemoryStoreRows = {}
      for (const name of names) {
        if (groupNamespaces.has(name) && scope.groupID === null) continue
        if (deviceNamespaces.has(name) && !scope.devicePackages) continue
        const rows = new Map<string, unknown>()
        for (const [key, value] of committed[name] ?? []) {
          if (belongs(name, key, scope)) rows.set(key, structuredClone(value))
        }
        views[name] = guardedMap({
          rows,
          assertActive,
          accepts: (key) => belongs(name, key, scope),
          write(key) {
            let changed = touched.get(name)
            if (changed === undefined) {
              changed = { rows, keys: new Set() }
              touched.set(name, changed)
            }
            changed.keys.add(key)
            if (faults.take('after-first-write')) {
              writeFailure = new Error('Injected after-first-write failure')
              throw writeFailure
            }
          },
          read() {
            if (faults.take('status-read')) throw new Error('Injected status-read failure')
          },
        })
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
      const tx: MemoryTransaction = {
        providerID: 'memory',
        groupID: scope.groupID,
        rows,
        onCommit(hook) {
          assertActive()
          commits.push(hook)
        },
        onRollback(hook) {
          assertActive()
          rollbacks.push(hook)
        },
      }
      let backendOutcome: 'committed' | 'rolled-back' | undefined
      let outcome: 'committed' | 'rolled-back' | undefined
      const settled = deferred()
      const settlement: TransactionHookSettlement = {
        settle(next) {
          if (backendOutcome !== next) throw new Error('Backend ownership conflict')
          if (outcome !== undefined) {
            if (outcome !== next) throw new Error('Transaction ownership conflict')
            return
          }
          outcome = next
          transactionContext.run(owner, () => {
            for (const hook of next === 'committed' ? commits : rollbacks) {
              try {
                hook()
              } catch {
                /* A failed hook must not skip remaining hooks. */
              }
            }
          })
          commits.length = 0
          rollbacks.length = 0
          settled.resolve()
        },
      }
      const merge = () => {
        for (const [name, { rows, keys }] of touched) {
          const target = committed[name] ?? new Map<string, unknown>()
          committed[name] = target
          for (const key of keys) {
            if (rows.has(key)) target.set(key, structuredClone(rows.get(key)))
            else target.delete(key)
          }
        }
      }
      let retained = false
      try {
        const value = await transactionContext.run(owner, () => fn(tx))
        owner.active = false
        if (writeFailure !== undefined) throw writeFailure
        if (faults.take('before-commit')) throw new Error('Injected before-commit failure')
        const fault = faults.takeCommit()
        if (fault !== undefined) {
          retained = true
          if (fault === 'reject') {
            merge()
            backendOutcome = 'committed'
            release()
          } else {
            const backendOwner = { scope, waiting: fault.waiting }
            pending.add(backendOwner)
            for (const barrier of barriers) if (overlaps(scope, barrier)) backendOwner.waiting()
            fault.reject((outcome) => {
              if (outcome === 'commit') merge()
              backendOutcome = outcome === 'commit' ? 'committed' : 'rolled-back'
              pending.delete(backendOwner)
              release()
            })
          }
          const gateOwner = gateContext.getStore()
          if (scope.groupID !== null && gateOwner?.active && gateOwner.groupID === scope.groupID) {
            mutationGate.holdUntil(scope.groupID, settled.promise)
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
        if (!retained) {
          backendOutcome = 'rolled-back'
          settlement.settle('rolled-back')
        }
        throw error
      } finally {
        owner.active = false
        if (!retained) release()
      }
    },
  }
  const faults = registerMemoryFaults(db)
  return db
}
