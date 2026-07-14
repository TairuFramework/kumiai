# Question 4.2 — do the acceptance criteria hold end to end?

Repo `/Users/paul/dev/yulsi/kumiai`, branch `feat/control-ledger-lane`. **Tree is green and committed at
`d19aad1`** (rpc 153 + 1 skipped, mls 287, 27/27). This is the **last question of the plan**.

Read first: `docs/superpowers/specs/2026-07-13-control-ledger-lane-design.md` (the whole `## Acceptance`
section at line 1945, and `## Testing` at 1717), `packages/rpc/src/peer.ts`, `packages/rpc/src/classify.ts`,
`packages/rpc/src/commit.ts`, and the existing rpc test suite (26 files — you will be citing them).

---

## The question

> **Assumption:** the spec's acceptance list is satisfied by what Phases 1–3 built.
>
> **Done when:** each acceptance bullet has a passing test.

## The acceptance list, verbatim from the spec

1. A host writes no ordering, no authority, no integrity, and no body-distribution code — and **no
   body store**. Its only new obligation is the `HubStore` migration.
2. Two admins enacting entries concurrently converge against an honest hub, with **no permanent fork
   and no lost entries**.
3. Two concurrent commits **on the same device** both land.
4. A member invited **while commits are in flight** converges by pulling the log, **without recovery**.
5. A third member who has **never seen an entry body** applies the enacting commit on first delivery.
6. `GroupMLS.exportGroupInfo` is implementable by a host **without leaking group state to the relay**.
7. A permanently-failing commit is dropped **once** and never retried forever.
8. A peer that must heal converges **even under commit pressure**: its external commit is CAS'd, and
   losing the race costs it **a re-request, not a wedge**.
9. A member offline for **the trim window's duration** resumes by **pulling, not healing**.

---

## This is a CENSUS first, and a test-writing task second

**Do not start by writing tests.** Start by auditing. For **each** of the nine bullets, produce a row:

| # | bullet | covering test (`file.test.ts` › `test name`) | what it actually asserts | verdict |

`verdict` is one of **COVERED** / **PARTIAL** / **UNCOVERED**.

**A bullet is COVERED only if an existing test asserts the bullet's own claim.** Not an adjacent one.
The standing failure mode of this whole plan is a test that passes for the wrong reason, and the
cheapest way to fail this question is to skim the suite, recognise a familiar-sounding test name, and
tick the box. **Open the test and read the assertions.** If the test converges the group but never
checks that the entry is present in every member's ledger, bullet 2 is PARTIAL, not COVERED.

Then, and only then, write tests for the PARTIAL and UNCOVERED rows.

**Report the census in full even for the bullets that are already green.** The census is the deliverable
that outlives this question — it is the map from the design's promises to the tests that hold them
down, and if a promise has no test the honest answer is to say so, not to manufacture one.

## The bullets I expect to be hard, and why

- **Bullet 1 is a claim about ABSENCE, and no ordinary test asserts absence.** "A host writes no
  ordering, authority, integrity, or body-distribution code, and no body store" is a statement about the
  `HubStore` / `GroupMLS` contract *surface*: the host implements those and nothing else. Think about
  what could actually hold this down — the `hub-protocol` conformance suite is the shape of the store
  obligation, and `memoryStore` is the reference host. Is there anything a test can assert here beyond
  "the conformance suite is the whole contract"? **If the honest answer is that this bullet is a design
  property rather than a testable one, say so plainly** and say what the nearest testable proxy is.
  Do not invent a ceremony that passes and means nothing.
- **Bullet 6** (`exportGroupInfo` without leaking to the relay) was question 2.2's territory. Check
  whether the test that exists asserts the *non-leak*, or merely that the seal round-trips. Those are
  different claims and only one of them is the bullet.
- **Bullet 8** (heal under commit pressure, "a re-request, not a wedge") — `recover()` has its own CAS
  loop from question 3.5. Does a test actually make it *lose* that CAS and show it re-requests a fresh
  GroupInfo rather than retrying a stale one? A test where the heal wins uncontested does not cover
  this bullet.
- **Bullet 9** says "for the trim window's *duration*" — the member is offline but its frames are **still
  in the log**, so it resumes by pulling. This is NOT the trim strand. **The trim-strand heal trigger —
  a member offline BEYOND the window, whose frames are gone — is a known unbuilt gap: nothing in the
  peer reads `oldest`.** It is deliberately not in the acceptance list. **Name it in the report; do not
  conflate it with bullet 9, and do not build it.** If a test for bullet 9 only passes because the log
  was never trimmed at all, say so.

## ⚠️ Wrong-but-passing: "no error was raised"

Question 4.1 established this the hard way: **`recover()` with nobody to answer resolves
`{ advanced: false }` and does not throw.** A peer can converge, advance its epoch, fire its Welcome,
raise nothing — and still be silently broken. Most of this design's failures are like that: the
stranded peer reports itself healthy, the reverted entry raises nothing, the bricked group looks idle.

**Every bullet must assert that state MOVED:** epochs advanced, entries present in each member's
ledger, rosters matching, plaintexts readable, members converged on the same head. Not the absence of
an exception.

## Definition of done

- **The census table, all nine rows, with the covering test named by file and test name**, and the
  assertion that does the work quoted or described. PARTIAL and UNCOVERED called honestly.
- Tests written for every PARTIAL and UNCOVERED bullet that is testable, each asserting **moved state**.
- For any bullet that is genuinely not testable (bullet 1 is the candidate), **an argued statement of
  why**, and the nearest proxy — not a ceremony.
- **A mutation check on every test you write.** Break the mechanism the bullet depends on, show the new
  test goes red, revert, and report the red output. A new test that cannot be made to fail is not a test.
- The trim-strand gap named separately, and **not built**.
- No `src/` change expected. **If one is needed, that is the finding** — it means Phases 1–3 left a hole,
  and the honest report is what that hole is.

## Conventions

`type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`/`DID`; ES
`#fields`, never `private`/`readonly`. pnpm only. **Never edit generated `lib/`.**

**Code, comments, and test names never reference plan questions, decision numbers, or phase labels** —
no `// Q4.2:`, no `// G21`. State the invariant directly.

Verify from the repo root — **an `rtk` shim intercepts bare `pnpm run`**:

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

## Stop conditions

- **A bullet that cannot be satisfied without a design change → `BLOCKED`.** Do not invent the change.
  Every probe in this plan that reported `BLOCKED` was right to, and two of them killed rules the design
  had carried for thirty revisions.
- **Do not build the trim-strand trigger.** It is out of scope and it is not in the acceptance list.
- **Do not commit.**

## Report contract

Write `docs/superpowers/probes/question-4.2-report.md`: the full nine-row census, the tests written, the
mutation check for each (**including what else went red, and what did not**), the trim-strand gap stated
separately, and the full verify output. Return only: status, a one-line test summary, and concerns.
