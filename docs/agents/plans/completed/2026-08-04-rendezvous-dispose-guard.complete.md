# Guarding the rendezvous responder lane

**Status:** complete
**Date:** 2026-08-04
**Branch:** `fix/rendezvous-dispose-guard`

## What this was

Residual 5, opened by the final review of `test/pin-dispose-lane-guards` and closed here. That
branch pinned the peer's lane guards and added the one `onCommitDelivery` never had; it left the
rendezvous responder lane with no post-dispose check at all.

`onRendezvousMessage`'s two responders — `handleRecoveryRequest` and `handleLedgerRequest` — each
schedule a `setTimeout` whose callback deletes itself from its pending set (`pendingReplies` /
`pendingLedgerReplies`) as its FIRST act, then runs an async IIFE through real MLS awaits
(`sealGroupInfo` / `sealLedger`) before `mux.publish`. A timer that has already fired when
`dispose()` runs is therefore *gone from the set the `clearTimeout` sweep walks* — too late by
construction, not by race. `mux.publish` carries no disposed check of its own. The result was a
sealed GroupInfo, or the group's whole sealed ledger, published from a peer its host had torn down.

## The design decisions worth keeping

**The guard goes against the publish, not the entry point.** An entry-level check in
`onRendezvousMessage` would be dead code: `mux.onInbound` returns a closure that removes the
listener, `dispose()` calls it, and the drain snapshots its listener set and dispatches with no
await in between — so no post-dispose frame can reach the responder at all. Only the
fired-timer-mid-IIFE window is open, and only the publish escapes the peer.

**Silent `return`, not `assertLive()`.** This is the inbound form of the peer's post-dispose rule,
the same call `onCommitDelivery` made: a reply timer has no caller to reject, and the responder's
own `catch {}` would swallow a throw. Host-facing entry points still refuse loudly.

**Scoped deliberately short of `mux.publish`.** Guarding at the mux would close a wider class of
post-dispose traffic, and was left out of scope both here and on the previous branch. What that
leaves open is now recorded as residual 7 rather than living only in this branch's design notes.

## What shipped

Two `if (disposed) return` statements in `packages/rpc/src/peer.ts`, one test per guard in
`packages/rpc/test/peer-dispose-race.test.ts` (now 10), and the documentation to match. Patch-level
for `@kumiai/rpc` — intent recorded in `.changeset/`.

Each test gates the responder's MLS seal, so its reply timer fires and parks mid-seal; the peer is
then disposed, the gate released, and the test asserts the peer wrote nothing to the hub.

## What the process caught, worth remembering

- **Per-guard mutation checks, run separately, are the deliverable.** Two guards landing on one
  branch is exactly how the previous branch's three shipped unverified — deleting all three at once
  left the suite green. Deleting the ledger guard alone fails only the ledger test; deleting the
  recovery guard alone fails only the group-info test. Both were re-run independently of the
  implementer's report.
- **An anti-vacuity witness needs to cover the whole window, not its opening.** Both tests
  originally latched a flag when the seal was *entered*, before dispose. That proves the window
  opened; it says nothing about whether the parked continuation ever resumed to reach the guard — so
  a continuation that silently never ran would leave the recording empty and the test would pass for
  nothing. The final review caught it. A second latch, set after the gate and asserted after the
  post-gate flush, closes it.
- **Do not swap that flush for a poll on the new witness.** Unguarded, the publish lands *after* the
  resumed flag flips, so asserting the moment it goes true can observe an empty recording before the
  publish arrives — a false pass worse than the defect. The witness is an added assertion, never a
  replacement for waiting.
- **The branch wrote a false claim about itself, again, and was caught again.** The fix wave's own
  text asserted the residuals doc "records only residuals 3 and 4" while the same commit added
  sections 6 and 7 to it. Same defect class as the previous branch's two worst findings. Corrected
  rather than parked.
- **A plan's size tripwire must count the comments the plan itself mandates.** This plan gated on
  `peer.ts` being "+6 −2 or thereabouts" and a correct implementation came out +13 −4, because the
  estimate omitted the comment blocks the plan prescribed verbatim. The tripwire fired on correct
  work; the implementer was right to report rather than reconcile.
- **Parked deliberately:** the recovery test's fixed post-gate flush. Replacing it with a bounded
  poll would mean either duplicating the `waitFor` helper from `peer-cursor-table.test.ts` into a
  second file or extracting a fixture and touching an unrelated test file. The current form fails
  loudly rather than vacuously. Worth revisiting whenever that file is next opened for another
  reason.

## Follow-on

Two further post-dispose windows were found while verifying this one, and are filed as residuals 6
and 7 in `docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md`: an in-flight ledger
waiter that writes host MLS state after dispose, and a lane operation already past its entry guard
that still reaches `mux.publish`. Neither publishes anything this branch's scope covered; both are
described in full there. Residuals 3 and 4 remain open in the same file, untouched and not
renumbered.

Background: `docs/agents/plans/completed/2026-08-04-pin-dispose-lane-guards.complete.md`.

## Scope

Two production lines plus their comments; everything else is tests, records and a changeset.

Verified at completion: `@kumiai/rpc` 396/396 with `Cached: 0`, whole-repo 44/44 turbo tasks forced,
integration suite 43/43, lint clean over 315 files, and both per-guard mutation checks re-run.
