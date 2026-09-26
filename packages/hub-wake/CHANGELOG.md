# @kumiai/hub-wake

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
