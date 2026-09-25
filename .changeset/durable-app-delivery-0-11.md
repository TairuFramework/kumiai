---
"@kumiai/broadcast": minor
"@kumiai/hub-client": minor
"@kumiai/hub-conformance": minor
"@kumiai/hub-protocol": minor
"@kumiai/hub-server": minor
"@kumiai/hub-tunnel": minor
"@kumiai/hub-wake": minor
"@kumiai/mls": minor
"@kumiai/mls-hub": minor
"@kumiai/mls-rpc": minor
"@kumiai/rpc": minor
"@kumiai/rpc-conformance": minor
---

Coordinate the 0.11 release band for acknowledged durable app-frame delivery. `@kumiai/rpc`
adds opt-in at-least-once delivery of retained events, a pending-record port, handler frame
identity, and retry and operator-drop behavior. `@kumiai/mls` adds staged decrypt and cleartext
AAD reading; `@kumiai/mls-rpc` implements the atomic durable-open port. The conformance suite
covers the new contract, and the remaining packages move together in the shared version band.

**Breaking:** all app frames now use versioned AAD carrying authenticated log intent. 0.10 and
0.11 peers cannot exchange app frames; a frame with the older bare-topic AAD is refused. Consumers implementing
`GroupCrypto` must provide `frameAAD` and support the new `unwrap` options. Hosts opting in to
durable delivery must atomically persist consumed-key state with each pending record, order
handle saves, reject stale same-epoch writes, and avoid holding a database transaction while
awaiting a peer or handle operation.
