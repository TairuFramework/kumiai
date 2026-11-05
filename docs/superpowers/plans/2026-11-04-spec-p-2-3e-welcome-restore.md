# Spec P 2.3e: owned source operations, Welcome burn and restore quarantine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans, or superpowers:subagent-driven-development when delegation is authorised. Implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Enforce source admission by construction, install Welcomes with atomic package exclusion, and quarantine declared backup restores.

**Architecture:** A private mls-rpc executor retains the existing group owner across complete source operations. Incarnation/generation-bound wire admission closes before terminal or replacement submission. Separate completion, recovery and Welcome-destination paths preserve saved plaintext, damaged-state recovery and lawful readmission.

**Tech Stack:** TypeScript, pnpm 12.15.0, Vitest, ts-mls, sealed memory persistence, existing rpc-conformance and hub-conformance consumers.

**Spec:** [Spec P](../specs/2026-10-08-spec-p-transactional-persistence.md), binding **r29**, including its final exporter ruling and D8 command rules.

**Stage:** planning
**Mode:** tasks

Baseline: `feat/spec-p-phase-2`, `288eedf1` (r29), following fixture migration `6a0999ff` and main integration at `a11ae4fe`.
Twenty tasks replace the nine-task draft. This document authorises no implementation during the rewrite session.
Only this plan and `.superpowers/sdd/plan-2-3e-draft/rewrite-notes.md` may change during drafting.
All commands and commits below belong to subsequent implementation.

## Global Constraints

- R29 overrides older plans, inventory classifications and review suggestions. In particular, public-data verification is legal after terminal.
- Every hub fault means non-delivery. Hub claims never grant durable halt/hold, discard, rebuild, stranding or owed-work deletion.
- Applied authenticated state controls membership. Package receipts prove consumption, never successful Welcome admission or membership.
- Use existing PeerRemovedError for terminal, DisplacedGroupHandleError for displaced bindings, and GroupUnavailableError restore-pending for declared quarantine.
- Admission binds an exact `GroupKey` and lifecycle generation. New admission never revives old bindings, results, clones or queued wire work.
- Device lifecycle admission precedes group acquisition. Terminal and restore metadata are validated under ownership before private restore or crypto.
- Whole protected operations use the existing owner queue across nested awaits. Memory-only commands use that same slot without provider transactions.
- Commands obey D8 ordering, callback dependencies, reentrancy, revocation and D3 scheduling. They receive no store capability.
- Callbacks holding an owner never await roots, new ownership, network, handlers or work depending on release of that owner.
- Combined acquires device before group. Any group holder refuses device acquisition. Cancellation withdraws waiters and releases raced grants.
- Source/wire admission closes before terminal/switch/readmission submission. Unknown outcome retains closure, owners and proof queues indefinitely.
- Only proven rollback allows fresh authority. Frozen closing data requires mutation-bound identity/version and transition-guard revalidation before reuse.
- Protected effects include private restore, open/decrypt, seal, sign, private derivation and actual framework fetch/publish invocation.
- Previously submitted non-cancellable effects may settle. Their results grant no further source authority.
- Managed handles, clones, credentials, signing keys, suites and private state cannot escape command results or arbitrary callbacks.
- `GroupCrypto.exportSecret(label, length?)` stays unchanged. Export initiation needs current admission. Returned epoch bytes are host-owned.
- Raw independently retained keys remain the trusted-code exception. This plan does not turn host storage or standalone MLS into a sandbox.
- Public-only signature verification grants neither source nor recovery authority. Its enclosing source/recovery operation still needs admission.
- Completion permits sealed pending/cursor codecs, saved handlers, `HandlerCompletion` and storage inspection/acks after terminal. It grants no MLS restore or transport.
- Retain trust and terminal metadata independently of private state. Terminal or missing/unreadable admission metadata refuses recovery before private work.
- Fresh Welcome uses destination authority. Terminal sources cannot block lawful readmission or gain source authority through installation.
- Ordinary package exclusion is device/ref-wide across source aliases. Burn, receipt, cleanup and installation share one Combined transaction and mutationID.
- Preserve last-resort reuse, spent authenticators, independent holds, successor tombstones, proof barriers, sealing/AAD and two-marker outcomes.
- Preserve unpublished old-entry `incarnation-abandoned` failures. Never automatically reseal them into the replacement incarnation.
- Preserve terminal-first removal, retained pending plaintext, canonical completion, required `crypto.pending` for every retained handler, and `recoveryCompletion` naming.
- Q1=A is settled: declared devices stay quarantined through phase 2. Keep `RestoreWork.stage='invalidate'` and its full group list.
- Phase 4 owns package invalidation/rotation, pending uploads and revocation stages. Their deferred completion cannot release startup here.
- No legacy persisted-data compatibility is required. Make pre-1.0 API breaks in place and document them in `.changeset/spec-p-storage-foundation.md`.
- Migrate broken callers, independent mirrors and fixtures in the contract-changing task. Never commit a known-red intermediate state.
- Every delivery/completion/persistence/public-type task runs affected package `test:unit` and `test:types`, plus the **full** integration suite.
- Public type changes also run `rtk proxy pnpm exec turbo run test:types --force`. Verify **Cached: 0**, or its equivalent uncached summary.
- Port changes run **both** contract families against real implementations and affected doubles. Doubles may be stricter, never more permissive.
- Guard tests require behavioural mutation RED followed by restored GREEN. Import errors and timeouts alone are not evidence.
- Use the machine-wide heavy-run protocol. Priority remains Sakui, controller work, then this milestone. No invented lock-file protocol.
- Use pnpm. Leave generated `lib/`, versions, package scripts/configuration and dependency conventions unchanged. Do not merge, push or release.

## Review Focus

1. **A nested crypto await outlives cancellation/fail-stop or competes with removal.** T5/T15 test suspended memory-command revocation and terminal exclusion.
2. **Backend terminal commit precedes proof while transport is queued.** T9/T10: `deferred wire refuses before terminal proof`, with actual invocation counters.
3. **Old references survive rollback, switch or Welcome readmission.** T4a/T7b/T11: `fresh admission never revives superseded references`, including clones/exporters and successful fresh work.
4. **A warmed seal holds G while Combined Welcome holds D.** T5/T11: `warmed seal refuses device-root dependency`; ready completion/control subsequently progresses.
5. **Restore snapshots contain certified debt and terminal pending plaintext.** T13/T14: `quarantine fails certified debt while canonical plaintext completion survives`.

---

## Scope and retained obligations

The approved design is recorded in `design-review.md` §5 and `design-review2.md` §5 under `.superpowers/sdd/plan-2-3e-draft/`.
`spec-r29-notes.md` records amendment history. R29 itself remains binding when those documents differ.
The old inventory's 28 candidates remain accounted for below. Its old line references and per-edge guard vocabulary are historical.

Q1=A permits early group quarantine without completing package stages. Repeated startup rechecks groups and then rejects `GroupUnavailableError({reason:'restore-pending'})`.
It retains the `invalidate` stage and complete `remainingGroups`, even after failure events are acknowledged.
No restored-device source/recovery/network worker starts here. Later package completion permits recovery, followed by fresh-leaf resync for each group hold.

Carry-forward 2.3d obligations 3-6 remain binding, with obligation 4's recheck mechanism superseded by r29.
Keep trust-only GroupMLS construction and lazy batching/control entry labels. B2 requires pending storage even for legacy function handlers.
T10 resolves O2's dead branch when editing peer startup. T15a documents M4: missing custom completion coverage leaves the cursor volatile.
Retirement still has no timeout. Required `openedDeliveryContext`, registry cursor wiring, `internalOperations` and candidate-envelope semantics remain supported.
Older legacy-journal policy remains only where the normative current contract requires it. This plan adds no persisted-format compatibility.

Package-stage completion, full declared-restore conformance, SQL-provider faults and SIGKILL remain open for phases 4, 3 and 6 respectively.
2.4 owns HTTP smoke and the buffered hub lift. Upstream fetch cancellation, response bounds and retention product policy retain their owners.
The three carried load-timing cases remain phase-end gates: manual-recovery restart, rpc failed-put retry and transactional fork-recovery.
Their current source fixes and migrated integration fixtures do not replace fresh verification.

## File Structure

All paths are repository-relative. Braces expand to separate paths. Newly proposed files are explicitly marked Create in tasks.

| Unit | Main implementation files | Task |
| --- | --- | --- |
| Kinded Welcome API | `packages/mls-hub/src/{join,pool,provisioner,index}.ts` | 1 |
| Device participants | `packages/mls-rpc/src/device-packages.ts`, `registry/{types,registry}.ts` | 2 |
| Combined prepare and terminal metadata | mls-rpc `{device-entry-capability,entry-capability,memory-device-persistence,memory-group-persistence,memory-group-state,persistence-guards}.ts` | 3 |
| Executor, binding, command lifecycle and closing data | mls-rpc `registry/source-executor*.ts`, `owner-queue.ts`, private coordinator integration | 4,4a |
| Live/ephemeral/publication crypto | mls-rpc `{crypto,registry-crypto,mls-encryptor}.ts`, `registry/{access,cold,live-send,live-receive,app-open,registry}.ts` | 5 |
| Control/build/rotation/adoption and delivered entries | mls-rpc `{control-build,control-validation,control-adoption,auto-rotation,revoke,apply-commit,mls}.ts`, `registry/control-batch.ts`, rpc `{crypto,control-batch,control-prepare,peer}.ts` | 6,6a |
| Recovery and switch | mls-rpc `{mls,recovery,registry-group-mls,registry-peer,manual-recovery,safety,safety-conditions}.ts`, `registry/{source,switch,recovery-coordinator,verdict,continuation}.ts`, `{recovery-record,branch-history}.ts` | 7,7a,7b,7c |
| Checkpoints and containment cutover | mls-rpc `{checkpoint,access,testing,registry-handle-access,index}.ts`, `registry/{types,registry,access}.ts`, all remaining callback consumers | 8 |
| Wire boundary | rpc `{source-wire,peer,peer-types,peer-epoch,hub-mux}.ts`, managed peer/tunnel factories | 9 |
| Landed 2.3d migration | rpc `{peer,app-lane}.ts`, mls-rpc `{terminal-admission,handler-completion}.ts`, terminal transition preparation | 10 |
| Welcome exclusion | mls-rpc `registry/seed.ts`, `memory-package-stores.ts`, independent history contracts | 11 |
| Device cleanup | mls-rpc `device-cleanup.ts` and dedicated tests/fixture | 12 |
| Restore failure authority | mls-rpc `restore-quarantine.ts`, private device/group coordinator paths | 13 |
| Declaration policy | mls-rpc `registry/restore.ts`, `registry/{registry,types}.ts`, executor lifecycle policy | 14 |
| Shared witnesses and host migration | rpc-conformance `source-authority.ts`, `welcome-restore.ts`, wrappers, integration, READMEs/changeset | 15,15a |

### Source evidence at current HEAD

Locations below were read at `288eedf1`. Future implementation must relocate symbols after preceding tasks change files.
`HandleAccess.read` at `packages/mls-rpc/src/access.ts:44` accepts arbitrary callbacks and results.
`control-build.ts:287` captures a suite, and `mls.ts:867` captures encoded private state and credentials from readControl.
`registry/live-send.ts:867` uses a separate send serializer. `registry/live-receive.ts:142` uses a separate receive lock.
`entry-capability.ts:26` omits terminal from metadata. `memory-group-state.ts:597` writes the corresponding sealed projection.
`memory-group-persistence.ts:470` builds observations and still derives terminal from readable private state.
`checkpoint.ts:135` signs retained debt with active-key checks but no terminal/restore admission.
`registry/recovery-coordinator.ts:559` decodes a candidate after proof. `registry-peer.ts:740` restores it after released reads at `:898`.
`registry/switch.ts:151` relinquishes/captures input before `start()` at `:216`. Semantic replay also precedes startup.
`packages/rpc/src/peer.ts:475` wraps final hub calls. Its checks sample removal, without generation-bound provisional closure.
`packages/rpc/src/peer-epoch.ts:422` retries directed replies without an explicit disposal check.

### The retained 54-edge routing and test inventory

This is a coverage checklist, **not** a request for 54 lifecycle guards. Named commands own admission and complete private work.
Each row requires live calibration and refusal/continuation evidence at the relevant primitive boundary. Invoke each listed alias separately.
The owning task repeats its command map. A dispatched brief must not depend on this table being appended.
Paths below are under `packages/mls-rpc/src/`, except explicitly prefixed rpc paths. Numbers are current anchors, not future edit coordinates.
`inspect` means storage/public data without source authority. `host` means standalone authority outside managed composition.

| Edge | Current entry and anchor | Destination / test owner |
| --- | --- | --- |
| S01 | `registry.seed`, `registry/seed.ts:195` | T11 Welcome destination + Combined install; T14 declaration refusal |
| S02 | new `switchIncarnation`, `registry/switch.ts:148` | T7b `recovery.switch.prepare`, closing persistence |
| S03 | adopted switch replay, `registry/switch.ts:183` | T7b storage-only semantic resolution, fresh destination startup |
| S04 | cold `registry.access`, `registry/registry.ts:1088`, `registry/cold.ts:87` | T5 `source.load` before restore |
| S05 | cached `read/readControl/refresh`, `registry/access.ts:185,199` | T5 projections; T8 removes handle callbacks |
| S06 | access `mutate/replace/adopt`, `registry/access.ts`; `registry-handle-access.ts:18` | T6 named transitions; T8 removes raw wrapper/captured-replacement map |
| S07 | `openBatch`/streaming open, `registry/app-open.ts:82` | T5 `app.open`; saved pending uses completion |
| S08 | `seal`, `registry/live-send.ts:848` | T5 memory-only `app.seal` |
| S09 | `receive`, `registry/live-receive.ts:124` | T5 memory-only `app.receive` |
| S10 | `preparePublication/publicationSnapshot`, `registry/types.ts:75` | T5 `app.publication`; settlement remains storage-only |
| S11 | scheduled maintenance/warm-up, `registry/live-send.ts:729,958` | T5 `app.maintain`, scheduler-selected persistence entry |
| S12 | accounting/compatibility/accept/handoff, `registry/live-send.ts:329,455,638` | T5 owned internal command helpers, no root nesting |
| S13 | ownerless handoff, `registry/registry.ts:477` | T5 `app.handoff` before private restoration |
| S14 | `restoreCommittedSender`, `testing.ts:24`, `registry/registry.ts:1226` | T5 internal diagnostic command; T8 data-only testing result |
| S15 | `signInstalled`, `checkpoint.ts:135` | T8 `checkpoint.signInstalled` |
| S16 | `compare`, `checkpoint.ts:208` | T8 public-only verification/inspect; no source admission granted |
| S17 | `importCheckpoint/updateRecords` intake, `checkpoint.ts:277` | T8 public verification plus storage transition |
| S18 | checkpoint facts/coverage/export/records/events/ack, `checkpoint.ts` | T8 inspect, including terminal/quarantine positive controls |
| S19 | checkpoint refresh/retry timer, `checkpoint.ts:541` | T8 inspect; any signing delegates to S15, wire to T9 |
| S20 | peer factory/start, `registry-peer.ts:534` | T7b fresh bound factory; T9 fresh gate |
| S21 | confirmed replay/accept, `registry-peer.ts:688,740,898` | T7b `recovery.resolveSwitch` before candidate decode, then `recovery.replay` |
| S22 | committed/adopted peer replay, `registry-peer.ts:876` | T7b inspect proof tuple; new destination admission |
| S23 | confirmed callbacks/retry/resume, `registry-peer.ts` | T7b `recovery.replay`, never retained source snapshots |
| S24 | `reconcileAcceptedRecovery`, `registry-peer.ts:612` | T7/T7b `recovery.reconcile` |
| S25 | manual runner/move/restart, `registry-peer.ts`, `manual-recovery.ts:639` | T7 data-only target resolution outside ownership, then fresh recovery command |
| S26 | `createRegistryGroupMLS`, `registry-group-mls.ts:70` | T7 trust/metadata construction with zero private restoration |
| S27 | request/sign/export/ledger/source, `mls.ts:563,814,1073` | T7 `recovery.request/sign/export`; HKDF fully owned |
| S28 | inspect/absence/verdict, `mls.ts:381,627` | T7 `recovery.inspect/absence/openVerdict` |
| S29 | captured apply/restore, `mls.ts:408,467`, `recovery.ts:656` | T7 `recovery.build/restore`; binding-renewal seam splits ownership |
| S30 | candidate serialize/confirmation/onAccepted, `recovery.ts` | T7 revocable command facades, no candidate handle closures |
| S31 | reconcile/authorise/check/settle fork, `registry/recovery-coordinator.ts:156,600` | T7 named recovery commands with exact tuple checks |
| S32 | `sealRosterAbsence`, `registry-group-mls.ts:345` | T7 `recovery.sealAbsence` |
| S33 | GroupInfo/verdict/key/prepare and verify aliases, `mls.ts:576,596,611,837` | T7 source commands; standalone public verification stays legal |
| S34 | header/validation/process/legacy recovery, `mls.ts:673` | T6 control; T6a data-bearing commit/batch; T7 recovery commands |
| S35 | ledger/bootstrap/epoch/roster, `mls.ts:1018` | T5 data projections; T6 ledger crypto commands; saved rows inspect |
| S36 | GroupCrypto wrap/unwrap/entries/export, `crypto.ts:317`, `registry-crypto.ts:30` | T5 named crypto commands |
| S37 | encryptor encrypt/decrypt/chunks, `mls-encryptor.ts:58,184` | T5 per-batch commands, bounded owner occupancy |
| S38 | encryptor delayed publish, `mls-encryptor.ts:82` | T9 binding-aware actual invocation |
| S39 | rotation scheduler/lazy producer, `auto-rotation.ts:170` | T6 `control.rotate`, no source snapshots outside command |
| S40 | managed createInvite/prepareBuild/returned drive, `control-build.ts:245,352` | T6 `control.prepare/build/save`, private journals stay internal |
| S41 | restoreValidation/header/validate/verifyOwn, `control-validation.ts:174` | T6 command facade, no cached validation handle escape |
| S42 | adoption, `control-adoption.ts:24` | T6 `control.adopt` and frozen closing data if terminal |
| S43 | revoke proof/publish, `revoke.ts:43` | T6 `control.revoke`; T9 actual transport |
| S44 | safety recover/manual target, `safety.ts:267`, `manual-recovery.ts:639` | T7 recovery orchestration; status/ack inspect |
| S45 | not-member handler, `safety-conditions.ts:118` | T7 `recovery.absence`; ordinary handler outside source owner |
| S46 | start/finalisers/delete/dispose/drain/status/completion, `registry/registry.ts:269` | T10 completion/storage; T14 startup policy before workers |
| S47 | proposed cleanup `runOnce/kick/timer` | T12 device storage/network/storage; T14 device network policy |
| S48 | proposed declare/resume/quarantine | T13/T14 storage-only declared authority |
| S49 | `serveRetiredObligations`, `registry/retired.ts:229` | Host-delivery authority; T15a documents separate network precondition |
| S50 | raw derive/seal/open/apply/rotation/revoke helpers, `crypto.ts:77`, `revoke.ts:61` | Host helpers retained; managed callers move to T5/T6 commands |
| S51 | raw recovery helpers, `recovery.ts:85,119,656` | Host API retained; T7 owns all managed invocations |
| S52 | `simpleHandleAccess`/raw constructors, `access.ts:96` | Unmanaged host boundary; T8 prevents managed use/containment escape |
| S53 | `registry.recoverySource`, `registry/registry.ts:1074`, `registry/source.ts:30` | T7 metadata/trust projection, never a reusable admission token |
| S54 | successor access/replay, `successor.ts:70,151` | T7 own-destination binding; source completed-choice replay inspect |

