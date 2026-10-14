# Spec P 2.2d Recovery Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans for approved implementation. Track the checkboxes task by task.

**Status:** DRAFT, reconciled against USER Q0-Q5, rec2 R0-R9, rec3 S1-S8, rec4 T1-T4 and retained rec1 rulings (2026-10-14).
**Goal:** Recover stranded devices through authenticated capture replies, confirmed registry switching and resumable destination bootstrap.
**Architecture:** Reply v2 binds a committed snapshot, authenticator and capture head. Candidate v3 preserves immutable origin and acceptance facts.
A detached coordinator drains the source before switching. Retired continuations preserve owed work. Core sinks propagate local safety holds synchronously.
**Tech Stack:** TypeScript, pnpm 12.10.1, Vitest, ts-mls 2.0.0-rc.13, Web Crypto and transactional memory persistence.
**Spec:** [Spec P](../specs/2026-10-08-spec-p-transactional-persistence.md) r19 (applied in the same commit as this plan).
"r18:N" coordinates refer to the r18 text at ebdda50; "the r19 replacement for r18:N" is the r19 text that replaced those lines.

Baseline: HEAD `ebdda505e1288990746b2df345e804c0596df8e1`. All existing-source coordinates below refer to this HEAD.
Binding precedence: `.superpowers/sdd/plan-2-2d-draft/threat-model-brief.md`, `review-rec2/rulings.md` (R0 is USER),
then `review-rec3/rulings.md` (S1-S8), `review-rec4/rulings.md` (T1-T4), `review-rec1/rulings.md` filtered by Q4, then `rescope-brief.md`.
Evidence: `review-rec4/findings-sol.md`. Read the 2.2b/2.2c carry-forwards.

## Global Constraints

- Use pnpm only. Prefix development commands with `rtk proxy`.
- Pair every Vitest run with its package's `test:types`. Rebuild exported siblings before cross-package tests.
- Run repo-wide build/type gates after every exported type change, including fixtures and integration consumers.
- Keep declaration/caller/fixture changes green within each task. Split any closure exceeding approximately 25 changed files before implementation.
- Preserve runtime-neutral ownership enforcement. Prepare crypto outside provider transactions. Release ownership before network I/O or host callbacks.
- Only proven commits release state, events or destination peers. Ambiguity releases nothing.
- Preserve source outcomes, owed Welcomes, history and immutable safety evidence. Copy no source ratchets/applied rows/anchors/cursors into n+1.
- Never edit generated `lib/`, dependencies, scripts, configuration or package versions.
- Internal dependencies remain `workspace:^`. Cross-repo dependencies remain catalogued published `^` ranges.
- Reply version 2 uses `kumiai/mls/recovery/v2` and `kumiai/mls/recovery-aad/v2`. Ledger-only replies retain version 1/domains.
- Candidate version 3 uses `kumiai/recovery-candidate/v3`. ClientState codec v2 and existing journal sourceState stay unchanged.
- Save exact recovery payload/ID/candidate/request key/source/target/capture/search origin before first publication.
- Initial expectedHead equals authenticated captureHead, including null. Only authenticated head-only retry changes expectedHead.
- Keep existing digest/payloadDigest fields, stored commit/proof shapes and frame version. No identity migration or canonical intake gate.
- Exclude fork detection, manual recovery (2.2e), batching/leases/openBatch/package burn/restore-work/full registry crypto (2.3), and database providers (phase 3).
- Fork detection is deferred to later out-of-band peer checkpoints. This recovery plan defines no checkpoint transport or implementation.
- Future implementation tasks end with green checks and a reviewable commit. Run lint before those commits.
- Release text belongs only in `.changeset/spec-p-storage-foundation.md`.

## Review Focus

- Delivered-copy failures must not enter local safety sinks. Task 5d tests trust/report boundaries.
- Future app expiry must use the locked epoch and fire without traffic. Task 5e tests hints, boundaries and timers.
- Delayed replies after responder advancement must settle X without erasing owed work. Task 14b tests R0 and movement.
- Settled restart must need no retired secrets and keep cumulative obligations bounded. Task 14b tests row shape and repetition.
- Legacy/captured activation must preserve live acceptance and convergence. Tasks 14a/14b test both fixture modes and the complete closure.

## Decisions

**D0 -- threat model (Q0).** The hub cannot forge MLS content. Denial of service is the main concern.
Drop, delay, reorder, replay, encoding/tag/blob/padding tampering, junk and unknown versions mean non-delivery: skip/poison/diagnostic.
They never authorise durable halt/hold, discard of possibly accepted work, rebuild/double enactment, owed-work deletion or permanent stranding.
Peers cannot prove non-delivery in-band. No machinery attempts to prove hub misbehaviour.

**D1 -- acceptance authority (Q3/P0).** Authenticated applied state decides whether recovery attempt X was applied.
Log search provides confirmation hints. Byte mismatch, absence, junk and gaps never authorise discard or prevent authenticated recapture.
Recapture uses fresh requestID/requestKey outside X's immutable record. Backoff is bounded at 15 seconds.
Head ordering never refuses recapture. Hub-assigned strings may regress or be inflated. Persist a monotone member-signed recoveryEpochFloor through settlement/discard/restart.

| Authenticated responder state | Action |
| --- | --- |
| Later epoch, X's exact wire-encoded fresh LeafNode present | Accepted -> settled. Adopt X only with bound confirmation. Otherwise use R0 below. Never match only DID/index. |
| Same capture epoch and authenticator | Responder prefix lacks X: retry SAME bytes/ID/candidate at fresh authenticated captureHead, even if lower. |
| Later epoch, X's fresh leaf absent | X cannot apply again, including applied-then-removed. Unconfirmed X permits policy-gated discard/build (r18:66,128); existing accepted facts survive. |
| Same epoch, different authenticator | Diagnostic and bounded retry/recapture. No forkHalt or durable hold. |
| Epoch below floor | Refuse stale epoch, preserve X and retry. Head regression is diagnostic only. |

**R0 settlement.** Known position (ack/exact-byte hit) plus a responder still at epochAfter keeps the existing bound-confirmation fast path.
Otherwise, authenticated later-epoch exact-leaf presence settles X as accepted-unadoptable in one ControlStore transition.
Save compact public X facts and cumulative ledgerBefore in settledRejoins. Clear the active pointer and raise recoveryEpochFloor to the recaptured epoch.
Omit request/requestKey/candidate/payload durably. Zeroise owned secret buffers only after proving the settlement committed.
Keep at most one cumulative settlement row per source incarnation. New settlements replace public provenance and union all prior owed tokens.
Carry ledgerBefore into fresh Y, as HEAD `packages/rpc/src/peer.ts:3533` carries it after discard.
Y builds at the recaptured epoch and removes X's sole same-identity leaf under normal admission. Never rebuild X at its capture epoch.
X uses `frameCommit(pending.commit, [], null)` (`peer.ts:3823`), enacting no ledger work. Compute reenact tokens only after Y bootstrap (`control/rejoin.ts:217-223`).
Restart preserves settled X and owed obligations before constructing Y. No new ResyncProof arm, applied-state proof, candidate codec/verifier change or null-position lookup.

**D2 -- own recognition (Q2/P1).** Exact bytes provide positive evidence. Mismatch means nothing learned, never adverse settlement evidence.
One helper decodes/re-encodes the MLS-message commit half before hashing. It recognises re-encoded/blob-changed own no-entry commits.
Require both helper results to be non-null before matching. Never reconstruct application/publication bytes or rewrite stored digests.
No-entry blobs are ignored on author and receiver.
Named-entry recognition uses normal MLS validation and the receiver resolver/reference-verification predicate under retained pre-state.
A valid swapped blob can recognise saved work. Invalid copies skip/advance cursor, retaining slot and acceptance-unknown state.
For ordinary slots, unchanged incarnation/epoch/authenticator permits identical bytes/ID at a fresh head after an unrecognised copy.
Commit-once remains idempotent. Copy mismatches never produce lost/absent/superseded; unresolved deadline outcome is unknown. Authenticated recapture applies to recovery attempts only.
Normal first-valid proof gates adoption/Welcome release. Existing saved payloadDigest binds saved work after recognition.
Only refusal of the authenticated commit itself permits negative verdicts. Copy failures remain advisory through replay and caches.
Unproven superseded verdicts cannot discard X. D1 independently decides later-epoch non-acceptance.

**D3 -- local safety (Q1/P2/P3).** Both past-epoch divergence branches produce claimed diagnostic poison, including signed refused CAS losers.
Own-slot/search delivery contradictions skip/advance cursor and preserve unknown work. They never halt or trigger frame-driven resync.
Unknown commit-frame/header versions add `upgrade-required` diagnostics and skip. Existing persisted halts/holds remain readable and immutable.
Host reportFork/authenticator comparison and genuine local storage invariants retain their halt contracts.
Legacy local control-record version holds remain separate. Missing/unreadable retained local trust remains recovery-unavailable.
Fresh responder disagreement and provider/configuration failures cannot manufacture these local conditions.
Before commit-lane catch-up, future app frames hold as at HEAD. Catch-up means no applicable unapplied commit through its observed head.
Only then apply claimed epoch <= local epoch + 2 and hold age < 30,000 ms, starting local monotone age at catch-up.
Crossing either bound, or an unsupported outer app version, commits diagnostic poison as completed. Only contiguous completed prefixes advance.

**D4 -- capture and origin.** captureHead is explicit null or a nonempty opaque string of at most 64 JavaScript characters.
Sign the committed captured authenticator as canonical unpadded base64url of suite KDF length. Never derive it from public GroupInfo/candidate before-state.
Candidate v3 retains authenticated reply, source/target/capture/search origin and the existing confirmation tuple.
Origin trust authorises signer/floors/owner/anchor. Offered authenticated GroupInfo binds sourceTree/candidate, supporting membership/path advancement.
Removed-after-origin signers retain attestation authority, including possible signed floor inflation. This lies outside the hub threat model.
Busy-group accepted-unadoptable churn remains a liveness residual when responders advance before confirmation. It supplies no hub-fault evidence.

**D5 -- registry boundary.** rpc owns portable `RecoverySource<TTrust = unknown>` and ResyncProof. mls-rpc removes duplicate names and re-exports the portable proof.
mls-rpc validates/narrows to RegistryRecoverySource internally. Ordinary source stays identity-only AdoptionExpected.
Recovery factories use saved switchMutationID. Restricted mapping writes adopted source rejoin plus destination cursor, never arbitrary changes/anchorLanded.
Only RegistrySourceMovedError permits fresh-counter retry with unchanged key/identity/trust/target. Resolve uncertain saved-ID proof before movement.
Coordinator waits source completion/drain and restores raw pending state. It never retains the host-bound pending proxy.
Destination continuation remains discoverable after destination epoch advancement. RecoveryCompletion owns accepted-operation -> unknown settlement in source storage, idempotently.
Local switch rollback never proves remote non-acceptance. Accepted/confirmed X survives movement or enters R0 settlement, preserving its ledger and obligations.

**D6 -- legacy and configuration.** Unadopted legacy records, including non-null conflictEpoch, retain every byte/stage under unsupported-version policy.
Their stop until manual recovery in 2.2e is an accepted compatibility cost. ControlHold unsupported-version is legacy/read-only for delivered frames.
Installed legacy continuations finish only with independent installation proof. Never fabricate capture metadata or reinstall their candidate.
New attempts are automatic/null-authorisation. Valid manual shapes decode but stop until 2.2e.
Registry recovery with custom recoverySecret requires recoverySecretFromTrust at construction. Missing equivalence throws TypeError before requests/hold writes.

## HEAD safety audit and retained source boundaries

Tasks 5a-5e audit every halt/hold producer and catch mapping, including unavailable-validation consumers. Each unit migrates its conflicting assertions.
The closures below come from actual `git grep` at HEAD, including source consumers, shared fixtures and integration tests.
Tasks 8a/8b finish own recognition and negative-verdict mappings. No identity-migration inventory remains.

