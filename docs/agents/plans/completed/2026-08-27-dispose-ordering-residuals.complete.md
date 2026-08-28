# Dispose & ordering residuals — completed

**Status:** complete
**Date:** 2026-08-27
**Packages:** `@kumiai/rpc`, `@kumiai/hub-tunnel`
**Branch:** `fix/dispose-ordering-residuals`

## Goal

Close four residuals (#3, #4, #6, #7) triaged out of earlier dispose/test-gap branches
and parked in `2026-07-31-close-medium-test-gaps-residuals` (now deleted): hub-tunnel
subscribe ordering, a named disposed error, a post-dispose ledger-write guard, and a
post-dispose publish guard.

## What was built

- **`PeerDisposedError` (#4)** — a named lifecycle error in `packages/rpc/src/errors.ts`
  (its own file, not `commit.ts`, so `hub-mux.ts` can import it without depending on
  `commit.ts`), thrown by `assertLive` with the message unchanged (`'Peer is disposed'`,
  non-breaking) and exported from `index.ts`. Test `/disposed/i` assertions upgraded to
  `instanceof`.
- **hub-tunnel subscribe ordering (#3)** — `transport.ts` captures the construction
  `hub.subscribe` in an async IIFE (preserving subscribe-before-`receive` call order while
  absorbing a synchronous throw), gates the first send on it with a second `torndown`
  re-check after the await, and orders teardown's `unsubscribe` after the subscribe settles.
  Closes: a caller that constructs a transport and immediately publishes could lose the
  first inbound reply on a real wire.
- **ledger-waiter post-dispose write guard (#6)** — two `disposed` guards in the
  `requestLedger` waiter IIFE in `peer.ts`: an early-out, and a decisive re-check after the
  `openSealedLedger` await, before `bootstrapLedger` (a write into the host-owned MLS handle).
  This waiter runs outside the commit mutex, so #7's guard does not cover it.
- **mux publish post-dispose guard (#7)** — a `publishSuspended` flag in `hub-mux.ts`
  guarding all three routes to the wire (`publish`, `bus.publish`, `mailbox.publish`);
  `suspendPublishing()` exposed on the mux; `peer.dispose` calls it right after
  `disposed = true`, before `await settled`.

## Key design decisions

- **`mls: GroupMLS` is host-passed, not peer-created.** A post-dispose write through that
  handle mutates state the host still references — this raised the stakes on #6 and #7 from
  "wasted work" to "corrupts host-shared state," and is why both got real guards + tests.
- **#7 guards the publish funnel; it does not drain the commit mutex.** Draining
  (`dispose()` awaiting the mutex) was rejected as unsafe: `build()` / `onAccepted()` are
  host-supplied callbacks that run inside the mutex with no bound, so the drain can hang
  `dispose()` indefinitely, and a host that disposes from inside its own callback
  self-deadlocks. Guarding the funnel awaits nothing — the in-flight op rejects with
  `PeerDisposedError`, matching the existing "disposed op rejects" idiom.
- **Accepted, documented boundaries (guard the entrance, not the in-flight call).**
  Both #6 and #7 stop work that has *not yet entered* the shared resource; they cannot recall
  a call already in flight. For #7, a publish already awaiting `hub.publish` is on the wire.
  For #6, an `openSealedLedger`/`bootstrapLedger` already entered can complete its host write
  after dispose returns — and because the waiter stays registered until `finish(true)`,
  several already-accepted replies can be mid-call. Closing either would require the same
  unbounded/deadlock-prone drain rejected for #7. Both are documented boundaries, not holes.
- **`suspendPublishing()` runs before `teardownEpoch()`**, so disposing a peer with an active
  directed session no longer emits a best-effort `session-end` frame (its `mux.mailbox.publish`
  now throws `PeerDisposedError`, swallowed by `sendSessionEnd`'s own `.catch`). The remote
  falls back to idle-timeout cleanup. A protocol-visible consequence, accepted.
- **Slice ordering:** `PeerDisposedError` (#4) landed first as a prerequisite — #7's mux guard
  throws it.

## Verification

- #6 and #7 guards are mutation-checked: each guard, when removed, fails exactly one test and
  only that test — including all three #7 publish routes independently, and both #6 guards
  (early-out and decisive re-check) covered by separate tests.
- `@kumiai/rpc` 401 tests, `@kumiai/hub-tunnel` 83 tests, all passing non-cached; lint and
  typecheck clean.
- Reviewed by the per-task and whole-branch code-review passes plus two external Codex rounds;
  every finding closed.

## Follow-on

Three out-of-scope dispose-teardown hazards surfaced during the work were filed separately as
`2026-08-27-dispose-teardown-hazards` in `next/` (teardownEpoch AggregateError skipping
`mux.dispose()`, un-awaited `iterator.return?.()`, and a residual `inboxLane` closure).
