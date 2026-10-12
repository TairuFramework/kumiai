# Spec P 2.2b Registry Core and Incarnations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build registry core with validated access, real incarnation ownership, spent-first admission, proven replacement, retirement hooks, committed snapshots and retained obligations.

**Architecture:** `createGroupHandleRegistry` lives in `@kumiai/mls-rpc` over the shared D8 coordinator. Prepare reads and transactional writes belong to one owner entry. Retirement hooks run outside entries before revalidation. Peers and `createGroupMLS` keep `simpleHandleAccess`; consumer wiring moves to 2.2d.

**Tech Stack:** TypeScript, pnpm 12.10.1, Vitest, ts-mls 2.0.0-rc.13, Web Crypto, MLS v2 codecs and transactional memory persistence.

**Spec:** [Spec P transactional persistence](../specs/2026-10-08-spec-p-transactional-persistence.md), **r18**, binding. Relevant sections: D2 `:151-191`, Registry `:300-303`, D8 `:405-523`, registry interfaces `:658-801`, Welcome `:861-862`, retention `:889-915`, conformance `:1083-1114`.

Baseline: HEAD `493ac08b20f71f51c8da8f8297ce518cc9c9515a`. The inventory is evidence to verify, not an implementation contract. Reviews: `.superpowers/sdd/plan-2-2b-draft/rereview-sol.md` and `rereview-opus.md`. Rulings: `rulings.md` and earlier `revise.md` in that directory. Later N1-N4 override conflicting earlier rulings, including N4 over item 10. This revision changes only this plan. Tasks below authorise future implementation, not execution during revision.

## Global Constraints

- Use pnpm only. Prefix implementation commands with `rtk proxy`.
- Pair every Vitest invocation with package `test:types`. Rebuild sibling exports before importing changed package exports.
- Run repository-wide `test:types` after breaking type changes. Preserve meaningful existing cases.
- Run both contract families against real implementations and affected doubles. See `docs/agents/architecture.md:21-24`.
- Never edit generated `lib/` files. Add no cross-repo dependency or toolchain configuration change.
- Cross-repo dependencies use catalog published `^` ranges. Internal dependencies use `workspace:^`.
- Edit the existing fourteen-package minor release intent during implementation. Publish nothing at this gate.
- Expected null means absent lifetime, never a tombstone. Lifetime revisions and state versions remain provider-accounted.
- Enforce incarnation, epoch, authenticator, progress and spent guards independently of CAS.
- Pure reads use `Read` entries, never transitions. They advance no revision and retain no ambiguity.
- Prepare crypto outside the work transaction, under the owner slot. Use only attempt-bound prepare reads.
- Domain and side writes refuse in prepare with `PersistencePhaseError`. Root calls inside entries refuse with `ReentrantOwnershipError` when detectable.
- Ordinary handlers, retirement hooks and network I/O run outside every entry. Raw persistence roots remain available during retirement drains.
- Retry proof/barrier failures from 100 ms, doubling to 15 s. Proof retains its entry; ordinary retry orchestration releases ownership.
- Missing, deleted or invalid state exposes no fabricated handle. A diagnostic open never authorises state use.
- Source/admission identity comes from current `trust.installed`. Administrative state metadata remains version/deleted/initialIdentity.
- Spent admission precedes epoch comparison. Retained-entry proof settles seed ambiguity. Adopted-row switch replay precedes admission. Missing surviving spent sets refuse.
- Seed has the normative signature without mutationID. External resolve propagates GroupStateUncertainError after marker supersession.
- New incarnations inherit no source progress, ceilings, anchor, cursors, applied rows or responses.
- Recovery trust contains public signer-tree nodes only. Production code never uses `structuredClone`.
- Registry retention enforces `retainKeysForGenerations >= 1000` and `maximumForwardRatchetSteps >= 1000`.
- PackageUse is validated and staged here. Atomic ordinary package burn/receipt and package-row locking are 2.3.
- Run lint before each implementation commit. Mutation checks must fail at the assertion for the named rule.
- Runtime baseline: ES2022 built-ins in scoped `src`. No Node imports, async-context implementation, `structuredClone` or newer runtime-only APIs.
- Preserve `packages/mls-rpc/test/runtime-neutral.test.ts`; its recursive scan includes new source directories (`:64-71`).

## Review Focus

1. Two factories share one database: a second live registry refuses, while prepared CAS serialises writes and reads preserve revisions. Tasks 1, 8.
2. Retirement races cold load, hooks or another replacer: refusal restores access and only the winning attempt displaces ownership. Tasks 9, 15, 18, 20-21.
3. Restart follows ambiguous installation or marker supersession: seed uses retained-entry proof, external resolve may be uncertain, and adopted switch replay never reinstalls. Tasks 15, 18, 21.
4. Acceptance proves candidate A but direct adopt/replace supplies B, or a resync confirmation is ineligible: refuse before any save. Tasks 12, 17.
5. Control/effect-only commits and retired obligations: snapshots follow final accounting, every uncertified old entry fails, and Welcome release requires first-valid evidence. Tasks 10-11, 13, 19.

## Decisions (binding for executors)

| # | Decision | Boundary and reason |
| --- | --- | --- |
| R1 | Registry implementation lives in `packages/mls-rpc/src/registry/`. One live registry owns a coordinator binding. | Reject a second live factory over the same binding. Device and group wrappers share binding identity. |
| R2 | Register an internal prepare/read/write/observation capability with the shared database/coordinator binding token. | Capability registration preserves that token across separately constructed device/group wrappers. The live-registry WeakMap keys the token, never `persistence.groups`. Memory uses its shared database owner binding. Future providers register an equivalent token. Spread wrappers do not inherit registration. |
| R3 | Deliver read/readControl/mutate/ordinary replace/adopt, runtime and onRetire. | `open`, pending interception, seal/receive/openBatch, leases, packages, batch and restore-work remain 2.3. `start()` validates cold ownership only and refuses restorePending. This is a staged core API. |
| R4 USER | No `createRegistryHandleAccess`, build/adoption migration, registry consumer wiring or registry-adapter port runner in 2.2b. | Those consumers move to 2.2d with recovery rewiring. Existing peers/MLS use simple access. Direct registry tests prove this gate. |
| R5 | Require `SimpleHandleAccessParams.key`; remove its incarnation-1 default. | Preserve simple access behaviour and migrate explicit keys mechanically. |
| R6 | Explicit Welcome readmission installs fresh `latestIncarnation+1` and tombstones the active source. | `replace === true` is required. Tombstones have no active source to retire. Only the Welcome branch of carry-forward m4 is addressed. Recovery slot migration stays 2.2d. |
| R7 USER | Registry calls registered retire hooks outside entries, then rechecks and commits. | The state machine below owns the temporary fence and hold. Hosts register `async () => { await peer.dispose(); await peer.drained() }`. A fence alone proves no transport drain. |
| R8 | Switch opens the persisted sealed verdict and reuses full `createVerdictJudge`/`judgeVerdict`, including retained signer eligibility. | Match record source and candidate. Store no target/capture fields in RejoinRecord here; authenticated target propagation/storage is 2.2d. |
| R9 | Keep `judgeWelcomeAdmission` in mls-hub with the exact r18 signature/result union. | Registry maps its result to lifetime actions. Keep mls-hub tests there and avoid a dependency cycle. |
| R10 | After retire hooks drain, shared source writes fail EVERY uncertified old outbox entry before lifetime.save. | N4 overrides revise.md item 10. A prior lastAttempt grants no exemption. Persist incarnation-abandoned status/events, remove failed rows, and leave certified rows/settlements untouched. No handoff storage surface. |
| R11 | Storage-only retired service uses fixed old ports and the live first-valid Welcome gate. | No old handle or peer. Delivery is at least once, including acceptance-before-deletion crashes. |
| R12 | Shared registry conformance uses structural mirrors and real registry runners in real-MLS and independent-double modes. | Build fixtures before conformance. Extend double semantics, never cast a partial object to GroupHandle. No independent registry substitute is required. |
| R14 | Commit observation carries final accounted lifetime/metadata/trust/control/runtime inputs for every group transition. | Registry-internal public projection builds snapshots on proof. External listener dispatch occurs after owner release, FIFO, outside settlement. No new public MLS runtime helper. |
| R15 | Keep the switched source rejoin at stage adopted with all durable continuation fields. | No completion Outcome kind. Bootstrap, ordered missing-token reenact, acknowledgement and adopted-row deletion belong to 2.2d. Replay derives destination n+1 from the retained source row. |
| R16 | Compare a direct ordinary candidate with the decoded accepted journal destination before carrying progress. | Epoch/authenticator, own credential, immutable anchor and complete candidate state must match. No pre-carry progress differences are allowed. Source progress is carried only after this check. |

### Phase-2.2b ownership

This table supersedes the relevant 2.2a rows for this gate. The prior table assigned consumer adapters to 2.3 (`2026-10-11-spec-p-2-2a-commit-once.md:75`). USER moves access/build/adoption/MLS recovery consumer wiring to 2.2d. No consumer migration is implied by registry core tests.

| Spec item | Here | Elsewhere |
| --- | --- | --- |
| Prepare-phase committed reads, shared binding and CAS derivation | Task 1 | Database providers/evidence: phase 3 |
| MLS retention propagation | Task 2 | Full crypto adapters: 2.3 |
| Registry owner/configuration validation and production trust builder | Task 3 | Recovery orchestration: 2.2d |
| Model-backed handle/exporter, fixture assembly, real wire Welcome | Tasks 4-6 | No registry substitute or consumer adapter |
| Admission types and cold owner/access | Tasks 7-8 | Full startup restore-work: 2.3 |
| Retirement state machine, onRetire, hook/drain ownership | Task 9 | Actual peer hook registration: 2.2d |
| Accounted observation and internal runtime projection | Tasks 10-11 | Fork/recovery-unavailable gates: 2.2c. Leases/backup gates: 2.3 |
| Direct mutate/ordinary replace/adopt and journal-candidate binding | Task 12 | Consumer build/adoption migration and retry movement: 2.2d |
| Shared retirement writes, failure events and adopted rejoin retention | Task 13 | Existing certified settlement remains serviceable. New certification/transport adapters: 2.3 |
| Normative Welcome judgment and seed without mutationID | Tasks 14-15 | Atomic package burn/receipt, adapter-set validation, cross-group exclusion: 2.3 |
| RecoverySource, full verdict check, restricted switch and adopted replay | Tasks 16-18 | captureHead v2, source/target migration, bootstrap/reenact settlement and caller wiring: 2.2d |
| Retired worker, delete/dispose, crash/conformance | Tasks 19-21 | Adopted continuation settlement: 2.2d. Handler adapters: 2.3. Real HTTP smoke: 2.4 |
| Required simple-access key | Task 22 | Registry access/build/adopt/MLS consumer wiring: 2.2d. Lease-backed crypto: 2.3 |
| Release intent and regression gate | Task 23 | Publish only after wider Spec P delivery |

### Explicit staged signatures

The r18 signatures remain the final contract. Core conformance mirrors describe this gate's declared subset, never claim full r18 parity.

| Staged deviation | Reconciliation owner |
| --- | --- |
| Factory omits normative `packages` and `batch`; startup refuses restorePending; access omits seal/receive/openBatch/open/pending and registry omits declareRestoredFromBackup. | 2.3 adds these signatures and full conformance parity. |
| RegistryHandleAccess adds `readControl` (`stateVersion()` is already normative, spec `:668`), plus USER-required `onRetire(hook: () => Promise<void>): () => void`. | 2.2d reconciles these core extensions with consumer adapters and wires peer lifecycle registration. |
| Core switch accepts restricted RegistrySwitchWrite rather than normative AdoptionWrite (`:684-687`). | 2.2d maps normative AdoptionWrite to validated source/destination fields, then reconciles the public signature and mirrors. |
| Core replace/adopt require an ordinary accepted journal, despite replace's optional AdoptionWriteFactory type. | 2.2d supplies ordinary consumer orchestration and preserves recovery through switch only. |
| RejoinRecord retains HEAD source fields and no authenticated target/capture fields. | 2.2d migrates source/target and authenticates captureHead before production wiring. |

Seed exactly matches r18 `:681`. It adds no mutationID parameter or installation receipt. Public runtime projection stays inside mls-rpc.

### Checked HEAD premises

These references were read at HEAD. New files, signatures and fixture members below are proposed deliverables, not claims about existing APIs.

