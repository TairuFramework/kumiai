---
'@kumiai/broadcast': minor
'@kumiai/hub-client': minor
'@kumiai/hub-http': minor
'@kumiai/hub-protocol': minor
'@kumiai/hub-server': minor
'@kumiai/hub-store': minor
'@kumiai/hub-tunnel': minor
'@kumiai/mls': minor
'@kumiai/mls-hub': minor
'@kumiai/mls-rpc': minor
'@kumiai/rpc': minor
'@kumiai/rpc-conformance': minor
---

Adopt kokuin 0.7, enkaku 0.23 and teikyo 0.5.

Controller log folds are asynchronous in kokuin 0.7, which changes these contracts:

- `GroupHandle` is built with `await GroupHandle.create(params)`, and `deriveGroup` returns a promise.
- `foldChain`, `foldControllerLog`, the registry and member-root helpers, `treeTime`, `isLapsed` and
  `recoverySignerEligible` return promises.
- `HandleAccess.replace` takes a guard returning a promise, and implementations must await it.
- `PendingRecovery.judgeVerdict` returns a promise.
- `DIDMethodResolver.resolveMember` takes `{ subject, member }`.

`GroupHandle.registry` and `sendAdmission()` stay synchronous. Control state is computed first and
published together, so readers never observe a partial update.

Hosts can pass a kokuin `crypto` provider through `GroupOptions`, `GroupHandleParams` and
`CreateHubParams`. Verification caches are kept per provider. MLS cryptography is unchanged.
