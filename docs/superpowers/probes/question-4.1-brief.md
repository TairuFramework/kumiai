# Question 4.1 — does a sole-member group survive a crash on its first commit, and the calendar? (G21, G24)

Repo `/Users/paul/dev/yulsi/kumiai`, branch `feat/control-ledger-lane`. **Tree is green and committed at
`3e339ad`** (rpc 149 + 1 skipped, mls 287, 27/27). This is the **first question of Phase 4** — the
scenarios that only fail at the seams. Every question in this phase is an integration test whose
failure mode is **silence**.

Read first: `packages/rpc/src/peer.ts` (the init/seed lane op, `replayJournal`, `pullCommits`,
`healIfRequested`, and `frameCommit`), `packages/rpc/src/classify.ts`, `packages/rpc/src/commit.ts`,
`packages/rpc/test/fixtures/durable-fake-hub.ts`, `packages/rpc/test/fixtures/peer.ts`
(`buildInviteCommit`, `makeMLSPeer`), `packages/rpc/test/fixtures/journal.ts`,
`packages/rpc/test/peer-commit-replay.test.ts` (the existing crash/restart harness — reuse its shape).

---

## The question

> **Assumption:** the journal, not heal, is what saves the group of size one — and it only works if
> the dedup record outlives the trim window.

## The plan, verbatim

> **Done when:** **G21:** the creator's `commitInvite` is accepted, the process dies before
> `onAccepted`, and there is **no other member in existence** to answer a rendezvous. It recovers
> **from the journal alone**, the invitee gets the Welcome, the group is alive. **G24:** the same
> scenario, but **the log is trimmed before the restart** — replay still returns the original
> sequenceID and the peer still adopts.
>
> **⚠️ Wrong-but-passing:** any heal-based recovery. There is nobody to recover *from* — the only
> prospective member is the invitee whose Welcome was never sent. A design that leans on `recover()`
> here bricks the group at creation, permanently, and every multi-member test still passes.

Spec: "Detection is not recovery… the group is **bricked at creation**."

---

## There are TWO crash points, and only one of them tests the dedup record

The commit loop, as question 3.3 left it:

```
publish → sequenceID
markAccepted(publishID, sequenceID)     ← the journal slot learns it was accepted
onAccepted()                            ← the host adopts the handle, sends the Welcome
clear(publishID)
```

"Dies before `onAccepted`" is **ambiguous between two different crashes**, and they exercise
**different code**:

- **Crash A — the hub accepted the publish, the process died BEFORE `markAccepted`.** The slot has
  **no `acceptedAs`**. Replay must check the journalled epoch, **re-seal, and re-publish with the same
  `publishID`** — and the hub's **dedup record** must hand back the *original* `sequenceID`. **This is
  the only path that touches the dedup record, and therefore the only path G24 can be about.**
- **Crash B — `markAccepted` ran, the process died before `onAccepted`.** Replay routes on
  `acceptedAs` first: adopt from the slot, clear, **no network at all**.

**Test both.** G24 (the trim) is **crash A only** — a trimmed log cannot change crash B's behaviour,
because crash B never talks to the hub. If you write G24 over crash B it will pass and it will mean
nothing, exactly as question 3.3's own regression test did on its first draft.

## The trap this question is actually built around — read this before writing anything

**The sole member's own un-merged commit is sitting in the log it is about to pull.**

On restart the seed pull drains the commit topic to head. The frame it finds there is **its own
commit, which it has not adopted** (that is the whole premise). The cursor table has a row for exactly
this:

| Frame | Cursor |
|---|---|
| **Current epoch, committed by *this peer*, unmergeable** | **do not advance; heal → `recover()`** |

**In a group of one there is nobody to heal from.** If that heal fires and is not cancelled by the
journal replay that follows, `recover()` runs, finds no member to answer a rendezvous, and the group is
**bricked at creation** — which is precisely the wrong-but-passing outcome the plan names.

So the question turns on **what the init sequence actually does**: does the seed pull run before the
journal replay, and if it does, is the heal request **dropped** once replay adopts the commit? Read
`healIfRequested` and the `settled.then(...)` at the bottom of `createGroupPeer`. **Establish the real
ordering empirically before you fix anything.**

