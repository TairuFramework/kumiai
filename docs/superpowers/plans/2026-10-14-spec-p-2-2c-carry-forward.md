# Plan 2.2c carry-forward (rulings, deferred minors, obligations)

Plan 2.2c (durable fork halt + GroupSafety) complete at `8697173` (range `4588e5f..8697173`). Ephemeral: delete with the other phase-2 plans.

## Obligations for later sub-plans

- 2.2d: immediate propagation of registry/GroupSafety holds to live peers (2.2c peers learn a host-reported halt only on control refresh or restart).
- 2.2d: r15 authenticated captureHead. Until then a stale-GroupInfo external recovery commit that lands after an applied commit halts the survivor as fork evidence; rewrite tests/integration/test/recovery-confirmation.test.ts stale-GroupInfo row to spec :1125 (CAS refusal, fresh retry, no halt, incl. restart).
- 2.2d: legacy RejoinRecord conflictEpoch silently takes ordinary settlement; document or migrate.
- 2.2d: all 2.2b obligations still open (drain-induced source moved retry, null mutationID binding, retireIncarnation drained precondition, AdoptionWrite→RegistrySwitchWrite, consumer wiring, onRetire, adopted bootstrap, barrel/README).
- 2.2e: manual recover(). USER decision: re-invite with a lost spent set creates a NEW successor group; track it.
- 2.2e: fork tombstones refuse readmission; clearable-hold implications (hub-mux gated retain drops refcount).
- 2.3: batching, leases, restore-work, package burn, retired certified-settlement publication; restart frozen-settlement publication under a safety hold (must run exempt from safety gates, R19); restart settlement of post-apply bookkeeping skipped under a latch.
- phase 3 providers: EntryCapability.run joins proof before rejecting (document); a real provider raising transient GroupStateConflictError from trust() must not be misdiagnosed as permanent trust loss (durable recovery-unavailable).
- Accepted residual: a crash before the first durable halt write loses one-shot fork evidence (one-shot reveals, host evidence).
- OPEN QUESTION (user): past-epoch frames are classified before authentication (cleartext epoch + digest), so any party able to publish to the commit topic can durably halt every member that applied that epoch (spec D1 accepts as observed evidence).

## Rulings

