import type { ByteTransform } from '@kumiai/broadcast'

/**
 * Consumer-supplied MLS crypto port: epoch number, epoch-bound domain-separated exported secrets
 * (`exportSecret`), byte-level encrypt/decrypt (`wrap`/`unwrap`), and the ledger-entry seal
 * (`sealEntries`/`openEntries`). group-rpc never imports MLS.
 *
 * TWO SEALS, not interchangeable. `wrap`/`unwrap` are ratchet-backed: each open consumes a
 * message key and mutates the handle. `sealEntries`/`openEntries` use a key DERIVED from the
 * epoch, so opening is pure and may run from inside a commit's own apply — the one place it does
 * run, and which the ratchet-backed pair cannot serve.
 *
 * `epoch()` and `exportSecret(label)` are read on init and every {@link "peer".GroupPeer.resync}.
 * `wrap`/`unwrap` close over the live group and always use current epoch state. `unwrap` returns
 * the authenticated sender (`senderDID`), REQUIRED — see {@link GroupUnwrapResult}.
 *
 * `unwrap` MUST open bytes sealed at the handle's CURRENT epoch — that is the whole requirement.
 * A real MLS handle also opens a few epochs behind (ts-mls keeps four; evicting the fifth zeroes
 * their keys), but group-rpc must NOT depend on that window: it is spent by epoch TRANSITIONS
 * rather than time, so a peer catching up destroys the very keys a past-epoch read would need.
 * Implementations that open strictly at the current epoch are correct.
 *
 * `unwrap` throwing is ORDINARY CONTROL FLOW on the read paths, not an error — it means "not my
 * epoch". Readers walk logs full of frames from epochs they don't hold and drop them without
 * treating them as corrupt.
 */