## Verification protocol

**Drafting:** run no package tests, builds, typechecks or mutations. This rewrite uses source and document checks only.
**Implementation:** obtain the existing machine heavy-run slot before every heavy gate, including mutations and full integration.
No worker may substitute a four-file integration subset, disable global setup or use a temporary memory-only config for the full gate.
The baseline has **41 integration files**, approximately five minutes per full run. New files increase that count.
The previous subset hid 48 failures. The `6a0999ff` migration is the starting fixture baseline, not evidence for this implementation.

The following helpers define exact commands. Include their used definitions in every dispatched brief.

```bash
kfocus() {
  local package_name="$1"
  shift
  rtk proxy pnpm --filter "$package_name" exec vitest run --maxWorkers=2 "$@"
}
kunit() { rtk proxy pnpm --filter "$1" run test:unit; }
kpackageTypes() { rtk proxy pnpm --filter "$1" run test:types; }
ktypes() { rtk proxy pnpm exec turbo run test:types --force; }
kbuild() { rtk proxy pnpm exec turbo run build:js build:types --env-mode=loose; }
kintegration() { (cd tests/integration && rtk proxy pnpm exec vitest run); }
kcontracts() {
  local contract_result=0
  local contract_package
  for contract_package in @kumiai/mls-rpc @kumiai/rpc @kumiai/hub-server @kumiai/hub-tunnel @kumiai/integration-tests @kumiai/hub-store @kumiai/hub-wake; do
    kfocus "$contract_package" || contract_result=1
  done
  return "$contract_result"
}
```

`kcontracts` runs complete package suites, including normal integration setup. It applies no filename filter.
This deliberately executes every manifest wrapper, including wrappers without `conformance` in their names.
The explicit baseline manifest below expands braces into separate `.test.ts` paths. Counts exclude the two future wrappers.

| Package directory (`test/` relative) | Baseline wrapper stems | Count |
| --- | --- | ---: |
| `packages/mls-rpc` | `anchor-store-conformance`, `app-publication-conformance`, `checkpoint-port-conformance`, `checkpoint-storage-conformance`, `clear-hold-storage`, `control-consumption-conformance`, `control-crash`, `control-migration`, `control-safety-conformance`, `control-safety-inputs`, `control-store-conformance`, `final-review`, `fork-notice-conformance`, `guards`, `handler-batching-conformance`, `manual-recovery-conformance`, `ownership-phases-conformance`, `ports-conformance-transactional`, `ports-conformance`, `recovery-absence-conformance`, `registry-conformance`, `registry-crash`, `registry-crypto-conformance`, `registry-lease-conformance`, `safety-conformance`, `storage-conformance` | 26 |
| `packages/rpc` | `commit-once-conformance`, `control-migration`, `control-store-conformance`, `hub-conformance`, `ports-conformance`, `recovery-absence`, `recovery-binding-double` | 7 |
| `packages/hub-server` | `checkpoint-authorization`, `conformance`, `log-hub-conformance`, `purge-race-conformance` | 4 |
| `packages/hub-store` | `conformance`, `purge-race-conformance` | 2 |
| `packages/hub-tunnel` | `hub-conformance` | 1 |
| `packages/hub-wake` | `memoryRegistry` | 1 |
| `tests/integration` | `anchor-rotation-recovery`, `commit-once-conformance`, `hub-log-conformance`, `outbox-adoption`, `proven-revoke-run` | 5 |

The manifest has **46 baseline wrappers**. T15/T15a add mls-rpc `source-authority-conformance` and `welcome-restore-conformance`.
Before each port gate, reconcile imports and invocations with this manifest:

```bash
rg -n 'rpc-conformance|hub-conformance' packages/*/test tests/integration/test -g '*.ts'
rg -n '(test[A-Z][A-Za-z]*Conformance|testLegacyControlMapping|testControlMigrationActivation|runControlSafetyContract|runGroupSafetyContract|assertPartialLossSpentRefused)\s*(<[^>]+>)?\s*\(' packages/*/test tests/integration/test -g '*.ts'
```

Inspect multiline/aliased imports and helper-mediated calls. Compare exported runners/assertions in both contract packages with their consumers.
Type-only imports and factory helpers are not executable wrappers. Record each selected suite's exit status, fixture mode and backend.
New consumers require manifest/package-list updates in the task introducing them. Run every package even after failure.
Build changed exports before cross-package tests. `kunit` and `kpackageTypes` run for every affected implementation/consumer package.
Contract packages lack standalone test:unit scripts. Their consumer wrappers are the executable gate.
`tests/integration/test/global-setup.ts` attempts PostgreSQL and fails closed under `CI=true` if unavailable.
Skipped engines mean incomplete backend evidence. Never label a skipped backend, fixture reconstruction or timeout as provider/SIGKILL proof.
Expected successful gates: every selected test passes, exit zero, no new skips, package types clean, and forced repo types show zero cached tasks.
Unexpected failures require in-task caller migration or repair before committing. No known-red handoff to the next task.

For each guard witness, record live calibration, assertion-RED mutation, restored GREEN and primitive counters.
Use deterministic milestones and `flushReady()` checkpoints. Pauses always release in `finally`; fixed microtask counts prove no exclusion.
Mutate central admission/owner/generation/wire enforcement, not 54 independent call-site checks.
Routing tests also mutate an executor delegate into its former raw route to prove the adapter cannot bypass enforcement.

## Tasks

### Task 1: Return kinded package use from Welcome opening

**Files:**

- Modify `packages/mls-hub/src/{join,pool,provisioner,index}.ts`, `packages/mls-rpc/src/persistence-types.ts` if its shared alias needs adjustment.
- Test `packages/mls-hub/test/{join,consume,pool,provisioner}.test.ts`.
- Migrate `tests/integration/test/{welcome-after-crash,peer-readmission,control-guidance}.test.ts` and every other result/source literal affected.

**Interfaces:**

Consumes MLS Welcome verification and existing `JoinedWelcome`, `KeyPackageBundle`, `OpenWelcomeParams`.
Produces the following exports in mls-hub. Mls-rpc uses the same structural shape without an upward dependency.

```ts
type PackageUse = { sourceID: string; ref: string; kind: 'ordinary' | 'last-resort' }
type BundleSource = {
  sourceID: string
  kind: PackageUse['kind']
  bundles(): Promise<Array<KeyPackageBundle>>
  consume(ref: string, groupID: string): Promise<void>
  receipt(ref: string): Promise<{ groupID: string } | null>
}
type OpenWelcomeResult =
  | { joined: JoinedWelcome; packageUse: PackageUse }
  | { refused: 'package-consumed'; packageUse: PackageUse }
function openWelcome(sources: Array<BundleSource>, welcome: OpenWelcomeParams): Promise<OpenWelcomeResult>
```

**Route map:** pool/provisioner source constructors supply literal kinds. `openWelcome` checks descriptors, then ordinary receipt, then MLS opening.
Last-resort opening bypasses ordinary receipts. Neither successful opening nor refusal installs a managed group.

- [ ] **Step 1: Add failing result/discrimination tests.**

| Test | Required assertions |
| --- | --- |
| `ordinary receipt refuses without claiming admission` | Exact refused result/packageUse; bundles/decryption zero; receipt groupID grants no membership |
| `opened Welcome identifies source ref and kind` | Both kinds return verified joined result and exact use; consume zero |
| `last resort remains reusable without receipt admission` | Repeated valid opens reach MLS; ordinary receipt semantics unused |
| `invalid source descriptors refuse before callbacks` | Empty/duplicate IDs and unknown kinds reject with every callback zero |

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-hub test/join.test.ts test/consume.test.ts`. Expected: old result/kind assertions fail.
- [ ] **Step 3: Implement and migrate callers.** Preserve sourceErrors and independent-source fallback. Keep standalone consume APIs. Replace receipt-derived `alreadyJoined` everywhere.
- [ ] **Step 4: Verify.** Run focused GREEN, mls-hub/mls-rpc unit+types, full `kintegration`, `ktypes`, `kcontracts`. Expected: all gates pass with zero cached type tasks.
- [ ] **Step 5: Mutation-check result guards.** Receipt-as-membership and wrong last-resort kind each fail their named assertions. Restore GREEN.
- [ ] **Step 6: Commit.** Stage only this task's complete source/test/caller migration. Commit `feat(mls-hub): return kinded package use from Welcome opening`.

### Task 2: Require validated device package participants

**Depends on:** T1.

**Files:**

- Create `packages/mls-rpc/src/device-packages.ts`, `packages/mls-rpc/test/device-packages.test.ts`, `packages/mls-rpc/test/fixtures/device-packages.ts`.
- Modify `packages/mls-rpc/src/registry/{types,registry}.ts`.
- Modify `packages/rpc-conformance/src/{persistence-fixture,registry-fixture}.ts` and mls-rpc fixtures `{registry,storage-persistence,registry-crypto,handler-conformance}.ts`.
- Migrate every direct registry constructor in mls-rpc tests and integration. Include cold/source/switch/opened-delivery/checkpoint/readme constructors.

**Interfaces:**

Consumes `DevicePersistence<TTx>` and existing normative `DevicePackageAdapters` in `persistence-types.ts:367`.
Produces required `GroupHandleRegistryParams<TTx>.packages: DevicePackageAdapters` and private:

```ts
function validateDevicePackages<TTx extends GroupTransaction>(
  device: DevicePersistence<TTx>, packages: DevicePackageAdapters,
): DevicePackageAdapters
```

Independently define `ConformanceBundleSource<TBundle = unknown>` and `ConformanceDevicePackageAdapters<TBundle = unknown>`.
Mirror sourceID/kind/providerID/ownerDID, bundles/consume/receipt, source/store pairs, rotateAvailability and cleanup exactly.
Reuse independent conformance pool/last-resort/cleanup types. Do not import MLS bundle types into contract packages.

**Route map:** factory construction validates before registry registration or scheduler binding. Welcome requests resolve exactly one registered source/store pair.
Empty participants are valid for genesis-only use. Missing requested participants refuse.

- [ ] **Step 1: Add named validation tests in device-packages.test.ts.**

| Test | Required assertions |
| --- | --- |
| `missing package participants refuse before registry registration` | Missing packages throws TypeError; package reads, private restore and callback counters equal zero; corrected construction reuses coordinator |
| `foreign package participant identities refuse before callbacks` | Adapter/source/store providerID and ownerDID mismatches each throw; all read/consume/receipt/rotate/cleanup counters zero |
| `invalid source IDs kinds and operations refuse before callbacks` | Empty/duplicate IDs, unknown kind and each non-callable operation throw TypeError; zero callbacks |
| `source store pairs require an exact bijection` | Missing/extra/duplicate store and mismatched kind refuse; provider counters zero; valid ordinary plus last-resort pair succeeds |
| `participant descriptors are defensively copied` | Mutating input arrays/descriptors cannot retarget registered source/store IDs or kinds; callback/store identities remain equal |
| `empty participants permit genesis but refuse requested package use` | Genesis succeeds with zero package calls; unregistered requested use refuses before bundle/read/restore |

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-rpc test/device-packages.test.ts test/registry-cold.test.ts`. Expected: validation assertions fail.
- [ ] **Step 3: Implement validation and migrate constructors.** Validate callable operations. Preserve callback/store identities within copied descriptors.
  Fixtures provision real records through `createMemoryPackageStores`. Relabelling unrelated storage with matching IDs is forbidden.
  Host descriptors must truthfully identify one provider/loss boundary. Shape validation cannot inspect arbitrary callback implementations.
- [ ] **Step 4: Verify.** Run focused GREEN, mls-rpc/mls-hub unit+types, full `kintegration`, `ktypes`, `kcontracts`. Expected: all pass, zero cached repo types.
- [ ] **Step 5: Mutation-check validation.** Remove identity matching, duplicate detection, bijection and defensive copying separately. Require the corresponding named test assertion RED, then restored GREEN.
- [ ] **Step 6: Commit.** Commit the entire migration as `feat(mls-rpc): require device package participants`.

### Task 3: Prepare Combined entries and persist terminal admission metadata

**Depends on:** T2. This remains the metadata producer before every executor consumer.

**Files:**

- Create `packages/mls-rpc/src/device-entry-capability.ts`, `packages/mls-rpc/test/device-entry-capability.test.ts`.
- Modify `packages/mls-rpc/src/{entry-capability,memory-device-persistence,memory-group-persistence,memory-group-state,persistence-guards}.ts`.
- Modify `packages/rpc-conformance/src/{persistence-fixture,ownership-phases}.ts` for independent metadata/accounting assertions.
- Extend mls-rpc tests `{device-persistence,owner-queue,metadata-clock,registry-cold,registry-peer,registry-continuation,spent-set-corrupt}.test.ts` and fixtures `{registry,storage-persistence}.ts`.

**Interfaces:**

Consumes existing `EntryReads`, `Prepared<T>`, `DeviceRecord`, `DeviceStores<TTx>` and private coordinator binding.
Produces registered internal capability, never a public barrel export:

```ts
type DeviceEntryReads = { device(): Promise<DeviceRecord>; group: EntryReads }
type PreparedDevice<TPrepared> = Prepared<TPrepared> & { expectedDeviceRevision: number }
type DeviceEntryCapability<TTx extends GroupTransaction> = {
  assertRoot(): void
  read<TValue>(work: (stores: DeviceStores<TTx>) => Promise<TValue>): Promise<TValue>
  runCombined<TPrepared, TResult>(
    request: { groupID: string; mutationID: string; signal?: AbortSignal },
    prepare: (reads: DeviceEntryReads) => Promise<PreparedDevice<TPrepared>>,
    work: (stores: DeviceStores<TTx>, prepared: TPrepared) => Promise<TResult>,
  ): Promise<TResult>
}
function deviceEntryCapability<TTx extends GroupTransaction>(
  device: DevicePersistence<TTx>,
): DeviceEntryCapability<TTx> | null

type StateMetadata = GroupKey & {
  version: number; deleted: boolean; terminal: boolean; initialIdentity: EpochIdentity | null
}
// EntryReads.metadata(incarnation: number): Promise<StateMetadata | null>
// IncarnationStores.state.loadMetadata(): Promise<StateMetadata | null>
```

`read` supplies phase-read-only stores with group null. Failures reject and release without uncertain proof retention.
`runCombined` reuses existing entry phases and both owners. Prepare reads committed rows outside the provider transaction.
Work revalidates prepared group expectations/device revision. Both markers use the same mutationID. Preparation capabilities expire before work.
`DevicePersistence.transition` stays unchanged. Copied/unregistered wrappers cannot obtain private coordinator authority.

**Route map:** state save -> sealed `meta/state-version` projection. Tombstone/admin/effect accounting -> preserve prior projection.
`captureObservation` -> active metadata terminal in both readable and unreadable-state branches. No source admission is inferred from metadata alone.

| Codec path from the primitive scan | Authority |
| --- | --- |
| `persistence-codec.ts:230,240`; `memory-group-state.ts:342,355,444,463`; `memory-package-stores.ts:72,96` | At-rest seal/open under existing storage authority; never a source command |
| `memory-group-persistence.ts:1253,1347,1388`; `memory-incarnation-stores.ts:118,127`; `checkpoint-store.ts:224,266,276` | At-rest accounting/checkpoint storage, legal without MLS source authority |
| rpc `peer.ts:815,6081`, `app-lane.ts:1803,1836` restore records | Saved-plaintext completion, not private MLS restoration; T10 preserves it |


Project the existing non-deleted `GroupStateRecord.terminal`; invent no second terminal decision.
Missing/non-boolean metadata refuses. Tombstoning cannot guess false. Same-incarnation terminal never reverts.
Readable state/metadata must agree, alongside existing identity/version checks. Unreadable state never supplies a default.
Preserve the field through explicit accounting rewrites and spread updates in memory-group-persistence.
Administrative accounting opens no private state. Observations publish only after existing proof. Null terminal means no readable active projection.

- [ ] **Step 1: Add failing ownership and projection witnesses.**

| Test | Required assertions |
| --- | --- |
| `Combined prepare owns device then group outside provider work` | Paused crypto sees zero work transactions; committed group/device reads feed one validated work transaction |
| `group holder refuses device acquisition` | Prompt ReentrantOwnershipError synchronously in both context modes, post-await with ownershipContext; no queued device request |
| `cancelled Combined withdraws group wait and releases device` | Holding A blocks Combined A; B progresses; cancellation lets same-device provisioning progress; raced grant invokes no cancelled work |
| `Combined proof retains both owners and preparation` | Late commit exposes result/hooks once after both markers; late rollback exposes none; no prepare rerun during proof |
| `device read and expired prepare views cannot write` | Phase/attempt refusals precede codec/backend calls; failed Read releases ownership |
| `terminal projection survives unreadable state and tombstone` | Envelope corruption, null and malformed inner bytes preserve exact true/false metadata; old-source restore zero |
| `every accounting path preserves terminal projection` | State save, effect/admin bump and tombstone preserve field; no private-state open; rollback/delayed proof exposes no partial flag |
| `missing malformed or conflicting terminal projection refuses` | No false fallback; readable state mismatch rejects; independent conformance mirror requires field |