| HEAD source | Required boundary and owner |
| --- | --- |
| `packages/rpc/src/classify.ts:241-277`; `packages/rpc/src/peer.ts:1769-1847` | Past divergence: 5a. Own-unmerged mismatch: 5b. Both skip/diagnose, retaining unknown work. |
| `packages/rpc/src/peer.ts:1586-1590`, `:1662-1703`, `:2624-2656`; `packages/rpc/src/control/search.ts:415-425`, `:464-495` | Unknown versions: 5c. Unexplained own: 5b. Recognition/refusal: 8a/8b. No hard holds/halts. |
| `packages/rpc/src/control/slot.ts:70-110`; `packages/rpc/src/control/search.ts:242-252`, `:324-341` | Task 5b removes delivery contradictions. Trusted local epoch-authenticator checks remain local-invariant halts. |
| `packages/mls-rpc/src/control-validation.ts:43-82`, `:213-278`; `packages/mls-rpc/src/safety.ts:71-93`, `:123-180` | Task 5d maps copy failures to diagnostic poison. Tasks 5b/5c migrate search-derived assertions earlier. safety.ts remains host/local only. |
| `packages/rpc/src/control/operations.ts:125-133`, `:207-269`; `packages/rpc/src/control/store.ts:267-327` | Task 5b owns operations/retry consumers. store.ts retains immutable local safety, audited unchanged. Keep required payloadDigest fields. |
| `packages/mls-rpc/src/registry/safety.ts:44-83`, `:93-139`; `packages/mls-rpc/src/registry/access.ts:310-318` | Tasks 4/5d retain these local trust/saved-hold guards unchanged. Task 5d verifies delivery failures cannot manufacture trust loss. |
| `packages/mls-rpc/src/registry/registry.ts:90-109`; `packages/mls-rpc/src/registry/retired.ts:181-212` | Task 5d audits these local-only guards unchanged. Tasks 7/15 preserve accepted facts, prior safety and owed work. |
| `packages/mls/src/recovery.ts:527-579`, `:711-717`; `packages/rpc/src/peer.ts:1297`, `:1627-1634`, `:3775` | Reply metadata, complete-prefix capture and requester-sampled CAS replacement. Tasks 2/13/14b. |
| `packages/mls-rpc/src/registry/verdict.ts:98-172`; `packages/mls-rpc/src/registry/switch.ts:67-110`, `:261-267` | Target binding, advanced tree, typed movement and unhooked uncertainty. Tasks 7/16. |
| `packages/rpc/src/peer.ts:1207-1226`, `:1951-2007`; `packages/rpc/src/recovery-confirmation.ts:28-40`, `:183-214` | Copy-derived negatives stay advisory in production/replay/cache. Task 8b. |
| `packages/mls-rpc/src/crypto.ts:76-84`, `:200-209`; `packages/rpc/src/ledger-entries.ts:104-117`; `packages/rpc/src/peer.ts:1897-1930` | Task 5c poisons/diagnoses sealed-entry versions and advances without strand/heal. Task 8a follows its ledger-entries edit. |
| `packages/mls-rpc/src/memory-incarnation-stores.ts:168-182`, `:326-327` | Task 1b normalises fresh/legacy snapshots without rewriting saved records. |
| `packages/mls-rpc/src/registry/types.ts:42-54`; `packages/mls-rpc/src/registry/verdict.ts:205-218` | Remove duplicate portable names. Bound commitDigest uses record.digest, distinct from proof.payloadDigest. Tasks 1a/7. |
| `packages/rpc/src/peer.ts:3813-3821` | Preserve de-duplicated in-flight/awaitingBootstrap, current ledger and conditional commitOnce bodies. Task 14b. |
| `packages/rpc/src/app-lane.ts:768-790`, `:864-879`; `packages/rpc/src/peer.ts:435,1540-2011` | Task 5e supplies commit-lane catch-up before two-epoch/30-second bounds and completes outer-version poison occurrences. |

## HEAD grep closures and owners

Verified at ebdda50 with `git grep -n -E 'forkHalt|haltFork|assertDurableForkHalt|assertDurableControlHold|fork-halted|unsupported-version|unexplained-own-commit|fork-losing|fork-winning|digest-divergence|cursor|frozen' HEAD -- packages/rpc/test packages/mls-rpc/test tests/integration/test`.
App closure also greps `future-epoch|future epoch|FrameEpochError|far-future`. Rejoin closure greps `RejoinRecord|buildRejoinRecord|putRejoin|\.rejoin\b|ControlSnapshot` across packages/tests.
The Tasks 5a-5e Files blocks enumerate the changed closure. The following coordinates identify key assertions, including additional grep discoveries.
Test-table prefixes resolve to packages/{rpc,mls-rpc}/test or tests/integration/test, with .test.ts suffix unless fixtures/source is explicit.

| HEAD test coordinates | Earliest semantic owner |
| --- | --- |
| rpc peer-durable-effects:78-96,449-465; peer-final-fixes:102-168; peer-fork-settlement:232-291,330-345 | 5a poison/progress with restart/history/outcomes/Welcomes. |
| rpc peer-control-search-walk:105-127; peer-commit-log-replay:329; peer-delayed-bootstrap:160-169; peer-fork-halt:688-714; peer-recovery:28-61 | 5a delivered competitors. Keep explicit host/persisted cases. |
| rpc peer-strand-observation:119-173; peer-locked-commit-epoch:120-173; peer-recover-lane:274-345; peer-failed-heal-strand:171-177 | 5a past branches; later own rows belong to 5b. |
| integration fork-halt:65-101,215-334 and fixtures/fork-halt:304; recovery-confirmation:389-477 | 5a delivered rows diagnose; storage-failure tests retain explicit host/historical setup. |
| rpc control-search:238-286,568-631; control-slot:218-253; peer-fork-settlement:348-417; peer-control-retry:262-278; peer-rejoin-record:680-706 | 5b own/search contradictions. Unknown-version search rows finish in 5c. |
| rpc peer-cursor-table:66,92; peer-failed-heal-strand:89,240,265; peer-strand-observation:175-224; peer-locked-commit-epoch:91-95 | 5b own rows; 5c unknown rows. Preserve locked-epoch parity. |
| rpc peer-recover-lane:491-510; mls-rpc control-validation:893-908,960-1038 | 5b removes search-derived halts; 5d changes direct validation classification. |
| rpc peer-app-cursor:85-140 | 5b migrates own-commit halts to poison/progress, preserving restart and app-cursor coverage. |
| rpc peer-unknown-commit-frame-version:77-106; peer-unknown-frame-version:83-123; peer-control-settlement:26-70; peer-fork-halt:396-437 | 5c diagnostic progress, with existing host-halt cursor freeze retained. |
| integration control-adoption-race:65; mls-rpc control-validation:213-278 (source) | 5d preserves injected stored hold and adds delivered-copy progress. |
| rpc future-epoch-retention:83-132; peer-app-drain-integrity:49-93,98-145; durable-stall:620-680 | 5e caught-up bounds, honest lag >2 epochs and handler/cursor coverage. |

Retained safety matches are explicit host reports, seeded persisted fields, local identity checks or ordinary completed-prefix assertions.
Task 5d audits unchanged mls-rpc tests `{control-adoption,control-build,crypto-safety,group-namespaces,registry-delete,registry-runtime,registry-seed,registry-switch}.test.ts`.
Tasks 5b/5c retain rpc control-safety-fields/control-store-conformance, fixtures/peer, peer-{log-delivery,readmission,safety-commit,safety-ephemeral,safety-gates,safety-recovery,safety-startup} and send-admission assertions.
Task 5a retains explicit host/historical cases in peer-final-fixes.test.ts:181,257 and peer-fork-settlement.test.ts:155-210. Task 5b migrates its moved-slot contradiction rows. Task 5d retains integration control-first-valid/peer-readmission/welcome-after-crash safety assertions.
The remaining cursor hits check normal receive/adoption/rollback progress, not delivered-frame halts. Their assertions stay unchanged and run in full suites.

| Rejoin/ControlSnapshot grep hits (all files) | Owner and treatment |
| --- | --- |
| rpc src/control/{types,store,rejoin}.ts, src/{peer,index}.ts | 1a aliases/declarations, 1b snapshot fields, 6b stored union/readers, 14b public alias/captured activation. |
| rpc src/control/{forks,operations,safety,welcome}.ts | 1a audits unchanged ControlSnapshot pass-through readers; 5b owns operation retry behaviour. |
| rpc-conformance src/{control-store,memory-control-store,persistence-fixture,index,group-mls,registry-fixture}.ts | 1a independent contracts/aliases, 1b snapshots, 6b storage mirror/double, 7 switch mirror, 14b activation. |
| rpc-conformance src/control-safety.ts, src/registry.ts | 1a audits unchanged type-only/seeded consumers; Control/Port gates preserve them. |
| mls-rpc src/{entry-capability,persistence-types}.ts, src/registry/cold.ts | 1b audits unchanged snapshot-typed reads, with repo-wide types. |
| mls-rpc src/{safety,registry/safety}.ts | 5d retains local-only snapshot consumers; exported type gates cover alias promotion. |
| mls-rpc src/registry/{verdict,switch,retired}.ts | 1a legacy aliases, 6b stored-record discrimination, 7 captured proof/accepted preservation, 15 continuation. |
| mls-rpc src/memory-incarnation-stores.ts; test/storage-fixture.test.ts | 1b fresh/load normalisation and type witnesses; 6b preserves both adopted formats in memory storage. |
| rpc test/control-store.test.ts:28,62; control-safety-fields.test.ts:24; peer-fork-settlement.test.ts:24,141; peer-readmission.test.ts:20-125 | 1b snapshot literals, including readmission null/[] and expectReset; 14a prepares control-store record, 5a preserves fork settlement coverage. |
| rpc test/fixtures/{host-db,peer}.ts | 1b snapshots; 14a prepares captured builder; 14b selects it atomically. |
| rpc test/{peer-control-settlement,peer-durable-effects,peer-startup-order,peer-safety-recovery,peer-control-retry,peer-fork-halt}.test.ts | 14a captured fixtures; 14b activates prepared selectors. Earlier 5a-5c assertion migrations remain. |
| rpc test/peer-readmission.test.ts; peer-rejoin-record.test.ts | 1b readmission fields; 6b rejoin-record legacy narrowing; 14b record semantics/activation. |
| mls-rpc test/fixtures/{codec-reopen,registry,registry-recovery}.ts | 1a legacy types; 7 gives `createRegistryRecovery` an explicit `format:'legacy'\|'captured'` option (registry-verdict legacy rows pin `'legacy'`); 14a dual genuine builders; 14b flips only the `fixtures/registry.ts` default. |
| mls-rpc test/{registry-switch,registry-delete,registry-retirement-writes,storage-codec-reopen}.test.ts | 1b snapshot, 6b switch/retirement discrimination and codec legacy narrowing, 14a captured fixtures, 14b activation rerun. |
| integration recovery-requester-restart.test.ts:85; anchor-rotation-recovery.test.ts:442 | 1a restart legacy type, 6b loaded-record narrowing, 14a dual setup, 14b active captured restart/rotation. |
| rpc README.md | 18 documents the promoted contract. |

Task 14a prepares rpc control-store:62, peer-control-settlement:59, peer-durable-effects:337,475, peer-startup-order:210,270 and peer-safety-recovery:346.
It also prepares mls-rpc fixtures/codec-reopen.ts:114. Task 14b reruns every prepared consumer, preserving acceptance/epoch/convergence assertions.

T2 storage/reader closure uses HEAD grep `RejoinRecord|buildRejoinRecord|putRejoin|[.]rejoin([^[:alnum:]_]|$)|ControlSnapshot`: 305 matches across 53 files.
Two MLS matches are `kumiai.rejoin-confirm` domain strings, not storage readers. Task 6b changes exactly 17 files below.

| HEAD stored-record reader/type coordinates | Task 6b treatment |
| --- | --- |
| rpc src/control/types.ts:48,64,91-95; store.ts:334,363-385; rpc-conformance src/control-store.ts:92,108,133,1396,1527-1538; memory-control-store.ts:325-332 | Widen real/mirrored load/apply fields. Discriminate both formats before copying, retaining common-field settlement/readmission semantics. |
| rpc src/control/rejoin.ts:28,128-129; peer.ts:2272-2279,2322-2342,2996-2998,3107-3111,3352-3354,3448-3512,3669-3675,3711-3760,3873-3878,3968-3974,4179 | Narrow legacy orchestration before stepRejoin, source scan, candidate restore or deletion. Shared barrier/bootstrap/readmission reads preserve either format. |
| mls-rpc src/registry/switch.ts:61,113-128,159-163,230-235; verdict.ts:75,121-128; retired.ts:92-111; memory-incarnation-stores.ts:504 | Discriminate saved formats before proof/codec/source reads. Preserve legacy acceptance and adopted continuation bytes. Task 7 adds captured verification/switching. |
| rpc test/peer-rejoin-record.test.ts:643-649,694-697,741-752; integration recovery-requester-restart.test.ts:85-90; mls-rpc test/storage-codec-reopen.test.ts:12-25,39,49,78-84 | Explicit legacy narrowing at typed observations and legacy decoder/source reads, preserving acceptance/restart/convergence. |
| rpc test/control-store.test.ts:18,62; mls-rpc test/{registry-switch,registry-verdict,registry-retirement-writes}.test.ts | Both-format persistence/narrowing witnesses and unchanged live legacy acceptance. Every test-side `RejoinRecord`-annotated legacy literal (control-store.test.ts:18,62 included) is retyped `LegacyRejoinRecord` here; 6b's gate reruns a repo-wide `: RejoinRecord` annotation grep so 14b's alias promotion is type-neutral. |