| Checked source | Consequence |
| --- | --- |
| `packages/mls-rpc/src/memory-group-persistence.ts:190-205` | Existing prepare enters work immediately. Split it before invoking crypto preparation. |
| `packages/mls-rpc/src/memory-group-state.ts:161-175` | Existing transaction binding permits work/effects reads only. Add a separate prepare snapshot binding. |
| `packages/mls-rpc/src/memory-group-state.ts:23-28`, `:376-389`, `:453-467` | Metadata has version/deleted/initialIdentity, never current epoch or readability. |
| `packages/mls-rpc/src/memory-group-persistence.ts:635-653`, `:711-740`, `:789-828` | Trust follows installations; finalise/account own version changes, including side effects. |
| `packages/mls-rpc/src/memory-group-persistence.ts:984-991` | transitionInTransaction requires an already-bound entry, not a root prepare seam. |
| `packages/mls-rpc/src/owner-queue.ts:209-212`, `:341-349`, `:457-472` | Roots refuse nesting; prepare operations exist; current commit hooks precede release. |
| `packages/mls-rpc/src/memory-device-persistence.ts:79-114` | Separate factories create distinct groups objects but share the database binding/owner queues. Singleton ownership must key that shared identity. |
| `packages/mls-rpc/src/persistence-errors.ts:1-13`, `:27-33` | Reuse canonical GroupControlUnsettledError, displacement and phase errors. |
| `packages/mls-rpc/src/recovery.ts:211-259`, `:49-71`; `packages/mls/src/recovery-verdict.ts:126-194` | Open the sealed verdict with requestKey; preserve tuple/tag checks and known-registry eligibility/floors. |
| `packages/rpc/src/control/types.ts:161-193` | RejoinRecord stores source key/epoch/authenticator/head, candidate/requestKey/verdict. It has no target/capture fields. |
| `packages/mls-rpc/src/memory-incarnation-stores.ts:208-211`, `:282-313`, `:376-416` | Source active writes must precede pointer movement; certified entries cannot change. |
| `packages/rpc/src/control/store.ts:244-277` | controlSettled includes outcomes/Welcomes; readmissionChanges settles unknown operations but does not drain publications. |
| `packages/rpc/src/control/welcome.ts:6-33`; `packages/rpc/src/peer.ts:2286-2312` | deliverObligations returns void, may throw AggregateError, and requires canDeliver. Preserve first-valid release. |
| `packages/rpc/src/peer.ts:3838-3871` | dispose then drained is the host lifecycle primitive; disposal suspends publishing. |
| `packages/mls-rpc/test/fixtures/storage-persistence.ts:122-130`, `:318-345`, `:476-490`, `:630-641` | Existing fixture pre-seeds epoch 3 with unrelated owner identity. Reopen returns ports, and ciphertext corruption does not update metadata. |
| `packages/mls-rpc/test/fixtures/sealed-memory-mls.ts:89-113`, `:136`; `packages/mls-rpc/test/fixtures/storage-seed.ts:40-64` | Existing partial double/exporter/seed cannot supply owner-matched registry/verdict fixtures unchanged. |
| `packages/mls/src/group-context.ts:33-61`; `packages/mls/src/group-handle.ts:1832`; `packages/mls/src/types.ts:13-58` | Retention option/configuration propagation must be added; derive currently rebuilds context. |
| `packages/mls-rpc/src/access.ts:40-49`; `packages/rpc/src/errors.ts:56-66`; `packages/rpc/src/crypto.ts:389-391` | Required key and widened SendAdmission also require widening SendNotAdmissibleError. |
| `packages/mls-rpc/src/memory-group-persistence.ts:267-291` | Pending resolve joins proof. Fallback resolves a matching marker and throws uncertainty after supersession. |
| `packages/mls-rpc/src/control-adoption.ts:25-26`, `:66-76`; `packages/mls-rpc/src/control-journal.ts:16-55` | Existing adoption restores the journal candidate. Direct APIs must bind their independently supplied candidate before carry. |
| `packages/rpc/src/control/rejoin.ts:180-213`, `:217-237`; `packages/rpc/src/control/types.ts:152-187` | Adopted rows preserve ledgerBefore until bootstrap emits reenact. No completion outcome exists. |

---

### Task 1: Build actual prepare-phase committed reads and prepared CAS

**Files:**
- Create: `packages/mls-rpc/src/entry-capability.ts`.
- Modify: `packages/mls-rpc/src/memory-group-persistence.ts`, `packages/mls-rpc/src/memory-group-state.ts`, `packages/mls-rpc/src/memory-device-persistence.ts`.
- Modify: `packages/rpc-conformance/src/ownership-phases.ts`, `packages/rpc-conformance/src/persistence-fixture.ts`.
- Modify fixture: `packages/mls-rpc/test/fixtures/storage-persistence.ts`.
- Test: `packages/mls-rpc/test/entry-capability.test.ts`, `packages/mls-rpc/test/ownership-phases-conformance.test.ts`.

**Interfaces:** Consumes existing GroupTransition/GroupStores and D8 OwnerEntry. Produces internal module exports only. StateMetadata is `GroupKey & {version: number; deleted: boolean; initialIdentity: EpochIdentity | null}`.

```ts
export type EntryReads = {
  lifetime(): Promise<GroupLifetime | null>
  trust(): Promise<GroupRecoveryTrust | null>
  metadata(incarnation: number): Promise<StateMetadata | null>
  state(incarnation: number): Promise<GroupStateRecord | null>
  control(incarnation: number): Promise<ControlSnapshot>
  controlMutation(incarnation: number): Promise<string | null>
  diagnoseState(incarnation: number): Promise<'missing' | 'null' | 'deleted' | 'readable' | 'unreadable'>
}
export type Prepared<T> = { expected: GroupTransition['expected']; value: T }
export type EntryCapability<TTx extends GroupTransaction> = {
  read<T>(groupID: string, fn: (reads: EntryReads) => Promise<T>): Promise<T>
  run<P, T>(request: Pick<GroupTransition, 'groupID' | 'mutationID'>,
    prepare: (reads: EntryReads) => Promise<Prepared<P>>,
    work: (stores: GroupStores<TTx>, prepared: P) => Promise<T>): Promise<T>
}
export function bindEntryCapability<TTx extends GroupTransaction>(params: { persistence: GroupPersistence<TTx>; capability: EntryCapability<TTx>; coordinatorBinding: object }): void
export function entryCapability<TTx extends GroupTransaction>(persistence: GroupPersistence<TTx>): EntryCapability<TTx> | null
export function coordinatorBinding<TTx extends GroupTransaction>(persistence: GroupPersistence<TTx>): object | null
```

Split barrier/marker preparation from enter-work. In memory, take defensive `db.snapshot()` rows after the barrier. Bind a read-only view to entry/attempt/prepare phase. Each read synchronously registers one `entry.operation`, uses unlocked codec helpers, and releases its reservation before caller code runs. No work transaction spans crypto. The coordinator never exposes mutable snapshot maps or an unbound transaction facade to callers. Future providers use short committed read transactions with the same explicit binding, never the work transaction.

Prepare views permit reads only, including independently constructed stores over their rows. Writes fail before codec/seal/row mutation. Drain admitted operations when closing prepare; expire new prepare reads at work and revoke late results on cancellation/fail-stop. Required opens remain fatal; only coordinator `diagnoseState` classifies corruption without poisoning authorised safety work. It returns status, never usable bytes. Metadata opens its own sealed row; it makes no corruption claim about unopened state.

`run` holds the group slot from prepare through work and proof. Prepare returns expected revision/activeIncarnation. Compare them at the start of work. Ordinary writes need no preliminary Read. Caller expectations are additional work-start guards, used only for explicit admission/source/adoption expectations. `read` is a Read entry and performs no domain save.

- [ ] **Step 1: Write failing tests.** `prepare has real committed reads`: phase is prepare during codec open; work transaction count is zero during suspended crypto; work starts afterwards. `fresh prepare stores refuse domain and side writes`: construct stores from the current prepare binding, attempt lifetime.save/control.apply, assert PersistencePhaseError and zero seals/changed rows. `prepare bindings expire`: captured views reject in work and after outcome; revoked delayed opens publish nothing. `prepared CAS serialises concurrent writes`: two runs return successive revisions, no spurious CAS refusal. `work refuses stale prepared expected`: return a deliberately stale expected revision while keeping state/trust valid; CAS refuses before the work callback or any save. `read preserves revisions`: repeated read/control reads preserve lifetime and state versions. `prepare waits behind committed but unsettled entry`: no callback before earlier hook/backend settlement; group B proceeds. `prepare roots refuse`: synchronous root rejects promptly; repeat after await with ownershipContext. `diagnostic does not authorise state`: corrupted bytes yield unreadable; required state read still rejects. `capability missing`: copied persistence has no binding.
- [ ] **Step 2: Run red.** Run `rtk proxy pnpm turbo run build:js build:types`, `rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types`, `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`, then `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/entry-capability.test.ts test/ownership-phases-conformance.test.ts`. Expected: missing seam/type errors, then named missing-behaviour failures after declarations.
- [ ] **Step 3: Implement the coordinator seam and fixture entry()/constructPrepareStores probes.** Extend structural mirrors without importing mls-rpc. Register each wrapper capability with the shared database/owner binding token. Separate factories must return identical coordinatorBinding tokens. Preserve normal public transition/Combined paths.
- [ ] **Step 4: Run green using Step 2 commands.** Expected: PASS. Mutation-check write permission using the fresh prepare-store test; remove CAS comparison using an explicitly stale prepared expectation test. Restore each guard and rerun.
- [ ] **Step 5: Commit.** Run `rtk proxy pnpm run lint` and `git diff --check`. Stage only Task 1 files. Commit `feat(mls-rpc): add prepare-bound reads and prepared lifetime CAS`.

### Task 2: Propagate MLS retention through every constructor

**Files:**
- Modify: `packages/mls/src/types.ts`, `packages/mls/src/group-context.ts`, `packages/mls/src/group-create.ts`, `packages/mls/src/group-welcome.ts`, `packages/mls/src/group-handle.ts`.
- Test: `packages/mls/test/key-retention.test.ts`.

**Interfaces:** Consumes existing GroupOptions and ts-mls ClientConfig. Produces `GroupOptions.keyRetention?: Partial<KeyRetentionConfig>` and internal context signatures:

```ts
export type MlsContextOptions = { keyRetention?: Partial<KeyRetentionConfig> }
export function createMlsContext(cipherSuite: MlsContext['cipherSuite'], anchor?: GroupAnchor, options?: MlsContextOptions): MlsContext
export function resolveMlsContext(options?: GroupOptions, anchor?: GroupAnchor): Promise<MlsContext>
```

Merge ts-mls defaults through its public exported default configuration components. Do not deep-import defaultClientConfig. Normal MLS defaults stay unchanged. Flow options through create, restore, Welcome, external join and derive. Derive preserves the complete effective client configuration. Existing public constructors expose the new GroupOptions field. No new package-barrel export is needed for these internal context helpers.

- [ ] **Step 1: Write failing tests.** `normal retention defaults remain unchanged`. `retention survives every construction`: create, restore, Welcome, external join and derive retain explicit generation/window values and other configuration fields.
- [ ] **Step 2: Run red.** `rtk proxy pnpm turbo run build:js build:types`; `rtk proxy pnpm --filter @kumiai/mls run test:types`; `rtk proxy pnpm --filter @kumiai/mls exec vitest run test/key-retention.test.ts`. Expected: missing option, then propagation failures.
- [ ] **Step 3: Implement internal context options and propagation.** Preserve complete configuration when deriving handles. Add no runtime-projection export.
- [ ] **Step 4: Run Step 2 green.** Expected: PASS. Run `rtk proxy pnpm turbo run test:types` after the public GroupOptions change.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `feat(mls): propagate key retention across construction paths`.

### Task 3: Validate registry ownership/configuration and build retained trust

**Files:**
- Create: `packages/mls-rpc/src/registry/validation.ts`, `packages/mls-rpc/src/registry/trust.ts`.
- Test: `packages/mls-rpc/test/registry-validation.test.ts`.

**Interfaces:** Consumes Tasks 1-2 and existing MLS codecs. OwnIdentity imports from `@kokuin/token`. RecoveryBinding imports from `src/recovery.ts`.

```ts
export type RecoveryEnvironment = { identity: OwnIdentity; options: GroupOptions; recoveryBinding?: RecoveryBinding }
export function registryOptions(options: GroupOptions): GroupOptions
export function validateRegistryHandle(params: { handle: GroupHandle; key: GroupKey; record?: GroupStateRecord; trust: GroupRecoveryTrust | null; environment: RecoveryEnvironment; ownerDID: string }): void
export function recoveryTrustFor(handle: GroupHandle, key: GroupKey, retained: GroupRecoveryTrust | null): GroupRecoveryTrust
```

Define RecoveryEnvironment in `registry/validation.ts`, then re-export its type from registry/types when Task 8 creates that module. Helpers stay internal. registryOptions supplies omitted generation/window values as 1000. It refuses explicit values below 1000 or invalid integers. Other retention fields retain configured/default values.

Registry restore rebuilds from supplied recovery options and preserves ordered ledger tokens/repeats. It installs the supplied policy/resolver/callback references. Validate those references, effective retention, suite, encoded immutable anchor, owner DID, groupID, epoch and authenticator. Cold reads compare record and current trust. Installations compare candidate context and retained trust. Factory compares normalised recovery identity with persistence.ownerDID and providerID.

recoveryTrustFor creates destination installed identity, encoded anchor, public-only tree, copied binding/credential/ordered ledger/suite and retained defensive spent set. Merge revocations/floors with candidate.registry using knownRecoveryRegistry. Empty spent is allowed only for true absent lifetime. Unreadable/missing surviving trust refuses. Reuse codecs or explicit byte/Map copies. Provider finalisation appends the installed authenticator.

- [ ] **Step 1: Write failing tests.** `registry retention defaults and floors`: omitted fields equal 1000; 999, NaN, fraction and negative refuse. `foreign owner and mismatched context refuse`: owner/provider, credential, suite, anchor, callback references and retention mismatches fail. `trust builder keeps public history`: private node fields absent; revocations/spent defensively copied; ordered ledger repeats preserved.
- [ ] **Step 2: Run red.** `rtk proxy pnpm turbo run build:js build:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-validation.test.ts test/runtime-neutral.test.ts`. Expected: missing helpers, then validation failures.
- [ ] **Step 3: Implement validation and production trust construction.** Keep dependencies unchanged. Use these helpers in cold, seed and switch tasks.
- [ ] **Step 4: Run Step 2 green.** Expected: PASS, including runtime-neutral source scan.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `feat(mls-rpc): validate registry ownership and retained trust`.

### Task 4: Model-backed GroupHandle and context-bound exporter double

**Files:**
- Modify: `packages/mls-rpc/test/fixtures/sealed-memory-mls.ts`, `packages/rpc/test/fixtures/memory-group-mls.ts`.
- Test: `packages/mls-rpc/test/registry-double.test.ts`.

**Interfaces:** Consumes Task 2 retention and the independent memory MLS model. Extend `restoreMemoryControlHandle` to accept GroupOptions and expose a genuine `GroupHandle` subclass. Preserve existing callers' defaults. Its returned handles support state/credential/context/anchor/registry/ledger, membership/binding, admission, encoding/restoration, exportSecret and carryReceiveProgress.