Run ownership tests with/without ownershipContext. Respect D8's post-await diagnostic limitation without the port.

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-rpc test/device-entry-capability.test.ts test/owner-queue.test.ts test/metadata-clock.test.ts`. Expected: missing preparation/projection assertions fail.
- [ ] **Step 3: Factor prepare into the existing coordinator.** Reuse barriers, entry-bound readers, operation locks, phases, proof and hook settlement.
  Prepare failure/cancel releases owners without work transactions. Migrate metadata literals, independent mirrors and all public callers here.
- [ ] **Step 4: Verify.** Run focused GREEN, mls-rpc unit+types, full `kintegration`, `ktypes`, `kcontracts`. Expected: all pass, zero cached repo types.
- [ ] **Step 5: Mutation-check ownership/projection.** Reverse acquisition, retain cancelled waiter, accept one marker, drop/reset terminal, or read private state administratively.
  Each mutation must fail its named behavioural assertion. Restore GREEN.
- [ ] **Step 6: Commit.** Commit `feat(mls-rpc): prepare Combined entries and project terminal metadata`.

### Task 4: Construct the private source executor and memory-only command lifecycle

**Depends on:** T3. This adds private machinery without claiming migration coverage yet.

**Files:**

- Create `packages/mls-rpc/src/registry/{source-executor,source-executor-types,source-command-runtime}.ts`.
- Create `packages/mls-rpc/test/source-executor.test.ts`, `packages/mls-rpc/test/fixtures/source-executor.ts`.
- Modify `packages/mls-rpc/src/{owner-queue,entry-capability,memory-group-persistence,memory-device-persistence,group-batch,group-batch-binding}.ts` as required by their existing ownership/scheduling boundaries.
- Modify `packages/mls-rpc/src/registry/registry.ts` to construct one executor per registered coordinator/device.
- Extend `packages/mls-rpc/test/{owner-queue,group-batch,ownership-phases-conformance}.test.ts`.

**Interfaces:**

Consumes T3 metadata/capabilities, D8 owner queues, D3 scheduler and `RecoveryEnvironment`.
Produces private contracts. `GroupKey` here is the existing rpc key type, not a new identity format.

```ts
type SourceBinding = { key: GroupKey; generation: number }
type BoundSourceResult<TValue> = { binding: SourceBinding; value: TValue }
type SourceCommand<TInput, TOutput> = { input: TInput; output: TOutput }
type SourceCommands = {
  'source.inspect': SourceCommand<undefined, AdoptionExpected>
}
type SourceExecutor = {
  execute<TName extends keyof SourceCommands>(request: {
    binding: SourceBinding
    command: TName
    input: SourceCommands[TName]['input']
    signal?: AbortSignal
  }): Promise<BoundSourceResult<SourceCommands[TName]['output']>>
}
type DeviceLifecycle = {
  beforeUse(): Promise<void>
  assertCurrent(): void
}
type SourceExecutorControl = {
  admit(key: GroupKey, purpose: 'source' | 'recovery' | 'destination'): Promise<SourceBinding>
  invalidate(key: GroupKey, reason: Error): void
  assertCurrent(binding: SourceBinding): void
}
function createSourceExecutor<TTx extends GroupTransaction>(params: {
  persistence: DevicePersistence<TTx>
  entry: EntryCapability<TTx>
  lifecycle: DeviceLifecycle
  environment: RecoveryEnvironment
}): { executor: SourceExecutor; control: SourceExecutorControl }
```

T5-T8/T11 extend SourceCommands explicitly. The dispatcher fixes purpose, mode and data-only output schema.
No generic callback/execute(fn), host registration or caller-selected weaker authority exists.
Private `admit` exposes only a binding. Every command revalidates it under G.
`assertCurrent` validates data-only continuations, never authorises protected effects.

**Command/authority map:**

| Command class | Admission and ownership | Result boundary |
| --- | --- | --- |
| Source | Device before G; exact key/generation, lifetime, terminal and restore checks under G | Data/exporter result only |
| Recovery | Device before G; independently readable terminal metadata plus retained trust/policy | Protocol result; no ordinary source authority or damaged source restore |
| Destination | Device before Combined D/G acquisition; spent/package/hold/restore/admission checks | Installed destination key/result, never revived source binding |
| Completion/inspection | Existing persistence/HandlerCompletion authority | No executor source admission; no source primitives/transport |

**Whole-operation rules:**

- A command holds G from its owned admission through the last nested crypto continuation. Network seams return data and release G.
- Memory commands use `queued -> prepare -> settled -> released`, with no store capability or provider transaction.
- Complete startup barrier/metadata loading through an ordinary persistence entry before admitting memory commands.
- Memory commands consult the coordinator's current committed admission projection under G. They never open a transaction to re-read it.
- Every settled metadata change updates or invalidates that projection before another command can use it. Missing projections require separate maintenance.
- Do not hold a live-send/receive serializer while waiting for G. Replace those ownership roles in T5.
- Scheduler selection precedes FIFO admission. Service ready control adoption, then round-robin completion/other work before another burst command batch.
- Commands cannot acquire D after G, invoke roots or await work requiring their held slot. Synchronous callback markers apply in both context modes.
- Post-await root diagnosis uses ownershipContext when supplied. Without it, the documented misuse limitation remains; lawful operations never depend on it.

Cancellation/fail-stop revokes authority and discards late results before releasing G.
Central provider/restorer/signer wrappers check attempt liveness at actual primitive invocation, including continuations after provider acquisition.
Ownership provides terminal exclusion. Primitive checks enforce revocation.
Cache private state/lease progress only. Reconstruct command-local contexts under fresh provider bindings.
Never retarget old suites/callbacks or cache attempt-bound capabilities. Clones stay private, gain no lease and require fresh admission.

T4a adds mutation-bound provisional closure before migration starts. Ordinary epoch successors do not automatically change membership lineage.

- [ ] **Step 1: Add failing executor boundary witnesses.**

| Test | Required assertions |
| --- | --- |
| `admission precedes private restore under exact binding` | Terminal/missing/unreadable metadata, wrong incarnation and group restore hold refuse before reads.state/private restore |
| `inspect waits for startup persistence before owner admission` | Pause first scope barrier/marker entry; source.inspect remains pending; release completes projection before inspect |
| `command callbacks cannot depend on their own release` | Synchronous reentry rejects in both modes; post-await rejects with ownershipContext; unrelated callers remain unbound |
| `invalidation never revives superseded bindings` | Fresh inspect succeeds; old binding/result refuses; no groupID alias follows the current incarnation |
| `inspect commands enter the shared scheduler` | Inspect requests use D3 selection before G; independent group queues progress |

T4 tests only inspect/admission infrastructure. T5 owns real crypto, warmed startup/service and nested-await witnesses. T11 owns Combined-Welcome inversion.
The fixture exposes `flushReady(): Promise<void>` without manufacturing outcomes.

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-rpc test/source-executor.test.ts test/owner-queue.test.ts test/group-batch.test.ts`. Expected: missing executor/ownership assertions fail.
- [ ] **Step 3: Implement in the existing coordinator.** Add command kind/phases and private dispatcher. Reuse revocation, callback markers, scheduling and provider outcomes.
  Bind `beforeUse` to existing startup/open/restore refusal now. T14 replaces that policy with declaration processing, without changing adapter routes.
  Storage entries remain queue-admissible. Only their protected source portions use executor admission.
- [ ] **Step 4: Verify.** Run focused GREEN, mls-rpc/rpc unit+types, full `kintegration`, `kcontracts`. Run `ktypes` if public signatures changed. Expected: all gates pass.
- [ ] **Step 5: Mutation-check central enforcement.** Drop binding/terminal admission, skip the startup entry, reuse an invalidated generation, or allow command D acquisition.
  Primitive revocation and nested-crypto mutations belong to T5, after its handlers exist. Require behavioural RED for each, then restored GREEN.
- [ ] **Step 6: Commit.** Commit `feat(mls-rpc): execute bound source operations under group ownership`.

### Task 4a: Freeze closing mutations and close admission before submission

**Depends on:** T4. No managed path migration starts before this protocol exists.

**Files:**

- Modify `packages/mls-rpc/src/registry/{source-executor,source-executor-types,source-command-runtime}.ts`.
- Modify `packages/mls-rpc/src/{entry-capability,device-entry-capability,memory-group-persistence,memory-device-persistence,memory-group-state,memory-incarnation-stores}.ts` for private prepare/submission/write guards.
- Modify `packages/mls-rpc/src/registry/{access,app-open,app-publication,live-send,switch,seed,registry,retired,safety}.ts`, `successor.ts` and direct closing fixtures/callers.
- Create `packages/mls-rpc/test/source-closing.test.ts`; extend executor/owner fixtures.

**Interfaces:**

Consumes T4 private lifecycle cells and T3 `EntryReads`, `Prepared<P>` and Combined prepare.
Produces private entry-bound preparation. Keep public `GroupPersistence.transition` unchanged.

```ts
type ClosingReason = 'terminal' | 'switch' | 'readmission' | 'delete' | 'successor'
type ClosingMutation = { mutationID: string }
type ClosingDomain = { states: Array<GroupStateRecord>; lifetime: GroupLifetime | null }
type ClosingPreparation = {
  freeze<TPrepared extends Prepared<unknown>>(request: {
    source: GroupKey; reason: ClosingReason
    prepared: TPrepared; domain: ClosingDomain
  }): Promise<TPrepared>
}
// Prepared<P> gains closing?: ClosingMutation.
// EntryCapability.run<P,T> prepare becomes:
//   (reads: EntryReads, closing: ClosingPreparation) => Promise<Prepared<P>>
// DeviceEntryCapability.runCombined<P,T> prepare becomes:
//   (reads: DeviceEntryReads, closing: ClosingPreparation) => Promise<PreparedDevice<P>>
// Registry retirement capability becomes:
// retire<P,T>(key: GroupKey,
//   prepare: (reads: EntryReads, closing: ClosingPreparation) => Promise<Prepared<P>>,
//   work: (stores: GroupStores<TTx>, prepared: P) => Promise<T>,
//   afterDrain?: () => Promise<void>,
// ): Promise<T>
```

`freeze` uses entry-bound reads under prepare, outside provider work, without acquiring owners/roots.
Bind effective request/prepared mutationID, entry/attempt, source lifetime/version/identity and transition guards. Missing/conflicting IDs reject.
Detach prepared.value/domain bytes. Return Prepared with an identity-registered token retaining frozen data, source tuple, guards and allowed writes.
Closing values contain persistence data only; runtime handles/functions remain private locals. Copied tokens grant nothing.
`lifetime:null` means no lifetime write. Every listed state/lifetime value must match the submitted domain write exactly.

**Order:** startup barrier -> owned prepare/crypto -> freeze -> return Prepared -> synchronous closure -> transact -> work -> proof/settlement.
`run` consumes prepared.closing before transitionOwned. Combined consumes it before outer db.transact.
Close/invalidate source/wire cells there. Work/state.save cannot discover closure.
Work receives detached data; its writer checks exact domain values/expected guards.
Work-time undeclared terminal/deleted/displacement writes reject before modifying rows, including alternate transaction-bound store construction.
Direct public transitions cannot declare closure. Attempted closing writes **refuse** before domain mutation, rolling back the already-started transaction.

**Atomic producer migration map -- all migrate in T4a:**

| Existing producer | Prepare declaration and work migration |
| --- | --- |
| `registry/access.ts` recordFor/writeState, mutate/replace/adopt and control replay branches | Freeze when proposed state first becomes terminal; move final serialisation before freeze; write only frozen state/control data |
| `registry/app-open.ts`, `registry/app-publication.ts:196` and `registry/live-send.ts` prepared saves | Same conditional terminal declaration; non-closing saves remain ordinary entries |
| `registry/switch.ts` capability.run | Freeze source retirement and destination domain plan in prepare; work installs frozen values |
| `registry/seed.ts` capability.run (Combined in T11) | Existing-lifetime replacement freezes readmission plan; genesis has no old source to close |
| `registry/registry.ts` retirement wrapper; `registry/retired.ts` deleteIncarnations/retireIncarnation; `successor.ts` retireToSuccessor | Replace work-only retirement input with prepared lifetime/tombstone plan; freeze delete/successor before submission; drain remains outside owners |
| `memory-group-persistence.ts` implicit source tombstone during lifetime change | Require the declaration and include derived tombstone in frozen domain; accounting cannot invent closure |
| direct closing source/test/integration callers and storage/conformance seed helpers | Migrate closings to private prepared-entry fixture helper; retain public refusal tests; migrate independent fixtures in this task |

Migrate registry/safety.ts retirement typing and successor/delete callers to the exact prepare/work retirement signature above.
Search `terminal`, `activeIncarnation`, `deleted:true`, `state.save`, `lifetime.save` and retirement helper callers before committing.
Migrate every discovered producer now. Work cannot commit undeclared closure. T6/T7b/T11 subsequently migrate crypto routing.

Closing authority permits frozen writes only, never restore/crypto/transport. Unknown retains owners/data/closure.
Only proven rollback admits fresh authority. Retry revalidates original identity/version and package/source/acceptance guards under owned prepare.

Closure publishes no terminal fact or success before proof. Submitted calls may settle without further source authority.
Unknown proof has no timeout escape, even when it delays separately authorised completion.
Rollback never reopens an old binding/gate. Only fresh authority can revalidate and retry.

- [ ] **Step 1: Add failing closing/rollback witnesses.**

| Test | Required assertions |
| --- | --- |
| `closing mutation persists frozen data without renewed authority` | Valid removal/switch/readmission data can persist after closure; no protected primitive starts afterward |
| `source closes before backend commit can precede proof` | Pause submission/proof; cached source/gate is already closed; no early terminal publication |
| `unknown outcome retains closure and both Combined owners` | Queued source/completion/package work cannot pass until proof; no elapsed-time release |
| `fresh admission never revives superseded references` | Fresh live operation/retry succeeds when unchanged; old reference remains refused; changed expected tuple refuses |
| `copied closing token cannot persist arbitrary data` | Wrong mutation/object/attempt and changed frozen input reject without row/effect changes |
| `closing declaration precedes transact and work` | Pause backend entry; old source already closed and work count zero; then frozen producer succeeds after proof |
| `direct persistence cannot commit undeclared closure` | Public terminal/deletion/displacement attempts reject before domain mutation; row/hook deltas zero; non-closing transition succeeds |

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-rpc test/source-closing.test.ts test/source-executor.test.ts`. Expected: missing early closure/frozen-authority assertions fail.
- [ ] **Step 3: Implement the private protocol.** Reuse D8 outcome/proof/rollback settlement. Add no second lock, queue or public authority flag.
- [ ] **Step 4: Verify.** Run focused GREEN, mls-rpc/rpc unit+types, full `kintegration`, `kcontracts`; `ktypes` for public changes. Expected: all pass.
- [ ] **Step 5: Mutation-check closure.** Close after observation, accept a copied token, reopen old generation or skip rollback revalidation.
  Require named assertion RED and restored GREEN, including a successful fresh retry control.
- [ ] **Step 6: Commit.** Commit `feat(mls-rpc): bind closing persistence to frozen revocable source authority`.

### Task 5: Move managed crypto, live serializers and publication onto commands

**Depends on:** T4a.

**Files:**

- Create `packages/mls-rpc/src/registry/source-crypto-commands.ts`, `packages/mls-rpc/test/source-crypto-commands.test.ts`.
- Modify `packages/mls-rpc/src/{crypto,registry-crypto,mls-encryptor}.ts` and `registry/{access,cold,reserve,live-send,live-receive,app-open,app-publication,registry,source-executor-types}.ts`.
- Extend mls-rpc tests `{registry-crypto-conformance,registry-lease-conformance,app-publication-conformance,mls-encryptor,terminal-admission}.test.ts` and their fixtures.
- Migrate corresponding integration crypto/publication callers if byte-result wrappers change.

**Interfaces:**

Consumes executor.execute, SourceBinding, BoundSourceResult and existing byte-port types.
Intersect CryptoCommands into private SourceCommands:

```ts
type CryptoCommands = {
  'source.load': SourceCommand<undefined, AdoptionExpected>
  'app.seal': SourceCommand<{
    plaintext: Uint8Array; aad: Uint8Array; intent: 'log' | 'ephemeral'
  }, SealedApp>
  'app.receive': SourceCommand<Array<ReceiveInput>, Array<ReceiveResult>>
  'app.open': SourceCommand<Array<OpenAppInput>, Array<OpenAppResult>>
  'app.publication': SourceCommand<{
    entry: AppOutboxEntry; floor: string | null
  }, PreparedAppPublication>
  'app.publicationSnapshot': SourceCommand<string, AppPublicationSnapshot | null>
  'app.maintain': SourceCommand<undefined, void>
  'app.handoff': SourceCommand<undefined, void>
  'crypto.export': SourceCommand<{ label: string; length: number }, ExportSecretResult>
  'crypto.sealEntries': SourceCommand<Uint8Array, Awaited<ReturnType<GroupCrypto['sealEntries']>>>
  'crypto.openEntries': SourceCommand<Uint8Array, Uint8Array>
}
```

Preserve GroupCrypto.exportSecret(label:string,length?:number), default 32, entry-label refusal and ExportSecretResult.
Preserve RegistryHandleAccess byte ports and originating bindings through prepared/wire work. T9 adds wire admission.

**Path-to-command map:**

| Paths and aliases | Command / boundary |
| --- | --- |
| cold access/cache warm-up, `restoreValidated`, ownerless handoff | `source.load` / `app.handoff`; metadata precedes state |
| live-send `seal`, send-copy creation, reservation acceptance/accounting | `app.seal` for warmed work; `app.maintain` persistence prepare for refill |
| live-receive `receive/refresh`, queued encryptor decrypt chunks | `app.receive` for warm batches; separate maintenance when cold |
| durable open/streaming, registry-crypto.ts:45 unwrapBatch, rpc app-lane.ts:1322 openReady | `app.open`, one capped scheduled transition per batch |
| preparePublication/publicationSnapshot, log entry sealing | `app.publication` / `app.publicationSnapshot`; final certification remains storage-only |
| GroupCrypto wrap/unwrap | seal/receive/open commands according to frame intent |
| GroupCrypto sealEntries/openEntries/exportSecret | matching crypto command; derive-and-use stays inside operation |
| testing sender restoration/lease readers | executor-private diagnostic only; T8 removes raw testing result |
| `registry/cold.ts:67,163`, `reserve.ts:72,127`, `registry.ts:477,733,1234` | `source.load/app.handoff/app.maintain`; private restore stays under G |
| `registry/access.ts:137,163,287,499,1265` | `source.load/app.maintain` restoration; control-only branches belong to T6 |
| `registry/live-send.ts:390,524,958,873,972`, `live-receive.ts:157,271` | `app.maintain/seal/receive/publication`, including encryptApplication and copied sender restoration |
| `crypto.ts:78,88,109,233,330,340,348,352,363,367,380`, `registry-crypto.ts:79`, `mls-encryptor.ts:61` | `crypto.export/sealEntries/openEntries`, `app.seal/receive/open`; raw helpers remain explicit host-only APIs |
| rpc `peer.ts:849,1055,1058,1059`, `control-prepare.ts:190,347`, `ledger-entries.ts:115` | Byte ports delegate to commands; batch scopes invoke private owned bodies without execute; T6a replaces commit resolvers |

MLSEncryptor delegates crypto here and trackPublish to T9. Saved completion uses plaintext storage, never source restore.

- [ ] **Step 1: Add failing command/routing tests.**

| Test | Required assertions |
| --- | --- |
| `warm seal and receive exclude removal across nested crypto` | Removal cannot commit until each full operation releases G; no independent serializer admits competing private work |
| `ephemeral chunks stay memory only` | After warm-up, provider transaction count zero; cold/exhausted calls reject without inline refill |
| `first warmed command waits for scope startup persistence` | Fresh scope/precreated seal/receive; pause first barrier/marker entry; flushReady: settled=false, protected counters=0; release and reach crypto through the same adapters; subsequent warm calls open zero transactions |
| `warmed commands service control and another lane within three batches` | Pause active ordinary A batch; queue sustained A, ready B and real control adoption; release; control and B finish within three total batches including active A, before another A batch; no direct scheduler invocation |
| `ready saved completion precedes the next burst command batch` | Pause A with backlog; ready saved-plaintext HandlerCompletion with settling handler; release; effect/pending removal/cursor commit precedes next A batch; both context modes |
| `warmed seal refuses device-root dependency` | Ordinary seal holds G while Combined preparation holds D waiting G; detectable callback root calls reject without queueing; cancellation/release permits ready control/completion; actual Welcome install is T11 |
| `managed entry crypto contains derived keys and suites` | Only protocol data escapes; no handle/state/context/key |
| `managed export succeeds live and refuses new exports after closure` | Live counter positive; terminal/superseded/restore-held delta zero; returned bytes remain host data |
| `cancelled seals burn generations without installing late progress` | Revocation discards scratch handle/result; allocated sender generations never repeat; resumed stale operation cannot overwrite newer cache/progress |
| `fail-stop revokes suspended memory-command authority` | Live warm seal/receive control; pause next primitive, snapshot progress, queue caller; real coordinator fail-stop rejects active/queued callers with its conflict before release; resume: zero later primitive calls or result/cache/lease/ratchet installation; warm transaction count zero |
| `cached clones require fresh command admission and gain no lease` | Private clone; stale seal/open/export refuses; fresh admission succeeds |
| `cold and ownerless paths admit before private reads` | Terminal metadata refuses before reads.state/restore, including unreadable private envelope |
| `saved pending replay does not call source commands` | After terminal, existing plaintext/pending remain readable and completable with private counters zero |

Run ordinary-adapter fail-stop witnesses against real MLS/doubles in both ownershipContext modes.

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-rpc test/source-crypto-commands.test.ts test/registry-crypto-conformance.test.ts test/mls-encryptor.test.ts`. Expected: routing/owner/primitive assertions fail.
- [ ] **Step 3: Migrate complete operations.** Retain leases, ratchets, receive counts and AAD/intent checks.
  Burn allocated sender generations on revocation. Install scratch progress only while live.
  Replace sendTail/receive locks. Re-admit after maintenance; never await roots or maintenance under G. Keep guards as assertions.
