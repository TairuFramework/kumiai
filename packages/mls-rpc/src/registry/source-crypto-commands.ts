import type { GroupHandle } from '@kumiai/mls'
import type {
  AdoptionExpected,
  AppOutboxEntry,
  AppPublicationSnapshot,
  BatchBudget,
  ExportSecretResult,
  GroupCrypto,
  PreparedAppPublication,
} from '@kumiai/rpc'
import { createRuntime, type Runtime } from '@sozai/runtime'

import {
  assertSealedEntryBlob,
  deriveEntryKey,
  ENTRY_SEAL_LABEL,
  openEntries,
  sealEntries,
} from '../crypto.js'
import type { EntryCapability, EntryReads } from '../entry-capability.js'
import { copyStoredValue } from '../memory-incarnation-stores.js'
import { type OwnerAttempt, ownerAttemptCallback } from '../owner-queue.js'
import { GroupStateConflictError } from '../persistence-errors.js'
import type {
  GroupKey,
  GroupTransaction,
  OpenAppInput,
  OpenAppResult,
} from '../persistence-types.js'
import { SourceProjectionUnavailableError } from './source-command-runtime.js'
import { assertCryptoBinding, currentSourceBinding } from './source-executor.js'
import type {
  SourceBinding,
  SourceCommand,
  SourceExecutor,
  SourceExecutorControl,
} from './source-executor-types.js'
import type { ReceiveInput, ReceiveResult, SealedApp } from './types.js'

export type CryptoCommands = {
  'source.load': SourceCommand<undefined, AdoptionExpected>
  'app.open': SourceCommand<Array<OpenAppInput>, Array<OpenAppResult>>
  'app.publication': SourceCommand<
    { entry: AppOutboxEntry; floor: string | null },
    PreparedAppPublication
  >
  'app.publicationSnapshot': SourceCommand<string, AppPublicationSnapshot | null>
  'app.maintain': SourceCommand<undefined, void>
  'app.handoff': SourceCommand<undefined, void>
  'app.seal': SourceCommand<
    { plaintext: Uint8Array; aad: Uint8Array; intent: 'log' | 'ephemeral' },
    SealedApp
  >
  'app.receive': SourceCommand<Array<ReceiveInput>, Array<ReceiveResult>>
  'crypto.export': SourceCommand<{ label: string; length: number }, ExportSecretResult>
  'crypto.sealEntries': SourceCommand<Uint8Array, Awaited<ReturnType<GroupCrypto['sealEntries']>>>
  'crypto.openEntries': SourceCommand<Uint8Array, Uint8Array>
}
export type SourceCryptoScope = {
  assertLive(): void
  call<T>(fn: () => T): T
  onRevoke(fn: () => void): () => void
  protect(handle: GroupHandle): GroupHandle
}
export type SourceCryptoBodies = {
  seal(input: CryptoCommands['app.seal']['input'], scope: SourceCryptoScope): Promise<SealedApp>
  receive(input: Array<ReceiveInput>, scope: SourceCryptoScope): Promise<Array<ReceiveResult>>
  handle(scope: SourceCryptoScope): Promise<GroupHandle>
  open(input: Array<OpenAppInput>, budget: BatchBudget): Promise<Array<OpenAppResult>>
  publication(
    input: CryptoCommands['app.publication']['input'],
    expected: AdoptionExpected | undefined,
  ): Promise<PreparedAppPublication>
  publicationSnapshot(protocol: string): Promise<AppPublicationSnapshot | null>
  maintain(): Promise<void>
  handoff(scope: SourceCryptoScope): Promise<void>
}
type CryptoConfiguration = { label: string; runtime: Runtime }
type Registration = { key: GroupKey; bodies: SourceCryptoBodies }
const configurations = new WeakMap<object, CryptoConfiguration>()
export function sourceCryptoConfiguration(request: object): CryptoConfiguration | undefined {
  return configurations.get(request)
}
const registrations = new WeakMap<object, Map<string, Registration>>()
const loaders = new WeakMap<object, (key: GroupKey, reads: EntryReads) => Promise<void>>()
export function registerSourceLoader(
  coordinator: object,
  load: (key: GroupKey, reads: EntryReads) => Promise<void>,
): void {
  loaders.set(coordinator, load)
}
export async function loadSourceCrypto(
  coordinator: object,
  key: GroupKey,
  reads: EntryReads,
): Promise<void> {
  const load = loaders.get(coordinator)
  if (load === undefined) throw new GroupStateConflictError('Source loader is not registered')
  await load(key, reads)
}
export type SourceEntryCommand =
  | 'app.open'
  | 'app.publication'
  | 'app.publicationSnapshot'
  | 'app.maintain'
