# Question 5.2 — report

Both Criticals fixed in `packages/rpc/src/peer.ts`. `packages/mls` untouched, no `HubStore` change.
Only one source file changed (`peer.ts`, +58/-9) plus two new test files. Not committed.

Base: `8884e11` (green). Verify (repo root, via `rtk proxy`): **build 7/7, lint clean (195 files),
test 27/27 tasks** — rpc **171 passed / 1 skipped**, mls **298 passed**, hub-tunnel 63, hub-client 5.

---

## Critical 1 — a failed heal cleared its own trigger

### The red (captured, against unmodified HEAD)

New parametrised test `test/peer-failed-heal-strand.test.ts`, `{own-unmerged, ahead, fork-losing} ×
{no responder, responder answers}`. Against unmodified source:

```
× a frame framed ahead of it: no responder — commit() refuses, and nothing lands
× the losing side of a fork: no responder — commit() refuses, and nothing lands
  (own-unmerged / no responder: PASSED — self-restoring, as the brief predicted)
  (all three "responder answers" controls: PASSED)
AssertionError: promise resolved "{}" instead of rejecting
```

The `ahead` case is the reviewer's exact reproduction (group at epoch 3, log trimmed with
`FakeHub.trim` to a single frame framed at epoch 3, Bob back at epoch 1, no responder): `commit()`
resolved a `LaneResult` instead of rejecting, Bob framed at epoch 1 against a head carrying epoch 3,
**won the compare-and-set**, and advanced onto a branch of one. `fork-losing` is the same fault from
the other trigger. `own-unmerged` was already safe because its row does not advance the cursor, so the
trigger re-fires on every pull.

### The fix, and why this one

**Built the distinct `stranded` flag, not the capture/restore of `healRequested`.**

`healRequested` conflates two jobs: *schedule the next heal* (consumed by `healIfRequested`, and
legitimately cleared as control flow — `recover()` clears it at the top of every attempt) and *refuse
commits because I have positive evidence I am off the group's line* (must survive a failed heal). The
minimal "capture at entry, restore on exit" does not actually work here: `healIfRequested` sets
`healRequested = false` **before** calling `recover()`, so a capture at `recover()`'s entry captures
`false` and restores `false` — the bug stands. Patching that by unconditionally re-setting the flag on
the no-responder/deadline exits over-corrects: it would strand a *healthy* peer whose pull during
`recover()` caught it up, or a host-initiated speculative `recover()`.

Splitting the concern removes the whole class of leak. `stranded` is:

- **Set** only by the three rows that are positive evidence — `own-unmerged` (711), `ahead` (719),
  `fork`-losing (735) — alongside the existing `healRequested = true`.
- **Cleared** in exactly one place: when a rejoin actually lands (`recover`, ~1400, where
  `healRequested = false` already sat). That is the only event that rebuilds the peer's place in the
  tree.
- **The sole guard** on `commit()` (~1171): `if (stranded)` throws `RecoveryRequiredError`.

This is provably correct because **no pull can carry a stranded peer back to the line**: log frames run
in non-decreasing epoch order (every accepted commit compare-and-sets at the head), so once a peer sees
a frame ahead of its epoch there is never another frame *at* its epoch behind it to apply; the frames
that would have carried it are trimmed or poison. The one apparent exception — `own-unmerged` resolved
by adopting a journalled commit — never sets `stranded`, because `replayJournal` runs strictly ahead of
`pullCommits` in *every* lane path (seed, wakeup, commit, replay, recover), so a landed own commit is
adopted before the pull ever classifies it as `own-unmerged`. Stranding is therefore always resolved by
a rejoin, and clear-on-rejoin-only is exact.

Also corrected the stale `pullCommits` doc (~626): "A pull that stops early … takes no tip at all" was
true only of `own-unmerged`; the `ahead` path steps over its frame, drains to the end, and **does**
record the live tip — which is precisely why the `stranded` flag, not a withheld tip, is what has to
stop the next `commit()`.

