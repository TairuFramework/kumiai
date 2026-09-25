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
- **Done when:** The README shows one shared `simpleHandleAccess` instance, custom host `epoch` and durable `open` obligations, and the recovery override. Update the pending minor 0.10 changeset text for `@kumiai/mls-rpc` and `@kumiai/rpc-conformance` without another minor entry. State that without `pending` the simple adapter saves ordinary ratchet state, so a crash between `unwrap` and handler completion loses that frame. Cross-check all twelve package notes and the separate Proposal-fix PR boundary.
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

### 2026-09-25 -- Question 2.1: Does one adapter preserve handle lifetime and save ordering?
**Findings:** BLOCKED on the first run. One access mutex over `read` / `mutate` / `replace` / `open` and the shared-access call shape both work. A commit with ledger entries deadlocks: `processCommit` holds `access.mutate`, `processMessage` calls the ledger resolver, the resolver calls `GroupCrypto.openEntries`, which can only reach the exporter key through `access.read`. The brief's "keep in-commit derivation lock-free" was self-contradictory once factories lose `handle()`.
**Spec impact:** order changed: Question 3.2's pre-resolution merges into 2.1. Entry IDs come from `decodeControlEnvelope(commit.authenticatedData)` (`group-handle.ts:995`), readable before processing, so the shell resolves outside the lock and installs an in-memory resolver inside `mutate` (decision 4).
**Learned:** removing `handle()` from the factories and pre-resolving entries are one change, not two.

### 2026-09-25 -- Question 2.1 (second run): shared `HandleAccess` with commit pre-resolution
**Findings:** DONE. `simpleHandleAccess` serialises `read` / `mutate` / `replace` / `open` on one queue; `epoch()` reads a published number. Both factories require `access`. `readCommitEntryIDs` (`@kumiai/mls`) reads private-Commit envelope IDs as an untrusted fetch hint. `processCommit` checks kind and epoch under `read`, resolves outside the lock, installs an in-memory resolver inside `mutate`; an epoch move throws a retryable error before apply. A refused Commit does not save.
**Spec impact:** accepted: without `pending`, the simple adapter now saves the post-`wrap` / post-`unwrap` ratchet. A crash after `unwrap` before the handler completes loses that frame; `pending` is the at-least-once path. The 0.10 changeset and README migration must say so (Question 6.2). A failed post-operation save cannot undo the in-memory ratchet in the simple adapter; the host restores from storage.
**Learned:** fixtures that advance a handle directly leave the published epoch behind; everything goes through `access`. Integration runs read built `lib/` output, so rebuild before a direct integration run.

### 2026-09-25 -- Question 2.2: Can reusable byte and recovery helpers replace factory copies?
**Findings:** DONE. `deriveEntryKey`, `sealEntries`, `openEntries`, `createRecoveryPending`, `deriveRecoverySecret` exported and used by the factories. Fixed vector pins `[1 | nonce | ciphertext]`; old and new seal/open interoperate; error text unchanged. Factory wipes keys in `finally`. Recovery pending: 120,000 ms TTL, per-request unref timer plus access-time sweep, zeroing on expiry/replace/delete. Accepting recovery deletes only the key it opened with.
**Spec impact:** none.
**Learned:** only `sealEntries` / `openEntries` / `exportRecoverySecret` needed rerouting; 2.1 already routed the rest. Phase 2 exit criteria met.

### 2026-09-25 -- Question 1.1 (second run): port results carry the epoch they acted at
**Findings:** DONE. `exportSecret` -> `{ secret, epoch }`, `sealEntries` -> `{ sealed, epoch }`, `processCommit` -> `{ advanced, epochBefore, epochAfter }`, `unwrap` result gains `epoch`, and a frame at another epoch throws `FrameEpochError { frameEpoch, handleEpoch }` under the lock before any decrypt (ordinary and durable open). Doubles match. Both suites force the `epoch()` hint one behind and one ahead; results unchanged. `@kumiai/rpc-conformance` fixtures now need `setEpochHintOffset`. Peer callers changed mechanically only.
**Spec impact:** none. Strict past refusal checked for regressions: `GroupHandle.decrypt` resolves the sender with the CURRENT epoch's sender-data secret, so on main a past-window frame already decrypted, burned its key, then failed `unwrap: opened frame has no authenticated sender`. Strict refusal gives the same outcome without burning the key. An RPC call or reply in flight across a commit is lost today and still is; fixing that means past-epoch sender resolution, a separate feature.
**Learned:** ts-mls's past-epoch window is not usable through `GroupHandle.decrypt`; no caller ever relied on it successfully.

