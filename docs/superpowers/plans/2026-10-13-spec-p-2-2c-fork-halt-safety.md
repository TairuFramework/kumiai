# Spec P 2.2c Durable Fork Halt and GroupSafety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace automatic fork healing and fork-evidence ControlHold with immutable durable safety fields, all-path runtime gates, and GroupSafety without manual recovery.

**Architecture:** Two write-once ControlSnapshot fields carry safety holds. The incarnation control store co-writes their stable-ID events in one group transaction. Peer detectors latch synchronously before writing and resolve mutation proof before notifying. GroupSafety and registry latches bind to GroupKey. Storage-written holds reach existing peers at refreshControl or restart. Immediate registry-to-peer propagation requires 2.2d consumer wiring.

**Tech Stack:** TypeScript, pnpm 12.10.1, Vitest, ts-mls 2.0.0-rc.13, Web Crypto, MLS v2 codecs and transactional memory persistence.

**Spec:** [Spec P transactional persistence](../specs/2026-10-08-spec-p-transactional-persistence.md), **r18**, binding. Relevant sections: D1 `:32-73`, spent/Welcome `:157-167`, D4 outcomes `:277-279`, storage `:586-608`, admission `:663-666`, control `:751-754`, safety API `:805-850`, crash seams and conformance.

Baseline: HEAD `f3fd2b5`. Inputs: `.superpowers/sdd/plan-2-2c-draft/inventory.md`, `review-sol.md`, `review-opus.md`, `revise.md`, `revise2.md`, `rereview-sol.md`, `rereview-opus.md` and `rereview2-opus.md` in that directory. Controller rulings R1-R37 bind this plan. Inventory premises are checked against code, not accepted as implementation claims. Read the existing 2.2a and 2.2b carry-forward documents before execution.

## Global Constraints