### Group-death hazard (Q3.4) — shown NOT reintroduced

The guard fires only on positive `ahead`-class evidence, **never on poison**. `stranded` is set in the
three trigger rows only; the poison paths (malformed, policy-refused, unresolvable bodies) advance the
cursor and touch neither flag. New test `poison is not evidence of being stranded` proves a peer that
has only stepped over a body-less frame **still commits** (lands the honest next commit behind the dead
frame, epoch 1 → 2). This is the distinction the log demands: in the case it fears, nobody resolves the
body-less frame, so the group never advances past that epoch and **no honest member ever sees an
`ahead` frame** — none is gated, and the group is not wedged. The existing cursor-table poison tests
(policy-refused, body-less, sender-lie) all still pass, unchanged.

### Mutation check A

Revert the guard to `if (healRequested)` (whole rpc suite):

```
× a frame framed ahead of it: no responder — commit() refuses, and nothing lands
× the losing side of a fork:  no responder — commit() refuses, and nothing lands
Tests  2 failed | 168 passed | 1 skipped
```

Red: exactly the two non-self-restoring rows under a failed heal. **Green (did not go red):**
`own-unmerged` no-responder (self-restoring), all three responder controls, the poison test, and every
other file — the two `stranded` sites in the rows are inert without the guard change, so nothing else
depends on it.

---

## Critical 2 — `dispose()` during an in-flight heal hung the lane

### The red (captured, against unmodified HEAD)

New test `test/peer-dispose-heal.test.ts`, `settles recover(), and the lane operation queued behind
it`:

```
× settles recover(), and the lane operation queued behind it
AssertionError: expected 'HUNG' not to be 'HUNG'
```

A `recover()` blocked in `requestGroupInfo` (no responder, long window) plus a `replay()` queued behind
it; `dispose()` fires mid-flight. `requestGroupInfo` resolves from only two places — a reply, or its
timeout — and `dispose()` clears that timeout (`recoveryTimers`) while never resolving
`recoveryWaiters`. So `recover()` never settled, `commitTail` never resolved, and the queued op hung
with it: `recover() after dispose: HUNG`.

### The fix

In `dispose()`, **before** clearing `recoveryTimers`, drain the waiters — call each with `null` and
clear the map — mirroring the timeout path. Order is deliberate (resolve first, then clear timers) so a
fired timer cannot race a half-drained map.

### Ledger-gather sibling — verified, does NOT hang

`ensureLedger`'s requester-side resolver is a **bare local `const timer`**, held in none of the four
collections `dispose()` clears (`recoveryTimers`, `pendingReplies`, `pendingLedgerReplies`, and the
`ledgerWaiters`/`suppressedRequests` maps). So `dispose()` removes the *waiter* (a late reply won't
resolve it) but leaves the timeout intact — it fires and settles `ensureLedger` on its own, bounded by
the gather deadline. This is the exact asymmetry with `requestGroupInfo`, whose timer **is** in
`recoveryTimers` and is therefore destroyed by the same cleanup. No drain added; **no code change to the
ledger gather.** Confirmed by test `the ledger gather settles on its own timer, needing no drain`
(rejoin against a lying responder → incomplete ledger → in-flight gather → dispose mid-wait → the queued
op still settles), which **passes on the unmodified source** — positive evidence it never depended on
the drain.

### Mutation check B

Remove the two drain lines from `dispose()` (whole rpc suite):

```
× settles recover(), and the lane operation queued behind it
Tests  1 failed | 169 passed | 1 skipped
```

Red: only the recover-hang test. **Green (did not go red):** the ledger-gather sibling (its own timer
settles it — the whole point of the sibling finding) and every other file.

---

## Stop conditions

Neither triggered. `stranded` cleanly distinguishes the states that must be distinguished (positive
evidence off the line vs. poison stepped over), so no design change was needed. Not committed.
