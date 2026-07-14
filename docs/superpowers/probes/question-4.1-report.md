# Question 4.1 — report

**Status: DONE_WITH_CONCERNS.** Four tests, all green, **with no `src/` change**. The sole member
recovers from the journal alone, at both crash points, with the log intact and with the log swept
away. It publishes to the rendezvous topic **zero times**.

The concerns are not about the behaviour, which is correct. They are about *why* it is correct, and
about a fixture that turned out not to need building.

---

## 1. The startup ordering, established empirically

**The seed pull DOES NOT meet the peer's own un-merged commit.** The journal replay runs strictly
ahead of the pull and leaves a cursor past the peer's own frame, so the pull reads an empty page.

`initControlLanes` (`packages/rpc/src/peer.ts:854`) seeds the lane as one serialized operation:

```
runSerial: replayJournal()  →  ensureLedger()  →  pullCommits()
```

and `ready` is `initControlLanes()` then `buildEpoch()`; the deferred
`void settled.then(() => healIfRequested())` at `peer.ts:1417` is what would run a heal the seed
asked for. So the trap the brief describes — the own-commit row firing in a group with nobody to
heal from — is closed **by the ordering, and only by the ordering**.

### The evidence

The tests do not infer this. `recordingHub` in
`packages/rpc/test/peer-first-commit-crash.test.ts` wraps `fetchTopic` and records every commit-log
frame the pull was actually handed. In all four tests:

```
expect(pulled).toEqual([])
```

and in the two untrimmed tests, the frame demonstrably **is** in the log the peer is about to read —
asserted directly against the hub, before the restart:

```
const log = await hub.fetchTopic({ subscriberDID: 'alice', topicID: commits })
expect(log.messages).toHaveLength(1)
```

So the untrimmed pull read a log that contained exactly one frame — the peer's own un-merged commit
— and came back with nothing, because `replayJournal` had already set `reconciledHead` to that
frame's position (`peer.ts:969-971`).

### And the heal request is NOT cancelled by the replay

This is the load-bearing point, and it is worth stating plainly because the code does not.
`healRequested` is set by the pull (`peer.ts:679`) and is cleared in exactly two places —
`healIfRequested` (`peer.ts:1392`) and the top of `recover()`'s loop (`peer.ts:1270`). **`replayJournal`
never clears it.** Adopting the commit does not retract the request to heal from it.

The design does not need the cancellation *because* replay precedes the pull in every lane operation
— the seed (`peer.ts:854`), the delivery wakeup (`peer.ts:793`), `commit()` (`peer.ts:1073`),
`replay()` (`peer.ts:1185`) and `recover()` (`peer.ts:1259`) all replay at step 0. The ordering is
uniform, so the flag can only ever be raised by a *genuine* own-unmerged frame: one whose journal
slot was lost or never written. That is a peer for which a heal is the right answer.

But it means the safety of the group of one rests on a single ordering constraint with **no
independent guard behind it**, and I proved that by inverting it (§4).

---

## 2. The red output before any fix

There was none. **All four tests passed on their first run**, with no source change:

```
 ✓ the hub took the commit and the process died before the acceptance was recorded: the journal republishes, and nobody is asked 71ms
 ✓ the log is trimmed before the restart: replay still returns the original sequenceID, and the peer still adopts 66ms
 ✓ the acceptance was recorded and the process died before the host adopted: the peer adopts from the slot, and touches no network 66ms
 ✓ the acceptance was recorded and the log is trimmed: the slot alone is enough, and the trim changes nothing 67ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Per the brief's stop condition — *a pass for the wrong reason is the failure mode of this entire
phase* — §4 and §5 are the two mutations that establish these are passes for the right reason.

---

## 3. The fix

**None. No `src/` change was needed, and none was made.** `git diff` over `packages/rpc/src` is
empty; the only change in the tree is the new test file.

---

## 4. Mutation check — the code (the ordering)

The ordering is the whole mechanism, so I inverted it: in `initControlLanes`, `pullCommits()` before
`replayJournal()`. This is the design the brief predicted would brick the group.

**What went red: 6 tests.**

| File | Test | Failure |
|---|---|---|
| `peer-first-commit-crash` | crash A, **log intact** | `expected [ '000000000001' ] to deeply equal []` |
| `peer-first-commit-crash` | crash B, **log intact** | `expected [ '000000000001' ] to deeply equal []` |
| `peer-commit-replay` | never accepted, someone else won: a ledger commit hands back its tokens | `JournalEpochError` |
| `peer-commit-replay` | never accepted, someone else won: an invite hands back a failure notice | `JournalEpochError` |
| `peer-commit-replay` | a remove that never landed is surfaced, and the member is STILL IN THE GROUP | `JournalEpochError` |
| `peer-commit-replay` | the obvious host handler answers a loss by committing — and does not deadlock | `JournalEpochError` |

**What stayed green: the two TRIMMED tests.** This is precisely the inversion the brief predicted —
a trimmed log returns no frames, the own-commit row never fires, and the trimmed case sails through
a startup ordering that is wrong. Had G24 been written over crash B, or over a fixture that always
trims, the ordering could have been inverted and the probe would have reported success.

The four `peer-commit-replay` reds are a different mechanism and worth naming: with the pull first,
the *other* member's commit is applied and the epoch advances, so `replayJournal` then finds its
entry framed an epoch behind and refuses with `JournalEpochError` (`peer.ts:924`). Those tests all
involve a second member. **Not one of them is a group of one**, so none of them covers the case this
question is about — and that is exactly the gap the four new tests close.

### What the mutated peer actually does — and why "no error" is not the assertion

Under the inverted ordering, the untrimmed sole member does **not** end up bricked in state. I probed
it directly (throwaway test, since removed):

```
welcomes [ 'dave' ]
epoch 2
slot cleared
rendezvous publishes 1      ← 
commit frames 1
```

The pull raises `healRequested`, the replay that follows adopts the commit anyway and **does not
retract the flag**, and the deferred `healIfRequested()` then runs `recover()` against a group of
one. Nobody answers, `requestGroupInfo` times out, `sealed == null`, and `recover()` returns
`{ advanced: false }` — **it resolves. It does not throw.**

So under the wrong ordering: the group converges, the Welcome fires, no error is raised, and the peer
has asked the void for help. **Every assertion the brief warned against would pass.** The single
observation that separates recovery from luck is `rendezvous publishes == 0`, which is why
`expectRecoveredFromTheJournalAlone` asserts it first.

(The damage in a *real* group of one is a wasted rendezvous and a stall on the commit mutex for the
recovery deadline — 30s by default. It is not a brick here only because the journal happens to win
the race to the handle. That is a thin margin to be standing on, and it is a concern, not a defence:
see §7.)

**Reverted.** Confirmed by `git diff packages/rpc/src` → empty.

---

## 5. Mutation check — the fixture

The brief asked for `DurableFakeHub.trim`. **I did not add one, and I did not need one.** See §6 for
the reasoning. `FakeHub.trim` (`test/fixtures/fake-hub.ts:310`) already exists and already meets the
brief's spec *verbatim*: it deletes the topic's log-class frames and leaves `#heads` and
`#publishRecords` untouched, so `fetchTopic` returns `messages: []` and `oldest: null` over a topic
that still has a head. That separation is the mechanism under test, and it is the fixture I
mutation-checked.

**The mutation:** make `trim` also delete the trimmed sequenceIDs from `#publishRecords` — the hub's
dedup record forgetting whatever the log forgets.

```ts
trim(topicID: string, before: string): void {
  const log = this.#logs.get(topicID)
  if (log == null) return
  // MUTATION: the dedup record forgets what the log forgets.
  for (const message of log) {
    if (message.sequenceID >= before) continue
    for (const [publishID, sequenceID] of this.#publishRecords) {
      if (sequenceID === message.sequenceID) this.#publishRecords.delete(publishID)
    }
  }
  this.#logs.set(topicID, log.filter((message) => message.sequenceID >= before))
}
```

**G24 goes red, and it is the only test in the repo that does:**

```
 ✓ the hub took the commit and the process died before the acceptance was recorded: the journal republishes, and nobody is asked
 × the log is trimmed before the restart: replay still returns the original sequenceID, and the peer still adopts
   → expected [] to deeply equal [ 'dave' ]
 ✓ the acceptance was recorded and the process died before the host adopted: the peer adopts from the slot, and touches no network
 ✓ the acceptance was recorded and the log is trimmed: the slot alone is enough, and the trim changes nothing

AssertionError: expected [] to deeply equal [ 'dave' ]

- Expected
+ Received

- [
-   "dave",
- ]
+ []

 ❯ expectRecoveredFromTheJournalAlone test/peer-first-commit-crash.test.ts:162:30
```

Whole rpc suite under the mutation: **`PASS (152) FAIL (1)`** — the one failure is G24. So G24 is the
only thing in the codebase measuring the permanence of the dedup record across a trim, and the test
is measuring the record and not the fixture's inability to forget.

