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

The change is monotonically heal-reducing. Exactly three verdicts move, and every one moves toward
fewer heals:

1. A digest-equal frame at a different sequenceID: used to read `fork`, now reads `history`. The
   fix this changeset is for.
2. A digest-different frame at an EQUAL sequenceID: used to read `history` unconditionally (the
   old code short-circuited on the sequenceID match before ever comparing bytes), now reads
   `fork`/`winning` — always `winning`, since an equal sequenceID can never be strictly lower than
   itself.
3. A frame with no digest to compare (`commitDigest === null`) at a different sequenceID: used to
   fall back to the position comparison and read `fork` (branch decided the same way as any other
   position mismatch — so this direction alone could produce a `losing` heal), now always reads
   `history`. Reachable only by a direct caller of the exported `classifyCommit`, never through the
   lane, since both call sites that pass a null digest settle at `ahead` first.

`winning` sets neither `healRequested` nor `stranded`, and the other two moves remove a heal
outright, so no path through the classifier can now produce a heal the old code did not, in any
order the hub serves the log.

Breaking, for anyone calling the classifier directly: `classifyCommit` now takes a single
`ClassifyCommitParams` object — `{ header, sequenceID, commitDigest, state }` — rather than
positional arguments. `commitDigest` is `digestAppliedCommit(commit)`, or `null` where the bytes
were never extracted. `CommitClassifierState.appliedByEpoch` is now
`ReadonlyMap<number, AppliedCommit>`. `AppliedCommit`, `ClassifyCommitParams` and
`digestAppliedCommit` are all exported.
Verdicts 2 and 3 above change what a direct caller sees for the same inputs: verdict 2 produces no
heal operationally (`winning` sets neither `healRequested` nor `stranded`) but a caller asserting
on the verdict itself would see the change; verdict 3 is unreachable through the lane today and
only affects a direct caller of the exported `classifyCommit`.
