---
'@kumiai/rpc': patch
---

Prevent commit deliveries from blocking peer initialization. Let disposal bypass stalled readiness while waiting for in-flight host ledger bootstraps, and stop seed work after disposal.
