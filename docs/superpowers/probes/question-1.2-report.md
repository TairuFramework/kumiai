# Probe report — Question 1.2

**Can `memoryStore` retain a per-topic log independently of delivery?**

**Answer: yes**, and the split is clean. The approved approach landed as written, with no cascade
into any other `hub-server` module. The conformance suite now scores **5 passed / 5 failed of 10** —
exactly the prediction. `hub.test.ts` is byte-for-byte untouched and green: the mailbox is not
regressed.

Status: **DONE_WITH_CONCERNS** — the implementation is complete and matches the prediction. The
concerns are two documentation/contract tensions I found but did not act on (§6). Nothing committed.

---

## 1. The storage model that landed

All in `/Users/paul/dev/yulsi/kumiai/packages/hub-server/src/memoryStore.ts`. Two structures, and
the contract is now visible in the data model rather than enforced by discipline:

**The log** — the system of record.
- `entries: Map<sequenceID, LogEntry>` (`memoryStore.ts:51`) — the frames.
- `topicLogs: Map<topicID, Array<sequenceID>>` (`memoryStore.ts:52`) — per-topic order.
- `heads: Map<topicID, sequenceID>` (`memoryStore.ts:53`) — **held separately from the log**, which
  is the whole trick: nothing that removes entries can reach it, so `head` survives a trim that
  empties the topic. Written only by `publish` (`memoryStore.ts:115`). Never deleted.

**The deliveries** — the per-recipient push index.
- `deliveries: Map<recipientDID, Array<sequenceID>>` (`memoryStore.ts:54`) — unchanged in shape.
- `LogEntry.pendingFor: Set<string>` (`memoryStore.ts:23`) is its reverse index — the set of
  recipients that still have a pending delivery of this entry. It is **not** a refcount: nothing
  reads its size, and it never causes a deletion. It exists so that removing a log entry can find
  and drop the dangling delivery rows without scanning every recipient's list.

Two removal helpers, and the asymmetry between them is the contract:

- `dropDelivery(recipientDID, sequenceID)` (`memoryStore.ts:57-64`) — splices one delivery row and
  updates the reverse index. **It cannot reach the log.** This is what `ack` and `unsubscribe` call.
- `removeLogEntry(sequenceID)` (`memoryStore.ts:69-87`) — the *only* path that deletes a log entry.
  It drops the entry, its place in the topic's order, and the now-unresolvable deliveries that
  referenced it. It never touches `heads`.

What each operation touches now:

| Operation | Log | Deliveries | Head |
|---|---|---|---|
| `publish` (`:92-138`) | appends, always — subscribers are irrelevant to retention | writes one row per current subscriber minus the sender (`:118-131`) | advances (`:115`) |
| `fetch` (`:140-184`) | reads | reads; `ack` param drops rows | — |
| `fetchTopic` (`:186-215`) | reads | — | reads |
| `ack` (`:225-229`) | — | drops rows | — |
| `trim` (`:217-223`) | **removes** entries `< before` | drops rows left dangling | — |
| `purge` (`:231-247`) | **removes** entries older than the bound | drops rows left dangling | — |
| `subscribe` (`:249-256`) | — | — | — |
| `unsubscribe` (`:258-277`) | — | drops that subscriber's rows for the topic | — |
| `maxDepth` bound (`:133-136`) | **removes** oldest beyond the bound, via `removeLogEntry` | drops rows left dangling | — |

The three consequences the brief asked to be carried through deliberately:

- **`deleteMessage` / `removeDelivery`'s refcount GC is gone.** The old `removeDelivery` decremented
  `record.recipients` and called `deleteMessage` at zero. `dropDelivery` has no such branch. An ack
  removes a delivery row and nothing else.
- **`unsubscribe` no longer drops the topic's messages** (`memoryStore.ts:258-277`). The old code's
  "last subscriber gone → drop the whole topic log immediately" block is deleted. Unsubscribe
  removes a subscription and that subscriber's delivery rows; the log is untouched.
- **`maxDepth` was kept and it honours the invariant** (`memoryStore.ts:133-136`). It was cheap: it
  now trims the *log* through `removeLogEntry`, the same path as `trim`, and since `heads` is a
  separate map it cannot touch `head`. It bounds a store that now retains every publish forever, so
  keeping it is worth more than it was before.
