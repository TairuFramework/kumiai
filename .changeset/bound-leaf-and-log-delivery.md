---
"@kumiai/mls": patch
"@kumiai/mls-rpc": patch
"@kumiai/rpc": patch
"@kumiai/rpc-conformance": patch
"@kumiai/hub-protocol": patch
"@kumiai/hub-server": patch
"@kumiai/hub-client": patch
"@kumiai/hub-tunnel": patch
"@kumiai/hub-conformance": patch
---

Ship bound-leaf lifecycle and durable epoch-change log delivery together as coordinated patches.
These patches contain breaking API and wire contracts for the single consumer, kubun.
The anchor version remains 1 and `HANDSHAKE_VERSION` remains 1.
Release the capability child-expiry attenuation patch in kokuin before kumiai.
Hub deployment precedes or accompanies peers. Rejoiners and responders ship together.
Older responders ignore the new rendezvous kinds and cannot confirm new rejoiners.
Every lifecycle peer must run the same release.

## Lifecycle API and wire contracts

- Genesis adds `GroupAnchor.controller`, `leafLifetime` and `trustedGrantLifetime`, with strict decoding and immutable values.
  Defaults are 86,400 and 2,592,000 seconds. Ceilings are 604,800 and 31,536,000 seconds.
- Bound credentials pin issuer and subject, verify without wall-clock consensus, and support one trusted-grant delegation link.
  Children cannot outlive parents. Fixed identity, tree time, lapse, registry agreement and generation floors gate every entry.
- Creation, key packages and external joins accept `ControllerBinding`. Lifecycle external joins cannot be floating.
  `Invite.recipientDID` binds consent and key packages. Lifecycle `createInvite` omits `permission` and accepts consumer `entries` without role grants.
- `kumiai.device` adds proven revoke suffixes against the recorded controller log, reset and clock.
  Lifecycle groups reject register, add, label, capability revokes and role entries. Ledger revocations are permanent and can cascade.
- `renewLeaf`, `removeLapsedLeaves`, `revokeWithProof`, `revocationOf` and adoption-only events expose the lifecycle.
  Helpers return speculative handles and absorb no pending proposals, including in standard groups. `confirmAdopted()` emits their control events once.
  Revocation events include `logPosition`, `reason` and `cascadedFrom`. Restore and Welcome project silently.
- `publishRevokeProof` runs one rebuilding lane commit with a log-send hold.
  Its fourth argument requires host-supplied `serializeJournal(derived)`, restoring MLS state AND derived ledger entries through `adoptJournalled`.
  Outcomes are committed, already-revoked, self-affected and not-provable. Hosts retry thrown lane failures.
- `HISTORY_HORIZON = 393,216` is fixed. A commit passes only when post<=horizon or post<=pre.
  Welcome/external revalidation has no absolute horizon check. The comparative commit gate is the only authority.
  Reset shortens prefixes but never removes ledger proofs. A full proof ledger needs a new group.
- Consumer ledger entries have only the whole-frame bound. `assertFrameFits` checks every RPC-owned final frame before journalling or publishing.
  Hosts publishing a Welcome through a hub preflight its final bytes inside `build()`, before returning `PendingCommit`.
  `FrameTooLargeError` journals and publishes nothing. Oversized whole-ledger replies can prevent joining and recovery.
- New errors include `LeafBindingError`, `LeafLapsedError`, `RevokeProofError`, `InviteRecipientMismatchError` and `FrameTooLargeError`.
  Binding reasons include issuer-mismatch, subject-mismatch, audience-mismatch, permission-denied, signature-invalid, confirmation-invalid, chain-depth, self-issued, child-outlives-parent, denied-issuer, lifetime-cap,
  generation-floor, identity-change, controller-mismatch, floating-refused and history-horizon.
  Proof reasons include no-rev, wrong-controller, not-authority-signed, generation-floor, too-large, detached, needs-reset,
  effects-mismatch and removes-mismatch. `CommitRejectedError` carries the recovery refusal reason. Every MLS throw while processing a commit is wrapped as `CommitRejectedError`.

