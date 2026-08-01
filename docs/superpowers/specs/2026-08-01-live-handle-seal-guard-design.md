# The stale-handle reseal gap does not exist, and what to build instead

`docs/agents/plans/next/2026-07-31-mls-rpc-author-path-stale-handle-reseal.md` asks for a test
proving a restarted member that authors a commit seals at the live epoch rather than a captured,
pre-`adopt` handle. Its central premise — "no test in the repo can currently catch it" — is false.
Three mutations modelling exactly that defect were applied during design; every one of them was
caught by tests that exist today.

This spec closes the entry on that evidence, converts the one guard that is real but *incidental*
into a deliberate one, and adds the coverage the entry was reaching for that genuinely does not
exist: nothing walks restart-then-author against real MLS.

No source changes. Tests and records only.

---

## 1. What the probes showed

Each mutation was applied to source, the suite run, then reverted. The tree was verified clean and
`packages/mls-rpc/lib/` rebuilt from unmutated source afterwards.

| Mutation | Suite | Result |
| --- | --- | --- |
| `crypto.ts` `wrap` snapshots `handle()` at construction | `packages/mls-rpc` | 2 failed / 48 |
| same mutation, built to `lib/` | `tests/integration` | 2 failed / 35 |
| `peer.ts` `buildEpoch` never refreshes the cached `epoch` (`:566`) | `packages/rpc` | 35 failed / 391 |
| `peer.ts` `captureAnchor` reuses the previous anchor (`:464`) | `packages/rpc` | 49 failed / 391 |

The two `mls-rpc` failures are `crypto.test.ts`'s "unwrap refuses every epoch but the handle current
one" (`:201`) and the `frameEpoch` test (`:303`, failing at `:317`). The two integration failures
are in `app-lane-delivery.test.ts`.

The entry's other premises all hold, and are restated here only because they were checked:
`GroupCryptoParams.handle` is a function whose doc comment names the bug shape (`crypto.ts:45-50`);
`processCommit` applies received commits in place with no `adopt` (`mls.ts:146-171`);
`adopt`/`adoptJournalled` reassign a closed-over binding and mint genuine new objects
(`app-lane-e2e.ts:169,201`); `app-lane-delivery.test.ts:604`'s restart is receive-only.

Two further facts settle the rest of the entry:

- **`epoch` and `exportSecret` following `adopt` are already pinned explicitly**, with a comment
  naming the defect: `crypto.test.ts:85-92` — "A crypto closing over the handle it was built with
  would still be exporting the line above."
- **Restart-then-author is already covered at the unit layer.**
  `packages/rpc/test/peer-first-commit-crash.test.ts:168` has a restarted peer author a fresh
  commit and advance to epoch 3; `peer-anchor-restart.test.ts:148` has a restarted peer dispatch on
  the wire. Both run against the doubles, which pass the conformance suites.

There is no hiding place for the defect the entry names.

## 2. The one real residual: the `wrap` guard is incidental

`wrap`'s staleness is caught only as a side effect of two tests named for other properties —
unwrap's epoch refusal, and `frameEpoch` reading cleartext. Nothing in the repo states "`wrap`
follows the live handle across `adopt`". An edit to either test that preserved its stated intent
could drop the guard without anyone noticing.

### The test

One test in `packages/mls-rpc/test/crypto.test.ts`. A three-member group: Alice commits an invite
adding Carol (epoch 2), adopts, then `wrap`s a message. **Carol opens it. Bob, left at epoch 1,
cannot.**

Carol rather than a Bob who applied the same commit, deliberately. `unwrap` opens a bounded window
*below* the live epoch out of ts-mls's retained key material — the port's own documented divergence
from the fake (`crypto.ts:65-68`). A Bob who walked to epoch 2 might therefore still open an
epoch-1 frame, and the mutation would slip through the assertion. Carol joined at epoch 2 and holds
no key material below it, so her refusal of a stale frame is structural rather than a property of
how much ts-mls happens to retain.

`twoMemberGroup` (`crypto.test.ts:23-56`) keeps `tokens`, `publish` and `resolveLedgerEntries`
local and returns none of them, so adding a third member needs them exposed. Extend the existing
fixture rather than writing a parallel one.

**Mutation gate.** Make `wrap` snapshot `handle()`'s return at construction. The new test must
fail. Restore before moving on.

## 3. The coverage that is genuinely absent: restart-then-author against real MLS

Every restart-then-author test runs against the doubles. Nothing exercises it through
`createGroupCrypto` and a live `GroupHandle`.

### The test

One test in `tests/integration/test/app-lane-delivery.test.ts`, beside the existing restart test.
**Alice is the member that restarts, not Bob**: only an admin may author a ledger or remove commit
(`mls-permissions.test.ts:215-222`, "commitWithEntries requires the committer be an admin"), and Bob
holds `member`. Alice is the founding admin.

Shape: Alice persists and dies (`peer.dispose()` then `disconnect()`, as at
`app-lane-delivery.test.ts:577-587`) → restore via `restoreMemberHandle` → rebuild with
`restartOf` → the restored Alice authors `buildLedgerCommit` → she dispatches a chat frame → Bob
receives it, and the group is at the new epoch.

**This test is expected to bite on no mutation.** The `wrap` snapshot already fails two other tests
in this same file, and both peer-cache mutations fail 35 and 49 `rpc` tests respectively. Its value
is that it composes the real port, the real peer and a real restart on the author path, which
nothing does today.

That expectation is not a licence to skip the check. Attempt at least the `wrap` snapshot against
it and **record what happened** — including "the mutation was caught by pre-existing tests in this
file, so this test's failure is not evidence of anything it uniquely guards." The entry being closed
here exists precisely because an earlier task discarded a test after finding it could not fail; the
rule that came out of that is to record, not discard.

## 4. The record

- Delete `docs/agents/plans/next/2026-07-31-mls-rpc-author-path-stale-handle-reseal.md`.
- The completed record for this branch carries section 1's table and its conclusion, so the next
  reader who wonders about stale handles finds the probe rather than re-running it.

## Non-goals

- No change to `crypto.ts`, `mls.ts`, `peer.ts`, or any other source file.
- No removal or rewrite of the two incidental guards. They stay; section 2 adds beside them.
- The `adoptJournalled` route the entry offers as an alternative is not tested separately. It
  reassigns the same binding through the same `adopt`, so it reaches the identical property, and
  section 3 already covers a restarted author.

## Verification

- `packages/mls-rpc`: full unit run, plus the section 2 mutation gate.
- `tests/integration`: full run, plus the section 3 mutation attempt and its recorded result.
- Whole-repo `test:types` and lint before the branch is offered for review.