- [ ] **Step 4: Verify.** Run focused GREEN, mls-rpc/rpc unit+types, full `kintegration`, `kcontracts`. Run `ktypes` for any public type change. Expected: all pass.
- [ ] **Step 5: Mutation-check enforcement.** Bypass commands, release G during HKDF, reuse clones, skip barrier, or bypass D3.
  Omit command fail-stop revocation, including post-await liveness/result checks; resumed primitive/progress assertions must fail.
  Require behavioural RED for each mutation, then restored GREEN, including startup counters and exact batch/completion order.
- [ ] **Step 6: Commit.** Commit `refactor(mls-rpc): contain managed application crypto in source commands`.

### Task 6: Move control, rotation, ledger and adoption authority inside commands

**Depends on:** T5.

**Files:**

- Create `packages/mls-rpc/src/registry/source-control-commands.ts`, `packages/mls-rpc/test/source-control-commands.test.ts`.
- Modify `packages/mls-rpc/src/{control-build,control-validation,control-adoption,auto-rotation,revoke,mls}.ts`, `registry/{access,types,control-batch,source-executor-types}.ts`.
- Modify rpc `src/control/build.ts`, `src/peer.ts`; extend control/build/validation/adoption/rotation tests and independent conformance fixtures.
- Migrate all builder/frame callbacks and rpc/mls-rpc/integration callers now.

**Interfaces:**

Consumes executor/binding, ClosingPreparation and T5 crypto commands.
Produces data-only resolve/frame and private commands:

```ts
type ManagedInviteParams = Pick<CreateInviteParams, 'recipientDID' | 'controllerLog'> & (
  | {permission: GroupPermission; entries?: never}
  | {permission?: never; entries?: Array<string>}
)
// RegistryHandleAccess.createInvite(params: ManagedInviteParams): Promise<CreateInviteResult>
type ManagedBuildInput =
  | {kind: 'invite'; keyPackage: Parameters<typeof commitInvite>[1]; invite: Parameters<typeof commitInvite>[2]}
  | {kind: 'remove'; leafIndex: number; ledgerEntries?: Array<string>}
  | {kind: 'ledger'; tokens: Array<string>}
  | {kind: 'rotation'}
  | {kind: 'revoke'; input: RevokeWithProofParams}
type ControlFrameInput = Omit<HostBuilt, 'journal'>
type ControlFrameResult = {payload: Uint8Array; publishID: string; expectedHead: LogPosition | null}
type ManagedBuiltFrame = {
  id: string; built: ControlFrameInput
  entries: Awaited<ReturnType<GroupCrypto['sealEntries']>>
}
type FrameControlBuild = (
  built: ControlFrameInput, entries: ManagedBuiltFrame['entries'],
) => Promise<ControlFrameResult>
// Managed builder configuration:
// resolveBuild(operation: Operation): Promise<ManagedBuildInput>
// ControlBuildPort.prepareBuild(op: Operation, frame: FrameControlBuild): Promise<PrepareControlResult>
```

commitInvite is packages/mls/src/group-commit.ts:586; executor supplies group.
Replace build/rotate/serializeJournal callbacks with resolveBuild/private serialisation. Migrate callers now.
Resolve/frame use public/presealed data outside G. Standalone builders stay unmanaged.

Register these exact private command signatures:

- `control.createInvite`: `SourceCommand<ManagedInviteParams, CreateInviteResult>`, supplying group/identity privately.
- `control.build`: `SourceCommand<{op: Operation; input: ManagedBuildInput}, ManagedBuiltFrame>`.
- `control.save`: `SourceCommand<{id: string; frame: ControlFrameResult}, PrepareControlResult>`.
- `control.rotate`: `SourceCommand<undefined, OperationRequest | null>` for scheduler eligibility.
- `control.revoke`: `SourceCommand<{op: Operation; input: RevokeWithProofParams}, ManagedBuiltFrame>`.
Each mapping uses SourceCommand<Parameters<F>, Awaited<ReturnType<F>>> for function F.

| Command | Function F |
| --- | --- |
| control.restoreValidation | ControlValidationPort['restoreValidation'] |
| control.adopt | ControlAdoptionPort['adopt'] |
| control.header, control.validateRecoveryCommit | GroupMLS['readCommitHeader'], ['validateRecoveryCommit'], respectively |
| ledger.seal, ledger.open, ledger.bootstrap | GroupMLS['sealLedger'], ['openSealedLedger'], ['bootstrapLedger'], respectively |

Validation commands instead use `{id:string; args:Parameters<F>}` input and Awaited<ReturnType<F>> output.
Map control.validation.header/frame/own to ControlValidation.readCommitHeader/validateFrame/verifyOwn respectively.

Ports: `packages/rpc/src/control/{build,search,types}.ts`.
prepareBuild: resolve -> owned build/seal -> framing -> fresh save with original binding/guards.
Facades retain IDs. Only executor validation/adoption opens BuiltCommit.journal's source/candidate/proposal envelope.

**Path-to-command map:**

| Managed path | Executor route |
| --- | --- |
| `prepareBuild`, returned build drive/save/retry | resolve/frame outside G; control.build/save re-admits |
| managed invitation creation before enqueue | control.createInvite; no raw group callback |
| captured suite/state/credential/entry key in control-build | Command-local private journal only |
| `restoreValidation`, returned header/validate/verifyOwn callbacks | control.restoreValidation + validation commands |
| private header and recovery-commit validation | Matching control command owns sender-data work; processCommit cutover belongs to T6a |
| `adopt`, access mutate/replace/adopt | control.adopt; freeze terminal data before submission |
| auto-rotation scheduler/lazy producer | control.rotate; release between commands |
| buildRevokeProofOperation/publishRevokeProof | control.revoke, then data-only wire |
| ledger seal/open/bootstrap | Ledger commands; saved ledger/epoch/roster returns copied data |
| `control-build.ts:316,322,354,387,421`, `control-validation.ts:211,271,384,389,429,436`, `control-adoption.ts:40`, `mls.ts:1171` | `control.build/restoreValidation/adopt` and validation commands own source/candidate restore, derivation, seal/open |
| `registry/access.ts:376,673,705,974,1115,1122` | control.adopt or validation commands own restore/mutation/replacement |
| `mls.ts:1028,1041`, rpc `peer.ts:2020,4519`, `host-boundary.ts:401`, `control/slot.ts:60` | ledger.seal/open and validation facades enter commands; no retained key |

**Green boundary:** Keep processCommit outside execute until T6a's atomic context migration.
Its ordinary resolver stays outside G. Batch-local open/export invokes private owned bodies, never roots.

- [ ] **Step 1: Add failing containment/continuation tests.**

| Test | Required assertions |
| --- | --- |
| `managed invitation creation needs no raw source handle` | Real Invite/enqueue/build succeeds from public parameters; signer/group never escapes |
| `control build owns every async private continuation` | Pause suite/build/seal; removal waits through command end |
| `validation facade cannot retain usable private authority` | Stale facade refuses before restore/crypto; live validation succeeds |
| `terminal adoption persists frozen data without new crypto` | Self-removal persists applied/control/terminal at unchanged epoch; postclosure primitive delta=0 |
| `rollback build and adoption retry revalidate frozen data` | Fresh retry requires unchanged identity/version/guards; old facade refuses |
| `framing callback receives no private authority` | Captured arguments contain no journal/handle/seal closure; removal during framing makes save refuse |
| `rotation and revoke retain leases and independent obligations` | Preserve bytes/ID/deadline, Welcome/retry rules; hub poison cannot retire |

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-rpc test/source-control-commands.test.ts test/terminal-admission.test.ts`. Expected: containment assertions fail.
- [ ] **Step 3: Implement the mapped handlers and adapters.** Resolve/frame/network outside G; revalidate binding/source on re-entry.
  Refuse control.load/readControl roots and nested execution under G.
  Preserve handshake normalisation, named-entry validation, r28i retries and proof/publication rules.
- [ ] **Step 4: Verify.** Run focused GREEN, mls-rpc/rpc unit+types, full `kintegration`, `kcontracts` and `ktypes`. Expected: all pass, zero cached repo types.
- [ ] **Step 5: Mutation-check facades.** Return suite/handle closures, bypass adoption or reuse closing tokens after changed guards.
  Require assertion RED/restored GREEN; retain terminal public-verification controls.
- [ ] **Step 6: Commit.** Commit `refactor(mls-rpc): execute control and adoption with contained authority`.

### Task 6a: Apply delivered commit entries without executor reentrancy

**Depends on:** T6. This closes the temporary commit-resolver route before recovery migration.

**Files:**

- Modify mls-rpc `src/{mls,apply-commit,registry-group-mls}.ts`, `src/registry/{access,control-batch,source-control-commands,source-executor-types}.ts`.
- Modify rpc `src/{crypto,control-batch,control-prepare,peer}.ts` and `src/index.ts` if type exports require adjustment.
- Modify independent `packages/rpc-conformance/src/group-mls.ts` and every real/double commit-context producer/consumer.
- Extend mls-rpc `test/{source-control-commands,control-batch-effects}.test.ts`.
- Migrate rpc `test/{control-prepare,group-mls,group-mls-adoption,peer-safety-commit,memory-commit-authentication,ports-conformance}.test.ts` and `test/fixtures/{memory-group-mls,peer,commits}.ts`.
- Migrate affected integration contexts, including `tests/integration/test/{app-lane-e2e.ts,app-lane-delivery.test.ts,lifecycle-recovery.test.ts,control-first-valid.test.ts}`.

**Interfaces:**

Consumes SourceExecutor/SourceBinding, T6 control handlers and existing ProcessCommitResult/AdoptionWriteFactory.
Replace public CommitContext in rpc crypto.ts and its independent mirror, preserving the adoption factory's staged public-data contract:

```ts
type CommitContext = {
  adoption?: AdoptionWriteFactory
  senderDID?: string
  sealedEntries?: Uint8Array
}
type ManagedCommitInput = { commit: Uint8Array; context: CommitContext }
type CommitCommands = {
  'control.processCommit': SourceCommand<ManagedCommitInput, ProcessCommitResult>
}
// GroupMLS.processCommit(commit:Uint8Array, context:CommitContext):Promise<ProcessCommitResult>
// ReadyControlScope.prepareCommit uses this exact signature.
```

Remove CommitContext.resolveLedgerEntries and ReadyControlScope.openEntries. The optional blob represents this delivered frame only.
Absence supplies no missing bodies. Copy commit/blob bytes at admission; callers cannot substitute another frame during awaits.
Adoption receives copied staged public data only and obeys D8 callback restrictions.

Ordinary processCommit enters execute once. Its already-owned handler opens entries privately during application, without crypto.openEntries/execute.
ReadyControlScope.prepareCommit calls the same private body under the existing batch owner and attempt, without acquiring G again.
Keep other batch methods, including exportSecret and validation, entry-bound to private owned bodies; they never invoke executor roots.
Invalidate the scope on exit/revocation. Retained scope methods cannot initiate another primitive.

The private resolver uses the owned handle, configured entryLabel and current attempt-bound provider.
Install it only for the applying commit's duration, then clear it in finally.
Open lazily only when MLS asks for missing named IDs after applicable-epoch/authorship checks.
No-entry, already-satisfied and inapplicable commits perform zero entry derivation/open calls.
Preserve digest/signature binding, custom entry labels and the receiver reference predicate for own-copy validation.
Keep standalone GroupOptions.resolveLedgerEntries host APIs distinct from this removed port callback.
Retain `resolveLedgerEntries?: (ids:Array<string>) => Promise<Array<string>>` explicitly on the host ApplyCommitParams type.
Managed applyCommit calls supply only the private owned resolver.

**Path-to-owned-handler map:**

| Current path at HEAD 288eedf1 | Migration |
| --- | --- |
| rpc peer.ts:2640-2659 resolver -> crypto.openEntries | Pass sealedEntries from commitFrame; preserve error classification outside the command |
| rpc control-prepare.ts:282-299 resolver -> scope.openEntries | Pass the same frame blob to entry-bound prepareCommit; remove the openEntries scope member |
| mls-rpc mls.ts:696,739,762 and apply-commit.ts:123 | One owned commit body with private lazy resolver; no externally supplied entry callback |
| mls.ts:1123,1166,1183; registry/access.ts:1053; registry/control-batch.ts | Preserve configured label; join existing owner/attempt for batch methods, not local public access roots |
| rpc-conformance group-mls.ts:77; rpc double memory-group-mls.ts:2576 | Independent data-bearing mirror and lazy frame-local opening; no permissive resolver fallback |

Delivered-entry refusal yields no bodies. Malformed/missing bodies remain delivered-copy skips, never membership refusal or durable hold.
Unsupported versions retain unknown-version/coverage diagnostics. Provider exceptions retain identity and local retry policy.
Remove peer's callback flags. Classify DeliveredEntryCopyError/MissingLedgerEntriesError as copy skips and UnsupportedLedgerEntriesVersionError as coverage uncertainty.
Other exceptions propagate unchanged for local retry; no blanket crypto catch converts provider failures into hub-fault skips.

**Green boundary:** Change producers, public/mirror types, real implementations, batch scopes, doubles and fixtures together.
Search CommitContext/ConformanceCommitContext and context.resolveLedgerEntries, including context literals in integration helpers.
Do not change GroupOptions resolvers used by standalone MLS construction. No compatibility callback overload remains on the port.

- [ ] **Step 1: Add failing ordinary and batched witnesses.**

| Test | Required assertions |
| --- | --- |
| `ordinary named-entry commit uses one source owner` | Ordinary peer applies a valid foreign commit with its delivered blob/custom label; ledger/roster/cursor update; one execute/G acquisition; nested execute count zero; removal waits through paused derive/open |
| `batched named-entry commit joins its existing owner` | Real buffered control path calls prepareCommit; same named-entry result and label; only batch owner/attempt used; zero nested execute/G acquisition; retained scope refuses after exit |
| `delivered entries open lazily with unchanged refusal policy` | No-entry/already-held/wrong-epoch/own-policy-refused commits open zero blobs; valid missing-entry control opens; wrong digest/malformed/refused blob skips atomically; unsupported version diagnoses; no hold/halt/build retirement; provider exception identity propagates |
| `commit contexts expose data without entry callbacks` | Public/mirror type tests reject resolveLedgerEntries and scope.openEntries; every migrated caller compiles |

Run ordinary and buffered paths against real MLS/doubles in both ownershipContext modes.
Calibrate private entry derive/open counters with a valid same-adapter commit before refusal assertions.

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-rpc test/source-control-commands.test.ts test/control-batch-effects.test.ts`.
  Expected: data-context, owner-count and lazy-opening assertions fail.
- [ ] **Step 3: Migrate the complete port and owned body.** Preserve named-entry application and frozen adoption writes before terminal submission.
  Never call public crypto/access/execute roots from the resolver or batch methods.
- [ ] **Step 4: Verify.** Run focused GREEN, mls-rpc/rpc unit+types, full `kintegration`, `kcontracts` and `ktypes`.
  Expected: all real/double and context modes pass, zero cached repo types.
- [ ] **Step 5: Mutation-check ownership and lazy opening.** Route private open through execute, reopen an expired scope, or open before eligibility.
  Require owner/counter/liveness assertion RED, not merely deadlock timeout. Restore GREEN.
- [ ] **Step 6: Commit.** Commit `refactor(mls-rpc): open delivered commit entries inside their owner`.

### Task 7: Execute complete recovery crypto with separate recovery authority

**Depends on:** T6a. Recovery construction remains trust-only and restores no source handle.

**Files:**

- Create `packages/mls-rpc/src/registry/source-recovery-commands.ts`, `packages/mls-rpc/test/source-recovery-commands.test.ts`.
- Modify `packages/mls-rpc/src/{mls,recovery,recovery-codec,registry-group-mls,manual-recovery,safety,safety-conditions,successor}.ts`.
- Modify `packages/mls-rpc/src/registry/{source,recovery-coordinator,source-executor-types}.ts`.
- Modify `packages/rpc/src/{crypto,peer,host-boundary}.ts`, `packages/rpc/src/control/rejoin.ts` and independent recovery mirrors/fixtures.
- T7c owns request-key co-storage and the release port. No storage representation change belongs to T7.
- Extend mls-rpc tests `{registry-peer,registry-switch,registry-source,registry-trust-construction,recovery-retained-trust,terminal-admission}.test.ts` and recovery fixtures.
- Migrate every affected recovery-facade caller, including integration and rpc doubles, within this task.

**Interfaces:**

Consumes executor `SourceBinding`, `ClosingMutation`, metadata and retained trust. Recovery never reads damaged source state.
Produces `RecoveryCommands` with command arguments/results fixed by the port mappings below.
For a function type `F`, the map entry is `SourceCommand<Parameters<F>, Awaited<ReturnType<F>>>` unless explicitly narrowed here.

`serialize(): Uint8Array` returns cached encrypted bytes after private control.assertCurrent(binding).
`confirmationKey(position:string, commitDigest:string):Promise<Uint8Array>` re-enters recovery.candidateKey.
Candidate crypto facades retain private IDs/data. Keep the internal accept(GroupHandle,...) hook until T7b migrates switch with onAccepted orchestration.
Never pass an ID to the unchanged raw-candidate switch port. Release G before orchestration.
**Green boundary:** T7-T7b retain existing raw requestKey representation throughout, including persisted rows and every old consumer.
They introduce command routing first. T7c changes representation atomically after all private consumers are contained.
No opaque reference or raw-key resolver bridge is introduced here. Key-containment completion is claimed only after T7c.

**Path-to-command and classification map:**

| Current aliases | New route / exact port type |
| --- | --- |
| createRecoveryRequest/signRecoveryConfirmation/exportRecoverySecret | `recovery.request/sign/export`, matching `GroupMLS` methods |
| inspectCapture/checkRosterAbsence/openRecoveryVerdict | `recovery.inspect/absence/openVerdict`, CapturedRecoveryPort/GroupMLS method mappings |
| captured applyRecovery/restoreRecovery | `recovery.build/restore`, matching CapturedRecoveryPort methods; facade contains IDs/encrypted results |
| candidate serialize/confirmationKey | Cached envelope; recovery.candidateKey uses the existing method tuple/result. T7b owns recovery.accept/onAccepted cutover |
| reconcileCapture/authoriseForkRecovery/checkForkRecoveryCapture/settleForkCapture | `recovery.reconcile/authoriseFork/checkFork/settleFork`, matching current coordinator/port methods |
| sealRosterAbsence | `recovery.sealAbsence`, `CapturedRecoveryPort['sealRosterAbsence']` non-nullable function type |
| sealGroupInfo/sealRecoveryVerdict/confirmationKey/prepareRecovery | `recovery.sealInfo/sealVerdict/confirmation/prepare`, matching GroupMLS methods, with source authority where live MLS is required |
| recoverySource/readSource/GroupMLS construction | Metadata/trust projection through recovery admission, no private restore; returned snapshots grant no authority |
| manual target/recoveryBinding/resolver callbacks | Data-only request outside ownership, then fresh command with binding and expected source |
| successor access | Its own group executor/binding; source completed-choice/status/ack remain inspect |
| verifyRecoveryConfirmation/verifyRecoveryRequest | Public token inputs + immutable public groupID, legal after terminal; never obtain source authority |
| preliminary verify in captured sealGroupInfo | Public verification legal; subsequent roster/capture/seal requires admitted source command |
| `mls.ts:416,473,483,498,969,973`, `recovery.ts:130,541,588,672,785,805,813` | `recovery.inspect/build/restore/reconcile` own every candidate decode, reply authentication and private candidate restore |
| `mls.ts:243,244,561,569,614,619,635,645,818,827,878,893,904,920,1010,1083` | `recovery.export/sign/confirmation/sealVerdict/openVerdict/request/sealInfo/restore/candidateKey`; includes signToken, captured/legacy seal/open and HKDF |
| `recovery.ts:90,91,104,119,185,193,450,453,617`, `registry-group-mls.ts:380,388` | Matching request/export/absence/verdict/candidateKey/sealAbsence commands, including trusted helper aliases |
| `mls.ts:303,397,1079`, `recovery.ts:604`, `safety-conditions.ts:142`, rpc `host-boundary.ts:498` | recovery verdict/absence/export/restore commands, including judge callbacks and default deriveRecoverySecret |
| `recovery-codec.ts:85,99,266,294` | Raw AEAD helpers stay host-callable; managed callers use T7-T7b commands. T7c changes key meaning |
| rpc `peer.ts:1796,1918,2927,2937,3336,4480,4918,5005,5032,5154,5204,5244,5260,5428,5788`; `recovery-capture.ts:23`; `recovery-confirmation.ts:31,178` | GroupMLS/captured delegates enter recovery commands; network stays outside G |