The failure mode it exposes is the exact one the mechanism exists to prevent: the republish carries
`expectedHead: null` (the first commit of the group's life) against a head that is now the peer's own
accepted sequenceID, so with the dedup record gone it reads as an ordinary lost compare-and-set →
`HeadMismatchError` → the slot is cleared and the commit surfaces as `{ kind: 'invite' }`. **Dave is
in the ratchet tree and is never told.** The group of one has invited a member into a group it will
never learn it is in — silently, with no error anywhere.

**Reverted.** Confirmed by `git diff packages/rpc/test/fixtures/fake-hub.ts` → empty.

---

## 6. Deviation: `FakeHub`, not `DurableFakeHub`

The brief specifies adding `trim` to `DurableFakeHub`. I used `FakeHub` instead, and added nothing.

- `DurableFakeHub` exists to model **per-subscriber acks and redelivery** — a peer going offline and
  a reconnect backlog being pushed at it (`test/fixtures/durable-fake-hub.ts:20-28`). **This question
  has no delivery in it at all.** The group has one member; the hub's push loop skips the sender
  (`durable-fake-hub.ts:88`, `fake-hub.ts:198`), so no frame is ever delivered to anyone, and the
  seed pull is the only read.
- `FakeHub` already has everything the question needs: `trim` with exactly the semantics the brief
  spells out, a permanent `#publishRecords` that no deleter reaches, `head()`, and the `published`
  array that makes *"the peer publishes to the rendezvous topic zero times"* observable at all.
  `DurableFakeHub` has no `published` array, so building on it would have meant adding a publish
  recorder *as well as* a `trim` — two pieces of fixture surface, on a fixture whose one distinctive
  feature the test does not use.
- The brief points at `peer-commit-replay.test.ts` as the harness to reuse. **That file is built on
  `FakeHub`.** The new tests sit beside it on the same fixture.

Adding an unused `DurableFakeHub.trim` would have been dead fixture code. If a later question needs
a trim under redelivery, it is four lines, and `FakeHub.trim` is the template.

---

## 7. Concerns

1. **The group of one is saved by an ordering constraint with nothing behind it.** `healRequested` is
   never cleared by `replayJournal` — adopting the commit does not retract the request to heal from
   it. The flag is safe today only because replay precedes the pull in all five lane operations. That
   invariant is stated in prose (`peer.ts:889-891`, `peer.ts:855-857`) and enforced by nothing. A
   future refactor that moves the pull ahead of the replay in *just the seed* passes 147 of 153 tests
   and leaves the sole member asking a void for help on every restart. The four new tests are now the
   guard; before them, only tests involving a second member caught it, and none of them is about this
   failure.
2. **A spurious heal is invisible except by counting publishes.** `recover()` with no responder
   resolves `{ advanced: false }`. It is not an error, it does not log, and it does not fail a
   convergence assertion. `rendezvousFrames(...).toHaveLength(0)` is the only thing standing between
   "recovered from the journal" and "recovered by luck, having also asked the void for help", and it
   is worth carrying into any future probe of this lane.
3. **The trimmed path is a weaker test than the untrimmed one, and always will be.** A trimmed log
   returns no frames, so the own-commit row cannot fire and the startup ordering cannot be observed
   at all. §4 shows the trimmed tests staying green under an ordering that breaks the untrimmed ones.
   Any future test of this area that trims must be paired with one that does not.
4. **Deviation from the brief's fixture instruction** (§6). Deliberate and argued, but it is a
   deviation, and if the plan wants `DurableFakeHub.trim` for a later question it still needs
   writing.

---

## 8. Full verify

From the repo root, via the `rtk proxy` shim.

```
$ rtk proxy pnpm run build
@kumiai/rpc:build:js: Successfully compiled: 17 files with swc (50.28ms)
 Tasks:    7 successful, 7 total
Cached:    6 cached, 7 total
  Time:    454ms

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 190 files in 151ms. No fixes applied.

$ rtk proxy pnpm test
@kumiai/rpc:test:unit:  Test Files  26 passed (26)
@kumiai/rpc:test:unit:       Tests  153 passed | 1 skipped (154)
@kumiai/rpc:test:unit:    Duration  5.52s

 Tasks:    27 successful, 27 total
Cached:    25 cached, 27 total
  Time:    6.109s
```

rpc went from 149 + 1 skipped to **153 + 1 skipped** — the four new tests, and nothing else moved.
mls is unchanged. 27/27 tasks.

**Not committed.** The only change in the tree is the new file
`packages/rpc/test/peer-first-commit-crash.test.ts`.
