# Probe report — Question 3.2: the three loss scenarios are delivered by pull, and the skipped test comes back

**Date:** 2026-07-16
**Branch:** `feat/app-lane-delivery` (not switched, nothing committed)
**Status:** **GREEN.** All three loss scenarios are delivered by pull. The skipped test is un-skipped
and passes. Scenario 2 was **deliverable**, not the laggard case — reasoning below.

## Answer

Yes. `packages/rpc/test/peer-app-drain.test.ts` now holds five tests: the untouched
transport-drop test, the un-skipped restart test, and one test per remaining loss scenario plus the
retention split. Every one asserts the **plaintext the handler received**. No `src/` change was
needed — the committed drain (`3cee984`) already delivers all three; this probe is test-only, and
that is the finding.

## Changes

One file touched. `packages/rpc/src/` is byte-identical to the committed state (`git diff
packages/rpc/src/` is empty).

- `packages/rpc/test/peer-app-drain.test.ts:3-4` — added imports: `commitTopic` / `protocolTopic`
  from `../src/topic.js`, `fakeEpochSecret` from `./fixtures/fake-crypto.js` (scenario 2 asserts the
  log ordering it is named for).
- `packages/rpc/test/peer-app-drain.test.ts:53-71` — **the doc comment rewritten.** The old one
  said app frames "are mailbox-class and cannot be pulled … The fix is a pull-readable app lane …
  Unskip this the day it can." That is now false. The replacement states the invariant the test
  pins — nothing pushes the frame at him, so the pull is the only thing that can deliver it; the
  restarted handle comes back at the sealing epoch (the key is his to hold) and the seed pull reads
  the segment's topic before the walk ratchets off that epoch (the key is his to use); neither half
  alone delivers anything. No history, no plan-question or phase names.
- `packages/rpc/test/peer-app-drain.test.ts:72` — **`test.skip` → `test`**, retargeted from the
  ephemeral `chat/changed` onto the retained `chat/posted`, and `hub.redeliver('bob')` dropped (see
  "Surprises").
- `packages/rpc/test/peer-app-drain.test.ts:112-243` — three new tests: scenario 1, scenario 2, and
  the retention split.
- `packages/rpc/test/peer-app-drain.test.ts:18` — **untouched**, as directed. It still runs the
  ephemeral `chat/changed` through the hub's mailbox redelivery, and still passes on that mechanism.

## The three scenarios, and how each was constructed

### Scenario 3 — own-epoch after restart (the un-skip), `:72`

`test('a peer that was restarted still reads the messages sent at its epoch')`. Kept the original
test's shape deliberately, including its "phone in a pocket" framing: the dead peer is **never
disposed**, so the hub still holds its subscriptions.

Alice and bob at epoch 1 → `hub.detach('bob')` → alice dispatches `chat/posted` at epoch 1 → alice
commits ten times (epoch 11) → assert `seen` is `[]` (a backlog, not a live delivery) → bob restarts
over the same handle, crypto, journal and anchor store (`restartOf: bob`) → `hub.reattach('bob')`.

The restarted handle is still at epoch 1 and the restored anchor is still at epoch 1, so
`ready`'s seed pull loads the segment's topic and `deliverAppFrames` opens the epoch-1 frame before
the first `processCommit` ratchets past it. Asserts `epoch === 11` **and** the plaintext.

### Scenario 1 — epoch never held, `:112`

`test('a peer reads the messages sent at an epoch it was never online for')`.

Alice runs the group to **epoch 3**, posts `chat/posted` there, and runs on to **epoch 6**. Bob then
boots **cold at epoch 1**. Epoch 3 is an epoch bob was never online for: no subscription of his was
ever live while the group was there. His walk carries him 1 → 6, and at epoch 3 — before the apply
that leaves it — the trial decrypt opens the frame.

No commit touches a leaf, so the anchor never moves (`anchorEpoch() === 1` asserted). Every frame is
on the one topic, and the **only** thing separating the delivered frame from the undelivered epochs
is the sealing epoch — which is what makes this test about per-epoch reads and not about topics. At
epochs 1 and 2 the buffered frame does not open and is put back; at epoch 3 it does.

