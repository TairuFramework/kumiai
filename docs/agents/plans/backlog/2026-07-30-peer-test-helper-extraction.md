# Extract the duplicated peer-test helpers into `test/fixtures/`

**Priority:** low — test hygiene, no behaviour at stake. Raised 2026-07-30 by the whole-branch review
of the security-residuals work (see `completed/2026-07-30-security-residuals.complete.md`).

Four files in `packages/rpc/test/` now carry their own copies of the same lane-driving helpers:

- `peer-commit-log-replay.test.ts`
- `peer-external-forgery.test.ts`
- `peer-recover-lane.test.ts`
- `peer-cursor-table.test.ts`

The duplicated set is `flush` (a fixed-delay settle), `wakeLane` (publishes a mailbox frame on the
commit topic to say "read your log again" without writing to the log), `recoveryRequests` / `heals`
(counts recovery requests actually put on the wire, by decoding rendezvous-topic frames), and
`waitFor` (polls a predicate instead of sleeping).

**Why it is worth doing beyond tidiness.** The copies have drifted, and the drift cost real coverage.
The newest file settled 80 ms after `wakeLane` where the older ones use 200–400 ms, and it did not
carry `peer-cursor-table.test.ts`'s convention of asserting `mls.seen()` — the counter for
`processCommit` invocations — so its "the port was never asked" claim was pinned by nothing until the
review caught it. A shared fixture is how those conventions travel to the next file that needs them.

**Shape.** A `test/fixtures/lane.ts` alongside the existing `peer.ts` / `commits.ts` / `fake-hub.ts`,
exporting the four helpers. Prefer `waitFor` over `flush` at call sites where a positive outcome is
being awaited — it fails loudly instead of falsely — and keep a settle only where the assertion is an
*absence*, which is the one case a poll cannot express.
