---
'@kumiai/rpc': patch
---

A `GroupPeer` protocol call now rejects with `Peer is disposed` once `dispose()` has been called,
instead of two different wrong answers depending on when it was made.

`dispose()` awaits a promise derived from the same `ready` that gates every protocol call, so a
call queued before init settles always resumes FIRST — early enough to build a directed client
that teardown then disposes one microtask later. `to()` handed back a live-looking `Client` over
an already-aborted transport, discoverable only by using it. A call made after teardown had
emptied the runtime map took the other path and reported `Unknown protocol: <name>` — blaming a
protocol that is fine for a peer that is gone.

A `disposed` flag, set as `dispose()`'s first statement and checked after the `ready` await,
refuses both.