- Use pnpm only. Prefix repository commands with `rtk proxy`.
- If SWC fails, use `SWC_NATIVE_BINDING_CACHE=/private/tmp/kumiai-task1-swc` with turbo `--env-mode=loose`.
- Pair each Vitest invocation with the package `test:types`. Rebuild sibling exports before cross-package tests.
- Run repository-wide `rtk proxy pnpm turbo run test:types` after exported type changes. Integration consumers are part of that gate.
- Changed ports run both contract families against real implementations and every affected double (`docs/agents/architecture.md:21-24`).
- Doubles may be stricter than their port, never more permissive. rpc-conformance imports neither rpc nor mls-rpc.
- Never edit generated `lib/` files. Add no dependency, script or toolchain change. Internal dependencies remain `workspace:^`.
- Cross-repo dependencies remain published `^` ranges through the workspace catalog.
- Runtime baseline: ES2022 built-ins in scoped `src`. Add no Node imports, async-context implementation or `structuredClone`.
- Preserve `packages/mls-rpc/test/runtime-neutral.test.ts`.
- Pure reads use Read entries. Safety writes co-commit control and event. Never write them through separate roots.
- Network I/O, host callbacks and handlers run outside ownership entries.
- Failure/ambiguity releases nothing. A validated runtime latch survives failed writes for that incarnation. Only proven commits trigger notification.
- Acknowledgement never clears either field. No public reset/clear-halt API exists.
- Preserve `unsupported-version` and `acceptance-unknown` ControlHold semantics.
- Already opened handlers may finish. Preserve storage-only outcomes/events, opened-record restoration, committed Welcome delivery and existing live certified settlement. Restart frozen-settlement publication belongs to 2.3.
- Do not implement manual recovery, ManualRecoveryRecord, captureHead v2, stranded resync orchestration or sourceRecheck/conflictEpoch removal.
- Registry consumer wiring belongs to 2.2d. Leases, batching, openBatch adapters and full restore-work belong to 2.3.
- Release text goes only into `.changeset/spec-p-storage-foundation.md`, in Task 13. Publish nothing.
- Run `rtk proxy pnpm run lint` before implementation commits. Mutation checks must fail at the named safety assertion.
- Implementation commits retain these trailers:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QNKrDfFoVDpZLtLyvPMoEo
  ```

## Review Focus

1. Failed/ambiguous writes hold the current runtime. Proven commits survive restart. Tasks 3, 5, 12 prove both outcomes. One-shot below-cursor reveals and host evidence cannot be re-detected after a crash before durable writing. In-process storage retries preserve pending peer evidence. This crash-before-write residual remains.
2. Reports racing epoch/incarnation changes refuse without latch/event. Queued registry work and installation after retirement hooks recheck safety. Tasks 3-4.
3. A halt during an await stops the next open and every later network handoff. Already started opens/handlers may finish. Tasks 4, 8-9.
4. Missing/corrupt/empty-spent trust refuses Welcome unchanged. A recoveryUnavailable field alone permits otherwise admissible readmission with valid retained trust. Tasks 4, 11.
5. Halted startup loads safety before network, yet restores opened plaintext and serves owed storage work. Tasks 5, 8, 10, 12.

## Decisions (binding for executors)

| # | Decision | Boundary and reason |
| --- | --- | --- |
| C1 | Move ForkHalt, GroupSafetyEvent and RecoveryUnavailableEvent from `packages/mls-rpc/src/persistence-types.ts:402-412` into rpc `control/safety.ts`. Move GroupForkEvidence from search.ts and add SafetyHold there. Export through rpc and re-export from mls-rpc. PersistenceEvent stays in mls-rpc. | No duplicate declarations or rpc-to-consumer dependency. Update the independent `packages/rpc-conformance/src/persistence-fixture.ts:593-625` mirror. |
| C2 | ControlSnapshot adds `forkHalt: ForkHalt \| null` and `recoveryUnavailable: RecoveryUnavailableEvent \| null`. ControlChanges adds optional non-null values. Identical reapplication preserves the body. Clear/replacement rejects ControlSafetyImmutableError atomically. | Runtime untyped null and mixed changes cannot bypass immutability. |
| C3 | IDs are `JSON.stringify(['group:fork', groupID, incarnation])` and `JSON.stringify(['group:recovery-unavailable', groupID, incarnation])`. Validate ID/kind/key in rpc applyChanges, independently in the double, and in mls-rpc. | `halt.eventID === forkEventID(key)`. Recovery event ID, kind, groupID and incarnation must match. |
| C4 | A newly set field co-writes its event through unlocked helpers in the same incarnation transaction. Identical reapply after ack does not recreate it. | No nested memoryOperation. Event conflict rolls back the whole transition. AppOutbox.ackEvent rejects safety IDs with TypeError. |
| C5 | In Task 5 narrow ControlHold.reason to `'acceptance-unknown' \| 'unsupported-version'` and remove its evidence member. Fork writers use haltFork. | Migrate all literals, callers and mirrors in that task. |
| C6 | Persist only the safety field/event, never a safety-derived strand or cursor.stranded. haltFork and refreshControl latch without setting runtime stranded. Set healRequested=false. | blocked(), healing guards and every former safety-derived stranded gate consult `safetyHold() !== null` directly. Preserve pre-existing real strands. |
| C7 | Both divergence branches halt with commit-digest evidence. Preserve onStrand confidence and add StrandKind `'fork-winning'`. Certified losers and identical/missing applied history stay non-fork. | Stop immediately without advancing/certifying the walk. Search/slot mismatches retain payload-digest evidence. |
| C8 | Remove ForkEvidence, cursor.fork, forkEvidence, forkSettlement and deleteAppliedFrom. Reuse deleteAppliedBelow. `readmissionChanges(snapshot)` clears applied rows with `Number.MAX_SAFE_INTEGER`. Recovery builds set conflictEpoch null. | Signature unchanged. conflictEpoch/sourceRecheck removal remains 2.2d. |
| C9 | `safetyHold(): SafetyHold` latches self-detected halts, safety reasons from mls.sendAdmission()/held crypto or resolver refusals, and storage fields at the next refreshControl/restart. | Latch a held error's reason before returning, so the next pull is gated at entry (R37). Immediate registry/GroupSafety-to-live-peer propagation closes with 2.2d wiring. No storage-level durable-send gate is added in 2.2c (R30). |
| C10 | Optional peer onSafetyEvent fires at most once after proof, outside locks, only when the stored halt equals this peer's body. Contain callback throws/rejections. | GroupSafety.events() is the complete durable source, including registry/host events. No callback replay promise. |
| C11 | Both cold and accounted admission project: fork-halted, recovery-unavailable, terminal, stranded, lapsed, admissible. Keyed volatile latches overlay that projection. | Preserve an unreadable-source safety refusal even when no trusted runtime snapshot can be constructed. No fabricated handle/identity. |
| C12 | One registry trust helper serves cold access, held-access reload, recoverySource, reportFork prepare and accounted-observation diagnosis. Missing, typed unreadable/corrupt and empty-spent trust persist recovery-unavailable after entry release. | Installed-key mismatch stays invalid with no write. Transient I/O propagates unchanged. Recheck active lifetime/control. Unreadable control retains invalid refusal with no write. |
| C13 | Seed checks pending fork latches and latest committed forkHalt before drain, in prepare and in work. Switch refuses both safety reasons before drain and again in prepare/work. | Completed proof-backed replay remains idempotent. Pending latch is incarnation-bound. registry.delete is allowed under a halt. Fork-halted tombstones retain evidence and refuse ordinary readmission pending 2.2e. Readmission with only a recovery field requires valid retained trust, as specified below. |
| C14 | createGroupSafety accepts the normative factory parameters. recover always rejects ManualRecoveryUnavailableError until 2.2e. Validate registry registration and shared coordinator binding with persistence. | TypeError for an unregistered/spread registry or foreign binding. mls/resolveTarget remain unused. rpc re-exports LogHub and MailboxHub types only. |
| C15 | Snapshot caller key/evidence before any await. Validate and latch inside the owning entry's prepare. Authenticator reports require active key, committed epoch/local bytes and different remote bytes. Other evidence requires active key and epoch no greater than committed. | ForkReportRefusedError reason is key, epoch or authenticator. No Read-to-latch gap. Any existing forkHalt makes reportFork storage-neutral success, latch only (R21). |
| C16 | epochAuthenticator returns a defensive active trust.installed identity, independently of MLS state bytes. Retired/absent/deleted keys or typed unreadable trust return null. It never writes. | Validate the requested key. Transient I/O propagates. Latch-only admission changes do not promise onEpochChanged. Listeners report committed observations. |
| C17 | Under safety, expired never-built intents become lost. Unresolved fork-touched built/pending-published/accepted work becomes unknown. Existing outcomes and proven occurrence/supersession facts remain. | No pullToHead/readHead/searchLog/prepareBuild/MLS work under the hold. Keep commitOnce and halt evidence after outcome ack. Volatile holds reach stepOperation through deps. |
| C18 | `hardControlHeld(): boolean` includes `safetyHold() !== null` plus the existing hard ControlHold check. Split `controlHoldPresent(): boolean` for that ControlHold-only check. | Use controlHoldPresent at `packages/rpc/src/peer.ts:293-296`, `:2057` so safety cannot freeze unsupported-version reloads. |

**USER 2026-10-13 — manual re-invite with lost spent set:** re-invite means admission into a NEW group (successor/new groupID); 2.2e must cover this case. This plan implements neither successor recovery nor any total-loss path. Missing/unreadable/empty-spent retained trust still refuses seed as unavailable. No empty-set fallback or reconstruction from Welcome/GroupInfo is permitted. A persisted recoveryUnavailable field with now-readable, valid trust does not itself bar a fresh admissible Welcome into n+1. The old tombstone retains its field/event.

### Error mapping

| Boundary under either safety reason | Error/behaviour |
| --- | --- |
| Every peer send: durable, ephemeral, request, gather, directed and withEpoch path | SendNotAdmissibleError(reason). Suppress automatic replies at the safety gate. |
| Enqueue, registry mutate/replace/adopt, direct crypto, resync/reauthorize, peer recovery calls | GroupSafetyHeldError(reason), defined once in rpc errors.ts and exported in Task 4. reauthorize(): void throws synchronously when latched. |
| Durable unwrap encounters GroupSafetyHeldError | Held/retryable. Latch its reason in the peer before returning if safetyHold() is null. Preserve ciphertext/cursor. Never poison/dead or wrap it as a storage failure. |
| Incoming commit/header/body resolver encounters GroupSafetyHeldError | Latch its reason if safetyHold() is null. Held before resolverFailed/unprocessable/poison/strand handling. Retain unprocessed commit/cursor, certify no head. Task 9. |
| Ordinary switch/seed | Existing refusal errors with the C13 reason. Seed trust loss remains unavailable. |
| GroupSafety.recover in this phase | ManualRecoveryUnavailableError. |
| Unsupported-version only | Preserve RecoveryRequiredError and existing enqueue semantics. |

### Safety-path checklist

Check safetyHold before starting new crypto/recovery work. Recheck synchronously at every network handoff after the last await. Prepared bytes are not handed-off bytes. Pure storage service uses explicit exception routes.

| Checked HEAD path | Task / discriminating test |
| --- | --- |
| `packages/rpc/src/peer.ts:1155-1185` recovery GroupInfo responder | 9: queued/post-halt requests seal/publish nothing. Suspend sealing, halt, resume: no publish. |
| `packages/rpc/src/peer.ts:1232-1257` ledger responder | 9: no sealLedger/publish after hold, including timer and suspended completeness checks. |
| `packages/rpc/src/peer.ts:1075-1145`, `:3229` verdict/confirmation publication and timers | 9: queued verdict/confirmation timers and external commits remain silent after halt. |
| `packages/rpc/src/peer.ts:2835`, `:2888` ensureLedger request creation/publication | 9: halt during request creation prevents publication/open/bootstrap continuation. |
| `packages/rpc/src/peer.ts:3045`, `:3390` requestGroupInfo/applyRecovery continuation | 9: safety checks after awaits prevent request, recovery application, restoration and adoption. |
| `packages/rpc/src/peer.ts:1416`, `:1549`, `:1718`, `:1726-1757` incoming commit fetch/header/process/resolver | 9: recheck after fetch and before each crypto start. Volatile-only halt retains commit/cursor/head, no strand. Held disposition precedes failure classification. |
| `packages/rpc/src/peer.ts:1271-1316` advanceHandle, especially drain `:1282`, roster/epoch `:1284-1300`, ratchet `:1316` | 9: recheck after every preparatory await and before anchor/new-transition save or ratchet/adopter. Suspended drain/roster cannot continue after latch. |
| `packages/rpc/src/peer.ts:3180-3190` rejoin publication, startup settleRejoinPublication `:3662` | 9: a saved pre-halt rejoin publishes nothing live or on restart. |
| `packages/rpc/src/peer.ts:887-895` recovery retry timer | 9: a timer armed before halt never sets healRequested. |
| `packages/rpc/src/peer.ts:2494`, `:2511` control readEvidence/publication | 5: halt during readEvidence prevents control handoff. |
| `packages/rpc/src/peer-epoch.ts:297`, `:434` raw directed wraps. `packages/rpc/src/directed.ts:147`, `:333-343`, `:553-554` client/reply/NACK handoffs | 9: guarded wrappers and final checks cover unary, stream, channel and NACK. |
| `packages/rpc/src/peer-epoch.ts:216` broadcast handoff | 9: halt after sealing prevents bus publish. |
| `packages/mls-rpc/src/crypto.ts:161`, `:173` sealEntries/openEntries | 4: safety refusal before key derivation/open, also after access-queue awaits. |
| `packages/rpc/src/app-lane.ts:699`, `:739`, `:743`, `:765`. Callers `packages/rpc/src/peer.ts:1878`, `:1282` | 8: per-frame new-open gates and retryable refusals, covering pull and pre-adoption drains. |
| `packages/rpc/src/peer.ts:3787-3790` retryAppDelivery → retryAppPull `:588` | 8: opened delivery may retry, but the held pull starts no retain/fetch/open. |
| `packages/rpc/src/peer.ts:3813`, `:3830` resync/reauthorize | 8: GroupSafetyHeldError, no rebuild/retain/subscribe. |
| `packages/rpc/src/peer.ts:2994-3010`, `:3792-3804` replay/dropAppFrame | 8: skip replay second phase. Drop performs only storage drop, with no reconcile/heal. |
| `packages/rpc/src/peer.ts:2290`. `packages/mls-rpc/src/registry/retired.ts:180` committed Welcome exemption | 8, 10: deliver live/restart without acceptance search or fresh crypto. Uncommitted obligations remain blocked. |
| `packages/rpc/src/log-delivery.ts:45-46`, `:80-88` live proven entries. Opened pending records | 8: existing live certified settlement remains serviceable. 8, 10: opened completion/restoration requires no fresh crypto/network setup. |

### Phase-2.2c ownership

| Spec item | Here | Elsewhere |
| --- | --- | --- |
| Safety types, immutable fields, independent reducers | Task 1 | -- |
| Atomic event co-write, ack isolation, retirement preservation | Task 2 | -- |
| GroupSafety except recover, event Read, admission projection | Task 3 | Manual authorisation/recover: 2.2e |
| Trust-loss detection, registry/crypto gates, seed/switch | Task 4 | Registry HandleAccess/MLS/crypto consumer wiring: 2.2d |
| Immediate registry/GroupSafety propagation to live peers | Storage refresh/restart here | **2.2d obligation:** wire live registry admission into GroupMLS and peer consumers |
| Peer halt funnel, proof/retry, strong predicates, storage outcomes | Task 5 | -- |
| Both divergence branches, observation limits | Task 6 | -- |
| Repair/cursor evidence removal | Task 7 | conflictEpoch/sourceRecheck removal: 2.2d |
| Durable gates and live public entry points | Task 8 | Batch/open adapters: 2.3 |
| Incoming commit continuations, ephemeral and all recovery gates | Task 9 | New recovery protocol/orchestration: 2.2d |
| Startup ordering and existing storage-only obligations | Task 10 | Full restore-work, leases and batching: 2.3 |
| Restart frozen-settlement publication under a safety hold | -- | **2.3 obligation (must run exempt from safety gates)**, per `docs/superpowers/plans/2026-10-12-spec-p-2-2b-carry-forward.md:12` |
| Shared safety contracts in both modes | Task 11 | -- |
| Real MLS with storage/refresh staging, crash seams | Task 12 | Real HTTP smoke: 2.4 |
| Docs, release intent, final gate | Task 13 | -- |
| Recovery-unavailable with lost spent set: manual re-invite (USER) | Seed refuses 'unavailable' here | **2.2e obligation:** re-invite into a new successor group |

### Dependency and migration order

| First changing task | Prerequisite and migrations owned there |
| --- | --- |
| 1 | Snapshot/mirror/default literals and key-aware applyChanges adapters. Keep ControlHold unchanged. |
| 2 | Atomic co-write and AppOutbox safety-ID refusal. |
| 3 | Cold/accounted safety admission, EntryReads.events, factory binding and type re-exports precede API reopen tests. |
| 4 | GroupSafetyHeldError home/export, all trust-loss reason expectations, including registry-cold. Crypto uses complete HandleAccess fixtures. |
| 5 | ALL fork-evidence literal/callback/mirror migrations, direct strong predicates and fixture split. No durable-send rejection assertion yet. |
| 6 | Only past-epoch behaviour/healing expectations change here. Literal compilation migrations already landed in 5. |
| 7 | Every removed member/type/helper consumer and suffix-prune fixture changes here. |
| 8 | Durable send/enqueue rejection and in-drain opens. Extend assertDurableForkHalt. Migrate every halted-peer enqueue/commit expectation here. |
| 9-10 | Incoming commit continuations and ephemeral/recovery handoffs, then deferred mux startup. Existing direct mux eager behaviour remains. |
| 11-13 | Shared API contracts, real-MLS staging tests, documentation and uncached gate. Exports already exist in producing tasks. |

### Checked HEAD premises

All line references identify `f3fd2b5`, not future line numbers. Proposed files and interfaces are marked Create/Produces.

| Checked source | Consequence |
| --- | --- |
| `packages/rpc/src/classify.ts:253-276`, `packages/rpc/src/peer.ts:1534-1578` | Classifier compares applied.digest and commitDigest. Exact certified loser exclusion runs first. |
| `packages/rpc/src/peer.ts:1608`, `:1652-1678`, `:1451` | Own-unmerged holds, losing healing and one-shot below-cursor reveals require separate migrations. |
| `packages/rpc/src/control/search.ts:53-110`, `:241-245`, `:335-345`, `:460-486` | Evidence already exists. Search deps/writers need the halt callback. |
| `packages/rpc/src/control/slot.ts:22-31`, `:41-128`, `packages/rpc/src/control/operations.ts:25-44`, `:106-127` | Slot/operation deps lack safety callbacks. Expired intent already loses before pulling. Exact applied cleanup currently sits behind holds. |
| `packages/rpc/src/control/store.ts:159-164`, `:224-228`, `:254-327` | applyChanges has no key parameter. deleteAppliedBelow already exists. readmissionChanges takes only snapshot. applyResolved resolves lastMutation proof. |
| `packages/mls-rpc/src/memory-incarnation-stores.ts:160-175`, `:229-238`, `:293-333`, `:443-469` | Defaults, event helper and preservation list exist. Use unlocked atomic co-write. |
| `packages/mls-rpc/src/entry-capability.ts:36-46`, `:70-93`, `packages/mls-rpc/src/memory-group-persistence.ts:240-294` | EntryReads lacks events. Registered coordinator binding and memoryOperation already exist. |
| `packages/mls-rpc/src/registry/cold.ts:98-117`, `:185-192`, `packages/mls-rpc/src/registry/runtime-facts.ts:37-44`, `:115-123` | Both admission projections need fields. Unreadable observations produce no trusted runtime snapshot. |
| `packages/mls-rpc/src/registry/source.ts:13-77`, `packages/mls-rpc/src/registry/registry.ts:391-400`, `packages/mls-rpc/src/registry/access.ts:362` | Source bypasses cold load. Held access reloads separately. All require shared trust diagnosis. |
| `packages/mls-rpc/src/registry/seed.ts:41-65`, `:106-128`, `:164`, `:235`, `packages/mls-rpc/src/registry/switch.ts:128-135`, `:210` | Surviving trust/spent refusal already exists. Seed hard-codes no fork. Installation needs post-drain/work safety checks. |
| `packages/mls-rpc/src/access.ts:18-39`, `:50`, `:122-141`, `packages/mls-rpc/src/registry/types.ts:25-41`, `packages/mls-rpc/src/mls.ts:296` | RegistryHandleAccess lacks open. Production simple access projects handle admission, so registry-to-peer wiring is absent. |
| `packages/mls-rpc/src/crypto.ts:159-183`, `:220-238`, `packages/mls-rpc/src/memory-group-ports.ts:228-246` | Direct crypto is ungated. Outbox lists only app events but currently acknowledges any ID. |
| `packages/rpc/src/peer.ts:330`, `:3608-3672`, `packages/rpc/src/hub-mux.ts:400-402`, `:542`, `:612` | Receive starts eagerly. Startup returns before pending restore. Subscribe retries need a delayed safety check. |
| `packages/rpc/test/fixtures/host-db.ts:150`, `packages/rpc-conformance/src/memory-control-store.ts:192`, `:287-354` | host-db uses rpc applyChanges. Only the structural memory double owns an independent reducer. Both builders/adopters need gates. |
| `packages/rpc-conformance/src/control-store.ts:1161-1201`, `packages/rpc-conformance/src/registry-fixture.ts:219-225` | Prune-below boundary/delete-before-put rows exist. New safety factory member belongs in the fixture type. |

---

### Task 1: Safety types, immutable fields and key-aware reducers

**Files:**
- Create: `packages/rpc/src/control/safety.ts`, `packages/rpc/test/control-safety-fields.test.ts`.
- Modify: `packages/rpc/src/control/types.ts`, `packages/rpc/src/control/store.ts`, `packages/rpc/src/control/search.ts`, `packages/rpc/src/errors.ts`, `packages/rpc/src/index.ts`.
- Modify: `packages/rpc-conformance/src/control-store.ts`, `packages/rpc-conformance/src/memory-control-store.ts`, `packages/rpc-conformance/src/persistence-fixture.ts`, `packages/rpc-conformance/src/index.ts`.
- Modify: `packages/mls-rpc/src/persistence-types.ts`, `packages/mls-rpc/src/index.ts` (same-declaration re-exports), `packages/mls-rpc/src/memory-incarnation-stores.ts`.
- Modify adapters/defaults: `packages/rpc/test/fixtures/host-db.ts`, `packages/mls-rpc/test/fixtures/transactional-access.ts`.
- Modify literals/type checks: `packages/rpc/test/control-store.test.ts`, `packages/rpc/test/peer-fork-settlement.test.ts`, `packages/rpc/test/peer-readmission.test.ts`, `packages/mls-rpc/test/registry-switch.test.ts`, `packages/mls-rpc/test/storage-fixture.test.ts`.

**Interfaces:** Produces rpc exports. GroupForkEvidence retains the existing three variants, moved from search.ts. Conformance mirrors them structurally.

```ts
type SafetyHold = 'fork-halted' | 'recovery-unavailable' | null
type ForkHalt = { eventID: string; evidence: GroupForkEvidence; detectedAt: number }
type GroupSafetyEvent = GroupKey & { id: string; kind: 'group:fork'; halt: ForkHalt }
type RecoveryUnavailableEvent = GroupKey & { id: string; kind: 'group:recovery-unavailable'; reason: 'trust-unreadable' }
function forkEventID(key: GroupKey): string
function recoveryUnavailableEventID(key: GroupKey): string
function controlSafetyHeld(snapshot: ControlSnapshot): SafetyHold
function applyChanges(snapshot: ControlSnapshot, changes: ControlChanges,
  context?: CommitOnceWriteContext | null, key?: GroupKey | null): ControlSnapshot
