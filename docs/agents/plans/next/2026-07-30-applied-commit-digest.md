# Key the fork check on the applied commit, not only its position

**Priority:** medium. Raised 2026-07-30 by the whole-branch review of the security-residuals work
(see `completed/2026-07-30-security-residuals.complete.md`, which records the analysis this item
comes out of). Closable inside `@kumiai/rpc` — which is why it is here rather than in
`backlog/2026-07-29-commit-lane-ahead-storm.md`, its neighbour in the same territory.

## The gap

The `fork` row's own doc says it is "two different commits at one epoch". It does not check that.
`appliedByEpoch` maps epoch to the *sequenceID* the peer applied there (`packages/rpc/src/peer.ts:740`),
and `classifyCommit` settles the row by comparing positions (`packages/rpc/src/classify.ts:195`,
`state.appliedByEpoch.get(header.epoch)`). So "a different commit" is proxied by "a different
sequenceID", and the two are not the same thing: the **same** commit, re-published verbatim, lands at a
new sequenceID and satisfies the proxy.

That proxy holds only while the reader is served the log in sequenceID order, and nothing enforces
that. `walkCommits` iterates the hub's messages in whatever order they arrive and never checks a
frame's position against `reconciledHead` — the variable is assigned unconditionally in every branch,
and `asLogPosition` (`packages/rpc/src/cursor.ts:33`) is a bare cast. So a hub that replays a genuine
commit frame **and** serves the copy before the original — or withholds the original and reveals it
after the cursor has passed — makes the peer apply the replay, record it as the applied commit for that
epoch, then read the original as `fork`/`losing`: heal, rejoin, external commit in the log, and every
peer rotates the app-lane anchor. One group-wide heal and topic rotation per replay, for bytes the
group already delivered once.

The hub-conformance clause `a re-published payload under a fresh publishID never lands below the
original` bounds *where* a replay's sequenceID can land. It says nothing about the order a reader is
served, which is the second premise the closure record now names.

## The fix

Record what was applied, not just where: key `appliedByEpoch` on the epoch as today, storing the
position **and** a digest of the applied commit's bytes. In `classifyCommit`, when a frame's epoch
matches a record:

- digest equal → `history`. The same commit, wherever it now sits in the log. Advance, no heal.
- digest different → `fork`, settled on sequenceID order exactly as today.

That makes the row match its stated definition, and makes a capture-and-replay inert regardless of the
order the hub serves. Genuinely different commits at one epoch still fork and still heal — the case the
row exists for is untouched.

## Scope, honestly

Not a one-line change. `appliedByEpoch` is written from six places, each of which must now have the
applied commit's bytes to hand:

- `peer.ts:1263` — the apply site, the only write from the log. The bytes are the frame's.
- `peer.ts:1431` and `peer.ts:1488` — the journalled-adopt paths, recording `entry.acceptedAs`. The
  commit is the peer's own, in the journal entry.
- `peer.ts:1690` and `peer.ts:1871` — a commit this peer made and adopted, and the rejoin landing. Own
  commit bytes, available at both.

The digest wants to be over the commit bytes alone, not the whole frame: the sealed entry blob riding
the frame is derived, and re-sealing is legal, so a frame-wide digest would make a legitimate re-seal
look like a different commit.

`appliedByEpoch` stays in-memory and deliberately so — a restarted peer holding no record reads
`history` and can MISS a fork but never invent one. This change does not alter that.

## What it does not close

An untrusted hub that reorders or withholds keeps other ways to force heals, and a cheaper one is
already filed: see `backlog/2026-07-29-commit-lane-ahead-storm.md`, where a single garbage byte
produces an `ahead` frame and the bound belongs to whoever gates publish authorization on the commit
topic. This item removes the replay route and fixes a classification that does not do what it says;
it is not a defence against a hub of that shape, and should not be recorded as one. If both are
scheduled, the storm is the one that decides how much the reorder path is worth closing.

## Verification

`packages/rpc/test/peer-commit-log-replay.test.ts` already pins the in-order case (`fork`/`winning`
with the anchor unmoved, and `history` for a peer holding no record) with direct `classifyCommit`
verdict assertions and a `mls.seen()` pin proving the port is never handed the commit again. Add the
out-of-order case: publish, replay, and serve the copies newest-first — `FakeHub`'s `hideFrom` /
`revealTo` model exactly this — then assert no recovery request and an unmoved anchor. That test must
fail before the change and pass after; if it passes before, the premise above is wrong and the finding
should be re-derived rather than the test adjusted.
