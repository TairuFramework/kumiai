---
'@kumiai/rpc': minor
---

The commit lane's `fork` row now checks what its doc claims — two different *commits* at one epoch,
not two different sequenceIDs. `appliedByEpoch` records a digest of the applied commit's bytes
beside its log position, and `classifyCommit` takes the incoming frame's digest and answers
`history` when it matches.

Previously "a different commit" was proxied by "a different sequenceID", and the proxy only held
while a reader was served the log in sequenceID order — which nothing enforces. A hub that
re-published a genuine commit frame verbatim and served the copy first (or withheld the original
until the cursor had passed) made the peer apply the replay, record it as the commit for that epoch,
then read the original as the LOSING side of a fork: a heal, a rejoin, an external commit in the
log, and an app-lane anchor rotation for every member — once per replay, for bytes the group had
already delivered once.

Genuinely different commits at one epoch still fork and still heal, and the winner is still the
lower sequenceID. `appliedByEpoch` remains in memory, so a restarted peer holding no record still
reads history as history: it can miss a fork, never invent one.

This is not a defence against a hub that reorders or withholds in general — it removes the replay
route and fixes a classification that did not do what it said.

The change is monotonically heal-reducing. Exactly two verdicts move, and both move toward fewer
heals: a digest-equal frame at a different position, which used to read `fork`, now reads
`history`; a digest-different frame at an EQUAL sequenceID, which used to read `history`
unconditionally (the old code short-circuited on the sequenceID match before ever comparing
bytes), now reads `fork`/`winning` — always `winning`, since an equal sequenceID can never be
strictly lower than itself, and `winning` sets neither `healRequested` nor `stranded`. No path
through the classifier can now produce a heal the old code did not, in any order the hub serves
the log.

Breaking, for anyone calling the classifier directly: `classifyCommit` takes the frame's commit
digest as a third argument (`digestAppliedCommit(commit)`, or `null` where the bytes were never
extracted), and `CommitClassifierState.appliedByEpoch` is now
`ReadonlyMap<number, AppliedCommit>`. Both `AppliedCommit` and `digestAppliedCommit` are exported.
Two verdicts change for the same inputs, as described above: a frame at the SAME sequenceID as
the record but a DIFFERENT digest now reads `fork`/`winning` instead of `history` — no heal
results, but a direct caller asserting on verdicts would see it — and a frame with no digest to
compare (`null`) now always reads `history` instead of falling back to the position comparison;
that path is unreachable through the lane today and only affects a direct caller of the exported
`classifyCommit`.
