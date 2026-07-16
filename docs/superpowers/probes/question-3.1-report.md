# Probe report — the returning-member drain, interleaved BEFORE each apply

**Status: DONE.** The approved approach held. It did not fight the code: the pre-apply hook landed
where the brief predicted, and both mutations fail exactly the way the brief predicted they would.

Branch `feat/app-lane-delivery`, uncommitted, nothing staged, no branch switch. This overwrites the
BLOCKED report for this question.

## The answer

**Yes.** A peer-internal per-segment drain delivers retained app frames in order under the correct
per-epoch keys, across a rotation boundary. Both tests are green against the strict fake — which
opens only at the sealing epoch — so they are correct against real MLS, whose 4-epoch window is a
superset. Nothing in the drain leans on that window.

## Changes

| File | Change |
| --- | --- |
| `packages/rpc/src/peer.ts:75` | `APP_FETCH_LIMIT = 100` — the segment pull is paged like the commit log. |
| `packages/rpc/src/peer.ts:289-300` | `appEventHandlers`: the host's event handlers adapted once, via the same `adaptBusHandlers` the live bus server is built from. Built at construction because the drain runs mid-walk, when the app lane is torn down and not yet rebuilt — it cannot reach a runtime. |
| `packages/rpc/src/peer.ts:350-366` | `appSegment` (per-protocol buffer of sealed frames, log order) + `appSegmentLoaded`. |
| `packages/rpc/src/peer.ts:381-391` | `captureAnchor` now resets the buffer. The anchor moving *is* the segment boundary — there is no other definition — so the reset lives in the one place the anchor is written, not at its call sites. |
| `packages/rpc/src/peer.ts:768-808` | `loadAppSegment`: subscribe (`mux.retainTopic`), then pull the segment topic to head, once, buffering ciphertext. |
| `packages/rpc/src/peer.ts:810-880` | `deliverAppFrames`: trial-decrypt the buffer at the current epoch, deliver what opens through `appEventHandlers`, re-buffer what does not. |
| `packages/rpc/src/peer.ts:964-970` | **The hook**, immediately before `port.rosterDIDs()` / `port.processCommit`. |
| `packages/rpc/src/peer.ts:1043-1064` | `pullCommits` split: `walkCommits(port, topicID)` is the old body verbatim; `pullCommits` wraps it and adds the end-of-walk flush. |
| `packages/rpc/src/hub-mux.ts:54-64, 271-273` | New `retainTopic(topicID)`. |
| `packages/rpc/src/crypto.ts:8-30` | The port contract stated (brief item 5). |
| `packages/rpc/test/fixtures/fake-crypto.ts:47-56` | The same contract mirrored on the fake, so its strictness reads as intent. No behaviour change. |
| `packages/rpc/test/fixtures/peer.ts:15-24` | `chat/posted` (`retain: 'log'`) added **alongside** `chat/changed`; the ephemeral one untouched. |
| `packages/rpc/test/peer-app-segment-drain.test.ts` | New. Two tests. |

## Was the pre-apply hook where I expected?

**Yes**, and the reason it fits is slightly better than the brief's. The hook sits at `peer.ts:964`,
between the disposition guards and `rosterBefore` / `processCommit`. Two properties of the existing
walk make it fit rather than fight:

1. By that line every frame that is *not* applicable has already `continue`d — history, ahead, fork,
   poison, own-unmerged. So the hook runs **only** on the path that is about to ratchet the handle:
   exactly the event the drain must precede, with no filtering of its own.
2. `crypto.epoch()` is read on the line above (`framedEpoch`, for the fork record), so the walk
   already treats this point as "the epoch I am at, before the apply". The drain needs precisely that
   moment, and the walk had already named it.

The rotation site fit too: `captureAnchor()` is called from inside the walk (`peer.ts:~1020`) on
`detectRosterChange(...) || header?.external === true`, so segment N's buffer is dropped and segment
N+1's topic is pulled *during* the walk — without touching `detectRosterChange`, the external signal,
`retentionOf`, or the `AnchorStore` shape.

## Two things the brief did not name, both load-bearing

### 1. The end-of-walk flush is required; the brief's step 2 does not produce it

The brief says drain "before each apply". That delivers every epoch the walk *leaves* — but never the
epoch it *stops at*. A peer whose backlog is entirely at its current epoch, or whose commit log is
empty, has no apply to hang the drain on and would read nothing at all. Test 1's `{ text: 'at three' }`
(published at epoch 3, the head the walk stops at) is exactly this frame.

So `pullCommits` = `walkCommits(...)` then one final `deliverAppFrames()`. This is why the walk body
was extracted rather than edited in place: the walk has three `return` sites and a `throw`, and the
flush must run after all three returns but **not** after the throw — a port that broke its contract
leaves the cursor put and the frame is re-read, and delivering around a retry path would be wrong.
The extraction is mechanical: `walkCommits` is the old body verbatim, with `port` / `topicID` as
parameters instead of locals.