Managed recovery.ts helpers run inside commands. Export retains G through suite acquisition/HKDF extract/expand.
For binding renewal, return data, release G, resolve externally and re-admit/revalidate before retry.
Never await registry.start, switchIncarnation, target resolution, network or onAccepted orchestration under G.

- [ ] **Step 1: Add failing recovery/replay witnesses.**

| Test | Required assertions |
| --- | --- |
| `recovery derivation owns nested HKDF continuations` | Pause suite/extract; queued removal cannot pass; revocation causes no later expand invocation |
| `binding renewal releases ownership and requires fresh admission` | Failed build requests external binding without G; removal during callback prevents retry construction/sign/derive |
| `unreadable source state permits only admitted retained-trust recovery` | Readable non-terminal metadata/trust admits request/authenticate/candidate restoration; source restore/read-state zero |
| `terminal or unreadable admission metadata refuses recovery` | Trust alone cannot admit; all private boundary deltas zero; missing trust preserves existing unavailable/hold policy |
| `public verification survives terminal without granting authority` | Valid signed request/confirmation/GroupInfo verifies; following protected seal/request/export still refuses |

Calibrate actual authentication/restore primitives before resetting counters. Avoid lexical-wrapper-only spies.

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-rpc test/source-recovery-commands.test.ts test/recovery-retained-trust.test.ts`. Expected: current HKDF/renewal/continuation assertions fail.
- [ ] **Step 3: Move complete recovery operations and migrate callers.** Private authentication/derivation runs only inside admitted recovery commands.
  Check requested/current metadata under ownership. Live recovery never restores damaged source state.
  Preserve fork/manual provenance, F > E retirement evidence, source tuple validation, independent outcomes/Welcomes and no-reseal outbox policy.
  Public-only verifiers use immutable public identity rather than calling `readRecoverySource()` merely to compare groupID.
- [ ] **Step 4: Verify.** Run focused GREEN, mls-rpc/rpc unit+types, full `kintegration`, `ktypes`, `kcontracts`. Expected: all pass, zero cached repo types.
- [ ] **Step 5: Mutation-check recovery authority.** Release G before HKDF, call renewal under G, or reuse an invalidated candidate continuation.
  Require corresponding counter/ownership RED and restored GREEN. Blanket refusal must fail unreadable-state/public-verification live controls.
- [ ] **Step 6: Commit.** Commit `refactor(mls-rpc): contain complete recovery crypto operations`.

### Task 7a: Own recovery validation and abandonment while preserving completion

**Depends on:** T7. Keep raw requestKey semantics until T7c.

**Files:**

- Modify `packages/mls-rpc/src/{recovery-record,branch-history,recovery,registry-peer}.ts` and `registry/{continuation,verdict,recovery-coordinator,source-recovery-commands,source-executor-types,switch}.ts`.
- Modify rpc `src/recovery-types.ts`, independent conformance recovery mirrors and all record-producing fixtures/integration callers.
- Create `packages/mls-rpc/test/recovery-validation.test.ts`; extend `{recovery-record,registry-continuation,branch-abandoned}.test.ts` and manual recovery fixtures.


**Interfaces:**

Consumes SourceExecutor.execute/SourceBinding, SourceCommand, T7 recovery handlers and T4a ClosingPreparation.
Produces required `candidateIdentity: EpochIdentity` on CapturedRejoinRecord and CapturedPendingRecovery, plus the executable legacy record variant used by current adapters.
Persist verified destination identity at construction: groupID from source.key, incarnation=source.key.incarnation+1, and candidate epoch/authenticator.
Migrate every producer/fixture now. Missing required identity refuses; no legacy-data reconstruction.
Keep `validateCapturedRecoveryRecord(input: CapturedRejoinRecord): CapturedRejoinRecord` for public shape/digest/tuple validation only.
It performs no decode/decrypt and makes no authenticated association claim. decodeRecoveryRecord remains storage-only.
Add these private commands:

```ts
type RecoveryValidationCommands = {
  'recovery.validateCandidate': SourceCommand<CapturedRejoinRecord, EpochIdentity>
  'recovery.abandonment': SourceCommand<
    Parameters<RegistryRecoveryCoordinator['prepareBranchAbandonment']>,
    Awaited<ReturnType<RegistryRecoveryCoordinator['prepareBranchAbandonment']>>
  >
}
```

validateCandidate performs candidate decode/authentication/record association under recovery admission/G.
Only authenticated construction/validation may supply candidateIdentity. Installation compares it with actual candidate identity.
Public stores/record decoders/peer validators call structural validation. Private use calls the association implementation under its owned command.
Continuation load/finish retains its existing RecoveryContinuationPort signatures and completion authority.
Compare saved candidateIdentity with destination initialIdentity, spent proof and exact adopted record, including ordinary/manual variants.
Never gate load/finish/recoveryCompletion on the superseded source, resolve old keys or restore MLS private state.

**Path-to-command map:**

| Current path | New boundary |
| --- | --- |
| `recovery-record.ts:99,150`; callers `registry-peer.ts:833`, `recovery.ts:804`, `registry/verdict.ts:106` | Storage-only validation; private association enters recovery.validateCandidate |
| `registry/continuation.ts:61,62` installed/load/finish | Verified candidateIdentity + initialIdentity/spent/record equality; completion authority, no source gate/decode |
| `branch-history.ts:305,306,328,331`; `registry/recovery-coordinator.ts:126,127` | recovery.abandonment owns decode/auth/lineage; freeze event before closure |
| `recovery.ts:804,805,813` private restore association | Public shape check followed by private validation/auth in the existing recovery.restore owned implementation |
| `registry/switch.ts:398` branch preparation | Use owned recovery.abandonment implementation in prepare; freeze resulting public event with closing data |

The coordinator's ordinary prepareBranchAbandonment route admits recovery before decode/auth/lineage validation.
Its owned implementation accepts entry-bound reads; it never nests entry.read or execute under held G.
Switch uses that implementation inside its existing owned preparation, with admission validated before the private segment.
T7b migrates the remaining switch preparation. Retain raw-key bytes consistently until T7c.

- [ ] **Step 1: Add named ordinary-adapter witnesses.**

| Test | Required assertions |
| --- | --- |
| `ordinary record reads never decrypt recovery candidates` | Read/decode/status after terminal/quarantine remains structural; decode/auth/restore counters zero; forged association refuses at live private use |
| `branch abandonment is an owned recovery command` | Coordinator and switch routes reach real auth live; terminal/superseded/quarantined source refuses with zero decode/auth/restore; nested auth pause excludes removal |
| `candidate identity is verified before installation` | Wrong source/epoch/authenticator/commit association refuses; valid identity persists with the record; failed write/rollback exposes neither |
| `recovery completion survives source supersession without private decode` | Real switch then reconstruction: load/finish ordinary/manual continuation and recoveryCompletion settle outcomes/ledger/ack once; source stays revoked; key/decode/auth/restore counters zero |

Calibrate negative counters through the same ordinary adapter live first. Release all pauses in finally.

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-rpc test/recovery-validation.test.ts test/registry-continuation.test.ts`. Expected: public-decode/private-routing assertions fail.
- [ ] **Step 3: Split validation and migrate all producers/callers.** Keep private abandonment inside owned preparation and completion storage-only.
- [ ] **Step 4: Verify.** Run focused GREEN, mls-rpc/rpc unit+types, full `kintegration`, `ktypes`, `kcontracts`. Expected: all pass, zero cached repo types.
- [ ] **Step 5: Mutation-check boundaries.** Restore public decoder, bypass abandonment admission, release G during auth, or gate continuation on old source.
  Require each named counter/progress assertion RED, then restored GREEN. Live abandonment and completed-switch continuation remain positive.
- [ ] **Step 6: Commit.** Commit `refactor(mls-rpc): separate recovery private validation from completion proof`.

### Task 7b: Migrate recovery resolution, peer replay and incarnation switch

**Depends on:** T7a. Resolution admission happens before its candidate decode, not after returning to peer orchestration.

**Files:**

- Create `packages/mls-rpc/test/source-replay.test.ts`.
- Modify `packages/mls-rpc/src/registry/{recovery-coordinator,switch,types,source-recovery-commands,source-executor-types}.ts`.
- Modify `packages/mls-rpc/src/{registry-peer,registry-group-mls,recovery,recovery-codec}.ts` and `registry/verdict.ts`.
- Modify `packages/rpc/src/recovery-types.ts`, independent rpc-conformance recovery/registry mirrors and both fixture modes.
- Extend mls-rpc tests `{registry-peer,registry-switch,registry-source,terminal-admission}.test.ts` and affected integration recovery callers.

**Interfaces:**

Consumes T4 executor/binding, T4a frozen closing mutation, T7 recovery commands and T3 metadata/trust readers.
Produces:

```ts
type ManagedRecoveryCandidate = { id: string }
type RegistrySwitchParams = {
  source: LegacyRegistryRecoverySource | RegistryRecoverySource
  rejoinID: string
  proof: LegacyResyncProof | ResyncProof
  write: RegistrySwitchWrite
}
// GroupHandleRegistry.switchIncarnation(
//   candidate: ManagedRecoveryCandidate, params: RegistrySwitchParams,
// ): Promise<GroupKey>
// Consumes T7a required candidateIdentity: EpochIdentity on recovery records/facades.
function readRecoveryRecordInReads(
  reads: EntryReads, key: GroupKey, authorisationID?: string,
): Promise<StoredRejoinRecord | null>
```

Candidate IDs name executor-owned source/request-bound data, never handles.
Preserve T7a verified candidateIdentity. Missing identity refuses without legacy reconstruction.
Use destination initialIdentity/spent/exact record for storage-only replay. Root reads delegate to entry-bound reads without nesting.
T7a supplies structural record validation, verified candidateIdentity and storage-only continuation completion.
Use those exact interfaces. Private replay still validates association through recovery.validateCandidate under its retained owner.

Add command entries:

- `recovery.resolveSwitch`: `SourceCommand<Parameters<RegistryRecoveryCoordinator['resolveRecoverySwitch']>, Awaited<ReturnType<RegistryRecoveryCoordinator['resolveRecoverySwitch']>>>`.
- `recovery.replay`: `SourceCommand<{key: GroupKey; recordID: string; authorisationID?: string}, ManagedRecoveryCandidate>`.
- `recovery.switch.prepare`: `SourceCommand<[ManagedRecoveryCandidate, RegistrySwitchParams], ClosingMutation>`.

Convert internal accept(GroupHandle,...) and switch consumers to ManagedRecoveryCandidate together here.
No raw candidate callback survives. onAccepted(expected,proof,write):Promise<void> invokes write with copied public staged data outside G.
It passes the candidate ID and resulting RegistrySwitchParams to switchIncarnation, whose prepare revalidates source/candidate/proof.
No owned handler awaits switch orchestration.

**Path-to-command map:**

| Current path | New boundary |
| --- | --- |
| resolveRecoverySwitch proof/storage reads then candidate decode at :559 | Join proof outside owner; committed semantic tuple inspects data only; any candidate decode requires admitted recovery command |
| registry-peer accept/confirmed replay at :740/:898 | `recovery.replay` rereads exact source/record/metadata and authenticates/restores under one owner |
| onConfirmedRecovery, retry/resume/manual runner after awaits | Same replay command, never an old released source snapshot |
| peer reconcileAcceptedRecovery | T7/T7b `recovery.reconcile` with current exact source validation |
| switch candidate capture/restore before startup at switch.ts:151 | Device admission first, owned recovery prepare second, frozen closing install third |
| adopted/committed switch replay | Stored tuple/identity/spent comparison only, then separately admit destination startup |
| owned branch preparation | T7a recovery.abandonment implementation under the existing owner, before freeze; no nested root/execute |
| candidate onAccepted | ID/proof/write data to fresh switch orchestration; no raw candidate closure passed across release |
| `registry/recovery-coordinator.ts:308,368,559,614` | `recovery.authoriseFork/checkFork/resolveSwitch/reconcile` own reply auth and candidate decode |
| `registry/verdict.ts:190,192,194,326,333,339,345`; `registry/switch.ts:157,231,316,388` | `recovery.switch.prepare` owns verdict/candidate auth, restore and destination export; no private preparation in work |
| `registry-peer.ts:719,740` | `recovery.replay` owns candidate decode and restoration before switch orchestration |

Private recovery refuses terminal/unreadable metadata before decode/auth/restore. Non-terminal retained trust permits damaged-state recovery without source restore.
Removal waits during owned preparation; switch re-admits after release, then closes through T4a before submission.
Adopted replay/continuation remains storage-only after supersession. Destination startup uses its own binding; old references stay stale.

- [ ] **Step 1: Add assertion-RED replay/resolution tests.**

| Test | Required assertions |
| --- | --- |
| `resolution refuses removal before candidate decode` | Pause after proof/storage response releases ownership; commit removal; resume; actual candidate-decode/restore/crypto deltas zero |
| `confirmed replay reacquires after released record reads` | Pause final read, commit removal, resume; PeerRemovedError before auth/restore; same-pause live control installs once |
| `replay retains ownership through authentication and restore` | Pause actual nested primitive; removal remains uncommitted until release; subsequent switch re-admits independently |
| `direct switch refuses before candidate capture` | Device declaration/group terminal refuses before relinquish/capture/restore, including semantic replay inputs |
| `semantic adopted replay uses no private candidate restore` | Correct saved tuple returns destination without install/hooks; wrong tuple refuses; live destination starts freshly |
| `switch rollback revalidates frozen source and candidate` | Proven rollback fresh retry succeeds only with unchanged guards; old candidate/gate never revives |
| `switch and Welcome leave old references refused` | Old access/clone/prepared continuation stays stale; fresh admitted work succeeds; outbox fails incarnation-abandoned without reseal |

Calibrate real decode/auth/restore, including reconstructed/manual variants. Preserve PeerRemovedError precedence when removal also closes the rejoin record.

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-rpc test/source-replay.test.ts test/registry-peer.test.ts test/registry-switch.test.ts`. Expected: current released-read/decode assertions fail.
- [ ] **Step 3: Implement and migrate all candidate/switch callers.** Reuse T7 helpers only inside retained ownership.
  Release before roots, peer drain/start or network. Preserve exact acceptance/provenance/F > E guards and independent obligations.
- [ ] **Step 4: Verify.** Run focused GREEN, mls-rpc/rpc unit+types, full `kintegration`, `ktypes`, `kcontracts`. Expected: all pass, zero cached repo types.
- [ ] **Step 5: Mutation-check replay.** Decode before admission, authenticate after releasing G, or reuse the saved source across record reads.
  Require counter/ownership RED and restored GREEN. Blanket live refusal must fail same-pause replay and damaged-state controls.
- [ ] **Step 6: Commit.** Commit `refactor(mls-rpc): own recovery resolution replay and switch preparation`.


### Task 7c: Cut over managed recovery request keys atomically

**Depends on:** T7b. Routing and storage-only continuation proof exist before byte semantics change.

**Files:**

- Modify mls-rpc `{mls,recovery,recovery-codec,memory-group-persistence,memory-incarnation-stores,registry-peer,safety-conditions}.ts` under `packages/mls-rpc/src/`.
- Modify `registry/{source-recovery-commands,source-executor-types,recovery-coordinator,switch,verdict}.ts` and request/candidate record writers.
- Modify rpc `src/{crypto,peer,peer-types,host-boundary,recovery-only-mls,recovery-confirmation,recovery-reconcile}.ts`, `src/control/rejoin.ts` and all recovery mirrors/doubles/fixtures.
- Create `packages/mls-rpc/test/recovery-request-keys.test.ts`; extend recovery/replay/continuation tests and affected integration callers.

**Interfaces:**

Consumes executor `execute`, `SourceBinding`, all T7-T7b commands and their private key-taking helpers.
Managed `requestKey: Uint8Array` changes from raw key to opaque random reference in this task only.
No mixed representation or raw-key resolver bridge is permitted. Standalone unmanaged helpers retain caller-owned raw keys.
Add `GroupMLS.releaseRecoveryRequest(requestKey: Uint8Array): void` for transaction-free disposal, including terminal/recovery-only wrappers.
Add required `releaseRecoveryRequest(requestKey: Uint8Array): void` to both rejoin dependency types and settleRecovery parameters.
Pass the bound GroupMLS release method through their callers, including unmanaged implementations/doubles.
Generate keys privately. Command-local resolution requires owner/source/request association and exact expected record.
Co-write sealed keys with recorded rejoin/manual-candidate records. Public record/control projections expose references only.
Unrecorded keys live only in flight. Restart loads recorded sealed keys under fresh recovery admission.
Release disposes unrecorded key state, then clears local reference bytes. Durable key retirement co-commits with record removal.

**Atomic representation-consumer map:**

| Consumer | Same-task migration |
| --- | --- |
| T7 request/sign/export, inspect/absence/openVerdict/build/restore/candidateKey facades in mls.ts/recovery.ts | Return references; resolve only inside their admitted command handlers |
| T7a/T7b replay/resolve/fork/verdict/switch/abandonment/validateCandidate | Consume reference privately, then call raw helper with command-local key; never pass reference as AEAD/HPKE key |
| recovery-record.ts, registry/continuation.ts | Already storage-only from T7a; enforce zero key lookup/decode even after supersession |
| recovery-codec.ts candidate AEAD helpers | Keep raw-key API for private/standalone use; managed callers pass resolved key internally |
| registry-peer.ts:719; switch.ts:231,316; verdict.ts:190,192; branch-history.ts:305,306,328 | Former decodes already moved to T7a/T7b handlers; migrate all handler key arguments with producers atomically |
| recovery-coordinator.ts:308,368,559,614; mls.ts:416,473,483,969; recovery.ts:130,541,672,785,805,813 | Authentication/decode command implementations all resolve privately, with unchanged tuple/admission checks |
| `mls.ts:1041`, rpc `peer.ts:4519` ledger.open | Resolve request reference inside ledger.open before HPKE open; migrate with request producer despite earlier T6 ownership |
| rpc `peer.ts:3537,5237,5589,5859`, `control/rejoin.ts:356`, `recovery-reconcile.ts:80`; mls-rpc `registry-peer.ts:320`, `safety-conditions.ts:281`, registry/recovery-coordinator.ts:474 | Call release before clearing local reference bytes; persisted-record deletion retires sealed keys atomically |
| rpc peer/rejoin/confirmation, peer-types, host-boundary, recovery-only wrappers and crypto.ts port docs | Carry references consistently; update the raw-private-half documentation; no helper receives an unresolved reference |
| real/double mirrors, direct helper tests and persisted integration fixtures | Explicit managed-reference versus unmanaged-key setup; rebuild fixtures, no legacy-data fallback |

Re-grep every requestKey read/write and candidate/authentication helper call before committing.
Any remaining managed raw consumer joins this task, including callers that compile with Uint8Array but depend on key bytes.

- [ ] **Step 1: Add named atomic-cutover witnesses.**

| Test | Required assertions |
| --- | --- |
| `recovery key and candidate records commit together` | Mid-write/late rollback preserves both; late commit exposes both after proof; private durable keys sealed and absent from public projections |
| `managed recovery references reveal no candidate decryption key` | Returned reference cannot decode candidate bytes; live command and reconstructed replay/switch authenticate and install once |
| `opaque keys preserve fork verdict and abandonment routes` | Ordinary fork/check/reconcile, verdict and abandonment adapters reach real decode/auth primitives with references; association mismatches refuse |
| `released request references grant no further key authority` | Unrecorded release opens zero transactions; terminal release succeeds; reuse refuses; record deletion retires durable key atomically |
| `completion after switch needs no recovery key resolution` | Reconstructed continuation finishes with superseded source and zero private key/decode/restore calls |

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-rpc test/recovery-request-keys.test.ts test/source-replay.test.ts`. Expected: raw key disclosure/retirement assertions fail.
- [ ] **Step 3: Cut over producers and every consumer together.** Preserve request/record/candidate identity guards and no-reseal outcomes.
- [ ] **Step 4: Verify.** Run focused GREEN, mls-rpc/rpc unit+types, full `kintegration`, `ktypes`, `kcontracts`. Expected: all pass, zero cached repo types.
- [ ] **Step 5: Mutation-check representation.** Pass a reference directly to one former decoder/authenticator, expose raw key, or omit co-storage/release.
  Require named assertion RED and restored GREEN. Blanket refusal must fail reconstructed replay/switch/abandonment controls.
