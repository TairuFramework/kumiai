# Probe report — Question 1.3

**Is the CAS atomic, and is `sequenceID` ordered?**

**Answer: the CAS is correct and the ordering is now contract — but "atomic" is not something this
store, or this suite, can prove.** The three CAS clauses flip to passing. Two of the three do so on
their own merits. The third — the concurrent one — passes **vacuously**, and §3 says exactly what
that green tick is and is not worth, because a host will otherwise read it as proof it is not.

Status: **DONE_WITH_CONCERNS** — the count is 13 passed / 2 failed of 15, not the predicted 12/3.
The extra pass is arithmetic, not a surprise (§2). Concerns in §5. Nothing committed.

---

## 1. Where the CAS lives and what it touches

`packages/hub-server/src/memoryStore.ts:139-152`, and it is the **first** thing `publish` does:

```ts
if (params.expectedHead !== undefined) {
  const head = heads.get(params.topicID) ?? null
  if (head !== params.expectedHead) {
    throw new HeadMismatchError(...)
  }
}

counter++
const sequenceID = formatSequenceID(counter)
```

The ordering is the whole design. Everything that could constitute "storing something" — the
`counter++`, the mint, the entry, the topic log push, the delivery rows, the head advance, the depth
trim — happens *after* the comparison, so the loser is not a rollback: **there is nothing to roll
back.** It touches no state at all. That is the load-bearing half of the clause, and it is why I put
the check above `counter++` rather than beside the append: a store that mints first and throws later
burns a sequenceID, leaving a permanent gap that the next reader cannot distinguish from a trimmed
frame.

Three properties this rests on, all inherited and none of them re-derived here:

- `heads` is a separate map, unreachable by `trim`, `purge`, the depth bound, `ack` and
  `unsubscribe` — so the value being compared cannot be deleted out from under the comparison.
- Since question 1.2's last change, no mailbox publish moves it either (`memoryStore.ts:145-150`), so
  the head always names a **log** frame, and a log frame is removed only by `trim`.
- `expectedHead: undefined` (absent) is distinguished from `expectedHead: null` (the empty-topic
  sentinel) by the `!== undefined` guard. An unconditional publish skips the branch entirely: the
  mailbox fast path is untouched, which is why `hub.test.ts` and the integration tests never noticed
  this question happened.

### The ordering and atomicity contract, in words

- `StoredMessage.sequenceID` (`packages/hub-protocol/src/types.ts:4-14`) now *requires* what
  `formatSequenceID`'s `padStart(12, '0')` has been getting away with by luck since question 1.1:
  minted by the store inside the transaction, lexicographically ordered, strictly increasing within
  a topic, fixed-width zero-padded. It names both wrong-but-typechecking answers — a bare decimal
  (`"10" < "9"`) and a UUID — and it names the in-process counter, which "collides across two hub
  processes on one database: survivable for a mailbox, fatal for a head, because the head IS a
  sequenceID."
- `PublishParams.expectedHead` (`types.ts:22-31`) now says the loser stores nothing —
  "no log entry, no delivery row, no sequenceID consumed, no event emitted. A store that appends and
  then throws satisfies a test that only checks for the throw, and is broken."
- The `HubStore` doc (`types.ts:105-112`) states the transaction boundary: `publish` compares,
  mints, appends and advances the head in ONE transaction, and "a host that reads 'the head is a
  scalar' and implements it as three statements does not satisfy this contract, however green its
  single-connection tests are."

---

## 2. Conformance: 13 passed / 2 failed of 15

```
passed  the retention class governs deletion: an acked mailbox frame is gone, an acked log frame is not
passed  a mailbox publish does not move the head
passed  a publish to a topic with no subscribers is retained and can be pulled later
passed  ack deletes the delivery, not the log entry
passed  trimming an entry removes the deliveries that pointed at it
passed  a subscribe above the hub maximum is refused rather than clamped
passed  a topic keeps its frames for the longest retention any subscriber asked for
passed  trim is the only deleter: head survives a trim while oldest moves
passed  sequenceIDs are lexicographically ordered across the 9 to 10 boundary
passed  expectedHead null is accepted only while the topic has never had a log publish
passed  two publishes at the same head: one accepted, one rejected, nothing stored for the loser
failed  a replayed publishID returns the original sequenceID and appends nothing
failed  the dedup record outlives the log: a replay after a trim still returns the original sequenceID
passed  racing publishes at the same head yield exactly one accepted append
passed  fetchTopic refuses a non-subscriber
--- 13 passed / 2 failed of 15
```