Other grep hits use common fields, type-only/pass-through snapshots, legacy producers or equality assertions. Audit them unchanged with repo-wide types/full gates.
This includes registry/delete assertions, conformance registry.ts and fixture signatures. No cast or legacy-record fabrication closes a reader.

## Stages and gates

26 green units, 8 serial stages. Counts below are distinct planned changed files per unit, including tests and creates.
Brace lists expand to concrete paths. Unchanged audit/gate files do not count. Shared files intentionally recur in serial units.

| Stage | Units (files each) | Boundary |
| --- | --- | --- |
| 1 Foundation | 1a (25) → 1b (16) | Additive declarations, then required snapshot/provider closure. |
| 2 Primitives | 2 (11) → 3 (13) → 4 (8) | Reply/trust, entry control access, synchronous local sinks. |
| 3 Diagnostics | 5a (20) → 5b (19) → 5c (17) → 5d (10) → 5e (12) | Past divergence, own/search, versions, real mappings, caught-up app bounds. |
| 4 Persistence | 6 (8) → 6b (17) → 7 (20) | Origin codec, stored-record union/readers, bound proof and restricted switches. |
| 5 Recovery APIs | 8a (18) → 8b (18) → 9 (13) → 10 (25) → 11 (24) → 12 (20) | Recognition, refusal authority, constructors and additive captured port. |
| 6 Capture/lifecycle | 13 (15) → 15 (9) → 16 (11) → 17 (12) | Captured responder, continuation, coordinator and live safety. |
| 7 Activation | 14a (17) → 14b (25) | Additive fixture preparation, then atomic production/mirror activation. |
| 8 Final | 18 (12) | Integration witnesses, documentation and full gates. |

Keep the complete live legacy producer, one-argument sealing and acceptance path through Stage 6.
Task 6b enables captured storage before Task 7. Production selection, public RejoinRecord promotion and legacy stops remain Task 14b.
Tasks 10/11 migrate constructor callers, retaining genuine legacy ControlSource facts through a private adapter.
Tasks 12/13 implement captured APIs beside legacy APIs. Neither redirects production recovery nor stops newly generated legacy records.
Tasks 15/16/17 prepare lifecycle/live safety. Task 14a prepares fixtures additively. Task 14b activates callers and the legacy policy together.
Compatibility helpers retain explicit legacy names/types. No active requester then produces legacy records.
Preserve actual acceptance, epoch advancement and convergence assertions (`rpc-conformance/src/group-mls.ts:1143-1180`, integration `lifecycle-recovery.test.ts:199-218`).
No intermediate GREEN may replace those assertions with stops/skips. Each task carries its own checks and consumes only prior-stage capabilities.

All commands below are future implementation checks. This document revision runs only static verification.
Run each task's named Vitest files with `rtk proxy pnpm --filter @kumiai/<package> exec vitest run <files>`.
Then run `rtk proxy pnpm --filter @kumiai/<package> run test:types` for each tested package. PASS is required.
RED means the specified behavioural assertion fails. Integration witnesses may start green and require sensitivity checks instead.

**Build/type gate:** every exported change runs both commands.
```bash
rtk proxy pnpm turbo run build:js build:types
rtk proxy pnpm turbo run test:types
```

**Control gate:** Tasks 1a/1b/3/5a-5e/6/6b/7/8a/8b/12/14a/14b/15/16 and any ControlStore/rejoin change.
Task 1a runs the explicit pre-runner Control command below, excluding the file Task 1b creates:
```bash
rtk proxy pnpm --filter @kumiai/rpc exec vitest run test/control-store-conformance.test.ts test/commit-once-conformance.test.ts
rtk proxy pnpm --filter @kumiai/rpc run test:types
rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/control-crash.test.ts
rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
```
Task 1b creates the real persistence runner. From 1b onward, run both real and double:
```bash
rtk proxy pnpm --filter @kumiai/rpc exec vitest run test/control-store-conformance.test.ts test/commit-once-conformance.test.ts
rtk proxy pnpm --filter @kumiai/rpc run test:types
rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/control-store-conformance.test.ts test/control-crash.test.ts
rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
```

**Safety gate:** Tasks 4/5a-5e/7/8a/8b/9/12/14b/16/17 and any safety change.
```bash
rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/control-safety-conformance.test.ts test/safety-conformance.test.ts
rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
```

**Port gate:** Tasks 1a/1b/2/3/5a-5e/6b/7/8a/8b/9/10/11/12/13/14a/14b/15/16/17 and every GroupMLS/peer-port change.
Run both contract families against every implementation and double, including transactional-real MLS and store/wire hubs.
```bash
rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/ports-conformance.test.ts test/ports-conformance-transactional.test.ts test/registry-conformance.test.ts
rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
rtk proxy pnpm --filter @kumiai/rpc exec vitest run test/ports-conformance.test.ts test/hub-conformance.test.ts
rtk proxy pnpm --filter @kumiai/rpc run test:types
rtk proxy pnpm --filter @kumiai/hub-server exec vitest run test/conformance.test.ts test/log-hub-conformance.test.ts
rtk proxy pnpm --filter @kumiai/hub-server run test:types
rtk proxy pnpm --filter @kumiai/hub-store exec vitest run test/conformance.test.ts
rtk proxy pnpm --filter @kumiai/hub-store run test:types
rtk proxy pnpm --filter @kumiai/integration-tests exec vitest run test/hub-log-conformance.test.ts
rtk proxy pnpm --filter @kumiai/integration-tests run test:types
```

## Tasks

### Task 1a: Add portable contracts and preserve legacy aliases

**Consumes:** HEAD legacy types/store invariants. **Produces:** additive captured declarations, explicit legacy aliases and independent mirrors.
**Files (25):** Create `packages/rpc/src/recovery-types.ts`. `packages/rpc/test/recovery-types.test.ts`.
Modify `packages/rpc/src/control/{types,store,rejoin}.ts`. `packages/rpc/src/{peer,index,crypto,host-boundary}.ts`. `packages/rpc-conformance/src/{control-store,memory-control-store,persistence-fixture,index,group-mls,registry-fixture}.ts`. `packages/rpc/test/fixtures/memory-group-mls.ts`. `packages/mls-rpc/src/index.ts`. `packages/mls-rpc/src/registry/{types,source,verdict,switch,retired}.ts`. `packages/mls-rpc/test/registry-source.test.ts`. `packages/mls-rpc/test/fixtures/registry-recovery.ts`. `tests/integration/test/recovery-requester-restart.test.ts`.

**Interfaces:** rpc owns `RecoverySource<TTrust = unknown> = AdoptionExpected & { trust:TTrust; trustDigest:string; lifetimeRevision:number }`.
RecoveryTargetCapture contains targetID/topicID, groupInfoEpoch, groupInfoAuthenticator and captureHead.
`ResyncProof = RecoveryTargetCapture & { position:LogPosition; payloadDigest:string; verdict:Uint8Array }` retains non-null bound confirmation.
mls-rpc specialises RegistryRecoverySource and re-exports portable ResyncProof. Preserve HEAD shapes as LegacyRegistryRecoverySource/LegacyResyncProof.
Keep RejoinRecord as the legacy alias until 14b. Add CapturedRejoinRecord/StoredRejoinRecord. Task 6b widens storage/readers before Task 7.
Rename rpc control/rejoin.ts:16's local RecoverySource to SourceScanIdentity. Task 7 supplies genuine trustDigest, never fabricated legacy metadata.
CapturedRejoinRecord retains digest/payloadDigest and adds format:2, portable source, target, captureHead/searchFrom, trigger/authorisationID, switchMutationID/destinationKey.
AcceptedRejoinSettlement contains kind/id/digest/payloadDigest/epochAfter/acceptedEpoch, public origin, exact LeafNode digest and ledgerBefore. It contains no saved record/secrets.
Public origin is `{sourceKey:GroupKey;target:RecoveryTargetCapture;searchFrom:LogPosition|null}`. `leafDigest` hashes exact wire-encoded LeafNode bytes with SHA-256/base64url.
ControlSnapshot adds optional recoveryEpochFloor/settledRejoins. ControlChanges adds recoveryEpochFloor/putSettledRejoins, with one cumulative row per incarnation.
Declare Task 12's captured port/reconciliation and r19's handoff/continuation/completion contracts additively on GroupMLS.

- [ ] Test capture head null/opaque validation, defensive source copies, immutable origin, assign-once switch ID and nondecreasing floor.
- [ ] Add portable rpc/mirror mutual-assignability and opaque-trust type witnesses. Preserve legacy bytes/stages and active acceptance.
- [ ] Give integration recovery-requester-restart.test.ts:85 an explicit legacy record type until captured activation. Preserve restart/convergence assertions.
- [ ] Run rpc recovery-types/control-store tests RED with paired types. Implement additive declarations and explicit aliases.
- [ ] Run the explicit pre-runner Control command, Port/build/type gates GREEN before the 1a commit.

### Task 1b: Promote snapshot fields across real storage and doubles

**Consumes:** Task 1a optional floor/settlement declarations. **Produces:** required snapshot fields and normalised real/double persistence.
**Files (16):** Create `packages/mls-rpc/test/control-store-conformance.test.ts`.
Modify `packages/rpc/src/control/{types,store}.ts`. `packages/rpc-conformance/src/{control-store,memory-control-store,persistence-fixture}.ts`. `packages/mls-rpc/src/memory-incarnation-stores.ts`. `packages/rpc/test/fixtures/{host-db,peer}.ts`. `packages/mls-rpc/test/fixtures/transactional-access.ts`. `packages/rpc/test/{control-store,control-safety-fields,peer-fork-settlement,peer-readmission}.test.ts`. `packages/mls-rpc/test/{registry-switch,storage-fixture}.test.ts`.

**Interfaces:** ControlSnapshot requires `recoveryEpochFloor:number|null` and `settledRejoins:Array<AcceptedRejoinSettlement>`.
Fresh snapshots and old persisted snapshots normalise missing fields to null/[], preserving saved record bytes and existing floor values.
Both applyChanges implementations copy public settlement fields defensively and union prior ledgerBefore into at most one row.
Legacy storage signatures remain until 6b. The public legacy alias/producers remain until 14b. Run the contract on real persistence and the strict double.

- [ ] Test fresh/legacy snapshots, defensive settlement copies, bounded cumulative obligations and monotone floor without record rewrites.
- [ ] Migrate exact snapshot literals in control-store, control-safety-fields, peer-fork-settlement, peer-readmission and registry-switch tests together.
- [ ] Set peer-readmission.test.ts:20-122 floor/settlements to null/[] and preserve expectReset:125 against normalised load. Record semantics remain 14b.
- [ ] Create mls-rpc control-store-conformance.test.ts using the real provider, including old persisted snapshot normalisation.
- [ ] Run named snapshot/contract tests RED. Promote all listed producers/fixtures/mirrors to required fields.
- [ ] Run real/double Control, Port/build/type gates GREEN. Recheck every ControlSnapshot literal before the 1b commit.

### Task 2: Add reply-v2 and retained-trust primitives

**Consumes:** retained trust and Task 1a capture contract. **Produces:** reply-v2/trust authentication and additive sealing primitives.
**Files (11):** Create `packages/mls/src/recovery-trust.ts`. `packages/mls/test/{recovery-capture-head,recovery-trust}.test.ts`.
Modify `packages/mls/src/{recovery,recovery-verdict,index}.ts`. `packages/mls/test/{recovery,recovery-forgery,recovery-ledger,recovery-verdict}.test.ts`. `packages/mls/test/fixtures/history-probe.ts`.

**Interfaces:** `RecoveryTrustInputs` contains groupID/genesisAnchor/signerTree/registry/credential/binding/ledger/ciphersuiteName.
`createRecoveryRequestFromTrust({trust,identity,requestID,deadlineMs?})` returns Promise<{request:string;requestKey:Uint8Array}>.
`authenticateRecoveryReply({trust,sealed,requestID,requestKey,options})` returns Promise<RecoveryGroupInfo|null>.
`openRecoveryVerdictFromTrust` takes the same inputs and returns Promise<OpenedRecoveryVerdict>. MLS imports no rpc types.
Add `sealCapturedGroupInfo(params: SealGroupInfoParams & {captureHead:string|null}): Promise<Uint8Array>` beside isolated legacy sealing.
Captured RecoveryGroupInfo requires captureHead/groupInfoAuthenticator. Keep complete v1 callers/results live until Task 14b activation.