```

ControlSnapshot/Changes gain C2 fields. Any supplied safety change requires key, even for identical reapply. Existing non-safety callers keep their signature. Adapters pass their fixed key as the fourth argument. ControlSafetyImmutableError lives in rpc errors.ts with constructor `(field: 'forkHalt' | 'recoveryUnavailable')`, name and a getter backed by `#field`. Conformance exports independent `ConformanceSafetyHold` and safety-field mirrors without importing rpc.

- [ ] **Step 1: Write failing tests.** Add shared control-store rows and pure reducer tests:
  - `safety fields start null and project field-only holds`: null strand/ControlHold, each reason, fork precedence when both exist.
  - `safety writes are immutable and atomic`: identical body retained. Different evidence/timestamp, partial values and untyped null clearing reject unchanged. A conflict in either field rejects both-field/operation changes atomically.
  - `safety identity binds the store key`: wrong/missing key, wrong fork ID, recovery ID/kind/groupID/incarnation reject TypeError before any state/marker change.
  - `safety values are defensive`: mutate input and loaded authenticator evidence, then reread unchanged bytes.
  - `stable event IDs`: exact JSON tuple values for group g/incarnation 2.
  Shared assertions match error name/field, never instanceof across implementations.
- [ ] **Step 2: Run red.**
  ```bash
  rtk proxy pnpm --filter @kumiai/rpc exec vitest run test/control-safety-fields.test.ts test/control-store-conformance.test.ts
  rtk proxy pnpm --filter @kumiai/rpc run test:types
  ```
  Expected: new rows fail because fields/validation are absent. New export/type assertions fail until implemented.
- [ ] **Step 3: Implement C1-C3.** Add the pure predicate and an independent copy in memory-control-store. Validate before mutation. host-db uses rpc applyChanges with key. Update defaults/mirrors without narrowing ControlHold.
- [ ] **Step 4: Run green.** Repeat Step 2, then:
  ```bash
  rtk proxy pnpm turbo run build:js build:types
  rtk proxy pnpm turbo run test:types
  ```
  Expected: PASS, including mutual structural type checks and integration consumers.
- [ ] **Step 5: Commit.** Message: `feat(rpc): add immutable safety fields and key validation`.

### Task 2: Atomic event co-write, ack isolation and retirement preservation

**Files:**
- Modify: `packages/mls-rpc/src/memory-incarnation-stores.ts`, `packages/mls-rpc/src/memory-group-ports.ts`, `packages/mls-rpc/src/registry/retired.ts`, `packages/mls-rpc/src/registry/registry.ts` (deleteGroup).
- Modify shared rows: `packages/rpc-conformance/src/group-storage.ts`, `packages/rpc-conformance/src/persistence-fixture.ts`.
- Test: `packages/mls-rpc/test/storage-conformance.test.ts`, `packages/mls-rpc/test/registry-retirement-writes.test.ts`, `packages/mls-rpc/test/group-namespaces.test.ts`, `packages/mls-rpc/test/registry-delete.test.ts`.

**Interfaces:** Consumes Task 1. IncarnationStores.control.apply newly sets a field and inserts exactly one matching event in its transaction. AppOutbox.ackEvent refuses stored safety kinds with TypeError. An absent ID remains an idempotent no-op.

- [ ] **Step 1: Write failing shared rows.** `halt and event co-commit`: exactly one equal event/body after commit. `fault/ambiguous COMMIT preserves both-or-neither`: armWorkFault and pending proof for commit/rollback. `conflicting same-ID event rolls back control`: preinstall different content, expect unchanged field/event. `ack keeps halt and identical reapply does not resurrect event`: body/timestamp unchanged. Repeat for recoveryUnavailable. `outbox cannot ack fork event`: TypeError, event remains. `clear/terminal/retire/delete preserve safety`: both fields and unacked events remain addressable. Retirement preserves local history. No safety clear enters retirement changes.
  Shared `safety fields permit certified storage finalisation`: existing settlement removal/finalisation at `packages/mls-rpc/src/memory-incarnation-stores.ts:253-267` and `packages/mls-rpc/src/memory-group-ports.ts:183-207` succeeds under either field. Preserve original occurrence, atomic entry/obligation removal and retained published event. Add no publication service.
- [ ] **Step 2: Run red.**
  ```bash
  rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/storage-conformance.test.ts test/registry-retirement-writes.test.ts test/group-namespaces.test.ts test/registry-delete.test.ts
  rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
  ```
  Expected: atomic event/ack-isolation rows FAIL before implementation.
- [ ] **Step 3: Implement C4.** Use unlocked event helpers within control.apply. Enforce C3 again at the storage boundary. Extend explicit clearTransport preservation. Permit deletion subject to existing drainage/unsettled-control rules.
- [ ] **Step 4: Run green.** Repeat Step 2. Expected: PASS in real-MLS/model storage modes, including proof outcomes.
- [ ] **Step 5: Commit.** Message: `feat(mls-rpc): co-write safety events and preserve halted tombstones`.

### Task 3: GroupSafety, event Read capability and admission projection

**Files:**
- Create: `packages/mls-rpc/src/safety.ts`, `packages/mls-rpc/src/registry/safety.ts`, `packages/mls-rpc/test/group-safety.test.ts`.
- Modify: `packages/mls-rpc/src/entry-capability.ts`, `packages/mls-rpc/src/memory-group-persistence.ts`, `packages/mls-rpc/src/registry/registry.ts`, `packages/mls-rpc/src/registry/runtime-facts.ts`, `packages/mls-rpc/src/registry/cold.ts`, `packages/mls-rpc/src/persistence-errors.ts`, `packages/mls-rpc/src/index.ts`.
- Modify: `packages/rpc/src/index.ts` (type-only LogHub/MailboxHub re-exports).
- Modify: `packages/rpc-conformance/src/persistence-fixture.ts`, `packages/rpc-conformance/src/ownership-phases.ts`, `packages/mls-rpc/test/fixtures/registry.ts`, `packages/mls-rpc/test/storage-fixture.test.ts`.
- Test: `packages/mls-rpc/test/ownership-phases-conformance.test.ts`, `packages/mls-rpc/test/registry-runtime.test.ts`.

**Interfaces:** Consumes Tasks 1-2 and registered EntryCapability. Produces the spec's GroupSafety, ManualRecovery, RecoveryTarget and createGroupSafety signatures:

```ts
type ManualRecovery = { mode: 'resync'; targetID: string } | { mode: 'successor'; successor: GroupKey }
type RecoveryTarget = { id: string; commitTopicID: string; hub: LogHub & MailboxHub }
type GroupSafety = {
  epochAuthenticator(key: GroupKey): Promise<EpochIdentity | null>
  reportFork(key: GroupKey, evidence: GroupForkEvidence): Promise<void>
  recover(key: GroupKey, choice: ManualRecovery): Promise<GroupKey>
  events(key: GroupKey): Promise<Array<GroupSafetyEvent | RecoveryUnavailableEvent>>
  ackEvent(key: GroupKey, id: string): Promise<void>
}
function createGroupSafety<TTx extends GroupTransaction>(params: {
  registry: GroupHandleRegistry; persistence: GroupPersistence<TTx>; mls: GroupMLS
  resolveTarget: (targetID: string) => Promise<RecoveryTarget>
}): GroupSafety
// EntryReads and independent ConformanceEntryReads mirror:
events(incarnation: number): Promise<Array<PersistenceEvent>>
type RegistrySafetyCapability<TTx extends GroupTransaction> = {
  binding: object; entry: EntryCapability<TTx>
  latch(key: GroupKey, reason: NonNullable<SafetyHold>): void
  held(key: GroupKey): SafetyHold
}
```

Register the private safety capability by registry object identity in registry/safety.ts. Its binding must equal coordinatorBinding(params.persistence). Latches survive owner invalidation only for their exact GroupKey. Admission changes synchronously. Do not emit epoch listeners for latch-only changes. ForkReportRefusedError has constructor `({ reason: 'key' | 'epoch' | 'authenticator' })`, name and `#reason` getter. ManualRecoveryUnavailableError has a stable name.

reportFork snapshots evidence/key/timestamp before awaiting. Any existing forkHalt for the requested incarnation gives storage-neutral success and latches only, regardless of body equality. Otherwise prepare reads lifetime/trust/control, validates C15 and latches immediately upon successful validation. Work rechecks the same active key/identity and writes once, or succeeds without writing if a halt already exists. Entry proof fences caller completion. Rollback retains only that key's latch. events uses Read and filters the two kinds. ackEvent rejects an existing non-safety ID with TypeError. An absent ID, including repeat ack, is a storage-neutral no-op.

- [ ] **Step 1: Write failing tests.** Both registry fixture modes:
  - `field-only safety projects cold and accounted admission`: C11 precedence, strand/ControlHold null, same result after reopen.
  - `committed identity survives unreadable state`: active key returns copied trust identity. Wrong/retired/absent/deleted key returns null. Typed unreadable trust returns null, transient error propagates.
  - `validated report latches in prepare`: suspended work exposes fork admission before proof. No listener promise until a committed observation.
  - `report refuses moved or invalid identity`: epoch/incarnation moves between call and entry, wrong group/key/local bytes, equal remote, future non-authenticator epoch. Refusal reason exact, no latch/event/revision change.
  - `report snapshots caller evidence before await`: mutate supplied bytes while queued, stored evidence equals the original.
  - `unreadable report trust refuses without fork latch`: GroupUnavailableError reason invalid, no fork event. Task 4 adds trust-loss persistence and migrates the error.
  - `existing-halt report and ack are storage-neutral`: different-body, duplicate and after-ack reports create no revision/event. Latch only. Tombstone ack removes only that event and keeps safety.
  - `report rollback isolates incarnation latch`: no durable rows. A later valid fresh incarnation does not inherit it.
  - `factory rejects foreign binding/unregistered registry`; `recover refuses unavailable manual recovery`.
  Shared ownership row `event reads are neutral and proof fenced`: Read only, unchanged lifetime revision/state version/marker, tombstone access, defensive event bytes, wait behind unresolved proof.
- [ ] **Step 2: Run red.**
  ```bash
  rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/group-safety.test.ts test/ownership-phases-conformance.test.ts test/registry-runtime.test.ts
  rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
  ```
  Expected: new capability/API/projection rows FAIL.
- [ ] **Step 3: Implement C11, C14-C16.** Add EntryReads.events via one memoryOperation over unlocked incarnation stores. Add cold/accounted projections now, before API reopen tests. Keep safety overlay usable when the trusted snapshot is null.
- [ ] **Step 4: Run green.** Repeat Step 2, then:
  ```bash
  rtk proxy pnpm turbo run build:js build:types
  rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-
  rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
  rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types
  rtk proxy pnpm turbo run test:types
  ```
  Expected: PASS. RecoveryTarget needs no new dependency.
- [ ] **Step 5: Commit.** Message: `feat(mls-rpc): expose GroupSafety with fenced reads and keyed latches`.

### Task 4: Shared trust-loss detection, registry/crypto refusal and installation rechecks

