---
"@kumiai/hub-protocol": minor
"@kumiai/hub-client": minor
---

Convert every remaining positional `HubStore` and `HubClient` method to a single named params object, and make `HubClient.publish` accept raw bytes.

**Breaking (`@kumiai/hub-protocol`):** `HubStore`'s seven positional methods — `unsubscribe`, `getSubscribers`, `storeKeyPackage`, `fetchKeyPackages`, `countKeyPackages`, `storeLastResortKeyPackage`, `fetchLastResortKeyPackage` — now take a single params object each (`{ subscriberDID, topicID }`, `{ topicID }`, `{ ownerDID, keyPackage, notAfter? }`, `{ ownerDID, count? }`, `{ ownerDID }`, `{ ownerDID, keyPackage }`, `{ ownerDID }` respectively), matching every other `HubStore` method. Every implementor and conformance double must migrate. Pure signature reshape, no behavioral or wire change.

**Breaking (`@kumiai/hub-client`):** `HubClient`'s five positional methods — `subscribe`, `unsubscribe`, `uploadKeyPackages`, `uploadLastResortKeyPackage`, `fetchKeyPackages` — now take a single params object each; `SubscribeOptions` is folded into `SubscribeParams`. `HubClient.publish` now accepts `payload: Uint8Array` instead of a pre-base64 string, and encodes it internally with standard Base64 (`toB64`) before sending — on-wire bytes are unchanged. Every caller must migrate.