export function isSourceEntryCommand(
  name: keyof CryptoCommands | 'source.inspect',
): name is SourceEntryCommand {
  return (
    name === 'app.open' ||
    name === 'app.publication' ||
    name === 'app.publicationSnapshot' ||
    name === 'app.maintain'
  )
}
function registrationFor(coordinator: object, key: GroupKey): Registration {
  const registration = registrations
    .get(coordinator)
    ?.get(JSON.stringify([key.groupID, key.incarnation]))
  if (registration === undefined)
    throw new GroupStateConflictError('Source crypto is not registered')
  return registration
}
export async function runSourceCryptoEntry<TName extends SourceEntryCommand>(params: {
  coordinator: object
  binding: SourceBinding
  command: TName
  input: CryptoCommands[TName]['input']
  expected?: AdoptionExpected
  budget: BatchBudget
}): Promise<CryptoCommands[TName]['output']> {
  const registration = registrationFor(params.coordinator, params.binding.key)
  const input = copyStoredValue(params.input)
  let result: unknown
  switch (params.command) {
    case 'app.open':
      result = await registration.bodies.open(input as Array<OpenAppInput>, params.budget)
      break
    case 'app.publication':
      result = await registration.bodies.publication(
        input as CryptoCommands['app.publication']['input'],
        params.expected,
      )
      break
    case 'app.publicationSnapshot':
      result = await registration.bodies.publicationSnapshot(input as string)
      break
    case 'app.maintain':
      result = await registration.bodies.maintain()
      break
  }
  return result as CryptoCommands[TName]['output']
}
export function releaseSourceCrypto(coordinator: object): void {
  registrations.delete(coordinator)
  loaders.delete(coordinator)
}
const resultBindings = new WeakMap<object, SourceBinding>()
export function sourceResultBinding(value: object): SourceBinding | undefined {
  const binding = resultBindings.get(value)
  return binding === undefined ? undefined : copyStoredValue(binding)
}
export function retainSourceResult(value: unknown, binding: SourceBinding): void {
  if (typeof value !== 'object' || value === null) return
  resultBindings.set(value, copyStoredValue(binding))
  for (const field of ['ciphertext', 'payload', 'sealed'] as const) {
    const bytes = (value as Record<string, unknown>)[field]
    if (bytes instanceof Uint8Array) resultBindings.set(bytes, copyStoredValue(binding))
  }
}
const suites = new WeakMap<object, object>()
type EntryCrypto = Pick<GroupCrypto, 'exportSecret' | 'sealEntries' | 'openEntries'> & {
  assertAvailable(): void
}
const entryCrypto = new WeakMap<object, (configuration: CryptoConfiguration) => EntryCrypto>()

export function sourceCryptoScope(
  attempt: OwnerAttempt,
  assertCurrent: () => void,
): SourceCryptoScope {
  function assertLive(): void {
    attempt.assertLive()
    assertCurrent()
  }
  // Each primitive retains this operation's authority, including after a non-cancellable await.
  function guarded<T extends object>(target: T): T {
    return new Proxy(target, {
      get(object, property) {
        assertLive()
        const value: unknown = ownerAttemptCallback(attempt, () => Reflect.get(object, property))
        if (typeof value === 'function')
          return (...args: Array<unknown>) => {
            assertLive()
            const result: unknown = ownerAttemptCallback(attempt, () =>
              Reflect.apply(value, object, args),
            )
            if (result instanceof Promise)
              return result.then((value: unknown) => {
                assertLive()
                return value
              })
            assertLive()
            return result
          }
        return value !== null && typeof value === 'object' && !(value instanceof Uint8Array)
          ? guarded(value)
          : value
      },
    })
  }
  function protect(handle: GroupHandle): GroupHandle {
    assertLive()
    const current = handle.context.cipherSuite
    const original = suites.get(current) ?? current
    const suite = guarded(original) as typeof current
    suites.set(suite, original)
    handle.context.cipherSuite = suite
    return handle
  }
  return {
    assertLive,
    protect,
    onRevoke(fn) {
      assertLive()
      const revoke = () => ownerAttemptCallback(attempt, fn)
      attempt.signal.addEventListener('abort', revoke, { once: true })
      return () => attempt.signal.removeEventListener('abort', revoke)
    },
    call: (fn) => {
      assertLive()
      return ownerAttemptCallback(attempt, fn)
    },
  }
}
export function registerSourceCrypto(
  binding: object,
  key: GroupKey,
  bodies: SourceCryptoBodies,
): void {
  let groups = registrations.get(binding)
  if (groups === undefined) {
    groups = new Map()
    registrations.set(binding, groups)
  }
  groups.set(JSON.stringify([key.groupID, key.incarnation]), {
    key: { ...key },
    bodies,
  })
}
export function managedEntryCrypto(
  key: object,
  label: string,
  runtime: Runtime,
): EntryCrypto | undefined {
  return entryCrypto.get(key)?.({ label, runtime })
}