**Files:**
- Modify: `packages/mls-rpc/src/registry/safety.ts`, `packages/mls-rpc/src/safety.ts` (reportFork prepare), `packages/mls-rpc/src/registry/source.ts`, `packages/mls-rpc/src/registry/cold.ts`, `packages/mls-rpc/src/registry/access.ts`, `packages/mls-rpc/src/registry/seed.ts`, `packages/mls-rpc/src/registry/switch.ts`, `packages/mls-rpc/src/registry/registry.ts`, `packages/mls-rpc/src/crypto.ts`, `packages/mls-rpc/src/persistence-errors.ts`.
- Modify: `packages/rpc/src/errors.ts`, `packages/rpc/src/index.ts` (GroupSafetyHeldError home/export).
- Test/Create: `packages/mls-rpc/test/registry-safety-admission.test.ts`, `packages/mls-rpc/test/crypto-safety.test.ts`.
- Modify tests: `packages/mls-rpc/test/registry-cold.test.ts:145-153`, `packages/mls-rpc/test/registry-source.test.ts`, `packages/mls-rpc/test/registry-access.test.ts`, `packages/mls-rpc/test/registry-runtime.test.ts`, `packages/mls-rpc/test/registry-seed.test.ts`, `packages/mls-rpc/test/registry-switch.test.ts`, `packages/mls-rpc/test/group-safety.test.ts`.
- Modify shared rows/fixtures: `packages/rpc-conformance/src/registry.ts`, `packages/mls-rpc/test/fixtures/registry.ts`.

**Interfaces:** Consumes Task 3's keyed safety capability/projection. Produces:

```ts
class GroupSafetyHeldError extends Error // constructor(reason: NonNullable<SafetyHold>), #reason getter
// GroupUnavailableReason += 'recovery-unavailable'
// RegistryResyncRefusalReason += 'fork-halted' | 'recovery-unavailable'
function readRetainedTrust(reads: EntryReads, key: GroupKey): Promise<GroupRecoveryTrust>
// Registry-owned helper, invoked only after the failing entry releases:
persistTrustUnavailable(key: GroupKey): Promise<void>
```

readRetainedTrust throws a typed trust-unavailable diagnosis containing key/cause for missing, typed corrupt/unreadable or empty-spent trust. Installed-key mismatch remains invalid with no write. Isolate trust errors from metadata/state/control errors. Transient I/O escapes unchanged. RecoverySource, cold load, held-access reload and reportFork prepare use this helper. After the failing entry releases, latch that incarnation and run the existing safety-only transition. Recheck lifetime/control without state/trust opens and co-write once. An existing field is a no-op. A moved lifetime installs nothing for the new owner. Unreadable control remains invalid with no write. reportFork rejects GroupSafetyHeldError('recovery-unavailable') after diagnosis. epochAuthenticator only returns null for typed unreadable trust and never writes.

Accounted unreadable-trust observations (`packages/mls-rpc/src/registry/runtime-facts.ts:34-41` → `packages/mls-rpc/src/registry/registry.ts:135-142`), including readable status with null trust at `:137`, schedule diagnosis outside the producing ownership entry. Re-read through readRetainedTrust for that active GroupKey before classification. Only C12's typed losses latch/persist. Transient diagnostic I/O writes nothing. Existing fields cause no observation/write loop.

Guard mutate/replace/adopt before host/MLS callbacks and recheck inside prepare/work, including queued/prepared operations and volatile latches. Preserve proof-backed no-op replay. Seed retains every surviving trust/spent check. It reads latest control for active/tombstone and checks pending fork latch before drain and during prepare/work. Unreadable latest control refuses unavailable and writes nothing. Switch checks both pending/committed reasons before drain and in prepare/work, even after event ack. A recoveryUnavailable field alone with valid retained trust permits otherwise admissible seed into n+1.

Crypto tests use a **complete existing HandleAccess fixture or complete stub** with admission returning the reason. Use real-group/transactional-access fixtures' existing open method. No registry-backed crypto, synthetic open or `as HandleAccess`. Check admission at entry and inside queued access callbacks before encrypt/decrypt/key derivation. Preserve GroupSafetyHeldError through durable unwrap's catch. Direct sealEntries/openEntries use safety-specific guards, preserving ordinary lapsed control reads.

- [ ] **Step 1: Write failing tests.** Each safety reason with strand/ControlHold null:
  - `queued mutate/replace/adopt refuses before callbacks`: callback/adoption-factory/MLS counters zero, no state/control/marker change.
  - `crypto refuses every new crypto boundary`: wrap, ephemeral/durable unwrap, sealEntries and openEntries reject GroupSafetyHeldError. Encrypt/decrypt/exporter counts zero. Queue before halt, resume after halt: same refusal.
  - `recoverySource alone persists trust loss`: state and trust corrupt, never call access, field/event with exact stable ID persist after reopen.
  - `held access reload persists trust loss`: obtain access first, corrupt trust, invoke held read/mutate, same durable diagnosis.
  - `accounted trust loss persists after control-only transition`: registry-runtime.test.ts, corrupt trust, then only control.apply. Stable field/event, held key, no recovery, survives reopen. Repeat diagnosis adds no revision/event. Variants: both state and trust corrupt. Missing trust with readable status and trust null (`packages/mls-rpc/src/registry/registry.ts:137`), then control-only transition.
  - `transient accounted diagnosis writes nothing`: observational unreadable status followed by transient readRetainedTrust failure produces no durable hold/event.
  - `missing/corrupt trust and state-independent variants`: one hold/event, repeat detection writes no revision. Unreadable control gives invalid with no write.
  - `report trust loss persists recovery refusal`: missing/typed corrupt/empty-spent trust gives one recovery field/event and GroupSafetyHeldError reason recovery-unavailable. Installed-key mismatch remains invalid, no write. Transient report I/O propagates unchanged.
  - `transient trust I/O is not safety loss`: exact error propagates, no latch/control/event. Metadata corruption is not trust loss.
  - `seed keeps surviving spent requirement`: missing/corrupt/empty-spent trust plus unspent-looking Welcome refuses unavailable, nothing written/burned. No fallback/reconstruction.
  - `seed unreadable latest control refuses unavailable`: active and tombstoned latest sources, no writes/package burn/installation.
  - `seed field-only recovery hold readmits`: valid nonempty trust, fresh admissible Welcome, n+1 admissible in the same registry. Tombstone keeps recovery field/event.
  - `spent precedes persisted fork halt`: known spent alternate Welcome refuses spent. Fresh Welcome refuses fork-halted for active and tombstoned source.
  - `installation rechecks hook-created halt`: halt in retirement hook prevents seed/switch install. Pending failed-write latch also refuses.
  - `switch refuses both fields after ack`: trust readable, no drain/install, exact RegistryResyncRefusedError reason.
  Migrate registry-cold and unreadable-report expectations here, when their behaviour changes.
- [ ] **Step 2: Run red.**
  ```bash
  rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-safety-admission.test.ts test/crypto-safety.test.ts test/registry-cold.test.ts test/registry-source.test.ts test/registry-runtime.test.ts test/registry-seed.test.ts test/registry-switch.test.ts test/group-safety.test.ts
  rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
  ```
  Expected: new trust-persistence/gate/recheck rows FAIL.
- [ ] **Step 3: Implement C12-C13 and the crypto guards.** Reuse the shared helper at every diagnostic path. Retain key-scoped failed-write latches. Introduce/export GroupSafetyHeldError here, before any task throws it.
- [ ] **Step 4: Run green.** Repeat Step 2, then build siblings and run all registry tests:
  ```bash
  rtk proxy pnpm turbo run build:js build:types
  rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-
  rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
  rtk proxy pnpm --filter @kumiai/rpc run test:types
  rtk proxy pnpm turbo run test:types
  ```
  Expected: PASS. Production registry crypto/MLS consumer adapters remain absent.
- [ ] **Step 5: Commit.** Message: `feat(mls-rpc): persist trust-loss holds and gate registry work`.

### Task 5: Proven peer halt funnel, strong predicates and storage-only operation service

**Files:**
- Modify: `packages/rpc/src/peer.ts`, `packages/rpc/src/peer-types.ts`, `packages/rpc/src/host-boundary.ts`, `packages/rpc/src/control/search.ts`, `packages/rpc/src/control/slot.ts`, `packages/rpc/src/control/operations.ts`, `packages/rpc/src/control/rejoin.ts`, `packages/rpc/src/control/store.ts`.
- Modify: `packages/mls-rpc/src/control-build.ts`, `packages/mls-rpc/src/control-adoption.ts`, `packages/mls-rpc/src/memory-group-persistence.ts`, `packages/mls-rpc/src/registry/access.ts`, `packages/mls-rpc/src/registry/retired.ts`.
- Modify mirrors/doubles: `packages/rpc-conformance/src/control-store.ts`, `packages/rpc-conformance/src/memory-control-store.ts`, `packages/rpc/test/fixtures/host-db.ts`, `packages/rpc/test/fixtures/peer.ts`, `packages/rpc/test/fixtures/memory-group-mls.ts`, `packages/rpc/test/fixtures/control-hold.ts`, `packages/mls-rpc/test/fixtures/transactional-access.ts`.
- Create: `packages/rpc/test/peer-fork-halt.test.ts`, `packages/rpc-conformance/src/control-safety.ts`, `packages/mls-rpc/test/control-safety-conformance.test.ts`.
- Modify: `packages/rpc-conformance/src/index.ts`, `packages/rpc/test/control-store-conformance.test.ts`, `packages/mls-rpc/test/control-build.test.ts`, `packages/mls-rpc/test/control-adoption.test.ts`, `packages/mls-rpc/test/control-validation.test.ts`, `tests/integration/test/control-first-valid.test.ts`.
- Migrate rpc tests: `packages/rpc/test/peer-durable-effects.test.ts`, `packages/rpc/test/peer-cursor-table.test.ts`, `packages/rpc/test/peer-rejoin-record.test.ts`, `packages/rpc/test/control-operations.test.ts`, `packages/rpc/test/control-search.test.ts`, `packages/rpc/test/control-slot.test.ts`, `packages/rpc/test/peer-failed-heal-strand.test.ts`, `packages/rpc/test/peer-strand-observation.test.ts`, `packages/rpc/test/peer-recover-lane.test.ts`, `packages/rpc/test/peer-locked-commit-epoch.test.ts`, `packages/rpc/test/peer-fork-settlement.test.ts`.

**Interfaces:** Consumes Tasks 1-4. Produces peer `haltFork(evidence: GroupForkEvidence): Promise<void>`, `safetyHold(): SafetyHold`, internal `latchSafetyHold(reason: NonNullable<SafetyHold>): void`, C18's `hardControlHeld(): boolean`/`controlHoldPresent(): boolean`, and `onSafetyEvent?: (event: GroupSafetyEvent) => void | Promise<void>`. latchSafetyHold synchronously retains the reason, sets healRequested=false and preserves stranded. Add required `haltFork(evidence: GroupForkEvidence): Promise<void>` and `safetyHold(): SafetyHold` to ControlSearchDeps/ControlSlotDeps/OperationDeps and shared fixtures. Update every caller. Non-safety ControlHold callback stays for its two remaining reasons.

haltFork retains one immutable pending body per incarnation before awaits. Latch immediately and set healRequested=false without setting stranded. Later detections while a body is pending or committed only latch: no second write/notification. Each storage attempt uses a fresh mutationID with the same body/eventID through `applyResolved(control, { forkHalt: halt }, mutationID, sleep, signal)`. Ambiguity joins proof there. Proven rollback retries storage only with 100 ms backoff doubling to 15 s.

ControlSafetyImmutableError, or reload of a differing non-null forkHalt, stops retries and keeps the latch. Notify at most once after proven commit, only when stored halt equals this peer's body. Contain callback errors. A loaded committed field latches before further MLS reads. Guard every healRequested assignment and stranded-clearing continuation with safety, including after awaits. withEpoch maps safety to SendNotAdmissibleError. Durable acceptance/enqueue assertions land in Task 8.

**Strong-hold audit:** Apply controlSafetyHeld independently of strand/ControlHold at every site below. Preserve acceptance-unknown's additional build/publication restrictions. Move safe cleanup ahead of new-work gates.

