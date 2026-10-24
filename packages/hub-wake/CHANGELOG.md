# @kumiai/hub-wake

## 0.12.0

### Minor Changes

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

## 0.10.0

### Minor Changes

- Ship in the 0.10 release band for acknowledged durable app-frame delivery. `@kumiai/rpc`
  adds opt-in at-least-once delivery of retained events, a pending-record port, handler frame
  identity, and retry and operator-drop behavior. `@kumiai/mls` adds staged decrypt and cleartext
  AAD reading; `@kumiai/mls-rpc` implements the atomic durable-open port. The conformance suite
  covers the new contract, and the remaining packages move together in the shared version band.

  **Breaking:** all app frames now use versioned AAD carrying authenticated log intent. 0.9 and
  0.10 peers cannot exchange app frames; a frame with the older bare-topic AAD is refused. Consumers
  implementing `GroupCrypto` must provide `frameAAD` and support the new `unwrap` options. Hosts opting in to
  durable delivery must atomically persist consumed-key state with each pending record, order
  handle saves, reject stale same-epoch writes, and avoid holding a database transaction while
  awaiting a peer or handle operation.

### Patch Changes

- Updated dependencies:
  - @kumiai/hub-protocol@0.10.0

## 0.9.0

### Minor Changes

- Version-band alignment. The twelve packages in this repo share one pre-1.0 version band (same minor), so a minor landing in any of them raises the whole group together (see `AGENTS.md`). This cycle's feature intents bump `mls`, `broadcast`, `hub-protocol`, `hub-client`, `rpc`, `mls-rpc`, and `rpc-conformance`; this intent carries the remaining band members to the same minor.

  Of these, `hub-server`, `mls-hub`, and `hub-conformance` migrated internal call sites and the reference `HubStore`/`HubClient` doubles to the new params-object signatures (no exported-surface change of their own); `hub-tunnel` and `hub-wake` carry no source change this cycle and rise solely to keep the band aligned.

### Patch Changes

- Updated dependencies:
  - @kumiai/hub-protocol@0.9.0

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
