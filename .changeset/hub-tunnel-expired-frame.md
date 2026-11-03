---
'@kumiai/hub-tunnel': patch
---

Add `ExpiredFrameError` and `precedesSequenceID`. An `Encryptor` rejects with `ExpiredFrameError` for a ciphertext whose key it no longer holds, and the encrypted transport acks that frame, reports a `frame-expired` event and drops it as `expired` instead of reporting a decrypt failure. A frame the hub sequenced after the session's first publish or delivered frame fails the session at once, with a session-end to the peer, instead of leaving it to its idle timeout.