### 2. `fetchTopic` is gated on the caller's own subscription

`HubMux` had no way to subscribe without installing a listener, and both fakes throw
`NotSubscribedError` on an ungated fetch (`fake-hub.ts:210`, `durable-fake-hub.ts:98`). A segment
reached by *rotating onto it mid-walk* has never been subscribed — `buildEpoch` runs only once the
walk is over — so the drain cannot pull it without subscribing first. Hence `mux.retainTopic`.

It is deliberately unpaired with a release: an app topic is subscribed for the member's whole life
(`peer.ts:~430` and `hub-mux.ts:83-88` both say so — unsubscribing tells the hub to drop this
member's undelivered frames and free any frame it was the last reader of), so there is no later
moment it could correctly be undone at. It is idempotent through the existing refcount, and the drain
only ever subscribes topics for anchors this peer actually holds — the same set `buildEpoch` would
subscribe — so the `subscriberCount` assertions in `peer-control-lanes.test.ts:156,206` and
`peer-anchor-restart.test.ts:150` (topics for anchors nobody holds must have zero subscribers) still
hold.

## Deviations from the brief, and why

### Every buffered frame is tried, rather than stopping at the first that will not open

The brief's step 2 says stop at the first failure, justified by publish order being non-decreasing in
seal-epoch. That justification is sound, and under it the two are **identical** — each epoch's frames
are a contiguous run at the front, so scanning on finds nothing extra.

They differ only when the front of the buffer holds a frame from an epoch the handle has **already
passed**, which stop-at-first would wedge every later frame behind for the rest of the segment. That
is reachable, and by an ordinary path: `replayJournal()` adopts a journalled commit and advances the
handle *before* `pullCommits` runs (`peer.ts:1025`, then `:1030`). A peer restarting over its own
landed commit at epoch E therefore pulls a buffer whose front is an E-sealed frame it can never open
— and every E+1 frame behind it would be lost permanently, with nothing anywhere reporting it.

Trying all of them delivers a **superset**, in publish order, and drops nothing, so it cannot be
worse on correctness. It costs time (below). I judged this a robustness detail inside the approved
shape rather than a redesign, but it is a deviation and is flagged as one.

### A member's own frames are not drained back to it

The brief does not cover this, and the drain forces the question. The live fan-out excludes the
publisher (`fake-hub.ts:27`, `durable-fake-hub.ts:91`) but `fetchTopic` does not, so a returning peer
finds its own past posts in the segment log. I skip on `senderDID === localDID`, matching the live
path: a returning member should not be the only member in the group who sees its own messages
arrive. This is a real semantic decision the brief did not authorise. It is one condition at
`peer.ts:~857` and trivially reversible.

### A defensive `retentionOf` check on drained frames

`fetchTopic` returns log-class frames, but log-class is the *publisher's* word. A member could
publish an ephemeral procedure's frame with `retain: 'log'` and have the drain fire an ephemeral
handler off the log. Retention is the protocol's word, so the drain re-asks it. One line;
`retentionOf` itself untouched.

## What the buffer costs on a long walk

**Memory: one segment's retained frames, sealed, held for the length of that segment's walk.** Not
the whole log — the buffer is dropped at every rotation, so the bound is "app frames published
between two roster changes", not "app frames ever". The bad case is a *quiet* group: one that never
adds or removes a member has one segment forever, so the buffer is the whole app history since
genesis, bounded only by hub retention. See concern 1.

**Time: `O(frames)` unwrap attempts in the good case, `O(frames × commits-in-segment)` in the worst.**
Each apply scans what is *left* in the buffer, and frames leave it as they are delivered, so the
per-apply cost is the residue: frames from epochs still ahead of the walk (which the walk is about to
consume) plus frames that will never open. Stop-at-first would make this `O(frames)` flat — that is
the real price of the deviation above, and I took it because the alternative silently loses mail. The
never-open residue is small and adversarial (laggard publishers, passed epochs); if a segment ever
holds many of them, this is the line to revisit.

**Network: one `fetchTopic` page-loop per segment per protocol.** A walk crossing three roster
changes pulls three topics — not one per commit.

## Mutation checks

### (a) Drain moved to AFTER `processCommit` — the previous brief's design

Removed the call at the hook, re-inserted it after the apply/anchor block and before the cursor
advance. **Both tests go red:**

```
 × frames from several epochs inside one segment all arrive, each read at its own epoch 280ms
 × frames from two segments either side of a roster change all arrive, in publish order 372ms

1. AssertionError: expected [ { text: 'at two' }, …(1) ] to deeply equal [ { text: 'at one' }, …(2) ]
       at packages/rpc/test/peer-app-segment-drain.test.ts:71:18
2. AssertionError: expected [ …(3) ] to deeply equal [ …(4) ]
       at packages/rpc/test/peer-app-segment-drain.test.ts:143:18
```

`{ text: 'at one' }` — the epoch-1 frame — is **gone**, and the delivered run starts at `'at two'`.
That is the previous brief's design failing for the exact reason this brief said it must: after the
apply the handle has ratcheted past epoch 1, and those bytes are ciphertext forever. It does not pass,
and it must not.

### (b) Drain only at the anchor epoch instead of at each epoch in the segment

Gated both the hook and the end-of-walk flush on `crypto.epoch() === anchor.epoch`. Gating only the
hook is **not** the mutation — the unguarded flush would restore per-epoch delivery through the back
door and the mutation would pass, hiding the defect. **Both tests go red:**

```
 × frames from several epochs inside one segment all arrive, each read at its own epoch 281ms
 × frames from two segments either side of a roster change all arrive, in publish order 373ms

1. AssertionError: expected [ { text: 'at one' } ] to deeply equal [ { text: 'at one' }, …(2) ]
       at packages/rpc/test/peer-app-segment-drain.test.ts:71:18
2. AssertionError: expected [ …(2) ] to deeply equal [ …(4) ]
       at packages/rpc/test/peer-app-segment-drain.test.ts:143:18
```

The exact complement of (a): **only** the anchor epoch's frame arrives, and everything sealed at the
epochs the segment ran on through is lost. That is what "per-segment rather than per-epoch" costs,
and it is what test 1 exists to catch.

Both reverted. `grep -n MUTATION packages/rpc/src/peer.ts` → no matches. Suite green.

## Verify (real output, repo root)

```
$ pnpm run build
 Tasks:    8 successful, 8 total
Cached:    7 cached, 8 total
  Time:    681ms

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 219 files in 226ms. No fixes applied.

$ pnpm test
@kumiai/rpc:test:unit:  Test Files  35 passed (35)
@kumiai/rpc:test:unit:       Tests  202 passed | 1 skipped (203)
 Tasks:    30 successful, 30 total
```

`test:types` (`tsc --noEmit -p tsconfig.test.json`) runs as part of `pnpm test` and passes. The
baseline was 34 files / 200 tests; this adds 1 file / 2 tests. (The previous probe's evidence file
`probe-drain-site.test.ts`, referenced by the BLOCKED report, is no longer in the tree.)

## `peer-app-drain.test.ts:72` stays skipped

It stays skipped, and the drain does **not** make it pass. Confirmed empirically rather than argued —
unskipped in a scratch copy, run, restored:

```
1. a peer that was restarted still reads the messages sent at its epoch
   AssertionError: expected [] to deeply equal [ { text: 'before lunch' } ]
       at packages/rpc/test/peer-app-drain.test.ts:103:18
```

Correct and expected: it exercises `chat/changed`, which is ephemeral, so nothing it publishes enters
the log and the drain never sees it. The file is byte-identical to `HEAD` (`git diff` empty). Making
it pass means moving it onto a retained procedure — that question's call, not this one's.

## Residuals (unchanged, not closed)

- **`processCommit` → `save` window** — untouched, still open, still needs the anchor inside the
  handle's durable write. It is now *also* the mechanism behind the head-of-line hazard that motivated
  the scan-all deviation.
- **Laggard publisher** — unreadable under any ordering. Named in a comment on `deliverAppFrames`.
- **Fresh joiner cannot drain pre-join frames** — correct by design, and structurally enforced here:
  it restores no anchor, so it seeds at its own add epoch and never derives an earlier segment's topic
  at all.
- **Pruned window (Phase 4)** — seam marked at `peer.ts:~790`. `result.oldest` is where retention now
  begins; detecting a gap needs a durable read position to compare against, and there is none. No
  signal designed, as scoped.

## Concerns

1. **The unbounded buffer on a roster-stable group** is the one I would not ship without revisiting.
   A group that never adds or removes a member has one segment forever, so "one pull per segment"
   becomes "the entire app history, into memory, on every construction". Retention caps it, but 30
   days of a busy group is a real number. This is the natural home for a durable app-lane cursor —
   which would also close the pruned-window seam and make a re-pull safe.
2. **The self-echo skip is my call, not the brief's.** If the intent is that a returning member *does*
   replay its own posts, it is one condition to delete — but then a live member and a returning member
   see different histories, which seems worse. Worth an explicit ruling.
3. **`retainTopic` widens `HubMux`.** It is the honest primitive for "I want to pull this topic", but
   it makes it easier to subscribe without meaning to hold forever. The doc says so; a reviewer should
   still look.
4. **`deliverAppFrames` swallows a failed segment pull** and leaves the buffer unloaded to retry. Right
   for the walk — the drain must not break the commit lane — but a permanently failing app-topic fetch
   is then silent. The commit lane has the same posture (`peer.ts:1031`), so I matched it rather than
   inventing a signal.
5. **I lost `peer.ts` mid-probe** to a `git checkout` of an uncommitted file while reverting mutation
   (a), and rewrote it from context. The restored file typechecks, lints, and passes, and mutation (a)
   was re-run against the restored file to confirm it still goes red. Worth knowing the file was
   retyped rather than edited incrementally — review the diff, not the history.
