# Question 3.6 — does replay return its outcome without deadlocking the host?

Repo `/Users/paul/dev/yulsi/kumiai`, branch `feat/control-ledger-lane`. **Tree is green and committed
at `e0c9481`** (rpc 147, mls 283, 27/27).

**This is a SHORT, DIRECTED probe.** Most of this question was answered as a side effect of questions
3.3 and 3.5. Your job is one real test plus one honest audit. Do not rebuild what is there.

---

## The question

> **Assumption:** replay at lane step 0, with `lost` delivered as a **return value**, lets the host
> respond by calling `commit()` — the one thing it will certainly do.

## Part 1 — the real work: the invitee side of a re-delivered Welcome (G22)

**This has zero coverage anywhere in the repo, and it is a question about ts-mls, not about our code.**

The spec's claim, on `PendingCommit.onAccepted` and in the design:

> **`onAccepted` MUST be idempotent — replay can and will run it more than once.** The sequence
> *publish → accepted → `onAccepted()` → `clear(publishID)`* is three steps and a crash can land
> between any two of them. Re-adopting the journalled handle is harmless — it is a fixed serialized
> value. **Re-delivering a Welcome is not:** the invitee has already joined, and a second
> `processWelcome` over the same bytes errors or builds a duplicate group state. **Both halves must
> tolerate a repeat.**
>
> The testing clause: *Replay runs `onAccepted` twice. The peer is killed between `onAccepted()` and
> `clear(publishID)`. On restart the entry replays: the handle is adopted again (harmless) and the
> Welcome is delivered again — and the invitee, already joined, **no-ops it rather than erroring or
> building a duplicate group**.*

Every existing test asserts the **sender** side (the peer delivers the Welcome once). **Nothing tests
what happens to the recipient.** `grep processWelcome packages/mls/test/` finds no duplicate-delivery
test.

**Write it in `packages/mls`**, against real ts-mls, not against the memory double. A member joins from
a Welcome, then is handed **the same Welcome bytes again**. Assert what actually happens.

**This can genuinely fail, and if it does, the failure IS the finding.** Report `BLOCKED` and stop —
do not paper over it, do not add a dedup layer in `rpc` to hide it. If ts-mls throws or builds a second
group state, then:
- the spec's "both halves must tolerate a repeat" is **false**,
- `PendingCommit.onAccepted`'s doc comment is **lying to hosts**, and
- replay's Welcome re-delivery is a live defect on the crash path.

That is a much more valuable outcome than a green test, and three probes in this plan have already
produced exactly that kind of result. **Assert the invitee's actual state** — its epoch, its roster,
that it holds one group and not two — not merely that nothing was thrown.

If it **passes**, say precisely *why* it passes (what does ts-mls do with a Welcome for a group the
member is already in?), because the host is being promised this and the promise needs a reason behind
it, not just a green tick.

## Part 2 — the audit: are the other three clauses actually pinned?

These are believed green already. **Verify each one is pinned by an assertion that would catch the
wrong implementation — not passing by accident.** For each, say which test covers it and what the
load-bearing assertion is. If a clause is *not* genuinely covered, say so and write the test.

| Clause | Believed covered by |
|---|---|
| **G27** — a host that responds to any lane result (`lost`, `reenact`) by immediately calling `commit()` completes and does not deadlock | `packages/rpc/test/peer-commit-replay.test.ts:322`; `peer-recover-lane.test.ts:54` for `reenact` |
| **G25/G26** — replay loses the CAS: a `ledger` commit's tokens are handed back and the **host** re-issues them, **and the peer did not commit them itself**; a journalled `remove` is surfaced with the member **still in the roster** | `peer-commit-replay.test.ts` — the three "never accepted, and someone else won" tests |
| `replay()` exists as a lane operation; every lane result carries `{ lost?, reenact? }` | `packages/rpc/src/commit.ts`, `peer.ts` |

The one to look at hardest is **the `remove` notice**. The spec's reason: *"the silent-success version
of this bug leaves an admin believing an eviction happened."* Check the test asserts **the member is
still in the roster**, not merely that a notice was returned. An admin told "your removal failed" while
the member is quietly gone — or told nothing while the member is quietly still there — are different
bugs, and only one assertion distinguishes them.

## What NOT to do

- Do not rebuild the replay lane, the journal, or `LaneResult`. They are built and committed.
- Do not add tests that restate what is already asserted. If a clause is pinned, say so and move on.
- Do not "fix" a failing G22 by adding dedup in `rpc`. Report it.

## Conventions

`type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`/`DID`; ES
`#fields`, never `private`/`readonly`. pnpm only. **Never edit generated `lib/`.**

**Code, comments, and test names never reference plan questions, decision numbers, or phase labels** —
no `// Q3.6:`, no `// G22`. State the invariant directly.

Verify from the repo root — **an `rtk` shim intercepts bare `pnpm run`**:

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

## Stop conditions

- **G22 fails → `BLOCKED`.** That is a finding, not a blocker to route around.
- **Do not commit.** Leave the work in the tree.

## Report contract

Write `docs/superpowers/probes/question-3.6-report.md`. It must contain: what ts-mls actually does with
a re-delivered Welcome (with the test and its output), and the audit table with the load-bearing
assertion named for each clause. Full verify output. Return only: status, a one-line test summary, and
concerns.