The superclass reads anchor extensions and folds ledger at construction (`packages/mls/src/group-handle.ts:398-432`). Supply valid anchor extensions and owner-matched credentials. Extend independent model semantics for membership, bindings, branches, encode/restore and progress ownership. Do not replace the model with production MLS behaviour or cast a partial object to GroupHandle. The exporter binds label, context and requested length. Recovery artifacts will use real signing/sealing over this independently modelled state.

- [ ] **Step 1: Write failing tests.** `double constructs a valid anchored handle`: real superclass accepts construction and membership/binding match the model. `double exporter binds context`: wrong request/position/digest contexts differ; requested lengths match. `double durable state restores independently`: ledger repeats, membership and progress survive byte-only reconstruction. `double ordinary branches differ`: two commits from one source can have different same-next-epoch authenticators. `double carry preserves committed progress without aliasing`: source mutation cannot mutate the candidate.
- [ ] **Step 2: Run red.** `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-double.test.ts`; `rtk proxy pnpm --filter @kumiai/rpc run test`. Expected: subclass/context/progress failures; existing model contracts remain meaningful.
- [ ] **Step 3: Implement the subclass and missing independent model semantics.** Remove the partial-handle cast on this path.
- [ ] **Step 4: Run Step 2 green.** Expected: PASS, including existing double contracts.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `test(mls-rpc): provide model-backed registry handle semantics`.

### Task 5: Assemble owner-matched registry fixtures, mirrors and durable faults

**Files:**
- Create: `packages/rpc-conformance/src/registry-fixture.ts`, `packages/mls-rpc/test/fixtures/registry.ts`, `packages/mls-rpc/test/fixtures/registry-welcome.ts`, `packages/mls-rpc/test/fixtures/registry-recovery.ts`.
- Modify: `packages/mls-rpc/test/fixtures/storage-persistence.ts`, `packages/mls-rpc/test/fixtures/storage-seed.ts`.
- Test: `packages/mls-rpc/test/registry-fixture.test.ts`.

**Interfaces:** Consumes Tasks 1-4 and existing fault primitives. Produces structural `ConformanceRegistryHandle`, `ConformanceRegistryAccess`, `ConformanceRegistry`, `ConformanceRegistryFixture`. Mirrors reproduce the public methods in Tasks 8/12/15/16/18/20 without importing implementation packages. Concrete handles must satisfy the exercised GroupHandle surface structurally, without an `unknown as GroupHandle` cast.

The following RegistryRowSetup/RegistryFixtureBase/PendingFault block belongs exclusively to `packages/mls-rpc/test/fixtures/registry.ts`. DevicePersistence<MemoryTransaction> and MemoryStoreRows never enter rpc-conformance. The fixture base uses existing production types only; registry-specific mirrors declare later API shapes locally. Task 8 adds the live registry and registry-preserving reopen. Export mirror types only from their module until Task 21 adds the conformance barrel export. Tasks 13/17/18 extend typed setup/proof fields when their production types arrive. No prerequisite imports a not-yet-created production module.

```ts
export type RegistryRowSetup = {
  key: GroupKey; state?: GroupStateRecord; trust?: GroupRecoveryTrust
  control?: ControlChanges; anchor?: AnchorSlot | null
  outbox?: Array<AppOutboxEntry>; events?: Array<PersistenceEvent>
  settlements?: Array<{seq: number; value: AppSettlementObligation}>
}
export type RegistryFixtureBase = {
  device: DevicePersistence<MemoryTransaction>; identity: OwnIdentity; environment: RecoveryEnvironment
  makeHandle(epoch: number): Promise<GroupHandle>
  advance(handle: GroupHandle): Promise<GroupHandle>
  welcomeHistory(kind: PackageUse['kind']): Promise<{exact: GroupHandle; alternate: GroupHandle; newer: GroupHandle; unusedOlder: GroupHandle; packageUse: PackageUse}>
  confirmedRecovery(sourceKey: GroupKey): Promise<{candidate: GroupHandle; record: RejoinRecord}>
  installRows(rows: RegistryRowSetup): Promise<void>
  inspectRows(): Promise<MemoryStoreRows>
  corruptState(key: GroupKey): Promise<void>
  removeStateBytes(key: GroupKey): Promise<void>
  corruptTrust(groupID: string): Promise<void>
  mutateMetadata(key: GroupKey, fn: (value: unknown) => unknown): Promise<void>
  holdRestore(groupID: string): {started: Promise<void>; release(): void}
  holdProof(mutationID: string): {started: Promise<void>; release(): void}
  restoreCount(groupID: string): number
  overrideRestore(fn: (record: GroupStateRecord & {deleted: false; state: Uint8Array}) => Promise<GroupHandle>): void
  onPhase(phase: 'prepare' | 'work' | 'effects' | 'finalise' | 'account' | 'proof' | 'hook', fn: () => void | Promise<void>): void
  constructPrepareStores(): GroupStores<MemoryTransaction>
  reopen(): Promise<RegistryFixtureBase>
  close(): Promise<void>
  armNextWorkFault(point: 'pending'): PendingFault & {mutationID: Promise<string>}
  armNextWorkFault(point: 'after-first-write' | 'before-commit' | 'commit-then-reject'): {mutationID: Promise<string>}
  armWorkFault(mutationID: string, point: 'pending'): PendingFault
  armWorkFault(mutationID: string, point: 'after-first-write' | 'before-commit' | 'commit-then-reject'): void
}
export type PendingFault = {rejected: Promise<void>; finish(outcome: 'commit' | 'rollback'): Promise<void>}
export function createRegistryFixture(params: {mode: 'real-mls' | 'double'; setup: 'empty' | 'seeded'; groupID: string}): Promise<RegistryFixtureBase>
```

The concrete fixture may import implementation types. Its portable mirror imports ConformanceGroupRecoveryTrust from persistence-fixture.ts and ConformanceControlSnapshot/ConformanceAdoptionExpected from control-store.ts. It uses generic handle parameters and locally mirrors staged registry methods. Parity assertions compare the final concrete RegistryFixture with ConformanceRegistryFixture<GroupHandle>. The final fixture adds `registry: GroupHandleRegistry`, and reopen returns that complete fixture. After saving the confirmed record, obtain current RecoverySource for the switch call; control writes legitimately advance version/revision. Retain the original source identity in record.source.

Bind faults to that mutation's work transaction, never its initial barrier/read. armNextWorkFault captures the next internally allocated Transition mutationID and faults only its work transaction. It supports seed without adding a public mutationID argument or a factory test option. Durable reconstruction drops queues, registry/cache, hook registrations, proof maps and handles. Retain only committed sealed rows and the owner signing identity/configuration needed to reopen them. Reopen follows backend completion; a separate wrapper restart preserves pending backend work only for first-entry barrier tests.

- [ ] **Step 1: Write failing fixture tests.** `empty fixture has no lifetime`: no implicit epoch-3/group-B rows. `fixture owner matches every credential`: cold restore can validate. `durable reopen drops runtime`: no retained cache/hook/proof object. `work fault misses prepare`: reads/barrier pass; intended installation fails. `pending work is controllable`: start operation without awaiting it, await fault.rejected, then finish and await operation. `welcome history fixture joins`: each retained Welcome processes through processWelcome to its recorded epoch/authenticator. `recovery verdict fixture is authoritative`: the fixture's confirmed verdict passes the existing createVerdictJudge as authoritative and its tampered copy is advisory.
- [ ] **Step 2: Run red.** `rtk proxy pnpm turbo run build:js build:types`; `rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-fixture.test.ts`. Expected: missing fixture, then semantic failures.
- [ ] **Step 3: Implement fixtures and structural parity checks.** Parameterise storage fixtures without changing their default suite setup. Use Task 4 model-backed handles. Assemble owner-matched Welcome history and real sealed/signed recovery verdicts in both modes. Structural mirror types remain implementation-independent.
- [ ] **Step 4: Run Step 2 green, then `rtk proxy pnpm --filter @kumiai/rpc run test`.** Expected: fixture assertions and existing double contracts PASS in both modes. Verify concrete/mirror structural parity without implementation imports in rpc-conformance.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `test(mls-rpc): add owner-matched registry and recovery fixtures`.

### Task 6: Verify the alternate wire Welcome fixture

**Files:**
- Modify: `packages/mls-rpc/test/fixtures/registry-welcome.ts`.
- Test: `packages/mls-rpc/test/registry-welcome-wire.test.ts`.

**Interfaces:** Consumes Task 5 real-MLS fixture and public MLS/ts-mls APIs. Produces `alternateWireWelcome(): Promise<{original: Uint8Array; alternate: Uint8Array; exact: GroupHandle; alternateHandle: GroupHandle}>` in the concrete Welcome fixture module. This artifact belongs only to real-MLS mode. Double conformance still restores distinct same-authenticator handles.

Installed ts-mls public declarations expose createCommit, message codecs and extraProposals/ratchetTreeExtension. Kumiai publicly exposes commitLedgerEntries and processWelcome. Build two recipient bundles and invites. Enact both role tokens with commitLedgerEntries. Use createCommit with two inline Add proposals and ratchetTreeExtension true. Set invite ledgerEntries to the enacted ledger. Encode the Welcome with encode(mlsMessageEncoder, welcome). Decode, reverse its two welcome.secrets, and re-encode. Preserve encryptedGroupInfo and each recipient ciphertext verbatim. Process both independently with processWelcome and the same retained recipient bundle. No deep imports or epoch-secret resealing.

- [ ] **Step 1: Write the failing wire test.** `alternate Welcome really joins`: exactly two recipient secrets; unequal encoded bytes; equal encryptedGroupInfo and recipient ciphertexts; both processWelcome calls succeed and joined authenticators match. Assert separate joined handles and no mutation of the retained bundle.
- [ ] **Step 2: Run red.** `rtk proxy pnpm turbo run build:js build:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-welcome-wire.test.ts`. Expected: absent fixture, then artifact assertions fail.
- [ ] **Step 3: Implement the public-API fixture.** Return both encoded artifacts and independently joined handles.
- [ ] **Step 4: Run Step 2 green.** Expected: both wire joins PASS with unequal bytes and equal authenticators. Record actual results, never infer feasibility from the double.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `test(mls-rpc): verify alternate Welcome wire representation`.

### Task 7: Widen admission and its error type together

**Files:**
- Modify: `packages/rpc/src/crypto.ts`, `packages/rpc/src/errors.ts`.
- Test: `packages/rpc/test/send-admission.test.ts`.

**Interfaces:** Produces the exact r18 SendAdmission union (`:663-665`). SendNotAdmissibleError constructor/reason getter accept the complete false-admission reason union. Existing simple callers retain their current subset.

- [ ] **Step 1: Write failing assertions.** `admission error preserves every reason`: lapsed, rotation-required, stranded, fork-halted, terminal, backup-restored and recovery-unavailable survive constructor/getter unchanged. Add type assertions for each SendAdmission variant.
- [ ] **Step 2: Run red.** `rtk proxy pnpm --filter @kumiai/rpc run test:types`; `rtk proxy pnpm --filter @kumiai/rpc exec vitest run test/send-admission.test.ts`. Expected: unsupported reason type errors, then getter failures if declarations alone change.
- [ ] **Step 3: Widen the union, constructor and getter.** Add no new runtime gate here.
- [ ] **Step 4: Run green.** `rtk proxy pnpm turbo run build:js build:types`; `rtk proxy pnpm turbo run test:types`; repeat Step 2. Expected: PASS and existing consumers compile.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `feat(rpc): expose the normative send admission reasons`.

### Task 8: Registry factory, cold access and immutable owner cache

**Files:**
- Create: `packages/mls-rpc/src/registry/types.ts`, `packages/mls-rpc/src/registry/registry.ts`, `packages/mls-rpc/src/registry/cold.ts`, `packages/mls-rpc/src/registry/access.ts`, `packages/mls-rpc/src/registry/runtime.ts`.
- Modify: `packages/mls-rpc/src/index.ts`, `packages/mls-rpc/src/persistence-errors.ts`, `packages/mls-rpc/README.md`, `packages/mls-rpc/test/fixtures/registry.ts`.
- Test: `packages/mls-rpc/test/registry-cold.test.ts`.

**Interfaces:** Consumes Tasks 1-7. Produces factory/read access. Use normative GroupRuntimeSnapshot/GroupEpochRuntime fields (spec `:661-662`). RegistryHandleAccess initially exposes key/runtime/epoch/stateVersion/admission/read/readControl/onRetire. Full implemented core shape grows in Task 12. `readControl` supplies `ControlReadScope`; refresh reuses the same Read entry and expires with its callback.

```ts
export type RegistryHandleAccess = {
  key: GroupKey; runtime: GroupEpochRuntime
  epoch(): number; stateVersion(): number; admission(): SendAdmission
  read<T>(fn: (handle: GroupHandle) => T | Promise<T>): Promise<T>
  readControl<T>(fn: (scope: ControlReadScope) => Promise<T>): Promise<T>
  onRetire(hook: () => Promise<void>): () => void
}
export function createGroupHandleRegistry<TTx extends GroupTransaction>(params: {
  persistence: DevicePersistence<TTx>; providerID: string; recovery: RecoveryEnvironment
  restore: (record: GroupStateRecord & { deleted: false; state: Uint8Array }) => Promise<GroupHandle>
  restoreCandidate: (candidate: Uint8Array) => Promise<GroupHandle> // decodes host-serialised ControlJournal.candidate
}): GroupHandleRegistry
```

GroupHandleRegistry initially has `start(): Promise<void>` and `access(groupID: string): Promise<RegistryHandleAccess>`. Tasks 15-20 add seed/source/switch/delete/dispose. Factory refuses missing entry capability and duplicate live registry over coordinatorBinding(persistence.groups). The ownership WeakMap keys that shared token. Two createMemoryDevicePersistence calls over one db have distinct groups but the same token. Refuse the second registry before any load, restore or subscription. Document this requirement in types/README for future provider registration.

