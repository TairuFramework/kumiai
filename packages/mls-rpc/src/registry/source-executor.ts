import { PeerRemovedError } from '@kumiai/rpc'

import { observeSourceClosure } from '../closing-preparation.js'
import {
  coordinatorBinding,
  type EntryCapability,
  type EntryReads,
  entryCapability,
} from '../entry-capability.js'
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
  SourceProjectionUnavailableError,
} from './source-command-runtime.js'
import type { CryptoCommands, SourceEntryCommand } from './source-crypto-commands.js'
import {
  isSourceEntryCommand,
  loadSourceCrypto,
  releaseSourceCrypto,
  retainSourceResult,
  runSourceCryptoCommand,
  runSourceCryptoEntry,
  sourceCryptoConfiguration,
  sourceCryptoScope,
} from './source-crypto-commands.js'
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
  accounted: SourceAdmission | null
  reason: Error | null
}
const ownedAdmissions = new WeakMap<
  SourceExecutor,
  (key: GroupKey, reads: EntryReads) => Promise<SourceBinding>
>()
const cryptoAssertions = new WeakMap<SourceExecutor, (binding: SourceBinding) => void>()
export function assertCryptoBinding(executor: SourceExecutor, binding: SourceBinding): void {
  const assert = cryptoAssertions.get(executor)
  if (assert === undefined) throw new GroupStateConflictError('Missing source admission')
  assert(binding)
}
const currentBindings = new WeakMap<SourceExecutor, (key: GroupKey) => SourceBinding>()
export function admitOwnedSource(
  executor: SourceExecutor,
  key: GroupKey,
  reads: EntryReads,
): Promise<SourceBinding> {
  const admit = ownedAdmissions.get(executor)
  if (admit === undefined) throw new GroupStateConflictError('Missing owned admission')
  return admit(key, reads)
}
export function currentSourceBinding(
  executor: SourceExecutor,
  key: GroupKey,
): SourceBinding | undefined {
  return currentBindings.get(executor)?.(key)
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
      accounted: null,
      reason: null,
    }
    cells.set(groupID, cell)
    const observed = cell
    observers.push(
      entry.observe(groupID, (observation) => {
        const previous = observed.projection ?? observed.accounted
        observed.projection = null
        observed.accounted = null
        if (observed.key === null) return
        const metadata =
          observation.metadata.find((value) => value.incarnation === observed.key?.incarnation) ??
          (previous?.metadata.version === observation.activeVersion ? previous.metadata : undefined)
        if (
          metadata !== undefined &&
          observation.lifetime !== null &&
          observation.trust !== null &&
          observation.trustStatus === 'readable'
        ) {
          observed.accounted = copyStoredValue({
            lifetime: observation.lifetime,
            metadata,
            source: {
              key: observed.key,
              stateVersion: metadata.version,
              identity: observation.trust.installed,
            },
          })
        }
        if (
          observation.stateStatus === 'unobserved' &&
          previous !== null &&
          metadata !== undefined &&
          observation.lifetime !== null
        ) {
          // Side-write accounting advances metadata without changing the installed private identity.
          observed.accounted = copyStoredValue({
            ...previous,
            lifetime: observation.lifetime,
            metadata,
            source: { ...previous.source, stateVersion: metadata.version },
          })
        }
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
    cell.accounted = null
    cell.reason = reason
  }
  function assertBinding(binding: SourceBinding, crypto = false): SourceCell {
    lifecycle.assertCurrent()
    if (entry.failureSignal?.aborted) throw entry.failureSignal.reason
    const cell = cells.get(binding.key.groupID)
    if (
      cell === undefined ||
      cell.generation !== binding.generation ||
      cell.key?.incarnation !== binding.key.incarnation
    ) {
      if (
        crypto &&
        (cell?.reason instanceof PeerRemovedError || cell?.reason instanceof GroupUnavailableError)
      )
        throw cell.reason
      throw new DisplacedGroupHandleError('Source binding is superseded', { cause: cell?.reason })
    }
    const projection = cell.projection ?? (crypto ? cell.accounted : null)
    if (projection === null) throw new SourceProjectionUnavailableError()
    assertSourceAdmission(binding.key, projection)
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
      const input = copyStoredValue(request.input)
      const configuration = sourceCryptoConfiguration(request)
      const expected =
        command === 'app.publication'
          ? copyStoredValue(
              (assertBinding(binding, true).projection ?? assertBinding(binding, true).accounted)
                ?.source,
            )
          : undefined
      await lifecycle.beforeUse()
      lifecycle.assertCurrent()
      const signals = anySignal([
        ...(entry.failureSignal === undefined ? [] : [entry.failureSignal]),
        ...(request.signal === undefined ? [] : [request.signal]),
      ])
      try {
        return await groupBatchFor(coordinator, binding.key.groupID).schedule({
          source: command,
          kind:
            command === 'app.open' || command === 'app.receive'
              ? 'open'
              : command === 'app.publication'
                ? 'enqueue'
                : 'accounting',
          signal: signals.signal,
          run: async (budget) => {
            if (command === 'source.load') {
              return await entry.read(binding.key.groupID, async (reads) => {
                const projection = await readSourceAdmission(reads, binding.key)
                const cell = cells.get(binding.key.groupID)
                if (cell === undefined || cell.generation !== binding.generation)
                  throw new DisplacedGroupHandleError('Source binding is superseded')
                cell.projection = projection
                assertBinding(binding)
                await loadSourceCrypto(coordinator, binding.key, reads)
                assertBinding(binding, command !== 'source.inspect')
                return {
                  binding: copyStoredValue(binding),
                  value: copyStoredValue(projection.source),
                }
              })
            }
            if (isSourceEntryCommand(command)) {
              const cell = cells.get(binding.key.groupID)
              if (cell === undefined || cell.generation !== binding.generation)
                throw new DisplacedGroupHandleError('Source binding is superseded')
              const value = await runSourceCryptoEntry<SourceEntryCommand>({
                coordinator,
                binding,
                command,
                input: input as CryptoCommands[SourceEntryCommand]['input'],
                expected,
                budget,
              })
              if (cell.generation !== binding.generation)
                throw new DisplacedGroupHandleError('Source binding is superseded')
              retainSourceResult(value, binding)
              return { binding: copyStoredValue(binding), value }
            }
            return await entry.command(
              binding.key.groupID,
              async (attempt) => {
                const cell = assertBinding(binding, command !== 'source.inspect')
                const projection =
                  cell.projection ?? (command !== 'source.inspect' ? cell.accounted : null)
                if (projection === null) throw new SourceProjectionUnavailableError()
                const value =
                  command === 'source.inspect'
                    ? runSourceCommand({ command, input: undefined }, projection, attempt)
                    : await runSourceCryptoCommand<keyof CryptoCommands>({
                        coordinator,
                        binding,
                        command,
                        input,
                        configuration,
                        scope: sourceCryptoScope(attempt, () => {
                          assertBinding(binding, true)
                        }),
                      })
                attempt.assertLive()
                assertBinding(binding, command !== 'source.inspect')
                retainSourceResult(value, binding)
                return { binding: copyStoredValue(binding), value }
              },
              { signal: signals.signal },
            )
          },
        })
      } catch (error) {
        if (signals.signal.aborted) throw signals.signal.reason
        throw error
      } finally {
        signals.dispose()
      }
    },
  }
  ownedAdmissions.set(executor, async (key, reads) => {
    const cell = cellFor(key.groupID)
    const projection = await readSourceAdmission(reads, key)
    if (cell.key !== null && cell.key.incarnation !== key.incarnation)
      close(cell, new DisplacedGroupHandleError('Source incarnation is displaced'))
    cell.key = copyStoredValue(key)
    cell.projection = projection
    cell.reason = null
    return { key: copyStoredValue(key), generation: cell.generation }
  })
  cryptoAssertions.set(executor, (binding) => {
    assertBinding(binding, true)
  })
  currentBindings.set(executor, (key) => {
    const cell = cellFor(key.groupID)
    const binding = { key: copyStoredValue(key), generation: cell.generation }
    assertBinding(binding)
    return binding
  })
  observers.push(
    observeSourceClosure(coordinator, (key, reason) => control.invalidate(key, reason)),
  )
  const source = { executor, control }
  executorDisposals.set(source, () => {
    for (const unsubscribe of observers.splice(0)) unsubscribe()
    cells.clear()
    releaseSourceCrypto(coordinator)
  })
  return source
}
