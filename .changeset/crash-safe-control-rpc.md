---
'@kumiai/rpc': minor
---

Replace the single commit slot with durable FIFO operations, outcomes, Welcome obligations, commit rows, external responses and cursor. Persist rejoin records and explicit recovery keys, replay accepted work, retain fork evidence and reset old-branch control atomically on Welcome re-admission while keeping outcomes and obligations.

Recovery resumes a durable rejoin record containing the exact payload, candidate and request key.
Confirmed adoption co-commits the required `AdoptionWrite` with MLS state. Binding, lapse and floor
refusals retry renewal within the same recovery attempt and original deadline; only unavailable
usable bindings end as `renewal-required`.

Recovery failures now distinguish `invalidated` source re-checks from `unconfirmed` attempts.
Invalidations include `blockingPosition` and `anchorRecovery` so hosts can identify anchor-gated
livelock. Retry behaviour is unchanged. Document authenticated Welcome re-admission as manual repair.

Verify returned commit positions against the retained payload before adoption. Search absence requires
coverage through the reported head. Concurrent replay preserves adopted rejoins through durable
reenact settlement. Refresh re-emits durable outcomes once per peer instance, including after anchor
repair failures. Committed intents remain scheduled when their post-write refresh fails.

Breaking changes from 0.10:

- Replace `commit(build, {holdLogSends})` with `commit(OperationRequest)`, returning `{position}`.
  Submit durable intents with `enqueue`, read `outcomes`, and acknowledge with `ack`.
  `replay()` returns only optional `reenact`; `LaneResult` and its `lost` collection are removed.
  A non-landed outcome now rejects the commit wait with `OperationOutcomeError` carrying the
  durable outcome; restart drops the wait while preserving the operation.
- Remove `CommitJournal`, `CommitKind`, `JournalEntry`, `JournalEpochError`, `LostCommit` and
  `PendingCommit` exports. Replace peer params `journal` and `adoptJournalled` with `control`,
  `build(op)`, `adopt(journal, expected, write)` and `deliverWelcome`. Hosts must co-commit the
  supplied `AdoptionWrite` with MLS state and the matching anchor landed mark. Permanent build
  refusals throw `OperationRejectedError`; ordinary errors retain the intent for retry.
- Remove `commitDeadlineMs`; use `operationTimeoutMs`, measured from durable enqueue time.
- Remove `AppOutbox.getCommitCursor` and `putCommitCursor`. `CommitCursor` now belongs to
  `ControlStore` and uses branded log positions with optional fork evidence. `AppliedCommit`
  now requires `epoch`, `payloadDigest`, `opID` and `removed` as well as `digest` and `sequenceID`.
- `GroupMLS.createRecoveryRequest` returns `{request, requestKey}`. `applyRecovery`,
  `openSealedLedger` and `openRecoveryVerdict` require that explicit `requestKey`. Implement
  `readRecoverySource` and `restoreRecovery`; `PendingRecovery` requires `serialize()` and
  `onAccepted(write)` with an adoption factory. `processCommit` must return `applied` separately
  from `advanced` and persist `CommitContext.adoption` with the staged MLS state.
