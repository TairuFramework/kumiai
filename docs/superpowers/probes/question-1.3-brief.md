# Probe brief — Question 1.3

## The question

**Is the CAS atomic, and is `sequenceID` ordered?**

- **Assumption:** `expectedHead` plus a store-minted, lexicographically-ordered sequenceID can be
  *specified* such that a non-transactional store fails the suite — even though the in-memory store
  cannot itself exhibit the race.
- **Done when:** `publish` honours `expectedHead`; `HeadMismatchError` is raised and **nothing is
  stored** for the loser; the empty-topic `null` sentinel works; the contract states in words that
  the head comparison, **the sequence mint**, the append and the head advance are **one
  transaction**; and sequenceIDs are contractually lexicographic and strictly increasing within a
  topic.
- **⚠️ Wrong-but-passing:** `String(counter)` unpadded, or a UUID. Both satisfy `sequenceID: string`
  and silently break every comparison in the design (`"10" < "9"`). And an **in-process counter** —
  which is what kubun mints today — passes every single-process test in existence while colliding
  across two hub processes on one database. Survivable for a mailbox. Fatal for a head, because
  **the head *is* a sequenceID.**

## Scope

**In scope:** `expectedHead` CAS in `publish`, the ordering and atomicity contract, and the
conformance clauses that judge them.

**Out of scope:** `publishID` idempotency and the dedup record. That is question 1.4. The two dedup
clauses in the suite must **still fail** when you are done. Implementing them here would hide
whether the CAS is sound on its own.

Expected outcome: **12 passed / 3 failed of 15** — the three CAS clauses flip to passing, the two
dedup clauses stay failing. Say what you actually get and why. Do not chase a full pass.

## What you already have (from questions 1.1–1.2)

- `heads` is a **separate map** from the log (`memoryStore.ts`). No deleter can reach it, and since
  question 1.2's last change, **no mailbox publish can move it either**. So the CAS anchor is
  coherent *by construction* rather than by convention — a head always names a log frame, and a log
  frame is only removed by `trim`. That property is what `expectedHead` rests on; do not undermine
  it.
- `formatSequenceID` already zero-pads to 12 (`memoryStore.ts`), which is why the ordering clause
  has been passing since question 1.1. It passes **by luck, not by contract** — nothing has ever
  required it. This question is where it becomes a requirement.

## Spec excerpts (verbatim — this is the contract)

From `docs/superpowers/specs/2026-07-13-control-ledger-lane-design.md`:

```ts
export type PublishParams = {
  senderDID: string
  topicID: string
  payload: Uint8Array
  /**
   * Compare-and-set on the topic's head. Absent: append unconditionally. Present: append
   * only if the topic's current head is exactly this value, where `null` means "the topic
   * has never had an accepted publish". On mismatch, throw HeadMismatchError and store
   * nothing.
   */
  expectedHead?: string | null
  // ...
}
```

> **`sequenceID` gains an ordering contract.** The design compares sequenceIDs in five places —
> `expectedHead` equality, `head` against the cursor, `oldest` against the cursor, `after` as an
> exclusive cursor, and the byzantine tiebreak. The type is `string` and its order has never been
> specified; `memoryStore` works only because `formatSequenceID` happens to `padStart(12, '0')`. A
> host that mints `String(counter)` unpadded, or a UUID, satisfies the type and silently breaks
> every one of those comparisons (`"10" < "9"`). The contract now requires:
>
> - sequenceIDs are **lexicographically ordered, strictly increasing within a topic** —
>   byte-comparable, so a fixed-width zero-padded encoding, not a bare decimal and not a UUID;
> - the sequenceID is **minted by the store inside the CAS transaction**, not by the process.
>   kubun mints from an in-process counter lazily seeded from `max(sequence_id)`, so two hub
>   processes on one database already collide. Survivable for a mailbox; fatal for a head,
>   because the head *is* a sequenceID.
>
> **Atomicity is a contract requirement, not an implementation detail.** The head comparison,
> **the sequence mint**, the append, and the head advance MUST happen in **one transaction**.
> A read-then-write CAS is a race — precisely the race D1 exists to eliminate. A host reading
> "the head is a scalar" could reasonably implement it as three statements; the contract
> forbids that in words, and the conformance suite must catch it.
>
> The head is **hub-assigned** — a `sequenceID`, which only the store mints. A member cannot
> choose it, so a malicious member cannot wedge the lane by publishing a bogus head token.
> This is why the CAS condition is not a member-supplied value. The payload stays opaque: the
> hub sequences bytes it cannot read.

