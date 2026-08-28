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
about `dispose()` not fully finishing what it starts. Spec review surfaced a fourth, closely related
leak — transport teardown paths that set `torndown` inline and skip the real cleanup — folded into
Slice 2 since it lives in the same code the drain-await fix touches.

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

**Fix.** Run both unconditionally, collect whatever each throws, then surface it:

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

**hub-mux (`dispose` is already async).** One-liner:

```ts
await iterator.return?.()
```

as the last statement of `dispose()`, replacing the un-awaited call.

**hub-tunnel transport (`teardown` is deliberately synchronous).** `teardown` is fired from ~8
synchronous sites (idle timer, signal abort, readable-pull error paths, writable `close`/`abort`,
and the enkaku transport's `'disposed'` event listener). It must **stay synchronous** — most of
those callers have no promise to await (an abort or idle timeout is best-effort by nature).

The authoritative *async* disposal boundary is enkaku's `Transport.dispose()`, which does
`await this.#events.emit('disposed', …)` (`enkaku/packages/transport/src/index.ts:80`), and
`@sozai/event`'s `emit` awaits its listeners via `await Promise.allSettled(listeners.map(fn => fn(data)))`
(`sozai/packages/event/src/index.ts:146`). So a listener that returns a promise **is awaited** by
`transport.dispose()`. The fix threads the receive-close promise through that one listener.

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
  if (unsubscribeEvents != null) { unsubscribeEvents(); unsubscribeEvents = undefined }
  if (abortHandler != null && signal != null) {
    signal.removeEventListener('abort', abortHandler)
    abortHandler = undefined
  }
  // Ordered after `subscribed` (unchanged rationale, transport.ts:287-289):
  void subscribed.then(() => hub.unsubscribe?.(localDID, receiveTopicID)).catch(() => {})
  receiveClosed = iterator.return?.() ?? undefined
}
```

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
- **Slice 2 cleanup-bypass (new — the leak fix):** after each inline `torndown` path runs
  (`iterator.next()` rejection, `result.done` completion, remote `session-end`), a following
  `transport.dispose()` must still run the full cleanup. Assert that the reconnect timer is cleared, the
  hub-status listener (`unsubscribeEvents`) and abort listener are removed, and `hub.unsubscribe` is
  called — none of which the inline paths do themselves. Mutation-check: keeping the old inline partial
  cleanup (only `clearIdleTimer`) instead of routing through `releaseResources()` must fail these
  assertions. Also assert the `session-end` ack ordering is preserved: `ackHandled` is observed before
  the iterator's `return()` resolves.
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

All three originally-filed hazards are addressed, plus the teardown-cleanup-bypass leak surfaced during
spec review (folded into Slice 2 — the inline `torndown` paths that skipped `clearReconnectTimer`,
listener removal, and `hub.unsubscribe`). Should Slice 2's bounded-`return()` assumption ever break (a
hub whose `iterator.return()` does unbounded I/O), that would be a new residual, not a change to this
design.
