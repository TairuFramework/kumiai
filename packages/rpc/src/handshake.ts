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
 * BUMPING THIS IS SURVIVABLE, and that is a property of the reader, not of the byte. An old peer
 * meeting an unknown version does not fail the decode — {@link decodeHandshakeFrame} hands the
 * version back rather than throwing — and on the COMMIT topic the lane files an unreadable frame
 * as {@link "classify".CommitDisposition} `ahead`: the group moved on to something this build
 * cannot read, so step over the frame, heal, and stay stranded until the heal lands.
 *
 * It has to work that way, because the obvious alternative does not. Filing an unreadable frame
 * as poison holds only while SOME frames stay readable, and after a version bump none do: there
 * is no "next frame" to heal from, so the peer steps over the group's entire future, drains to
 * the end of the log, and reports itself fully reconciled at a dead epoch. Silent, and no restart
 * fixes it. The heal direction is also the safe one — a forged unknown-version frame can only
 * TRIGGER a heal, never suppress one, the same asymmetry the `ahead` row already accepts on a
 * cleartext epoch.
 *
 * STILL PREFER PUTTING A FORMAT CHANGE INSIDE THE PAYLOAD, and the sealed ledger-entry blob is
 * the case that will tempt you to bump this instead. A payload change costs an old peer one
 * commit (it fails the OPEN, files that commit as poison, and heals from the next frame); a
 * header bump costs it a full rejoin, on every frame, from the bump onwards. Bump this only when
 * the HEADER itself changes — and only alongside a plan for the peers that cannot read it, whose
 * whole recourse is the heal above.
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
 * Validate the header and split a frame into its version, kind and payload. Throws on a short
 * frame, a bad magic, or an unknown kind — bytes that are not this protocol at all.
 *
 * DOES NOT throw on an unsupported VERSION: it returns it, because the right answer differs by
 * lane and only the caller knows which lane it is on. Every caller MUST compare `version` against
 * {@link HANDSHAKE_VERSION} before trusting `payload`, which is a format this build has never
 * seen. On the commit topic an unknown version is evidence the group moved on and the peer heals
 * (see {@link HANDSHAKE_VERSION}); everywhere else it is a frame that says nothing, and is
 * dropped like any other unreadable one.
 */
export function decodeHandshakeFrame(frame: Uint8Array): {
  /** The frame's wire version. Equal to {@link HANDSHAKE_VERSION} for a frame this build reads. */
  version: number
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
  const kind = frame[HANDSHAKE_MAGIC.length + 1]
  if (!isHandshakeKind(kind)) {
    throw new Error(`unknown handshake kind: ${kind}`)
  }
  return { version, kind, payload: frame.subarray(HEADER_LENGTH) }
}
