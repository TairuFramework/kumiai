# Residuals from closing the medium test gaps

**Priority:** low.
**Origin:** the whole-branch review of `test/close-medium-test-gaps`, 2026-07-31. Four items were
triaged out of scope for that branch's final fix wave; residuals 1 and 2 were closed on
`test/pin-dispose-lane-guards`, 2026-08-03. Residual 5 was opened by that same branch's own final
review, 2026-08-04, not by the 2026-07-31 review, and closed the same day by
`fix/rendezvous-dispose-guard`. That same branch's own final review opened residuals 6 and 7,
2026-08-04, leaving 3, 4, 6 and 7 open. Background:
`docs/agents/plans/completed/2026-07-31-close-medium-test-gaps.complete.md` and the retired doc
`docs/agents/plans/completed/2026-07-07-test-gaps.complete.md`.

## 3. `createHubTunnelTransport` fires `hub.subscribe` fire-and-forget

`transport.ts:214-215` issues `void Promise.resolve(hub.subscribe(...)).catch(() => {})` and never
awaits it. Against an in-memory double that was a synchronous Set mutation. Against a real wire —
which `tests/integration/test/hub-tunnel-echo.test.ts` now uses — it is an RPC round trip, so there
is **no contractual guarantee** the subscription lands before the first publish on the same
transport. A caller that constructs a transport and immediately publishes can lose the first
inbound frame.

Empirically stable: the subscribe is issued during construction, several awaits before any request
reaches the hub, and the echo test was run 12/12 clean. The test carries a comment saying so. The
real fix is exposing the subscribe as something a caller can await (or gating the first send on
it), not tightening the test.

## 4. `'Peer is disposed'` is a plain `Error`

`peer.ts:735` throws a bare `Error`. This package exports named error classes for exactly the
conditions callers act on (`commit.ts:153,168,192`), and "the peer is disposed" is one a caller
plausibly branches on — retry against a fresh peer, versus surface to the user.

Left as-is deliberately: it is consistent with its immediate neighbours (`peer.ts:668,688`), so
changing this one throw in isolation would make the package *less* internally consistent, not more.
This is a package-wide decision about which failures get named classes, not a local one — take it
with `docs/agents/plans/backlog/rpc-api-surface.md` rather than on its own.

Note for whoever takes it: both dispose tests currently assert `/disposed/i` against the message
prose (`peer-dispose-race.test.ts`), so a named class is an opportunity to make them assert on a
type instead. Until then, the message string is load-bearing.

## 6. An in-flight ledger waiter writes host state after dispose

`requestLedger`'s waiter (`peer.ts:1609-1625`) registers a `ledgerWaiters` callback that runs an
async IIFE: `openSealedLedger`, then `bootstrapLedger(tokens)` — a write into the host's MLS handle.
`dispose()` calls `ledgerWaiters.clear()` (`peer.ts:2076`), but a callback already invoked before
that point is past the map, and its IIFE completes afterwards. Its only guard is the local
`if (settled) return` (`peer.ts:1612`), which tracks the gather's own resolution and says nothing
about `disposed`.

It publishes nothing, so it sits outside the "no publish after dispose" scope that
`fix/rendezvous-dispose-guard` and `test/pin-dispose-lane-guards` closed. But
`fix/rendezvous-dispose-guard`'s own plan described the requester-side reply handlers
(`handleRecoveryReply`, `handleLedgerReply`) as merely resolving waiters — this one also writes into
the host's group state after the host tore the peer down, which understates it.

Out of scope for now: no host-facing entry point exposes the MLS handle this mutates after dispose,
so the blast radius needs a design pass before it is worth guarding. Closing it needs
`bootstrapLedger` (or the `ledgerWaiters` callback wrapping it) to check `disposed`, plus a
mutation-checked test that parks the callback on `openSealedLedger` or `bootstrapLedger` the way
`peer-dispose-race.test.ts`'s rendezvous tests park `sealLedger` / `sealGroupInfo`.

## 7. A lane operation already past its guard still runs after dispose

`dispose()` awaits `settled` (`peer.ts:2059`) — `ready.catch(() => {})` (`peer.ts:2017`) — never the
commit mutex (`runSerial`, `peer.ts:840-850`). An operation that has already passed its entry guard
— `onCommitDelivery`'s `if (disposed) return` (`peer.ts:1367`), or `commit()` / `replay()` /
`recover()`'s `assertLive()` (`peer.ts:1645`, `:1778`, `:1843`) — keeps running inside the mutex and
can still reach `pullCommits` and `mux.publish` (`hub-mux.ts:665`, which carries no disposed check
of its own) after `dispose()` has returned.

The guards `fix/rendezvous-dispose-guard` and `test/pin-dispose-lane-guards` added close the
*entry* to each lane, not an operation already inside it when dispose runs.

Out of scope for now: closing this properly means guarding at `mux.publish` itself — the one point
every lane funnels through — which both branches deliberately kept out of scope. That is a bigger
change than a local check: it needs a design decision on what a disposed publish should do (throw
into an unawaited caller, log, or silently drop) before it can be built and mutation-tested.
