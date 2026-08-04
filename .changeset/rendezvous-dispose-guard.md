---
'@kumiai/rpc': patch
---

A rendezvous reply whose timer fired before `dispose()` no longer publishes after it. Both
responders — `handleRecoveryRequest` and `handleLedgerRequest` — schedule a `setTimeout` whose
callback removes itself from its pending set before awaiting the MLS seal, so `dispose()`'s
`clearTimeout` sweep could not reach one already in flight, and a sealed GroupInfo or the group's
whole sealed ledger could go out from a torn-down peer.
