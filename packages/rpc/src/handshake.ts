/**
 * Framing for the raw MLS control lanes: un-`wrap`ped bytes on non-rotating topics (Commits on
 * the commit topic, recovery request/reply on the rendezvous topic). Self-identifying, so a
 * frame on the wrong lane is dropped rather than mis-read:
 *
 *   [ MAGIC(2) | VERSION(1) | KIND(1) | payload... ]
 *
 * Magic: fail-fast on garbage or a mis-routed payload. Version: evolve the wire format without
 * an ambiguous unversioned migration. Kind: discriminate the messages.
 */

/** Leading marker identifying a handshake frame ("EK"). */
export const HANDSHAKE_MAGIC = Uint8Array.from([0x45, 0x4b])

/**
 * Current handshake wire-format version.
 *
 * DO NOT BUMP THIS TO SIGNAL A CHANGE IN SOMETHING THE FRAME MERELY CARRIES, and the sealed
 * ledger-entry blob is the case that will tempt you. An old peer meeting an unknown version
 * fails at `decodeHandshakeFrame`, and the commit lane catches that BEFORE it reads the header —
 * so the frame is stepped over without ever being classified. It is the classification that
 * makes a peer notice the group has moved past it (`ahead`) and heal. Step over every new frame
 * instead, and the peer walks to the end of the log, reports itself fully reconciled, and sits
 * at a dead epoch forever: no error, no heal, no restart that fixes it.
 *
 * A change to a payload's own format belongs inside that payload, where an old peer fails the
 * OPEN — which it already survives, by filing the commit as poison and healing from the next
 * frame — rather than failing the decode, which it does not survive. Bump this only when the
 * header itself changes, and only alongside a plan for peers that cannot read it.
 */
export const HANDSHAKE_VERSION = 1

const HEADER_LENGTH = HANDSHAKE_MAGIC.length + 2

/** The message kinds carried on the handshake lane. */
export const HANDSHAKE_KIND = {
  /** An MLS Commit fanned out to advance every member's epoch. */
  commit: 0,
  /** A stranded peer asking the group for current state. */
  recoveryRequest: 1,
  /** A member's reply carrying the state needed to re-sync. */
  recoveryReply: 2,
  /**
   * A rejoined peer asking for the group's WHOLE ordered ledger. A GroupInfo carries an
   * authenticated ledger head (a chain digest) and no entries, so a peer that rejoined by
   * external commit cannot ask for "the ids it is missing" — nothing enumerates them.
   */
  ledgerRequest: 3,
  /** A member's reply carrying its whole ordered ledger, for the requester to head-verify. */
  ledgerReply: 4,
} as const

export type HandshakeKind = (typeof HANDSHAKE_KIND)[keyof typeof HANDSHAKE_KIND]

const KINDS = new Set<number>(Object.values(HANDSHAKE_KIND))

function isHandshakeKind(value: number): value is HandshakeKind {
  return KINDS.has(value)
}

/** Wrap a payload with the magic + version + kind header. */
export function encodeHandshakeFrame(kind: HandshakeKind, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(HEADER_LENGTH + payload.length)
  frame.set(HANDSHAKE_MAGIC, 0)
  frame[HANDSHAKE_MAGIC.length] = HANDSHAKE_VERSION
  frame[HANDSHAKE_MAGIC.length + 1] = kind
  frame.set(payload, HEADER_LENGTH)
  return frame
}

/**
 * Validate the header and split a frame into its kind and payload. Throws on a
 * short frame, a bad magic, an unsupported version, or an unknown kind.
 */
export function decodeHandshakeFrame(frame: Uint8Array): {
  kind: HandshakeKind
  payload: Uint8Array
} {
  if (frame.length < HEADER_LENGTH) {
    throw new Error('handshake frame is too short')
  }
  if (frame[0] !== HANDSHAKE_MAGIC[0] || frame[1] !== HANDSHAKE_MAGIC[1]) {
    throw new Error('handshake frame has a bad magic')
  }
  const version = frame[HANDSHAKE_MAGIC.length]
  if (version !== HANDSHAKE_VERSION) {
    throw new Error(`unsupported handshake version: ${version}`)
  }
  const kind = frame[HANDSHAKE_MAGIC.length + 1]
  if (!isHandshakeKind(kind)) {
    throw new Error(`unknown handshake kind: ${kind}`)
  }
  return { kind, payload: frame.subarray(HEADER_LENGTH) }
}
