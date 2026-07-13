# Probe report — Question 1.4

**Does the dedup record outlive the log?**

**Answer: yes — and I proved the suite catches the wrong implementation rather than assuming it.**
The conformance suite is **15 passed / 0 failed of 15**, and a deliberately row-hung store — the
natural wrong implementation, with the key hanging off the message row — scores **14 passed / 1
failed**, failing exactly and only the load-bearing clause (§3).

Status: **DONE_WITH_CONCERNS** — 15/15 as predicted, nothing weakened. The concerns are the Phase 1
exit check, which is **not** fully green and should not be reported as such (§5), and two SQL-host
traps the suite cannot catch (§6). Nothing committed.

---

## 1. Where the dedup record lives, and why no deleter can reach it

`packages/hub-server/src/memoryStore.ts:76-83`:

```ts
/**
 * publishID -> the sequenceID it was accepted as. Not a log entry, and not reachable from one:
 * no deleter here takes a publishID, so `removeEntry`, `trim` and `purge` have no way to touch
 * this map even by mistake. ...
 */
const publishRecords = new Map<string, string>()
```

The structural argument, which is the point rather than a nicety:

- Every deleter in this store is keyed by **sequenceID**. `removeEntry(sequenceID)`
  (`memoryStore.ts:104-124`) is the only thing that removes a frame; `trim`
  (`memoryStore.ts:296-304`) and `purge` (`memoryStore.ts:312-330`) both work by selecting
  sequenceIDs and calling it. The depth bound does the same.
- `publishRecords` is keyed by **publishID**, and there is **no index from a sequenceID back to a
  publishID** anywhere in the file. A deleter holding a sequenceID has no way to name the record
  that points at it — not "must remember not to", but *cannot*, without adding a reverse index that
  does not exist.

That is the same trick that made `heads` correct in question 1.2: the invariant is a property of the
data model, not of the author's care. The record is retained indefinitely — it is a key and a
sequenceID, one per conditional publish.

The write is at `memoryStore.ts:169-171`, immediately after the mint, so the record and the frame
are born together and then have entirely independent lifetimes.

---

## 2. Dedup before CAS: what happens to a replay with a stale `expectedHead`

The check is the **first** thing `publish` does (`memoryStore.ts:139-150`), above the CAS, which is
itself above the mint:

```ts
if (params.publishID != null) {
  const accepted = publishRecords.get(params.publishID)
  if (accepted !== undefined) {
    return accepted            // ← before the head is ever compared
  }
}
```

**A replay carries a stale `expectedHead` by construction.** The caller journalled
`{ expectedHead: null, publishID: 'commit-1' }`, published, the hub accepted — and *that acceptance
is what moved the head*. So when the caller replays the journal byte-for-byte, the `expectedHead` it
sends is guaranteed to be wrong. In this order, the replay never reaches the comparison: it returns
`000000000001`, the original sequenceID, and appends nothing.

**In the other order it raises `HeadMismatchError`** — and the caller reads that as "my publish was
rejected, my commit was lost", when in fact it landed. That is precisely the confusion the
idempotency key exists to prevent, and it converts a recoverable restart into a permanent
divergence. This is not hypothetical: it is the literal failure my row-hung experiment produced (§3).

The returned sequenceID may name a frame that trim has since removed. **That is correct.** The
replay asks *"did my publish land?"*, not *"give me my frame"*. Both facts are now stated in words on
`PublishParams.publishID` (`packages/hub-protocol/src/types.ts:33-50`) and on the `HubStore` doc
(`types.ts:159-165`).

---

## 3. The suite catches the wrong implementation — verified, not assumed

The brief asserts that hanging the key off the message row "passes every other clause and fails only
this one". I built that store and ran the suite against it rather than taking it on faith: a wrapper
that keeps its own `publishID -> sequenceID` map and, on `trim`, **deletes the records whose
sequenceID falls below the bound** — which is exactly what a `messages` table with a `publish_id`
column does when the row is deleted. (Scratch file, run once, deleted; not committed.)

```
failed  the dedup record outlives the log: a replay after a trim still returns the original sequenceID
    HeadMismatchError: Publish to topic:conformance expected head null, but the head is 000000000002
--- 14 passed / 1 failed of 15
```

