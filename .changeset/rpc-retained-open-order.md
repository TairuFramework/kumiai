---
'@kumiai/rpc': patch
---

A pushed retained-log frame is now opened before any later frame of the same group, on any topic. The live push used to only wake a retained pull, so a later live frame from the same sender could open first and advance the receive ratchet past the retained frame's generation; once its skipped key was evicted the retained frame failed with "Desired gen in the past" and was lost. Opens for a group now share one ingress queue across topics and epoch rebuilds, and a log push holds it until the pull has opened the frame. A pull that cannot reach the ledger now retries instead of completing.
