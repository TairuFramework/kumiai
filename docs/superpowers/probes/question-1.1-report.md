# Probe report — Question 1.1

**Does a conformance suite written from the spec actually fail today's store?**

**Answer: yes.** 9 of the suite's 10 cases fail against the unmodified `memoryStore`. The one
that passes (lexicographic ordering) passes for a real reason: `formatSequenceID` already
zero-pads to 12 digits.

Status: **DONE_WITH_CONCERNS** — the suite fails as predicted, but three of the four cases the
brief named are *masked* by the `fetchTopic` throwing stub rather than failing on their own
assertion. Independent evidence below shows the underlying failure is real. No store behaviour
was changed. Nothing committed.

---

## 1. What today's `memoryStore` actually does

Retention is entirely a function of delivery. Three mechanisms, all in
`/Users/paul/dev/yulsi/kumiai/packages/hub-server/src/memoryStore.ts`:

1. **A publish with no recipients stores nothing.** `publish` mints a sequenceID
   (`memoryStore.ts:93`), computes `recipients` = current subscribers minus the sender, and if
   that set is empty it returns the sequenceID **without writing a message record**
   (`memoryStore.ts:105-107`). The caller gets an ID for a frame that does not exist. The
   `topicMessages` index (`memoryStore.ts:128-136`) is only written on the delivery path, so
   it is not a log — it is a fan-out index that happens to be keyed by topic.
2. **The last ack deletes the frame.** `ack` → `removeDelivery` decrements a refcount and calls
   `deleteMessage` when the last recipient is gone (`memoryStore.ts:83-85`), which removes the
   row from `messages`, from every delivery list, and from `topicMessages`
   (`memoryStore.ts:53-70`).
3. **Two other things also delete frames**, which the spec says only trim may do:
   `unsubscribe` drops the whole topic index when the last subscriber leaves
   (`memoryStore.ts:242-250`), and the depth bound trims on publish (`memoryStore.ts:135-137`).

There is **no head**, **no `expectedHead` comparison**, **no `publishID`**, and **no dedup
record** anywhere in the file — `publish` reads only `senderDID`, `topicID`, `payload`. The
age-based deleter is `purge` (`memoryStore.ts:200-207`), which is the only portable trim the
contract exposes; the suite drives trim through it.

