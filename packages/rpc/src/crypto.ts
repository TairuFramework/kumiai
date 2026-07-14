import type { ByteTransform, Unwrap } from '@kumiai/broadcast'

/**
 * Consumer-supplied MLS crypto port. The consumer adapts its live MLS group into
 * this shape (epoch number, an epoch-bound topic-derivation secret, byte-level
 * encrypt via `wrap`, and decrypt-plus-recover-sender via `unwrap`). group-rpc
 * never imports MLS.
 *
 * `epoch()` and `exportSecret()` are read on init and on every
 * {@link "peer".GroupPeer.resync}. `wrap`/`unwrap` close over the live group, so
 * they always use current epoch state. `unwrap` returns the authenticated
 * sender (`senderDID`) recovered from the ciphertext.
 */
export type GroupCrypto = {
  epoch(): number
  exportSecret(): Uint8Array | Promise<Uint8Array>
  wrap: ByteTransform
  unwrap: Unwrap
}

/**
 * What a Commit says about itself, readable WITHOUT applying it and without decrypting
 * anything: the epoch it is framed at, and the member that authored it.
 *
 * Both are needed to classify a frame before the peer touches it, and both come out of the
 * commit's own bytes — in real MLS, the message's epoch and the DID of the leaf its
 * `senderLeafIndex` names, authenticated by the Commit's own signature. The committer is
 * therefore unforgeable, which is exactly why the lane reads it here and never from the
 * frame's transport sender: that is the hub's word, and the hub is not trusted.
 */
export type CommitHeader = {
  /** The epoch the Commit is framed at — the epoch every member that can apply it is at. */
  epoch: number
  /** The MLS-authenticated author of the Commit. Not the publisher of the frame. */
  committerDID: string
}

/** Context delivered alongside a received Commit on the raw handshake lane. */
export type CommitContext = {
  /**
   * The hub-authenticated publisher of the frame. This is the transport sender,
   * NOT the MLS-cryptographic committer (the Commit authenticates its committer
   * internally) — auxiliary information (logging, rate-limiting), not an
   * authorization boundary.
   */
  senderDID?: string
  /**
   * The bodies riding this Commit's own frame: the signed control-ledger tokens it
   * enacts, sealed under the epoch the Commit is framed at. The port wires this into
   * the MLS handle's entry resolver for the duration of this commit, so the entries the
   * Commit names resolve from the frame that carries them — no prior delivery, no store.
   *
   * It is a resolver, not a value, and that is load-bearing: it opens the blob only when
   * the port asks, and the port asks only for a Commit it is applying — one framed at
   * the epoch this peer is at, which is the epoch the blob is sealed under. A frame this
   * peer cannot apply never has its blob touched.
   *
   * Answers with the tokens sealed into the frame; the port binds each to the id it
   * asked for by digesting it (a responder can fail to answer, never inject), and gets
   * nothing at all for a blob that cannot be opened.
   */
  resolveLedgerEntries?: (ids: Array<string>) => Promise<Array<string>>
}

/**
 * Consumer-supplied MLS lifecycle port. Sibling to {@link GroupCrypto}: where
 * `GroupCrypto` adapts application encrypt/decrypt, this drives the handshake
 * lane — applying Commits to advance the epoch and re-syncing a stranded peer.
 * group-rpc owns the transport + orchestration (subscribe the non-rotating
 * handshake topic, run these methods, resync when the epoch advances); the
 * consumer owns the MLS state and any storage/atomicity, entirely below this
 * interface.
 */
export type GroupMLS = {
  /**
   * Read what a Commit says about itself — its epoch and its committer — WITHOUT applying it
   * and without opening anything. `null` for bytes that are not a Commit at all.
   *
   * This is what lets the lane classify a frame before it touches it: the epoch says whether
   * the frame is this peer's to apply, and the committer says whether it is this peer's own.
   * Neither question may be answered by trying and failing.
   */
  readCommitHeader(commit: Uint8Array): CommitHeader | null
  /**
   * Apply a received Commit to the MLS state and durably persist the result,
   * returning whether the epoch advanced (the signal to resync the app lane).
   * Implementations make this atomic; the orchestration only requires that the
   * write is durable before it resolves.
   *
   * **A frame it cannot apply is `{ advanced: false }`, and never a throw.** The lane's rule
   * is that a throw leaves the cursor where it was and the frame is read again — so a port
   * that throws on a Commit it was never in a position to apply wedges the lane on that
   * frame forever, and a late joiner that throws on its own add-commit wedges on the first
   * frame it ever reads. A Commit framed at another epoch, and a Commit the group's policy
   * refuses, are both `{ advanced: false }`.
   *
   * It throws for exactly ONE outcome: a Commit it SHOULD have been able to apply and could
   * not, because the ledger entries the Commit names would not resolve. That failure is
   * retryable — the bodies can still arrive — and it is the only one that is. See
   * {@link isMissingLedgerEntries}.
   */
  processCommit(commit: Uint8Array, context: CommitContext): Promise<{ advanced: boolean }>
  /**
   * Export current group state for a recovery responder, sealed to the
   * requesting member's MLS leaf so only that requester (not the hub, not other
   * members) can open it.
   */
  exportGroupInfo(requesterDID: string): Promise<Uint8Array>
  /**
   * Re-sync from a sealed recovery reply, returning whether the epoch advanced.
   * The bytes may be hub-injected or sealed to a different member; implementations
   * SHOULD return `{ advanced: false }` for input they cannot open. A throw is also
   * tolerated — the caller treats it as no advance — but returning is preferred.
   */
  applyRecovery(groupInfo: Uint8Array): Promise<{ advanced: boolean }>
  /**
   * The signed control-ledger tokens this member holds for the given content ids,
   * omitting any it does not hold. It serves another member's request for the bodies
   * of entries it lacks — the one case a commit frame cannot cover, because a peer that
   * rejoined by external commit was handed no ledger with its GroupInfo.
   *
   * The requester re-verifies every token and checks its digest against the id it asked
   * for, so an implementation that answers with the wrong body can only fail to answer.
   */
  getLedgerEntries(ids: Array<string>): Promise<Array<string>>
  /**
   * The epoch-independent secret for the non-rotating handshake/recovery topic.
   * Stable for the group's whole life so a stranded peer on any epoch can always
   * derive the rendezvous.
   */
  exportRecoverySecret(): Uint8Array | Promise<Uint8Array>
}

/**
 * The one throw {@link GroupMLS.processCommit} is allowed: the Commit named ledger entries
 * whose bodies would not resolve, from its own frame or from anywhere else the peer looked.
 *
 * It is the only RETRYABLE outcome, and the lane treats it as one — the frame is read again,
 * a bounded number of times, before the cursor is allowed past it. Everything else the port
 * says about a frame it will not apply is a `{ advanced: false }`.
 *
 * Matched by name, not by class: the port is consumer-supplied and its error type is not
 * this package's to import. A port whose missing-entries error is named anything else is a
 * port whose frames the lane will treat as an unknown failure — so the name is contract.
 */
export function isMissingLedgerEntries(error: unknown): boolean {
  return error instanceof Error && error.name === 'MissingLedgerEntriesError'
}