Add `GroupUnavailableError extends Error` with reason: `'absent' | 'deleted' | 'state-unreadable' | 'invalid' | 'restore-pending'`. Cold Read coherently loads lifetime/metadata/trust/state/control. Validate before publishing ownership. Null bytes and failed opens never fall back to commitOnce sourceState. Missing active metadata or installed-trust mismatch is invalid, not absence. Readable state means a successful guarded open plus validation, never metadata inference.

Share one in-flight cold load per group/generation. Cache immutable validated record bytes/facts by `(GroupKey, stateVersion)`, never a mutable speculative handle. Each callback receives an isolated restoration/clone. Return defensive keys so host mutation cannot change cache ownership. Reads cannot persist mutations. Warm access rechecks active key/version in its Read; changed version invalidates cached bytes. Every handle-using operation guarded-opens the current stored state before using cached canonical bytes, even at unchanged version. A cache never bypasses null/corrupt-state refusal. Cold publication/return checks the fence generation immediately before publishing. A stale generation discards its result and retries only after active state permits another load. Invalid restores are never cached; a later call must validate again.

Initial runtime semantics are real: snapshot contains the validated installed identity/version/membership. available is true only with readable validated active state and own membership. Admission is terminal for terminal/own-removed state, stranded for persisted strand, lapsed for MLS lapse, otherwise admissible. Missing/retired runtime returns null. Task 11 replaces this initial publication path with all-commit observation.

- [ ] **Step 1: Write failing tests.** `concurrent cold access shares validation`: one restore and one access object. `key values are defensive`: mutating a returned key cannot retarget ownership. `cold absent deleted null corrupt and malformed refuse`: correct typed reasons, no fabricated handle. `invalid cold restore is never cached`: retry and actually use read; validation runs again. `cold identity uses current trust`: A3→A4 metadata.initialIdentity remains A3, source/runtime is A4. `foreign owner anchor suite options refuse`: Task 3 validator fires. `read mutates only isolated copy`: next read and stored bytes unchanged. `warm version drift reloads`: facade change invalidates cache. `two device factories one database reject second registry`: construct two devices over the same db/owner/provider, assert distinct groups and identical binding token, then second registry refuses before restore/read/observer registration. `copied unregistered wrapper refuses`.
- [ ] **Step 2: Run red.** `rtk proxy pnpm turbo run build:js build:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-cold.test.ts`. Expected: factory missing, then named failures.
- [ ] **Step 3: Implement cold ownership and core reads.** Use Task 1 Read and Task 3 validator. Expose no staged write/open interface.
- [ ] **Step 4: Run Step 2 green.** Expected: PASS in both fixture modes.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `feat(mls-rpc): add validated registry cold access`.

### Task 9: Attempt-owned retirement state machine and hooks

**Files:**
- Create: `packages/mls-rpc/src/registry/retirement.ts`.
- Modify: `packages/mls-rpc/src/registry/registry.ts`, `packages/mls-rpc/src/registry/access.ts`, `packages/mls-rpc/src/registry/cold.ts`, `packages/mls-rpc/src/registry/types.ts`, `packages/mls-rpc/src/persistence-errors.ts`, `packages/mls-rpc/src/entry-capability.ts`, `packages/mls-rpc/src/memory-group-persistence.ts`, `packages/mls-rpc/src/owner-queue.ts`, `packages/mls-rpc/test/fixtures/registry.ts`.
- Test: `packages/mls-rpc/test/registry-retirement.test.ts`.

**Interfaces:** Consumes Task 8 owner cache and Task 1 entries. Produces `beginRetirement(key: GroupKey): RetirementAttempt`; attempt has `generation: number`, `drain(): Promise<void>`, `settle(outcome: 'committed' | 'rolled-back'): void`. These are private registry methods, not persistence roots. Add coordinator `activity(groupID: string, excludingMutationID?: string): {generation: number; pending: number}` to EntryCapability. Track every Transition/Combined admission and completion, including raw facade/completion writes; reads do not advance this activity generation. Exclude the replacement mutation itself during its recheck. Add RegistryRetiringError and RegistryRetireHookError extending Error. The former identifies a temporarily retiring key; the latter retains hook rejection as cause. onRetire unregisters idempotently.

| State / trigger | Next state and behaviour |
| --- | --- |
| active → winning readmit/switch/delete attempt | retiring(attempt, generation+1). Install hold synchronously before awaiting hooks. Stop runtime owner creation/new access calls. |
| runtime call after fence | Operation methods, epoch/stateVersion/admission and new hook registration reject RegistryRetiringError promptly. Persisted roots are never blocked by this hold. |
| runtime entry admitted before fence | Preserve FIFO; it completes before replacement. Its prepare still checks active key. Already-open handlers use raw persistence reads/completion during drain. |
| drain | Await earlier admitted registry entries, then invoke all registered hooks outside every entry/owner slot. Hooks run once per drain round, in registration order. Observe all failures. |
| hook rejection, invalid proof/admission, stale CAS, cancellation before commit or known rollback | Only that attempt restores active and releases its hold. Previously granted access for that still-active key becomes usable again. A stopped peer is not restarted automatically; hosts may register/create another. |
| unknown provider outcome | ambiguous(attempt). Keep temporary fence/hold while the D8 entry resolves proof. No timeout lifts it. |
| proof rolled-back | active with a new generation. Release hold; discard candidate/cache and publish no install. |
| proof committed | displaced source, install destination owner or tombstone. Release temporary hold; the old access permanently rejects DisplacedGroupHandleError. |
| fail-stop without proven commit | Restore active creation state, discard cache and release only that attempt's hold. Propagate GroupStateConflictError; persistence remains failed until restart. |
| competing replacer | A loser rejects RegistryRetiringError or stale displacement. It owns no hold and cannot settle/unfence the winner. |
| cold load begun before fence | Its captured generation no longer matches. It cannot publish/return the old owner even if restore later succeeds. |
| hook never settles | Attempt remains retiring; no owner slot is held. Host must supply a settling hook. Group B and raw completion work continue. |

runtime.snapshot remains the last proven diagnostic value during retirement and becomes null only on proven displacement. It authorises no new work. Retirement hooks cover peers, submitted publications, opened handlers, completion and finalisers. Hook completion is a host promise of quiescence, not proof inferred from storage. Recheck source and drain generation in the replacement entry. Re-drain outside ownership if permitted raw work opened meanwhile. Deletion permits at most three drain/recheck rounds (Task 20).

- [ ] **Step 1: Write failing tests.** `hook runs outside ownership`: hook performs root read/completion successfully; phases show no owner entry. `never settling hook holds no slot`: group B and same-group raw read finish. `hook rejection restores active`: new access/read succeeds after typed rejection. `unregister is idempotent`. `queued-before-fence entries finish in order`: new calls reject temporarily, preceding writes succeed. `competing loser cannot unfence winner`: winner held in hook/proof, loser refuses, hold remains. `blocked cold restore cannot publish`: fence changes generation before restore release; old result never returns. Later Tasks 15/18/20 test refusal/rollback/ambiguity on real mutations, not only fake settlement.
- [ ] **Step 2: Run red.** `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-retirement.test.ts test/registry-cold.test.ts`. Expected: missing lifecycle behaviour.
- [ ] **Step 3: Implement the state table and connect cold publication/onRetire.** Do not register peers or alter createGroupMLS.
- [ ] **Step 4: Run Step 2 green.** Expected: PASS. Remove generation check and verify the held-restore assertion fails; restore it.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `feat(mls-rpc): add attempt-owned retirement hooks and fences`.

### Task 10: Coordinator observation of every final accounted commit

**Files:**
- Modify: `packages/mls-rpc/src/entry-capability.ts`, `packages/mls-rpc/src/memory-group-persistence.ts`, `packages/mls-rpc/src/memory-device-persistence.ts`, `packages/mls-rpc/src/owner-queue.ts`.
- Modify: `packages/rpc-conformance/src/ownership-phases.ts`, `packages/rpc-conformance/src/persistence-fixture.ts`, `packages/mls-rpc/test/fixtures/storage-persistence.ts`, `packages/mls-rpc/test/fixtures/registry.ts`.
- Test: `packages/mls-rpc/test/commit-observation.test.ts`, `packages/mls-rpc/test/ownership-phases-conformance.test.ts`.

**Interfaces:** Consumes Task 1 coordinator. Extend EntryCapability with `observe(groupID: string, fn: (observation: AccountedGroupObservation) => void): () => void`. Define AccountedGroupObservation in entry-capability.ts. It contains mutationID, final lifetime, affected StateMetadata, current trust, active ControlSnapshot, active key/version and diagnostic state/terminal status. Trust supplies public tree/anchor/registry inputs for Task 11. Explicit unreadable state/trust status supports diagnostic observation without poisoning safety-only transitions. All fields are detached, without stores/transactions. Add internal `OwnerEntry.afterRelease(fn: () => void): void`, separate from onCommit.

Capture final observation after finalise and effects/account. Cover public transitions, Combined participation and control/anchor/cursor/outbox facades. Publish trusted synchronous observers only on commit proof. No root read, handle restoration or host callback runs during publication. Staged/accounted capture is allowed before proof. Rollback/fail-stop drops it. Pending proof retains the prior observation.

Dispatch afterRelease only after releasing every slot and clearing callback context. The seam preserves per-group FIFO. External runtime listeners are Task 11's responsibility. Extend conformance mirrors structurally, without mls-rpc imports.

- [ ] **Step 1: Write failing tests.** `every facade commit is observed`: control-only, anchor, cursor and outbox writes carry final versions. `effect-only observation uses accounting`: version advances once after side writes. `pending proof publishes once`: no observation before proof, exactly one on commit, none on rollback/fail-stop. `afterRelease can call persistence roots`: no active callback token or owned slot; same-group read/transition completes. `observations are detached`: changing bytes/maps cannot affect rows or another observer. `Combined observation waits both owners`.
- [ ] **Step 2: Run red.** `rtk proxy pnpm turbo run build:js build:types`; `rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/commit-observation.test.ts test/ownership-phases-conformance.test.ts`. Expected: missing observation/afterRelease seam or named accounting failures.
- [ ] **Step 3: Implement final-accounted capture and proof publication.** Keep afterRelease distinct from existing before-release hooks.
- [ ] **Step 4: Run Step 2 green.** Expected: PASS. Publish before proof and dispatch before release separately; their named assertions must fail. Restore each guard.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `feat(mls-rpc): observe every proven accounted group commit`.

### Task 11: Internal public-state projection and runtime publication

**Files:**
- Create: `packages/mls-rpc/src/registry/runtime-facts.ts`.
- Modify: `packages/mls-rpc/src/registry/runtime.ts`, `packages/mls-rpc/src/registry/access.ts`, `packages/mls-rpc/src/registry/registry.ts`, `packages/mls-rpc/test/fixtures/registry.ts`.
- Test: `packages/mls-rpc/test/registry-runtime.test.ts`.

**Interfaces:** Consumes Task 10 accounted observations, Task 7 admission and Task 8 initial runtime. Produces internal helpers, never MLS package-barrel exports:

```ts
export type PublicRuntimeFacts = { members: Array<string>; ownPresent: boolean; lapsed: boolean }
export function publicRuntimeFacts(params: { tree: ClientState['ratchetTree']; anchor: GroupAnchor; registry: DeviceRegistry; ownerDID: string }): PublicRuntimeFacts
```

Use existing public parseMLSCredentialIdentity and token decodeSignedToken/normalizeDID for validated public nodes. Reuse, never copy, the membership and controller-time/lapse rules at `packages/mls/src/group-handle.ts:809-840` and `packages/mls/src/lifecycle.ts:61-98`: extract them into one exported pure `@kumiai/mls` helper (deliberate public API addition, release-intent noted) that both the handle and this projection call. This pure synchronous projection performs no host callback or handle restoration. The only new @kumiai/mls export is that lapse/membership helper.

Subscribe before the first cold/seed/source/switch/delete call, including initially absent groups. On proven commit, project final public inputs, invalidate immutable cache bytes and install the defensive snapshot synchronously. Invalid/unreadable trust publishes no trusted snapshot. Readable validated active state plus own membership gives available true. Admission precedence is terminal, stranded, then lapsed. Broader safety gates remain 2.2c/2.3. Displaced access returns null and emits null once.

Use Task 10 afterRelease for external notifications, outside entry callback/context. Preserve per-group FIFO and listener registration order. Give each listener independent defensive values. Returned promises never delay settlement or later notifications. Attach rejection handlers and contain synchronous throws. Synchronous listener work must return; JavaScript cannot be pre-empted.

- [ ] **Step 1: Write failing tests.** `public facts match validated handle`: membership, own removal and lapse match real MLS and model handles. `control-only commit updates runtime`: strand/version/admission match final rows. `effect-only commit uses final version`. `rollback and pending proof retain old snapshot`. `anchor outbox cursor facades invalidate cache`. `snapshots and listener values are defensive`. `listeners can call roots after release`. `slow rejecting listeners do not delay commits`: second commit and FIFO notifications arrive before first promise settles, without unhandled rejection. `displacement emits null once`.
- [ ] **Step 2: Run red.** `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-runtime.test.ts test/runtime-neutral.test.ts`. Expected: missing projection or snapshot/listener failures.
- [ ] **Step 3: Implement projection and runtime subscription.** Use final accounted versions. Add no @kumiai/mls barrel export.
- [ ] **Step 4: Run Step 2 green.** Expected: PASS in both modes. Deliver listeners inside the commit hook; the same-group root assertion must fail. Restore afterRelease dispatch.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `feat(mls-rpc): publish registry runtime after owner release`.

### Task 12: Direct core mutation and ordinary adoption

