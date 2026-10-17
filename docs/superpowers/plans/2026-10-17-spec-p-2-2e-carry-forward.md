# Plan 2.2e carry-forward (rulings, deferred minors, obligations)

Plan 2.2e (fork detection, recovery escape hatches, hub migration) complete at `7694f7c5` (range `474365ba..7694f7c5`, branch `feat/spec-p-phase-2`, not pushed). Final Opus review: 0C/5I/5M, fixed in `ea8c4cad..b0f18ab6`; re-review found M4 not addressed plus new N1, both fixed in `624e9230` and `7694f7c5`. Ephemeral: delete with the other phase-2 plans.

## Obligations for later sub-plans

1. Order: 2.2e -> 2.3 -> phase-2 remainder (hub-client lifts, mls-rpc encryptor, contract suites on real MLS, real HTTP smoke).
2. Merge held until phase 2 complete (user decision). Do not merge or push after 2.2e alone.
3. 2.3: full registry crypto/application adapters (the Task 18 fixture refuses app opens). 2.3 scope also covers crypto, batching, leases, package burn/restore (`task-20-report.md` concern 3).
4. Host-supplied app cursor stores must clear themselves after a current move. Kumiai clears only its own `groups.ports(key).cursor`, via `IncarnationStores.cursor.clear()` in the move transaction (documented in both READMEs).
5. Evidence claimed is phase-2 memory reconstruction. Phase-3 providers and child-process SIGKILL evidence stay excluded.
6. 2.3: legacy exits. Docs name only successor retirement as the explicit exit for an unadopted legacy rejoin record. Verify whether manual resync also clears it (Task 20 M1).
7. 2.3: N3. An ordinary switch over a superseded resync drops the owed `unknown` outcome of an accepted-unadopted candidate (`registry/switch.ts:374-381` vs `successor.ts:107-116`). Fix: pass the superseded rows' attempt ids as `abandonedAttempts` in the ordinary switch.
8. Port changes landed in 2.2e that 2.3 and later contract work must keep in both real and double implementations: `ManualRecoveryRecord.completedSequence?`, `IncarnationStores.cursor.clear()`, `SpentSetCorruptError.key` optional, `GroupNotMemberError` removed.
9. Contract suites on real MLS (phase-2 remainder): the I3 witness drives rpc's fake-crypto peer over kumiai's real cursor store, not real-MLS app frames. Re-witness with real MLS app encryption.
10. Release: `.changeset/spec-p-storage-foundation.md` carries the 2.2e summary. Package versions stay in the band; no new release files were added.

## Final review (fixed)

- I1 not-member rows unbounded, sealed proofs stored: `bc0f2914`.
- I2 pending successor disabled automatic/fork recovery: `ffc55ae2`.
- I3 current-moved devices skipped app messages: `b0f18ab6`.
- I4 restart chose manual row by list order: `80c3534e`.
- I5 duplicate `SpentSetCorruptError`: `cbb4b024` (with M3, `GroupNotMemberError` deleted).
- M1 `recover()` never settled on manual-resync spent corruption: `77dfb562`.
- M4 hub-paced checkpoint receive turns: `8c9209a1`, then counted from turn end in `7694f7c5`.
- N1 pending old-hub app frame swallowed a different new-hub frame at the same position: `624e9230`.
- Follow-up on live pushes and cross-hub ordering: no drop, no stall, no code change (`final-fix-report.md`).

## Final review minors (deferred)

