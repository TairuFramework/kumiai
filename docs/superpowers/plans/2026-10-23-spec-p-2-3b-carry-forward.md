# Plan 2.3b carry-forward (open decisions, rulings, deferred minors, obligations)

Plan 2.3b (leases, `seal`/`receive`, ephemeral, auto-rotation with internal outcomes) complete on `feat/spec-p-phase-2` (range `ce655daf..HEAD`, not pushed). Task 6b redesigned to spec r28g as R1 (codec, published `@kumiai/mls` 0.10.7 via PR #67), R2 `b50b4396`, R3 `ba8e4c2c`, R4 `6946dbca`; main merged at `0815b4ad` and `30c44584` (#68 stale-leaf; r28g imported-reservation user decision). Lanes B/C1 merged `1cf2bbb6`; Tasks 7/8/11 merged `81574138`, `056dcc27`, `3814ae0c`; Task 12 `3b54c7cf`. Final reviews: Opus READY_WITH_MINORS (3 Important, fixed) and blind Codex NOT_READY (I4 fixed; I1-I3 open user decisions); fixes in the commit following `3b54c7cf`. Ephemeral: delete with the other phase-2 plans.

## Open user decisions

Spec r28g vs the threat model (every hub fault degrades to not-delivered; never durable halt, hold, discard or stranding). Code unchanged.
1. **Codex I1, poison suppresses rotation.** At generation 500 an internal rotation build gets `skipped` from an unreadable occurrence before first handoff; publication, scheduler, expiry and restart all refuse it. No other committer means no send after the hub recovers. Suggested: separate coverage uncertainty from reasons that forbid identical-byte retry (`operations.ts:172`, `peer.ts:1142`, `auto-rotation.ts:203`).
2. **Codex I2, delivery-failure strand then retirement discard.** Foreign current-epoch commit with an unreadable entry blob strands the cursor while a local Invite build is live; resync retires the source and closes the build `unknown` (candidate and speculative Welcome deleted). D1/D4 allow it (`peer.ts:2376`, `registry/retired.ts:130`).
3. **Codex I3, withheld revoke holds sends.** A saved revoking build never delivered keeps `revokeHeld` blocking retained sends past deadline, through ack and restart. Intentional r28g (`peer-control-settlement.test.ts:871`); releasing must not imply revocation succeeded.

## Obligations for later sub-plans

1. Merge held until phase 2 complete (user decision). Do not merge or push after 2.3b alone.
2. Next sub-plans: 2.3c (resync/retirement drain of opened records, `drainOpened`, `switch-blocked`; N3 and O1/O3/O4 settlement), 2.3d (`HandlerCompletion`, handler metadata, frame-ref migration, poison removal), 2.3e, then 2.4.
3. Double commit authentication (2.3a obligation 2) resolved by Tasks 10/11 and the final fix (rpc `readCommitHeader` now tag-checked). Closed.
4. Version drift: branch `@kumiai/mls` is 0.10.8, main is 0.10.9. Pick up at the next main merge.
5. Hosts importing pre-redesign state must pass a `legacyCommitJournal` adapter or an explicit `null` (required only per incarnation whose snapshot needs migration); else `LegacyJournalDecisionRequiredError`.
6. Hosts must forward `internalOperations` in their `createPeer` adapter (`registry-peer.ts:572`) or auto-rotation never binds and the member stays `rotation-required`.
7. Host `restoreCandidate` must accept the library rotation candidate envelope; non-`InvalidCandidateError` throws loop the rotation intent until its 30 s deadline.
8. Hosts implementing registry port types themselves must add `RegistryHandleAccess.seal`, `receive`, `onAdmissionChanged`, `onRotationRequired`, `GroupHandleRegistry.effectiveNext`.
9. Hub-conformance has no `test:unit`; it runs only via hub-server/hub-tunnel wrappers. R4 skipped that family; final gates `3b54c7cf` were green, rerun at phase end.
10. Carried from 2.3a: past-retention catch-up loss (user decision pending; settled notice, departing-pull window, or yielding walk).
11. Carried from 2.3a: uncancellable hub fetches (`@enkaku/client` aborts only after `sent`); fix upstream in enkaku.
12. Carried from 2.3a: transport-level hub response decode bound (hub-protocol/hub-client) unbounded by rpc's page-size check.
13. Carried from 2.3a: raw-key holders can restore unrestricted handles (accepted Q3 trusted-code exception; 2.3b README states a handle handed to the registry requires no other send-capable copy).
14. Carried from 2.3a: ts-mls chain-secret skipped cache and commit-creation retained own handshake secret (out of scope).
15. Carried from 2.3a: hosts wire `appCursorStore` to the registry incarnation cursor (`ports(key).cursor`); documented in the mls-rpc README.
16. Release: `.changeset/spec-p-storage-foundation.md` and `.changeset/version-band-0-11.md` carry the 2.3a/2.3b paragraphs, removed handshake APIs and build hooks, send-denied handles, retained operation IDs. Versions stay in the band.

## Rulings worth re-checking

- Kumiai MLS context floors `maximumForwardRatchetSteps` at 500 (lower explicit overrides included); spec line amended to match. Load-bearing for lease participation.
- Tokens: holding token authorizes no-wait only for the exact handle minted with it; foreign, used or stale tokens wait on the serializer. Opus M5 (throw `TypeError`) reverted: Tasks 1-3 contract and 16 tests need the wait.
- Default durable handlers stay at-least-once (spec :531-538); R3 reverted fix-round-2 N5.
- Task 7: lost or rejected rotation re-evaluates (admission, intents, build, spentSource) per D4/D5, not unconditional retry; internal outcome notification at-most-once (row deleted before callback); public enqueue of a reserved-prefix ID throws `TypeError`.
- Operation ID reuse refused while an outcome, build, spent marker or Welcome obligation holds it; internal outcomes are registry-owned at retirement (hidden from `listRetiredOutcomes`).
- R4: explicit main-journal decision required only for incarnations needing migration; matching slot ahead of source epoch refused at migration (spec :683-684).
- r28g advance applies on every restore, raw handles included.
- Task 8 'removed' lease row tests deferred reservation, control progress, pending replay and retained-key receive; no new registry handles after terminal removal.
- group-conditions not-member recovery wait raised 5s to 20s (spec :98/:329 allow 15 s backoff cap).
- Intermediary branches and checks used `--no-verify` and an early lane merge (user-approved); the combined merge was gated.
- Load-timing flakes ruled not regressions (rerun isolated): recovery-key-cleanup, peer-recovery, hub-migration:1579, ownership-phases `2s` bound, manual-recovery-conformance.

## Final review minors (deferred)

- Opus M6: `./testing` subpaths expose S1 bypasses (`restoreCommittedSender`, `armLiveEncryptFault`, maintenance gates, `serializeHandle`); louder README warning.
- Opus M7: sealed double `readSenderData` reports `invalid` on a corrupt body where real MLS reports `consumed` or `generation-bound` (stricter, reason differs).
- Opus M8: shared migration double lacks the main-journal decision rule; pinned only in mls-rpc.
- Opus declined to judge: walker adoption vs `consumesInboundCommit` `commitOnce === null`; retirement drain vs lane lock; double `buildKeyRotation`; `controlOccurrenceCoverage`; host-written provider activation barriers; `refreshAdmission` cached-base recompute.
- Parked Task 6: stale-control provenance (F-T6-control); `sameStoredValue` perf, `admissionChanged` pre-dedupe, redundant `schedule`, initial advance skips `changed()`.
- Parked R3: terminal-mode witness no longer proves eventual cursor save; cursor-save throw backs off the worker ~1 s.
- Task 0: spec :621 "unused skipped generations count" reads oddly beside "no per-seal burn"; `onAdmissionChanged` spec :1015-1018 beyond brief.
- Task 1: `derive` does not reclamp a mutated parent `keyRetention`. Task 2: `confirmAdopted` allow-listed (F6). Task 9: sandbox permission warnings, test-strength minors.
- Harden the recovery-key-cleanup test (`timeoutMs=50`).
- 2.3a minors still open: `GroupUnavailableError` `deleted`/`invalid` retried as storage; held `unsupported-version` maps to a terminal error; same topic/position different ids both open; pull rate bounded only by continuation backoff; `frameID` hashed each deliver pass; spec :1366, :1065-1066, :1371 wording; test gaps (Task 4 retained-epoch branches, Task 11 redeliver "once", Task 5b concurrent builders on one permit).
