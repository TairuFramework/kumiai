---
'@kumiai/mls-rpc': minor
---

Co-commit incoming and own adoption control changes with MLS state, preserve ratchet progress, and restore durable recovery candidates using explicit recovery request keys. Confirmed rejoin adoption carries its control write.

Recovery restores its candidate and explicit request key from the durable rejoin record.
`PendingRecovery.onAccepted(write)` takes a required `AdoptionWriteFactory`; its `AdoptionWrite`
is persisted with MLS state.
Binding, lapse and floor refusals invalidate the binding and retry renewal within the same recovery
attempt and original deadline before reporting `renewal-required` when no usable binding is available.

Breaking changes from 0.10:

- Remove `createRecoveryPending` and `RecoveryPending`. Use `GroupMLS.applyRecovery` and
  `restoreRecovery(candidate, requestKey)` with the explicit key returned by `createRecoveryRequest`.
- Remove `PublishRevokeProofParams.options`: `publishRevokeProof({peer, mls, input})` now enqueues
  a durable operation. Hosts must route proof builds through `buildRevokeProofOperation({mls, op,
  options: {serializeJournal}})` and persist the candidate's ledger with its state.
- `SimpleHandleAccessParams.persist` now receives `(handle, write?: AdoptionWrite)`; co-commit
  supplied writes with MLS state, control and anchor. `HandleAccess.mutate` and `replace` accept
  an adoption factory; `replace` also takes `prepare(current)` for source checks and ratchet carry.
  Adoptions require persistence, including `PendingRecovery.onAccepted(write)`.
