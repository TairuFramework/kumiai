---
'@kumiai/hub-conformance': minor
---

Both suites gain the clause `a re-published payload under a fresh publishID never lands below the
original`. A store that fails it is not conformant, so this is a clause existing implementations must
now satisfy — `@kumiai/hub-server`'s memory store already does, and any sqlite or postgres store
assigning sequenceIDs from a monotonic counter does too.

It exists because a security property one layer up rests on it. `@kumiai/rpc`'s commit lane resolves
two commits at one epoch by sequenceID order: the lower one stands, the higher one is stepped over.
That is what makes a capture-and-replay harmless — an observer who re-publishes a genuine commit
frame verbatim gets it *appended* above the frame peers already applied, so it reads as the winning
side of a fork nobody heals. Idempotency cannot help here: it keys on `publishID`, and the replayer
picks that. The log's ordering is the whole defence, and nothing pinned it.

Stated as a floor (`replayed >= original`) rather than strictly greater, so a store that
deduplicates on content and hands back the original sequenceID stays legal — that is equally safe for
the reader the clause protects. A replay landing *below* an applied frame is the failure: every peer
that applied the original would read it as the losing branch and rejoin, one group-wide heal per
replay, for bytes already delivered once.

This clause alone is not a complete defence. It bounds *where* a replay's sequenceID can land, not
the order a reader is served the log in — a hub that respects the floor but serves a later frame
before an earlier one, or withholds one and reveals it after a reader's cursor has passed it, can
still make a reader apply the replay first and read the original as the losing side of a fork. That
second premise — the reader is served the log in sequenceID order — is unpinned by this clause and is
recorded separately in `docs/agents/plans/backlog/2026-07-29-commit-lane-ahead-storm.md`.