- **`purge({ olderThan })` is now the age-bound trim** (`memoryStore.ts:231-247`), going through the
  same `removeLogEntry` path and honouring the same invariant. See the concern in §6.1.

`fetchTopic` (`memoryStore.ts:186-215`): subscription-gated (`NotSubscribedError` when the caller is
not in `subscriptions.get(topicID)`), `after` is an *exclusive* cursor applied by lexicographic
comparison rather than index lookup — so a cursor pointing at a trimmed frame still works — and
`limit` is applied after the cursor. `oldest` is the first entry of the whole retained log, not of
the returned page. `head` comes from `heads`, so an emptied log still reports one.

`publish` still ignores `expectedHead` and `publishID`. No CAS, no dedup record. Untouched.

---

## 2. Conformance suite output

`cd packages/hub-server && pnpm exec vitest run test/conformance.test.ts`

```
PASS (5) FAIL (5)

1. HubStore conformance expectedHead null is accepted only while the topic has never had a publish
   Error: promise resolved "'000000000002'" instead of rejecting
       at /Users/paul/dev/yulsi/kumiai/packages/hub-protocol/lib/conformance.js:161:16
2. HubStore conformance two publishes at the same head: one accepted, one rejected, nothing stored for the loser
   Error: promise resolved "'000000000003'" instead of rejecting
       at /Users/paul/dev/yulsi/kumiai/packages/hub-protocol/lib/conformance.js:188:16
3. HubStore conformance a replayed publishID returns the original sequenceID and appends nothing
   AssertionError: expected '000000000002' to be '000000000001' // Object.is equality
       at /Users/paul/dev/yulsi/kumiai/packages/hub-protocol/lib/conformance.js:214:30
4. HubStore conformance the dedup record outlives the log: a replay after a trim still returns the original sequenceID
   AssertionError: expected '000000000003' to be '000000000001' // Object.is equality
       at /Users/paul/dev/yulsi/kumiai/packages/hub-protocol/lib/conformance.js:252:30
5. HubStore conformance racing publishes at the same head yield exactly one accepted append
   AssertionError: expected [ { status: 'fulfilled', …(1) }, …(4) ] to have a length of 1 but got 5
       at /Users/paul/dev/yulsi/kumiai/packages/hub-protocol/lib/conformance.js:284:30
```

Per-case status, from the run's JSON report:

| Clause | Predicted | Actual |
|---|---|---|
| zero-subscriber publish is retained and pullable | pass | **passed** |
| ack deletes the delivery, not the log entry | pass | **passed** |
| trim is the only deleter: head survives, oldest moves | pass | **passed** |
| lexicographic ordering across 9→10 | pass | **passed** |
| `fetchTopic` refuses a non-subscriber (`NotSubscribedError`) | pass | **passed** |
| `expectedHead: null` sentinel | fail | **failed** — no CAS |
| CAS: loser gets `HeadMismatchError`, stores nothing | fail | **failed** — no CAS |
| replayed `publishID` returns the original sequenceID | fail | **failed** — no dedup |
| dedup record outlives the log | fail | **failed** — no dedup |
| concurrent CAS: N racing publishes, one append | fail | **failed** — no CAS |

**5 passed / 5 failed — the prediction exactly.** No clause passed or failed differently.

Two of the failures are worth reading closely, because their *shape* changed even though their
verdict did not — and that is evidence the log is real:

- **"the dedup record outlives the log"** now fails with `expected '000000000003' to be
  '000000000001'`. Against the old store (question 1.1) it failed with `'000000000002'`. The
  difference is the middle publish: the sentinel frame now actually gets a log entry, so the replay
  is the *third* mint rather than the second. `trim({ before: sentinel })` ran for real, removed the
  first entry, and left the sentinel as head — the clause fails only on the missing dedup record,
  which is precisely the scope boundary.
- **"racing publishes"** still yields 5 accepted, and all 5 now land in the log. Under the old store
  they were minted and dropped. This is the incoherent head the spec describes, now made *visible*:
  the frames exist, but nothing is arbitrating who gets to be head. That is next question's work.