export type GroupCrypto = {
  epoch(): number
  /**
   * An MLS exporter secret for THIS epoch, domain-separated by `label`: different labels at the
   * same epoch MUST derive different bytes (a conformance clause, not a suggestion).
   *
   * `label` IS REQUIRED, deliberately: an optional/ignored label type-checks against an
   * implementation that returns identical bytes for every purpose — silent cross-domain key
   * reuse, since nothing throws or type-errors. Required fails loudly instead. Do not make this
   * optional or give it a default.
   *
   * `length` defaults to the implementation's natural export length (32 bytes for every real
   * implementation here, matching XChaCha20-Poly1305's key size) and MAY be overridden. RFC 9420
   * binds `length` into the exporter's `KDFLabel` struct (§8.5), so a same-label export at a
   * different length is an INDEPENDENT key, not a truncation or extension of the default-length
   * one.
   */
  exportSecret(label: string, length?: number): Uint8Array | Promise<Uint8Array>
  wrap: ByteTransform
  /**
   * Open a sealed app frame and recover who sent it. Returns {@link GroupUnwrapResult}, whose
   * `senderDID` is REQUIRED: an implementation that cannot name the sender must throw, not return
   * the field missing. See {@link GroupUnwrapResult} for why.
   */
  unwrap(bytes: Uint8Array): GroupUnwrapResult | Promise<GroupUnwrapResult>
  /**
   * The epoch a sealed frame was sealed at, read from its own CLEARTEXT without opening it —
   * structural and pre-open, like {@link GroupMLS.readCommitHeader} is pre-apply. `null` for
   * bytes that are not a readable sealed frame. Must NOT throw: it is asked about every frame a
   * log holds, most of which are not this handle's to open.
   *
   * WHAT IT IS FOR: `unwrap` throwing says "not my epoch" but can't say which direction. A frame
   * sealed AHEAD will open once the reader catches up; one sealed BELOW can never open again,
   * because MLS ratchets forward. A reader that can't tell these apart can't hold a durable read
   * position — passing an ahead frame loses it on restart, refusing everything pins the position
   * forever. This is what makes the app lane's cursor (see {@link "app-cursor".AppCursorStore})
   * safe.
   *
   * UNTRUSTED: it's the publisher's word, relayed by an untrusted hub. Use it only to decide what
   * to try, never to decide bytes are authentic — only `unwrap` is authoritative about opening.
   *
   * Real host: MLS carries the epoch in a PrivateMessage's cleartext; `@kumiai/mls` exports
   * `readMessageEpoch`.
   */
  frameEpoch(bytes: Uint8Array): number | null
  /**
   * Seal the ledger-entry blob a Commit carries, under a key derived from THIS epoch's exporter
   * secret. Its twin is {@link openEntries}.
   *
   * SEPARATE FROM `wrap`/`unwrap`: those consume a ratchet generation and mutate the handle on
   * open, so they can't serve an open that must run from inside the apply of the commit carrying
   * the blob. Derived-key sealing makes opening PURE — idempotent, re-entrant, no ratchet cost.
   *
   * PER-EPOCH: a different epoch derives a different key, so a removed member can't open entries
   * from a commit enacted after its removal.
   *
   * AGREED WITHOUT EXCHANGE: every member at an epoch derives the same key from state it already
   * holds — nothing transported, nothing to distribute or lose.
   *
   * The applying peer always holds the right key: a Commit is applied at the epoch it's framed
   * at, and its author sealed the blob at that same epoch (a host that has already advanced
   * cannot frame a commit) — so any peer in a position to apply it is, by construction, at the
   * sealing epoch, including a returning member replaying the log in order.
   *
   * Confidentiality from the hub is all this buys. The bodies are signed, content-addressed
   * tokens whose trust comes from their own signatures, which the MLS port re-verifies; the seal
   * authenticates nobody.
   */
  sealEntries(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>
  /**
   * Open a blob {@link sealEntries} produced at THIS epoch. Throws for bytes sealed at any other
   * epoch, for a group this member is not in, or for bytes that aren't a sealed blob — the same
   * "not mine" `unwrap` throwing means, read the same way.
   *
   * PURE: opening the same bytes twice gives the same answer and changes no handle state.
   * Callers open from inside an apply.
   */
  openEntries(sealed: Uint8Array): Uint8Array | Promise<Uint8Array>
}

/**
 * `GroupCrypto.unwrap`'s result: an opened app frame's plaintext and the AUTHENTICATED sender
 * recovered from it. rpc's OWN type, not `@kumiai/broadcast`'s `UnwrapResult` — deliberately,
 * though otherwise identical in shape.
 *
 * `senderDID` IS REQUIRED. Broadcast's `UnwrapResult` carries `senderDID?: string` because
 * broadcast also serves transports with no identity to recover; reusing it here would let an
 * implementation return a frame with no sender, and callers would silently treat
 * "unauthenticated" the same as "authenticated as nobody in particular". group-rpc's app lane is
 * always MLS-sealed, so there's no identity-less case to accommodate: a sender is either PRESENT
 * and CORRECT, or the open throws. Optional would type-check against an implementation that has
 * no sender to give and quietly returns one anyway. Do not widen this back to optional.
 */
export type GroupUnwrapResult = {
  payload: Uint8Array
  senderDID: string
}

/**
 * What a Commit says about itself, readable WITHOUT applying it and without decrypting: the
 * epoch it's framed at, its author, and whether it's an external commit. All come from the
 * commit's own bytes, never from the frame's transport sender — that's the hub's word, and the
 * hub is not trusted.
 *
 * The two facts have different trust and availability — conflating them is a defect. The epoch
 * is CLEARTEXT: keyless, readable at any epoch, only the publisher's word. The committer is
 * AUTHENTICATED: recovering it needs the epoch's sender-data secret, so it's available only for
 * a commit framed at the reader's own current epoch. A header demanding both would be unreadable
 * for every commit but the reader's own — precisely the frame a peer that fell behind must read.
 */
export type CommitHeader = {
  /**
   * The epoch the Commit is framed at — the epoch every member that can apply it is at. Always
   * present: rides the message's cleartext, needs no key.
   *
   * UNAUTHENTICATED: use only to decide what to TRY, never to decide bytes are authentic.
   * Anything that can publish to the commit topic can claim any epoch here.
   */
  epoch: number
  /**
   * The MLS-authenticated author of the Commit. Not the publisher of the frame.
   *
   * ABSENT when it cannot be authenticated — for a member commit, every epoch but the reader's
   * own, since resolving it means decrypting sender-data with the epoch secret the reader holds
   * right now. Absent means "cannot vouch for who wrote this", NEVER "no one wrote it": never
   * substitute an unauthenticated committer for a missing one.
   */
  committerDID?: string
  /**
   * Whether this Commit is an EXTERNAL commit: its committer joined the group with the commit
   * itself rather than from a leaf it already held — a rejoin.
   *
   * The app-lane anchor rotates on it and CANNOT be told any other way: a rejoin by a member the
   * roster still holds changes no DID ({@link rosterDIDs} reads the same set before and after)
   * and no occupied leaf index (the resync blanks the member's old leaf and the new one lands on
   * that same blank). Nothing a before/after diff can see moves, yet the rejoiner's fresh handle
   * would anchor where it booted while the group stayed put — so the commit has to say so itself.
   *
   * Structural and pre-apply, like its neighbours: an external commit is a public message from a
   * non-member, readable from the frame without advancing state, carrying its committer's DID in
   * its own UpdatePath leaf (it has no pre-commit leaf to resolve one from). Absent — like
   * `false` — for an ordinary member commit.
   *
   * Structural means UNAUTHENTICATED: it says what shape the frame is, never that the rejoin is
   * genuine, so it must not be read as permission for anything the committer guards.
   */
  external?: boolean
}

/** Context delivered alongside a received Commit on the raw handshake lane. */
export type CommitContext = {
  /**
   * The hub-authenticated publisher of the frame — the transport sender, NOT the
   * MLS committer. Auxiliary (logging, rate-limiting), not an authorization boundary.
   */
  senderDID?: string
  /**
   * The bodies riding this Commit's own frame: signed control-ledger tokens, sealed under the
   * epoch the Commit is framed at. Wired into the MLS handle's entry resolver for this commit's
   * duration, so named entries resolve from the frame that carries them — no prior delivery, no
   * store.
   *
   * A resolver, not a value: it opens the blob only when the port asks, for a Commit it's
   * applying — at this peer's epoch, the epoch the blob is sealed under. A frame this peer can't
   * apply never has its blob touched. Each token is bound to the id it was asked for by digest (a
   * responder can fail to answer, never inject), and yields nothing for a blob it can't open.
   */
  resolveLedgerEntries?: (ids: Array<string>) => Promise<Array<string>>
}

/**
 * The external commit that rejoins a stranded peer, BUILT and not adopted — the recovery twin of
 * {@link "commit".PendingCommit}: the derived handle is adopted only if the hub accepts the
 * commit, since a peer that adopted first sits on its own branch the moment it loses the
 * compare-and-set.
 *
 * Carries no entries — a GroupInfo has nowhere to put an entry envelope — so a heal is TWO
 * commits: this one rejoins, and the entries the peer still owes ride an ordinary `commit()`
 * behind it.
 */
export type PendingRecovery = {
  /** The external-commit bytes, framed at the epoch the sealed GroupInfo described. */
  commit: Uint8Array
  /**
   * Adopt the rejoined handle. Runs only if the hub accepts the external commit — the ONLY place
   * it may be adopted.
   *
   * The rejoined handle's ledger is EMPTY — a GroupInfo carries a head and no entries — so until
   * bootstrapped the handle is internally inconsistent: a roster reset, not a neutral one.
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
   * The DIDs this handle's ratchet tree currently holds a leaf for — one entry per leaf. Purely
   * local: reads no secret, advances nothing.
   *
   * Read around {@link processCommit} to tell a Commit that dropped a leaf from one that didn't:
   * a DID present before and absent after means a Remove was enacted (robust to a Commit
   * carrying both an Add and a Remove, where the count is unchanged), and dropping a leaf
   * rotates the app-lane anchor. Order doesn't matter — compared as a set.
   *
   * Membership only: a rejoin by a member the roster still holds changes no DID and is invisible
   * here — {@link CommitHeader.external} is what the lane rotates on for that. The two together
   * are the whole rotation rule.
   */
  rosterDIDs(): Promise<Array<string>>
  /**
   * Read what a Commit says about itself — epoch, committer, and whether it's external — WITHOUT
   * advancing state. Lets the lane classify a frame (epoch = this peer's to apply? committer =
   * this peer's own? a rejoin?) before touching it; none of those may be answered by trying and
   * failing.
   *
   * `null` means ONE thing: these bytes are not a Commit at all — undecodable, truncated, or some
   * other message kind. It does NOT mean "a Commit I could not read": the lane files `null` as
   * poison and steps over it, so a port that returned `null` for every commit framed away from
   * its own epoch would make a peer that fell behind read the group's entire future as garbage
   * and report itself fully reconciled at a dead epoch.
   *
   * If the bytes are a Commit, always return its `epoch`. Return `committerDID` only when the
   * Commit itself authenticates one — leave it ABSENT rather than guessing, never fill it from
   * the frame's transport sender.
   *
   * Async and handle-bound: a real host recovers a member commit's committer by decrypting its
   * sender-data with the epoch secret and mapping the sender leaf to a DID against the ratchet
   * tree — both reachable only on the handle the host already holds, and only for a Commit
   * framed at the epoch that handle is at. That's why the committer is optional and the epoch is
   * not. An external commit needs neither: its committer's DID rides its own UpdatePath leaf
   * (which is also what makes it recognizable as external) — but the port must still check the
   * commit's own signature before reporting a committer; it must not report one it hasn't
   * authenticated. The port reaches its own handle internally; the lane awaits.
   */
  readCommitHeader(commit: Uint8Array): Promise<CommitHeader | null>
  /**
   * Apply a received Commit and durably persist the result, returning whether the epoch advanced
   * (the signal to resync the app lane). Must be durable before it resolves.
   *
   * A frame it cannot apply is `{ advanced: false }`, NEVER a throw: a throw leaves the cursor put
   * and re-reads the frame, wedging the lane on it forever (a late joiner would wedge on its own
   * add-commit, the first frame it reads). A Commit at another epoch, or one policy refuses, is
   * also `{ advanced: false }`.
   *
   * Throws for exactly ONE outcome: a Commit it SHOULD apply but can't, because the ledger
   * entries it names won't resolve from the Commit's own frame — the only place they ride. The
   * lane does NOT retry (no member at that epoch could resolve them either) and treats it as
   * POISON: cursor advances, never re-read. This distinguishes that case from a port that broke
   * contract on a frame it should have applied, which the lane DOES re-read. See
   * {@link isMissingLedgerEntries}.
   */
  processCommit(commit: Uint8Array, context: CommitContext): Promise<{ advanced: boolean }>
  /**
   * Mint the rendezvous request this peer publishes to ask the group for its state: an HPKE
   * keypair for this one request, public half in a token signed by this member's identity key.
   * The private half is retained by the port keyed by `requestID`, making the reply openable by
   * this peer alone. Minted per request, not from the leaf, because the peers that most need a
   * heal (commit accepted and lost, on a discarded branch) no longer hold a leaf key the group
   * can see.
   *
   * The port MUST bound retention of the private half itself — the lane has no release hook. A
   * timed-out gather/rejoin or a failed `recover()` drops its `requestID` on the rpc side without
   * telling the port, so a port that only evicts on reply-open leaks one key per timeout. A TTL
   * off the mint time is the natural bound; it lives here rather than as a new lane release
   * method that would obligate every {@link GroupMLS}.
   */
  createRecoveryRequest(requestID: string): Promise<Uint8Array>
  /**
   * Answer another member's request: verify the token, check the requester still holds a leaf in
   * THIS member's current ratchet tree, seal current GroupInfo to the ephemeral key inside the
   * signed request, AND vouch for it with a membership attestation signed by this member's DID
   * key, binding the group, the request, and the exact GroupInfo bytes. The seal itself is HPKE
   * base mode and authenticates no one; the attestation is what lets the requester tell this
   * member's reply from an observer's forgery.
   *
   * Authorization is roster-intrinsic: a removed member gets nothing from any responder that has
   * applied its removal. Throws for a request it refuses; the peer stays silent.
   */
  sealGroupInfo(request: Uint8Array): Promise<Uint8Array>
  /**
   * Open a sealed reply with the key minted for `requestID` and BUILD the external commit that
   * rejoins this peer. Non-mutating: the rejoined handle is adopted only in
   * {@link PendingRecovery.onAccepted}, because the commit still has to win a compare-and-set at
   * the head.
   *
   * `null` for bytes this peer cannot open OR cannot trust. HPKE base mode needs only the
   * requester's public ephemeral key, which rides the public request in the clear — so a
   * hub-injected or observer-forged reply may DECRYPT. What refuses it: the responder must sign
   * the reply with its DID key (the signer must hold a leaf in this peer's last-known tree), and
   * the offered GroupInfo's group id and genesis anchor must match the group being healed. A
   * reply the AEAD refuses, or one that fails either check, is `null`; a throw is tolerated and
   * read the same way.
   */
  applyRecovery(sealed: Uint8Array, requestID: string): Promise<PendingRecovery | null>
  /**
   * Whether the ledger this handle holds is the whole ledger its OWN GroupContext attests to: the
   * head folded from the entries it holds, against the authenticated head it carries. Purely
   * local. False means incomplete — {@link bootstrapLedger} must run before this handle can be
   * trusted to fold a roster or judge an incoming commit. A handle that rejoined by external
   * commit reads false: empty ledger against a live, non-genesis head.
   */
  isLedgerComplete(): Promise<boolean>
  /**
   * The WHOLE ordered ledger this handle holds, as signed tokens — what a peer about to rejoin
   * snapshots as entries it may still owe, and filters its re-enactment against once the group's
   * ledger is back. Purely local, never on the wire (a responder uses {@link sealLedger}).
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
   * Same roster-intrinsic authorization as {@link sealGroupInfo}, not a nicety: the ledger is the
   * group's whole authority state on a public secretless topic, and a responder that sealed
   * without checking would hand every role and promotion to any stranger who minted a request.
   * Throws for a request it refuses; the peer stays silent.
   *
   * The seal is EPOCH-INDEPENDENT and must remain so: the requester can be at an older epoch than
   * every responder (it crashed between rejoin and bootstrap, and the lane gathers before it
   * pulls), and a reply sealed under the responder's current epoch would be unopenable by it.
   */
  sealLedger(request: Uint8Array): Promise<Uint8Array>
  /**
   * Open a sealed gather reply with the key minted for `requestID`, returning the responder's
   * whole ordered ledger as signed tokens.
   *
   * `null` when the AEAD refuses the bytes. It does NOT prove the sealer was a member: unlike the
   * GroupInfo reply, the ledger reply carries no attestation, and HPKE base mode authenticates no
   * one, so an observer of the request can forge a reply that decrypts. The key is NOT consumed:
   * every responder answers, and the requester must open the next reply after dropping one.
   *
   * Opening proves NOTHING about who sealed the tokens. The bound is {@link bootstrapLedger}'s
   * head check: a reply reproducing this group's authenticated head is its whole ledger in order;
   * a forged, lying, reordered or truncated one fails and is dropped — withhold, never rewrite. A
   * forged reply that merely decrypts costs one gather attempt: denial of service, not compromise.
   */
  openSealedLedger(sealed: Uint8Array, requestID: string): Promise<Array<string> | null>
  /**
   * Install a gathered ledger, verified against the authenticated head BEFORE a single entry is
   * folded. REPLACES the ledger this handle holds — sound because a list reproducing the head
   * this handle's own GroupContext carries IS the group's entire ledger, in order.
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
 * member at that epoch can — nobody applies the commit, and the next honest commit is framed at
 * the same epoch and compare-and-sets behind it. Everything else the port says about a frame it
 * will not apply is `{ advanced: false }`, poison on the same terms.
 *
 * Matched by NAME, not class: the port is consumer-supplied and its error type is not this
 * package's to import. An error named anything else is treated as an unknown failure — so the
 * name is contract.
 */
export function isMissingLedgerEntries(error: unknown): boolean {
  return error instanceof Error && error.name === 'MissingLedgerEntriesError'
}