### Scenario 2 — own-epoch published after the leaving commit, `:150`

`test('a peer reads a message sent at its own epoch that reached the log after the commit leaving
it')`. **This is the scenario the brief flagged. It was deliverable, not the laggard case.**

Three members at epoch 1. `hub.detach('alice')` → **carol** commits, and that commit — the commit
that takes the group off epoch 1 — lands in the log while alice is still at epoch 1 and has not
applied it. Alice then dispatches `chat/posted`, sealing under **epoch 1**, and the frame enters the
log **behind** the commit that left epoch 1. The test asserts that ordering explicitly rather than
narrating it: it filters `hub.published` by `commitTopic(recoverySecret)` and by
`protocolTopic(fakeEpochSecret(1), 1, 'chat')` and asserts
`posted[0].sequenceID > commits[0].sequenceID`. Bob then boots cold at epoch 1, reads the frame,
and applies carol's commit — asserting `epoch === 2` and the plaintext.

**Why this is deliverable and not the laggard case.** The laggard case is a statement about a
*reader*, not about a publisher: bytes sealed at epoch E are lost to anyone **already past E**. It
is not a statement about the frame's position in the log. Two things follow, and they are
independent:

- Carol — who applied her own commit and is at epoch 2 — can never open alice's frame. That half
  **is** the laggard residual, it is inherent, and no ordering or store repairs it. Untouched, not
  asserted, not repaired.
- Bob is **still at epoch 1**. The key is in his hand. The drain reads a segment's topic *whole* and
  *ahead of every apply*, so the frame's place in the log relative to that commit never enters the
  question — `loadAppSegment` pulls the topic with no cursor, and `deliverAppFrames` runs before
  `processCommit`. Bob reads it.

This is exactly the reading the brief's escape hatch names: "a frame published at the peer's own
epoch that simply lands in the log before the peer's pull". It landed before his pull; he was at
the epoch that opens it; it was delivered. The scenario as the spec names it is about the
**returning member's own epoch**, and the returning member gets it. Reported as deliverable, and
the test's doc comment says both halves out loud — including that a reader already past the sealing
epoch never will, and that this is inherent rather than an ordering this code could fix.

I did not weaken a test, loosen the fake, or contort the drain to reach this. The fake crypto's
strict single-epoch `unwrap` is untouched; it is what makes the pass meaningful.

### Retention split, `:203`

`test('a returning peer is given the logged history and none of the ephemeral history')`.

Alice dispatches `chat/changed` (ephemeral) and `chat/posted` (`retain: 'log'`) at the same epoch
onto the **same topic** while bob is gone. Bob restarts: the `posted` handler receives its plaintext,
the `changed` handler receives nothing. Because both procedures are on one protocol and one topic,
this cannot be topic separation doing the work — the ephemeral frame is on the very topic the drain
just pulled, and it is not in that topic's log to be pulled (the hub's `fetchTopic` filters to
log-class frames). The protocol's declaration is the whole of what decides it.

## Mutation checks

### 1. Revert the log-class publish (`peer.ts` dispatch: a logged event takes the live path)

Replaced the `retentionOf(...) === 'log'` branch in `surfaceFor.dispatch` with a bare
`await runtime.client.dispatch(prc, data)`.

```
 ✓ test/peer-app-drain.test.ts > ... > a peer whose transport dropped still reads the messages sent at its epoch 212ms
 × test/peer-app-drain.test.ts > ... > a peer that was restarted still reads the messages sent at its epoch 203ms
   → expected [] to deeply equal [ { text: 'before lunch' } ]
 × test/peer-app-drain.test.ts > ... > a peer reads the messages sent at an epoch it was never online for 178ms
   → expected [] to deeply equal [ { text: 'sent at epoch three' } ]
 × test/peer-app-drain.test.ts > ... > a peer reads a message sent at its own epoch that reached the log after the commit leaving it 159ms
   → expected [] to deeply equal [ { text: 'raced the commit' } ]
 × test/peer-app-drain.test.ts > ... > a returning peer is given the logged history and none of the ephemeral history 160ms
   → expected [] to deeply equal [ { text: 'alice said something' } ]

 Test Files  1 failed (1)
      Tests  4 failed | 1 passed (5)
```