- [ ] Test exact opaque/null head and committed authenticator round-trip in the signed reply. Canonical JWT sorts captureHead before groupID.
- [ ] Test v1/missing/wrong-type/empty/overlong/tampered head, wrong domains and invalid authenticator refuse before build.
- [ ] Test retained trust request/reply/verdict authentication without private state. Wrong group/signer/anchor/binding/floor/denial refuses.
- [ ] Test ledger-only replies remain v1 and cross-kind refusal persists. Provider/policy I/O retains its error identity.
- [ ] Run mls `test/recovery-capture-head.test.ts test/recovery-trust.test.ts test/recovery-forgery.test.ts test/recovery-ledger.test.ts` RED.
- [ ] Implement additive captured primitives using existing authentication/codec boundaries, then run GREEN and mls test plus Port/build/type gates.

### Task 3: Supply entry-bound ordinary control access

**Consumes:** Task 1a source identities and existing entry reads. **Produces:** entry-bound ControlHandleAccess/loadControl.
**Files (13):** Create `packages/mls-rpc/src/registry-handle-access.ts`. `packages/mls-rpc/test/registry-consumer-access.test.ts`.
Modify `packages/mls-rpc/src/{access,control-build,control-adoption,index}.ts`. `packages/mls-rpc/src/registry/access.ts`. `packages/mls-rpc/test/fixtures/transactional-access.ts`. `packages/mls-rpc/test/{control-build,control-adoption,registry-access,transactional-access,ports-conformance-transactional}.test.ts`.

**Interfaces:** `ControlHandleAccess = Pick<HandleAccess,'epoch'|'admission'|'read'|'readControl'|'mutate'|'replace'>`.
`createRegistryHandleAccess({access:RegistryHandleAccess}):ControlHandleAccess` exposes no synthetic open.
`ControlReadScope.loadControl(control?:ControlStore):Promise<ControlSnapshot>` uses entry reads for registry scopes.
Foreign supplied key throws DisplacedGroupHandleError. Simple/transactional scopes use the real supplied store and refresh-equivalent expiry.
Ordinary adoption may select a mutation ID. Recovery adoption later requires saved switchMutationID.

- [ ] Test registry build has no nested root control load/transition. Foreign keys refuse before reading. Retained loadControl expires after await/release.
- [ ] Test head-only retry keeps prepared bytes and invokes builder/sealer once. Ordinary installed/noop/moved adoption preserves receive progress.
- [ ] Test factory-selected mutation ID binds state/trust/control/marker under rollback and ambiguity. Missing ID refuses unchanged.
- [ ] Run mls-rpc `test/registry-consumer-access.test.ts test/control-build.test.ts test/control-adoption.test.ts test/transactional-access.test.ts` RED.
- [ ] Capture/seal once in Read, release, then save. Reacquire fresh Read for retry. Use registry.adopt for ordinary journals.
- [ ] Run GREEN, transactional port tests and Control/Port/build/type gates. Preserve existing journal/slot proof guards.

### Task 4: Push keyed local safety latches synchronously

**Consumes:** existing validated local safety and exact incarnation keys. **Produces:** synchronous keyed sink/retirement registration.
**Files (8):** Create `packages/mls-rpc/src/registry/consumers.ts`. `packages/mls-rpc/test/registry-live-safety.test.ts`.
Modify `packages/mls-rpc/src/registry/{registry,safety,runtime}.ts`. `packages/mls-rpc/test/{group-safety,registry-safety-admission,registry-runtime}.test.ts`.

**Interfaces:** Private registered capability supplies `onSafetyHold(key,latch):()=>void`, `onRetire(key,hook):()=>void` and `safetyHold(key):SafetyHold`.
Registration immediately supplies the current reason. Subscriptions belong to exact incarnation keys and survive owner-cache invalidation.
Only validated host reports/local trust loss and saved local safety fields invoke sinks. D0 forbids delivered faults from doing so.

- [ ] Test host fork report pushes before proof. Failed seal/rollback still gates live sinks with zero committed event. Repeat local trust loss.
- [ ] Test invalid/moved reports never push, late subscriber sees reason, fork dominates unavailable and foreign incarnation cannot gate n+1.
- [ ] Test throwing sink cannot change transaction outcome or suppress other sinks. Reject foreign registry bindings.
- [ ] Run mls-rpc `test/registry-live-safety.test.ts test/group-safety.test.ts test/registry-safety-admission.test.ts test/registry-runtime.test.ts` RED.
- [ ] Push restricted memory-only sinks at latch assignment. Release ownership before host notifications. Unsubscribe at disposal.
- [ ] Run GREEN, Safety/build/type gates in both registry fixture modes and ownership-context variants.

### Task 5a: Make competing past commits diagnostic poison

**Consumes:** D0/D3 and Task 4 local sinks. **Produces:** both past-divergence branches skip/advance without applied rewrite or frame-triggered resync.
**Files (20):** Create `packages/rpc/test/peer-divergence-poison.test.ts`.
Modify `packages/rpc/src/{classify,peer,peer-types}.ts`. `packages/rpc/test/{commit-classify,peer-durable-effects,peer-final-fixes,peer-fork-settlement,peer-control-search-walk,peer-commit-log-replay,peer-strand-observation,peer-locked-commit-epoch,peer-recover-lane,peer-fork-halt,peer-recovery,peer-failed-heal-strand,peer-delayed-bootstrap}.test.ts`. `tests/integration/test/{fork-halt,recovery-confirmation}.test.ts`. `tests/integration/test/fixtures/fork-halt.ts`.

**Interfaces:** Classifier/StrandKind adds claimed `past-epoch-divergence`. Existing fork names remain readable compatibility types.
All delivered-competitor halt/frozen-cursor assertions migrate in this unit. Host/persisted/local-invariant halt coverage remains.
Shared tests keep own/version rows unchanged until their later owner. Integration persistence tests use explicit host reports or seeded historical halts.

- [ ] Test signed refused CAS losers, both orderings and forged copies: cursor progresses, no halt/latch/event/strand/heal, history/outcomes/Welcomes survive.
- [ ] Migrate restart/history/reconstruction assertions in the listed rpc tests and stale-GroupInfo/fork integration rows together.
- [ ] Preserve real stale-external rejection, survivor progress and unchanged applied history in recovery-confirmation.test.ts:389-477.
- [ ] Run listed rpc/integration tests RED. Replace past-divergence classify/peer mappings only.
- [ ] Run those tests, full rpc/integration suites and Control/Safety/full Port/build/type gates GREEN. Mutation-check the delivery-halt guard.

### Task 5b: Keep own-slot/search contradictions retryable

**Consumes:** 5a poison/progress and retained ordinary slot state. **Produces:** no delivery-derived own halt or terminal retry barrier.
**Files (19):** Modify `packages/rpc/src/peer.ts`. `packages/rpc/src/control/{search,slot,operations}.ts`. `packages/rpc/test/{control-search,control-slot,control-operations,peer-control-retry,peer-rejoin-record,peer-cursor-table,peer-failed-heal-strand,peer-strand-observation,peer-locked-commit-epoch,peer-recover-lane,peer-fork-halt,peer-fork-settlement,peer-app-cursor}.test.ts`. `packages/mls-rpc/test/control-validation.test.ts`. `packages/rpc/test/fixtures/control-hold.ts`.

**Interfaces:** Own-unmerged/search/slot mismatches skip/advance, preserving payload/ID/journal/candidate/key/tuple and owed work.
Unchanged ordinary incarnation/epoch/authenticator permits identical bytes/ID at a fresh head, including a tampered named-entry copy.
Search mismatch never certifies absence/supersession. Unresolved deadline outcome is unknown. Recovery recapture remains separately additive.
Retain trusted local epoch-authenticator halts in slot.ts:94-110 and search.ts:242-252.
Audit store.ts:267-327 unchanged: saved host/historical safety is immutable. Required payloadDigest fields remain.

- [ ] Migrate every listed orphaned-own, slot/applied-row and search-halt assertion to poison/progress with retained work and restart coverage.
- [ ] Migrate peer-app-cursor.test.ts:85-140 own-commit halt assertions to poison/progress, preserving both restarts and app-cursor/key-spend coverage.
- [ ] Migrate mls-rpc control-validation.test.ts:904,1036 search-derived halt assertions now, before 5d changes direct validation mappings.
- [ ] Test tampered own named-entry copy, identical retry and receiver application. No lost/absent/superseded verdict or second build.
- [ ] Test copy mismatch at deadline yields unknown. Preserve owed outcomes/Welcomes and host/local-invariant halt tests.
- [ ] Run listed rpc/mls-rpc tests RED. Remove delivery-derived halt/retry barriers while retaining local identity checks.
- [ ] Run those tests, full rpc/mls-rpc suites and Control/Safety/full Port/build/type gates GREEN.

### Task 5c: Complete unknown commit and sealed-entry versions as poison

**Consumes:** 5a/5b progress and typed version errors. **Produces:** upgrade-required diagnostics, cursor advance and no strand/heal.
**Files (17):** Modify `packages/rpc/src/{classify,peer,ledger-entries}.ts`. `packages/rpc/src/control/search.ts`. `packages/mls-rpc/src/crypto.ts`. `packages/rpc/test/{commit-classify,ledger-entries,control-search,peer-unknown-frame-version,peer-unknown-commit-frame-version,peer-locked-commit-epoch,peer-fork-halt,peer-control-settlement,peer-strand-observation}.test.ts`. `packages/mls-rpc/test/{crypto,control-validation}.test.ts`. `packages/rpc/test/fixtures/control-hold.ts`.

**Interfaces:** Unsupported handshake/commit-frame/sealed-entry outer/inner versions skip as poison, never new ControlHold or authoritative refusal.
Keep persisted unsupported-version holds readable/immutable. Task 8a follows these ledger-entries edits.

- [ ] Migrate unknown-header/frame hold/frozen-cursor tests, including failed hold-write, suspended-fetch and restart assertions in this unit.
- [ ] Test real crypto -> resolver -> peer sealed-entry version failures advance, preserving slot/outcomes/Welcomes with no strand/heal.
- [ ] Preserve an already latched host halt during suspended fetch; diagnostic delivery must neither replace it nor advance through it.
- [ ] Run listed rpc/mls-rpc tests RED. Propagate typed diagnostics through crypto/resolver/search/walker.
- [ ] Run those tests, full rpc/mls-rpc suites and Control/Safety/full Port/build/type gates GREEN.

### Task 5d: Pin real validation and local-only registry safety mappings

**Consumes:** 5b/5c diagnostic search consumers. **Produces:** exact real copy-failure mappings and retained host/local registry boundaries.
**Files (10):** Modify `packages/mls-rpc/src/control-validation.ts`. `packages/mls-rpc/test/{control-validation,control-safety-conformance,control-safety-inputs,group-safety,registry-safety-admission,registry-access,registry-retired,registry-retirement-writes}.test.ts`. `tests/integration/test/control-adoption-race.test.ts`.

**Interfaces:** control-validation.ts:43-82,213-278 maps delivered framing/resolver/own-copy failures to diagnostic invalid/poison, preserving provider error identity.
Audit unchanged safety.ts:71-93,123-180 and registry/{safety,access,registry,retired}.ts at the HEAD table coordinates.
These guards read local trust, persisted safety or explicit host reports. None inspects delivered bytes to infer trust loss or a new hold.
control-adoption-race.test.ts:65 is an injected persisted hold. Preserve its refusal assertion and add a delivered-poison progress witness.

- [ ] Test direct own/frame/resolver failures cannot manufacture hard holds or retained-trust loss. Keep missing local trust/host reports immutable.
- [ ] Preserve seeded control-adoption/build/safety/registry refusals and owed retired work. Never weaken convergence or skip tests.
- [ ] Run listed mls-rpc/integration tests RED. Implement only the control-validation mapping changes identified above.
- [ ] Run those tests, full mls-rpc/integration suites and Control/Safety/full Port/build/type gates GREEN.

### Task 5e: Bound future app frames and complete version poison

**Consumes:** D0 and existing app completed-prefix/cursor storage. **Produces:** bounded future waits and completed diagnostic poison occurrences.
**Files (12):** Modify `packages/rpc/src/{app-lane,peer}.ts`. `packages/rpc/test/{future-epoch-retention,peer-app-drain-integrity,durable-stall,durable-drain,peer-app-cursor,peer-locked-app-epoch,peer-dispose-continuations,app-lane-safety}.test.ts`. `tests/integration/test/app-lane-delivery.test.ts`. `tests/integration/test/app-lane-e2e.ts`.