- [ ] **Step 6: Commit.** Commit `refactor(mls-rpc): replace managed recovery keys with opaque references`.

### Task 8: Migrate checkpoint signing and remove managed callback escape APIs

**Depends on:** T7c. This closes the temporary compatibility surface left while consumers migrated.

**Files:**

- Create `packages/mls-rpc/src/registry/source-checkpoint-commands.ts`, `packages/mls-rpc/test/source-containment.test.ts`.
- Modify `packages/mls-rpc/src/{checkpoint,access,testing,crypto,mls,registry-group-mls,index}.ts`, `registry/{types,access,registry,source-executor-types}.ts`.
- Delete `packages/mls-rpc/src/registry-handle-access.ts`; remove its index export and migrate every consumer.
- Modify all remaining managed callback consumers and test-only raw sender readers found by repo-wide search/typechecking.
- Modify independent access/checkpoint/registry mirrors in rpc-conformance and fixture implementations in mls-rpc/rpc.
- Extend mls-rpc tests `{checkpoint-installation,checkpoint-port-conformance,registry-trust-construction,registry-consumer-access,send-denial-sources,terminal-admission}.test.ts` and testing-export consumers.

**Interfaces:**

Consumes T4 executor, T5-T7c named commands and T3 metadata.
Produces data-only managed reads and a distinct unmanaged host type.
Update `source.inspect` to `SourceCommand<undefined, GroupReadSnapshot>` and migrate its consumers here.
Add `source.controlSnapshot: SourceCommand<undefined, {snapshot: GroupReadSnapshot; control: ControlSnapshot}>`.

```ts
type GroupReadSnapshot = {
  source: AdoptionExpected
  epoch: number
  roster: Array<RosterEntry>
  ledger: Array<string>
  ledgerComplete: boolean
}
// HandleAccess.read(): Promise<GroupReadSnapshot>
// HandleAccess.readControl(): Promise<{ snapshot: GroupReadSnapshot; control: ControlSnapshot }>
// RegistryHandleAccess uses these exact methods; no raw callback overload remains.
// UnmanagedHandleAccess retains the old raw callback contract for standalone host-owned MLS.
// simpleHandleAccess(params: SimpleHandleAccessParams): UnmanagedHandleAccess
```

Remove arbitrary managed mutate/replace/open callbacks and `ControlReadScope.handle/refresh` from public managed access.
Preserve `adopt(candidate: ManagedRecoveryCandidate, expected: AdoptionExpected, write: AdoptionWrite): Promise<'installed' | 'noop' | 'moved'>`.
T6 control candidate refs also use adopt, with private purpose/source/expected validation.
Existing explicit byte/adoption/crypto/lifecycle ports delegate to executor commands. They are not aliases for unmanaged access.
Keep `HandleAccess.admission(): SendAdmission` and `epoch(): number` as published data hints.
Raw `createGroupMLS/createGroupCrypto` constructors accept only the explicitly unmanaged contract. Registry factories never instantiate those raw routes.
Replace managed factory `restore/restoreCandidate` hooks with private restoration commands configured from the existing recovery environment/options.
The resulting factory parameters are exactly:

```ts
type GroupHandleRegistryParams<TTx extends GroupTransaction> = {
  persistence: DevicePersistence<TTx>
  providerID: string
  packages: DevicePackageAdapters
  batch?: GroupBatchOptions
  openedDeliveryContext?: OpenedDeliveryContext
  recovery: RecoveryEnvironment
} & RegistryOpenedHandlerOptions<TTx>
```

Keep journal/rotation-envelope decoding private. Migrate custom integrations to T6 managed inputs/envelopes now.
Hooks/test injection receive no managed handles, private state, credentials or suites.
Preserve candidate envelopes and zero-restorer construction. Raw host APIs retain custom restoration; managed factories use current library envelopes.

Produces `checkpoint.signInstalled` with exact input `Parameters<CheckpointPort['signInstalled']>` and output `Awaited<ReturnType<CheckpointPort['signInstalled']>>`.
The command retains G through saved-frame verification, suite acquisition and signing. Its registered purpose requires terminal/restore admission.
Compare/intake verification using public frame/roster data remains legal after terminal. Storage actions retain ordinary persistence phases.

**Alias-to-command/inspection map:**

| Alias | Route |
| --- | --- |
| checkpoint.ts:192, rpc checkpoint-worker.ts:144 signInstalled/retry | `checkpoint.signInstalled`, exact binding/metadata admission before suite/sign |
| compare, importCheckpoint, updateRecords with public intake | Public-data verification + existing storage transition, no source handle |
| fact/coverage/export/readRecords/events/forkNotices/ack/refresh | Storage inspection/ack, including terminal and restore quarantine |
| managed read/readControl | `source.inspect`/data projection; no arbitrary callback argument |
| managed mutation/replacement/control refresh | Already named T5-T7c commands; no compatibility callback fallback |
| createRegistryHandleAccess.replace, registry-handle-access.ts:18; registryCapturedReplacements, registry/access.ts:99,1264 and registry/registry.ts:855 | Remove wrapper/export/map, including capture/restore/forwarding; migrate registry-group-mls.ts:233 and all consumers to named managed commands/ref adoption |
| restoreCommittedSender/leaseReaders/serializeHandle on managed paths | Private diagnostics returning public counters/identity only; no raw handles/clones/private bytes |
| standalone simpleHandleAccess/raw helpers | Explicit host-owned contract, never silently selected by registry adapters |

- [ ] **Step 1: Add failing checkpoint and escape tests.**

| Test | Required assertions |
| --- | --- |
| `checkpoint retained debt cannot sign after terminal or restore hold` | Precreated port, unsigned and saved-frame debt; damaged state/reconstruction; new suite/sign calls zero |
| `checkpoint public inspection and intake survive source refusal` | Compare/verify/import/public-record updates, facts/export/ack/refresh succeed without source crypto or transport |
| `managed read has no handle result or callback capture surface` | Public type tests reject callback overload/raw result; runtime surface exposes only copied data |
| `managed clone and private-byte exports cannot escape` | No managed result/getter/callback contains handle/clone/state/context/credential/signing key; retained façade refuses outside operation |
| `raw managed replacement facade is absent` | Public type/runtime surfaces omit createRegistryHandleAccess/raw replace; valid candidate-ref adopt succeeds; stale/wrong-purpose refs refuse before capture/restore; registryCapturedReplacements has no remaining binding/consumer |
| `returned epoch exporter bytes remain host owned` | Admitted export succeeds; previous bytes remain data after removal; new exporter invocation refuses |
| `trust-only constructors restore nothing` | GroupMLS/crypto/checkpoint construction performs zero private restore, including unreadable state |

Attempt every public hook/retained continuation. Pause/cancel a provider; resumed capture starts no new primitive.

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-rpc test/source-containment.test.ts test/checkpoint-installation.test.ts test/registry-trust-construction.test.ts`. Expected: old raw surfaces/retained signing assertions fail.
- [ ] **Step 3: Remove escape APIs and migrate every remaining caller.** Use public data projections where callers only inspect.
  Move private use into named handlers. Copy arrays/bytes defensively. Do not use a generic result filter to compensate for arbitrary raw callbacks.
  Update independent mirrors and test fixtures now. Keep storage status/epochAuthenticator/report/ack separate from recovery authority.
- [ ] **Step 4: Verify.** Run focused GREEN, mls-rpc/rpc/mls-hub unit+types, full `kintegration`, `ktypes`, `kcontracts`. Expected: all pass, zero cached repo types.
  Search managed sources for raw callback access, suites, `.clone()` and captured private bytes. Every remaining hit must be executor-private or explicit unmanaged code.
- [ ] **Step 5: Mutation-check containment.** Reintroduce a raw read/replacement callback, raw diagnostic handle or checkpoint signing bypass.
  Require public-type/runtime/boundary assertion RED and restored GREEN. Public verification and live export controls must remain positive.
- [ ] **Step 6: Commit.** Commit `refactor(mls-rpc): close managed authority escape surfaces`.

### Task 9: Check binding-aware wire admission at actual transport invocation

**Depends on:** T8.

**Files:**

- Create `packages/rpc/src/source-wire.ts`, `packages/rpc/test/source-wire.test.ts`.
- Modify `packages/rpc/src/{index,peer,peer-types,peer-epoch,hub-mux,host-boundary}.ts`.
- Modify `packages/mls-rpc/src/{registry-peer,mls-encryptor}.ts`, `registry/{source-executor,source-executor-types,registry}.ts`.
- Modify independent peer/wire mirrors and fixtures in rpc-conformance, rpc, mls-rpc and integration.
- Create `packages/rpc/test/peer-epoch.test.ts` for directed-reply disposal. No such file exists at this baseline.

**Interfaces:**

Consumes private lifecycle cells and SourceBinding from T4, plus bound prepared results from T5-T8.
Produces portable rpc exports and required peer/tunnel wiring:

```ts
type SourceBinding = { key: GroupKey; generation: number }
type SourceWireGate = {
  binding: SourceBinding
  assertInvocation(): void
  onRevoked(listener: (error: Error) => void): () => void
}
// GroupPeerParams.sourceWire: SourceWireGate
// MLSEncryptorParams.sourceWire: SourceWireGate
```

The gate is immutable and captures one exact incarnation/generation. Only mls-rpc's private executor can issue its managed implementation.
RPC receives no close/reopen control. A copied binding cannot mint a gate. Unmanaged hosts/doubles implement the same port contract explicitly.
`assertInvocation()` synchronously checks captured binding and current closure. No await or queue step intervenes before calling the underlying transport.
Prepared payloads, callbacks and fetch/publish tasks retain their originating gate. A stale task never fetches the newest peer's gate.
On revocation, old peers stop source work and report replacement/displacement to their owner. Reconstruct under fresh admission when lawful.
Proven rollback can admit a fresh peer/gate. It cannot reopen the previous peer's gate.

**Path-to-gate map:**

| Transport path | Boundary |
| --- | --- |
| peer guardedHub fetchTopic/publish, `peer.ts:475` | `sourceWire.assertInvocation()` immediately before Reflect.apply |
| hub-mux subscription readiness/deferred publish/fetch | Carry originating gate through waits; final host call checks it |
| durable publication/control/rendezvous/recovery fetch/publish | Route through the same guardedHub, preserving bound prepared result |
| peer-epoch.ts:267,446 segment/reply; directed.ts:595 sealReply | Captured gate accompanies sealed payload to final mux invocation |
| MLSEncryptor.trackPublish | Captured encryptor gate checked immediately before actual mailbox hub.publish |
| cleanup and retired obligation delivery | Distinct device/host authority; never borrow a terminal source gate |

Only actual initiation is fenced. A call submitted before closure may settle; no result may trigger another protected call without admission.
A host transport that internally defers invocation must preserve the gate to its actual invocation boundary. Document that port obligation.
No network await retains source ownership. No storage/completion operation requires a wire gate.

Add disposal checks before/after wrap and at each directed-reply anchor retry in `peer-epoch.ts:422`.
Anchor movement plus disposal must terminate promptly instead of starting another wrap. Preserve per-epoch topic/anchor consistency.

- [ ] **Step 1: Add failing actual-boundary tests.**

| Test | Required assertions |
| --- | --- |
| `deferred wire refuses before terminal proof` | Queue while live, pause immediately before transport invocation; close/commit terminal with proof delayed; fetch/publish invocation counters stay unchanged |
| `old wire gate stays revoked after rollback and readmission` | Fresh admitted transport succeeds; old gate/payload/task refuses after rollback, switch and Welcome |
| `submitted transport can settle without authorising follow-up` | Pre-close call settles; continuation cannot fetch/publish or invoke crypto under old binding |
| `tunnel publish checks binding after sealing` | Removal/switch between seal and actual mailbox publish yields zero new transport calls |
| `directed reply disposal ends anchor-change retries` | Move anchor during wrap, dispose before resume; no next wrap or publish; promise settles PeerDisposedError |
| `wire delay does not hold group ownership` | Ordinary group/completion work proceeds while transport response remains paused |

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/rpc test/source-wire.test.ts test/peer-epoch.test.ts`. Expected: generation/provisional/disposal assertions fail.
- [ ] **Step 3: Implement gate port and migrate every factory/double.** Start from guardedHub and trace all actual fetch/publish sites.
  Close shared cells synchronously from T4a's pre-submission closing protocol, rather than removal observation.
  Preserve existing removal checks as assertions/scheduling shortcuts during migration. They are no longer the admission mechanism.
- [ ] **Step 4: Verify.** Run focused GREEN, rpc/mls-rpc/hub-tunnel unit+types, full `kintegration`, `ktypes`, `kcontracts`. Expected: all pass, zero cached repo types.
- [ ] **Step 5: Mutation-check wire guards.** Move check to enqueue, drop generation, close only after proof, or omit tunnel/disposal enforcement.
  Require actual invocation/next-wrap assertion RED, then restored GREEN. Already-submitted-call control remains legal.
- [ ] **Step 6: Commit.** Commit `feat(rpc): bind actual transport invocation to revocable source admission`.

### Task 10: Replace landed 2.3d admission while preserving terminal-first completion

**Depends on:** T9. This is an explicit migration of shipped behaviour, not another admission sweep.

**Files:**

- Modify `packages/rpc/src/{peer,app-lane}.ts` and `packages/mls-rpc/src/{terminal-admission,handler-completion}.ts`.
- Modify private terminal preparation/coordinator integration in `packages/mls-rpc/src/registry/{access,source-control-commands,source-executor}.ts`.
- Extend mls-rpc `test/{terminal-admission,opened-delivery,handler-batching-conformance}.test.ts`.
- Extend `packages/rpc/test/{peer-removed-blind,peer-startup-order,peer-control-settlement}.test.ts`.
- Extend `tests/integration/test/terminal-drain.test.ts` with delayed-proof/source-boundary assertions.

**Interfaces:**

Consumes the T4a closing protocol, T6 terminal adoption command, T9 `SourceWireGate`, and existing `HandlerCompletion<TTx>`.
Produces no new public port. Preserve `completion`, `recoveryCompletion`, `drainOpened(): Promise<void>` and their current exact contracts.
`assertNotTerminal(access: {admission(): SendAdmission}): void` remains an assertion helper during migration.
Its comment must no longer delegate correctness to rechecking after the last await.

**Old-mechanism-to-new-authority map:**

| Existing site | Migration |
| --- | --- |
| `removalCommitted()` port/crypto/transport choke points in peer.ts | Managed private work enters executor; actual transport uses captured wire gate |
| `terminal-admission.ts`, recovery/control `assertNotTerminal` repeats | Keep assertions/fast failure while executor ownership and primitive revocation enforce safety |
| terminal removal apply with no epoch advance | Prepare frozen applied/control/state mutation; close before submission; prove commit before observation |
| recovery request release | Memory/private-key retirement only, legal after terminal; grants no source authority |
| peer.ts:815,6081,6101,6221,6252,6338 pending restore/drain/default handlers | Completion authority, sealed pending/cursor storage, no MLS restore or transport |
| transactional HandlerCompletion | Existing entry-bound completion and coverage; host effect/pending/cursor co-commit |
| terminal clearing, certified settlement, old outbox failures | Storage-only transition after all owed handlers/completions drain; no timeout erasure |
| startup O2 branch, current peer.ts:6220 | Delete dead inner restorePending branch; retain effective finally drain at :6337 |

Completion authority does not bypass unresolved proof. Unknown terminal outcome may keep the owner forever and delay queued completion.
Do not release ownership on timeout or start workers as a substitute for awaiting their completion transactions.
Retained handlers, including plain functions, still require atomic `crypto.pending`. Frame-less retained events reject.
Live/cold/retired delivery shares canonical key-bound completion and the same openedDeliveryContext.

- [ ] **Step 1: Add failing migration witnesses.**

