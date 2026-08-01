---
'@kumiai/hub-conformance': minor
'@kumiai/rpc': minor
---

A replayed commit is no longer a fork.

**Security.** The commit lane's `fork` row proxied "a different commit" with "a different
sequenceID", and that proxy only held while a reader was served the log in sequenceID order — which
nothing enforced. A hub re-publishing a genuine commit frame verbatim and serving the copy first made
every peer apply the replay, record it as the commit for that epoch, then read the original as the
losing side of a fork: a heal, a rejoin, an external commit, and an app-lane anchor rotation for
every member, once per replay, for bytes already delivered.

`appliedByEpoch` now records a digest of the applied commit's bytes, and `classifyCommit` answers
`history` when the incoming frame's digest matches. Genuinely different commits at one epoch still
fork and still heal, lower sequenceID winning. The change is monotonically heal-reducing: exactly
three verdicts move, each toward fewer heals, so no path can now produce a heal the old code did not,
in any order the hub serves the log.

Not a general defence against a hub that reorders or withholds — it removes the replay route. Both
conformance suites gain the complementary floor, `a re-published payload under a fresh publishID
never lands below the original`; a store failing it is not conformant. Stated as a floor rather than
strictly greater so a content-deduplicating store stays legal. The second premise — that a reader is
served the log in sequenceID order — remains unpinned and is recorded in
`docs/agents/plans/backlog/2026-07-29-commit-lane-ahead-storm.md`.

**Breaking**, for direct callers of the classifier: `classifyCommit` takes a single
`ClassifyCommitParams` object — `{ header, sequenceID, commitDigest, state }`.
`CommitClassifierState.appliedByEpoch` is `ReadonlyMap<number, AppliedCommit>`. `AppliedCommit`,
`ClassifyCommitParams` and `digestAppliedCommit` are exported. Two of the three moved verdicts are
visible only to a direct caller asserting on the verdict itself.