**Interfaces:** app-lane.ts owns `APP_FUTURE_EPOCH_WINDOW = 2` and `APP_FUTURE_HOLD_MS = 30_000`.
AppLaneParams adds optional `commitLaneCaughtUp:()=>boolean`, defaulting true for direct lanes without a commit lane. peer.ts supplies it and calls the lane's existing `retryDelivery()` (app-lane.ts:611) on every not-caught-up to caught-up transition, so the age clock starts and expiry is scheduled without further traffic. Test: catch-up with no later commit/app traffic starts the clock and poisons a held far-future claim at 30,000 ms.
Catch-up means no applicable unapplied commit through the commit lane's observed head. Invalidate it before new commit work.
Before catch-up, future frames hold as at HEAD, regardless of claimed epoch or elapsed time. Apply bounds only while caught up.
Then hold only when claimed epoch <= locked local epoch + 2 and age < 30,000 ms.
Start caughtUpAt when the commit lane first catches up after the future occurrence arrives, using local monotone time.
Future occurrences arriving while caught up start age at observation. Duplicate/refetched copies preserve it.
Use FrameEpochError.handleEpoch as the locked local epoch, never crypto.epoch() hints. Schedule expiry without requiring another incoming frame.
Recheck catch-up before expiry poison. Wake held occurrences after catch-up and try opening before applying future-frame bounds.
Restart permits a fresh bounded wait. Committed poison/completed cursors remain durable and are never reopened.
Crossing either bound completes diagnostic poison. Unsupported outer app versions likewise complete poison without decrypting or invoking a handler.
HEAD lane records poison completion through frame.sealed=done and the durable completed-prefix cursor write, using existing AppCursorStore.save.
The later registry-crypto AppPoisonRecord contract uses keyConsumed:false before completion. Full registry crypto remains owned by 2.3.
Local storage ambiguity advances nothing until proof. Earlier genuine pending records still block the prefix. Local host safety remains authoritative.

- [ ] Migrate far-future/operator-drop assertions in future-epoch-retention, peer-app-drain-integrity and durable-stall to automatic poison/progress.
- [ ] Test caught-up window boundary +2 holds, +3 poisons. Test 29,999 ms holds and 30,000 ms expires without new traffic.
- [ ] Extend peer-app-drain-integrity.test.ts:98-145 to honest lag >2 epochs. All frames deliver after catch-up, preserving cursor order.
- [ ] Test >30 seconds behind starts no hold-age clock. Catch-up starts age at zero; subsequent commit lag suspends bound enforcement.
- [ ] Test duplicate/refetch cannot renew age. Restarted near-future waits expire within 30 seconds; committed poison survives cursor reconstruction.
- [ ] Preserve honest near-future delivery within bounds, pending/key-spend atomicity, handler absence and completed-prefix ordering.
- [ ] Run listed rpc/integration tests RED. Apply the bounds across retained/live occurrence paths and retry/disposal scheduling.
- [ ] Run those tests, full rpc/integration suites and Control/Safety/full Port/build/type gates GREEN.

### Task 6: Persist authenticated origins and candidate v3

**Consumes:** Tasks 1/2 immutable captured origin. **Produces:** v3 codec, record validation and trust digest.
**Files (8):** Create `packages/mls-rpc/src/{recovery-record,recovery-trust-digest}.ts`. `packages/mls-rpc/test/recovery-record.test.ts`.
Modify `packages/mls-rpc/src/{recovery-codec,persistence-codec}.ts`. `packages/mls-rpc/test/{recovery-codec,recovery-codec-format,storage-codec-reopen}.test.ts`.

**Interfaces:** CapturedRecoverySnapshot adds source/target/captureHead/searchFrom/attestedReply to existing candidate/request/bound-commit fields.
`encodeCapturedRecoveryCandidate(snapshot,requestKey):Uint8Array` and `decodeCapturedRecoveryCandidate(bytes,requestKey):CapturedRecoverySnapshot` are additive.
`recoveryTrustDigest(trust:GroupRecoveryTrust):string` hashes canonical public trust with `kumiai/recovery-trust/v1` length-prefixed SHA-256/base64url.
Use base64url bytes, unsigned decimal bigint, encoded sorted DeviceRegistry, sorted object keys, array order and null sparse-tree slots.
`decodeRecoveryRecord(value:unknown)` returns explicit captured/legacy discrimination. `validateCapturedRecoveryRecord(record):void` validates immutable associations.
Keep complete sourceState and live v2 producers isolated until Task 14b. No v3 fallback to old formats. R0 requires no candidate-codec change.

- [ ] Test reordered equivalent trust hashes equally. Changed authority/key/ledger/spent facts differ. Include bigint lifetimes and sparse trees.
- [ ] Measure full sealed record/candidate size, including duplicated trust/sourceState and the 43-character trustDigest. Test digest validation before use.
- [ ] Test source/target/authenticator/capture/search survive sealed reopen. Wrong origin/target/candidate identity and v1/v2/tampering refuse.
- [ ] Test every legacy stage with null/non-null conflictEpoch retains bytes. Manual shape decodes but stops until 2.2e.
- [ ] Test confirmed co-writes switchMutationID. Defensive existing confirmed+null remains decodable for startup assignment.
- [ ] Run mls-rpc `test/recovery-record.test.ts test/recovery-codec.test.ts test/recovery-codec-format.test.ts test/storage-codec-reopen.test.ts` RED.
- [ ] Implement v3 codec and validation without byte splicing. Decoder performs no publication/adoption/cleanup. Run GREEN, Control/build/type gates.

### Task 6b: Widen captured storage and close every record reader

**Consumes:** Tasks 1a/1b/6 additive formats, normalised snapshots and captured codec. **Produces:** real/mirrored StoredRejoinRecord persistence and explicit reader discrimination.
**Files (17):** Modify `packages/rpc/src/control/{types,store,rejoin}.ts`. `packages/rpc/src/peer.ts`. `packages/rpc-conformance/src/{control-store,memory-control-store}.ts`. `packages/mls-rpc/src/memory-incarnation-stores.ts`. `packages/mls-rpc/src/registry/{switch,verdict,retired}.ts`. `packages/rpc/test/{control-store,peer-rejoin-record}.test.ts`. `packages/mls-rpc/test/{registry-switch,registry-verdict,registry-retirement-writes,storage-codec-reopen}.test.ts`. `tests/integration/test/recovery-requester-restart.test.ts`.

**Interfaces:** ControlSnapshot.rejoin becomes `StoredRejoinRecord|null`. ControlChanges.putRejoin becomes `StoredRejoinRecord`.
ControlStore.load/apply and independent conformance contracts expose that union. Real storage and the strict memory double preserve both formats exactly.
Captured records have format:2. Legacy records lack format. Discriminate before format-specific source, candidate, proof or orchestration reads.
`rejoinBarrier(record:StoredRejoinRecord|null):LogPosition|null` reads common fields. RejoinDeps and sourceRecheck retain explicit legacy inputs.
`stepRejoin(deps:RejoinDeps,record:LegacyRejoinRecord):Promise<StoredRejoinRecord|null>` preserves any replacement returned by its stored reread.
Peer callers narrow before invoking legacy steps, scans, restores or deleting refused records. Captured records remain durable without legacy processing.
switch.ts confirmedRecord accepts/returns StoredRejoinRecord, including replay:113-128 and both reads:159-162,230-233.
verdict.ts dispatches by format before legacy source/codec access. Legacy verification/acceptance stays live; Task 7 supplies captured verification/switching.
retired.ts and memory storage preserve both adopted formats. Common-field settlement/readmission operations retain their existing semantics.
RejoinRecord remains the public legacy alias. No live producer selection or legacy stop policy changes before 14b.

- [ ] Test real/double load/apply/reopen round-trips both formats with exact bytes and defensive copies, without casts or fabricated legacy source fields.
- [ ] Test format discrimination across switch replay/read/work, verdict decoding, retirement and memory adopted-record retention.
- [ ] Narrow peer-rejoin-record observation arrays and requester-restart/codec-reopen legacy readers without weakening acceptance/restart/convergence.
- [ ] Test stored captured records never enter legacy step/scan/restore/refused deletion. Preserve bytes while captured execution awaits Tasks 7/15/16.
- [ ] Keep live legacy switch, acceptance, bootstrap and retirement witnesses GREEN. Add persistence/dispatch witnesses before widening.
- [ ] Run all listed tests and real/double Control/full Port/build/type gates GREEN before committing. Task 7 consumes this storage contract.

### Task 7: Bind confirmed proof and restricted switch writes

**Consumes:** Tasks 1/3/6 source/codec, 6b stored union/discriminated readers and existing bound verdict. **Produces:** captured restricted saved-ID switch factory/verifier and typed movement.
**Files (20):** Create `packages/mls-rpc/src/registry/switch-write.ts`. `packages/mls-rpc/test/registry-switch-write.test.ts`.
Modify `packages/mls-rpc/src/registry/{types,verdict,switch,retired,source,source-trust,trust,access,registry}.ts`. `packages/mls-rpc/src/{persistence-errors,index}.ts`. `packages/rpc-conformance/src/{registry-fixture,persistence-fixture}.ts`. `packages/mls-rpc/test/fixtures/registry-recovery.ts`. `packages/mls-rpc/test/{registry-verdict,registry-switch,registry-retirement-writes,registry-source}.test.ts`.

**Interfaces:** `RegistryRecoverySource = RecoverySource<GroupRecoveryTrust>` computes Task 6's trustDigest. rpc mirrors remain portable.
`toRegistrySwitchWrite({record,write,staged}):RegistrySwitchWrite` accepts only adopted source rejoin and destination cursor with saved mutation ID.
`verifyRegistryResync({source,candidate,record,proof}):Promise<void>` reauthenticates origin/target and existing digest/position/verdict tuple under D1.
`createRecoverySwitchFactory(record):AdoptionWriteFactory` rejects null switchMutationID. RegistrySourceMovedError identifies expectation-only movement.

- [ ] Test independent target/topic/epoch/authenticator/head/reply/candidate/request/digest/position/verdict tampering causes zero writes.
- [ ] Test advanced offered membership/path succeeds from stale origin. Remove sourceTree === origin.trust.signerTree, retaining signer/floor/admission checks.
- [ ] Test digest != payloadDigest: proof.payloadDigest matches record.payloadDigest, bound tuple/verdict commitDigest matches record.digest/position.
- [ ] Correct `packages/mls-rpc/src/registry/verdict.ts:205-218` to use record.digest for tuple/tag, retaining saved-work payload binding.
- [ ] Test mapper rejects extra fields/anchorLanded. Install n+1 once: version1, senderHWM0, fresh anchor/cursor, empty history, spent append and destinationKey.
- [ ] Test rollback/replay uses same switchMutationID. Source history/evidence/outcomes/Welcomes survive. Suspended hook drain blocks retirement writes.
- [ ] Test ledgerBefore includes local in-flight/awaitingBootstrap obligations beyond origin trust.ledger; verification preserves the immutable saved union.
- [ ] Test only hooked StorageOutcomeUnknownError transfers settlement. Unhooked GroupStateUncertainError releases fence and remains proof-pending.
- [ ] Run mls-rpc `test/registry-switch-write.test.ts test/registry-verdict.test.ts test/registry-switch.test.ts test/registry-retirement-writes.test.ts` RED.
- [ ] Implement proof/restricted mapping and typed error. Defer proof-pending resolution to Task 16. Run GREEN, Control/Safety/Port/build/type gates.

### Task 8a: Recognise own copies with the receiver predicate

**Consumes:** Task 5c diagnostic resolver behaviour and receiver validation. **Produces:** ownCommitDigest/receiver recognition across real and mirror.
**Files (18):** Create `packages/mls/src/own-commit-digest.ts`. `packages/mls/test/own-commit-digest.test.ts`. `packages/mls-rpc/test/own-commit-copy.test.ts`.
Modify `packages/mls/src/index.ts`. `packages/mls-rpc/src/{mls,control-validation}.ts`. `packages/rpc/src/{crypto,host-boundary,peer,ledger-entries}.ts`. `packages/rpc/src/control/{search,slot}.ts`. `packages/rpc-conformance/src/group-mls.ts`. `packages/rpc/test/fixtures/memory-group-mls.ts`. `packages/mls-rpc/test/control-validation.test.ts`. `packages/rpc/test/{control-search,control-operations,ledger-entries}.test.ts`.

