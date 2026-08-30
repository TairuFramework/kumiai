# @kumiai/hub-conformance

## 0.8.0

### Minor Changes

- Align the shared pre-1.0 version band to 0.8.0. The twelve packages move as one minor band
  (AGENTS.md); the `topicID` schema narrowing (`@kumiai/hub-protocol`) raises the band, so the
  remaining packages take a no-op minor to keep every package on the same minor. No functional change
  in these packages.

### Patch Changes

- Updated dependencies:
  - @kumiai/hub-protocol@0.8.0

## 0.7.0

### Minor Changes

- wake notifications: sealed push pings for suspended devices

### Patch Changes

- Updated dependencies:
  - @kumiai/hub-protocol@0.7.0

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
  - @kumiai/hub-protocol@0.6.0

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

- Commit-lane replay handling, anycast suppression, the durable-ack relay, and peer disposal.

  **Breaking.**

  - `classifyCommit` takes a single `ClassifyCommitParams` object —
    `{ header, sequenceID, commitDigest, state }`. `CommitClassifierState.appliedByEpoch` is
    `ReadonlyMap<number, AppliedCommit>`. `AppliedCommit`, `ClassifyCommitParams` and
    `digestAppliedCommit` are exported.
  - `ProtocolSurface.to` returns `Promise<Client<Protocol>>`; it is now gated on peer readiness like
    `protocol()`'s other three methods.
  - `@kumiai/rpc`'s hand-copied `createGroupBusServer` is deleted. `@kumiai/broadcast`'s
    `createBroadcastResponder` is the single implementation; it renames `handlers` →
    `requestHandlers` and gains an optional `@sozai/event` `EventEmitter` and a dispose-aborted
    `AbortSignal` in the handler context.
  - `MailboxHubEvents` is `EventEmitter<{ status: MailboxHubEvent }>`. Use
    `hub.events.on('status', …)` in place of `hub.events.subscribe(…)`; the returned unsubscribe is
    unchanged. `HubBase.events` is `readonly`, and `MailboxHubEventListener` is removed.
  - `@kumiai/broadcast`'s `subscribe` callback gains an optional second argument carrying the ack.
    `@kumiai/hub-tunnel` gains `HubReceiveOptions` and an optional `receive` scope parameter
    (additive — a double declaring fewer parameters stays assignable).

  **Security — a replayed commit is no longer a fork.** The commit lane proxied "a different commit"
  with "a different sequenceID". A hub re-publishing a genuine commit frame verbatim and serving the
  copy first made every peer read the original as the losing side of a fork: a heal, a rejoin, an
  external commit, and an app-lane anchor rotation for every member, once per replay, for bytes
  already delivered. `appliedByEpoch` now records a digest of the applied commit's bytes and
  `classifyCommit` answers `history` on a match. Genuinely different commits at one epoch still fork
  and still heal, lower sequenceID winning; the change only ever produces fewer heals than before. Not
  a general defence against a hub that reorders or withholds — it removes the replay route. Both
  conformance suites gain the complementary floor, `a re-published payload under a fresh publishID
  never lands below the original`; a store failing it is not conformant.

  **Anycast suppression fires only on a successful reply.** Any observed reply, errors included,
  previously marked a request replied, so one fast *failing* responder suppressed every healthy one
  and the client timed out. `adaptBusHandlers` now validates bus-lane input against the protocol's
  declared JSON schemas — an invalid request rejects (which, per the fix, suppresses nobody) and an
  invalid event is dropped and logged. Live push and app-lane drain share the same validation.

  **The durable-acknowledgement relay is reconnected** between a peer's ack and the hub, and
  `@kumiai/hub-tunnel`'s transport now acks every frame its read pump handles, withholding only where
  the transport tears down first. Two visible consequences: mailbox entries that previously aged out
  unread are reclaimed, and a frame matching no listener and no sink is no longer acked, so it is
  redelivered after restart rather than silently dropped. `@kumiai/hub-conformance` gains opt-in
  `testAckConformance`, split into `testMailboxAckConformance` and `testLogAckConformance` so a
  subject with no readable log can take the redelivery clause alone.

  **A disposed `GroupPeer` refuses everything** — `dispatch`, `request`, `gather`, `to`, `commit`,
  `replay`, `recover`, `resync` — with `Peer is disposed`. Each previously failed its own way, `to()`
  handing back a live-looking `Client` over an aborted transport among them. `resync()` also now runs
  under the commit mutex, so a host calling it mid-commit waits rather than running two teardown/build
  cycles over one set of runtimes.

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
  - @kumiai/hub-protocol@0.5.0

## 0.4.0

### Minor Changes

- Adds `testLogHubConformance` and `testMailboxHubConformance` alongside the existing store suite,
  so the hub-tunnel and rpc doubles are held to the same contract as `createMemoryStore`.

  A double that answers where its real port refuses hides a production defect behind a green
  suite. The suite carries a compile-time tripwire in its callers: a reverse type assignment that
  fails the moment a contract grows a member the suite has never heard of.

### Patch Changes

- Updated dependencies:
  - @kumiai/hub-protocol@0.4.0

## 0.3.0

### Minor Changes

- New package: the `HubStore` conformance suite, extracted from `@kumiai/hub-protocol/conformance`
  so the protocol package carries no test-runner dependency. Hosts implementing `HubStore` import
  `testHubStoreConformance` from here; `vitest` is a peer dependency the host provides.

### Patch Changes

- Updated dependencies:
  - @kumiai/hub-protocol@0.3.0
