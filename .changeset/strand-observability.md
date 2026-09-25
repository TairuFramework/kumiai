---
"@kumiai/rpc": patch
"@kumiai/mls": patch
"@kumiai/mls-rpc": patch
---

Expose commit strand observations and recovery lifecycle callbacks. Recovery attempts are single-flight, and `recover()` may drain re-enact entries left by an earlier automatic heal. Future-version handshake frames with unknown kinds now trigger healing, failed request publishes throw instead of timing out, and a ledger bootstrap completed later returns the owed re-enact entries.

`@kumiai/mls` persists all accepted received state changes and ledger bootstrap before notifications, restoring the prior in-memory state if persistence fails. Host callback errors do not undo a durable advance.

`@kumiai/mls-rpc` persists recovery handles before adoption, uses the MLS handle persistence boundary for commits and ledger bootstrap, reports durable advances even if a host callback throws, and clears retired recovery request keys.
