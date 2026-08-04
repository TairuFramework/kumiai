# Guard the rendezvous responder lane against a fired reply timer

Residual 5 from `docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md`, opened by
the final review of `test/pin-dispose-lane-guards` on 2026-08-04.

## The problem

`@kumiai/rpc`'s peer answers two kinds of rendezvous request. Each handler schedules a
`setTimeout(getReplyDelayMs())`, and the timer's callback deletes itself from its pending set as its
FIRST statement before entering an async IIFE:

- `handleRecoveryRequest` (`peer.ts:879-907`) — `await port.sealGroupInfo(...)`, then `mux.publish`.
- `handleLedgerRequest` (`peer.ts:951-976`) — `await port.isLedgerComplete()`, `await
  port.sealLedger(...)`, then `mux.publish`.

`dispose()` clears `pendingReplies` and `pendingLedgerReplies` (`peer.ts:2061-2063`). That covers a
timer that has not fired. It cannot cover one that has: the callback removed itself from the set
before `dispose()` ever walked it — too late by construction, not by race. The IIFE is then several
real MLS awaits away from its publish, and nothing downstream stops it. `mux.publish` carries no
disposed check (`hub-mux.ts:665-679`), `assertSubscribable` only throws on a `'refused'` subscription
(`:391-394`), and `dispose()`'s `rendezvousUnsubscribe?.()` drops only a local refcount, leaving the
subscription standing.

What escapes is not incidental: `handleRecoveryRequest` publishes a sealed GroupInfo, and
`handleLedgerRequest` publishes the group's whole authenticated ledger — from a peer whose host has
already torn it down.

## What is NOT open

Verified before designing, because the residual's phrasing ("the lane has no check") is broader than
the hole:

- **No post-dispose frame reaches `onRendezvousMessage`.** `mux.onInbound` returns a closure that
  removes the listener from the topic's set (`hub-mux.ts:407-431`), and `dispose()` calls it. An
  entry-level check would be dead code guarding a window that does not exist.
- **A scheduled-but-unfired timer is already handled** by the existing `clearTimeout` sweep.
- **The requester-side handlers do not publish.** `handleRecoveryReply` and `handleLedgerReply`
  resolve waiters, and `dispose()` already drains and clears those maps.

The single open window is a fired timer mid-IIFE. The guard goes there and nowhere else.

## Source change

One line per responder, immediately before its `mux.publish`:

```ts
const sealed = await port.sealLedger(request.request)
// This timer fired BEFORE dispose, so it had already deleted itself from
// `pendingLedgerReplies` when dispose()'s clear sweep walked it — too late by construction,
// not by race. Silent, like `onCommitDelivery`: there is no caller to tell, and the catch
// below would swallow a throw anyway.
if (disposed) return
await mux.publish({ ... })
```

Placed after the seal rather than before it. The seal is local, read-only, and already inside the
handler's `try`, so running it for a disposed peer wastes work but reaches nothing; the publish is
the only hub contact, so the check belongs against it. A second check before the seal would guard a
window whose whole cost is that wasted local work.

`assertLive`'s doc block records the rule's third form, and the sentence added on
`test/pin-dispose-lane-guards` pointing at residual 5 comes back out.

## The tests

Two, appended to `packages/rpc/test/peer-dispose-race.test.ts` — one per guard. One test for both
would leave the other guard deletable with the suite green, which is the exact defect this line of
work exists to correct.

Both use the same staging, which mirrors Test C's gate on that branch:

- **Bob is the responder under test.** `recovery: { getDelayMs: () => 0 }` so his reply timer fires
  promptly; a `createRecordingHub` wrapper over the shared `FakeHub`; and an MLS port spread over
  `createMemoryGroupMLS` whose `sealLedger` (or `sealGroupInfo`) sets `entered = true`, awaits a
  gate, then delegates. Gating the seal rather than the publish means only the seal's return and the
  guard run after the gate opens.
- **Alice is the requester**, on the bare `FakeHub`. Built with the incomplete-ledger pattern at
  `peer-dispose-heal.test.ts:59-88`: a rejoin against a responder that withholds the last ledger
  entry, leaving her permanently incomplete. Her `replay()` publishes a ledgerRequest; her
  `recover()` publishes a recoveryRequest.
- **Sequence.** Alice requests. Bob's timer fires and blocks in the seal. `await bob.peer.dispose()`.
  `recorder.start()`. Open the gate. Flush. Assert.

Only Bob gets the recording wrapper, per the fixture's one-peer rule — a second live peer's
publish/fetchTopic/subscribe traffic would land in the recording and the assertion could never be
empty.

### The anti-vacuity bite

Each test asserts `expect(entered).toBe(true)` alongside `expect(recorder.calls()).toEqual([])`.

This is the second assertion Test C could not have. Its observable was pure absence, so if the
delivery ever stopped arriving the recording would be empty and the test would pass for nothing —
the one real vacuity risk the `test/pin-dispose-lane-guards` final review left standing. Here the
gated seal is proof the timer fired and the IIFE ran, so a delivery that stops arriving turns the
test red instead of quietly green.

## Verification

Per guard, separately — deleting both at once is how the original three shipped unpinned:

- Delete `handleLedgerRequest`'s check. Expect exactly its own test to fail, naming
  `publish:<rendezvous>`. Restore, confirm green.
- Same for `handleRecoveryRequest`'s.

Then `pnpm exec turbo run test:types test:unit --filter=@kumiai/rpc --force` with `Cached: 0`
confirmed, and the whole-repo gate before merge. Do NOT use `pnpm run test -- --filter X --force`:
pnpm forwards both flags to each package's vitest and tsc, which die on `CACError: Unknown option
--filter` and `tsc error TS5023`, and nothing is filtered.

## Out of scope

- **`mux.publish`-level guarding.** Refusing publishes after `mux.dispose()` would close this class
  for every lane at once, but `dispose()` disposes the mux LAST, after `teardownEpoch()`, so the
  window would stay open unless that order changes — and `mux.dispose()` deliberately leaves
  subscriptions standing. A broader change than this residual justifies.
- **The requester-side reply handlers**, per "What is NOT open".
- **Residual 3 and 4** stay in `next/`. Residual 5 is deleted from it on completion.

## Risks

1. **Spreading the MLS port.** `createMemoryGroupMLS` returns an object literal, so
   `{ ...bobMLS, sealLedger: ... }` carries every other method by own-property copy. If the fixture
   ever returns a class instance or uses a prototype, the spread silently drops methods and the test
   fails at an unrelated call. It would fail loudly, not vacuously.
2. **`getDelayMs: () => 0` still yields a macrotask.** The timer fires on the next tick, not
   synchronously, so the test must flush between Alice's request and its dispose. If the flush is
   too short, `entered` is false and the new assertion catches it — which is what it is for.
3. **`handleLedgerRequest` checks `isLedgerComplete()` before sealing.** Bob must be complete or the
   handler returns before reaching the gate. The setup commits a ledger entry on Bob first, exactly
   as `peer-dispose-heal.test.ts` does.
