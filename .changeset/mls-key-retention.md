---
'@kumiai/mls': patch
---

Every kumiai MLS context now carries `KUMIAI_KEY_RETENTION_CONFIG` (exported): 256 retained skipped keys per sender ratchet and a 512-generation forward window, in place of ts-mls's 10 and 200. One sender ratchet is spent across several lanes a receiver drains independently, so after a reconnect a newer frame on one lane could open first and move the ratchet past a backlog on another; every backlog frame beyond the 10th then failed with "Desired gen in the past" and was lost. The retention also survives a commit (`deriveGroup` keeps the source context's client config). A full window costs about 9.5 KiB per sender per retained epoch in persisted state.
