# Question 5.3 — closing the conformance-suite holes a plausible SQL host walks through

Branch `feat/control-ledger-lane`, baseline `db9cba8` (tree green). The deliverable is the
`hub-protocol` conformance suite. Writing the missing clauses honestly is what turned the two real
`memoryStore` bugs red; all seven new clauses are mutation-checked against the reference store — the
only host available.

Files changed:

- `packages/hub-protocol/src/conformance.ts` — seven new clauses, a `maxDepth` conformance param, a
  documented `createStore` requirement (default retention 0).
- `packages/hub-protocol/src/types.ts` — head is stored state; `trim`/depth are log-class-scoped.
- `packages/hub-server/src/memoryStore.ts` — the two real bugs fixed (`trim`, depth loop).
- `packages/hub-server/test/conformance.test.ts` — passes `maxDepth: 16`.
- `packages/hub-server/test/memoryStore.test.ts` — the `maxDepth` unit test rewritten to log frames
  (the old one asserted the now-removed mailbox-depth behaviour), plus two guard tests.

The suite grew from 16 to 23 clauses (22 unconditional + 1 gated on `maxDepth`). `hub-server` unit
tests: 57 → 66.

---

## New clauses and what each forbids

Each "X survives" clause asserts the paired deletion in the same test, so a delete-nothing store
cannot pass it (except the depth clause — see its note).

### Critical 1 — `head` is stored state, not a projection of the log

Every existing `trim`/`purge` clause leaves a surviving log frame, so a host whose `head` is
`SELECT max(sequenceID) WHERE retain='log'` passes all 16. Two new clauses empty the log to nothing:

- **`head is stored state: it survives a trim that empties the log`** — publish two log frames, trim
  above the tip (`before: ${last}\uffff`), assert `messages: []`, `oldest: null`, **`head === last`**.
  Forbids: a derived head (returns null the moment the log empties → a peer CASes `expectedHead: null`,
  wins, forks the group).
- **`head is stored state: it survives a purge that empties the log`** — same, via `purge({ olderThan: 0 })`.
  Forbids the same on the age path, and is also Important 6's "head survives a purge that empties the
  log".

### Critical 2 — `unsubscribe` is a deleter the suite never exercised

- **`unsubscribe frees the mailbox frame but never the log frame or the head`** — publish one mailbox +
  one log frame (both asserted pending for Bob first), unsubscribe the only subscriber, re-subscribe,
  assert the mailbox frame is gone from `fetch` **and** the log frame + head survive in `fetchTopic`.
  Forbids: `unsubscribe` implemented as "drop this subscriber's deliveries, then GC any frame with zero
  remaining deliveries" — which destroys the commit log the first time a group's last member leaves.

### Critical 3 — the `retain: 'mailbox'` default was never exercised

- **`an absent retain defaults to mailbox: the frame is delivery-derived and never enters the log`** —
  publish with `retain` omitted, two subscribers, assert it is absent from the log and `head` is null
  *before* acking, delivered to both, then gone from every `fetch` after both ack, with `head`/`oldest`
  still null. Forbids: defaulting an absent `retain` to `'log'` — which turns every app/rendezvous/tunnel
  frame in the system into a permanent, head-moving log frame.

### Important 4 — `trim` destroys undelivered mailbox mail (REAL store bug)

- **`trim removes only log-class frames: a mailbox frame on the same topic is untouched`** — publish a
  mailbox + a log frame, trim past both, assert the log frame is gone **and** the mailbox frame's pending
  delivery is still deliverable via `fetch`. Forbids: scoping the delete to the whole topic instead of
  `retain='log'`.

### Important 5 — depth counts mailbox frames, so any member can evict the log (REAL store bug)