Two things worth saying about that result.

**First: 14 of 15 clauses pass.** The row-hung store is correct about retention, correct about the
classes, correct about trim, correct about the CAS, and correct about ordinary dedup. Exactly one
clause stands between it and a green suite, which is what "load-bearing" means and why the clause has
to exist.

**Second: look at the failure.** It is not an assertion mismatch — it is
`HeadMismatchError: expected head null, but the head is 000000000002`. That is the bricked-group
walkthrough from the brief, reproduced mechanically: the record died with the frame, the replay
became an ordinary new publish, its CAS at the journalled `null` sentinel was compared against a head
naming the frame that trim had just removed, and it was rejected. A sole-member group in that state
has no other member to heal against and no exit. The clause does not just detect a missing row; it
detects the exact fatal path, and it prints it.

---

## 4. Conformance: 15 passed / 0 failed of 15

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
passed  a replayed publishID returns the original sequenceID and appends nothing
passed  the dedup record outlives the log: a replay after a trim still returns the original sequenceID
passed  racing publishes at the same head yield exactly one accepted append
passed  fetchTopic refuses a non-subscriber
--- 15 passed / 0 failed of 15
```

Both dedup clauses now publish `retain: 'log'` — a mailbox publish does not move the head, so their
`head` assertions were meaningless without it — and, more importantly, **both replays now carry the
stale `expectedHead` the caller would actually have journalled** (`conformance.ts:346-350`,
`:383-390`). That is what makes them test the dedup-before-CAS ordering rather than merely the
existence of a record; a store that checks the key but compares the head first now fails them. No
assertion was weakened.

One store-level test the suite cannot express, because it asserts on the padded encoding that is
`memoryStore`'s private choice: `a replayed publishID consumes no sequenceID and survives a purge of
the whole log` (`packages/hub-server/test/memoryStore.test.ts`). It purges the entire log, replays,
gets `000000000001` back, and then checks the **next** publish takes `000000000002` — a replay burns
no sequence.

---

## 5. Phase 1 exit check — two of three, and I am not calling it green

The exit criteria: `hub-protocol` exports a conformance suite; `memoryStore` passes all of it; and
the suite **fails** a store that (a) hangs retention off delivery, (b) hangs dedup off the message
row, or (c) mints sequenceIDs in-process.

| | Criterion | Status |
|---|---|---|
| | `hub-protocol` exports a conformance suite | **Met.** `@kumiai/hub-protocol/conformance`, 15 clauses. |
| | `memoryStore` passes all of it | **Met.** 15/15. |
| (a) | The suite fails a **delivery-derived** store | **Met, and demonstrated.** Watched it fail in question 1.1 (9 of 10 red against the old store) and again as the class-pair clause in 1.2. |
| (b) | The suite fails a **row-hung dedup** store | **Met, and demonstrated today** — §3, 14/15 with the load-bearing clause red. |
| (c) | The suite fails an **in-process sequence counter** | **NOT MET. It cannot be met by a test.** |

**(c) is not a test and must not be reported as one.** The suite calls `createStore()` and drives one
store object inside one process. A host that mints its sequenceID from an in-process counter — lazily
seeded from `max(sequence_id)` at startup, which is exactly kubun's shape today — **passes all 15
clauses**, because within a single process that counter is monotonic and unique. It breaks only with
two hub processes against one database, where they mint the same sequenceID for different frames.
Survivable for a mailbox; fatal for a head, because the head *is* a sequenceID: two processes can each
believe they hold the head, both CAS successfully against it, and the lane forks.

Catching that requires two processes and a shared database. The suite has one of each **by
construction** — `createStore` returns an object, not a deployment. So (c) is a **documented review
item, not a test**: the contract forbids it in words (`types.ts:4-14`, "minted by the STORE, inside
the transaction, not by the calling process"), and the only enforcement is a human reading the host's
DDL and confirming the mint is a `SEQUENCE`/`AUTOINCREMENT`/`RETURNING` inside the same transaction
as the head comparison.

**Phase 1's honest status: the suite exists, `memoryStore` conforms, and the two failure modes the
suite was built to catch are caught and have been watched to fail. The third is a contract clause
with a review obligation attached, and no green run of this suite is evidence about it.** A host that
reads the suite passing as "my sequence minting is fine" has misread it — which is the same hazard as
the concurrent-CAS clause (question 1.3 §3), and for the same structural reason.

---

## 6. What a real SQL host will get wrong that the suite does not catch

Beyond the in-process counter (§5) and the read-then-write CAS (question 1.3 §4.3), this question
adds two:

### 6.1 The dedup record must be written in the same transaction as the append, or a crash splits them

`publish` writes two things: the log entry and the dedup record. If they are separate transactions —
or one is a fire-and-forget insert — a crash between them leaves one of two states, and **both are
bad in a way no clause here detects**:

- **Frame committed, record lost.** The replay is treated as new, CAS at the journalled head fails
  against the head the lost-record frame set — the bricked group of §3, arrived at by a crash instead
  of a trim.
- **Record committed, frame rolled back.** Worse and quieter: the replay returns a sequenceID for a
  frame that **never existed**, the caller marks its commit as landed, and the commit is gone
  forever. No peer can pull it and no error is raised anywhere.

The contract says the whole publish is one transaction, and the dedup write is part of the publish —
but the suite drives an in-process store that cannot crash mid-publish, so it cannot test this. It is
the same class of gap as the concurrency clause: **stated, not testable here.** A host should assert
it with a crash-injection test against its real database.

### 6.2 A unique constraint on `publish_id` is not the same as a dedup check

The tempting SQL shortcut is `UNIQUE (publish_id)` plus `ON CONFLICT DO NOTHING`, and letting the
insert fail on a replay. That does *not* satisfy the contract: the replay must **return the original
sequenceID**, and `ON CONFLICT DO NOTHING` returns nothing at all. `ON CONFLICT ... DO UPDATE ...
RETURNING sequence_id` or an explicit lookup-then-insert inside the transaction does. A host that
implements the constraint but not the return path turns every replay into an error the caller cannot
distinguish from a rejection — and the suite *does* catch that one (`a replayed publishID returns the
original sequenceID`), so it is a trap, not a hole. Noting it because it is the first thing a SQL
author reaches for.

### 6.3 The dedup record's retention outliving the log is a schema property, not a policy

If the record lives in a `publish_records` table with `ON DELETE CASCADE` from `messages`, the host
has re-implemented the row-hung store while believing it separated them. The cascade must not exist —
and note this is the *opposite* of the delivery rows, where the cascade **is** the contract (question
1.2 §6.4, now a clause). Two adjacent tables referencing `messages`, one of which must cascade and
one of which must not. That is an easy thing to get uniformly wrong in either direction, and it is
worth one line in the host's schema review.

---

## 7. Verify

`rtk proxy pnpm run build`:

```
 Tasks:    7 successful, 7 total