**The prediction was 12 passed / 3 failed. I got 13 / 2, and the difference is arithmetic in the
brief, not a clause behaving unexpectedly.** The suite went into this question at 10 passed / 5
failed of 15. Of those five failures, **three are CAS** (`expectedHead: null` sentinel, two-at-the-
same-head, racing) and **two are dedup** (replayed `publishID`, dedup-outlives-trim). Flipping the
three CAS clauses gives 13 passed and leaves exactly the two dedup clauses red. 12/3 would require a
third non-CAS failure, and there isn't one. Both remaining failures are `publishID` — question 1.4's
work, untouched:

```
 FAIL  a replayed publishID returns the original sequenceID and appends nothing
AssertionError: expected '000000000002' to be '000000000001'

 FAIL  the dedup record outlives the log: a replay after a trim still returns the original sequenceID
AssertionError: expected '000000000003' to be '000000000001'
```

### The CAS clauses had to be told to publish `retain: 'log'`

All three published with no `retain` — i.e. mailbox — which since question 1.2 **does not move the
head**. Left alone they would have asserted a CAS against a head that no publish in the test ever
advanced: the `null`-sentinel clause would have *passed for the wrong reason* (the head stays `null`
forever, so the second `expectedHead: null` publish is legitimately accepted), and the other two
would have failed with a mismatch that had nothing to do with CAS. Each now publishes `retain: 'log'`,
which is the only class a CAS is meaningful for. No assertion was weakened; the sentinel clause was
renamed to `...has never had a log publish`, which is what `null` now means.

I also strengthened the "nothing stored for the loser" clause, which is the point of it: it now
asserts the loser's payload is absent from **both** indexes (the log via `fetchTopic`, the deliveries
via `fetch`), not merely that the winner's two frames are present. A store that appends, writes
delivery rows and then throws passed the old assertion set on the throw alone.

---

## 3. What the concurrent-CAS clause actually proves against `memoryStore` — and what it does not

**It proves nothing about atomicity. Against this store it is a tautology.**

The clause fires five publishes without awaiting between them and asserts one is accepted. But they
run on one event loop against one store instance, and `memoryStore.publish` has **no await between
reading the head and writing it** — the whole body is synchronous under an `async` wrapper. Nothing
can interleave. The clause would pass identically if the store read the head, minted a sequence and
wrote in three separate statements with no transaction at all, which is *precisely the broken
implementation the head exists to prevent*. `memoryStore` passing it is not evidence that
`memoryStore` is atomic; it is evidence that a single-threaded program is single-threaded.

What the clause *does* catch, and the only things it catches: a store that ignores `expectedHead`
outright (it accepted all five before this question), and one whose losers throw something other
than `HeadMismatchError`.

This is now written at the clause, in the clause's own doc comment
(`packages/hub-protocol/src/conformance.ts:407-424`), opening with "READ THIS BEFORE TRUSTING A GREEN
RUN OF THIS CASE" and closing with the instruction that a host MUST re-run it against a real database
over **separate connections**, genuinely concurrent, because that is the only version that proves the
comparison, the mint, the append and the head advance are one transaction. A silently-vacuous clause
is worse than no clause: a host reads a green suite as proof, and this one would be a lie.

### The one atomicity-adjacent thing that *is* checkable in-process

`packages/hub-server/test/memoryStore.test.ts` — `a losing conditional publish consumes no
sequenceID and leaves no gap`. The first publish takes `000000000001`; a losing CAS is rejected; the
next accepted publish takes `000000000002`, **not** `000000000003`. This does not prove
transactionality, but it catches the store that "rolls back" by forgetting to — the one that mints
before it compares and quietly burns an ID on every loser. It lives in the store's own tests rather
than the suite because it asserts on the padded format, which is `memoryStore`'s choice of a
contract-satisfying encoding, not the contract itself.

---

## 4. What a real SQL host will get wrong that the suite does *not* catch

Three, in descending order of how much they would hurt.

### 4.1 An in-process sequence counter passes every clause in the suite

This is the big one, and it is the one kubun has today. The suite calls `createStore()` and drives
**one** store object. A host that mints its sequenceID from an in-process counter — lazily seeded
from `max(sequence_id)` at startup, which is exactly kubun's shape — passes all 15 clauses, because
within one process the counter is monotonic and unique. Put two hub processes on one database and
they mint the same sequenceID for different frames. For a mailbox that is a delivery mix-up. For a
log it is fatal: **the head is a sequenceID**, so two processes can each believe they hold the head,
both CAS successfully against it, and the lane forks.

