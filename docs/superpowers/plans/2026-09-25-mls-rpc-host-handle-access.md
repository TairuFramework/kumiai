# MLS RPC Host Handle Access Plan

**Stage:** executing
**Mode:** learning-loop
**Spec:** docs/superpowers/specs/2026-09-25-mls-rpc-host-handle-access-design.md

## Premise check

- The spec cites `packages/mls-rpc/test/commit-topic-proposal.test.ts`, but that file is absent after the rebase. The bug is still supported by `mls-rpc/src/mls.ts` passing unfiltered bytes to `GroupHandle.processMessage`, which accepts Proposals. A separate PR owns its regression test. Question 3.1 tests `applyCommit`'s own refusal.
- The spec allows `epoch()` at `peer.ts:1448,1487` as an unknown-version classifier input. Those calls feed `classifyCommit` and can change `ahead`, strand, and cursor behavior. Question 1.2 uses a locked epoch there, following the spec's rule that hints never decide dispositions.
- Kubun's `#stateSequence` and `#persistedSequence` are process-local maps (`group-handle-registry.ts:136-137,443-444,519-530`), not a durable state-row revision. Question 4.1 requires a persisted per-group revision and conditional write; the current sequence cannot serve as its guard.
- `GroupHandle.ledger` contains `LedgerLogEntry`, not bare `VerifiedLedgerEntry` (`group-handle.ts:270,397-401`). Question 3.1 maps the appended suffix through `.verified` and excludes `kumiai.*` entries.
- `.changeset/durable-app-delivery.md` already lists all twelve packages, including `@kumiai/mls-rpc` and `@kumiai/rpc-conformance`, as minor. The spec's instruction to add another minor changeset for those two conflicts with its no-second-minor rule. Question 6.2 updates the pending 0.10 changeset text instead.

## Phase 1: Locked epoch results in `@kumiai/rpc`

Order: runs after Question 2.1 (see Decision Log, Question 1.1).

Exit criteria: Both ports and their doubles report the epoch used under the handle lock. No disposition, cursor move, anchor, seal, replay, or repair decision uses `crypto.epoch()`. Run `pnpm exec vitest run --root tests/integration` and `rtk proxy pnpm run test:types` from the repo root.

### Question 1.1: Can the port return the epoch that each operation used?
- **Assumption:** Epoch-bearing results can preserve the port's caller ergonomics while leaving `epoch()` synchronous and hint-only.
- **Done when:** Write usage tests first. Define typed epoch results for commit apply, secret export, seal, and app open/refusal; align real ports, conformance shapes, and doubles. A double with an epoch hint one behind or one ahead returns the same locked result and disposition. The double refuses everything the real port may refuse.
- **Spec excerpt:** “Every decision takes its epoch from a port result computed under the handle lock (`access.read` or `access.mutate`). The port result carries the epoch it acted at, and `@kumiai/rpc` decides from that value:”
- **Verify:** `rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2 && pnpm exec vitest run packages/rpc/test/ports-conformance.test.ts packages/mls-rpc/test/ports-conformance.test.ts && rtk proxy pnpm run lint`

### Question 1.2: Can commit classification and repair ignore a lying hint?
- **Assumption:** A commit applied after classification can reclassify from the locked `epochBefore`, then advance the cursor only for the actual disposition.
- **Done when:** Test lagging and ahead hints for applicable, past, future, own, fork, and unknown-version frames. Move `peer.ts:1348,1363,1376,1448,1487,1532,1604,1681,1689,2382,2395` to locked results; check the cursor, anchor barrier, and repair outcome. A mismatch returned by apply triggers reclassification without skipping an applicable commit.
- **Spec excerpt:** “`applyCommit` compares the frame epoch under the lock and returns `epochBefore` and `epochAfter`; a mismatch returns a disposition, not an advance, so the peer reclassifies instead of moving its cursor past an applicable commit;”
- **Verify:** `rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2 && pnpm exec vitest run packages/rpc/test/peer-commit-lane.test.ts packages/rpc/test/peer-unknown-commit-frame-version.test.ts packages/rpc/test/peer-recover-lane.test.ts && rtk proxy pnpm run lint`

