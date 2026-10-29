---
'@kumiai/mls': patch
---

Add `GroupHandle.clone()`, an independent in-process copy of a group handle that skips serialization, ledger replay and signature verification. Use it in place of a serialize-and-restore round trip to get a private copy of a live handle.
