# Key the fork check on the applied commit, not only its position

Closes `docs/agents/plans/next/2026-07-30-applied-commit-digest.md`. Scoped entirely to
`@kumiai/rpc`; no port and no conformance suite moves.

## The defect

`appliedByEpoch` (`packages/rpc/src/peer.ts:740`) maps each epoch this peer passed to the
*sequenceID* it enacted there, and `classifyCommit` (`packages/rpc/src/classify.ts:195`) settles
the `fork` row by comparing positions. The row's own doc says it is "two different commits at one
epoch". It does not check that: "a different commit" is proxied by "a different sequenceID", and
the same commit re-published verbatim lands at a new sequenceID and satisfies the proxy.

The proxy holds only while the reader is served the log in sequenceID order, and nothing enforces
that. `walkCommits` iterates `result.messages` in whatever order they arrive; `reconciledHead` is
assigned unconditionally in every branch and never compared against the frame's position, and
`asLogPosition` (`packages/rpc/src/cursor.ts:33`) is a bare cast.

Traced against the code, with a peer at epoch 1, a genuine external commit `C` at `p1`, and a
byte-for-byte replay of `C` at `p2 > p1` that the hub serves first:

1. Frame `p2`: `header.epoch === state.epoch` and the committer is not local, so `apply`. The peer
   processes `C`, reaches epoch 2, and sets `appliedByEpoch[1] = p2`.
2. Frame `p1`: `header.epoch < state.epoch`, `applied = p2`, `p1 !== p2`, so `fork` — and
   `p1 < p2`, so `branch: 'losing'`.
3. `peer.ts:1203` sets `healRequested` and `stranded`. Heal, rejoin, an external commit in the log,
   and every peer rotates the app-lane anchor.

One group-wide heal and topic rotation per replay, for bytes the group already delivered once.

The hub-conformance clause *a re-published payload under a fresh publishID never lands below the
original* bounds where a replay's sequenceID can land. It says nothing about the order a reader is
served, which is the second premise this closes.

## The fix

Record what was applied, not just where. `appliedByEpoch` keys on the epoch as today and stores the
position **and** a digest of the applied commit's bytes. When a frame's epoch matches a record:

- digest equal → `history`. The same commit, wherever it now sits in the log. Advance, no heal.
- digest different → `fork`, settled on sequenceID order exactly as today.

The row then matches its stated definition, and a capture-and-replay is inert in any service order.
Genuinely different commits at one epoch still fork and still heal.

### Representation

`classify.ts` gains:

```ts
export type AppliedCommit = { sequenceID: string; digest: string }
export function digestAppliedCommit(commit: Uint8Array): string // toB64U(sha256(commit))
```

`CommitClassifierState.appliedByEpoch` becomes `ReadonlyMap<number, AppliedCommit>`, and the
`header.epoch < state.epoch` branch becomes:

```ts
const applied = state.appliedByEpoch.get(header.epoch)
if (applied == null) return { row: 'history' }
if (commitDigest != null && commitDigest === applied.digest) return { row: 'history' }
if (commitDigest == null && sequenceID === applied.sequenceID) return { row: 'history' }
return {
  row: 'fork',
  appliedSequenceID: applied.sequenceID,
  branch: sequenceID < applied.sequenceID ? 'losing' : 'winning',
}
```

One record per epoch, not a second parallel map: nothing can then record a position without a
digest, because the type will not allow it. Two maps written together at five sites would be an
invariant with no type behind it.

`digestAppliedCommit` lives in `classify.ts` because the digest exists only for this comparison, and
colocating the producer with the comparator stops the two definitions drifting. Not in
`commit-frame.ts`, whose module header states that reading a frame imports no crypto.

The digest is over the **commit bytes alone**, never the whole frame. `encodeCommitFrame` copies
`commit` in verbatim (`commit-frame.ts:55`) and `decodeCommitFrame` returns
`frame.subarray(HEADER_BYTES, blobStart)` (`commit-frame.ts:110`), so `pending.commit`,
`entry.commit` and `commitFrame.commit` all digest identically. The sealed entry blob riding the
frame is derived and re-sealing is legal, so a frame-wide digest would make a legitimate re-seal
look like a different commit.

`sha256` from `@noble/hashes/sha2.js` and `toB64U` from `@sozai/codec`, matching `topic.ts:87`. Both
are already direct dependencies of `@kumiai/rpc`.

### Signature

`classifyCommit(header, sequenceID, commitDigest, state)`. `commitDigest` is `string | null` and
required, not optional: the two `UNKNOWN_FRAME_VERSION` call sites (`peer.ts:1120`, `peer.ts:1149`)
have no commit bytes and must say so explicitly rather than by omission. Those calls settle at
`ahead` on the classifier's first line, so `null` never reaches the branch above — the `sequenceID`
fallback is there to keep the function total, and its doc says so.

Winner and loser still settle on sequenceID order. That is unaffected by service order: it compares
the two IDs' values, not which arrived first.

### Write sites

