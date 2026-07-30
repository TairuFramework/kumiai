# Key the fork check on the applied commit, not only its position

**Status:** complete
**Date:** 2026-07-30
**Branch:** `fix/applied-commit-digest`
**Scope:** `@kumiai/rpc` only — no port change, so neither conformance suite and no double moved.
**Origin:** filed as a follow-up by the security-residuals work; see
`completed/2026-07-30-security-residuals.complete.md`, which records the analysis this came out of.

## The problem

The commit lane's `fork` row means "two different commits at one epoch" — something a hub can only
produce by serving different logs to different members — and it triggers a heal: recovery, rejoin via
an external commit, and an app-lane anchor rotation for every member of the group. It did not check
that. `appliedByEpoch` mapped each epoch to the *sequenceID* the peer enacted there, and
`classifyCommit` settled the row by comparing positions, so "a different commit" was proxied by "a
different sequenceID" — and the same commit, re-published verbatim, lands at a new sequenceID and
satisfies the proxy.

That proxy holds only while the reader is served the log in sequenceID order, and nothing enforces
that: `walkCommits` iterates the hub's messages as they arrive and never compares a frame's position
against `reconciledHead`. So a hub that re-published a genuine commit frame and served the copy first
— or withheld the original until the cursor had passed — made the peer apply the replay, record it as
the commit for that epoch, then read the original as the LOSING side of a fork. One group-wide heal
and topic rotation per replay, for bytes the group had already delivered once.

The hub-conformance clause *a re-published payload under a fresh publishID never lands below the
original* bounds where a replay's sequenceID can land. It says nothing about the order a reader is
served, which was the second premise.

## What was built

`appliedByEpoch` now holds `{ sequenceID, digest }`, where the digest is sha256 (base64url) over the
applied commit's bytes. `classifyCommit` takes the incoming frame's digest and answers `history` when
it matches, falling through to the position-based winner/loser tiebreak only when the commits
genuinely differ. Five write sites supply it: the apply site in `walkCommits`, both journal-replay
paths, `commit()`'s acceptance, and the rejoin landing.

## Key design decisions

**The digest covers the commit bytes alone, never the frame.** The sealed entry blob riding a commit
frame is derived and re-sealing it is legal, so a frame-wide digest would make a legitimate re-seal
look like a different commit and fork the group on it. `encodeCommitFrame` copies the commit in
verbatim and `decodeCommitFrame` returns that exact subarray, so the bytes an author digests and the
bytes a reader digests are identical.

**Digest-equal folds into `history`; it did not get its own row.** The cursor treatment is identical —
step over, no heal, blob never touched — and the `poison` row's doc already sets that precedent
("THREE classifications land here — one row, because the cursor treatment is identical"). A row is a
cursor treatment, not a taxonomy.

**One record per epoch, not two parallel maps.** A position recorded without its digest re-opens the
replay, and a type that cannot express one without the other cannot drift.

**No ordering check was added to `walkCommits`.** Rejecting frames at or below `reconciledHead` looks
cheap and is worse on its own terms: it would silently drop a *genuine* fork frame served out of
order — the exact case the row exists for — trading a false heal for a missed one.

**`appliedByEpoch` stays in memory, deliberately.** A restarted peer holds no record, reads `history`,
and can MISS a fork but never invent one. Unchanged by this work.

**A null digest answers `history` unconditionally.** The original design kept a position comparison as
a totality fallback; review found that this contradicted the rule stated eleven lines above it —
`applied == null` returns `history` because the peer "can MISS a fork but can never invent one, the
safe direction" — while judging an undigested frame more harshly on the same kind of missing evidence.
`history` keeps the function equally total and is consistent. Unreachable through the lane (the only
null-digest calls pass `UNKNOWN_FRAME_VERSION`, settled at `ahead` first), but reachable by direct
callers, since `classifyCommit` is exported.

## The property this buys

**The change is monotonically heal-reducing.** Exactly three verdicts move:

1. digest equal at a different position: `fork` → `history`
2. digest different at an equal position: `history` → `fork`/`winning`
3. no digest at a different position: `fork` → `history` (direct callers only, never the lane)

Two remove a heal, and the third lands on `winning`, which sets neither `healRequested` nor
`stranded` — inside the lane it is `reconciledHead = position; continue`, identical to `history`. So
**no path can produce a heal the old code did not, in any order the hub serves the log.** This is the
security argument for the change and holds for orders no test exercises. It is also stated in the
changeset, so it reaches the changelog.

## What this does NOT close

An untrusted hub that reorders or withholds keeps other ways to force heals, and a cheaper one is
filed: `backlog/2026-07-29-commit-lane-ahead-storm.md`, where a single garbage byte produces an
`ahead` frame and the bound belongs to whoever gates publish authorization on the commit topic. This
work removes the replay route and fixes a classification that did not do what it said. **It is not a
defence against a hub of that shape and must not be recorded as one.** If both are scheduled, the
storm is the one that decides how much the reorder path is worth closing.

## Verification

Five tests in `packages/rpc/test/peer-commit-log-replay.test.ts` and eight below-epoch cases in
`packages/rpc/test/commit-classify.test.ts`. Full `@kumiai/rpc` suite 386/386 with `tsc -p
tsconfig.test.json` clean and `rtk proxy pnpm run lint` clean, re-run directly rather than through
turbo.

The load-bearing tests were written red first and mutation-checked — each guard was broken and the
covering test confirmed to fail before the source was restored:

- **The out-of-order replay test failed before the change**, on the recovery-request assertion, with
  both premises (`replayed > original`, and the peer having actually applied the replay) verified
  first, so the red was for the stated reason rather than a broken fixture.
- **A genuine fork still forks and still heals** in the same hidden-then-revealed service order —
  without it, the whole change is satisfied by deleting the fork row.
- **The commit-only digest is pinned against a re-sealed frame:** two frames with identical commits
  and different sealed blobs. This one is worth remembering. The first draft of the test did not
  catch the frame-wide mutant at all — it applied the frames in sequenceID order, which routes the
  mutant into the unobservable `fork`/`winning` branch. It had to be restructured to serve the
  lower-sequenceID frame *after* the higher one is applied so the mutant reaches `fork`/`losing` and
  produces a visible heal. A test guarding an invariant along the wrong axis looks exactly like one
  that works.

The test that expects a heal polls for the recovery request; the tests asserting an *absence* keep a
bounded wait, which is the correct shape for each.

## Residue knowingly accepted

Two test-only nits were triaged and left, on the grounds that neither is worth a backlog entry:
`commit-classify.test.ts`'s `'the SAME commit at an epoch this peer enacted is not a fork'` now
matches on both digest and position so no longer discriminates which check answered (two newer tests
bracket the case from both sides, so it is redundant rather than wrong), and `publishedCommitDigest`
in `test/fixtures/commits.ts` does not check the handshake kind, so a non-commit frame throws
confusingly rather than clearly — it throws rather than returning a wrong digest, so it cannot make a
test pass that should fail.

## Notes

The plan's task checkboxes were never ticked by the implementing agents; completion rests on the
commit history, the per-task reviews, and the verification above rather than on the boxes.