The store's own existing tests assert the two behaviours the spec calls broken, and they pass
today: `packages/hub-server/test/memoryStore.test.ts:11` ("publish stores nothing when the
topic has no subscribers (drop)") and `:83` ("refcount GC: message removed when its last
subscriber acks"). The spec's reading of the store is correct.

---

## 2. What was added

Type surface (`packages/hub-protocol/src/types.ts`), verbatim from the spec:
`PublishParams.expectedHead`, `PublishParams.publishID`, `FetchTopicParams`,
`FetchTopicResult`, `HubStore.fetchTopic`. Both new `PublishParams` fields are optional, so no
existing caller changed. `HeadMismatchError` is a new
`packages/hub-protocol/src/errors.ts`, following the `hub-tunnel/src/errors.ts` pattern
(`override name = '...'`). Both are re-exported from `packages/hub-protocol/src/index.ts`.

The `HubStore` type now carries a doc comment stating the log/mailbox split, the ordering
contract, and the one-transaction requirement, so the contract is readable at the type.

**Suite:** `packages/hub-protocol/src/conformance.ts`, exported from the new
`@kumiai/hub-protocol/conformance` subpath. Export shape:

```ts
import { testHubStoreConformance } from '@kumiai/hub-protocol/conformance'

testHubStoreConformance({ createStore: () => new SQLHubStore(freshDatabase()) })
```

One exported function, one param (`createStore: () => HubStore | Promise<HubStore>`, called
once per case so every case gets an empty store). It registers a `describe` block of `test`s
via vitest. That is how a host — kubun — runs the contract against its own SQL store.

**`memoryStore` stub:** the only change to `memoryStore.ts` is a `fetchTopic` that throws
`new Error('fetchTopic is not implemented')` (`memoryStore.ts:190-192`), plus the two type
imports it needs. No log, no CAS, no dedup; `publish`, `fetch`, `ack`, `purge`,
`deleteMessage`, `removeDelivery` and the retention rules are byte-for-byte unchanged.

### Package.json changes (flagging, per the "don't touch build config" convention)

Two were unavoidable and are part of the deliverable, not drive-bys:

- `packages/hub-protocol/package.json` gains an `"./conformance": "./lib/conformance.js"`
  export. It is a **separate subpath on purpose**: the suite imports `vitest`, and putting it
  behind the main entry would make every production consumer of `@kumiai/hub-protocol` load
  vitest at runtime.
- `vitest` added as an **optional peerDependency** (hosts already have it; the main entry never
  needs it) and a devDependency, both `catalog:`. `pnpm-lock.yaml` updated by `pnpm install`.

---

## 3. The failure output (unmodified `memoryStore`)

`cd packages/hub-server && pnpm exec vitest run test/conformance.test.ts`

```
 RUN  v4.1.10 /Users/paul/dev/yulsi/kumiai/packages/hub-server

 ❯ test/conformance.test.ts (10 tests | 9 failed) 9ms
     × a publish to a topic with no subscribers is retained and can be pulled later 4ms
     × ack deletes the delivery, not the log entry 1ms
     × trim is the only deleter: head survives a trim while oldest moves 0ms
     × expectedHead null is accepted only while the topic has never had a publish 1ms
     × two publishes at the same head: one accepted, one rejected, nothing stored for the loser 0ms
     × a replayed publishID returns the original sequenceID and appends nothing 1ms
     × the dedup record outlives the log: a replay after a trim still returns the original sequenceID 0ms
     × racing publishes at the same head yield exactly one accepted append 1ms
     × fetchTopic refuses a non-subscriber 0ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 9 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/conformance.test.ts > HubStore conformance > a publish to a topic with no subscribers is retained and can be pulled later
Error: fetchTopic is not implemented
 ❯ Object.fetchTopic src/memoryStore.ts:191:13
    190|     async fetchTopic(_params: FetchTopicParams): Promise<FetchTopicRes…
    191|       throw new Error('fetchTopic is not implemented')
       |             ^
 ❯ ../hub-protocol/lib/conformance.js:56:40

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/9]⎯

 FAIL  test/conformance.test.ts > HubStore conformance > ack deletes the delivery, not the log entry
Error: fetchTopic is not implemented
 ❯ Object.fetchTopic src/memoryStore.ts:191:13
 ❯ ../hub-protocol/lib/conformance.js:85:40

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/9]⎯

 FAIL  test/conformance.test.ts > HubStore conformance > trim is the only deleter: head survives a trim while oldest moves
Error: fetchTopic is not implemented
 ❯ Object.fetchTopic src/memoryStore.ts:191:13
 ❯ ../hub-protocol/lib/conformance.js:107:40

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/9]⎯

 FAIL  test/conformance.test.ts > HubStore conformance > expectedHead null is accepted only while the topic has never had a publish
AssertionError: promise resolved "'000000000002'" instead of rejecting

- Expected:
Error {
  "message": "rejected promise",
}

+ Received:
"000000000002"

 ❯ ../hub-protocol/lib/conformance.js:156:16
    154|                 payload: payload(2),
    155|                 expectedHead: null
    156|             })).rejects.toThrow(HeadMismatchError);
       |                ^

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/9]⎯

 FAIL  test/conformance.test.ts > HubStore conformance > two publishes at the same head: one accepted, one rejected, nothing stored for the loser
AssertionError: promise resolved "'000000000003'" instead of rejecting

- Expected:
Error {
  "message": "rejected promise",
}

+ Received:
"000000000003"

 ❯ ../hub-protocol/lib/conformance.js:183:16
    181|                 payload: payload(3),
    182|                 expectedHead: first
    183|             })).rejects.toThrow(HeadMismatchError);
       |                ^

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/9]⎯

 FAIL  test/conformance.test.ts > HubStore conformance > a replayed publishID returns the original sequenceID and appends nothing
AssertionError: expected '000000000002' to be '000000000001' // Object.is equality

Expected: "000000000001"
Received: "000000000002"

 ❯ ../hub-protocol/lib/conformance.js:209:30
    209|             expect(replayed).toBe(sequenceID);
       |                              ^

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/9]⎯

 FAIL  test/conformance.test.ts > HubStore conformance > the dedup record outlives the log: a replay after a trim still returns the original sequenceID
AssertionError: expected '000000000002' to be '000000000001' // Object.is equality

Expected: "000000000001"
Received: "000000000002"

 ❯ ../hub-protocol/lib/conformance.js:240:30
    240|             expect(replayed).toBe(sequenceID);
       |                              ^

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[7/9]⎯

 FAIL  test/conformance.test.ts > HubStore conformance > racing publishes at the same head yield exactly one accepted append
AssertionError: expected [ { status: 'fulfilled', …(1) }, …(4) ] to have a length of 1 but got 5

- Expected
+ Received

- 1
+ 5

 ❯ ../hub-protocol/lib/conformance.js:270:30
    270|             expect(accepted).toHaveLength(1);
       |                              ^

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[8/9]⎯

 FAIL  test/conformance.test.ts > HubStore conformance > fetchTopic refuses a non-subscriber
Error: fetchTopic is not implemented
 ❯ Object.fetchTopic src/memoryStore.ts:191:13
 ❯ ../hub-protocol/lib/conformance.js:290:41

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[9/9]⎯

 Test Files  1 failed (1)
      Tests  9 failed | 1 passed (10)
```

### Did each case fail for the reason the spec predicts?

| Case | Failure | Spec-predicted reason? |
|---|---|---|
| zero-subscriber publish is retained | `Error: fetchTopic is not implemented` | **Masked.** Reason is real (see §4) but the assertion never ran. |
| ack does not delete | `Error: fetchTopic is not implemented` | **Masked.** Same. |
| trim is the only deleter | `Error: fetchTopic is not implemented` | **Masked.** Same. |
| `expectedHead: null` sentinel | promise resolved `'000000000002'` instead of rejecting | **Yes** — no CAS: `publish` ignores `expectedHead` and appends. |
| CAS: loser gets `HeadMismatchError` | promise resolved `'000000000003'` instead of rejecting | **Yes** — no CAS; the loser is accepted and stored. |
| replayed `publishID` | got `'000000000002'`, expected `'000000000001'` | **Yes** — no dedup record; the replay is an ordinary new append. |
| **dedup outlives trim** (load-bearing) | got `'000000000002'`, expected `'000000000001'` | **Yes** — no dedup record at all, so trim is not even needed to lose it. |
| concurrent CAS | 5 accepted, expected 1 | **Yes** — no CAS. See caveat in §5. |
| `fetchTopic` refuses a non-subscriber | `Error: fetchTopic is not implemented` | **Masked.** The suite's positive assertion (a subscriber CAN read) runs first, so the stub cannot false-pass this clause — see §5. |
| lexicographic ordering across 9→10 | **passes** | Correct: `formatSequenceID` pads to 12 (`memoryStore.ts:29-31`). A host minting bare decimals fails here. |

**The masking is structural, not a suite defect.** Every clause about the log has to read the
log, and the only contract read path is `fetchTopic`, which does not exist on today's store.
There is no way to phrase "the log retained the frame" against a store with no log without
first calling the method that would expose it. The brief sanctioned the throwing stub; this is
its inevitable consequence.

---

## 4. Independent evidence that the three masked cases fail for the predicted reason

Run against the **unmodified** store's existing API only (no `fetchTopic`), so the stub cannot
interfere. Scratch script, not committed:

```
zero-subscriber publish -> sequenceID minted: 000000000001
  frames recoverable after subscribing: 0
after the last subscriber acks -> frames still readable: 0
publish with expectedHead "bogus-head" on a fresh topic -> 000000000001 (accepted, no throw)
republish of publishID "p1" -> 000000000002 (new sequenceID, appended again)
```

Line 1-2: `publish` to a topic with no subscribers hands back sequenceID `000000000001` and the
frame is unrecoverable by any read path — the store minted an ID for nothing. That is exactly
the incoherent head the spec describes: a head that could advance past frames that were never
stored.

Line 3: after the last subscriber acks, the frame is gone. `ack` destroyed a log entry.

Lines 4-5: `expectedHead` and `publishID` are silently ignored — a store that "satisfies the
type" today would accept a conditional publish against a bogus head, and would turn a replayed
commit into a second commit. This is the failure mode the spec calls fatal for restart replay.

Backing this up, the store's own current tests *assert* the broken behaviour and pass:
`memoryStore.test.ts:11` and `memoryStore.test.ts:83`. When question 1.2 makes the store
conformant, **those two existing tests must be rewritten** — they encode the old contract.

---

## 5. Verify

`rtk proxy pnpm run build` — green:

```
 Tasks:    7 successful, 7 total
  Time:    1.35s
```

`rtk proxy pnpm run lint` — green:

```
$ biome check --write ./packages ./tests
Checked 166 files in 163ms. No fixes applied.
```

`rtk proxy pnpm test` (`turbo run test:types test:unit`) — the **only** failing task is
`@kumiai/hub-server#test:unit`, and within it the **only** failing file is the new
`test/conformance.test.ts`. Turbo's default behaviour kills sibling tasks when one fails, so
the run was repeated with `--continue --force` to prove every other package is green:

```
@kumiai/hub-protocol:test:unit:  Test Files  1 passed (1)   Tests   5 passed (5)
@kumiai/broadcast:test:unit:     Test Files  8 passed (8)   Tests  35 passed (35)
@kumiai/hub-tunnel:test:unit:    Test Files 20 passed (20)  Tests  63 passed (63)
@kumiai/rpc:test:unit:           Test Files 16 passed (16)  Tests  68 passed (68)
@kumiai/hub-client:test:unit:    Test Files  1 passed (1)   Tests   5 passed (5)
@kumiai/mls:test:unit:           Test Files 18 passed (18)  Tests 265 passed (265)
@kumiai/hub-server:test:unit:    Test Files  1 failed | 4 passed (5)   Tests 9 failed | 32 passed (41)
 Tasks:    26 successful, 27 total
 Failed:   @kumiai/hub-server#test:unit
```

All 27 `test:types` tasks pass — the type additions cascade nowhere. `hub.test.ts`,
`memoryStore.test.ts`, `rateLimit.test.ts`, `registry.test.ts` all still pass (the 32 passing
in hub-server). Integration tests (`tests/integration`, not part of the turbo run) also pass:
`Test Files 3 passed (3) | Tests 17 passed (17)`.

**Expected failure vs. regression:** 9 failures, all in `test/conformance.test.ts`, all by
design. Zero regressions.

---

## 6. Things that surprised me / concerns

1. **The stub masks three of the four clauses the brief expected to fail on their own terms.**
   Structural, unavoidable, and documented above with independent evidence. Worth knowing that
   the suite's *fail-loudly* value against a partially-migrated host store is higher than
   against today's store, where the missing method swallows the first assertion in each case.

2. **Today's store fails the CAS clauses too**, which the brief's done-when list did not
   enumerate (it named zero-subscriber, ack-does-not-delete, dedup-outlives-trim, `fetchTopic`
   missing). `expectedHead` is silently ignored, so the sentinel case, the two-publishes case
   and the concurrent case all fail. Not a problem, but the done-when list undercounted: the
   real number is 9 of 10.

3. **`fetchTopic`'s non-subscriber refusal has no named error type in the spec.** The verbatim
   type surface only names `HeadMismatchError`. A clause of the form
   `await expect(fetchTopic(nonSubscriber)).rejects.toThrow()` would be satisfied by *any*
   throw — including the not-implemented stub — which is a genuine false-pass hazard for a host
   partway through migration. The suite works around it by asserting the positive case (a
   subscriber CAN read) first in the same test, so a store that throws for everything still
   fails. **Recommendation for the spec: name the refusal error** (e.g. `NotSubscribedError` in
   `hub-protocol`) so this clause can be asserted directly. I did not add it — that is a
   contract decision, not a probe decision.

4. **Trim is only expressible portably through `purge({ olderThan: 0 })`.** The contract has no
   per-topic trim, and `maxDepth` is a `memoryStore` constructor option, not part of `HubStore`.
   So the trim clauses trim *everything*: the suite asserts `oldest` moves (to `null`) while
   `head` survives, which is the strongest portable form. The spec's "trim by depth and age"
   has no depth surface on `HubStore` at all — **if depth trim is meant to be part of the
   contract, `HubStore` needs a way to express it**, otherwise no host can be tested for
   "depth trim moves `oldest` and never touches `head`". The suite's doc comment tells hosts to
   verify depth trim themselves.

5. **`purge` may be the wrong name for trim now.** In the new model `purge` *is* the trim, and
   it is the only legal deleter — but `unsubscribe` also deletes the topic log today
   (`memoryStore.ts:242-250`). Question 1.2 will have to decide whether unsubscribe still nukes
   the log; under the spec ("trim is the only thing that removes a log entry") it must not, and
   `memoryStore.test.ts:62` ("last unsubscribe drops the whole topic log immediately") is a
   third existing test that will have to be rewritten.

6. **One flaky `mls` test failure** appeared in a single full-suite run under parallel load
   (`Tests 1 failed | 264 passed`), and did not reproduce in three subsequent runs (isolated and
   forced full re-run: 265/265). `mls` has no dependency on `hub-protocol`, so it cannot be
   related to this change. Flagging it as a pre-existing flake, not a regression.

7. **`vitest` in a published package's peer deps.** The suite is production code in `src/` per
   the brief, so `@kumiai/hub-protocol` now advertises an optional `vitest` peer. It is behind
   its own subpath so the main entry stays clean, but it does mean the contract suite is
   vitest-shaped: a host on a different runner cannot use it. If that matters, the alternative
   is exporting the cases as data (`Array<{ name, run(store) }>`) and letting the host adapt
   them — more code, and no host in the stack uses anything but vitest.
