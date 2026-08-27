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
about `dispose()` not fully finishing what it starts.

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

**Fix.** Wrap the teardown so `mux.dispose()` runs unconditionally, then let the error propagate:

```ts
try {
  await teardownEpoch()
} finally {
  await mux.dispose()
}
```

- `mux.dispose()` always runs (the leak is closed).
- The `AggregateError` still propagates out of `dispose()` after the mux is cleaned up (decision:
  **still throw** — a host disposing a peer learns a child failed to tear down; nothing leaks either
  way). This matches `teardownEpoch()`'s existing contract on the rotation path.
- **No reorder.** Children hold and use the mux, so they must be disposed before it; `mux.dispose()`
  stays last. Only the guarantee that it runs changes.

## Slice 2 — `dispose()` should resolve only after the receive drain is closed

**Files:** `packages/rpc/src/hub-mux.ts` (`dispose`, ~763), `packages/hub-tunnel/src/transport.ts`
(`teardown` ~298 and the `'disposed'` listener ~485).

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
`transport.dispose()`. The fix threads the receive-close promise through that one listener:

- In `teardown`, capture the return promise instead of dropping it:
  ```ts
  // module-scoped: let receiveClosed: Promise<unknown> | undefined
  receiveClosed = iterator.return?.() ?? undefined
  ```
- Make the `'disposed'` listener (`transport.ts:485`) async and await it after teardown:
  ```ts
  transport.events.on('disposed', async () => {
    teardown()
    await receiveClosed
  })
  ```

This gives `transport.dispose()` — the voluntary, awaitable disposal — the "receive closed" guarantee,
while the involuntary teardown paths (abort/idle/error) stay synchronous and best-effort, unchanged.
`teardown`'s existing `torndown` idempotency guard means a teardown already run by another path has
already set `receiveClosed`; the listener still awaits whatever is there.

## Slice 3 — clear the stale `inboxLane` reference on dispose

**File:** `packages/rpc/src/peer.ts` (`dispose`).

`inboxLane` (`peer.ts:381`, set only in `buildEpoch` at `peer.ts:573`) closes over the mux and holds
`{ topicID, path }`. `teardownEpoch()` clears `runtimes` but never `inboxLane`, so a disposed peer
retains a reference to an obsolete inbound path. The residual #7 publish guards already block anything
the stale lane could actually do, so this is a cleanliness fix, not a correctness one.

**Fix.** Clear it in `dispose()` — one line, `inboxLane = undefined`, after the teardown. Put it in
`dispose()` (not `teardownEpoch()`) so the rotation path is untouched: `rebuildEpoch()` relies on
`buildEpoch()` re-setting `inboxLane`, and there is no reason to clear-then-rebuild it on every
rotation. On `dispose()` there is no rebuild, so the reference is simply dropped.

## Testing

- **Slice 1 (correctness — the load-bearing one):** a peer whose child disposal rejects. Build a peer,
  make one child's `dispose()` reject (a runtime whose directed client / bus server / acceptor / client
  throws on dispose), call `peer.dispose()`, and assert **both**: (a) `mux.dispose()` ran (spy /
  observable mux teardown effect — e.g. the mux refuses or its drain stopped), and (b) `peer.dispose()`
  still rejected with the `AggregateError`. Mutation-check: replacing the `try/finally` with a plain
  sequential `await teardownEpoch(); await mux.dispose()` must fail assertion (a).
- **Slice 2:** a receive-drain double whose `iterator.return()` resolves on a delayed tick. For hub-mux,
  assert `mux.dispose()` does not resolve until `return()` has resolved. For the transport, assert
  `transport.dispose()` does not resolve until the drain's `return()` has resolved (drive it through
  enkaku `dispose()` → `'disposed'`). Confirm the involuntary paths (abort/idle) are unaffected.
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

Nothing carved out here — all three filed hazards are addressed. Should Slice 2's bounded-`return()`
assumption ever break (a hub whose `iterator.return()` does unbounded I/O), that would be a new
residual, not a change to this design.