**Files:**
- Modify: `packages/mls-rpc/src/registry/access.ts`, `packages/mls-rpc/src/registry/types.ts`, `packages/mls-rpc/src/registry/trust.ts`, `packages/mls-rpc/src/registry/validation.ts`, `packages/mls-rpc/src/persistence-errors.ts`.
- Test: `packages/mls-rpc/test/registry-access.test.ts`. Existing control-build/control-adoption source remains unchanged.

**Interfaces:** Consumes Tasks 1/3/8/11 and existing ControlJournal/FirstValidCommit. Produces `mutate: HandleAccess['mutate']`, `replace: HandleAccess['replace']`, and `adopt(next: GroupHandle, expected: AdoptionExpected, write: AdoptionWrite): Promise<'installed' | 'noop' | 'moved'>`. No HandleAccess adapter. Define RegistryRecoveryReplacementError extending Error for recovery journal/candidate replacement through ordinary methods. Reuse the existing moved-refusal error name via an Error named ControlAdoptionMovedError; no existing exported class is assumed.

mutate runs on an isolated current-version handle in prepare. Its persist callbacks stage the final state and optional adoption writes; they perform no durable save. Multiple callbacks stage one final state save per incarnation. If callback changes epoch, co-write recoveryTrustFor. Return callback results only after proven commit. Rollback/ambiguity never advances a cached mutable handle.

For this staged core, replace/adopt require an ordinary ControlJournal in write.expected.journal with matching FirstValidCommit acceptance. replace's factory receives staged ordinary identity; its prepare callback runs against gated current/source. Decode/check journal before install; reject recovery candidate envelopes or absent ordinary provenance. All build/adoption callers keep simple access until 2.2d supplies registry-mode orchestration and retry release. This deliberate restriction prevents guessing whether an arbitrary next handle is a resync.

Resolve write.mutationID proof before any noop/spent check. With no matching pending/marker proof, uncertainty permits only the ordinary source/journal/control checks below. It never proves rollback or identity-based success. An unchanged identity is noop only with matching applied payload/position or matching control mutation proof. Otherwise moved, not silent success. Compare expected key/version/identity at work start. Check journal source, checkpoint/from, slot payload/journal and retained acceptance. Bind next to the decoded journal destination before carry or any save. Compare groupID, next epoch/authenticator, own credential against the decoded own leaf, and encoded immutable anchor. Journal candidate bytes are host-serialised (`rpc/src/host-boundary.ts:345-347`), so decode them only through the factory's `restoreCandidate`, exactly as `control-adoption.ts:25` does; never assume `encodeClientState` format. The own credential comes from that restored destination handle (`ControlJournal` stores only `sourceCredential`). `encodeClientState(next.state)` must equal `encodeClientState(destination.state)`. A `restoreCandidate` rejection or malformed result refuses like a mismatch, unchanged. No progress differences are permitted before this comparison. Run the same check for replace after its factory yields write.expected.journal. Return moved for adopt and throw ControlAdoptionMovedError for replace on mismatch. Neither path saves state/trust/control/anchor or changes versions. Only after binding succeeds, carry current committed sender/receive progress with `carryReceiveProgress` into an isolated candidate before save. Validate configuration and provider monotonicity. Never resurrect evicted epochs. State/trust/control/anchorLanded changes share one work transition.

`open` is deliberately absent here. 2.3 supplies AppFrameRef conversion and interception into pending/openBatch, rather than invoking independent host save callbacks in prepare.

- [ ] **Step 1: Write failing tests.** `concurrent mutate derives CAS in prepare`: both writes succeed in queue order. `multiple persist calls save once`: one state version bump, final state durable. `epoch mutation co-writes trust`: installed/spent advances atomically. `ordinary candidate carries committed progress`: candidate prepared before send/open progress cannot regress it. `same identity without write proof is moved`: no version/install. `proved ordinary replay is noop`: no second save. `A proof cannot install B through adopt or replace`: in both fixture modes, build A and B from the same source with equal next epoch but different authenticators; retain accepted A payload/journal, supply B to each direct API. Refuse before carry/state-save/any seal, and keep physical rows, stateVersion, lifetimeRevision and trust unchanged. Also change own credential and non-progress candidate state separately (the anchor derives from state, so it has no isolated variant). `undecodable journal candidate refuses unchanged`: in both modes a `restoreCandidate` that rejects, and one returning another group's handle, refuse before carry/save with rows/versions/trust unchanged. `ordinary replace refuses recovery envelope`: unchanged rows. `mutate rollback and pending proof discard speculative progress`: next read restores committed bytes.
- [ ] **Step 2: Run red.** `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-access.test.ts`. Expected: absent methods or named guard failures.
- [ ] **Step 3: Implement direct registry methods using one Task 1 run.** No preliminary Read for ordinary writes. Apply explicit caller adoption guards at work start. Integrate Task 11 observation.
- [ ] **Step 4: Run Step 2 green.** Expected: PASS. Bypass only journal-candidate binding; A-proof/B-candidate refusal must fail in both modes. Restore the check. Existing real/simple port runners remain regression tests, not registry conformance claims.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `feat(mls-rpc): add direct registry mutation and ordinary adoption`.

### Task 13: Shared drained-source retirement and adopted continuation

**Files:**
- Create: `packages/mls-rpc/src/registry/retired.ts`.
- Modify: `packages/mls-rpc/src/memory-incarnation-stores.ts`, `packages/rpc-conformance/src/group-storage.ts`, `packages/mls-rpc/test/fixtures/registry.ts`.
- Test: `packages/mls-rpc/test/registry-retirement-writes.test.ts`.

**Interfaces:** Consumes Task 1 GroupStores and Task 9 completed retirement drain. Produces `retireIncarnation<TTx extends GroupTransaction>(stores: GroupStores<TTx>, params: {source: GroupKey; nextIncarnation: number; switchedRejoinID?: string; mutationID: string; at: number}): Promise<void>`. Source/control/outbox changes precede lifetime.save. No EntryWork, handoff type, handoff meta methods or new storage namespace.

For EVERY old entry without a certified AppSettlementObligation, write failed status and one stable event ID `JSON.stringify(['incarnation-abandoned', groupID, source.incarnation, seq])`. Preserve entry data/lastAttempt and nextIncarnation in the event. This includes non-null lastAttempt and formerly submitted but unproven entries. Hooks have already drained all submitted network work. Retain existing failure events without duplication. Remove failed uncertified outbox rows in the same transaction, retaining their status/data in events. Teach removal to recognise this matching failure event instead of adding a second removed event.

Leave certified entries and frozen settlements byte-identical. Their existing original-occurrence settlement path remains lawful. A fully settled drain removes published entries before switch, so no entries remain afterward. A fixture with residual certified rows verifies preservation; it does not justify retaining uncertified entries. No automatic reseal or new handoff-retention escape API.

Turn source operations and unswitched rejoin into unknown outcomes with stable IDs. Preserve owed outcomes/Welcomes, commitOnce, acceptance/holds and evidence. For switchedRejoinID, update only the matching confirmed record's stage to adopted under retired n. Preserve source, candidate, requestKey, verdict, position, ledgerBefore and every other continuation field. Add no Outcome kind. Keep slot provenance for retired Welcome checks.

2.2d reads the adopted row through fixed retired control ports and bootstraps the destination n+1. It derives ordered missing tokens from ledgerBefore, persists reenact when nonempty, and only then removes the row. This later settlement needs an explicit guarded retired-control continuation write path; 2.2b does not widen retired writes to arbitrary putRejoin/deleteRejoin. Until then the row remains durable and blocks deletion. Hosts alone choose reenqueuing.

Transaction order: source retirement/control/status/events/removal, then lifetime.save(destination active), then destination state/trust/control/anchor/cursor. Provider finalise writes the source tombstone. An existing tombstone has no source retirement stage.

- [ ] **Step 1: Write failing tests.** `retirement writes before pointer change`: reversing order refuses displacement. `every uncertified entry fails once`: null and non-null lastAttempt receive incarnation-abandoned with immutable data/nextIncarnation; no rows remain and event IDs survive replay. `certified entries and settlements remain unchanged`. `unknown operations keep owed artifacts and slot`. `switched rejoin remains adopted with ledgerBefore`: include a source token absent from candidate ledger, reopen and read the identical ordered list/candidate/proof fields from retired control; no invented outcome or automatic enqueue. `mid-write rollback preserves both sides`: events/status/control/removal and installation all roll back.
- [ ] **Step 2: Run red.** `rtk proxy pnpm turbo run build:js build:types`; `rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-retirement-writes.test.ts test/storage-conformance.test.ts test/ownership-phases-conformance.test.ts`. Expected: missing retirement helper or event/adopted-retention failures.
- [ ] **Step 3: Implement shared retirement with existing ports.** Preserve certification guards. Permit failure-event-backed removal without duplicate status events.
- [ ] **Step 4: Run Step 2 green.** Expected: PASS in both modes. Skip attempted entries and remove the adopted row separately; their named assertions must fail. Restore both rules.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `feat(mls-rpc): fail uncertified retired entries and retain adopted rejoin`.

### Task 14: Normative pure Welcome judgment and existing-call migration

**Files:**
- Modify: `packages/mls-hub/src/admission.ts`, `packages/mls-hub/src/index.ts`, `packages/mls-hub/README.md`, `packages/mls-hub/test/admission.test.ts`, `packages/mls-hub/test/join.test.ts`.
- Modify: `tests/integration/test/peer-readmission.test.ts`, `tests/integration/test/welcome-after-crash.test.ts`. No registry import in mls-hub.

**Interfaces:** Consumes verified Welcome identity values. Produces the exact normative location/signature, spec `:861-862`:

```ts
export type WelcomeAdmissionParams = {
  held: { incarnation: number; epoch: number | null; deleted: boolean; forkHalted: boolean } | null
  spentEpochAuthenticators: Array<Uint8Array>
  welcome: { epoch: number; epochAuthenticator: Uint8Array }
}
export function judgeWelcomeAdmission(params: WelcomeAdmissionParams): 'join' | 'alreadyJoined' | 'replace' | 'refused'
```

Reject malformed spent/authenticator/epoch/held inputs with TypeError. Spent → refused before all epoch branches. Held forkHalted → refused. Absent or deleted → join. Live epoch null → refused (unavailable state requires recovery). Live at/above Welcome → alreadyJoined; strictly newer → replace. Registry derives live held.epoch from current installed trust, even if private state bytes are null; missing/invalid administrative metadata is a registry refusal before judgment.

Migrate existing callers only to pure parameters. Track authenticators actually installed by their simple-host setup. Last-resort replay and joined-before-consume judgment change to refused/spent (`tests/integration/test/peer-readmission.test.ts:115-120`, `:199-206`; `tests/integration/test/welcome-after-crash.test.ts:219-227`, `:247-252`). Receipt-only openWelcome short-circuit remains alreadyJoined and performs no installation (`tests/integration/test/welcome-after-crash.test.ts:240-245`). These tests retain existing host storage/lifecycle; fresh-incarnation assertions belong to registry tests. No cyclic devDependency or joinRef/package migration.

- [ ] **Step 1: Write failing tests.** `spent precedes epoch`: exact/alternate identity refuse. `tombstone has no highest epoch floor`: lower unspent joins. `fork halted refuses`. `live null epoch refuses`. `malformed inputs refuse`: missing set, invalid metadata/authenticator. `unused older Welcome is alreadyJoined`: construct W3 unused, remove at E4, readmit with W5, then judge unspent W3. Keep receipt-only no-decrypt assertions.
- [ ] **Step 2: Run red.** `rtk proxy pnpm turbo run build:js build:types`; `rtk proxy pnpm turbo run test:types`; `rtk proxy pnpm --filter @kumiai/mls-hub run test`; `rtk proxy pnpm --filter @kumiai/integration-tests run test`. Expected: signature mismatch, then changed replay assertions.
- [ ] **Step 3: Implement pure judgment and migrate those calls/expectations.** Keep join tests inside mls-hub. No registry seed consumer wiring.
- [ ] **Step 4: Run Step 2 green.** Expected: PASS. Move spent after epoch comparison; the same-epoch spent assertion must fail. Restore it.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `feat(mls-hub): apply normative spent-first Welcome judgment`.

### Task 15: Normative seed and explicit readmission with retained-entry proof

**Files:**
- Create: `packages/mls-rpc/src/registry/seed.ts`.
- Modify: `packages/mls-rpc/src/registry/registry.ts`, `packages/mls-rpc/src/registry/types.ts`, `packages/mls-rpc/src/persistence-errors.ts`, `packages/mls-rpc/test/fixtures/registry.ts`.
- Test: `packages/mls-rpc/test/registry-seed.test.ts`.

**Interfaces:** Consumes Tasks 3/9/13/14. Produces the exact normative `seed(group: GroupHandle, params: {replace?: boolean; packageUse: PackageUse | null}): Promise<GroupKey>`. Add SeedAdmissionRefusedError with `reason: 'spent' | 'fork-halted' | 'replace-required' | 'invalid-active-metadata' | 'unavailable' | 'invalid-genesis' | 'invalid-package-use'`. Internal `seedAdmission(params: {lifetime: GroupLifetime | null; metadata: StateMetadata | null; trust: GroupRecoveryTrust | null; welcome: {epoch: number; epochAuthenticator: Uint8Array}; replace?: boolean; forkHalted: boolean}): 'join' | 'alreadyJoined' | 'readmit' | 'next-incarnation'` maps pure judgment or throws typed refusal. The persisted halt gate belongs to 2.2c; this HEAD has no halt field. Pass false here, test pure halted judgment, and claim no complete fork-halt enforcement.

Allocate the seed mutationID internally for Task 1 run. Unknown outcome retains that entry and its saved GroupKey until D8 proof settles. Return the saved result only after proven commit; rollback lifts the fence and installs/spends nothing. A fresh seed invocation is fresh admission and an installed Welcome always refuses spent. Add no installation receipt or historical seed replay API.