All four decisive tests red. The transport-drop test stays **green** — correctly: it runs the
ephemeral `chat/changed` over the hub's mailbox redelivery, which this mutation does not touch. That
is the clearest possible evidence the two mechanisms are genuinely different, and that leaving that
test alone was right.

### 2. Revert the anchor update (drop `captureAnchor()` at the apply site)

Removed the `if (detectRosterChange(...) || header?.external === true) { await captureAnchor() }`
block in `walkCommits`.

```
 × test/peer-app-segment-drain.test.ts > a returning peer reads the retained app frames of every epoch it walks past > frames from two segments either side of a roster change all arrive, in publish order 217ms
 × test/peer-roster-change-detect.test.ts > ... > a remove-only commit is detected: the anchor advances 85ms
 × test/peer-roster-change-detect.test.ts > ... > an add-only commit is detected: the anchor advances to the joiner's add epoch 68ms
 × test/peer-roster-change-detect.test.ts > ... > an Add and a Remove in one commit is detected — the case a count check misses 67ms
 × test/peer-roster-change-detect.test.ts > ... > an external-commit rejoin by a member the roster lost is detected: it brings a DID back 66ms
 × test/peer-roster-change-detect.test.ts > ... > an external-commit rejoin by a member still IN the roster is invisible to a DID diff, and rotates anyway 63ms
 × test/peer-removed-blind.test.ts > ... > nothing the removed member still holds derives the new topic, and nothing reaches her 167ms
 × test/peer-app-topic.test.ts > ... > a Remove rotates the app topic onto a new ID, and delivery continues across it 161ms
 × test/peer-app-topic.test.ts > ... > an add-only commit rotates the app topic too, and delivery continues across it 154ms
 × test/peer-app-topic.test.ts > ... > a member booting at a later epoch than the anchor derives the same topic and exchanges events 204ms
 × test/peer-app-topic.test.ts > ... > a rejoin rotates the anchor: the group and the rejoiner land on the same post-commit epoch 273ms
 × test/peer-anchor-restart.test.ts > ... > a roster change rotates the anchor and persists it, and a restart comes back on the new one 107ms
 × test/peer-anchor-restart.test.ts > ... > the fixture restart carries the anchor store: a peer restarted after a rotation comes back on it 103ms
 × test/peer-control-lanes.test.ts > ... > commit and rendezvous are subscribed once at init, and survive resync and dispose 109ms
 × test/peer-recovery.test.ts > ... > a stranded peer rejoins by external commit, and one responder wins 186ms

 Test Files  7 failed | 28 passed (35)
      Tests  15 failed | 191 passed (206)
```

The decisive drain test — the cross-rotation one — goes red, along with fourteen others.

**Worth stating plainly:** this mutation leaves all five `peer-app-drain.test.ts` tests green,
because none of them contains a roster change. That is by construction, not an oversight: the three
loss scenarios are all *within one segment*, and the anchor rotation is what `peer-app-segment-drain`'s
cross-rotation test is for. The decisive test for this mutation lives there, and it goes red.

### Inversion

Both mutations were inverted **by hand** (`Edit`, restoring the exact original text). No
`git checkout`, `git restore`, or `git stash` was run at any point. Verified clean:

```
$ git diff --stat
 packages/rpc/test/peer-app-drain.test.ts | 179 +++++++++++++++++++++++++++----
 1 file changed, 159 insertions(+), 20 deletions(-)

$ git diff packages/rpc/src/
(empty)
```

No residue.

## Verify (real output, repo root)

