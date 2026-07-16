/**
 * The host's durable read position on ONE app-lane topic: the last frame the drain is DONE with.
 *
 * It exists because the drain is the only thing that delivers a retained app frame to a peer that
 * was away, and without a position it re-reads the topic from the hub's oldest retained frame on
 * every restart. That re-read is not free: it re-delivers whatever the handle can still open, and
 * it hides the one thing a reader must be told — that the hub's retention floor has passed the
 * place this peer had got to, so frames between the two are gone. A position is what makes a
 * re-read unnecessary and a gap knowable, and both only if it survives the process.
 *
 * THE ADVANCE RULE, which the store's whole value rests on: a cursor may only pass a frame that is
 * DELIVERED or DEAD. A frame sealed at an epoch the walk has not reached yet is neither — it is
 * openable later, and only later — and a cursor that passed it would drop it on the next restart,
 * which is the exact loss this store exists to stop. See the drain in `peer.ts`, which is where the
 * rule is enforced.
 *
 * Keyed by TOPIC ID, and not folded into {@link "anchor".AnchorStore}: a topic ID already encodes
 * both the segment (it is anchor-bound) and the protocol, which is exactly the granularity a read
 * position has — the drain is per-protocol, and the position is written per drain rather than per
 * rotation. A rotation onto a new segment is a new topic and therefore a fresh position, with no
 * clearing to forget.
 *
 * `load` returning `null` means this peer has never processed a frame on that topic: read from the
 * hub's oldest retained frame, and report no gap — nothing is known to be missing from a place the
 * peer has never been.
 *
 * Positions are log positions (see `cursor.ts`), opaque to the host: store the string, compare
 * nothing.
 */
export type AppCursorStore = {
  load(topicID: string): Promise<string | null>
  save(topicID: string, position: string): Promise<void>
}

/**
 * A gap below the retention floor: the hub's oldest retained frame on an app topic is NEWER than
 * the position this peer had read to, so whatever sat between them aged out unread.
 *
 * Reported rather than silent, which is the whole point — a peer back from a long absence is
 * otherwise handed a partial history it cannot tell from a complete one, and neither it nor its
 * host can say so. It is a NOTICE and not an error: the frames that survived are delivered anyway.
 *
 * It is the conservative side of a question the hub cannot answer exactly: a peer whose own cursor
 * frame has aged out cannot prove that nothing was published between it and the floor, so this
 * fires whenever the floor has passed the cursor. It over-reports; it never stays quiet about a
 * real gap.
 *
 * NO WALL-CLOCK, deliberately: rpc has no clock worth handing a host, and "messages since <date>"
 * is the host's own sentence to write from its own HLC. What is carried is what rpc knows.
 */
export type AppWindowPruned = {
  /**
   * The group the gap is in, as rpc knows one: its commit topic, derived from the group's
   * epoch-independent recovery secret. Stable for the group's whole life and identical for every
   * member — the only name rpc has for a group, and enough to key a host's per-group condition on.
   */
  groupID: string
  /** The app protocol whose topic the gap is on. */
  protocol: string
  /** The last position this peer read to: the older edge of the gap, exclusive. */
  cursor: string
  /** The hub's oldest retained frame on the topic now: the newer edge of the gap, inclusive. */
  oldest: string
}
