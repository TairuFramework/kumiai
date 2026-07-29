---
'@kumiai/hub-server': minor
'@kumiai/rpc': minor
---

`createHandlers` and `createHub` now take `onStoreError`, called when a `HubStore` operation fails
at a point where the hub deliberately does not fail the request: the last-resort key-package
top-up read, an ack, and the scheduled purge. All three swallows are correct and unchanged — a
permanently broken last-resort read still returns what the pool can serve, rather than destroying
key packages nobody received — but they are no longer silent. Unwired, the failure is reported
through `@sozai/log` under `['kumiai', 'hub-server']`.

`@kumiai/rpc` now reports through `@sozai/log`'s `getReporter` instead of two hand-rolled copies
of the same logic. No behaviour change in rpc itself; what changed is underneath it, in
`@sozai/log` 0.3.0, whose default config now carries every category rather than dropping
`['kumiai']` records for want of a matching logger.
