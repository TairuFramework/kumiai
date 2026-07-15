# @kumiai/hub-conformance

## 0.3.0

### Minor Changes

- 70634ac: New package: the `HubStore` conformance suite, extracted from `@kumiai/hub-protocol/conformance` so the protocol package carries no test-runner dependency. Hosts implementing `HubStore` import `testHubStoreConformance` from here; `vitest` is a peer dependency the host provides.

### Patch Changes

- Updated dependencies [70634ac]
  - @kumiai/hub-protocol@0.3.0
