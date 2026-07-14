# Question 3.4 — follow-up: the escalation is the DoS, and the table is missing a row

**Read first:** `docs/superpowers/probes/question-3.4-brief.md` and your report
`docs/superpowers/probes/question-3.4-report.md`. This continues that work. **The tree is GREEN
(rpc 132) and uncommitted. Keep it green. Do not commit.**

Three decisions came out of the review of your report. Two are behaviour changes; one is a doc.

---

## 1. The `MissingLedgerEntriesError` row is wrong in the spec, and your concern 2 is why

You reported the gather "has nowhere to go" and the retry loop always exhausts. Correct — and it
goes further than you took it. **The escalation itself is a member-triggerable group-wide DoS.**

If an unresolvable frame escalates to `recover()`, then any *current* member publishes one commit
naming ledger entries whose bodies it omits from the frame, every honest peer fails to resolve, and
**every honest peer heals at once.** That is G19's exact shape, arriving through the row that was
supposed to be the safe one. The bounded retry does not fix it; it delays it by N attempts. The
spec's own general rule forbids it:

> **a frame from an untrusted member must never be able to make an honest peer do expensive work**

**The discriminator that resolves it.** *If a frame is unresolvable for me, it is unresolvable for
every member at my epoch.* The bodies are sealed under the epoch the commit is framed at (D3), so
every member at that epoch either can open the blob or cannot. Therefore:

- **Nobody can resolve it** → nobody applies it → **the group never advances past that epoch**. It is
  a dead frame in the log: the next honest commit is framed at the same epoch, CASes at the head after
  the poison, and everyone applies it. Cost: one wasted CAS slot — which the spec **already accepts**
  as a DoS-class write capability ("an ex-member can inject noise into the serialization lane
  indefinitely, costing every honest commit an extra CAS round"). **No heal. No storm.**
- **The group *does* advance past it** → the fault was mine alone; my blob is genuinely corrupt or my
  state is broken. And I learn this **not from the frame itself, but from a later frame framed at an
  epoch ahead of mine.**

### So: the last row becomes poison, and the table gains a row it never had

**Replace** the `MissingLedgerEntriesError` row's action. It is now: **drop, advance the cursor, and
do NOT heal** — but *remember that I skipped an epoch I could not resolve.* Delete the bounded retry
loop and the escalate-on-exhaustion. They are dead code that buys a DoS.

**Add** the row the table is missing — and note that its absence is a live bug in what you built, not
merely a gap. Today a frame framed at an epoch **ahead** of this peer's classifies as *"an epoch this
peer has no recorded applied-commit for"* → **history → advance**. So a peer that skips an epoch walks
the rest of the log calling every subsequent commit "history", reaches `reconciledHead == head`, and
**reports itself healthy while permanently stuck at a dead epoch.** That is precisely the failure the
spec's own G18 note describes ("walks cheerfully to `reconciledHead == head`"), reached by a different
road. The new row:

| Frame | Cursor |
|---|---|
| **Framed at an epoch AHEAD of this peer's current epoch** | **advance; heal trigger → `recover()`** — the group has moved on without this peer, which is proof it is behind |

Place it correctly in the order and **say in the report where you put it and why**. Think about which
existing rows it must precede or follow — in particular, whether an *ahead* frame can be confused with
the *history* row, and what stops the very first pull of a fresh Welcome joiner from tripping it.
**That last point is load-bearing**: a joiner from a Welcome starts at some epoch N with a log full of
frames at epochs < N *and* possibly > N. Get this wrong and every new member heals on arrival, which
is the storm again, self-inflicted.

**Tests this changes and adds:**

- **The unopenable-frame test must now assert nobody heals.** A member publishes a commit whose bodies
  cannot be resolved: every honest peer drops it, advances, and **does not heal**. The group is not
  wedged and not stormed. This is the *third* G19-class test, and it is the one that closes the attack
  question 3.3 left open.
- **A peer that genuinely cannot resolve, while the group can, heals.** The others apply the frame and
  reach epoch E+1; the victim skipped E, meets a frame at E+1, and **heals**. Assert its epoch
  advances — "no error thrown" is not the assertion.
- **A Welcome joiner does not heal on arrival.** Whatever ordering you choose must not trip the new
  row for a member reading history it was never part of.

## 2. A typed error for the heal trigger unwinding `commit()` — approved

Your concern 1. Export it from `commit.ts` alongside `JournalEpochError` and `CommitDeadlineError`,
with a doc comment saying what the host should do about it (the heal is already scheduled; the host's
`commit()` did not happen and can be re-issued once the lane is whole). Give it a test.

## 3. `appliedByEpoch` stays in memory — approved, document the limit

Your concern 3, accepted as-is. A restarted peer can **miss** a fork and can never **invent** one, and
that is the safe direction: inventing forks would turn every late joiner into a recovery storm. D1's
fork *resolution* is not built anyway, so the trigger has nowhere to go. **No durable store.** Make the
comment in `peer.ts`/`classify.ts` say exactly this — that it is a deliberate, bounded weakness, what
it costs, and what would have to change (D1 landing) before it is worth revisiting.

---

## What the report must answer

**Append** a section titled **"The escalation was the DoS (follow-up)"** to
`docs/superpowers/probes/question-3.4-report.md`. Do not overwrite it.

1. **A mutation check on the new rule.** Restore the escalate-on-unresolvable, and show the storm:
   one body-less commit from one member, and count the heals. Exact output. Then revert.
2. **Where you placed the new row, and what breaks if it goes elsewhere.** Specifically: show what
   happens to a Welcome joiner if the *ahead* row is evaluated before the *history* row.
3. Confirm the old bounded-retry loop is **gone**, not merely bypassed.
4. Full verify output.

## Conventions

Unchanged, and they still bind: `type` not `interface`; `Array<T>` not `T[]`; never `any`; capital
`ID`/`DID`; ES `#fields`. **Never edit generated `lib/`.** **No plan/question/decision references in
code, comments, or test names** — state the invariant directly.

Verify from the repo root (an `rtk` shim intercepts bare `pnpm run`):

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

## Stop conditions

- If the new rule does not work — in particular if you find a case where a peer must heal on an
  unresolvable frame, or where the *ahead* row cannot be placed without breaking a joiner — **STOP and
  report `BLOCKED`.** Do not paper over it. The last two probes' `BLOCKED` results each killed a fix
  the user had already approved, and both were right to.
- **Do not commit.**

Return only: status, a one-line test summary, and concerns.
