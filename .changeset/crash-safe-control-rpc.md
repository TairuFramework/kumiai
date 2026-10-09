---
'@kumiai/rpc': minor
---

Replace the single commit slot with durable FIFO operations, outcomes, Welcome obligations, commit rows, external responses and cursor. Persist rejoin records and explicit recovery keys, replay accepted work, retain fork evidence and reset old-branch control atomically on Welcome re-admission while keeping outcomes and obligations.

Recovery resumes a durable rejoin record containing the exact payload, candidate and request key.
Confirmed adoption co-commits the required `AdoptionWrite` with MLS state. Binding, lapse and floor
refusals retry renewal within the same recovery attempt and original deadline; only unavailable
usable bindings end as `renewal-required`.