**Interfaces:** `ownCommitDigest(commit:Uint8Array):string|null` is the sole recognition helper, exposed by GroupMLS and its independent mirror.
Decode/re-encode only the MLS-message commit half before SHA-256/base64url. Null results never match. No global canonical intake gate.
No-entry blobs are ignored. Named entries use normal MLS validation and the receiver resolver/reference predicate under retained pre-state.
Keep saved-work digests and first-valid proof gates. searchOccurrence(fetch,from,payloadDigest) retains HEAD's found/absent/gap contract.

- [ ] Test re-encoded/blob-changed no-entry copies, including existing nonempty blobs. Malformed/two-null results never recognise work.
- [ ] Test valid swapped named-entry blobs recognise; failed resolver/reference checks skip/advance cursor, preserving slot/unknown acceptance.
- [ ] Test unsigned tags/encoding/blob mismatch never proves absence, supersession, refusal or rebuild. Preserve saved payload/ID/digests/tuple.
- [ ] Test tampered own named-entry copy -> identical bytes/ID retry -> real receiver applies once. Deadline remains unknown.
- [ ] Run mls own-commit-digest, mls-rpc own-commit-copy/control-validation and rpc control-search/ledger-entries tests RED with paired types.
- [ ] Share the receiver predicate and update own branches after Task 5c's ledger-entries changes. Leave competitor authentication/frame producers unchanged.
- [ ] Run GREEN and Control/Safety/Port/build/type gates.

### Task 8b: Preserve authenticated refusal authority through replay/cache

**Consumes:** Task 8a recognition and existing positive bound confirmation. **Produces:** refusalAuthority wire/record/replay/cache policy.
**Files (18):** Modify `packages/mls/src/recovery-verdict.ts`. `packages/mls/test/recovery-verdict.test.ts`. `packages/mls-rpc/src/{mls,recovery,control-validation}.ts`. `packages/rpc/src/{crypto,host-boundary,peer,recovery-confirmation}.ts`. `packages/rpc/src/control/{types,store}.ts`. `packages/rpc-conformance/src/{group-mls,control-store,memory-control-store}.ts`. `packages/rpc/test/fixtures/memory-group-mls.ts`. `packages/mls-rpc/test/control-validation.test.ts`. `packages/rpc/test/{recovery-confirmation,control-store}.test.ts`.

**Interfaces:** Negative response/verdict adds refusalAuthority:'authenticated-commit' only for authenticated commit MLS/policy refusal.
Missing/copy-derived provenance remains advisory in wire decoding, persisted responses, replay, caches and requester judgement.
Bound positive confirmation remains unchanged. R0 confirmation/settlement belongs to Task 14b.

- [ ] Test accepted external/lost ack plus signed blob-induced negative preserves X through replay/cache/restart.
- [ ] Test genuine authenticated-commit refusal remains authoritative; framing/resolver/eligibility failures and old negative rows never settle X adversely.
- [ ] Run mls recovery-verdict, mls-rpc control-validation and rpc recovery-confirmation/control-store tests RED with paired types.
- [ ] Gate refusal provenance at producers and every replay/cache consumer. Keep unproven superseded verdicts advisory.
- [ ] Run GREEN and Control/Safety/Port/build/type gates. Mutation-check the negative-authority guard, restore and rerun GREEN.

### Task 9: Add trust-secret derivation and registry constructor

**Consumes:** Tasks 2/3/4/6/7 primitives/control/sinks/registry writes. **Produces:** additive registry GroupMLS constructor and trust-secret derivation.
**Files (13):** Create `packages/mls-rpc/src/registry-group-mls.ts`. `packages/mls-rpc/test/{recovery-retained-trust,registry-recovery-consumer}.test.ts`.
Modify `packages/mls-rpc/src/{mls,recovery,index}.ts`. `packages/mls-rpc/src/registry/{source,trust}.ts`. `packages/mls-rpc/test/{recovery-secret,readme-persistence}.test.ts`. `packages/rpc/src/{crypto,host-boundary}.ts`. `packages/rpc-conformance/src/group-mls.ts`.

**Interfaces:** Add GroupMLSDependencies(control,identity-only readRecoverySource,recoveryAdoption?,onSafetyHold?,recoverySecretFromTrust?).
`RecoveryAdoptionDependencies` contains target/environment/trusted source reader and accept(candidate,{source,proof,write}):Promise<void>.
`createRegistryGroupMLS(params):GroupMLS` takes registry/key/recovery/target and required callable onConfirmedRecovery sink, as the r19 replacement for r18:767-769 defines.
`deriveRecoverySecretFromTrust(trust,options?):Promise<Uint8Array>` exactly matches mls.ts:129-136's extract/expand with 32-byte output.
Use encoded genesis anchor and `kumiai/recovery/v1`. Add dependencies alongside legacy plain constructor until Tasks 10/11 finish migration.
Add the two-argument sealing overload before Tasks 10/11 use it. Keep one-argument legacy sealing explicit until Task 14b.
Task 9 owns the live GroupMLS sealing declaration/overload. Task 12 delegates the captured port.
Two-argument sealing captures the real snapshot/cursor pair. Task 13 supplies complete-prefix proof before Task 14b activation.
Live reply decoding uses Task 2 primitives. Captured APIs remain additive until Task 14b; the legacy producer/acceptance path stays complete.

- [ ] Test null/corrupt private state opens no old handle during request/authentication. Wrong trust/group/binding/floor refuses.
- [ ] Test live/trust secret bytes and commit/rendezvous topics match. Custom secret without trust derivation throws construction TypeError, zero holds/requests.
- [ ] Test constructor injects real control/key/ordinary identity/trusted recovery/safety readers and rejects missing coordinator sink.
- [ ] Run mls-rpc `test/recovery-retained-trust.test.ts test/registry-recovery-consumer.test.ts test/recovery-secret.test.ts test/readme-persistence.test.ts` RED.
- [ ] Wire explicit trust conversion and UTF-8 request facade. Keep candidate/acceptance additive until Task 14b.
- [ ] Run GREEN and Safety/Port/build/type gates. Trust-digest tests remain solely in Task 6.

### Task 10: Migrate mls-rpc constructor callers

**Consumes:** Task 9 additive dependencies. **Produces:** migrated mls-rpc constructors and prepared compatibility fixtures.
**Files (25):** Modify `packages/mls-rpc/test/{control-adoption,adoption-write,control-validation,persist-boundary,ports-conformance-transactional,recovery-codec,recovery-secret,readme-persistence,commit-pre-resolution,epoch-results,transactional-access,handle-access,ports-conformance,commit-topic-proposal,recovery-holder-evidence,recovery-codec-format,registry-double}.test.ts`. `packages/mls-rpc/test/fixtures/{storage-persistence,registry,codec-reopen,real-group,registry-recovery}.ts`. `tests/integration/test/control-first-valid.test.ts`. `tests/integration/test/app-lane-e2e.ts`. `tests/integration/test/fixtures/fork-halt.ts`.

**Interfaces:** Callers provide Task 9's GroupMLSDependencies. Identity-only AdoptionExpected remains independent from trusted registry recovery.
Constructor/fixture migration has no behavioural RED requirement. Preserve acceptance/convergence while both recovery paths remain available.
Prefer shared genuine fixture construction. Never supply placeholder trust, control or state-version metadata.

- [ ] Test simple/transactional constructors expose real control/source expectations and retain ordinary adoption/progress behaviour.
- [ ] Run mls-rpc `test/control-adoption.test.ts test/ports-conformance.test.ts test/ports-conformance-transactional.test.ts test/transactional-access.test.ts`.
- [ ] Migrate constructor callers. Prepare responder calls to pass their actual committed head through the additive captured sealing signature.
- [ ] Keep complete legacy acceptance separate. Task 14b activates captured responder calls after Task 13 supplies complete-prefix sealing.
- [ ] Run GREEN and Port/build/type gates. Do not require the new plain constructor contract until Task 11 migrates remaining consumers.

### Task 11: Migrate remaining constructors and require dependencies

**Consumes:** Tasks 9/10 constructor contract. **Produces:** remaining constructor/README callers with complete legacy lifecycle.
**Files (24):** Modify `tests/integration/test/{recovery-confirmation,lifecycle-recovery,app-lane-delivery,lifecycle-verdict,history-frame-size,lifecycle-admission,recovery-known-registry,recovery-ledger-preservation}.test.ts`. `packages/rpc/test/{peer-safety-recovery,ports-conformance,recovery-confirmation,fixtures,recovery-binding-double,group-mls,peer-dispose-race,peer-unknown-frame-version}.test.ts`. `packages/rpc/test/fixtures/peer.ts`. `packages/mls-rpc/src/mls.ts`. `packages/mls-rpc/README.md`. `packages/mls-rpc/test/readme-persistence.test.ts`. `packages/rpc/src/{crypto,host-boundary,peer}.ts`. `packages/rpc-conformance/src/group-mls.ts`.

**Interfaces:** Require GroupMLSDependencies on the final plain constructor. Registry construction already injects them.
Absent recoveryAdoption refuses captured recovery only. Ordinary source remains AdoptionExpected, without fabricated trust/lifetimeRevision.

- [ ] Test real integration constructors provide genuine control/key/identity dependencies and executable README examples typecheck.
- [ ] Run integration `test/control-first-valid.test.ts test/lifecycle-recovery.test.ts test/recovery-confirmation.test.ts` and mls-rpc readme-persistence tests.
- [ ] Require dependencies after migrating remaining constructors. Use registry construction for captured recovery consumers.
- [ ] Prepare integration/rpc responder callers with actual committed heads. Keep their overload additive until Task 14b.
- [ ] Preserve a private legacy source-reader adapter until Task 14b. Ordinary exported readRecoverySource returns AdoptionExpected.
- [ ] Recheck createGroupMLS/sealGroupInfo inventories for unowned call sites.
- [ ] Run GREEN and Port/build/type gates. Witnesses may already pass. Never manufacture RED through missing fixtures/imports.

### Task 12: Implement the additive captured-recovery port

**Consumes:** Tasks 1/2/6/7/9 portable declarations and trust authentication. **Produces:** working captured preparation/restoration/non-building reconciliation.
**Files (20):** Modify `packages/mls-rpc/src/{registry-group-mls,recovery,recovery-codec,mls,index}.ts`. `packages/mls-rpc/test/{recovery-retained-trust,recovery-codec,recovery-codec-format,storage-codec-reopen}.test.ts`. `packages/rpc/src/{crypto,host-boundary,peer,peer-types,index}.ts`. `packages/rpc/src/control/rejoin.ts`. `packages/rpc-conformance/src/group-mls.ts`. `packages/rpc/test/fixtures/memory-group-mls.ts`. `packages/rpc/test/{host-boundary,peer-rejoin-record,recovery-confirmation}.test.ts`.

**Interfaces:** `buildRecoveryCandidate({source,reply,requestID,requestKey,target,environment}):Promise<CapturedAppliedRecovery>` consumes authenticated capture.
`restoreRecoveryCandidate({source,candidate,requestKey,environment}):Promise<CapturedPendingRecovery>` restores v3 without old-handle access.
CapturedPendingRecovery retains LegacyPendingRecovery commit/epoch/serialization/verdict methods, adding immutable source:RecoverySource<unknown> and target:RecoveryTargetCapture.
Its `onAccepted(expected:RecoverySource<unknown>,proof:ResyncProof,write:AdoptionWriteFactory):Promise<void>` narrows trust only inside mls-rpc.
`CapturedRecapture = {sealed:Uint8Array;requestID:string;requestKey:Uint8Array;epochFloor:number|null}` contains fresh, separate recapture inputs.
`CapturedAppliedRecovery = CapturedPendingRecovery | {renewalRequired:true} | null`.
`RecoveryReconciliation = {kind:'accepted';epoch:number;leafDigest:string} | {kind:'head-only';head:LogPosition|null} | {kind:'unapplied-later';epoch:number} | {kind:'retry'|'held'}`.
CapturedRecoveryPort exposes `applyRecovery(sealed,requestID,requestKey):Promise<CapturedPendingRecovery|{renewalRequired:true}|null>`,
`restoreRecovery(candidate,requestKey):Promise<CapturedPendingRecovery>` and `reconcileCapture(record:CapturedRejoinRecord,reply:CapturedRecapture):Promise<RecoveryReconciliation>`.
Implement `sealGroupInfo(request:Uint8Array,captureHead:LogPosition|null):Promise<Uint8Array>` using Task 9's additive snapshot/cursor sealing. Task 13 strengthens complete-prefix enforcement.
RecoveryReconciliation held means local safety/missing retained trust only. Retry means different authenticator, below-floor capture or transient failure.
GroupMLS.capturedRecovery is additive. Initial apply exposes genuine immutable source. Recapture authenticates/classifies without candidate construction.
Leaf/tree/request/group/target/origin checks stay in mls-rpc/MLS. rpc sees typed reconciliation only, never opaque trust/tree internals.
Host-boundary classifies capture authentication as recovery work, wraps pending callbacks and preserves caller errors. Independent mirror/double implement the same signatures.