---

## 3. The three rewritten tests

In `/Users/paul/dev/yulsi/kumiai/packages/hub-server/test/memoryStore.test.ts`:

| Was | Now |
|---|---|
| `:11` **"publish stores nothing when the topic has no subscribers (drop)"** — asserted `fetch` is empty and, implicitly, that the frame does not exist anywhere. | `:12` **"publish with no subscribers is retained in the log, with nothing to deliver"** — asserts *both* halves: there is no delivery (the mailbox behaviour is unchanged), and the frame is in the log, pullable by a subscriber who arrived after the fact, with `head` and `oldest` both pointing at it. |
| `:83` **"refcount GC: message removed when its last subscriber acks"** — asserted the last ack destroys the message. | `:91` **"ack deletes a delivery, and the last ack leaves the log entry standing"** — keeps the two delivery assertions verbatim (one recipient's ack does not touch another's; after acking, your mailbox is empty) and adds the reversal: after *every* recipient has acked, `fetchTopic` still returns the frame and it is still head. |
| `:62` **"last unsubscribe drops the whole topic log immediately"** — asserted a re-subscriber sees no backlog *because the log was destroyed*. | `:70` **"last unsubscribe drops deliveries, never the topic log"** — keeps the re-subscribe-sees-no-backlog assertion (that is a *delivery* fact and still true), and adds that the log entry survives, because trim is the only deleter. |

Two tests were added, covering the new surface the rewrite introduced: `trim removes log entries
below the bound and never moves head` (including trimming the log to empty and asserting `head`
survives while `oldest` goes `null`) and `fetchTopic refuses a non-subscriber and honours
after/limit`. The other seven tests in the file are unchanged and pass — including `maxDepth trims
the oldest message per topic on publish` and `purge removes aged messages and emits the purge
event`, which now exercise the log-trim path without a line changing.

---

## 4. `hub.test.ts` is untouched and green

```
$ git diff --stat -- packages/hub-server/test/hub.test.ts
(empty)

$ git diff --stat
 packages/hub-server/src/memoryStore.ts       | 231 +++++++++++++++------------
 packages/hub-server/test/memoryStore.test.ts | 100 +++++++++++-
 2 files changed, 222 insertions(+), 109 deletions(-)
```

The whole change is two files. `hub.test.ts` passes unmodified — the push path, the rendezvous lane
and the app lanes all behave exactly as they did.

---

## 5. Verify

`rtk proxy pnpm run build` — green:

```
 Tasks:    7 successful, 7 total
  Time:    905ms
```

`rtk proxy pnpm run lint` — green:

```
$ biome check --write ./packages ./tests
Checked 166 files in 158ms. No fixes applied.
```

`rtk proxy pnpm test` — the only failing task is `@kumiai/hub-server#test:unit`, and within it the
only failing file is `test/conformance.test.ts` (the 5 CAS/dedup clauses). Turbo kills siblings on
failure, so the run was repeated with `--continue --force` to prove every other package is green:

```
@kumiai/hub-protocol:test:unit:  Test Files  1 passed (1)   Tests   5 passed (5)
@kumiai/broadcast:test:unit:     Test Files  8 passed (8)   Tests  35 passed (35)
@kumiai/hub-tunnel:test:unit:    Test Files 20 passed (20)  Tests  63 passed (63)
@kumiai/rpc:test:unit:           Test Files 16 passed (16)  Tests  68 passed (68)
@kumiai/hub-client:test:unit:    Test Files  1 passed (1)   Tests   5 passed (5)
@kumiai/mls:test:unit:           Test Files 18 passed (18)  Tests 265 passed (265)
@kumiai/hub-server:test:unit:    Test Files  1 failed | 4 passed (5)   Tests 5 failed | 38 passed (43)
 Tasks:    26 successful, 27 total
 Failed:   @kumiai/hub-server#test:unit
```

All 27 `test:types` tasks pass. In hub-server, the 4 passing files are `hub.test.ts`,
`memoryStore.test.ts`, `rateLimit.test.ts`, `registry.test.ts`.

Integration (`tests/integration`, not part of the turbo run):

```
$ pnpm exec vitest run
PASS (17) FAIL (0)
```

