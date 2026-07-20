# Probe report — Fix 2: the drain's bound, its failed pull, and its latch

Branch `feat/app-lane-delivery`. Checkpoint `60e8b28` holds the first pass; everything since is
uncommitted on top of it.

**Status: F4 and F3 done. F5 blocked and filed.** The three branch-owner rulings are all applied. The
suite's remaining red is a single finding, exposed on purpose by ruling 1 and filed rather than
fixed.

---

## F4 — the bound. DONE, now on cleartext.

**Changes**

- `packages/rpc/src/peer.ts:1021` — `justifiedEpochCeiling()`. Pages the commit topic fresh from the
  hub and returns `max(framedEpoch + 1)` over every commit frame in it, floored at `crypto.epoch()`.
  A commit framed at H produces epoch H+1 when applied, so H+1 bounds every member.
- `packages/rpc/src/peer.ts:1046` — the epoch comes from **`crypto.frameEpoch(commit)`**, the
  cleartext read that sits over `readMessageEpoch`, and no longer from `readCommitHeader`. Ruling 1.
  `readCommitHeader` authenticates the committer against the handle's *current* epoch secret, so it
  answers `null` for every commit framed ahead of this peer — which is every commit a returning
  member has yet to walk. The old ceiling would have collapsed to `crypto.epoch()` in production for
  exactly the member the lane exists for. No new port method was needed.
- `packages/rpc/src/peer.ts:1157` — the ahead-branch requires the claim to be justified; unjustified
  → `frame.sealed = null`, and the cursor passes it.
- `packages/rpc/src/peer.ts:1135-1145` — the ceiling is read once per drain and only if some frame
  actually claims to be ahead, so the honest path makes no extra network read.
- `packages/rpc/src/peer.ts:1090-1103` — `frameEpoch`'s trust-boundary doc extended to cover a claim
  of a *future* epoch, which it was silent on.

**The trust argument, stated at the function** (`peer.ts:982-999`), because it is the whole
justification for reading an unauthenticated field: a commit's framed epoch is the hub's word, and a
hub free to inject onto the commit topic can **raise** this ceiling at will. It can never **lower**
it — the honest commits are in the log too and the ceiling is the maximum over all of them, so no
injected frame can hide one. Raising it reaches, at worst, the unbounded wait that exists today,
which is the defect being bounded. Lowering it is what would destroy an honest member's frames, and
that is unreachable. Bounded by an untrusted party is strictly better than unbounded. The asymmetry
is why it is acceptable here and would not be for opening: this decides how long to **wait**, never
what to believe — what is read out of a frame is still `unwrap`'s answer alone.

## F3 — the failed pull. DONE.

- `packages/rpc/src/peer.ts:1135` — the `try/catch { return }` around `loadAppSegment()` is gone. The
  failure propagates through `advanceHandle`, which never reaches its `advance()`, so no epoch is
  passed unread. `initControlLanes` and `onCommitDelivery` already catch a failed pull and leave the
  cursor put, so the stall is a stall and not a crash.
- The latch's placement makes this safe on its own: `appSegmentLoaded` is taken only after the whole
  segment is in hand, so a failed pull leaves it `false` and the retry re-pulls cleanly.
- **Fault injection added:** `FlakyFetchHub` in `packages/rpc/test/peer-app-drain-integrity.test.ts`
  — a `DurableFakeHub` whose `fetchTopic` fails once per armed topic.

## F5 — the latch. BLOCKED, filed, and the comment corrected.

Not implemented, per ruling 2. The latch stands.

- `packages/rpc/src/peer.ts:449-467` — the false justification is replaced with the true one. Both
  old clauses were wrong: the log **does** grow, and a re-pull would **not** re-deliver what the
  drain dispensed (the pull is from the cursor, which is past it). What a re-pull re-delivers is what
  the **live lane** delivered — the live path hands log-retained frames to the host straight off the
  bus and advances no read position at all, so an online peer's cursor sits behind every frame it was
  pushed. One position, two deliverers, only one keeps it. The comment now names that, and names what
  the latch costs: the frame published mid-walk.