1. **M2: a current move runs before spent diagnosis** (`registry-peer.ts:751`). The move commits, start throws, the owner fails. No safety loss.
2. **M5: `clearHold` with unknown outcome** leaves the in-memory app-hold latch held until restart.
3. **N2: `cursor.clear` contract does not pin incarnation scope** (`rpc-conformance/src/group-storage.ts:1247-1254`). A host clearing every cursor of the group would pass. Save an incarnation 1 cursor and check it survives `incarnation(2).cursor.clear()`.
4. **N3: ordinary switch drops the owed `unknown` outcome** of a superseded accepted-unadopted candidate (obligation 7).
5. **Unawaited delivery-worker cursor save.** `drained()` does not await an in-flight `appCursorStore.save` (`app-lane.ts:513`, from `finishRecord`). Per-group transaction FIFO probably orders it before the move clear. Unverified.
6. **`resumeBlocked(topicID, position)` keyed by position only** (`app-lane.ts:248-254`). An old record finishing at P can emit a premature `onAppDeliveryResumed` or clear the stall notice for a different new-hub frame stalled at P. Delivery unaffected.
7. **Heal-timing flake** in `manual-recovery-conformance` `successful rejoin leaves source holds in history / internal`: first attempt `no-reply`, retry exceeded the 12 s `waitFor`. File alone 3x green, full rerun 5211/5211. Known slow-CI class: poll on post-heal state.

## Deferred minors (per task, ledger)

