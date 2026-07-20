import type { ByteTransform } from '@kumiai/broadcast'

/**
 * Consumer-supplied MLS crypto port: epoch number, as many epoch-bound, domain-separated
 * exported secrets as callers have labels for (`exportSecret`), byte-level encrypt (`wrap`) and
 * decrypt-plus-recover-sender (`unwrap`), and the ledger-entry seal (`sealEntries`/
 * `openEntries`). group-rpc never imports MLS.
 *
 * TWO SEALS, and they are not interchangeable. `wrap`/`unwrap` carry app traffic and are
 * ratchet-backed: each open consumes a message key and mutates the handle. `sealEntries`/
 * `openEntries` carry a commit's ledger-entry blob under a key DERIVED from the epoch, so
 * opening is pure and may run from inside the apply of the commit that carries it — which is the
 * only place it does run, and which the ratchet-backed pair cannot serve.
 *
 * `epoch()` and `exportSecret(label)` are read on init and every {@link "peer".GroupPeer.resync}.
 * `wrap`/`unwrap` close over the live group, so they always use current epoch state. `unwrap`
 * returns the authenticated sender (`senderDID`) recovered from the ciphertext, and REQUIRES one
 * — see {@link GroupUnwrapResult}.
 *
 * WHAT `unwrap` MUST OPEN, and what group-rpc must never ask of it: it must open bytes sealed at
 * the handle's CURRENT epoch. That is the whole requirement. A real MLS handle also opens a few
 * epochs BELOW the current one — ts-mls keeps four, and evicting the fifth zeroes its key
 * material — but group-rpc must not depend on that window, and does not: it reads every retained
 * frame at the epoch its ciphertext was sealed at, ahead of the commit that would ratchet the
 * handle past it. The window is spent by epoch TRANSITIONS rather than by time, so a peer
 * catching up destroys the very keys a past-epoch read would need — a member away four commits
 * could read and a member away a week could not. Leaning on it would make correctness turn on how
 * far behind a peer happened to fall.
 *
 * So `unwrap` throwing is ORDINARY CONTROL FLOW on the read paths, not an error: it is how a
 * frame says "not my epoch". Every reader here walks logs full of frames from epochs it does not
 * hold — a late joiner reaches the commit that added it — and drops them without calling them
 * corrupt. An implementation that opens strictly at the current epoch is a correct implementation
 * of this port.
 */
