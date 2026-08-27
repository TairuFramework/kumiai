# Dispose-teardown hazards

**Priority:** low.
**Origin:** the Codex review of `docs/superpowers/specs/2026-08-27-dispose-ordering-residuals-design.md`,
2026-08-27. Three teardown hazards were surfaced while designing that spec's four dispose/ordering
fixes (residuals #3, #4, #6, #7 from
`docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md`, closed on this branch).
The three below are unrelated to those four fixes and were deliberately kept out of that branch's
scope. Background: `docs/superpowers/specs/2026-08-27-dispose-ordering-residuals-design.md`,
"Out of scope" section.

## 1. `teardownEpoch()`'s `AggregateError` on a child-disposal failure skips `mux.dispose()`

`teardownEpoch()` (`packages/rpc/src/peer.ts:621`) throws an `AggregateError`
(`packages/rpc/src/peer.ts:636`) when a child disposal fails. That throw propagates out before the
later `mux.dispose()` call (`packages/rpc/src/peer.ts:2090`) runs, so a single child-disposal
failure leaks the hub drain, listeners, sinks, and sleepers that `mux.dispose()` would otherwise
have torn down.

Deferred: unrelated to the four residuals this branch closed (none of which touch
`teardownEpoch`'s failure path), and fixing it needs a design decision on ordering — whether
`mux.dispose()` should run before the epoch teardown that can throw, or be wrapped so its own
failure can't be skipped by a sibling's — rather than a local guard.

## 2. Un-awaited `iterator.return?.()` in dispose paths

Both `mux.dispose()` (`packages/rpc/src/hub-mux.ts:763`) and the hub-tunnel transport's teardown
(`packages/hub-tunnel/src/transport.ts:298`) call `iterator.return?.()` without awaiting it, so
`dispose()` can resolve before the receive resource actually closes.

Deferred: unrelated to the four residuals this branch closed. Awaiting it is not necessarily free —
it would change `dispose()`'s completion semantics (currently synchronous-feeling, becomes bounded
by however long the iterator's `return` takes) and needs its own design pass on whether dispose
should wait for resource teardown or just signal it.

## 3. `inboxLane` closes over the mux and outlives dispose

`inboxLane` (`packages/rpc/src/peer.ts:381,573`) closes over the mux, and `teardownEpoch()` never
clears it, so a disposed peer retains a reference to an obsolete path. The post-dispose publish
guards land by this branch (Slice 3 of the spec above) block anything the lane would actually do
with that reference, but the reference itself is still held.

Deferred: unrelated to the four residuals this branch closed, and the guards this branch added
already close the practical hazard (nothing the lane does post-dispose can reach the wire); clearing
the reference itself is a cleanliness fix, not a correctness one, so it wasn't worth expanding this
branch's scope.
