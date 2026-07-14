# Question 5.2 — a failed heal deletes its own trigger, and dispose during a heal hangs the lane

Repo `/Users/paul/dev/yulsi/kumiai`, branch `feat/control-ledger-lane`. **Tree is green and committed at
`8884e11`** (rpc 162 + 1 skipped, mls 298, 27/27). Two Criticals from the branch review, both
**reproduced against HEAD by the reviewer**, both in `packages/rpc/src/peer.ts`. Fix them together —
they are the same file and the same `recover()` / `dispose()` neighbourhood.

Read first: `packages/rpc/src/peer.ts` — `recover()` (~1300), `requestGroupInfo` (~1240), the cursor
rows in `pullCommits` (~700), `commit()`'s heal guard (~1136), `healIfRequested` (~1440), `dispose()`
(~1490), and `classify.ts`. Read `packages/rpc/test/peer-recover-lane.test.ts` and
`peer-cursor-table.test.ts` for the harness.

---

## Critical 1 — a failed heal clears `healRequested` and never restores it

`recover()` sets `healRequested = false` at the top of each attempt (`peer.ts:1316`) and does not
restore it on any failure exit: no responder → `break` (`1332`); unopenable reply → `continue`
(`1343`); deadline → the `return { advanced: false, reenact: [] }` at `1424`. Only the
ledger-incomplete path (`1405`) re-raises it. `healIfRequested` swallows the result (`~1445`).

**Why that is a fork, not a stall.** The `ahead` cursor row **advances the cursor** (`peer.ts` ~714)
and the drain then **takes the tip** — so after one pull, the peer's *only* evidence it is off the
group's line is the in-memory `healRequested` flag; the frames are behind the cursor and will never be
re-read, and `commitLogHead` is now the live head. `commit()`'s sole guard against racing at a stale
epoch is that same flag (`peer.ts:1136`). Clear it on a failed heal and the peer is indistinguishable
from a healthy one.

Reproduced against HEAD by the reviewer (group at epoch 3, log trimmed to a single frame framed at
epoch 3, Bob at epoch 1, **no responder online**):

```
commit() outcome: RESOLVED          <- expected RecoveryRequiredError
bob epoch after commit: 2
commit frames on the log: 2         <- he raced the head, and won
```

Bob published a commit framed at epoch 1 against a head carrying epoch 3, **won the CAS**, ran
`onAccepted`, and adopted. Nothing raised. **If that commit is an invite, `onAccepted` delivers a
Welcome and the invitee joins a branch of one.**

