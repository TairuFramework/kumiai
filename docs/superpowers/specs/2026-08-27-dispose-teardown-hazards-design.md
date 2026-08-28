# Dispose-teardown hazards — design

**Date:** 2026-08-27
**Scope:** the three dispose-teardown hazards filed as follow-on from the dispose/ordering
residuals work (see `docs/agents/plans/completed/2026-08-27-dispose-ordering-residuals.complete.md`
and `docs/agents/plans/next/2026-08-27-dispose-teardown-hazards.md`), settled onto one branch.
**Packages:** `@kumiai/rpc` (`peer.ts`, `hub-mux.ts`), `@kumiai/hub-tunnel` (`transport.ts`).
**Premises:** all three verified against current source on 2026-08-27; the enkaku/sozai event
mechanism that Slice 2's transport fix relies on was verified in the cross-repo source (see Slice 2).

## Background

Three teardown hazards surfaced during the dispose/ordering-residuals work but were kept out of that
branch's scope because two of them needed design decisions rather than a local guard. All three are
about `dispose()` not fully finishing what it starts. Two rounds of external spec review surfaced
further, closely related defects in the same disposal paths — all folded here:

- **Slice 2** absorbed several transport-teardown gaps: inline `torndown` paths that skip the real
  cleanup (reconnect timer, listeners, `hub.unsubscribe`); a construction-race that registers the
  hub-status listener *after* a pre-aborted teardown already ran (Finding A); exception-safety in the
  extracted `releaseResources()` (Finding E); and correct handling of an async `return()` rejection —
  surfaced on the voluntary `dispose()` path, guarded against unhandled rejection on the involuntary
  ones (Finding D — `@sozai/event`'s `emit` rethrows rather than swallowing).
- **Slice 4** (new) makes both `mux.dispose()` and `peer.dispose()` idempotent under concurrent callers
  via a shared in-flight promise (Findings B + C) — Slice 1's and Slice 2's new awaits make the old
  boolean/no-op idempotency observably wrong.

## Slice 1 — `dispose()` must always reach `mux.dispose()` even if `teardownEpoch()` throws

**File:** `packages/rpc/src/peer.ts` (`dispose`, ~2089-2090).

`teardownEpoch()` (`peer.ts:621`) disposes every child (directed clients, bus server, acceptor,
client) concurrently via `Promise.allSettled`, then — if any rejected — throws an `AggregateError`
(`peer.ts:636`). `dispose()` calls it at `peer.ts:2089`, immediately before `await mux.dispose()`
(`peer.ts:2090`). A single child-disposal failure therefore aborts `dispose()` before `mux.dispose()`
runs, leaking the hub drain, listeners, sinks, and sleepers that `mux.dispose()` tears down.

**`teardownEpoch()`'s throw is correct and must stay.** It is also called from `rebuildEpoch()`
(`peer.ts:710`), the normal epoch-rotation path, where a child-disposal failure *should* surface —
silently swallowing it there would hide a broken rotation. So the fix belongs in `dispose()`, not in
`teardownEpoch()`.

**A bare `try/finally` is wrong (found on review).** `try { await teardownEpoch() } finally { await mux.dispose() }`
does *not* preserve the teardown error: in JavaScript a throw from the `finally` block replaces a throw
from the `try` block. And `mux.dispose()` *can* now throw — Slice 2 makes it `await iterator.return?.()`,
so a rejecting drain-close would swallow `teardownEpoch()`'s `AggregateError` entirely. Both failures
must be collected, not sequenced through `finally`.

**Fix.** Run both unconditionally, collect whatever each throws, then surface it. This block is the tail
of `dispose()`'s awaited body — Slice 4 wraps that body in a memoized in-flight promise, so the snippet
below is shown flat here and appears in its final memoized position in Slice 4:

```ts
const disposeErrors: unknown[] = []
try {
  await teardownEpoch()
} catch (error) {
  disposeErrors.push(error)
}
try {
  await mux.dispose()
} catch (error) {
  disposeErrors.push(error)
}
inboxLane = undefined // Slice 3 — on the unconditional path, never skipped by a throw above
if (disposeErrors.length === 1) throw disposeErrors[0]
if (disposeErrors.length > 1) {
  throw new AggregateError(disposeErrors, 'Peer dispose failed')
}
```

- `mux.dispose()` always runs (the leak is closed), regardless of a `teardownEpoch()` failure.
- The error still propagates (decision: **still throw** — a host disposing a peer learns a child
  failed to tear down; nothing leaks either way). A lone `teardownEpoch()` `AggregateError` rethrows
  as-is (`length === 1`, no double-wrap); if both steps fail, both are surfaced together. This matches
  `teardownEpoch()`'s existing contract on the rotation path.
- **No reorder.** Children hold and use the mux, so they must be disposed before it; `mux.dispose()`
  stays after `teardownEpoch()`. Only the guarantee that it runs — and that neither error is lost —
  changes.

## Slice 2 — `dispose()` should resolve only after the receive drain is closed, and every teardown path must run the full cleanup

**Files:** `packages/rpc/src/hub-mux.ts` (`dispose`, ~763), `packages/hub-tunnel/src/transport.ts`
(`teardown` ~273-299, the three inline `torndown` paths ~349-361 and ~390-404, and the `'disposed'`
listener ~485).

Both the mux and the hub-tunnel transport drain a hub subscription through an async iterator
(`subscription[Symbol.asyncIterator]()` — `hub-mux.ts:457`, `transport.ts:230`). Each closes that
iterator on teardown with a fire-and-forget `iterator.return?.()` (`hub-mux.ts:763`,
`transport.ts:298`), so `dispose()` can resolve before the receive resource has actually closed.

**Decision: await it, bounded.** `iterator.return()` closes *our own* drain at the very end of
teardown — no mutex is held, no host-supplied callback runs inside it — so awaiting it does not
recreate the unbounded/deadlocking drain that residual #7 rejected (which awaited host-supplied
`build()`/`onAccepted()` inside the commit mutex). The bounded-ness assumption is: closing a hub
subscription's async iterator runs local cleanup, not a fresh unbounded network round trip. If a
future hub implementation made `return()` do unbounded I/O, this await would need revisiting — noted
as the boundary here, consistent with how the residuals branch documented its accepted boundaries.

