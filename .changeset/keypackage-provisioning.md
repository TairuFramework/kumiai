---
'@kumiai/hub-client': minor
'@kumiai/hub-conformance': minor
'@kumiai/hub-protocol': minor
'@kumiai/hub-server': minor
'@kumiai/mls-hub': minor
'@kumiai/mls': minor
'@kumiai/rpc': minor
---

Key-package provisioning: last-resort slot, pool replenishment, and drain defence.

**Security.** An authorized attacker within quota could drain a victim's key-package pool, after
which the victim could not be added to any group until they re-uploaded. Closed on four fronts: a
per-DID last-resort slot that is never consumed and sits outside the storage cap; per-DID caps
(`maxKeyPackagesPerDID` 100, `maxSubscriptionsPerDID` 1000) that reject rather than evict; a
per-target consumption quota (`maxPerTargetConsumed`, 60/window) so minting throwaway requester DIDs
no longer amplifies a drain; and automatic provisioning in the new `@kumiai/mls-hub`, without which
no DID had a slot at all.

A fetch previously ran the pool read and the top-up read in one `try`. The pool read is destructive,
so a throw from the top-up discarded the packages it had just spliced out — and a store without the
slot threw exactly there, silently draining every target. The reads are now split.

`@kumiai/hub-conformance` gains a clause that one owner's last-resort package is never served for
another. **An existing store may now fail it**: every other clause exercises a single DID, so a read
missing `AND owner = ?` passed them all. A fetch for BOB returning ALICE's package Welcomes ALICE,
who derives the epoch secrets, while the ledger grants the role to BOB.

**Breaking.**

- `HubStore.countKeyPackages(ownerDID)` is a **new required method**. `storeKeyPackage` takes an
  optional `notAfter`; an expired entry must be neither served, counted, nor charged against the cap.
- `KeyPackagePool.ensureStocked()` and `LastResortProvisioner.ensureProvisioned()` return an
  `AsyncResult` from `@sozai/result`. Read `.value`, or branch on `result.isError()` to carry on
  through an outage. A transient condition returns `HubRetryableError`; a settled refusal throws
  `HubRefusedError` with its wire code.

**Added.** `@kumiai/mls`: `createLastResortKeyPackageBundle` (extension `0x000A`, explicit 90-day
lifetime — ts-mls's ~15-day default made the slot read healthy while every join through it failed),
`LAST_RESORT_LIFETIME_DAYS`, `encodeKeyPackage`/`decodeKeyPackage` and the private-half equivalents,
`keyPackageRef`. `@kumiai/mls-hub`: `createLastResortProvisioner`, `createKeyPackagePool`,
`processWelcomeFromSources`. `@kumiai/hub-protocol`: `hub/v1/keypackage/status` (caller's own depth
only, takes no `did`), a `lastResort` upload flag, and four coded errors —
`HUB_AUTHORIZATION_DENIED`, `HUB_KEYPACKAGE_QUOTA`, `HUB_SUBSCRIPTION_QUOTA`,
`HUB_KEYPACKAGE_FETCH_LIMIT`. `@kumiai/hub-client`: `uploadLastResortKeyPackage`.

**Host obligations**, silent if missed: retain a last-resort bundle's `privatePackage` across a
Welcome, and re-upload before its lifetime elapses. The `LastResortStore` port holds secret key
material and MUST scope every method by owner DID.
