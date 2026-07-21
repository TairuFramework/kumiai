import type {
  ChannelProcedureDefinition,
  EventProcedureDefinition,
  RequestProcedureDefinition,
  StreamProcedureDefinition,
} from '@enkaku/protocol'

/**
 * Retention class of an app procedure's dispatched frames. `log` is retained by the hub and
 * pullable to a cursor (drained on a member's return); `ephemeral` is live push, mailbox-class,
 * dropped if no subscriber is listening.
 */
export type Retention = 'log' | 'ephemeral'

/**
 * An event procedure that may opt into log retention. `retain: 'log'` makes every dispatch of
 * the procedure retained and pullable regardless of call site; absent, dispatches are ephemeral.
 */
export type RetainableEventProcedureDefinition = EventProcedureDefinition & { retain?: 'log' }

/**
 * A single procedure of a group protocol. Only `event` procedures may carry `retain`.
 */
export type GroupProcedureDefinition =
  | RetainableEventProcedureDefinition
  | RequestProcedureDefinition
  | StreamProcedureDefinition
  | ChannelProcedureDefinition

/**
 * A protocol run over a group broadcast substrate, where only `event` procedures may declare
 * `retain: 'log'`. Correlation traffic (`request`/`stream`/`channel`) is always ephemeral:
 * retaining it is unsafe — a re-pulled request re-fires its responder, and the rid/timeout/quorum
 * a reply correlates against is dead by the time a returning member drains it. Structurally a
 * superset of the underlying Enkaku protocol definition for everything else.
 */
export type GroupProtocolDefinition = Record<string, GroupProcedureDefinition>

/**
 * Per-entry retention rule used as a constraint: an `event` procedure is unconstrained (retain
 * allowed); every other procedure must carry no `retain` (`retain?: never`), so a `retain` on a
 * request/stream/channel fails the constraint and the definition is rejected at the type level.
 */
type RetainRule<Procedure> = Procedure extends { type: 'event' } ? unknown : { retain?: never }

/**
 * Identity helper that returns the protocol definition unchanged while preserving its literal
 * type for downstream inference — extended over the underlying broadcast helper so an `event`
 * procedure may declare `retain: 'log'`. Declaring `retain` on a non-`event` procedure is a type
 * error (the `RetainRule` constraint) AND throws here at definition time, so a JS caller or an
 * erased type cannot slip a retained request/stream/channel past the guardrail.
 */
export function defineGroupProtocol<
  const Definition extends GroupProtocolDefinition & {
    [Name in keyof Definition]: RetainRule<Definition[Name]>
  },
>(definition: Definition): Definition {
  for (const [name, procedure] of Object.entries(definition)) {
    const proc = procedure as { type?: unknown; retain?: unknown }
    if (proc.retain !== undefined && proc.type !== 'event') {
      throw new Error(
        `defineGroupProtocol: procedure "${name}" has type "${String(proc.type)}" and declares retain; only 'event' procedures may be retained, request/stream/channel traffic is always ephemeral`,
      )
    }
  }
  return definition
}

/**
 * The retention a procedure was declared with in its group protocol definition. `'log'` only for
 * an `event` procedure carrying `retain: 'log'`; `'ephemeral'` for everything else (the default).
 */
export function retentionOf(protocol: GroupProtocolDefinition, procedureName: string): Retention {
  const procedure = protocol[procedureName] as { type?: unknown; retain?: unknown } | undefined
  return procedure?.type === 'event' && procedure.retain === 'log' ? 'log' : 'ephemeral'
}
