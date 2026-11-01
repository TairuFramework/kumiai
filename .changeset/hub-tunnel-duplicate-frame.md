---
'@kumiai/hub-tunnel': patch
---

Add `DuplicateFrameError`. An `Encryptor` rejects with it for a ciphertext it has already opened, and the encrypted transport acks that frame and drops it as `dedup` instead of reporting a decrypt failure. A hub redelivers a frame whose ack was lost, and a ratcheting cipher cannot open it twice.
