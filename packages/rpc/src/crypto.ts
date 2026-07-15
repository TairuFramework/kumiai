import type { ByteTransform, Unwrap } from '@kumiai/broadcast'

/**
 * Consumer-supplied MLS crypto port: epoch number, an epoch-bound topic-derivation secret,
 * byte-level encrypt (`wrap`) and decrypt-plus-recover-sender (`unwrap`). group-rpc never
 * imports MLS.
 *
 * `epoch()` and `exportSecret()` are read on init and every {@link "peer".GroupPeer.resync}.
 * `wrap`/`unwrap` close over the live group, so they always use current epoch state. `unwrap`
 * returns the authenticated sender (`senderDID`) recovered from the ciphertext.
 */
export type GroupCrypto = {
  epoch(): number
  exportSecret(): Uint8Array | Promise<Uint8Array>
  wrap: ByteTransform
  unwrap: Unwrap
}

/**
 * What a Commit says about itself, readable WITHOUT applying it and without decrypting: the
 * epoch it is framed at, and its author. Both classify a frame before the peer touches it, and
 * both come from the commit's own bytes (authenticated by its signature), never from the
 * frame's transport sender — that is the hub's word, and the hub is not trusted.
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
   * The hub-authenticated publisher of the frame — the transport sender, NOT the
   * MLS committer. Auxiliary (logging, rate-limiting), not an authorization boundary.
   */
  senderDID?: string
  /**
   * The bodies riding this Commit's own frame: the signed control-ledger tokens it enacts,
   * sealed under the epoch the Commit is framed at. The port wires this into the MLS handle's
   * entry resolver for this commit's duration, so the named entries resolve from the frame that
   * carries them — no prior delivery, no store.
   *
   * A resolver, not a value, and load-bearing: it opens the blob only when the port asks, and
   * the port asks only for a Commit it is applying — framed at this peer's epoch, which is the
   * epoch the blob is sealed under. A frame this peer cannot apply never has its blob touched.
   * The port binds each token to the id it asked for by digesting it (a responder can fail to
   * answer, never inject), and gets nothing for a blob it cannot open.
   */
  resolveLedgerEntries?: (ids: Array<string>) => Promise<Array<string>>
}

/**
 * The external commit that rejoins a stranded peer, BUILT and not adopted — the recovery twin
 * of {@link "commit".PendingCommit}, non-mutating for the same reason: the derived handle is
 * adopted only if the hub accepts the commit, or a peer that adopted first sits on a branch of
 * its own the moment it loses the compare-and-set.
 *
 * Carries no entries — a GroupInfo has nowhere to put an entry envelope — which is why a heal
 * is TWO commits: this one rejoins, and the entries the peer still owes ride an ordinary
 * `commit()` behind it.
 */
export type PendingRecovery = {
  /** The external-commit bytes, framed at the epoch the sealed GroupInfo described. */
  commit: Uint8Array
  /**
   * Adopt the rejoined handle. Runs only if the hub accepts the external commit; the ONLY place
   * it may be adopted.
   *
   * The rejoined handle's ledger is EMPTY — a GroupInfo carries a head and no entries — so until
   * the ledger is bootstrapped the handle is internally inconsistent: a roster reset, not a
   * neutral one.
   */
  onAccepted: () => Promise<void>
}

/**
 * Consumer-supplied MLS lifecycle port. Sibling to {@link GroupCrypto}: this drives the
 * handshake lane — applying Commits to advance the epoch, re-syncing a stranded peer. group-rpc
 * owns transport + orchestration; the consumer owns MLS state and any storage/atomicity below
 * this interface.
 */