External persistence.resolve joins matching pending proof. After restart a matching unsuperseded marker can answer committed. After supersession it throws GroupStateUncertainError (`:500-501`, `:1111`), which propagates without an identity-equality fallback. The caller uses access(groupID) for the current installed key. A fresh seed of that Welcome still refuses spent. Test-only work-fault capture exposes internally allocated IDs for these assertions.

Genesis requires true absence, epoch 0 and null packageUse. Non-genesis requires well-shaped non-null PackageUse. Validate sourceID/ref nonempty, recognised kind and candidate ownership/configuration. Stage packageUse for the later Combined/install boundary. Invoke no provider package hook or atomic burn here.

Take one coherent admission Read capturing lifetime revision and installed identity. Readmit requires replace === true. Acquire retirement only for readmit and drain hooks outside ownership. Run one prepare/work entry. At work start recheck the caller admission expectation and current metadata/trust/spent/complete mapped decision, independently of prepared CAS. Use Task 13 source writes before lifetime.save. Install latest+1, version 1, matching trust, empty control, null anchor/cursor and no app progress/pending/outbox/applied/responses. Tombstone join needs no source hooks/writes. Provider finalisation appends exactly once. Seed's lazy null anchor belongs to the new handle; switch derives its candidate anchor in Task 18.

- [ ] **Step 1: Write failing tests.** `absent Welcome installs incarnation one`. `genesis refuses package or existing lifetime`. `fresh spent seed refuses`. `seed unknown returns saved result after proof`: next-work fault captures the internal ID, no result before proof, one install afterward. `superseded seed marker is uncertain`: external resolve(M1) after M2 throws GroupStateUncertainError; access returns installed key; fresh seed refuses spent. `readmit requires explicit true`: omission/false refuse and source stays usable. `readmit drains hooks then creates n+1`: old failure events/owed artifacts retained and source displaced. `tombstone lower unspent Welcome creates latest+1`: no source retire. `missing malformed active metadata refuses typed`. `rollback spends nothing`: events/state unchanged, fence lifted. `seed ambiguity retains fence until proof`: commit displaces, rollback restores. `admission rechecked inside work`: alter only admission inputs at work probe with lifetime CAS equal; refusal occurs before state/trust saves. `stale admission Read refuses on drift`: group B proceeds.
- [ ] **Step 2: Run red.** `rtk proxy pnpm turbo run build:js build:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-seed.test.ts test/registry-retirement.test.ts`. Expected: missing normative seed or named proof/admission failures.
- [ ] **Step 3: Implement seed with Tasks 3/9/13/14.** Use retained-entry proof, never a receipt or public mutationID parameter.
- [ ] **Step 4: Run Step 2 green.** Expected: PASS in both modes. Remove admission recheck and explicit replace check separately; the intended refusal-before-save assertions must fail. Restore each guard.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `feat(mls-rpc): seed through retained-entry proof and explicit readmission`.

### Task 16: Handle-independent current RecoverySource

**Files:**
- Create: `packages/mls-rpc/src/registry/source.ts`.
- Modify: `packages/mls-rpc/src/registry/registry.ts`, `packages/mls-rpc/src/registry/types.ts`, `packages/mls-rpc/src/index.ts`.
- Test: `packages/mls-rpc/test/registry-source.test.ts`.

**Interfaces:** Consumes Task 1 administrative/trust reads. Produces `RecoverySource = AdoptionExpected & {trust: GroupRecoveryTrust; lifetimeRevision: number}`; `recoverySource(groupID: string): Promise<RecoverySource>`. This does not replace GroupMLS.readRecoverySource yet.

One Task 1 Read loads lifetime, active metadata and retained trust. Return current installed identity only when installed.incarnation/groupID match the active key. Copy all bytes/nested data. Use metadata.version, never initialIdentity. Null/corrupt private state does not prevent this read; no state open is required to construct source. Metadata/trust missing, malformed or unreadable refuses instead of manufacturing identity or empty spent. Absent/deleted source gives GroupUnavailableError. Private-state readability remains a separate diagnostic/cold-access concern.

- [ ] **Step 1: Write failing tests.** `A3 A4 corrupt and null state keep current source`: A4 identity/version/lifetime/trust survive state corruption/loss, while access refuses. `source uses one Read`: no revisions change. `source fields are defensive`. `missing metadata and corrupt trust refuse`: no initial/empty fallback. `retired installed identity cannot masquerade as active`.
- [ ] **Step 2: Run red.** `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-source.test.ts`. Expected: missing source or identity assertion failure.
- [ ] **Step 3: Implement source using committed administrative/trust reads.** Preserve consumer recovery code for 2.2d.
- [ ] **Step 4: Run Step 2 green.** Expected: PASS in both modes.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `feat(mls-rpc): read recovery source independently of private state`.

### Task 17: Reuse full authoritative recovery verdict judgment

**Files:**
- Create: `packages/mls-rpc/src/registry/verdict.ts`.
- Modify: `packages/mls-rpc/src/recovery.ts`, `packages/mls-rpc/src/recovery-codec.ts`, `packages/mls-rpc/src/registry/types.ts`, `packages/mls-rpc/src/persistence-errors.ts`, `packages/mls-rpc/test/fixtures/registry-recovery.ts`.
- Test: `packages/mls-rpc/test/registry-verdict.test.ts`. Keep MLS verdict wire format unchanged.

**Interfaces:** Consumes Task 16 source and existing recovery judge/codec. Produces `verifyRegistryResync(params: {source: RecoverySource; candidate: GroupHandle; record: RejoinRecord; proof: ResyncProof}): Promise<void>`. Add RegistryResyncRefusedError extending Error with reason: 'malformed' | 'unaccepted' | 'source' | 'candidate' | 'tuple' | 'ineligible'. ResyncProof is introduced in registry/types with spec `:826-830` fields, using rpc LogPosition. It is not added to RPC consumer ports here.

Require record stage confirmed. Match record.position and record.payloadDigest to proof.position and proof.payloadDigest. Match source.key/epoch/authenticator to supplied source and source.trust.installed. Decode persisted candidate with record.requestKey. Compare requestID, epochAfter, groupID, complete candidate state/credential/binding, candidate identity and bound confirmation tuple with the supplied candidate. Compare public source tree with retained source trust. Merge persisted knownRegistry with retained trust.registry using knownRecoveryRegistry, preserving revocations and maximum generation/time floors. Any source/candidate association mismatch refuses before retirement writes.

Here `proof.verdict` is the sealed verdict bytes, byte-equal to record.verdict. Open using candidate, record.requestID and record.requestKey through openRecoveryVerdict. Recompute confirmation key/tag via createVerdictJudge.confirmationKey(proof.position, proof.payloadDigest). Require confirmed and judgeVerdict === authoritative using the complete existing rule. Preserve unbound confirmed semantics; do not add a new current-membership requirement. Bound groups must pass recoverySignerEligible against retained known registry/binding. Own signer, signature/type/request/group/epoch/position/digest/tag mismatch or refused/superseded verdict refuses.

RejoinRecord has no target/capture fields at HEAD. ResyncProof targetID/topicID/groupInfoEpoch/captureHead receive type/position validation only here. Their authenticated persistence/association and initial CAS remain explicit 2.2d prerequisites before production wiring. Never claim they were stored or authenticated here. Verify all existing record/source/candidate fields now.

- [ ] **Step 1: Write failing tests.** `full bound confirmed verdict accepts`; `bound signer policy refuses`: revoked signer, revoked capability issuer, obsolete prefix below genFloor, wrong controller, lapsed grant. `tuple and sealed record association refuse`: wrong request/group/epoch/position/digest/tag, own signer, tampered signature, mismatched record.verdict. `record source and candidate must match`: stale source incarnation/identity, another persisted candidate/requestKey, refusal/unconfirmed stage. `unbound confirmed retains existing judgment`: no accidental extra membership rule. Fault fixtures use real signatures/sealing in both modes.
- [ ] **Step 2: Run red.** `rtk proxy pnpm turbo run build:js build:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-verdict.test.ts test/recovery-codec.test.ts test/recovery-holder-evidence.test.ts`. Expected: missing verifier or named policy failures.
- [ ] **Step 3: Factor and reuse judgment, without duplicating its policy.** Expose the decoded sourceTree for public-node comparison. The encoded sourceState currently uses candidate groupContext/keySchedule with the source tree; never infer source epoch/authenticator from it. Compare record.source against current trust.installed instead. No handle-dependent automatic recovery rewiring.
- [ ] **Step 4: Run focused verdict green plus full `rtk proxy pnpm --filter @kumiai/mls-rpc run test`.** Expected: PASS. Bypass recoverySignerEligible and tag comparison separately; corresponding negative assertions fail. Restore each guard.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `feat(mls-rpc): verify registry resync with authoritative verdict policy`.

### Task 18: Restricted atomic switch and destination initialisation

**Files:**
- Create: `packages/mls-rpc/src/registry/switch.ts`.
- Modify: `packages/mls-rpc/src/registry/registry.ts`, `packages/mls-rpc/src/registry/types.ts`, `packages/mls-rpc/test/fixtures/registry.ts`, `packages/mls-rpc/test/fixtures/registry-recovery.ts`.
- Test: `packages/mls-rpc/test/registry-switch.test.ts`.

**Interfaces:** Consumes Tasks 3/9/13/16/17. Produces `switchIncarnation(candidate: GroupHandle, params: {source: RecoverySource; rejoinID: string; proof: ResyncProof; write: RegistrySwitchWrite}): Promise<GroupKey>`.

`RegistrySwitchWrite = {mutationID: string; source: {rejoinID: string}; destination: {control: {cursor: {position: LogPosition; epoch: number}}}}`. This is a deliberately restricted core write contract, replacing generic AdoptionWrite at this staged boundary. Runtime validation rejects additional source/destination fields with TypeError before any save. Require write.source.rejoinID to equal params.rejoinID and the retained record ID. No caller-supplied source ControlChanges, destination applied/responses/operations, anchorLanded or source cursor/anchor. The registry derives retirement changes and destination rows. 2.2d constructs this write alongside authenticated target propagation.

Resolve write.mutationID outside entries to join any matching pending proof before a barrier-protected Read of the fixed source control row. Catch only GroupStateUncertainError for that lookup; it proves neither success nor rollback. A matching retained adopted rejoin proves semantic replay of this rejoinID, independently of later markers.

Match source key/epoch/authenticator, rejoinID, persisted candidate identity/state/credential/anchor, position/digest and sealed verdict against supplied candidate/proof. Do not require the retired source to remain active or its old lifetimeRevision to remain current. Return `{groupID, incarnation: source.key.incarnation + 1}` without fencing, hooks, restore of an old owner or a second install, even if that destination is now retired. A mismatched adopted row refuses unchanged. Committed marker without matching adopted evidence refuses conflict. Only a matching confirmed row may proceed as a fresh attempt. Adopted replay never reinstalls, and active identity alone is never proof.

Fresh attempts acquire source retirement ownership, drain hooks, then prepare source rows and verify Task 17 using persisted trust, after matching it to supplied source.trust. Work compares source key/stateVersion/current identity/lifetimeRevision, including its retained trust, and revalidates the confirmed record. Compare prepare-derived CAS plus the caller source expectation. A stale source refuses unchanged; no identity-only replay fallback.

Validate candidate using Task 3. Require current latestIncarnation to equal the active source incarnation n. Destination is n+1 with version 1, fresh private state from the externally joined candidate and no source carry. Refuse spent candidate before any installation write. Prepare fresh anchor `{anchor: {epoch: Number(candidate.epoch), secret: await candidate.exportSecret(APP_TOPIC_LABEL, new Uint8Array(), 32)}}`; import APP_TOPIC_LABEL from rpc (`packages/rpc/src/topic.ts:23`, exported at `packages/rpc/src/index.ts:212`). No pending rotation. Destination control is emptyControl plus cursor `{position: proof.position, epoch: Number(candidate.epoch)}`. The restricted supplied cursor must equal these derived values. App-topic cursors remain absent until 2.3 open/completion. No source rows/progress get copied.

Task 13 retires source and leaves its switched rejoin at stage adopted before lifetime.save. Then save destination state/trust/control/anchor atomically. Preserve ledgerBefore and all continuation fields until 2.2d bootstrap/reenact settlement. Use Task 11 proof publication. The new slot's secret must differ from source capture, even if candidate epoch happens to equal/lower source epoch.

- [ ] **Step 1: Write failing tests.** `switch atomicity and isolation` (spec `:1083`): A4 n→external candidate n+1, old tombstone, fresh state/control/cursor/anchor, no inherited progress/applied/responses. `switch stale and unaccepted guards` (`:1084`): stale key/version/identity/revision, refused/unconfirmed record, spent candidate, invalid write cursor refuse unchanged. `switch mid-write rollback`: both sides byte-identical, spends nothing, source usable/fence lifted. `switch replay resolves adopted evidence before stale source and spent`: after a later owed-only source write supersedes the marker, same rejoin returns n+1 with no hooks/version/install. A different candidate or proof cannot reuse that adopted row. `switch reopen retains bootstrap continuation`: ledgerBefore includes a token absent from candidate ledger; after reopen the adopted row preserves ordered tokens and all proof inputs, with no completion outcome or automatic enqueue. `switch revision-only drift refuses`: save source for active n, then delete an owed Welcome through fixed retired n-1 ports. Lifetime revision advances while active stateVersion, key, identity and trust stay equal. Pass the stale source with freshly prepared CAS; refusal precedes retirement/state/trust saves. `switch inherited destination fields refuse`: supply an untyped write with source applied/responses, app cursor, anchor or progress rows in destination initialisation, one variant at a time. Expect TypeError before any source/destination save and byte-identical physical rows. For candidate-state source progress, alter decoded candidate history; Task 17 candidate association must refuse before installation. `competing switches cannot undo winner fence`. `switch ambiguous proof retains hold`: commit/rollback publish exactly their state. `old applied cannot mask self-removal`: new incarnation terminal state remains terminal.
- [ ] **Step 2: Run red.** `rtk proxy pnpm turbo run build:js build:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-switch.test.ts test/registry-verdict.test.ts`. Expected: absent switch or named guards.
- [ ] **Step 3: Implement switch with Tasks 3/9/13/16/17.** No production caller or target storage claim.
- [ ] **Step 4: Run Step 2 green.** Expected: PASS in both modes. Remove only source lifetimeRevision comparison while prepared CAS remains valid; the retired-owed-only revision-drift fixture must now install, failing its refusal assertion. The active stateVersion/identity guards cannot mask this mutation check. Restore it.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `feat(mls-rpc): install proven resync into a fresh incarnation`.

