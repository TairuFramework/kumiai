---
'@kumiai/mls-rpc': minor
---

Co-commit incoming and own adoption control changes with MLS state, preserve ratchet progress, and restore durable recovery candidates using explicit recovery request keys. Confirmed rejoin adoption carries its control write.

Recovery restores its candidate and explicit request key from the durable rejoin record.
`PendingRecovery.onAccepted(write)` takes a required `AdoptionWriteFactory`; its `AdoptionWrite`
is persisted with MLS state.
Binding, lapse and floor refusals invalidate the binding and retry renewal within the same recovery
attempt and original deadline before reporting `renewal-required` when no usable binding is available.
