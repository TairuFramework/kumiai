# @kumiai/mls-hub

## 0.6.0

### Minor Changes

- **Breaking (`@kumiai/mls`):** `GroupOptions.cache`, `GroupOptions.resolver`, the matching
  `GroupHandle` params and getters, and the exported `populateCacheFromCredential` are gone. Nothing
  in the package ever read or wrote either one, so a consumer passing a cache was getting a
  passthrough that would report a miss for a document it had been told would be there.

  `GroupMember` now carries `longForm`, the resolvable form of `id` — the leaf's long form for
  did:peer:4, `id` itself for did:key — and `GroupHandle.findMemberLongForm(id)` looks it up by
  either form. That is what a consumer needing a member's DID document should use: it reads the
  signed leaf rather than an unsigned copy beside it.

  The rest of the band takes the minor because all eleven packages share one pre-1.0 version band.

### Patch Changes

- Updated dependencies:
  - @kumiai/hub-client@0.6.0
  - @kumiai/hub-protocol@0.6.0
  - @kumiai/mls@0.6.0

## 0.5.0

### Minor Changes

- Key-package provisioning: last-resort slot, pool replenishment, and drain defence.

  **Security.** An authorized attacker within quota could drain a victim's key-package pool, after
  which the victim could not be added to any group until they re-uploaded. Closed on four fronts: a
  per-DID last-resort slot that is never consumed and sits outside the storage cap; per-DID caps
  (`maxKeyPackagesPerDID` 100, `maxSubscriptionsPerDID` 1000) that reject rather than evict; a
  per-target consumption quota (`maxPerTargetConsumed`, 60/window) so minting throwaway requester DIDs
  no longer amplifies a drain; and automatic provisioning in the new `@kumiai/mls-hub`, without which
  no DID had a slot at all.

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
  - `@kumiai/mls-hub`'s pool and last-resort records carry `kind: 'ordinary'` or `kind: 'last-resort'`.
    `KeyPackagePoolStore` and `LastResortStore` were structurally assignable, so a host wiring one
    store to both got no diagnostic on the wrong half — under which a single-use ordinary package
    could be installed in the hub's reusable last-resort slot. The discriminant makes them mutually
    unassignable, and both callers re-check `kind` on every read since a store adapter rebuilding
    records from its own columns can drop the field where no compiler sees it. **A store MUST persist
    `kind` and return it unchanged.**

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

- The group moves to the 0.5 band. Every publishable package shares one meaningful version — the minor
  while pre-1.0, the major after. Trailing segments still diverge freely: a package taking a patch
  release on its own does not move anyone else.

  `@kumiai/mls-hub` publishes for the first time in this release, at the band version.

  **Breaking.** Two dead exports removed while the band break makes it cheap, both unreachable in
  practice:

  - `@kumiai/mls` no longer exports the `GroupSyncScope` type — referenced by nothing, here or in any
    consumer.
  - `HubClient` no longer exposes the `rawClient` getter. `HubClient` now has one method per
    `HubProtocol` procedure, and a caller needing the underlying `Client<HubProtocol>` already holds
    it — `HubClientParams` takes it in.

### Patch Changes

- Updated dependencies:
  - @kumiai/hub-client@0.5.0
  - @kumiai/hub-protocol@0.5.0
  - @kumiai/mls@0.5.0