```
$ pnpm run build
 Tasks:    8 successful, 8 total
build exit: 0

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 219 files in 260ms. No fixes applied.
lint exit: 0

$ pnpm test
 Tasks:    30 successful, 30 total
test exit: 0

@kumiai/mls:test:unit:            Tests  307 passed (307)
@kumiai/broadcast:test:unit:      Tests   35 passed (35)
@kumiai/hub-protocol:test:unit:   Tests    8 passed (8)
@kumiai/hub-tunnel:test:unit:     Tests   63 passed (63)
@kumiai/hub-server:test:unit:     Tests   69 passed (69)
@kumiai/hub-client:test:unit:     Tests    5 passed (5)
@kumiai/rpc:test:unit:      Test Files   35 passed (35)
@kumiai/rpc:test:unit:            Tests  206 passed (206)
```

`@kumiai/rpc`: **206 passed, 0 skipped.** `grep -rn "test.skip\|it.skip\|describe.skip"
packages/rpc/test/` returns nothing — the skip is gone from the package, not merely from this file.

## Surprises

1. **No `src/` change was required.** The committed interleaved drain delivers all three scenarios
   as-is. I went in expecting to find at least one gap and found none; the probe is test-only. The
   assumption in plan Q3.2 ("the drain closes each of …") holds without amendment.

2. **`hub.redeliver('bob')` had to go from the un-skipped test, and its removal strengthens it.**
   The original test called `reattach` **and** `redeliver` because push was the only mechanism that
   existed. Keeping it would have let the hub push the epoch-1 app frame at the restarted peer, so a
   pass would no longer prove the drain — and worse, it would have raced: whether the frame arrives
   before the seed pull ratchets the handle to epoch 11 is a timing accident. Dropping it makes the
   restart's own seed pull the only possible deliverer, which is what the test is for. This matches
   the pattern `peer-app-segment-drain.test.ts` already established (`reattach`, no `redeliver`).
   `reattach` itself is now strictly redundant — `hub.receive()` sets `#live` on construction — but
   I left it in as the explicit statement that the socket came back.

3. **Scenario 2 needed a third member to construct honestly.** Alice cannot both publish at epoch 1
   and be the one who commits off it — adopting her own commit moves her past the epoch she would
   need to seal under. A second committer (carol) plus a momentarily-behind publisher (alice) is the
   real shape of the race, and it is an ordinary one: a publish racing a commit, not a contrivance.

## Concerns

1. **Scenario 1 overlaps `peer-app-segment-drain.test.ts:22`** ("frames from several epochs inside
   one segment all arrive"), which already covers a frame sealed at an epoch the returning peer was
   not online for. The overlap is deliberate — the brief asks for the three loss scenarios named and
   asserted as such — but the two files now assert adjacent things from different framings. If that
   redundancy is unwanted, scenario 1 is the one to drop, not the segment-drain test.

2. **Scenario 2's deliverable half and the laggard residual are the same frame.** The test proves
   bob gets it; it does not assert that carol never will. Asserting the negative would be asserting
   the accepted residual, which is out of scope here — but it does mean nothing in the suite pins
   the laggard boundary, and a future change that (say) widened the drain's decrypt window past the
   current epoch would go unnoticed by these tests. The fake crypto's strict single-epoch `unwrap`
   is what currently holds that line, and it holds it as a fixture property rather than an assertion.

3. **Mutation 2 does not touch this file.** Recorded above rather than buried: the anchor-update
   mutation's decisive test is in `peer-app-segment-drain.test.ts`. Anyone reading
   `peer-app-drain.test.ts` alone would not learn that the anchor rotation is load-bearing, because
   within a single segment it is not.

## Residuals — unchanged, not closed, as directed

Untouched and not reported as surprises: the unbounded segment buffer; the `// SEAM:` in
`loadAppSegment` (a pruned frame is silently absent); the `O(frames × commits)` trial decrypt; the
`processCommit`→`save` window; the laggard publisher. No pruned-window event, no durable cursor, no
retention default change. The drain's design, the self-echo skip, `detectRosterChange`, the external
signal, the `AnchorStore` and the fake's strictness are all as committed.