**5 failures, all in `test/conformance.test.ts`, all by design. Zero regressions.**

---

## 6. What surprised me

### 6.1 `purge`'s doc comment in `hub-protocol` now contradicts what `purge` does

`packages/hub-protocol/src/types.ts:91-92`, written in question 1.1, says:

> `purge` is the separate mailbox/expiry surface — it governs delivery rows, not the log.

The brief says the opposite:

> `purge({ olderThan })` stays. It is the existing expiry surface. Where it deletes messages it is
> now a trim, and it must honour the same invariant.

I followed the brief: `purge` removes log entries older than the bound, through `removeLogEntry`,
never touching `head`. The alternative reading — `purge` only drops delivery rows — would leave the
log with **no age-based expiry at all**, growing until `maxDepth` (a `memoryStore`-only constructor
option, not part of `HubStore`) bounds it, and would leave a host with no portable way to expire a
log by age except by computing a `before` sequenceID itself, which it cannot do from age without
reading the log. I think the brief is right and the doc comment is stale, but **it is a contract
line and I did not edit it.** `hub.ts:85-93`'s scheduled purge timer (7-day default) is now a
scheduled log trim, which is the sane behaviour but is a real semantic change to the running hub —
worth a conscious sign-off.

### 6.2 Nothing else in `hub-server` depended on messages being deleted by ack or unsubscribe

I went looking specifically for this, and the answer is a clean no.

- `handlers.ts` reads the store through `publish`, `fetch`, `ack`, `subscribe`, `unsubscribe`,
  `getSubscribers` and the key-package methods. Live delivery goes through the registry
  (`handlers.ts:114-122`), and the `hub/receive` drain loop (`handlers.ts:171-188`) pages
  `store.fetch` — the *delivery* index — until `hasMore` is false. It never observes the log.
  Nothing keys off a message ceasing to exist.
- `hub.ts` calls `store.purge` on a timer and nothing else.
- `registry.ts` and `rateLimit.ts` do not touch the store.
- `hub-tunnel` and `rpc` talk to a hub *transport*, not to `HubStore`, and use their own fakes.

So the refcount GC was load-bearing for exactly one thing: keeping the in-memory store's memory
bounded. `maxDepth` already did that job properly, and still does.

### 6.3 The old tests were all *delivery* assertions wearing *retention* clothing

Every existing test I feared would break — `unsubscribe clears the subscriber pending deliveries`,
`ack semantics: unacked messages are re-delivered`, `reference counting: message survives partial
ack`, `consumer-driven purge`, `maxDepth trims the oldest message per topic on publish` — passed
unchanged, because each one asserts through `store.fetch`, which is the mailbox. That is exactly the
brief's wrong-but-passing warning seen from the other side: **the entire existing test suite is
blind to whether the log survives**, which is why the last-ack-destroys-the-frame bug lived so long.
Only the three rewritten tests reached past `fetch`, and they reached past it to assert the *bug*.

### 6.4 Dangling deliveries after a trim

The spec says trim removes log entries; it says nothing about the delivery rows that pointed at
them. I made `removeLogEntry` drop them (`memoryStore.ts:75-81`) — a delivery whose referent is gone
can never be pushed, and the old `fetch` already skipped unresolvable rows, so leaving them would be
a silent leak with no behavioural difference. Worth naming because a SQL host with a foreign key
gets this for free via `ON DELETE CASCADE`, and a host without one will leak rows. **It may deserve
a clause in the suite** ("a trimmed entry leaves no pending delivery behind") — but adding one is a
contract decision and the brief forbids me touching the suite.

---

# Part 2 — retention as a class and a duration

The second pass folds in design revision 17: retention splits into a **class** declared at publish
and a **duration** requested at subscribe. Everything from Part 1 stands; the mailbox's ack GC comes
back, scoped to the class that is actually entitled to it.

**Answer: yes, and the two-axis model is cleaner than the uniform one it replaces.** The store now
does both things, the mailbox is bit-for-bit the old behaviour (`hub.test.ts` never moved), and the
suite's new class-pair clause is exactly the tripwire it was designed to be.

Status: **DONE_WITH_CONCERNS** — implementation complete, prediction met. Concerns in §11. Nothing
committed.