- Task 1: lint formatted files outside fix scope during Task 2 WIP.
- Task 6: integration `recovery-capture-head` attempt-count flake under load.
- Task 7, 8, 19: IO-permission warning noise in worktree build logs ("Operation not permitted").
- Task 11: timing-sensitive real-crypto integration and mls-rpc rows under 4-worker load (retention-count 60 s timeout; retained-trust reply budget).
- Task 12b: retention-count fixture cost near the 60 s timeout serially; concurrent gates unreliable.
- Task 13: 4-worker notice-coalescing assertion failure under load (passes at 1-2 workers). Recheck if it recurs.
- Retention follow-up: age/coalescing fix partly relies on rows now at about 30% of the 60 s limit. Watch for recurrence. Retention M3 stays deferred.
- Task 16a: live-binding WeakMap entries kept for registry lifetime; repeated identical call-time `recover` replaces the remembered hub (undocumented); test-shape nits (row names, hold-after-pause, single-mode proof-barrier row, no-op race in a wait); validator refuses a callable hub object; a bad supplied `commitTopicID` is now `TypeError` (was `GroupStateConflictError`); authorisation-time resolver path checks only id/topic on the resolver result, not hub shape, and the run path has no dedicated row.
- Task 16b: m1 transient move refusal sticks to the rejoin until restart; m3 stub-peer mismatch row; m4 refusal rows double-only; m5 shadowed entry; m6 list-order restart tiebreak (largely closed by I4); m7 `recover()` rejects after a durable move when start fails.
- Task 17: m3 every seed opens all sealed checkpoint rows (cost and blast radius); m5 duplicated tombstone predicate; m7 resolver lacks a direct superseded witness; concurrent duplicate `recover(successor)` not idempotent; a pending successor choice still blocks resync (the app must admit an alternative successor first, per T17-I1); `manualRecoveryStatus` ties among all-completed rows by random UUID (largely closed by I4's `completedSequence`); superseded resync `load()` refuses permanently even after the successor retires; tombstone `authorisationID` may name a record first authorised for another successor (unread field); replace stored-row guard untested.
- Task 18: M1 `status()` rejects on transient trust I/O; M5 eager seed slot per attempt; M6 no spent-entry length check; fixed 500 ms negative wait in the hard-control-hold row; double condition write in catch when latched; startup race catch checks only the fork-halted latch (status stays `starting`); `safety().status` hold field omits `controlHold` while spent latched (confirm intent).
- Task 20: M1 docs name only successor as the exit for an unadopted legacy rejoin record (obligation 6); M2 rpc `SpentSetCorruptError` never thrown, README should say so (superseded by I5); M3 precedence not-member > recovery-unavailable holds for the safety projection only (`registryPeer.status` reports failed); M4 notice example acks open notices in a loop (ack-on-sight copy risk).

## Rulings (ledger, condensed)

Superseded or reversed rulings are marked; keep them for the cost record.

- Run Tasks 0, 1, 7 concurrently with the pre-flight scan; disjoint files. Cost if wrong: a fix round if the scan flags them.
- F1: Task 3b adds a sealed `coverage` CheckpointRecord kind (effectiveFloor, expiry/skipped/pre-join watermarks) with rpc union member and independent mirror; 3b may touch `checkpoint-types.ts`. Cost if wrong: one record kind.
- F2: Task 10 freshness witness signs `comparisonEpoch` = newest common retained epoch <= responder epoch (6) and asserts a freshness rejection, not span admission. Cost: fixture tweak.
- F3: Task 15a equality check excludes `forkRecoveryAttempt`, asserts exactly the A3 removal. Cost: one assertion.
- F4: Task 12b uses existing GroupSafety events/`ackEvent`, no API rename. Cost: none.
- F5: SQL gates must show PostgreSQL participation (`CI=true` fail-closed); a skipped backend is BLOCKED. Cost: infra time.
- F6: `settleAcceptedRecovery` floor param is `number|null`; null ordinary floor preserved; Y's effective E never written to the ordinary floor (R7). Cost: signature widening.
- F7: `activeRejoin` excludes the executing manual selection, includes competing ordinary/manual candidates and a pending `forkRecoveryAttempt`; else current move is unreachable. Cost: predicate arm.
- F8: `CheckpointService.updateRecords` rejects fact/debt/provenance/coverage mutations; only coordinator-private authority writes them. Cost: guard + test.
- F9: Task 19 fixes key cleanup and adds the `target-behind` reason literal; Task 11 reuses it and adds exact-X history preservation. Cost: merge care.
- Lanes per preflight: 19 now; 8 after 4; 9->10->11 serial; 13/14, manual 15a-17, 18 serial after 11; 12a after 11. No stated cost.
- Pipeline: Task 2 dispatched while Task 1 under review. Cost if wrong: Task 2 rework on a Task 1 interface change.
- T0-I1: `comparisonEpoch` is the lower bound of the requested lineage span (split E when a fork notice is open, else oldest retained epoch). Responder sends frames in `[max(comparisonEpoch, its oldest retained), F]`, nearest F kept under the 786432-byte bound, F always included. Requester compares at the newest common retained epoch in the span. Supersedes R9 M-b. Cost if wrong: one codec field meaning.
- T0-M1: qualify the total-loss row to same-group admission; successor retirement stays an exit. No stated cost.
- Reopen Task 1 for fix round 2 (ES2022 lone-surrogate check replaces `isWellFormed`); Task 2 waits, reruns its gate. Cost: one fix round.
- Task 2 fix round 1 in worktree `lane/2-2e-t2fix`, then cherry-pick. Cost: possible pick conflict.
- T3a-I1: no change; plan Files list is an upper bound; 3b must run both runners in both fixture/ownership modes. Cost if wrong: missed writer surfaces at the 3b enforcement gate.
- T5-merge: survivor = notice with earliest `detectedAt` (tie: smaller `noticeID`); never renumber persisted events; union branches/signers/evidence; loser closed `merged` with `mergedInto`; one `fork-updated` event with `mergedFrom`, 30000 ms coalescing; acks per notice. Cost if wrong: one extra notice event per merge.
- T5-I2: compact per-notice tombstone (noticeID, acknowledged revision/time, sorted frame hashes) kept while a supporting installation fact can authenticate a replay; replay of a tombstoned frame is a no-op; bounded by checkpoint retention (256 installs / 7 days). Cost: small tombstone rows.
- T5-I3: timer flush failures re-arm with capped backoff (30000 ms doubling to 600000 ms); terminal failures use the owner failure path. No stated cost.
- T6-auth: no code change; authorisation is the app's hub `authorize` hook; Task 20 docs state the checkpoint topic needs the same rule as the commit topic. No stated cost.
- T6-m1: re-grade to Important; delays above 2^31-1 ms (TimeoutOverflowWarning, clamped to 1 ms by Node, hot loop) are clamped/chunked to <= 2147483647 ms with a fake-timer regression.
- T6-cursor: receive-cursor advancement must be atomic with evidence/notice/event persistence.
- Load-sensitive timing flake (integration recovery-capture-head attempt count): minor, re-run in later gates. Cost if wrong: a real extra-publish regression surfaces later.
- T10-fold: suspected Task 5 defect; follow-up 5fold in its own lane, root cause first, NOT-A-BUG allowed. Cost if wrong: spurious early split epochs lower recovery floors (F6).
- T10-M: fix M1/M2 in the same round (brief/T0-I1 witnesses). Cost: one extra test each.
- Integration regressions from parallel Tasks 10/11 go to the `t11fix` lane as fix round 1b; do not weaken Task 10 witnesses. Cost: one extra round.
- T13-I1: accept alternate runner placement (as T3a-I1). Cost: one runner registration.
- T12a-I1: accept the substitutions (behaviour lives in the shared incarnation writer and independent checkpoint mirror). Cost: a missed hook path surfaces in 12b/18 integration tests.
- T-retention: retention-count/age/coalescing flakiness recurred in 7 tasks including wrong-result failures; promoted to a follow-up investigation lane. Cost: one extra lane.
- Routing fallback: Claude subagents (Opus implements/reviews, Sonnet scoped re-reviews, Haiku never for judgment). Cost: token cost.
- T18-regrade: M2, M3, M4 enter the fix round with I1/I2; M1/M5/M6 deferred. Cost: small extra round.
- T16a-regrade: "target.hub never validated" promoted to Important; add a shared contract row for the call-time choice (real + double); other minors deferred. Cost: one extra round.
- T-retention-M: fix M1/M2 now; M3 stays deferred. Cost: trivial.
- Gate main 447eb962 mls-rpc ownership-phases failures: drop the `afterRelease`/`onRollback` hooks (release() wake reordered suspended outbox writes); WeakMap entry collected with `OwnerEntry`. Fixed `c0c26694`. Cost if wrong: decrypted rows live until GC of the entry.
- T16b-appcursor: a current move does NOT reset app-topic cursors; hosts reset after a move. **Reversed in the final pass** (clear in the move transaction). Cost materialised as final I3.
- T16b-fix: fix I1 (+ row floor=epoch+1, no strand refuses) and m2 in fix round 1; m1/m3-m7 deferred. Cost: m1 liveness gap until restart.
- T17-supersede: a successor choice may replace a pending resync; over a successor is refused; resync over resync refused; the superseded row stays `authorised` and every consumer ignores it. Cost if wrong: one stale row a later reader might act on. Final review confirmed no consumer does.
- T17-retire: routing retirement = source peer stopped by drain + lifetime tombstoned; retired cursor/anchor rows kept. Cost: dormant rows retained.
- T17-I1: a new successor supersedes an unexecuted successor (authorisation re-read in-tx); self-successor rejected. Cost: superseded successor rows linger.
- T17-regrade: m2 (status by row order) and m4 (ungated overlay load) promoted into fix round 1. Cost: small scope growth.
- merge-spent-manual: with an authorised manual recovery, resume skips the spent-corruption check; spent corruption reappears at the next resume without a manual recovery. Cost if wrong: `spent-set-corrupt` surfaces late while manual recovery is pending. Final review: safe.
- Final: T16b-appcursor reversed; kumiai must keep current-moved devices from skipping app frames (clear in move tx or namespace). Cost: port change + contract work.
- Final: I2 fixed by excluding successor rows from `hasActiveManualRecovery`; resync over a pending successor stays refused. Cost: an ordinary switch could race a later successor retirement (retire tx re-reads its row).
- Final: I5 unify `SpentSetCorruptError` on the rpc class; `GroupNotMemberError` deleted (branch-new, per `git log -S`). Cost: export change pre-1.0.
- Final: M1 and M4 re-graded to Important. Cost: small scope growth.
- Final: I2 extended; resync rows superseded by a successor are excluded too. Cost: a superseded resync's accepted-unadopted candidate may coexist with an automatic rejoin (one dangling leaf).
- Final: I3 implemented as clear-in-move-transaction (`IncarnationStores.cursor.clear`), not namespacing (namespacing needs a new host-wired `createPeer` option). Cost: host-supplied cursor stores must clear themselves; buffered old-hub pending app frames keep old positions (collision risk, then closed by N1).
- Final: residual-fix; M4 and N1 get one more targeted fix beyond the single pass; N1 fixed by requiring frame-id match on restore (moves stay allowed). Cost: one extra fix round.
