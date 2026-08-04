# Residuals from closing the medium test gaps

**Priority:** low.
**Origin:** the whole-branch review of `test/close-medium-test-gaps`, 2026-07-31. Four items were
triaged out of scope for that branch's final fix wave; residuals 1 and 2 were closed on
`test/pin-dispose-lane-guards`, 2026-08-03. Residual 5 was opened by that same branch's own final
review, 2026-08-04, not by the 2026-07-31 review, and closed the same day by
`fix/rendezvous-dispose-guard`, leaving only 3 and 4 open. Background:
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
