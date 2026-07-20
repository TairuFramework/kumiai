/**
 * The hub hands a peer two kinds of position, both a bare `string`:
 *
 * - A **log position** is a place in a *topic's log*: `fetchTopic`'s `after`, `head`,
 *   `oldest`. Every reader of the topic sees the same log in the same order.
 * - A **delivery position** is a place in *this recipient's delivery queue*:
 *   `hub/v1/receive`'s `after` and `ack`. It runs across every subscribed topic, skips the
 *   recipient's own frames, and is emptied by acking.
 *
 * Different sequences, different frames, different orders. Crossing them silently mis-pages
 * (skipped or re-read commits) with no type error, since both are strings. Branded so a
 * delivery position cannot be assigned where a log position is expected, and minting either
 * requires saying which you mean.
 */

// Nominal brand keys: `declare const … : unique symbol` mints a fresh type-only tag with no runtime
// value — the declaration IS the definition, nothing to import. Each tags one string type below so
// the two cannot be assigned to each other.
declare const logPositionBrand: unique symbol
declare const deliveryPositionBrand: unique symbol

/** A position in a topic's log. Read it from a `fetchTopic` result or a log publish. */
export type LogPosition = string & { readonly [logPositionBrand]: true }

/** A position in a recipient's delivery queue. Read it from a pushed message. */
export type DeliveryPosition = string & { readonly [deliveryPositionBrand]: true }

/**
 * Name a sequenceID as a position in a topic's log. Legitimate sources: the entries,
 * `head` and `oldest` of a `fetchTopic` result, and the sequenceID a `retain: 'log'`
 * publish returns. A sequenceID from a *pushed* message is NOT one of them.
 */
export function asLogPosition(sequenceID: string): LogPosition {
  return sequenceID as LogPosition
}

/** Name a sequenceID as a position in this recipient's delivery queue (i.e. an ack). */
export function asDeliveryPosition(sequenceID: string): DeliveryPosition {
  return sequenceID as DeliveryPosition
}
