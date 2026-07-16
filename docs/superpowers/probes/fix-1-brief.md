# Probe brief — every site that advances the handle must uphold the lane's invariant, not just one

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted for review.

**Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.** That has
destroyed work on this branch twice. To revert a mutation, invert the edit by hand.

## The invariant, stated once

**A handle must not ratchet past an epoch without (a) draining that epoch's retained app frames and
(b) capturing the anchor if the roster changed.** Both are one-way doors: after the advance, that
epoch's frames are ciphertext forever and its secret can never be re-exported.

It is currently enforced at **one** of the sites that advance the handle. There are four.

| site | advances via | anchor capture | drain before |
| --- | --- | --- | --- |
| `walkCommits` (applying others' commits) | `port.processCommit` | ✅ roster diff + capture | ✅ |
| `commit()` (a roster change this peer AUTHORS) | `pending.onAccepted()` ~`:1708` | ❌ **none** | ❌ **none** |
| `replayJournal` (restart) | `adoptJournalled` ~`:1440`, `:1497` | ❌ none | ❌ **none** |
| `recover()` (rejoin) | adopt ~`:1497` | ✅ explicit | ❌ none |

`recover()`'s own comment states the principle — *"a member does not process its own commit, so the
apply site never runs"* — and `commit()` has the identical problem while doing nothing about it.

## The three defects this closes

### F1 — CRITICAL, and CONFIRMED by a failing test I already ran

`commit()` never rotates the anchor for a roster change it authors. Reproduced: two peers, alice
authors `buildRemoveCommit(alice, 'carol')`, bob applies it from the log. Bob rotates to anchor 2;
alice stays at **1**. `expected 1 to be 2`.

The member who performed the roster change silently partitions from the group it just changed —
bidirectional, permanent, no error. A restart does not heal it (`classify.ts` files the own commit as
`history`). For an **Add**, the new member's handle cannot derive the author's topic even in
principle. For a **Remove**, the evicting admin keeps publishing to the topic the removed member still
holds — a forward-secrecy break, metadata not plaintext (they cannot open the seal), but real.

**This is the exact bug class the branch exists to kill, reintroduced by the branch.**

### F2 — HIGH

`replayJournal` ratchets via `adoptJournalled` with no drain in front. A peer booting with a journalled
commit after a week offline marks its whole backlog at that epoch dead and persists the cursor past it.

### F6 — MEDIUM

`captureAnchor()` moves `anchor` inside `walkCommits` (~`:1274`) under the commit mutex;
`rebuildEpoch()` runs only after the whole walk returns (~`:1315`). `dispatch` takes no mutex (only
`await ready`) and publishes to `runtime.topicID`, captured at the *previous* `buildEpoch`. In that
window a logged dispatch publishes **to the segment just left, sealed under the NEW epoch** — readable
by nobody: members on the new topic are not listening on the old one, members on the old topic cannot
open the new seal, and the publisher's own drain never pulls the old topic again.

**Not the accepted laggard.** A laggard's seal epoch and topic segment are *consistent* (its handle has
not applied the rotation), so another laggard can read it. Here they are inconsistent by construction
and nobody can, ever.

## Approved approach (follow it; BLOCKED if it fights the code — do not redesign)

1. **One guarded path, not three patches.** Give the lane a single seam that every handle-advancing
   site goes through — drain the current epoch, let the caller advance, diff the roster, capture the
   anchor if it moved. Then route `walkCommits`, `commit()`'s accepted path, `replayJournal`, and
   `recover()` through it. Patching three call sites leaves a fourth to be added later with the same
   hole; the point of the fix is that the hole stops being *writable*.
   - Use the **roster diff** (`detectRosterChange` around the advance), not the commit's `kind`. It is
     what `walkCommits` already trusts, it answers for add/remove/both-in-one, and a `kind` is the
     host's word about its own commit.
   - `recover()` already captures explicitly; fold it in rather than leaving a fourth spelling.
2. **F6: derive the publish topic from the live anchor at dispatch time**, not from the `runtime`
   captured at `buildEpoch`. A frame must land on the segment that CONTAINS its seal epoch, and only
   the live anchor knows that. (The runtime's `topicID` is still what the receive transport binds to;
   this is about the logged-event publish.) If a cleaner seam exists — rebuilding under the mutex,
   making the rotation atomic w.r.t. dispatch — take it and say why.

## Done when (all required)

1. **The author rotates.** A peer that `commit()`s a roster change lands on the same anchor as a peer
   that applies it, for **both** an add and a remove, asserted on `anchorEpoch()` **and** on the wire
   (they exchange logged events on one topic afterwards). This is F1's regression test and it must fail
   against today's code.
2. **Replay drains and rotates.** A peer restarted with a journalled roster-change commit drains its
   backlog at that epoch and lands on the right anchor.
3. **No dispatch lands on an abandoned topic.** A logged dispatch racing a rotation is published to the
   segment containing its seal epoch, and a member reads it.
4. **Mutation checks (required, paste each):** remove the capture from the authored-commit path → (1)
   goes red; remove the drain from the replay path → (2) goes red. Invert by hand; confirm green.
5. Whole suite green (rpc 214 + your additions, mls 307, 30/30). **Do not weaken an existing test to
   make one of these pass** — if an existing test conflicts, that is a finding: report it.

## Why no test caught F1 — fix this too

Every rotation test fabricates its commit from an off-stage `senderDID: 'admin'` non-peer, so **every
peer under test is an applier and never an author**. The only two tests that drive a roster change
through `commit()` are the only two files with no `anchorEpoch()` assertion. The gap is in the shape of
the fixtures, not in anyone's attention. Your new tests must drive the roster change through a real
peer's `commit()` — `buildRemoveCommit`/`buildInviteCommit` (`test/fixtures/peer.ts:208`, `:234`).

## Known and accepted — do NOT close, do NOT report

The `processCommit`→`save` crash window; the laggard publisher; a fresh joiner's empty ts-mls window;
the drain being at-least-once against the live path; `hub-mux` swallowing subscribe failures (filed).

## Scope boundary

The advance-site invariant + the dispatch topic ONLY. **Out of scope, being fixed separately** — do not
touch them, do not work around them: the swallowed `loadAppSegment` failure, the unbounded future-epoch
claim pinning the cursor, and the one-pull-per-segment latch. Do not touch `detectRosterChange`, the
external signal, `retentionOf`, `frameEpoch`, the store shapes, or the fake's strictness.

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`. Code/comments/tests never name plan questions, findings, or phases —
state the invariant ("a handle does not ratchet past an epoch until that epoch's frames are read and
its anchor is taken").

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`
(`pnpm run lint` alone → eslint via the `rtk` shim; use `rtk proxy pnpm run lint`.)

## Report contract

Full report → `docs/superpowers/probes/fix-1-report.md` (changes with file:line, both mutations pasted,
what the single seam looks like and which sites route through it, whether any existing test conflicted,
surprises, concerns). Return ONLY: status, uncommitted-changes note, one-line test summary, concerns. No
full diff.
