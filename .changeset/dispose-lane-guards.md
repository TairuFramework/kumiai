---
'@kumiai/rpc': patch
---

A commit delivery queued behind the commit mutex when `dispose()` ran is now refused. `dispose()`
awaits `settled`, never the mutex, so such a delivery used to resume against a torn-down peer and
rebuild its epoch — fetching the commit topic from a peer its host had already disposed. Refused
silently, unlike every host-facing entry point: an inbound delivery has no caller to tell.
