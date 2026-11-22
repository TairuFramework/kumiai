---
"@kumiai/hub-protocol": patch
"@kumiai/hub-client": patch
"@kumiai/hub-store": patch
"@kumiai/hub-server": patch
"@kumiai/hub-conformance": patch
---

Fence unsubscribe with durable subscription generations across client connections.
Every successful subscribe returns a new decimal-string generation, including refreshes of an existing subscription.
Fenced unsubscribe accepts `expectedGeneration` and returns whether it removed membership.
A stale fence leaves membership and pending deliveries untouched.
Omitting the fence preserves unconditional cleanup and the legacy wire success response.
`HubClient` exposes the returned generation and forwards the optional fence.

WARNING: update custom `HubStore` implementations for the new return values and atomic fencing contract.
`subscribe()` now returns `Promise<string>` and `unsubscribe()` returns `Promise<boolean>`.
The conformance suite covers refresh, re-creation, matching fences and unfenced cleanup.

Migration `2-subscription-generation` adds generation `"0"` to existing subscription rows and a persistent subscription counter.
Upgrade all peers together. Clients must retain each accepted generation and pass it when removing that subscription.
