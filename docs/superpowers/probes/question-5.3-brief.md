# Question 5.3 — the conformance suite has holes a plausible SQL host walks through

Repo `/Users/paul/dev/yulsi/kumiai`, branch `feat/control-ledger-lane`. **Tree is green at `db9cba8`**
(rpc 171 + 1 skipped, mls 298, 27/27). From the branch review of `packages/hub-protocol` /
`packages/hub-server`. **Three Criticals and two Importants, and they interlock**: the deliverable is the
`hub-protocol` conformance suite (the contract a SQL host in another repo implements), and writing the
missing clauses honestly is what turns two real `memoryStore` bugs red. Do them as one unit.

Read first: `packages/hub-protocol/src/conformance.ts` (the suite), `packages/hub-protocol/src/types.ts`
(the `HubStore` contract JSDoc), `packages/hub-server/src/memoryStore.ts` (the reference host —
`publish`, `removeEntry`, `trim`, `purge`, the `maxDepth` loop ~230, `topicLogs`), and
`packages/hub-server/test/memoryStore.test.ts` (unit tests that assert things the *suite* does not — and
so do not ship to hosts).

The suite runs against `memoryStore` at `packages/hub-server/test/conformance.test.ts`. **The reference
store is correct on the three Critical items and buggy on the two Important ones**; every new clause
must be run against `memoryStore` and any red is either a suite bug or a store bug — say which.

---

## The through-line

Every finding is the same shape, the plan's own signature: an obligation stated correctly in `types.ts`
and implemented correctly (mostly) in `memoryStore`, with **no clause in the suite** — so a host that is
correct by its unit tests is not held to it, and a plausible SQL implementation passes 16/16 and then
silently forks or empties a group's commit log **in someone else's repo.**

## Critical 1 — a host can derive `head` from the log and pass every clause

Every `trim` in the suite leaves a surviving log frame (`before: last`, `before: sentinel`), and `purge`
is called once, only to assert it frees nothing. **No clause ever empties a topic's log and then asserts
`head`.** So the natural SQL `head` — `SELECT max(sequence_id) WHERE topic_id=? AND retain='log'` —
passes all 16. Then a group's commit log ages out, that derived `head` becomes `null`, a peer CASes
`expectedHead: null` and **wins**, forking the group at the hub. This is G34, which the design calls the
peer's last line of defence, and only a `memoryStore` unit test (`memoryStore.test.ts` ~180) guards it.

**Add a clause:** publish two log frames, `trim({ before: <above the tip> })`, assert `messages: []`,
`oldest: null`, **`head === last`**. Add the same for `purge` after retention lapses. State in
`types.ts` that **`head` is stored state, not a projection of the log** — a host that recomputes it does
not satisfy the contract however green its single-connection tests are.

## Critical 2 — `unsubscribe` is a deleter the suite never exercises

The suite never calls `store.unsubscribe` (verify: zero occurrences). Yet the plan's own decision log
records it as "a third illegal deleter nobody had noticed", the acceptance list names it, and
`types.ts` states it as contract. `memoryStore` was fixed and unit-tested (`memoryStore.test.ts` ~89) —
but that test does not ship. A SQL host that implements `unsubscribe` as "delete this subscriber's
delivery rows, then GC messages with zero remaining deliveries" — the exact shape the reference store
once had — passes all 16 clauses and **destroys the commit log the first time a group's last member
unsubscribes.**

**Add a clause:** publish one mailbox frame and one log frame, unsubscribe the only subscriber,
re-subscribe, assert the mailbox frame is gone **and** the log frame and `head` survive.

## Critical 3 — the `retain: 'mailbox'` default is never exercised

Every `store.publish(...)` in the suite passes an explicit `retain` (verify by count). A host that
defaults an absent `retain` to `'log'` passes every clause — and then every app frame, rendezvous frame
and tunnel frame in the system (all published with no `retain`) becomes log-class: never GC'd, and
moving the head of every topic it touches. The backward-compatibility hinge is untested.

**Add a clause:** publish with `retain` omitted, subscribe a second reader, ack from every subscriber,
assert the frame is gone from `fetch` **and** `fetchTopic().head` is still `null` (it never was a log
frame). State the default in `types.ts` if it is not already unambiguous there.

## Important 4 — `memoryStore.trim` destroys undelivered mailbox mail (a REAL store bug)