### Question 1.3: Can app delivery, anchors, and sealing decide from locked epochs?
- **Assumption:** Synchronous push and failure callbacks can defer or carry the locked answer without treating a stale hint as proof that a frame is past.
- **Done when:** Test `app-lane.ts:589,617,620`, `peer.ts:618,648,777,1809,1858,2118`, and constructor seeds `peer.ts:544,572`. Future frames remain buffered/unacked; only a locked past answer marks done. `retainOnFailure` uses the open's locked outcome, even if its callback shape must become async. Anchor secret and epoch come from one export; sealing and journal epochs match the sealed state; the first locked result corrects startup seeds.
- **Spec excerpt:** “`unwrap` checks the frame epoch against the locked handle and reports past or future distinctly; the lane marks a frame `done` only on a locked "past" answer and retains on "future";”
- **Verify:** `rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2 && pnpm exec vitest run packages/rpc/test/peer-app-drain.test.ts packages/rpc/test/peer-inbox-single-open.test.ts packages/rpc/test/peer-commit-replay.test.ts packages/rpc/test/peer-anchor-advance.test.ts && rtk proxy pnpm run lint`

## Phase 2: Handle access and standalone helpers

Exit criteria: One `HandleAccess` instance drives both factories. All handle reads, mutations, replacements, and simple durable opens obey the spec. Run `pnpm exec vitest run --root tests/integration` and `rtk proxy pnpm run test:types` from the repo root.

### Question 2.1: Does one adapter preserve handle lifetime and save ordering?
- **Assumption:** `simpleHandleAccess` can preserve received-commit rollback, ratchet persistence, and persist-before-publish replacement without saving the same state twice.
- **Done when:** Write a usage test before the API. Export `HandleAccess`, `SimpleHandleAccessParams`, and `simpleHandleAccess`; require `access` in both factories. Test shared access, scalar publication after successful save, rollback, `read` callback lifetime, `mutate` save behavior, `replace` ordering, and simple `open` pass-through. Test authored and recovery handle replacement. Keep the ledger slot installed at every handle construction path.
- **Spec excerpt:** “`replace` persists before publishing the new handle. A transactional adapter works on a fresh restored handle; it discards that handle on rollback and publishes only on commit.”
- **Verify:** `rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2 && pnpm exec vitest run packages/mls-rpc/test/persist-boundary.test.ts packages/mls-rpc/test/crypto.test.ts && rtk proxy pnpm run lint`

### Question 2.2: Can reusable byte and recovery helpers replace factory copies?
- **Assumption:** Standalone helpers can preserve the existing wire format and lifetime rules without retaining a handle.
- **Done when:** Test and export `deriveEntryKey`, `sealEntries`, `openEntries`, `createRecoveryPending`, and `deriveRecoverySecret`. Verify v1/24-byte XChaCha sealing, error text, key wiping, 120,000 ms TTL, replacement/deletion zeroing, and timer unref. Route all spec-listed MLS reads through `access.read`, bootstrap through `mutate`, recovery adoption through `replace`, and ratchet operations through `mutate`/`open`. Keep `frameEpoch` and `frameAAD` byte-only.
- **Spec excerpt:** “Export these from `@kumiai/mls-rpc` and use them in its factories; none should read or retain a global handle:”
- **Verify:** `rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2 && pnpm exec vitest run packages/mls-rpc/test/crypto.test.ts packages/mls-rpc/test/ports-conformance.test.ts && rtk proxy pnpm run lint`

## Phase 3: Commit core and shell

Exit criteria: The host can call `applyCommit` inside its own transaction; `processCommit` preserves the RPC port contract. No wrong-epoch or non-Commit frame opens a blob. Run `pnpm exec vitest run --root tests/integration` and `rtk proxy pnpm run test:types` from the repo root.

### Question 3.1: Can `applyCommit` give a complete transactional result?
- **Assumption:** The handle's ordered ledger suffix and before/after snapshots provide all host projections without an `onLedgerEntries` callback.
- **Done when:** Test the exported signature with a real handle. Refuse non-Commit bytes, wrong epochs, and own authenticated commits before resolver or mutation. Return rosters, old ledger length, committer DID, `advanced`, and non-`kumiai.*` verified suffix with repeats. Test rejected, removed-self, accepted, failed-persist, and post-persist callback cases. `MissingLedgerEntriesError` and store faults propagate; malformed/unauthentic or rejected commits return no advance unless durable advance occurred. The separate Proposal-on-commit-topic PR remains separate.
- **Spec excerpt:** “A non-Commit returns `advanced: false` without passing bytes to `processMessage`. A mismatched epoch or own authenticated commit also returns false. No resolver or state mutation runs on those paths.”
- **Verify:** `rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2 && pnpm exec vitest run packages/mls-rpc/test/apply-commit.test.ts packages/mls-rpc/test/persist-boundary.test.ts && rtk proxy pnpm run lint`

