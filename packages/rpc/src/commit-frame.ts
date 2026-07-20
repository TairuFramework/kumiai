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
 * An unknown version is REFUSED, not healed from: the heal rule belongs to the handshake header
 * (see {@link "handshake".HANDSHAKE_VERSION}), which the lane reads before this. Here the value
 * is diagnosis — a named error instead of a plausible mis-parse.
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
 * Split a commit frame into its two halves. Throws only on bytes that are not a frame at
 * all — too short, an unknown version, or a length that runs past the end. An unopenable blob is
 * not a decoding failure: this never looks at the blob.
 */
export function decodeCommitFrame(frame: Uint8Array): CommitFrame {
  if (frame.length < HEADER_BYTES) {
    throw new Error('commit frame is too short')
  }
  const version = frame[0]
  if (version !== COMMIT_FRAME_VERSION) {
    throw new Error(`unsupported commit frame version: ${version}`)
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
