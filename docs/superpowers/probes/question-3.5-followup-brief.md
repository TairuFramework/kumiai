# Question 3.5 — follow-up: the fixture cannot lie, and four sign-offs

**Read first:** `docs/superpowers/probes/question-3.5-brief.md` and your report
`docs/superpowers/probes/question-3.5-report.md`. This continues that work. **The tree is GREEN
(rpc 145) and uncommitted. Keep it green. Do not commit.**

Your four concerns came back. **Three are signed off as you built them. One is reversed, and the
reason matters.**

---

## 1. The fork row is NOT dead code. Your fixture cannot reach it. (Reversed)

You wrote:

> `classifyCommit` decides the branch with `sequenceID < applied ? 'losing' : 'winning'`. But
> `appliedByEpoch` is only ever written with a sequenceID that the cursor has already reached, and the
> pull only ever delivers frames with `sequenceID > reconciledHead`. So an incoming fork frame is
> **always** `'winning'`… The row is dead code as built.

That reasoning is correct **about an honest hub, and only about an honest hub.** Look at what the row
is *for*. The losing branch of a **byzantine double-accept** exists only because a hub violated the
compare-and-set — it accepted two commits at one head and served divergent logs to different members.
**A hub that will do that will also reorder.** `fetchTopic`'s exclusive-cursor contract is a
*contract*, and the party bound by it is the party the design does not trust.

So the losing branch is reachable exactly as the spec describes, by the only actor who can produce it:

```
The hub double-accepts at head H: commit X (seq 3) and commit Y (seq 5), both framed at epoch E.
It serves Y to Bob first.  Bob applies Y.  appliedByEpoch[E] = 5,  cursor = 5.
It then serves X to Bob.   3 < 5  ->  'losing'  ->  Bob heals onto the winning branch.
```

Bob can only ever see that frame if the hub hands it to him after his cursor passed it — which is
precisely what a byzantine hub does, and precisely what your `FakeHub` cannot do.

**This is the same finding as G37, one question later.** There, an implementation that read the
committer from `senderDID` passed 131 of 132 tests, and only a hub that could **lie** exposed it. Here,
a whole row of the table looks like dead code, and only a hub that can **reorder** shows it is not. The
standing lesson: *a test double that cannot lie is not a test.*

**Do:**

- Give `FakeHub` a byzantine control — double-accept two commits at one head, and serve them to
  different peers in different orders (including serving a peer a frame below its own cursor). Model
  the hub the design's threat model actually names. Keep it explicit and opt-in: honest by default, so
  no existing test silently changes meaning.
- Write the **losing-branch heal test** end to end through it: Bob applies the higher-sequenceID commit,
  is later served the lower one, classifies it `'losing'`, heals, rejoins, and **re-enacts the entries
  the winning branch does not have** (which is where your membership filter earns its keep — assert the
  entries, not the absence of an error).
- Your current byzantine test drives `recover()` directly. **Keep it** — it tests the recovery path in
  isolation — but it is no longer the only coverage.
- Say in the report whether the `'winning'` side needs a test too (a peer that sees the fork and
  correctly does **not** heal), and write it if so.

**If you find the row genuinely cannot fire even against a byzantine hub, STOP and report `BLOCKED`
with the reasoning.** That would be a real finding and it would change the design. Do not force it.

**Note what you must NOT do:** do not weaken the honest `fetchTopic` path, and do not let the byzantine
control leak into the store's conformance suite. The `HubStore` contract is unchanged — a *conforming*
store does not do this. The fixture models a **non-conforming** one, which is the threat.

## 2–4. Signed off, as you built them

- **`inFlight` is the pre-rejoin ledger, not the journal.** Confirmed, and your reasoning is accepted:
  with the journal in place, replay settles a crashed peer's commit at step 0 before any heal can run,
  so a journal-sourced in-flight set can never coexist with a heal and the filter over it would be
  vacuous. The pre-rejoin ledger makes the membership rule literally what it says — *re-enact an entry
  if and only if the group's authenticated ledger does not contain it* — as a set-difference. **This is
  a correction to the spec, not a deviation from it. Make sure the code comment says so**, in terms a
  reader with no plan in hand can act on.
- **The bootstrap gather rides the rendezvous lane.** Signed off, with your reasoning: the spec's
  "gather rides the app lane" refers to D3's id-keyed gather, which question 3.2 deleted, and a
  just-rejoined peer needs a lane it certainly shares with a responder. The rendezvous topic is the only
  non-rotating one both hold for life.
- **`LaneResult` gains `reenact?`.** Signed off. A heal fired by the pull has no return value to put the
  entries in, so they are stashed and handed to the next lane operation that has one, exactly as `lost`
  is.
- **Drop `GroupMLS.getLedgerEntries`.** Signed off — remove it. It is dead in the lane (bodies ride the
  commit frame), and it shrinks the surface every host implements. Check nothing else calls it.

## And one bug you found that must not get lost

Your concern 1 — **the seed-time journal replay always threw** (`epoch` initialised to `0`,
`buildEpoch()` running after the seed lane operation, so `frameCommit`'s guard refused every replay at
startup for any peer past epoch 0, and the throw aborted the seed pull too). That is a **live defect in
question 3.3's journal**, on the crash-restart path, which is the journal's whole reason for existing —
and 137 green tests never saw it because every replay test calls `replay()` explicitly, after `ready`.

You fixed it. **Now pin it.** Add a test that fails against the old code: a peer past epoch 0 restarts
with a journalled commit and settles it **without the host calling anything** — the seed lane operation
alone. Report the red output against the unfixed version.

---

## What the report must answer

**Append** a section titled **"The fixture that could not lie (follow-up)"** to
`docs/superpowers/probes/question-3.5-report.md`. Do not overwrite it.

1. The losing-branch heal test, end to end through the byzantine hub. Or `BLOCKED`, with why.
2. The regression test for the seed-time replay bug, with its red output against the unfixed code.
3. Confirmation that `getLedgerEntries` is gone and nothing called it.
4. Full verify output.

## Conventions

Unchanged and still binding. `type` not `interface`; `Array<T>` not `T[]`; never `any`; capital
`ID`/`DID`; ES `#fields`. **Never edit generated `lib/`.** **No plan/question/decision references in
code, comments, or test names** — state the invariant directly.

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

## Stop conditions

- `BLOCKED` if the approach does not work. Do not invent an alternative design.
- **Do not commit.**

Return only: status, a one-line test summary, and concerns.