### Question 3.2: Can the shell resolve entries before taking access?
- **Assumption:** Requested envelope IDs can be obtained or explicitly supplied before `mutate`, while the handle still verifies tokens by digest and signature inside apply.
- **Done when:** Test a resolver implemented with `access.read`: no re-entry or deadlock. Precheck epoch and Commit kind without opening the blob, pre-resolve requested IDs outside `mutate`, then recheck under the lock. Test an empty ID list, absent/bad bodies, a concurrent epoch move, and poison versus retry mapping. `processCommit` delegates to `applyCommit` and returns the epoch-bearing RPC result. If neither exported parsing nor a pre-resolution hook can supply IDs, mark this question BLOCKED and update the spec before code proceeds.
- **Spec excerpt:** “The shell must prepare the frame's sealed entries outside `mutate` and pass a non-locking, in-memory resolver inside it, after checking the frame epoch and Commit type.”
- **Verify:** `rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2 && pnpm exec vitest run packages/mls-rpc/test/apply-commit.test.ts packages/rpc/test/peer-ledger-bodies.test.ts && rtk proxy pnpm run lint`

## Phase 4: Atomic durable open

Exit criteria: Isolated staging, one conditional state-plus-record write, conflict retry, and duplicate safety are proved against the transactional test adapter. Run `pnpm exec vitest run --root tests/integration` and `rtk proxy pnpm run test:types` from the repo root.

### Question 4.1: Can an open commit without a database wait under the live handle lock?
- **Assumption:** An isolated restored handle can stage a real MLS decrypt, then publish only after the pending record and state commit together.
- **Done when:** Write transactional-adapter usage tests. `access.open` captures the staged state and record, conditionally writes both with a persisted per-group monotonic revision, and retries from a fresh handle on revision conflict. It orders earlier saves, rejects same-epoch stale writes, discards on rollback, and publishes only on commit. Document the remaining real-Kubun-registry proof required before host adoption.
- **Spec excerpt:** “The state row needs a monotonically increasing revision within an epoch, not only an epoch guard: later app opens at the same epoch consume additional ratchet generations. Reject an older revision even when its epoch matches.”
- **Verify:** `rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2 && pnpm exec vitest run packages/mls-rpc/test/transactional-access.test.ts packages/mls-rpc/test/durable-save-order.test.ts && rtk proxy pnpm run lint`

### Question 4.2: Does retry preserve the key and storage-error boundary?
- **Assumption:** A failed or duplicate atomic save can be retried without consuming the app key twice or exposing tentative state.
- **Done when:** Test storage failure, conflict retry, duplicate frame ID, wrong AAD, and unopenable MLS bytes. The duplicate reuses its pending record or returns a retryable storage fault. Only atomic-save failure becomes `AppFrameStorageError`; MLS/AAD errors remain original. `pending.list` and `complete` run outside access, and restored delivery sees exactly one pending record.
- **Spec excerpt:** “A duplicate frame ID must reuse its pending record or return a retryable storage fault without consuming the key twice.”
- **Verify:** `rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2 && pnpm exec vitest run packages/mls-rpc/test/transactional-access.test.ts packages/mls-rpc/test/ports-conformance.test.ts packages/rpc/test/durable-restart.test.ts && rtk proxy pnpm run lint`

## Phase 5: Recovery secret choice

Exit criteria: Existing groups keep their rendezvous secret; hosts can explicitly select and restore their own choice. Run `pnpm exec vitest run --root tests/integration` and `rtk proxy pnpm run test:types` from the repo root.

