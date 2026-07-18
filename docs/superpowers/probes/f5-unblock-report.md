# F5 unblock report — the hub CAN name a pushed frame's log position; all five done-when met

Branch `feat/app-lane-delivery`, uncommitted. Nothing committed, no branch switched, no
`git checkout` / `restore` / `stash` run on anything.

## Status: DONE, not blocked

The blocking question was: *can the hub cheaply know a frame's log position at push time?* It can,
and the answer is not a synthesis, an inference, or a bet on the reference store's shared counter.

`hub/publish`'s handler already holds both values in local variables at the moment it fans out:
`ctx.param.retain` (the class, the publisher's own word) and `sequenceID` (what `store.publish`
returned for an accepted append). For a `retain: 'log'` publish that sequenceID *is* the position
`fetchTopic` will serve the frame at — the store assigned it inside the accepting transaction. No
new state, no extra query, no second counter. The `hub/receive` backlog drain gets it from the
store's own entry, which carries `retain` already.

So the previous probe's BLOCKED was correct about rpc and correct about the brands — a pushed
`sequenceID` is a delivery position and must never be crossed with a log position — and the fix was
exactly where it said it was: the hub contract.

**The reference store's shared counter is NOT the contract.** `memoryStore` mints one sequence for
both classes, so the two coincide there; nothing anywhere requires that, and the change does not
assume it. The field is reported by the store rather than derived by the reader, so an
implementation with a separate per-recipient delivery sequence reports its log's own value. The
conformance clause pins the property that matters (a pushed log frame's `logPosition` equals the
position `fetchTopic` serves that same frame at), never the coincidence.

## Done-when

1. **A log-class push carries its log position; a mailbox push does not.** DONE. New clause in
   `hub-conformance/src/log-hub.ts`, run against the real store and both rpc doubles. Watched red on
   all three before the fix (output below).
2. **A frame published mid-walk is delivered exactly once, latch gone.** DONE. `appSegmentLoaded` is
   gone; the drain re-pulls every time. Covered twice — by my own
   `test/peer-app-live-cursor.test.ts`, and by **un-skipping the existing
   `peer-app-drain-integrity.test.ts` mid-walk test**, which was skipped precisely because this was
   unfixable without a position the live lane also advances. Both watched red under the restored
   latch.
3. **An online peer is re-delivered nothing.** DONE. The four duplicate-catching tests
   (`peer-app-topic` ×3, `peer-removed-blind` ×1) are untouched and green. `takeAppFrame` is the
   single door into the buffer and takes a position once, which is what makes a re-pull safe.
4. **A restart does not re-deliver frames that arrived live.** DONE, new test. Watched red twice —
   once under the restored latch, once under a disabled live-cursor path.
5. **Mutation checks.** All three run, all three red, all three inverted by hand. Output below.
6. **Suite.** rpc 277 / 0 / 0 skipped, mls 311, turbo 30/30, integration 23/23, lint clean. No
   existing test weakened; one was un-skipped and strengthened by being run.

## What changed

**The contract.** `StoredMessage` gains `logPosition?: string`, present exactly when the frame is
log-class and **absent** otherwise — not empty, not zero, since a falsy placeholder is a position a
cursor would happily move to, past every log frame below it. Wired through
`hub-protocol` (type + `hub/receive` schema), `hub-server` (`memoryStore` on both read paths,
`handlers` on both push paths), `hub-client`, `hub-tunnel`'s encrypting wrapper, and both rpc
doubles.

`hub/topic/fetch` is deliberately unchanged: that endpoint serves the log, so every entry's log
position is already its `sequenceID` and already the contract for `after`. A second name for a value
on the wire would be one more thing to disagree with itself.

**The rpc side.** The live app path now records the position of every log-class frame it is pushed,
and the durable cursor moves over it under the unchanged advance rule.

- `noteLiveAppFrame` classifies at the epoch the frame *arrives* at, not at merge time — the handle
  moves under the mux's lock-free push loop and the answer is only true of that moment. At the
  frame's seal epoch: the live transport is the deliverer and the frame is done either way, because
  every path there delivers or drops exactly as the drain would. Above it: bytes kept, drain's
  problem (the justification check is a network read this path must not make). Below it, or not a
  readable frame: dead, and *nothing recoverable is lost by saying so* — MLS ratchets forward, so a
  later pull would classify it dead too. That last point is what makes marking done safe rather than
  optimistic.
- `takeAppFrame` is the one way a frame enters the buffer, from either deliverer, and takes a
  position once. A repeat is a reconcile that can only ever mark a frame *done*, never resurrect its
  bytes.
- Two positions are now named and distinct, as asked: `position` (the durable cursor) and `fetched`
  (how far the log has been pulled). They differ exactly when a buffered frame is not done, and the
  pull resumes from `fetched` so a re-pull costs one short page.
- `runAppLane` is a new mutex. It is **not** the commit mutex and cannot be: `runSerial` resets the
  journal-replay flag on entry, so a cursor write taking it would tell the next pull the journal had
  not been replayed. What it excludes is real, not tidiness — the buffer is an ordered array the
  drain iterates while awaiting `unwrap` and a host handler inside the loop, and a push splicing it
  mid-iteration re-delivers one frame and steps over another; and `advanceAppCursor` reads a run of
  done frames and *then* splices them, so an interleave cuts twice and drops frames the cursor never
  covered. Both ends in a durable `save`, so an interleave writes the wrong position to disk.
