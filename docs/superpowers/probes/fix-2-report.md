# Probe report — Fix 2: the drain's bound, its failed pull, and its latch

Branch `feat/app-lane-delivery`, uncommitted. **Status: PARTIAL.** F4 and F3 are implemented and
green. **F5 is BLOCKED** — the approved fix is incomplete in a way the brief's reasoning did not
anticipate, and shipping it breaks four existing tests. One existing test conflicts with F4 and is
left red by instruction rather than weakened.

---

## F4 — the bound. DONE.

**Changes**

- `packages/rpc/src/peer.ts:989-1025` — new `justifiedEpochCeiling()`. Pages the commit topic fresh
  from the hub, reads each frame's epoch pre-apply with `port.readCommitHeader` (the same read the
  walk makes at `:1298`), and returns `max(header.epoch + 1)` over the log, floored at
  `crypto.epoch()`. A commit framed at H produces epoch H+1 when applied, so H+1 is the highest
  epoch any member can have sealed at.
- `packages/rpc/src/peer.ts:1123-1131` — the ceiling is read lazily, once per drain, and only if a
  frame actually claims to be ahead. The honest buffer holds no such claim, so the honest path makes
  no extra network read.
- `packages/rpc/src/peer.ts:1155-1160` — the ahead-branch now requires the claim to be justified.
  Unjustified → `frame.sealed = null`, and the cursor passes it.
- `packages/rpc/src/peer.ts:1085-1093` — `frameEpoch`'s trust-boundary doc extended to cover a claim
  of a *future* epoch, which it was silent on.

**Why every frame is asked and not only the head:** the log's furthest frame may be poison or a
fork loser, and neither justifies an epoch. Taking the max over readable headers is the same answer
in the honest case and safe in the others.

## F3 — the failed pull. DONE.

- `packages/rpc/src/peer.ts:1122` — the `try/catch { return }` around `loadAppSegment()` is gone.
  The failure propagates through `advanceHandle` (`:1177`), which never reaches its `advance()`, so
  no epoch is passed unread. `initControlLanes` (`:1512`) and `onCommitDelivery` (`:1456`) already
  catch a failed pull and leave the cursor put, so the stall is a stall and not a crash.
- `packages/rpc/src/peer.ts:1112-1117` and `:938-941` — the stall and its accepted cost are stated
  where the walk and the pull each need them.

The latch's placement makes this safe on its own: `appSegmentLoaded` is taken only after the whole
segment is in hand, so a failed pull leaves it `false` and the retry re-pulls from the cursor with
nothing half-buffered behind it.

**Fault injection added:** `FlakyFetchHub` in `packages/rpc/test/peer-app-drain-integrity.test.ts:20`
— a `DurableFakeHub` whose `fetchTopic` fails once per armed topic.

## F5 — the latch. BLOCKED. Not implemented.

The brief's justification for dropping the latch is:

> *"a re-pull would re-deliver" — the pull is FROM THE CURSOR, so it would not.*

That holds only for frames **the drain itself delivered**. It does not hold for frames the **live
lane** delivered, and nothing reconciles the two:

- The live app lane is built in `buildEpoch` (`packages/rpc/src/peer.ts:502-527`) out of
  `mux.bus` → `BroadcastClient` / `createGroupBusServer`. It hands log-retained frames to the host's
  handlers and **never touches `appCursors`, `appCursorStore`, or any read position** — grep for
  `appCursors` returns only `loadAppSegment` and `advanceAppCursor`.
- So for an online peer the cursor stays behind every live delivery, and the *second* pull of a
  segment re-reads and re-delivers frames the host already has.

The latch is what has been hiding this. Removing it makes the drain re-deliver on every commit.
Implemented in full and run against the suite:

