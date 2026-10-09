---
'@kumiai/rpc-conformance': minor
---

Cover crash-safe control storage, adoption writes, speculative ratchet carry, durable recovery candidate restoration and explicit recovery keys across real implementations and strict doubles.

Breaking changes from 0.10:

- Remove `testCommitJournalConformance`, `ConformanceCommitJournal` and `ConformanceJournalEntry`.
  Replace them with `testControlStoreConformance` and its transactional host/store types.
- Remove `ConformanceCommitCursor` and the commit-cursor methods from `ConformanceAppOutbox`
  and `MemoryAppOutbox`; commit cursors are tested through the control-store suite instead.
- `ConformanceGroupMLS` now returns `{request, requestKey}` from `createRecoveryRequest` and
  takes an explicit `requestKey` in `applyRecovery`, `openSealedLedger` and `openRecoveryVerdict`.
  Implement `readRecoverySource` and `restoreRecovery`; process results require `applied`, and
  `ConformanceCommitContext.adoption` must co-commit with MLS state. Pending candidates require
  `serialize()` and `onAccepted(write)` with an adoption factory.
- `ConformanceMLSGroup` fixtures must supply `buildRotation`, `confirmationTag` and `pauseNextSave`
  for speculative identity, confirmation and adoption-persistence checks.