### Task 19: Storage-only retired outcomes and first-valid Welcome delivery

**Files:**
- Modify: `packages/mls-rpc/src/registry/retired.ts`, `packages/mls-rpc/src/index.ts`, `packages/mls-rpc/test/fixtures/registry.ts`.
- Test: `packages/mls-rpc/test/registry-retired.test.ts`. No old-peer fixture or peer adapter.

**Interfaces:** Consumes Task 13 retained stores and existing ControlSearchPort/deliverObligations. Produces the following storage-only helpers.

```ts
export function serveRetiredObligations<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>; key: GroupKey
  search: ControlSearchPort
  deliverWelcome: (obligation: WelcomeObligation) => Promise<void>
}): Promise<{ delivered: Array<string>; remaining: Array<string>; failures: Array<unknown> }>
export function listRetiredOutcomes<TTx extends GroupTransaction>(params: { persistence: GroupPersistence<TTx>; key: GroupKey }): Promise<Array<Outcome>>
export function ackRetiredOutcome<TTx extends GroupTransaction>(params: { persistence: GroupPersistence<TTx>; key: GroupKey; id: string }): Promise<void>
```

Refuse active keys. Use fixed `ports(key)`, never a GroupHandle or peer. Read snapshot under a Read entry; network delivery/search run after release. For committed Welcome obligations, permit delivery as the live peer does. Otherwise require matching slot.opID, retained commitOnceAcceptance and no strand/stranded cursor/hard hold. A first-valid recheck through supplied search must match slot payloadDigest and retained from/position (including source key/identity). Unknown/superseded/absent or mismatched proof retains the obligation. Search must operate from the retained journal/slot, not restart an old runtime. Production transport resolver wiring stays outside this core.

Wrap deliverObligations with this canDeliver policy. It returns void and may throw AggregateError; collect failures, then reload fixed old control to construct remaining. delivered lists only obligations whose accepted transport delivery and deletion have both completed. Delivery acceptance followed by deletion failure remains pending. No exactly-once network claim. Root old-port owed deletes remain lawful; do not bypass provider slot/retirement guards.

- [ ] **Step 1: Write failing tests.** `uncommitted retired Welcome never releases`: no retained proof, wrong digest/from/position, unknown search or hard strand/hold gives zero deliveries. `first-valid and committed obligations deliver`: accepted transport then delete. `transport accepted crash before deletion repeats`: work-bound delete fault, durable reopen, delivery called again with identical Welcome/opID; only successful deletion removes it. `one failed delivery does not block other obligations`: failure/remaining accurately returned. `retired outcome ack is fixed-key and idempotent`. `old access cannot supply a restarted owner`: read for old peer construction rejects displacement; no old peer is constructed.
- [ ] **Step 2: Run red.** `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-retired.test.ts`. Expected: missing worker/gate failures.
- [ ] **Step 3: Implement the worker and result wrapper.** Retain all unproved obligations. Keep network callbacks outside ownership.
- [ ] **Step 4: Run Step 2 green.** Expected: PASS. Replace canDeliver with true; the uncommitted zero-delivery assertion must fail. Restore it.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `feat(mls-rpc): serve retired obligations behind first-valid proof`.

### Task 20: Delete/dispose with outside-slot drain and all-incarnation refusal

**Files:**
- Modify: `packages/mls-rpc/src/registry/registry.ts`, `packages/mls-rpc/src/registry/retirement.ts`, `packages/mls-rpc/src/registry/types.ts`, `packages/mls-rpc/src/registry/retired.ts`, `packages/mls-rpc/test/fixtures/registry.ts`.
- Test: `packages/mls-rpc/test/registry-delete.test.ts`.

**Interfaces:** Consumes Tasks 1/9/11/13/19. Produces `delete(key: GroupKey): Promise<void>` and `dispose(): Promise<void>`. Registry disposal closes runtime admission synchronously, drains registered hooks/issued work outside entries, unregisters observers and releases singleton binding. It does not delete storage or stop raw persistence.

Delete acquires the Task 9 retiring attempt and drains hooks. In a new run, recheck active key, drain generation and all control snapshots from incarnation 1 through latestIncarnation. ANY unsettled operations/rejoin/outcomes/Welcomes gives canonical GroupControlUnsettledError. A switched adopted rejoin is unsettled and blocks deletion until 2.2d completes bootstrap/reenact settlement. There is no handoff-obligation scan or abandon API. A frozen certified settlement blocks transport clearing until existing outbox.remove(seq, originalOutcome) completes its original-occurrence publication. Owed outcomes/Welcomes settle through Task 19. No 2.2b task publishes a certified settlement left under a retired incarnation; producing that publication is 2.3 (certified settlement/transport adapters), and until then such a group's delete refuses with GroupControlUnsettledError.

If new completion/opened work appeared during drain, release the entry and drain again. Capture Task 9 activity after hook drainage. Recheck its generation and other pending work at work start. Activity includes admission, so an unfinished or queued raw write cannot escape a committed-observation-only test. After three failed drain/recheck rounds refuse GroupControlUnsettledError and restore runtime owner creation. New work caused by another group's commit does not trigger re-drain.

On a stable settled group, one transition clears transport, sets activeIncarnation null and lets provider finalise tombstone/effects. Retain lifetime/trust/spent, unacked events, device cleanup and host history. Before clearTransport, persist failed statuses and stable deleted events for remaining uncertified active entries. Use ID `JSON.stringify(['deleted', groupID, key.incarnation, seq])`. Then clearTransport removes those rows using Task 13 failure-event recognition, without adding a removed event. After a fully drained switch, old outbox entries are already removed/published, so delete finds none to abandon again. Residual certified entries stay protected until original-occurrence settlement; delete never rewrites their status or adds incarnation-abandoned events. Invoke TransactionalGroupEffects.delete in that transaction. Nonactive key rejects DisplacedGroupHandleError. Refusal/cancellation/rollback releases its hold; ambiguous outcome keeps it until proof. Fail-stop propagates canonical conflict and allows only restart recovery.

- [ ] **Step 1: Write failing tests.** `delete refuses old-incarnation obligations`: active new control empty, retired owed Welcome/outcome present → canonical error, source runtime usable. `delete drains handler root reads and completion`: root reads succeed while hook waits, no slot held. `delete re-drains then refuses after three changes`: owner creation reopens. `delete calls transactional effect`: tombstone/side row co-commit or both roll back. `delete keeps spent events and cleanup`. `delete refuses retained adopted continuation`: retired ledgerBefore and proof inputs remain byte-identical. `delete handles uncertified active entries`: no prior switch, deleted status/event retains data and clears rows. `delete preserves certified settlement until original publication`: first refuse; existing original-outcome removal then permits delete. `delete rollback and hook rejection restore active`. `delete pending proof retains hold`: commit→deleted, rollback→active. `late calls after committed delete write nothing`. `dispose waits hooks and pending proof`: raw persistence and group B continue; singleton reusable only after disposal finishes.
- [ ] **Step 2: Run red.** `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-delete.test.ts test/registry-retirement.test.ts`. Expected: missing delete/drain behaviour.
- [ ] **Step 3: Implement deletion and disposal.** Preserve certified settlement and all-incarnation adopted-control guards.
- [ ] **Step 4: Run Step 2 green.** Expected: PASS. Restrict unsettled-control scan to active incarnation; old-obligation assertion must fail. Restore it.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `feat(mls-rpc): drain registry deletion across all incarnations`.

### Task 21: Shared registry conformance and durable crash sequences

**Files:**
- Create: `packages/rpc-conformance/src/registry.ts`, `packages/mls-rpc/test/registry-conformance.test.ts`, `packages/mls-rpc/test/registry-crash.test.ts`.
- Modify: `packages/rpc-conformance/src/registry-fixture.ts`, `packages/rpc-conformance/src/index.ts`, `packages/mls-rpc/test/fixtures/registry.ts`, `packages/mls-rpc/test/fixtures/registry-welcome.ts`, `packages/mls-rpc/test/fixtures/registry-recovery.ts`.

**Interfaces:** Consumes Task 5 mirrors and Tasks 8-20 core. Produces `testRegistryConformance<THandle extends ConformanceRegistryHandle>(params: {name: string; createFixture: (options: {groupID: string; setup: 'empty' | 'seeded'}) => Promise<ConformanceRegistryFixture<THandle>>}): void`. Register actual registry over memory persistence in real-MLS and independent-double modes. No GroupMLS/GroupCrypto/PendingGroupCrypto port suite over a registry adapter.

Promote Tasks 8-20's externally observable rows into the shared contract. Keep coordinator phase details in ownership-phases. Run both modes for every registry refusal/proof/retirement/snapshot row. Keep wire alternate construction in the real fixture test; double conformance still uses a distinct restored handle with the same authenticator and must refuse it.

- [ ] **Step 1: Add failing shared crash rows.** `seed committed before reopen`: access returns committed group; external resolve of the captured internal mutationID returns committed while its marker remains; fresh seed of same Welcome rejects SeedAdmissionRefusedError(spent). `pending switch commit and rollback`: start promise with a rejection handler attached immediately, await fault.rejected, assert fence/no notifications, allow B to commit, finish backend, then await/catch operation and reopen. No awaiting switch before finish. `A3 A4 switch reopen spent`: exact and alternate valid A3 handles both refuse, for ordinary/last-resort metadata; rollback spends nothing. `superseded seed resolve is uncertain`: perform later control commit; resolve captured seed ID throws GroupStateUncertainError; access returns the current installed key; fresh seed remains spent. `adopted switch replay survives restart`: preserve source ledgerBefore with a candidate-missing token; after later marker and reopen, replay returns n+1 without hooks or reinstall; retained adopted row remains unchanged for 2.2d. `retirement event replay until ack`: stable ID/data after reopen, ack removes only that event, no reseal. `Welcome acceptance before delete crash repeats` (spec `:1066`). `initially absent seed waits barrier`: earlier pending work blocks seed, B proceeds. `seed switch delete wait unfinished completion/proof`: no owner publication or late writes. `cold race matrix`: suspend restore, attempt readmit/switch/delete; commit discards old load, refusal/rollback reactivates with new generation; competing loser never lifts winning hold.
- [ ] **Step 2: Run red.** `rtk proxy pnpm turbo run build:js build:types`; `rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run test/registry-conformance.test.ts test/registry-crash.test.ts test/registry-fixture.test.ts test/registry-double.test.ts test/registry-welcome-wire.test.ts`. Expected: missing registration or a specifically named shared invariant failure.
- [ ] **Step 3: Implement shared test registrations and any fixture forwarding.** Production fixes must follow the already-defined contracts. Map inherited storage guards to existing storage/ownership suites; do not count those alone as registry lifecycle evidence.
- [ ] **Step 4: Run Step 2 green.** Expected: every shared row passes in both modes. Run `rtk proxy pnpm --filter @kumiai/mls-rpc run test` to include storage/ownership and runtime-neutral regression.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `test(mls-rpc): cover registry reconstruction and retirement races`.

### Task 22: Required simple-access key without registry consumer wiring

**Files:**
- Modify: `packages/mls-rpc/src/access.ts`, `packages/mls-rpc/README.md`.
- Modify: `packages/mls-rpc/test/adoption-write.test.ts`, `packages/mls-rpc/test/control-adoption.test.ts`, `packages/mls-rpc/test/control-build.test.ts`, `packages/mls-rpc/test/readme-persistence.test.ts`, `packages/mls-rpc/test/fixtures/real-group.ts`.
- Modify: `tests/integration/test/app-lane-e2e.ts`, `tests/integration/test/app-lane-delivery.test.ts`, `tests/integration/test/control-adoption-race.test.ts`, `tests/integration/test/peer-drained-wire.test.ts`, `tests/integration/test/recovery-known-registry.test.ts`.

**Interfaces:** Consumes the existing simple host port. Produces required `SimpleHandleAccessParams.key: GroupKey`. `simpleHandleAccess` still returns existing HandleAccess and keeps its simple-host serialisation. createGroupMLS/peer wiring is unchanged.

- [ ] **Step 1: Add required-key type assertion and explicit key tests.** `simple access forwards supplied key`: source/adoption key is the supplied incarnation, never inferred. Add explicit incarnation 1 only to genuinely single-incarnation fixtures.
- [ ] **Step 2: Run red.** `rtk proxy pnpm turbo run test:types`. Expected: omitted-key call-site errors after changing the parameter type; type assertion fails before it.
- [ ] **Step 3: Remove the default and migrate only key arguments.** Re-run `rg -n 'simpleHandleAccess\(' packages tests --glob '*.ts'` to check the complete call-site census. Add no registry adapter.
- [ ] **Step 4: Run green.** `rtk proxy pnpm turbo run build:js build:types`; `rtk proxy pnpm turbo run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc run test`, `rtk proxy pnpm --filter @kumiai/rpc run test`, `rtk proxy pnpm --filter @kumiai/integration-tests run test`. Expected: PASS, existing real/simple/double port contracts still run.
- [ ] **Step 5: Commit after `rtk proxy pnpm run lint` and `git diff --check`.** Commit `refactor(mls-rpc): require explicit simple access incarnation keys`.

