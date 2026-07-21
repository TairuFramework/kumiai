# @kumiai/hub-conformance

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
