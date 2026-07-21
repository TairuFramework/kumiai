/**
 * The commit lane's frame: an MLS Commit plus the ledger-entry bodies that Commit enacts,
 * sealed under the epoch secret the Commit is framed at.
 *
 *   [ VERSION(1) | commitLength(4, LE) | commit bytes | sealed entry blob... ]
 *
 * Length-delimited halves, so the commit half is read WITHOUT touching the blob. Body
 * delivery is atomic with the commit: a peer is never told of a body before the commit that
 * enacts it.
 *
 * NOTHING IN THIS MODULE IMPORTS CRYPTO — reading a frame cannot decrypt, so "read this
 * frame" and "opened its blob" cannot be conflated. Every peer walking the log reaches frames
 * sealed under an epoch secret it does not hold (the late joiner reaches the commit that added
 * it); an unopenable blob is history, not poison — read the commit half, step over the frame.
 * The blob is opened by {@link "ledger-entries".createLedgerEntryResolver}, only for a commit
 * the peer is applying.
 */

/**
 * Current commit-frame format version.
 *
 * Exists because WITHOUT it, a later frame with a third section would decode here SUCCESSFULLY,
 * silently swallowed into `sealedEntries` — a reader that accepts corrupt input can't be taught
 * later to reject it, so the rule has to ship in the first build.
 *
 * BUMPING THIS STRANDS EVERY OLD PEER; the lane routes an unknown version to
 * {@link "classify".classifyCommit} as {@link "classify".UNKNOWN_FRAME_VERSION} (same as an
 * unknown handshake version) so the strand is a loud heal, not a silent stall —
 * {@link isUnsupportedCommitFrameVersion} is what lets the lane tell that failure apart from
 * bytes that are simply not a frame. This byte is read BEFORE the commit bytes are extracted, so
 * unlike the sealed ledger-entry blob (whose failure lands after the commit is read, poisoning
 * one commit and healing off the next), there is no next frame to fall back to — bump this only
 * when the frame's SHAPE itself changes (a third section, a wider length field), and only with a
 * responder that still answers old peers' rendezvous requests in a version they can read.
 */
export const COMMIT_FRAME_VERSION = 1

const VERSION_BYTES = 1
const COMMIT_LENGTH_BYTES = 4
const HEADER_BYTES = VERSION_BYTES + COMMIT_LENGTH_BYTES

/** A commit frame's two halves, as bytes. The blob is opaque here — sealed, unread. */
export type CommitFrame = {
  /** The framed MLS Commit. */
  commit: Uint8Array
  /** The sealed ledger-entry bodies this Commit enacts. Opaque until opened. */
  sealedEntries: Uint8Array
}

/** Frame a Commit with the sealed blob of the entry bodies it enacts. */
export function encodeCommitFrame(commit: Uint8Array, sealedEntries: Uint8Array): Uint8Array {
  const frame = new Uint8Array(HEADER_BYTES + commit.length + sealedEntries.length)
  frame[0] = COMMIT_FRAME_VERSION
  new DataView(frame.buffer).setUint32(VERSION_BYTES, commit.length, true)
  frame.set(commit, HEADER_BYTES)
  frame.set(sealedEntries, HEADER_BYTES + commit.length)
  return frame
}

/**
 * Thrown by {@link decodeCommitFrame} for an unknown version byte, and ONLY for that: the lane
 * must treat it differently from "not a frame" (dropped) — a frame from the future goes to the
 * classifier to raise a heal, so it needs a type to branch on, not a message string.
 */
export class UnsupportedCommitFrameVersionError extends Error {
  #version: number

  constructor(version: number) {
    super(`unsupported commit frame version: ${version}`)
    this.name = 'UnsupportedCommitFrameVersionError'
    this.#version = version
  }

  /** The version byte read off the frame — the one this build does not know. */
  get version(): number {
    return this.#version
  }
}

/**
 * Whether a {@link decodeCommitFrame} failure was an unknown VERSION, not just non-frame bytes.
 * Checked by class, not name, since the error is thrown in-package — mirrors
 * {@link "crypto".isMissingLedgerEntries}.
 */
export function isUnsupportedCommitFrameVersion(error: unknown): boolean {
  return error instanceof UnsupportedCommitFrameVersionError
}

/**
 * Split a commit frame into its two halves. Throws on bytes that are not a frame at all (too
 * short, or a length past the end) and on an unknown version — as
 * {@link UnsupportedCommitFrameVersionError}, so the caller can route it to the heal instead of
 * dropping it. Never looks at the blob, so an unopenable one is not a decoding failure.
 */
export function decodeCommitFrame(frame: Uint8Array): CommitFrame {
  if (frame.length < HEADER_BYTES) {
    throw new Error('commit frame is too short')
  }
  const version = frame[0]
  if (version !== COMMIT_FRAME_VERSION) {
    throw new UnsupportedCommitFrameVersionError(version)
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const commitLength = view.getUint32(VERSION_BYTES, true)
  const blobStart = HEADER_BYTES + commitLength
  if (frame.length < blobStart) {
    throw new Error('commit frame is truncated: the commit runs past the end of the frame')
  }
  return {
    commit: frame.subarray(HEADER_BYTES, blobStart),
    sealedEntries: frame.subarray(blobStart),
  }
}
