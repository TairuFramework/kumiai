---
"@kumiai/hub-protocol": minor
"@kumiai/hub-store": minor
"@kumiai/hub-server": minor
"@kumiai/hub-http": minor
---

Add optional publish attribution, invocation hooks and SQL occupancy reporting for relay accounting.
Attribution uses `{ account, actor, via: 'direct' | 'delegated' | 'group' }`.
The default is direct attribution to the authenticated sender. Only a verified delegation yields delegated attribution.

Breaking: custom `HubStore` implementations must return required `PublishResult.outcome` and `storedBytes` fields.
Outcomes are `inserted`, `deduplicated` and `no-recipients`. Only inserted frames contribute stored bytes.
The development memory store also returns these outcomes.

Migration `1-attribution` adds payload sizes, nullable attribution columns and a persistent store ID.
Legacy and unattributed rows attribute occupancy to `sender_did`.
`occupancy()` and `storeID()` are optional storage hooks.
`onInvocation` and `resolveAttribution` are optional server hooks, also accepted by the HTTP host.
Existing delivery, retention and deduplication semantics remain unchanged.
