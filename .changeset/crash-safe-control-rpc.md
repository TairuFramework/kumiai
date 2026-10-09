---
'@kumiai/rpc': minor
---

Replace the single commit slot with durable FIFO operations, outcomes, Welcome obligations, commit rows, external responses and cursor. Persist rejoin records and explicit recovery keys, replay accepted work, retain fork evidence and reset old-branch control atomically on Welcome re-admission while keeping outcomes and obligations.
