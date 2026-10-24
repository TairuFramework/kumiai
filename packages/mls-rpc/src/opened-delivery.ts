import {
  assertOpenedDeliveryEntry,
  bindOpenedDelivery,
  type OpenedDeliveryBinding,
  type OpenedDeliveryContext,
  requireOpenedDeliveryContext,
  runOpenedDelivery,
  sortPendingAppFrames,
} from '@kumiai/rpc'

import { coordinatorBinding, type EntryCapability, entryCapability } from './entry-capability.js'
import { copyStoredValue } from './memory-incarnation-stores.js'
import { GroupStateConflictError } from './persistence-errors.js'
import type {
  GroupKey,
  GroupPersistence,
  GroupTransaction,
  PendingAppFrame,
  PendingAppFrames,
} from './persistence-types.js'

type DeliveryState = {
  key: GroupKey
  lanes: Map<string, Promise<unknown>>
  sources: Set<Parameters<OpenedDeliveryBinding['attach']>[1]>
  context?: OpenedDeliveryContext
  drain?: Promise<void>
}
const registryContexts = new WeakMap<object, OpenedDeliveryContext>()
export function bindRegistryOpenedContext(
  registry: object,
  context: OpenedDeliveryContext | undefined,
): void {
  if (context !== undefined) registryContexts.set(registry, requireOpenedDeliveryContext(context))
}
export function registryOpenedDeliveryContext(registry: object): OpenedDeliveryContext | undefined {
  return registryContexts.get(registry)
}
export function storedOpenedDeliveryContext(
  binding: object,
  key: GroupKey,
): OpenedDeliveryContext | undefined {
  return coordinators.get(binding)?.get(JSON.stringify([key.groupID, key.incarnation]))?.context
}
export function assertStoredOpenedEntry(binding: object, key?: GroupKey): void {
  for (const state of coordinators.get(binding)?.values() ?? [])
    assertOpenedDeliveryEntry(state.context, { key: key ?? state.key })
}
const coordinators = new WeakMap<object, Map<string, DeliveryState>>()
function deliveryState(binding: object, key: GroupKey): DeliveryState {
  let groups = coordinators.get(binding)
  if (groups === undefined) {
    groups = new Map()
    coordinators.set(binding, groups)
  }
  const id = JSON.stringify([key.groupID, key.incarnation])
  let state = groups.get(id)
  if (state === undefined) {
    state = { key: { ...key }, lanes: new Map(), sources: new Set() }
    groups.set(id, state)
  }
  return state
}
function bindContext(state: DeliveryState, context: OpenedDeliveryContext): void {
  requireOpenedDeliveryContext(context)
  if (state.context !== undefined && state.context !== context)
    throw new TypeError('Opened delivery requires the shared coordinator context')
  state.context = context
}
async function serial<T>(state: DeliveryState, protocol: string, fn: () => Promise<T>): Promise<T> {
  const previous = state.lanes.get(protocol) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(fn)
  state.lanes.set(protocol, next)
  try {
    return await next
  } finally {
    if (state.lanes.get(protocol) === next) state.lanes.delete(protocol)
  }
}
function assertHealthy(capability: EntryCapability<GroupTransaction>): void {
  if (capability.failureSignal?.aborted) throw capability.failureSignal.reason
}
async function pauseOpenedRetry(delay: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw signal.reason
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, delay)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
class Completed extends Error {}
async function completeStoredOpened<TTx extends GroupTransaction>(
  capability: EntryCapability<TTx>,
  key: GroupKey,
  id: string,
): Promise<void> {
  try {
    await capability.run(
      { groupID: key.groupID, mutationID: crypto.randomUUID() },
      async (reads) => {
        if ((await reads.appFrame(key.incarnation, id)).pending === null) throw new Completed()
        return { expected: await reads.lifetime(), value: undefined }
      },
      async (stores) => {
        const pending = stores.incarnation(key.incarnation).pending
        if ((await pending.list()).some((record) => record.frame.id === id))
          await pending.complete([id])
      },
    )
  } catch (error) {
    if (!(error instanceof Completed)) throw error
  }
}

