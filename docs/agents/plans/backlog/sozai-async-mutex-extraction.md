# Extract the FIFO `Mutex` to `@sozai/async`

**Priority:** backlog (cross-repo; no functional gap in kumiai today).
**Origin:** `completed/2026-07-11-mls-state-serialization-secret-hygiene.complete.md`.

## Problem

`packages/mls/src/mutex.ts` holds a small, generic, dependency-free FIFO async serializer:

- `run(fn): Promise<T>` executes callbacks one at a time, in the order they were called.
- Order is never reprioritized — callers rely on it to preserve causal ordering.
- A callback's rejection is delivered to its own caller but never stalls or poisons the queue.

Nothing about it is MLS-specific. The same read-`await`-write-on-shared-state hazard it exists to
close appears elsewhere in the stack (hub, rpc, and anything mutating state across an `await`), and
each such site would otherwise hand-roll its own chain — which is precisely how the original
`GroupHandle` race got in.

It was kept local because extracting it upstream means a `@sozai` change, publish, and version bump
before kumiai could consume it — coordination a crypto-hygiene fix should not have waited on.

## Direction

Move the primitive to `@sozai/async` unchanged. It was deliberately shaped for this: a standalone
module exporting a `Mutex` type and a `createMutex()` factory, with no imports. kumiai's only glue
is a module-private `WeakMap<GroupHandle, Mutex>` keyed by handle, which stays behind — so the swap
is: delete `packages/mls/src/mutex.ts`, import `createMutex` from `@sozai/async`, keep the map.

Worth doing when `@sozai` is next opened for other reasons; not worth a release cycle on its own.

## Note on the shape

The rejection-isolation is the part to preserve exactly on the move — a naive `chain.then(fn)` never
runs `fn` once the chain has entered a rejected state, silently wedging every later caller. The
chain must advance on *both* fulfilment and rejection while the real outcome is surfaced to the
original caller. Any extraction should carry the existing unit tests (FIFO order under a
faster-finishing later job; each caller gets its own result; a rejecting job does not poison the
queue) rather than re-deriving them.
