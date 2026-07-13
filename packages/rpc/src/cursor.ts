/**
 * The hub hands a peer two kinds of position, and both are a bare `string`.
 *
 * - A **log position** is a place in a *topic's log*: the domain of `fetchTopic`'s
 *   `after`, `head` and `oldest`. Every reader of the topic sees the same log in the
 *   same order.
 * - A **delivery position** is a place in *this recipient's delivery queue*: the
 *   domain of `hub/receive`'s `after` and of `ack`. It runs across every topic the
 *   recipient subscribes to, it skips the frames the recipient published itself, and
 *   it is emptied by acking.
 *
 * They are different sequences, over different frames, in different orders. A peer
 * that holds one "cursor" and feeds it to both silently mis-pages — skipping commits
 * or re-reading them — and no type error stops it, because both are strings. So they
 * are branded here: a delivery position cannot be assigned where a log position is
 * expected, and the only way to mint either is to say which one you mean.
 */

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