| Checked HEAD sites | Required adjustment |
| --- | --- |
| `packages/rpc/src/control/store.ts:77` controlAdoptionAllowed and its users | Refuse field-only safety before adoption. |
| `packages/rpc/src/control/slot.ts:41`, `packages/rpc/src/control/rejoin.ts:158`, `packages/rpc/src/control/operations.ts:111`, `:198` | Slot/rejoin/build gates. Exact saved applied cleanup/outcomes use storage-only evidence first. |
| `packages/rpc/src/peer.ts:1364`, `:2297`, `:2411`, `:2487`, `:2522`, `:2542`, `:2574`, `:2676`, `:3661`, `:3726` | Include safety at every direct hold check. Preserve committed Welcome and storage-only cleanup exceptions. |
| `packages/rpc/src/peer.ts:887`, `:891`, `:2063`, `:2118`, `:2293`, `:2338`, `:2573`, `:2606`, `:3000`, `:3182`, `:3256`, `:3260`, `:3267`, `:3496`, `:3561`, `:3618` hardControlHeld callers | Covered by C18 redefinition. ControlHold-only sites `:293-296`, `:2057` use controlHoldPresent. |
| `packages/rpc/src/peer.ts:1063` responder entry, `:1076` blocked reader, cursor/strand writers `:775-802`, `:811-816`, `:2237-2249` | Entry/blocked/healing gates consult `safetyHold() !== null` directly. Never derive persisted stranded from safety. Storage cleanup preserves cursor/strand, including real pre-existing strand. |
| `packages/rpc/src/peer.ts:658` durable held reader | Add `safetyHold() !== null` directly to held. Preserve the proven-settlement exception route. |
| `packages/rpc/src/peer.ts:1399` takeHead reader | Check `safetyHold() !== null` before updating/certifying head. |
| `packages/rpc/src/peer.ts:2400`, `:2409` reconcileAbsent readers (`:2398-2414`) | Return false when `safetyHold() !== null` at entry and after walk, including through=null. Replace the removed fork-evidence clause with safety. |
| `packages/rpc/src/peer.ts:2387-2396` followWinner, post-walk readEvidence `:2389-2390` | Return unavailable when `safetyHold() !== null` at entry, after walk and after readEvidence. No post-walk evidence read under hold. |
| `packages/rpc/src/peer.ts:2488` publication reader | Check `safetyHold() !== null` before source reads and at the final handoff. |
| `packages/rpc/src/peer.ts:2528` pullToHead reader | Check `safetyHold() !== null` at entry/after awaits. Stop before further MLS/recovery work. |
| `packages/rpc/src/peer.ts:3175` discarded/healing reader | When `safetyHold() !== null`, keep healRequested=false for every discarded reason. |
| `packages/rpc/src/peer.ts:3340` recovery continuation reader | Check `safetyHold() !== null` inside runSerial at entry/after awaits before continuing. |
| `packages/rpc-conformance/src/memory-control-store.ts:287`, `:344`, `:353` | Independent saveBuilt/adoption guards. |
| `packages/rpc/test/fixtures/host-db.ts:169`, `:183`, `:278`, `packages/mls-rpc/test/fixtures/transactional-access.ts:185`, `:238` | Real reducer adapters and independent builder conditions. |
| `packages/mls-rpc/src/control-build.ts:115`, `:211`, `:319`, `packages/mls-rpc/src/memory-group-persistence.ts:719`, `:721` | Provider prepare/save/work rechecks, ordinary state-install gates. |
| `packages/mls-rpc/src/registry/access.ts:277`, `packages/mls-rpc/src/registry/retired.ts:188`, `packages/mls-rpc/src/control-adoption.ts:41` | Ordinary destination/adoption and uncommitted retired Welcome release. |
| `packages/rpc/test/fixtures/peer.ts:481`, `packages/rpc/test/fixtures/memory-group-mls.ts:1087` | Fixture build/adoption cannot silently remain more permissive. |

**Migration inventory:** All fork-evidence literals change here, including `packages/rpc/test/peer-failed-heal-strand.test.ts:89`, `:232`, `:251`, `peer-strand-observation.test.ts:217`, `peer-recover-lane.test.ts:538`, `peer-locked-commit-epoch.test.ts:91`, `peer-fork-settlement.test.ts:438`. Migrate `packages/mls-rpc/test/control-validation.test.ts:897-899`, `:1032` and `packages/rpc-conformance/src/control-store.ts:39`. Update every createControlSearch/settleControlSlot caller in the Files list, including `packages/rpc/src/control/operations.ts:127`. These migrations keep their original detector triggers. Split control-hold.ts: assertDurableControlHold becomes unsupported-version only. Add assertDurableForkHalt for durable field/restart/control-recovery assertions. Task 8 adds its send/enqueue assertions. Leave `peer-unknown-commit-frame-version.test.ts` and `peer-unknown-frame-version.test.ts` callers unchanged.

Produce `runControlSafetyContract(fixture: ControlSafetyFixture): void` in rpc-conformance/control-safety.ts. ControlSafetyFixture wraps actual prepareBuild/saveBuilt/adopt boundaries. Its methods are `prepareValid(): Promise<void>`, `hold(reason: NonNullable<ConformanceSafetyHold>): Promise<void>`, `prepareBuild(): Promise<'refused' | 'changed'>`, `saveBuilt(): Promise<'refused' | 'changed'>`, `adopt(): Promise<'refused' | 'changed'>`, `snapshot(): Promise<{control: ConformanceControlSnapshot; state: Uint8Array | null; version: number}>`, and `cryptoCalls(): number`. Run it against real persistence/build/adoption, transactional-access, host-db, memory-control-store and the memory MLS/peer builder. Wrappers normalise existing refusal results only. They must not supply the missing gate.

- [ ] **Step 1: Write failing tests.**
  - `own/search/slot fork detectors halt`: exact evidence, no persisted strand/cursor mutation, direct slot/search callers included.
  - `halt proof controls notification`: delayed committed proof gives exactly one notification afterwards. Pending proof emits none. Rollback emits none, retry commits the same body/eventID with fresh mutationID. Callback throw/rejection is contained.
  - `two detectors before proof write once`: one body/write, zero retries after commit, at most one notification. Differing stored body or ControlSafetyImmutableError stops retries and keeps latch.
  - `host report precedes peer detection`: peer latches, zero apply retries, no peer notification. Stored host body/event remains unchanged.
  - `storage-written halt latches on wakeup`: direct store write, no detector. Refresh latches, stranded unchanged/healRequested=false, zero sends/recovery. Run storage-only cleanup afterwards: persisted cursor/strand deep-equal pre-halt snapshot, including a real existing strand. Cleanup checks non-interference. Task 9's in-flight cursor test discriminates R22.
  - `admission safety latches synchronously`: each mls.sendAdmission safety reason blocks new control/recovery. Repeated wakes never set healRequested true.
  - `control handoff rechecks after readEvidence`: suspend read, latch, resume, zero publish.
  - `direct control search stops under safety`: no fetch/readEvidence/restoreValidation starts after the callback holds. A mid-await latch prevents the next validation/fetch.
  - `in-flight absence search stays unknown after latch`: suspend search before reconcileAbsent, variants `through === null` and bounded. Latch, resume: no absence proof or lost/landed outcome. Unresolved built work reaches C17 unknown. followWinner starts no post-walk readEvidence under hold.
  - `never-built deadline under halt loses`; `built deadline under halt is unknown`; `pending publication deadline under halt is unknown`; `accepted unresolved deadline under halt is unknown`; `known outcome/facts remain`: separate rows, live/restart, volatile latch with absent durable field included. Zero fetchTopic/publish/pullToHead/readHead/searchLog/prepareBuild/MLS calls. Outcome ack preserves slot/evidence.
  - `exact applied slot cleans up under halt`: use saved snapshot.applied, no host readEvidence/search/adoption. Delete lingering operation without deleting slot or changing proven outcome.
  - Shared `field-only safety refuses direct builders/adopters`: both reasons, null strand/ControlHold. No state/version/slot/bytes changes or crypto. Already prepared work halted before save also refuses.
  - `unsupported/soft hold regressions`: unsupported stays ControlHold and acceptance-unknown permits gap recovery.
- [ ] **Step 2: Run red.**
  ```bash
  rtk proxy pnpm --filter @kumiai/rpc exec vitest run test/peer-fork-halt.test.ts test/control-store-conformance.test.ts
  rtk proxy pnpm --filter @kumiai/rpc run test:types
  ```
  Expected: new halt/proof/direct-gate rows FAIL.
- [ ] **Step 3: Implement the funnel and C6/C17-C18.** Migrate C5 and all callers/mirrors together. Schedule storage-only deadlines without control-topic initialisation or MLS reads. Use stored applied rows for exact cleanup before the hold gate. Run the review scan:
  ```bash
  rtk proxy rg -n "reason !== 'acceptance-unknown'|controlHold !== null|hardControlHeld|healRequested = true|stranded = false" packages tests --glob '!**/lib/**'
  rtk proxy rg -n '\bstranded\b' packages/rpc/src/peer.ts
  rtk proxy rg -n "fork-evidence|createControlSearch\(|settleControlSlot\(" packages tests --glob '!**/lib/**'
  ```
  Expected: no fork-evidence literals. Review every remaining hold/caller and stranded reader for direct safety or an explicitly unreachable path under hold. Cursor/strand writers remain real-strand-only. Preserve soft semantics.
- [ ] **Step 4: Run green.**
  ```bash
  rtk proxy pnpm turbo run build:js build:types
  rtk proxy pnpm --filter @kumiai/rpc run test
  rtk proxy pnpm --filter @kumiai/mls-rpc run test
  rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types
  rtk proxy pnpm --filter @kumiai/integration-tests exec vitest run test/control-first-valid.test.ts
  rtk proxy pnpm --filter @kumiai/integration-tests run test:types
  rtk proxy pnpm turbo run test:types
  ```
  Expected: PASS, including the shared direct-builder/adopter rows and all initial literal migrations.
- [ ] **Step 5: Commit.** Message: `feat(rpc): prove and retry fork halts across control paths`.

### Task 6: Halt both past-epoch branches and remove their healing trigger

**Files:**
- Modify: `packages/rpc/src/peer.ts:1652-1678`, `:2113`, `packages/rpc/src/peer-types.ts` (StrandKind).
- Extend: `packages/rpc/test/peer-fork-halt.test.ts`.
- Migrate behaviour in rpc tests: `packages/rpc/test/peer-recover-lane.test.ts`, `packages/rpc/test/peer-failed-heal-strand.test.ts`, `packages/rpc/test/peer-commit-log-replay.test.ts`, `packages/rpc/test/peer-strand-observation.test.ts`, `packages/rpc/test/peer-final-fixes.test.ts`, `packages/rpc/test/peer-delayed-bootstrap.test.ts`, `packages/rpc/test/peer-locked-commit-epoch.test.ts`, `packages/rpc/test/peer-recovery.test.ts`, `packages/rpc/test/peer-control-search-walk.test.ts`, `packages/rpc/test/commit-classify.test.ts`, `packages/rpc/test/peer-fork-settlement.test.ts`.

**Interfaces:** Consumes Task 5. Classifier output unchanged. Produces StrandKind `'fork-winning'`. Walker evidence is `{kind: 'digest-divergence', epoch: header.epoch, position, localDigest: applied.digest, remoteDigest: commitDigest}`. These are MLS commit digests, not sealed entry/full-payload digests.

- [ ] **Step 1: Write failing tests.** `both branches halt without advancing`: exact independently computed commit digests, unchanged cursor/head/applied/outcomes/responses, no certifying or superseded external reply. Losing/winning onStrand keeps observed confidence. `no healing after delayed retries`: advance beyond retry backoff, zero recovery/rejoin/reenact, healRequested never true. `restart divergence stays held`. `no applied history stays non-fork`. `identical re-sealed commit stays history`. `certified loser exclusion binds exact tuple`: wrong key/epoch/position/payload is not exempt. Keep ahead/gap confidence and ordinary recovery tests.
- [ ] **Step 2: Run red.**
  ```bash
  rtk proxy pnpm --filter @kumiai/rpc exec vitest run test/peer-fork-halt.test.ts test/peer-control-search-walk.test.ts test/commit-classify.test.ts
  rtk proxy pnpm --filter @kumiai/rpc run test:types
  ```
  Expected: winning/losing no-advance/no-heal assertions FAIL.