Contrast the `own-unmerged` row (`peer.ts` ~703), which does **not** advance the cursor — so its
trigger re-raises on every pull, self-restoring. That is why `peer-cursor-table.test.ts` ("a peer that
must recover before it can commit") passes: it covers the one row that happens to heal itself. **`ahead`
and `fork`-losing are not self-restoring, and no test exercises them under a failed heal.**

This is a live regression against a **recorded** hazard, not a new one. The Q3.4 decision log says the
self-fork "expires (the group's next commit is *ahead* of it, and the new row heals it)" — but that is
only true when a responder exists. `recover()`'s no-responder path is documented as "stays degraded,
and retries" (`peer.ts` ~196, and the spec heal-triggers section), and the code does the opposite: it
**forgets**. The trim strand — a member offline past the retention window — is the most likely way in,
and "nobody online right now" is the ordinary condition of a small group.

### The fix, and the trap in the obvious version

**`healRequested` must survive an unsuccessful heal.** The minimal change captures it at `recover()`'s
entry and restores it on every non-success exit. **Consider instead a distinct `stranded` flag** set by
the `ahead`, `fork`-losing and `own-unmerged` rows, cleared **only** on a successful rejoin
(`peer.ts:1395`) or when a pull actually carries the peer back to the group's line, with `commit()`
refusing while it is set. Weigh the two and say which you built and why.

**⚠️ Do NOT reintroduce the group-death hazard the Q3.4 log warns about.** That entry ("refuse to commit
at an epoch I skipped is worse than the bug — one unresolvable frame would kill the group permanently")
is about refusing on **suspicion**, and it is correct. This guard must refuse only on **positive
evidence** — the peer has actually seen a frame framed *ahead* of its own epoch, which by the design's
own reasoning is the one observation that proves the fault is its own. Verify the distinction holds in
your fix: in the case the log fears (nobody can resolve a body-less frame), the group never advances
past that epoch, so **no honest member ever sees an `ahead` frame** and none is gated. If your guard
gates a peer that has only seen *poison* (a frame it stepped over, never an `ahead`), you have rebuilt
the hazard — check it does not.

**Also fix the stale comment.** `pullCommits`'s doc (`peer.ts` ~620) claims "A pull that stops early —
on the frame it must heal for — takes no tip at all." True only of `own-unmerged`; the `ahead` path
drains to the end and takes the tip. Say so.

## Critical 2 — `dispose()` during an in-flight heal hangs the lane forever

`requestGroupInfo` (`peer.ts:1248`) resolves its promise from exactly two places: the reply handler,
and its own timeout — which `dispose()` clears (`recoveryTimers`). **`recoveryWaiters` is never
resolved and never cleared by `dispose()`.** So a `recover()` awaiting `requestGroupInfo` when
`dispose()` fires never settles; `commitTail` never resolves, and every lane operation queued behind it
is stuck too. `dispose()` is what backgrounding a mobile client calls, and a heal is what a returning
peer runs at startup — a routine interleaving.

Reproduced against HEAD: `recover() after dispose: HUNG`.

### The fix

In `dispose()`, **before** clearing `recoveryTimers`, drain `recoveryWaiters` — call each waiter with
`null` and clear the map, exactly as the timeout path does (`peer.ts:1254`). Check the same class of
bug in the **ledger** gather: `ledgerWaiters` and `pendingLedgerReplies` — is an in-flight
`ensureLedger` also left hanging by `dispose()`? The reviewer believed `ensureLedger`'s own timer
resolves it independently; **verify that** rather than trusting it, and if it too can hang, drain it the
same way. A resolve that relies on a timer another cleanup might clear is the exact shape of Critical 2.

## The tests — assert the belief, not the absence of an error

Both bugs are silent. Question 4.1 established the discipline: `recover()` with no responder resolves
`{ advanced: false }` **without throwing**, so "no error raised" is worthless here.

For Critical 1, the test the suite structurally lacks: **every heal trigger, under a failed heal.** A
parametrised test over `{own-unmerged, ahead, fork-losing} × {heal succeeds, no responder}`. Under a
failed heal the peer must **refuse to commit** — assert the `commit()` call rejects (or returns the
recovery signal), assert **no new frame appears on the log**, and assert the epoch did not advance onto
a private branch. The `ahead`-row + no-responder + trimmed-log combination is the reviewer's
reproduction and is not currently tested at all; `FakeHub` already has `trim` and the byzantine
controls you need.

For Critical 2: start a `recover()` that will find no responder within the deadline, call `dispose()`
while it is in flight, and assert **the `recover()` promise settles** (and that a lane operation queued
behind it also settles). Add the ledger-gather sibling if it hangs.

**Mutation-check each fix**: revert it, show the new test goes red, report what else went red — and what
did not.

## ⚠️ Wrong-but-passing

- **Asserting the heal "converged" or "raised no error."** It converges onto a fork. Assert the peer
  **did not commit** and **no frame landed**.
- **A `commit()` guard that refuses on poison, not only on `ahead`.** That is the group-death hazard
  rebuilt. The guard fires on positive evidence of being behind, and poison is not that evidence.
- **Draining `recoveryWaiters` after clearing the timers.** Order matters — resolve the waiters first,
  then clear timers, or a fired timer races the drain.

## Definition of done

- Both Criticals fixed in `peer.ts`; the stale `pullCommits` comment corrected.
- The parametrised heal-trigger test (Critical 1) and the dispose-during-heal test (Critical 2), each
  asserting **belief / state**, not the absence of an exception.
- A mutation check per fix, with what else went red and what did not.
- An explicit statement of whether the ledger gather has the same dispose-hang, with evidence.
- The Q3.4 group-death hazard shown **not** reintroduced — a poison-only peer is still allowed to
  commit.
- `packages/mls` must not be touched. No `HubStore` change.

## Conventions

`type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`/`DID`; ES
`#fields`, never `private`/`readonly`. pnpm only. **Never edit generated `lib/`.**

**Code, comments, and test names never reference plan questions, decision numbers, or phase labels.**

Verify from the repo root — **an `rtk` shim intercepts bare `pnpm run`**:

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

## Stop conditions

- **If restoring `healRequested` correctly requires a design change** (e.g. the flag genuinely cannot
  distinguish the states that must be distinguished) → `BLOCKED`, with the question stated.
- **Do not commit.**

## Report contract

Write `docs/superpowers/probes/question-5.2-report.md`: the red for each bug (captured), the fix chosen
and why, the group-death-hazard check, the ledger-gather dispose finding, both mutation checks, and the
full verify output. Return only: status, a one-line test summary, and concerns.