Five, each writing `{ sequenceID, digest }` instead of a bare position. The commit bytes are to hand
at all five — verified in source, not assumed:

| Site | Position | Commit bytes |
|---|---|---|
| `peer.ts:1263` — the apply, the only write from the log | `position` | `commitFrame.commit` |
| `peer.ts:1431` — journal replay, `acceptedAs` present | `entry.acceptedAs` | `entry.commit` |
| `peer.ts:1488` — journal replay, accepted on republish | `sequenceID` | `entry.commit` |
| `peer.ts:1690` — `commit()` accepted | `sequenceID` | `pending.commit` |
| `peer.ts:1871` — rejoin landed | `sequenceID` | `pending.commit` |

The `next/` item counted six by including `peer.ts:740`, which is the declaration. `grep -n
appliedByEpoch packages/rpc/src/peer.ts` gives exactly these five writes, the declaration, and the
three reads that pass it into `classifyCommit` (`1121`, `1150`, `1174`).

In `walkCommits` the digest is computed once per readable frame, after `decodeCommitFrame` succeeds
and beside the existing `readCommitHeader` call on the same bytes, then passed to `classifyCommit`
and reused at the apply site.

## What this does not change

- **`appliedByEpoch` stays in memory, deliberately.** A restarted peer holds no record, reads
  `history`, and can MISS a fork but never invent one. Untouched.
- **Genuine forks still fork and still heal**, in any service order.
- **Digest-equal folds into `history`, it does not get its own row.** The cursor treatment is
  identical — step over, no heal, blob never touched — and the `poison` row's doc sets the
  precedent explicitly: "THREE classifications land here — one row, because the cursor treatment is
  identical." A row is a cursor treatment, not a taxonomy. `history`'s doc grows a second case.
- **`walkCommits` gains no ordering check.** Rejecting frames at or below `reconciledHead` looks
  cheap and is worse on its own terms: it would silently drop a *genuine* fork frame served out of
  order — the exact case the row exists for — trading a false heal for a missed one.
- **No port change.** `GroupMLS` and `CommitHeader` are untouched, so neither conformance suite nor
  any double moves. Putting the digest on `CommitHeader` was considered and rejected for exactly
  that reason: it is a value the port has no business computing.

## What this does not close

An untrusted hub that reorders or withholds keeps other ways to force heals, and a cheaper one is
already filed: `backlog/2026-07-29-commit-lane-ahead-storm.md`, where a single garbage byte produces
an `ahead` frame and the bound belongs to whoever gates publish authorization on the commit topic.
This work removes the replay route and fixes a classification that does not do what it says. It is
not a defence against a hub of that shape and must not be recorded as one. If both are scheduled,
the storm is the one that decides how much the reorder path is worth closing.

## Verification

`packages/rpc/test/peer-commit-log-replay.test.ts` already pins the in-order case with direct
`classifyCommit` verdict assertions and an `mls.seen()` pin proving the port is never handed the
commit again. `FakeHub.revealTo` models the out-of-order case precisely — its own doc describes the
attack: "Hand a reader a frame its cursor has ALREADY PASSED… a hub that has already broken the
compare-and-set to fork the log has no reason to keep this one."

**The new test. It must fail before the change and pass after.**

1. Alice at epoch 1. Bob's genuine external commit lands at `original`.
2. `hub.hideFrom('alice', original)` before she reads it.
3. Replay the frame byte-for-byte, landing at `replayed > original`. Alice applies the replay,
   reaches epoch 2, and records epoch 1.
4. `hub.revealTo('alice', original)`, then wake the lane.
5. Assert no recovery request, the anchor unmoved, `mls.seen()` unmoved, the epoch still 2 — and the
   verdict directly, `{ row: 'history' }`.

Today step 4 yields `fork`/`losing`, so both `healRequested` and `stranded` are set. If the test
passes before the change, the premise above is wrong and the finding is re-derived rather than the
test adjusted.

**The row's own case, kept honest.** A companion test with two genuinely *different* commits at
epoch 1, served in the same hidden-then-revealed order: still `fork`, still heals. Without it the
new test is satisfied by deleting the fork row.

**Mutation check on both.** Each new test ends by breaking the guard it claims to hold — force the
digest comparison to always match and confirm the fork test fails; force it to never match and
confirm the replay test fails; restore.

**Existing tests that move.** Three files construct `appliedByEpoch` and take the new record shape:
`commit-classify.test.ts:14`, `peer-commit-log-replay.test.ts:124`, `peer-recover-lane.test.ts:347`.
One is a behaviour change rather than a mechanical edit — `peer-commit-log-replay.test.ts:120-126`
asserts the in-order replay reads `fork`/`winning`, and after the fix it reads `history`. Every
observable assertion in that test still holds; the verdict and its narration change, and the comment
explaining why the verdict is asserted directly stays true.

A changeset is required: `classifyCommit` and `CommitClassifierState` are both exported from
`index.ts` and both change shape. No consumer outside `packages/rpc` exists in kumiai or kubun.
