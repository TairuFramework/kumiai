# `teardownEpoch()`'s `AggregateError` is unreachable in production

**Priority:** low (doc-only, or a small hardening if a future child changes it).
**Origin:** surfaced while implementing the dispose-teardown hazards (see
`docs/agents/plans/completed/2026-08-28-dispose-teardown-hazards.complete.md`, Slice 1).

## The finding

`peer.ts`'s `teardownEpoch()` disposes every child concurrently via `Promise.allSettled` and throws an
`AggregateError('Group epoch teardown failed')` if any child-disposal rejects. `dispose()` was hardened
(Slice 1) to always reach `mux.dispose()` and to collect both errors even when `teardownEpoch()` throws.

However, all four children `teardownEpoch()` disposes — the per-member directed clients, the bus server,
the acceptor, and the outbound `BroadcastClient` — bottom out in `@sozai/async`'s `Disposer`.
`Disposer.dispose()` catches a rejecting dispose callback, routes it to `console.warn` (or an optional
`onDisposeError`), and **always resolves** its `disposed` promise; it never rejects. The two remaining
unprotected call sites in the child `dispose()` paths (`unsubscribe()` in the directed client and the
inbox acceptor) resolve to a synchronous refcount decrement that cannot throw.

Consequence: with the current implementations, no child disposal can reject, so `teardownEpoch()`'s
`AggregateError` is unreachable in production today. Slice 1's aggregation is still correct defensive
code, and its second arm — `mux.dispose()`, which is hand-rolled and genuinely rejects — is load-bearing
and reachable. Only the first arm (around `teardownEpoch()`) currently guards a path nothing can trigger.

The implementation's test for this arm forces the path with a scoped `vi.spyOn(BroadcastClient.prototype,
'dispose')` seam, which exercises the real `teardownEpoch()` rejection path even though no fixture double
can otherwise reach it.

## Options (decide when picked up)

1. **Doc-only (cheapest):** add a short comment in `teardownEpoch()` / `dispose()` noting the aggregation
   is defensive against a future non-`Disposer` child and is currently untriggerable in production. No
   behavior change.
2. **Harden a child (larger):** give one of the `Disposer`-based classes (or `teardownEpoch()` itself) a
   real path to surface a child-disposal failure, so the aggregation guards a reachable hazard. Only
   worth it if a concrete need for observable child-disposal failure emerges.

Recommendation: option 1 unless a real requirement for observable child-disposal failure arises.
