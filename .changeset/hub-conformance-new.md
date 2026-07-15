---
"@kumiai/hub-conformance": minor
---

New package: the `HubStore` conformance suite, extracted from `@kumiai/hub-protocol/conformance` so the protocol package carries no test-runner dependency. Hosts implementing `HubStore` import `testHubStoreConformance` from here; `vitest` is a peer dependency the host provides.
