/**
 * The commit lane's frame: an MLS Commit plus the ledger-entry bodies that Commit enacts,
 * sealed under the epoch secret the Commit is framed at.
 *
 *   [ commitLength(4, LE) | commit bytes | sealed entry blob... ]
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

const COMMIT_LENGTH_BYTES = 4

/** A commit frame's two halves, as bytes. The blob is opaque here — sealed, unread. */
export type CommitFrame = {
  /** The framed MLS Commit. */
  commit: Uint8Array
  /** The sealed ledger-entry bodies this Commit enacts. Opaque until opened. */
  sealedEntries: Uint8Array
}

/** Frame a Commit with the sealed blob of the entry bodies it enacts. */
export function encodeCommitFrame(commit: Uint8Array, sealedEntries: Uint8Array): Uint8Array {
  const frame = new Uint8Array(COMMIT_LENGTH_BYTES + commit.length + sealedEntries.length)
  new DataView(frame.buffer).setUint32(0, commit.length, true)
  frame.set(commit, COMMIT_LENGTH_BYTES)
  frame.set(sealedEntries, COMMIT_LENGTH_BYTES + commit.length)
  return frame
}

/**
 * Split a commit frame into its two halves. Throws only on bytes that are not a frame at
 * all — too short, or a length that runs past the end. An unopenable blob is not a
 * decoding failure: this never looks at the blob.
 */
export function decodeCommitFrame(frame: Uint8Array): CommitFrame {
  if (frame.length < COMMIT_LENGTH_BYTES) {
    throw new Error('commit frame is too short')
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const commitLength = view.getUint32(0, true)
  const blobStart = COMMIT_LENGTH_BYTES + commitLength
  if (frame.length < blobStart) {
    throw new Error('commit frame is truncated: the commit runs past the end of the frame')
  }
  return {
    commit: frame.subarray(COMMIT_LENGTH_BYTES, blobStart),
    sealedEntries: frame.subarray(blobStart),
  }
}
