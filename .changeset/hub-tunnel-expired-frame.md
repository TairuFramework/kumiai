---
'@kumiai/hub-tunnel': patch
---

Add `ExpiredFrameError`. An `Encryptor` rejects with it for a ciphertext whose key it no longer holds, and the encrypted transport acks that frame, reports a `frame-expired` event and drops it as `expired` instead of reporting a decrypt failure.