```
PASS (217) FAIL (5)

2. the app topic is stable within a roster-change-bounded segment epochs advancing without a roster change leave the app topic put, and delivery continues
   AssertionError: expected [ { n: 1 }, { n: 1 }, { n: 3 } ] to deeply equal [ { n: 1 }, { n: 3 } ]
       at packages/rpc/test/peer-app-topic.test.ts:142:20
3. the app topic is stable within a roster-change-bounded segment a Remove rotates the app topic onto a new ID, and delivery continues across it
   AssertionError: expected [ { n: 'before' }, …(2) ] to deeply equal [ { n: 'before' }, { n: 'after' } ]
       at packages/rpc/test/peer-app-topic.test.ts:207:20
4. the app topic is stable within a roster-change-bounded segment an add-only commit rotates the app topic too, and delivery continues across it
   AssertionError: expected [ { n: 'before' }, …(2) ] to deeply equal [ { n: 'before' }, { n: 'after' } ]
       at packages/rpc/test/peer-app-topic.test.ts:262:20
5. a member removed at the rotation cannot reach the topic the group rotates onto nothing the removed member still holds derives the new topic, and nothing reaches her
   AssertionError: expected [ …(3) ] to deeply equal [ …(2) ]
       at packages/rpc/test/peer-removed-blind.test.ts:143:20
```

Restoring only the latch and changing nothing else makes exactly those four go green again, which
isolates the cause to the latch and not to the F5 restructure.

These are duplicate deliveries to a **live** peer, not the accepted at-least-once of a returning
one, and repairing them means giving the live lane a read position it advances — a change to the
live lane and to what the cursor means, not to the drain. That is a redesign of the approved
approach, so I stopped.

The F5 implementation I wrote (per-topic `appFetchedTo` in-memory fetch position, distinct from the
durable cursor, plus a per-segment pruned-window report so the gap is still reported once) was
reverted by hand. **It worked** — done-when (4) passed under it. It is the live-lane overlap alone
that blocks it. The regression test is left in place as `test.skip` at
`packages/rpc/test/peer-app-drain-integrity.test.ts:213` with the blocker written above it.

**How the two positions were kept apart** (for whoever unblocks this): the cursor is read from the
store exactly once per segment, seeds `appFetchedTo`, and thereafter moves only in
`advanceAppCursor` over delivered-or-dead frames; `appFetchedTo` moves per fetched message and runs
ahead of the cursor by every buffered frame still waiting for its epoch. Re-pulling from the cursor
re-buffers those; writing the cursor from `appFetchedTo` passes frames nobody read. They coincide
only on the first pull, when nothing is buffered.

---

## Tests added

`packages/rpc/test/peer-app-drain-integrity.test.ts` (new, 4 tests).

Red against today's code, before any source change:

```
PASS (1) FAIL (3)

1. ... a frame claiming an epoch the commit log cannot justify is dead, and the cursor passes it
   AssertionError: expected '000000000001' to be '000000000002' // Object.is equality
       at packages/rpc/test/peer-app-drain-integrity.test.ts:96:48
2. ... a drain whose pull fails does not ratchet past the epoch it could not read
   AssertionError: expected [ { text: 'at epoch two' } ] to deeply equal []
       at packages/rpc/test/peer-app-drain-integrity.test.ts:194:18
3. ... a frame published while the walk is still walking is picked up by it
   AssertionError: expected [ { text: 'at epoch one' } ] to deeply equal [ { text: 'at epoch one' }, …(1) ]
       at packages/rpc/test/peer-app-drain-integrity.test.ts:260:18
```

Done-when (2) — "a justified claim still waits" — is the one that **cannot** be red before the fix:
it is a non-regression guard against F4 over-reaching, and today's unbounded code trivially satisfies
it. It is given teeth by Mutation B below, and it is staged two epochs ahead rather than one so that
a bound taken from the peer's own handle fails it.

## Mutation checks

**A — restore the unbounded ahead-branch** (`peer.ts:1160` → `if (sealedAt != null && sealedAt >
crypto.epoch()) continue`). Done-when (1) goes red:

```
PASS (2) FAIL (1) skipped (1)

1. ... a frame claiming an epoch the commit log cannot justify is dead, and the cursor passes it
   AssertionError: expected '000000000001' to be '000000000002' // Object.is equality
       at packages/rpc/test/peer-app-drain-integrity.test.ts:96:48
```

**B — take the bound from the peer's own epoch instead of the log** (`justifiedEpochCeiling` →
`return crypto.epoch() + 1`). Done-when (2) goes red — the honest ahead frame is eaten, which is
precisely the failure mode (2) exists to catch:

```
PASS (2) FAIL (1) skipped (1)

1. ... a frame the commit log justifies keeps its place, and the cursor passes it only on delivery
   AssertionError: expected [ { text: 'at epoch one' } ] to deeply equal [ { text: 'at epoch one' }, …(1) ]
       at packages/rpc/test/peer-app-drain-integrity.test.ts:143:18
```

