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
 * The leading byte exists because WITHOUT it this format's failure mode is the worst kind
 * available: a later frame with a third section decodes here SUCCESSFULLY, its new section
 * silently swallowed into `sealedEntries`, and the peer applies a commit while believing
 * something false about what rode with it. A reader that accepts corrupt input cannot be taught
 * later to reject it — the rule has to be in the build that ships first.
 *
 * BUMPING THIS STRANDS EVERY OLD PEER, and the heal is what makes that a loud stall rather than a
 * silent one. Do not read {@link "handshake".HANDSHAKE_VERSION}'s "prefer putting a format change
 * inside the payload" as covering this byte: that advice is about the SEALED LEDGER-ENTRY BLOB,
 * whose failure lands after the commit bytes have been read, so the frame is filed as poison and
 * the peer heals off the next readable frame. This version byte is read BEFORE the commit bytes
 * are extracted, so there is no next frame to heal from — after a bump every frame fails here.
 * The lane therefore routes an unknown version to {@link "classify".classifyCommit} as
 * {@link "classify".UNKNOWN_FRAME_VERSION}, exactly as it does an unknown handshake version, and
 * {@link isUnsupportedCommitFrameVersion} is what lets it tell that failure apart from bytes that
 * are simply not a frame. Which payload changes heal, precisely:
 *
 *   - the blob's OWN version/contents (`ledger-entries`): heals — poison one commit, read on.
 *   - a change to THIS frame's shape (a third section, a wider length field): does NOT heal by
 *     itself. It needs this byte bumped, and the bump needs the heal above plus a responder that
 *     still answers old peers' rendezvous requests in a version they can read.
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
 * Thrown by {@link decodeCommitFrame} for a frame whose version byte this build does not know —
 * and ONLY for that. A distinct type because the lane must act differently on it: "not a frame"
 * (too short, truncated) is dropped, while "a frame from the future" is evidence the group moved
 * to a format this build cannot read, and goes to the classifier to raise a heal. Distinguishing
 * those two by message text would not be something to branch on, which is why this exists.
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
 * Whether a {@link decodeCommitFrame} failure was an unknown VERSION rather than bytes that are
 * not a frame at all. The lane's branch, mirroring {@link "crypto".isMissingLedgerEntries}: this
 * error is thrown in-package, so the check is by class rather than by name.
 */
export function isUnsupportedCommitFrameVersion(error: unknown): boolean {
  return error instanceof UnsupportedCommitFrameVersionError
}

/**
 * Split a commit frame into its two halves. Throws only on bytes that are not a frame at
 * all — too short, or a length that runs past the end — plus the one failure that is NOT
 * "not a frame": an unknown version, thrown as {@link UnsupportedCommitFrameVersionError} so the
 * caller can route it to the heal instead of dropping it. An unopenable blob is not a decoding
 * failure: this never looks at the blob.
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
