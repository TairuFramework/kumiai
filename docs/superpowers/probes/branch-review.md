# Adversarial review — `feat/app-lane-delivery`

Scope: `git diff main...HEAD`, focused on `packages/rpc/src/`. Accepted items from the brief are not
reported. Findings are ranked by severity.

Headline: **the branch fixes the app-lane loss for every member that APPLIES a roster change, and
leaves it wide open for the member that AUTHORS one.** `commit()` never rotates the anchor. The test
suite cannot see it because every rotation test fabricates the roster-changing commit from an
off-stage non-peer, so the one actor whose behaviour is wrong is the one actor never under test.

---

## F1 — CRITICAL — `commit()` never rotates the anchor for a roster change it authors

`packages/rpc/src/peer.ts:1708-1710` (and `:1440`, `:1497` for the restart half)

### The defect

The anchor rotates in exactly three places:

- `peer.ts:1210` + `:1270-1275` — `walkCommits` diffs `port.rosterDIDs()` around `processCommit`
  and captures. This is the **applier's** path.
- `peer.ts:1888` — `recover()` captures explicitly after `pending.onAccepted()`.
- `peer.ts:1975` — first boot.

`commit()` is not among them:

```ts
// peer.ts:1697-1711
await slot.markAccepted(publishID, sequenceID)
...
await pending.onAccepted()      // ← the host adopts the post-commit handle HERE.
await slot.clear(publishID)     //   The roster changes HERE. Nothing diffs it.
await rebuildEpoch()            // ← re-derives every topic from the UNCHANGED anchor.
return takeLost()
```

The code already states the governing principle — in `recover()`, at `peer.ts:1879-1881`:

> The anchor, set from the rejoined handle — the peer's own half of the rotation every member
> applying this same external commit performs. **It can never take the other half: a member does not
> process its own commit, so the apply site above never runs for the one commit that put this peer
> back in the group.**

That argument is not special to a rejoin. It is true of **every commit a peer authors**. `recover()`
acts on it; `commit()` does not. The rotation rule (`roster.ts:1-21`) is enforced on exactly one of
the two paths that can change a roster.

`replayJournal` has the same hole at `peer.ts:1440` and `peer.ts:1497`: both call `adoptJournalled`,
which adopts a post-commit handle whose roster may differ, and neither diffs or captures.

### Failure scenario — the Add (silent, permanent, bidirectional partition)

State: Alice + Bob at epoch 5, anchor `{secret@5, 5}`, app topic `T5`.

1. Alice: `commit(build → add Dave)`. Publish accepted → `onAccepted()` → Alice's handle at epoch 6,
   roster `{alice, bob, dave}` → `rebuildEpoch()` → topic = `protocolTopic(anchor.secret@5, 5, name)`
   = **`T5`**. Anchor unmoved.
2. Bob: commit wakeup → `walkCommits` → `apply` → `detectRosterChange({a,b}, {a,b,d})` = true →
   `captureAnchor()` → `{secret@6, 6}` → **`T6`**.
3. Dave: boots from his Welcome at epoch 6, empty `anchorStore` → `captureAnchor()` → `{secret@6, 6}`
   → **`T6`**.

Result: Alice is alone on `T5`; Bob and Dave are on `T6`.

- Alice's dispatches go to `T5`. Bob tore down his `T5` listener in `teardownEpoch` (his mux
  subscription stands, but nothing is listening, so the push is dropped — `hub-mux.ts:171-177`), and
  his drain only ever pulls the current anchor's topic (`peer.ts:905`). Bob never sees them, live or
  drained.
- Bob's and Dave's dispatches go to `T6`. Alice never subscribed to `T6` and never pulls it.
- **Dave cannot derive `T5` even in principle.** MLS ratchets forward; his handle can export no
  secret from before his add. This is precisely the constraint `roster.ts:8-13` and
  `peer.ts:379-384` cite as the reason an Add must rotate the anchor.

### It is permanent, and a restart does not heal it

- `reconciledHead` is set past Alice's own frame (`peer.ts:1702`), so no later pull re-reads it.
- After a restart `reconciledHead` is `null`, so the frame **is** re-read — but
  `classifyCommit(header{epoch:5}, …)` with `crypto.epoch() === 6` and an empty in-memory
  `appliedByEpoch` files it `history` (`classify.ts:142-147`) → `continue`, no apply, no rotation.
