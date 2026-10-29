import type { ProtocolDefinition } from '@enkaku/protocol'
import { normalizeDID } from '@kokuin/token'
import type { SuppressConfig } from '@kumiai/broadcast'
import { toUTF } from '@sozai/codec'

import type { GroupKey } from './control/types.js'
import type { PendingAppFrame, PendingAppFrames } from './crypto.js'
import type { GroupTransaction, HandlerCompletion } from './handler-completion.js'
import { adaptBusHandlers, type BusHandlerMaps, type GroupProcedureHandlers } from './handlers.js'
import type { GroupProtocolDefinition } from './protocol.js'
import { retentionOf } from './protocol.js'

/** The host propagates delivery tokens across awaits, independently of ownership tokens. */
export type OpenedDeliveryContext = {
  run<T>(token: object, fn: () => T): T
  get(): object | undefined
}

export class OpenedDeliveryReentryError extends Error {
  constructor(key: GroupKey) {
    super(`Opened delivery cannot join ${key.groupID}/${key.incarnation}`)
    this.name = 'OpenedDeliveryReentryError'
  }
}

type DeliveryScope = { owner?: object; key: GroupKey }
const calls = new WeakMap<object, DeliveryScope>()

export function assertOpenedDeliveryEntry(
  context: OpenedDeliveryContext | undefined,
  scope: Partial<DeliveryScope> = {},
): void {
  const token = context?.get()
  const call = token === undefined ? undefined : calls.get(token)
  if (call === undefined) return
  if (
    (scope.owner !== undefined && scope.owner === call.owner) ||
    (scope.key !== undefined && scope.key.groupID === call.key?.groupID) ||
    (scope.owner === undefined && scope.key === undefined)
  )
    throw new OpenedDeliveryReentryError(call.key)
}

export async function runOpenedDelivery<T>(
  context: OpenedDeliveryContext,
  scope: DeliveryScope,
  fn: () => Promise<T>,
): Promise<T> {
  const token = {}
  calls.set(token, scope)
  try {
    return await context.run(token, fn)
  } finally {
    calls.delete(token)
  }
}

export function requireOpenedDeliveryContext(
  context: OpenedDeliveryContext | undefined,
): OpenedDeliveryContext {
  if (context == null || typeof context.run !== 'function' || typeof context.get !== 'function')
    throw new TypeError('Durable handlers require openedDeliveryContext')
  return context
}

/** A registry-bound pending facade hands admitted completion to its exact storage key. */
export type OpenedDeliveryBinding = {
  key: GroupKey
  failureSignal?: AbortSignal
  list(): Promise<Array<PendingAppFrame>>
  complete(id: string): Promise<void>
  claim(record: PendingAppFrame, fn: () => Promise<void>): Promise<boolean>
  attach(
    context: OpenedDeliveryContext,
    source: {
      handoff(): Promise<void>
      completed(id: string): Promise<void>
      /** Withdraw fallback admission independently of in-flight completion tracking. */
      canDeliver?(): boolean
      deliver(record: PendingAppFrame): Promise<void>
    },
  ): () => void
}
const bindings = new WeakMap<PendingAppFrames, OpenedDeliveryBinding>()
export function bindOpenedDelivery(
  pending: PendingAppFrames,
  binding: OpenedDeliveryBinding,
): void {
  bindings.set(pending, binding)
}
export function openedDeliveryBinding(
  pending: PendingAppFrames | undefined,
): OpenedDeliveryBinding | undefined {
  return pending === undefined ? undefined : bindings.get(pending)
}

export function createOpenedRecordHandler(params: {
  localDID: string
  protocols: Record<string, ProtocolDefinition>
  events: Map<string, BusHandlerMaps['events']>
  handlers?: Record<string, Record<string, unknown>>
}): (record: PendingAppFrame) => Promise<void> {
  const localDID = normalizeDID(params.localDID)
  return async (record) => {
    const protocol = params.protocols[record.frame.protocol]
    if (protocol == null || !Object.hasOwn(params.protocols, record.frame.protocol))
      throw new Error(`Unknown opened protocol: ${record.frame.protocol}`)
    let message: { payload?: { typ?: string; prc?: unknown; data?: unknown } } | undefined
    try {
      message = JSON.parse(toUTF(record.payload))
    } catch {
      return
    }
    const prc = message?.payload?.prc
    if (message?.payload?.typ !== 'event' || typeof prc !== 'string') return
    if (!Object.hasOwn(protocol, prc)) throw new Error(`Unknown opened procedure: ${prc}`)
    if (normalizeDID(record.senderDID) === localDID || retentionOf(protocol, prc) !== 'log') return
    if (
      params.handlers !== undefined &&
      typeof params.handlers[record.frame.protocol]?.[prc] !== 'function'
    )
      throw new Error(`Missing opened handler: ${prc}`)
    const events = params.events.get(record.frame.protocol)
    if (events == null) return
    const event = {
      data: message.payload.data ?? {},
      senderDID: normalizeDID(record.senderDID),
      frame: { ...record.frame },
    }
    await events.emit(prc, event)
  }
}

export function createOpenedAppHandler<
  P extends Record<string, GroupProtocolDefinition>,
  TTx extends GroupTransaction,
>(params: {
  localDID: string
  protocols: P
  handlers: { [K in keyof P]: GroupProcedureHandlers<P[K], TTx> }
  completion: HandlerCompletion<TTx>
  suppress?: SuppressConfig
}): (record: PendingAppFrame) => Promise<void> {
  const events = new Map<string, BusHandlerMaps['events']>()
  for (const [name, protocol] of Object.entries(params.protocols))
    events.set(
      name,
      adaptBusHandlers<GroupProtocolDefinition, TTx>(protocol, params.handlers[name] as never, {
        completion: params.completion,
        suppress: params.suppress,
      }).events,
    )
  return createOpenedRecordHandler({ ...params, events })
}