## Delivery, recovery and host contracts

- `GroupPeerMLSParams` requires `AppOutbox` and host-configured `appOutboxLimit`.
  Log dispatch resolves at durable acceptance, preserving per-sender order and at-least-once delivery across epoch changes and restarts.
  `MAX_APP_ENTRY_BYTES = 524,288` bounds encoded plaintext. `PeerRemovedError`, `SendNotAdmissibleError`, `AppOutboxFullError` and `AppEntryTooLargeError` reject acceptance.
  Breaking: hosts implement durable `getCommitCursor()` and `putCommitCursor()` alongside entries, storing `{ position, epoch }`.
  Cursor writes follow durable MLS state. Startup discards epoch mismatches. Entry clearing preserves the cursor, and group deletion clears both.
  Reservations count at the cap. `lastAttempt` is prepared state, never publication evidence. Hosts encrypt plaintext and choose erasure policy.
- `HandleAccess.admission()` and `GroupMLS.sendAdmission()` synchronously publish the same epoch-paired snapshot as `epoch()`, without acquiring a handle lock.
  Adoption callbacks read the pre-adoption snapshot. A dispatch awaited there can persist, but outbox put must not await that adoption transaction.
  Lapse after enqueue holds entries until renewal or removal. `onAppOutboxCleared` reports removal with the cleared sequences.
- `AnchorStore` stores one `{ anchor, pending }` slot. Pending includes `epochBefore`, target `epochAfter`, `rosterBefore`, `forced` and advance digest `advance`.
  Each record spans one advance and resolves before another. An ambiguous record permits only the same advance's retry.
  `MissingLedgerEntriesError` at port epoch == epochBefore is known-unlanded: clear the rotation record, keep the frame's poison handling.
  Startup repairs landed anchors. A lost target secret requires confirmed forced recovery before delivery or another advance.
- `GroupMLSParams.recoveryBinding`, `GroupMLS.prepareRecovery` and `applyRecovery`'s widened `PendingRecovery | { renewalRequired: true } | null` result support binding renewal.
  Lifecycle GroupInfo replies include the whole authenticated ledger. The known registry unites revocations and takes maximum floors.
- `PendingRecovery` adds target `epoch`, `confirmationKey`, `judgeVerdict`, idempotent `onAccepted` and `markBindingUnusable()`.
  The adapter's unusable-binding set is in memory, identity-keyed and bounded to 16 entries. Ratchets do not clear it.
  Restart permits one extra refused attempt. No timer retries a held binding or policy refusal.
- `GroupMLS` adds `verifyRecoveryRequest`, `confirmationKey`, `sealRecoveryVerdict` and `openRecoveryVerdict`.
  `ProcessCommitResult.refusal` and exported `RecoveryRefusalReason` propagate binding, lapse, floor, policy and invalid.
  `RecoveryFailureReason` adds renewal-required, refused with refusal/responder, and unconfirmed with advisory verdicts.
  Binding/lapse/floor wait for new binding and host `recover()`, or a ratchet. Policy/invalid wait for host `recover()`.
  Unconfirmed attempts keep entries and retry on backoff. Only counted confirmation authorises adoption.
- Rendezvous adds `recoveryConfirmRequest { requestID, request, position, commitDigest }` and `recoveryVerdict { requestID, sealed }` codecs.
  Signed HPKE verdicts bind the full tuple under a separate domain. Confirmation adds target epoch and HMAC tag.
  Lifecycle verdicts and GroupInfo attestations gate signers against bound leaves, known revocations/floors and expiry with 300 seconds' allowance.
  An unknown revocation can still allow stale confirmation until leaf expiry, or the revoked trusted grant's expiry, plus that allowance.
  A removed receiver can accept an authorised removal whose path survivors reject. Divergent policies or forked hub views remain residuals.