export function bindRegistryOpenedDelivery<TTx extends GroupTransaction>(params: {
  binding: object
  capability: EntryCapability<TTx>
  key: GroupKey
  pending: PendingAppFrames
}): void {
  const key = { ...params.key }
  const { capability } = params
  const state = deliveryState(params.binding, key)
  const binding: OpenedDeliveryBinding = {
    key,
    failureSignal: capability.failureSignal,
    list: () => capability.read(key.groupID, (reads) => reads.pendingFrames(key.incarnation)),
    complete: (id) => completeStoredOpened(capability, key, id),
    async claim(record, fn) {
      return await serial(state, record.frame.protocol, async () => {
        const saved = await capability.read(key.groupID, (reads) =>
          reads.appFrame(key.incarnation, record.frame.id),
        )
        if (saved.pending === null) return false
        await fn()
        return true
      })
    },
    attach(context, source) {
      bindContext(state, context)
      state.sources.add(source)
      return () => state.sources.delete(source)
    },
  }
  bindOpenedDelivery(params.pending, binding)
}

export function handoffStoredOpened(binding: object, key: GroupKey): Promise<void> {
  const state = deliveryState(binding, key)
  return Promise.all([...state.sources].map((source) => source.handoff())).then(() => {})
}

export async function drainStoredOpened<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>
  key: GroupKey
  deliver(record: PendingAppFrame): Promise<void>
  openedDeliveryContext: OpenedDeliveryContext
}): Promise<void> {
  assertOpenedDeliveryEntry(params.openedDeliveryContext, { key: params.key })
  await joinStoredOpened(params)
}

export async function joinStoredOpened<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>
  key: GroupKey
  deliver(record: PendingAppFrame): Promise<void>
  openedDeliveryContext: OpenedDeliveryContext
}): Promise<void> {
  const key = { ...params.key }
  const context = requireOpenedDeliveryContext(params.openedDeliveryContext)
  const capability = entryCapability(params.persistence)
  const binding = coordinatorBinding(params.persistence)
  if (capability === null || binding === null)
    throw new GroupStateConflictError('Opened delivery requires registered entry capability')
  capability.assertRoot()
  const state = deliveryState(binding, key)
  bindContext(state, context)
  if (state.drain !== undefined) return await state.drain
  const run = async () => {
    await Promise.all([...state.sources].map((source) => source.handoff()))
    const records = await capability.read(key.groupID, (reads) =>
      reads.pendingFrames(key.incarnation),
    )
    // A live claim can still be saving its cursor after removing its pending row.
    const protocols = new Set([
      ...records.map((record) => record.frame.protocol),
      ...state.lanes.keys(),
    ])
    await Promise.all(
      [...protocols].map(async (protocol) => {
        let delay = 100
        for (;;) {
          assertHealthy(capability)
          try {
            const delivered = await serial(state, protocol, async () => {
              const pending = await capability.read(key.groupID, (reads) =>
                reads.pendingFrames(key.incarnation),
              )
              const record = sortPendingAppFrames(pending).find(
                (record) => record.frame.protocol === protocol,
              )
              if (record === undefined) return false
              await runOpenedDelivery(context, { key }, () =>
                params.deliver(copyStoredValue(record)),
              )
              let completionDelay = 100
              for (;;) {
                assertHealthy(capability)
                try {
                  await completeStoredOpened(capability, key, record.frame.id)
                  await Promise.all(
                    [...state.sources].map((source) => source.completed(record.frame.id)),
                  )
                  break
                } catch {
                  assertHealthy(capability)
                  await pauseOpenedRetry(completionDelay, capability.failureSignal)
                  completionDelay = Math.min(completionDelay * 2, 15000)
                }
              }
              return true
            })
            if (!delivered) return
            delay = 100
          } catch {
            assertHealthy(capability)
            await pauseOpenedRetry(delay, capability.failureSignal)
            delay = Math.min(delay * 2, 15000)
          }
        }
      }),
    )
  }
  state.drain = run()
  try {
    await state.drain
  } finally {
    state.drain = undefined
  }
}
