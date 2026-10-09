---
'@kumiai/mls-hub': minor
---

Split Welcome opening from post-save consumption. Ordinary sources atomically delete packages and retain receipts; reusable last-resort sources write no receipt. Judge admission by authenticated epoch so a newer Welcome can re-admit a held group.
