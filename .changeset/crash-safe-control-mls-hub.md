---
'@kumiai/mls-hub': minor
---

Split Welcome opening from post-save consumption. Ordinary sources atomically delete packages and retain receipts; reusable last-resort sources write no receipt. Judge admission by authenticated epoch so a newer Welcome can re-admit a held group.

Breaking changes from 0.10:

- Remove `processWelcomeFromSources`, `ProcessWelcomeFromSourcesParams` and
  `ProcessWelcomeFromSourcesResult`. Use `openWelcome(sources, welcome)`, returning either
  `{joined, joinRef: {sourceID, ref}}` or `{alreadyJoined}`. Save the joined state and `joinRef`
  before consuming its source. The old `releaseError` result is removed; consumption is a separate
  post-save operation, and `sourceErrors` now lives on `joined`.
- `BundleSource` replaces `release` with `consume(ref, groupID)` and `receipt(ref)` and requires
  a stable, non-empty `sourceID` distinct from the other Welcome sources.
  `KeyPackagePoolParams` and `LastResortProvisionerParams` also require `sourceID`.
- Host implementations of `KeyPackagePoolStore` and `LastResortStore` must implement `consume`
  and `receipt`. Ordinary consumption atomically deletes the package and writes its durable
  receipt; last-resort consumption is a no-op and its receipt is always null. Pool/provisioner
  `release` remains for manual callers, but is no longer the post-join path.