| Test | Required assertions |
| --- | --- |
| `terminal commits before saved handlers drain without new source effects` | Handler deliberately paused; terminal/applied/control commit first; source/wire counters stay zero; clearing waits |
| `delayed terminal proof closes source before observers know removal` | Backend commits while observation/proof paused; precreated crypto/control/recovery/tunnel references initiate nothing |
| `saved plaintext completion survives terminal and unreadable MLS state` | At-rest codec positive; default handler and transactional completion succeed; no source restorer/fetch/publish |
| `terminal restart drains once through canonical completion` | Reconstruct pending/coverage, complete with original idempotency key and epoch; no duplicate host effect/cursor loss |
| `failed completion retains plaintext and blocks clearing` | Handler/transaction failure leaves pending and owed work; dispose/timeout cannot erase it |

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-rpc test/terminal-admission.test.ts test/opened-delivery.test.ts` and `kfocus @kumiai/rpc test/peer-removed-blind.test.ts test/peer-startup-order.test.ts test/peer-control-settlement.test.ts`. Expected: any remaining caller-managed bypass fails its boundary assertion.
- [ ] **Step 3: Migrate choke points and O2.** Trace removal through prepare, submit, outcome, proof, observation, drain and clearing.
  Retain guards as assertions until command/wire coverage is verified. Remove raw bypasses, not canonical completion or stored terminal semantics.
  Resolve O2 in the touched startup block. Preserve the effective finally path and add restart proof coverage.
- [ ] **Step 4: Verify.** Run focused GREEN, rpc/mls-rpc unit+types, full `kintegration`, `kcontracts`. Run `ktypes` if public types changed. Expected: all pass.
- [ ] **Step 5: Mutation-check migrated guarantees.** Move closure after proof, let peer call raw crypto, gate completion on source admission, or clear pending before drain.
  Each must fail a named assertion. Restore GREEN before commit.
- [ ] **Step 6: Commit.** Commit `refactor(rpc): enforce terminal-first removal through executor and wire authority`.

### Task 11: Install Welcomes with destination authority and atomic device-wide exclusion

**Depends on:** T10. This starts lane A after the serial migration spine.

**Files:**

- Modify `packages/mls-rpc/src/registry/{seed,registry}.ts`, `packages/mls-rpc/src/{memory-package-stores,persistence-errors}.ts`. Registry edits wire seed construction only.
- Modify `packages/rpc-conformance/src/{registry-fixture,registry}.ts` for independent history/refusal contracts and assertions.
- Modify mls-rpc fixtures `{registry,registry-welcome,device-packages}.ts` and tests `{registry-seed,registry-fixture,registry-welcome-wire,registry-reserve,send-denial-sources,registry-safety-admission,checkpoint-installation}.test.ts`.
- Create `packages/mls-rpc/test/registry-welcome-burn.test.ts`.
- Migrate integration `{welcome-after-crash,peer-readmission,fork-halt,group-conditions}.test.ts` and every affected non-genesis seed/history caller.

**Interfaces:**

Consumes validated packages, T3 `runCombined`, T4 destination and T4a closing authority and T8 data-only access.
Preserves `seed(group: GroupHandle, params: {replace?: boolean; packageUse: PackageUse | null}): Promise<GroupKey>`.
Transfer the host-owned Welcome input into destination installation; return no managed handle.
createRegistrySeed receives device:DevicePersistence<TTx> and packages:DevicePackageAdapters.
Its result stays `{key:GroupKey;reservation:Reservation|null}`.
Register `welcome.install: SourceCommand<{candidate: GroupHandle; replace: boolean; packageUse: PackageUse | null}, GroupKey>` as a destination/Combined command.
Destination admission revalidates the next key under D/G independently of source admission.
Genesis uses destination policy with G only. Absent replace means false.

Produces independent conformance history contract and local implementation mirror:

```ts
type ConformanceWelcomeCandidate = 'exact' | 'alternate' | 'restored' | 'newer' | 'unusedOlder'
type ConformanceWelcomeHistory<THandle> = Record<ConformanceWelcomeCandidate, THandle> & {
  packageUses: Record<ConformanceWelcomeCandidate, ConformancePackageUse>
}
// welcomeHistory(kind: ConformancePackageUse['kind']): Promise<ConformanceWelcomeHistory<THandle>>
```

Ordinary candidates get independent refs except restored, which shares exact's ref/authenticator. Last-resort candidates share one reusable ref.
Migrate the shared assertions and all callers from `history.packageUse` to `history.packageUses[candidate]` in this task.
Extend independent seed refusal types with `package-consumed` alongside production `SeedAdmissionRefusedError`.

**Installation route map:**

| Path | Authority and work |
| --- | --- |
| registry/seed.ts:203 before candidate capture/relinquish/restore | Device lifecycle first; explicit destination command, not old source admission |
| genesis | Absent lifetime, epoch zero, null packageUse; group-only installation |
| successor.ts:29 and seed.ts:165 openSuccessorTombstone | Storage-only hold inspection; grants no source authority |
| ordinary/last-resort Welcome | D then G Combined prepare; candidate validation, spent/admission checks before work |
| replacing live/terminal incarnation | Drain outside owners, freeze old transition, close old binding before submission; never restore old terminal state |
| spent/receipt/alreadyJoined refusal | No install/burn/reservation/cleanup; receipt never proves group membership |
| proven rollback retry | Fresh destination admission and all frozen-data/package/source guards revalidated |

Ordinary row and receipt IDs become `JSON.stringify(['ordinary', ref])`, independent of sourceID within their separate sealed device namespaces.
Canonical package value: `{ref: string; sourceIDs: Array<string>; record: KeyPackageRecord | null}`.
Identical alias puts coalesce sorted unique source IDs. Conflicting material refuses.
Every alias, including newly registered C after reconstruction, checks the canonical receipt before put/consume.
Consume removes private material and writes winning `{ref, sourceID, groupID}` receipt. All receipt lookups report that groupID.
Keep standalone deleted-ref consumption and same-group idempotence. Combined installation requires the private record to exist.
Last-resort consume remains reusable. Group spent authenticators prevent its replay.

In the same transaction, write installation/trust/spent/reservation, ordinary burn/receipt and cleanup:

```ts
const row: HubCleanupRow = {
  ...packageUse,
  id: JSON.stringify(['welcome-cleanup', device.ownerDID, packageUse.sourceID, packageUse.ref]),
  ownerDID: device.ownerDID,
  groupID: key.groupID,
  notAfter: ordinaryRecord.notAfter,
}
```

No post-install consume/joinRef carries exclusion. Retain D/G through two-marker proof; publish no success/hooks/destination earlier.

- [ ] **Step 1: Add failing registry installation/history tests.**

| Test | Required assertions |
| --- | --- |
| `source aliases cannot install one ordinary ref into two groups` | Actual A/B cross-group Welcomes race/sequentially install once; one receipt/cleanup; alias lookups agree; loser has no rows |
| `ambiguous Welcome fences competitors until both-owner proof` | Late commit gives one winner; late rollback admits competitor; no early result/hook or lock release |
| `Welcome write failure burns nothing` | Mid-write/pre-commit failure preserves exact group/device pre-state; proven rollback retry installs |
| `retired winner cannot reprovision through another source` | Retire/delete/reconstruct, add C; C.put(original) refuses; A/B/C receipts agree; ordinary private material cannot resurrect |
| `ordinary history keeps distinct package uses across installations` | exact n=1; newer refused without replace stays unburnt; replace n=2; unusedOlder alreadyJoined unburnt; after delete unusedOlder n=3 |
| `last resort installs distinct unspent groups without receipts` | Reusable private key remains; exact/alternate spent authenticators refuse before epoch comparison |
| `fresh invitation readmits without restoring terminal source` | Damaged old state, no independent hold/restoreWork; fresh Welcome installs n+1; source restore zero; destination primitive positive |
| `Welcome cannot revive retained source references` | Old access/clone/result/gate remains refused; new admitted destination command and transport succeed |
| `warmed seal and Combined Welcome obey device-before-group rules` | G-owning crypto callback cannot request D; once it settles, Welcome and ready control/completion progress |

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-rpc test/registry-welcome-burn.test.ts test/registry-seed.test.ts test/registry-fixture.test.ts`. Expected: duplicate burn/history/authority assertions fail.
- [ ] **Step 3: Implement Combined destination install and migrate fixtures.** Prepare under retained D/G outside the provider transaction.
  Revalidate device revision, source identity/version, spent/hold/admission and canonical package presence in work.
  Preserve fork/successor/restore restrictions. A fresh invitation never clears declared restorePending.
- [ ] **Step 4: Verify.** Run focused GREEN, mls-rpc/mls-hub unit+types, full `kintegration`, `ktypes`, `kcontracts`. Expected: all pass, zero cached repo types.
- [ ] **Step 5: Mutation-check burn and destination authority.** Reintroduce source-scoped keys, move consume after install, ignore C receipts or reuse exact's ordinary ref.
  Also restore old source state or revive its binding during readmission. Require behavioural RED and restored GREEN.
- [ ] **Step 6: Commit.** Commit `feat(mls-rpc): burn ordinary packages in Combined Welcome installation`.

### Task 12: Retry device cleanup without retaining ownership across network

**Depends on:** T10. Lane B owns only its three new files.

**Files:**

- Create `packages/mls-rpc/src/device-cleanup.ts`.
- Create `packages/mls-rpc/test/device-cleanup.test.ts`, `packages/mls-rpc/test/fixtures/device-cleanup.ts`.
- T15a owns production lifecycle wiring, preserving this lane's file separation.

**Interfaces:**

Consumes validated adapters, T3 device Read and the device lifecycle policy. Cleanup has no group source binding.
Produces internal service:

```ts
function createDeviceCleanup<TTx extends GroupTransaction>(params: {
  persistence: DevicePersistence<TTx>
  packages: DevicePackageAdapters
  signal: AbortSignal
  assertDeviceNetwork(): void
}): { runOnce(): Promise<void>; kick(): void; stop(): Promise<void> }
```

**Route map:** runOnce/kick/timer -> device Read/copy/release -> synchronous device-network admission -> adapter cleanup outside owners -> device-only guarded row removal.
One pass per coordinator/device runs at once. Kicks coalesce. Stop cancels timers and awaits already-started calls outside ownership.
No callback waits on a device slot held by this worker.

Delete only after confirmed removed/expired or `Date.now() >= notAfter * 1000`.
NotAfter uses seconds. Retry uses in-memory milliseconds: 1000 doubling to 60000. Restart may retry immediately.
Retry/throw retains debt. Unsupported parks debt until expiry/restart. Do not invent hub revocation support or a durable retry-timer schema.
Before deletion, re-read and compare the exact row. Never recreate keys or remove permanent receipts.
Cleanup failure never changes group safety, admission or Welcome success.

- [ ] **Step 1: Add named cleanup tests using fake time and ordinary runOnce/kick/stop.**

| Test | Required assertions |
| --- | --- |
| `cleanup retry and throws retain debt with capped backoff` | Retry/throw keeps exact row; delays equal 1000,2000,4000,8000,16000,32000,60000,60000 ms; at delay-1 no invocation, at delay one invocation; restart may invoke immediately |
| `cleanup removes only confirmed removed or expired rows` | Each result removes exact debt once; retry/throw changes no row; permanent receipt/key/group safety/admission unchanged |
| `cleanup expiry uses seconds at the exact boundary` | At notAfter*1000-1 debt remains; at notAfter*1000 expiry removes it without adapter invocation; receipt remains |
| `unsupported cleanup parks until expiry or reconstruction` | One unsupported invocation; repeated kicks/timer advances before expiry cause zero more adapter calls; row stays; restart retries once; expiry removes debt |
| `concurrent cleanup kicks coalesce per device` | Pause adapter; many kicks/runOnce calls yield max active passes=1 and one invocation per selected row |
| `cleanup completion cannot delete a replaced row` | Pause after copied read; replace any row field; removed reply deletes nothing; new row remains byte-for-byte; next fresh pass may remove it |
| `cleanup stop cancels timers and joins started calls` | Stop clears pending retries; aborted pass initiates no next adapter/deletion; stop stays pending until started adapter settles; no later timer callback invokes adapter |
| `device network refusal precedes cleanup adapter invocation` | Declared/disposed/aborted device: adapter calls=0, rows unchanged; independent live device invokes once |
| `cleanup survives source retirement and reconstruction` | Proven debt remains addressable with source retired/deleted; worker succeeds without joinRef/private restore/group source access |
| `cleanup adapter wait releases device ownership` | Pause adapter; flushReady completes same-device root provisioning and canonical row exists while adapterReturned=false; separate group B also commits |

`flushReady(): Promise<void>` drains runnable storage/codec work without awaiting paused adapters or blocked owners.
Release pauses in finally. Assert counters/progress at milestones, not timeouts.
- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-rpc test/device-cleanup.test.ts`. Expected: missing service/behaviour assertions fail.
- [ ] **Step 3: Implement storage/network/storage sequence.** Use defensive row copies, cancellation checks and exact-row deletion. Device lifecycle admission precedes each actual adapter invocation.
- [ ] **Step 4: Verify.** Run focused GREEN, mls-rpc unit+types and full `kintegration`. Expected: all pass. Public/port changes additionally require `ktypes`/`kcontracts`.
- [ ] **Step 5: Mutation-check cleanup.** Hold D across adapter await: provisioning assertion must report false at flushReady, not merely timeout.
  Also mutate unsupported removal, retry delays, expiry units/comparison, stale-row equality, cancellation and admission separately.
  Each must fail its corresponding named assertion. Restore GREEN and release adapters in finally.
- [ ] **Step 6: Commit.** Commit `feat(mls-rpc): retry device package cleanup outside owner slots`.

### Task 13: Quarantine restored groups and fail all restored outbox entries atomically

**Depends on:** T10. Lane C owns private coordinator/storage changes and dedicated tests.

**Files:**

- Create `packages/mls-rpc/src/restore-quarantine.ts`, `packages/mls-rpc/test/restore-quarantine.test.ts`, `packages/mls-rpc/test/fixtures/restore-quarantine.ts`.
- Modify `packages/mls-rpc/src/{device-entry-capability,memory-device-persistence,memory-group-persistence,memory-incarnation-stores}.ts`.
- Extend `packages/rpc-conformance/src/device-storage.ts` for portable storage assertions only.

**Interfaces:**

Consumes T3 device capability and existing sealed restore/outbox/status stores.
Produces private capability method and registry-facing wrapper:

```ts
// DeviceEntryCapability<TTx>.quarantineRestoredGroup(
//   request: {workID: string; groupID: string},
// ): Promise<void>
function quarantineRestoredGroup<TTx extends GroupTransaction>(params: {
  persistence: DevicePersistence<TTx>; workID: string; groupID: string
}): Promise<void>
```

**Path/authority map:** quarantine wrapper -> registered device capability -> Combined D/G -> durable work-ID/list validation -> private restore writer.
It is storage-only declared authority, never a source command or a caller-supplied permission boolean.
Normal certified finalisation/removal/clear guards remain unchanged.

One transaction validates work ID and group membership in remainingGroups, sets lifetime.restorePending and visits every incarnation through latestIncarnation.
For **every** restored entry, including certified/retired/terminal debt, remove entry/settlement and co-write:

```ts
const event: AppStatusEvent = {
  ...key,
  id: JSON.stringify(['database-restored', workID, key.groupID, key.incarnation, saved.seq]),
  kind: 'failed',
  reason: 'database-restored',
  entry: { ...saved, status: 'failed' },
}
```

Preserve seq/protocol/prc/data/lastAttempt exactly. Emit no published/removed companion event.
Preserve unacked events, pending plaintext, control outcomes, independent Welcome obligations, checkpoints, trust/spent and safety history.
Already held groups with no outbox entries are no-ops, even after status acknowledgement.
Do not alter restoreWork stage or its full phase-4 group list.
Administrative metadata accounting never opens/restores private state or fabricates an installed identity.

- [ ] **Step 1: Add failing authority/event witnesses.**

| Test | Required assertions |
| --- | --- |
| `declared restore atomically fails certified and unproven entries` | Multiple groups/incarnations; exact failure data/IDs; hold and all removals co-commit |
| `restore quarantine requires no readable MLS state` | Corrupt/null/malformed private bytes do not block; source restore/decrypt/network zero; required outbox/work decode failure rolls back |
| `forged restore events cannot authorise certified deletion` | No declaration/wrong ID/unlisted group refuses; ordinary meta.putEvents cannot grant private deletion authority |
| `restore proof exposes hold failure events and removal together` | Mid-write fault/late rollback unchanged; late commit visible once after both markers; no early notifications |
| `acknowledged restore events never regenerate` | Reconstruct/retry/ack then repeat produces no duplicate event/effect; work list remains full |
| `quarantine fails certified debt while canonical plaintext completion survives` | Pending plaintext remains, canonical completion succeeds after proof, source boundaries untouched |

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-rpc test/restore-quarantine.test.ts`. Expected: certified-removal or missing-private-authority assertions fail.
- [ ] **Step 3: Implement private restore mode.** Validate durable work inside Combined and bind writer to entry/attempt.
  Validate allowed namespace diff after effects. Co-write transactional status effects. Ordinary public events and copied transaction fields grant no authority.
  Update metadata versions once and preserve unreadable bytes. Defer status notification until proven outcome.
- [ ] **Step 4: Verify.** Run focused GREEN, mls-rpc unit+types, full `kintegration`, `kcontracts`; `ktypes` if public types changed. Expected: all pass.
- [ ] **Step 5: Mutation-check restore authority.** Omit certified entries, omit work-ID validation, globally weaken certified removal, or open private state administratively.
  Each must fail its named assertion. Restore GREEN.
- [ ] **Step 6: Commit.** Commit `feat(mls-rpc): quarantine restored groups with atomic failure events`.

### Task 14: Declare backup restore and replace the shared lifecycle policy

**Depends on:** T11 and T13. T12 remains independent until T15a wiring.

**Files:**

- Create `packages/mls-rpc/src/registry/restore.ts`, `packages/mls-rpc/test/registry-restore.test.ts`.
- Modify `packages/mls-rpc/src/registry/{registry,types,source-executor}.ts` to install device policy.
- Modify `packages/rpc-conformance/src/{registry-fixture,registry}.ts` for independent declaration/restore mirrors and assertions.
- Extend executor/checkpoint/recovery/wire fixture policy tests and declaration callers in integration.
- No second routing migration belongs here. Any bypass discovered here is repaired at its owning command/delegate in-task.

**Interfaces:**

Consumes `DeviceLifecycle`, `quarantineRestoredGroup`, validated participants and existing durable RestoreWork.
Produces public `GroupHandleRegistry.declareRestoredFromBackup(): Promise<void>` and independent ConformanceRegistry mirror.
Produces private service:

```ts
function createRegistryRestore<TTx extends GroupTransaction>(params: {
  persistence: DevicePersistence<TTx>
}): { declare(): Promise<void>; resumeQuarantine(): Promise<void> }
```

**Policy/route map:**

| Route class | Shared lifecycle behaviour |
| --- | --- |
| executor source/recovery/destination admission, including checkpoint signer | `beforeUse()` synchronously claims device use, then resolves startup/restore outside G |
| actual source wire or device cleanup adapter | Captured gate/device policy synchronously refuses declaring/restored/disposed state |
| seed/direct switch/replay/factory/maintenance/timers | Already delegates to corresponding executor/gate; no call-site recheck additions |
| declaration/quarantine/storage inspection/acks | Storage authority; does not claim source use or recursively call startup |
| saved plaintext/drain/HandlerCompletion | Completion authority stays legal, subject to existing proof ownership |
| public-only verification | Public-data path remains legal; grants no source/recovery/network authority |

Use per-device pristine/declaring/starting/started/disposed policy, shared by precreated ports and all registry-managed paths.
Reserve declaring synchronously. Concurrent start waits. Source-use-first makes late declaration throw TypeError before any write.
Declaration-first closes any unadmitted references before asynchronous persistence can run.
One device-only transition records random work ID, stage invalidate, and sorted unique groups.list IDs.
Repeated declarations join that work/proof. Ambiguous declaration never starts workers or publishes unproven lifecycle facts.

Startup resumes early quarantine for every listed group before certified finalisers, cleanup, peers, rotation or recovery network work.
Then Q1=A rejects restore-pending. Retain stage/full list across retry, acknowledgement and reconstruction.
No package invalidation/rotation, upload retirement or revocation stage runs here. No phase-2 path clears the declaration/holds.
Group restorePending without device work still refuses protected commands, including a checkpoint port created before that hold.
Only future proven package completion plus fresh-leaf resync can release restored source use.

- [ ] **Step 1: Add failing declaration/isolation tests.**

| Test | Required assertions |
| --- | --- |
| `declaration wins before every managed authority acquisition` | Declare-first blocks source/recovery/destination/signing before G/private work; source-first rejects declaration before writes |
| `declaration proof publishes one durable work record` | Concurrent calls share ID/list; late commit/rollback/proof preserve outcome semantics and no early worker start |
| `startup quarantine precedes certified finalisation` | Both debt classes fail database-restored with original data; publish/reseal/cleanup/rotation/peer-factory counters zero |
| `reconstruction resumes quarantine without completing package stages` | Interrupt before/between groups; stable IDs and full invalidate list persist; ordinary/last-resort keys remain untouched |
| `precreated checkpoint debt cannot sign through declaration` | Before/between/after quarantine and reopened: suite/sign/source-G counters zero; live control signs |
| `group restore hold applies after prior startup` | restoreWork null, lifetime.restorePending true; protected signing/export/restore refuse independently of device declaration |
| `quarantine preserves storage inspection and plaintext completion` | Facts/export/ack/refresh, safety/report/status and HandlerCompletion work with at-rest codec positive and private/network zero |
| `one restored device cannot quarantine another` | Separate provider/device B starts/seeds/crypto/transports positively while A remains held, including reconstruction |