- `anchorStore.load()` restores the stale anchor forever (`peer.ts:1971-1973`).

Alice stays partitioned until she happens to *apply someone else's* roster-changing commit. In a real
group the member who performs adds and removes is the admin — i.e. the failure lands on the account
that invites everyone.

### Invariant 1 is violated

> The anchor … must be >= every current member's effective join.

Alice's anchor sits at 5; Dave's effective join is 6. Alice's anchor is **below** a current member's
join — the exact condition `peer.ts:379-384` says the design exists to make impossible.

### Security corollary (Remove) — a weaker but real forward-secrecy break

Alice removes Carol at epoch 5. Alice's anchor stays at 5, so Alice keeps publishing to `T5` — the
topic derived from the epoch-5 secret **Carol exported while she was a member and still holds**.
Carol's subscription to `T5` was never released (`hub-mux.ts:93-102`: nothing ever unsubscribes), so
she keeps receiving Alice's frames and can compute the topic ID herself.

This is **not** a plaintext break: content is sealed under Alice's *live* epoch (6), which Carol
cannot open. It is a metadata/traffic-analysis leak — Carol learns that the group is still active,
who is publishing, at what rate and size, on a topic the design says the group must have abandoned.
`roster.ts:8-10`: "A Remove must rotate it for forward secrecy — the evicted member keeps every topic
ID it ever derived, **so the group has to stop using them**." The evicting admin does not stop.

### Why no test catches it

Every rotation test drives the roster change through `publishCommit({ senderDID: 'admin', … })`
(`test/fixtures/commits.ts:54-58`: "A member that is not a peer in the test — an admin off-stage").
So every peer under test is an **applier**:

- `peer-app-topic.test.ts:185` (Remove), `:246` (Add), `:323` (Add) — all off-stage admin.
- `peer-roster-change-detect.test.ts` — all off-stage admin.
- `peer-removed-blind.test.ts`, `peer-anchor-restart.test.ts` — all off-stage admin.

The only two tests that drive a roster change through `peer.commit()` are the only two files in the
suite with **no `anchorEpoch()` assertion at all**:

- `peer-commit-cas.test.ts:274` — `alice.peer.commit(buildInviteCommit(alice, 'dave'))`
- `peer-commit-replay.test.ts:301` — `alice.peer.commit(buildRemoveCommit(alice, 'mallory'))`

And `peer-app-topic.test.ts:278`'s describe title — *"every member agrees on the anchor, including
one that boots after it"* — is false for the one member it never tests.

**Fixture gap that would hide the fix, too:** `buildRemoveCommit`'s `onAccepted`
(`test/fixtures/peer.ts:222-225`) does change the roster (`mls.evict(victimDID)`), but
`buildInviteCommit`'s (`test/fixtures/peer.ts:248-251`) does **not** add the invitee's leaf — it only
pushes to `member.welcomes`. So a roster-diff-based fix in `commit()` would not fire for the invite
fixture. That fixture is unfaithful about the single thing the anchor rotation turns on.

### Missing tests

- *"a member that COMMITS an add rotates its own anchor onto the add epoch, and exchanges events with
  the member it added"* — with a topic-ID and a wire assertion, mirroring `peer-app-topic.test.ts:224`
  but with `alice.peer.commit(...)` instead of `publishCommit(...)`.
- The Remove twin, asserting the committer leaves the evicted member's topic.
- The restart twin for `replayJournal`: a journalled roster-changing commit adopted on boot must
  rotate.
- `buildInviteCommit`'s `onAccepted` must add the leaf.

### Fix shape

Read `port.rosterDIDs()` before `pending.onAccepted()` and diff after — exactly as `walkCommits` does
at `peer.ts:1210` / `:1270-1275` — then `captureAnchor()`. Same around `adoptJournalled` in
`replayJournal`. Note `PendingCommit.kind` (`'invite' | 'remove' | 'ledger'`) is *not* a safe
substitute: it is the host's word about intent, where the diff is the handle's word about outcome.

---

## F2 — HIGH — `replayJournal` ratchets the handle with no drain in front of it

`packages/rpc/src/peer.ts:1440`, `packages/rpc/src/peer.ts:1497`

### The defect