export type GroupMLS = {
  /**
   * Read what a Commit says about itself — epoch and committer — WITHOUT applying it or opening
   * anything. `null` for bytes that are not a Commit. Lets the lane classify a frame (epoch =
   * this peer's to apply? committer = this peer's own?) before touching it; neither question may
   * be answered by trying and failing.
   */
  readCommitHeader(commit: Uint8Array): CommitHeader | null
  /**
   * Apply a received Commit and durably persist the result, returning whether the epoch
   * advanced (the signal to resync the app lane). Must be durable before it resolves.
   *
   * A frame it cannot apply is `{ advanced: false }`, NEVER a throw: a throw leaves the cursor
   * put and re-reads the frame, so a port that throws on a Commit it was never in a position to
   * apply wedges the lane on that frame forever (a late joiner would wedge on its own add-commit,
   * the first frame it reads). A Commit at another epoch, or one policy refuses, is both
   * `{ advanced: false }`.
   *
   * Throws for exactly ONE outcome: a Commit it SHOULD apply but cannot because the ledger
   * entries it names will not resolve from the Commit's own frame — the only place they ride.
   * The lane does NOT retry; the bodies never arrive later (sealed under the Commit's framed
   * epoch, so a peer that cannot open them is one no member at that epoch can), and the lane
   * steps over the frame as POISON — cursor advances, never re-read. The throw distinguishes
   * that poison case from a port that broke its contract on a frame it should have applied, which
   * the lane DOES re-read. See {@link isMissingLedgerEntries}.
   */
  processCommit(commit: Uint8Array, context: CommitContext): Promise<{ advanced: boolean }>
  /**
   * Mint the rendezvous request this peer publishes to ask the group for its state: an HPKE
   * keypair for this one request, its public half in a token signed by this member's identity
   * key. The private half is retained by the port keyed by `requestID`, and is what makes the
   * reply openable by this peer alone. Minted per request, not from the leaf, because the peers
   * that most need a heal (commit accepted and lost, on a discarded branch) no longer hold the
   * leaf key the group can see — their own commit rotated it and the new key died unpersisted.
   *
   * The port MUST bound retention of that private half itself — the lane has no release hook. A
   * gather/rejoin that times out and a `recover()` that fails before opening a reply both drop
   * their `requestID` on the rpc side (the waiter maps clear on finish/timeout/dispose) but tell
   * the port nothing, so a port that only evicts on reply-open accumulates one key per timed-out
   * round. A TTL off the request's mint time is the natural bound: a request older than one
   * requester deadline can no longer be answered. The bound lives here rather than as a lane
   * release call that would obligate every {@link GroupMLS} to a new method.
   */
  createRecoveryRequest(requestID: string): Promise<Uint8Array>
  /**
   * Answer another member's request: verify the token, check the requester still holds a leaf in
   * THIS member's current ratchet tree, seal current GroupInfo to the ephemeral key inside the
   * signed request, AND vouch for it — the reply carries a membership attestation this member
   * signs with its DID key, binding the group, the request and the exact GroupInfo bytes. The
   * seal is HPKE base mode and authenticates no one, so the attestation is what lets the
   * requester tell this member's reply from an observer's forgery.
   *
   * Authorization is roster-intrinsic, not a check the caller can forget: a removed member gets
   * nothing from any responder that has applied its removal. Throws for a request it refuses, and
   * the peer stays silent.
   */
  sealGroupInfo(request: Uint8Array): Promise<Uint8Array>
  /**
   * Open a sealed reply with the key minted for `requestID` and BUILD the external commit that
   * rejoins this peer. Non-mutating: the rejoined handle is adopted in
   * {@link PendingRecovery.onAccepted} and nowhere else, because the commit still has to win a
   * compare-and-set at the head.
   *
   * `null` for bytes this peer cannot open OR cannot trust. HPKE base mode needs only the
   * requester's public ephemeral key — all of which rides the public request in the clear — so a
   * hub-injected or observer-forged reply may DECRYPT. What refuses it: the responder must prove
   * membership by signing the reply with its DID key (open side requires the signer to hold a
   * leaf in this peer's last-known tree), and the offered GroupInfo's group id and genesis anchor
   * must match the group being healed. A reply the AEAD refuses, or one that fails either check,
   * is `null`. A throw is tolerated and read the same way.
   */
  applyRecovery(sealed: Uint8Array, requestID: string): Promise<PendingRecovery | null>
  /**
   * Whether the ledger this handle holds is the whole ledger its OWN GroupContext attests to:
   * the head folded from the entries it holds, in their order, against the authenticated head it
   * carries. Purely local. False means incomplete — {@link bootstrapLedger} must run before this
   * handle can be trusted to fold a roster or judge an incoming commit. A handle that rejoined by
   * external commit reads false: empty ledger against a live, non-genesis head.
   */
  isLedgerComplete(): Promise<boolean>
  /**
   * The WHOLE ordered ledger this handle holds, as signed tokens — what a peer about to rejoin
   * snapshots as the entries it may still owe, and filters its re-enactment against once the
   * group's ledger is back. Purely local, never on the wire (a responder uses {@link sealLedger}).
   *
   * Order is load-bearing: the head is a chain digest, so a permuted list of the same tokens
   * folds to a different head and the requester rejects it.
   */
  getLedger(): Promise<Array<string>>
  /**
   * Answer another member's ledger gather: verify the token, check the requester still holds a
   * leaf in THIS member's current ratchet tree, and seal this handle's whole ordered ledger to
   * the ephemeral key inside the signed request.
   *
   * Same roster-intrinsic authorization {@link sealGroupInfo} makes, and not a nicety: the ledger
   * is the group's whole authority state on a public secretless topic, and a responder that
   * sealed without checking would hand every role and promotion to any stranger who minted a
   * request, encrypted to the stranger's key. Throws for a request it refuses; the peer stays silent.
   *
   * The seal is EPOCH-INDEPENDENT and must remain so: the requester crashed between rejoin and
   * bootstrap and the lane gathers before it pulls, so it can be at an older epoch than every
   * responder, and a reply sealed under the responder's current epoch would be unopenable by it.
   */
  sealLedger(request: Uint8Array): Promise<Uint8Array>
  /**
   * Open a sealed gather reply with the key minted for `requestID`, returning the responder's
   * whole ordered ledger as signed tokens.
   *
   * `null` when the AEAD refuses the bytes — sealed to another ephemeral key, or bound to another
   * member, request, or reply kind. It does NOT prove the sealer was a member: unlike the
   * GroupInfo reply the ledger reply carries no attestation, and HPKE base mode authenticates no
   * one, so an observer of the request can forge a reply that decrypts. The key is NOT consumed:
   * every responder answers, and the requester must open the next reply after dropping one.
   *
   * Opening proves NOTHING about who sealed the tokens. The bound is {@link bootstrapLedger}'s
   * head check: a reply reproducing this group's authenticated head is its whole ledger in order,
   * and a forged, lying, reordered or truncated one fails and is dropped — withhold, never
   * rewrite. A forged reply that merely decrypts costs one gather attempt: denial of service, not
   * compromise.
   */
  openSealedLedger(sealed: Uint8Array, requestID: string): Promise<Array<string> | null>
  /**
   * Install a gathered ledger, verified against the authenticated head BEFORE a single entry is
   * folded. REPLACES the ledger this handle holds, sound because the check is a fold from
   * genesis: a list reproducing the head this handle's own GroupContext carries IS the group's
   * entire ledger, in order.
   *
   * Throws for a list whose recomputed head does not match — a lying responder can withhold,
   * never rewrite — and the peer drops that responder and folds the next reply instead.
   */
  bootstrapLedger(tokens: Array<string>): Promise<void>
  /**
   * The epoch-independent secret for the non-rotating handshake/recovery topic. Stable for the
   * group's whole life so a stranded peer on any epoch can always derive the rendezvous.
   */
  exportRecoverySecret(): Uint8Array | Promise<Uint8Array>
}

/**
 * The one throw {@link GroupMLS.processCommit} is allowed: the Commit named ledger entries whose
 * bodies would not resolve from the frame the Commit rides in.
 *
 * The lane treats it as POISON: step over the frame, advance the cursor, never re-read. The
 * bodies are sealed under the Commit's framed epoch, so a peer that cannot resolve them is one no
 * member at that epoch can — nobody applies the commit, the group never moves past that epoch,
 * and the next honest commit is framed at the same epoch and compare-and-sets behind it.
 * Everything else the port says about a frame it will not apply is `{ advanced: false }`, poison
 * on the same terms: advances, never retried, does not heal.
 *
 * Matched by NAME, not class: the port is consumer-supplied and its error type is not this
 * package's to import. A missing-entries error named anything else is treated as an unknown
 * failure — so the name is contract.
 */
export function isMissingLedgerEntries(error: unknown): boolean {
  return error instanceof Error && error.name === 'MissingLedgerEntriesError'
}
