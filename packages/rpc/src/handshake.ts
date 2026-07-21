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
 * BUMPING THIS IS SURVIVABLE, but only because of what the reader does with it, not the byte
 * itself: {@link decodeHandshakeFrame} hands an unknown version back rather than throwing, and on
 * the COMMIT topic the lane files it as {@link "classify".CommitDisposition} `ahead` — the group
 * moved to a format this build can't read, so step over the frame and heal. That heal only
 * GUARANTEES a loud stall in place of a silent one; landing the rejoin additionally needs the new
 * build to still answer old peers' rendezvous requests in a version they can read.
 *
 * It has to be `ahead`, not poison: poison only works while SOME frames stay readable, and after
 * a bump none do — there's no "next frame" to heal from, so the peer drains to the end of the
 * log and reports itself reconciled at a dead epoch, silently, permanently. The heal direction is
 * also the safe one: a forged unknown-version frame can only TRIGGER a heal, never suppress one —
 * the same asymmetry the `ahead` row accepts on a cleartext epoch.
 *
 * STILL PREFER PUTTING A FORMAT CHANGE INSIDE THE PAYLOAD — but "the payload" isn't one place.
 * The commit frame ({@link "commit-frame".COMMIT_FRAME_VERSION}) does NOT get the cheap outcome:
 * its version byte is read before the commit bytes are extracted, so a bump there strands every
 * old peer exactly as a bump here does, and routes to the same heal. Only the sealed ledger-entry
 * blob gets the cheap outcome, because its failure lands after the commit is read (poisons one
 * commit, heals from the next). Bump this only when the HEADER itself changes, and only alongside
 * a responder that keeps answering old peers' rendezvous requests — without that, the heal above
 * is decorative.
 */
export const HANDSHAKE_VERSION = 1

const HEADER_LENGTH = HANDSHAKE_MAGIC.length + 2

/**
 * The message kinds carried on the handshake lane. {@link decodeHandshakeFrame} THROWS on a kind
 * byte not listed here, before the caller learns the frame's version — and on the commit topic a
 * throw is poison, not the heal. So no future version may publish a kind this enum lacks:
 * `commit` stays `0` forever, and a new commit-topic message needs its kind added HERE, not just
 * allowed by a version bump. Deliberate — kind is validated before version.
 */
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
 * DOES NOT throw on an unsupported VERSION; it returns it, since the right answer differs by
 * lane and only the caller knows which lane it's on. Every caller MUST compare `version` against
 * {@link HANDSHAKE_VERSION} before trusting `payload` — see {@link HANDSHAKE_VERSION} for what an
 * unknown one means on the commit topic versus everywhere else.
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
