---
'@kumiai/hub-server': patch
---

Store errors on the key-package fetch path keep their wire code.

`store.fetchKeyPackages` and `store.fetchLastResortKeyPackage` were called outside any try/catch,
so a named store error reached the client with no `code` at all — indistinguishable from a
transport failure, which is the exact distinction the hub's wire codes exist to preserve.

On the ordinary path both reads are now mapped through the handler's error translation, so a named
store error stays tellable from an unreachable hub while an unnamed one still passes through
untouched rather than being dressed in a code it never earned.

On the spent-drain-budget fallback the store error deliberately does NOT become the client's
error: the request was already being refused and the reusable slot was the only thing that could
have rescued it, so replacing a retryable `HUB_KEYPACKAGE_FETCH_LIMIT` with an opaque failure would
change what a caller does about a situation that has not changed. The refusal stands, and the store
error is attached as `cause` so an operator can still see a broken store behind it.