- [ ] **Step 3: Implement C7.** Return immediately after halt detection, including below-cursor reveals. Apply C6 through the common latch without setting stranded. Migrate only changed branch/healing expectations now. Replace pure healing-mechanics rows with equivalent halt/history assertions and record each replacement.
- [ ] **Step 4: Run green.** `rtk proxy pnpm --filter @kumiai/rpc run test`, then `rtk proxy pnpm turbo run build:js build:types` and `rtk proxy pnpm turbo run test:types`. Expected: PASS, including the public union's consumers.
- [ ] **Step 5: Commit.** Message: `feat(rpc): halt both observed fork branches without healing`.

### Task 7: Remove automatic repair and every cursor-fork consumer

**Files:**
- Reduce: `packages/rpc/src/control/forks.ts` (keep appliedRows only).
- Modify: `packages/rpc/src/control/types.ts`, `packages/rpc/src/control/store.ts`, `packages/rpc/src/control/rejoin.ts`, `packages/rpc/src/peer.ts`, `packages/rpc/src/index.ts`.
- Modify: `packages/mls-rpc/src/control-build.ts:115`, `:223`, `:319`, `packages/mls-rpc/src/memory-incarnation-stores.ts:465`.
- Modify doubles: `packages/rpc-conformance/src/control-store.ts:81`, `:400`, `:930`, `packages/rpc-conformance/src/memory-control-store.ts:297`, `packages/rpc-conformance/src/index.ts`, `packages/rpc/test/fixtures/host-db.ts:183`, `packages/mls-rpc/test/fixtures/transactional-access.ts:185`.
- Modify peer member consumers: `packages/rpc/src/peer.ts:791`, `:816`, `:2248`, `:2360`, `:3424`.
- Migrate tests: `packages/mls-rpc/test/group-namespaces.test.ts:1340`, `packages/mls-rpc/test/registry-retirement-writes.test.ts:368`, `packages/mls-rpc/test/registry-access.test.ts:715`, `packages/rpc/test/peer-control-settlement.test.ts:976`, `packages/rpc/test/peer-fork-settlement.test.ts`, `packages/rpc/test/peer-readmission.test.ts`, `packages/rpc/test/control-store.test.ts`, `packages/rpc/test/peer-final-fixes.test.ts`.

**Interfaces:** Consumes Tasks 5-6. Removes ForkEvidence/ConformanceForkEvidence, cursor.fork, forkEvidence/forkSettlement and deleteAppliedFrom. Retains `ControlChanges.deleteAppliedBelow?: number` and `readmissionChanges(snapshot: ControlSnapshot): ControlChanges`. Readmission uses `deleteAppliedBelow: Number.MAX_SAFE_INTEGER`. No new prune API or epoch argument.

- [ ] **Step 1: Write failing readmission assertion.** `readmission clears applied with existing prune-below`: applied equals `[]`, owed outcomes/Welcomes and safety fields remain. Check preserved existing deleteAppliedBelow boundary rows at control-store.ts:1161-1201, adapting their suffix-delete setup. Add a boundary row only if migration removes that coverage. Their E-1 removal, E/E+1 retention and incarnation isolation remain unchanged.
- [ ] **Step 2: Run red.**
  ```bash
  rtk proxy pnpm --filter @kumiai/rpc exec vitest run test/peer-readmission.test.ts test/control-store-conformance.test.ts test/control-store.test.ts
  rtk proxy pnpm --filter @kumiai/rpc run test:types
  ```
  Expected: new change-set assertion fails until deleteAppliedBelow replaces deleteAppliedFrom. Existing invariant rows remain regressions.
- [ ] **Step 3: Remove and migrate C8 consumers.** Preserve safety/history instead of manufacturing a replacement fork cursor. Use conflictEpoch null for new recovery builds. Scan broadly:
  ```bash
  rtk proxy rg -n 'forkSettlement|deleteAppliedFrom|forkEvidence\(|\bForkEvidence\b|\bConformanceForkEvidence\b|\.fork\b|\?\.fork\b|\bfork\s*:' packages tests --glob '!**/lib/**'
  ```
  Expected: removed types/helpers/members/literals have no hits. Review legitimate unrelated store `.fork()` methods and `fork:` store methods separately. They remain valid.
- [ ] **Step 4: Run green.**
  ```bash
  rtk proxy pnpm turbo run build:js build:types
  rtk proxy pnpm --filter @kumiai/rpc run test
  rtk proxy pnpm --filter @kumiai/mls-rpc run test
  rtk proxy pnpm turbo run test:types
  ```
  Expected: PASS. Repository-wide types, including integration, are the removal gate.
- [ ] **Step 5: Commit.** Message: `refactor(rpc): remove fork repair and cursor evidence`.

### Task 8: Durable gates, per-frame opens and live entry-point semantics

**Files:**
- Modify: `packages/rpc/src/peer.ts`, `packages/rpc/src/app-outbox.ts`, `packages/rpc/src/app-lane.ts`, `packages/rpc/src/log-delivery.ts`, `packages/rpc/test/fixtures/control-hold.ts` (extend assertDurableForkHalt only).
- Create: `packages/rpc/test/peer-safety-gates.test.ts`, `packages/rpc/test/app-lane-safety.test.ts`.
- Modify/Test: `packages/rpc/test/peer-log-delivery.test.ts`, `packages/rpc/test/peer-failed-heal-strand.test.ts`.

**Interfaces:** Consumes Task 4's GroupSafetyHeldError and Task 5's safetyHold/latchSafetyHold. AppLaneParams adds `safetyHold?: () => SafetyHold` and `onSafetyHeld?: (reason: NonNullable<SafetyHold>) => void`, defaulting to null/no-op for direct callers. Peer supplies safetyHold/latchSafetyHold for both pull/pre-adoption drains. Outbox admission combines mls admission with the current latch. Public semantics follow the error table. resync refuses safety. reauthorize(): void throws GroupSafetyHeldError synchronously when latched. replay skips its second phase. dropAppFrame performs only storage drop under safety.

Gate new retained fetches and every durable open, including after load/fetch awaits. Held sync/pull callbacks perform no retain/fetch. Stop draining without marking unopened frames done or moving cursors past them. GroupSafetyHeldError is retryable in drain/note, never poison/dead. Invoke onSafetyHeld with its reason before returning, synchronously latching the peer when safetyHold() is null. Preserve delivery/completion of opened records independently of sealed-frame fetching. Recheck sends after seal and at the final append handoff using current safety, not a captured boolean. Await initial safety readiness before durable acceptance without creating a ready cycle.

- [ ] **Step 1: Write failing tests.** Parameterise both safety reasons:
  - `durable dispatch refuses pending and committed halt`: SendNotAdmissibleError, no outbox row. Include failed halt write with only volatile latch.
  - `queued durable send is preserved`: zero new seal/append, row remains queued. `halt between seal and handoff`: zero append.
  - `two-frame drain stops at next open`: suspend first unwrap, halt, finish first, second never opened and remains sealed. Cursor cannot pass second. Run for pull and pre-adoption drain.
  - `safety unwrap refusal stays retryable`: no poison/dead disposition or cursor advance, including a refusal after an access await. With peer safetyHold() initially null, one held refusal latches its reason. The next pull wake makes zero fetch/open calls.
  - `opened handler finishes under halt`: completion persists normally. Pending opened delivery is independent of new-open gate.
  - `enqueue refuses without writing`: GroupSafetyHeldError, no operation/revoke side effect. Migrate peer-failed-heal-strand.test.ts own-unmerged arms at `:222`, `:248-249` to rejection. Other arms retain intent expectations.
  - `resync and reauthorize refuse`: no rebuild/retain/subscribe. `replay skips second phase`: no recovery/ledger/bootstrap/rebuild. `drop only drops stored frame`: no reconcile/heal.
  - `committed Welcome remains serviceable`: original bytes, no new crypto/adoption/search. Uncommitted Welcome stays blocked.
  - `live in-memory certified settlement remains serviceable`: log-delivery proven entries remove/finalise under hold without new certification/seal/append. Failed removal retries retain proof. No durable settlement service or restart-publication row in 2.2c (R19).
  - `outcomes emit and ack while held`: slot/halt/history unchanged.
- [ ] **Step 2: Run red.**
  ```bash
  rtk proxy pnpm --filter @kumiai/rpc exec vitest run test/peer-safety-gates.test.ts test/app-lane-safety.test.ts test/peer-log-delivery.test.ts
  rtk proxy pnpm --filter @kumiai/rpc run test:types
  ```
  Expected: in-drain/final-handoff/refusal rows FAIL.
- [ ] **Step 3: Implement the gates and exception routes.** Extend assertDurableForkHalt with durable-send/enqueue assertions. Audit `rtk proxy rg -n "peer\.(enqueue|commit)\(" packages/rpc/test tests` against every halted-peer fixture, including Task 5 migrations. Migrate every halted-peer hit. Keep unsupported fixture semantics unchanged.
- [ ] **Step 4: Run green.** `rtk proxy pnpm --filter @kumiai/rpc run test`. Expected: PASS, including both drains and held storage service.
- [ ] **Step 5: Commit.** Message: `feat(rpc): stop new durable work at safety boundaries`.

### Task 9: Incoming commit, ephemeral and recovery gates at crypto starts and final handoffs

**Files:**
- Modify: `packages/rpc/src/peer-epoch.ts`, `packages/rpc/src/directed.ts`, `packages/rpc/src/peer.ts`, `packages/rpc/src/recovery-confirmation.ts`.
- Modify counters/helpers only: `packages/rpc/test/fixtures/fake-crypto.ts`, `packages/rpc/test/fixtures/peer.ts`.
- Create: `packages/rpc/test/peer-safety-ephemeral.test.ts`, `packages/rpc/test/peer-safety-recovery.test.ts`, `packages/rpc/test/peer-safety-commit.test.ts` (R18/R33 incoming-walk tests).
- Test: `packages/rpc/test/directed.test.ts`, `packages/rpc/test/peer-recover-lane.test.ts`, `packages/rpc/test/peer-recovery.test.ts`.

**Interfaces:** Consumes Task 5's safetyHold. EpochRuntimeParams adds `safetyHold: () => SafetyHold`. DirectedClientParams, InboxAcceptorParams and UnroutedTagResponderParams add `safetyHold?: () => SafetyHold` with null default. WaitForRecoveryConfirmationParams adds `safetyHold?: () => SafetyHold`. Extend `responseOutcome(port: GroupMLS, response: ExternalResponse, safetyHold?: () => SafetyHold): Promise<RecoveryCommitOutcome | undefined>` to guard key derivation after readEpoch. Peer injects these callbacks and guarded raw wraps. Confirmation receive queues check safety before new verdict opens and subsequent pending-recovery work. The send closure checks every invocation, including timers. Outbound peer paths use SendNotAdmissibleError. Public recovery calls use GroupSafetyHeldError. Automatic recovery returns/stops without new work. Inbound ephemeral frames are dropped before unwrap.

Incoming walk and advanceHandle recheck the synchronous safetyHold after every preparatory await, including fetch, pre-adoption drain and roster/epoch reads. Recheck immediately before every readCommitHeader, processCommit, openEntries, anchor/new-transition save and ratchet/adopter call. On hold, retain unprocessed commit/cursor/head and certify nothing. Classify GroupSafetyHeldError as held before resolverFailed/unprocessable/poison/strand handling, including advanceHandle error continuations. Latch its reason before returning if peer safetyHold() is null. Already-started app opens and atomic commit persistence complete. Persist only real strand state.

