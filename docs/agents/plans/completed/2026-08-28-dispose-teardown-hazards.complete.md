# Dispose-teardown hazards

**Status:** complete
**Date:** 2026-08-28
**Packages:** `@kumiai/rpc` (`peer.ts`, `hub-mux.ts`), `@kumiai/hub-tunnel` (`transport.ts`).
**Origin:** the three teardown hazards filed as follow-on from the dispose/ordering-residuals work
(see `2026-08-27-dispose-ordering-residuals.complete.md`). Two rounds of external spec review then
surfaced several closely-related defects in the same disposal paths; all were folded into this branch.

## Goal

Make `dispose()` fully finish what it starts across the three packages: always reach `mux.dispose()`,
wait for the receive drain to close, run the full cleanup on every teardown path, and stay correct
under concurrent callers. The stakes are correctness, not hygiene: the `mls: GroupMLS` handle is
host-passed, so a post-dispose write through a leaked drain or stale lane can corrupt host-shared state.

## What was built

Four interacting slices settled onto one branch (five code/test commits plus the fix wave):

- **Slice 1 — `peer.dispose()` always reaches `mux.dispose()`.** `teardownEpoch()` disposes every child
  concurrently and throws an `AggregateError` if any child-disposal rejects. Previously that throw
  aborted `dispose()` before `mux.dispose()` ran, leaking the hub drain, listeners, sinks, and sleepers.
  The fix runs both steps under independent `try/catch`, collecting whatever each throws: `mux.dispose()`
  now always runs, a lone failure rethrows unwrapped, and a double failure surfaces as an
  `AggregateError('Peer dispose failed')`. A bare `try/finally` was rejected on review — a throw from
  `finally` replaces the `try` error, and `mux.dispose()` can now throw too (Slice 2), so both errors
  must be collected rather than sequenced. `teardownEpoch()`'s own throw is left intact because it is
  also called from the epoch-rotation path, where a child-disposal failure *should* surface.

- **Slice 2 — `dispose()` resolves only after the receive drain is closed, and every teardown path runs
  the full cleanup.** Both the mux and the transport drain a hub subscription through an async iterator
  and previously closed it with a fire-and-forget `iterator.return?.()`, so `dispose()` could resolve
  before the receive resource actually closed. The mux now `await`s the close. In the transport, the
  timer/listener/subscription/iterator teardown was extracted into one `releaseResources()` that every
  path calls — fixing a wider pre-existing leak where three inline teardown paths (readable-pull
  `next()` rejection, `result.done`, remote `session-end`) cleared only the idle timer and skipped the
  reconnect timer, the hub-status listener, the abort listener, and `hub.unsubscribe`. The `'disposed'`
  listener became async and awaits the captured receive-close promise. Folded findings: a construction
  race that registered the hub-status listener *after* a pre-aborted teardown already ran, now guarded
  with `!torndown` (Finding A); exception-safety wrappers so a synchronous throw from an unrestricted
  call (`unsubscribeEvents()` or `iterator.return()`) cannot strand the rest of the cleanup (Finding E);
  and correct handling of an async `return()` rejection (Finding D, below).

- **Slice 3 — clear the stale `inboxLane` reference on dispose.** `inboxLane` closes over the mux and was
  never cleared by `teardownEpoch()`, so a disposed peer retained a reference to an obsolete inbound
  path. Cleared unconditionally in `dispose()` (on the path that runs whether or not either teardown
  step threw), not in `teardownEpoch()` — the rotation path re-sets it via `buildEpoch()` and must be
  left untouched. The residual-#7 publish guards already blocked anything the stale lane could do, so
  this is a cleanliness fix riding along with the correctness ones.

- **Slice 4 — concurrent `dispose()` shares one in-flight disposal.** Slices 1 and 2 turned both
  `dispose()` methods into genuine awaitable work, so the old boolean/no-op idempotency became observably
  wrong (a second caller could resolve before the drain closed, or re-run the whole body). Each method is
  now a synchronous function that runs its eager prologue, starts the async body once, memoizes the
  promise, and returns that same promise to every later caller. The eager prologue (`disposed = true`,
  then `suspendPublishing()` / `publishSuspended = true`) still runs synchronously on the first call
  before anything is awaited — preserving the residual-#7 ordering invariant (suspend the publish funnel
  before any await). External type stays `(): Promise<void>`; the `async` moved to the inner IIFE.

## Key design decision corrected during implementation (Finding D)

The spec asserted that `transport.dispose()` *rejects* if the drain close fails, "like `mux.dispose()`
and `peer.dispose()`." **That premise is wrong and was corrected in the implementation.** enkaku's
`Transport` extends `@sozai/async`'s `Disposer`, and its dispose callback `await`s
`events.emit('disposed', …)`. `@sozai/event`'s `emit` does rethrow a rejecting listener — but
`Disposer.dispose()` catches that rejection, routes it to `console.warn('Disposer dispose callback
rejected', …)`, and **always resolves**. So the true behavior is:

- **Ordering holds:** `transport.dispose()` does not *resolve* until the receive-close promise settles
  (the Disposer awaits its callback, which awaits the emit, which awaits the async `'disposed'`
  listener's `await receiveClosed`).
- **Rejection is swallowed:** a close failure surfaces via `console.warn`, not by rejecting
  `transport.dispose()`. This is unlike the hand-rolled `mux.dispose()` / `peer.dispose()`, which have
  no Disposer layer and genuinely reject.

The production code matches this true behavior; only the involuntary paths additionally attach a no-op
`catch` to the stored close promise so a rejection there is never an unhandled rejection while the
voluntary listener's separate `await` still observes it. Reviewers verified this against source four
independent times. The lesson — a rethrowing `emit` can still be swallowed by a `Disposer` one layer up
— is captured in agent memory.

## Verified boundary and follow-on

`iterator.return()` closes *our own* drain at the very end of teardown — no mutex held, no host callback
inside it — so awaiting it is bounded (local cleanup plus at most a fire-and-forget wire close for the
real `HubClient` channel), not the unbounded/deadlocking drain that the dispose-ordering-residuals work
rejected. If a future hub made `return()` do unbounded I/O this await would need revisiting — the
accepted boundary, same shape as that branch's documented boundaries.

One architectural finding surfaced and is deferred to backlog (see
`2026-08-28-teardownepoch-aggregate-unreachable.md`): because all four children `teardownEpoch()`
disposes are `Disposer`-based and `Disposer` never rejects, `teardownEpoch()`'s `AggregateError` is
currently unreachable in production. Slice 1's aggregation is correct defensive code — and its second
arm (`mux.dispose()`, which genuinely rejects) is load-bearing — but the first arm guards a path only a
future non-`Disposer` child could trigger. Documented, not a blocker.

## Verification

`@kumiai/rpc` 408/408 and `@kumiai/hub-tunnel` 94/94 (forced, real runs). Every task followed
red→green→mutation-check discipline. Two whole-branch code reviews plus an independent Codex pass — the
second review caught that Finding E's exception-safety had no committed test (its original mutation-check
used a temporary test deleted before commit), now closed with two permanent synchronous-throw tests that
bite. No port-contract changed, so the `rpc-conformance` / `hub-conformance` suites needed no re-run.

## Branch note

Stacked on the dispose-ordering-residuals branch (it edits the same `dispose()` tail): target the new
PR at that branch, or rebase onto `main` once it merges.