- Ruling: PF1 F1 callback prohibition narrowed to network I/O/handlers/notifications; authorised prepare crypto/codec/effects/hooks in entries — spec S198-200,233-235,441-483 requires them — cost if wrong: a reviewer flags lawful in-entry crypto.
- Ruling: PF2 F2 Task 8 Files extend to peer-cursor-table, peer-durable-effects, peer-rejoin-record, peer-fork-settlement + audit hits — mandatory migration exceeded its list — cost: none beyond scope clarity.
- Ruling: PF3 F3 readmissionChanges bound Number.MAX_SAFE_INTEGER + 1 plus max-epoch row — exclusive comparison kept epoch MAX_SAFE_INTEGER — cost: trivial.
- Ruling: PF4 A1 ackEvent rejects stored safety kinds only; absent ID no-op — matches spec S884-885 unknown-remove — cost: a stray ack of an unknown safety ID silently succeeds.
- Ruling: PF5 A2 moved-epoch refusal only for epoch-authenticator evidence — spec S38/46-48 keeps past-epoch digest evidence — cost: report of stale digest evidence accepted (still bound to active key).
- Ruling: PF6 V1 Task 7 RED asserts the exact bound + no deleteAppliedFrom — baseline already passes the output invariant — cost: none.
- Task 1: Ruling: I1 fix materializes canonical known-field body, which also drops unknown extra keys (sonnet m1) — one design closes both — cost: none.
- Task 2: Ruling: no edit to registry/retired.ts or registry/registry.ts — both reviewers verified existing retirement/delete paths already preserve safety fields and registry-retirement-writes/registry-delete tests cover it; touching files only to satisfy the list adds nothing — cost if wrong: a retirement path clears a field, caught by Task 11/12 contracts.
- Task 4: Ruling: halted mutate(fn, adoption) refuses at entry; proof-backed no-op replay preserved via adopt/replace only — brief requires guard before host/MLS callbacks and mutate's fn is a callback that runs before no-op proof — cost if wrong: a host replaying through mutate under a halt gets GroupSafetyHeldError instead of a no-op.
- Task 4: Ruling: seed/switch/access safety rows live in new registry-safety-admission.test.ts instead of the brief's listed files — same coverage, one file — cost if wrong: none functional.
- Task 4: Ruling: regraded Sonnet m1 (reportFork rewraps GroupStateConflictError as invalid), m2 (exportSecret sync held throw), m4 (persist failure replaces diagnosis), m6 (switch hook-halt row) into fix round 1 — wrong public error class/shape or missing brief row — cost if wrong: small extra fix scope.
- Task 5: Ruling: regraded Sonnet m1 (lost notification when ambiguous write landed) to Important — violates C10/R21 notify-when-stored-equals-ours — cost if wrong: small fix scope. Pulled m3 (verify slot applied source), m4 (holdControl must use controlHoldPresent), m7 (real-strand cleanup row) into fix round 1.
- Task 5: Ruling: haltFork retry loop runs under the runSerial lane lock (Sonnet m2) — accepted: latch is synchronous so new work stays gated, and the queued work (cleanup, committed Welcome) needs the same failing storage — cost if wrong: committed Welcome delivery delayed until storage recovers or dispose.
- Task 6: Ruling: restore the refreshControl persisted-strand restart heal for non-fork strands, safety-guarded — plan's :2113 removal targeted fork healing; after R22 forks never persist stranded, so the trigger only serves ordinary strands the brief says to keep — cost if wrong: one guarded heal path restored.
- Task 7: Ruling: overruled sol's missing peer-final-fixes migration — Task 6 (abc4db0/f2979c8) already migrated that file to halt/history assertions; it has no cursor.fork/forkSettlement use and passes unchanged — cost if wrong: none (removal scan is the gate).
- Task 8: Ruling: Sonnet minor 1 (uncommitted Welcome negative arm) already covered by Task 5 fix round 1 rows in peer-fork-halt.test.ts — no change.
- Task 11: Ruling: sol M1 (turbo IO warnings in sandbox logs) — controller reruns build/types after cherry-pick in main checkout as the clean gate — cost if wrong: none.
- Task 9: Ruling: regraded Sonnet m3 (attemptBody catch masks PeerDisposedError under latch) into fix round — wrong public error class — cost if wrong: small scope. Pulled m2 (renewalRequiredEpoch reorder) too. fake-crypto.ts: fixer moves counters there only if it replaces ad-hoc spies cleanly, else justifies — brief listed it as helpers-only, not a behaviour requirement.
- Task 12: Ruling: stale-GroupInfo recovery row halting Alice fork-winning is spec-correct, not a false positive — spec D1 table (line 38) mandates durable halt for past-epoch digest divergence "on either classifier branch"; the r16 superseded exception (line 46) needs a fully validated first-valid prefix certificate the walker does not hold (sol diag /private/tmp/kumiai-t12-diag.md; Opus judgment /private/tmp/kumiai-t12-opus-judgment.md disagreed, overruled: its proposal contradicts D1). The honest race lands only because r15 authenticated captureHead is unimplemented (2.2d). Row becomes a positive halt assertion; r15 rewrite of the row to spec :1125 carried to 2.2d — cost if wrong: until 2.2d, an honest stale-GroupInfo recovery race halts the survivor permanently (manual re-invite).
- Final: Ruling: regrade rpc M1 (public entry points await ready before checking safety) Minor -> Important — effect: with a persistent storage failure after a latched halt, enqueue/request/to/resync hang forever instead of rejecting GroupSafetyHeldError — cost if wrong: one small fix round.
- Final: Ruling: declined "real provider transient GroupStateConflictError from trust() misdiagnosed as permanent loss" — only memory provider exists; carry to phase 3 provider contract — cost if wrong: a phase-3 provider could durably hold recovery-unavailable on a transient conflict.
- Final: Ruling: declined "mls-rpc processCommit/access.mutate pass GroupSafetyHeldError unwrapped" — covered by Task 9 peer-safety-commit rows and safetyHold() sendAdmission fallback; other slice found no wrap — cost if wrong: a held commit could be treated as resolver failure.

## Deferred minors

