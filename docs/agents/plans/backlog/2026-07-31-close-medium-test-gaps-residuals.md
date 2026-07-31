# Residuals from closing the medium test gaps

**Priority:** medium for 1 and 2 (both are unpinned or unguarded post-dispose paths in shipped
`@kumiai/rpc`), low for 3 and 4.
**Origin:** the whole-branch review of `test/close-medium-test-gaps`, 2026-07-31. Four items
triaged out of scope for that branch's final fix wave. Background:
`docs/agents/plans/completed/2026-07-31-close-medium-test-gaps.complete.md` and the retired doc
`docs/agents/plans/next/2026-07-07-test-gaps.md`.

## 1. `replay` and `recover` post-dispose guards are unpinned

`peer.ts` gained `assertLive()` at eight entry points on that branch. Three of them sit on the lane
calls: `commit` (`:1629`), `replay` (`:1762`) and `recover` (`:1827`). Deleting all three
simultaneously in a throwaway worktree left the whole rpc suite green — 390/390. So the guards
themselves were shipped unverified.

`commit` is now pinned: `packages/rpc/test/peer-dispose-race.test.ts`, describe "dispose against a
commit made afterwards", asserts a post-dispose `commit()` rejects *and* writes nothing to the hub.
With `assertLive()` removed from `commit` alone it fails, showing four real hub calls
(`fetchTopic:<commit-topic>`, `fetchTopic:<rendezvous>`, `publish:<commit-topic>`,
`fetchTopic:<rendezvous>`). `replay` and `recover` are **not** pinned — deleting either guard still
leaves the suite green.

`commit` was done first because it is the one with damage that escapes the process: it publishes.
`replay` and `recover` are read-and-heal paths, so what an unguarded one costs is smaller and needs
establishing before a test is written for it. The work is: determine what each observably does
post-dispose (the `commit` test's recording-wrapper shape is the tool), then either pin it or
record why it cannot be pinned — the Task 8 pattern.

Do not extract a shared recording fixture while doing this. Three inline `FakeHub` wrappers already
exist across this package's tests and each records different fields; a shared recorder gaining a
parameter per caller is worse. Adjudicated twice — ledger Task 4 and the final review.

## 2. `onCommitDelivery` reaches `rebuildEpoch()` with no disposed check

`onCommitDelivery` (`peer.ts:1348-1358`) awaits `ready` and may then call `rebuildEpoch()`, with no
`assertLive()`. A delivery already queued in `runSerial` when `dispose()` awaits `settled` reaches
the same post-dispose rebuild the branch's fix now refuses at every host-facing entry. Pre-existing,
same class as the bug that fix closed — it is simply not host-facing, so the fix's rationale
("a disposed peer refuses everything a *host* asks of it") does not cover it.

**Whoever closes this must revisit `peer-dispose-race.test.ts` first.** That file's
"dispose against an in-flight subscribe" test names this exact hole as load-bearing (`:115-122`):
`onCommitDelivery`'s unguarded rebuild is the *only* remaining way anything downstream of a
post-dispose rebuild can be observed by a caller, and the test uses it to reach
`onSubscribeFailed`. Guarding `onCommitDelivery` may make that test unable to reach its observable
at all. Decide deliberately whether the test is re-shaped, re-pointed at another observable, or
retired with the hole — do not let it fail and get patched.

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

`peer.ts:732` throws a bare `Error`. This package exports named error classes for exactly the
conditions callers act on (`commit.ts:153,168,192`), and "the peer is disposed" is one a caller
plausibly branches on — retry against a fresh peer, versus surface to the user.

Left as-is deliberately: it is consistent with its immediate neighbours (`peer.ts:668,688`), so
changing this one throw in isolation would make the package *less* internally consistent, not more.
This is a package-wide decision about which failures get named classes, not a local one — take it
with `docs/agents/plans/backlog/rpc-api-surface.md` rather than on its own.

Note for whoever takes it: both dispose tests currently assert `/disposed/i` against the message
prose (`peer-dispose-race.test.ts`), so a named class is an opportunity to make them assert on a
type instead. Until then, the message string is load-bearing.