### 2026-09-25 -- Question 1.2: Can commit classification and repair ignore a lying hint?
**Findings:** DONE. `GroupMLS` gains `readEpoch(): Promise<number>` (locked `access.read`; doubles return the model epoch; conformance checks it ignores a lagging or leading hint). Every commit-path decision moved off `crypto.epoch()`: classifier and fork evidence (both frame versions), advance baseline and barrier, ratchet check (`processCommit.epochBefore` / `epochAfter`), changed-roster anchor epoch, pull-failure rebuild, rejoin adoption. An apply that refuses at a different `epochBefore` reclassifies the same frame and requests a runtime rebuild before moving the cursor. Tests compare honest, lagging and leading hints for applicable, past, future, own, fork and both unknown-version cases, plus a handle move between classification and apply. Mutation: restoring `crypto.epoch()` in the classifier fails the applicable, own and fork cases.
**Spec impact:** `GroupMLS.readEpoch()` added. `processCommit` as a read was rejected: unknown-version frames carry no commit bytes, and a probe apply would change the double's process count.
**Learned:** an apply refusal can follow an intervening handle move, so "refused" still needs a runtime rebuild. The constructor can seed an anchor from a lying hint; that is Question 1.3.

### 2026-09-25 -- Question 1.3: Can app delivery, anchors, and sealing decide from locked epochs?
**Findings:** DONE (done directly, not by a probe). The open-once path calls `note` after the open settles, passing the throw; `retainOnFailure(message, error)` takes it too. `isFrameAhead(error)` (a `FrameEpochError` with `frameEpoch > handleEpoch`) decides retain in both, and the drain now calls `unwrap` for every readable frame and reads past/future from its refusal (unreadable bytes stay dead without an open). `captureAnchor` pairs secret and epoch from one `exportSecret` result and no longer takes an epoch argument. `frameCommit` returns the sealed epoch and checks it against the commit's framed epoch (`frameEpoch(commit)`; skipped for the external rejoin commit, framed at the group's epoch). The journal records the sealed epoch; replay checks `GroupMLS.readEpoch()`. The peer's `epoch` variable is gone; the anchor's startup value is a placeholder that `ready` overwrites. Mutations: drain, note, anchor, journal, replay each fail `peer-locked-app-epoch.test.ts`.
**Spec impact:** none. A past frame now takes the handle lock for its refusal instead of being skipped on the hint; the simple adapter does not save on a throw.
**Learned:** the peer-level retain test could not reach `retainOnFailure`: a direct hub publish on the fixture's app topic never reaches the open-once path, so retain is pinned at the open-once level (past acked, future retained) and a mutation of the peer's one-line wiring is not caught. Phase 1 exit criteria met: the only `crypto.epoch()` left in `@kumiai/rpc` is that placeholder.