- `packages/rpc/src/peer.ts:923-925` — `loadAppSegment`'s doc points at the same constraint.
- **Filed:** `docs/agents/plans/next/2026-07-18-live-lane-read-position.md` — the gap, the four tests
  that went red, the four things a fix has to change (getting the sequenceID past the bus abstraction;
  which position advances; ephemeral frames sharing the topic; ordering against the drain's buffer),
  and three options. Leans toward making the app lane's delivery a wakeup like the commit lane
  already is, which removes the problem instead of managing it.
- The regression test stays in the tree as `test.skip` in `peer-app-drain-integrity.test.ts` with the
  blocker written above it.

---

## Ruling 1's second half: the memory double, and what it was hiding

`packages/rpc/test/fixtures/memory-group-mls.ts:520` read a commit at any epoch and its comment
asserted that as the contract — *"Reads the commit's own bytes and nothing else: no epoch secret, no
blob, no state."* That is the opposite of what the real handle does. It now refuses a non-external
commit framed above its own epoch, modelling `group-handle.ts:758-767`. External commits stay exempt
and must: they carry their committer in their own UpdatePath leaf, need no secret, and are framed at
the group's epoch — ahead of the stranded peer that most needs to read one.

**That reddened four tests, and the finding is a serious one: `classifyCommit`'s `ahead` row is
unreachable against a real MLS port.** `null` is settled as poison before any epoch question, so a
peer that falls behind reads every later commit as poison, steps over it, drains to the end, and
reports itself fully reconciled — stuck at a dead epoch with a clean bill of health. That is the exact
outcome the row exists to prevent, and `peer-cursor-table.test.ts:363-366` says so in its own comment.

```
1. a peer the group left behind learns it from a later frame, not from the one it could not apply, and heals
   AssertionError: expected 1 to be 4 // Object.is equality
       at packages/rpc/test/peer-cursor-table.test.ts:366:29
2. a heal trigger under a failed heal a frame framed ahead of it: no responder — commit() refuses, and nothing lands
   Error: promise resolved "{}" instead of rejecting
       at packages/rpc/test/peer-failed-heal-strand.test.ts:143:79
3. a heal trigger under a failed heal a frame framed ahead of it: a responder answers — the peer heals, then commits
   AssertionError: expected 1 to be greater than 1
       at packages/rpc/test/peer-failed-heal-strand.test.ts:166:31
4. a heal re-enacts by ledger membership an entry the group already holds is not re-enacted, and a later admin is not reverted
   AssertionError: expected 2 to be 4 // Object.is equality
       at packages/rpc/test/peer-recover-lane.test.ts:140:31
```

All four are the same mechanism. **These tests assert the right behaviour** — they are red because the
double stopped lying, not because the intent changed, so none of them was touched.

Not fixed here, and deliberately: the repair is not the one-liner it looks like. Classifying from the
cleartext epoch separates the two facts the classifier reads from a commit, and only one is available
without a key — the **committer** is what needs the epoch secret, and it is what `own-unmerged` turns
on, the row whose doc is emphatic that the committer must be MLS-authenticated and never the hub's
word. Which rows may depend on an unauthenticated field has to be argued per row. Filed with options
at the time, including the note that the real handle refuses commits framed **below** its epoch too,
so the `history` row and the fork check rest on the same read and should be checked before designing
the fix.

> **Resolved later on this same branch, at `6b31331`.** `readCommitHeader` was widened to return the
> cleartext `epoch` at any epoch and to withhold only the `committerDID` it cannot authenticate, so
> `ahead`, `history` and `fork` all dispatch on the epoch (`classify.ts:29`) while `own-unmerged`
> keeps the authenticated read it requires — which answers the `history`/fork question above at the
> same time. The four tests below are green; the backlog file this paragraph used to point at was
> deleted as spent.

## Ruling 3: the conflicting test, rewritten

`packages/rpc/test/peer-app-cursor.test.ts:105` — *"a justified frame ahead of a stranded peer is
never passed, however often it restarts"*. Green.

The old version staged an ahead frame with an empty commit log — an unjustified claim, which F4
defines as dead — and asserted the cursor waited behind it. Rewritten on the only shape where waiting
across restarts is still real: bob meets his **own un-merged commit** at the head of his walk, which
stops the drain dead; commits framed at 2 and 3 sit further along the log and justify a frame sealed
at epoch 4; no responder is live, so the heal finds nobody and he stays at epoch 1 across three boots.
The cursor sits on the frame he delivered and never passes the one he could not.

The comment says why the frame must be justified, and one thing worth flagging: **the delivery half
is gone, and that is not an omission.** A stranded peer's only exit is a rejoin, a rejoin rotates the
anchor, and a rotation moves to a new topic and drops the buffer — so "delivered when the walk reaches
it" belongs to a *lagging* peer, not a stranded one. That half is covered by done-when (2) in
`peer-app-drain-integrity.test.ts`, which stages it within a single walk.

---

## Tests

`packages/rpc/test/peer-app-drain-integrity.test.ts` (new, 4 tests). Red against today's code, before
any source change:

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

Two tests here **cannot** be red before the fix, and both are guards against F4 over-reaching rather
than tests of it: done-when (2), and the rewritten stranded-peer test. Today's unbounded code
trivially satisfies both. Mutation B is what gives them teeth, and it reddens both.

## Mutation checks

All re-run against the final cleartext-based ceiling. Inverted by hand. No `git checkout`,
`git restore`, or `git stash` was run at any point.

**A — restore the unbounded ahead-branch** (`peer.ts:1157` → `if (sealedAt != null && sealedAt >
crypto.epoch()) continue`). Done-when (1) goes red:

```
PASS (5) FAIL (1) skipped (1)

1. ... a frame claiming an epoch the commit log cannot justify is dead, and the cursor passes it
   AssertionError: expected '000000000001' to be '000000000002' // Object.is equality
       at packages/rpc/test/peer-app-drain-integrity.test.ts:96:48
```

**B — take the bound from the peer's own epoch instead of the log** (`justifiedEpochCeiling` →
`return crypto.epoch() + 1`). Both non-regression guards go red — the honest ahead frame is eaten,
which is precisely what they exist to catch:

```
PASS (4) FAIL (2) skipped (1)

1. ... a justified frame ahead of a stranded peer is never passed, however often it restarts
   AssertionError: expected '000000000005' to be '000000000004' // Object.is equality
       at packages/rpc/test/peer-app-cursor.test.ts:150:50
2. ... a frame the commit log justifies keeps its place, and the cursor passes it only on delivery
   AssertionError: expected [ { text: 'at epoch one' } ] to deeply equal [ { text: 'at epoch one' }, …(1) ]
       at packages/rpc/test/peer-app-drain-integrity.test.ts:143:18
```

**C — restore the swallowed load failure** (`try { await loadAppSegment() } catch { return }`).
Done-when (3) goes red in the exact shape F3 describes — the walk ratcheted to epoch 2 and destroyed
the epoch-1 frame on the way:

```
PASS (2) FAIL (1) skipped (1)

1. ... a drain whose pull fails does not ratchet past the epoch it could not read
   AssertionError: expected [ { text: 'at epoch two' } ] to deeply equal []
       at packages/rpc/test/peer-app-drain-integrity.test.ts:194:18
```

**D — restore the latch.** Not a mutation on this diff: the latch is in the tree, because F5 is
blocked. Its red is the third failure in the pre-change run above, taken against the same code.

## Suite

- `pnpm run build` — `Tasks: 8 successful, 8 total`.
- `rtk proxy pnpm run lint` — `Checked 224 files in 219ms. Fixed 1 file.` (formatting on the rewritten
  test; clean on re-run).
- `pnpm test` — `Tasks: 29 successful, 30 total`. mls **307/307**. rpc **217 passed, 1 skipped, 4
  failed** — the four are the `ahead`-row finding above and nothing else; the skip is the blocked F5
  regression. The test that conflicted with F4 in the first pass is now green.

## Concerns

1. **The `ahead` row is the biggest thing found on this probe, and it is not an app-lane bug.** A peer
   that falls behind never heals against a real MLS port. Filed at the time; **fixed before the
   branch merged, at `6b31331`** (see the resolution note under Ruling 2). It wanted its own probe
   because four green-looking tests were covering it.
2. **Doubles that are more capable than the port they stand for hide exactly this class of defect.**
   Both problems on this probe trace to one: `memory-group-mls`'s `readCommitHeader` answered at any
   epoch and stated that as the contract. Worth a sweep of the other doubles for the same shape — the
   fake crypto's deliberate *strictness* (`unwrap` refusing any epoch but the live one, documented as
   "stricter than real MLS, deliberately") is the pattern that works, and it works because it errs
   toward refusing.
3. **The ceiling costs a commit-log read** when a frame claims to be ahead. Lazy and rare, but an
   attacker who can publish to the app topic can force one log walk per drain by including a single
   ahead-claiming frame. Bounded per drain, not per frame, and far cheaper than the unbounded buffer
   growth it removes — but not free.
4. **`crypto.frameEpoch` now answers for two message shapes in the fake** (`fake-crypto.ts`), because
   the real `readMessageEpoch` answers for one format that covers both a commit and an app frame. The
   doubles encode them differently, so the fake decodes both. Documented there; worth a glance from
   whoever owns the fixture layering.