Invariant 3: *a retained frame is readable only at the epoch it was sealed at — so the drain runs
BEFORE each `processCommit`, never after.* `walkCommits` honours this at `peer.ts:1204`.
`adoptJournalled` is a `processCommit`-equivalent — it advances the epoch — and has **no**
`deliverAppFrames()` in front of it. The only two call sites of the drain are `peer.ts:1204` and
`peer.ts:1308`, both inside the pull; `replayJournal` is step 0 of every lane operation and runs
*strictly ahead of the pull* by explicit design (`peer.ts:1414-1420`).

### Failure scenario

Alice holds a journalled commit framed at epoch 5 and has been offline a week. The group is still at
epoch 5 and has published 200 `retain: 'log'` frames to the app topic.

1. Boot → `ready` → `initControlLanes` → `runSerial`:
   `replayJournal()` (`peer.ts:1386`) → republish deduped/accepted → `adoptJournalled` → **handle at
   epoch 6**. This is the peer's first action; `appSegmentLoaded` is still `false`, nothing has been
   drained.
2. `pullCommits()` (`peer.ts:1391`) → `deliverAppFrames()` → `loadAppSegment()` — the first pull ever
   — returns the 200 frames sealed at epoch 5.
3. `crypto.frameEpoch(sealed) === 5`, `crypto.epoch() === 6`, `5 > 6` is false → `frame.sealed = null`
   (`peer.ts:1029`) = **dead**.
4. `advanceAppCursor` walks the whole run of dead frames and **persists the cursor past all 200**
   (`peer.ts:958-965`).

A week of messages, silently and unrecoverably gone — the cursor is rewritten, so the next restart
cannot get them either. This is the exact bug class the branch exists to kill.

