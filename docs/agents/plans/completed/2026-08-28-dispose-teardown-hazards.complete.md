# Dispose-teardown hazards

**Status:** complete
**Date:** 2026-08-28
**Packages:** `@kumiai/rpc` (`peer.ts`, `hub-mux.ts`), `@kumiai/hub-tunnel` (`transport.ts`).
**Origin:** the three teardown hazards filed as follow-on from the dispose/ordering-residuals work
(see `2026-08-27-dispose-ordering-residuals.complete.md`). Two rounds of external spec review then
surfaced several closely-related defects in the same disposal paths; all were folded into this branch.

## Goal

Make `dispose()` fully finish what it starts across the three packages: always reach `mux.dispose()`,
close the receive drain on every teardown path, run the full cleanup on every path, and stay correct
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

- **Slice 2 — every teardown path runs the full cleanup, and the receive drain is closed fire-and-forget
  on every path.** Both the mux and the transport drain a hub subscription through an async iterator.
  In the transport, the timer/listener/subscription/iterator teardown was extracted into one
  `releaseResources()` that every path calls — fixing a wider pre-existing leak where three inline
  teardown paths (readable-pull `next()` rejection, `result.done`, remote `session-end`) cleared only
  the idle timer and skipped the reconnect timer, the hub-status listener, the abort listener, and
  `hub.unsubscribe`. Folded findings: a construction race that registered the hub-status listener
  *after* a pre-aborted teardown already ran, now guarded with `!torndown` (Finding A); exception-safety
  wrappers so a synchronous throw from an unrestricted call (`unsubscribeEvents()` or `iterator.return()`)
  cannot strand the rest of the cleanup (Finding E); and the drain-close decision below (Finding D).

  **Drain-close decision — fire-and-forget, corrected during CI.** An intermediate version of this
  branch made `dispose()` *await* the drain close (`await iterator.return?.()` in the mux; the
  transport's `'disposed'` listener `await`ing a captured close promise), so `dispose()` would resolve
  only after the receive resource actually closed. That version passed every unit test and three review
  passes but **deadlocked the `@kumiai/integration-tests` suite against the real wire hub**: the drain
  loop is parked at `await iterator.next()`, and on the real enkaku channel the async iterator's
  `return()` waits behind that in-flight `next()`, which never settles during teardown — so awaiting
  `return()` blocks forever. Fake hubs resolve `return()` instantly, which masked it in unit tests, and
  turbo had cached the integration suite green, which masked it in CI. The fix reverts to closing the
  drain **fire-and-forget** on every path (a no-op `.catch()` keeps a late rejection off the
  unhandled-rejection path). This is not merely a rollback: the residual-#7 `publishSuspended` guards
  already block every post-dispose write independently of whether the drain has closed, so awaiting the
  close bought no correctness — it was belt-and-suspenders that only ever held against fake hubs. The
  mux still *rejects* if `return()` throws **synchronously** (it runs that call un-`try/caught` as its
  last act), so Slice 1's aggregation second arm stays reachable.

- **Slice 3 — clear the stale `inboxLane` reference on dispose.** `inboxLane` closes over the mux and was
  never cleared by `teardownEpoch()`, so a disposed peer retained a reference to an obsolete inbound
  path. Cleared unconditionally in `dispose()` (on the path that runs whether or not either teardown
  step threw), not in `teardownEpoch()` — the rotation path re-sets it via `buildEpoch()` and must be
  left untouched. The residual-#7 publish guards already blocked anything the stale lane could do, so
  this is a cleanliness fix riding along with the correctness ones.

- **Slice 4 — concurrent `dispose()` shares one in-flight disposal.** Slices 1 and 2 turned both
  `dispose()` methods into genuine awaitable work, so the old boolean/no-op idempotency became observably
  wrong (a second caller could re-run the whole body). Each method is now a synchronous function that
  runs its eager prologue, starts the async body once, memoizes the promise, and returns that same
  promise to every later caller. The eager prologue (`disposed = true`, then `suspendPublishing()` /
  `publishSuspended = true`) still runs synchronously on the first call before anything is awaited —
  preserving the residual-#7 ordering invariant (suspend the publish funnel before any await). External
  type stays `(): Promise<void>`; the `async` moved to the inner IIFE.

## Finding D and the drain-close asymmetry

The spec asserted that `transport.dispose()` *rejects* if the drain close fails, "like `mux.dispose()`
and `peer.dispose()`." **That premise was wrong.** enkaku's `Transport` extends `@sozai/async`'s
`Disposer`, whose `dispose()` catches a rejecting dispose callback, routes it to `console.warn`, and
**always resolves** — it never rejects, unlike the hand-rolled `mux.dispose()` / `peer.dispose()` which
have no Disposer layer. (`@sozai/event`'s `emit` *does* rethrow a rejecting listener, but the `Disposer`
one layer up still swallows it — a lesson captured in agent memory.)

With the drain close now **fire-and-forget on every path** (the corrected Slice 2 decision above), the
rejection question collapses: `releaseResources()` attaches a no-op `.catch()` to the `return()`
promise and nothing awaits it, so a rejecting async `return()` is swallowed on both the voluntary
dispose path and the involuntary (idle/abort/error/completion/remote-session-end) paths alike — it
reaches neither the caller, nor the `console.warn` channel, nor the unhandled-rejection handler. The
only close failure that still *rejects* a `dispose()` is a **synchronous** throw from `return()` on the
hand-rolled `mux.dispose()` / `peer.dispose()`, which run that call un-`try/caught`; the transport wraps
it, so it never rejects there.

## Boundary and follow-on

The drain close is not awaited, so there is no teardown-duration boundary to defend: `dispose()`
resolves in bounded local work (synchronous clears plus initiating a fire-and-forget close) regardless
of what the hub's `return()` does. This is the same conclusion the dispose-ordering-residuals work
reached when it rejected draining a subscription inside `dispose()`.

**Process lesson (the real one).** The await-drain deadlock shipped through brainstorming, a written
spec, three review passes, and an external Codex pass — all green — because the fake-hub unit tests
cannot exhibit it and the `@kumiai/integration-tests` suite was never actually run during development
(turbo had it cached green on `main`). Any change to a `dispose()`/teardown path against a hub must run
that integration suite **uncached** as a gate; a green unit suite over fake hubs is not evidence.

One architectural finding surfaced and is documented in code (a comment on `teardownEpoch()` and on
`peer.dispose()`'s aggregation in `peer.ts`): because all four children `teardownEpoch()` disposes are
`Disposer`-based and `Disposer` never rejects, `teardownEpoch()`'s `AggregateError` is currently
unreachable in production. Slice 1's aggregation is correct defensive code — and its second arm
(`mux.dispose()`, which rejects on a synchronous `return()` throw) is load-bearing — but the first arm
guards a path only a future non-`Disposer` child could trigger. The rotation path (which shares
`teardownEpoch()`) and a `BroadcastClient.prototype.dispose` test spy still exercise it. No hardening
was warranted, so no follow-on was filed.

## Verification

`@kumiai/rpc` 408/408 and `@kumiai/hub-tunnel` 94/94 (forced, real runs), plus the
`@kumiai/integration-tests` suite 43/43 run **uncached** against the real wire hub — the gate that
catches the drain-close deadlock a green unit suite hides. Every task followed
red→green→mutation-check discipline. Two whole-branch code reviews plus an independent Codex pass — the
second review caught that Finding E's exception-safety had no committed test (its original mutation-check
used a temporary test deleted before commit), now closed with two permanent synchronous-throw tests that
bite. No port-contract changed, so the `rpc-conformance` / `hub-conformance` suites needed no re-run.

## Branch note

Folded into PR #35 (single PR onto `main`).