- [ ] **Step 1: Write failing tests.** Both safety reasons, each checklist path. Incoming-walk rows belong to peer-safety-commit.test.ts:
  - `commit fetch continuation obeys volatile latch`: suspend fetch, halt write rolls back, resume. Zero subsequent readCommitHeader/processCommit/openEntries/adopt/anchor install. Cursor/head unchanged, no certification/strand. Use observational ports without provider gates.
  - `pre-adoption drain and roster continuations obey volatile latch`: separately suspend drain/roster read, latch through rolled-back halt write, resume. Same zero-call/cursor/head/no-strand assertions. Already-started app open completes. Ports must expose missing peer checks.
  - `in-flight commit persists clean cursor after latch`: suspend inside processCommit's persist via an observational MLS port, before adoption changes materialise. Latch via haltFork, resume: persisted cursor.stranded absent, strand null, applied/outcomes commit normally. Variant: pre-existing real strand remains unchanged. No provider gate may hide the write.
  - `commit resolver safety refusal stays held`: GroupSafetyHeldError precedes resolverFailed/poison/strand, retains commit/cursor/head, zero anchor repair/new adoption. With peer safetyHold() initially null, one held refusal latches its reason. The next pull wake makes zero fetch/open calls.
  - `dispatch/request/gather/retained directed traffic refuses`: unary/stream/channel, zero wrap/handoff. Gather callbacks cannot send after halt.
  - `directed and broadcast handoffs recheck`: suspend raw client/reply wrap or broadcast seal, latch, resume, zero mailbox/bus publish. Include automatic replies and unrouted-tag NACK.
  - `protocol and inbox inbound frames stay unopened`: zero unwrap/handler starts. Already opened handler completes, its new reply is suppressed.
  - `recovery responders stay silent`: inbound GroupInfo/ledger/confirmation requests and external commits after halt cause zero sealGroupInfo/sealLedger/sealRecoveryVerdict/publish.
  - `queued responder/verdict/confirmation timers stay silent`: arm before halt, advance beyond retry delays, zero seal/publish after halt.
  - `saved rejoin publication stays held live and after restart`: record saved before halt, zero publish. `armed recovery retry never requests healing`: halt before timer fires, healRequested remains false.
  - `mid-flight responder sealing cannot hand off`: suspended GroupInfo/ledger/verdict seal completes, zero publication.
  - `ledger request stops after request creation await`: zero publish/openSealedLedger/bootstrap after latch.
  - `automatic recovery continuation stops after awaits`: suspend request creation, reply wait or reconciliation, halt, resume. No requestGroupInfo publication/applyRecovery/restore/adopt/confirmation sends.
  - `explicit recovery refuses safety`: GroupSafetyHeldError reason exact, no MLS/network work.
  Record starts separately from handoffs. In-progress operations may complete, but cannot start the next crypto step or publish.
- [ ] **Step 2: Run red.**
  ```bash
  rtk proxy pnpm --filter @kumiai/rpc exec vitest run test/peer-safety-ephemeral.test.ts test/peer-safety-recovery.test.ts test/peer-safety-commit.test.ts test/directed.test.ts
  rtk proxy pnpm --filter @kumiai/rpc run test:types
  ```
  Expected: incoming commit continuation, raw directed/responder/post-await rows FAIL.
- [ ] **Step 3: Implement every checklist gate.** Cover incoming walk/advanceHandle and held error continuations, rejoin publication, recovery retry, responder and confirmation timers. Keep crypto/MLS ports observational so provider gates cannot conceal missing peer checks. Preserve committed Welcome and live certified-settlement exceptions.
- [ ] **Step 4: Run green.** `rtk proxy pnpm --filter @kumiai/rpc run test`. Expected: PASS, including ordinary non-fork gap recovery.
- [ ] **Mutation check:** temporarily set `stranded = true` in haltFork. Run `rtk proxy pnpm --filter @kumiai/rpc exec vitest run test/peer-safety-commit.test.ts -t 'in-flight commit persists clean cursor after latch'` and `rtk proxy pnpm --filter @kumiai/rpc run test:types`. Expected: FAIL at cursor.stranded absence. Restore, rerun: PASS.
- [ ] **Step 5: Commit.** Message: `feat(rpc): gate ephemeral and recovery handoffs on safety`.

### Task 10: Load safety before network and retain storage-only startup service

**Files:**
- Modify: `packages/rpc/src/peer.ts`, `packages/rpc/src/hub-mux.ts`, `packages/rpc/test/hub-mux-subscribe-failure.test.ts` (direct rearm gate row, existing eager cases unchanged).
- Create: `packages/rpc/test/peer-safety-startup.test.ts`.
- Regression files, unchanged eager default: `packages/rpc/test/hub-mux.test.ts`, `packages/rpc/test/hub-mux-dispose.test.ts`, `packages/rpc/test/hub-mux-receive-ended.test.ts`, `packages/rpc/test/hub-mux-ack-refcount.test.ts`, `packages/rpc/test/hub-mux-bus-ack.test.ts`, `packages/rpc/test/hub-mux-mailbox-ack.test.ts`, `packages/rpc/test/directed.test.ts`, `packages/rpc/test/open-once-ack.test.ts`, `packages/rpc/test/frame-size.test.ts`, `packages/rpc/test/hub-conformance.test.ts`.

**Interfaces:** Consumes Tasks 5, 8-9. HubMuxParams adds opt-in `deferredStart?: boolean` and optional `networkAllowed?: () => boolean` for start/retain/every subscribe. HubMux adds idempotent `start(): void`. Default stays eager. Peer passes deferredStart and a gate closed until initial safety load succeeds. start/dispose are safe before receive exists. Disposal before start resolves drainage without creating receive. Check networkAllowed immediately before every hub.subscribe, including retries and rearmTopic attempt 0 (`packages/rpc/src/hub-mux.ts:455-457`). Committed Welcome delivery remains an explicit exception.

After safety load, held startup runs restorePending, storage-only operation/outcome cleanup and committed Welcome delivery. No anchor repair/capture, new open, build/search/adoption or receive/subscribe/retain occurs. Storage service must not depend on starting mux or initialising control topics. Clean startup calls start once and rechecks safety between all later awaits. A halt discovered during startup pull stops later runtime/network stages while owed storage work continues. Initial safety-load failure rejects ready with that load error and leaves the peer idle, with zero network work. Frozen-settlement restart publication remains 2.3.

- [ ] **Step 1: Write failing tests.**
  - `persisted fork/recovery hold starts no network`: empty-obligation fixture counts receive, subscribe, retain, fetchTopic, append, publish, mailbox sends and responder seals. All zero after ready and beyond delayed retries.
  - `initial safety read suspended or failed enables nothing`: no receive/retain/send before success. Failure rejects ready with the exact load error, peer idle, every network counter zero.
  - `reauthorize before ready under persisted halt`: suspend restorePending after safety load latches. Before ready settles, reauthorize synchronously throws GroupSafetyHeldError, zero subscribe.
  - `direct mux rearm attempt 0 obeys networkAllowed`: hub-mux-subscribe-failure.test.ts, retained topic refused earlier. Set networkAllowed false, reset subscribe counter. Separate rearmTopic/rearmRefusedTopics variants make zero hub.subscribe calls (`packages/rpc/src/hub-mux.ts:380`).
  - `clean start is idempotent and ordered`: safety load precedes exactly one receive. Dispose-before-start completes, later start does nothing.
  - `delayed subscribe retry obeys live halt`: initial failure arms retry, halt, delay expires, no new subscribe.
  - `mid-startup halt stops later stages`: no further runtime/network setup after detection.
  - `halted restart restores opened plaintext`: existing pending record delivered/completed, no decrypt/fetch/subscribe.
  - `halted restart cleans exact applied slot and emits/acks outcomes`: no MLS/readEvidence/search/adoption, slot/evidence retained. Cleanup after latch keeps persisted cursor/strand deep-equal pre-halt snapshot. A pre-existing real strand remains persisted unchanged.
  - `halted restart delivers committed Welcome`: original bytes delivered, obligation removed after success, no new MLS/build/search. Uncommitted Welcome retained.
  Run each owed-work row live and after restart. Count only its explicitly allowed handoff. All new-work/network-setup counters remain zero.
- [ ] **Step 2: Run red.**
  ```bash
  rtk proxy pnpm --filter @kumiai/rpc exec vitest run test/peer-safety-startup.test.ts test/hub-mux-subscribe-failure.test.ts
  rtk proxy pnpm --filter @kumiai/rpc run test:types
  ```
  Expected: eager receive and missing held restoration rows FAIL.
- [ ] **Step 3: Implement deferred start and exception-aware ready phases.** Keep storage-only scheduling independent of control-lane/network readiness.
- [ ] **Step 4: Run green.**
  ```bash
  rtk proxy pnpm --filter @kumiai/rpc run test
  rtk proxy pnpm --filter @kumiai/rpc exec vitest run test/hub-conformance.test.ts test/hub-mux
  rtk proxy pnpm --filter @kumiai/rpc run test:types
  ```
  Expected: PASS with existing direct mux clients unchanged.
- [ ] **Step 5: Commit.** Message: `feat(rpc): restore held storage work before network startup`.

### Task 11: Shared GroupSafety, registry and crash contracts

**Files:**
- Create: `packages/rpc-conformance/src/safety.ts`, `packages/mls-rpc/test/safety-conformance.test.ts`.
- Modify: `packages/rpc-conformance/src/index.ts`, `packages/rpc-conformance/src/registry.ts`, `packages/rpc-conformance/src/registry-fixture.ts`, `packages/mls-rpc/test/fixtures/registry.ts`, `packages/mls-rpc/test/registry-crash.test.ts`, `packages/mls-rpc/test/registry-fixture.test.ts`.
- Test: `packages/rpc/test/peer-fork-halt.test.ts` (Task 5 detector/host-first rows).

**Interfaces:** Consumes Tasks 2-5. Produces independent ConformanceGroupSafety and `runGroupSafetyContract(fixture: ConformanceRegistryFixture): void`. Add `safety(): ConformanceGroupSafety` to ConformanceRegistryFixture in registry-fixture.ts, including reopened fixtures. Mirror GroupSafety's five signatures and event/choice types structurally. Verify mutual assignability with actual types. No instanceof assertions across factories.

- [ ] **Step 1: Write shared rows.** `host mismatch co-writes field/event/admission`; `invalid/moved report writes and latches nothing`; `defensive committed identity/events`; `Read has no revision/marker effects and waits for proof`; `ack retains safety across reopen/tombstone`; `retired ack leaves active incarnation unchanged`; `trust loss via source/cold/held access persists once`; `transient error does not diagnose loss`; `lost spent trust refuses fresh Welcome unchanged`; `field-only recovery hold with valid trust readmits n+1`; `fork tombstone refuses ordinary Welcome`; `switch refuses both after ack`; `halt committed before notification replays identical body/ID`; `rolled-back report holds only live incarnation`; `ambiguous report proves both-or-neither before release`. Run both real-MLS/model modes and supplied/absent ownershipContext where relevant.
  `existing-halt reports are storage-neutral`: different bodies and after-ack reports only latch, revision/event unchanged. Re-run Task 5's peer-fork-halt.test.ts two-detector and host-first rows: one write, no retries after commit, at most one notification. Host-first peer detection has zero apply retries/notifications.
- [ ] **Step 2: Run red before fixture wiring.**
  ```bash
  rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/safety-conformance.test.ts test/registry-crash.test.ts test/registry-fixture.test.ts
  rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
  ```
  Expected: missing fixture member/type parity FAIL.
- [ ] **Step 3: Wire the real safety factory in both modes.** Keep direct-builder/adopter contracts from Task 5 running against every double. Registry model parity does not replace those contracts.
- [ ] **Step 4: Run green.** Repeat Step 2 and Task 5 Step 2's rpc test/type commands, then:
  ```bash
  rtk proxy pnpm turbo run build:js build:types
  rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types
  rtk proxy pnpm turbo run test:types
  ```
  Expected: PASS, including reopened fixture member and structural error checks.
- [ ] **Step 5: Commit.** Message: `test(rpc-conformance): cover GroupSafety and retained safety evidence`.

### Task 12: Real-MLS divergence, staged host reports and crash proof

**Files:**
- Create: `tests/integration/test/fork-halt.test.ts`.
- Modify: `tests/integration/test/peer-readmission.test.ts`, `tests/integration/test/welcome-after-crash.test.ts` for persisted safety inputs where needed.
- Reuse: `packages/mls-rpc/test/fixtures/registry.ts`, `packages/rpc/test/fixtures/fake-hub.ts` and existing integration real-MLS fixtures.

**Interfaces:** Consumes Tasks 5-11. Real MLS commits run through existing complete simple/transactional HandleAccess paths. GroupSafety uses the actual registry/persistence binding. Host reports halt storage and registry admission. The peer refuses after a commit wakeup/refreshControl or restart, **not immediately through unwired registry admission**. Inspect registry admission and the same peer control store independently. No synthetic crypto/open adapter or cast supplies the claim.

The losing scenario uses a hub double serving a reordered/forged prefix below an applied cursor with real competing MLS commits. Follow peer-commit-log-replay's reordering technique. Do not pretend honest CAS inserts below an accepted commit. Serve a one-shot reveal only once to expose retry assumptions.

