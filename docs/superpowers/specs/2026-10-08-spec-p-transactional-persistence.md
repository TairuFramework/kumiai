# Spec P: transactional persistence — design

Date: 2026-10-08
Status: draft r28 (2026-10-22)
Parent: [client host, messaging protocol and multi-device e2e](2026-10-08-client-messaging-e2e-design.md)
Control baseline: [Spec P2a](2026-10-08-spec-p2a-crash-safe-control-design.md), superseded where amended here.

## Model

**Trust (r24 decision).** The hub is blind: one append-only log per topic, CAS on head, opaque bytes.
It may withhold, delay, reorder, replay or selectively deliver bytes. Non-delivery is accepted and undetectable in-band.
Peers are trusted in intent but may be buggy. No single peer may roll the group back or steer it.
The continuing branch is whatever log the hub keeps. Checkpoints supply no continuation authority.
The hub cannot forge MLS content. Drop, delay, reorder, replay, byte tampering, junk and unknown frame versions mean non-delivery.
Skip or diagnose such frames. Never derive a durable halt/hold, discard, rebuild, owed-work (outcomes, Welcome obligations) deletion or permanent stranding from them.
Detection-only in-band checkpoints reveal attributed conflicting views within retained coverage. They never select a winner, halt or switch.
Full partition, withholding and expired comparison history can prevent detection. Local export/import/verification supports later out-of-band comparison.
Host reportFork/authenticator comparison and genuinely local storage invariants retain their halt contracts.
See [RFC 9750 §5.2–5.2.1](https://www.rfc-editor.org/rfc/rfc9750.html#section-5.2).
1. **Incarnation monotonicity (r14 decision).** Key local state by `(groupID, incarnation)`.
   Epochs never decrease or change same-number authenticator; recovery atomically installs `n+1` and tombstones `n`.
   This removes in-place rollback, recovery progress merges and anchor ordinals.
   Recovery lineage and the attempt-scoped floor exception below never change an installed incarnation in place.
2. **Commit-once (r14 decision).** Durably save exact control bytes, publishID and candidate before publication.
   Head-only retries reuse them. Ordinary builds resume only after epoch change.
   (r28) The device's own in-order adoption of the commit log is the only settlement authority for a build; a hub acknowledgement is retry evidence.
   A build lives until the authenticated transaction that consumes its source epoch settles it, or until retirement or `abandon()` closes it (D4).
   (r28c) Own frames never advance state through received-commit application; a recognised own occurrence of a live build installs the saved candidate.
   Restricted different-branch recovery creates a new bound attempt, never an in-place rebuild.
   This removes handshake reservations, burn budgets, baseline readers and staging-clone rules (the client-state codec's v2 flags field still carries `main`'s reservation fields, D5 r28e).
3. **One transaction per transition (r14 decision).** All affected group namespaces share one provider transaction.
   Bounded adaptive batches amortise commits and release the group scope between batches.
   This removes internal cross-store ordering seams and chat-specific coordination.

This is a proposed contract, not an implementation claim. Phase 2 supplies memory doubles and conformance;
phase 3 supplies database providers. P2a remains the control stage machine, with the amendments below.

## Decisions

### D1. Detection, durable halt and recovery (r24)

Keep `onStrand` observations and their confidence. Classify evidence before selecting recovery:

| Observation                                                                | Action                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Competing past-epoch commit digest divergence, on either classifier branch | diagnostic poison; skip, never halt or frame-trigger automatic resync                                                                                                                                                                                                                                                                                                                            |
| Host reports different authenticators for the same group/epoch             | durable fork halt                                                                                                                                                                                                                                                                                                                                                                                |
| `own-unmerged` | recognise saved own work (exact bytes or the receiver predicate), never apply it as a received commit; a recognised occurrence installs the saved candidate (D4 r28c). An unrecognised, altered or failed named-entry copy is non-delivery: atomically advance the skipped cursor, set `skipped` with explicit `retryForbidden: false` unless a prior prohibition already applies, and keep the build live; identical saved bytes/ID may republish under D4 r28i. With no live build at that epoch (after `abandon()` or closure), diagnose/skip and keep the spent marker. |
| `ahead`, retention gap or unprocessable gap, without a local safety hold | catch up or inspect authenticated recovery state with bounded retry; delivery claims alone never authorise destructive retirement of a live build. Automatic recovery that would retire its source requires request-bound, MLS-verified member-signed GroupInfo for the same group at F > the build's source E, then normally confirmed recovery and source revalidation (D4 r28i). A delivery fault never permanently strands the device. |
| Unknown/unsupported commit-frame or handshake-header version               | diagnostic poison plus `upgrade-required` host diagnostic; skip, never create a durable hold                                                                                                                                                                                                                                                                                                     |
| Lost MLS state, retained recovery trust readable                           | stranded; automatic resync (r16 decision)                                                                                                                                                                                                                                                                                                                                                        |
| Recovery trust also missing/unreadable                                     | retain `recovery-unavailable`; no automatic reconstruction; manual fresh invitation or admitted successor                                                                                                                                                                                                                                                                                        |
| Eligible unequal checkpoint testimony                                      | detection-only fork notice; never halt, discard, rebuild, strand or switch                                                                                                                                                                                                                                                                                                                       |
| Request-bound authenticated roster absence                                 | non-terminal `not-member`; existing admission rules and capped-backoff recovery continue                                                                                                                                                                                                                                                                                                         |
| Successfully decoded trust envelope with missing/malformed spent set       | durable `spent-set-corrupt`; refuse admission, never substitute an empty set                                                                                                                                                                                                                                                                                                                     |

**Delivery faults (r19 decision, Q0/Q1).** Competing past-epoch commits, including refused signed CAS losers, are diagnostic poison on both classifier branches.
Skip with claimed `past-epoch-divergence` observation. Advance the skipped cursor without applied rewrite, fork event/latch or frame-triggered resync.
Own-slot mismatches also skip/advance cursor, preserving saved work; the walker is the only reader that settles a build (D4 r28).
Unconfirmed recovery acceptance (a rejoin-X state, D1 below; not a control hold) permits authenticated recapture with bounded retry. Ordinary live builds permit identical bytes/ID at a fresh head after a refused handoff or coverage-only skip, with unchanged incarnation/epoch/authenticator and effective retry prohibition false (D4 r28h).
Neither condition becomes a durable safety hold. An unrecognised/tampered ordinary own-copy frame means non-delivery, never lost/absent/superseded.
Commit-once retry is idempotent. Unresolved deadline outcome is unknown.
No encoding, unsigned tag, sealed-entries blob, padding, position or frame-version difference supplies adverse acceptance evidence.
Audit peer/classify, control slot/operations/store, the walker's own-occurrence path, mls-rpc control-validation/safety and registry producers, including their catch mappings.
Only host reports/authenticator comparisons and genuine local storage inconsistency can produce new durable safety halts.
The slot's and the walker's trusted local committed-identity comparisons remain local-invariant halts.
Fresh responder authenticator disagreement is a diagnostic retry, not a local-invariant halt.
Existing persisted halts/unsupported-version holds remain readable. Evidence stays immutable.
Only the provenance-restricted clearHold or completed manual retirement below can release applicable holds. Legacy control-record version holds retain their separate policy.
Unsupported sealed-entries outer/inner versions propagate through crypto/resolver/walker as poison plus upgrade-required diagnostics, advancing cursor without strand/heal.
HEAD packages/mls-rpc/src/crypto.ts:76-84,200-209 -> packages/rpc/src/ledger-entries.ts:104-117 -> packages/rpc/src/peer.ts:1897-1930.
Tasks 5a-5e own complete HEAD behavioural closures. Each unit changes implementation and conflicting assertions together, preserving restart/history/outcomes/Welcomes.
Historical task labels: 5a owned past divergence, 5b own/search contradictions, 5c frame/blob versions, 5d real validation/local registry guards and 5e app bounds.
Every unit runs Control/Safety/full Port gates, both contract families on real implementations and doubles. Task 5c precedes Task 8a ledger-entries changes. Task 8b separately owns negative refusalAuthority through wire/replay/cache.
Missing/unreadable retained local trust remains recovery-unavailable. Delivered bytes and provider/configuration failures cannot manufacture that condition.
Already owed outcomes/Welcomes and source history remain serviceable. Independently MLS-validated applied state may settle work normally.

**Applied-state settlement authority (r19 decision, Q3/P0).** Authenticated applied state decides whether recovery attempt X was applied.
Authenticate responder GroupInfo and its signed epoch/authenticator/tree. Compare X's exact fresh cryptographic LeafNode, never DID/index alone.
Later epoch with X's exact wire-encoded fresh LeafNode present means accepted -> settled. Adopt X only with existing bound confirmation.
Fast path: known position from publish ack/exact-byte hit, and an authenticated responder still at epochAfter, permits bound confirmation/adoption of X.
Otherwise settle X as accepted-unadoptable in ONE ControlStore transition: save compact public X facts/cumulative ledgerBefore in settledRejoins, clear active rejoin and raise recoveryEpochFloor.
Ordinary settlement omits request/requestKey/candidate/payload. Superseded-branch settlement instead retains sealed exact-X history as specified below.
Zeroise owned secret buffers only after settlement commit proof, respecting retained history ownership.
Keep at most one cumulative settlement row per source incarnation. Later settlements replace public provenance and union prior obligations.
r23: D1 leaf-absent discard of unconfirmed X uses the same settledRejoins row in ONE transition: provenance `{kind:'not-accepted', epoch}` (authenticated recapture
epoch, no accepted facts), cumulative ledgerBefore unioned, active rejoin cleared, recoveryEpochFloor raised. Y's first save unions every settled obligation.
Carry ledgerBefore forward, as HEAD packages/rpc/src/peer.ts:3533 does. Restart retains settled X and its owed obligations before constructing Y.
Build fresh Y at the recaptured epoch. Y's Remove targets X's sole same-identity leaf under normal replacement admission.
X is frameCommit(pending.commit, [], null) (peer.ts:3823), enacting nothing. Reenact tokens are computed only after Y bootstrap (control/rejoin.ts:217-223).
Never rebuild X at its capture epoch or label accepted X unapplied/absent. No new ResyncProof arm, applied-state proof or candidate-codec/registry-verifier change.
No responder lookup without a known position. Bound confirmation retains its non-null position and original exporter tuple.
Equal capture epoch/authenticator means the responder prefix lacks X. Retry identical saved bytes/ID/candidate at its fresh authenticated captureHead.
Later epoch with X's leaf absent permits authenticated non-acceptance discard/build, including applied-then-removed, subject to removal/admission policy (r18:66,128).
An already accepted/confirmed X instead retains its accepted settlement. Local switch rollback never proves remote non-acceptance.
Same epoch/different authenticator means diagnostic retry/recapture, without forkHalt or durable hold.
Log search is a confirmation hint. Absence, mismatches, gaps and junk never authorise discard or prevent recapture.
Recapture uses fresh requestID/requestKey outside X's immutable record, with backoff bounded at 15 seconds.
Hub-assigned head strings may regress or be inflated. Head regression is diagnostic only, never a refusal or permanent strand.
Same epoch/authenticator retries at fresh authenticated captureHead even when lower. Null denotes the captured empty prefix.
Persist a monotone recoveryEpochFloor independently of X. First save of X co-writes its authenticated capture epoch.
Leaf-absent discard and R0 settlement raise it to the authenticated recaptured epoch in their pointer transition. Restart preserves the stored maximum.
Reject lower epochs without deleting X, except through the bound forkRecovery authorisation below.
The ordinary stored floor stays monotone even while one attempt has an effective floor E.
Busy groups may repeatedly accept X then advance before confirmation, causing accepted-unadoptable churn. This non-hub liveness residual remains explicit.
Never build a second external attempt at one capture epoch on the same lineage.
The restricted different-branch forkRecovery predicates below permit lower/equal-number captures without rebuilding saved X.

**Own-commit recognition (r19 decision, Q2/P1).** Keep existing digest fields, payloadDigest, stored shapes and frame version.
Exact bytes provide positive evidence. A mismatch means nothing learned, never absence, supersession, refusal or permission to rebuild.
One helper decodes then re-encodes the MLS-message commit half and hashes it. Malformed input returns null, never a fatal encoding exception.
Match saved/delivered helper results only when both are non-null. Reconstruction serves recognition only, never application or publication.
No-entry commits ignore blobs on author and receiver. Re-encoded/blob-changed copies can therefore recognise saved work.
Named-entry commits use the receiver's own resolver/reference-verification predicate under retained pre-state, never MLS receive processing (D4 r28c).
A different blob that passes that predicate can recognise saved work. Failed delivered-copy verification only skips/advances cursor with coverage uncertainty, persists explicit `retryForbidden: false` unless a prior prohibition applies, and keeps the build live; identical saved bytes/ID remain eligible under D4 r28i. Provider exceptions retain their local failure policy.
Recognition installs the saved candidate; first-valid proof with complete coverage gates `landed` and Welcome release (D4 r28c). Saved payloadDigest binds saved work after recognition, without schema migration.
No canonical intake gate, identity-version migration, equivalence taxonomy or competitor-authentication API is introduced.
Only refusal of the authenticated commit itself authorises terminal negative verdicts.
Transport/blob/framing/unsigned-field/copy-eligibility failures remain advisory, including verdict caches.
Refusals are computed on request, never persisted (r20 decision). A refusal does not advance state, so a stored refusal keyed by hub-assigned
position is hub-controlled data: its count, keys and position strings are unbounded. Applied responses stay stored; they advance the epoch and are bounded by it.
Unproven superseded verdicts never authorise recovery discard. Applied-state settlement authority independently decides later-epoch non-acceptance.
Confirmed verdicts retain saved request, digest/position and candidate-derived tag binding.
Origin-authorised signers removed after origin retain attestation authority, including signed floor inflation. This residual lies outside the hub threat model.

**Fork halt (r24 provenance amendment).** Immediately hold the runtime while committing the halt, evidence and a stable-ID
machine-readable `group:fork` event in one group transaction. Failure/ambiguity keeps the runtime held.
New ForkHalt records carry `producer: 'app-report' | 'internal'`. Event IDs never imply ownership.
After proven commit emit the event; replay until acknowledged. Event acknowledgement never clears the halt.
Block durable and ephemeral sends, new opens, control enqueue/build/adoption/publication and automatic recovery, live and after restart.
Already opened handlers may finish; storage-only outcomes/events and certified settlement remain serviceable.
Keep local history. Do not choose a winning branch, erase evidence or automatically reenact fork-touched operations.
Already handed-off network bytes cannot be recalled. Restart loads the halt before enabling any network work.

Expose defensive committed `{groupID, incarnation, epoch, authenticator}` copies. Host comparisons/halt reports require the same MLS group/epoch. Consistently
isolated views evade local checks; differing epochs alone prove no fork.

**Automatic stranded resync (r14 decision).** Obtain an authenticated, member-signed GroupInfo through the existing
sealed reply. Verify its group, signature/tree, credentials, binding/holder evidence and replacement policy.
Create a fresh leaf and external commit with `Remove(own old leaf) + ExternalInit`, using
[RFC 9420 §12.4.3.2](https://www.rfc-editor.org/rfc/rfc9420.html#section-12.4.3.2).
A reused leaf index does not reuse secrets: the candidate has a fresh secret tree, generations from zero and no old history.
A removed device cannot use resync to bypass admission; absence of its matching old leaf requires a new invitation.
**Retained recovery trust (r16 decision).** A separately sealed group-level record survives incarnation retirement and state-byte corruption.
Every genesis/Welcome/commit/resync installation co-writes its immutable genesis anchor, last-known public signer tree, membership/registry,
credential, binding, ordered ledger, cipher suite, installed identity and spent-authenticator set. Progress saves preserve it.
Request creation, reply authentication and candidate restoration take this record plus host identity/policy, never a fabricated GroupHandle.
The tree and anchor supply the checks at `packages/mls/src/recovery.ts:658`, `:675`; lifecycle signer judgement retains registry floors/denials.
Unreadable state alone permits automatic resync. Missing/unreadable trust forbids it: persist a hold and stable `group:recovery-unavailable` event.
Safety-only transitions can write the hold/event without opening state/trust. No automatic reconstruction from untrusted GroupInfo exists. Recovery requires manual fresh invitation or retirement to an already admitted successor. Event ack cannot lift the hold. Backup restore remains subject to its declaration.

**GroupInfo capture head (r15 decision).** The responder reconciles a complete commit-log prefix before capturing its reply. Under its group owner gate, capture the
committed MLS snapshot and that prefix's cursor together. `captureHead: string | null` names the reconciled commit prefix where GroupInfo is current; null means
empty, never delivery/unreconciled head.

Add required captureHead and groupInfoAuthenticator to the signed responder attestation's JWT payload.
The authenticator is the captured committed epoch authenticator, canonical unpadded base64url with decoded length equal to the suite's KDF size.
It is not derivable from public GroupInfo or the external candidate's temporary before handle.
Encode captureHead as its exact JSON string or explicit null. Existing canonical token encoding sorts captureHead before groupID.
Framing: `u32(tokenLength) || UTF8(token) || GroupInfo`, or lifecycle `u32(tokenLength) || UTF8(token) || u32(GroupInfoLength) || GroupInfo || ledger`.
Lengths are big-endian. The signature binds captureHead, captured epoch authenticator, group, request and exact GroupInfo digest.
HPKE seals that signed token using the existing group/member/request authentication boundary (`packages/mls/src/recovery.ts:261`, `:566`, `:618`).
This recovery-reply wire change stays within the 0.x band and requires coordinated producer/consumer updates.
Ordinary GroupInfo reply v2 uses HPKE info/AAD domains `kumiai/mls/recovery/v2` / `kumiai/mls/recovery-aad/v2`.
Lineage-bearing replies use v3 and `kumiai/mls/recovery/v3` / `kumiai/mls/recovery-aad/v3`, with signed lineageDigest.
V2 remains readable/restorable for ordinary saved attempts but grants no forkRecovery exception authority.
The outer frame remains `u8(version) || enc(32 bytes) || ciphertext`. Ledger-only replies keep their existing format.
Refuse v1, missing/wrong-type `captureHead` or `groupInfoAuthenticator`, invalid positions/authenticators and failed attestation verification before building any external attempt.
A capture position is explicit null or a nonempty opaque string of at most 64 JavaScript characters. Preserve its exact value; impose no decimal-position grammar.

Persist immutable captureHead/searchFrom/target and exact external bytes/ID/candidate/request key before publication.
Initial expectedHead equals authenticated captureHead, including null. Search may accelerate bound confirmation under applied-state settlement authority.
After mismatch or unconfirmed acceptance, recapture authenticated responder state without replacing X or building another candidate.
Equal epoch/authenticator means responder prefix lacks X: retry SAME bytes at its authenticated head, even if lower or after an inflated prior head.
Later epoch with X's exact leaf means accepted -> settled. Adopt X only with bound confirmation; otherwise preserve accepted-unadoptable X and build leaf-replacing Y.
Later epoch without X's leaf permits discard/build subject to admission/removal policy, including applied-then-removed. Log absence never decides discard.

**Reconciliation limit (r19 decision).** Public GroupInfo and fresh external candidates lack old receiver secrets and referenced proposals.
Unclassifiable frames cannot prove non-acceptance. Follow applied-state settlement authority rather than log-derived discard.
Recapture remains available with gaps, byte mismatches or unconfirmed acceptance. Preserve X and its immutable request/key/confirmation tuple.
Fresh recapture keys remain separate. Head regression only diagnoses; member-signed recoveryEpochFloor survives settlement/discard/restart.
Equal epoch/authenticator means responder prefix lacks X and retries SAME bytes at fresh head, including lower heads.
Equal epoch/different authenticator diagnoses and recaptures without a durable hold.
Later epoch with exact X leaf means accepted -> settled, adopting X only with bound confirmation; otherwise build fresh leaf-replacing Y after durable settlement.
Later epoch without X's leaf permits policy-gated discard/build. No second same-lineage attempt at X's capture epoch is permitted.
Only the restricted forkRecovery predicates below permit different-branch captures. Backoff is bounded at 15 seconds.
Unsupported delivered frame/blob versions skip with upgrade-required diagnostics. Legacy control-record holds retain their separate policy.
Keep bound confirmation and normal MLS validation under applied-state settlement authority.
Only refusal of the authenticated commit itself authorises terminal negative settlement. Transport/blob/framing/copy-eligibility failures never do.
Requests carry the saved external commit bytes; the responder checks their commit digest against the request.
A responder still at the commit's epoch dry-run validates them on retained state and signs refusalAuthority: 'authenticated-commit' only after
authenticated MLS/policy refusal. A responder past that epoch answers only from applied state. No negative response row is written.
An in-memory, bounded, non-durable memo may rate-limit repeat evaluation. Requester judgement treats missing provenance as advisory.
Legacy negative rows remain readable as advisory only and are never replayed terminally.
Host commitPolicy MUST be a pure, deterministic function of (group state, incoming) and identical on every member, like MLS validation itself.
A divergent policy already forks the group on member commits; under this contract any member's authenticated refusal is the group's refusal.
A policy throw is a local fault: advisory, never refusal authority.
A responder verdict never chooses a fork or authorises replacement of X in place.
Remove P2a's separate lower-epoch candidate-admission/source-prefix algorithm.
Ordinary accepted/confirmed stages replay the same attempt. Restricted forkRecovery may supersede X while preserving its exact history.
An adopted stage never reinstalls its candidate.
Policy refusal remains durable until host action; transport/no-responder failures retry with backoff while stranded.

**Total database loss (r15 decision).** Losing the spent set is safe only when all prior Welcome-decryption material is also lost. KeyPackage init/HPKE private keys
MUST share group state's provider, transaction scope and loss/restore boundary, or derive only from it. This includes ordinary packages, retained last-resort
packages and every recoverable copy. A separately surviving store is forbidden. A new empty store may start without the spent set only under this condition. Old
Welcomes then remain undecryptable. Retained signing credentials alone cannot recreate these independently generated keys
(`node_modules/ts-mls/dist/src/keyPackage.js:62`). Without retained recovery trust, automatic external resync is impossible; manual re-invite supplies fresh
admission (r16 decision). Partial trust loss refuses.

Current private package stores are host-injected (`packages/mls-hub/src/pool-store.ts:24`, `packages/mls-hub/src/store.ts:21`). Pool/provisioner persist before
upload (`packages/mls-hub/src/pool.ts:130`, `packages/mls-hub/src/provisioner.ts:148`). MLS accepts private material at Welcome processing
(`packages/mls/src/group-welcome.ts:95`). Phase 2 defines shared-provider adapters; phase 3 implements database scope. Ordinary consumption joins installation
atomically (r16 decision).

**Backup restore (r15 decision).** The host MUST call `declareRestoredFromBackup()` before registry access, peer startup or network work. One device transaction
writes a durable restore-work record (r16 decision). Startup resumes it idempotently before access/network work. Every restored group remains held until
external-commit resync installs a new incarnation and fresh leaf before any send, including ephemeral sends. Restored MLS state is recovery metadata, never a send
source. Preserve fork halts and replacement/admission policy. Fork-halted groups still require manual recovery authorisation. Removed devices still require a fresh
invitation. Invalidate restored ordinary/last-resort keys and pending uploads. Mint replacements before advertising; persist device revocation retries where
supported. The current hub lacks revocation (`packages/hub-protocol/src/protocol.ts:193`, `:241`, `:262`); replace its last-resort slot. Ordinary copies survive
until fetched/expired; fetched copies cannot be recalled. Their Welcomes fail without local private keys (availability residual).

Each group transaction holds/fails every restored outbox entry, including settlements, with stable `database-restored` events retaining original data.
Events replay until ack; entries never publish/reseal. This overrides D6 and means local abandonment, not proven remote non-delivery.
The registry receives provider identity and ordinary/last-resort package adapters explicitly (r16 decision).
Restore-work stages invalidate old keys/uploads, rotate availability, queue device-level revocation retries, then mark/fail every restored group.
Persist stage progress with each transition. Delete restore-work only after proven invalidation/rotation, queued retries and all group holds/failures. Uncertain ordinary uploads retire keys; never reupload them.
Deletion permits recovery workers, not restored sends. Failure/ambiguity keeps startup held; retry rows survive restore-work deletion.
D2 resync clears only its group's restorePending; normal installations initialise false, but ordinary seed/adopt cannot clear a declared hold.
An undeclared backup restore is outside the model: rolled-back spent sets and ratchets cannot reveal their own lost future.
They can admit old Welcomes or reuse keys/generations. This rollback rule applies
[RFC 9750 §6.6's state-loss reinitialisation guidance](https://www.rfc-editor.org/rfc/rfc9750.html#section-6.6).

**Installed checkpoints and notices (r24).** The only transport worker uses
`deriveTopicID(configuredRecoverySecret, 0, 'kumiai/checkpoint/v1')`, with empty scope.
The hub `authorize` hook gates the checkpoint topic exactly like the commit topic.
Publish unconditionally with `retain: 'log'`, without `expectedHead`. Subscribe before draining and request seven days.
Live pushes wake bounded retained fetches. Only fetched positions advance the separate persisted checkpoint cursor.
The worker owns its receive channel and releases ownership before network work and notifications.

Define `LP(x) = u32be(byteLength(x)) || x` and
`H(label, ...parts) = SHA256(UTF8(label) || 0x00 || LP(part1) || ...)`.
Canonical UTF-8 JSON uses `@sozai/codec.canonicalStringify` and the EpochCheckpointBodyV1 shape below.
`genesisHash = H('kumiai/checkpoint-genesis/v1', exactGenesisAnchorExtensionBytes)`.
`authHash = H('kumiai/checkpoint-authenticator/v1', UTF8(groupID), genesisHashBytes, u64be(epoch), epochAuthenticatorBytes)`.
`keyHash = H('kumiai/checkpoint-key/v1', signaturePublicKeyBytes)`.
Sign `UTF8('kumiai/checkpoint-signature/v1') || 0x00 || LP(canonicalBodyBytes)` with the device's Ed25519 MLS signature key.
Verification uses strict Ed25519 (`zip215: false`). Other signature algorithms require a new checkpoint version.
Frame: `u8(1) || u8(1) || u32be(length) || LP(canonicalBodyBytes) || signature[64]`.
Length counts the complete payload after its length field. Maximum complete frame: 4,096 raw bytes.
Require exact lengths/full consumption, canonical 32-byte unpadded base64url hashes, recognised suites and valid UTF-8.
Reject duplicate/unknown fields, noncanonical JSON/base64 and lone surrogates. Epochs are nonnegative safe integers. Leaves are unsigned 32-bit integers.

The body carries keyHash and leafIndex, never signerDID, raw authenticator, incarnation, timestamp, position, publishID or hub identity.
`parentAuthHash` is our epoch-1 authHash, or null when that epoch was not installed.
Retained local facts include installed GroupContext.confirmedTranscriptHash, canonical unpadded base64url of its bytes.
The empty genesis transcript encodes as the empty string. Checkpoints never publish that field or substitute authHash for it.
Facts contain the complete authenticated roster with DID, keyHash, leafIndex and canonical 32-byte Ed25519 public key.
Sort members by DID/key/leaf. Reject duplicate DID/key pairs or leaves and keys that do not hash to keyHash.
Facts contain no credentials, registry export, ledger, private tree or MLS secret.

Genesis, Welcome, own/received commit and confirmed resync atomically capture facts and publication debt with installed state/trust.
Installation provenance is mutationID/stateVersion, established by the private coordinator. Progress saves preserve immutable facts.
Speculative builds, refused commits, offered GroupInfo, imported frames and hub acknowledgements never create installed facts.
Self-removal retains its fact but publishes no checkpoint under the removed identity.
Signing resolves a proven installed factID, outside the provider transaction. It accepts no arbitrary candidate or authenticator.
Save exact signed bytes/publication work before network handoff. Rollback/uncertainty releases nothing. Crash-before-sign resumes the captured fact.
Rapid advances cannot substitute a newer installation. Signing consumes no MLS generation. Stale incarnation workers cannot sign for their replacement.

Publish once for every eligible installation. Drain at one checkpoint/second, burst eight, without coalescing retained unsent installations.
An eligible online member republishes its exact current checkpoint every 30 minutes with ±20% jitter and a fresh heartbeat publishID.
Persist sampled deadlines and in-flight IDs across restart/reconnect. Ambiguous publication retries exact bytes/ID.
Overdue timers produce one heartbeat, never catch-up bursts. Reschedule from actual handoff.
Retry exponentially, capped at 15 seconds, within the same rate budget. Remote input never induces new signing.
Transport failure never holds ordinary MLS sends. Offline/suspended periods give no cadence guarantee.
Receive at most 32 frames, 128 KiB and 64 signature checks per turn. Release the owner gate between turns.
Reject oversized input before JSON/crypto. Deduplicate by `H('kumiai/checkpoint-id/v1', exactFrameBytes)`.

Current counts towards the newest 256 installations across the group, including retired incarnations.
Superseded facts expire seven days after local supersession or outside those newest 256 installations, whichever occurs first.
Prune associated unsent work. Replays never refresh installation identities or supersession clocks.
No fixed history byte cap silently truncates rosters. Storage exhaustion follows provider failure semantics.
Absent retained data exposes lost coverage rather than fabricated completeness.
Checkpoint retention is independent of applied rows, MLS secrets and the spent set.
Seal group-level `checkpoints` records with null incarnation in AAD and GroupKey inside the value.
Facts, publications, cursor, notices/evidence, conditions, journal, superseded history and manual records use distinct record identities.
Only the D8 coordinator establishes installation provenance or writes restricted recovery authority. Ordinary store callers cannot fabricate either.

Comparison binds the compared epoch/hash to our retained local fact.
Signer eligibility uses DID and key hash in our pre-split roster, falling back to the compared-epoch roster only when the earlier fact is unavailable.
Resolve DID locally from keyHash. Foreign leaf numbers need not match local leaf numbers. Count signers once per DID.
At least one compared hash matches our retained fact. Same-key unequal statements identify equivocation.
Missing epochs/bindings, unsupported versions and ineligible signatures yield invalid/coverage-gap, never adverse recovery authority.
A malicious eligible signer can invent testimony and cause a spurious notice. Checkpoints never choose a winner, halt or switch.

One durable ForkNotice represents each detected split, with the best-known split epoch, branch hashes/signers and this device's branch.
Use local detectedAt/lastEvidenceAt/firstSeenAt/lastCheckpointAt, never hub timestamps.
`fork-detected` replays until acknowledged. Material changes emit `fork-updated`, coalesced by forkNoticeMinInterval, default 30 seconds.
Material changes are a new branch/signer, an earlier split epoch or a changed device branch. Unchanged heartbeats never notify.
Close after only one branch receives checkpoints for forkNoticeQuietInterval, default 24 hours, or after this device switches branch.
Closing does not prove which branch survived. Acknowledgement affects notification, never admission or safety.
Evidence, even unacknowledged, obeys the ordinary 256-installation/seven-day supersession bounds.
Closed evidence expires at the earlier of acknowledgement-plus-604800000 ms and its checkpoint bounds.
This explicitly supersedes DN3's unbounded unacknowledged-evidence pinning exception.
Keep replayable unacknowledged summaries with partial coverage after evidence pruning. Late acknowledgement never extends retention.
App/internal halt evidence remains separate immutable history, retained under its halt/tombstone contract.
Public checkpointCoverage exposes the effective comparison floor, incarnation-specific retained ranges and pre-join/skipped/expired holes, including after restart.
Summary-only epochs never count as comparable facts. Full withholding, absent shared signers and expired epochs can prevent detection.

**Roster absence (r24 controller departure, R1/R6/R8/R9).** This replaces approved design Goal 3 and section 4's terminal not-member/stop-retrying rule.
A signed roster authenticates a responder's view. It cannot prove that the hub kept that branch.
not-member is diagnostic only. Admission retains existing stranded/hold rules. No admission path refuses solely because of this diagnostic.
Ordinary candidate admission remains unchanged. An absent device still requires normal invitation when replacement policy cannot admit it.

A separate former-member roster reply discloses only signed public tree, authenticated role-ledger head/entries and responder lineage, never secrets or messages.
The requester must be absent now, with its DID AND requesting key hash in the responder's retained earlier roster.
A never-seen or expired DID/key pair gets no reply. Hosts/imported facts cannot supply disclosure authority.
Dedupe replies per responder/requestID and reuse bounded per-group recovery admission/suppression budgets.
Hard-held responders never serve recovery replies.

Verify request binding, eligible signing, head/tree/ledger and absence of our own DID, irrespective of leaf/key changes.
Capture public tree, complete ledger, reconciled prefix/head and retained signed lineage under one responder owner snapshot.
Freshness is lineage-relative: same lineage at the newest common retained epoch requires reply epoch > our latest installed epoch.
Different lineage at any retained epoch needs no epoch-number condition. Unequal authenticated authHash or confirmedTranscriptHash establishes that difference.
Absent comparable authenticated evidence grants no not-member claim. Older/equal same-lineage replies cannot prove fresh absence.
Surface responder keyHash, epoch, local observedAt and distinct responder DIDs/count.
Emit once per new evidence, with notice-style coalescing. Preserve optional pendingReason in status.
Recovery continues at capped backoff. Any successful install, head-only reconcile or re-anchor clears the active condition and preserves history.
Failure or pending proof never clears it. No roster reply supplies terminal continuation authority.
Advise apps against disposal/deletion on first evidence. Another responder DID or persistence can inform app policy.
App policy owns disposal, deletion and re-invitation. Neither silence nor an ineligible reply proves removal.
Use 'no-reply' when nothing was received and 'no-eligible-responder' when replies arrived but none was eligible.

Recovery requests sign comparisonEpoch. comparisonEpoch is the LOWER bound of the requested lineage span.
The requester sends split E when a fork notice is open, otherwise its OLDEST retained epoch.
The responder sends its signed lineage frames for epochs in [max(comparisonEpoch, its oldest retained), F].
Keep complete replies within 786432 bytes, keeping the frames nearest F when truncating to that bound.
F's frame is always included in a qualifying lineage reply. An empty interval or unavailable F frame grants no qualifying lineage proof.
The requester compares at the newest common retained epoch inside the received span.
Absence diagnosis (R6) needs any common epoch, with the existing lineage-relative freshness and absence checks.
Fork-floor authority (R2/R7) still needs the E frame in the span and every existing notice/signer/MLS transcript predicate.
Trimming E or lacking any common epoch cannot grant the corresponding authority. No input causes new signing.
T0-I1 supersedes the earlier R9 M-b newest-retained default and complete-requested-span requirement.
This lower-bound meaning and bounded suffix apply to ordinary lineage-bearing recovery and former-member roster replies.
Rendezvous disclosure includes DID, ephemeral key and comparisonEpoch. comparisonEpoch is cleartext, visible to the hub and subscribers.
Legacy requests without comparisonEpoch retain ordinary recovery, without lineage-exception authority.

**Restricted fork recovery (r24, R2/R7/R9/R10).** Checkpoint intake alone never executes a recovery transition.
Automatic floor lowering requires an open notice with other-branch hash at its best-known split E, attested by an eligible, non-equivocating signer.
Equivocation-only notices grant nothing. The reply carries its signing key's signed checkpoint at E, matching that other hash and differing from our E fact.
That reply signer occurs in our pre-E roster. The authenticated reply lineage binds the E checkpoint to offered state.
Checkpoint testimony alone grants no exception. Verify the offered MLS GroupInfo and its public transcript binding as well.

Require offered GroupInfo epoch F >= E, using the notice's best-known split.
Within our retained range, GroupContext.confirmedTranscriptHash must differ from our retained fact at F.
Below the oldest retained fact, or in a hole within that range, refuse with 'target-behind'.
A continuing head F in a retained-range hole, including epochs crossed by external commit, waits until a retained epoch or beyond our newest.
If F is above our newest retained fact, the E-lineage binding still applies. Missing facts never manufacture transcript inequality.
An earlier-moving notice can re-enable authorisation: a head in [S, E) is refused until the best-known split moves from E to S.
Manual resync supplies the exit otherwise. After evidence expiry, automatic healing stays target-behind; explicit manual resync supplies the exit.

Recheck E-lineage and MLS transcript binding for every capture while Y carries forkRecovery, including build, restore, retries and restart.
The real MLS adapters use registry-owned installed lineage and private authorisation/checking dependencies.
Owner-bound facts/frames reach ordinary sealing with the captured state/head/ledger snapshot. Hosts cannot inject signing, disclosure or floor authority.
The real captured port delegates authoriseForkRecovery to the private coordinator. Missing authority/checker refuses the exception.
Ordinary v2/missing-lineage recovery keeps X and its floor unchanged when an exception would be required.

If X exists at built, published, confirmed or adopted-incomplete stage, settle it as `{kind:'superseded-branch', epoch:E}` in the cumulative row.
Union every obligation. Preserve unknown/accepted outcomes and sealed exact-X history, including request/key/candidate/payload and existing confirmation facts.
This overrides r23's compact-settlement omission rule only for superseded-branch provenance. Never infer not-accepted from a branch switch.
Atomically settle X/history, clear its active/unfinished continuation pointer and persist Y's bound forkRecoveryAttempt intent.
No-X recovery persists the same bound Y intent without inventing an X settlement.
Intent ID equals authorisation.attemptID and the later Y record ID. Bind source and destination when retiring an adopted-incomplete continuation.
Prove this transition before constructing Y. Retrying an existing intent is idempotent and never settles Y as X.

Only that bound attempt gets effective floor E. Keep the ordinary control recoveryEpochFloor unchanged.
Settlement or abandonment of Y removes its exception. Ordinary floor raising and cumulative settlement rules remain monotone.
Permit lower/equal-number different-branch captures only under all these predicates. No distinct-DID threshold applies, preserving two-member healing.
Without all predicates, preserve X/floor and retry with 'target-behind'. Never discard saved work merely to create another attempt.
Deliberately forged coherent GroupInfo plus checkpoint chains remain an accepted insider residual outside the intent-trusted model.
Their effect stays within the attacker's fake state. Honest members never confirm fake Y.
Every rejoin installation still requires bound external confirmation. Notice testimony never substitutes for acceptance proof.

**Abandonment reporting (r24, DN3/R4).** Existing authenticated recovery decides switches, never notices or reporting coverage.
Journal own-send IDs/epoch/authHash prospectively, without plaintext. Store only per-epoch counts for others, never per-received-message rows or plaintext.
Ephemeral sends remain unpersisted and uncovered. Retain journal metadata only within its supporting installation bounds.
On non-descendant switch emit branch-abandoned with abandoned range, optional notice link, own IDs, others' counts and branch-only membership changes.
If sent plaintext is not retained, report message IDs and the app resends from its copy. Never resend others' messages.
Reports declare complete/partial coverage separately for ancestry, own messages, others seen, membership and ephemeral traffic.
Partial coverage names pre-journal-history, retention-gap, unknown-ancestry or ephemeral-uncovered reasons. Counts describe observed metadata only.
Unknown ancestry reports range 'unknown' and partial coverage without delaying or changing the established switch.
Missing history never fabricates zero counts or exact branch-only deltas.

**Manual recovery and hub migration (r24, DN1/R3).** Only host invocation authorises a selected target or admitted successor.
Resync accepts registered targetID or call-time `target: {targetID, hub, commitTopicID}`.
Persist only targetID and sealed commitTopicID, with explicit allowOpenFork and attempt authority. Never serialise hub methods.
The unchanged resolveTarget(targetID) must reconstruct that exact ID/topic binding after restart.
Resolution failure/mismatch leaves the same attempt visibly paused as target-unresolved, without fallback or dropped authority.
Persist the chosen action before execution. Failure leaves the prior state and any halt intact.
A committed authorisation supplies a restricted manualRecoveryControl overlay for only rejoin/floor/settled rows.
Keep ordinary X byte-identical during manual save/retry/rollback. Carry cumulative obligations into independently saved manual candidates.
Bind each nested attempt to source, selected target and authorisationID. Only the provider-scoped capability grants the manual floor exception.
This explicit manual authority supplies the exit from signed floor inflation or expired fork evidence, without lowering the ordinary floor.
Keep ordinary holds/operations untouched and ordinary lanes closed. Manual authority never permits held responders to answer.
At successful retirement, preserve exact ordinary X history, unknown/accepted outcomes and obligations. Never infer remote non-acceptance.
Persist the manual adopted destination/continuation identity atomically. Restart selects that authorised record and never fabricates legacy metadata.
Switch-proof resolution remains unbounded with visible pending until proof. Only proven commits release routing or destination peers.

A current move keeps GroupKey, MLS state, authenticator, generations and holds.
Require readable state, complete ledger/walk, no known lag/slot/operation/unresolved publication or settlement and zero pending owner work.
Require no hard hold, condition, open notice or active ordinary/manual rejoin.
A pending forkRecoveryAttempt counts as active rejoin, including the no-slot/rejoin/operation checks.
Persisted `allowOpenFork: true` overrides only the open-notice predicate. Every other exclusion remains mandatory.
Same-key movement refuses while held. Otherwise rejoin through responders already on the selected destination, checked against retained trust.
Authorised manual recovery abandons Y's pending forkRecovery intent in the same transition that persists the manual attempt, removing Y's exception.
A completed rejoin creates a fresh incarnation without source holds. Source holds/evidence remain history.
Hard-held responders never answer recovery requests. If every device is halted, successor mode supplies the exit.

Commit/rendezvous/checkpoint transport moves to the chosen hub. Rendezvous/checkpoint topic derivation retains the configured recovery secret.
Partial migration can create an undetectable cross-hub split. kumiai never chooses destinations or automatically migrates members.
An ahead arrival at a migrated topic stays pending with 'target-behind' unless the restricted forkRecovery predicates apply.
An empty target supplies no responder proof for a held/diagnosed device. Its current-move exclusions remain mandatory.

Successor mode validates an already normally admitted/available successor before retiring the source, without holding both group gates.
Retire/tombstone the source and record failures, routing retirement and chosen-action completion atomically after draining source work.
The successor tombstone blocks every old Welcome, including newer/unspent Welcomes and empty private state after restart.
Nothing is copied. The app may clear the tombstone explicitly. Spent checks still refuse replay after clearing.
Application code owns successor creation, admission, routing and member migration. These are separate group transitions.

**clearHold (r24, DN4).** Clear only a matching app-report halt, established by stored producer provenance.
Match GroupKey, eventID and reportMutationID under private attempt authority. Co-write exact halt history and clearance before releasing the latch.
Legacy halts without provenance stay uncleareable through clearHold. Completed manual rejoin or successor retirement supplies their exit.
Internal safety latches, spent-set-corrupt, not-member and unsupported-version holds cannot be cleared through this API.
Clear durably, retain reported evidence as history, and resume the ordinary commit walk. If stranded, ordinary recovery takes over.
No forced resync. Ack never clears holds. Gated transport retention defers rather than dropping its reference while a clearable hold remains.
Resume only demanded subscriptions after proven release. A holder released before clearance never subscribes.
A newer internal latch survives clearance of an older app incident.

**Spent diagnosis (r24, DN5).** Unreadable combined trust envelopes remain recovery-unavailable.
Only successful envelope decoding with a missing/malformed spent set produces spent-set-corrupt, with event, typed error and status.
An empty decoded set in a surviving installed group is malformed. It cannot omit that installed authenticator.
Refuse admission as before. Never initialise an empty set in a surviving store. Warm observation persists diagnosis across restart.
Projection precedence is hard safety holds > spent-set-corrupt > not-member > recovery-unavailable > pending.
Keep lower-precedence records/evidence intact. Precedence never makes not-member terminal, adds its own admission refusal or cancels recovery.
Total database loss with all Welcome-decryption material lost permits plain fresh invitation into the same group.
An already admitted successor remains an explicit exit. Documentation must not claim total loss forbids successor retirement.
Undeclared backup restore remains outside the model. No spent-corruption repair helper or implicit safety reset exists.

### D2. Incarnations, admission and local order

One live process owns the database; one registry owns each active incarnation and its non-reentrant group gate. MLS state, key ceilings/progress, control, anchors,
pending/outbox/meta, cursors, occurrences and local watermarks belong to their incarnation. Administrative pointers/revisions/markers locate records without carrying
epoch state. Stale owners/ports cannot silently follow a new incarnation and throw `DisplacedGroupHandleError`.

**Spent set (r16 decision).** Retained recovery trust and its spent-epoch-authenticator set live above incarnations. Genesis, Welcome, own/received commit and resync
append each installed authenticator in its installation transaction. Progress saves, tombstones and deletion retain trust and sorted, unique defensive spent byte
copies. Missing sets in surviving/restored stores refuse. Only D1's total-loss condition permits a new empty set (r15 decision). Welcome/seed/resync admission
refuses spent authenticators before epoch comparison, including a valid alternate Welcome representation with different bytes but the same authenticator. Completed
mutation replay resolves its marker, not candidate admission. No silent empty-set fallback or current-identity reinstall exception.

**Welcome admission (r14 decision).** Derive groupID/epoch/authenticator from the verified joined handle.
After the spent check: absent lifetime joins incarnation 1; a live incarnation at/above the Welcome epoch returns
`alreadyJoined`; a strictly newer authenticated Welcome may explicitly readmit after peer stop/drain; a tombstone may
admit any unspent valid Welcome into `latestIncarnation+1`. No highest-ever epoch floor exists.
A fork-halted group refuses ordinary readmission until provenance-authorised clearHold or completed manual recovery releases the applicable hold.
Successor tombstones independently refuse readmission until explicitly cleared. All spent checks remain mandatory.
Seed rechecks lifetime/revision/admission inside the transaction. Genesis requires absent lifetime, epoch zero and null package use.
**Package exclusion (r16 decision).** Welcome install atomically writes group namespaces/trust and consumes the ordinary device-pool record/private key.
Recheck the prepared package reference and presence under the package-row lock; an existing receipt or absent private key refuses admission.
Two cross-group Welcomes may prepare, but exactly one installs. Mutation proof resolves ambiguous installation before releasing the shared package lock.
Last-resort packages deliberately remain reusable; their replay protection is the group-level spent-authenticator set.
Installation queues hub-copy cleanup at device level. No incarnation `joinRef` remains a security obligation.
This implements [RFC 9420 §16.8](https://www.rfc-editor.org/rfc/rfc9420.html#section-16.8)'s ordinary-package replay protection.

**Switch (r14 decision).** Block new source work, settle in-flight publications and drain previously opened handlers. One transaction validates the expected source
incarnation/revision/version and exact resync acceptance, tombstones `n`, installs fresh `n+1`, appends its authenticator, creates its anchor/control/cursor and
records failed old outbox statuses/events. Across incarnations candidate epochs may differ; within one, lower epochs or same-number different authenticators always
refuse. Copy no source progress/ceilings/cursors/applied/anchor; no same-epoch replacement exception. Old unsettled operations become `unknown`; old outcomes and
owed Welcomes remain addressable under `n` until ack/delivery. Storage-only workers serve those obligations without starting an old peer. Old applied rows cannot
mask new self-removal. Resync bootstrap reports missing ledger tokens as `reenact`; only the host decides to enqueue them again.

(r25) Until 2.3c, every retirement (resync switch, delete, successor) leaves opened records durable and undelivered in the retired incarnation; 2.3c retired-port delivery drains them without a live peer, and the visible blocked-switch status moves with it.

Unpublished old entries fail with `incarnation-abandoned` events retaining entry/destination incarnation; host retry may enqueue fresh, never automatic reseal.
Certified settlements publish with original occurrence/topicID. Host history survives unchanged.

**Order (r14 decision).** Use `(incarnation, anchorEpoch, position)` lexicographically within a durable lane. `anchorEpoch` is the authenticated MLS capture epoch,
not a local counter. Positions compare by one code-unit order only within that topic (r25). This extra epoch component is necessary because different anchor topics have independent
position spaces. Keep/restore preserves anchorEpoch; one epoch has one capture identity. Resync starts a new incarnation; late frames retain original epoch, retired
opens refuse. Host message dedup is `(groupID, author, id)`; the first occurrence keeps its order and persisted topicID. Local read watermarks include incarnation;
peer receipts remain `(authenticated topicID, position)` with no local incarnation on wire. Different topics' receipt positions are incomparable. No ordering lineage,
admissionFloor, ordinal counter or topic-to-ordinal map remains. Checkpoint lineage does not change lane ordering.

### D3. Group transactions, adaptive batching and handlers

**Atomic transitions (r14 decision).** Welcome install, open/accept, adoption, switch, removal/terminal clearing,
publication settlement and outbox enqueue/attempt/status each write all affected kumiai namespaces in one group transaction.
Supplied host effects use that same transaction. Root facades share the coordinator; transaction-bound methods never nest it.
Prepare crypto outside the provider transaction under the group owner gate; the short transaction validates identity/version
and writes the prepared result. Publish runtime state, plaintext, acknowledgements, events and transport bytes only after proven commit.
Control build/publish/fetch/confirm and Welcome delivery always run outside transactions.

**Adaptive group commit (r14 decision).** Take whatever compatible work is ready; flush at the first applicable cap/bound:

| Host option       | Default | Meaning                                                                             |
| ----------------- | ------- | ----------------------------------------------------------------------------------- |
| `maxBatchFrames`  | 64      | maximum streaming opens/completions/settlements per transaction                     |
| `maxBatchDelayMs` | 2 ms    | maximum coalescing delay once work is ready, excluding an already active transition |
| `maxBatchWorkMs`  | 8 ms    | stop adding work at the next operation boundary after this staging/work budget      |

An idle group starts immediately: a lone frame waits for neither a timer nor a full batch. Arrivals during active work coalesce for the next batch. Bursts of
hundreds–thousands split into bounded transactions; steady streams and interleaved low-rate commands use the same scheduler. One transaction may open/settle N
frames. Mid-batch crash/failure commits all state, pending records and transactional effects or none; expose no partial output. Size/work bounds are finite/positive;
delay finite/non-negative. Calls cannot be pre-empted. Atomic install/switch/terminal prepares outside storage, never splits.

**Fairness (r14 decision).** Release the group transaction and owner scope between batches, including catch-up. At each boundary service ready control adoption, then
round-robin other lanes and enqueue/completion work before another burst-lane batch. Each ready source gets at most one capped batch per round. During lane A's
sustained burst, ready lane B work and control adoption complete before a second further A batch; with only A/B/control ready, both finish within three total batches
including the active A batch. The bound assumes protocol prerequisites, available storage and short/settling handlers. Enqueue cannot wait for backlog exhaustion.
Self-removal/switch await opened-record drains. Groups have independent gates/queues; SQLite writer limits authorise no global application mutex.

(r25) Until 2.3c, every retirement (resync switch, delete, successor) leaves opened records durable and undelivered in the retired incarnation; 2.3c retired-port delivery drains them without a live peer, and the visible blocked-switch status moves with it.

**Durable lanes only (r14 decision).** Only log-retained events use outbox/pending/cursor/completion persistence.
Ephemeral RPC requests/responses, streams/channels and signals perform no persistence and initiate no provider transaction.
Use memory-only receive progress and pre-reserved send leases (D5). Exhaustion rejects/holds the ephemeral call without storage work;
separately scheduled maintenance refills. A later independent durable transition may save current same-identity progress.
Ephemeral handlers have no replay/completion guarantee. Host `markRead` is a separate durable host action.

**Common handler boundary (r14 decision).** Default durable delivery is at least once. The open transaction persists plaintext,
authenticated sender/epoch, frame identity and stable idempotency key with consumed keys. After commit, invoke the handler outside
both gate and transaction. Success schedules one completion transaction removing pending and advancing the contiguous topic cursor.
Handler/completion failure leaves pending for retry. A failed record blocks its lane, not other lanes.
Only completed/dead frames advance a cursor; duplicate completion is harmless.

Opt-in transactional completion passes the group transaction to the handler. Effect, pending completion and cursor commit together: exactly-once durable effect when
the host shares the provider/DB, not exactly-once callback invocation. These handlers stay short, perform no network I/O and use only supplied transaction stores.
Every other handler runs outside a transaction. No transaction callback awaits a root store, another group's gate or a timer. Multiple handlers declare one
completion policy. The frame key is JSON of `['kumiai/frame/v1', groupID, incarnation, topicID, position, protocol, procedure]`, stable across restart/redelivery.
Different occurrences have different keys; applications also dedup semantic message identity. MessageStore/status effects use this common boundary.

**Terminal drain.** Commit self-removal's terminal flag and applied/control changes even without epoch advancement; that transaction closes every live build, unbuilt intent and rejoin record (D4 r28c).
Block new opens/seals/publication, restore all already opened records and await their handlers/completion transactions.
Drain persisted plaintext without decrypting/fetching/opening more frames. Starting workers is not awaiting completion.
Then one clearing transaction settles certified entries, fails others and clears transport rows.
Failure delays clearing; disposal/timeouts never authorise pending erasure. Restart follows the same order.

### D4. Commit-once control

P2a retains FIFO intents, durable outcomes, revoke holds, Welcome obligations and exact external-attempt replay. Pull to head before build. Build non-mutatingly and
frame once, outside a provider transaction. The built-save transaction revalidates source incarnation/epoch/authenticator and queue head, then saves exact full
payload, publishID, candidate/journal, required proposal/key material and complete Welcome before anything leaves the device. A source move prevents publication.
Retry a rolled-back save with the already prepared bytes. Death before built-save permits preparation again; no payload escaped.

**One source-epoch slot (r14 decision).** All private control/rotation builders share one durable commit-once slot per incarnation/epoch. Direct calls, queue
changes, outcome ack and deadline expiry cannot free it or create a second same-epoch build. It ends only in the authenticated transaction that consumes its
epoch, on retirement, or on `abandon()`, to prevent protection-tree generation reuse.
(r28c) Closing a live build by `abandon()` uses the final-report rule (Deadline/outcomes): atomically delete any surviving provisional report, write terminal
`unknown` under a fresh outcome ID, delete the build's executable material (candidate, journal, speculative Welcome) and write the durable spent-source marker
`spentSource: { epoch }` for that incarnation. Repeated `abandon()` of already closed work writes nothing. Ack and restart preserve the marker. No control build is
permitted while `spentSource.epoch` equals the source epoch; a marker below the current epoch is dead and is cleared by the next consumption, as is a matching one
by authenticated epoch advancement or retirement (self-removal leaves it, moot on a terminal group). Welcome obligations are a separate `abandon()` deletion, as
P2a D1 says. Authenticated consumption and host abandonment are distinct closure causes: after advancement, later own copies are past-epoch diagnostics; after
abandonment without advancement, an own-unmerged frame with no live build at its epoch is a past-own diagnostic skip (cursor advances, nothing is installed or
reported, the marker stays; it cannot reopen the operation or install the deleted candidate), and later frames follow the ordinary `ahead`/strand rules of D1,
with the availability concession's ghost-member consequence if the group moved on that commit.

**Settlement by adoption (r28 decision, supersedes r19 mismatch/restart and r27 retained builds).** One log reader settles a build: the _walker_, the inbound
commit-lane reader that adopts the log in order from the durable cursor (P2a D5), validating every foreign frame with normal MLS/proposal/policy checks against
the state at its framed epoch. (r28d) An own occurrence never advances state through received-commit application (the committer holds no copath secret for
its own update path, RFC 9420 §12.4.2; `apply-commit.ts` refuses an own non-external commit); authentication-only processing on disposable retained state
(the existing signature-verification helper) is permitted, and installation always uses the saved candidate. Its validity is recognition (exact bytes, or the
own-commit helper and receiver reference-verification predicate for a changed copy) plus the r25 source/control-compatibility recheck of the saved candidate
against the current state; the candidate's validation at build time is its MLS proof. There is no historical search from the build head, no stored acceptance uncertainty, no retained
reconciliation set and no applied-window pinning. A hub acknowledgement is retry evidence only: it writes `acceptedAs` on the live build (P2a's `accepted` stage
is that build and nothing more) and no applied row, cursor, outcome or obligation.
The authenticated transaction that consumes a build's source epoch settles it, and nothing else does:
- (r28c) every recognised own occurrence uses the saved-candidate installation path. After recognition, receiver reference verification and the r25
  compatibility recheck succeed, the installation transaction atomically consumes the build: it installs the saved candidate, preserves ratchet progress,
  writes the applied row with opID and the cursor, and deletes the build. With _complete coverage_ (below) it is the FIRST valid commit at its framed epoch:
  the outcome is `landed` and the Welcome obligation (below) is written. With incomplete coverage (a retention gap or `skipped === true`) the outcome is
  terminal `unknown`, the speculative Welcome is deleted and no obligation is created: the skipped frame is non-delivery per the Model, so the device does not
  strand on its own commit, and this is the availability concession below. (r28i) Named-entry verification uses the delivered frame's own sealed blob under a
  locally derived key for own copies, never the host resolver. Failed delivered copies, own or foreign, are hub-caused non-delivery: unreadable, malformed,
  unsupported, unauthentic or reference-incomplete blobs do not authenticate a refusal of the commit itself. Skip/diagnose the occurrence; atomically persist
  its cursor advance and coverage uncertainty (`skipped: true` for an affected live build, explicit `retryForbidden: false` unless a prior prohibition applies).
  Keep the live build's exact bytes/ID, candidate, deadline and speculative Welcome. Do not strand, hold, halt, rebuild or retire its source from that copy.
  A source-epoch commit-content signature alone does not authenticate its entry blob or prove that the device's build lost.
  Genuinely local key derivation, storage and verifier/provider exceptions remain distinct: hold the cursor and retry with capped backoff, without a skip or
  fabricated copy error; bounded local retry exhaustion retains D1's recovery backstop. It does not bypass the live-build retirement authority below.
  While a build at source E is live, ahead/head/gap claims and failed delivered copies may trigger bounded-backoff authenticated state inspection, never a
  destructive strand or another ordinary build. Automatic recovery that would retire that source requires request-bound, MLS-verified member-signed GroupInfo
  for the same group at F > E, authenticated through retained trust and the existing MLS signature/tree/credential/replacement checks without building a candidate.
  Same/lower epochs, same-number authenticator disagreement, wrong request/group or failed trust checks grant no authority. Inspection only permits the normal
  recovery sequence; retirement still requires its bound confirmation and source revalidation. Explicit host retirement/abandonment remains available.
  The port recomputes coverage from its captured snapshot and refuses installation (`'moved'`) while a genuinely local strand remains; `'moved'` advances nothing.
  Delivery gaps instead record `incomplete` atomically before adoption; own installation behind incomplete coverage closes `unknown` without a Welcome obligation;
- validated competitor at that epoch, other than a removal of this device, with complete coverage: `lost` (superseded); follow its state/cursor, never install
  our candidate or release its Welcome;
- any other authenticated consumption: terminal `unknown`; delete the candidate, journal and speculative Welcome in that transaction. This includes a competitor
  behind incomplete coverage, authenticated self-removal and retirement (D2 :477; recovery, readmission and resync are retirements). Automatic recovery retirement
  of a live build obeys the F > E inspection plus confirmed-recovery rule above; explicit host retirement or `abandon()` is a separate closure authority.
  (r28c) Authenticated self-removal is consumption even without epoch advance: its adoption transaction closes every live build terminal `unknown`, closes every
  unbuilt intent `rejected` with `reason: 'removed'` (nothing left the device) and any rejoin record `unknown` (a record already at `refused` carries its
  outcome and is deleted without a second one), deletes speculative material and releases revoke holds; obligations survive. A terminal group therefore holds
  no build, intent or rejoin record; deletion needs acks plus delivery or `abandon()` of the remaining Welcome obligations, never `abandon()` of control (D7).
  This supersedes P2a D5's later removal-effect `apply`, which then settles nothing.
  _Coverage (r28c)._ `BuiltCommit.head` is the immutable cursor position at built-save (`expectedHead` is separate retry bookkeeping); null `head` denotes the
  empty prefix. A build is refused while the cursor carries `incomplete`, so `head` always lies inside covered history. The build carries a durable `skipped`
  flag, set in the same transaction as, and before, any cursor advance past a commit-lane occurrence after `head` that the walker did not adopt, unless that
  occurrence is positively classified as a frame whose readable framed epoch differs from the build's, a duplicate position or an application frame. An
  unreadable epoch counts as a skip: poison, an unrecognised or altered own copy, an unknown handshake or frame version, a refused external commit and an
  unparseable frame all set it. A retention gap discovered in the same fetch is durably recorded (the cursor's `incomplete` mark, set in the same transaction as
  the cursor advance) before any occurrence from that fetch is adopted, so the consuming transaction's pre-state includes it. Restart and head refresh never
  clear `skipped`. _Complete coverage_ at a consuming transaction means, in that transaction's pre-state: no `incomplete` cursor mark, `skipped` unset and the
  winner at or after `head`. Incomplete coverage never yields `lost`. Coverage is relative to the served log (Model): a hub withholding frames without a visible
  gap still yields complete coverage, so `lost` is branch-relative as P2a D3 says; no local predicate proves global non-acceptance. A match proves occurrence
  only. Replay by ANY party able to publish to the commit topic obeys this rule, including another publishID.
  See [RFC 9750 §5.2.1](https://www.rfc-editor.org/rfc/rfc9750.html#section-5.2.1).
  Hub bytes, head movement, elapsed time, acknowledgement, absence and delivered-copy validation failure never delete saved work before authenticated consumption
  or explicit host retirement/abandonment, prove loss or create a durable safety hold. Failed copies and gap/ahead claims alone cannot authorise automatic
  retirement of a live build; the independently authenticated advancing-state and confirmed-recovery rule above applies.
  (r28b) After consumption, later own copies are past-epoch diagnostics (D1 :46): they never reopen the operation or create an obligation, and a stale prepared
  adoption writes nothing. A build and an applied row at its epoch with a different payloadDigest cannot coexist; finding both, or an own occurrence whose saved
  candidate fails the r25 control-compatibility check while the frame validates, is a conflicting trusted local installation record and follows D1's
  local-invariant halt. No fork outcome kind exists for a build.
  (r28i) `skipped` records coverage uncertainty independently of the monotone retry prohibition. New coverage-only skips persist explicit `retryForbidden: false`.
  Unreadable/unclassified frames, content-authentication failures, own-copy mismatches and failed own or foreign named-entry copies supply coverage uncertainty alone.
  A foreign source-epoch refusal prohibits retry only when its commit-content signature verifies and the refusal concerns the authenticated commit itself,
  independently of delivered blob/framing/reference eligibility. Sender-data identification or a verified signature attached to a failed blob is insufficient.
  Such authenticated refusals persist `skipped: true` and `retryForbidden: true` with the cursor advance. Applied authenticated consumption closes the build and
  forbids retry. Other-epoch, duplicate-position and application classifications retain their coverage exceptions above.
  With unchanged incarnation/epoch/authenticator, before the deadline, without acknowledgement and with effective retry prohibition false, publish only identical
  saved bytes/ID, including after coverage-only skips and restart, at a refreshed expectedHead. Never rebuild at the same source epoch.
  An authenticated refusal keeps the build live but prohibits identical retry. Later recognised own installation still closes `unknown` by incomplete coverage.
  Otherwise authenticated consumption or explicit host retirement/abandonment closes it. Neither coverage loss nor retry eligibility proves lost/absent/superseded.
  A head/proposal/stateVersion change alone never permits rebuild. A late handoff completion applies only to the same live build identity; it never resurrects
  consumed or abandoned work.
  (r28c) Availability concession. A possibly accepted build closed without own first-valid proof loses its speculative Welcome; terminal `unknown` asserts
  uncertainty, never absence. This covers both a build closed by a competitor or retirement and an own occurrence installed behind incomplete coverage: in the
  latter the Add is on the device's own branch with no Welcome held for it. The host learns `unknown` and may re-invite; if the Add did land, the invitee is a
  ghost member the target guard refuses to re-add until the host removes it and re-invites with a fresh key package. This is the accepted boundary of
  epoch-scoped settlement.
  (r28) Epoch advancement never rebuilds saved bytes. An unbuilt intent revalidates at the current epoch and builds only if still eligible; stale internal intents settle `rejected` (D5).
  Only the host re-enacts a settled build, under a new operation ID. (r28c) After an internal rotation closes, the registry re-evaluates admission under D5. It never replaces a live build. Abandonment does not permit another build at the spent source epoch.
  Same-number trusted local authenticator divergence remains a local-invariant halt. Retirement settles old work without rebuilding there.
  Recovery attempts keep D1's authenticated recapture; it is a rejoin mechanism, never a control-build one. Host/local-invariant fork halts still forbid automatic rejoin.

Retain candidate/journal and needed proposals/decryption keys while the build lives; nothing survives closure but outcomes, obligations and, after `abandon()`, the spent marker.
Delivered references/keys/resolver failures never create a durable safety hold or, before consumption, authorise erasing saved work.
Extra proposals do not invalidate saved bytes; omitted proposals are cleared on adoption and require reproposal.
Control builders pass `pendingProposals: {}`; rotation uses empty proposals/entries and refuses local pending proposals.
Own-candidate installation and ordinary adoption preserve current sender/receive ratchet progress in matching retained history, including after restart.
Never resurrect evicted epochs. Incarnation switches carry no progress.

**Deadline/outcomes.** Persist `enqueuedAt + operationTimeoutMs` (default 30 s), unchanged by restart/retry. Before expiry retry transport failures with backoff. At
expiry stop new publication handoffs; one already in flight may still land. (r28d) After expiry a validated own occurrence still installs once: complete
coverage produces `landed` and its obligation, incomplete coverage terminal `unknown` without a new obligation.
(r28b) Expiry is a clock event over a live build only. If the build exists and carries no `reported` mark, one transaction writes a provisional `unknown` and sets
the durable once-only `reported` mark on the build, with no search, hub read or network completion; the build stays in its slot. A `reported` build is never
reported again, whatever ack did to the row; no clock event touches an operation whose build no longer exists. Ack deletes only the given outcome ID.
Consumption always writes its final outcome (`landed`, `lost` or terminal `unknown`) under a fresh outcome identity, even if the provisional one was acked,
deleting any surviving provisional row; an ack of the earlier ID never deletes the later result. Duplicate consumption writes no additional report.
`landed`/`lost` never change.
Expired never-built intent loses without building. Outcomes persist until ack; none releases the source-epoch slot. A reported build cannot be automatically
replaced, including by a new operation ID. Other intents wait for epoch change; a host may manually resync/readmit or `abandon()` if no survivor advances. Once
ordering trust fails, outcomes assert only locally observed facts.
Discovery, transport and validation-input failures are unavailable evidence and never prove loss. Local-invariant failures keep their halt contracts.
A definitely rolled-back storage transition changes nothing and is retried; an ambiguous commit follows D7/D8 completion proof before retry or release.
While storage completion cannot be established, no outcome is written and holds persist, indefinitely if need be.

**Terms (r28b).** _Reported_ means an outcome row was durably committed, not host receipt or ack. A build is _closed_ (settled) when consumption, retirement or
`abandon()` ends it with `landed`, `lost` or terminal `unknown`; a provisional `unknown` is a report, not a closure, and the build stays live. A build's epoch is
_consumed_ by the authenticated transaction that advances the device past its source epoch within the incarnation, sets the incarnation's terminal flag
(self-removal), or retires the incarnation. _Owed work_ is outcomes and Welcome obligations (Model :15); a _speculative_ Welcome is a field of its build and
is not owed; an _obligation_ is the independent row the own-occurrence adoption writes with `landed`. (r28c) _Installation_ is the saved candidate becoming the
device's state; it follows recognition and is distinct from `landed`, which additionally needs complete coverage. The _walker_ is defined above.

**Migration (r28d, r28h compatibility).** Every persisted build with `skipped: true` and no retry distinction remains retry-forbidden.
This includes pre-r28h rows, schema-version-1 snapshots and legacy-migrated builds. Both publication gates default absent `retryForbidden` to `skipped`.
New coverage-only skips persist explicit `retryForbidden: false`. Later cursor advances cannot grant retry permission to older skipped rows.

Migration is one version-marked transaction per incarnation ControlSnapshot (the mark lives on that snapshot; each incarnation migrates
independently, a retired incarnation's rows under the closure bullet), run once before workers start and idempotent on restart (a restart before its commit
runs it again from the legacy snapshot; after its commit the mark skips it). Its mapping is total over the legacy ControlSnapshot (`control/types.ts`):
- Every operation row present is open work by construction (legacy closure deleted its row). Existing outcome rows and their acknowledgement state are untouched.
- Welcomes: every legacy `welcomes` row is proof-backed (the legacy slot wrote it only after first-valid proof, `committed` or not) and becomes an obligation
  with its exact bytes and recipients, idempotently by originating incarnation and `opID`; no legacy `welcomes` row is ever deleted with a build. The walker's
  later `landed` for the same operation writes no second row. Only a build's embedded speculative Welcome follows build deletion. Proof material
  (`commitOnceAcceptance`, `accepted.acceptance`, `reconciliation.acceptance`) is deleted only after this step.
- Closure: a `reconciliation` row, and any row whose source epoch is advanced, terminal or retired, closes; an `accepted` stage never overrides that
  classification. A row whose `applied` row at its epoch carries its `payloadDigest` closes `landed` at that row's position, never `unknown`; on a terminal
  incarnation an `intent` row closes `rejected` with `reason: 'removed'` as the self-removal rule says; every other closes terminal `unknown`. Each closure
  follows the final-report rule: any surviving provisional row (`unknownReported`) is deleted and one final outcome is written under a fresh ID; candidate,
  journal and embedded speculative Welcome are deleted.
- Live build: only a current, non-terminal source retains one. A legacy `built` or `accepted` stage whose `commitOnce` is at the current epoch becomes the
  build (Interfaces), with `opID`, `kind`, `revokes`, `enqueuedAt` and `deadline` copied from its operation row and the row removed from the FIFO;
  `hubAcceptedAt` or the `accepted` stage's position becomes `acceptedAs`; `unknownReported` becomes `reported`; `head` is the legacy `searchFrom`, where
  `null` is the empty prefix, not unavailable (only a record whose `searchFrom` field is missing falls back to the cursor position at migration).
  Coverage: the migrated build starts with `skipped` set unless trusted persisted evidence establishes the coverage predicate through its current cursor;
  absence of a legacy uncertainty field is not evidence. The cursor equal to `searchFrom`, with no `incomplete` mark, no `acceptance-unknown` hold and no
  `uncertainty`, is the one case that needs no reconstruction and starts with `skipped` unset.
- Ownerless slot: a legacy current-source `commitOnce` with no owning operation row is already closed work (legacy closure left the slot in place). It becomes
  `spentSource: { epoch }` (migration is the marker's second writer), reopening no publication and creating no outcome; its `welcomes` row, if any, is an
  obligation per the Welcomes bullet and its embedded speculative Welcome is deleted. An advanced or retired ownerless slot is deleted without a marker.
- A `built` row without a matching `commitOnce` (crash before the slot write) and every `intent` row on a non-terminal incarnation stay FIFO intents;
  `pendingPublish` is dropped (`expectedHead` lives on the build).
- No other spent-source marker is created: a consumed legacy `commitOnce` with an owner is closed above, and the marker only guards the matching source epoch.
- The `acceptance-unknown` control hold is removed; recovery-X state, the ordinary floor, settled rejoins and every other safety hold are preserved.
- `main`'s `CommitJournal` slot (`main:packages/rpc/src/commit.ts`, one host-provided pending commit: `publishID`, `expectedHead`, framed `epoch`,
  `holdsLogSends`, `acceptedAs`, `commit`, `bodies`, `kind`, host-opaque `journal`) is not a build: its journal is the host's blob, not a control journal.
  The migration transaction reports a non-empty slot to the host as `main`'s `LostCommit` (`kind`, `journal`; `ledger` carries its tokens) under a terminal
  `unknown` with a fresh ID, releases `holdsLogSends` and clears the slot; the host delivers its Welcome or re-issues. An entry carrying `acceptedAs` is
  reported the same way: hub acceptance is retry evidence, not adoption (D4).

**Welcome lifetime (r28 decision).** Once first-valid acceptance is durably proven, the complete Welcome is atomically persisted as an independent delivery
obligation. Only durable transport acceptance or host `abandon()` ends it; recovery, readmission, retirement (D2 :477), pruning, outcome ack and build deletion
preserve it under its originating incarnation, without re-validation. Any other Welcome lives exactly as long as its build and is deleted in the transaction that
deletes the build. No transaction may leave a Welcome without a build or obligation.

**Revoke hold (r28b decision).** A revoke holds retained log submissions (P2a D3 scope, never ephemeral traffic) while its intent or build exists. The transaction
that consumes its epoch, retires it or abandons it releases its hold whatever the outcome, as P2a's outcome-ends-hold rule: the host learns it may not have
landed and re-enacts it. A provisional `unknown` is not a settlement and does not release it: its bytes may already be at the hub, in flight, or in a copy the
walker has not yet met, so the revoke may still be adopted at its epoch. A built revoke therefore holds indefinitely when its source epoch never moves,
including after the deadline; host `abandon()` or authorised retirement is the exit. Rejected or expired unbuilt intents release their own holds.
The released fact survives ack and restart. Other holds are unaffected.
Release proves nothing about revocation: the target may still read later traffic until a re-enacted revoke lands.

**Adoption (r16 decision).** One transaction installs state/recovery trust/spent authenticator, applied row, external response when relevant, control cursor/outcome,
anchor changes and coupled settled outbox work. Recheck expected incarnation/identity/version inside the gate.
Already committed mutation or matching validated saved-work proof is idempotent. Hub acknowledgement alone writes no applied row/cursor.
(r28) An incoming commit whose payload is the saved build, at any stage, is the own-occurrence case above; P2a D5's "matches an `accepted` operation" reads so.
(r28b) Superseded P2a text: D3 step 3's head-mismatch search, `lost`/`unknown` and return-to-intent; D3 step 4's adopt-on-`accepted` and `moved` branch;
D4's obligation written with `accepted`; D5 startup step 7's settle-before-walk (startup only republishes a live build whose epoch is current and deadline
not reached, skipping one that carries `acceptedAs`, then walks; the walk settles); D5's post-removal `apply` for leftover operations; (r28c) D6's "settle operations first" before a rejoin `built`
(a `built` operation republished or searched, an `accepted` one adopted or kept on `moved`): the peer instead runs the eligible identical retry, then the
ordinary walk, and the rejoin's switch transaction closes whatever is still live. Recovery never depends on a search or an adopt-on-`accepted` path. The
source-switch transaction, not RecoveryCompletion, closes every live build of the source (terminal `unknown`, speculative Welcome deleted, obligations kept);
RecoveryCompletion afterwards writes only `reenact`.
The current incarnation's terminal flag governs self-removal, independent of old epoch sorting.

### D5. Codecs, registry and application keys

**State codec.** Preserve `encodeClientState(state)` / `decodeClientState(bytes)` signatures.
(r28e, user decision) Version 2 is the ONLY client-state format, on `main` 0.10.7 and phase 2 alike:
`u8(2) || u8(flags) || [u64(epoch) || u32(generation) || u8(consumed)] || u32(bodyLength) || ts-mls body || u32(refCount) || refs`, big-endian;
`flags` is 0 (no reservation) or 1 (reservation; the three bracketed fields are present only then and carry `handshakeReservation` unchanged: epoch,
generation, consumed); each sorted ref is `u32(UTF8Length) || UTF8(proposalRef)` and names exactly a pending proposal with sender zero.
Decode a copied body, then restore zero. Duplicate/unknown refs, non-absent body sender, invalid lengths/UTF-8, a flags value other than 0 or 1, a
`consumed` byte other than 0 or 1 and trailing bytes refuse. Empty/truncated input returns undefined. The codec reads v2 only and writes v2 only; v1, v3,
v4 and unknown version bytes are refused (throw). The merge carries this identical codec; phase 2 adds the flags byte and the reservation fields to its v2
layout at merge, and the handshake-reservation semantics travel in that field. No rewrite, legacy decode rule or client-state migration exists.
**Imported reservation (r28g, user decision).** Phase 2 never writes a reservation (it writes flags 0). A state written by `main` 0.10.x may carry
`{epoch E, generation g, consumed}`: that device may already have framed and handed off a commit at (E, g) and lost the CAS, with no phase-2 build
record. On every restore of such a state (restricted and unrestricted handles alike, so no proposal or direct build can reuse (E, g)), and again
inside the commit permit before constructing any commit (then a no-op): if the reservation's epoch equals the handle's current epoch, the handshake ratchet
advances past g (whether `consumed` is true or false; a ratchet already past g is unchanged); a reservation at any other epoch is ignored. The field
is then cleared and the permit's state save writes flags 0. This burns at most one generation, never stalls, exports no reservation API and
changes no codec rule; a crash before the save repeats the same idempotent advance.

Recovery candidate v3 uses AAD `kumiai/recovery-candidate/v3` and complete
`sourceState = encodeClientState({...snapshot.state, ratchetTree: snapshot.sourceTree})`.
Decode it separately; never splice private-state bytes by envelope offsets. Refuse v1/v2 candidates for new adoption.
Keep requestKey, binding/holder evidence, exact-external-commit confirmation tuple, authenticated reply, immutable source/target/captureHead and original search origin.
Legacy unadopted records lacking capture metadata, including non-null conflictEpoch, retain bytes/stage under unsupported-version hold.
They never fabricate metadata, publish/adopt or silently settle. Authorised manual recovery supplies their exit while preserving saved history.
Legacy adopted work finishes only with proof of its existing installation.
Candidate v3 retains existing full sourceState and its codec. The separate prospective metadata journal retains no plaintext.
Only superseded-branch provenance requires the additional sealed exact-X history described in D1.
**Registry.** Await shared cold load/restore/configuration validation before access. Validate groupID, epoch, credential and authenticator;
missing/tombstoned/invalid records expose no fabricated handle. Host supplies context/policy/resolvers and ordered tokens including repeats.
Only proven commits install runtime snapshots/notifications. Snapshots contain incarnation, epoch/authenticator, version, membership and
availability; publish defensive copies and contain listener failures. Simple access remains available.

**Application leases.** Scoped to incarnation/epoch/authenticator: reserve 16 generations, renew below 4, ceiling 500.
Pre-reserve the first lease with state installation; refill via independent durable work or coalesce with a ready transition.
Restore needs no skip: reservations advance the committed state. Failed/unpublished seals and unused skipped generations count.
Same-identity saves retain maximum ceiling/current progress; new epoch resets its ceiling; new incarnation inherits neither.

(r26) A reservation advances the committed state.
- A reservation is one transaction. Every acceptance first relinquishes the caller's input: it is send-denied irreversibly, and encryptions already admitted drain. Only then is the input validated, compared or encoded. Divergence found by revalidation is refused. It then snapshots the state at `g = max(own, senderHWM)` and advances the stored sending ratchet by encrypt-and-discard to `min(g + 16, 500)`, saving that.
- Only after commit proof may the private in-memory send copy, built from the snapshot, use `[g, min(g + 16, 500))`.
- Invariants: every copy's limit is at most the committed stored own generation, and no send-capable handle other than the copy holds state below it. Memory loss only wastes generations.
- Every installing write reserves in its own transaction and hands its snapshot to the registry in memory.
- Renewal below 4 is a new reservation. It extends the copy only when it starts at the copy's limit with unchanged send eligibility; otherwise the copy is replaced or refused.
- The copy is dropped on owner loss, identity change, send-eligibility change, and a stored version above the one this registry accounted for.
- Application send policy only narrows. `denyApplicationSend` is irreversible and inherited by derivation; `bindSendCeiling` binds once. Registry-backed access denies every handle it issues or accepts. Control-build permit clones are denied for every host. Simple access otherwise sends as before.

Lapsed/removed/suspended/pending-proposal restore permits control/pending replay; defer the reservation until encryption is allowed. Seals use only committed reserved ranges; there is no per-seal burn.
At effective next generation 500, reject new durable acceptance, hold accepted entries awaiting a fresh seal
and schedule one rotation outside the gate. Lapse takes precedence. Directed replies/tunnels obey the same bound.

(r26) Effective next generation is the send copy's own generation when one exists, otherwise the committed stored generation.
- At 500 admission reports `rotation-required` (not recovery-only). GroupMLS applies this at every admission update. New durable acceptance refuses, and a frame sealed below 500 still hands off.
- The registry peer runs one outside-gate scheduler per identity. Through a private internal enqueue (the public enqueue refuses the namespace), it enqueues a deterministic, non-revoking, library-built auto-rotation whose id lies in the reserved `kumiai/internal/` namespace.
- Enqueue errors and rejected attempts back off with a cap. Outcomes in that namespace go to the registry, never to the host, across restart.
- (r28b) A CAS loss is not evidence. The walk decides: a built rotation settles `lost` only on walker-validated supersession with complete coverage, otherwise its consumption closes it `unknown` (D4); an unbuilt stale intent settles `rejected`. The scheduler re-enqueues only after its build is closed; the new epoch resets the ceiling, so it re-evaluates admission rather than re-enqueueing on `lost` alone.

Registry hosts/doubles require generation retention/forward steps >=1000 through create/restore/Welcome/external join/derive/recovery.
Ordinary callers have a maximumForwardRatchetSteps floor of 500, including explicit lower overrides. Higher values remain effective.
Non-admin rotation passes lifecycle checks, includes an update path, empty proposals/entries and unchanged roster/ledger; it keeps the app anchor unless
membership changes. No handshake HWM/reservation/budget exists (the v2 codec's flags field still carries `main`'s reservation fields, State codec r28e).

### D6. Application publication and settlement

Outbox stores immutable plaintext, not application ciphertext or acknowledgement proof.
Each seal gets a fresh publishID and attempt containing incarnation, seal epoch, anchor epoch, floor and exact topicID.
Attempt/state/lease writes commit together before transport handoff. Failed/null in-process handoff retries prepared bytes/ID from memory.
Restart reseals only unproven active-incarnation entries. Epoch/authenticator or anchor-topic change invalidates prepared bytes;
a head-only move does not. Incarnation retirement fails entries without resealing.

Both proof paths and acknowledgements bind incarnation/epoch/authenticator, sealVersion and acknowledgement cutoff.
Snapshot before/after sealing/walking; suspend snapshots during uncertainty. A crossed walk, stale ack or no-new-head probe cannot
certify a replacement identity. The client result remains `{sequenceID}`; HTTP adds no `deduped` field.

**Durable settlement.** Before freezing proof persist `{sequenceID, attemptID, topicID, outcome: 'published'}`.
Capture expected identity/stateVersion/attemptID before queuing; inside the acquired gate/transaction reread live state and entry.
Require exact identity/version/attempt and stored topicID. Mismatch returns `recorded: false` with reason and changes nothing,
including hooks/markers/evidence. Gate-first certification commits before queued terminal/switch work; adoption-first invalidates stale proof.
Rollback retries retain the gate; ambiguity uses D7's completion barrier. Test both proof paths and both acquisition orders.

Obligated attempts cannot change. Identical obligation is idempotent; conflicting outcome rejects. Removal co-deletes entry/obligation and writes published
status/effects in one transaction. Generic remove/terminal/switch clearing honours certified obligations; only unproven entries fail. Frozen occurrence retains
original incarnation/anchor epoch/position/sealed topicID after restart. Disposal retains a storage-only finaliser; lifecycle drain waits for it. Restore obligations
before sends/clearing. Statuses: `pending → accepted → published` or `accepted → failed`; acceptance follows enqueue commit. Transactional effects co-write status;
others consume stable events idempotently until ack. Correlate host messages by semantic identity.

Unknown/repeated remove has no extra effect; protocol/procedure/data remain immutable. Decode fatal UTF-8 JSON, broadcast v2, event type and matching procedure;
invalid input rolls back acceptance. Return `{procedure: entry.prc, payload: decoded.payload.data ?? {}}`. Memory hub dedup becomes `(topicID, publishID)`, with
original acceptance time and SQL's inclusive 365-day purge cutoff; trim/ack/retries do not refresh it. Refused CAS claims no durable ID; accepted retry returns its
original position.

### D7. At-rest protection, completion and external seams

Every factory requires host `AtRestCodec.seal/open(bytes, aad)`. Host owns all key lifecycle; kumiai stores no at-rest key.
Seal every persisted namespace, including lifetime/spent set, state, control, anchors/secrets, pending, cursors, outbox/meta,
events/obligations, recovery targets and topicIDs, including retained retired records.
Device package/receipt/cleanup/restore-work rows and group recovery trust also require at-rest protection (r16 decision).
Queryable group/incarnation/sequence keys, revisions/locks/mutation markers may remain clear.
Topic locator is a digest; actual topicID exists only inside sealed values.
AAD is UTF-8 JSON of `['kumiai/at-rest/v1', groupID, incarnationOrNull, namespace, recordID]`:
lifetime/trust/checkpoints use null; checkpoint values include GroupKey; state/control/anchor use fixed slots; pending uses frame ID; cursor uses topic digest;
outbox uses String(seq); metadata/event IDs use tagged tuples. Physical duplicates retain logical AAD identity.
Device-scoped records use ownerDID, null incarnation, distinct namespaces and sourceID/ref or work ID (r16 decision).
Seal failure rolls back the whole transition; open failure exposes no handle/payload or plaintext fallback.
Memory persists sealed bytes without a plaintext shadow map. Provider encryption alone cannot satisfy this contract.

**Ambiguity.** Rejected COMMIT can still commit. Ownership, phases and proof sequencing follow D8. One mutationID/revision and coordinator own completion across all namespaces.
Keep the group gate, started-operation set and both hook queues until proof. Never release payload/state/callers on raw negative reads.
State-free P2a apply may throw canonical `StorageOutcomeUnknownError`; `lastMutation()` first performs the same completion barrier.
Each transaction unconditionally upserts/updates retained `groupOwner(groupID)`. After uncertainty, a fresh root transaction takes
that lock, then reads markers in subsequent statements. Postgres READ COMMITTED waits on the original owner-row writer.
SQLite/Expo require completed COMMIT/ROLLBACK or a clean connection plus first-write writer-lock barrier.
Quarantine uncertain connections. Acquisition/timeouts alone prove nothing. Retry barrier/read failures from 100 ms doubling to 15 s,
outside transactions; other groups continue. Matching mutation proves the whole commit; exact previous revision proves rollback only
after the barrier. Unexpected marker is ownership conflict. Marker survives deletion/switch to prevent late resurrection.

Known completion settles its commit/rollback hooks before caller release. Unknown completion retains both queues and a settlement token;
marker proof settles exactly one queue, or none when an ownership conflict fail-stops the factory (D8), before state installation/release. Repetition is idempotent; contradiction is ownership error.
Contain hook exceptions. After process death durable events/status/obligations supply replay.
Phase 3 requires `StoreProvider.scope: 'root' | 'transaction'`; factories reject non-root providers with `NonRootProviderError`.
Use only supplied transaction stores, await every started write, CAS through plain UPDATE affected counts including Expo.
Nested inline transactions cannot supply completion boundaries.

**Device scope and remaining seams (r16 decision).** Welcome install spans group and device package/receipt/cleanup namespaces in one provider transaction.
Package operations acquire device package-row ownership before the group owner; no group-held callback acquires it later.
Serialise only package-pool/device rows across groups, including provisioning/invalidation. Ordinary group transitions remain independent.
Device transitions fence retained `deviceOwner(ownerDID)`; Welcome touches both owners with one mutationID and validates both revisions.
Completion barriers fence every touched owner/marker; ambiguity keeps both ownership scopes and hook queues until proof.
Burn the ordinary private record and write its receipt during install. Hub-copy cleanup alone remains external.
Device-level cleanup rows outlive tombstones/retirement. Retry with backoff after restart; delete only after confirmed removal/expiry.
The current hub has no targeted removal API: eager ordinary-copy cleanup is impossible there; wait for fetch/expiry, never restore local keys.
A cleanup-capable adapter proves the conformance completion case. Unsupported revocation preserves the recorded residual, not fabricated success.
Control publication/confirmation and Welcome delivery remain network seams. Deliver Welcomes at least once and delete obligations
only after transport acceptance. Revoke holds cover retained submissions; D1 fork halt additionally covers ephemeral sends.

Deletion blocks owner creation, stops/disposes peer and awaits opened handlers, completion, submitted network work, finalisers and ambiguity resolvers outside the
gate. One transition tombstones/clears transport state with optional host effects. Unsettled control in any incarnation refuses with canonical
`GroupControlUnsettledError`; explicit abandon/ack is the escape (after its removal transaction a self-removed group holds no build, intent or rejoin record, D4 r28d, so acks plus Welcome delivery or `abandon()` of the remaining obligations suffice; the spent marker never blocks deletion). Host history, recovery trust/spent set and device cleanup rows survive. No timeout/rejected save
authorises lifecycle handoff.

Lift authenticated opened epoch metadata on durable replay/live/ephemeral, anycast and all directed invocation kinds.
Optional broadcast transit metadata carries epoch; group adapters require it, with no current-epoch fallback.
Transport sender/epoch overrides spoofed wire/header fields. Directed `kumiai/epoch` describes the invoking frame.
Extract MLSEncryptor over loaded registry access/committed snapshots; receive reports exact successful-open counts.
Sequential epoch advance with unchanged incarnation/surviving membership keeps a tunnel; unavailable membership, removal, jumps or switch
close it once. Keep sender checks, stale-reply retirement and disposal unsubscribe.
Hub-client buffer injects inspectEpoch/currentEpoch/onEpochChanged: unauthenticated prefilter, malformed/unknown frames pass through,
notifications wake work, disposal unsubscribes and reconnect/retry preserves retention.
Automatic origin `/info` integration remains blocked; phase-2 HTTP smoke injects server DID.

### D8. Ownership queue and phases (r17 decision)

One model owns all persistence concurrency. It supersedes layered barrier/store-lock/gate/finalisation-fence mechanisms; D2, D3, D7
rules on ownership, gates, ambiguity and callback restrictions are expressed through it. Providers implement only the D8 primitives.

**Scopes.** One FIFO, non-reentrant owner queue per `deviceOwner(ownerDID)` and per `groupOwner(groupID)`, keyed by ID and surviving
incarnation switch/deletion; stale handles reject. Independent groups never share a queue. Backend writer limits never become a global
application mutex. Queues are application structures in `mls-rpc`, identical for every provider. "Group gate" and "owner gate" elsewhere
in this spec mean the group owner slot. The D3 scheduler selects work before queue admission, so lane priority and round-robin bounds hold
under FIFO slots.

**Entries.** Every root persistence operation is one entry; warmed ephemeral registry seal/receive (D3) is not and opens no transaction.
`Transition` (group save/transition/delete, or device-only package/cleanup/restore work) and `Combined` (Welcome/combined device+group
transition) may become ambiguous. `Read` (root `loadState`, `load`, `lastMutation`, facade, device and package reads) never becomes
ambiguous and retains nothing: any failure, including an unknown backend outcome on its read transaction, rejects that read and releases
at once. A `Read` still queues behind every earlier unsettled entry, including one whose rows committed but whose hooks have not settled.
Marker proof is not an entry; it runs inside the retained entry it resolves. `Combined` joins the device queue; at its head it holds the
device slot and waits for the group slot (device rows already serialise across groups). Cancellation or rejection while waiting withdraws
the group waiter and releases the device slot; a group grant racing that cancellation is released at once. An entry holding a group slot never acquires a device slot and refuses instead of waiting.

**Phases.** An entry moves strictly through, never overlapping:

| Phase           | Provider tx         | Domain writes (state, trust, lifetime, incarnation, ownership, spent) | Side writes (control, anchor, pending, cursor, outbox/meta, events, package/receipt/cleanup/restore, host effect rows) | Reads                           |
| --------------- | ------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| queued          | none                | refuse                                                                | refuse                                                                                                                 | refuse                          |
| prepare         | none                | refuse                                                                | refuse                                                                                                                 | entry-bound reads of own scopes |
| work            | open                | allowed                                                               | allowed                                                                                                                | allowed                         |
| finalise        | open                | coordinator only                                                      | coordinator only                                                                                                       | coordinator only                |
| effects         | open                | refuse with `PersistencePhaseError`                                   | allowed                                                                                                                | allowed                         |
| account         | open                | coordinator only                                                      | coordinator only                                                                                                       | coordinator only                |
| outcome         | closing             | every supplied store and entry capability expires                     |                                                                                                                        |                                 |
| ambiguous/proof | fresh proof tx only | refuse                                                                | refuse                                                                                                                 | refuse                          |
| settled         | none                | refuse                                                                | refuse                                                                                                                 | refuse                          |
| released        | none                |                                                                       |                                                                                                                        |                                 |

Refusals apply to every store or transaction access bound to the entry's provider transaction, however constructed, not only supplied wrappers.
`prepare` holds the owner slot outside any provider transaction for crypto preparation and, per owner scope, the first entry of any kind
after process start runs the completion barrier plus marker check before proceeding. Its reads use an entry-bound read capability that reuses
the entry's ownership and reads committed rows; root calls from `prepare` are reentrant and refuse.

**Store operations (r18 decision).** One per-entry operation lock admits one store operation at a time for its whole read-modify-write,
including codec I/O and, for async providers, backend statements, so no two operations interleave and none overwrites another's result.
Operations never nest: a store implementation, coordinator helper or read callback never invokes a public store method or another locked
operation from inside an operation, only private unlocked helpers under the one reservation, and never holds a reservation around a
callback allowed to invoke public stores (package-read callbacks call individually locked stores without an outer reservation). Host
callbacks invoked inside an operation (codec seal/open) receive no store access, and any store call they make is caller misuse. Lawful use
therefore cannot wait on itself through the lock. An allowed store call registers its operation synchronously before returning its promise,
including while it waits for the lock; execution is serial. A phase change closes admission for the outgoing phase at once, freezes that
phase's registered operations and drains all of them, including abandoned ones, using their captured bindings, so phases never overlap and
every registered operation settles before `outcome`. Store wrappers stay attempt-bound and evaluate each new call against the current
phase table: `effects` reopens public side writes and reads, and `finalise`/`account` admit only the private coordinator writer. Drainage
has no wall-clock bound: progress assumes codec and backend calls settle, and operation callbacks must not depend on phase advancement,
entry outcome, completion hooks or another operation queued behind their reservation. `maxBatchWorkMs` bounds staging, not codec/backend
latency or drainage; elapsed time alone never proves completion or authorises ownership release. Phase changes are coordinator actions,
never reachable from host code. The entry records every fatal operation failure (a seal failure, a failed required open, or any failure after an
operation changed rows) independently of the lock, including when the caller abandoned or caught it; such a transition is rollback-only and
draining cannot clear that. A private coordinator diagnostic may classify unreadable MLS state for authorised control/meta-only safety work
without poisoning it; that never permits state use, payload release, publication or bypassing required trust validation, and unreadable
records stay preserved. A refused access that was never admitted and changed nothing does not poison it. Each operation, store and writer is
bound to its entry, provider transaction and attempt; cancellation, fail-stop or a retry attempt revokes the old bindings, rejects pending
operation promises, discards late results, and lets backend rollback/completion proceed without waiting for a suspended host callback.
Work or effect rejection revokes outstanding operations before rollback/completion. A failed `Read` immediately revokes its attempt
bindings, rejects pending operation promises and releases application ownership without awaiting host callbacks; it retains no proof or
hook queue, and the provider independently completes or quarantines its backend transaction before connection reuse. `Transition` and
`Combined` ownership releases only after a known completion, or stays retained for unknown-outcome proof.

**Coordinator authority (r18 decision).** `finalise` and `account` read and write through a private coordinator writer created per entry
and attempt, with its own private access path to the provider transaction, never passed to host code or the `ownershipContext` port;
possession of that object, not ambient context, is the authority. Public and copied transaction views never inherit it. Every other access
during `finalise` and `account`, including host accessors, effect getters, codec callbacks and stores constructed from the raw transaction,
is refused. Codec calls made by the writer run as host code without that authority. `finalise` (validation, domain persistence, trust/spent/tombstone, version accounting) completes before `effects`
begins, so a host effect calling supplied stores never waits on finalisation. `account` runs after effects: it validates effect side
writes against their incarnation and advances the state/metadata versions they require (Interfaces, D6). Host-controlled values `finalise`
and `effects` need (the effects record's callable fields and any getter results) are captured before `finalise`, never read by invoking
host code under coordinator authority. Capability validation, transaction participation, scope ordering, prepare reads, proof execution
and joining, Combined participation, hook settlement and fail-stop use explicit entry and transaction bindings, never ambient context.

**Exceptions.** A transactional _effect_ (awaited in `effects`) that throws rolls back the whole transition, including its rows. A completion
_hook_ (`onCommit`/`onRollback`, run in `settled`) that throws is contained; remaining hooks still run and the outcome stands.

**Outcome and proof.** The provider reports `committed`, `rolledBack` or `unknown`. Known outcomes settle exactly one hook queue, then
release. `unknown` keeps the entry at its queue head in `ambiguous`, retaining slots, the started-operation set, a settlement token and both
hook queues; no read or transition passes it. Proof: retry from 100 ms doubling to 15 s outside transactions; open a fresh root transaction,
run the provider barrier on every owner the entry touched, then read markers in later statements (D7). Classification per touched owner:
marker carries this entry's mutationID is `committed`; marker equals the exact `{mutationID, revision}` read before this entry's work (or is
absent when the owner was absent) is `rolledBack`. `Combined` is `committed` only if both owners say so, `rolledBack` only if both do.
Any other result is `conflicted`. Conflict proves another writer owns the database, which D2 forbids, so the persistence factory
fail-stops: no hook queue runs and both are dropped, no further transaction is opened, the caller and every queued or later entry on any
scope reject with `GroupStateConflictError`, and recovery is a process restart where durable markers, events and obligations replay (D7). Fail-stop is atomic
across every entry already active on any scope and every joined resolver: callers reject with `GroupStateConflictError`, hook queues and
started operations are dropped, entry capabilities expire, pending proofs and drains awaiting those entries end with the same error,
and the provider rolls back or disposes already-open backend transactions through connection completion without opening new ones. Otherwise settle exactly one queue, containing hook exceptions, then release. After a known rollback an entry whose owner declares
retry (D6 certification) re-runs `work` through `outcome` with a fresh provider transaction while keeping its slots. Retries back off like proof (100 ms doubling to 15 s); a D6 mismatch on retry
returns `recorded: false` and ends the entry. Callers
receive the saved result or rethrown `StorageOutcomeUnknownError`. External `resolve(groupID|ownerDID, mutationID)` joins a matching pending
proof rather than queueing; with none pending it runs as a `Read` that performs the barrier, answers `committed` only when the marker carries that
mutationID, and otherwise throws `GroupStateUncertainError` (superseded or unclassifiable); it never answers from a raw negative read.

**Deletion.** Persistence entries are never admission-blocked; D7 blocks runtime owner creation only. Deletion drains handlers,
completion transactions, submitted network work, finalisers and ambiguity resolvers outside the slot (D7), then enqueues its `Transition`,
which revalidates under the slot. If work was opened meanwhile it releases and drains again; after three attempts it refuses with
`GroupControlUnsettledError`. D7.s runtime owner-creation block is lifted whenever deletion returns without a committed
tombstone (refusal, cancellation, rollback, unknown resolved as rollback or fail-stop); after a committed tombstone D2 readmission governs.

**Reentrancy (r18 decision).** Core logic is runtime-neutral (Node, browsers, Hermes) and uses no runtime-specific async-context API;
`ownershipContext` only diagnoses public root reentrancy. A root call from inside an active entry (prepare, work, finalise, effects,
account, proof, hook) is caller misuse and rejects promptly with `ReentrantOwnershipError` whenever detectable: always during the
synchronous run of any entry callback, host accessor, codec call, hook or proof step (the queue sets a synchronous marker for that run and
restores it in `finally`), and also after `await` when the host supplies the optional factory port
`ownershipContext?: OwnershipContextPort`, `type OwnershipContextPort = { run<T>(token: object, fn: () => T): T; get(): object | undefined }`
(for example a Node `AsyncLocalStorage` adapter or a TC39 `AsyncContext.Variable`). The port must propagate the token through async
continuations and restore nested bindings, including after exceptions. Core passes an opaque token with no methods or capabilities,
recognises tokens only by private identity, and ignores released ones; released entries are never reported as current and independent
callers stay unbound. Without the port a root call after yielding may be undetectable: awaiting it may deadlock through same-scope or
cross-scope dependencies, and an unawaited one may run after release. This limits diagnostics only, never lawful entry-bound operations.
Entry-bound capabilities are the only legal path inside an entry. Ordinary handlers and network I/O run outside every entry.

**Provider primitives.** Open transaction for work through account; report outcome; completion barrier; marker read after barrier; CAS by
affected count. The barrier may create owner rows internally with the marker-neutral value `{mutationID: null, revision: 0}`, classified as absent;
it never advances a marker. That is distinct from entry stores and not a phase violation. Any transaction whose COMMIT or ROLLBACK
result is unknown, including `Read` and barrier transactions, quarantines its connection, and the provider completes it before that
connection or the writer lock is reused, independent of proof.
Memory: private view over committed sealed snapshot, merge/discard, fault injection, backend completion barrier.
SQLite and Expo: `BEGIN IMMEDIATE`; a COMMIT error is `unknown` and quarantines the connection. Completion means: retry COMMIT to a
result, or prove ROLLBACK, or dispose of the connection, where disposal requires every statement finalised and the driver confirming the
connection destroyed (a returned close call alone proves nothing). Only then does the barrier take
a clean connection's first-write writer lock. PostgreSQL: the barrier upserts each touched owner row (`INSERT … ON CONFLICT DO NOTHING`,
which waits on an uncommitted original insert) then `SELECT … FOR UPDATE`; READ COMMITTED marker reads follow in later statements.
All: plain `UPDATE` affected counts.

**Provider evidence.** Every provider (memory in phase 2; SQLite, PostgreSQL and Expo in phase 3, or Expo's explicit blocked reason) passes
the ownership-phases conformance suite and its real-database integration row. D2's single live process still holds; extra connections or
processes in these tests contend the backend only. Each integration case injects a named fault milestone and asserts what blocks, what is
visible to a second connection, and which hook queue runs, with connection identity recorded: (a) group A ambiguous after COMMIT sent,
group B commits meanwhile on another connection (SQLite: B may wait only for the active writer, never for A's unsettled entry); (b) late
COMMIT and late ROLLBACK each proved through the barrier, including an initially absent group and device owner; (c) crash/restart before
proof, first entry per owner runs barrier and marker check; (d) uncertain connection quarantined and completed before proof; (e) Combined
device+group ambiguity settles both scopes once; (f) conflicting marker fail-stops the factory with no hooks; (g) a failed Read or barrier transaction is completed and the writer
lock freed for the next writer. Memory alone cannot satisfy a
database provider's row.

## Interfaces

Types in this section are normative. Existing P2a types retain unlisted fields.
Incarnation-scoped adapters cannot silently substitute the active incarnation for a stale caller.
Conformance mirrors reproduce these fields and signatures without importing implementation packages.

### Group persistence and transactions

```ts
export type GroupKey = { groupID: string; incarnation: number }
export type EpochIdentity = GroupKey & { epoch: number; authenticator: Uint8Array }
export type PackageUse = { sourceID: string; ref: string; kind: 'ordinary' | 'last-resort' }
export type GroupLifetime = {
  groupID: string
  latestIncarnation: number
  activeIncarnation: number | null
  revision: number
  mutationID: string
  restorePending: boolean // (r15 decision) cleared only by fresh-incarnation resync
}
export type GroupStateRecord = GroupKey & { version: number } & (
    | { deleted: true }
    | {
        deleted: false
        terminal: boolean
        epoch: number
        epochAuthenticator: Uint8Array
        state: Uint8Array | null
        credential: { id: string; groupID: string }
        ledger: Array<string>
        senderHWM: number
        // r26: committed own application generation reserved for this record's epoch; mirrors the stored sending ratchet after a reservation
      }
  )
```

(r25) `GroupOptions.keyRetention.retainKeysForEpochs` is host-configurable: default 4, an integer from 1 to 32; anything else throws KeyRetentionRangeError. Registry handles and storage guards enforce the configured epoch count, and every skipped-key index is a safe integer below its ratchet's generation.

```ts
export type GroupTransaction = {
  providerID: string
  groupID: string | null
  onCommit(fn: () => void): void
  onRollback(fn: () => void): void
}
export type IncarnationStores = {
  state: { load(): Promise<GroupStateRecord | null>; save(record: GroupStateRecord): Promise<void> }
  control: {
    load(): Promise<ControlSnapshot>
    apply(changes: ControlChanges, mutationID: string): Promise<void>
  }
  anchor: { load(): Promise<AnchorSlot | null>; save(slot: AnchorSlot | null): Promise<void> }
  pending: {
    list(): Promise<Array<PendingAppFrame>>
    put(records: Array<PendingAppFrame>): Promise<void>
    poison(records: Array<AppPoisonRecord>): Promise<void>
    listPoison(): Promise<Array<AppPoisonRecord>>
    complete(ids: Array<string>): Promise<void>
  }
  cursor: {
    load(topicID: string): Promise<string | null>
    save(topicID: string, position: string): Promise<void>
  }
  outbox: {
    list(): Promise<Array<AppOutboxEntry>>
    put(entries: Array<AppOutboxEntry>): Promise<void>
    remove(seqs: Array<number>): Promise<void>
    clear(): Promise<void>
  }
  meta: {
    loadSettlement(seq: number): Promise<AppSettlementObligation | null>
    putSettlement(seq: number, value: AppSettlementObligation | null): Promise<void>
    events(): Promise<Array<PersistenceEvent>>
    putEvents(events: Array<PersistenceEvent>): Promise<void>
    ackEvent(id: string): Promise<void>
  }
  clearTransport(): Promise<void> // preserves owed outcomes/Welcomes, fork evidence and unacked events
}
export type GroupStores<TTx extends GroupTransaction> = {
  tx: TTx
  lifetime: { load(): Promise<GroupLifetime | null>; save(value: GroupLifetime): Promise<void> }
  trust: {
    load(): Promise<GroupRecoveryTrust | null>
    save(value: GroupRecoveryTrust): Promise<void>
  }
  incarnation(incarnation: number): IncarnationStores
}
export type GroupTransition = {
  groupID: string
  mutationID: string
  expected: { revision: number; activeIncarnation: number | null } | null
}
export type GroupPersistence<TTx extends GroupTransaction> = {
  load(groupID: string): Promise<GroupLifetime | null>
  loadState(key: GroupKey): Promise<GroupStateRecord | null>
  loadTrust(groupID: string): Promise<GroupRecoveryTrust | null>
  list(): Promise<Array<GroupLifetime>>
  ports(key: GroupKey): GroupPersistencePorts
  transition<TValue>(
    change: GroupTransition,
    work: (stores: GroupStores<TTx>) => Promise<TValue>,
  ): Promise<TValue>
  resolve(groupID: string, mutationID: string): Promise<'committed' | 'rolled-back'>
}
export type GroupPersistencePorts = {
  key: GroupKey
  control: ControlStore
  outbox: AppOutbox
  anchor: AnchorStore
  cursor: AppCursorStore
}
export type AtRestCodec = {
  seal(plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
  open(ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
}
export type TransactionHookSettlement = { settle(outcome: 'committed' | 'rolled-back'): void }
export type OutcomeAwareTransactionOptions = {
  onUnknown(settlement: TransactionHookSettlement): void
}
export type GroupBatchOptions = {
  maxBatchFrames?: number
  maxBatchDelayMs?: number
  maxBatchWorkMs?: number
}
export type OwnershipContextPort = {
  run<T>(token: object, fn: () => T): T
  get(): object | undefined
}
```

Transition-bound methods never transact or join an owner queue; the coordinator owns validation/sealing/hooks and completion proof.
Expected null means absent lifetime, never a tombstone. Lifetime revision advances per transition; state version per MLS state, control, anchor, outbox, meta or trust change; pending, poison and cursor writes never advance it (r25).
Enforce incarnation/epoch/authenticator/spent rules independently of CAS. Stores are group-bound and expire with their phase/attempt binding; operations admitted before expiry still complete unless revoked.

### Device persistence and retained trust (r16 decision)

```ts
export type GroupRecoveryTrust = {
  groupID: string
  genesisAnchor: Uint8Array
  installed: EpochIdentity
  signerTree: ClientState['ratchetTree']
  registry: DeviceRegistry
  credential: MemberCredential
  binding: ControllerBinding | null
  ledger: Array<string>
  ciphersuiteName: string
  spentEpochAuthenticators: Array<Uint8Array>
}
export type HubCleanupRow = PackageUse & {
  id: string
  ownerDID: string
  groupID: string | null
  notAfter: number
}
export type RestoreWork = {
  id: string
  stage: 'invalidate' | 'rotate' | 'groups'
  remainingGroups: Array<string>
}
export type DeviceRecord = { revision: number; mutationID: string; restoreWork: RestoreWork | null }
export type DeviceStores<TTx extends GroupTransaction> = {
  tx: TTx
  group: GroupStores<TTx> | null
  ordinary(sourceID: string): KeyPackagePoolStore
  lastResort(sourceID: string): LastResortStore
  cleanup: {
    list(): Promise<Array<HubCleanupRow>>
    put(row: HubCleanupRow): Promise<void>
    remove(id: string): Promise<void>
  }
  restore: { load(): Promise<RestoreWork | null>; save(work: RestoreWork | null): Promise<void> }
}
export type DevicePersistence<TTx extends GroupTransaction> = {
  providerID: string
  ownerDID: string
  groups: GroupPersistence<TTx>
  load(): Promise<DeviceRecord>
  transition<TValue>(
    change: { mutationID: string; expectedRevision: number; group: GroupTransition | null },
    work: (stores: DeviceStores<TTx>) => Promise<TValue>,
  ): Promise<TValue>
  resolve(mutationID: string): Promise<'committed' | 'rolled-back'>
}
export type DevicePackageAdapters = {
  providerID: string
  ownerDID: string
  sources: Array<BundleSource & { kind: PackageUse['kind']; providerID: string; ownerDID: string }>
  stores: Array<{
    sourceID: string
    kind: PackageUse['kind']
    providerID: string
    ownerDID: string
    store: KeyPackagePoolStore | LastResortStore
  }>
  rotateAvailability(): Promise<void> // durable fresh provisioning; uploads stay outside transactions
  cleanup(row: HubCleanupRow): Promise<'removed' | 'expired' | 'retry' | 'unsupported'>
}
```

`DevicePersistence` owns all group, package, last-resort, trust/spent, cleanup and restore-work namespaces on one provider/loss boundary. Transaction-bound package
stores never nest transactions; their root provisioning facades use device transitions and the same ownership barriers. Factory validation rejects foreign
provider/owner/source IDs and missing/duplicate store participants. Receipt-bearing refs can never regain private records. `signerTree` contains public nodes only,
never retained private ratchets. Every epoch installation refreshes trust atomically; its immutable anchor never changes. Trust corruption does not corrupt clear
lifetime locators.

### Registry, control and handlers

```ts
export type GroupRuntimeSnapshot = EpochIdentity & {
  stateVersion: number
  members: ReadonlySet<string>
  available: boolean
}
export type GroupEpochRuntime = {
  snapshot(): GroupRuntimeSnapshot | null
  onEpochChanged(listener: (value: GroupRuntimeSnapshot | null) => void): () => void
}
export type SendAdmission =
  | { epoch: number; admissible: true }
  | {
      epoch: number
      admissible: false
      reason:
        | 'lapsed'
        | 'rotation-required'
        | 'stranded'
        | 'fork-halted'
        | 'terminal'
        | 'backup-restored'
        | 'spent-set-corrupt'
        | 'recovery-unavailable'
    }
export type SealedApp = { ciphertext: Uint8Array; epoch: number; generation: number }
export type ReceiveInput = { ciphertext: Uint8Array; expectedAAD: Uint8Array } // callers with no expectation pass the frame's clear AAD
export type ReceiveResult =
  | {
      kind: 'opened'
      payload: Uint8Array
      senderDID?: string
      aad: Uint8Array
      frameEpoch: number
      handleEpoch: number
    }
  | {
      kind: 'refused'
      reason: 'past-epoch' | 'future-epoch'
      frameEpoch: number
      handleEpoch: number
    }
  | {
      kind: 'refused'
      reason:
        | 'log-intent'
        | 'consumed'
        | 'closed-epoch'
        | 'generation-bound'
        | 'capacity'
        | 'invalid'
      error?: unknown
    }
export class ApplicationLeaseUnavailableError extends Error {} // reason: 'cold' | 'exhausted' | 'deferred'
export type RegistryHandleAccess = {
  key: GroupKey
  runtime: GroupEpochRuntime
  epoch(): number
  stateVersion(): number
  admission(): SendAdmission
  read<TValue>(fn: (handle: GroupHandle) => TValue | Promise<TValue>): Promise<TValue>
  seal(
    plaintext: Uint8Array,
    opts: { aad: Uint8Array; intent: 'log' | 'ephemeral' },
  ): Promise<SealedApp>
  receive(frames: Array<ReceiveInput>): Promise<Array<ReceiveResult>> // <= 64 inputs, else RangeError
  onRotationRequired(listener: (identity: EpochIdentity) => void): () => void
  onAdmissionChanged(listener: () => void): () => void // any effective-admission flip, in either direction
  openBatch(frames: Array<OpenAppInput>): Promise<Array<OpenAppResult>>
  adopt(
    next: GroupHandle,
    expected: AdoptionExpected,
    write: AdoptionWrite,
  ): Promise<'installed' | 'noop' | 'moved'>
  mutate: HandleAccess['mutate']
  replace: HandleAccess['replace']
  pending: PendingAppFrames
}
export type GroupHandleRegistry = {
  declareRestoredFromBackup(): Promise<void> // commits restore-work (r16 decision)
  start(): Promise<void> // finishes restore-work idempotently before access/network work
  access(groupID: string): Promise<RegistryHandleAccess>
  seed(
    group: GroupHandle,
    params: { replace?: boolean; packageUse: PackageUse | null },
  ): Promise<GroupKey>
  recoverySource(groupID: string): Promise<RegistryRecoverySource>
  switchIncarnation(
    candidate: GroupHandle,
    params: {
      source: RegistryRecoverySource
      rejoinID: string
      proof: ResyncProof
      write: RegistrySwitchWrite
    },
  ): Promise<GroupKey>
  delete(key: GroupKey): Promise<void>
  dispose(): Promise<void>
}
export function createGroupHandleRegistry<TTx extends GroupTransaction>(params: {
  persistence: DevicePersistence<TTx>
  providerID: string
  packages: DevicePackageAdapters
  recovery: RecoveryEnvironment
  restore: (
    record: GroupStateRecord & { deleted: false; state: Uint8Array },
  ) => Promise<GroupHandle>
  batch?: GroupBatchOptions
}): GroupHandleRegistry
export type PreOpenAppFrameRef = GroupKey & {
  id: string
  protocol: string
  topicID: string
  segment: number
  position: string // segment = anchor epoch
}
export type AppFrameRef = PreOpenAppFrameRef & { procedure: string }
// GroupCrypto.unwrap opts.frame changes to PreOpenAppFrameRef (r16 decision).
// (r26) Wrap routes to `seal`; frame-less unwrap routes to `receive`, which refuses `log`-intent frames without consuming.
// Until 2.3d, rpc keeps the r14 `AppFrameRef` and narrow `PendingAppFrame` and calls only singleton durable unwrap. Registry crypto binds GroupKey from its incarnation-bound access; a mismatching supplied key refuses as storage failure, never as a dead frame.
export type OpenAppInput = {
  frame: PreOpenAppFrameRef
  ciphertext: Uint8Array
  expectedAAD?: Uint8Array
}
export type OpenAppResult =
  | { kind: 'opened'; record: PendingAppFrame }
  | { kind: 'refused'; frame: PreOpenAppFrameRef; reason: 'malformed-plaintext'; keyConsumed: true }
  | {
      kind: 'refused'
      frame: PreOpenAppFrameRef
      reason: 'invalid-ciphertext' | 'wrong-aad' | 'duplicate' | 'invalid-position'
      keyConsumed: false
    }
  | {
      kind: 'refused'
      frame: PreOpenAppFrameRef
      reason: 'past-epoch'
      keyConsumed: false
      frameEpoch: number
      handleEpoch: number
    } // not retained
  | {
      kind: 'held'
      frame: PreOpenAppFrameRef
      reason: 'future-epoch'
      frameEpoch: number
      handleEpoch: number
    }
  | { kind: 'held'; frame: PreOpenAppFrameRef; reason: 'unsupported-version' } // legacy/read-only; never produced
// r25: locked epochs, duplicate, invalid-position; past-epoch only for epochs no longer retained
// r25: only authenticated malformed plaintext (keyConsumed:true) persists an AppPoisonRecord. Crypto refusals, duplicates, invalid positions, outer-version faults and window/age expiry persist no row; durable cursor completion records them.
export type AppPoisonRecord = { frame: PreOpenAppFrameRef; reason: string; keyConsumed: boolean } // r25: new rows always carry keyConsumed:true; legacy rows may carry false.
export type PendingAppFrame = {
  frame: AppFrameRef
  payload: Uint8Array
  senderDID: string
  epoch: number
  idempotencyKey: string
}
export type PendingAppFrames = {
  list(): Promise<Array<PendingAppFrame>>
  complete(id: string): Promise<void>
}
export type GroupHandlerMetadata = {
  epoch: number
  incarnation: number
  frame?: AppFrameRef
  idempotencyKey?: string
}
export type DurableHandler<TContext, TTx extends GroupTransaction> =
  | {
      mode?: 'at-least-once'
      handle(
        context: TContext &
          GroupHandlerMetadata & {
            frame: AppFrameRef
            idempotencyKey: string
          },
      ): Promise<void>
    }
  | {
      mode: 'transactional'
      handle(
        context: TContext &
          GroupHandlerMetadata & {
            frame: AppFrameRef
            idempotencyKey: string
            tx: TTx
          },
      ): Promise<void>
    }
export type CommitKeyRotationResult = {
  commitMessage: Uint8Array
  newGroup: GroupHandle
  epoch: bigint
}
```

(r26) Live seal/receive operations join retirement's pre-commit drain; new live work, and any lease wait in progress, is refused from drain start. A reservation composes into a caller's transition: its advanced state is saved by that transition, and its hand-off is used after that transition's proof.

(r25) Private commit construction requires an authoring permit, checked inside @kumiai/mls before the commit is constructed. Every handle an access implementation issues (initial, refreshed, adopted, restored) and every handle derived from one is permanently restricted (CommitAuthoringRefusedError). Only the durable control-build path grants a permit: on a handle restored from the journal's sourceState bytes, for exactly one commit, whose receipt must match the returned commit bytes and candidate; journal, candidate and slot are persisted before the bytes are handed to the network. Public external commits (recovery, rejoin) spend no own handshake generation and are outside the permit.

```ts
export function commitKeyRotation(group: GroupHandle): Promise<CommitKeyRotationResult>
```

(r26) `seal` and `receive` are byte-level; no registry handle leaves the registry. Neither opens a provider transaction. Both refuse under a safety hold.
- **Sends.** A cold, exhausted or deferred send rejects with ApplicationLeaseUnavailableError and schedules a reservation outside the call. A `log` seal first waits, bounded, for that reservation; the wait aborts at retirement start. `seal` refuses any non-admissible admission and reports the generation read inside the encryption's serialization.
- **Cold receive.** A cold `receive` waits once, bounded, for its own scheduled refresh, aborting at retirement start. A cold ephemeral seal rejects at once.
- **Receive handle.** `receive` uses a private send-denied decrypt-only handle, rebuilt when the committed receive projection changes. A version this registry committed installs its proven record as the base. A higher foreign version clears the base until a cold refresh, which is gated on receive lifecycle and safety, not on send admission.
- **Per frame,** serialized per group across base rebuilds, `receive` compares the expected AAD before reading sender data. It refuses generations at or above 500, and refuses `(epoch, leaf, generation)` tuples already opened ephemerally in this process.
- **Consumed set.** Its cap is members × 500 × retained epochs plus slack. Over the cap, the oldest non-current epoch is closed: its bucket is deleted and a closed marker is kept. A current epoch at the cap refuses instead.
- The count of `opened` results is exact. One replay of an opened ephemeral frame after a restart is accepted. Durable opens are unchanged by the 500 refusal.

`openBatch` stages in input order and returns one mixed result per input only after atomic
state/pending/poison commit (r16 decision).

(r25) openBatch accepts at most 64 inputs and rejects larger arrays with RangeError before any read.

Authenticated plaintext supplies procedure and idempotency key; pre-open references supply neither. Validate fatal
UTF-8/JSON, broadcast v2, type/procedure/schema/retention. Outer unsupported versions refuse as invalid-ciphertext without opening or writing, count as completed through the cursor, and never create durable holds (r25).

(r25) Registry crypto validates fatal UTF-8, a JSON object, broadcast `v: 2`, `payload.typ === 'event'`, a non-empty well-formed string `payload.prc` and an absent or plain-object `payload.data`. Protocol membership, schema and retention stay rpc delivery checks.

Before commit-lane catch-up, future-epoch claims hold as at HEAD. Catch-up means no applicable unapplied commit through its observed head.
Only while caught up, require APP_FUTURE_EPOCH_WINDOW=2 of locked local epoch and hold age < APP_FUTURE_HOLD_MS=30,000 ms.
Age starts when the commit lane first catches up after the future occurrence arrives, using local monotone time.
Future occurrences arriving while caught up start age at observation. Duplicate/refetched copies preserve it; expiry needs no new traffic: each transition into catch-up re-runs app delivery, which starts age and schedules expiry.
Task 5e wires peer commit-lane catch-up into app-lane. Recheck it before poison; after catch-up, try opening held frames before applying bounds.
Use the open refusal's locked handle epoch, never a crypto epoch hint. Restart permits a fresh bounded wait, preserving committed poison/completed cursors.

(r25) A frame whose epoch is below the handle epoch but still retained opens from the retained epoch; past-epoch refuses only epochs no longer retained, and such frames are not delivered. Authenticated commit progress never awaits application delivery or a handler, and app work never runs on the peer's commit queue. App pulls run under page, byte and time budgets with a bounded number of outstanding hub requests; exhaustion leaves frames undelivered and is retried later. After an anchor rotation, the departing anchor is saved with the new anchor in one anchor-slot write, together with the epoch of the new anchor (its departure epoch). Every later anchor-slot write carries the departing list forward. Its topic keeps being pulled under its own segment identity while the authenticated applied epoch is less than the departure epoch plus 32; neither a short page nor the crypto epoch hint ends it, and expiry is computed when read, never written by app work. Expiry settles that topic's stalled frames with a delivery-settled notice marked `expired`, distinct from `resumed`.

While caught up, beyond either bound mark completed through the durable cursor without a poison row (r25). Durable cursor commit records completion through the prefix.
Task 5e tests honest lag >2 epochs delivering all frames after catch-up, plus caught-up +2/+3 and 29,999/30,000 ms boundaries.
Malformed authenticated plaintext refuses, commits the consumed key and dead/poison occurrence, advances only a
contiguous completed prefix, and never invokes a handler. Storage failure/ambiguity exposes no result; replay resolves saved pending/poison before reopening. Held
inputs remain uncompleted. Registry crypto owns pending. `access` awaits `start()`; declaration itself only proves the durable restore-work write. Null/unreadable state permits retained-trust recovery, never handle access; recoverySource reads
lifetime/version/trust independently of state bytes. Recovery uses switchIncarnation, never ordinary replace.

(r25) Positions are opaque hub tokens ordered by one code-unit comparison everywhere; the registry compares them for equality only. One occurrence matcher (frame id, topicID, segment, position) serves in-batch and saved replay: a match returns the earlier or saved record or refusal without reopening or writing; the same id at another occurrence refuses as `duplicate` with keyConsumed:false and no write. A position that is empty or longer than 64 characters refuses as `invalid-position`. A completed frame's key is spent, so a refetch refuses without a write. An occurrence at or before the topic's durable cursor refuses as `duplicate` before decryption, and an attempt whose cursor moved before work re-prepares; openBatch never reports `opened` for a record it did not persist.

```ts
export type BuiltCommit = {
  opID: string
  kind: 'invite' | 'remove' | 'ledger' | 'rotation'
  revokes: boolean // (r28c) the owning operation; its intent row left the FIFO at built-save
  enqueuedAt: number
  deadline: number // (r28c) persisted deadline, unchanged by restart/retry
  incarnation: number
  epoch: number
  authenticatorBefore: Uint8Array
  publishID: string
  expectedHead: LogPosition | null
  head: LogPosition | null // (r28b) immutable cursor position at built-save; coverage origin; null is the empty prefix
  payload: Uint8Array
  payloadDigest: string
  digest: string
  bodies: Array<string>
  journal: Uint8Array
  welcome: { bytes: Uint8Array; recipients: Array<string> } | null
  acceptedAs?: LogPosition // (r28b) hub ack; retry evidence only
  skipped?: true // (r28c) an occurrence after head at this epoch, or of unreadable epoch, was skipped; never cleared
  retryForbidden?: boolean // (r28h) false for new coverage-only skips; absent defaults to skipped
  reported?: true // (r28b) provisional deadline `unknown` written once
}
export type HostBuilt = Pick<
  BuiltCommit,
  'incarnation' | 'epoch' | 'authenticatorBefore' | 'digest' | 'bodies' | 'journal' | 'welcome'
> & { commit: Uint8Array }
```

RejoinRecord.source uses portable rpc RecoverySource<unknown>. mls-rpc validates/narrows it to RegistryRecoverySource internally.
RecoveryTargetCapture = { targetID: string; topicID: string; groupInfoEpoch: number; groupInfoAuthenticator: Uint8Array; captureHead: LogPosition | null }.
Authenticated captureHead/searchFrom never change. Only authenticated head-only retry refreshes expectedHead, including a lower head.
Persist authenticated reply with candidate for restored target verification. CapturedPendingRecovery exposes immutable source and target/capture without fabricated trust.
CapturedRecoveryPort supplies initial preparation/restoration and authentication/classification of recapture against saved X WITHOUT building.
MLS/mls-rpc owns LeafNode/tree verification. rpc receives typed reconciliation and never decodes candidates or inspects opaque trust.
Captured sealing requires the committed cursor and complete prefix. Unsupported legacy records cannot enter captured execution.
Drop conflictEpoch/source-prefix scan for new attempts. Preserve payloadDigest/digest, exact bytes/requestKey/candidate and bound verdict stages.
Legacy unadopted records stop without fabricated metadata until authorised manual recovery. Proven adopted continuations finish without reinstalling.
Write switchMutationID atomically with confirmed. Defensive confirmed+null startup assigns before coordinator work.
Adopted source continuations bind destinationKey. Retirement preserves history, owed work, accepted settlements and immutable safety evidence.
RejoinRecord adds `trigger: 'automatic' | 'manual'` and `authorisationID: string | null`; manual attempts require matching durable authorisation. Authorised manual construction uses the persisted selected-target record. Legacy records without supported provenance retain their compatibility stop.
`StagedAdoption` adds incarnation. Control adapters, applied rows/responses/cursor and outcomes bind GroupKey.
ControlSnapshot adds `commitOnce: BuiltCommit | null`, `forkHalt: ForkHalt | null`, `recoveryUnavailable: RecoveryUnavailableEvent | null` (r16 decision), and
`strand: {reason: StrandedReason | 'unsupported-version'} | null`, `manualRecovery: ManualRecoveryRecord | null`, and
`forkRecoveryAttempt: ForkRecoveryAttempt | null` (legacy missing intent normalises to null).
Group-level checkpoint records retain active conditions, notices and immutable evidence separately from hard holds.
The strand/ControlHold 'unsupported-version' reason is legacy/read-only for hub-delivered frames; new frame-version faults diagnose/skip.
Legacy local control-record version stops retain their compatibility policy, independently of delivered frame diagnostics.
ControlChanges carries optional values for these fields; halt evidence is immutable on retirement.
The commit-once slot survives operation outcome/ack and ends only with its epoch (D4 r28). `deleteAppliedFrom` fork repair is removed; prune only within the incarnation.
(r28c) P2a's Operation union is replaced. ControlSnapshot holds FIFO unbuilt intents only (`operations`), at most one live build (`commitOnce: BuiltCommit`,
carrying its owning operation's `opID`, `kind`, `revokes`, `enqueuedAt` and `deadline`; the former `built`/`accepted` stages are that build, the latter with
`acceptedAs`; no built or accepted operation remains in the FIFO and the built-save transaction deletes the intent row), a `spentSource: { epoch: number } | null`
marker written by `abandon()` or by migration for an ownerless current-source legacy slot, cleared only by consumption/retirement (it blocks only while its epoch equals the source epoch; never deletion), independent Welcome
obligations and outcome rows. ControlChanges supports the build and spentSource mutations. Allowed build mutations: payload/ID/candidate/journal/`head` and the
operation fields are immutable; coverage uncertainty, effective retry prohibition and reporting are monotone; `acceptedAs` is written by hub acknowledgement only.
`retryForbidden: false` distinguishes a new coverage-only skip. An absent distinction on a skipped row means retry-forbidden, including after migration.
Cursor advances may establish the distinction only before the first skip, or raise it to true. Head refresh, reporting and acknowledgement preserve both flags;
`expectedHead` refresh is guarded by unchanged incarnation/epoch/authenticator; closure deletes the build atomically with its outcome, obligation (if `landed`)
and speculative-material deletion.
BuiltCommit has no searchFrom; no control search port, acceptance-unknown hold, stored first-valid proof or retained operation set exists.
Adoption guards validate against the walker's current occurrence, never a stored proof. expectedHead updates never change payload/ID.
ControlSnapshot adds recoveryEpochFloor: number | null and settledRejoins: Array<AcceptedRejoinSettlement>, with matching ControlChanges recoveryEpochFloor/putSettledRejoins.
AcceptedRejoinSettlement always contains kind/id/public origin and cumulative ledgerBefore.
Accepted-unadoptable provenance adds digest/payloadDigest/epochAfter/acceptedEpoch and exact LeafNode digest.
Not-accepted and superseded-branch provenance carry epoch, without inventing accepted facts. Superseded-branch preserves prior accepted facts in exact-X history.
Public origin contains sourceKey, target/capture and original searchFrom, never opaque trust or private state.
Store at most one cumulative row per source incarnation, idempotently by id. Later settlements replace public provenance and union every prior owed token.
Ordinary settlement omits request/requestKey/candidate/payload. Superseded-branch provenance preserves sealed exact-X history in checkpoints.
Zeroise owned buffers only after proof of committed settlement, respecting retained history ownership.
R0 settlement folds that row, deletes the active rejoin and raises the floor in one transition. Never delete outcomes/Welcomes or accepted facts through movement.
Fresh snapshots and old persisted snapshots normalise missing floor/settlements/intent to null/[]/null without changing saved record bytes.
Persist the ordinary monotone authenticated epoch floor independently of rejoin deletion. First ordinary save uses capture epoch.
Only effectiveRecoveryEpochFloor for the privately authorised, source/ID-bound forkRecovery attempt returns E.
Bare ControlStore.apply cannot mint this authority, lower the ordinary floor or clear safety records.
Leaf-absent discard and R0 settlement raise it to authenticated recapture epoch atomically. Restart preserves it, normalising missing legacy values only.
Task 14b tests all four write/restart points. Task 3 also runs Control. Task 1a uses the explicit pre-runner command in the plan.
Preserve HEAD peer.ts:3813-3821 ledgerBefore: de-duplicated inFlightEntries ?? awaitingBootstrap.entries, current ledger and conditional commitOnce bodies.
Carry that union into Y. settleAcceptedRecovery takes the ordinary recoveryEpochFloor as its fourth argument.
Never write Y's temporary effective E into the ordinary floor. (r28b) The source-switch transaction closes every live source build terminal `unknown` (D4); RecoveryCompletion never defers or repeats that closure and writes only `reenact`, atomically/idempotently.
Compute reenact after destination bootstrap. No automatic enqueue or ledgerBefore mapping removes owed tokens.
No private builder exports a handshake reservation API or generation budget.

### Registry adapters and handler registration (r16 decision)

```ts
export type AdoptionExpected = {
  key: GroupKey
  stateVersion: number
  identity: EpochIdentity | null
}
// @kumiai/rpc owns the portable recovery generic:
export type RecoverySource<TTrust = unknown> = AdoptionExpected & {
  trust: TTrust
  trustDigest: string
  lifetimeRevision: number
}
// @kumiai/mls-rpc owns this specialisation and imports rpc ResyncProof:
export type RegistryRecoverySource = RecoverySource<GroupRecoveryTrust>
// Task 1a renames rpc control/rejoin.ts:16 local RecoverySource to SourceScanIdentity.
// Task 1a renames old registry/types.ts:42-54 shapes to LegacyRegistryRecoverySource/LegacyResyncProof for live legacy overloads.
// New RegistryRecoverySource/portable ResyncProof are additive. Task 7 supplies genuine trustDigest for captured sources, never fake legacy metadata.
export function recoveryTrustDigest(trust: GroupRecoveryTrust): string
// Let T=UTF8(kumiai/recovery-trust/v1), C=canonical UTF-8 JSON of validated public trust.
// Uint8Array becomes base64url; bigint becomes canonical unsigned decimal strings; DeviceRegistry becomes base64url(encodeDeviceRegistry(registry)).
// DeviceRegistry encoding sorts map entries. Bigint leaf lifetimes and sparse tree slots participate in the digest.
// Omit undefined object fields; undefined tree slots become null. Recursively sort object keys; preserve array order.
// Return base64url(SHA256(u32be(|T|)||T||u32be(|C|)||C)). Never compare raw opaque trust in rpc.
// Store trustDigest with the saved source record/candidate. rpc compares digest strings only.
// Reordered equivalent trust hashes equally; authority/key/ledger/spent changes differ.
// SHA-256 base64url digest uses 43 characters. Size accounting includes full trust plus sealed record/candidate and duplicated trust/sourceState.
export type ControlHandleAccess = Pick<
  HandleAccess,
  'epoch' | 'admission' | 'read' | 'readControl' | 'mutate' | 'replace'
>
export function createRegistryHandleAccess(params: {
  access: RegistryHandleAccess
}): ControlHandleAccess
// Build/adoption and GroupMLS consume ControlHandleAccess; full registry crypto/open/leases remain 2.3.
// ControlReadScope adds loadControl(control?: ControlStore): Promise<ControlSnapshot>.
// Registry scopes check supplied control.key against entry groupID/incarnation before reading; foreign keys throw DisplacedGroupHandleError.
// Simple/transactional scopes use the real supplied ControlStore; loadControl expires exactly with refresh, including after await.
// Ordinary adoption may select an ID when mutationID is null.
// Recovery adoption always uses saved switchMutationID; build reads/sealing release their entry before root save/retry.
export function createGroupCrypto(
  params: Omit<GroupCryptoParams, 'access' | 'pending'> & {
    access: RegistryHandleAccess
  },
): GroupCrypto & {
  pending: PendingAppFrames
  unwrapBatch(frames: Array<OpenAppInput>): Promise<Array<OpenAppResult>>
}
export type RecoveryRouting = { targetID: string; topicID: string }
export type RecoveryAdoptionDependencies = {
  target: RecoveryRouting
  environment: RecoveryEnvironment
  readRecoverySource(): Promise<RegistryRecoverySource>
  accept(
    candidate: GroupHandle,
    params: { source: RegistryRecoverySource; proof: ResyncProof; write: AdoptionWriteFactory },
  ): Promise<void>
}
export type GroupMLSDependencies = {
  control: ControlStore
  readRecoverySource: () => Promise<AdoptionExpected>
  recoveryAdoption?: RecoveryAdoptionDependencies
  onSafetyHold?: (latch: (reason: NonNullable<SafetyHold>) => void) => () => void
  recoverySecretFromTrust?: (trust: GroupRecoveryTrust) => Promise<Uint8Array>
}
// GroupMLSParams includes GroupMLSDependencies and uses access: ControlHandleAccess.
// Stages are serial. Tasks 12/13 implement captured APIs additively; the complete legacy producer/caller/acceptance path stays live through Stage 6.
// Task 14b activates captured production calls, mirrors and behavioural fixtures together, after Tasks 15/16 implement continuation/coordinator.
// Task 14a prepares the 17-file fixture closure; 14b activates the 25-file production/mirror closure. Every unit remains below approximately 25 files. Never replace convergence with stops/skips.
// Compatibility helpers retain explicit legacy names/types; no active requester produces legacy records after activation.
// Ordinary source readers return identity-only AdoptionExpected, never fabricated trust/lifetimeRevision.
// Only registry-injected recoveryAdoption supplies the trusted recovery source. Absent recoveryAdoption refuses captured recovery only.
export function createRegistryGroupMLS(
  params: Omit<
    GroupMLSParams,
    'access' | 'control' | 'readRecoverySource' | 'recoveryAdoption' | 'onSafetyHold'
  > & {
    registry: GroupHandleRegistry
    key: GroupKey
    recovery: RecoveryEnvironment
    target: RecoveryRouting
    onConfirmedRecovery(handoff: ConfirmedRecoveryHandoff): void
  },
): Promise<GroupMLS>
// r20: async because sendAdmission() is synchronous and registry.access() is async and restores private state.
// Construction validates params (sink TypeError) before any await, then reads an initial cached SendAdmission from
// registry entry/control/safety reads plus the persisted trust's installed epoch, never restoring private state.
// Null/corrupt private state yields admissible:false with an existing reason. The cache follows access open,
// safety subscriptions and access admission changes; sendAdmission() returns it synchronously.
// Registry injects entry-bound control/identity/adoption/safety readers and separate trusted recovery reader, opening no old private handle.
// Missing/invalid coordinator onConfirmedRecovery sink throws TypeError at registry GroupMLS construction, before requests.
// target is stable host routing checked against the commit lane; GroupPeerMLSParams requires it.
// MLS owns the one recognition helper. No RPC dependency or general intake gate.
export function ownCommitDigest(commit: Uint8Array): string | null
// Decode/re-encode the MLS-message commit half before SHA-256/base64url. Null for malformed input.
// GroupMLS and independent rpc-conformance mirrors add these members:
// ownCommitDigest(commit: Uint8Array): string | null
// onSafetyHold(latch: (reason: NonNullable<SafetyHold>) => void): () => void
// Helper/sink plumbing stays outside host-callback drain accounting. searchOccurrence keeps its three-argument found/absent/gap contract.
// For recovery X, exact found is a confirmation hint. Every search result permits authenticated recapture; none authorises discard.
// (r28i) Failed delivered own/foreign copies are coverage-only skips with explicit retryForbidden: false unless already prohibited. Identical saved bytes/ID may retry with unchanged incarnation/epoch/authenticator before deadline; deadline reports unknown once. Authenticated foreign commit refusal and applied consumption retain retry prohibition; legacy skipped rows without the field remain forbidden.
// StrandKind adds 'past-epoch-divergence' with claimed confidence, diagnostic-only. Existing fork signal names remain compatibility types only.
export type LegacyRejoinRecord = {
  id: string
  stage: 'built' | 'published' | 'confirmed' | 'adopted' | 'refused'
  publishID: string
  expectedHead: LogPosition | null
  payload: Uint8Array
  payloadDigest: string
  requestID: string
  request: Uint8Array
  requestKey: Uint8Array
  candidate: Uint8Array
  source: { key: GroupKey; epoch: number; authenticator: Uint8Array; head: LogPosition | null }
  digest: string
  epochAfter: number
  ledgerBefore: Array<string>
  conflictEpoch: number | null
  position?: LogPosition
  verdict?: Uint8Array
  refusal?: RecoveryRefusal
}
export type RecoveryTargetCapture = {
  targetID: string
  topicID: string
  groupInfoEpoch: number
  groupInfoAuthenticator: Uint8Array
  captureHead: LogPosition | null
}
export type CapturedRejoinRecord = Omit<LegacyRejoinRecord, 'source' | 'conflictEpoch'> & {
  format: 2
  source: RecoverySource
  target: RecoveryTargetCapture
  captureHead: LogPosition | null
  searchFrom: LogPosition | null
  trigger: 'automatic' | 'manual'
  authorisationID: string | null
  switchMutationID: string | null
  destinationKey: GroupKey | null
  forkRecovery?: ForkRecoveryAuthorisation
}
export type RejoinRecord = CapturedRejoinRecord
export type StoredRejoinRecord = LegacyRejoinRecord | CapturedRejoinRecord
// Legacy records decode separately and retain their unsupported-provenance stop until authorised manual recovery.
// Captured records never enter legacy execution. Proven adopted legacy continuations never reinstall.
// Portable mirrors use RecoverySource<unknown>; mls-rpc alone narrows trust.
export type ForkRecoveryAuthorisation = {
  attemptID: string
  noticeID: string
  splitEpoch: number
  otherAuthHash: string
  responderKeyHash: string
  source: GroupKey
  evidence: Uint8Array
}
export type ForkRecoveryAttempt = {
  id: string
  source: GroupKey
  forkRecovery: ForkRecoveryAuthorisation
}
export type AcceptedRejoinSettlement = {
  id: string
  origin: { sourceKey: GroupKey; target: RecoveryTargetCapture; searchFrom: LogPosition | null }
  ledgerBefore: Array<string>
} & (
  | {
      kind: 'accepted-unadoptable'
      digest: string
      payloadDigest: string
      epochAfter: number
      acceptedEpoch: number
      leafDigest: string
    }
  | { kind: 'not-accepted'; epoch: number }
  | { kind: 'superseded-branch'; epoch: number }
)
// Ordinary settlements omit secret work. Superseded-branch retains exact X in sealed checkpoint history.
export function effectiveRecoveryEpochFloor(
  snapshot: ControlSnapshot,
  attempt: { id: string; source: GroupKey },
): number | null
// E only for the privately authorised Y binding. Otherwise return the ordinary stored floor.
export type CapturedRecapture = {
  sealed: Uint8Array
  requestID: string
  requestKey: Uint8Array
  epochFloor: number | null
}
export type RecoveryReconciliation =
  | { kind: 'accepted'; epoch: number; leafDigest: string }
  | { kind: 'head-only'; head: LogPosition | null }
  | { kind: 'unapplied-later'; epoch: number }
  | { kind: 'superseded-branch'; epoch: number; authorisation: ForkRecoveryAuthorisation }
  | { kind: 'retry' | 'held' }
// held = local safety/missing retained trust only. retry = different authenticator, below-floor capture or transient failure.
export type LegacyPendingRecovery = Pick<
  PendingRecovery,
  'epoch' | 'markBindingUnusable' | 'confirmationKey' | 'judgeVerdict' | 'commit' | 'serialize'
> & {
  onAccepted(write: AdoptionWriteFactory): Promise<void>
}
export type CapturedPendingRecovery = Omit<LegacyPendingRecovery, 'onAccepted'> & {
  source: RecoverySource<unknown>
  target: RecoveryTargetCapture
  onAccepted(
    expected: RecoverySource<unknown>,
    proof: ResyncProof,
    write: AdoptionWriteFactory,
  ): Promise<void>
}
export type CapturedAppliedRecovery = CapturedPendingRecovery | { renewalRequired: true } | null
export type CapturedRecoveryPort = {
  applyRecovery(
    sealed: Uint8Array,
    requestID: string,
    requestKey: Uint8Array,
  ): Promise<CapturedAppliedRecovery>
  restoreRecovery(candidate: Uint8Array, requestKey: Uint8Array): Promise<CapturedPendingRecovery>
  reconcileCapture(
    record: CapturedRejoinRecord,
    reply: CapturedRecapture,
  ): Promise<RecoveryReconciliation>
  sealGroupInfo(request: Uint8Array, captureHead: LogPosition | null): Promise<Uint8Array>
  checkRosterAbsence?(
    evidence: Uint8Array,
    requestID: string,
    requestKey: Uint8Array,
  ): Promise<AuthenticatedRosterAbsence | null>
  sealRosterAbsence?(
    request: Uint8Array,
    captureHead: LogPosition | null,
  ): Promise<Uint8Array | null>
  authoriseForkRecovery?(
    reply: CapturedRecapture,
    noticeID: string,
  ): Promise<ForkRecoveryAuthorisation | null>
}
// GroupMLS.capturedRecovery supplies production captured recovery; legacy direct factories may omit optional authority.
// Initial apply returns genuine immutable source. reconcileCapture authenticates request/group/target/origin/floor and exact LeafNode against saved X without building.
// Leaf/tree checks stay in MLS/mls-rpc. rpc sees typed reconciliation, never opaque trust internals. Fresh keys never overwrite X's original tuple.
// Same-lineage recapture, including lost private state, makes zero extra candidate builds. A different-branch Y needs private forkRecovery authority.
export type RegistrySwitchWrite = {
  mutationID: string
  source: { rejoinID: string; authorisationID?: string }
  destination: { control: { cursor: { position: LogPosition; epoch: number } } }
}
export type ConfirmedRecoveryHandoff = { record: CapturedRejoinRecord; completion: Promise<void> }
export type RecoveryContinuation = {
  source: GroupKey
  destination: GroupKey
  record: StoredRejoinRecord
}
// Legacy adopted continuations require independently proven installation; never fabricate capture metadata or rewrite the saved record.
export type RecoveryCompletion = (params: {
  ledger: Array<string>
  mutationID: string
}) => Promise<void>
export type RecoveryContinuationPort = {
  loadRecoveryContinuation(destination: GroupKey): Promise<RecoveryContinuation | null>
  finishRecoveryContinuation(params: {
    continuation: RecoveryContinuation
    ledger: Array<string>
    mutationID: string
  }): Promise<void>
}
export function createRecoveryContinuationPort<TTx extends GroupTransaction>(params: {
  registry: GroupHandleRegistry
  persistence: GroupPersistence<TTx>
}): RecoveryContinuationPort
export type RegistryPeerOptions = {
  mls: GroupMLS
  recoveryOnly: boolean
  target: RecoveryRouting
  onConfirmedRecovery(handoff: ConfirmedRecoveryHandoff): void
  continuation: RecoveryContinuation | null
  completion: RecoveryCompletion | null
}
export type RegistryPeer = {
  peer(): GroupPeer<Record<string, GroupProtocolDefinition>> | null
  installedKey(): GroupKey
  ready: Promise<void>
  dispose(): void
  drained(): Promise<void>
}
export function createRegistryPeer(params: {
  registry: GroupHandleRegistry
  key: GroupKey
  recovery: RecoveryEnvironment
  target: RecoveryRouting
  continuation: RecoveryContinuationPort
  settleAcceptedRecovery?: (
    record: CapturedRejoinRecord,
    acceptedEpoch: number,
    leafDigest: string,
  ) => Promise<void>
  createMLS(
    key: GroupKey,
    onConfirmedRecovery: (handoff: ConfirmedRecoveryHandoff) => void,
  ): GroupMLS
  createPeer(
    key: GroupKey,
    options: RegistryPeerOptions,
  ): Promise<GroupPeer<Record<string, GroupProtocolDefinition>>>
}): Promise<RegistryPeer>
// GroupPeerMLSParams adds onConfirmedRecovery?, continuation? and completion? with these exact types.
// Continuation/completion must both be present or both absent/null.
export declare class RegistrySourceMovedError extends GroupStateConflictError {
  get reason(): 'source-expectation-moved'
}
export function createRecoverySwitchFactory(record: CapturedRejoinRecord): AdoptionWriteFactory
// Replacements for these existing port members:
export type GroupMLSRecoverySourcePort = { readRecoverySource(): Promise<AdoptionExpected> }
// Ordinary certificates use identity-only source. Trust/lifetimeRevision belong only to registry recoveryAdoption.
export type RecoveryAdoptionPort = {
  onAccepted(
    expected: RecoverySource<unknown>,
    proof: ResyncProof,
    write: AdoptionWriteFactory,
  ): Promise<void>
}
// After source completion/host-boundary exit, coordinator rereads confirmed X, restores raw candidate and builds saved proof/factory, never retaining a proxy.
// Defensive confirmed+null startup first assigns switchMutationID under ownership; never fabricates capture/source metadata.
// Restart with confirmed+switchMutationID resumes coordinator before source work. Successful/proven switch creates destination MLS via createMLS.
// Load continuation by current destination key (even after epoch advancement); pass MLS/continuation/completion into createPeer, including restart.
// No continuation means ordinary destination startup. (r28b) The switch transaction closes source builds; RecoveryCompletion owns only reenact reporting, atomically/idempotently.
// Task 15 creates rpc rejoin-legacy.test.ts; Task 14b extends it. Task 15 tests switch-before-peer crash/restart and repeated completion, preserving existing outcomes/Welcomes, settled X facts and reenact obligations.
// RegistrySourceMovedError alone permits fresh-counter retry of the same candidate/proof/switchMutationID for unchanged key/identity/trust/target.
// Other local conflicts/proof/candidate/spent/invariant failures stop with diagnostics and confirmed bytes preserved.
// Delivered confirmation/copy/transport failures instead diagnose/retry, preserving X under applied-state settlement authority.
// A hold stays stopped. Identity/trust/key/target movement never deletes accepted/confirmed X. Local switch rollback is local-only.
// Preserve confirmation/ledgerBefore/owed obligations while reconciling installation, or enter R0 accepted-unadoptable settlement at an authenticated recaptured epoch.
// Discard/build is limited to D1 authenticated non-acceptance for unconfirmed X (later epoch with leaf absent), or a separate explicit host action.
// Task 16 restart: delayed acceptance + source movement + rolled-back switch preserves X facts and obligations.
// Task 16 keeps moved accepted X pending when settlement callback is absent. Captured production construction requires that callback at Task 14b activation.
// Transient failures back off to at most 15 seconds; uncertain outcomes resolve before retry and never authorise another candidate.
// Only hooked StorageOutcomeUnknownError transfers settlement. Unhooked GroupStateUncertainError settles the fence and resolves saved switchMutationID.
// Catch provider GroupStateUncertainError without skipping the fresh Read, including when a later mutation superseded the latest marker.
// A fresh registry Read checks that ID's proof marker, spent set, adopted source record and destination initial identity.
// Classify saved-ID commit/rollback BEFORE movement: committed switch starts destination once, even after later movement; never discard/reinstall.
// Explicit rolled-back proof permits only existing same-ID retry after origin/target checks. Missing/inconsistent proof stays pending or terminal.
// r22: with the fence settled (or after process restart, which ends every prior transaction) a fresh Read showing the source record still
// confirmed with that ID, no adopted record, no spent candidate and no destination initial identity IS rolled-back proof for that ID.
// The same-ID switch is a CAS on the confirmed record, so retrying it can never apply twice. Any other inconsistent fact stays pending/terminal.
// Pending/restart uses proof-first bounded 15-second retry. Local refusal preserves accepted X; R0 then permits leaf-replacing Y under normal admission.
// Never turn rollback into remote non-acceptance. Duplicate/missing ambiguous identities refuse; actual removed devices require fresh invitation (r18:66,128).
export type ControlAdoptionPort = {
  // (r28c) `occurrence` is the walker's validated own occurrence; the port installs the saved candidate for both coverage values and never runs MLS
  // receive processing on an own frame. `write` carries `landed` plus the obligation for complete coverage, terminal `unknown` without obligation otherwise.
  adopt(
    journal: Uint8Array,
    expected: AdoptionExpected & { occurrence: OwnOccurrence },
    write: AdoptionWrite,
  ): Promise<'installed' | 'noop' | 'moved'>
}
export type MetadataHandler<THandler> = THandler extends (context: infer TContext) => infer TResult
  ? (context: TContext & GroupHandlerMetadata) => TResult
  : never
export type GroupProcedureHandlers<
  TProtocol extends GroupProtocolDefinition,
  TTx extends GroupTransaction,
> = {
  [TProcedure in keyof TProtocol & string]: TProtocol[TProcedure] extends {
    type: 'event'
    retain: 'log'
  }
    ?
        | DurableHandler<EventHandlerContext<TProtocol, TProcedure>, TTx>
        | ((
            context: EventHandlerContext<TProtocol, TProcedure> & GroupHandlerMetadata,
          ) => void | Promise<void>)
    : MetadataHandler<ProcedureHandlers<TProtocol>[TProcedure]>
}
export function adaptBusHandlers<
  TProtocol extends GroupProtocolDefinition,
  TTx extends GroupTransaction,
>(
  protocol: TProtocol,
  handlers: GroupProcedureHandlers<TProtocol, TTx>,
  options: { completion: HandlerCompletion<TTx>; suppress?: SuppressConfig },
): BusHandlerMaps
export type HandlerCompletion<TTx extends GroupTransaction> = {
  key: GroupKey
  complete(ids: Array<string>): Promise<void>
  transact(
    ids: Array<string>,
    handle: (tx: TTx, records: Array<PendingAppFrame>) => Promise<void>,
  ): Promise<void>
}
export type GroupPeerHandlerParams<
  TProtocols extends Record<string, GroupProtocolDefinition>,
  TTx extends GroupTransaction,
> = {
  handlers: { [K in keyof TProtocols]: GroupProcedureHandlers<TProtocols[K], TTx> }
  completion: HandlerCompletion<TTx>
}
```

`mutate` stages ordinary MLS changes and co-commits state/trust/adoption writes. Supplied persist callbacks stage writes, never commit independently.
`replace` runs prepare against the gated current handle, captures identity/version, then ordinary adopt carries progress; recovery replacement refuses.
`open` intercepts staged state/record persistence into the same transition, ignoring independent root-save callbacks.

(r25) RegistryHandleAccess has no `open`; `openBatch` replaces it.

(r26) Wrap routes to `seal`; frame-less unwrap routes to `receive`, which refuses `log`-intent frames without consuming.
Registry `createGroupCrypto` routes durable unwrap to a singleton openBatch. Until 2.3d, rpc keeps the r14 `AppFrameRef` and narrow `PendingAppFrame` and calls only singleton durable unwrap. Registry crypto binds GroupKey from its incarnation-bound access; a mismatching supplied key refuses as storage failure, never as a dead frame.
Singleton unwrap maps results to FrameEpochError (past/future), AppFrameStorageError (storage), InvalidAppEntryError (plaintext) or crypto refusal. `unwrapBatch` preserves per-input results; it never rejects valid siblings for crypto refusal.
GroupMLS/PendingRecovery/GroupPeerMLSParams/OperationDeps use the named replacement port members above; GroupPeerParams adds GroupPeerHandlerParams.
Registry-injected recovery methods read RegistryRecoverySource through recoveryAdoption without handle access.
Ordinary GroupMLS readRecoverySource returns identity-only AdoptionExpected. Live responders still use read/captured-prefix state.
Stale key/version/identity/lifetime revision refuses adoption/switch unchanged. Candidate replay resolves mutation proof before spent admission.

(r25) Every MLS state write, application receipt included, is an exact version CAS serialised per group; a receive save that loses its CAS re-prepares at most three times. An ordinary adoption or build retry of an own commit carries the commit journal and is checked for control compatibility: the current state's control projection (everything except secret-tree progress other than the own handshake generation, retained history and the proposal map) must equal that of the journal's `sourceState`; every proposal the commit references must still be present unchanged; no own-sender proposal may be added; and retained epochs may only have been evicted, never added. Extra foreign proposals are allowed (:576), and history eviction the retention policy performs is allowed and carried into the candidate. This replaces matching the captured stateVersion. Adoptions without a journal keep the exact version match.

Functions remain default at-least-once registrations. Transactional policy is valid only for log events; mixed listener policies refuse registration.
`completion.transact` reloads uncompleted IDs, runs the registered effect and co-writes completion/cursor once; completed IDs invoke nothing.

### Checkpoint, condition and reporting contracts (r24)

```ts
type EpochCheckpointBodyV1 = {
  v: 1
  type: 'kumiai/checkpoint/v1'
  groupID: string
  genesisHash: string
  ciphersuite: number
  epoch: number
  authHash: string
  parentAuthHash: string | null
  keyHash: string
  leafIndex: number
}
type CheckpointMember = {
  signerDID: string
  keyHash: string
  leafIndex: number
  signaturePublicKey: string
}
type EpochRosterFactV1 = {
  v: 1
  key: GroupKey
  genesisHash: string
  ciphersuite: number
  epoch: number
  authHash: string
  parentAuthHash: string | null
  confirmedTranscriptHash: string
  members: Array<CheckpointMember>
  installation: { mutationID: string; stateVersion: number }
}
type CheckpointComparison =
  | { kind: 'agreement'; epoch: number; signerDID: string; keyHash: string }
  | {
      kind: 'conflict'
      epoch: number
      signerDID: string
      keyHash: string
      localAuthHash: string
      remoteAuthHash: string
      parentAuthHash: string | null
    }
  | { kind: 'invalid' | 'coverage-gap' }
type CheckpointCoverage = {
  groupID: string
  current: { key: GroupKey; epoch: number } | null
  retained: Array<{ key: GroupKey; from: number; through: number }>
  effectiveFloor: number | null
  gaps: Array<{
    key: GroupKey
    from: number
    through: number
    reason: 'pre-join' | 'skipped' | 'expired'
  }>
}
type CheckpointPort = {
  signInstalled(factID: string): Promise<Uint8Array | null>
  compare(key: GroupKey, frame: Uint8Array): Promise<CheckpointComparison>
  exportCheckpoints(key: GroupKey, epochs?: Array<number>): Promise<Array<Uint8Array>>
  checkpointFact(key: GroupKey, epoch: number): Promise<Uint8Array | null>
  checkpointCoverage(groupID: string): Promise<CheckpointCoverage>
}
type OwnBranchMessage = { id: string; epoch: number; authHash: string }
type CoverageGapReason =
  | 'pre-journal-history'
  | 'retention-gap'
  | 'unknown-ancestry'
  | 'ephemeral-uncovered'
type ReportCoverage = { kind: 'complete' } | { kind: 'partial'; reasons: Array<CoverageGapReason> }
type BranchReportCoverage = {
  ancestry: ReportCoverage
  ownMessages: ReportCoverage
  othersSeen: ReportCoverage
  membership: ReportCoverage
  ephemeral: ReportCoverage
}
type AbandonedEpochRange = { from: number; through: number } | 'unknown'
type ForkBranch = {
  authHash: string
  signers: Array<{ signerDID: string; keyHash: string }>
  firstSeenAt: number
  lastCheckpointAt: number
}
type ForkNotice = {
  id: string
  groupID: string
  splitEpoch: number
  branches: Array<ForkBranch>
  deviceAuthHash: string
  detectedAt: number
  lastEvidenceAt: number
  atRisk: Array<OwnBranchMessage>
  revision: number
  acknowledgedRevision: number
  acknowledgedAt: number | null
  coverage: { evidence: ReportCoverage; ownMessages: ReportCoverage; ephemeral: ReportCoverage }
  closedAt: number | null
  equivocations: Array<{ signerDID: string; keyHash: string }>
}
type ForkNoticeEvent = { id: string; kind: 'fork-detected' | 'fork-updated'; notice: ForkNotice }
export type BranchAbandonedEvent = GroupKey & {
  id: string
  kind: 'branch-abandoned'
  noticeID: string | null
  epochs: AbandonedEpochRange
  ownMessages: Array<OwnBranchMessage>
  othersSeen: number
  membersAdded: Array<string>
  membersRemoved: Array<string>
  coverage: BranchReportCoverage
}
export type GroupCondition = 'not-member' | 'spent-set-corrupt'
export type NotMemberEvidence = {
  responderKeyHash: string
  epoch: number
  authHash: string
  observedAt: number
  responderDIDs: Array<string>
  responderCount: number
}
export type GroupConditionEvent = GroupKey & {
  id: string
  kind: GroupCondition
  detectedAt: number
  evidence: NotMemberEvidence | null
}
export type RecoveryPendingReason =
  | 'no-reply'
  | 'no-eligible-responder'
  | 'target-behind'
  | 'target-unresolved'
// RegistryPeerStatus includes this diagnostic arm and uses the same reasons in its pending arm.
export type NotMemberStatus = {
  kind: 'not-member'
  eventID: string
  evidence: NotMemberEvidence
  retrying: true
  pendingReason?: RecoveryPendingReason
}
export type AuthenticatedRosterAbsence = {
  groupID: string
  requesterDID: string
  requestID: string
  epoch: number
  captureHead: string | null
  groupInfoAuthenticator: Uint8Array
  confirmedTranscriptHash: string
  responderDID: string
  responderKeyHash: string
  lineage: Array<{ epoch: number; authHash: string }>
  evidence: Uint8Array
}
```

MLS exports equivalent structural checkpoint/proof results without importing rpc. Independent conformance mirrors import no implementation helpers.
Partial coverage requires at least one reason. Ephemeral coverage is always `{kind:'partial', reasons:['ephemeral-uncovered']}`.
`effectiveFloor` is the earliest ordinary comparable epoch, or null without facts. Ranges remain incarnation-specific.
Coverage watermarks survive pruning/restart without retaining expired rosters. Evidence summaries never imply comparable facts.
`importCheckpoint(key, frame)` uses stored-fact validation, identical to hub intake, and never accepts supplied roster provenance.
Standalone `verifyCheckpointPair({first, second, localRosterFact, eligibilityRosterFact?})` trusts the caller's independently authenticated local facts.
The compared local fact always binds epoch/hash. The optional prior eligibility fact never replaces that binding.
Exports and fact/coverage access return defensive copies, including retained retired evidence. No extra transport worker exists.

`GroupMLS.createRecoveryRequest(requestID, deadlineMs?, comparisonEpoch?)` forwards signed comparisonEpoch through real and retained-trust request creation.
Validate comparisonEpoch as a nonnegative safe integer. Missing retained comparison facts leave ordinary requests available without exception authority.
`SpentSetCorruptError` (one class, defined in rpc and thrown by mls-rpc) takes `{key?:GroupKey;cause?:unknown}` and exposes a defensive key.
Not-member has no error class; it is diagnostic only. Only spent-set-corrupt adds a SendAdmission/SafetyHold restriction.

Roster replies use token type `kumiai.recovery-roster`, frame version 1 and HPKE info/AAD domains
`kumiai/mls/recovery-roster/v1` / `kumiai/mls/recovery-roster-aad/v1`.
Reuse signed-request ephemeral-key sealing and group/requester/requestID AAD framing.
Sign group/request/head/authenticator/tree/ledger/lineage digests. Refold the authenticated complete role ledger from genesis.
Payload: `u32(tokenLength) || UTF8(token) || u32(GroupInfoLength) || GroupInfo || u32(ledgerLength) || encodedLedgerTokens || encodedCheckpointList`.
The checkpoint list is `u32(count)` followed by `u32(length) || frame`, at most 256 frames of at most 4096 bytes each.
Require full consumption, contiguous parentAuthHash links within the returned span and the reply's signing key/current offered authenticator binding.
The complete frame, including sealing overhead, stays within 786432 bytes. Trim older lineage frames first, preserving the frames nearest F.
Never truncate the signed public tree or complete authenticated ledger. If those required fields plus F's frame cannot fit, no qualifying reply exists.
A bounded suffix can qualify for absence at a common epoch without E. Missing E never grants fork-floor authority.
Extract confirmedTranscriptHash only from verified GroupInfo.groupContext, never an unsigned field or checkpoint assertion.
Roster replies cannot enter candidate-building GroupInfo, ledger-only or confirmation consumers. Transmit no historical roster facts.
A present DID with a changed leaf is not absent. An obsolete incarnation with that DID can remain pending.

Real GroupMLS adapter dependencies privately bind authoriseForkRecovery, readInstalledRecoveryLineage and checkForkRecoveryCapture to the registered coordinator.
The lineage reader takes `{comparisonEpoch, throughEpoch}` and reads installed signed frames under the bound owner snapshot.
Treat comparisonEpoch as the signed lower bound. Clamp to the responder's oldest retained epoch.
When trimming under the complete-reply bound, retain the frames nearest throughEpoch.
Ordinary sealCapturedGroupInfo receives those frames alongside public state/head/ledger. No reply causes signing.
`checkForkRecoveryCapture({attempt, reply})` enforces E-lineage and transcript checks before settlement and every Y apply/restore/recapture.
Registry construction supplies these dependencies and excludes them from host parameters. Hosts cannot replace private authority through object fields.
Legacy direct factories may omit them and emit ordinary v2. Both real port runners bind real registry authority without replacing capabilities in tests.
New port methods are host operations at the exhaustive boundary. comparisonEpoch is host data. Condition callbacks drain before disposal.

Checkpoint storage includes sealed `{kind:'superseded-rejoin', id, key, record, authorisation}` with exact CapturedRejoinRecord X.
Condition rows carry `{kind:'condition', id, key, event, active, sealedProof}`. Notice evidence retains exact frames and complete local facts within its bounds.
Own-message rows, per-epoch seen counters and coverage-start markers share supporting installation retention.
Manual-recovery and successor-tombstone rows are group-level records. Generic callers cannot clear conditions/holds or fabricate forkRecovery intent.

### Safety and manual recovery (r24)

```ts
export type StrandedReason = 'retention-gap' | 'unprocessable-gap' | 'lost-state' | 'ahead'
// New digest-divergence/unexplained-own-commit evidence is host-report-only. Existing persisted evidence remains readable and immutable.
// Delivered competitors/copies/versions produce diagnostic poison, never these durable halt bodies.
export type GroupForkEvidence =
  | {
      kind: 'digest-divergence'
      epoch: number
      position: string
      localDigest: string
      remoteDigest: string
    }
  | { kind: 'epoch-authenticator'; epoch: number; local: Uint8Array; remote: Uint8Array }
  | { kind: 'unexplained-own-commit'; epoch: number; position: string; digest: string }
export type ForkHalt = {
  eventID: string
  evidence: GroupForkEvidence
  detectedAt: number
  producer?: 'app-report' | 'internal'
}
// Every new record supplies producer. Optionality reads legacy records only; never invent provenance.
export type GroupSafetyEvent = GroupKey & { id: string; kind: 'group:fork'; halt: ForkHalt }
export type RecoveryUnavailableEvent = GroupKey & {
  id: string
  kind: 'group:recovery-unavailable'
  reason: 'trust-unreadable'
}
export type PersistenceEvent =
  | AppStatusEvent
  | GroupSafetyEvent
  | RecoveryUnavailableEvent
  | GroupConditionEvent
  | ForkNoticeEvent
  | BranchAbandonedEvent
export type RecoveryTarget = { id: string; commitTopicID: string; hub: LogHub & MailboxHub }
// (r28c) The walker's validated own occurrence, supplied to the own-candidate adoption with explicit coverage; replaces FirstValidCommit.
// No search port or CommitSearchResult exists.
export type OwnOccurrence = {
  source: AdoptionExpected
  position: LogPosition
  payloadDigest: string
  coverage: 'complete' | 'incomplete'
}
export type ResyncProof = {
  targetID: string
  topicID: string
  groupInfoEpoch: number
  groupInfoAuthenticator: Uint8Array
  captureHead: LogPosition | null // authenticated reply's immutable head
  position: LogPosition
  payloadDigest: string
  verdict: Uint8Array
}
export type ManualRecovery =
  | { mode: 'resync'; targetID: string; allowOpenFork?: boolean }
  | {
      mode: 'resync'
      target: { targetID: string; hub: LogHub & MailboxHub; commitTopicID: string }
      allowOpenFork?: boolean
    }
  | { mode: 'successor'; successor: GroupKey }
export type PersistedManualRecovery =
  | { mode: 'resync'; targetID: string; commitTopicID: string; allowOpenFork: boolean }
  | { mode: 'successor'; successor: GroupKey }
export type ManualRecoveryRecord = {
  id: string
  source: GroupKey
  choice: PersistedManualRecovery
  stage: 'authorised' | 'completed'
  pauseReason: 'target-unresolved' | null
  destination: GroupKey | null
  attempt: CapturedRejoinRecord | null
  epochFloor: number | null
  settlements: Array<AcceptedRejoinSettlement>
  mutationID: string
}
export type ManualRecoveryStatus = {
  id: string
  kind: 'pending' | 'paused' | 'completed'
  reason: 'target-unresolved' | null
}
export type SuccessorTombstone = {
  kind: 'successor-tombstone'
  id: string
  source: GroupKey
  successor: GroupKey
  authorisationID: string
  retiredAt: number
  clearedAt: number | null
}
export function canMoveCurrent(params: {
  control: ControlSnapshot
  activity: { pending: number }
  stateReadable: boolean
  ledgerComplete: boolean
  walkComplete: boolean
  outboxUnresolved: boolean
  settlementUnresolved: boolean
  hardHold: SafetyHold
  condition: GroupCondition | null
  openForkNotice: boolean
  activeRejoin: boolean
  allowOpenFork: boolean
}): boolean
export type GroupSafety = {
  epochAuthenticator(key: GroupKey): Promise<EpochIdentity | null>
  reportFork(key: GroupKey, evidence: GroupForkEvidence): Promise<void>
  recover(key: GroupKey, choice: ManualRecovery): Promise<GroupKey>
  clearHold(key: GroupKey): Promise<void>
  onSafetyChanged(key: GroupKey, sink: (reason: SafetyHold) => void): () => void
  clearTombstone(groupID: string): Promise<void>
  status(key: GroupKey): Promise<{
    hold: SafetyHold
    condition: GroupCondition | null
    evidence: NotMemberEvidence | null
    manualRecovery: ManualRecoveryStatus | null
  }>
  events(
    key: GroupKey,
  ): Promise<
    Array<
      | GroupSafetyEvent
      | RecoveryUnavailableEvent
      | GroupConditionEvent
      | ForkNoticeEvent
      | BranchAbandonedEvent
    >
  >
  ackEvent(key: GroupKey, id: string): Promise<void>
}
export function createGroupSafety<TTx extends GroupTransaction>(params: {
  registry: GroupHandleRegistry
  persistence: GroupPersistence<TTx>
  mls: GroupMLS
  resolveTarget: (targetID: string) => Promise<RecoveryTarget>
}): GroupSafety
```

`recover` validates the source key, durably authorises only this choice, then returns the installed/successor key after completion.
A successor must already be normally admitted/available; resolve it before retiring the source, without acquiring both group gates.
The application owns target registration, URLs, topic selection and successor creation/admission; GroupMLS supplies configured identity/policy. Persist opaque target ID and sealed topicID;
resolve transport objects again on restart, requiring exact ID/topic equality. Unresolved attempts remain visibly paused without fallback.
Acknowledgement never lifts a halt. clearHold requires matching app-report provenance and preserves immutable evidence.
canMoveCurrent receives activeRejoin=true for a pending forkRecoveryAttempt. allowOpenFork bypasses only its open-notice predicate.
RegistrySwitchWrite.source.authorisationID selects the matching committed manual record rather than ordinary control.rejoin.
The peer/MLS manualRecovery data binds authorisationID/source, never an unchecked override boolean. Recheck authority before publication/installation.
GroupMLS adds optional onSafetyChanged(sink), carrying nullable releases alongside the existing non-null onSafetyHold subscription.
HubMux.resume retries deferred demanded subscriptions and resumes its receive drain after proven release, preserving stale-owner fencing.
ResyncProof verifies exact external application under bound-verdict rules, never arbitrary candidate approval.
The proof binds targetID/topicID/groupInfoEpoch/groupInfoAuthenticator/captureHead to the authenticated saved reply and exact confirmed external candidate.
Origin trust supplies signer authority/floors/owner/anchor. Authenticated offered GroupInfo and exact external commit bind sourceTree/candidate.
Do not require capture sourceTree to equal stale origin.trust.signerTree; membership/path changes between them are supported.
proof.payloadDigest equals record.payloadDigest, binding exact saved work. Bound tuple/verdict commitDigest and confirmationKey use record.digest/position.
Task 7 corrects packages/mls-rpc/src/registry/verdict.ts:205-218 and tests digest != payloadDigest. Never substitute proof.payloadDigest for commitDigest.
Accepted-unadoptable settlement adds no proof arm, nullable cursor, exporter tag, candidate codec or registry-verifier branch.
Keep existing fields/digests. A delivered-copy mismatch means nothing learned. It never authorises discard or invalidates confirmed work.
ledgerBefore is the immutable local obligation union, not merely source.trust.ledger. Task 7 preserves in-flight/awaitingBootstrap tokens while authenticating origin.
Recovery switch factory uses record.switchMutationID, including rollback/resolved-rolled-back; null-ID selection remains ordinary adoption only.
Frame-driven contradictions never produce fork halt evidence. Checkpoints produce separate detection-only notices. Host reportFork retains the existing evidence API.
Preserve all existing durable halt bodies/events without reinterpretation, including historical frame-derived evidence.

### Welcome, outbox and host effects

```ts
export type OpenWelcomeParams = Omit<ProcessWelcomeParams, 'keyPackageBundle'>
export type JoinedWelcome = {
  group: GroupHandle
  credential: MemberCredential
  sourceErrors?: Array<Error>
}
export type OpenWelcomeResult =
  | { joined: JoinedWelcome; packageUse: PackageUse }
  | { refused: 'package-consumed'; packageUse: PackageUse } // (r16 decision) receipt never claims Welcome admission
export function openWelcome(
  sources: Array<BundleSource>,
  welcome: OpenWelcomeParams,
): Promise<OpenWelcomeResult>
export type WelcomeAdmissionParams = {
  held: { incarnation: number; epoch: number | null; deleted: boolean; forkHalted: boolean } | null
  spentEpochAuthenticators: Array<Uint8Array>
  welcome: { epoch: number; epochAuthenticator: Uint8Array }
}
export function judgeWelcomeAdmission(
  params: WelcomeAdmissionParams,
): 'join' | 'alreadyJoined' | 'replace' | 'refused'
export type AppAttempt = {
  incarnation: number
  epoch: number
  floor: string | null
  attempts: number
  publishID: string
  segment: number
  topicID: string
}
export type AppOutboxEntry = {
  seq: number
  protocol: string
  prc: string
  data: Uint8Array
  lastAttempt: AppAttempt | null
  status: 'accepted' | 'failed'
}
export type AppPublicationOutcome = {
  incarnation: number
  segment: number
  topicID: string
  position: string
}
export type AppSettlementObligation = {
  sequenceID: string
  attemptID: string
  topicID: string
  outcome: 'published'
}
export type AppSettlementExpected = {
  identity: EpochIdentity
  stateVersion: number
  attemptID: string
}
export type AppSettlementResult =
  | { recorded: true }
  | {
      recorded: false
      reason: 'identity-changed' | 'state-version-changed' | 'attempt-changed' | 'entry-missing'
    }
export type AppStatusEvent = GroupKey & { id: string; entry: AppOutboxEntry } & (
    | { kind: 'accepted' }
    | { kind: 'published'; occurrence: AppPublicationOutcome }
    | {
        kind: 'failed'
        reason: 'incarnation-abandoned' | 'removed' | 'deleted' | 'database-restored'
        nextIncarnation?: number
      }
  )
export type AppOutbox = {
  put(entry: AppOutboxEntry): Promise<void>
  list(): Promise<Array<AppOutboxEntry>>
  recordSettlement(
    seq: number,
    obligation: AppSettlementObligation,
    expected: AppSettlementExpected,
  ): Promise<AppSettlementResult>
  loadSettlement(seq: number): Promise<AppSettlementObligation | null>
  remove(seq: number, outcome?: AppPublicationOutcome): Promise<void>
  clear(): Promise<void>
  events(): Promise<Array<AppStatusEvent>>
  ackEvent(id: string): Promise<void>
}
export type TransactionalGroupEffects<TTx extends GroupTransaction> = {
  outbox?(tx: TTx, event: AppStatusEvent): Promise<void>
  delete?(tx: TTx, key: GroupKey): Promise<void>
}
export function decodeAppEntry(entry: AppOutboxEntry): { procedure: string; payload: unknown }
export type MlsContextOptions = { keyRetention?: Partial<KeyRetentionConfig> }
// GroupOptions adds keyRetention?: Partial<KeyRetentionConfig>.
// resolveMlsContext/options, createGroup, restoreGroup, processWelcome, joinGroupExternal and derive inherit it.
// createMlsContext sets context.clientConfig = { ...defaultClientConfig, keyRetentionConfig: mergedRetention }.
// deriveGroup/staged clones preserve it; recovery restoration rebuilds it from registry options.
export type RecoveryEnvironment = {
  identity: OwnIdentity
  options: GroupOptions
  recoveryBinding?: RecoveryBinding
}
// @kumiai/mls primitives: no rpc or registry dependency.
export type RecoveryTrustInputs = {
  groupID: string
  genesisAnchor: Uint8Array
  signerTree: ClientState['ratchetTree']
  registry: DeviceRegistry
  credential: MemberCredential
  binding: ControllerBinding | null
  ledger: Array<string>
  ciphersuiteName: string
}
export function createRecoveryRequestFromTrust(params: {
  trust: RecoveryTrustInputs
  identity: OwnIdentity
  requestID: string
  deadlineMs?: number
}): Promise<{ request: string; requestKey: Uint8Array }>
export function authenticateRecoveryReply(params: {
  trust: RecoveryTrustInputs
  sealed: Uint8Array
  requestID: string
  requestKey: Uint8Array
  options: GroupOptions
}): Promise<RecoveryGroupInfo | null>
export function openRecoveryVerdictFromTrust(params: {
  trust: RecoveryTrustInputs
  sealed: Uint8Array
  requestID: string
  requestKey: Uint8Array
  options: GroupOptions
}): Promise<OpenedRecoveryVerdict>
// @kumiai/mls-rpc facade: convert GroupRecoveryTrust to RecoveryTrustInputs; GroupMLS request bytes are UTF-8 of primitive request.
export type CapturedRecoveryEnvironment = RecoveryEnvironment & {
  accept: RecoveryAdoptionDependencies['accept']
}
export function buildRecoveryCandidate(params: {
  source: RegistryRecoverySource
  sealed: Uint8Array
  requestID: string
  requestKey: Uint8Array
  target: RecoveryRouting
  environment: CapturedRecoveryEnvironment
}): Promise<CapturedAppliedRecovery>
export function restoreRecoveryCandidate(params: {
  source: RegistryRecoverySource
  candidate: Uint8Array
  requestKey: Uint8Array
  environment: CapturedRecoveryEnvironment
}): Promise<CapturedPendingRecovery>
// buildRecoveryCandidate authenticates sealed under source trust itself and keeps those exact bytes as attestedReply;
// a parsed reply never travels apart from its attestation. onAccepted delegates to environment.accept (r21).
export function deriveRecoverySecretFromTrust(
  trust: GroupRecoveryTrust,
  options?: GroupOptions,
): Promise<Uint8Array>
// Default: suite KDF.expand(KDF.extract(UTF8(groupID), genesisAnchor), UTF8('kumiai/recovery/v1'), 32), exactly packages/mls-rpc/src/mls.ts:129-136.
// genesisAnchor is the existing encoded anchor. Trust's ciphersuiteName selects the same configured suite/provider.
// Registry recovery construction with custom recoverySecret but no recoverySecretFromTrust throws TypeError before requests/hold writes.
// When live state is available, compare trust/live bytes and commit/rendezvous topics. Never silently change derivation or topics.
export function createMlsContext(
  cipherSuite: MlsContext['cipherSuite'],
  anchor?: GroupAnchor,
  options?: MlsContextOptions,
): MlsContext
```

Outbox facades share the coordinator and reject stale active writers; retired ports only serve owed records/events/frozen settlement.
TransactionalGroupEffects is host opt-in with handler restrictions; other hosts consume stable-ID events outside transactions.
Registry constructors enforce retainKeysForGenerations and maximumForwardRatchetSteps >= 1000 (r16 decision).
Normal MLS defaults remain; options flow through every listed path. Reply/restore checks bind trust anchor/tree/registry and candidate ownership.
Unknown complete/remove succeeds; byte/nested values are defensive copies.
```ts
export class GroupStateConflictError extends Error {
  override name = 'GroupStateConflictError'
}
export class GroupStateUncertainError extends Error {
  override name = 'GroupStateUncertainError'
}
export class DisplacedGroupHandleError extends Error {
  override name = 'DisplacedGroupHandleError'
}
export class OutboxReplacementError extends Error {
  override name = 'OutboxReplacementError'
}
export class InvalidAppEntryError extends Error {
  override name = 'InvalidAppEntryError'
}
export class NonRootProviderError extends Error {
  override name = 'NonRootProviderError'
}
```

These inherit `(message?: string, options?: ErrorOptions)`.
Re-export canonical rpc StorageOutcomeUnknownError and GroupControlUnsettledError. Do not redeclare them.

### Factories, lifted ports and test support (r16 decision)

```ts
export type MemoryStoreRows = Record<string, Map<string, unknown>>
export type MemoryTransaction = GroupTransaction & { rows: MemoryStoreRows }
export type MemoryDatabase = {
  transact<TValue>(
    scope: { groupID: string | null; devicePackages: boolean },
    fn: (tx: MemoryTransaction) => Promise<TValue>,
    options?: OutcomeAwareTransactionOptions,
  ): Promise<TValue>
  completionBarrier(scope: { groupID: string | null; devicePackages: boolean }): Promise<void>
  snapshot(): MemoryStoreRows
}
export function createMemoryTransaction(params: { rows: MemoryStoreRows }): MemoryDatabase
export function createMemoryDevicePersistence(params: {
  db: MemoryDatabase
  atRest: AtRestCodec
  providerID: string
  ownerDID: string
  effects?: TransactionalGroupEffects<MemoryTransaction>
  ownershipContext?: OwnershipContextPort
}): DevicePersistence<MemoryTransaction>
// Phase 3. GroupProviderTransaction forwards this root callback's StoreProvider.
export type GroupProviderTransaction = StoreProvider & GroupTransaction
export function createDevicePersistence(params: {
  db: HozonDB
  atRest: AtRestCodec
  providerID: string
  ownerDID: string
  effects?: TransactionalGroupEffects<GroupProviderTransaction>
  ownershipContext?: OwnershipContextPort
}): DevicePersistence<GroupProviderTransaction>
export type BufferedEpochInspection = {
  inspectEpoch(ciphertext: Uint8Array): bigint | undefined
  currentEpoch(): number | null
  onEpochChanged(listener: () => void): () => void
}
export function createBufferedPeerHubView(params: {
  hub: MailboxHub
  peerDID: string
  groupID: string
  epochs: BufferedEpochInspection
  reconnectTimeoutMs?: number
  logger?: { warn(message: string, context?: Record<string, unknown>): void }
}): MailboxHub & { dispose(): void }
export type MLSEncryptorParams = {
  access: Pick<RegistryHandleAccess, 'seal' | 'receive' | 'runtime'>
  peerDID: string
  role: 'dialer' | 'listener'
}
// r26: byte-level seal/receive; empty MLS AAD (kubun wire format); membership from committed runtime snapshots
export class MLSEncryptor implements Encryptor {
  constructor(params: MLSEncryptorParams)
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>
  trackPublish(hub: MailboxHub): MailboxHub
  clear(): void
  watchPeerRemoval(dispose: () => Promise<void>): () => void
}
// Broadcast transit fields (optional for generic transports, required by group adapters):
export type UnwrapResult = { payload: Uint8Array; senderDID?: string; epoch?: number }
export type BusEvent = { data: unknown; senderDID?: string; epoch?: number }
export type BroadcastHandlerContext = { senderDID?: string; epoch?: number; signal?: AbortSignal }
// BroadcastMessage adds epoch?: number; BroadcastHandler takes BroadcastHandlerContext.
export type DirectedHandlerMetadata = {
  epoch: number
  incarnation: number
  message: { header: { 'kumiai/epoch': number } }
}
// OpenedInbound adds epoch: number. Every Enkaku event/request/stream/channel context adds DirectedHandlerMetadata.
export type RawStoredRecord = {
  groupID: string
  incarnation: number | null
  namespace: string
  recordID: string
  key: string
  bytes: Uint8Array
}
export type PendingCommitFault = {
  rejected: Promise<void>
  barrierWaiting: Promise<void>
  finish(outcome: 'commit' | 'rollback'): Promise<void>
}
export type PersistenceTestPorts<TTx extends GroupTransaction> = {
  device: DevicePersistence<TTx>
  registry: GroupHandleRegistry
  safety: GroupSafety
  packages: DevicePackageAdapters
  access(groupID: string): Promise<RegistryHandleAccess>
  crypto(key: GroupKey): Promise<
    GroupCrypto & {
      pending: PendingAppFrames
      unwrapBatch(frames: Array<OpenAppInput>): Promise<Array<OpenAppResult>>
    }
  >
  mls(key: GroupKey): GroupMLS
  completion(key: GroupKey): HandlerCompletion<TTx>
}
export type PersistenceFixture<TPorts> = {
  ports: TPorts
  reopen(): Promise<TPorts>
  failNext(point: 'after-first-write' | 'before-commit' | 'status-read'): void
  commitThenReject(): void
  rejectCommitPending(): PendingCommitFault
  inspectRows(): Promise<MemoryStoreRows>
  inspectRawBytes(): Promise<Array<RawStoredRecord>>
  inspectSideRow(key: string): Promise<Uint8Array | null>
  mutateStoredRecord(
    namespace: string,
    key: string,
    mutate: (bytes: Uint8Array) => Uint8Array,
  ): Promise<void>
  swapStoredRecords(namespace: string, keyA: string, keyB: string): Promise<void>
  setTime(now: number): void
  advanceTime(ms: number): Promise<void>
  close(): Promise<void>
}
export type PersistenceConformanceParams<TTx extends GroupTransaction> = {
  label: string
  writeSideRow(tx: TTx, key: string, bytes: Uint8Array): Promise<void>
  createFixture(
    id: string,
    effects?: TransactionalGroupEffects<TTx>,
  ): Promise<PersistenceFixture<PersistenceTestPorts<TTx>>>
}
export function testGroupPersistenceConformance<TTx extends GroupTransaction>(
  params: PersistenceConformanceParams<TTx>,
): void
```

Memory transactions snapshot/commit only declared group/device-package scope plus supplied side rows; concurrent group commits preserve both. Reject reentrant
transactions and global queues. Snapshots expose only committed sealed rows, including during unfinished backend completion. Late commit/rollback faults retain
private rows, the group owner lock and both hook queues after the caller promise rejects.

Physical mutation/swaps change only addressed ciphertext, preserving keys/markers; missing keys/throwing callbacks change nothing. Use idle resolvers, reopen to
discard caches, inspect every physical copy before opening. Side rows use the supplied transaction; assert visibility and hook counts, including independent postgres
reads. Existing ControlStore, AppOutbox, AnchorStore, pending-crypto and cursor cases remain in the unified persistence fixture. Standalone legacy memory control
factories may remain for isolated tests, but never satisfy shared persistence conformance. TPorts is `PersistenceTestPorts<TTx>`: real MLS fixtures construct
crypto/MLS through these adapters; mirrors reproduce every changed port structurally. Broadcast transport copies epoch/sender only from unwrap; handler adapters take local incarnation from completion.key; bus event/anycast
contexts propagate them. Group paths refuse missing authenticated epoch. Directed metadata overrides wire headers and denotes the invoking frame, including
stream/channel requests; it is never the reply/current epoch. Retention options survive every hub subscribe/reconnect/retry; MLS key retention also propagates
through all constructors/derive/restore paths.

## Source checks

Reverified for r16 on 2026-10-10, feat/spec-p-phase-2. These are implementation boundaries, not completion claims.

| Boundary                                                                             | Current source                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull/build/save; absent mismatch currently returns to intent                         | `packages/rpc/src/control/operations.ts:144`, `:194`                                                                                                                                                                                                                                               |
| Match-before-coverage and direct adoption need first-valid validation (r16 decision) | `packages/rpc/src/peer.ts:2128`, `packages/rpc/src/control/operations.ts:192`, `:235`                                                                                                                                                                                                              |
| Head is separate publication metadata; MLS AAD binds no log position                 | `packages/rpc/src/peer.ts:2106`, `packages/hub-client/src/client.ts:94`, `node_modules/ts-mls/dist/src/messageProtection.js:69`                                                                                                                                                                    |
| Discarded protection tree; empty control proposals                                   | `node_modules/ts-mls/dist/src/createCommit.js:77`, `packages/mls/src/group-commit.ts:279`                                                                                                                                                                                                          |
| Referenced proposals required; omitted proposals cleared                             | `node_modules/ts-mls/dist/src/clientState.js:398`, `node_modules/ts-mls/dist/src/processMessages.js:219`                                                                                                                                                                                           |
| SQL mismatch rolls back ID claim; memory needs topic-scoped dedup                    | `packages/hub-store/src/store.ts:226`, `:310`, `packages/hub-server/src/memoryStore.ts:216`                                                                                                                                                                                                        |
| Divergence/ahead/own-unmerged classifier and strand observations                     | `packages/rpc/src/classify.ts:255`, `:282`, `packages/rpc/src/peer-types.ts:112`                                                                                                                                                                                                                   |
| Losing forks currently heal; shared automatic recovery trigger                       | `packages/rpc/src/peer.ts:1512`, `:3053`                                                                                                                                                                                                                                                           |
| Existing resync wrapper, producer, sealed reply and replacement gate                 | `packages/mls/src/group-welcome.ts:203`, `packages/mls-rpc/src/recovery.ts:144`, `packages/mls/src/recovery.ts:538`, `packages/mls/src/lifecycle.ts:445`                                                                                                                                           |
| Current reply v1, attestation layout/authentication and missing captureHead          | `packages/mls/src/recovery.ts:35`, `:251`, `:261`, `:566`, `:618`, `:711`, `packages/rpc/src/peer.ts:1092`, `packages/mls-rpc/src/mls.ts:397`                                                                                                                                                      |
| KeyPackage secrets generated independently, encoded and held in host source stores   | `node_modules/ts-mls/dist/src/keyPackage.js:62`, `packages/mls/src/group-credential.ts:71`, `packages/mls/src/key-package-codec.ts:91`, `packages/mls-hub/src/pool.ts:117`, `packages/mls-hub/src/provisioner.ts:135`, `packages/mls-hub/src/pool-store.ts:24`, `packages/mls-hub/src/store.ts:21` |
| Welcome private-key input and restored bundles                                       | `packages/mls/src/group-welcome.ts:95`, `packages/mls-hub/src/records.ts:161`                                                                                                                                                                                                                      |
| Hub KeyPackage surface has no revocation, last-resort upload replaces its slot       | `packages/hub-protocol/src/protocol.ts:193`, `:241`, `:262`, `packages/hub-client/src/client.ts:186`                                                                                                                                                                                               |
| Fresh resync tree/history and zero generations                                       | `node_modules/ts-mls/dist/src/createCommit.js:289`, `node_modules/ts-mls/dist/src/secretTree.js:241`                                                                                                                                                                                               |
| Ordinary adoption progress carry                                                     | `packages/mls/src/group-handle.ts:910`                                                                                                                                                                                                                                                             |
| Current v1 codec and recovery source-tree splice                                     | `packages/mls/src/codec.ts:25`, `packages/mls-rpc/src/recovery-codec.ts:36`                                                                                                                                                                                                                        |
| Sender-zero encoding loss                                                            | `node_modules/ts-mls/dist/src/unappliedProposals.js:8`, `node_modules/ts-mls/dist/src/codec/optional.js:4`                                                                                                                                                                                         |
| Separate pending completion/cursor; terminal startup precedes pending restore        | `packages/rpc/src/app-lane.ts:498`, `:513`, `packages/rpc/src/peer.ts:3111`, `:3137`                                                                                                                                                                                                               |
| Ordinary cross-group reuse before consume; source metadata persists late consumption | `packages/mls-hub/src/join.ts:46`, `packages/mls-hub/test/join.test.ts:167`, `packages/mls-hub/README.md:166`, `packages/mls-hub/src/pool-store.ts:54`                                                                                                                                             |
| Recovery requires last-known tree/anchor; current consumers require a handle         | `packages/mls/src/recovery.ts:658`, `:675`, `packages/mls-rpc/src/mls.ts:386`, `:416`, `:466`                                                                                                                                                                                                      |
| Existing access/crypto, handlers and pre-open ref need adapters                      | `packages/mls-rpc/src/access.ts:12`, `packages/mls-rpc/src/crypto.ts:87`, `packages/rpc/src/handlers.ts:19`, `packages/rpc/src/app-lane.ts:724`, `:517`, `../kubun/packages/plugin-p2p/src/groups/group-handle-access.ts:24`                                                                       |
| Reconnecting lift must replay retention (r16 decision)                               | `../kubun/packages/plugin-p2p/src/hub/hub-like.ts:529`, `:1033`                                                                                                                                                                                                                                    |
| Provider lacks explicit scope and ambiguous-completion hook retention                | `../hozon/packages/db/src/db.ts:31`, `:275`, `:286`                                                                                                                                                                                                                                                |

Supplied Resync/C probes report fresh-member resync and exact-byte retry; neither was rerun or tested capture-head/database-loss rules. Resync's assembled
integration was blocked. D1/D4 specify validation/key/progress requirements without implementation claims.

## Crash seams

Wrap providers/hub clients only in tests. Phase 2 reconstructs runtime. Phase 3 faults real providers.
Phase 6 kills children. After means proven transaction commit, never callback completion.

| Seam                                                                                                      | Recovery assertion                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installed state/fact/publication debt committed, before signing                                           | restart signs that exact proven installation; progress-only saves create no fact; rollback releases nothing                                                                                           |
| Exact checkpoint frame saved, before publish or after ambiguous handoff                                   | retry identical bytes/publishID; persist heartbeat deadline/ID; stale workers never follow a replacement incarnation                                                                                  |
| Notice/condition/event committed, before notification or after acknowledgement                            | replay/coalesce material evidence, not heartbeats; checkpoint input never creates a hold or recovery transition                                                                                       |
| Checkpoint expiry before restart or late acknowledgement                                                  | group-wide 256/seven-day bounds prune evidence even unacknowledged; summary/coverage exposes holes without clock refresh                                                                              |
| Superseded X/history cleared to bound Y intent, before construction or after restart                      | exact X and obligations survive for every saved stage; ordinary floor unchanged; only the same Y gets E; every capture rechecks lineage/transcript                                                    |
| Authorised manual attempt replaces pending forkRecovery intent                                            | abandonment removes Y's exception atomically; pending intents count as active rejoin before replacement                                                                                               |
| Manual target persisted, before resolver/move/rejoin proof                                                | resume exact ID/topic/override only; mismatch pauses visibly without fallback; source/routing/holds remain until proof                                                                                |
| clearHold before/after proven commit, including ambiguity                                                 | keep hold before proof; clear only matching app provenance; retain exact evidence/history and unrelated conditions                                                                                    |
| Successor retirement/tombstone committed, before routing notification                                     | source stays retired, old Welcome refuses across restart; no state/messages copied; owed work remains serviceable                                                                                     |
| Decrypted missing/malformed spent set observed by warm or cold registry                                   | persist spent-set-corrupt through safety-only writes; unreadable envelopes remain recovery-unavailable; precedence survives restart                                                                   |
| Inside a group transition/batch, after its first logical write                                            | all affected namespaces and transactional effects commit together or remain unchanged                                                                                                                 |
| Built-save/manual authorisation committed, before publish or after remote acceptance                      | only the selected recovery target resumes; exact saved bytes/ID/candidate survive; the walk settles, never a pre-walk search (r28b)                                                                   |
| Open batch committed, before default handler; default effect before completion commit                     | every opened frame redelivers with the same key until completion; no cursor-only loss                                                                                                                 |
| Transactional completion before/after COMMIT                                                              | host effect, pending completion and cursor all roll back or all persist                                                                                                                               |
| Self-removal committed, before opened handlers drain                                                      | terminal restart drains persisted records without new crypto/network work before clearing                                                                                                             |
| Certification committed, before removal/terminal/switch                                                   | frozen obligation survives; original sealed topicID reports published exactly once                                                                                                                    |
| Fork-halt committed before notification, or recovery switch/Welcome committed before peer restart/consume | halt/event survive without automatic recovery; a completed switch isolates/tombstones records and replays failures; device hub-cleanup survives retirement and resumes without joinRef (r16 decision) |
| COMMIT rejected while backend unfinished                                                                  | raw negative reads release nothing; barrier selects final rows and one hook queue, or none with factory fail-stop on ownership conflict                                                               |
| Ownership conflict found by proof (r17 decision)                                                          | factory fail-stops before any hook or new transaction; restart replays durable markers, events and obligations; no hook runs for the conflicted mutation                                              |
| Application lease committed, before seal                                                                  | restart restores the advanced committed state; the lost send copy's range is wasted, with no additional skip or sender generation reuse                                                               |
| Welcome transport accepted, before obligation deletion                                                    | delivery repeats at least once; atomic ordinary burn/receipt or last-resort spent admission prevents reinstall                                                                                        |
| Restore declaration committed, before package invalidation or group failure transactions finish           | startup remains held after reconstruction. Resume invalidation/holds/events before resync or any send (r15 decision).                                                                                 |

There is no pending-complete/cursor seam, state/control/anchor split seam or handshake-reservation seam.
Remaining external P2a publish/confirm/bootstrap/Welcome seams use its stage replay. Frame-driven past divergence becomes diagnostic poison.
Host-reported forks retain durable halt/manual recovery and provenance-restricted clearHold. Existing evidence remains immutable.

## Conformance

Run both contract suites against real implementations and every affected double.
Each changed port/restart seam enumerates real-MLS/double fixtures and supplied/absent ownership-context modes where applicable.
Behavioural tasks own their real witnesses, conflicting assertion migrations and exhaustive host-boundary classifications.
Checkpoint core includes the real split witness. Absence and floor contracts immediately follow it.
Both real MLS port runners exercise registry authority and transcript checks through ordinary adapters, without capability replacement.
Keep each meaningful existing case. Replace cases tied solely to removed mechanisms with the equivalent invariant below.

| Suite / phase                         | Case                                                | Required assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| codec / 2                             | lossless sender                                     | zero/one/absent clone/save/reopen, malformed sidecar. v2 only: flags 0 and 1 round-trip the reservation fields exactly; v1, v3, v4 and unknown version bytes throw; flags or consumed byte above 1 and trailing bytes refuse. Zero regression fails against current codec.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| recovery codec / 2                    | complete sourceState and captured origin            | differing source/candidate trees, empty proposals and zero/one/absent senders. Persisted v3 candidate/key restores bound verdict and immutable authenticated source/target/capture/search origin. V1/v2 adoption refuses. Legacy unadopted/conflictEpoch records hold without mutation or fabricated metadata; proven adopted continuations never reinstall.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| checkpoints / 2,3                     | canonical installed-only authority                  | Strict Ed25519/canonical bytes/4096-byte bound, exact hashes/parents and immutable provenance. Speculative/rolled-back/fabricated facts cannot sign. Every installation site captures transcript/roster/debt, progress never does. Fence stale workers. Real MLS and independent double, supplied/absent ownership context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|                                       | real split view and refused loser                   | Independently install valid divergent states under shared signers. Exchange only checkpoints, withholding competing commits. Both sides notify without halt/switch/stranding. CAS loser/re-encoding cannot manufacture installation facts. Lone fabricated testimony only notifies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
|                                       | eligibility and comparison coverage                 | DID+key pre-split eligibility with compared-epoch fallback, leaf differences and equivocation attribution. Expose group-wide effectiveFloor/ranges/holes after skipped/pre-join/expired epochs and restart. Summary-only epochs never restore coverage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|                                       | bounded transport/storage                           | Separate checkpoint/commit heads and cursors, identical authorize gates, subscribe-before-drain, retained fetch, exact retry, deadlines/jitter and rate/receive budgets. Current included in 256; supersession age and count prune even unacknowledged evidence. No roster truncation or replay clock refresh.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|                                       | notices and journal reports                         | Material-only coalescing/quiet close, local clocks, ack/history and partial summaries. Prospective own IDs/other counters, zero ephemeral rows. Unknown ancestry reports unknown/partial without delaying authenticated switch. Real/double report and retirement seams.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| roster absence / 2,3                  | disclosure and complete proof                       | Historical DID AND key gate, never-seen/expired silence, bounded requestID dedupe/budgets. Bind request/head/tree/complete ledger/lineage. Changed leaf with present DID is never absence. No secret/message or historical roster disclosure. Real/double and restart rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|                                       | bounded signed span                                 | Reject comparisonEpoch tampering/unsafe values and cross-domain/spliced replies. Select [max(comparisonEpoch, responder oldest retained), F]. Keep total reply <=786432 bytes including overhead by trimming older lineage frames, retaining those nearest F and always F's frame. Large-group full history exceeds the bound; its bounded suffix verifies without truncating public tree/ledger. Compare the newest common retained epoch in the suffix. Missing E refuses fork-floor authority even when common-epoch absence qualifies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
|                                       | no-open-notice 20/12 diagnosis                      | Requester installed through 20 with no open notice signs its OLDEST retained epoch. Eligible former-member responder on the different branch at 12 returns the bounded retained span through 12. Newest common retained epoch comparison verifies unequal lineage and own-DID absence: surface not-member, keep retries running and X/floor unchanged. No fork-floor authority follows from this diagnosis alone. Real/double and restart rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
|                                       | lineage-relative diagnosis                          | Advanced losing device at 20, continuing branch at 12, split 10: verified unequal lineage permits not-member. Older/equal same-lineage proof refuses. Fresh losing-branch absence only diagnoses, retries continue; later install/head-only/re-anchor clears active condition and preserves evidence. No new admission refusal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
|                                       | status and app policy                               | Defensive responder keyHash/epoch/observedAt/DIDs/count; retrying:true with optional pendingReason. Distinguish no-reply/no-eligible-responder. Events coalesce per new evidence. Disposal/deletion remains app policy, never terminal continuation authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| fork recovery / 2,3                   | saved X and no-X                                    | Eligible non-equivocating open E testimony plus same reply key's matching E checkpoint/pre-E roster and MLS lineage/transcript. Settle built/published/confirmed/adopted-incomplete X to superseded-branch with exact sealed history, never not-accepted. Union obligations and persist bound Y intent atomically, or no-X intent without invented settlement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|                                       | every capture and restart                           | Real adapter apply/restore/recapture rechecks E-lineage and transcript for Y, including restart after settlement. Own-lineage stale capture refuses even above E. Ordinary floor unchanged; settlement/abandonment removes only Y's exception. Two-member healing needs no second DID.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|                                       | coverage and best-known split                       | F >= best-known E. Below oldest or retained-range hole stays target-behind. Earlier-moving notice re-enables authorisation for head in [S,E). Hole waits for a retained epoch or beyond newest; evidence expiry stays target-behind. Manual resync exits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|                                       | real adapter authority                              | Both real port runners exercise no-X and saved-X healing through original adapters. Registry facts reach ordinary v3 sealing; host injection cannot supply private authority/disclosure/floor inputs. V2/missing authority preserves X/floor and retries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| manual recovery / 2,3                 | current move restrictions                           | Require freshness/readability/complete ledger/walk and no lag/slot/operation/unresolved publications/settlements/pending owner work. Reject every hard hold/condition/open notice/active rejoin, including pending forkRecoveryAttempt. allowOpenFork overrides only open notice. Real/double and restart rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
|                                       | selected-target rejoin                              | Call-time/registered exact ID/topic/override persists. Resolver mismatch visibly pauses without fallback. Same-key move preserves holds. Rejoin needs bound external confirmation and creates hold-free n+1. Failed/pending proof preserves source/routing/holds. Hard-held responders stay silent; all-held exit is successor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
|                                       | intent abandonment and partial migration            | Manual authorisation atomically abandons pending forkRecovery intent. Partial migration may split hubs undetectably; ahead arrival stays target-behind absent restricted authority. Empty targets never bypass current-move exclusions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|                                       | successor and scoped clear                          | Already admitted successor retires source atomically with tombstone/failures/routing; never copies state/messages. Newer unspent old Welcome still refuses, including restart. Explicit clearTombstone preserves spent checks. Matching app-report clearHold preserves history, refuses internal/legacy/unrelated holds, and resumes ordinary walk without forced resync.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| spent diagnosis / 2,3                 | cold/warm/restore paths                             | Successfully decoded missing/malformed sets yield typed spent-set-corrupt/event/status; unreadable envelopes retain recovery-unavailable. No empty fallback. Warm observation persists across restart. Preserve precedence/evidence and ordinary admission. Total-loss fresh invitation and already admitted successor remain available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| recovery reply / 2                    | authenticated captureHead (r15 decision)            | Responder exports a complete reconciled snapshot/cursor pair; empty gap or moved snapshot never certifies a head. String/null and captured authenticator round-trip in attestation; missing/wrong-type/tampered/invalid fields and v1 refuse before build. Restart retains original captureHead/target/search origin and initial CAS head.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| persistence / 2,3                     | CAS and monotonicity                                | Stale revision/version, tombstone-as-absent, lower epoch, same-number different authenticator or same-identity progress/ceiling regression reject unchanged. Non-root factories refuse.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|                                       | incarnation switch atomicity/isolation              | Source A4 in n to accepted external-resync state in n+1. Mid-write rollback changes neither record. Commit tombstones n and installs n+1 with fresh progress/anchor/cursors/control. Old applied rows cannot mask new-incarnation self-removal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
|                                       | source/candidate guards                             | stale incarnation/version/source, unaccepted/refused/spent resync result reject. Ambiguous successful switch resolves once. Adopted replay never reinstalls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|                                       | spent authenticators across incarnations            | A3 to A4 to fresh resync in n+1, reconstruct, exact and alternate valid A3 both refuse for ordinary/last-resort sources. Same authenticator/different bytes cannot evade admission.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
|                                       | cross-group ordinary Welcome (r16 decision)         | Concurrent Welcomes name one ordinary source/ref. Exactly one group installs/burns it, including COMMIT ambiguity; loser installs nothing. Retired winner cannot make the key reusable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|                                       | device cleanup retirement (r16 decision)            | Install/burn, fail hub cleanup, retire/tombstone, reconstruct. Cleanup-capable adapter retries to confirmed removal; local key never returns. Current hub records unsupported/expiry residual.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|                                       | lifetime/tombstone admission                        | every installation appends once. Rollback spends nothing. Delete/reopen keeps set. Unspent Welcome below an abandoned incarnation's epoch can create the next incarnation. Receipt-only replay never installs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|                                       | total database loss (r15 decision)                  | Lose group/spent state and all ordinary/last-resort private records together. Exact/alternate old Welcomes cannot decrypt/install, despite retained signing identity and hub copies. For same-group admission/reconstruction, retained-trust resync or manual fresh invitation succeeds; absent trust permits only fresh invitation. Already admitted successor retirement remains an exit. Separately surviving key stores violate/refuse the provider-scope contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|                                       | declared backup restore/participants (r16 decision) | Restore an older snapshot, declare before startup. All groups hold durable/ephemeral sends across restart; discard/rotate restored ordinary and retained last-resort keys. Only fresh-leaf external resync switches each group once and enables sends. Missing old leaf refuses. Declare commits restore-work once; restart resumes registered participants/stages, rejects foreign providers and deletes work only after completion. Test revocation failure/residual.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|                                       | restore outbox/crash (r16 decision)                 | All restored entries, including certified obligations, fail with database-restored events retaining data. Mid-write rollback exposes none; committed events replay until ack. Crash during declaration/invalidation/holds keeps startup blocked. No restored publish/reseal. Undeclared rollback is explicitly outside the guarantee.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|                                       | failed-outbox event                                 | switch atomically fails each unproven old entry/status and persists incarnation-abandoned event. Restart replays same ID/data until ack. No automatic reseal. Certified entries remain published.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
|                                       | order/read isolation                                | A4 occurrence (n,4,10) precedes resynced occurrence (n+1,2,20). Prior local watermark leaves it unread. Host history stays. Old-anchor peer receipt covers no new anchor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|                                       | pre-open/mixed batch (r16 decision)                 | Reference has no procedure; valid siblings install with derived keys, malformed plaintext burns/records poison without handler invocation, crypto refusals consume no key, future frames hold. Ambiguity exposes no partial result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
|                                       | open N, crash mid-batch                             | all N key advances/pending records commit or none. Rollback leaves keys usable and emits no plaintext/ack. Duplicate frame creates one pending record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|                                       | batching latency/fairness                           | idle lone frame commits without advancing batching timer. Sustained lane A burst allows low-rate B and ready control adoption within three total A/B/control batches, including active A. Enqueue also receives service.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
|                                       | group independence                                  | held/pending group A transition does not block B. Concurrent memory group commits preserve both groups' rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                                       | completion/cursors                                  | pending completion and contiguous cursor atomic. Unknown/double completion harmless. Future/unopenable records cannot advance cursor. Code-unit position ordering survives reopen (r25).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
|                                       | transactional exactly-once effect                   | side-row effect plus completion/cursor rolls back mid-transaction. Commit then crash/redelivery leaves one effect and no handler invocation for completed record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
|                                       | stable idempotency key                              | default handler effect before completion crash causes redelivery with byte-identical key/sender/epoch/incarnation. Semantic chat dedup keeps first content on conflicting reuse.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|                                       | terminal opened drain                               | opened batch, self-removal, kill before handlers. Restart awaits all handlers/completions before clear. Failures retain pending. No decrypt/publish. Live path matches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|                                       | transition visibility/hooks                         | state/control/anchor/pending/outbox/cursor and supplied side row share commit/rollback. Unknown queues remain zero until proof. Exactly one matching hook queue before caller release for non-conflicted outcomes; none on factory fail-stop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                                       | late completion/barrier                             | insert/open/Welcome/switch/delete and control-only/anchor/cursor/outbox transitions reject before backend completion. Initially absent owner covered. Late commit/rollback settles all rows before lifecycle handoff.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|                                       | at-rest all namespaces                              | inspect every physical byte copy for plaintext/spans, anchor secrets and topicIDs. Same-codec reopen succeeds. Wrong group/incarnation/namespace/record AAD, mutations and swaps reject through adapters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|                                       | deletion/lifecycle                                  | stopped/drained owner, unsettled-control refusal, atomic tombstone/effects, no late writes. Retired outcomes/Welcomes/events remain serviceable until ack/delivery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ownership-phases / 2,3 (r17 decision) | phase capabilities                                  | Domain write in effects, account-time host access or after outcome refuses with PersistencePhaseError and changes nothing, through supplied stores, independently constructed stores and exposed transaction access alike. Side writes in effects commit with the transition. Mutation-check each refusal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
|                                       | operation lock                                      | Suspend an async store operation mid-write, start a second operation and finalisation: they run one at a time and validation sees both. Two concurrent updates of the same record (control outcomes) both persist. A rejected abandoned seal makes the transition roll back. A late operation from a revoked attempt writes nothing. An operation called behind a suspended one before closure still drains; stores supplied in work keep working in effects; private writer operations complete in account. A suspended abandoned open followed by Read failure releases at once and the next same-scope operation completes. Device loads (initial and existing), device transitions, package reads and Combined participation complete without `ownershipContext`. Corrupt-state and corrupt-trust safety events and control obligations still commit; failed required opens and seals roll back. Effect side write to another incarnation is accounted (version advances) or refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|                                       | effect store calls/exceptions                       | Outbox effect then lifetime load, and delete effect then clearTransport, complete within bound. A throwing effect rolls back transition and effect rows. A throwing onCommit/onRollback hook is contained, other hooks run, outcome stands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|                                       | ambiguous transition fence                          | Unknown Transition, both before backend completion and after commit with proof delayed: every read path (group/facade/device/package) and same-group Transition wait until proof; independent group commits meanwhile. Zero hooks before proof, exactly one queue after unless proof fail-stops the factory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|                                       | ambiguous read releases                             | Fault on a root Read, both commit-then-reject and unfinished backend: read rejects; next same-group Read and Transition complete, on every read path. Providers with connections: the failed read transaction is completed and the next writer acquires the writer lock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
|                                       | proof classification/join                           | committed and rolledBack settle once; external resolve (group and device APIs) joins pending proof; repeated settlement idempotent. Conflicting marker: no hook queue runs, factory fail-stops, caller and every queued or later entry on any scope reject GroupStateConflictError. With another scope already ambiguous or mid-work, that entry, its joined resolvers and any drain awaiting it also reject, its hooks never run and its open backend transaction is rolled back or disposed. Fallback resolve after a later mutation superseded M throws GroupStateUncertainError. Barrier-created owner row classifies as absent. Certification rollback retry keeps its slot; queued terminal work cannot pass it. Combined classifies both owners, including competing ordinary-package installation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
|                                       | ordering/reentrancy/deletion                        | Combined holds device then waits group; cancelled wait withdraws its group waiter and releases device, and the group then progresses; group-holding entry refuses device slot. Root call from prepare/work/finalise/effects/account/proof/hook rejects ReentrantOwnershipError without waiting, after `await` with the `ownershipContext` port and in the synchronous segment without it; suite runs both ways. Concurrent unrelated callers stay unbound; nested port bindings restore after a throwing callback; hook-scheduled roots after release succeed. Codec, effect-getter and accessor callbacks during finalise/account cannot read or write. Deletion with a running handler drains, then deletes; reads made by that handler succeed meanwhile; work opened during the drain causes a re-drain, three failures refuse GroupControlUnsettledError. After refusal the runtime owner can be created again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
|                                       | restart before proof                                | First entry of any kind per owner scope after restart runs barrier and marker check; resolve fallback runs the barrier, never a raw negative read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
|                                       | storage guard witnesses                             | Partial-loss spent reinstall at incarnation 1 refuses; unreadable source state with readable trust retires to a fresh incarnation, corrupt trust refuses; internally consistent lower-epoch state refuses with epoch regression.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|                                       | real database integration                           | Per provider, the D8 provider-evidence cases (a)-(g) with fault milestones, second-connection visibility, hook-queue and connection-identity assertions. SQLite, PostgreSQL, Expo (or explicit blocked reason) in 3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| control / 2,3                         | delayed own replay (r28 decision)                   | Competitor wins CAS at E, saved own message later appears under another publishID. The walker's competitor adoption with complete coverage settles `lost`; the later copy is past-epoch poison and skips. A coverage gap settles terminal `unknown`; never a halt or rebuild.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| | commit-once poison head | Positively classified other-epoch frames or refused handoffs leave `skipped` unset and retry identical payload/ID/handshake generation. Unreadable/unclassified poison, failed content authentication and failed own/foreign named-entry copies set coverage uncertainty and explicit `retryForbidden: false` unless already prohibited; identical saved bytes/ID may publish after hub recovery and restart. Only content-signature-verified foreign refusal of the commit itself prohibits retry, independently of blob failure. Older skipped rows without the distinction remain forbidden. No same-source rebuild. A real receiver processes the poison prefix then applies the saved commit and matches the candidate authenticator; extra pending proposal is omitted and missing referenced proposal refuses. |
|                                       | commit-once restart (ordinary lane)                 | reconstruct after built-save/mismatch and after hub acceptance. Saved bytes/candidate survive. Refresh expectedHead only; the walk, not a search, settles. No same-epoch build after deadline/outcome ack or from a second queued intent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| | epoch move/deadline (ordinary lane, r28i) | Settlement only in authenticated consumption or explicit host retirement/abandonment: own first-valid gives `landed` plus obligation; validated winner with complete coverage gives `lost`; skip at E before the winner, rejoin, self-removal, retirement or abandon gives terminal `unknown` with candidate and speculative Welcome deleted and obligations kept; `skipped` survives restart. An own copy behind a gap or unreadable-epoch skip installs the candidate, closes `unknown`, writes no obligation and never runs MLS receive processing. An own copy after `abandon()` skips with the marker kept; a later higher-epoch frame without a live build follows ordinary D1 recovery. Self-removal closes queued intents `rejected` (`reason: 'removed'`) and a rejoin record `unknown`; the terminal group deletes after acks and Welcome delivery or abandon of remaining obligations. Failed own copies set `skipped` and explicit `retryForbidden: false` unless already prohibited; the live build and identical retry survive restart. Authenticated foreign refusal of the commit itself remains forbidden. Local-input failure holds the cursor with capped backoff and retains the recovery backstop; automatic retirement of a live build still needs verified request-bound same-group GroupInfo at F > E plus bound confirmation/source revalidation. Deadline writes provisional `unknown` once (`reported`); ack then restart gives no second report. Later consumption or abandon replaces it under a fresh identity even after ack; repeated abandon writes nothing. Abandon leaves the spent marker: no same-source build until epoch change; a stale marker below the epoch does not block. After deadline an own occurrence installs once (`landed` or `unknown` by coverage). No retained row survives consumption; no same-epoch rebuild. |
|                                       | legacy migration (r28d)                             | One version-marked transaction per incarnation, idempotent across a restart before and after its commit. Every legacy Welcome row, committed or not, becomes an obligation with exact bytes and none is deleted with a build; a retained row proven by its applied row closes `landed`, terminal-incarnation intents `rejected`, others `unknown` under fresh IDs with provisional rows deleted; a current-epoch `built`/`accepted` stage becomes the live build with `head = searchFrom` (null is the empty prefix), `reported`, `acceptedAs`, and `skipped` unless the cursor equals `searchFrom` with no gap, hold or uncertainty; an ownerless current-source slot becomes the spent marker with no outcome; intents stay intents; the acceptance-unknown hold is removed and recovery state kept; a `main` CommitJournal entry reports `LostCommit` under `unknown` and releases `holdsLogSends`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|                                       | adoption/removal/resync                             | full-payload poison, moved, accepted-before-walk, refusal/holder evidence, exact-external-commit confirmation, revoke-hold/two-revoke and Welcome cases remain; source guard is incarnation/version. Replace obsolete checkpoint-halt/source-prefix assertions with detection-only notices and authenticated, attempt-scoped forkRecovery assertions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| safety / 2,3                          | host fork halt live/restart                         | Host reportFork/authenticator comparison co-writes halt/evidence/event and new producer provenance. Live peers latch before proof, including failed writes. Ack never clears halt. Matching app-report clearHold preserves evidence. Legacy/internal holds refuse clearing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| | hub-fault audit | Both past divergence branches, signed CAS losers, own-slot contradictions, tampering, junk, unknown versions and failed delivered own/foreign named-entry copies skip/diagnose. Cursor/coverage/retry distinction commit atomically; rollback changes none. Live build bytes/ID/candidate/deadline/speculative Welcome survive reconstruction; no durable hold/halt/strand, discard/rebuild or owed-work deletion arises from the fault. Forged ahead/head/gap claims after a copy skip grant no retirement authority. Host/local-storage invariant paths retain their contracts. |
| | own recognition and recovery progress | Re-encoded/blob-changed own no-entry commits recognise with the helper. Named entries use the receiver reference predicate on the frame's own blob, never the host resolver. Failed own copies atomically skip with `skipped` and explicit `retryForbidden: false` unless already prohibited, keep the build live and permit identical saved bytes/ID after restart. A later valid own occurrence installs the saved candidate and closes by coverage. Provider exceptions retain identity and local retry policy. Recovery recapture remains distinct from settlement. |
| | strand signals / detection limits | Ahead/gap/own-unmerged observations retain claimed confidence. Delivery claims alone neither persist a destructive strand nor retire a live build. Missing/identical applied history proves no fork. Victim-spoof rejection still requires own-signature validation. Host authenticator comparisons remain available. |
|                                       | retained recovery trust (r16 decision)              | State bytes unreadable, trust intact: request/authenticate/restore without GroupHandle and automatic resync. Unreadable envelope: recovery-unavailable, no automatic reconstruction, manual fresh invitation or admitted successor. Decoded missing/malformed spent data: spent-set-corrupt. Every installing transaction refreshes trust atomically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| | stranded automatic resync | Retention gaps/lost local MLS state with no safety hold use retained trust and authenticated GroupInfo. With a live build at E, inspection must verify request-bound member-signed same-group GroupInfo at F > E before automatic recovery may construct a candidate; only bound confirmation plus source revalidation then permits retirement. Wrong request/group/signature/trust, F <= E and same-number authenticator disagreement grant none. Withheld evidence retains saved work without a new delivery-derived hold/strand or hot loop. Remove+ExternalInit yields one matching fresh leaf and n+1 across restart, pre-reserving its application range. Unknown frame/header versions skip with upgrade-required diagnostics; existing legacy holds remain immutable. |
|                                       | stale GroupInfo (r19 decision)                      | Recapture signed applied state: later epoch with X's exact leaf means accepted -> settled. Adopt X only with known position/current-epoch bound confirmation; otherwise atomically preserve accepted-unadoptable X/floor/ledger and build fresh Y removing X's sole identity leaf. Delayed advanced reply, pruned occurrence and settled restart succeed. Wrong leaf/request/group refuse. Later leaf absent includes applied-then-removed and obeys admission/removal policy. Mutation-check leaf matching in Task 14b.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
|                                       | capture-head retry (r19 decision)                   | Search mismatch/gap/junk never strands X or decides discard. Fresh recapture keys remain separate. Equal epoch/authenticator means responder prefix lacks X; retry SAME bytes at authenticated head even if lower/inflated previously. Ordinary epoch floor refuses regression and survives settlement/discard/restart. Only bound forkRecovery grants its temporary effective-floor exception. Leaf present means accepted -> settled, adopting X only with bound confirmation; otherwise fresh leaf-replacing Y. Blob-derived negatives remain advisory through wire/replay/cache. Same-epoch lost-state recapture makes zero extra builds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                                       | manual recovery                                     | no automatic action while halted; chosen target/authorisation reopens across restart, validated resync switches once, refused attempt preserves halt. Already admitted successor permits source retirement without copying state or coordinating routing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| registry / 2                          | cold access/leases                                  | concurrent cold load validated before access. Lease reserve/restart/failed seal never reuse generation. Lapsed/removed/suspended/proposals defer reservation without blocking control.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|                                       | rotation/retention                                  | 500 bound, rejection/hold/resume, non-admin empty rotation, 1000 retention/window through every constructor/derive/recovery. Real/double forward-window parity. Ordinary adoption preserves sender/receive history, no evicted epoch resurrection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| handlers / 2                          | registration/adapters (r16/r19 decision)            | Public handler policy union + completion runner, legacy functions and mixed-policy refusal. Phase 2.2d supplies control-only registry access/GroupMLS/coordinator/continuation with incarnation/version guards. Full real registry crypto/open/leases and mixed-result application batch remain 2.3. Concrete TPorts and doubles never fabricate a lost-state handle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|                                       | all metadata paths                                  | original authenticated epoch/incarnation on durable/live/anycast/directed kinds. Spoofed wire/header metadata loses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ephemeral / 2                         | persists nothing                                    | warmed pre-reserved lease, requests/responses/signals and decrypt batches: zero outbox/pending/cursor rows and zero transaction calls. Exhausted lease rejects without a transaction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| outbox / 2,3                          | attempt/settlement                                  | all required topicIDs/identity/version round-trip. Inside-gate mismatch changes nothing. Test both proof paths and both queued orderings, attempt changes and version-only changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
|                                       | frozen result/restart                               | remove rollback then terminal/switch/restart reports original published occurrence/topicID once. Obligations co-delete, cannot change attempt, conflicting result rejects. Others fail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|                                       | retries/decoder                                     | same-process bytes/ID retry, active-incarnation restart new app ID, immutable entry, unknown removal, invalid UTF-8/version/type/procedure and side-row rollback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| lifted runtimes / 2                   | encryptor/buffer                                    | exact receive counts, ephemeral memory-only batches, sequential rotation keeps tunnel, committed membership/incarnation change closes once. Buffered wake, unsubscribe and retention reconnect/retry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| hub-conformance / 2,3                 | dedup scope/expiry                                  | same ID on two topics, rejected ID reusable, accepted ID original position, inclusive 365-day cutoff and no timestamp refresh. Memory and SQL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| integration / 2 then 3                | real HTTP smoke                                     | injected server DID, real MLS/registry, invite/join, durable send/epoch/proof, rotation, fork halt, stranded/manual resync and reconstruction. Providers replace memory in 3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| client/messaging / 4,5                | host integration                                    | device cleanup sweep, lifecycle, failure events/programmatic retry, transactional/idempotent MessageStore and receipt order.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| e2e / 6                               | every listed seam                                   | child SIGKILL evidence, including N-frame batch, transactional effect and incarnation switch. Reconstruction alone does not satisfy this row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Phase split

| Phase | Deliverable / gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2     | ClientState codec v2 and recovery candidate v3 codecs first. D8 owner queue/phases with memory as reference provider and the ownership-phases suite. Memory group coordinator, registry/incarnations/spent admission, detection-only in-band checkpoints/notices, non-terminal absence evidence, attempt-scoped forkRecovery, manual target recovery/current movement/successor tombstones, provenance-restricted clearHold, spent diagnosis and automatic stranded resync with authenticated captureHead, commit-once runner, fair adaptive batching and handler metadata/policies. DevicePersistence/package adapters, atomic Welcome burn, retained recovery trust and durable restore-work (r16 decision). Application leases/rotation, encrypted namespaces, durable settlements/events and mutation/side-row/fault fixtures. hub-client lifts and mls-rpc encryptor. Both contract suites on real MLS and doubles. Real HTTP smoke with injected DID. |
| 3     | rpc-store sqlite/postgres providers and Expo support or explicit blocked reason. Each provider implements D8 primitives and passes ownership-phases plus its real-database integration row. Group/device-package transaction scope, root discriminator and outcome-aware Hozon hooks (including deferred rollback-hook settlement) are prerequisites. Provider CAS/barrier/late-COMMIT/raw-encryption/side-row tests. SQLite device reconstruction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4     | client ownership, identity/Spec I, Spec H/hub policy, inventory/device cleanup, lifecycle and rotation scheduling.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 5     | messaging protocols/MessageStore, transactional or idempotent handlers, durable status events, programmatic failed-send retry and per-anchor receipts. Expo bundle CI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6     | Child-process driver and SIGKILL at every external/transaction seam.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Phase 2 creates no client/messaging/MessageStore/Hozon provider/child driver; use opaque side rows for handler/status conformance.
Run affected package/integration tests and `pnpm turbo run test:types`. Provider isolation/failure evidence belongs to phase 3.

## History

Historical entries describe superseded contracts. The current decisions and interfaces above govern conflicts.
- r1: adoptable journal, proof versus acknowledgement, application leases and coordinated status.
- r2: current-record CAS, retention/rotation, publication positions and mutation markers.
- r3: save-before-consume, recovery identity, separate Welcome obligations and deletion hooks.
- r4: review findings fed the control split. No separate r4 model remains normative.
- r5: P2a took control, adoption co-commit, source joinRef and unsettled-delete refusal.
- r6: lossless v2 codec, registry/access, metadata, retries, decoding and shared memory contracts.
- r7: completion barriers, identity-bound proof, recovery floor and owner-mediated persistence.
- r8: recovery codec, asynchronous access, terminal proof drain and outcome-aware hooks.
- r9: Welcome replay guard and host at-rest codec. Artifact digests were superseded.
- r10: spent authenticators, handshake reservations, anchor encryption and explicit Welcome ports.
- r11: handshake budget/window parity and physical mutation/side-row conformance.
- r12: local anchor ordinals, durable certified obligations and handshake baseline reader.
- r13: opened terminal drain, displaced control retirement, settlement revalidation and persisted topicID.

**r14 restructure (r14 decision).** Incarnations replace in-place recovery, lineage/floors/progress merges, displaced-row retirement and local anchor ordinals.
Commit-once removes handshake reservations/HWM/budgets/errors, baseline readers and staging-clone rules. Group transactions remove cross-store ordering/chat-only
coordination. Strongly consistent DS replaces automatic fork healing with halt/manual recovery. Spent authenticators, at-rest protection, publication obligations,
ambiguity/external seams and automatic non-fork stranded resync remain.
- r15 (r15 decision): authenticated GroupInfo captureHead, stale-epoch CAS refusal and proven identical-byte poison retry. Total-loss KeyPackage co-storage and explicit backup-restore resync/rotation/outbox failure. Unclassifiable encrypted prefix: discard on proven absence, request fresh GroupInfo.

- r16 (r16 decision): first-valid own adoption/Welcome guard; atomic cross-group ordinary-package burn and device cleanup; retained handle-independent recovery trust; DevicePersistence/restore-work wiring; pre-open/mixed crypto results; concrete adapters, handler registration/completion, metadata/retention and conformance.
- r17 (r17 decision): D8 single ownership model — per-device/per-group FIFO owner queues, typed entries (Transition, Combined, never-ambiguous Read), strict phases with phase-derived store capabilities, proof inside the retained entry with a conflicted outcome that fail-stops the factory, drain-before-slot deletion, post-effects account step, reentrancy refusal and per-provider primitives including absent-owner upsert barriers and quarantined-connection completion; ownership-phases conformance and real-database integration evidence for every provider. Replaces layered barrier/store-lock/gate/fence mechanisms after recurring deadlock, post-validation write and retained-read findings.
- r18 (r18 decision): D8 runtime-neutral — per-entry operation lock over each operation's whole read-modify-write with nesting forbidden by construction (replaces inline nested sequencing after sibling deadlocks and lost writes); fatal operation failures make the transition rollback-only; operations bound to entry, transaction and attempt; coordinator authority is a private writer object, not ambient context (after codec and accessor callbacks inherited it); internal bindings explicit; reentrancy detection needs no runtime async-context API, with an optional opaque-token `ownershipContext` port for detection after `await`. Retires `GroupMutationGate`.
- r19 (r19 decision): 2.2d captured recovery treats hub faults as non-delivery. Reply v2/candidate v3 preserve immutable origin and existing bound proof. Authenticated applied state settles acceptance. R0 adopts X only with bound confirmation, otherwise atomically preserves accepted-unadoptable X/floor/ledger and builds leaf-replacing Y. Regressing heads diagnose only. Portable non-building recapture and additive APIs precede serial lifecycle/activation stages. RecoveryCompletion settles source operations once. Local switch rollback never deletes accepted X. Existing local/historical safety and legacy-record stops remain. Fork detection stays deferred out-of-band; manual recovery/full registry crypto remain 2.2e/2.3.

- r20: on-demand refusals replace unbounded persisted negative rows. Legacy negatives remain advisory.
- r23 baseline: cumulative accepted/non-accepted settlement preserves obligations and the ordinary recovery epoch floor. Ordinary settled work omits secrets.
- r24 (2026-10-16, DN1-DN5, R1-R10 and A1-A4): detection-only in-band checkpoints replace out-of-band deferral and checkpoint halts.
  R1 explicitly departs from approved design Goal 3/section 4: not-member is non-terminal. R6 makes freshness lineage-relative.
  R8 preserves admission and clears diagnosis on install/head-only reconcile/re-anchor. R9 adds evidence counts/pendingReason and signed bounded comparison spans.
  T0-I1 amends R9 M-b: comparisonEpoch is a lower bound, using open split E or otherwise the oldest retained epoch.
  Responders clamp to their retained range and trim older frames, keeping those nearest F within 786432 bytes and always F in qualifying replies.
  Absence compares the newest common retained epoch in the received span. Fork-floor authority still requires E and all R2/R7 predicates.
  The no-open-notice 20/12 witness diagnoses absence without changing X/floor. T0-M1 confines invitation-only total loss to same-group admission, preserving successor retirement.
  R2 adds superseded-branch cumulative settlement and sealed exact-X history. R7 scopes effective E to bound Y and checks every capture's MLS transcript.
  R10 requires registry-owned lineage/private authority through real adapters. R5 requires real/double witnesses, restart rows and exhaustive host boundaries.
  DN1/R3 persist exact targets and notice overrides, restrict current moves, preserve holds and add successor retirement/tombstones.
  DN2/R4 gate public former-member disclosure by retained DID AND key, with bounded dedupe/budgets and distinct no-reply hints.
  DN3/R4 journal own IDs/other counts, expose partial coverage and unknown ancestry, and bound even unacknowledged evidence.
  DN4 adds producer provenance and app-report-only clearHold. DN5 separates envelope loss from spent corruption and defines projection precedence.
  A1 refuses retained-range holes. A2 uses the best-known split and permits earlier-moving notices to re-enable authorisation.
  A3 treats pending fork intents as active rejoin and atomically abandons them on manual authorisation. A4 discloses cleartext comparisonEpoch.
  Manual resync remains the exit after evidence expiry or unavailable coverage. Phase 2.3 application crypto and phase 3 providers stay excluded here.
- r25 (2026-10-17, plan 2.3a): locked epochs, duplicate/invalid-position results; poison only for authenticated malformed plaintext; envelope validation; durable-only registry routing; RegistryHandleAccess drops open; opaque positions with one comparator and occurrence matcher; exact CAS for every MLS state write with app metadata off the version clock; journal control-compatibility for own-commit adoption and build retry; private commit authoring only under a control-build permit; durable departing anchors preserved by every anchor-slot write; 64-frame bound; retained past epochs open; commit progress independent of app work; configurable epoch retention (default 4, cap 32); opened-record drain deferred to 2.3c.
- r26 (2026-10-18, plan 2.3b): reservation advances committed state with ownership transfer (no restore skip); installation pre-reserve; send copy limited by committed generation; narrowing send policy; byte-level seal/receive; serialized private receive and ephemeral consumed set; retirement drains live work; effective-next rotation-required admission, handoff tolerance, internal auto-rotation; MLSEncryptor lift.
- r27 (2026-10-22, draft, never committed): retained builds reconciled after epoch consumption by a historical search, with applied-window pinning, rejoin proof recheck and handoff-deferred deadlines. Two reviews found it untranscribable; superseded by r28 before landing.
- r28 (2026-10-22, plan 2.3b task 6b): epoch-scoped settlement. The walker is the only log reader that settles a build; the transaction consuming the source epoch settles it (own first-valid: `landed` plus Welcome obligation; validated winner with complete coverage: `lost`; anything else, including gap, rejoin, retirement and abandon: terminal `unknown` with candidate and speculative Welcome deleted). No retained set, control search port, acceptance-unknown hold, applied-window pinning or BuiltCommit.searchFrom. Deadline writes a provisional `unknown` from the clock; consumption replaces it under a fresh outcome identity. Proven obligations survive recovery, readmission, retirement, pruning, ack and build deletion; only delivery or `abandon()` ends them. Own first-valid proof against a different adopted commit is fork evidence with the obligation kept. Revoke hold released by consumption, retirement or abandon, never by a provisional `unknown`; release proves nothing about revocation. Keeps r27's no-rebuild/auto-rotation wording, unavailable-evidence rule and storage rollback/ambiguity rule.
- r28b (2026-10-22, after two reviews): `abandon()` leaves a durable spent-source marker; self-removal is consumption; `BuiltCommit.head` plus durable per-build `skipped` define coverage from the pre-state, branch-relative; fork clause deleted (post-consumption own copies are past-epoch diagnostics, conflicting local records halt); once-only `reported` mark and final outcome always under a fresh identity; closed/reported/owed/walker terms; revoke hold may last indefinitely on a motionless epoch; D5 CAS wording replaced by walker supersession; explicit P2a supersessions and switch-transaction closure (RecoveryCompletion writes only `reenact`); availability concession and migration paragraph.
- r28c (2026-10-22, after two re-reviews): own frames never go through MLS receive processing; every recognised own occurrence installs the saved candidate (complete coverage: `landed` plus obligation; incomplete coverage: terminal `unknown`, speculative Welcome deleted, no obligation, the stated availability concession); unavailable validation inputs hold the walk with the build live. `OwnOccurrence` with explicit coverage replaces `FirstValidCommit` on the adoption port. Own copy with no live build is a diagnostic skip keeping the spent marker; spent marker blocks only at its own epoch. Skip predicate counts unreadable epochs, same-fetch gaps recorded before adoption, build refused on `incomplete`. BuiltCommit carries opID/kind/revokes/enqueuedAt/deadline and the built intent leaves the FIFO; allowed mutations listed. `abandon()` follows the final-report rule; repeated abandon writes nothing. Auto-rotation re-evaluates admission after any closure. Self-removal closes unbuilt intents `rejected` and a rejoin record `unknown`. Migration rewritten as a total, restart-safe, idempotent mapping; `main` client-state codec v1/v3 carry-forward in D5.
- r28d (2026-10-22, after two re-reviews of r28c): own-frame inputs are local; local failure is hold-and-retry with capped backoff, then D1's unprocessable-gap resync as the backstop (retirement closes the build `unknown`, Welcome deleted). Identical retry only after a refused handoff with `skipped` unset; an altered own copy sets `skipped` and never retries. Every legacy Welcome row is an obligation; ownerless current-source slot maps to the spent marker (migration is its second writer); missing coverage evidence maps to `skipped`; terminal intents `rejected`; per-incarnation version mark; `main` CommitJournal entry reported as `LostCommit` under `unknown`. Merged codec: reads 1/2/3/4, writes 4, drop-absent-sender decode rule, v3 reservation rewrite with one extra handshake advance at the body's epoch/generation, reservation APIs retired; Model/D5 reconciled. Terminal-group deletion needs acks and no live Welcome obligations. Minors: received-commit application versus authentication-only processing, `'moved'`/stranded cursor on an own occurrence, `reason: 'removed'`, refused-stage rejoin, null `searchFrom`, post-deadline install wording, "spent" wording.
- r28e (2026-10-22, user decision on the codec, superseding r28d's merge contract): version 2 is the only client-state format on `main` 0.10.7 and phase 2: `u8 2 || u8 flags || [u64 epoch, u32 generation, u8 consumed if flags = 1] || u32 bodyLength || body || u32 refCount || refs`, no trailing bytes; reads and writes v2 only, v1/v3/v4/unknown throw; no v4, no v3 rewrite, no v1 decode rule, no client-state migration; the merge carries the identical codec and phase 2 adds the reservation fields to its v2 layout at merge.
- r28f (2026-10-22, redesign gap analysis): poison-head conformance row narrowed to D4 — identical retry only for a positively classified other-epoch frame or refused handoff with `skipped` unset; unreadable-epoch or source-epoch poison sets `skipped`, no retry.
- r28g (2026-10-22, user decision at the `main` merge): an imported `main` reservation at the current epoch makes the commit permit advance the handshake ratchet past its generation (consumed or not) before construction, then clears the field; other epochs are ignored. `main`'s reservation methods, paired build hooks and `HandshakeWindowError` stay retired.
- r28h (user decision 2026-10-23, fix round 1): separate coverage uncertainty (`skipped`) from identical retry prohibition (`retryForbidden`). New coverage-only skips persist explicit false and permit identical saved bytes/ID after recovery and restart. Older skipped rows without the distinction remain retry-forbidden, including schema-version-1 snapshots and legacy-migrated builds. Foreign refusal requires successful commit-content signature authentication. Sender-data-only identification and content-authentication failure supply coverage uncertainty alone. Authenticated refusals, failed own named-entry copies and applied consuming commits still forbid retry. Commit-once, deadlines and coverage-dependent settlement remain unchanged.
- r28i (2026-10-23, Q2-B and controller rulings R1-R2): failed delivered named-entry copies, own and foreign, are non-delivery and coverage uncertainty only. Atomically skip with explicit `retryForbidden: false` unless already prohibited; preserve live bytes/ID/candidate/deadline/speculative Welcome and permit identical retry. Only content-signature-verified foreign refusal of the commit itself and applied authenticated consumption supply retry prohibition; legacy absent-field defaults remain. Delivery gap/ahead/head claims cannot destructively strand or retire a live build. Automatic recovery retirement requires request-bound MLS-verified member-signed same-group GroupInfo at F > source E, then bound confirmed recovery and source revalidation. Genuine local failures keep their retry/backstop policy. Coverage-dependent terminal outcomes and the speculative-Welcome availability concession remain; independent obligations survive.