**hub-mux (`dispose` is already async).** Await the close as the last statement of the disposal body,
replacing the un-awaited call:

```ts
await iterator.return?.()
```

Slice 4 moves this body into a memoized in-flight promise (so a concurrent second `dispose()` awaits the
same close rather than resolving early); the awaited `iterator.return?.()` shown here is that body's last
statement in its final form there.

**hub-tunnel transport (`teardown` is deliberately synchronous).** `teardown` is fired from ~8
synchronous sites (idle timer, signal abort, readable-pull error paths, writable `close`/`abort`,
and the enkaku transport's `'disposed'` event listener). It must **stay synchronous** — most of
those callers have no promise to await (an abort or idle timeout is best-effort by nature).

The authoritative *async* disposal boundary is enkaku's `Transport.dispose()`, which does
`await this.#events.emit('disposed', …)` (`enkaku/packages/transport/src/index.ts:80`), and
`@sozai/event`'s `emit` awaits its listeners and **rethrows** their failures: it collects results with
`Promise.allSettled`, then throws — a single rejection as-is, several as an `AggregateError`
(`sozai/packages/event/src/index.ts:146-159`). So a listener that returns a promise is both **awaited
and error-propagating** through `transport.dispose()`. The fix threads the receive-close promise through
that one listener (see Finding D below for the propagation consequence).

**There are FOUR teardown paths, and only one runs the full cleanup (found on review).** `teardown`
(`transport.ts:273`) is the complete teardown: it sets `torndown`, clears the idle timer AND the
reconnect timer, removes the hub-status event listener (`unsubscribeEvents`) and the abort listener,
sends `session-end`, defers `hub.unsubscribe`, and closes the iterator (`transport.ts:276-298`). Three
other paths inside the readable pull loop set `torndown = true` *inline* and clear only the idle timer,
skipping everything else:

- **`iterator.next()` rejects** (`transport.ts:349-354`): `torndown = true`, `clearIdleTimer()`,
  `controller.error(error)`.
- **iterator completes** (`result.done`, `transport.ts:357-361`): `torndown = true`,
  `clearIdleTimer()`, `controller.close()`.
- **remote `session-end` frame** (`transport.ts:390-404`): `torndown = true`, `clearIdleTimer()`,
  `controller.close()`, `ackHandled(...)`, `iterator.return?.()`, `onSessionEnd?.()`.

Because `teardown` early-returns on `if (torndown) return` (`transport.ts:274`), once any inline path
has set `torndown` a later voluntary `dispose()` → `teardown()` is a **no-op** — it never runs
`clearReconnectTimer()`, never removes `unsubscribeEvents` or the abort listener, and never calls
`hub.unsubscribe`. So on those three paths the reconnect timer, the hub-status listener, the abort
listener, and the subscription all leak. This is a real pre-existing leak, wider than the un-awaited
`iterator.return()`; a fix that only captures the return promise leaves it in place.

**Fix: extract the shared release into one function every path calls.** Pull the timer/listener/
subscription/iterator teardown out of `teardown` into a `releaseResources()` that also captures the
receive-close promise:

```ts
let receiveClosed: Promise<unknown> | undefined
const releaseResources = (): void => {
  if (torndown) return
  torndown = true
  clearIdleTimer()
  clearReconnectTimer()
  // unsubscribeEvents and iterator.return() are unrestricted callbacks — a synchronous throw from
  // either must not abort the remaining cleanup (torndown is already set, so no path could retry).
  // Same defensive shape as ackHandled (transport.ts:326-331).
  if (unsubscribeEvents != null) {
    try { unsubscribeEvents() } catch { /* ignore */ }
    unsubscribeEvents = undefined
  }
  if (abortHandler != null && signal != null) {
    signal.removeEventListener('abort', abortHandler)
    abortHandler = undefined
  }
  // Ordered after `subscribed` (unchanged rationale, transport.ts:287-289):
  void subscribed.then(() => hub.unsubscribe?.(localDID, receiveTopicID)).catch(() => {})
  try {
    const rawClose = iterator.return?.()
    receiveClosed = rawClose ?? undefined
    // Guard against an *async* return() rejection becoming an unhandled rejection on an involuntary
    // path (idle / abort / error / remote session-end with no following dispose), where nothing awaits
    // receiveClosed. Attaching a no-op catch marks the rejection handled; the voluntary 'disposed'
    // listener still awaits the raw `receiveClosed` and so still surfaces the failure (Finding D).
    if (rawClose != null) void Promise.resolve(rawClose).catch(() => {})
  } catch {
    // synchronous throw from iterator.return() (Finding E)
    receiveClosed = undefined
  }
}
```

**Finding E (exception-safety, found on re-review).** `releaseResources()` sets `torndown = true`
first, so if a later unrestricted call threw synchronously the guard would block any retry and the rest
of the cleanup would be skipped. The two unrestricted calls — `unsubscribeEvents()` and
`iterator.return()` — are each wrapped so one throwing cannot strand the reconnect timer, the abort
listener, or the subscription. This matches the existing `ackHandled` guard (`transport.ts:326-331`).

`teardown` keeps only its voluntary-path extras (the `session-end` frame it sends, and the optional
`controller.error`):

```ts
const teardown = (error?: unknown): void => {
  if (torndown) return
  releaseResources()
  sendSessionEnd()
  if (error !== undefined && readableController != null) {
    try { readableController.error(error) } catch { /* already closed */ }
  }
}
```

The three inline paths call `releaseResources()` in place of their partial cleanup, keeping their own
controller action:

- `next()` reject → `releaseResources(); controller.error(error)`.
- `result.done` → `releaseResources(); controller.close()`.
- remote `session-end` → **ack first, then release** — `ackHandled(message.sequenceID)` must run
  *before* the iterator closes (the existing `transport.ts:398-399` invariant: a subscription whose
  close abandons outstanding claims, as hub-mux's mailbox facade does, can no longer honour an ack).
  So: `ackHandled(...); try { controller.close() } catch {}; releaseResources(); onSessionEnd?.()`.
  `handled = false` stays. The inline paths still do **not** `sendSessionEnd` (only voluntary
  `teardown` does) — behaviour preserved.

The `'disposed'` listener (`transport.ts:485`) becomes async and awaits the captured promise:

```ts
transport.events.on('disposed', async () => {
  teardown()
  await receiveClosed
})
```

This gives `transport.dispose()` — the voluntary, awaitable disposal — both guarantees at once: the
full cleanup always ran (via whichever path called `releaseResources` first), and the receive drain is
closed (`await receiveClosed`) regardless of which path closed it. The involuntary paths (abort / idle
/ error / completion / remote session-end) stay synchronous and best-effort. When a `dispose()` follows
a path that already released, `teardown()`'s `torndown` early-return skips the redundant
`sendSessionEnd`, and the listener still awaits the `receiveClosed` that path recorded. `iterator.return()`
runs at most once per iterator now (each path routes through the single `releaseResources` guard), so
the earlier double-`return` concern no longer arises.

**Finding D — `transport.dispose()` *does* surface a drain-close rejection (corrected on third review).**
An earlier draft claimed `@sozai/event`'s `emit` swallowed a listener rejection via `Promise.allSettled`.
That was wrong: `emit` collects with `allSettled` and then **rethrows** — a single rejection as-is,
several as an `AggregateError` (`sozai/packages/event/src/index.ts:146-159`). So when the async
`'disposed'` listener's `await receiveClosed` rejects, that rejection propagates out through `emit` and
out of `transport.dispose()`. This is the **intended** contract and is consistent with the other two
disposal paths in this branch — `mux.dispose()` (`await iterator.return?.()`, uncaught) and
`peer.dispose()` (aggregates teardown errors) both surface a teardown failure to the caller. The Slice 2
guarantee is therefore the stronger one: `transport.dispose()` does not resolve until the drain close
has finished, *and* it rejects if that close failed.

The one hazard this introduces is on the **involuntary** paths (idle / abort / error / completion /
remote session-end with no following `dispose()`): they record `receiveClosed` but nobody awaits it, so
an async `return()` rejection there would be an unhandled rejection (a latent issue in the current
un-awaited `iterator.return?.()` at `transport.ts:298` as well). `releaseResources()` closes that by
attaching a no-op `catch` to the stored promise, which marks the rejection handled without preventing
the voluntary listener's separate `await` from still surfacing it.

**Construction-race: teardown before the hub-status listener exists (Finding A, found on re-review).**
The hub-status listener is registered *after* the transport is built —
`unsubscribeEvents = hub.events.on('status', …)` at `transport.ts:498`, below `new Transport(...)` at
`transport.ts:476`. But the readable's `start()` runs synchronously *during* that construction, and when
the transport is built with an **already-aborted** signal it calls `teardown()` right there
(`transport.ts:338-340`). So `releaseResources()` runs while `unsubscribeEvents` is still `undefined`,
sets `torndown = true`, and then execution continues to `transport.ts:489-509` and registers the
listener anyway — the `:489` block has no `torndown` guard (unlike the abort-handler block at
`transport.ts:478`, which is correctly skipped when the signal is pre-aborted). The listener then leaks:
nothing will ever call `unsubscribeEvents`. This is pre-existing, but it is exactly the
"full cleanup on every path" property this slice claims, so it is fixed here. **Fix:** guard the
registration block so a transport already torn down never registers the listener:

```ts
if (!torndown && reconnectTimeoutMs != null && hub.events != null) {
  // …existing armReconnectTimer + hub.events.on('status', …) …
}
```

With the guard, a pre-aborted construction tears down and registers nothing; a normal construction
registers as before (torndown is false at that point) and later teardown paths remove it through
`releaseResources()`.

**Bounded-`return()` — what the iterator actually is.** Both `subscription`s come from `hub.receive(...)`;
for the real hub (`HubClient`) that is an enkaku RPC channel (`hub-client/src/client.ts:119-123`,
`createChannel('hub/v1/receive', …)`), whose `.return()` closes the channel — local teardown plus at
most a fire-and-forget wire close, not a fresh blocking round trip. This is the bounded-ness the await
relies on. A hub whose `receive` iterator made `.return()` block on unbounded I/O would turn this await
into a slow `dispose()`; that is the accepted boundary (a new residual if it ever arises), the same
shape as the residuals branch's documented boundaries.

## Slice 3 — clear the stale `inboxLane` reference on dispose

**File:** `packages/rpc/src/peer.ts` (`dispose`).

`inboxLane` (`peer.ts:381`, set only in `buildEpoch` at `peer.ts:573`) closes over the mux and holds
`{ topicID, path }`. `teardownEpoch()` clears `runtimes` but never `inboxLane`, so a disposed peer
retains a reference to an obsolete inbound path. The residual #7 publish guards already block anything
the stale lane could actually do, so this is a cleanliness fix, not a correctness one.

**Fix.** Clear it in `dispose()` — `inboxLane = undefined`. It goes on the **unconditional cleanup
path**, not after a call that can throw: placing it merely after `await teardownEpoch()` would skip it
whenever teardown rejects (`peer.ts:636`). Slice 1's rewrite already positions it correctly — the
`inboxLane = undefined` line sits after both `try/catch` blocks and before the aggregated throw, so it
runs whether or not either teardown step failed. Put it in `dispose()` (not `teardownEpoch()`) so the
rotation path is untouched: `rebuildEpoch()` relies on `buildEpoch()` re-setting `inboxLane`, and there
is no reason to clear-then-rebuild it on every rotation. On `dispose()` there is no rebuild, so the
reference is simply dropped.

## Slice 4 — concurrent `dispose()` must share one in-flight disposal (Findings B + C, found on re-review)

**Files:** `packages/rpc/src/hub-mux.ts` (`dispose`, ~741), `packages/rpc/src/peer.ts` (`dispose`, ~2060).

Both `dispose()` methods are now *awaitable work* (Slice 2 makes the mux await `iterator.return()`;
Slice 1 makes the peer collect errors across two awaited steps). Their idempotency has not kept up:

- **mux (`hub-mux.ts:742`)** guards on a bare boolean — `if (disposed) return; disposed = true`. A
  second `dispose()` arriving while the first is still awaiting `iterator.return()` returns an
  immediately-resolved promise: it reports "disposed" before the drain is actually closed, and never
  sees a `return()` rejection the first call will observe.
- **peer (`peer.ts:2060`)** has *no* idempotency return at all — a concurrent second `dispose()` re-runs
  the whole body, calling `teardownEpoch()` a second time on already-cleared `runtimes` and awaiting
  `settled`/`mux.dispose()` again.

**Fix: a shared in-flight promise, memoized on first call.** Each `dispose()` becomes a synchronous
function that, on first call, runs the eager prologue that must stay synchronous, starts the async body
once, memoizes its promise, and returns that same promise to every later caller — so all callers await
the same completion and observe the same outcome (resolution or rejection).

mux:

```ts
let disposePromise: Promise<void> | undefined
dispose: () => {
  if (disposePromise != null) return disposePromise
  disposed = true          // synchronous-first: other guards read `disposed` immediately
  publishSuspended = true
  disposePromise = (async () => {
    for (const wake of [...sleeping]) wake()
    pending.clear()
    for (const sink of [...sinks]) { sink.close(); sinks.delete(sink) }
    refcount.clear()
    listeners.clear()
    await iterator.return?.()   // Slice 2's await lives here
  })()
  return disposePromise
}
```

peer:

```ts
let disposePromise: Promise<void> | undefined
dispose: () => {
  if (disposePromise != null) return disposePromise
  disposed = true              // synchronous-first (residual #7 invariant)
  mux.suspendPublishing()      // synchronous-first, before any await (residual #7 invariant)
  disposePromise = (async () => {
    await settled
    // …existing unsubscribe / recovery-drain / timer-and-waiter clears, unchanged…
    const disposeErrors: unknown[] = []
    try { await teardownEpoch() } catch (error) { disposeErrors.push(error) }
    try { await mux.dispose() } catch (error) { disposeErrors.push(error) }
    inboxLane = undefined                     // Slice 3, unconditional
    if (disposeErrors.length === 1) throw disposeErrors[0]
    if (disposeErrors.length > 1) throw new AggregateError(disposeErrors, 'Peer dispose failed')
  })()
  return disposePromise
}
```

- The eager prologue (`disposed = true`, `mux.suspendPublishing()` / `publishSuspended = true`) still
  runs synchronously on the first call, before the returned promise's body is scheduled — preserving the
  residual #7 ordering invariant (suspend publishing before anything is awaited). A concurrent second
  caller skips the prologue and receives the memoized promise.
- The method's external type is unchanged: it still returns `Promise<void>`; the `async` keyword just
  moves from the method to the inner IIFE.
- Peer's `dispose()` calls `mux.dispose()`, which is itself now memoized — consistent: whichever call
  first reaches the mux starts its single disposal; the other awaits the same promise.
## Testing

- **Slice 1 (correctness — the load-bearing one):** a peer whose child disposal rejects. Build a peer,
  make one child's `dispose()` reject (a runtime whose directed client / bus server / acceptor / client
  throws on dispose), call `peer.dispose()`, and assert **both**: (a) `mux.dispose()` ran (spy /
  observable mux teardown effect — e.g. the mux refuses or its drain stopped), and (b) `peer.dispose()`
  still rejected with the `teardownEpoch()` `AggregateError` (unwrapped — `length === 1`). Add a second
  case where **both** `teardownEpoch()` and `mux.dispose()` reject, and assert the rejection is an
  `AggregateError` carrying both. Mutation-checks: (i) replacing the error-collecting blocks with a plain
  sequential `await teardownEpoch(); await mux.dispose()` must fail assertion (a); (ii) reverting to a
  bare `try { await teardownEpoch() } finally { await mux.dispose() }` must fail the both-reject case
  (the `finally` throw would replace the teardown error, so the surfaced error would be only
  `mux.dispose()`'s).
- **Slice 2:** a receive-drain double whose `iterator.return()` resolves on a delayed tick. For hub-mux,
  assert `mux.dispose()` does not resolve until `return()` has resolved. For the transport, assert
  `transport.dispose()` does not resolve until the drain's `return()` has resolved (drive it through
  enkaku `dispose()` → `'disposed'`). Cover **both** iterator-close routes: (a) the ordinary path where
  `dispose()` triggers `teardown`, and (b) the case where a remote `session-end` frame closes the
  iterator first (`:390-404`) and a `dispose()` follows — assert the `'disposed'` listener still awaits
  the real close the session-end path recorded (a delayed return there must delay `dispose()`
  resolution).
- **Slice 2 rejection propagation + unhandled-safety (Finding D):** (a) a drain double whose
  `iterator.return()` *rejects*; assert `transport.dispose()` rejects with that error (it propagates
  through `emit`'s rethrow). (b) An involuntary path (idle timeout or abort) whose `iterator.return()`
  rejects with **no** following `dispose()`; assert no unhandled rejection surfaces (the no-op `catch`
  in `releaseResources()` handles it). Mutation-check: dropping that `void Promise.resolve(rawClose).catch(…)`
  guard must trip an unhandled-rejection detector in the involuntary case.
- **Slice 2 cleanup-bypass (new — the leak fix):** after each inline `torndown` path runs
  (`iterator.next()` rejection, `result.done` completion, remote `session-end`), a following
  `transport.dispose()` must still run the full cleanup. Assert that the reconnect timer is cleared, the
  hub-status listener (`unsubscribeEvents`) and abort listener are removed, and `hub.unsubscribe` is
  called — none of which the inline paths do themselves. Mutation-check: keeping the old inline partial
  cleanup (only `clearIdleTimer`) instead of routing through `releaseResources()` must fail these
  assertions. Also assert the `session-end` ack ordering is preserved: `ackHandled` is observed before
  the iterator's `return()` resolves.
- **Slice 2 construction-race (Finding A):** build a transport with an **already-aborted** signal so
  `start()` tears down synchronously during construction, then assert the hub-status listener was never
  left registered — e.g. a subsequent `hub.events` `'status'` emission arms no reconnect timer, and the
  transport holds no `unsubscribeEvents`. Mutation-check: removing the `!torndown` guard on the
  `:489` registration block must fail this (the listener registers post-teardown and leaks).
- **Slice 2 exception-safety (Finding E):** a transport whose `unsubscribeEvents` (or `iterator.return`)
  throws synchronously; assert `releaseResources()` still completes the rest of the cleanup (reconnect
  timer cleared, abort listener removed, `hub.unsubscribe` scheduled). Mutation-check: dropping the
  try/catch around the unrestricted call must strand the later cleanup.
- **Slice 4 (concurrent dispose):** call `dispose()` twice without awaiting the first, against a mux/peer
  whose `iterator.return()` (mux) or child disposal (peer) resolves on a delayed tick. Assert both
  returned promises settle together (the second does not resolve early) and both observe the same outcome
  — including the same rejection when disposal rejects. Assert the disposal body ran once (e.g.
  `teardownEpoch` / `iterator.return` invoked a single time). Mutation-checks: reverting mux to
  `if (disposed) return` must let the second call resolve before `return()` settles; removing peer's
  memo must re-invoke `teardownEpoch()` on the second call.
- **Slice 3:** after `peer.dispose()`, the stale `inboxLane` is gone. As it is a private closure var
  with no getter, assert it indirectly: the practical guarantee is already covered by the #7 guards, so
  this slice's test is light — confirm dispose still completes cleanly and `.to()` after dispose is
  refused (by `assertLive`, unchanged), documenting that the reference is dropped.
- Run the full `@kumiai/rpc` and `@kumiai/hub-tunnel` suites forced (`Cached: 0`); no port contract
  changes, so the conformance suites need no re-run for correctness.

## Branch strategy

This work depends on the dispose/ordering-residuals branch (`fix/dispose-ordering-residuals`, PR #35,
unmerged) — it edits the same `dispose()` tail (the `suspendPublishing()`/`teardownEpoch()`/`mux.dispose()`
region that branch introduced). Branch off `fix/dispose-ordering-residuals` (stacked), and either target
the new PR at that branch or rebase onto `main` once #35 merges. Branching from `main` instead would
conflict at the `dispose()` tail.

## Out of scope

All three originally-filed hazards are addressed, plus everything spec review surfaced in the same
disposal paths: the teardown-cleanup-bypass leak, the construction-race listener leak, and
`releaseResources()` exception-safety (all Slice 2), and concurrent-dispose idempotency (Slice 4). Should
Slice 2's bounded-`return()` assumption ever break (a hub whose `iterator.return()` does unbounded I/O),
that would be a new residual, not a change to this design. A `return()` *rejection* on the voluntary
`transport.dispose()` path is surfaced to the caller (Finding D — `@sozai/event`'s `emit` rethrows), in
line with `mux.dispose()`/`peer.dispose()`; the involuntary paths guard the same rejection against
becoming unhandled but do not surface it (no caller to surface it to).