- **No deadlock.** The two locks are ordered and never nested the other way: every `deliverAppFrames`
  call is from inside `runSerial` and takes the app lane second; nothing inside the app lane takes
  `runSerial`. The only path that could is a host handler re-entering the peer from the delivery —
  which already deadlocks on `runSerial` itself today, since that is documented non-reentrant, so
  this adds no reachable case. The live sync never calls a handler and cannot re-enter at all.

## Verification — every new test watched red first

**Done-when 1**, before the fix, all three implementations:

```
1. createMemoryStore: LogHub conformance a pushed log frame names its place in the log, and a pushed mailbox frame names none
   AssertionError: expected undefined to be '000000000001' // Object.is equality
1. FakeHub: LogHub conformance a pushed log frame names its place in the log, and a pushed mailbox frame names none
   AssertionError: expected undefined to be '000000000001' // Object.is equality
2. DurableFakeHub: LogHub conformance a pushed log frame names its place in the log, and a pushed mailbox frame names none
   AssertionError: expected undefined to be '000000000001' // Object.is equality
```

**Mutation 1 — restore the latch.** Both new tests red, each with its own claimed symptom:

```
PASS (0) FAIL (2)

1. the live lane and the drain share one read position a frame published while this peer is mid-walk is delivered, exactly once
   AssertionError: expected [] to deeply equal [ { text: 'published mid-walk' } ]
2. the live lane and the drain share one read position a restart does not re-deliver what the live lane already delivered
   AssertionError: expected [ { text: 'read live' }, …(1) ] to deeply equal [ { text: 'read live' } ]
```

…and the **un-skipped existing mid-walk test** under the same mutation:

```
    324|     expect(restarted.mls.epoch()).toBe(2)
    325|     expect(seen).toEqual([{ text: 'at epoch one' }, { text: 'mid-walk,…
       |                  ^
 Test Files  1 failed (1)
      Tests  1 failed | 6 skipped (7)
```

**Mutation 2 — stop the live path advancing the cursor.** Only the test that claims to depend on it
goes red; the mid-walk test correctly stays green, since its peer is offline for that publish:

```
PASS (1) FAIL (1)

1. the live lane and the drain share one read position a restart does not re-deliver what the live lane already delivered
   AssertionError: expected [ { text: 'read live' }, …(1) ] to deeply equal [ { text: 'read live' } ]
```

**Mutation 3 — make a mailbox push carry a log position:**

```
PASS (0) FAIL (1) skipped (10)

1. createMemoryStore: LogHub conformance a pushed log frame names its place in the log, and a pushed mailbox frame names none
   AssertionError: expected '000000000002' to be undefined
```

All three inverted by hand (`mutationLatch` grep-confirmed at 0 occurrences afterwards).

**Suite, after inverting everything:**

```
pnpm run build            → Tasks: 8 successful, 8 total
rtk proxy pnpm run lint   → Checked 233 files in 177ms. No fixes applied.
pnpm test                 → Tasks: 30 successful, 30 total
packages/rpc              → PASS (277) FAIL (0)      [was 276 + 1 skipped]
packages/mls              → PASS (311) FAIL (0)
tests/integration         → PASS (23)  FAIL (0)
```

## Concerns and follow-ups — filed, not closed

1. **A quiet-commit-lane peer keeps its position off live traffic alone**, via a coalesced
   `fetchTopic` per burst of app pushes (`scheduleAppLaneSync`). That is one extra short pull per
   burst under sustained chat. It is what makes done-when 4 hold for a group that is busy on the app
   lane and silent on the commit lane; if the cost shows up, the lever is the coalescing window, not
   the pull.
2. **The live sync advances the cursor but never delivers.** Deliberate: delivery unwraps against the
   live handle, and the sync runs outside the commit mutex where the handle can be mid-ratchet, so a
   frame classified at one epoch and unwrapped at the next would be called dead and dropped. The cost
   is that a frame buffered *pending* — including this peer's own log-class publishes, which the hub
   never pushes back — pins the cursor until the next real drain. Conservative in the safe direction
   (a stalled cursor re-reads; it does not lose), but it means a peer that only ever publishes and
   never walks a commit does not advance past its own frames.
3. **`reportPrunedWindow` now fires on the segment's first pull only**, keyed off `fetched == null`.
   With the latch gone it would otherwise fire on every drain. Every later pull starts from a
   position the peer reached itself, so re-reporting would be the same gap twice — but this is a
   behaviour change to a host-visible notice and worth a second opinion.
4. **`peer-app-live-backlog.test.ts` is the other probe's file and I did not touch it.** Its doc
   comment justifies itself partly on "the peer's segment pull is latched from a startup where the
   log was empty and never runs again" — which my change makes false. The test still passes and still
   tests what it claims (an *ephemeral* frame, which no log holds and no pull can ask for), but that
   sentence is now wrong and should be corrected before it rots.
5. **I un-skipped `peer-app-drain-integrity.test.ts`'s mid-walk test** and rewrote its stale
   "SKIPPED, and it is red" comment. That file was the other probe's; the coordinator confirmed it
   had finished before I touched it. The test is stronger than my own equivalent — it also asserts
   the cursor lands on the mid-walk frame — and I watched it red under the restored latch before
   trusting it.
6. **Untouched, per the brief:** `classify.ts`, `readCommitHeader`, `packages/mls/`. The 4 classify
   failures I saw mid-run were the other probe's in-flight work and cleared when it finished.