- [ ] **Step 2: Run RED.** Run `kfocus @kumiai/mls-rpc test/registry-restore.test.ts test/source-executor.test.ts`. Expected: declaration/startup/policy assertions fail.
- [ ] **Step 3: Install the lifecycle policy and migrate callers.** Change one policy shared by executor/gates, not 54 guards.
  Keep beforeUse outside owners. Preserve T7b recovery resolution/replay and T11 destination admission semantics.
  Storage completion must not invoke startup. Q1=A retains refusal rather than pretending deferred package stages completed.
- [ ] **Step 4: Verify.** Run focused GREEN, mls-rpc/rpc unit+types, full `kintegration`, `ktypes`, `kcontracts`. Expected: all pass, zero cached repo types.
- [ ] **Step 5: Mutation-check shared policy.** Start finalisers first, erase work/full list, omit a group, ignore group-only hold or share policy process-globally.
  Also bypass one precreated signer/wire delegate. Require owning assertion RED and restored GREEN, including device-B positive control.
- [ ] **Step 6: Commit.** Commit `feat(mls-rpc): declare backup restore through shared lifecycle admission`.

### Task 15: Publish primitive-boundary source-authority conformance

**Depends on:** T11-T14. All production enforcement exists before this assembly task.

**Files:**

- Create `packages/rpc-conformance/src/source-authority.ts`, `packages/mls-rpc/test/source-authority-conformance.test.ts`.
- Modify `packages/rpc-conformance/src/{persistence-fixture,registry-fixture,index}.ts` for independent boundary contracts.
- Modify `packages/mls-rpc/test/fixtures/{registry,source-executor}.ts` and rpc doubles where ordinary-adapter source witnesses need support.

**Interfaces:**

Consumes executor/wire/Welcome/completion/restore contracts. Produces independent witnesses, without new provider or host lifecycle APIs:

```ts
type ConformanceSourceBoundary =
  | 'private-restore' | 'open' | 'seal' | 'sign' | 'export' | 'derive' | 'fetch' | 'publish'
type ConformanceBoundaryPause = { entered: Promise<void>; release(): void }
type ConformanceRetainedKind = 'access' | 'clone' | 'prepared' | 'wire' | 'callback' | 'exporter'
type ConformanceSourceWitness = {
  pauseNext(boundary: ConformanceSourceBoundary): ConformanceBoundaryPause
  counts(): Record<ConformanceSourceBoundary, number>
  resetCounts(): void
  flushReady(): Promise<void>
  invoke(alias: string): Promise<void>
  retain(kind: ConformanceRetainedKind): Promise<{ invoke(): Promise<void> }>
  remove(): Promise<void>
  failStop(): Promise<void>
  switchIncarnation(): Promise<ConformanceGroupKey>
  readmitWelcome(): Promise<ConformanceGroupKey>
  damageState(): Promise<void>
  completeSavedPlaintext(): Promise<void>
}
// ConformanceSourceAuthorityFixture<THandle> extends ConformanceRegistryFixture<THandle>:
//   witness: ConformanceSourceWitness
//   reopen(): Promise<ConformanceSourceAuthorityFixture<THandle>>
function testSourceAuthorityConformance<THandle>(params: {
  name: string
  createFixture(options: {
    groupID: string; ownershipContext: boolean
  }): Promise<ConformanceSourceAuthorityFixture<THandle>>
}): void

```

`invoke(alias)` uses ordinary adapters below. Unknown aliases reject.

| Alias group | Delegate |
| --- | --- |
| seed, access, cachedRead, cachedControl, switch, switchReplay, peerStart | Registry destination/source commands and fresh peer admission |
| seal, receive, openBatch, streamingOpen, publication, publicationSnapshot, maintenance, accounting, handoff, committedSender | T5 app/crypto commands, with private-only sender diagnostics |
| wrap, unwrap, unwrapBatch, sealEntries, openEntries, exportSecret, tunnelEncrypt, tunnelDecrypt, tunnelPublish | T5 byte commands and T9 actual wire |
| createInvite, prepareBuild, validationHeader, validationVerifyOwn, adopt, processCommit, readCommitHeader, validateRecoveryCommit, rotation, revoke | T6/T6a control commands |
| recoveryRequest, recoverySign, recoveryExport, inspectCapture, rosterAbsence, openVerdict, buildCandidate, restoreCandidate, candidateKey, candidateSerialize, candidateAccept | T7 recovery commands/facades |
| resolveSwitch, peerReplay, confirmedCallback, reconcile, forkAuthorise, forkCheck, forkSettle, validateCandidate, branchAbandonment, manualRunner, manualTarget, successor | T7-T7c recovery commands or data-only target orchestration |
| readRecoveryRecord, loadRecoveryContinuation, finishRecoveryContinuation | T7a storage-only structural validation/completion, including superseded source |
| sealGroupInfo, sealVerdict, confirmationKey, prepareRecovery, sealLedger, openLedger, bootstrapLedger, readEpoch, roster, ledger | T6/T7 commands and public projections |
| checkpointSign, checkpointCompare, checkpointIntake, checkpointInspect, checkpointAck, verifyRequest, verifyConfirmation | T8 signer or public-only verification/inspection |
| start, drainOpened, complete, status, ack, cleanup, declare, quarantine, retiredWelcome, releaseRecoveryRequest, rawHostHelpers | Startup/device/completion/storage or explicit unmanaged host boundary |

Retain attempts real capture/clone/result escape without returning private objects. Count primitive entry even on throws.
Pause fetch/publish before final gate/invocation. Use backend faults, never fabricated outcomes/refusals or admission-helper calls.
failStop triggers the real coordinator conflict path during a paused ordinary memory command.
Run real MLS/every double in both context modes; retain D8's no-port post-await diagnostic limit.
Use real seed/declare/start, pending codecs/HandlerCompletion, retained recovery trust/metadata and public verification inputs.
Cleanup drives the device worker with lifecycle/provisioning controls.

- [ ] **Step 1: Add shared r29 witnesses and positive controls.**

| Shared test | Required evidence and owner |
| --- | --- |
| `nested awaits exclude terminal and cancellation revokes continuation` | T5 primitive pauses prove G ownership; warmed path opens zero transactions |
| `fail-stop revokes suspended memory-command authority` | T5: active/queued reject before release; resume with zero primitive/progress updates; same-adapter live control |
| `memory command startup and scheduler service obey D3` | T5 first-command barrier pending/counter assertion; control+B within three batches including active A; separate ready completion precedes next A |
| `warmed seal Combined Welcome and device root obey ownership order` | T5/T11 D/G inversion refusal, cancellation, then ready terminal/control/completion service |
| `terminal commit with delayed proof blocks deferred invocation` | T9/T10 actual backend commit before proof; restore/crypto/fetch/publish deltas zero, including restart |
| `preclosure effects may settle but cannot initiate follow-up` | T4/T9 previously invoked operation settles; retained callback cannot start another primitive |
| `rollback readmits freshly without reviving retained references` | T4a live fresh admission succeeds; all six retained kinds remain refused; frozen data revalidates guards |
| `switch and Welcome isolate old references and obligations` | T7b/T11 new incarnation/gate succeeds; old refs fail; unpublished old entries fail incarnation-abandoned; no auto-reseal |
| `callback clone and private-byte containment has positive export control` | T8 read-result/capture/clone escape attempts fail; live export positive; terminal/superseded/quarantine export deltas zero; returned epoch bytes remain host-owned |
| `saved plaintext completion survives terminal source refusal` | T10 at-rest codec and canonical completion positive; inspection/acks succeed; MLS restore and transport zero |
| `damaged state recovers only with readable nonterminal admission` | T7 trust recovery positive without source state; missing/terminal/unreadable metadata refuses before primitive entry |
| `device quarantine is isolated and precedes every managed route` | T14 precreated ports/queued wire/maintenance stay closed; independent device live restore/crypto/transport positive |
| `closing mutation and rollback retry retain identity guards` | T4a/T7b/T10 authentic self-removal/switch/readmission persist frozen data; wrong mutation/version refuses; no publication before proof |
| `public verification remains legal after terminal` | T7/T8 valid public request/confirmation/GroupInfo/checkpoint verification succeeds; it grants no protected follow-up |

Require same-adapter admitted controls and both contract families. No double may be more permissive.

- [ ] **Step 2: Run assertion-RED through ordinary adapters.** Run `kfocus @kumiai/mls-rpc test/source-authority-conformance.test.ts` with a T9 gate mutation.
  Expected: actual transport counter assertion fails. Restore and obtain GREEN. Repeat central executor/containment mutations already owned by T4/T8.
  Omit T5 command fail-stop revocation; require resumed primitive/progress assertion RED, then restored GREEN.
- [ ] **Step 3: Implement independent fixtures.** Count actual restore/crypto/transport initiation, including throwing calls.
  Preserve positive controls. Never manufacture outcomes or refusals.
- [ ] **Step 4: Verify.** Run the shared wrapper, mls-rpc/rpc unit+types, full `kintegration`, `ktypes`, `kcontracts`.
  Expected: all real/double and context modes pass, zero cached repo types. Include this wrapper in future contract gates.
- [ ] **Step 5: Audit witness sensitivity.** Record every S01-S54 route's ordinary-adapter calibration and routing classification.
  Require named behavioural mutation RED/restored GREEN. Unexercised aliases remain incomplete.
- [ ] **Step 6: Commit.** Commit `test(mls-rpc): enforce primitive-boundary source authority contracts`.

### Task 15a: Assemble Welcome/restore seams, cleanup lifecycle and host handoff

**Depends on:** T12, T14 and T15.

**Files:**

- Create `packages/rpc-conformance/src/welcome-restore.ts`, `packages/mls-rpc/test/welcome-restore-conformance.test.ts`.
- Modify `packages/rpc-conformance/src/{persistence-fixture,registry-fixture,index}.ts` for independent Welcome/restore contracts.
- Modify mls-rpc fixtures `{registry,device-packages}.ts` and dedicated Welcome/restore fixtures.
- Modify `packages/mls-rpc/src/registry/registry.ts` for cleanup startup/install/disposal wiring.
- Extend `tests/integration/test/{welcome-after-crash,terminal-drain}.test.ts`; create `tests/integration/test/backup-restore.test.ts`.
- Update `packages/{mls-hub,mls-rpc}/README.md`, `docs/agents/architecture.md`, `.changeset/spec-p-storage-foundation.md`.

**Interfaces:**

Consumes settled Welcome/result/participants, T12 cleanup, T13 quarantine, T14 declaration and T15 source witness contracts.
Produces independent Welcome/restore fixture and runner:

```ts
// ConformanceWelcomeRestoreFixture<THandle> extends ConformanceRegistryFixture<THandle>:
prepareWelcomePair(kind: ConformancePackageUse['kind']): Promise<{
  first: {handle: THandle; packageUse: ConformancePackageUse}
  second: {handle: THandle; packageUse: ConformancePackageUse}
}>
seedRestoreEntries(): Promise<Array<{
  key: ConformanceGroupKey; entry: ConformanceStorageAppOutboxEntry; certified: boolean
}>>
cleanupPass(): Promise<void>
cleanupResults(results: Array<'removed' | 'expired' | 'retry' | 'unsupported'>): void
reopen(): Promise<ConformanceWelcomeRestoreFixture<THandle>>
function testWelcomeRestoreConformance<THandle>(params: {
  name: string
  createFixture(options: {groupID: string}): Promise<ConformanceWelcomeRestoreFixture<THandle>>
}): void
```

Pair preparation uses two actual groupIDs and one private package through ordinary aliases. Neither group is pre-installed.
Restore entries span two groups and multiple incarnations, including certified/unproven debt. Cleanup drives the production worker.
Mirrors import no implementation types. Both real MLS and affected doubles run all applicable contracts.

**Route map:** Welcome suite -> seed/destination/Combined. Restore suite -> declare/start/private quarantine.
Cleanup -> device Read/release/adapter/guarded removal. Completion -> actual pending codec and canonical HandlerCompletion.
Host examples -> matched participants and named managed commands, without raw handle/suite callback access.

- [ ] **Step 1: Add failing assembled seam tests.**

| Test | Required assertions |
| --- | --- |
| `accepted Welcome delivery repeats after sender reconstruction without receiver reinstall` | Pause after actual transport acceptance before sender obligation deletion; reconstruct both sides; ordinary receipt refuses before decrypt, last-resort reaches spent refusal; no lost obligation |
| `cleanup outlives retirement and releases device ownership` | Proven seed creates debt; retry/reconstruction/capable completion and unsupported-to-expiry residual; same-device provisioning progresses during adapter pause |
| `backup quarantine precedes startup publication and preserves failure data` | Certified/unproven debt plus terminal pending plaintext; interrupted/reconstructed quarantine keeps full work list and original event data; source/network counters zero; completion succeeds |
| `registry package participants share one loss boundary` | Foreign participant rejection and existing total-database-loss witness stay enforced; no decrypt of exact/alternate old Welcome with identity alone |

- [ ] **Step 2: Run behavioural RED.** Run the new wrapper with a T11 canonical-burn or T13 declaration-authority mutation.
  Expected: ordinary registry ingress fails its burn/event assertion. Fixture setup/import failures do not count. Restore mutation.
- [ ] **Step 3: Wire cleanup into production lifecycle.** Start only after normal startup/proven installation, supplying shared device-network policy.
  RestoreWork starts no cleanup/network. Dispose stops timers and awaits started adapter calls outside owners.
  Preserve device debt for replacement registries and separate host authority for retired Welcome delivery.
- [ ] **Step 4: Document in-place host migration.** Show kinded openWelcome, required matched participants, seed packageUse and device/ref-wide receipts.
  Explain data-only managed access, command-backed builders/recovery/switch refs, generation-bound wire and peer reconstruction after displacement.
  Keep GroupCrypto.exportSecret unchanged and returned epoch bytes host-owned. Explain standalone raw-key/handle boundaries.
  Document completion versus recoveryCompletion, mandatory pending storage and M4's volatile cursor without custom coverage.
  Explain declare-before-use, stable database-restored replay/ack, Q1=A startup refusal and phase-4 package/resync work.
  Record all breaking changes in `.changeset/spec-p-storage-foundation.md`. Leave versions and release files unchanged.
  Keep persistent documentation free of branch-only spec/plan links.
- [ ] **Step 5: Run final verification.** Run `kbuild`, both new conformance wrappers, rpc/mls-rpc/mls-hub/hub-tunnel unit+types, full `kintegration`, `ktypes`, `kcontracts`.
  Expected: all pass, zero cached repo types, no new skips. Include both new wrappers in contract gates.
  Run `rtk proxy pnpm run lint`; inspect its diff. Rerun only checks affected by any subsequent changes.
  Record carried timing-case results, mutation evidence and unexecuted HTTP/provider/SIGKILL/backend gates explicitly.
- [ ] **Step 6: Commit.** Commit `test(mls-rpc): assemble Welcome restore seams and host migration`.

## Serial spine, file-disjoint lanes and dispatch

The serial spine is **1 -> 2 -> 3 -> 4 -> 4a -> 5 -> 6 -> 6a -> 7 -> 7a -> 7b -> 7c -> 8 -> 9 -> 10**.
Migrations stay serial because they share executor types and registry/access/control/recovery wiring. Split ownership does not make those edits independent.

After T10, three code lanes may proceed independently:

- **Lane A / T11:** seed, canonical package stores, history contracts/assertions and Welcome fixtures/callers.
- **Lane B / T12:** only device-cleanup implementation and its dedicated test/fixture.
- **Lane C / T13:** quarantine, device-entry/coordinator/incarnation-store changes and dedicated storage tests.

These lane edit sets are disjoint, including fixtures and mirrors. T11 consumes T3's seam without editing its producer.
T14 follows T11/T13. T15 follows all lanes and T14 for source conformance. T15a then assembles cleanup, Welcome/restore seams and host documentation.
Recheck actual edit sets before parallel execution. If a migration expands into another lane, serialise before editing.
Heavy verification always runs serially under the existing machine protocol. This rewrite creates no agents or extra worktrees.

Each dispatched brief contains its complete task, exact consumed signatures, local map and used verification-helper definitions.
Revision 1 in rewrite-notes.md records the measured capsule/signature assembly. Include it without the global inventory or manifest.
Include the binding/closure, ownership/callback, completion, Q1=A and full-test constraints from this plan.
Include dependency commit IDs and a short immutable source/spec baseline. Do not append the 54-edge table as missing implementation instructions.
Measure assembled brief bytes before dispatch. Split any brief above approximately 10 KB at a meaningful tested boundary.

## Completion gates and handoff

- [ ] All twenty tasks have independently green complete migrations, with no known-red intermediate commits.
- [ ] All managed raw authority lives inside named executor handlers. No generic managed read/mutate/open callback remains.
- [ ] Every S01-S54 alias routes to a command, public/storage inspection or documented standalone host boundary, with calibrated witnesses.
- [ ] Source/wire closure precedes terminal/switch/readmission submission, including backend-commit/proof gaps and restart.
- [ ] Frozen closing data is mutation-bound. Proven rollback admits freshly and never revives old bindings/results/gates/clones.
- [ ] Memory-only commands share G and D8 diagnostics/revocation/fairness without provider transactions.
- [ ] Completion remains independent, including terminal/unreadable-state saved plaintext and no-timeout drain.
- [ ] Recovery uses independently readable metadata/trust. Welcome destination admits lawfully without old source restoration.
- [ ] Cross-source package exclusion, Combined cancellation/two-marker proof, cleanup provisioning progress and restore failure authority are demonstrated.
- [ ] Every relevant task ran **full** integration plus affected unit/types. Public changes ran forced repo types with Cached: 0.
- [ ] Both contract families ran through all applicable real/double consumers. Every new guard has behavioural mutation RED/restored GREEN.
- [ ] Q1=A remains explicit. No phase-2 claim closes package invalidation/rotation or full restored-device recovery release.
- [ ] Existing version band, generated files, scripts/configuration, source-independent obligations and merge/push/release hold remain intact.

Inventory reconciliation, retaining all 28 candidates:

| Candidates | Owner/disposition |
| --- | --- |
| E01-E04 | Retain existing loss boundary/sealing/CRUD/queues; T2/T3/T15a regression witnesses |
| E05-E10 | T1-T3/T11 participant/API/prepare/canonical burn implementation |
| E11-E15 | T11/T12/T15a actual Welcome exclusion, last-resort, cleanup and consume-seam migration |
| E16-E20 | T13/T14/T15a declaration, holds, certified failure, stable replay/ack |
| E21-E22 | T11/T14 preserve restore-release restrictions; package stages and release remain phase 4 |
| E23-E24 | Preserve trust/lease/batching/completion/publication prerequisites throughout command migration |
| E25 | T4-T10 executor construction, every managed path, wire and 2.3d migration; T14 shared policy |
| E26 | T2/T3/T7a-T7c/T8/T11/T14 independent mirrors, required metadata, candidates and histories |
| E27-E28 | T15a assembled reconstruction seams, host docs and existing changeset |

Handoff retains HTTP/buffered lift for 2.4, provider evidence for phase 3, package stages for phase 4 and SIGKILL for phase 6.
Carry forward any unresolved timing failures with exact commands and evidence. Do not label an unrun gate complete.
This drafting session verifies document structure, source locations and consistency only. It runs no package suites, implementation mutations or git writes.
