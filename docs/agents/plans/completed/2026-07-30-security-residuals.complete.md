# Security residuals: implementation record

**Status:** complete. Executed 2026-07-30 on `chore/security-residuals`.

The substantive closures — the replay answer with its mechanism, the Kubun check, and where the
conformance obligation landed — are recorded in `completed/2026-07-29-security-residuals.complete.md`,
which was written as part of this work and is the file to read for *what is now true*. This file
records how it was built, the design decisions behind the shape it took, and the one correction the
final review forced.

## Goal

Close the two actionable items in the security residuals: answer whether a replayed genuine external
commit can still steer anything once the group has moved on, and make running `@kumiai/rpc-conformance`
an obligation stated where a host writes its own port. A third item — the commit-lane `ahead` storm —
was not closable in this repo and was carried to `backlog/2026-07-29-commit-lane-ahead-storm.md`.

## What was built

- **`@kumiai/hub-conformance`** gained the clause `a re-published payload under a fresh publishID
  never lands below the original`, in both the `HubStore` and `LogHub` suites.
- **`packages/rpc/test/peer-commit-log-replay.test.ts`** characterises the rpc lane's handling of a
  replay: `fork`/`winning` for a peer holding an `appliedByEpoch` record, `history` for one without,
  neither reaching `processCommit`, and the app-lane anchor unmoved.
- **`packages/rpc/src/crypto.ts`** states the conformance obligation on both `GroupCrypto` and
  `GroupMLS`, and states that `exportSecret`'s failure mode is silent. `@kumiai/rpc`'s and
  `@kumiai/rpc-conformance`'s READMEs point at each other.
- A changeset for `@kumiai/hub-conformance` (minor — a clause every implementation must now pass).

No production code changed. The branch is tests, port documentation, and records.

## Design decisions worth keeping

**The clause is a floor, not a strict increase.** `expect(replayed >= original)`. A store that
content-deduplicated and handed back the original sequenceID is equally safe for the reader the clause
protects, and a contract suite should not forbid a correct implementation because it is not the one we
happen to have. The failure being excluded is a replay landing *below* an applied frame.

**The clause lives at the hub layer, not the rpc layer.** The rpc conclusion rests on log ordering,
which the hub owns. Pinning it in `hub-conformance` means Kubun's sqlite and postgres stores inherit
the check rather than each store owner rediscovering why it matters.

**The obligation went on the port types, not into a new doc page.** Both READMEs already named the
suite as mandatory; the real gap was that neither port *type* did, and a host writing its own
`GroupCrypto` reads `crypto.ts`. A third location would be a third thing to keep current.

**The replay tests are a new file, not an addition to `peer-external-forgery.test.ts`.** That file's
subject is what a signature check does and does not assert. A replay is explicitly not a forgery —
same bytes, same key, same context — and filing it there would blur the distinction the file exists
to make.

**No third rpc test.** Both fork branches were already pinned at `commit-classify.test.ts:48`. What
was missing was not a case but the link from the replay path to that existing coverage.

## The correction the final review forced

The record initially claimed the conclusion "rests on one property" — that a replay never lands below
the original. It rests on **two**. `walkCommits` processes the hub's messages in whatever order the
hub returns them and never checks a frame's position against `reconciledHead`, and `appliedByEpoch` is
keyed by sequenceID alone. So a hub that respects the floor but serves the replay *before* the
original — or withholds the original and reveals it after the cursor has passed — makes the peer apply
the replay, then read the original as `fork`/`losing`, heal, rejoin, and rotate the anchor. The
app-lane topic moves after all.

That was recorded rather than fixed, deliberately: a hub of that shape is the `ahead`-storm capability
already carried in `backlog/2026-07-29-commit-lane-ahead-storm.md`, where the trigger is cheaper (one
garbage byte) and the effect worse, and a hub re-serving below a reader's cursor is not fixable
peer-side. A real fix was considered and **not** filed — keying `appliedByEpoch` on a digest of the
applied commit bytes as well as its position, settling `history` when the digest matches, which would
implement the fork row's actual definition and make a replay harmless regardless of hub ordering. It
is written down here so a future reader finds the option already weighed, not so it is owed.

The same review corrected a false claim in the port docs: `exportSecret` is not the *only* member
whose failure mode is silent — `sealEntries`/`openEntries` rest on the same per-epoch removal
boundary, so a hand-rolled entry seal keyed off anything else lets a removed member open the
ledger-entry blobs of commits enacted after its removal. Both files now say so.

## Verification

Executed as four subagent-driven tasks, each reviewed, plus a whole-branch review whose three
Important findings were fixed and re-reviewed. Every new test was mutation-checked: the hub clause
fails against an inverted sequence counter; the replay tests fail when the fork comparison is flipped;
and the assertions added by the final review fix (`seen()`, which counts `processCommit` calls, and a
direct `classifyCommit` verdict) fail when a replay is routed into the apply path — a mutation the
original assertions could not catch, since `commits()` counts applies and stays silent.

Both contract suites were run against the real implementations and the doubles, all four combinations
confirmed individually. Full `turbo run test:types test:unit --force`: 42/42, cache off.

**One deferred follow-up:** the test helpers duplicated across four peer test files, carried to
`backlog/2026-07-30-peer-test-helper-extraction.md`.
