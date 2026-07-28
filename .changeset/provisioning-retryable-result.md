---
'@kumiai/mls-hub': minor
---

`KeyPackagePool.ensureStocked()` and `LastResortProvisioner.ensureProvisioned()` now return an
`AsyncResult` from `@sozai/result` rather than a bare promise. A hub that cannot be reached, or that
answers something which clears on its own (a key-package quota), is returned as a
`HubRetryableError` for the caller to retry later; a settled refusal — authorization denied, an
invalid payload, an oversized batch — throws a `HubRefusedError` carrying its wire code and the
stage it failed at.

Both were previously all-or-nothing throws, and `ensureProvisioned()` in particular could fail an
app's startup over a transient outage during a call that used to be entirely local. Pruning now runs
on every path, including the failure paths.

Migration: read `.value` where the returned value was used directly
(`await pool.ensureStocked().value`), or branch on `result.isError()` to carry on through an outage.