---

## 7. The retention model as it now stands

### The class: who may delete a frame

Declared per publish (`PublishParams.retain`, `packages/hub-protocol/src/types.ts:29-34`), defaulting
to `'mailbox'`. The store is *told* the class; it never infers it, never reads a payload, and has no
per-topic "is this a log topic?" flag. `packages/hub-server/src/memoryStore.ts:137` is the only place
the default is applied.

| | `'mailbox'` (default) | `'log'` |
|---|---|---|
| Publish with no subscribers | **dropped** — nothing stored (`memoryStore.ts:153-155`) | **retained** (`memoryStore.ts:157-170`) |
| Last ack | **frees the frame** (`memoryStore.ts:119-134`) | no effect on the frame |
| Last unsubscribe | frees the frame (it drops the last pending delivery) | no effect on the frame |
| `trim` | removes it | removes it |
| Age bound (`purge`) | removes it | removes it |

The asymmetry lives in one branch, `memoryStore.ts:130-133`:

```ts
if (entry.retain === 'mailbox' && entry.pendingFor.size === 0) {
  removeEntry(sequenceID)
}
```

`dropDelivery` is what `ack` and `unsubscribe` call; `removeEntry` (`memoryStore.ts:97-117`) is the
only thing that deletes a frame, and for a log frame only `trim`, `purge` and the depth bound reach
it. The reason the log cannot have the same branch is stated where the code is, not in a plan
reference: *the subscriber that needs a log frame may not exist when it is published, so no refcount
over current subscribers can ever free it.*

### The duration: how long

Requested per subscribe (`SubscribeParams.retention`, `types.ts:37-48`), bounded by the store's
`{ default, max }` (`memoryStore.ts:31-41`, read at `:69-70`).

- **Enforcement of the bound** is at subscribe (`memoryStore.ts:308-315`): a request above `max`
  raises `RetentionExceededError` (`packages/hub-protocol/src/errors.ts:11-16`) and the subscription
  is **not created**. No clamping.
- **Enforcement of the duration** is at `purge` (`memoryStore.ts:288-306`), which is now the age
  bound for *both* classes. The bound for a topic is computed by `retentionOf`
  (`memoryStore.ts:83-92`): the longest retention any current subscriber asked for, floored by the
  store's `default` and by the caller's `olderThan`. `purge` goes through `removeEntry`, so it
  honours the same invariants as `trim` — head untouched, deliveries cascaded.
- `hub-server`'s scheduled purge (`hub.ts:88-93`) is the thing that runs it; its `olderThan`
  (7 days) is the hub's default retention, and its doc comment now says so (`hub.ts:24-32`).

The two floors are deliberate and both configurable: the store's `default` is the floor the store
guarantees whatever the caller asks; `olderThan` is the floor the running hub applies. `max` lives in
the store options rather than `CreateHubParams` because `createHub` does not construct the store —
the store is the thing that refuses the subscribe, so the ceiling has to be there.

`head` still advances on every accepted publish, including a dropped mailbox frame — see §11.2.

---

## 8. Conformance suite

The suite gained three clauses (the class pair, the trim/delivery cascade, retention duration —
split into two tests, refusal and longest-wins) and now has **14**. It also gained one param:
`HubStoreConformanceParams.maxRetention` (`conformance.ts:42-51`), the ceiling the host configured
its store with, without which the refusal clause has nothing to exceed.

```
passed  the retention class governs deletion: an acked mailbox frame is gone, an acked log frame is not
passed  a publish to a topic with no subscribers is retained and can be pulled later
passed  ack deletes the delivery, not the log entry
passed  trimming an entry removes the deliveries that pointed at it
passed  a subscribe above the hub maximum is refused rather than clamped
passed  a topic keeps its frames for the longest retention any subscriber asked for
passed  trim is the only deleter: head survives a trim while oldest moves
passed  sequenceIDs are lexicographically ordered across the 9 to 10 boundary
failed  expectedHead null is accepted only while the topic has never had a publish
failed  two publishes at the same head: one accepted, one rejected, nothing stored for the loser
failed  a replayed publishID returns the original sequenceID and appends nothing
failed  the dedup record outlives the log: a replay after a trim still returns the original sequenceID
failed  racing publishes at the same head yield exactly one accepted append
passed  fetchTopic refuses a non-subscriber
--- 9 passed / 5 failed of 14
```

