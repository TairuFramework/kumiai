# @kumiai/hub-wake

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
