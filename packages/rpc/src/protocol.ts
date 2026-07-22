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
 * An event procedure, the only kind that may choose. `retain: 'log'` makes every dispatch of the
 * procedure retained and pullable regardless of call site; `'ephemeral'` and absence both mean
 * live push, and are the same declaration said two ways — one for a definition that prefers to
 * state its choice, one for a definition that leaves it to the default.
 */
export type RetainableEventProcedureDefinition = EventProcedureDefinition & { retain?: Retention }

/**
 * Correlation traffic, which has exactly one retention available to it and so is typed with the
 * literal rather than the union. Writing `retain: 'ephemeral'` on one of these says what was
 * already true; `'log'` is not a value it has, so the mistake is a type error at the procedure
 * rather than a rule applied to it afterwards.
 */
export type EphemeralProcedureDefinition = (
  | RequestProcedureDefinition
  | StreamProcedureDefinition
  | ChannelProcedureDefinition
) & { retain?: 'ephemeral' }

/**
 * A single procedure of a group protocol. Only `event` procedures may declare `retain: 'log'`,
 * and the `type` discriminant is what enforces it: each member carries the retention it is
 * allowed, so a retained request fails to match any member of the union.
 */
export type GroupProcedureDefinition =
  | RetainableEventProcedureDefinition
  | EphemeralProcedureDefinition

/**
 * A protocol run over a group broadcast substrate, where only `event` procedures may declare
 * `retain: 'log'`. Correlation traffic (`request`/`stream`/`channel`) is always ephemeral:
 * retaining it is unsafe — a re-pulled request re-fires its responder, and the rid/timeout/quorum
 * a reply correlates against is dead by the time a returning member drains it. Structurally a
 * superset of the underlying Enkaku protocol definition for everything else.
 */
export type GroupProtocolDefinition = Record<string, GroupProcedureDefinition>

/**
 * Identity helper that returns the protocol definition unchanged while preserving its literal
 * type for downstream inference.
 *
 * The retention guardrail lives in {@link GroupProcedureDefinition}, not here: each member of that
 * union carries the retention its kind is allowed, so a retained request matches no member and is
 * refused by the constraint itself. An earlier shape enforced it with a mapped type over the
 * parameter, and that mapped type referenced the type parameter it was constraining — read while
 * inference was still running, so every procedure was treated as a non-event and every retain-free
 * `request` was rejected. Nothing caught it: the only request in the suite carried a
 * `@ts-expect-error` aimed at `retain`, which absorbed the error meant for `type`. Prefer a
 * constraint the discriminant can enforce over a rule applied on top of one.
 *
 * The throw survives for the caller who never met the type — plain JS, or types erased across a
 * boundary. It fires only on `retain: 'log'`, since `'ephemeral'` is legal on every kind.
 */
export function defineGroupProtocol<const Definition extends GroupProtocolDefinition>(
  definition: Definition,
): Definition {
  for (const [name, procedure] of Object.entries(definition)) {
    const proc = procedure as { type?: unknown; retain?: unknown }
    if (proc.retain === 'log' && proc.type !== 'event') {
      throw new Error(
        `defineGroupProtocol: procedure "${name}" has type "${String(proc.type)}" and declares retain: 'log'; only 'event' procedures may be retained, request/stream/channel traffic is always ephemeral`,
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