- `GroupPeer.commit` adds `holdLogSends`. `JournalEntry.holdsLogSends` persists the hold unchanged across restart.
  The hold blocks even prepared-but-unsubmitted log frames and waits for already submitted publications before committing.
  Ephemeral and directed traffic remain outside the hold.
- One live designated-hub peer owns a group's outbox, journal and anchor store, carrying all log sends, commits, recovery and revoke runs.
  Handover calls `dispose()`, awaits `drained()`, then starts the replacement. Never await drained inside that peer's counted callbacks or port calls.
  Drain accounts for abandoned host promises and returned callbacks, excluding parked hub and runtime work.
  Acceptance effects must recover from current durable state. Persisted notices can be lost on crash/dispose, so hosts read stores at startup.
- Ephemeral delivery requires acknowledged receiver subscription, listener registration within the acknowledgement TTL, and the receiver still holding the frame epoch.
  Other ephemeral traffic remains best-effort. Log handlers must be completion-safe after partial failures, beyond merely performing upserts.

## Hub fetch and conformance

Fetch results require `gap: boolean` in every store, client, tunnel and wire schema.
Gap, head and messages share one snapshot. Head and the per-topic removal watermark are monotonic stored state.
Gap covers removed log frames after the exclusive cursor, before the first returned frame, or through head on an empty page.
Without a cursor it covers any log removal. Mailbox removal and removal of only the cursor frame do not count.
Sparse `oldest` cannot prove coverage. A missing/non-boolean gap fails the fetch and retries, never certifies.
Log purge is prefix-only per topic by position, even under a backward clock. Mailbox expiry stays independent.
Depth eviction retains head and cannot produce an empty-page gap below head.
`StrandKind` adds retention-gap. `AppWindowPruned.oldest: string | null` reports every cursor-bearing fetch's gap, including empty windows.
Notices deduplicate per topic and cursor in memory and can repeat after restart.
Both conformance suite families run against real implementations and doubles, including snapshot and backward-clock cases.

## Kubun handoff

Adopt these contracts in one coordinated bump, without changing kumiai's anchor or handshake versions.

- Migrate the SQL hub store with per-topic `removed_through`, atomically raised with log deletions and read with head/page in one snapshot.
  Implement prefix-only per-topic purge by position, stopping at the first retained log frame under a backward clock.
  Validate both SQLite and PostgreSQL. Forward required gap through the client adapter and support nullable oldest notices.
- Add the encrypted outbox migration, configured cap, durable atomic writes, and group deletion/leave clearing and erasure policy.
  Persist journal `holdsLogSends` and the complete anchor rotation slot, including target epoch and digest.
- Supply `recoveryBinding` without waiting for the user. Publish lock-free HandleAccess admission alongside epoch.
  Handle renewal-required/refused holds, unconfirmed retries, retention-gap strands, dispatch errors and removal notices.
- Run one peer per group on the designated commit hub. Treat other hubs as failover candidates with dispose/drained handover.
  Make handlers completion-safe and acceptance effects recoverable from current handle state, including interrupted settlement.
- Supply `serializeJournal` for revoke proofs. Kubun wraps settlement fields in its own journal blob alongside MLS state and derived ledger entries.
  Fan proofs across the controller's groups and retry lane failures on reconnect, respecting self-affected, detached, needs-reset and too-large outcomes.
- Run the I6 reproduction (`i6-epoch-change-broadcast.test.ts`) and SQLite/PostgreSQL suites after that coordinated bump.
  Deploy the hub before or alongside peers, and ship rejoiners and responders together.

Persistent contracts: bound-leaf lifecycle, app lane, lanes and retention, group protocols, sealing and reserved namespaces.
This intent records readiness only. Version consumption, publishing, deployment and downstream changes remain separate work.
