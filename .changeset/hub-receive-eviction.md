---
'@kumiai/hub-server': minor
---

**`hub/receive` now evicts an older channel for the same DID instead of refusing the newer
one.** A client reconnects because its connection broke, and the server learns that last: it
still holds a receive writer pointing at a socket that is already gone. Refusing on that stale
belief turned away precisely the reconnect that had to happen, and the refusal arrived on a
channel promise nothing awaited — so the member had no push lane and no error either.

Both channels belong to one authenticated DID, so this lets a client replace its own stale
lane and nothing else. The evicted channel ends rather than errors.

Also: dropped the unused `@kumiai/mls` and `@sozai/stream` dependencies. The MLS core in a
blind hub's dependency closure was the wrong architectural signal as well as dead weight.