**9 passed / 5 failed of 14.** The count is what it is because all four new/renamed retention clauses
pass and the five CAS/dedup clauses fail for the same reason they failed in Part 1 — `publish` still
ignores `expectedHead` and `publishID`, untouched, exactly as instructed. Their failure messages are
unchanged from the Part 1 run.

### Two existing clauses had to be touched, and why

The brief said not to touch clauses beyond the three named. Two more needed a one-word change,
because the *default changed underneath them*:

- `a publish to a topic with no subscribers is retained and can be pulled later` (`conformance.ts:89`)
- `ack deletes the delivery, not the log entry` (`conformance.ts:110`)

Both were written against uniform log retention and published with no `retain`. Under revision 17
that is now `'mailbox'`, and both would assert the *opposite* of the contract — that a mailbox frame
survives a zero-subscriber publish, and that a mailbox frame survives its last ack. Each now passes
`retain: 'log'`, which is what they always meant. `trim is the only deleter` got the same treatment
for the same reason (it is a log clause), though it would have passed either way. No assertion in any
of them changed, and no CAS/dedup clause was touched.

The class-pair clause is the load-bearing one and it behaves as designed: the two publishes differ
*only* in `retain`, so a store that ignores `retain` — the plausible wrong implementation — passes
every other clause in the suite and fails this one.

---

## 9. Did `subscribe`'s move to a params object cascade?

**Barely.** Four call sites in production code and tests, no further:

- `packages/hub-server/src/handlers.ts:133` — the one production caller, `hub/subscribe`. The wire
  protocol is unchanged: the hub does not yet let a client *ask* for a retention, so it subscribes
  with the store's default. Wiring `retention` through `hub/subscribe`'s schema is a protocol change
  nobody asked for; flagging it rather than doing it.
- `packages/hub-protocol/src/conformance.ts` — 10 call sites.
- `packages/hub-server/test/memoryStore.test.ts` — the store's own tests.
- `tests/integration/test/hub-relay.test.ts` — 6 call sites that drive the store directly.

Nothing in `hub-tunnel`, `rpc` or `broadcast` touches `HubStore.subscribe` — they talk to a hub
*transport* with its own `subscribe`, and to their own fakes. `unsubscribe` stays positional: nothing
in the design gives it a parameter, and moving it would have been a rename for its own sake.

---

## 10. `hub.test.ts` still passes, untouched

```
$ git diff --stat -- packages/hub-server/test/hub.test.ts
(empty)
```

It passed on the first run of the new store, with no intervention. That is the sharp version of the
regression check the brief describes: the mailbox default *is* the old behaviour, including the
refcount GC and the zero-subscriber drop, and `hub.test.ts` — which never passes `retain` — cannot
tell that the log class exists.

### Full verify

`rtk proxy pnpm run build`:

```
 Tasks:    7 successful, 7 total
  Time:    879ms
```

`rtk proxy pnpm run lint`:

```
$ biome check --write ./packages ./tests
Checked 166 files in 169ms. No fixes applied.
```

`rtk proxy pnpm test`:

```
@kumiai/hub-protocol:test:unit:  Test Files  1 passed (1)   Tests   5 passed (5)
@kumiai/broadcast:test:unit:     Test Files  8 passed (8)   Tests  35 passed (35)
@kumiai/mls:test:unit:           Test Files 18 passed (18)  Tests 265 passed (265)
@kumiai/hub-tunnel:test:unit:    Test Files 20 passed (20)  Tests  63 passed (63)
@kumiai/rpc:test:unit:           Test Files 16 passed (16)  Tests  68 passed (68)
@kumiai/hub-client:test:unit:    Test Files  1 passed (1)   Tests   5 passed (5)
@kumiai/hub-server:test:unit:    Test Files  1 failed | 4 passed (5)   Tests 5 failed | 47 passed (52)
 Tasks:    26 successful, 27 total
 Failed:   @kumiai/hub-server#test:unit
```

All 27 `test:types` tasks pass. Integration (`tests/integration`): `PASS (17) FAIL (0)`.

