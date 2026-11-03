import type { ProtocolDefinition } from '@enkaku/protocol'
import { normalizeDID } from '@kokuin/token'
import type { SuppressConfig } from '@kumiai/broadcast'
import { toUTF } from '@sozai/codec'

import type { GroupKey } from './control/types.js'
import type { PendingAppFrame, PendingAppFrames } from './crypto.js'
import type { GroupTransaction, HandlerCompletion } from './handler-completion.js'
import {
  adaptBusHandlers,
  type BusHandlerMaps,
  type GroupProcedureHandlers,
  groupHandlerMetadata,
  validateBusHandlers,
} from './handlers.js'
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
    } & (
      | { handler: OpenedAppHandler<GroupTransaction>; deliver?: never }
      | { handler?: never; deliver(record: PendingAppFrame): Promise<void> }
    ),
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
  ignored?(record: PendingAppFrame): Promise<void>
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
      return params.ignored?.(record)
    }
    const prc = message?.payload?.prc
    if (message?.payload?.typ !== 'event' || typeof prc !== 'string')
      return params.ignored?.(record)
    if (!Object.hasOwn(protocol, prc)) throw new Error(`Unknown opened procedure: ${prc}`)
    if (prc !== record.frame.procedure) throw new TypeError('Opened procedure binding mismatch')
    if (normalizeDID(record.senderDID) === localDID || retentionOf(protocol, prc) !== 'log')
      return params.ignored?.(record)
    if (
      params.handlers !== undefined &&
      (!Object.hasOwn(params.handlers, record.frame.protocol) ||
        !Object.hasOwn(params.handlers[record.frame.protocol] ?? {}, prc) ||
        params.handlers[record.frame.protocol]?.[prc] == null)
    )
      throw new Error(`Missing opened handler: ${prc}`)
    const events = params.events.get(record.frame.protocol)
    if (events == null) return
    const event = {
      data: message.payload.data ?? {},
      senderDID: normalizeDID(record.senderDID),
      frame: { ...record.frame },
      epoch: record.epoch,
      idempotencyKey: record.idempotencyKey,
    }
    await events.emit(prc, event)
  }
}

export type OpenedAppHandler<TTx extends GroupTransaction> = {
  completion: HandlerCompletion<TTx>
  openedDeliveryContext: OpenedDeliveryContext
  deliver(record: PendingAppFrame): Promise<void>
}

function copyOpenedRecord(record: PendingAppFrame): PendingAppFrame {
  return { ...record, frame: { ...record.frame }, payload: record.payload.slice() }
}

function assertRecordKey(record: PendingAppFrame, key: GroupKey): void {
  groupHandlerMetadata(record, key)
  if (typeof record.idempotencyKey !== 'string')
    throw new TypeError('Opened handler requires idempotency key')
  if (record.frame.groupID !== key.groupID || record.frame.incarnation !== key.incarnation)
    throw new TypeError('Opened handler key mismatch')
}

export function normaliseOpenedAppHandler<TTx extends GroupTransaction>(params: {
  deliver: OpenedAppHandler<TTx> | ((record: PendingAppFrame) => Promise<void>)
  completion: HandlerCompletion<TTx>
  openedDeliveryContext: OpenedDeliveryContext
  owner?: object
}): OpenedAppHandler<TTx> {
  const { completion, owner } = params
  const openedDeliveryContext = requireOpenedDeliveryContext(params.openedDeliveryContext)
  const deliver = params.deliver
  if (typeof deliver !== 'function') {
    if (
      deliver == null ||
      typeof deliver.deliver !== 'function' ||
      deliver.completion !== completion ||
      deliver.openedDeliveryContext !== openedDeliveryContext ||
      deliver.completion.key.groupID !== completion.key.groupID ||
      deliver.completion.key.incarnation !== completion.key.incarnation
    )
      throw new TypeError('Opened handler binding mismatch')
    return deliver
  }
  return {
    completion,
    openedDeliveryContext,
    async deliver(record) {
      assertRecordKey(record, completion.key)
      const id = record.frame.id
      await runOpenedDelivery(openedDeliveryContext, { owner, key: completion.key }, () =>
        deliver(copyOpenedRecord(record)),
      )
      await completion.complete([id])
    },
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
  openedDeliveryContext: OpenedDeliveryContext
  owner?: object
  suppress?: SuppressConfig
}): OpenedAppHandler<TTx> {
  const { completion, owner } = params
  const openedDeliveryContext = requireOpenedDeliveryContext(params.openedDeliveryContext)
  const events = new Map<string, BusHandlerMaps['events']>()
  const inputHandlers = params.handlers as Record<string, Record<string, unknown>>
  for (const [name, protocol] of Object.entries(params.protocols))
    validateBusHandlers(protocol, inputHandlers[name] ?? {})
  for (const [name, protocol] of Object.entries(params.protocols)) {
    const handlers: Record<string, unknown> = {}
    for (const [prc, handler] of Object.entries(inputHandlers[name] ?? {})) {
      const invoke = (context: never) =>
        runOpenedDelivery(openedDeliveryContext, { owner, key: completion.key }, async () => {
          if (typeof handler === 'function') await handler(context)
          else await (handler as { handle(context: never): Promise<void> }).handle(context)
        })
      handlers[prc] =
        typeof handler === 'function'
          ? invoke
          : { mode: (handler as { mode?: unknown }).mode, handle: invoke }
    }
    events.set(
      name,
      adaptBusHandlers<GroupProtocolDefinition, TTx>(protocol, handlers as never, {
        completion,
        suppress: params.suppress,
      }).events,
    )
  }
  const deliver = createOpenedRecordHandler({
    ...params,
    events,
    ignored: (record) => completion.complete([record.frame.id]),
  })
  return {
    completion,
    openedDeliveryContext,
    async deliver(record) {
      assertRecordKey(record, completion.key)
      const protocol = params.protocols[record.frame.protocol]
      if (
        protocol !== undefined &&
        Object.hasOwn(protocol, record.frame.procedure) &&
        retentionOf(protocol, record.frame.procedure) !== 'log'
      )
        throw new TypeError('Opened handler requires retained procedure')
      await deliver(copyOpenedRecord(record))
    },
  }
}
