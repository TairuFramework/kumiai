---
'@kumiai/mls': patch
---

Every kumiai MLS context now carries `KUMIAI_KEY_RETENTION_CONFIG` (exported): 256 retained skipped keys per sender ratchet, one retained past epoch, and a 512-generation forward window, in place of ts-mls's 10, 4 and 200. One sender ratchet is spent across several lanes a receiver drains independently, so after a reconnect a newer frame on one lane could open first and move the ratchet past a backlog on another; every backlog frame beyond the 10th then failed with "Desired gen in the past" and was lost. A handle built on a context without a client config gets the same retention, and so does the handle a commit derives. In a group of three or more, frames a sender seals for the other peers fill each receiver's window, so steady-state persisted receiver state is about 42 KB for 3 members, 82 KB for 5 and 181 KB for 10.
