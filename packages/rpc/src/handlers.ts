import type { EventHandlerContext, ProcedureHandlers } from '@enkaku/server'
import {
  type BroadcastHandler,
  type BusEvents,
  type SuppressConfig,
  suppressible,
} from '@kumiai/broadcast'
import { toUTF } from '@sozai/codec'
import { EventEmitter } from '@sozai/event'
import { getReporter } from '@sozai/log'
import { createValidator, type Validator } from '@sozai/schema'

import type { GroupKey } from './control/types.js'
import type { AppFrameRef, PendingAppFrame } from './crypto.js'
import type { GroupTransaction, HandlerCompletion } from './handler-completion.js'
import type { GroupProtocolDefinition } from './protocol.js'

/** Log deliveries carry a stable frame ref; live ephemeral events have no frame.
 * A handler that never settles blocks later log events in its protocol. Disposal does not cancel
 * it; the host must settle its work or restart the peer to retry the pending record.
 */
export type GroupHandlerMetadata = {
  epoch: number
  incarnation: number
  frame?: AppFrameRef
  idempotencyKey?: string
}

export type DurableHandler<TContext, TTx extends GroupTransaction> =
  | {
      mode?: 'at-least-once'
      handle(
        context: TContext &
          GroupHandlerMetadata & {
            frame: AppFrameRef
            idempotencyKey: string
          },
      ): Promise<void>
    }
  | {
      mode: 'transactional'
      handle(
        context: TContext &
          GroupHandlerMetadata & {
            frame: AppFrameRef
            idempotencyKey: string
            tx: TTx
          },
      ): Promise<void>
    }

export type MetadataHandler<THandler> = THandler extends (context: infer TContext) => infer TResult
  ? (context: TContext & GroupHandlerMetadata) => TResult
  : never

export type GroupProcedureHandlers<
  TProtocol extends GroupProtocolDefinition,
  TTx extends GroupTransaction = GroupTransaction,
> = {
  [TProcedure in keyof TProtocol & string]: TProtocol[TProcedure] extends {
    type: 'event'
    retain: 'log'
  }
    ?
        | DurableHandler<EventHandlerContext<TProtocol, TProcedure>, TTx>
        | ((
            context: EventHandlerContext<TProtocol, TProcedure> & GroupHandlerMetadata,
          ) => void | Promise<void>)
    : MetadataHandler<ProcedureHandlers<TProtocol>[TProcedure]>
}

export type BusHandlerMaps = {
  /** Fire-and-forget event fan-out, keyed by procedure name. Host handlers are pre-registered. */
  events: EventEmitter<BusEvents>
  /** Anycast request procedures: prc -> handler(param, { senderDID, signal }) -> result. */
  requestHandlers: Record<string, BroadcastHandler>
}

/** `['kumiai', 'rpc']` — an app routing this category sees dropped-input diagnostics. */
const warnDropped = getReporter(['kumiai', 'rpc'], '@kumiai/rpc')

/** Minimal bus-path context message: authenticated sender at `payload.iss`. */
function busMessage(senderDID?: string): { payload: { iss?: string } } {
  return { payload: { iss: senderDID } }
}

type LooseContext = {
  data?: unknown
  param?: unknown
  signal?: AbortSignal
  message: { payload: { iss?: string } }
} & GroupHandlerMetadata
type LooseHandler = (context: LooseContext) => unknown

export function groupHandlerMetadata(
  transit: { epoch?: number },
  key: GroupKey,
): GroupHandlerMetadata {
  if (!Number.isSafeInteger(transit.epoch) || (transit.epoch as number) < 0)
    throw new TypeError('Handler requires authenticated epoch')
  return { epoch: transit.epoch as number, incarnation: key.incarnation }
}

function durablePolicy<TContext, TTx extends GroupTransaction>(
  handler: DurableHandler<TContext, TTx> | unknown,
): DurableHandler<TContext, TTx> {
  if (typeof handler === 'function')
    return { handle: handler as DurableHandler<TContext, TTx>['handle'] }
  if (
    handler === null ||
    typeof handler !== 'object' ||
    !('handle' in handler) ||
    typeof handler.handle !== 'function' ||
    ('mode' in handler &&
      handler.mode !== undefined &&
      handler.mode !== 'at-least-once' &&
      handler.mode !== 'transactional')
  )
    throw new TypeError('Invalid durable handler policy')
  return handler as DurableHandler<TContext, TTx>
}

export function validateBusHandlers(
  protocol: GroupProtocolDefinition,
  handlers: Record<string, unknown>,
): void {
  for (const [prc, definition] of Object.entries(protocol)) {
    const handler = handlers[prc]
    if (handler == null) continue
    if (definition.type === 'event' && definition.retain === 'log') durablePolicy(handler)
    else if (typeof handler !== 'function')
      throw new TypeError(`Ephemeral handler must be a function: ${prc}`)
  }
}

export function combineDurableHandlers<TContext, TTx extends GroupTransaction>(
  handlers: [DurableHandler<TContext, TTx>, ...Array<DurableHandler<TContext, TTx>>],
): DurableHandler<TContext, TTx> {
  if (handlers.length === 0) throw new TypeError('Durable listeners must be nonempty')
  const listeners = handlers.map((handler) => durablePolicy<TContext, TTx>(handler))
  const mode = listeners[0]?.mode ?? 'at-least-once'
  if (listeners.some((handler) => (handler.mode ?? 'at-least-once') !== mode))
    throw new TypeError('Mixed durable listener policies')
  return {
    mode,
    async handle(
      context: TContext &
        GroupHandlerMetadata & { frame: AppFrameRef; idempotencyKey: string; tx?: TTx },
    ) {
      for (const listener of listeners) await listener.handle(context as never)
    },
  }
}

