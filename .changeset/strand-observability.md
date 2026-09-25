---
"@kumiai/rpc": patch
---

Expose commit strand observations and recovery lifecycle callbacks. Recovery attempts are single-flight, and `recover()` may drain re-enact entries left by an earlier automatic heal. Future-version handshake frames with unknown kinds now trigger healing, failed request publishes throw instead of timing out, and a ledger bootstrap completed later returns the owed re-enact entries.
