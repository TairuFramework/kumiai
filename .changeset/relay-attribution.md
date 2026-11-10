---
"@kumiai/hub-protocol": patch
"@kumiai/hub-store": patch
"@kumiai/hub-server": patch
"@kumiai/hub-http": patch
---

Add optional publish attribution, invocation hooks and SQL occupancy reporting for relay accounting.
Attribution uses `{ account, actor, via: 'direct' | 'delegated' | 'group' }`.
The default is direct attribution to the authenticated sender. Only a verified delegation yields delegated attribution.

WARNING: return `PublishResult.outcome` and `storedBytes` from custom `HubStore` implementations.
These fields are now required for storage accounting.
Outcomes are `inserted`, `deduplicated` and `no-recipients`. Only inserted frames contribute stored bytes.
The development memory store also returns these outcomes.

Migration `1-attribution` adds payload sizes, nullable attribution columns and a persistent store ID.
Legacy and unattributed rows attribute occupancy to `sender_did`.
`occupancy()` and `storeID()` are optional storage hooks.
`onInvocation` and `resolveAttribution` are optional server hooks, also accepted by the HTTP host.
Existing delivery, retention and deduplication semantics remain unchanged.
