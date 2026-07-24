---
'@kumiai/hub-protocol': minor
'@kumiai/hub-server': minor
'@kumiai/hub-conformance': minor
'@kumiai/rpc': minor
---

Harden the hub against key-package drain and per-DID memory exhaustion.

`@kumiai/hub-protocol` gains four named errors with wire codes so refusals cross the RPC tunnel
diagnosably: `AuthorizationDeniedError` (`HUB_AUTHORIZATION_DENIED`), `KeyPackageQuotaExceededError`
(`HUB_KEYPACKAGE_QUOTA`), `SubscriptionQuotaExceededError` (`HUB_SUBSCRIPTION_QUOTA`), and
`KeyPackageFetchLimitError` (`HUB_KEYPACKAGE_FETCH_LIMIT`), each round-tripping through
`hubErrorCodeOf`/`hubErrorFromCode`. The `HubStore` port now documents that `storeKeyPackage` and
`subscribe` MAY reject over a per-DID cap (reject, never evict; a re-subscribe to a held topic never
counts against the cap).

`@kumiai/hub-server` enforces those caps in `createMemoryStore` — `maxKeyPackagesPerDID` (default
100) and `maxSubscriptionsPerDID` (default 1000) — bounding per-DID state where the count can be
checked atomically. The key-package `fetch` handler now dispatches the `authorize` hook and adds a
per-target-DID consumption quota (`maxPerTargetConsumed`, default 60/window) on top of the existing
per-requester window, so minting throwaway requester DIDs can no longer amplify a drain of one
victim's packages. `authorize` is also now dispatched for `keypackage/upload` and `topic/fetch`, and
`subscribe`/`unsubscribe`/`keypackage/upload` consume the per-DID rate limiter. The rate limiter
prunes idle full buckets past a TTL (default 300s) so its bucket map no longer grows without bound.

`@kumiai/rpc`'s hub mux now treats a subscribe authorization refusal as permanent (matched by
instance and by error name for the tunnel-rebuild path), so it no longer runs the full retry
schedule against a settled refusal and then mislatches it transient. A subscription-quota refusal is
deliberately left transient — it is a clearable resource condition, not a settled answer.

`@kumiai/hub-conformance` adds optional `maxKeyPackagesPerDID`/`maxSubscriptionsPerDID` params and
asserts the cap-rejection invariants (reject-not-evict, per-DID isolation, re-subscribe exemption)
for any store configured with caps.