The comment at `peer.ts:986-989` names the hazard ("a journal replay advances it before this pull
ever runs") and files it as ordinary, without saying it is a loss. It is fixable: `deliverAppFrames()`
before `adoptJournalled` — the anchor is settled at `peer.ts:1971-1976`, before `initControlLanes`,
so the drain has everything it needs.

### Test

None. The three suites that exercise `acceptedAs` / republish (`peer-commit-replay.test.ts`,
`peer-first-commit-crash.test.ts`, `peer-commit-cas.test.ts`) install **no app handlers and dispatch
no app frames** (`peer-commit-cas.test.ts:366,389`: `handlers: { chat: {} }`). Conversely no app-drain
test populates a journal. The two halves never meet.

---

## F3 — HIGH — a swallowed `loadAppSegment` failure lets the walk ratchet past frames it never read

`packages/rpc/src/peer.ts:1009-1015`

```ts
try {
  await loadAppSegment()
} catch {
  // The pull failed (not yet subscribed, hub down). The buffer stays unloaded and the next
  // pull retries it; the commit walk is not this drain's to break.
  return
}
```

**The comment lies about the consequence.** It is true that the next pull retries the *load*. It is
false that this is harmless: the "next pull" happens after `walkCommits` has already called
`processCommit` (`peer.ts:1213`) and ratcheted the handle. Everything the failed load would have
delivered is dead by the time the retry succeeds.

### Failure scenario

Bob is four epochs behind. `walkCommits` reaches the first applicable frame at epoch 5.

1. `deliverAppFrames()` → `loadAppSegment()` → `mux.fetchTopic` throws (transient hub 503, tunnel
   reconnect, `RetentionExceededError` on the listener-less retain at `peer.ts:909`) → swallowed →
   `return`.
2. `walkCommits` carries on → `processCommit` → epoch 6.
3. Next applicable frame → `deliverAppFrames()` → `loadAppSegment()` now succeeds → every epoch-5
   frame comes back → `sealedAt (5) !== crypto.epoch() (6)`, not ahead → `frame.sealed = null` →
   dead → cursor persisted past them.

One transient fetch error during a catch-up walk destroys the entire backlog at every epoch the walk
passed while the buffer was unloaded. Silent; the cursor advance makes it unrecoverable.

The safe behaviour is the one `walkCommits` already uses for a broken port (`peer.ts:1224-1229`):
leave the cursor put and re-read. A load failure must abort the walk *before* the apply, not let it
proceed blind.

### Test

None — and there is no fault injection anywhere in `packages/rpc/test/`. No `vi.spyOn`, no
`mockRejected`, no throwing `fetchTopic` wrapper. The only throws either fake hub can produce are
`HeadMismatchError` and `NotSubscribedError` from real preconditions, and `NotSubscribedError` is
unreachable in `loadAppSegment` because it retains first (`peer.ts:909`).

---

## F4 — MEDIUM-HIGH — an unbounded future-epoch claim pins the cursor for the segment's whole life

`packages/rpc/src/peer.ts:1022-1030`

```ts
const sealedAt = crypto.frameEpoch(sealed)
if (sealedAt !== crypto.epoch()) {
  if (sealedAt != null && sealedAt > crypto.epoch()) continue   // ← no upper bound
  frame.sealed = null
  continue
}
```

`sealedAt` is cleartext — "the frame's word — which is to say the PUBLISHER's, carried in the clear
and relayed by an untrusted hub" (`crypto.ts:47-49`). Nothing bounds how far ahead it may claim. A
frame claiming epoch `2^53` keeps `sealed != null` forever, and `advanceAppCursor` stops dead at the
first frame with `sealed != null` (`peer.ts:958).

`crypto.ts:49-51` covers the *claims-current* case ("a frame that claims this handle's epoch and will
not open is treated as any other frame that will not open"). It says nothing about the *claims-future*
case — which is the only claim that converts an untrusted party's word into durable local state.

### Failure scenario

The hub routes on `topicID` in the clear, so it knows every app topic a member publishes to. It
injects one frame onto that topic whose cleartext epoch field reads `65535` (or any member does; a
member holds the topic secret).

For the rest of that segment's life:

- The cursor for that topic **never advances again**. `frames.splice` never runs, so the poison frame
  and everything behind it stay buffered — `appSegment` grows without bound.
- Every restart re-pulls the entire segment from the pinned cursor (`peer.ts:910-912`) and
  re-delivers every still-openable frame after the pin. Not "at-least-once against the live path" —
  unbounded re-delivery of the whole segment history, on every boot, forever.
- Once the hub's retention floor passes the pinned cursor, `onAppWindowPruned` fires permanently and
  spuriously on every load.

The only bound is `captureAnchor()` resetting the buffer at the next roster change (`peer.ts:461-463`)
— i.e. **none at all** for a group with a stable roster, which is the normal case.

This is distinct from the accepted "`oldest > cursor` over-reports a pruned window": that is a
symptom of an honest prune. This is a wedge, reachable by the untrusted hub, with no honest cause.

Fix shape: bound the forward claim. A frame claiming an epoch above what the commit log's head can
justify (or above `anchor.epoch + N`) is not "ahead of the walk" — no walk will ever reach it — so it
is dead on the same terms as a below-epoch frame.

### Test

None. `peer-app-cursor.test.ts:120` proves the cursor stops behind an *honest* ahead-frame (and would
catch a mutation that removed the stop — good), but nothing publishes a frame claiming an epoch the
walk can never reach.

---

## F5 — MEDIUM — the segment is pulled at most once, and the comment justifying it is false on both clauses

`packages/rpc/src/peer.ts:429-434`, `packages/rpc/src/peer.ts:900-901`

```
Pulled ONCE per segment and not per commit: a re-pull would re-deliver every frame the buffer had
already dispensed, and the log is the same log at every epoch inside the segment.
```

Both clauses are wrong.

1. **"the log is the same log at every epoch inside the segment"** — it is not. The log *grows* with
   every `retain: 'log'` dispatch, and a segment with a stable roster lives indefinitely. The set of
   epochs a segment spans is fixed; the set of frames is not.
2. **"a re-pull would re-deliver every frame the buffer had already dispensed"** — it would not.
   `loadAppSegment` pulls **from the cursor** (`peer.ts:910-912`), and the cursor has by definition
   passed every dispensed frame. That is the entire stated purpose of `AppCursorStore`
   (`app-cursor.ts:5-9`: *"A position is what makes a re-read unnecessary"*).

So the one-pull rule is justified by a hazard the cursor already removes — and in removing the
re-pull, it defeats the cursor.

### Consequence

For an already-loaded segment, `deliverAppFrames` is a no-op over a stale buffer. A peer that stays up
but stops receiving live pushes never reads the frames that **are** in the log at the epoch it **is**
at. Its next `commit()` → `reconcileCommits()` → `deliverAppFrames()` → stale buffer → nothing →
`onAccepted()` → epoch advances → those frames are dead.

Reachable: `hub-mux.ts:159-162` kills the receive drain permanently on any iterator error
(`catch { return }`) with no reconnect and no report, so "up but deaf" is a real state. `fetchTopic`
still works from that state — the pull is the peer's one remaining chance to read its log, and the
`appSegmentLoaded` latch throws it away. That is the push-only, dropped-if-not-listening property the
branch exists to remove, reintroduced inside the drain.

(The hub-mux drain death itself is adjacent to the filed subscribe-failure swallow and largely
pre-dates the diff; the one-pull latch and its false justification are new here.)

---

## F6 — MEDIUM — `dispatch()` between `captureAnchor()` and `rebuildEpoch()` publishes into the void

`packages/rpc/src/peer.ts:557-566` vs `:1274` / `:1315`

`captureAnchor()` moves `anchor` **inside** `walkCommits` (`peer.ts:1274`), under the commit mutex.
`rebuildEpoch()` runs only after the whole walk returns (`peer.ts:1315`, `:1333`). `dispatch` takes no
mutex — only `await ready` (`peer.ts:1996`) — and publishes to `runtime.topicID`, captured at the
*previous* `buildEpoch`.

So in that window a `retain: 'log'` dispatch publishes **to the segment the peer just left, sealed
under the NEW live epoch**. Nobody can ever read it:

- members on the new topic are not listening on the old one;
- members still on the old topic are at the old epoch and cannot open the new seal;
- the publisher's own drain never pulls the old topic again (`captureAnchor` reset the buffer and the
  anchor moved).

**This is not the accepted laggard publisher.** The laggard's handle has not applied the rotation, so
its seal epoch and its topic segment are *consistent* — another laggard can read it, and the peer
cannot know better. Here the peer **has** applied the rotation and moved its own anchor; seal epoch
and topic segment are inconsistent by construction, so the frame is unreadable by *anyone*, laggards
included. And it is fixable in-process: derive the topic from the live `anchor` at dispatch time —
which `surfaceFor.to` already does (`peer.ts:576-577`) — or take the mutex.

The window is not tiny. Per remaining log frame, `walkCommits` awaits `fetchTopic`,
`readCommitHeader`, `deliverAppFrames` (a whole segment pull), `rosterDIDs`, `processCommit`, and
`captureAnchor` (an `exportSecret` plus a durable `anchorStore.save`).

Related inconsistency in the same window: `to()` resolves peers' inboxes against the **live** anchor
(`peer.ts:576-577`) while the acceptor listens on the `selfInbox` captured at `buildEpoch`
(`peer.ts:487`) — so this peer addresses new inboxes while listening on its own old one, and directed
replies time out. `to()` also skips `withReady` entirely (`peer.ts:1999` vs `:1996-1998`).

### Test

None. No test in `packages/rpc/test/*.test.ts` races a dispatch against a walk — every test
`await flush()`es between `publishCommit` and `dispatch`. The only `Promise.all` races in the suite
(`peer-commit-cas.test.ts:101,139`, `peer-recover-lane.test.ts:416`, `directed.test.ts:95,250`) are
commit/recover races.

---

## F7 — LOW-MEDIUM — guards no test exercises, and one mis-filed test

**(a) `peer.ts:1056` — the retention guard survives deletion.**

```ts
if (retentionOf(protocols[name], prc) !== 'log') continue
```

This is the one guard between a hostile member and *"make every returning member re-fire an ephemeral
handler out of the log"* — the hazard `protocol.ts:30-36` says retaining correlation traffic creates.
No test ever publishes a `retain: 'log'` frame naming an ephemeral procedure; every `retain: 'log'`
publish in the suite names an already-logged procedure (`peer-app-cursor.test.ts:104-105`,
`peer-app-retention.test.ts:84`). Deleting the guard keeps the suite green.

`peer-app-drain.test.ts:211` ("logged history and none of the ephemeral history") does **not** cover
it: the ephemeral frame rides the mailbox lane and the hub filters it out of `fetchTopic`
(`durable-fake-hub.ts:106-108`), so it never reaches the buffer and line 1056 is never evaluated for
it.

**(b) `peer.ts:1045` — the self-echo guard survives deletion.** It is structurally unreachable in
every test: a peer must publish while `appSegmentLoaded === false` for its own frame to land in its
own buffer, and every test flushes an empty seed pull first. Note that F1's fix reopens this window
(a committer's `captureAnchor` would reset the latch mid-lane), so the guard is about to start
mattering.

**(c) `peer-app-drain.test.ts:20` is mis-filed.** It sits in a describe titled *"app frames outlive
the commits that leave their epoch"*, but dispatches `chat/changed`, which `test/fixtures/peer.ts:24`
defines as **ephemeral**. That frame never enters the log; it is delivered by `hub.redeliver('bob')`
over the live mailbox lane. The test does not exercise the drain at all. Same family as the two
fixtures previously found asserting the opposite of their contract.

---

## F8 — LOW — `peer-removed-blind.test.ts` proves less than its title

`packages/rpc/test/peer-removed-blind.test.ts:151-162`

The test enumerates `protocolTopic(secret, epoch) !== groupTopic` over the secrets Carol **holds**
(`carolRecoverySecret`, `carolEpochSecret`) × epochs 0..6. But `fakeEpochSecret`
(`test/fixtures/fake-crypto.ts:35-39`) is an invertible XOR mix over `FAKE_BASE_SECRET`, an
**exported constant** (`:19`) — so Carol could compute *any* epoch's secret from nothing at all. The
enumeration is scoped to secrets held, not secrets derivable.

Not a pass-for-the-wrong-reason: it does genuinely go red for the two regressions that matter — a
recovery-secret anchor (the `epoch=2` iteration would derive `groupTopic` exactly, since
`memory-group-mls.ts:692-694` hands Carol the same shared bytes) and a pre-commit-secret anchor. That
is real value. But the `describe` title claims forward secrecy the double cannot express, and real
blindness rests entirely on MLS one-wayness, which is untested here and untestable against this fake
(the fake says so itself at `:32-34`). Worth renaming to what it proves: *"the anchor is sealed from
`exportSecret()` at the post-commit epoch — not the recovery secret, and not the pre-commit secret."*

---

## Categories with no findings

- **Invariant 6** (`only event procedures may be retain: 'log'`) — holds. `retentionOf`
  (`protocol.ts:73-76`) is the sole runtime gate on both the publish (`peer.ts:557`) and the drain
  (`peer.ts:1056`) paths, and it tests `type === 'event' && retain === 'log'`. `defineGroupProtocol`'s
  type-level and definition-time guards are belt-and-braces; even a JS caller passing a raw literal
  with `retain: 'log'` on a request cannot get it retained. (The guard is untested at runtime — see
  F7a — but it is correct.)
- **Invariant 5's authenticity half** — holds. `unwrap` is the sole authority on opening everywhere;
  `frameEpoch` never decides that bytes are genuine, only what to try. The defect in F4 is on the
  *pass* half, not the authenticity half.
- **`classify.ts`** — no findings. The row order, the null-header-first rule, and the
  authorship-not-applicability discrimination all hold against the cases in the diff.
- **Anchor half-pairing** — no findings. `captureAnchor` (`peer.ts:447`) reads `exportSecret()` and
  `epoch()` in one expression after the apply, and `recover()`'s ordering comment
  (`peer.ts:1884-1887`) is correct: post-`onAccepted` is where an applying member lands.

---

## Confidence

- **F1: high.** Verified by reading every `captureAnchor` call site (`peer.ts:446, 1274, 1888, 1975`),
  confirming `commit()` is absent from them, tracing the restart path through `classify.ts:142-147` to
  confirm it does not self-heal, and confirming by grep that the two tests driving a roster change
  through `commit()` are the only two files without an `anchorEpoch()` assertion. The one thing I did
  not do is run a failing test.
- **F2, F3: high.** Both are direct reads of the control flow; the missing test coverage was
  independently confirmed.
- **F4: medium-high.** The code path is certain. The reachability rests on the hub knowing app topic
  IDs (it does — it routes on them) and on epochs being far from the type's maximum (true for real
  MLS uint64; the fake's `getUint16` caps at 65535, which a long-lived group could theoretically
  reach, closing the wedge by accident).
- **F5, F6: medium.** The mechanisms are certain; how often they bite depends on transport behaviour
  I did not exercise. F6's window is confirmed open by two independent traces.
- **F7, F8: high** (mechanical facts about the suite).
