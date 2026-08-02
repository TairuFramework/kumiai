# @kumiai/hub-protocol

## 0.5.0

### Minor Changes

- Exactly-once ordered push delivery, and every store failure either coded on the wire or reported.

  **Breaking.** `HubStoreErrorEvent` is a discriminated union on `method` rather than a flat
  `{ method; did?; error }`. Each variant carries the subject its site has — `did` for `ack` and
  `fetchLastResortKeyPackage`, `topicID` for the new `getSubscribers`, neither for `purge`. A hook
  reading `event.did` unconditionally must narrow on `event.method` first.

  `hub/v1/receive` now buffers live pushes during the backlog drain and flushes them deduped before the
  channel goes live, so a frame published mid-drain is neither delivered twice nor out of order. All
  writes serialize through a bounded queue — over `receiveBufferLimit` (new `CreateHandlersParams`
  field, `DEFAULT_RECEIVE_BUFFER_LIMIT` 256) or on a write rejection the channel tears down and frames
  stay pending for redelivery. A `store.ack` failure no longer closes the channel, and an
  already-aborted receive signal runs cleanup instead of leaking.

  `createHandlers` and `createHub` take `onStoreError`, called at the four sites where the hub
  deliberately does not fail the request: the last-resort top-up read, an ack, the scheduled purge, and
  a failed subscriber read during publish fan-out. Those swallows are correct and unchanged — failing
  the publish would lose the live push permanently — but they are no longer silent. Unwired, they
  report through `@sozai/log` under `['kumiai', 'hub-server']`.

  Store failures on `hub/v1/unsubscribe` and the key-package fetch path now cross the wire with their
  hub code instead of arriving indistinguishable from a transport failure. On the spent-budget fallback
  the store error deliberately does not replace the client's retryable `HUB_KEYPACKAGE_FETCH_LIMIT`; it
  is attached as `cause`. `@kumiai/hub-protocol` gains `HUB_INVALID_PAYLOAD` / `InvalidPayloadError`
  for a malformed base64 publish payload.

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

## 0.4.0

### Minor Changes

- All seven procedures move to `hub/v1/*`: `hub/publish` -> `hub/v1/publish`, and the same for
  `subscribe`, `unsubscribe`, `topic/fetch`, `receive`, `keypackage/upload` and
  `keypackage/fetch`. The first real revision of any of them is then `hub/v1/publish` rather than
  an irregular `hub/publish/v2` with an unmarked predecessor.

  Wire-breaking both ways: deploy the hub and every `@kumiai/hub-client` consumer together.
  `@kumiai/hub-tunnel` names no procedure directly and is unaffected.

- `StoredMessage.logPosition` — the place a log-class frame occupies in its topic's log, carried
  on the push as well as the pull. A delivery position and a log position are different sequences:
  a delivery position runs across all of a recipient's subscribed topics and skips its own frames.
  Without this field a live push could not advance a durable read position at all. Absent on
  mailbox frames, which have no place in any log — read the absence, not a falsy value.

## 0.3.0

### Minor Changes

- BREAKING: the `HubStore` contract gains retention classes and a stored head.

  - `PublishParams` gains `retain: 'log' | 'mailbox'` (default `mailbox`), `expectedHead` and
    `publishID`; `publish` returns `{ sequenceID, deduped }` and MUST NOT re-deliver a deduped
    publish.
  - `subscribe` takes a `SubscribeParams` object; stores must implement `fetchTopic` (serving a
    topic's log-class frames, in order, to a cursor) and `trim`.
  - `head` is stored state supporting compare-and-set, not a projection of the log; `trim` and
    depth bounds are log-class-only. The conformance suite — the contract a host implements — is
    the deliverable, now 24 clauses.
  - The `./conformance` subpath export is **removed** and the `vitest` peer dependency dropped;
    the suite now ships as the standalone `@kumiai/hub-conformance` package.