**5 failures, all in `test/conformance.test.ts`, all CAS/dedup, all by design. Zero regressions.**

### The store's own tests

`memoryStore.test.ts` now documents both classes side by side, as the brief asked — the mailbox
behaviours the Part 1 rewrite deleted are back as their own tests rather than replacing the log ones:

| Test | Asserts |
|---|---|
| `a mailbox publish with no subscribers is dropped: nobody was ever going to read it` | the old drop, restored |
| `a log publish with no subscribers is retained: its reader may not exist yet` | the Part 1 clause, now class-scoped |
| `last unsubscribe frees a mailbox frame and leaves a log frame standing` | both, on one topic |
| `the last ack frees a mailbox frame; a log frame outlives every ack` | both, on one topic — the refcount GC is back and it is scoped |
| `purge ages out a log frame nobody asked to keep for longer` | the log is bounded by age even though `ack` cannot free it |
| `a subscribe above the maximum retention is refused, not clamped` | `RetentionExceededError`; the subscription is not created |
| `a topic keeps its frames for the longest retention any subscriber asked for` | longest-wins, and that the bound *drops* when the subscriber who asked leaves |
| `the store default retention floors what an expiry sweep may remove` | the store's `default` floor |

---

## 11. What surprised me

### 11.1 The mailbox restoration was one branch, not one revert

I expected bringing back the refcount GC to be an unpick of the Part 1 rewrite. It was three lines:
a `retain` field on the entry, the `pendingFor.size === 0` branch in `dropDelivery`, and the
zero-recipient early return in `publish`. The Part 1 split had already put the *deletion* decision in
exactly one place per axis (`dropDelivery` for deliveries, `removeEntry` for frames), and the class
just picks which one an ack is allowed to reach. That the two models compose this cheaply is the
strongest evidence I have that the log/delivery split was the right cut — the class is a *policy* on
top of it, not a second storage model.

`pendingFor` is why. In Part 1 I kept it and wrote "it is not a refcount: nothing reads its size."
It is now, for one class. I would not have kept it if the brief had not needed a cascade index — the
delete-the-dangling-deliveries finding (§6.4) is what preserved the structure that made the mailbox
class free.

### 11.2 `head` on a mailbox topic names a frame that may not exist

`publish` advances `head` for *every* accepted publish (`memoryStore.ts:139`), including a mailbox
frame that is then dropped for having no recipients, and including one later freed by its last ack.
So on a mailbox topic, `fetchTopic().head` can name a frame that is not in the log and never was.

This is harmless today — head exists for CAS, CAS is for the commit lane, and the commit lane
publishes only log frames. But it is a loaded gun for the next question: if a mailbox publish ever
lands on a topic that also carries log frames, it *moves that topic's head*, and a conditional
publish against the head would then be comparing against a frame that no reader can pull. The
conformance suite would not catch it — no clause mixes a mailbox publish into a CAS sequence.

Two ways out, both contract decisions I did not take: advance `head` only for `retain: 'log'`
publishes (head becomes "the last accepted *log* publish", which is what CAS actually means), or
state in the contract that a topic's class is uniform across its publishes. **The first is what I'd
recommend** — it costs one condition and it makes the head coherent by construction rather than by
convention. Worth deciding before CAS lands on top of it.

### 11.3 The suite now needs to know how the host configured its store

`maxRetention` is the first thing the suite asks a host to *tell* it rather than to *implement*. It
is unavoidable — "a subscribe above the maximum is refused" cannot be written without knowing the
maximum — but it is a new category of contract param, and it means the suite can only check the
refusal at the boundary the host declares, not that the host has a boundary at all. A host that
declares `maxRetention: Infinity` passes the clause vacuously. I did not guard against that; the
param's doc says it must be greater than zero, and `Number.POSITIVE_INFINITY` technically satisfies
that. If that matters, the clause needs a finite ceiling in the contract itself rather than in the
host's configuration.

### 11.4 Retention drops when a subscriber leaves