From the Testing section:

> - **CAS:** two publishes at the same head — one accepted, one `HeadMismatchError`, nothing
>   stored for the loser; the empty-topic sentinel (`null`); a replayed `publishID` returns
>   the original sequenceID and appends nothing.
> - **Concurrent CAS under real parallelism:** N racing publishes at the same head yield
>   exactly one accepted append. This must run against a real database over **separate
>   connections** — not N `await`s on one connection, which the obvious in-memory version
>   does and which a non-transactional, process-counter store passes while being broken.

## The approved approach

1. **CAS in `publish`.** When `expectedHead` is present, compare it against the topic's current
   head — `null` meaning "no log publish has ever been accepted on this topic" — and on mismatch
   raise `HeadMismatchError` **having stored nothing**: no log entry, no delivery rows, no
   sequenceID consumed, no event emitted. "Stores nothing" is the load-bearing half of the clause;
   a store that appends and *then* throws passes a naive test that only checks for the throw.

   Absent `expectedHead`: append unconditionally, exactly as today. This is what every mailbox
   publish does, and it must stay a fast path.

2. **The ordering and atomicity contract, in words, on the type.** `formatSequenceID`'s padding
   stops being an accident and becomes the contract: fixed-width, zero-padded, byte-comparable,
   strictly increasing within a topic, **minted by the store**. Say plainly on `PublishParams` /
   `HubStore` that the comparison, the mint, the append and the head advance are one transaction,
   and that a read-then-write CAS is the race this exists to eliminate.

3. **The honest limit, stated out loud in the suite.** An in-memory store *cannot prove atomicity*:
   N `await`s on one event loop serialize trivially, so `memoryStore` passing the concurrent-CAS
   clause means nothing at all. The clause's doc comment must say so, and must tell hosts that this
   one has to be run against a real database over **separate connections** to mean anything.

   **A silently-vacuous clause is worse than no clause** — a host reads a green suite as proof.
   Documenting the limit is part of the deliverable, not a footnote.

4. **A test the in-memory store *can* fail.** Where you can, express the atomicity requirement as
   something checkable in-process — e.g. that a losing CAS leaves the log, the head and the
   sequence counter exactly as they were (no gap in the sequence, no orphan). That does not prove
   transactionality, but it catches the store that "rolls back" by forgetting to.

## Rules

- **BLOCKED on the first failure of the approach.** Do not try alternatives without asking.
- Do not implement `publishID`. The two dedup clauses stay red.
- Do not weaken a clause to make it pass. If a clause is unfalsifiable in-memory, **say so in its
  doc comment** — do not quietly delete it or let it pass vacuously without a word.
- `hub.test.ts` and the integration tests must stay green. A mailbox publish passes no
  `expectedHead` and must be entirely unaffected.

## Conventions

`kigu:conventions` skill and the repo's `AGENTS.md`. `type` not `interface`; `Array<T>`; never
`any`; capital `ID`; ES `#fields`. **Code, comments and test names never reference plan questions,
phase labels, or G-numbers** — state the invariant directly ("the head comparison, the mint, the
append and the head advance are one transaction").

## Verify

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

from the repo root (`rtk proxy` prefix required). Include the output. Note: an `mls` test has
flaked once per run under parallel load in both previous questions and does not reproduce in
isolation — `mls` does not depend on `hub-protocol` or `hub-server`. If you see it, re-run `mls`
alone and report both results rather than investigating.

## Report contract

Write to `docs/superpowers/probes/question-1.3-report.md`:

- Where the CAS lives and what it touches, `file:line`.
- The pasted conformance output and the pass/fail count against the prediction (12/3).
- **What the concurrent-CAS clause actually proves against `memoryStore` — and what it does not.**
  Be blunt. This is the part a host will misread.
- Anything you found that a real SQL host will get wrong that the suite does *not* catch. The last
  two questions each surfaced one of those, and both mattered more than the code.
- The full verify output.

**Return to the caller only:** status, a one-line test summary, concerns. Do not commit.