### 2026-09-25 -- Question 3.1: Can `applyCommit` give a complete transactional result?
**Findings:** DONE (directly). `applyCommit(handle, commit, { ...CommitContext, entrySlot, ownDID }, persist?)` exported from `@kumiai/mls-rpc`. Result: `advanced`, `epochBefore`, `epochAfter`, `rosterBefore`, `rosterAfter`, `surfacedEntries` (ledger suffix `.verified`, `kumiai.*` excluded, repeats kept), `ledgerLengthBefore`, `committerDID`. Non-Commit, wrong-epoch and own authenticated commits are refused before resolver, persist or mutation. `MissingLedgerEntriesError` and persist failures propagate; a throw after the handle advanced reports the advance. `processCommit` delegates inside `access.mutate` and still throws a sentinel on refusal so the simple adapter does not save. Tests with real handles: accepted (repeated app entries), Add, refused set, own, removed-self, failed persist, missing bodies, post-persist callback. Mutations of the own, `kumiai.*` and epoch gates each fail a test.
**Spec impact:** result gains `epochBefore` / `epochAfter` (needed by `processCommit`'s RPC result). A commit that removes this member does not advance, and `rosterAfter` reports the tree it left rather than the before snapshot.
**Learned:** only an admin can author the own-commit case; the committer's un-adopted `commitLedgerEntries` output is the natural fixture. Rebased on main to take #51 first; its test migrated to `HandleAccess` (`06b4396`).

### 2026-09-25 -- Question 3.2: Can the shell resolve entries before taking access?
**Findings:** DONE, mostly inside Question 2.1's second run. Already tested there: resolver through `access.read` (no deadlock), empty ID list skips the resolver, concurrent epoch move rejects with a retryable error, wrong-epoch and non-Commit frames never open bodies, resolver fault and missing bodies keep their errors. Added: a body whose digest matches no requested ID is absent (`MissingLedgerEntriesError`, poison) and the handle stays put. `processCommit` delegates to `applyCommit` (Question 3.1).
**Spec impact:** none.
**Learned:** Phase 3 exit criteria met.

### 2026-09-25 -- Questions 4.1 and 4.2: atomic durable open under a transactional adapter
**Findings:** DONE (directly, one cycle for both). Library change: `createGroupCrypto` wraps the store fault as `AppFrameStorageError` in the `persistOpened` it hands `access.open`, not inside `decryptStaged`'s callback, so an adapter may stage in `fn` and write afterwards. Test fixture `transactional-access.ts`: a store row `{ state, ledger, revision }` with serialised writes conditional on the revision read, a pending table written in the same write (duplicate ID keeps its first record), and an adapter whose `mutate` / `replace` restore a fresh handle and publish after the write, and whose `open` holds the lock only to read the row and to publish, retrying from a fresh handle on `RevisionConflictError`. Tests (real MLS): read during a pending write sees the old handle and does not block; conflict retries and consumes the key once; failed write keeps key, row and live handle and a retry opens; stale same-epoch save rejected; delayed earlier save ordered first; rolled-back mutation publishes nothing; duplicate frame ID; wrong AAD and unopenable bytes keep their own errors and write nothing; `pending.list` / `complete` do not wait on the lock. Mutation: moving the wrap back inside the callback fails 3 tests.
**Spec impact:** none to the port. New defect fixed in `@kumiai/mls` (patch changeset): `decodeClientState` returned secrets aliasing its input, and a ratchet zeroes consumed secrets in place, so retrying from kept bytes failed with `aes-gcm: invalid tag`.
**Learned:** the fixture's open revision is shared host state, so opens serialise among themselves; a real host passes the revision through its own transaction context. Still owed before Kubun adoption: the same proof against the real `GroupHandleRegistry` and SQLite state row, which needs a persisted per-group revision (Kubun's `#stateSequence` is process-local) and a conditional upsert.

### 2026-09-25 -- Question 5.1: Can a host override recovery without changing the default?
**Findings:** DONE (directly). `GroupMLSParams.recoverySecret?: (handle) => Promise<Uint8Array>`, called under `access.read`; the default stays `deriveRecoverySecret`. Tests: default equals the anchor KDF; the override's secret is returned and both topics derive from it; after `access.replace` the override reads the published handle; an empty, short or non-byte result and a throwing override all reject, never falling back to the default.
**Spec impact:** a minimum of 16 bytes is enforced on the override's result (the default derives 32).
**Learned:** no peer change needed: `@kumiai/rpc` derives both topics from `exportRecoverySecret`. Kubun's override is `readGroupAnchor(handle)` plus its existing seed validation.
