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