- **`the depth bound counts only log frames: a mailbox flood cannot evict the commit log`** (gated on the
  `maxDepth` param). Half 1: publish `maxDepth + 1` **log** frames, assert the oldest is evicted and the
  count is `maxDepth` (this is the clause's paired deletion — it proves the bound genuinely evicts).
  Half 2: a fresh topic, one log frame (the commit) then `maxDepth` **mailbox** frames, assert the commit
  and head survive. Forbids: counting mailbox frames against the same depth — which lets any member evict
  a group's commit log with a flood.

### Important 6 — `purge`'s invariants were asserted for `trim` only

- The purge-empties-log head-survival clause above (shared with Critical 1).
- **`the dedup record outlives the log: a replay after a purge still returns the original sequenceID`** —
  publish a log frame with a `publishID`, `purge` it to nothing (log asserted empty), replay the same
  `publishID`, assert it returns the original sequenceID. Forbids: `purge` dropping the dedup record with
  the frame.

---

## The two real `memoryStore` bugs — red before the fix

Running the new clauses against the **unfixed** reference store (conformance suite, 23 clauses):

```
 × trim removes only log-class frames: a mailbox frame on the same topic is untouched
   AssertionError: expected [] to deeply equal [ '000000000001' ]
 × the depth bound counts only log frames: a mailbox flood cannot evict the commit log
   AssertionError: expected [] to deeply equal [ '000000000018' ]
      Tests  2 failed | 21 passed (23)
```

The other 21 clauses (all three Criticals and Important 6) were green against the reference store from
the start — the reference is correct there; only the suite was silent.

- **Important 4** — `trim` iterated `topicLogs` (which holds both classes) and `removeEntry`'d anything
  below `before`, deleting the pending mailbox frame. Fix: `trim` removes an entry only when
  `entries.get(sequenceID)?.retain === 'log'`.
- **Important 5** — the depth loop was `while (log.length > maxDepth) removeEntry(log[0])`, counting the
  mixed array; a flood of mailbox frames pushed `log.length` over `maxDepth` and evicted the log frame at
  `log[0]`. Fix: on a log publish, count only log-class frames and evict the oldest **log** frame while
  that count exceeds `maxDepth`.

After both fixes: **conformance 23/23 green; `hub-server` 66/66 green.**

---

## Store-mutation checks (red confirmed, then reverted)

For each clause, the minimal wrong change it exists to forbid was applied to `memoryStore`, the targeted
clause was run and confirmed red, and the change reverted (the store was restored byte-for-byte from a
backup and diff-verified after each).

| # | Finding | Wrong change applied | Targeted clause result |
|---|---------|----------------------|------------------------|
| 1 | Critical 1 | `head` derived: `log.length ? log[log.length-1] : null` | both head-stored-state clauses red: `expected null to be '000000000002'` / `'000000000001'` |
| 2 | Critical 2 | `dropDelivery` GCs any class (drop the `retain === 'mailbox'` guard) | unsubscribe clause red: `expected [] to deeply equal ['000000000002']` |
| 3 | Critical 3 | `retain = params.retain ?? 'log'` | absent-retain clause red: `expected [Array(1)] to have a length of +0 but got 1` |
| 4 | Important 4 | `trim` removes any frame below `before` (the pre-fix code) | trim clause red: `expected [] to deeply equal ['000000000001']` |
| 5 | Important 5 | depth loop counts the mixed array (the pre-fix code) | depth clause red: `expected [] to deeply equal ['000000000018']` |
| 6 | Important 6 | `purge` also deletes the dedup record for each purged sequenceID | dedup-after-purge clause red: `HeadMismatchError: expected head null, but the head is 000000000001` (the replay became a new publish and lost its CAS — exactly the JSDoc's predicted failure) |

Every clause can be made to fail by the implementation it targets. The store was confirmed identical to
the fixed version after the last revert.

---

## `types.ts` changes

- **`FetchTopicResult.head`** — added that the head is stored state, not a projection of the log; it
  outlives every frame, and a host that derives it (`SELECT max(sequenceID) WHERE retain='log'`) returns
  null when the log empties and forks the group.
- **`HubStore` JSDoc** — new bullet stating the same, and a sentence on the `'log'` bullet: any depth- or
  count-based bound a host layers on `trim` must count log-class frames only.
- **`TrimParams.before`** — reworded from "Remove log entries" to "Remove `retain: 'log'` frames … and
  **only** those", with the mailbox-mail-loss consequence and the class-scoped-depth requirement spelled
  out.
- **`retain` default** — already unambiguously stated in `PublishParams.retain` ("'mailbox' (default)")
  and the `HubStore` JSDoc ("It is the default"). No change needed; noted here per the brief.

---

## Decisions made (stop-condition disclosures)

1. **`maxDepth` is a new conformance param, optional.** The depth clause can only force eviction if it
   knows the host's bound, and "the depth bound evicts" is a host policy, not a universal contract
   guarantee — so a host with no depth bound omits `maxDepth` and the clause is skipped, and the eviction
   assertion never false-fails an unbounded host. `memoryStore` conformance passes `maxDepth: 16` (≥ 11 so
   the ordering clause's frames survive; small so the run stays quick).

2. **The depth clause's paired deletion is its half-1 eviction, not an in-test mailbox deletion.** Unlike
   the other clauses, nothing *must* be deleted by the mailbox flood in a correct store (mailbox frames
   are bounded by ack and age, not depth), so a "delete-nothing" store is actually correct here. Its rigor
   comes from the mutation check (finding 5) plus half-1 proving the bound genuinely evicts log frames.

3. **The purge-empties-log clauses require the conformance store's default retention to be 0.** A non-zero
   default floors the age bound and `purge({ olderThan: 0 })` would free nothing. This is documented in the
   suite's module JSDoc (`createStore` MUST return a zero-default store), and `memoryStore`'s conformance
   store already is one.

4. **The `maxDepth` semantic changed: it now bounds log-class frames only.** The existing `memoryStore`
   unit test `maxDepth trims the oldest message per topic on publish` asserted mailbox frames were
   depth-bounded — the exact behaviour Important 5 removes. It was rewritten to use log frames (renamed
   `maxDepth evicts the oldest log frame per topic on publish`), and a guard test
   (`maxDepth counts log frames only: a mailbox flood cannot evict the commit log`) was added.

No `packages/rpc` or `packages/mls` change. Every pre-existing clause stayed green.

---

## Full verify output

```
$ rtk proxy pnpm run build
 Tasks:    7 successful, 7 total          (exit 0)

$ rtk proxy pnpm run lint
 biome check --write ./packages ./tests
 Checked 195 files in 202ms. No fixes applied.   (exit 0)

$ rtk proxy pnpm test
 @kumiai/mls:test:unit:          Tests  298 passed (298)
 @kumiai/hub-protocol:test:unit: Tests  8 passed (8)
 @kumiai/broadcast:test:unit:    Tests  35 passed (35)
 @kumiai/hub-tunnel:test:unit:   Tests  63 passed (63)
 @kumiai/hub-server:test:unit:   Tests  66 passed (66)
 @kumiai/hub-client:test:unit:   Tests  5 passed (5)
 @kumiai/rpc:test:unit:          Tests  171 passed | 1 skipped (172)
 Tasks:    27 successful, 27 total          (exit 0)
```

Not committed, per the brief.
