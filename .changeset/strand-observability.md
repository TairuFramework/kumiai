---
"@kumiai/rpc": patch
"@kumiai/mls": patch
"@kumiai/mls-rpc": patch
---

Expose commit strand observations and recovery lifecycle callbacks. `started` is dispatched asynchronously when the attempt begins, before its terminal event and while a port call may still be pending. Recovery attempts are single-flight, and `recover()` may drain re-enact entries left by an earlier automatic heal. Future-version handshake frames with unknown kinds now trigger healing, failed request publishes throw instead of timing out, and a ledger bootstrap completed later returns the owed re-enact entries. Disposal waits for ledger bootstraps already in progress.

`@kumiai/mls` persists accepted received commits and proposals, plus ledger bootstrap, before notifications; this option does not persist application-message receive ratchets. Persist must write atomically and must not call back into the same handle while its mutex is held. A rejection restores prior in-memory state and must leave storage unchanged. Host callback errors do not undo a durable advance.

`@kumiai/mls-rpc` persists recovery handles before adoption; if adoption throws, a restart loads the new stored handle. It uses the MLS handle persistence boundary for commits and ledger bootstrap, reports durable advances even if a host callback throws, and expires and zeroes recovery request keys on timers without requiring another request.
