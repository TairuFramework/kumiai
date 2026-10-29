# @kumiai/hub-http

## 0.12.0

### Minor Changes

- Hub host seams and a purge race fix. Moves to `@hozon/db` 0.5, `@hozon/provider` 0.3 and `@teikyo` 0.4, whose minors are breaking, so the hub packages take a minor bump with them.

  - `hub-store`: `purge` no longer deletes a log frame published while the sweep runs. Log removal is bounded by the head read under the topic lock, and a topic with no head yet purges mailbox frames only. Previously, on Postgres, the first log publish to a mailbox-only topic could be deleted if it committed mid-sweep.
  - `hub-store`: the SQL store adds `purgeSubscriptions({ olderThan })`, which deletes subscriptions idle for longer than the window and returns exactly the rows it deleted. `createHubStore` and `getHubStore` return `SQLHubStore` (`HubStore & HubSubscriptionReaper`).
  - `hub-server`: the purge timer also reaps idle subscriptions when the store provides `purgeSubscriptions`. `HubPurgeOptions.subscriptionOlderThan` defaults to 90 days and is clamped to at least `olderThan`. Failures report through `onStoreError` with `method: 'purgeSubscriptions'`.
  - `hub-conformance`: new `testHubStorePurgeRaceConformance` export, for stores that run purge concurrently with publishes.
  - `hub-http`: `createHubServer` accepts `plugins`, composed after the hub plugin, so a host can serve its own routes beside the hub.

- Introduce the breaking 0.12 management tier across all fourteen packages. Lifecycle groups require registry-seeding controller logs and support membership and member-rooted capability bindings. ControllerLog proofs carry exact denial, removal and reset effects, with survivor grants and retained removal evidence. Effective-member quorum time, admission-only epoch caps and recovery knowledge retention replace the previous lifecycle contracts. Wire shapes, persisted projections, adapters and conformance doubles follow the new surface.

  Recheck lifecycle knowledge atomically when adopting recovery candidates, including adoption retries.

  Reject log events authored by tombstoned member incarnations after stale root settlements.

  Reject unauthenticated no-op log updates and bound replay and effect-claim verification work.

  Verify lifecycle envelopes in order so renewal and attestation can share a commit.

  Cascade chained leaves when their required holder grant loses member authority.

  Use one effective-member clock predicate and skip attestations beyond the author’s lease.

  `HandleAccess.replace(next, guard)` requires a guard that implementations run on the live handle under the replacement lock. New `retainsKnownEffects` and `guardedReplace`; recovery adoption and revoke replace through them, and hosts adopt authored commits through `guardedReplace`.

### Patch Changes

- Updated dependencies:
  - @kumiai/hub-protocol@0.12.0
  - @kumiai/hub-server@0.12.0
  - @kumiai/hub-store@0.12.0

## 0.11.0

### Minor Changes

- Align the remaining thirteen packages with kumiai's 0.11 version band.
  All fourteen packages share one pre-1.0 minor band, so the MLS dependency migration raises the whole group together.

  `@kumiai/mls-rpc` and `@kumiai/mls-hub` inherit the `@kumiai/mls` behaviour change.

  - `broadcast` and `hub-protocol` adopt `@enkaku/*` 0.22.1.
  - `hub-client`, `hub-server`, `hub-store`, `hub-tunnel`, `mls-hub` and `rpc` adopt `@enkaku/*` 0.22.1 and `@kokuin/token` 0.6.1.
  - `mls-rpc` adopts `@kokuin/token` 0.6.1.
  - `hub-server` also adopts `@kokuin/capability` 0.5.1.
  - `hub-http` adopts `@enkaku/*` 0.22.1, `@kokuin/token` 0.6.1 and `@kokuin/capability` 0.5.1.
  - `hub-http` also adopts `@teikyo/{access,enkaku,hozon}` 0.3.0, `@teikyo/rate-limit` 0.2.0 and `@sozai/http-server` 0.2.0.
  - `hub-http` moves to `@hozon/provider` 0.2.0 and `@hozon/db` 0.4.0 through its HTTP storage dependencies. The provider override is removed.
  - `hub-store` adopts `@hozon/db` 0.4.0 and `@hozon/{adapter,node-sqlite,postgres}` 0.2.0.

  These dependency moves include test dependencies where applicable.
  `hub-conformance`, `hub-wake` and `rpc-conformance` rise solely to keep the band aligned.

### Patch Changes

- Updated dependencies:
  - @kumiai/hub-protocol@0.11.0
  - @kumiai/hub-server@0.11.0
  - @kumiai/hub-store@0.11.0

## 0.10.1

### Patch Changes

- Add the production HTTP hosting package for Kumiai hubs.