```

`rtk proxy pnpm run lint`:

```
$ biome check --write ./packages ./tests
Checked 166 files in 160ms. No fixes applied.
```

`rtk proxy pnpm test`:

```
@kumiai/mls:test:unit:           Test Files 18 passed (18)  Tests 265 passed (265)
@kumiai/broadcast:test:unit:     Test Files  8 passed (8)   Tests  35 passed (35)
@kumiai/hub-protocol:test:unit:  Test Files  1 passed (1)   Tests   5 passed (5)
@kumiai/hub-tunnel:test:unit:    Test Files 20 passed (20)  Tests  63 passed (63)
@kumiai/hub-client:test:unit:    Test Files  1 passed (1)   Tests   5 passed (5)
@kumiai/rpc:test:unit:           Test Files 16 passed (16)  Tests  68 passed (68)
@kumiai/hub-server:test:unit:    Test Files  5 passed (5)   Tests  56 passed (56)

 Tasks:    27 successful, 27 total
```

**All 27 tasks green — the first fully green run since question 1.1 opened the suite.** No `mls`
flake this time. Integration (`tests/integration`): `PASS (17) FAIL (0)`.

`hub.test.ts` is **untouched** (`git diff --stat` on it is empty) and green. A publish with no
`publishID` skips the dedup branch entirely and takes exactly the path it took before.

Diff: `conformance.ts`, `types.ts`, `memoryStore.ts`, `memoryStore.test.ts`.
