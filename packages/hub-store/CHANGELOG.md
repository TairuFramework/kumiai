# @kumiai/hub-store

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

## 0.10.1

### Patch Changes

- Add the durable Hozon-backed hub store.