- [ ] **Step 1: Write failing integration rows.**
  - `real losing and winning divergence halt`: exact commit digests, retained history/cursor, no new app/control/ephemeral/recovery work.
  - `host mismatch halts registry then peer on refresh`: inspect field/event/admission first. Trigger peer refresh, then sends refuse. Reconstruct and repeat.
  - `durable halt restart loads before network`: all startup counters from Task 10 zero without owed obligations.
  - `ack retains immutable evidence`: same body/ID after reopen, field survives.
  - `commit before notification replays event`: callback fault contained, same event available after restart.
  - `delayed COMMIT proof emits only after proof`: committed gives one notification/event, rolled-back gives none until storage retry commits unchanged evidence.
  - `one-shot below-cursor rollback retries retained body`: reveal disappears, storage-only retry still commits original body. Document crash-before-write residual honestly.
  - `missing applied history and certified replay remain non-fork`; `ordinary gap recovery still heals`: preserve baseline recovery confirmation.
- [ ] **Step 2: Run red.**
  ```bash
  rtk proxy pnpm --filter @kumiai/integration-tests exec vitest run test/fork-halt.test.ts
  rtk proxy pnpm --filter @kumiai/integration-tests run test:types
  ```
  Expected: fail before fixture setup is complete. Existing implementation gates from earlier tasks must already pass.
- [ ] **Step 3: Complete fixture glue only.** Assert the precise control-store/registry binding. Production gaps return to their owning task's scope. Do not implement 2.2d consumer wiring here.
- [ ] **Step 4: Run green.** `rtk proxy pnpm --filter @kumiai/integration-tests run test`. Expected: PASS. Isolate any failure before labelling it a known flake.
- [ ] **Step 5: Commit.** Message: `test(integration): prove fork halt with real MLS and staged refresh`.

### Task 13: Documentation, release intent and uncached gate

**Files:**
- Modify: `packages/mls-rpc/README.md`, `packages/rpc/README.md`, `.changeset/spec-p-storage-foundation.md`.
- Verify exports already produced: `packages/mls-rpc/src/index.ts`, `packages/rpc/src/index.ts`, `packages/rpc-conformance/src/index.ts`.

**Interfaces:** Documents existing Task 1/3/4/6 exports. Introduces no new API.

- [ ] **Step 1: Document the final behaviour.** Cover GroupSafety, permanent old-incarnation evidence, ack semantics, fork-winning StrandKind, storage-only exceptions and committed-only onSafetyEvent. State refresh/restart propagation here and 2.2d immediate consumer wiring. Explain valid-trust field-only readmission and lost-spent refusal. Hosts derive judgeWelcomeAdmission's held.forkHalted (`packages/mls-hub/src/admission.ts:6`, `:66`) from forkHalt. recoveryUnavailable does not set it. Record the USER manual re-invite decision (successor group, 2.2e), 2.3 frozen-settlement obligation and crash-before-write residual. No public field-clearing promise.
- [ ] **Step 2: Review scope and removed mechanisms.**
  ```bash
  rtk proxy rg -n "forkSettlement|deleteAppliedFrom|'fork-evidence'|\bForkEvidence\b|\bConformanceForkEvidence\b|\.fork\b|\?\.fork\b|\bfork\s*:" packages tests --glob '!**/lib/**'
  rtk proxy rg -n "reason !== 'acceptance-unknown'|controlHold !== null|hardControlHeld" packages tests --glob '!**/lib/**'
  ```
  Expected: no removed safety mechanism remains. Only reviewed unrelated store-fork methods survive the broad scan. Remaining predicates explicitly preserve safety and soft-hold semantics. No manual-recover/captureHead/sourceRecheck/consumer-wiring implementation slipped in.
- [ ] **Step 3: Run the uncached full gate.**
  ```bash
  rtk proxy pnpm turbo run build:js build:types --force
  rtk proxy pnpm turbo run test:types --force
  rtk proxy pnpm --filter @kumiai/mls run test
  rtk proxy pnpm --filter @kumiai/mls-hub run test
  rtk proxy pnpm --filter @kumiai/mls-rpc run test
  rtk proxy pnpm --filter @kumiai/rpc run test
  rtk proxy pnpm --filter @kumiai/hub-server run test:unit test/conformance.test.ts test/log-hub-conformance.test.ts
  rtk proxy pnpm --filter @kumiai/hub-server run test:types
  rtk proxy pnpm --filter @kumiai/hub-store run test:unit test/conformance.test.ts
  rtk proxy pnpm --filter @kumiai/hub-store run test:types
  rtk proxy pnpm --filter @kumiai/integration-tests run test
  rtk proxy pnpm change status
  rtk proxy pnpm run check:versions
  rtk proxy pnpm run lint
  git diff --check
  ```
  Expected: PASS. Record suite counts and every real/double contract runner. Environmental failures require an exact blocked command and cause, not a success claim.
- [ ] **Step 4: Commit.** Message: `chore(safety): document durable halts and verification gate`.

## Revision 1

Controller rulings R1-R17 govern this revision. All review findings have an assigned resolution. The two residual boundaries are explicit decisions, not work hidden in later tasks.

| Review finding ID | Resolution |
| --- | --- |
| sol Cr1 | Task 8 per-frame app-lane gate, two callers, retryable refusal. |
| sol Cr2; opus K3, I2, I14 | C6, safety-path checklist, Tasks 5/8/9 network continuations and runtime flags. |
| sol Cr3 | C12, Task 4 shared source/cold/held trust-loss helper. |
| sol I4; opus I12 | C13/C15, Tasks 3-4 prepare latch and GroupKey/install race checks. |
| sol I5; opus I6 | Task 3 EntryReads.events, memory/mirror and ownership contract. |
| sol I6; opus K2, I10 | C9, ownership row, Tasks 4/5/12 staged propagation and complete HandleAccess fixture. |
| sol I7; opus I3, I16 | Migration table, Task 5 complete literal/caller narrowing and fixture split. Error export in Task 4, durable test in 8. |
| sol I8; opus I4 | Task 7 full consumer list, broad removal scan and repository types gate. |
| sol I9 | Review Focus 1, Task 5 applyResolved/immutable body/storage retry, Task 12 one-shot evidence residual. |
| sol I10; opus I11 | C17 and Task 5 separate stage-sensitive live/restart outcomes, zero fetch/publish. |
| sol I11; opus K1 | USER successor-group decision (plan line 74), Review Focus 4, Tasks 4/11 valid-trust distinction and lost-spent refusal, per R1. |
| sol I12; opus I13 | R16 narrowed by R19: Tasks 2/5/8/10 preserve cleanup, restore, outcomes, Welcome live/restart, live certified settlement and storage finalisation. Frozen restart publication belongs to 2.3. |
| sol I13; opus I1 | Task 1 pure predicate, Task 5 complete strong-site audit and independent direct-builder/adopter contracts. |
| sol M14; opus I5 | C8, Task 7 reuse deleteAppliedBelow with unchanged readmission signature, per R11. |
| sol M15; opus M6 | C7 and Task 6 exact commit digests. Search/slot retain payload digests. |
| sol M16; opus M5 | Task 10 Interfaces: opt-in mux start/dispose/retry lifecycle and unchanged eager regressions. |
| opus I7 | C4, Task 2 AppOutbox.ackEvent rejects safety IDs. |
| opus I8 | C3, Task 1 key-aware real/independent validation and shared control-store row, Task 2 store enforcement. |
| opus I9 | C14, Task 3 rpc type-only LogHub/MailboxHub re-export. |
| opus I15 | Task 12 reordered/forged prefix hub double with real MLS commits. |
| opus M1 | Error mapping, Task 4 single GroupSafetyHeldError home, Tasks 5/8/9 outbound mapping, per R17. |
| opus M2 | C14, Task 3 shared coordinator binding validation/test. |
| opus M3 | Task 1 and Task 11 structural name/field error assertions. |
| opus M4 | C10 and Task 13 complete durable events versus peer-only callback. |
| opus M7 | C13, Tasks 2/4 deletion allowed with retained tombstone halt and ordinary readmission refusal. |
| opus M8 | Task 3 defensive events, tombstone ack, future evidence and unreadable report trust tests. Task 4 trust-loss migration. |
| opus M9 | Checked premises and Task 1: host-db uses rpc reducer; only memory-control-store is independent. |
| opus M10 | Task 10 counters include fetchTopic, mailbox sends and responder seals. |
| opus M11 | Task 6 union/types gate and Task 13 README/release text include fork-winning. |

## Revision 2

Controller rulings R18-R31 govern this revision. R1-R17 remain binding except for the explicit R19/R22 overrides. References below identify the 757-line Revision 2 baseline.

| Finding ID | Ruling / resolution | Plan lines changed |
| --- | --- | --- |
| S-N1 | R18 accepted: Task 9 incoming walk/advanceHandle gates and held disposition, observational volatile-latch races. | 83, 99-100, 127, 147, 532, 542, 545-547, 564-565 |
| S-N2 | R19 narrowed: live certified path/storage finalisation stay exempt. Frozen restart publication remains 2.3, overriding R16. | 32, 112, 129, 232, 519-520, 565, 576, 578, 672, 717 |
| S-N3 | R20 accepted: accounted observations schedule typed trust diagnosis after release, once per field. | 66, 316, 330-332, 343-344, 357 |
| S-N4; O-M2 | R25: correct pull-drain citation and include retryAppDelivery → retryAppPull. | 107-108 |
| S-N5 | Label correction: R1's USER successor-group decision is settled, with its plan line reference. | 716 |
| O-N1 | R21 accepted: one pending body, fresh mutationIDs, conflict stop, stored-body notification and any-existing-halt report no-op. | 64, 69, 279, 288, 385-387, 410-412, 612, 614, 617, 625 |
| O-N2 | R22 accepted, overriding C6's runtime stranded=true: direct safety guards and cursor/strand cleanup preservation. | 60, 385, 397, 413, 427, 462, 588 |
| O-N3 | R23 accepted: split hardControlHeld/controlHoldPresent, enumerate callers, gate saved rejoin and recovery timers. | 72, 101-102, 383, 396, 427, 553, 565 |
| O-N4 | R24 accepted: Task 8 owns halted-peer enqueue/commit audit and own-unmerged expectation migration. | 146, 505, 517, 528 |
| O-M1 | Label correction: R17 mux lifecycle is Task 10 Interfaces, not C16. | 721 |
| O-M3; O-M4 | R26: move/re-export existing declarations and mirror. Typed loss/empty-spent persists, key mismatch stays invalid, transient I/O propagates. | 55, 66, 180, 330, 346 |
| O-M5 | R27: synchronous reauthorize refusal, every subscribe including rearm attempt 0, persisted halt before ready test. | 81, 507, 576, 583 |
| O-M6 | R28: reportFork prepare calls trust helper and rejects recovery-unavailable after diagnosis. epochAuthenticator never writes. | 66, 70, 287, 313, 330, 346 |
| O-M7; O-M8 | R29: unreadable latest control refuses seed unchanged. Initial safety-load error rejects ready and leaves idle/no network. | 334, 349, 578, 582 |
| O-M9 | R30 declined: no storage-level durable-send gate in 2.2c. Propagation closes with 2.2d wiring. | 63 |
| O-M10 | R31: preserved deleteAppliedBelow boundary wording. Hosts derive held.forkHalted only from forkHalt. | 478, 672 |

## Revision 3

| Finding ID | Ruling / resolution | Plan lines changed |
| --- | --- | --- |
| I1 | R32 accepted: enumerate stranded readers, gate reconcileAbsent/followWinner continuations, scan readers, preserve C17 unknown. | 397-405, 425, 439, 442 |
| I2 | R33 accepted: observational in-flight persistence proves clean cursor/strand and real-strand preservation. Mutation must fail. Cleanup remains non-interference coverage. | 421, 552, 557, 578 |
| M1 | R34: move rearm attempt 0 into direct HubMux variants. Peer row tests synchronous reauthorize refusal only. | 584, 586, 595-596, 606 |
| M2 | R35: assign R18/R33 incoming-walk rows to peer-safety-commit.test.ts and include it in red/mutation commands. | 547, 554, 572, 578 |
| M3 | R36: readable-status/null missing trust followed by control-only transition exercises accounted diagnosis and persistence. | 332, 343 |
| M4 | R37: latch held crypto/resolver reasons before returning. App-lane callback reaches the peer. Next pull starts no fetch/open. | 63, 82-83, 383, 517, 519, 525, 552, 558 |
