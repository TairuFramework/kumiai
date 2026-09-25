import type { EventProcedureDefinition, ProtocolDefinition } from '@enkaku/protocol'
import type { EventHandlerContext, ProcedureHandlers } from '@enkaku/server'
import {
  type BroadcastHandler,
  type BusEvents,
  type SuppressConfig,
  suppressible,
} from '@kumiai/broadcast'
import { EventEmitter } from '@sozai/event'
import { getReporter } from '@sozai/log'
import { createValidator, type Validator } from '@sozai/schema'

import type { AppFrameRef } from './crypto.js'

/** Log deliveries carry a stable frame ref; live ephemeral events have no frame.
 * A handler that never settles blocks later log events in its protocol. Disposal does not cancel
 * it; the host must settle its work or restart the peer to retry the pending record.
 */
export type GroupProcedureHandlers<Protocol extends ProtocolDefinition> = {
  [Procedure in keyof Protocol & string]: Protocol[Procedure] extends EventProcedureDefinition
    ? (
        context: EventHandlerContext<Protocol, Procedure> & { frame?: AppFrameRef },
      ) => void | Promise<void>
    : ProcedureHandlers<Protocol>[Procedure]
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

type LooseHandler = (context: {
  data?: unknown
  param?: unknown
  signal?: AbortSignal
  message: { payload: { iss?: string } }
  frame?: AppFrameRef
}) => unknown

/**
 * Adapt native `@enkaku/server` handlers into a bus event emitter + request handler map.
 * `event` procedures become listeners on the returned `EventEmitter`; `request` procedures
 * become anycast request handlers (wrapped `suppressible`). Input is validated against the
 * protocol's declared schemas before a host handler is called: an invalid request rejects
 * (surfacing as an error reply, which does not suppress healthy responders), an invalid event
 * is dropped and logged. The authenticated sender is exposed at `ctx.message.payload.iss` and
 * the responder-supplied cancellation signal at `ctx.signal`.
 */
export function adaptBusHandlers(
  protocol: ProtocolDefinition,
  handlers: Record<string, unknown>,
  suppress: SuppressConfig = {},
): BusHandlerMaps {
  const events = new EventEmitter<BusEvents>()
  const requestHandlers: BusHandlerMaps['requestHandlers'] = {}

  for (const [prc, definition] of Object.entries(protocol)) {
    const handler = handlers[prc] as LooseHandler | undefined
    if (handler == null) continue

    if (definition.type === 'event') {
      const validator: Validator<unknown> | undefined =
        definition.data != null ? createValidator(definition.data as never) : undefined
      events.on(prc, (event) => {
        const { data, senderDID, frame } = event as typeof event & { frame?: AppFrameRef }
        if (validator != null) {
          const result = validator(data)
          if (result instanceof Error) {
            warnDropped(`Dropped invalid event "${prc}": ${result.message}`)
            return
          }
        }
        return handler({
          data,
          message: busMessage(senderDID),
          ...(frame == null ? {} : { frame }),
        }) as void | Promise<void>
      })
    } else if (definition.type === 'request') {
      const validator: Validator<unknown> | undefined =
        definition.param != null ? createValidator(definition.param as never) : undefined
      // async: a validation failure must reach the caller as a REJECTED promise (the shape
      // `createBroadcastResponder`'s handleRequest awaits), not a synchronous throw escaping the
      // call expression before any promise exists.
      const fn: BroadcastHandler = async (param, context) => {
        if (validator != null) {
          const result = validator(param)
          if (result instanceof Error) throw result
        }
        return handler({
          param,
          ...(context?.signal != null ? { signal: context.signal } : {}),
          message: busMessage(context?.senderDID),
        })
      }
      requestHandlers[prc] = Object.keys(suppress).length > 0 ? suppressible(fn, suppress) : fn
    }
  }

  return { events, requestHandlers }
}