/**
 * Adapt native `@enkaku/server` handlers into a bus event emitter + request handler map.
 * `event` procedures become listeners on the returned `EventEmitter`; `request` procedures
 * become anycast request handlers (wrapped `suppressible`). Input is validated against the
 * protocol's declared schemas before a host handler is called: an invalid request rejects
 * (surfacing as an error reply, which does not suppress healthy responders), an invalid event
 * is dropped and logged. The authenticated sender is exposed at `ctx.message.payload.iss` and
 * the responder-supplied cancellation signal at `ctx.signal`.
 */
export function adaptBusHandlers<
  TProtocol extends GroupProtocolDefinition,
  TTx extends GroupTransaction,
>(
  protocol: TProtocol,
  handlers: GroupProcedureHandlers<TProtocol, TTx>,
  options: { completion: HandlerCompletion<TTx>; suppress?: SuppressConfig },
): BusHandlerMaps {
  const { suppress = {}, completion } = options
  validateBusHandlers(protocol, handlers)
  const policies = new Map<string, DurableHandler<LooseContext, TTx>>()
  for (const [prc, definition] of Object.entries(protocol)) {
    const handler = handlers[prc]
    if (handler != null && definition.type === 'event' && definition.retain === 'log')
      policies.set(prc, durablePolicy(handler))
  }
  const events = new EventEmitter<BusEvents>()
  const requestHandlers: BusHandlerMaps['requestHandlers'] = {}

  for (const [prc, definition] of Object.entries(protocol)) {
    const handler = handlers[prc] as LooseHandler | undefined
    if (handler == null) continue
    if (definition.type === 'event') {
      const validator: Validator<unknown> | undefined =
        definition.data != null ? createValidator(definition.data as never) : undefined
      const policy = policies.get(prc)
      const invoke = async (
        event: {
          data: unknown
          senderDID?: string
          epoch?: number
          frame?: AppFrameRef
          idempotencyKey?: string
        },
        tx?: TTx,
      ) => {
        const metadata = groupHandlerMetadata(event, completion.key)
        if (validator != null) {
          const result = validator(event.data)
          if (result instanceof Error) {
            warnDropped(`Dropped invalid event "${prc}": ${result.message}`)
            return
          }
        }
        const context = { data: event.data, message: busMessage(event.senderDID), ...metadata }
        if (policy === undefined) {
          await handler(context)
          return
        }
        await policy.handle({
          ...context,
          frame: { ...(event.frame as AppFrameRef) },
          idempotencyKey: event.idempotencyKey as string,
          ...(tx === undefined ? {} : { tx }),
        } as never)
      }
      events.on(prc, async (input) => {
        const event = input as typeof input & Partial<PendingAppFrame>
        if (policy === undefined) {
          await invoke(event)
          return
        }
        // A frame-less bus event cannot invoke a retained policy.
        if (event.frame === undefined) return
        if (
          event.frame.groupID !== completion.key.groupID ||
          event.frame.incarnation !== completion.key.incarnation ||
          event.frame.procedure !== prc ||
          typeof event.idempotencyKey !== 'string'
        )
          throw new TypeError('Durable handler binding mismatch')
        const id = event.frame.id
        if (policy.mode === 'transactional') {
          await completion.transact([id], async (tx, records) => {
            for (const saved of records) {
              if (
                saved.frame.id !== id ||
                saved.frame.groupID !== completion.key.groupID ||
                saved.frame.incarnation !== completion.key.incarnation ||
                saved.frame.procedure !== prc ||
                saved.frame.protocol !== event.frame?.protocol
              )
                throw new TypeError('Saved handler binding mismatch')
              const message = JSON.parse(toUTF(saved.payload)) as {
                payload?: { typ?: string; prc?: string; data?: unknown }
              }
              if (message.payload?.typ !== 'event' || message.payload.prc !== prc)
                throw new TypeError('Saved handler procedure mismatch')
              await invoke({ ...saved, data: message.payload.data ?? {} }, tx)
            }
          })
        } else {
          await invoke(event)
          await completion.complete([id])
        }
      })
    } else if (definition.type === 'request') {
      const validator: Validator<unknown> | undefined =
        definition.param != null ? createValidator(definition.param as never) : undefined
      const fn: BroadcastHandler = async (param, context) => {
        const metadata = groupHandlerMetadata((context ?? {}) as { epoch?: number }, completion.key)
        if (validator != null) {
          const result = validator(param)
          if (result instanceof Error) throw result
        }
        return handler({
          param,
          ...(context?.signal != null ? { signal: context.signal } : {}),
          message: busMessage(context?.senderDID),
          ...metadata,
        })
      }
      requestHandlers[prc] = Object.keys(suppress).length > 0 ? suppressible(fn, suppress) : fn
    }
  }
  const on = events.on.bind(events)
  events.on = (name, listener, options) => {
    if (protocol[name]?.type === 'event' && protocol[name]?.retain === 'log')
      throw new TypeError('Retained listeners require an explicit durable policy')
    return on(name, listener, options)
  }
  return { events, requestHandlers }
}