### Task 23: Release intent and complete implementation gate

**Files:** Modify `.changeset/spec-p-storage-foundation.md` only.

**Interfaces:** None. Keep its existing fourteen-package minor frontmatter, including MLS and mls-hub.

- [ ] **Step 1: Append accurate release text.** “Add registry core with validated ownership on the shared database binding, retire hooks, committed runtime snapshots and accepted-journal candidate binding. Seed uses its normative signature and retained-entry proof; superseded marker resolution may be uncertain. Switch replay uses retained adopted rejoin evidence. After drainage, fail every uncertified old entry with incarnation-abandoned events and preserve certified settlement. Retain adopted bootstrap/reenact continuation for 2.2d. Require explicit simple-access keys and normative spent-first Welcome judgment. Core switch currently uses restricted RegistrySwitchWrite; 2.2d reconciles AdoptionWrite and wires consumers. Leases, batching, package burn/receipt, full factory parameters and crypto/settlement adapters follow in 2.3. `@kumiai/mls` exports its lapse/membership rule as a pure helper.”
- [ ] **Step 2: Run the complete gate sequentially.**

```sh
rtk proxy pnpm turbo run build:js build:types
rtk proxy pnpm turbo run test:types
rtk proxy pnpm --filter @kumiai/mls run test
rtk proxy pnpm --filter @kumiai/mls-hub run test
rtk proxy pnpm --filter @kumiai/mls-rpc run test
rtk proxy pnpm --filter @kumiai/rpc run test
rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types
rtk proxy pnpm --filter @kumiai/hub-conformance run test:types
rtk proxy pnpm --filter @kumiai/hub-server run test:unit test/conformance.test.ts test/log-hub-conformance.test.ts
rtk proxy pnpm --filter @kumiai/hub-store run test:unit test/conformance.test.ts
rtk proxy pnpm --filter @kumiai/integration-tests run test
rtk proxy pnpm change status
rtk proxy pnpm run check:versions
rtk proxy pnpm run lint
git diff --check
```

Expected: PASS. Missing database infrastructure leaves the gate incomplete. No skipped suite is evidence of correctness.

- [ ] **Step 3: Check scope and staged API claims.** Confirm no registry adapter, recovery caller migration, package hook/burn, target/capture persistence or broad safety implementation slipped into this core gate.
- [ ] **Step 4: Record gate results.** Report actual commands/results and remaining 2.2c/d/e/2.3 obligations. Claim only scoped registry conformance.
- [ ] **Step 5: Commit.** Commit `chore(registry): record scoped registry release intent and gate`.

## Revision log

The tables record plan corrections and assigned verification, not completed implementation or passing tests. Revision 1 entries use final task numbers and reflect superseding Revision 2 rulings.

### Revision 1

| Finding | Resolution |
| --- | --- |
| sol C1 | Fixed: Task 9 retire hooks drain outside slots; Task 13 fails every uncertified entry after drainage under later N4; Task 20 scans every incarnation. |
| sol C2 | Fixed: Task 17 reuses full authoritative judgment and retained eligibility, with five bound-group negative tests. |
| sol C3 | Ruled by later N1: Tasks 15/21 retain seed entry proof, preserve marker uncertainty and refuse fresh spent Welcomes. No public seed mutationID or receipt. |
| sol I1 | Fixed: Task 1 prepare returns expected; one entry spans prepare/work; reads do not advance revisions. |
| sol I2 | Fixed: metadata retains actual fields; source uses trust.installed; guarded diagnostic opens never authorise state use. |
| sol I3 | Ruled USER scope: no build/adoption consumer migration or nested registry adapter here; ownership explicitly moves it to 2.2d. |
| sol I4 | Fixed: Task 9 attempt/generation state machine covers every noncommit, proof and competing/cold race. |
| sol I5 | Fixed: Tasks 10-11 separate all-transition accounting from after-release FIFO runtime listener dispatch. |
| sol I6 | Fixed: Tasks 3/8 share owner/anchor/suite/options/retention validation for cold and installations. |
| sol I7 | Fixed for core: Task 12 carries ordinary progress and requires proof-backed noop; consumer migration stays 2.2d. |
| sol I8 | Fixed: Task 18 restricted write, explicit anchor/control/cursor and inherited-destination-field refusal witness; target storage stays 2.2d. |
| sol I9 | Fixed: Tasks 4-6 separate model semantics, owner-matched structural fixture/fault reconstruction and real wire artifacts. |
| sol I10 | Fixed in plan: Task 6 specifies exported-API vector reordering and two processWelcome calls. Actual unequal-byte/equal-authenticator verification remains an implementation step. |
| sol I11 | Fixed: Task 14 separates spent refusal from receipt-only alreadyJoined; mls-hub tests stay in package. |
| sol I12 | Fixed: named phase/mutation/race/event/delivery/restart witnesses in Tasks 1/9/15/18-21 isolate the intended rules. |
| sol I13 | Fixed: replace === true, typed seed refusals, malformed active metadata unavailable, and non-genesis packageUse required. |
| sol I14 | Fixed: packageUse validated/staged only; no provider hook or burn guarantee in 2.2b. |
| sol M1 | Fixed: USER ownership moves wiring to 2.2d; m4 claim narrowed to Welcome retirement only. |
| sol M2 | Fixed: checked spec switch rows, complete binder signature and actual void/AggregateError Welcome helper semantics. |
| opus C1 | Fixed: Task 1 one-slot prepared CAS; caller Read→run drift refusal only for explicit expectations. |
| opus C2 | Fixed: Task 19 full first-valid Welcome gate before release, including retained slot and matching recheck. |
| opus I1 | Fixed: current identity from trust, real metadata fields, separate readability diagnostic. |
| opus I2 | Fixed: Task 1 explicit snapshot/read binding and expiry instead of unchanged prepare reuse. |
| opus I3 | Fixed: exact normative mls-hub judgment signature/location; no dependency cycle. |
| opus I4 | Fixed under later N1: typed seed refusal, retained-entry proof, superseded-marker uncertainty and unused-W3/W5 admission fixture. |
| opus I5 | Fixed: constructible public alternate Welcome fixture plus distinct-handle same-authenticator double test. |
| opus I6 | Fixed: attempt-owned fences lift on noncommit; prior admitted entries retain FIFO; cold generation checks. |
| opus I7 | Fixed under later N1/N2: Task 18 joins pending proof and uses exact retained adopted rejoin before fence/source/spent checks. Identity alone never proves replay. |
| opus I8 | Fixed: shared retirement Task 13 precedes seed/switch and orders source writes before lifetime.save. |
| opus I9 | Fixed: persisted sealed verdict opened with requestKey; full retained bound eligibility reused. |
| opus I10 | Ruled USER scope: no registry HandleAccess adapter or registry-adapter GroupMLS runner; consumers stay simple until 2.2d. |
| opus I11 | Ruled USER scope: build/adoption orchestration and held retry migration explicitly assigned to 2.2d. |
| opus I12 | Fixed core persist semantics: Task 12 stages one final save. Open/pending interception explicitly deferred to 2.3. |
| opus I13 | Fixed: production recoveryTrustFor in Task 3, used by epoch mutation/seed/switch without structuredClone. |
| opus I14 | Fixed: ownership amended, retention >=1000 owned here, m4 recovery slot migration stays 2.2d. |
| opus I15 | Fixed: Task 5 owns portable mirrors and concrete assembly/faults; Task 4 supplies real model-backed handles; both modes exercise the same refusals. |
| opus I16 | Fixed: candidate/accounted facts may be computed before commit, published only on proof. No restore inside hook. |
| opus I17 | Fixed: immutable record cache by key/version; isolated callback handles; rollback/pending proof never promote mutation. |
| opus I18 | Fixed in Revision 2: Tasks 2-3 separate retention from validation/trust; Tasks 4-6 separate double, assembly and wire fixtures; Tasks 7/10/11 separate admission, observation and runtime. |
| opus I19 | Fixed: prepare waits behind committed-but-unsettled earlier entry. |
| opus m1 | Fixed: checked spec interface and switch conformance citations. |
| opus m2 | Fixed: canonical GroupControlUnsettledError; core deletion owns drain/re-drain/three-attempt behaviour now. |
| opus m3 | Fixed: Task 7 widens SendNotAdmissibleError with SendAdmission before cold/runtime consumers. |
| opus m4 | Fixed: remove undisposed-peer/network guarantee; hooks own transport drain and fixed old ports remain serviceable. |
| opus m5 | Fixed: packageUse has no provider handoff; staging and 2.3 burn boundary explicit. |
| opus m6 | Fixed: rollback spent, restart alternate replay, stable event ack and delete-effect witnesses named. |
| opus m7 | Fixed: tombstone installation performs no active-source retirement. |
| opus m8 | Fixed: initial committed runtime fields and available definition specified in Task 8. |
| opus m9 | Fixed: Task 8 types/README document internal coordinator registration and unsupported wrapper refusal. |
| opus m10 | Fixed: pure live-null epoch refuses; registry current epoch comes from installed trust despite lost private bytes. |
| opus m11 | Superseded by N2: Task 13 keeps the switched adopted row and ledgerBefore. Bootstrap/reenact settlement and deletion remain 2.2d. |

### Revision 2

Binding rulings N1-N4 and I18 take precedence over earlier conflicting resolutions. In particular, N4 replaces revise.md item 10.

| Re-review finding | Resolution in this plan |
| --- | --- |
| opus N1 | Removed R13 and the installation-receipt task/namespace. Task 15 uses normative seed without mutationID and retained-entry proof. External superseded-marker resolve throws GroupStateUncertainError. Access recovers the current key; fresh seed refuses spent. Task 18 replays exact adopted evidence. |
| sol N1 | Removed the receipt infrastructure rather than claiming its raw transaction scope/immutability was repaired. No new namespace or EntryWork surface remains. Ordinary package receipts remain explicitly 2.3. |
| opus N2; sol N3 | Task 13 changes the switched rejoin only to adopted and retains ledgerBefore/candidate/request/proof fields. Tasks 18/21 reopen with a missing ledger token and assert durable continuation, no invented outcome or enqueue. Actual bootstrap, ordered reenact outcome, acknowledgement and adopted-row cleanup belong to 2.2d. |
| opus N3 | R1/R2 and Tasks 1/8 preserve a shared database/coordinator token across wrappers. The singleton keys that token. The named negative creates two device factories over one database and refuses the second registry. |
| opus N4 | R10 and Task 13 follow N4: drainage precedes failure of every uncertified entry, including attempted entries. Failed data/status survives in stable incarnation-abandoned events; failed rows are removed. Certified rows/settlements remain untouched. Task 20 specifies active-entry deletion, no old uncertified entries after switch, and existing certified settlement instead of handoff/abandon APIs. |
| sol N2 | R16 and Task 12 compare decoded journal destination epoch/authenticator/own credential/anchor/complete state before carry. No pre-carry progress differences are permitted. Both fixture modes retain accepted A and supply branch B to adopt/replace, refusing before any save/seal and preserving rows/version/trust. |
| opus N5 | Explicit staged-signature table assigns restricted switch/consumer reconciliation to 2.2d and full factory/crypto/startup parity to 2.3. Mirrors describe this core subset. Seed now exactly matches r18. |
| opus N6 | Task 1 Step 2 now includes build:js/build:types and rpc-conformance test:types, alongside mls-rpc types and focused tests. Step 4 repeats those commands. |
| opus N7; sol I12 residual | Task 18 constructs revision-only drift through an owed-Welcome deletion on retired n-1. Active version/identity/trust remain unchanged and prepared CAS is fresh. Removing only the caller revision guard must fail the refusal assertion. |
| opus N8 | Separate Task 7 admission/error widening, Task 10 coordinator observation/afterRelease, and Task 11 internal projection/runtime publication, each with its own test cycle. |
| opus N9; sol I8 residual | Removed the earlier blanket all-resolved claim. Task 18 names untyped inherited-destination-row refusal and candidate-progress association witnesses. This log distinguishes plan tests from completed implementation and deferred guarantees. |
| opus N10 | Task 11 owns runtime-facts inside mls-rpc. No public @kumiai/mls runtime export or helper is proposed. Existing public GroupOptions gains only the normative retention option. |
| opus N11 | Task 5 labels RegistryFixtureBase/MemoryTransaction/MemoryStoreRows as concrete mls-rpc fixture types. Portable rpc-conformance mirrors use structural/generic types and parity checks without implementation imports. |
| opus I18; sol re-review I18 and Task 2/3 sizing | Tasks 2/3 and 4/5/6 provide independent retention, validation/trust, model handle/exporter, assembly/reopen/faults and wire artifact deliverables. Receipt work is removed. Task numbers, dependencies, ownership, Review Focus and release intent match the final decomposition. |

Prior Critical/Important findings and prior Minors remain individually mapped in Revision 1. Sol reported no new Minor findings. All eleven new Opus findings have explicit resolutions above. Cryptographic fixture execution and production 2.2d/2.3 integration are prescribed future work, not claims made by this revision.

### Revision 3 (controller)

| Finding | Resolution |
| --- | --- |
| opus re-review 2 NEW-1 | Factory adds `restoreCandidate`; Task 12 decodes `journal.candidate` only through it and adds the undecodable-candidate negative in both modes. |
| M1 | stateVersion() marked normative (spec `:668`). |
| M2 | Task 5 adds Welcome-history and verdict fixture self-tests. |
| M3 | Removed the delete-after-adopted-continuation test needing a non-existent retired write. |
| M4 | Retired certified-settlement publication is 2.3; delete refuses until it completes. |
| M5 | Dropped the isolated anchor variant. |
| M6 | Lapse/membership rules extracted into one exported @kumiai/mls helper; no copy. |