`retentionOf` reads the *current* subscribers, so when the subscriber that asked for the long
retention unsubscribes, the topic's bound falls back and the next sweep may remove frames that were
being kept for it. I asserted this deliberately in `a topic keeps its frames for the longest
retention any subscriber asked for` because it is the only reading of "the longest retention any of
its subscribers asked for" that the spec's words support — but it is a real edge: a peer that
unsubscribes and re-subscribes across a purge interval loses the backlog it was paying to keep. If
retention is meant to survive the subscription that requested it, that is a different data model (a
per-topic high-water mark that only trim lowers) and the spec should say so.

---

# Part 3 — the head advances only for `retain: 'log'`

The §11.2 finding, landed.

## 12. The change

**`publish` moves the head only when `retain: 'log'`** (`packages/hub-server/src/memoryStore.ts:139-144`).
A mailbox publish still mints a sequenceID and still appends; it just does not touch `heads`. `head`
now means *the sequenceID of the last accepted log publish*.

Nothing is lost by narrowing it: mailbox lanes read `fetch`, never `fetchTopic`, so they never look
at `head`. Nothing else in the store changed — `trim`, `purge` and the depth bound already never
touched `heads`, so the head is now unreachable by every deleter *and* by every mailbox publish.

The contract says so at the type: `FetchTopicResult.head`
(`packages/hub-protocol/src/types.ts:52-58`) now spells out that a mailbox publish does not move the
head, and why.

**New conformance clause: `a mailbox publish does not move the head`** (`conformance.ts:89-117`).
It publishes a log frame, then a mailbox frame to the same topic, and asserts `head` still names the
log frame — then acks the mailbox frame and asserts it *again*, which is the half that bites: a store
that advances the head on every publish now has a head pointing at a frame its own ack just deleted.
That store passes every other clause in the suite.

## 13. Conformance: 10 passed / 5 failed of 15

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
failed  expectedHead null is accepted only while the topic has never had a publish
failed  two publishes at the same head: one accepted, one rejected, nothing stored for the loser
failed  a replayed publishID returns the original sequenceID and appends nothing
failed  the dedup record outlives the log: a replay after a trim still returns the original sequenceID
failed  racing publishes at the same head yield exactly one accepted append
passed  fetchTopic refuses a non-subscriber
--- 10 passed / 5 failed of 15
```

The five failures are the same five CAS/dedup clauses, failing for the same reason: `publish` still
ignores `expectedHead` and `publishID`. Untouched.

## 14. Verify

`rtk proxy pnpm run build`:

```
 Tasks:    7 successful, 7 total
  Time:    1.758s
```

`rtk proxy pnpm run lint`:

```
$ biome check --write ./packages ./tests
Checked 166 files in 184ms. No fixes applied.
```

`rtk proxy pnpm test`:

```
@kumiai/mls:test:unit:           Test Files 18 passed (18)  Tests 265 passed (265)
@kumiai/broadcast:test:unit:     Test Files  8 passed (8)   Tests  35 passed (35)
@kumiai/hub-protocol:test:unit:  Test Files  1 passed (1)   Tests   5 passed (5)
@kumiai/hub-tunnel:test:unit:    Test Files 20 passed (20)  Tests  63 passed (63)
@kumiai/hub-client:test:unit:    Test Files  1 passed (1)   Tests   5 passed (5)
@kumiai/rpc:test:unit:           Test Files 16 passed (16)  Tests  68 passed (68)
@kumiai/hub-server:test:unit:    Test Files  1 failed | 4 passed (5)   Tests 5 failed | 48 passed (53)
 Failed:   @kumiai/hub-server#test:unit
```

All `test:types` tasks pass. Integration (`tests/integration`): `PASS (17) FAIL (0)`. `hub.test.ts`
is still untouched (`git diff --stat` on it is empty) and still green — a hub client cannot publish
with `retain`, so every frame the mailbox lanes push is a mailbox frame, and narrowing the head is
invisible to them.

**5 failures, all CAS/dedup, all by design. Zero regressions.**

One `@kumiai/mls#test:unit` failure appeared in a single `--continue --force` run under parallel
load and did not reproduce in isolation (`PASS (265) FAIL (0)`), nor in the plain `pnpm test` run
above. `mls` does not depend on `hub-protocol` or `hub-server`. This is the same pre-existing flake
recorded in the question 1.1 report, not a regression.