**And note the inversion this predicts:** in **G24 the log is trimmed, so the seed pull returns no
frames at all** — the own-commit row never fires, and the heal is never requested. **The trimmed case
may well pass while the untrimmed one bricks.** If you see that asymmetry, it is a finding, not a
fixture bug. Do not "fix" it by trimming in both tests.

## The fixture must be able to forget — or G24 proves nothing

`DurableFakeHub` (`test/fixtures/durable-fake-hub.ts`) has the permanent `#publishRecords` map but
**no `trim` method at all** (the live `FakeHub` has one, at `fake-hub.ts:310`).

Add one. It must **actually delete log entries**: `trim(topicID, before)` removes the topic's log-class
frames at or before `before`, so `fetchTopic` returns `messages: []` and `oldest: null` — while leaving
`#heads` and `#publishRecords` **untouched**. That separation is not an implementation detail, it is
the entire mechanism under test: **the head and the dedup record are permanent and the log is not.**

**Then mutation-check the fixture itself.** Make `trim` *also* delete the trimmed sequenceIDs from
`#publishRecords`, and **show G24 goes red**. If it stays green, the test is not measuring the dedup
record's permanence — it is measuring the fixture's inability to forget, and it is worthless. Put the
red output in the report. **Revert the mutation.**

## ⚠️ Wrong-but-passing: any assertion that a heal is even ALLOWED to run

Do not assert "the group converged" or "no error was raised". A `recover()` that finds nobody may well
*resolve* — it has a deadline, and a timeout is not an exception. **Assert that no heal happened at
all:**

- **The peer publishes to the rendezvous topic ZERO times.** Count it on the hub. This is the load-
  bearing assertion of the whole question — it is what distinguishes "recovered from the journal" from
  "recovered by luck, having also asked the void for help".
- The invitee's **Welcome fired** (`welcomes` on the `TestPeer` records it — `buildInviteCommit`
  pushes the invitee's DID in `onAccepted`, and nowhere else).
- The handle **advanced to the post-commit epoch**, and the journal slot is **cleared**.
- The peer can **commit again afterwards** and it is accepted. A group that cannot take a second
  commit is not alive; it is a corpse at the right epoch.

## Definition of done

- **Four tests** — {crash A, crash B} × {log intact, log trimmed} — or a reasoned account in the
  report of why fewer suffice. Each asserts the four things above.
- The `DurableFakeHub.trim` fixture, **plus the fixture mutation check** showing G24 red without a
  permanent dedup record.
- If the sole member bricks on the untrimmed path: **capture the red output first**, then fix, then
  **mutation-check the fix** — revert it, show the test goes red, and report **what else in the suite
  goes red with it** (that number is the measure of how silent this failure is).
- No `src/` change is expected. **If one is needed, that is the finding** — say what it is and why, and
  do not smuggle a design change in as a fixture tweak.

## Conventions

`type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`/`DID`; ES
`#fields`, never `private`/`readonly`. pnpm only. **Never edit generated `lib/`.**

**Code, comments, and test names never reference plan questions, decision numbers, or phase labels** —
no `// Q4.1:`, no `// G21`. State the invariant directly.

Verify from the repo root — **an `rtk` shim intercepts bare `pnpm run`**:

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

## Stop conditions

- **Every test passes with no change → still report it, with the evidence**, and say explicitly whether
  the seed pull met the peer's own un-merged commit or not. A pass for the wrong reason is the failure
  mode of this entire phase.
- **If the fix requires a design change → `BLOCKED`.** Do not invent one. Every probe in this plan that
  reported `BLOCKED` was right to, and two of them killed rules the design had carried for thirty
  revisions.
- **Do not commit.**

## Report contract

Write `docs/superpowers/probes/question-4.1-report.md`: the startup ordering you found (with evidence),
the red output before any fix, the fix, both mutation checks (the fixture's and, if any, the code's —
**including what else went red, and what did not**), and the full verify output. Return only: status, a
one-line test summary, and concerns.
