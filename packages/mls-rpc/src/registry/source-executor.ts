import { PeerRemovedError } from '@kumiai/rpc'

import { observeSourceClosure } from '../closing-preparation.js'
import { coordinatorBinding, type EntryCapability, entryCapability } from '../entry-capability.js'
import { groupBatchFor } from '../group-batch-binding.js'
import { copyStoredValue } from '../memory-incarnation-stores.js'
import {
  DisplacedGroupHandleError,
  GroupStateConflictError,
  GroupUnavailableError,
} from '../persistence-errors.js'
import type { DevicePersistence, GroupKey, GroupTransaction } from '../persistence-types.js'
import { anySignal } from '../runtime.js'
import {
  assertSourceAdmission,
  readSourceAdmission,
  runSourceCommand,
  type SourceAdmission,
} from './source-command-runtime.js'
import type {
  DeviceLifecycle,
  SourceBinding,
  SourceExecutor,
  SourceExecutorControl,
} from './source-executor-types.js'
import type { RecoveryEnvironment } from './validation.js'

type SourceCell = {
  generation: number
  key: GroupKey | null
  projection: SourceAdmission | null
  reason: Error | null
}
type Executor = { executor: SourceExecutor; control: SourceExecutorControl }
const registryExecutors = new WeakMap<object, Executor>()
const executorDisposals = new WeakMap<Executor, () => void>()
// Bindings can outlive coordinators, including when sealed persistence is reopened.
let sourceGeneration = 0

function nextGeneration(): number {
  if (sourceGeneration === Number.MAX_SAFE_INTEGER)
    throw new GroupStateConflictError('Source lifecycle generation exhausted')
  return ++sourceGeneration
}

export function bindRegistrySourceExecutor(registry: object, source: Executor): void {
  registryExecutors.set(registry, source)
}
export function releaseRegistrySourceExecutor(registry: object): void {
  const source = registryExecutors.get(registry)
  if (source !== undefined) executorDisposals.get(source)?.()
  registryExecutors.delete(registry)
}
export function registrySourceExecutor(registry: object): Executor {
  const source = registryExecutors.get(registry)
  if (source === undefined) throw new GroupStateConflictError('Registry has no source executor')
  return source
}

export function createSourceExecutor<TTx extends GroupTransaction>(params: {
  persistence: DevicePersistence<TTx>
  entry: EntryCapability<TTx>
  lifecycle: DeviceLifecycle
  environment: RecoveryEnvironment
}): Executor {
  const { persistence, entry, lifecycle } = params
  const coordinator = coordinatorBinding(persistence.groups)
  if (coordinator === null || entryCapability(persistence.groups) !== entry)
    throw new GroupStateConflictError('Source executor requires the registered coordinator')
  const cells = new Map<string, SourceCell>()
  const observers: Array<() => void> = []
  function assertRoot(): void {
    entry.assertRoot()
    lifecycle.assertCurrent()
  }
  function cellFor(groupID: string): SourceCell {
    let cell = cells.get(groupID)
    if (cell !== undefined) return cell
    cell = {
      generation: nextGeneration(),
      key: null,
      projection: null,
      reason: null,
    }
    cells.set(groupID, cell)
    const observed = cell
    observers.push(
      entry.observe(groupID, (observation) => {
        observed.projection = null
        if (observed.key === null) return
        const lifetime = observation.lifetime
        if (lifetime?.restorePending) {
          close(observed, new GroupUnavailableError({ reason: 'restore-pending' }))
        } else if (lifetime?.activeIncarnation !== observed.key.incarnation) {
          close(observed, new DisplacedGroupHandleError('Source incarnation is displaced'))
        } else if (observation.terminal === true) {
          close(observed, new PeerRemovedError())
        }
      }),
    )
    return cell
  }
  function close(cell: SourceCell, reason: Error): void {
    cell.generation = nextGeneration()
    cell.key = null
    cell.projection = null
    cell.reason = reason
  }
  function assertBinding(binding: SourceBinding): SourceCell {
    lifecycle.assertCurrent()
    if (entry.failureSignal?.aborted) throw entry.failureSignal.reason
    const cell = cells.get(binding.key.groupID)
    if (
      cell === undefined ||
      cell.generation !== binding.generation ||
      cell.key?.incarnation !== binding.key.incarnation
    )
      throw new DisplacedGroupHandleError('Source binding is superseded', { cause: cell?.reason })
    if (cell.projection === null) throw new GroupUnavailableError({ reason: 'invalid' })
    assertSourceAdmission(binding.key, cell.projection)
    return cell
  }
  const control: SourceExecutorControl = {
    async admit(requestedKey, _purpose) {
      assertRoot()
      const key = copyStoredValue(requestedKey)
      await lifecycle.beforeUse()
      lifecycle.assertCurrent()
      const cell = cellFor(key.groupID)
      return await groupBatchFor(coordinator, key.groupID).schedule({
        source: 'source-admission',
        kind: 'accounting',
        signal: entry.failureSignal,
        run: async () =>
          await entry.read(key.groupID, async (reads) => {
            const generation = cell.generation
            const projection = await readSourceAdmission(reads, key)
            lifecycle.assertCurrent()
            if (generation !== cell.generation)
              throw new DisplacedGroupHandleError('Source admission was superseded')
            if (cell.key !== null && cell.key.incarnation !== key.incarnation)
              close(cell, new DisplacedGroupHandleError('Source incarnation is displaced'))
            cell.key = copyStoredValue(key)
            cell.projection = projection
            cell.reason = null
            return { key: copyStoredValue(key), generation: cell.generation }
          }),
      })
    },
    invalidate(key, reason) {
      const cell = cells.get(key.groupID)
      if (cell?.key?.incarnation === key.incarnation) close(cell, reason)
    },
    assertCurrent(binding) {
      assertBinding(binding)
    },
  }
  const executor: SourceExecutor = {
    async execute(request) {
      assertRoot()
      const binding = copyStoredValue(request.binding)
      const command = request.command
      const input = request.input
      await lifecycle.beforeUse()
      lifecycle.assertCurrent()
      const signals = anySignal([
        ...(entry.failureSignal === undefined ? [] : [entry.failureSignal]),
        ...(request.signal === undefined ? [] : [request.signal]),
      ])
      try {
        return await groupBatchFor(coordinator, binding.key.groupID).schedule({
          source: command,
          kind: 'accounting',
          signal: signals.signal,
          run: async () =>
            await entry.command(
              binding.key.groupID,
              async (attempt) => {
                const cell = assertBinding(binding)
                const projection = cell.projection
                if (projection === null) throw new GroupUnavailableError({ reason: 'invalid' })
                const value = runSourceCommand({ command, input }, projection, attempt)
                attempt.assertLive()
                assertBinding(binding)
                return { binding: copyStoredValue(binding), value }
              },
              { signal: signals.signal },
            ),
        })
      } finally {
        signals.dispose()
      }
    },
  }
  observers.push(
    observeSourceClosure(coordinator, (key, reason) => control.invalidate(key, reason)),
  )
  const source = { executor, control }
  executorDisposals.set(source, () => {
    for (const unsubscribe of observers.splice(0)) unsubscribe()
    cells.clear()
  })
  return source
}