export function sourceCryptoAdapter<TTx extends GroupTransaction>(params: {
  key: GroupKey
  coordinator: object
  capability: EntryCapability<TTx>
  executor: SourceExecutor
  control: SourceExecutorControl
}) {
  let binding = currentSourceBinding(params.executor, params.key)
  async function execute<TName extends keyof CryptoCommands>(
    command: TName,
    input: CryptoCommands[TName]['input'],
    signal?: AbortSignal,
    configuration?: CryptoConfiguration,
  ) {
    params.capability.assertRoot()
    if (binding !== undefined) {
      try {
        assertCryptoBinding(params.executor, binding)
      } catch (error) {
        if (!(error instanceof SourceProjectionUnavailableError)) throw error
        // A metadata-only update refreshes the projection without changing the generation.
        binding = await params.control.admit(params.key, 'source')
      }
    } else binding = await params.control.admit(params.key, 'source')
    async function submit(origin: SourceBinding) {
      const request = { binding: origin, command, input, signal }
      if (configuration !== undefined) configurations.set(request, configuration)
      return (await params.executor.execute(request)).value
    }
    try {
      return await submit(binding)
    } catch (error) {
      if (!(error instanceof SourceProjectionUnavailableError)) throw error
      try {
        assertCryptoBinding(params.executor, binding)
      } catch (current) {
        if (!(current instanceof SourceProjectionUnavailableError)) throw current
        binding = await params.control.admit(params.key, 'source')
        return await submit(binding)
      }
      throw error
    }
  }
  function bind(key: object): void {
    const registration = registrations
      .get(params.coordinator)
      ?.get(JSON.stringify([params.key.groupID, params.key.incarnation]))
    if (registration === undefined)
      throw new GroupStateConflictError('Missing source crypto bodies')
    entryCrypto.set(key, (configuration) => ({
      assertAvailable,
      exportSecret: (label, length = 32) => {
        assertAvailable()
        if (label === configuration.label)
          throw new Error(`exportSecret: label '${label}' is reserved for the ledger-entry seal`)
        return execute('crypto.export', { label, length }, undefined, configuration)
      },
      sealEntries: (bytes) => execute('crypto.sealEntries', bytes, undefined, configuration),
      openEntries: (bytes) => execute('crypto.openEntries', bytes, undefined, configuration),
    }))
  }
  async function handoff(): Promise<void> {
    params.capability.assertRoot()
    if (binding === undefined) throw new GroupStateConflictError('Missing handoff binding')
    const origin = binding
    await params.capability.command(params.key.groupID, async (attempt) => {
      const scope = sourceCryptoScope(attempt, () => assertCryptoBinding(params.executor, origin))
      await runSourceCryptoCommand({
        coordinator: params.coordinator,
        binding: origin,
        command: 'app.handoff',
        input: undefined,
        scope,
      })
    })
  }
  function assertAvailable(): void {
    if (binding === undefined) throw new GroupStateConflictError('Missing source binding')
    try {
      assertCryptoBinding(params.executor, binding)
    } catch (error) {
      if (!(error instanceof SourceProjectionUnavailableError)) throw error
    }
  }
  return { execute, bind, handoff, assertAvailable }
}
export async function runSourceCryptoCommand<TName extends keyof CryptoCommands>(params: {
  coordinator: object
  binding: SourceBinding
  command: TName
  input: CryptoCommands[TName]['input']
  scope: SourceCryptoScope
  configuration?: CryptoConfiguration
}): Promise<CryptoCommands[TName]['output']> {
  const { scope, command } = params
  const configuration = params.configuration ?? {
    label: ENTRY_SEAL_LABEL,
    runtime: createRuntime(),
  }
  scope.assertLive()
  const registration = registrations
    .get(params.coordinator)
    ?.get(JSON.stringify([params.binding.key.groupID, params.binding.key.incarnation]))
  if (registration === undefined)
    throw new GroupStateConflictError('Source crypto is not registered')
  const input = copyStoredValue(params.input)
  let result: unknown
  if (command === 'app.handoff') {
    result = await registration.bodies.handoff(scope)
  } else if (command === 'app.seal') {
    result = await registration.bodies.seal(input as CryptoCommands['app.seal']['input'], scope)
  } else if (command === 'app.receive') {
    result = await registration.bodies.receive(input as Array<ReceiveInput>, scope)
  } else {
    if (command === 'crypto.openEntries') assertSealedEntryBlob(input as Uint8Array)
    const handle = scope.protect(await scope.call(() => registration.bodies.handle(scope)))
    scope.assertLive()
    if (command === 'crypto.export') {
      const { label, length } = input as CryptoCommands['crypto.export']['input']
      if (label === configuration.label)
        throw new Error(`exportSecret: label '${label}' is reserved for the ledger-entry seal`)
      result = {
        secret: await scope.call(() => handle.exportSecret(label, new Uint8Array(), length)),
        epoch: Number(handle.epoch),
      }
    } else {
      const key = await scope.call(() => deriveEntryKey(handle, configuration.label))
      try {
        scope.assertLive()
        result =
          command === 'crypto.sealEntries'
            ? {
                sealed: scope.call(() =>
                  sealEntries(key, input as Uint8Array, configuration.runtime),
                ),
                epoch: Number(handle.epoch),
              }
            : openEntries(key, input as Uint8Array)
      } finally {
        key.fill(0)
      }
    }
  }
  scope.assertLive()
  return result as CryptoCommands[TName]['output']
}
