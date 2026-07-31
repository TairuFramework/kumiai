---
'@kumiai/rpc': minor
---

A disposed `GroupPeer` now refuses everything. Every entry point — `protocol().dispatch`,
`.request`, `.gather`, `.to`, plus `commit`, `replay`, `recover` and `resync` — rejects with
`Peer is disposed` once `dispose()` has been called, where each previously failed its own way and
none of them said why.

`dispose()` awaits a promise derived from the same `ready` that gates every entry point, so a call
queued before init settles always resumes one microtask EARLIER than dispose's own body — early
enough to run to completion against a runtime teardown is about to walk. `to()` handed back a
live-looking `Client` over an already-aborted transport, discoverable only by using it. `resync()`
rebuilt a whole epoch onto a disposed mux, re-registering listeners and retains into maps
`mux.dispose()` had just cleared and no second teardown will reach. `commit()` published to the
hub from a peer that is gone. In the mirror ordering, where teardown got there first and emptied
the runtime map, a protocol call reported `Unknown protocol: <name>` — blaming a protocol that is
fine for a peer that no longer exists.

A `disposed` flag, set as `dispose()`'s first statement and checked immediately after each entry
point's `await ready`, refuses all of them. A host that called a lane operation on a disposed peer
and got silence now gets an error.