- [ ] Test same-epoch recapture has zero extra candidate builds, including lost private state, wrong leaf/request/group/target and floor refusal.
- [ ] Test captured preparation returns real source/target; retained-trust recapture never opens an old private handle or overwrites X's keys/tuple.
- [ ] Test v3 origin/target/tuple and portable acceptance narrowing. Legacy live producer/restored acceptance still advances/converges.
- [ ] Run mls-rpc recovery-codec/recovery-codec-format/storage-codec-reopen/recovery-retained-trust and rpc host-boundary/recovery-confirmation tests RED.
- [ ] Implement declarations, host-boundary, mirror, real implementation and strict memory double without redirecting production callers.
- [ ] Run GREEN and Control/Safety/Port/build/type gates. Leave live legacy lifecycle intact until Task 14b.

### Task 13: Capture complete reconciled responder snapshots

**Consumes:** Tasks 2/12 additive captured sealing contract. **Produces:** complete-prefix captured responder and prepared wrapper callers.
**Files (15):** Create `packages/rpc/src/recovery-capture.ts`. `packages/rpc/test/peer-capture-head.test.ts`.
Modify `packages/mls-rpc/src/{registry-group-mls,mls}.ts`. `packages/mls-rpc/test/registry-recovery-consumer.test.ts`. `packages/rpc/src/{peer,crypto,host-boundary}.ts`. `packages/rpc-conformance/src/group-mls.ts`. `packages/rpc/test/fixtures/memory-group-mls.ts`. `packages/rpc/test/{peer-drained,peer-recovery-lifecycle,peer-safety-startup,peer-control-search-walk,peer-safety-recovery}.test.ts`.

**Interfaces:** `CommitPrefix = {kind:'complete';key:GroupKey;identity:EpochIdentity;stateVersion:number;head:LogPosition|null} | {kind:'incomplete'|'held'}`.
`reconcileCommitPrefix():Promise<CommitPrefix>` proves complete coverage, never just a sampled tip.
Implement CapturedRecoveryPort.sealGroupInfo(request:Uint8Array,captureHead:LogPosition|null):Promise<Uint8Array> beside complete legacy sealing.
Check supplied head against committed cursor/identity in one Read. Capture snapshot/ledger/authenticator/cursor atomically, seal fixed data after release.

- [ ] Test queued valid commits apply before reply. Empty gap or unproven empty tip produces zero replies. Null requires proven empty prefix.
- [ ] Test snapshot/cursor race returns one complete pair or retries. Moved source refuses caller-sampled head.
- [ ] Test skipped unknown-version poison does not hold capture forever. Genuine gap waits for complete coverage and bounded retry.
- [ ] Test no network I/O under ownership. Suspended seal plus local safety latch produces zero publication handoff.
- [ ] Run rpc `test/peer-capture-head.test.ts test/peer-control-search-walk.test.ts test/peer-safety-recovery.test.ts` RED.
- [ ] Implement complete-prefix capture in the additive real/double port without fabricated heads. Keep the legacy responder path live.
- [ ] Run GREEN, named drain/lifecycle/startup wrapper tests, registry-recovery-consumer tests and Port/build/type gates.

### Task 15: Resume destination bootstrap through retired continuation

**Consumes:** Tasks 1/6b/7 stored continuation/switch contract. **Produces:** working continuation and RecoveryCompletion source settlement.
**Files (9):** Create `packages/mls-rpc/src/registry/continuation.ts`. `packages/mls-rpc/test/registry-continuation.test.ts`. `packages/rpc/test/rejoin-legacy.test.ts`.
Modify `packages/mls-rpc/src/index.ts`. `packages/mls-rpc/test/registry-switch.test.ts`. `packages/rpc/src/{peer,peer-types}.ts`. `packages/rpc/src/control/rejoin.ts`. `packages/rpc/test/peer-rejoin-record.test.ts`.

**Interfaces:** Implement `loadRecoveryContinuation(destination:GroupKey):Promise<RecoveryContinuation|null>` and
`finishRecoveryContinuation({continuation,ledger,mutationID}):Promise<void>` via one source-incarnation storage transition.
RecoveryCompletion exclusively settles source stage:accepted operations to stable unknown outcomes, removing operations atomically and idempotently (HEAD rejoin.ts:184-212).
`createRecoveryContinuationPort({registry,persistence})` validates shared coordinator identity.
GroupPeerMLSParams receives continuation/completion together or neither. Destination MLS bootstraps, source storage completion closes over the continuation.

- [ ] Test switch-before-peer crash resumes without reinstall/republish. Later destination epoch advancement still finds initial installation proof.
- [ ] Test missing saved ledgerBefore tokens emit reenact once with stable outcome data, without automatic enqueue.
- [ ] Test bootstrap retry/crash/concurrent completion preserves source outcomes/Welcomes and finalises atomically/idempotently.
- [ ] Test accepted source operations become unknown once through RecoveryCompletion, including switch-before-peer crash/restart. Preserve settlement records/reenact obligations.
- [ ] Test source cleanup never changes destination cursor. Legacy adopted continuation requires independent installation proof, never fabricated metadata.
- [ ] Run mls-rpc registry-continuation/registry-switch and rpc peer-rejoin-record/rejoin-legacy tests RED with paired types.
- [ ] Route storage-only source obligations without constructing an old peer. Frozen-settlement publication remains 2.3.
- [ ] Run GREEN and Control/Port/build/type gates before Task 16 consumes this implementation.

### Task 16: Coordinate source drainage, switch proof and restart

**Consumes:** Tasks 6b/7/12/13/15 saved storage/proof, capture and completion. **Produces:** working detached coordinator/restart/movement lifecycle.
**Files (11):** Create `packages/mls-rpc/src/registry-peer.ts`. `packages/mls-rpc/test/registry-peer.test.ts`. `packages/rpc/test/peer-registry-retirement.test.ts`.
Modify `packages/mls-rpc/src/{registry-group-mls,index}.ts`. `packages/mls-rpc/src/registry/consumers.ts`. `packages/mls-rpc/test/{registry-recovery-consumer,registry-retirement}.test.ts`. `packages/rpc/src/{peer,peer-types,host-boundary}.ts`.

**Interfaces:** `createRegistryPeer(params):Promise<RegistryPeer>` takes registry/key/recovery/target/continuation and explicit createMLS/createPeer factories.
RegistryPeerOptions supplies mls/recoveryOnly/target/onConfirmedRecovery/continuation/completion, as the r19 replacement for r18:767-769 defines.
RegistryPeer supplies peer(), installedKey(), ready, dispose() and drained(). Register retirement before peer work.
Private capability adds readRecoveryRecord(key) and resolveRecoverySwitch(record):committed(destination)|rolled-back|pending.
Add optional settleAcceptedRecovery(record,epoch,leafDigest) callback. Before activation, moved accepted X stays durable/pending; captured production construction requires it in Task 14b.
Wait handoff.completion, reread saved confirmed record, restore raw candidate, build proof and saved-ID factory, then accept outside source boundary.

| Coordinator result | Action |
| --- | --- |
| Confirmed+null on startup | Assign switchMutationID once under ownership, then resume before source application work. |
| Confirmed+saved ID | Resume proof/acceptance first, using raw pending state, never a host-bound proxy. |
| Proven committed/adopted switch | Start destination once, load continuation and bootstrap. Never discard/reinstall. |
| RegistrySourceMovedError, unchanged origin/target | Reread counters after drain. Retry same candidate/proof/switchMutationID only. |
| Other conflict or local proof/candidate/spent/invariant failure | Stop with diagnostic and preserve confirmed bytes. Copy/transport failures are not terminal proof failures. |
| Existing local safety/legacy/policy hold | Stay stopped. Preserve saved facts. |
| Identity/trust/key/target movement, proved rolled-back local switch | Preserve accepted/confirmed X and its obligations; reconcile installation or use R0 settlement when authenticated recapture supplies its epoch. Rollback alone never discards. |
| Authenticated later-epoch leaf absence for an unconfirmed attempt | D1 non-acceptance permits discard/build subject to removal/admission policy. Already accepted X keeps its settlement. |
| Hooked StorageOutcomeUnknownError | Hooks settle. Release destination only after proof. |
| Unhooked GroupStateUncertainError | Settle fence, resolve saved ID, then fresh Read before movement. Pending retries with bounded backoff. |
| Transient transport/provider failure | Preserve attempt, back off at most 15 seconds and resolve uncertainty before retry. |

- [ ] Test null/corrupt state starts recovery-only with no fabricated handle/app work. Missing local trust holds with zero requests.
- [ ] Test callback/completion exits before raw acceptance and retire drain. Drain counter movement retries the same saved ID once.
- [ ] Test delayed acceptance + source movement + rolled-back switch/restart preserves X facts/ledger/owed obligations. Rollback is local-only.
- [ ] Test unhooked uncertain commit/rollback after later marker/movement and restart. Fresh Read checks saved proof/spent/adopted/initial-identity facts.
- [ ] Test missing/inconsistent proof never implies rollback. Hanging/rejected hooks never authorise writes. Pending retries are bounded.
- [ ] Test destination factories receive MLS/continuation/completion through live/restart/advanced-epoch paths. No continuation starts normally.
- [ ] Test unavailable settlement callback preserves accepted X. Authenticated recapture/classification never deletes it. Task 14b wires and tests leaf-replacing Y.
- [ ] Run mls-rpc registry-peer/registry-retirement/registry-recovery-consumer/registry-continuation and rpc peer-registry-retirement tests RED.
- [ ] Implement the table proof-first, including provider uncertainty catches that still perform fresh Read. Track coordinator workers separately from source drainage.
- [ ] Run GREEN and Control/Safety/Port/build/type gates. Manual 2.2e handles terminal local nonconvergence, never hub copy faults.

### Task 17: Bind live peer safety across suspended work

**Consumes:** Tasks 4/16 keyed sink and coordinator lifecycle. **Produces:** live peer safety subscriptions/post-await handoff checks.
**Files (12):** Create `packages/rpc/test/peer-live-registry-safety.test.ts`.
Modify `packages/mls-rpc/src/{registry-group-mls,mls}.ts`. `packages/rpc/test/{peer-divergence-poison,peer-fork-halt,peer-safety-gates}.test.ts`. `packages/rpc/src/{peer,peer-types,host-boundary,crypto}.ts`. `packages/rpc-conformance/src/group-mls.ts`. `packages/rpc/test/fixtures/memory-group-mls.ts`.

**Interfaces:** GroupMLS.onSafetyHold(latch):()=>void delegates to Task 4's keyed sink, with strict real/double parity.
Register before work, unsubscribe at disposal. latchSafetyHold updates memory only and remains outside host-callback drain accounting.
Local hold clears healRequested and gates every next start/handoff. Already opened handlers/committed owed work remain serviceable.

- [ ] Test suspended fetch/body open/app seal/responder seal/confirmation timer plus failed host safety write blocks the next crypto/network call without refresh.
- [ ] Test late subscriber gates before ready, foreign incarnation cannot affect destination and dispose unregisters.
- [ ] Test signed loser/own mismatch/version poison never pushes sink. Historical holds remain immutable through restart.
- [ ] Run rpc `test/peer-live-registry-safety.test.ts test/peer-divergence-poison.test.ts test/peer-fork-halt.test.ts test/peer-safety-gates.test.ts` RED.
- [ ] Recheck safety after awaits before new crypto/network handoff. Preserve storage-only outcomes/Welcomes.
- [ ] Run GREEN, rpc tests and Safety/Port/build/type gates.

### Task 14a: Prepare the complete captured record fixture closure

**Consumes:** 6b stored union/discrimination, complete additive captured lifecycle and legacy aliases. **Produces:** genuine captured fixture builders/readers beside active legacy fixtures.
**Files (17):** Modify `packages/mls-rpc/test/fixtures/{codec-reopen,registry,registry-recovery}.ts`. `packages/mls-rpc/test/{storage-codec-reopen,registry-delete,registry-retirement-writes,registry-switch}.test.ts`. `packages/rpc/test/{control-store,peer-control-settlement,peer-durable-effects,peer-startup-order,peer-safety-recovery,peer-control-retry,peer-fork-halt}.test.ts`. `tests/integration/test/{anchor-rotation-recovery,recovery-requester-restart}.test.ts`. `packages/rpc/test/fixtures/peer.ts`.