`memoryStore.ts` trim iterates `topicLogs`, which holds **both** classes (every publish pushes to it,
~218), and `removeEntry`s anything below `before`. So `trim({ topicID: commitTopic, before })` silently
deletes pending mailbox mail on that topic. `TrimParams` says "remove log entries" and `FetchTopicParams`
insists a topic's log *is* its log-class frames and nothing else — so a SQL host will scope its `DELETE`
to `retain='log'` and **diverge from the reference.** Two conforming hosts, two behaviours, one loses
mail.

**Decide it** (the contract's own language points one way: `trim` is log-class only), **state it in
`TrimParams`, fix `memoryStore` to match, and add a clause**: publish a mailbox frame and a log frame,
trim past both, assert the mailbox frame's pending delivery is still deliverable and the log frame is
gone.

## Important 5 — `maxDepth` counts mailbox frames, so any member can evict a group's commit log (a REAL store bug)

`memoryStore.ts` ~230 evicts `log[0]` from the mixed `topicLogs`. The suite itself establishes that any
member may publish a mailbox frame to a log topic. So a member publishes `maxDepth` mailbox frames to
`commitTopic` and **every log frame is evicted** — offline peers can no longer converge from the hub.
The class was made unable to *wedge* the lane (G33); it was not made unable to *empty* it.

**Fix:** count only log-class frames against `maxDepth`, fix `memoryStore`, and note in the contract that
a host's depth policy must be class-scoped. **Add a clause**: publish one log frame, then `maxDepth`
mailbox frames to the same topic, assert the log frame and `head` survive.

## Important 6 — `purge`'s invariants are asserted for `trim` only

`types.ts` says `trim` **and `purge`** must not remove the dedup record, and that purge honours trim's
invariants. The suite tests neither for purge. **Add two clauses:** head survives a purge that empties
the log; a replayed `publishID` survives a purge that removed its frame.

---

## The discipline these clauses must hold to

The existing suite is unusually honest — it asserts a frame's **absence before an ack** (not just
presence after), it labels the racing-CAS clause as unprovable in-process, and it closes the
"not-implemented stub throws too" hole by asserting the positive case in the same test. **Match that.**
Specifically, for every "X survives" clause, first show the thing that *should* be deleted **is** deleted
in the same test — a clause that only asserts survival passes against a store that deletes nothing.

**And mutation-check the suite against the reference store, which is the only host you have.** For each
new clause: after it is green, make the *minimal* wrong change to `memoryStore` that the clause exists to
forbid (derive `head` from `max`; GC on `unsubscribe`; default `retain` to `'log'`; trim the mixed log;
count mailbox frames in depth; drop the dedup record on purge) and **show the clause goes red.** A clause
that cannot be made to fail by the very implementation it targets is not testing anything. Report the red
and revert.

## ⚠️ Wrong-but-passing

- **A clause that asserts only survival.** Assert the paired deletion in the same test, or a
  delete-nothing store passes.
- **Fixing `memoryStore` without adding the clause** (Important 4/5). The store is not the deliverable;
  the suite is. A silent fix retires the finding without protecting the next host.
- **Asserting `head` after a trim that left a frame.** The whole point is the *empty* log — trim/purge to
  **nothing** and assert `head` still stands.

## Definition of done

- Clauses for all three Criticals and Important 6, each with its paired deletion and its store-mutation
  check.
- `memoryStore` fixed for Important 4 and 5, each with a clause that was **red before the fix** (capture
  it) and a store-mutation check after.
- `types.ts` updated: `head` is stored state; `trim`/depth are log-class-scoped; the `retain` default
  stated.
- No `packages/rpc` or `packages/mls` change. The suite additions must keep every existing clause green.

## Conventions

`type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`/`DID`; ES
`#fields`, never `private`/`readonly`. pnpm only. **Never edit generated `lib/`.**

**Code, comments, and test names never reference plan questions, decision numbers, or phase labels.**

Verify from the repo root — **an `rtk` shim intercepts bare `pnpm run`**:

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

## Stop conditions

- **If a clause reveals the contract itself is ambiguous** (e.g. `trim` vs mailbox genuinely could go
  either way and both are defensible) → state the decision you made and why, in the report; do not
  silently pick. If it needs a design call you cannot make, `BLOCKED`.
- **Do not commit.**

## Report contract

Write `docs/superpowers/probes/question-5.3-report.md`: each new clause and what it forbids, the two
`memoryStore` bugs with their red-before-fix, every store-mutation check (red confirmed, then reverted),
the `types.ts` changes, and the full verify output. Return only: status, a one-line test summary, and
concerns.