export type GroupCrypto = {
  epoch(): number
  /**
   * An MLS exporter secret for THIS epoch, domain-separated by `label`. There is not one
   * "the" exported secret — there are as many as there are labels, each epoch-bound the same
   * way, and each independent of every other: two different labels at the same epoch MUST
   * derive different bytes (that is what "domain-separated" means operationally, and it is a
   * conformance clause, not a suggestion).
   *
   * `label` IS REQUIRED, and that is the entire point of this signature rather than an
   * accident of it. An optional label type-checks against an implementation that ignores it —
   * every implementation before this one did — and such an implementation returns identical
   * bytes for every purpose that calls this method: the app-lane topic secret, and anything
   * else this port is ever asked to export, would silently collide on one key, so holding one
   * is holding the other. That is cross-domain key reuse, and it is SILENT: nothing throws,
   * nothing type-errors, callers get bytes back and move on. Required is the only shape that
   * fails loudly — a caller that forgets to pass a label gets a compile error, not a working
   * program with a latent key-reuse bug. Do not make this optional and do not give it a
   * default; the next reader who does either has reintroduced exactly this.
   *
   * `length` defaults to whatever the implementation considers its natural export length
   * (32 bytes for every real implementation in this repo, matching XChaCha20-Poly1305's key
   * size) and MAY be overridden — RFC 9420's exporter binds `length` into the `KDFLabel`
   * struct it runs `ExpandWithLabel` over (§8.5), not merely into HKDF-Expand's own output-length
   * argument, so a same-label export at a different length is itself an independent key, not a
   * truncation or extension of the default-length one. (Plain HKDF-Expand alone would not buy
   * this — a shorter output IS a prefix of a longer one under the same info; it is `KDFLabel`
   * binding `length` into the input that makes the two lengths independent.)
   */
  exportSecret(label: string, length?: number): Uint8Array | Promise<Uint8Array>
  wrap: ByteTransform
  /**
   * Open a sealed app frame and recover who sent it. Returns {@link GroupUnwrapResult}, whose
   * `senderDID` is REQUIRED — deliberately narrower than `@kumiai/broadcast`'s own `Unwrap`, whose
   * `UnwrapResult` carries `senderDID?: string` because broadcast serves transports with no
   * identity at all. group-rpc's app lane is always MLS-sealed, so there is no identity-less case
   * for this port to accommodate: an implementation that cannot name the sender has not opened the
   * frame, and must throw rather than return one with the field missing. See
   * {@link GroupUnwrapResult} for why optional was rejected here for the same reason it was
   * rejected on `exportSecret`'s `label`.
   */
  unwrap(bytes: Uint8Array): GroupUnwrapResult | Promise<GroupUnwrapResult>
  /**
   * The epoch a sealed frame was sealed at, read from its own CLEARTEXT without opening it —
   * structural and pre-open, like {@link GroupMLS.readCommitHeader} is pre-apply. `null` for bytes
   * that are not a readable sealed frame (garbage, truncated). It must NOT throw: it is asked about
   * every frame a log holds, most of which are not this handle's to open.
   *
   * WHAT IT IS FOR: `unwrap` throwing says "not my epoch" and cannot say WHICH not-my-epoch. A
   * frame sealed AHEAD of a reader that is walking forward will open once the walk gets there; a
   * frame sealed BELOW it can never be opened again, because MLS ratchets forward. Those are the
   * same exception. A reader that cannot tell them apart cannot hold a durable read position:
   * passing a frame it has merely not reached yet loses it on the next restart, and refusing to
   * pass anything pins the position forever. This is the distinction, and it is what makes the app
   * lane's cursor (see {@link "app-cursor".AppCursorStore}) safe.
   *
   * It is the frame's word — which is to say the PUBLISHER's, carried in the clear and relayed by
   * an untrusted hub — never the handle's, so it may only be used to decide what to try and what to
   * pass, never to decide that bytes are authentic. Only `unwrap` is authoritative about opening,
   * and a frame that claims this handle's epoch and will not open is treated as any other frame
   * that will not open.
   *
   * One line for a real host: MLS carries the epoch in a PrivateMessage's cleartext, and
   * `@kumiai/mls` exports `readMessageEpoch`.
   */
  frameEpoch(bytes: Uint8Array): number | null
  /**
   * Seal the ledger-entry blob a Commit carries, under a key derived from THIS epoch's exporter
   * secret. Its twin is {@link openEntries}.
   *
   * SEPARATE FROM `wrap`/`unwrap`, and that separation is the whole point. A blob sealed as an
   * application message is opened by `unwrap`, and `unwrap` on a real handle CONSUMES a ratchet
   * generation and mutates the handle's state. The entry blob is opened from inside the apply of
   * the commit that carries it — the MLS port asks for the bodies while it holds the handle — so
   * an open that mutates is unsound there however it is scheduled, and against a handle that
   * serializes its own state it does not even complete. Derived-key sealing makes opening PURE:
   * idempotent, re-entrant, and costing no ratchet generation, so the question of when it is safe
   * to open stops existing rather than being managed.
   *
   * PER-EPOCH, and required to be: a different epoch derives a different key, which is the same
   * property the app-lane anchor rests on. A removed member must not open the entries of a commit
   * enacted after its removal, and an epoch-independent key would hand it every one of them for
   * life.
   *
   * AGREED WITHOUT EXCHANGE: every member at an epoch derives the same key from state it already
   * holds. Nothing is transported, and there is no key to distribute or lose.
   *
   * WHY THE APPLYING PEER ALWAYS HOLDS THE RIGHT KEY, which is the load-bearing argument: a Commit
   * is applied at the epoch it is framed at, and its author sealed the blob at that same epoch (a
   * host that has already advanced cannot frame a commit — see the peer's own check). So a peer in
   * a position to apply the Commit is by construction at the epoch the blob was sealed under —
   * including a returning member replaying the commit log in order, which reaches each commit at
   * its own framed epoch.
   *
   * Confidentiality from the hub is all this buys. The bodies are signed, content-addressed
   * tokens whose trust comes from their own signatures, which the MLS port re-verifies; the seal
   * authenticates nobody and is not asked to.
   */
  sealEntries(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>
  /**
   * Open a blob {@link sealEntries} produced at THIS epoch. Throws for bytes sealed at any other
   * epoch, for a group this member is not in, and for bytes that are not a sealed blob — the same
   * "not mine" that `unwrap` throwing means, and read the same way.
   *
   * PURE, and the port may not implement it otherwise: opening the same bytes twice gives the same
   * answer and changes no handle state. Callers open from inside an apply.
   */
  openEntries(sealed: Uint8Array): Uint8Array | Promise<Uint8Array>
}

/**
 * `GroupCrypto.unwrap`'s result: an opened app frame's plaintext and the AUTHENTICATED sender the
 * open recovered from it. rpc's OWN type, not `@kumiai/broadcast`'s `UnwrapResult` — deliberately,
 * even though the two are otherwise identical in shape.
 *
 * `senderDID` IS REQUIRED, and that is the entire point of this type rather than an accident of
 * it — the same argument `exportSecret`'s `label` makes, aimed at the same failure. Broadcast's
 * `UnwrapResult` carries `senderDID?: string` because broadcast also serves transports that open
 * bytes with no identity to recover at all; reusing it here would let an implementation return a
 * frame with no sender and every caller downstream would silently treat "unauthenticated" the same
 * as "authenticated as nobody in particular". group-rpc's app lane is always MLS-sealed — there is
 * no identity-less case for it to accommodate — so any future rpc-level authorization needs a
 * foundation it can actually build on: a sender that is either PRESENT and CORRECT, or a throw.
 * Optional would type-check against exactly the implementation that has no sender to give and
 * quietly returns one anyway; required is the only shape that fails loudly. Do not widen this back
 * to an optional field; the next reader who does has reintroduced the hole `exportSecret`'s `label`
 * was made required to close.
 */
export type GroupUnwrapResult = {
  payload: Uint8Array
  senderDID: string
}

/**
 * What a Commit says about itself, readable WITHOUT applying it and without decrypting: the
 * epoch it is framed at, its author, and whether it is an external commit. All classify a frame
 * before the peer touches it, and all come from the commit's own bytes, never from the frame's
 * transport sender — that is the hub's word, and the hub is not trusted.
 *
 * **The two facts have different trust and different availability, and conflating them is a
 * defect.** The epoch is CLEARTEXT: keyless, readable at any epoch, and only the publisher's
 * word. The committer is AUTHENTICATED: recovering it needs the epoch's sender-data secret, so
 * it is available only for a commit framed at the reader's own current epoch. A header that
 * demanded both would be unreadable for every commit framed anywhere but here — which is
 * precisely the frame a peer that fell behind must be able to read.
 */
export type CommitHeader = {
  /**
   * The epoch the Commit is framed at — the epoch every member that can apply it is at. Always
   * present: it rides the message's cleartext and needs no key.
   *
   * UNAUTHENTICATED, and it must only be used to decide what to TRY, never to decide that bytes
   * are authentic. Anything that can put a frame on the commit topic can claim any epoch here.
   */
  epoch: number
  /**
   * The MLS-authenticated author of the Commit. Not the publisher of the frame.
   *
   * ABSENT when it cannot be authenticated — for a member commit, that is every epoch but the
   * reader's own, since resolving it means decrypting the commit's sender-data with the epoch
   * secret the reader holds right now. Absent is "I cannot vouch for who wrote this", NEVER "no
   * one wrote it": a reader must not substitute an unauthenticated committer for a missing one,
   * and no row that turns on authorship may fire without it.
   */
  committerDID?: string
  /**
   * Whether this Commit is an EXTERNAL commit: its committer joined the group with the commit
   * itself rather than from a leaf it already held — a rejoin.
   *
   * The app-lane anchor rotates on it, and CANNOT be told any other way. A rejoin by a member
   * the roster still holds changes no DID, so {@link rosterDIDs} reads the same set before and
   * after; it changes no occupied leaf index either, because the resync blanks the member's old
   * leaf and the new one lands on the leftmost blank — the leaf it just blanked. Nothing a
   * before/after diff can see moves, and the rejoiner's fresh handle would anchor where it
   * booted while the group stayed put. So the commit has to say so itself.
   *
   * Structural and pre-apply, like its neighbours: an external commit is a public message from a
   * non-member carrying a commit, which is readable from the frame without advancing state, and
   * carries its committer's DID in its own UpdatePath leaf (the committer has no pre-commit leaf
   * to resolve one from). Absent — like `false` — for an ordinary member commit.
   *
   * Structural means UNAUTHENTICATED, and this flag is reported on a frame whose committer did
   * not authenticate. It says what shape the frame is, never that the rejoin it describes is
   * genuine — so it must not be read as permission for anything the committer guards.
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
   * The DIDs this handle's ratchet tree currently holds a leaf for — the members
   * `GroupHandle.listMembers()` would report, one entry per leaf. Purely local, reads no
   * secret and advances nothing.
   *
   * Read around {@link processCommit} to tell a Commit that dropped a leaf from one that did
   * not: a DID present before applying and absent after means a Remove was enacted (robust to
   * a Commit carrying both an Add and a Remove, where a count is unchanged), and a commit that
   * drops a leaf rotates the app-lane anchor. Order is not significant — the lane compares as a
   * set.
   *
   * It answers for membership and nothing else. A rejoin by a member the roster still holds
   * changes no DID and is invisible here, by construction — {@link CommitHeader.external} is
   * what the lane rotates on for that, and the two together are the whole rotation rule.
   */
  rosterDIDs(): Promise<Array<string>>
  /**
   * Read what a Commit says about itself — epoch, committer, and whether it is external —
   * WITHOUT advancing state. Lets the lane classify a frame (epoch = this peer's to apply?
   * committer = this peer's own? a rejoin?) before touching it; none of those may be answered by
   * trying and failing.
   *
   * `null` means ONE thing: **these bytes are not a Commit at all** — undecodable, truncated, or
   * a message of some other kind. It does NOT mean "a Commit I could not read", and returning it
   * for one is the bug this contract exists to forbid: the lane files `null` as poison and steps
   * over it, so a port that answered `null` for every commit framed away from its own epoch
   * would make a peer that fell behind read the group's entire future as garbage, walk to the end
   * of the log, and report itself fully reconciled at a dead epoch.
   *
   * So: if the bytes are a Commit, return its `epoch`. Return `committerDID` only when the Commit
   * itself authenticates one — leave it ABSENT rather than guessing, and never fill it from the
   * frame's transport sender.
   *
   * Async and handle-bound: a real host recovers a member commit's committer by decrypting
   * its sender-data with the epoch secret (an open, not an apply) and mapping the sender leaf
   * to a DID against the ratchet tree — both reachable only on the handle the host already
   * holds, and both only for a Commit framed at the epoch that handle is at. That is exactly why
   * the committer is optional and the epoch is not. An external commit needs neither secret nor
   * tree — its committer's DID rides its own UpdatePath leaf, which is also what makes it
   * recognizable as external — but it is NOT exempt from authenticating: the credential carrying
   * that DID is a plain field, so the port must check the commit's own signature before reporting
   * a committer, and that check needs the group context of the epoch the commit was framed at.
   * Same reach as the member path, reached differently. A port that reported an external
   * committer it had not checked would let anything that can publish choose who a frame is from.
   * The port reaches its own handle internally; the lane awaits.
   */
  readCommitHeader(commit: Uint8Array): Promise<CommitHeader | null>
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