**C — restore the swallowed load failure** (`try { await loadAppSegment() } catch { return }`).
Done-when (3) goes red, and red in the exact shape F3 describes: the walk ratcheted to epoch 2 and
the epoch-1 frame was destroyed on the way:

```
PASS (2) FAIL (1) skipped (1)

1. ... a drain whose pull fails does not ratchet past the epoch it could not read
   AssertionError: expected [ { text: 'at epoch two' } ] to deeply equal []
       at packages/rpc/test/peer-app-drain-integrity.test.ts:194:18
```

**D — restore the latch.** Not a mutation on this diff: the latch is in the tree, because F5 is
blocked. Its red is the third failure in the pre-change run above, taken against the same code.

All mutations were inverted by hand. No `git checkout`, `git restore`, or `git stash` was run at any
point.

---

## Conflicting existing test — NOT weakened, NOT deleted

`packages/rpc/test/peer-app-cursor.test.ts:84` — *"a frame sealed ahead of the walk survives
restarts and is delivered when the walk reaches it"* — is red under F4 and I left it red:

```
1. the app-lane drain reads from a durable position and reports what aged out below it a frame sealed ahead of the walk survives restarts and is delivered when the walk reaches it
   AssertionError: expected '000000000002' to be '000000000001' // Object.is equality
       at packages/rpc/test/peer-app-cursor.test.ts:120:48
```

It stages an ahead frame that F4 defines as dead. Its own comment says so (`:98-99`): *"A frame
sealed at epoch 4 ... while the group's log has no commit that leaves epoch 1."* An unjustified
claim, and the test asserts the cursor waits behind it — the exact behaviour F4 removes.

**It cannot be minimally repaired**, and that is the finding worth more than the failure. Its staging
needs the frame to survive *several restarts* without the walk moving. Under F4, what justifies the
wait is a commit in the log — and any commit in the log that justifies epoch 4 also carries the
restarting peer to epoch 4 on its next walk. So "an ahead frame waits across restarts" is, after
F4, only reachable for a peer that is stranded (own-unmerged commit, or commits it cannot apply).
The invariant the test exists for is preserved by the new done-when (2) test, which stages it
two-epochs-ahead within a single walk and asserts the cursor's whole write history.

Deciding what replaces it is a call for the branch owner, not for this probe.

## Suite

- `pnpm run build` — 8/8 tasks successful.
- `rtk proxy pnpm run lint` — `Checked 224 files in 218ms. No fixes applied.`
- `pnpm test` — 29/30 turbo tasks. mls **307/307 green**. rpc **220 passed, 1 skipped, 1 failed** —
  the failure is the conflicting test above and nothing else; the skip is the blocked F5 regression.

## Concerns

1. **`readCommitHeader` may return `null` for a future-epoch commit against a real handle.**
   `packages/mls/src/group-handle.ts:758-767` resolves a member commit's committer by decrypting
   sender-data with *this* handle's epoch secret, so a commit framed above the handle's epoch
   returns `null` even though its epoch is public cleartext (`readMessageEpoch`, read at `:740`,
   succeeds). The memory double (`packages/rpc/test/fixtures/memory-group-mls.ts:520`) has no such
   restriction, so the suite cannot see it. If that is the real behaviour, `justifiedEpochCeiling`
   degrades to `crypto.epoch() + 1` against a real port, and a peer more than one epoch behind would
   have honest ahead frames declared dead. **This is not introduced by F4** — the commit lane's
   `ahead` row (`packages/rpc/src/classify.ts`, disposition `'ahead'`) depends on the same read and
   would be misfiled as poison today — but F4 gives it a second way to lose data. The port contract
   in `packages/rpc/src/crypto.ts:172` promises `null` only for "bytes that are not a Commit", so
   the mls implementation is the side that deviates. Worth its own probe.

2. **The ceiling costs a full commit-log read** when a frame claims to be ahead. Lazy and rare, but
   an attacker who can publish to the app topic can force one commit-log page walk per drain by
   including one ahead-claiming frame. Bounded work per drain, not per frame, and far cheaper than
   the unbounded buffer growth F4 removes — but it is not free.

3. **F5's blocker is the more interesting finding of the three.** The drain and the live lane both
   deliver from the same topic and only one of them keeps a position. That is what makes the latch
   load-bearing, and the latch is what makes mid-walk publishes invisible. Whichever way the branch
   goes, those two facts are the same fact.