- Task 1: minor (deferred): epoch/incarnation/detectedAt accept any finite number (sonnet m2).
- Task 1: minor (deferred): `{forkHalt: undefined}` throws TypeError; pin with a test (sonnet m3).
- Task 1: minor (deferred): control-safety-fields.test.ts imports ../../rpc-conformance/src by relative path (sonnet m4).
- Task 2: minor (deferred): group-storage.ts finalisation row 'transaction' branch hand-writes the event, exercises no production code.
- Task 2: minor (deferred): preserve row terminal/retire actions don't call clearTransport; no mutation evidence on retirement path.
- Task 2: minor (deferred): group-storage.ts +394 lines with repeated storageEvents filter; small helper.
- Task 3: minor (deferred): vitest transform-cache advice noise in hub-contracts log.
- Task 3: minor (deferred): safety.ts work-phase refusals after prepare latched leave a latch on a refused report (unreachable while prepare->work serialize).
- Task 3: minor (deferred): safety.ts:626 .slice() on malformed local/remote throws TypeError not ForkReportRefusedError; Buffer.slice is a view not a copy.
- Task 3: minor (deferred): registry latches map never shrinks (per-incarnation, registry lifetime).
- Task 3: minor (deferred): group-safety.test.ts:1139 unused epochAuthenticator result (dead statement).
- Task 3: minor (deferred): rpc index.ts new export type line sits above @module docblock.
- Task 3: minor (deferred): ownership-phases "wait behind unresolved proof" non-start asserted after one turn().
- Task 4: minor (deferred): replace committed-detection now relies on lifetime mutationID equality only; no explicit uncertain-commit replace row.
- Task 4: minor (deferred): duplicate checks — assertWorkSafety in work and writeState; seed judge() rechecks held() after readAdmission.
- Task 4: minor (deferred): safetyHeld nested ternary duplicates crypto.ts reason narrowing; shared heldReason helper.
- Task 4: minor (deferred): reserved-red log has unhandled-rejection noise (resolved in GREEN).
- Task 4: minor (deferred): reportFork awaits trust-hold persistence directly (safety.ts:166); a failed write replaces the held refusal with the persistence error (not via diagnoseFailure).
- Task 5: minor (deferred): `healRequested = safetyHold() === null` idiom repeated ~10x, redundant triple check in discarded; requestHeal() helper.
- Task 5: minor (deferred): sameHalt compares JSON.stringify of bodies with Uint8Array; field-wise compare clearer.
- Task 5: minor (deferred): runSerial entry refreshControl() when epochNeedsBuild adds a control load on a hot path; needs a comment.
- Task 5: minor (deferred): only one mutation check reported in original task (provider saveBuilt).
- Task 6: minor (deferred): 'Missing applied fork history' throw is classifier-invariant guard; needs comment.
- Task 6: minor (deferred): peer-delayed-bootstrap recoveryRequests check proves only no synchronous heal (delayed covered elsewhere).
- Task 7: minor (deferred): peer-fork-settlement.test.ts "own winner ... without repairing history" asserts on an unmutated snapshot (tautology).
- Task 7: minor (deferred): test.each([2, 4]) halt-preserves test only exercises applyChanges immutability.
- Task 7: minor (deferred): legacy RejoinRecord non-null conflictEpoch silently takes ordinary settlement; needs a comment (2.2d reader).
- Task 8: minor (deferred): peer-safety-gates.test.ts uses real 30ms sleeps for negative assertions.
- Task 8: minor (deferred): drop-only test does not spy healIfRequested/reconcileCommits directly.
- Task 8: minor (deferred): peer-app-cursor.test.ts removed advance-rule rationale comment; confirm future-epoch-frame rule pinned elsewhere.
- Task 11: minor (deferred): fixtures/registry.ts duplicates GroupSafety param builder (registryFixtureSafetyParams vs safety member/safetyMLS); extra makeHandle per assemble.
- Task 11: minor (deferred): shared row asserts literal fixture message `Injected ${point} failure`.
- Task 11: minor (deferred): safety-conformance Proxy returns unbound methods.
- Task 11: minor (deferred): rpc-conformance safety.ts repeated seed options literal (4x).
- Task 9: minor (deferred): held-fetch branch duplicates unsupported handshake/commit-frame classification; extract isUnsupportedFrame.
- Task 9: minor (deferred): non-safety port-contract error dropped silently as held when latch coincides (peer.ts diff :1383); no log.
- Task 9: minor (deferred): after applied commit, latch skips post-apply bookkeeping (own-op settlement loop, in-memory head); not pinned by a test (restart settlement is 2.3).
- Task 10: minor (deferred): hub-mux attemptSubscribe gated early return leaves state 'asking' and skips reportFailure; needs comment (harmless while hold permanent).
- Task 10: minor (deferred): hub-mux retain drops refcount while gated instead of deferring (relevant if a clearable hold is added, 2.2e).
- Task 10: minor (deferred): suspended-mode zero-network assertion after a single microtask is a weak window.
- Task 12: minor (deferred): welcome-after-crash halted row titled "restart" never restarts.
- Task 12: minor (deferred): fork-halt ephemeral spy has no positive calibration.
- Task 12: minor (deferred): possible double fault.finish on an already-failing path in fork-halt fixture.
- Task 12: minor (deferred): fixtures/fork-halt.ts ~505 lines mixes wiring/equivocation/certify/counters; relative-path src imports + namespace monkey-patching brittle.
- Task 13: minor (deferred): "Manual recovery remains unavailable until 2.2e" reads as delivery commitment; soften when 2.2e scoped.
- Task 13: minor (deferred): rpc README understates that mls.sendAdmission() can latch registry-held admission without control refresh (peer.ts:305-312).
- Final: minor (deferred): rpc M2 dead 'kind' in snapshot.strand branch in refreshControl (peer.ts:2299-2307) implies fork strands can persist.
- Final: minor (deferred): rpc M3 GroupSafetyHeldError on inbox/protocol inbound acks mailbox-class frame (peer-epoch.ts:162 retainOnFailure); directed request racing a volatile latch is dropped.
- Final: minor (deferred): other m1 malformed non-authenticator reportFork evidence latches runtime then TypeErrors in work phase (mls-rpc/src/safety.ts:76-93); held until restart.
- Final: minor (deferred): other m2 GroupSafety.events/ackEvent skip validKey (mls-rpc/src/safety.ts:176-205).
- Final: minor (deferred): disposed AND held peer now throws the safety error before PeerDisposedError for enqueue/resync/gather/withReady sends (unpinned); dispatch(non-log)/commit absent from the pre-ready test.each.