The contract now forbids this in words (`types.ts:4-14`: "minted by the store, inside the
transaction, not by the calling process"), but **no clause can catch it**, because catching it
requires two processes against one database and the suite has one of each by construction. A host
that reads the type and ignores it gets a green suite. The only real defence is a `SEQUENCE` /
`AUTOINCREMENT` / `RETURNING` mint inside the same transaction as the head comparison — and a review
of the host's DDL, which no test replaces.

### 4.2 `expectedHead: null` versus `expectedHead` absent is one `undefined` check away from silent
disaster

`null` means "no log publish has ever been accepted here" and is a *conditional* publish;
`undefined`/absent means *unconditional*. A SQL host that receives its params over a wire, or through
an ORM that coalesces `undefined` to `NULL`, or that writes `if (params.expectedHead)` instead of
`if (params.expectedHead !== undefined)`, collapses the two — and the collapse is silent in both
directions:

- `null` treated as absent: every empty-topic CAS becomes unconditional, and the sentinel clause
  still passes because the first publish is accepted either way. **The suite's sentinel clause only
  catches this because of its second publish.** A host with a weaker test would not notice.
- absent treated as `null`: every mailbox publish to a topic with a head becomes a failing CAS, which
  is loud — the good failure mode.

The falsy-check bug (`if (params.expectedHead)`) is the one to watch: it also treats the empty string
as absent, and it is the single most natural thing to type.

### 4.3 The head must be compared against a *locked* row, not a read

The contract says "one transaction", but a host on a `READ COMMITTED` default (Postgres, MySQL) can
be inside a transaction and still lose the race: `SELECT head FROM topics WHERE id = ?` inside `BEGIN`
takes no lock, so two transactions both read the same head, both pass the comparison, and both
commit. The fix is `SELECT ... FOR UPDATE`, or a conditional write that does the comparison in the
database (`UPDATE topics SET head = ? WHERE id = ? AND head = ?` and check the affected row count),
or `SERIALIZABLE`. The suite cannot tell these apart from a bare read — the separate-connections run
the clause now demands would, but only if the host actually does it, and only under enough contention
to hit the window.

If one thing from this question should end up in the spec rather than in a doc comment, it is that
sentence: **the head comparison must be a conditional write or a locking read, not a read followed by
a write.** "One transaction" is necessary and not sufficient, and a host will read it as sufficient.

---

## 5. Verify

`rtk proxy pnpm run build`:

```
 Tasks:    7 successful, 7 total
  Time:    1.332s
```

`rtk proxy pnpm run lint`:

```
$ biome check --write ./packages ./tests
Checked 166 files in 155ms. No fixes applied.
```

`rtk proxy pnpm test`:

```
@kumiai/broadcast:test:unit:     Test Files  8 passed (8)   Tests  35 passed (35)
@kumiai/mls:test:unit:           Test Files 18 passed (18)  Tests 265 passed (265)
@kumiai/hub-protocol:test:unit:  Test Files  1 passed (1)   Tests   5 passed (5)
@kumiai/hub-tunnel:test:unit:    Test Files 20 passed (20)  Tests  63 passed (63)
@kumiai/hub-client:test:unit:    Test Files  1 passed (1)   Tests   5 passed (5)
@kumiai/rpc:test:unit:           Test Files 16 passed (16)  Tests  68 passed (68)
@kumiai/hub-server:test:unit:    Test Files  1 failed | 4 passed (5)   Tests 2 failed | 53 passed (55)
 Tasks:    26 successful, 27 total   (--continue --force)
 Failed:   @kumiai/hub-server#test:unit
```

All 27 `test:types` tasks pass. `mls` passed on every run this time — the flake from the previous two
questions did not appear. Integration (`tests/integration`): `PASS (17) FAIL (0)`.

`hub.test.ts` is **untouched** (`git diff --stat` on it is empty) and green: a mailbox publish passes
no `expectedHead`, skips the CAS branch entirely, and cannot tell this question happened.

**2 failures, both `publishID` dedup, both by design. Zero regressions.**

Diff: `conformance.ts`, `types.ts`, `memoryStore.ts`, `memoryStore.test.ts` — 4 files, +154/-11.