**Interfaces:** Shared builders expose genuine captured records from Task 12 preparation, including immutable source/target/attested reply.
Fixtures select captured records only when production capturedRecovery is active. Existing legacy producers and behavioural expectations stay live here.
Use Task 6b's StoredRejoinRecord discrimination for captured setup of every listed buildRejoinRecord/putRejoin/.rejoin consumer.
Captured fixtures assert source.identity epoch; legacy fixtures assert source.epoch. Never replace acceptance/epoch advancement/convergence with stops or skips.

- [ ] Test both fixture modes preserve exact bytes, current legacy acceptance and captured target/source associations.
- [ ] Prepare codec-reopen, registry switch/delete/retirement, control/restart/readmission/safety and anchor-rotation consumers before alias promotion.
- [ ] Run all listed fixture consumers GREEN with paired types. Behavioural RED is unnecessary for additive fixture preparation.
- [ ] Run Control/full Port/build/type gates GREEN. Do not activate production or gate legacy records in this unit.

### Task 14b: Activate captured recovery and settle accepted-unadoptable X

**Consumes:** 6b stored union/readers, Tasks 12/13/15/16/17 captured lifecycle and 14a fixtures. **Produces:** production captured selection, public alias promotion, atomic accepted settlement and legacy stop policy.
**Files (25):** Create `packages/rpc/src/recovery-reconcile.ts`. `packages/rpc/test/recovery-capture-reconcile.test.ts`.
Modify `packages/mls-rpc/src/{registry-group-mls,registry-peer,mls}.ts`. `packages/rpc/src/{peer,peer-types,host-boundary,crypto}.ts`. `packages/rpc/src/control/{rejoin,types,store}.ts`. `packages/rpc/test/{rejoin-legacy,peer-rejoin-record,peer-readmission,recovery-confirmation}.test.ts`. `packages/rpc-conformance/src/{group-mls,control-store,memory-control-store}.ts`. `packages/rpc/test/fixtures/{peer,memory-group-mls}.ts`. `packages/mls-rpc/test/fixtures/{registry-recovery,codec-reopen,registry}.ts`. `tests/integration/test/lifecycle-recovery.test.ts`.

**Interfaces:** Consume Task 12's non-building reconciliation and genuine source, Task 13's capture and Tasks 15/16's working lifecycle.
RejoinDeps.reconcileCapture(record):Promise<RecoveryReconciliation> supplies fresh recapture inputs through CapturedRecoveryPort, bounded at 15 seconds.
`adopt` returns Promise<'adopted'|'handoff'>. stepRejoin returns record/null or `{kind:'handoff';record}`.
`settleAcceptedRecovery(record,acceptedEpoch,leafDigest):Promise<void>` folds compact public facts/obligations, deletes the active pointer and raises floor via applyResolved.
Omit request/requestKey/candidate/payload from settled storage. Zeroise owned buffers after proven commit. At most one cumulative row survives repeated settlements.
Carry saved ledgerBefore durably into Y before publication. Latest settled X remains discoverable while Y owns the active pointer. Later settlements replace provenance, retaining every prior owed token.
Alias RejoinRecord to CapturedRejoinRecord. Gate pre-existing legacy records only at activation, preserving bytes/stages and proven installed continuations.
Confirmed/switchMutationID co-write. Defensive confirmed+null startup assigns once before coordinator work. Handoff queues after source completion/host-boundary exit. Wire the coordinator settlement callback before activating captured recovery.

- [ ] Test initial CAS uses signed capture/null despite local head. Search mismatch/gap/junk and lost ack permit fresh-key recapture.
- [ ] Test all D1 rows. Regressing same-epoch/authenticator head still retries identical bytes; inflated-head witness never strands X.
- [ ] Test delayed reply after responder advancement and absent/pruned occurrence settle X accepted-unadoptable; Y removes X's exact sole identity leaf.
- [ ] Test restart after settlement preserves public facts/ledger/floor/owed work, builds Y later and computes reenact after Y bootstrap.
- [ ] Test settled storage contains no request/requestKey/candidate/payload; repeated settlements remain one row with cumulative obligations.
- [ ] Test first save of X co-writes floor=capture epoch. A restart before publication never lowers it.
- [ ] Test leaf-absent discard raises floor to authenticated recapture epoch atomically with pointer deletion.
- [ ] Test R0 settlement raises floor to acceptedEpoch atomically. Test restart preserves it and refuses replies below it.
- [ ] Test coordinator local-switch refusal plus delayed acceptance/source movement uses the same settlement callback; X obligations survive and Y replaces its leaf.
- [ ] Test wrong leaf/request/group/target cannot settle X. Exact wire LeafNode matching rejects DID/index reuse. Mutation-check leaf guard, restore GREEN.
- [ ] Test known-position/current-epoch bound confirmation still adopts X. No position lookup without a known position or new proof/codec arm.
- [ ] Test same-epoch recapture makes zero extra builds with lost private state; X's original keys/tuple never change.
- [ ] Test leaf absent includes applied-then-removed: removal/admission policy (r18:66,128) can require fresh invitation; no bypass or old-epoch rebuild.
- [ ] Test confirmed/ID atomicity, defensive assignment, saved handoff restart and complete legacy acceptance before activation.
- [ ] Test ledgerBefore preserves HEAD's de-duplicated inFlightEntries ?? awaitingBootstrap.entries, current ledger and conditional commitOnce bodies.
- [ ] Run rpc recovery-capture-reconcile/peer-rejoin-record/rejoin-legacy/peer-readmission/recovery-confirmation tests RED with paired types.
- [ ] Activate production requester/responder/candidates, mirrors and all prepared fixture selectors together after coordinator/continuation exist.
- [ ] Re-run every 14a fixture consumer and real/transactional conformance, preserving acceptance/epoch advancement/convergence.
- [ ] Preserve conformance restored acceptance/epoch advance and integration lifecycle convergence; run both immediately after activation.
- [ ] Remove new sourceRecheck/source-prefix scan/conflictEpoch orchestration. Run GREEN and Control/Safety/Port/build/type gates.

### Task 18: Prove real recovery and document the usable surface

**Consumes:** all preceding stage deliverables. **Produces:** integration sensitivity evidence, public docs/exports and complete gates.
**Files (12):** Create `tests/integration/test/{recovery-retained-trust,recovery-capture-head}.test.ts`.
Modify `tests/integration/test/{recovery-confirmation,recovery-requester-restart,fork-halt}.test.ts`. `tests/integration/test/fixtures/fork-halt.ts`. `packages/mls-rpc/src/index.ts`. `packages/rpc/README.md`. `packages/mls-rpc/README.md`. `docs/reference/reserved-namespaces.md`. `.changeset/spec-p-storage-foundation.md`. `packages/mls-rpc/test/readme-persistence.test.ts`.

**Interfaces:** Export portable source/proof, concrete registry source/write, control/MLS/peer constructors and existing error classes. Add no mechanism.
Document D0-D6, source continuation ownership, local safety, removed-after-origin authority and out-of-band deferral.

- [ ] Add real-MLS witnesses for stale CAS, same-byte poison retry, remote acceptance/lost ack, later authenticated leaf present/absent and epoch-floor restart.
- [ ] Add lost-state/advanced capture-tree/ghost-leaf admission/switch-drain-continuation crash witnesses. Preserve source outcomes/Welcomes.
- [ ] Add signed CAS loser, own contradiction, re-encoded no-entry/valid swapped named-entry, advisory blob-negative and unknown-version witnesses.
- [ ] Add live host safety and immutable historical-halt witnesses. Hub faults never permanently strand the saved attempt while authenticated responders remain available.
- [ ] Run integration `test/recovery-confirmation.test.ts test/recovery-requester-restart.test.ts test/recovery-retained-trust.test.ts test/recovery-capture-head.test.ts test/fork-halt.test.ts`.
- [ ] Permit immediate GREEN. Mutation-check fresh-leaf acceptance, blob-negative authority, own-copy recognition and delivery-halt guards. Restore before final checks.
- [ ] Finish exports/docs. Return production gaps to owning tasks. Claim phase-2 reconstruction evidence, never phase-6 SIGKILL evidence.
- [ ] Run complete gates below. Record suite counts and every real/double runner, with paired type checks. Expect PASS.

```bash
rtk proxy pnpm turbo run build:js build:types --force
rtk proxy pnpm turbo run test:types --force
rtk proxy pnpm turbo run test:unit --force
rtk proxy pnpm --filter @kumiai/mls run test
rtk proxy pnpm --filter @kumiai/mls-rpc run test
rtk proxy pnpm --filter @kumiai/rpc run test
rtk proxy pnpm --filter @kumiai/integration-tests run test
rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/runtime-neutral.test.ts test/readme-persistence.test.ts
rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
rtk proxy pnpm run check:versions
rtk proxy pnpm change status
rtk proxy pnpm run lint
git diff --check
```
Require repo-wide test:unit PASS with Cached: 0. Run Control/Safety/full Port gates, preserving every real/double runner.
Isolate known flaky rows before classification, recording failure and paired rerun outcomes.
If SWC native cache fails, retry with `SWC_NATIVE_BINDING_CACHE=/private/tmp/kumiai-2-2d-swc` and turbo `--env-mode=loose`.

## Ruling accounting and revision verification

- R0: D1/Task 14b settles accepted-unadoptable X atomically and carries ledger into leaf-replacing Y. Existing bound proof remains the only adoption arm.
- R1: D5/Task 16 preserve accepted/confirmed X across movement and local rollback. Task 14b owns authenticated settlement.
- R2: D1/Task 14b allows lower/inflated authenticated heads; only member-signed epoch floor refuses stale state.
- R3: Tasks 8a/8b separate recognition from refusal provenance. Task 14b owns confirmation and R0 regressions.
- R4: HEAD audit/Task 5c covers sealed-entry versions through crypto/resolver/walker. Task 8a follows those ledger-entries edits.
- R5: Task 15 RecoveryCompletion owns idempotent source accepted-operation -> unknown settlement.
- R6: Tasks 1/12 define and implement portable captured preparation/non-building reconciliation across boundary, mirror, real and double.
- R7: Stages 5/6 remain additive/live legacy; Stage 7 Task 14a prepares 17 files and Task 14b activates the 25-file closure with full convergence assertions.
- R8: Task 1b owns production memory snapshot fresh/legacy normalisation and real/double Control plus repo-wide types.
- R9: Tasks 1a/1b/7/10/13/14a/14b/18 own name collisions, distinct digests, wrappers, type witnesses, policies and uncached full unit gates.
- Q0-Q5/P1-P3/P5-P6/P8-P12 remain binding where unsuperseded. No identity migration/canonical gate or in-band fork machinery remains.
- S1: HEAD grep closure and Tasks 5a-5e migrate delivered-frame assertions with each behaviour change, retaining host/history/owed work.
- S2: HEAD record/snapshot inventory assigns every hit. Tasks 1a/1b/6b/14a/14b carry concrete green closures and activation reruns.
- S3: D1/Tasks 1a/1b/14b store one compact public settlement with cumulative obligations, omitting and zeroising retired secrets after proof.
- S4: D2/Tasks 5b/8a allow identical ordinary retry after tampered copies. No adverse verdict; unresolved deadline remains unknown.
- S5: D3/Task 5e bounds caught-up future app waits to two epochs/30 seconds and completes version/window/age poison through contiguous prefixes.
- S6: Every 5a-5e unit runs full Port. Task 3 runs Control. Task 1a uses the explicit pre-runner Control command.
- S7: Task 15 creates rejoin-legacy.test.ts. Task 14b extends it.
- S8: Tasks 1a/9/12/13/14b/17 own alias, sealing, floor writes, reconciliation reasons and exact facades. r19 retains handlers / 2 and residuals.
- T1: Task 1b includes peer-readmission null/[] literals and normalised expectReset. Its 16-file closure precedes 14b record semantics.
- T2: HEAD closure yields Task 6b's 17-file stored union/reader unit before 7. Legacy producers/acceptance/alias remain until 14b.
- T3: Task 5b includes peer-app-cursor own-halt assertions, restart and cursor coverage. Its closure is 19 files.
- T4: Task 5e's 12-file closure supplies commit-lane catch-up before bounds/age. Honest lag >2 epochs delivers after catch-up.
- Verify HEAD paths/coordinates and in-memory r19 application to original r18, including nonoverlap, insertion, fences and retained prefix requirements.
- Check both drafts for conflicting acceptance/hold/head/API rules. Verify only these two authorised files changed and HEAD stayed fixed.
- Implementation tests are future work. R0 resolves the former confirmation question; no design question remains open.
