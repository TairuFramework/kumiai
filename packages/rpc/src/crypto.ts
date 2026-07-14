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
 * The external commit that rejoins a stranded peer to the group, BUILT and not adopted —
 * the recovery twin of {@link "commit".PendingCommit}, and non-mutating for the same
 * reason: the handle it derives is adopted only if the hub accepts the commit, and a peer
 * that adopted first would be sitting on a branch of its own the moment it lost the
 * compare-and-set.
 *
 * It carries no entries. `joinGroupExternal` returns a commit and a handle and has nowhere
 * to put an entry envelope, which is why a heal is TWO commits: this one rejoins, and the
 * entries the peer still owes the group ride an ordinary `commit()` behind it.
 */
export type PendingRecovery = {
  /** The external-commit bytes, framed at the epoch the sealed GroupInfo described. */
  commit: Uint8Array
  /**
   * Adopt the rejoined handle. Runs only if the hub accepts the external commit, and is
   * the ONLY place it may be adopted.
   *
   * **The rejoined handle's ledger is EMPTY** — a GroupInfo carries an authenticated ledger
   * head and no entries — so from here until the ledger is bootstrapped the handle is
   * internally inconsistent, and that state is a roster reset, not a neutral one.
   */
  onAccepted: () => Promise<void>
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
   * Mint the rendezvous request this peer publishes to ask the group for its state: an
   * HPKE keypair minted for this one request, its public half carried in a token signed by
   * this member's identity key.
   *
   * The private half is retained by the port, keyed by `requestID`, and is what makes the
   * reply openable by this peer and nobody else. It is minted per request rather than taken
   * from the peer's leaf because the peers that most need a heal — the one whose commit was
   * accepted and lost, the one on a discarded branch — no longer hold the leaf key the
   * group can see: their own commit rotated it, and the new private key died with the state
   * that was never persisted.
   */
  createRecoveryRequest(requestID: string): Promise<Uint8Array>
  /**
   * Answer another member's request: verify the token, check the requester still holds a
   * leaf in THIS member's current ratchet tree, seal current GroupInfo to the ephemeral key
   * inside the signed request, AND vouch for it — the reply carries a membership attestation
   * this member signs with its DID key, binding the group, the request and the exact GroupInfo
   * bytes. The seal is HPKE base mode and authenticates no one, so the attestation is what lets
   * the requester tell this member's reply from an observer's forgery.
   *
   * The ask-direction authorization is roster-intrinsic, not a permission the caller can forget
   * to check: a removed member gets nothing from any responder that has applied its removal.
   * Throws for a request it refuses, and the peer stays silent rather than answering.
   */
  sealGroupInfo(request: Uint8Array): Promise<Uint8Array>
  /**
   * Open a sealed reply with the key minted for `requestID`, and BUILD the external commit
   * that rejoins this peer to the group it describes. Non-mutating, like every other commit
   * this port builds: the rejoined handle is adopted in {@link PendingRecovery.onAccepted}
   * and nowhere else, because the commit still has to win a compare-and-set at the head.
   *
   * `null` for bytes this peer cannot open OR cannot trust. The seal is HPKE base mode — it
   * needs only the requester's public ephemeral key, every input to which rides the public
   * request in the clear — so a hub-injected or observer-forged reply may well DECRYPT. What
   * refuses it is not the seal: the responder must prove membership by signing the reply with
   * its DID key (the open side requires the signer to hold a leaf in this peer's own last-known
   * tree), and the offered GroupInfo's group id and immutable genesis anchor must match the
   * group being healed. A reply the AEAD refuses (sealed for another member or request), or one
   * that fails either of those checks, is `null`. A throw is tolerated and read the same way.
   */
  applyRecovery(sealed: Uint8Array, requestID: string): Promise<PendingRecovery | null>
  /**
   * Whether the ledger this handle holds is the whole ledger its OWN GroupContext attests
   * to: the head folded from the entries it holds, in the order it holds them, against the
   * authenticated head it carries.
   *
   * Purely local — no peer, no network, and no memory of how the handle got here. False
   * means the ledger is incomplete and {@link bootstrapLedger} must run before this handle
   * can be trusted to fold a roster or judge an incoming commit. A handle that rejoined by
   * external commit reads false: its ledger is empty against a live, non-genesis head.
   */
  isLedgerComplete(): Promise<boolean>
  /**
   * The WHOLE ordered ledger this handle holds, as signed tokens — what a peer about to be
   * rejoined snapshots as the entries it may still owe the group, and what it filters its
   * re-enactment against once the group's own ledger is back.
   *
   * Purely local, and never what goes on the wire: a responder answers a gather with
   * {@link sealLedger}, which is this ledger sealed to one requester and to nobody else.
   *
   * Order is load-bearing: the head is a chain digest, so a permuted list of the same tokens
   * folds to a different head and the requester rejects it.
   */
  getLedger(): Promise<Array<string>>
  /**
   * Answer another member's ledger gather: verify the token, check the requester still holds
   * a leaf in THIS member's current ratchet tree, and seal this handle's whole ordered ledger
   * to the ephemeral key inside the signed request.
   *
   * The authorization is the same roster-intrinsic check {@link sealGroupInfo} makes, and it
   * is not a nicety here: the ledger is the group's whole authority state, the rendezvous
   * topic is public and secretless, and a responder that sealed without checking would hand
   * every role and every promotion to any stranger who minted a request — neatly encrypted to
   * the stranger's own key. Throws for a request it refuses, and the peer stays silent.
   *
   * The seal is EPOCH-INDEPENDENT, and must remain so. The requester is a peer that crashed
   * between its rejoin and its bootstrap, and the lane gathers before it pulls — so it can be
   * at an older epoch than every responder, and a reply sealed under the responder's current
   * epoch would be unopenable by the very peer that asked for it.
   */
  sealLedger(request: Uint8Array): Promise<Uint8Array>
  /**
   * Open a sealed gather reply with the key minted for `requestID`, and return the responder's
   * whole ordered ledger as signed tokens.
   *
   * `null` when the AEAD refuses these bytes — sealed to another ephemeral key, or bound to
   * another member, request, or reply kind. It does NOT mean the sealer was a member: unlike
   * the GroupInfo reply, the ledger reply carries no responder attestation, and HPKE base mode
   * authenticates no one, so an observer of the request can forge a ledger reply that decrypts.
   * The key is NOT consumed: every responder answers a gather, and the requester must be able
   * to open the next reply after it drops one.
   *
   * Opening therefore proves NOTHING about who sealed these tokens. The bound is
   * {@link bootstrapLedger}'s head check: a reply that reproduces this group's authenticated
   * head is its whole ledger, in order, and a forged, lying, reordered or truncated one fails
   * that check and is dropped — withhold, never rewrite. A forged reply that merely decrypts
   * costs the requester one gather attempt: a denial of service, not a compromise.
   */
  openSealedLedger(sealed: Uint8Array, requestID: string): Promise<Array<string> | null>
  /**
   * Install a gathered ledger, verified against the authenticated head BEFORE a single
   * entry is folded. It REPLACES the ledger this handle holds, which is sound because the
   * check is a fold from genesis: a list that reproduces the head this handle's own
   * GroupContext carries IS the group's entire ledger, in order.
   *
   * Throws for a list whose recomputed head does not match — a lying responder can withhold,
   * never rewrite — and the peer drops that responder and folds the next reply instead.
   */
  bootstrapLedger(tokens: Array<string>): Promise<void>
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