### Question 5.1: Can a host override recovery without changing the default?
- **Assumption:** The anchor KDF can remain the default while a per-group host callback supplies Kubun's validated seed.
- **Done when:** Test the default against existing bytes and test an override that validates the seed, survives restore, and is used for both commit and rendezvous topics. Reject an absent/invalid seed; never probe two topics silently. Add the override to `GroupMLSParams` and route the read through `access.read`.
- **Spec excerpt:** “Recommendation: keep the anchor KDF as the default for groups already using `mls-rpc`, with an explicit `recoverySecret?: (handle: GroupHandle) => Promise<Uint8Array>` host override for Kubun.”
- **Verify:** `rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2 && pnpm exec vitest run packages/mls-rpc/test/ports-conformance.test.ts packages/rpc/test/peer-recovery-lifecycle.test.ts && rtk proxy pnpm run lint`

## Phase 6: Contracts, migration, and release

Exit criteria: Both RPC suites pass for simple access, transactional access, and doubles; hub conformance passes for real implementations and doubles. The README and pending 0.10 changeset describe the migration. Run `rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2 && pnpm exec vitest run --root tests/integration && rtk proxy pnpm run test:types && rtk proxy pnpm run lint` from the repo root.

### Question 6.1: Do the real adapters and doubles satisfy the same contracts?
- **Assumption:** The port changes expose divergent fake answers through the existing structural conformance checks.
- **Done when:** Run both `rpc-conformance` suites, including optional durable-pending clauses, against real MLS with simple and transactional access and against RPC doubles. Add lying-hint clauses in both directions. Run `hub-conformance` against hub-server, hub-tunnel, and RPC hub doubles. Capture exact command output in the decision log.
- **Spec excerpt:** “Run both `rpc-conformance` suites against `mls-rpc` using `simpleHandleAccess`. Add a transactional test adapter that restores a fresh handle for every mutation, writes a staged state and pending record atomically, discards the working handle on failure, and swaps or invalidates cache only on commit.”
- **Verify:** `rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2 && pnpm exec vitest run packages/mls-rpc/test/ports-conformance.test.ts packages/rpc/test/ports-conformance.test.ts packages/rpc/test/hub-conformance.test.ts packages/hub-server/test/log-hub-conformance.test.ts packages/hub-tunnel/test/hub-conformance.test.ts && rtk proxy pnpm run lint`

### Question 6.2: Is the host migration and 0.10 release path explicit?
- **Assumption:** One adapter line and factory parameter substitutions explain migration without changing the release band.
- **Done when:** The README shows one shared `simpleHandleAccess` instance, custom host `epoch` and durable `open` obligations, and the recovery override. Update the pending minor 0.10 changeset text for `@kumiai/mls-rpc` and `@kumiai/rpc-conformance` without another minor entry. Cross-check all twelve package notes and the separate Proposal-fix PR boundary.
- **Spec excerpt:** “Pass this **same** `access` to both factories in place of their old handle/adopt/persist properties. This is one adapter-construction line, plus the parameter substitutions at the two call sites.”
- **Verify:** `rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2 && pnpm exec vitest run packages/mls-rpc/test/ports-conformance.test.ts && rtk proxy pnpm run lint`

## Review Focus

| Host failure | Tested by |
| --- | --- |
| Scalar epoch ahead after rollback marks a future app frame done | Question 1.3 |
| Resolver re-enters access and deadlocks | Question 3.2 |
| Same-epoch stale save overwrites a staged open | Question 4.1 |
| Replacement is published before persistence | Question 2.1 |
| Duplicate frame ID consumes a key twice | Question 4.2 |

## Decision Log

### 2026-09-25 -- Question 1.1: Can the port return the epoch that each operation used?
**Findings:** BLOCKED. The result shapes read well at the caller (`{ advanced, epochBefore, epochAfter }`, `{ secret, epoch }`, `{ sealed, epoch }`, `unwrap` gains `epoch`, `FrameEpochError`). The real ports cannot supply a locked epoch: they receive `handle: () => GroupHandle`, and `decrypt` / `decryptStaged` / `processMessage` take the handle mutex internally without returning the epoch used. Wrapping them in `mutexFor(handle).run` double-acquires a non-reentrant mutex; reading `handle().epoch` around the call races. A refused commit never reaches a persist callback. `exportSecret` is lock-free on purpose (in-commit resolver).
**Spec impact:** order changed: `HandleAccess` (Question 2.1) comes first; its lock serialises every handle operation, so epochs read inside `access.read` / `access.mutate` are coherent. The strict frame-epoch refusal belongs in that locked operation, because real `decrypt` still opens a bounded past window.
**Learned:** locked epoch results depend on the access boundary, not on the port types. No production code changed.
