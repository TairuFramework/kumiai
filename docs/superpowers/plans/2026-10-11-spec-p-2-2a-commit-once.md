# Spec P 2.2a Commit-once Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist one private control build per source epoch and adopt or release its Welcome only after proving first-valid acceptance.

**Architecture:** RPC owns the durable slot, prefix search and operation runner. The MLS adapter supplies retained source validation and guarded build/adoption through the existing single-handle access boundary. Registry ownership replaces that boundary in 2.2b. Network work and crypto preparation remain outside provider transactions.

**Tech Stack:** TypeScript, pnpm 12.10.1, Vitest, ts-mls 2.0.0-rc.13, Web Crypto, existing MLS v2 codecs and transactional memory persistence.

**Spec:** [docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md](../specs/2026-10-08-spec-p-transactional-persistence.md), **r18**, binding. D4 supersedes conflicting [P2a](../specs/2026-10-08-spec-p2a-crash-safe-control-design.md) operation rules.

Starting point: `feat/spec-p-phase-2`, `89eedeb`. Line citations below refer to this HEAD. This document authorises no execution during drafting.

## Global Constraints

- “pnpm only.” Run scripts as `rtk proxy pnpm run <script>` and package scripts as `rtk proxy pnpm --filter <package> run <script>`.
- Vitest strips types. Pair every Vitest run, including red and mutation runs, with the package's `test:types`.
- Before tests import changed sibling exports, run `rtk proxy pnpm turbo run build:js build:types`. Imports resolve through generated package barrels.
- Any breaking type change requires `rtk proxy pnpm turbo run test:types`, without `--filter`.
- A test double may be stricter than its port, never more permissive.
- “Changing a port means running **both** contract suites against the real implementation and the doubles”. See `docs/agents/architecture.md:21-24`.
- “Do not edit generated files (`lib/`).” Builds may regenerate them. Never hand-edit or stage generated output.
- “Cross-repo deps (`@sozai/*`, `@kokuin/*`, `@enkaku/*`) go through the workspace catalog as published `^` ranges, never `workspace:`. Internal `@kumiai/*` deps are `workspace:^`.”
- “All dev tooling and shared configs come from `@kigu/dev`.” Preserve scripts and tooling configuration.
- Record release intents through `rtk proxy pnpm change`, using `.changeset/` files. Use pnpm versioning, never `@changesets/cli`.
- “twelve packages share one version band (same minor pre-1.0, same major from 1.0); raising it is a group act, but a patch release within the band is not.” The current band intent names fourteen published packages.
- For test-quality-critical guards, break the guard, confirm its test fails, restore it, then rerun the paired checks.
- Lint before every staging step: `rtk proxy pnpm run lint`.
- Every commit passes `rtk proxy pnpm turbo run build:js build:types test:types` and its task's regression checks.
- “Every factory requires host `AtRestCodec.seal/open(bytes, aad)`.” Reuse existing factories and host keys.
- “Memory persists sealed bytes without a plaintext shadow map.” Retained validation material belongs inside sealed control storage.
- “AAD is UTF-8 JSON of `['kumiai/at-rest/v1', groupID, incarnationOrNull, namespace, recordID]`”. Preserve existing address binding.
- “Expected null means absent lifetime, never a tombstone.” Preserve version, identity, progress and spent-authenticator guards.
- “Stores are group-bound and expire with the callback.” Transaction-bound methods acquire no second gate or transaction.
- “signerTree contains public nodes only, never retained private ratchets.” Private validation snapshots belong in the control journal, never recovery trust.
- “Refuse every v1 blob: absence and lost zero are indistinguishable.” Source and candidate MLS state use the existing v2 codec.
- “Retry barrier/read failures from 100 ms doubling to 15 s, outside transactions; other groups continue.” Preserve D8 completion ownership.
- “Phase 2 creates no client/messaging/MessageStore/Hozon provider/child driver; use opaque side rows for handler/status conformance.”
- **Runtime baseline:** ES2022 built-ins. No `node:` imports, `AsyncLocalStorage`, `structuredClone`, `Promise.withResolvers`, `isWellFormed`, `toWellFormed`, `throwIfAborted`, `AbortSignal.any`, `AbortSignal.timeout`, `setImmediate`, `process`, `Buffer`, disposal symbols or `using` in scoped `src`.
- **Host whitelist:** `WeakMap`, `WeakSet`, `queueMicrotask`, timeout/interval timers, `TextEncoder`, `TextDecoder`, `ReadableStream`, `WritableStream`, `CountQueuingStrategy`. AbortController permits constructor/signal/abort. AbortSignal permits aborted/reason/addEventListener/removeEventListener. Crypto permits getRandomValues/subtle/randomUUID.
- **Optional capabilities:** `Float16Array`, `SharedArrayBuffer`, `Atomics` require the `typeof` presence/absence guards specified in plan 2.1d. Absence remains correct.
- **Supported hosts:** Node ≥20, secure-context evergreen browsers, Hermes with Web Crypto and TextEncoder/TextDecoder polyfills. Syntax lowering belongs to the bundler.
- **Runtime guard:** `packages/mls-rpc/test/runtime-neutral.test.ts` covers `mls-rpc`, `mls`, `rpc`, `broadcast`, `hub-client`, `hub-protocol`, `hub-tunnel`, `mls-hub`, `rpc-conformance` source. Preserve both symbol/type and name checks.

## Review Focus

- A source version changes during preparation: save must refuse without publishing or preparing replacement bytes. Task 2: `built-save rejects a source or queue move`.
- A match shares a page with a gap, or lies after an invalid build checkpoint: no acceptance or Welcome escapes. Task 3: `match never bypasses checkpoint or page gaps`.
- Sender-data authentication names us but the payload differs: do not equate `own-unmerged` with acceptance. Task 3: `unexplained own bytes hold without adoption or automatic healing`.
- A revoke drain crosses the exact deadline: no subsequent network handoff occurs. Task 4: `expiry during submission drain prevents handoff`.
- An accepted candidate outlives opens, seals and history eviction: adoption preserves current progress after reconstruction. Task 5: `accepted restart carries current progress without resurrecting history`.

## Phase-2.2 ownership

This table replaces the 2.1 table's 2.2 decomposition and moves registry core from 2.3 into 2.2b. Each item has one delivery owner.

| Spec item | Sole owner | Delivery boundary |
| --- | --- | --- |
| D4 private commit-once slot, BuiltCommit/HostBuilt, immutable searchFrom, deadline and FIFO runner | 2.2a | Tasks 1, 2, 4, 6 |
| FirstValidCommit, CommitSearchResult, ControlSearchPort and accepted-stage proof | 2.2a | Tasks 3-6, including full-prefix competitor validation and own-unmerged settlement |
| Control build-save/adoption source guards and removal of control lineage | 2.2a | Single-incarnation staging below. No registry construction |
| Empty control proposals, rotation builder's empty-proposal refusal, ordinary adoption progress carry | 2.2a | Tasks 2 and 5. Rotation scheduling remains 2.3 |
| First-valid Welcome release and commit-once crash/conformance rows | 2.2a | Tasks 4-7. Invitee package consumption remains 2.3 |
| Registry core: createGroupHandleRegistry, access, seed, judgeWelcomeAdmission, recoverySource, switchIncarnation, delete/dispose | 2.2b | Replaces the single-incarnation runtime staging with lifetime ownership and real versions |
| Incarnations, spent admission, stopped/drained switch and retained old-incarnation obligations | 2.2b | Old outcomes/Welcomes stay addressable. No old peer restarts |
| GroupSafety except recover, durable fork halt/evidence/events and recovery-unavailable hold | 2.2c | Both classifier branches, all send/open/control/startup gates, event acknowledgement |
| Removal of automatic fork healing, forkSettlement and deleteAppliedFrom | 2.2c | Replaces existing fork-healing tests with durable-halt assertions |
| captureHead recovery reply v2 and authenticated target propagation | 2.2d | Signed string/null head, v2 domains, exact initial CAS and retained external attempt |
| Trust-based recovery, stranded reconciliation and confirmed incarnation switch orchestration | 2.2d | Uses 2.2b switch and 2.2a validation concepts, with external-attempt rules |
| Removal of sourceRecheck, SourceScan and conflictEpoch | 2.2d | Removes structural source-prefix recovery approval |
| GroupSafety.recover, ManualRecoveryRecord, selected target and successor retirement | 2.2e | Persist authorisation, resume selected attempt, retain halt on failure |
| Batching, handlers, leases/rotation scheduling, package adapters, atomic Welcome burn, restore-work, settlements/events, registry consumer adapters | 2.3 | Remains runtime follow-up. Core registry ownership is excluded |
| Hub-client lifts, MLSEncryptor, final full contracts and real HTTP smoke | 2.4 | Unchanged |

The new search holds on fork evidence and cannot request automatic recovery. Full durable D1 halt and machine-readable events remain 2.2c.
Do not claim that 2.2a completes fork safety, resync, registry persistence conformance or terminal handler draining.

## Verified premises and placement

| Premise checked at HEAD | Consequence |
| --- | --- |
| `rpc/src/control/operations.ts:173` saves before publish, but `:198` resets absent builds and `:101` deletes them on settlement | Separate the slot from operation lifetime. Rewrite these transitions |
| `rpc/src/peer.ts:2128-2136` checks matches before gaps and performs no MLS validation | Replace private-control search, not just its return type |
| `rpc/src/classify.ts:255-289` classifies history/forks/own-unmerged. It does not validate commit content | Never use classifier disposition as first-valid proof |
| `mls-rpc/src/apply-commit.ts:87-92` refuses own commits. `:113-129` invokes normal MLS processing but folds most failures into refusal | Competitors use normal processing. Saved own builds use their validated construction and exact full bytes. Preserve unavailable-input diagnostics |
| `mls-rpc/src/mls.ts:285-290` returns epoch/authenticator and constant lineage 0 | **False premise:** an existing runtime incarnation/version source already exists |
| `mls-rpc/src/access.ts:12-38` has neither key nor stateVersion. `:43-54` already serialises access | Extend this boundary minimally. Do not create a registry or another group ownership queue |
| `rpc/test/fixtures/host-db.ts:103` exposes loadVersion. `mls-rpc/test/fixtures/transactional-access.ts:29,124` stores/checks revision | Real versions are available from hosts, not from readEpoch or lineage |
| `mls-rpc/src/persistence-types.ts:17-43` already defines GroupKey, EpochIdentity and versioned state | RPC uses dependency-neutral structural types. mls-rpc re-exports these shared identities without introducing a reverse import |
| `mls/src/group-commit.ts:279-281` already defaults pending proposals to empty. `group-lifecycle.ts:76` deliberately commits self-removal references | Make control choices explicit. Preserve the separate self-removal API |
| No exported commitKeyRotation exists. `mls-rpc/test/fixtures/real-group.ts:36` bypasses the desired guard with createCommit | Add the D4/D5 pure rotation primitive now. Scheduling/lease integration stays 2.3 |
| `mls/src/group-handle.ts:912-944` already carries sender/receiver trees and deletes evicted history | Reuse it under adoption ownership, including for a staged competitor |
| `rpc/src/peer.ts:2711` delegates external search to operationDeps.searchLog | Extract the old external occurrence search before changing private-control semantics |
| `rpc/src/control/store.ts:31` and `rpc-conformance/src/memory-control-store.ts:52` independently reduce control changes | Update both. Conformance must not reuse the implementation reducer |

All paths in this table are relative to `packages/`.

### Interface staging and task order

Task 1 adds `HandleAccess.readControl`, using the existing access serialiser. Its callback receives the current handle and an atomic source snapshot.
`SimpleHandleAccessParams` adds `key?: GroupKey` and required `stateVersion: () => number | Promise<number>`.
An omitted key means `{groupID: handle.groupID, incarnation: 1}` for this single-incarnation access only. No state-version default is allowed.

`GroupMLS.readRecoverySource()` becomes `Promise<ControlSource>` in 2.2a, where `ControlSource = AdoptionExpected & {epoch: number; authenticator: Uint8Array}`.
The MLS adapter sources **key/incarnation** from the access configuration, **epoch/authenticator** from the gated handle, and **stateVersion** from the host callback.
The ordinary host fixture uses `MemoryHostDatabase.loadVersion(groupID)`. Transactional access uses its gated stored `revision`.
Memory MLS uses its host database version, or an explicit in-memory version when no durable host exists.
Reconstruction reloads that version. Never increment a counter merely because search ran, and never substitute the epoch for a version.

2.2b replaces the configured incarnation with `RegistryHandleAccess.key`, and the callback with its committed `stateVersion()`.
It replaces the staged recovery source with normative `RecoverySource`, adding retained trust and lifetimeRevision from registry recoverySource.
2.2d consumes those trust fields and removes the remaining legacy source scan.
This plan removes lineage from BuiltCommit, HostBuilt, expected adoption, readRecoverySource and RejoinRecord/SourceScan mirrors.
The temporary rejoin source retains epoch/authenticator/head and uses key/incarnation instead of lineage. Its algorithm remains 2.2d's responsibility.

Tasks 1-3 add tested contracts and components without activating a partial first-valid runner. Task 4 switches the runner and required accepted shape together.
Task 5 strengthens the adoption/delivery boundary. Task 6 adds reconstruction/shared contracts. Task 7 records the release and runs the complete gate.

---

### Task 1: Source identity and an independently retained control slot

**Files:**
- Modify: `packages/rpc/src/control/types.ts:4-161`, `packages/rpc/src/control/store.ts:31-98`, `packages/rpc/src/crypto.ts:427`, `packages/rpc/src/control/operations.ts:24-60`, `packages/rpc/src/control/rejoin.ts:16-48`, `packages/rpc/src/index.ts:38-64`.
- Modify: `packages/mls-rpc/src/access.ts:12-105`, `packages/mls-rpc/src/mls.ts:285-290`, `packages/mls-rpc/src/revoke.ts:60`, `packages/mls-rpc/src/persistence-types.ts:17-19`, `packages/mls-rpc/src/memory-incarnation-stores.ts:154-162`, `packages/mls-rpc/src/memory-group-ports.ts`.
- Modify mirrors/fixtures: `packages/rpc-conformance/src/control-store.ts`, `packages/rpc-conformance/src/group-mls.ts`, `packages/rpc-conformance/src/memory-control-store.ts`, `packages/rpc-conformance/src/index.ts`, `packages/rpc/test/fixtures/host-db.ts`, `packages/rpc/test/fixtures/memory-group-mls.ts`, `packages/rpc/test/fixtures/peer.ts`, `packages/mls-rpc/test/fixtures/transactional-access.ts`, `packages/mls-rpc/test/fixtures/real-group.ts`, `tests/integration/test/app-lane-e2e.ts`.
- Test: `packages/rpc/test/control-store.test.ts`, `packages/rpc/test/control-store-conformance.test.ts`, `packages/mls-rpc/test/adoption-write.test.ts`, `packages/mls-rpc/test/group-namespaces.test.ts`.
- Mechanical type consumers: `packages/rpc/test/control-operations.test.ts`, `packages/rpc/test/peer-rejoin-record.test.ts`, `packages/rpc/test/peer-fork-settlement.test.ts`, `packages/rpc/test/peer-readmission.test.ts`, `packages/rpc/test/peer-control-retry.test.ts`, `packages/rpc/test/group-mls-adoption.test.ts`, `tests/integration/test/operation-host.test.ts`, `tests/integration/test/recovery-confirmation.test.ts`, `tests/integration/test/anchor-rotation-recovery.test.ts`, `tests/integration/test/epoch-log-delivery.test.ts`, `tests/integration/test/lifecycle-admission.test.ts`, `tests/integration/test/history-frame-size.test.ts`.

- Mechanical access consumers: `packages/mls-rpc/test/crypto.test.ts`, `packages/mls-rpc/test/durable-save-order.test.ts`, `packages/mls-rpc/test/readme-persistence.test.ts`, `packages/mls-rpc/test/persist-boundary.test.ts`, `packages/mls-rpc/test/transactional-access.test.ts`, `packages/mls-rpc/test/ports-conformance-transactional.test.ts`, `packages/mls-rpc/test/recovery-codec.test.ts`, `packages/mls-rpc/test/commit-topic-proposal.test.ts`, `packages/mls-rpc/test/commit-pre-resolution.test.ts`, `packages/mls-rpc/test/handle-access.test.ts`, `packages/mls-rpc/test/ports-conformance.test.ts`, `packages/mls-rpc/test/recovery-secret.test.ts`, `packages/mls-rpc/test/epoch-results.test.ts`, `packages/mls-rpc/test/recovery-holder-evidence.test.ts`, `packages/mls-rpc/test/standalone-helpers.test.ts`, `packages/mls-rpc/test/fixtures/codec-reopen.ts`, `tests/integration/test/app-lane-delivery.test.ts`, `tests/integration/test/peer-drained-wire.test.ts`, `tests/integration/test/recovery-known-registry.test.ts`.

**Interfaces:**
- Consumes: `ControlStore.load(): Promise<ControlSnapshot>`, `apply(changes: ControlChanges, mutationID: string): Promise<void>`, `lastMutation(): Promise<string | null>`.
- Produces in `rpc/src/control/types.ts`:

```ts
type GroupKey = { groupID: string; incarnation: number }
type EpochIdentity = GroupKey & { epoch: number; authenticator: Uint8Array }
type AdoptionExpected = { key: GroupKey; stateVersion: number; identity: EpochIdentity | null }
type ControlSource = AdoptionExpected & { epoch: number; authenticator: Uint8Array }
type BuiltCommit = {
  incarnation: number; epoch: number; authenticatorBefore: Uint8Array
  publishID: string; searchFrom: LogPosition | null; expectedHead: LogPosition | null
  payload: Uint8Array; payloadDigest: string; digest: string; bodies: Array<string>
  journal: Uint8Array; welcome: { bytes: Uint8Array; recipients: Array<string> } | null
}
type FirstValidCommit = {
  source: AdoptionExpected; from: LogPosition | null; position: LogPosition; payloadDigest: string
}
type CommitSearchResult =
  | { kind: 'first-valid'; proof: FirstValidCommit }
  | { kind: 'superseded'; winner: LogPosition }
  | { kind: 'absent' } | { kind: 'unknown' }
type ControlSearchPort = { searchLog(built: BuiltCommit, position?: LogPosition): Promise<CommitSearchResult> }
type HostBuilt = Pick<BuiltCommit,
  'incarnation' | 'epoch' | 'authenticatorBefore' | 'digest' | 'bodies' | 'journal' | 'welcome'
> & { commit: Uint8Array }
```

- Produces required `ControlStore.key: GroupKey`, `ControlSnapshot.commitOnce: BuiltCommit | null`, optional `ControlChanges.commitOnce?: BuiltCommit | null`, and `StagedAdoption.incarnation: number`.
- Produces optional `AdoptionWrite.expected?: AdoptionExpected`. Private-control adoption requires it. The host rechecks it inside the save transaction.
- Produces `HandleAccess.readControl<TValue>(fn: (handle: GroupHandle, source: AdoptionExpected) => Promise<TValue>): Promise<TValue>` and `GroupMLS.readRecoverySource(): Promise<ControlSource>`.
- Control rows, responses, cursor and outcomes are bound by their fixed `ControlStore.key`/incarnation namespace. Never resolve a row through a different active key.

- [ ] **Step 1: Write slot and source tests.** Use existing typed fixtures, with key `{groupID: 'group-A', incarnation: 1}`.

`slot survives operation deletion outcome acknowledgement and reopen`:

```ts
expect(afterAck.commitOnce).toEqual(savedBuilt)
expect(afterAck.operations).toEqual([])
expect(afterAck.outcomes).toEqual([])
expect(reopened.commitOnce).toEqual(savedBuilt)
expect(afterCallerMutation.commitOnce).toEqual(savedBuilt)
```

`readControl returns the host version and a defensive single-incarnation identity`:

```ts
expect(source.key).toEqual({ groupID: 'group-A', incarnation: 1 })
expect(source.stateVersion).toBe(await hostDB.loadVersion('group-A'))
expect(source.identity?.authenticator).toEqual(authenticator)
expect(source).not.toHaveProperty('lineage')
expect(staged.incarnation).toBe(1)
```

Add rollback and explicit `commitOnce: null` round-trips to the shared control-store suite. Absence of a change field preserves the slot.

- [ ] **Step 2: Run red checks.**

```sh
rtk proxy pnpm --filter @kumiai/rpc run test:types
rtk proxy pnpm --filter @kumiai/rpc run test:unit test/control-store.test.ts test/control-store-conformance.test.ts
rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/adoption-write.test.ts test/group-namespaces.test.ts
```

Expected: missing source/slot declarations or missing retained slot assertions fail. No synthetic first-valid proof is introduced.

- [ ] **Step 3: Implement the listed declarations and source mapping in their named files.**

Initialise every empty control snapshot with `commitOnce: null`. Copy nested slot values defensively in both independent reducers.
Expose memory persistence's already-fixed `ports(key).key` on its control facade. Give legacy stores an explicit constructor key.
Update host fixtures and conformance mirrors atomically with the type changes. Existing build framing sets `searchFrom = expectedHead` once.
Retain the old accepted shape until Task 4. Add proof types now without manufacturing proof for the old runner.
Mechanically replace legacy rejoin lineage equality with key/incarnation equality. Do not remove sourceRecheck, conflictEpoch or fork settlement here.

- [ ] **Step 4: Run green checks.** Run Step 2 after `rtk proxy pnpm turbo run build:js build:types test:types`.

Expected: all PASS, including existing rejoin source-identity assertions after their mechanical migration.

- [ ] **Step 5: Mutation-check slot retention.** Temporarily clear commitOnce on deleteOutcomes. Run Step 2's RPC pair.

Expected: `slot survives operation deletion outcome acknowledgement and reopen` FAILS. Restore the guard and rerun to PASS.

- [ ] **Step 6: Commit the source/slot contract.**

Run: `rtk proxy pnpm run lint`, then `git add -- packages/rpc/src/control/types.ts packages/rpc/src/control/store.ts packages/rpc/src/crypto.ts packages/rpc/src/control/operations.ts packages/rpc/src/control/rejoin.ts packages/rpc/src/index.ts packages/mls-rpc/src/access.ts packages/mls-rpc/src/mls.ts packages/mls-rpc/src/revoke.ts packages/mls-rpc/src/persistence-types.ts packages/mls-rpc/src/memory-incarnation-stores.ts packages/mls-rpc/src/memory-group-ports.ts packages/rpc-conformance/src/control-store.ts packages/rpc-conformance/src/group-mls.ts packages/rpc-conformance/src/memory-control-store.ts packages/rpc-conformance/src/index.ts packages/rpc/test/fixtures/host-db.ts packages/rpc/test/fixtures/memory-group-mls.ts packages/rpc/test/fixtures/peer.ts packages/mls-rpc/test/fixtures/transactional-access.ts packages/mls-rpc/test/fixtures/real-group.ts tests/integration/test/app-lane-e2e.ts packages/rpc/test/control-store.test.ts packages/rpc/test/control-store-conformance.test.ts packages/mls-rpc/test/adoption-write.test.ts packages/mls-rpc/test/group-namespaces.test.ts packages/rpc/test/control-operations.test.ts packages/rpc/test/peer-rejoin-record.test.ts packages/rpc/test/peer-fork-settlement.test.ts packages/rpc/test/peer-readmission.test.ts packages/rpc/test/peer-control-retry.test.ts packages/rpc/test/group-mls-adoption.test.ts tests/integration/test/operation-host.test.ts tests/integration/test/recovery-confirmation.test.ts tests/integration/test/anchor-rotation-recovery.test.ts tests/integration/test/epoch-log-delivery.test.ts tests/integration/test/lifecycle-admission.test.ts tests/integration/test/history-frame-size.test.ts packages/mls-rpc/test/crypto.test.ts packages/mls-rpc/test/durable-save-order.test.ts packages/mls-rpc/test/readme-persistence.test.ts packages/mls-rpc/test/persist-boundary.test.ts packages/mls-rpc/test/transactional-access.test.ts packages/mls-rpc/test/ports-conformance-transactional.test.ts packages/mls-rpc/test/recovery-codec.test.ts packages/mls-rpc/test/commit-topic-proposal.test.ts packages/mls-rpc/test/commit-pre-resolution.test.ts packages/mls-rpc/test/handle-access.test.ts packages/mls-rpc/test/ports-conformance.test.ts packages/mls-rpc/test/recovery-secret.test.ts packages/mls-rpc/test/epoch-results.test.ts packages/mls-rpc/test/recovery-holder-evidence.test.ts packages/mls-rpc/test/standalone-helpers.test.ts packages/mls-rpc/test/fixtures/codec-reopen.ts tests/integration/test/app-lane-delivery.test.ts tests/integration/test/peer-drained-wire.test.ts tests/integration/test/recovery-known-registry.test.ts`.
Expected: clean lint and no unrelated staged changes.
Run: `git commit -m "feat(control): add source identity and retained commit-once slot"`.
Expected: one green contract commit.

### Task 2: Guarded preparation and retained MLS validation material

**Files:**
- Create: `packages/rpc/src/control/build.ts`, `packages/mls-rpc/src/control-build.ts`, `packages/mls-rpc/src/control-journal.ts`, `packages/mls/src/group-rotation.ts`.
- Modify: `packages/rpc/src/index.ts`, `packages/mls-rpc/src/index.ts`, `packages/mls/src/index.ts`, `packages/mls/src/group-commit.ts:160-341`, `packages/mls-rpc/src/revoke.ts:36-63`.
- Modify fixtures: `packages/rpc/test/fixtures/host-db.ts`, `packages/rpc/test/fixtures/peer.ts`, `packages/rpc/test/fixtures/memory-group-mls.ts`, `packages/mls-rpc/test/fixtures/transactional-access.ts`, `tests/integration/test/app-lane-e2e.ts:291-340`.
- Modify: `packages/mls/src/group-lifecycle.ts`, `packages/mls/src/group-device.ts`, `packages/mls-rpc/src/memory-incarnation-stores.ts`, `packages/mls-rpc/src/memory-group-ports.ts` for explicit builder options and slot guards.
- Create/Test: `packages/mls-rpc/test/control-build.test.ts`, `packages/mls/test/group-rotation.test.ts`.

**Interfaces:**
- Consumes: Task 1 `HandleAccess.readControl`, `BuiltCommit`, `HostBuilt`, `AdoptionExpected` and `ControlStore.key`.
- Produces:

```ts
type FrameControlBuild = (built: HostBuilt, seal: GroupCrypto['sealEntries']) => Promise<{
  payload: Uint8Array; publishID: string; expectedHead: LogPosition | null
}>
type ControlBuildPort = {
  prepareBuild(op: Operation, frame: FrameControlBuild): Promise<Operation | null>
}
type SaveControlBuild = (op: Operation & { stage: 'built' }, expected: AdoptionExpected,
  mutationID: string) => Promise<'saved' | 'moved' | 'occupied'>
function createPersistenceBuildSaver<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>; key: GroupKey
}): SaveControlBuild
function createControlBuildPort(params: {
  access: HandleAccess; control: ControlStore
  build: (op: Operation, group: GroupHandle) => Promise<HostBuilt>
  saveBuilt: SaveControlBuild; now: () => number; operationTimeoutMs: number; newID: () => string
  entryLabel?: string; runtime?: Runtime
}): ControlBuildPort
type ControlJournal = {
  version: 1; source: AdoptionExpected; sourceState: Uint8Array
  sourceCredential: MemberCredential; sourceLedger: Array<string>; candidate: Uint8Array
}
function encodeControlJournal(value: ControlJournal): Uint8Array
function decodeControlJournal(bytes: Uint8Array): ControlJournal
type CommitKeyRotationResult = { commitMessage: Uint8Array; newGroup: GroupHandle; epoch: bigint }
function commitKeyRotation(group: GroupHandle): Promise<CommitKeyRotationResult>
```

`FrameControlBuild` and `ControlBuildPort` live in RPC. The factory and journal codec live in mls-rpc.
createPersistenceBuildSaver lives in control-build.ts and uses the existing 2.1 transition API, without constructing a registry.
The journal wraps the host's original opaque candidate. Its sourceState is a lossless pre-build MLS v2 snapshot, including pending proposals and decryption material.
The envelope's version 1 is a new control-journal format, never an MLS state v1 exception.

- [ ] **Step 1: Write preparation tests.**

`built-save rejects a source or queue move`, parameterised over key, epoch, authenticator, stateVersion and FIFO head:

```ts
expect(saveResult).toBe('moved')
expect(published).toEqual([])
expect(after).toEqual(before)
expect(buildCalls).toBe(1)
```

`preparation framing does not reenter access` asserts a completed built result and zero nested access calls.
`same-source direct and queued preparation share one slot` and `rolled-back save retries prepared bytes without another build`:

```ts
expect(buildCalls).toBe(1)
expect(frameCalls).toBe(1)
expect(secondResult).toBe(secondIntent)
expect(saved.commitOnce).toEqual(saved.operations[0]?.built)
expect(retried.payload).toEqual(prepared.payload)
expect(retried.publishID).toBe(prepared.publishID)
expect(decodeControlJournal(retried.journal).sourceState).toEqual(sourceBytes)
```

`rotation refuses local pending proposals and otherwise preserves roster and ledger`:

```ts
await expect(commitKeyRotation(withPending)).rejects.toThrow('pending proposals')
expect(withPending.state).toEqual(before)
expect(rotated.newGroup.epoch).toBe(group.epoch + 1n)
expect(rotated.newGroup.ledgerTokens).toEqual(group.ledgerTokens)
expect(rotated.newGroup.listMembers()).toEqual(group.listMembers())
expect(rotated.newGroup.state.unappliedProposals).toEqual({})
```

Use a non-admin member for successful rotation and a real receiver for update-path/authenticator verification.

- [ ] **Step 2: Run red checks.**

```sh
rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/control-build.test.ts
rtk proxy pnpm --filter @kumiai/mls run test:types
rtk proxy pnpm --filter @kumiai/mls run test:unit test/group-rotation.test.ts
```

Expected: missing factories/rotation export, then failures for repeated build and absent source guard.

- [ ] **Step 3: Implement guarded preparation and journal encoding.**

Use readControl's existing gate across slot/queue reads, crypto preparation and the guarded save. The provider transaction covers only revalidation and writes.
The raw builder receives the supplied handle. It must not reacquire access through read, readControl or groupHandleAccess.
The framing callback uses its supplied seal function, never root GroupCrypto.sealEntries while readControl owns access.
Create that function with deriveEntryKey(group, entryLabel) and sealEntries from `mls-rpc/src/crypto.ts:54-58`, preserving configured label/runtime.
Adapt revoke construction to a supplied-handle helper, preserving `publishRevokeProof` as enqueue/commit routing.
All private-control entry points use prepareBuild. Bare MLS crypto helpers remain usable outside RPC and are not a second durable control path.

Before invoking the raw builder, check deadline, current source and occupied slot. An occupied same-epoch slot returns the unchanged intent.
Capture sourceState before construction. Frame once and calculate base64url SHA-256 over the **full** payload.
saveBuilt rechecks source key/identity/version, FIFO head and slot inside the host transaction. Co-write the built operation and slot with one mutationID.
Implement createPersistenceBuildSaver over persistence.transition and transaction-bound incarnation state/control stores. Read lifetime before entry, then validate its expected revision inside entry.
Implement the same guarded callback in host-db and transactional-access fixtures. Never implement it as a preflight read followed by unconditional control.apply.
Provider control writes reject replacing an occupied same-epoch slot or changing its immutable fields. Only expectedHead may change at that source identity.
Slot clearing requires the transaction's source epoch advancement or retirement. Outcome/ack/abandon and generic row deletion cannot authorise clearing.
Retry proven rollback with the prepared value retained in memory, under the same access ownership. Resolve ambiguity before returning or publishing.
A version-only conflict rereads source/queue and retries the same prepared build. Identity/queue changes discard it unpublished, never publish stale bytes.
Death before proven built-save permits preparation again because no publication was allowed. No journal or source snapshot is exposed as a live sending handle.
Encode the control journal using existing runtime-neutral stored-value encoding with strict shape checks and defensive copies.

- [ ] **Step 4: Implement commitKeyRotation and explicit empty control proposals.**

Call commitWithEntries with `pendingProposals: {}`, `extraProposals: []`, `enacted: []`, `requireAdmin: false` after refusing local pending proposals.
Retain lifecycle pre/post checks and the update path. Derive the candidate without mutating the source.
Make private invite/remove/ledger/revoke control construction pass empty pending proposals explicitly. Preserve commitSelfRemovals' by-reference behaviour.

- [ ] **Step 5: Run green and mutation checks.** Rebuild siblings, then run Step 2 and repo-wide test:types.

Expected: PASS. Temporarily omit the transactional source-version check, rerun the paired control-build checks, and expect the version-race case to FAIL.
Restore it and rerun to PASS. Temporarily bypass the occupied-slot check and repeat for the direct/queued preparation case.

- [ ] **Step 6: Commit guarded preparation.**

Run: `rtk proxy pnpm run lint`, then `git add -- packages/rpc/src/control/build.ts packages/mls-rpc/src/control-build.ts packages/mls-rpc/src/control-journal.ts packages/mls/src/group-rotation.ts packages/rpc/src/index.ts packages/mls-rpc/src/index.ts packages/mls/src/index.ts packages/mls/src/group-commit.ts packages/mls-rpc/src/revoke.ts packages/rpc/test/fixtures/host-db.ts packages/rpc/test/fixtures/peer.ts packages/rpc/test/fixtures/memory-group-mls.ts packages/mls-rpc/test/fixtures/transactional-access.ts tests/integration/test/app-lane-e2e.ts packages/mls/src/group-lifecycle.ts packages/mls/src/group-device.ts packages/mls-rpc/src/memory-incarnation-stores.ts packages/mls-rpc/src/memory-group-ports.ts packages/mls-rpc/test/control-build.test.ts packages/mls/test/group-rotation.test.ts`.
Expected: clean lint and only the guarded-build deliverable staged.
Run: `git commit -m "feat(control): guard build persistence and retain source validation material"`.
Expected: one green commit.

### Task 3: Full-prefix first-valid search using normal MLS validation

**Files:**
- Create: `packages/rpc/src/control/search.ts`, `packages/rpc/src/control/occurrence.ts`, `packages/mls-rpc/src/control-validation.ts`.
- Modify: `packages/mls-rpc/src/apply-commit.ts:87-129`, `packages/mls-rpc/src/mls.ts:316-383`, `packages/mls/src/group-handle.ts:1638-1647`, `packages/mls/src/errors.ts`, `packages/mls/src/index.ts`, `packages/rpc/src/crypto.ts:160-167`, `packages/rpc/src/peer.ts:2117-2145,2711`, `packages/rpc/src/index.ts`, `packages/mls-rpc/src/index.ts`, `packages/mls-rpc/src/persistence-types.ts`.
- Modify mirrors: `packages/rpc-conformance/src/group-mls.ts`, `packages/rpc/test/fixtures/memory-group-mls.ts`.
- Create/Test: `packages/rpc/test/control-search.test.ts`, `packages/mls-rpc/test/control-validation.test.ts`.

**Interfaces:**
- Consumes: Tasks 1-2 proof types and control journal. Existing `GroupMLS.readCommitHeader(commit: Uint8Array): Promise<CommitHeader | null>` and `processCommit(commit: Uint8Array, context: CommitContext): Promise<ProcessCommitResult>`.
- Produces:

```ts
type ControlValidation = {
  source: AdoptionExpected
  readCommitHeader(commit: Uint8Array): Promise<CommitHeader | null>
  processCommit(commit: Uint8Array, context: CommitContext): Promise<ProcessCommitResult>
  openEntries(sealed: Uint8Array): Uint8Array | Promise<Uint8Array>
  verifyOwn(built: BuiltCommit): Promise<boolean>
}
type ControlValidationPort = {
  restoreValidation(built: BuiltCommit): Promise<ControlValidation | null>
}
type ControlSearchDeps = {
  fetch(after: LogPosition | null): Promise<HubFetchTopicResult>
  validation: ControlValidationPort
  currentSource(): Promise<AdoptionExpected>
  followWinner(frame: ControlLogFrame): Promise<void>
  reconcileAbsent(head: LogPosition | null): Promise<void>
  hold(evidence?: GroupForkEvidence): Promise<void>
}
type ControlLogFrame = { position: LogPosition; payload: Uint8Array; senderDID: string }
type GroupForkEvidence =
  | { kind: 'digest-divergence'; epoch: number; position: string; localDigest: string; remoteDigest: string }
  | { kind: 'epoch-authenticator'; epoch: number; local: Uint8Array; remote: Uint8Array }
  | { kind: 'unexplained-own-commit'; epoch: number; position: string; digest: string }
function createControlSearch(deps: ControlSearchDeps): ControlSearchPort
function createControlValidationPort(params: {
  access: HandleAccess; identity: OwnIdentity; options: GroupOptions; entryLabel?: string
  restoreCandidate: (candidate: Uint8Array) => Promise<GroupHandle>
}): ControlValidationPort
```

`HubFetchTopicResult` comes from `@kumiai/hub-tunnel` (`src/transport.ts:98`). GroupForkEvidence lives in RPC and is re-exported by mls-rpc.
Add `validation?: 'unavailable'` to ProcessCommitResult. It requires `applied: false`, `advanced: false` and equal epochs.
Add MLS `CommitValidationUnavailableError extends Error` with the standard `(message?: string, options?: ErrorOptions)` constructor.
The external helper is `searchOccurrence(fetch: ControlSearchDeps['fetch'], from: LogPosition | null, payloadDigest: string): Promise<{found: LogPosition} | 'absent' | 'gap'>` until 2.2d.

- [ ] **Step 1: Write first-valid tests.**

`match never bypasses checkpoint or page gaps`, with gaps before searchFrom, on the matching page, and empty nonterminal pages:

```ts
expect(result).toEqual({ kind: 'unknown' })
expect(ownAdoptions).toBe(0)
expect(welcomes).toEqual([])
```

`earlier valid competitor supersedes an alternate-ID exact own replay`:

```ts
expect(result).toEqual({ kind: 'superseded', winner: winnerPosition })
expect(followed).toEqual([winnerPosition])
expect(ownAdoptions).toBe(0)
expect(welcomes).toEqual([])
```

`prefix before the original build checkpoint is validated`, `unexplained own bytes hold without adoption or automatic healing`, and `unknown version or missing validation material holds`:

```ts
expect(validatedPositions).toContain(positionBeforeSearchFrom)
expect(unexplainedResult).toEqual({ kind: 'unknown' })
expect(heldEvidence?.kind).toBe('unexplained-own-commit')
expect(automaticRecoveryCalls).toBe(0)
expect(unavailableResult).toEqual({ kind: 'unknown' })
```

`source-epoch competitor validation uses normal MLS and does not mutate the live source` uses real commit/policy rejection and missing-proposal/key cases:

```ts
expect(validatorResult.applied).toBe(true)
expect(await live.readEpoch()).toBe(sourceEpoch)
expect(await validator.processCommit(missingReferenceCommit, context)).toMatchObject({ validation: 'unavailable', applied: false })
expect(await validator.processCommit(policyRefusedCommit, context)).toMatchObject({ applied: false, refusal: 'policy' })
```

- [ ] **Step 2: Run red checks.**

```sh
rtk proxy pnpm --filter @kumiai/rpc run test:types
rtk proxy pnpm --filter @kumiai/rpc run test:unit test/control-search.test.ts
rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/control-validation.test.ts test/ports-conformance.test.ts test/ports-conformance-transactional.test.ts
```

Expected: missing search/validator and unavailable-result contracts fail. Existing normal MLS conformance remains required.

- [ ] **Step 3: Implement isolated validation through the existing normal processing path.**

Restore the journal's source state/credential/ordered ledger with the host's unchanged policy, binding and resolver configuration.
Construct a private GroupMLS/GroupCrypto over that handle. Its persistence is staging only, with no live notifications or host effects.
GroupMLS.processCommit advances this isolated validator on a valid competitor. It never advances the live handle merely to inspect an occurrence.
verifyOwn checks source key/epoch/authenticator, exact saved full payload/commit digest and the restored candidate's source-history identity.
It relies on the original normal builder's policy validation and retained candidate, never readCommitHeader alone and never rebuilding.

Preserve missing-input diagnostics before applyCommit collapses errors into `invalid`. Missing proposal references and unavailable retained handshake keys return `validation: 'unavailable'`.
The installed ts-mls distinguishes missing references at `clientState.js:402-404`, and unavailable generations at `secretTree.js:105,169`.
Translate these pinned dependency errors at the MLS boundary, with tests for each cause. Unrecognised validation exceptions conservatively hold.
Malformed framing and conclusive cryptographic/policy rejection remain invalid. Resolver/storage failures propagate to an unknown search result, never prove poison.
The ordinary walker also respects validation-unavailable: leave the cursor before the frame and hold. It cannot convert this new result into a skip.

- [ ] **Step 4: Implement the prefix algorithm in search.ts.**

The algorithm is deliberate because the public search signature does not determine coverage, state effects or own handling:

```text
1. Restore retained source validation. Missing/unreadable inputs => unknown.
   Compare its key/identity with currentSource. Retirement never follows a new owner.
   Same-number authenticator divergence holds as evidence. If the live state already
   advanced, require matching committed applied evidence before treating it as the winner.
2. Validate coverage through the original build checkpoint, then search its suffix.
   Re-fetch the checkpoint prefix from null through searchFrom (inclusive), followed
   by (searchFrom, captured head]. Never start proof at a refreshed expectedHead.
   Check gaps, head consistency and forward order BEFORE interpreting any match.
   A missing checkpoint or unclassifiable prefix => unknown, not absence.
3. Walk in log order. Decode supported frames. Non-commit/malformed frames are skips.
   Unknown versions hold. Classify against the retained source epoch, not today's epoch.
   Older frames are history only where authenticated source installation/applied history
   establishes that boundary; an unproven boundary holds. Never treat a source-epoch
   frame as history merely because the live handle has subsequently advanced.
4. At the source epoch, validate competitors with the isolated GroupMLS.processCommit,
   including normal signatures, proposal resolution, sealed entries and lifecycle policy.
   The first applied result wins, including applied self-removal without epoch advance.
   Missing inputs/future or unclassifiable frames before a winner => unknown.
5. own-unmerged is a barrier, not proof. Exact saved full bytes with verified candidate
   and complete valid prefix => own winner. Different/unexplained own bytes => evidence
   hold; never process own bytes as a received commit or initiate recovery from search.
6. Continue occurrence discovery after a competitor wins. A later exact own payload,
   under ANY publishID, yields superseded. Follow the validated winner using ordinary
   reconciliation/adoption before returning. Never adopt the own candidate or owe its Welcome.
   A complete range with no exact own occurrence yields absent, after following any winner.
   Uncertain coverage after the winner still yields unknown for own acceptance.
7. An own first-valid occurrence produces {source, from: searchFrom, position,
   payloadDigest}. An optional acknowledged position is a hint, never permission to
   skip earlier rows or prefer a later replay over the earliest exact occurrence.
   Keep proof.source.identity bound to the source epoch. At that identity, use its
   current version. If already adopted, retain the source proof and require matching
   committed applied-payload evidence for idempotence. Never substitute the candidate
   identity merely because the live epoch advanced.
8. Reconcile a proven complete absent suffix. Only then publish its validated head as
   retry metadata. A growing head triggers another suffix pass, never a guessed CAS head.
```

The null-prefix choice is conservative: retention before the checkpoint can hold an operation even when a suffix match survives.
This plan adds no unauthenticated checkpoint shortcut. A later optimisation must preserve equivalent complete-prefix evidence.
The validator's source snapshot may lack a previously consumed key. That is unknown, never proof that an encrypted frame was invalid.

followWinner receives the exact validated frame and reuses advanceHandle/processCommit/adoptionWrite at the source identity.
It rechecks an already-committed matching applied row on restart, preserving the cursor instead of reinstalling state.
reconcileAbsent uses a bounded ordinary walk through the validated head, then sets commitLogHead for readHead. It cannot walk later unvalidated frames.
The search must suppress ordinary walking of the saved own occurrence until its first-valid decision completes.
An unexplained own-unmerged frame in the ordinary walker also holds control and preserves the cursor, without requesting automatic healing.
An already-committed different branch is evidence, never permission for followWinner to roll back or replace it.
Certified later losers bypass generic fork classification only for the exact validated prefix. Unrelated digest divergence remains evidence.

- [ ] **Step 5: Run green and mutation checks.** Rebuild, then run Step 2 and repo-wide test:types.

Expected: PASS. Move the match check before coverage, then run the RPC pair and expect the gap tests to FAIL.
Restore it. Skip competitor processCommit, rerun the pair, and expect supersession to FAIL. Restore and rerun both pairs to PASS.

- [ ] **Step 6: Commit search and validation.**

Run: `rtk proxy pnpm run lint`, then `git add -- packages/rpc/src/control/search.ts packages/rpc/src/control/occurrence.ts packages/mls-rpc/src/control-validation.ts packages/mls-rpc/src/apply-commit.ts packages/mls-rpc/src/mls.ts packages/mls/src/group-handle.ts packages/mls/src/errors.ts packages/mls/src/index.ts packages/rpc/src/crypto.ts packages/rpc/src/peer.ts packages/rpc/src/index.ts packages/mls-rpc/src/index.ts packages/mls-rpc/src/persistence-types.ts packages/rpc-conformance/src/group-mls.ts packages/rpc/test/fixtures/memory-group-mls.ts packages/rpc/test/control-search.test.ts packages/mls-rpc/test/control-validation.test.ts`.
Expected: clean lint and the legacy external search remains independently callable.
Run: `git commit -m "feat(control): validate full prefixes before own acceptance"`.
Expected: one green search commit.

### Task 4: Activate the commit-once runner and deadline rules

**Files:**
- Modify: `packages/rpc/src/control/welcome.ts`, `packages/rpc/test/peer-welcome-obligations.test.ts` for delivery rechecks.
- Modify: `packages/rpc/src/control/operations.ts:38-288`, `packages/rpc/src/control/types.ts:63-67`, `packages/rpc/src/peer-types.ts:78-95`, `packages/rpc/src/peer.ts:1846-1862,1968-2028,2062-2285,2436-2485,3151`, `packages/rpc-conformance/src/control-store.ts`.
- Modify hosts/fixtures: `packages/rpc/test/fixtures/peer.ts`, `packages/rpc/test/fixtures/memory-group-mls.ts`, `tests/integration/test/app-lane-e2e.ts`, `packages/rpc/test/control-operations.test.ts`, `packages/rpc/test/peer-commit-cas.test.ts`, `packages/rpc/test/peer-control-settlement.test.ts`, `packages/rpc/test/peer-operations.test.ts`.

**Interfaces:**
- Consumes: Tasks 2-3 `ControlBuildPort.prepareBuild`, `ControlSearchPort.searchLog` and Task 1 source types.
- Produces required accepted operation `{stage: 'accepted'; built: BuiltCommit; acceptedAs: LogPosition; acceptance: FirstValidCommit}`.
- Produces `ControlAdoptionPort.adopt(journal: Uint8Array, expected: AdoptionExpected & {acceptance: FirstValidCommit}, write: AdoptionWrite): Promise<'installed' | 'noop' | 'moved'>`.
- `OperationDeps` replaces build with `prepareBuild: ControlBuildPort['prepareBuild']`, replaces searchLog with `ControlSearchPort['searchLog']`, and uses ControlAdoptionPort.adopt.
- It adds `readSource(): Promise<AdoptionExpected>` and `readHead(): LogPosition | null`. Set `frame: FrameControlBuild`. Keep publish/pullToHead/clock/emit signatures.
- `GroupPeerMLSParams` replaces its raw build callback with required `prepareBuild: ControlBuildPort['prepareBuild']` and adds required `validation: ControlValidationPort`.
- `stepOperation(deps: OperationDeps, op: Operation): Promise<Operation | null>` and enqueue/outcomes/ack/commit signatures remain unchanged.
- Welcome dependencies add `canDeliver(obligation: WelcomeObligation): Promise<boolean>`. Accepted work requires a fresh prefix check. Committed obligations survive outcome ack.

- [ ] **Step 1: Rewrite the removed-behaviour tests and add deadline assertions.**

Replace `control-operations.test.ts:232` with `complete head-only absence refreshes CAS without rebuilding`:

```ts
expect(next?.stage).toBe('built')
expect(next?.built).toEqual({ ...savedBuilt, expectedHead: laterHead })
expect(buildCalls).toBe(1)
expect(next?.built.searchFrom).toBe(originalHead)
```

Replace `:265` with `gap holds before deadline and settles unknown at deadline`. Replace `:276` with `transport failure retries before expiry and never hands off after expiry`.
Replace `:245` and `:289` with `deadline survives reconstruction` and `epoch advance rebuilds only after complete absence and intent revalidation`.

```ts
expect(beforeDeadline).toBe(builtOperation)
expect(atDeadlineOutcome.kind).toBe('unknown')
expect(afterAck.commitOnce).toEqual(savedBuilt)
expect(expiredIntentBuildCalls).toBe(0)
expect(expiredIntentOutcome.kind).toBe('lost')
expect(afterExpiryPublications).toBe(0)
expect(completeAbsentOutcome.kind).toBe('lost')
expect(lateFirstValidOutcome.kind).toBe('landed')
expect(supersededOutcome.kind).toBe('lost')
expect(revalidatedTargetAlreadySatisfied.kind).toBe('rejected')
```

Use equality at `enqueuedAt + operationTimeoutMs`, plus one millisecond either side. Include the default `30_000` and a test override `1_000`.
`expiry during submission drain prevents handoff` holds settleLogSubmissions until expiry and asserts `expect(hubPublish).not.toHaveBeenCalled()`.
`accepted replay rechecks proof before adopt` asserts `expect(adoptCalls).toBe(0)` and no Welcome delivery when the prefix becomes unavailable.
`unknown slot blocks a different operation ID after acknowledgement` asserts one build across queue changes, direct prepareBuild calls and restart.

In peer-commit-cas, retain successive-epoch FIFO at `:22`. Keep winner-driven rebuild at `:39` only for complete exact-payload absence.
Change the repeated mismatch case at `:64-79` from six builds to one build with six identical attempts.
Change timeout-zero cases at `:84,116,131`: an expired intent never builds. Give mailbox/retained-head tests a positive timeout.
The swept-prefix test now expects hold/unknown if coverage cannot be established; retained head alone never authorises first-valid acceptance.

- [ ] **Step 2: Run red checks.**

```sh
rtk proxy pnpm --filter @kumiai/rpc run test:types
rtk proxy pnpm --filter @kumiai/rpc run test:unit test/control-operations.test.ts test/peer-commit-cas.test.ts test/peer-control-settlement.test.ts test/peer-operations.test.ts
```

Expected: existing rebuild, gap, expiry and occurrence-only acceptance behaviour FAILS the new assertions.

- [ ] **Step 3: Implement the runner transitions and switch all hosts together.**

Before preparing an intent, check expiry, pull to a complete head, revalidate intent and consult the durable slot.
Search every saved build before publication, including its first replay and after every transport failure/mismatch.
First-valid persists acceptance and the full Welcome obligation together. Superseded settles lost only after following the winner.
Unknown retains work before expiry, then settles unknown. Complete absence at expiry settles lost. Neither settlement nor ack clears the slot.
Complete absence before expiry with unchanged identity changes only expectedHead in both slot and operation. Do not reframe or rebuild.
An epoch advance can clear the old slot after acceptance resolution and return the original unexpired intent for fresh target validation.
An incarnation move settles old work unknown. It never builds in another owner. Same-epoch authenticator divergence holds as evidence.
Add `source retirement never rebuilds and same-epoch divergence never republishes`, asserting unknown/hold, zero builds and zero handoffs.
Do not clear a slot for a proposal change, state-version change, queue change, rejection, outcome acknowledgement or abandon.

Recheck expiry immediately before the actual mux.publish call, **after** revoke submission drainage and any awaited preparation.
Already handed-off publication may finish after expiry. Search its acceptance and allow first-valid landing without another handoff.
Retain the existing 1-second-to-15-second transport backoff. Clamp wakeups to the deadline so idle failures settle on time.
Accepted replay rechecks the complete proof before adoption. A version-only moved result retries proof/adoption with fresh version, never rebuilds.
Welcome delivery invokes canDeliver before transport handoff, including startup. Unknown accepted proof retains the obligation without delivery.
No-op requires matching committed mutation/applied full payload. Candidate authenticator equality alone cannot manufacture applied/cursor evidence.

Change `frameCommit(commit: Uint8Array, bodies: Array<string>, framedAt: number | null, seal: GroupCrypto['sealEntries'] = crypto.sealEntries): Promise<{payload: Uint8Array; epoch: number}>` to use the supplied seal.
Private preparation passes the source-bound seal. Legacy external framing retains its default.

Wire hold to the existing strand barrier, retaining the occupied slot. Search-driven holds must not call strandAccepted's automatic-healing path.
Before startup recovery or publication, resolve occupied slots. Unknown-version, unexplained-own and identity-divergence holds cannot be bypassed by automatic rejoin.
2.2c replaces this control-specific barrier with the durable, all-path fork halt and stable events.
Keep legacy external search on occurrence.ts. Do not pass a RejoinRecord to private-control search with fabricated BuiltCommit fields.

- [ ] **Step 4: Run green checks.** Rebuild, run Step 2, then run `rtk proxy pnpm turbo run test:types`.

Expected: PASS with required acceptance in every accepted-stage producer and structural mirror. No optional-proof compatibility path remains.

- [ ] **Step 5: Mutation-check handoff and slot guards.** Remove the post-drain deadline check, then run Step 2's pair.

Expected: expiry-drain test FAILS. Restore it. Clear the slot on unknown outcome, then expect the different-operation-ID test to FAIL.
Restore both and rerun to PASS.

- [ ] **Step 6: Commit the runner switch.**

Run: `rtk proxy pnpm run lint`, then `git add -- packages/rpc/src/control/welcome.ts packages/rpc/test/peer-welcome-obligations.test.ts packages/rpc/src/control/operations.ts packages/rpc/src/control/types.ts packages/rpc/src/peer-types.ts packages/rpc/src/peer.ts packages/rpc-conformance/src/control-store.ts packages/rpc/test/fixtures/peer.ts packages/rpc/test/fixtures/memory-group-mls.ts tests/integration/test/app-lane-e2e.ts packages/rpc/test/control-operations.test.ts packages/rpc/test/peer-commit-cas.test.ts packages/rpc/test/peer-control-settlement.test.ts packages/rpc/test/peer-operations.test.ts`.
Expected: clean lint and all host call sites migrated in the same commit.
Run: `git commit -m "feat(control): enforce commit-once retries and publication deadlines"`.
Expected: one green runner commit.

### Task 5: First-valid adoption, Welcome gating and ratchet preservation

**Files:**
- Create: `packages/mls-rpc/src/control-adoption.ts`, `packages/mls-rpc/test/control-adoption.test.ts`, `tests/integration/test/control-first-valid.test.ts`.
- Modify: `packages/mls-rpc/src/index.ts`, `packages/rpc/src/control/welcome.ts`, `packages/rpc/src/peer.ts:1968-2028,2033-2050,2184-2207`, `tests/integration/test/app-lane-e2e.ts:580-629`, `packages/rpc/test/fixtures/memory-group-mls.ts`.
- Test/Modify: `packages/rpc/test/peer-welcome-obligations.test.ts`, `packages/mls-rpc/test/adoption-write.test.ts`, `packages/mls-rpc/test/commit-topic-proposal.test.ts`, `packages/mls/test/carry-receive-progress.test.ts`.

**Interfaces:**
- Consumes: Task 4 ControlAdoptionPort, Task 3 ControlSearchPort, `HandleAccess.replace(next: GroupHandle, adoption?: AdoptionWriteFactory, prepare?: (current: GroupHandle) => Promise<boolean>): Promise<void>`.
- Produces `createControlAdoptionPort(params: {access: HandleAccess; control: ControlStore; restoreCandidate: (candidate: Uint8Array) => Promise<GroupHandle>}): ControlAdoptionPort`.
- The Welcome worker consumes Task 4's `canDeliver(obligation: WelcomeObligation): Promise<boolean>`. Delivery/delete signatures remain unchanged.
- `canDeliver` requires revalidated acceptance while the operation remains accepted. After adoption, the co-written obligation authorises delivery through pruning and outcome ack.

- [ ] **Step 1: Write real adoption and Welcome tests.**

`accepted restart carries current progress without resurrecting history`:

```ts
expect(restoredCandidateAuthenticator).toEqual(originalCandidateAuthenticator)
expect(reopenedConsumedMessage).toBeNull()
expect(nextSenderGeneration).toBeGreaterThan(previousSenderGeneration)
expect(adopted.state.historicalReceiverData.has(evictedEpoch)).toBe(false)
expect(rebuiltCount).toBe(0)
```

Use actual decrypt rejection rather than a synthetic flag when the fixture API throws for a consumed message.
Run opens and seals after build, persist/reconstruct, then adopt. Preserve matching older history and candidate E+1 state.

`stale adoption version retries proof without rebuilding`, `adoption rollback leaves state control and anchor unchanged`, and `no-op requires committed payload evidence`:

```ts
expect(staleResult).toBe('moved')
expect(afterStale).toEqual(beforeStale)
expect(afterRollback).toEqual(beforeRollback)
expect(landedRows).toHaveLength(1)
expect(appliedRows).toHaveLength(1)
expect(buildCalls).toBe(1)
```

`poison prefix retries the identical commit and real receiver matches candidate` and `extra proposal is omitted while missing reference holds`:

```ts
expect(secondPublish.payload).toEqual(firstPublish.payload)
expect(secondPublish.publishID).toBe(firstPublish.publishID)
expect(secondPublish.expectedHead).toBe(poisonHead)
expect(receiver.state.keySchedule.epochAuthenticator).toEqual(candidateAuthenticator)
expect(receiver.state.unappliedProposals).toEqual({})
expect(missingReferenceOutcome.kind).toBe('unknown')
expect(missingReferenceWelcomes).toEqual([])
```

Include malformed, non-commit and conclusively policy-refused frames. Inspect identical handshake bytes/generation, not just the commit digest.
`Welcome is never released for a superseded or unverified accepted stage` asserts zero deliveries for both cases.
`Welcome remains owed after landed outcome acknowledgement` asserts one retained obligation, retried delivery, then deletion only after transport acceptance.

- [ ] **Step 2: Run red checks.**

```sh
rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/control-adoption.test.ts test/adoption-write.test.ts test/commit-topic-proposal.test.ts
rtk proxy pnpm --filter @kumiai/rpc run test:types
rtk proxy pnpm --filter @kumiai/rpc run test:unit test/peer-welcome-obligations.test.ts
rtk proxy pnpm --filter @kumiai/integration-tests run test:types
rtk proxy pnpm --filter @kumiai/integration-tests run test:unit test/control-first-valid.test.ts
```

Expected: new adapter/revalidation assertions fail. Retained ordinary adoption and Welcome retry tests remain meaningful.

- [ ] **Step 3: Implement guarded adoption and proof-aware Welcome delivery.**

Decode the control wrapper and restore its original host candidate. Check expected key, source identity and current host version inside access ownership.
Recheck the same expectations in the host save transaction. An outer preflight check alone is insufficient.
Fresh proof supplies the latest stateVersion after acceptance persistence. The stored acceptance's source version remains historical evidence, not a permanent version lock.
Use current.carryReceiveProgress(candidate) before saving. Preserve sender and receiver progress and never resurrect evicted history.
Co-write state/control/applied/cursor/anchor through AdoptionWrite. With the 2.1 provider, installation updates trust/spent in that transition.
Pass `write.expected` to the host save. host-db and transactional-access check it before changing any row or marker.
Keep pending certified outbox work intact. Full settlement finalisation and registry-backed adoption remain assigned to 2.3 and 2.2b respectively.

For incoming winners, normal processCommit remains authoritative, including self-removal without epoch advancement.
Use staged.incarnation and fixed control key. Do not infer removal from a different incarnation's sorted applied rows.
Remove incoming payload-only settlement of accepted operations: require the matching validated acceptance and position before producing landed.
Welcome delivery for still-accepted work rechecks first-valid proof before handoff. Failed rechecks retain the obligation and hold delivery.
After committed adoption, the obligation is already authorised and survives pruning/outcome ack. Never require an already-acked outcome to deliver it.
Delivery remains at least once. Delete only after transport acceptance. No record is created for supersession.

- [ ] **Step 4: Run green checks.** Rebuild and run Step 2.

Also run `rtk proxy pnpm --filter @kumiai/mls run test:types` and `rtk proxy pnpm --filter @kumiai/mls run test:unit test/carry-receive-progress.test.ts`.
Expected: PASS, including both current and earlier retained epochs and existing refusal/holder checks.

- [ ] **Step 5: Mutation-check adoption and Welcome proof.** Bypass carryReceiveProgress, then run the integration pair.

Expected: sender/receiver progress assertions FAIL. Restore it. Bypass canDeliver's accepted-stage recheck and expect the gap/restart Welcome assertion to FAIL.
Restore and rerun the affected paired checks to PASS.

- [ ] **Step 6: Commit guarded adoption.**

Run: `rtk proxy pnpm run lint`, then `git add -- packages/mls-rpc/src/control-adoption.ts packages/mls-rpc/test/control-adoption.test.ts tests/integration/test/control-first-valid.test.ts packages/mls-rpc/src/index.ts packages/rpc/src/control/welcome.ts packages/rpc/src/peer.ts tests/integration/test/app-lane-e2e.ts packages/rpc/test/fixtures/memory-group-mls.ts packages/rpc/test/peer-welcome-obligations.test.ts packages/mls-rpc/test/adoption-write.test.ts packages/mls-rpc/test/commit-topic-proposal.test.ts packages/mls/test/carry-receive-progress.test.ts`.
Expected: clean lint and only adoption/Welcome work staged.
Run: `git commit -m "feat(control): gate adoption and Welcomes on first-valid proof"`.
Expected: one green adoption commit.

### Task 6: Reconstruction seams and shared control conformance

**Files:**
- Create: `packages/rpc-conformance/src/commit-once.ts`, `packages/rpc/test/commit-once-conformance.test.ts`, `tests/integration/test/commit-once-conformance.test.ts`, `packages/rpc/test/peer-commit-once-crash.test.ts`.
- Modify: `packages/rpc-conformance/src/index.ts`, `packages/rpc-conformance/src/control-store.ts`, `packages/rpc-conformance/src/group-mls.ts`, `packages/rpc/test/fixtures/peer.ts`, `tests/integration/test/app-lane-e2e.ts`, `packages/mls-rpc/test/fixtures/storage-persistence.ts`.
- Test/Modify: `packages/rpc/test/peer-first-commit-crash.test.ts`, `packages/rpc/test/peer-operations.test.ts`, `packages/rpc/test/peer-welcome-obligations.test.ts`, `tests/integration/test/operation-host.test.ts`, `tests/integration/test/welcome-after-crash.test.ts`.

**Interfaces:**
- Consumes: Tasks 1-5 final control records, build/search/adoption ports and existing seam wrappers.
- Produces independent structural `Conformance*` mirrors for every added public control type and port, with generic `Position extends string` where appropriate.
- Produces:

```ts
type CommitOnceScenario = 'alternate-id-replay' | 'gap-match' | 'poison-head' |
  'built-restart' | 'accepted-restart' | 'epoch-move' | 'deadline' | 'progress'
type CommitOnceEvidence = {
  outcome: 'landed' | 'lost' | 'unknown'; builds: number; ownAdoptions: number
  welcomeDeliveries: number; payloads: Array<Uint8Array>; publishIDs: Array<string>
  expectedHeads: Array<string | null>; searchFrom: string | null
  slotAfterAck: ConformanceBuiltCommit | null; winnerFollowed: boolean
  candidateMatchesReceiver: boolean; progressPreserved: boolean
}
function testCommitOnceConformance(params: {
  label: string; run(scenario: CommitOnceScenario): Promise<CommitOnceEvidence>
}): void
```

Scenario runners exercise actual peer/store/hub paths and collect observations. They cannot return canned evidence or replace search with a successful stub.
The shared suite owns assertions. Real MLS and the strict memory double own scenario construction and reconstruction.

- [ ] **Step 1: Add named crash tests and shared assertions.**

| Spec requirement/seam | Named test | Location / task |
| --- | --- | --- |
| Control row 1116, alternate-ID own replay after valid competitor | `earlier valid competitor supersedes an alternate-ID exact own replay` | control-search.test.ts / 3; shared `alternate-id-replay` / 6 |
| Control row 1116, match across gap | `match never bypasses checkpoint or page gaps` | control-search.test.ts / 3; shared `gap-match` / 6 |
| Control row 1117, poison retry and receiver parity | `poison prefix retries the identical commit and real receiver matches candidate` | control-first-valid.test.ts / 5; shared `poison-head` / 6 |
| Control row 1117, proposals | `extra proposal is omitted while missing reference holds` | control-first-valid.test.ts / 5 |
| Control row 1118, saved build/mismatch restart | `restart after built-save or head refresh keeps one exact build` | peer-commit-once-crash.test.ts / 6 |
| Control row 1118, remote acceptance restart | `restart after remote acceptance searches before own walk` | peer-commit-once-crash.test.ts / 6 |
| Control row 1118, expiry/ack/new ID | `unknown slot blocks a different operation ID after acknowledgement` | control-operations.test.ts / 4 |
| Control row 1119, epoch and deadline outcomes | `epoch advance rebuilds only after complete absence and intent revalidation`; `deadline survives reconstruction` | control-operations.test.ts / 4; shared scenarios / 6 |
| Built-save committed before publication | `restart after built-save or head refresh keeps one exact build` | peer-commit-once-crash.test.ts / 6 |
| Remote acceptance before accepted save, including forgotten dedup ID | `restart after remote acceptance searches before own walk` | peer-commit-once-crash.test.ts / 6 |
| Accepted save before adoption | `accepted restart rechecks the full prefix before adoption or Welcome` | peer-commit-once-crash.test.ts / 6 |
| First logical adoption write fails | `adoption rollback leaves state control and anchor unchanged` | control-adoption.test.ts / 5 |
| Own/incoming adoption committed before callbacks | `committed adoption reconstructs one applied row cursor and outcome` | peer-commit-once-crash.test.ts / 6 |
| Rejected COMMIT with unfinished backend | `ambiguous built and accepted saves release no bytes before proof` | peer-commit-once-crash.test.ts / 6 |
| Welcome transport acceptance before obligation deletion | `Welcome delivery repeats after acceptance-before-delete crash` | peer-welcome-obligations.test.ts / 6 |

Pin each seam with the relevant observations:

```ts
expect(reopenedBuilt).toEqual(savedBuilt)
expect(publicationsBeforeProof).toEqual([])
expect(unknownBeforeProof.outcomes).toEqual([])
expect(buildCountAfterRestart).toBe(1)
expect(ownWalkBeforeSettlement).toBe(false)
expect(landedOutcomes).toHaveLength(1)
expect(appliedRows).toHaveLength(1)
expect(deliveriesAfterDeliveryCrash).toBe(2)
expect(finalWelcomes).toEqual([])
```

`buildCountAfterRestart` counts both processes. The pre-save-death case instead permits a second preparation and still asserts zero escaped first payloads.
Parameterise ambiguity for commit and rollback. Use existing memory completion faults, not a promise rejection pretending to prove rollback.

Row 1120 stays green here for full-payload poison, moved/no-op, accepted-before-walk, refusal/holder evidence, revoke/two-revoke holds and inviter Welcome delivery.
Keep exact external-confirmation regressions running unchanged. New incarnation resync, captureHead and source-scan replacement belong to 2.2d.
Automatic fork-healing/row-retirement assertions are removed by 2.2c, except exact certified supersession cases now owned here.
Self-removal adoption remains green. Full persisted-handler terminal drain belongs to 2.3.
Keep `adoption-write.test.ts` self-removal test at line 75 and the peer removal replay tests running at the final gate.

- [ ] **Step 2: Run the focused reconstruction and contract checks.**

```sh
rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types
rtk proxy pnpm --filter @kumiai/rpc run test:types
rtk proxy pnpm --filter @kumiai/rpc run test:unit test/commit-once-conformance.test.ts test/peer-commit-once-crash.test.ts test/peer-first-commit-crash.test.ts test/peer-operations.test.ts test/peer-welcome-obligations.test.ts test/control-store-conformance.test.ts
rtk proxy pnpm --filter @kumiai/integration-tests run test:types
rtk proxy pnpm --filter @kumiai/integration-tests run test:unit test/commit-once-conformance.test.ts test/operation-host.test.ts test/welcome-after-crash.test.ts test/recovery-confirmation.test.ts
```

Expected initially: missing scenario harness/export or uncovered reconstruction behaviour FAILS. No meaningful existing regression is deleted to make the gate pass.

- [ ] **Step 3: Implement the scenario harness and missing reconstruction wiring.**

Reopen from committed stored bytes, discarding handles, callbacks, validators, search caches and prepared in-memory retries.
Run the same named scenarios against the memory MLS double and real MLS hosts. Include the 2.1 sealed provider for slot/journal reopening and ambiguity.
Preserve independent conformance reducers. Assert exact prefix/winner behaviour through peer observations, not just a returned result union.
Add compile-time assignments in both directions for source, build, proof, search and adoption mirrors.

- [ ] **Step 4: Run green and crash mutation checks.** Rebuild, then run Step 2 and repo-wide test:types.

Expected: PASS. Temporarily let restart walk before settling its saved build and run the paired RPC crash check.
Expected: accepted-before-walk FAILS. Restore it. Temporarily release built bytes on unknown COMMIT and expect the ambiguity seam to FAIL.
Restore both and rerun to PASS.

- [ ] **Step 5: Commit reconstruction conformance.**

Run: `rtk proxy pnpm run lint`, then `git add -- packages/rpc-conformance/src/commit-once.ts packages/rpc/test/commit-once-conformance.test.ts tests/integration/test/commit-once-conformance.test.ts packages/rpc/test/peer-commit-once-crash.test.ts packages/rpc-conformance/src/index.ts packages/rpc-conformance/src/control-store.ts packages/rpc-conformance/src/group-mls.ts packages/rpc/test/fixtures/peer.ts tests/integration/test/app-lane-e2e.ts packages/mls-rpc/test/fixtures/storage-persistence.ts packages/rpc/test/peer-first-commit-crash.test.ts packages/rpc/test/peer-operations.test.ts packages/rpc/test/peer-welcome-obligations.test.ts tests/integration/test/operation-host.test.ts tests/integration/test/welcome-after-crash.test.ts`.
Expected: clean lint and both real/double harnesses staged.
Run: `git commit -m "test(control): cover commit-once crashes on real MLS and doubles"`.
Expected: one green conformance commit.

### Task 7: Release intent and complete regression gate

**Files:** Modify `.changeset/spec-p-storage-foundation.md`. If pnpm change creates a separate intent, consolidate its summary into this existing band intent.

**Interfaces:**
- Consumes: final `ControlBuildPort.prepareBuild`, `ControlSearchPort.searchLog`, `ControlAdoptionPort.adopt` signatures from Tasks 2-4.
- Consumes: `testCommitOnceConformance(params: {label: string; run(scenario: CommitOnceScenario): Promise<CommitOnceEvidence>}): void` from Task 6.
- Produces: a coherent pending minor band intent and verified implementation/contract parity. No additional runtime interface.

- [ ] **Step 1: Record the release intent.**

Run: `rtk proxy pnpm change`.
Select the existing fourteen-package minor band represented by spec-p-storage-foundation.md. Consolidate duplicate entries without changing the band.
Append: “Persist one private control build per source epoch. Validate first-valid full-prefix acceptance before adoption or Welcome delivery. Retain source slots across deadlines and outcome acknowledgement.”
Expected: one coherent band-raising intent. No version application or publication.

- [ ] **Step 2: Run build and repository type checks.**

```sh
rtk proxy pnpm turbo run build:js build:types
rtk proxy pnpm turbo run test:types
```

Expected: PASS without filtered-away consumers or compatibility casts hiding missing proof/source fields.

- [ ] **Step 3: Run both contract suites and affected regressions.**

```sh
rtk proxy pnpm --filter @kumiai/mls run test
rtk proxy pnpm --filter @kumiai/mls-rpc run test
rtk proxy pnpm --filter @kumiai/rpc run test
rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types
rtk proxy pnpm --filter @kumiai/hub-conformance run test:types
rtk proxy pnpm --filter @kumiai/hub-server run test:types
rtk proxy pnpm --filter @kumiai/hub-server run test:unit test/conformance.test.ts test/log-hub-conformance.test.ts
rtk proxy pnpm --filter @kumiai/hub-store run test:types
rtk proxy pnpm --filter @kumiai/hub-store run test:unit test/conformance.test.ts
rtk proxy pnpm --filter @kumiai/mls-hub run test
rtk proxy pnpm --filter @kumiai/integration-tests run test
```

Expected: PASS. RPC includes memory MLS/control/hub doubles. mls-rpc includes simple and transactional real MLS ports, storage/ownership conformance and runtime guards.
Hub-server covers its real memory store/view. Hub-store covers the SQL store contract. Integration covers the wire hub adapter and real control hosts.
Conformance packages expose suites rather than standalone Vitest scripts. Their runners above execute the actual contracts.
Report unavailable database infrastructure as an incomplete gate, never as a pass. No registry-based full persistence or SIGKILL claim belongs here.

- [ ] **Step 4: Check intent, versions and lint.**

```sh
rtk proxy pnpm change status
rtk proxy pnpm run check:versions
rtk proxy pnpm run lint
git diff --check
```

Expected: coherent pending band, passing version checks, clean lint/diff and no generated files staged.

- [ ] **Step 5: Commit the release/gate deliverable.**

```sh
git add -- .changeset/spec-p-storage-foundation.md
git commit -m "chore(control): record commit-once release intent and regression gate"
```

Expected: release intent committed after all required checks pass. Any implementation fix found by the gate includes its owning task's paired checks.

## Self-review

Spec coverage: D4's slot/save/retry/deadline rules map to Tasks 1, 2 and 4. Full-prefix first-valid validation maps to Task 3.
Acceptance, Welcome and ratchet carry map to Tasks 4-5. Every control conformance row and applicable crash seam maps to named tests in Task 6.
The ownership table assigns deferred D1/D2/recovery/registry/runtime requirements exactly once. No deferred mechanism is described as complete here.

Step scan: tasks have reviewable deliverables, signatures, named assertions, red/green commands and commits. Bodies are reserved for the search algorithm.
Type scan: accepted proof becomes required only with Task 4's consumer migration. Source versions are host-backed. Mirrors remain independent.
Review Focus: all five conditions map to named tests in Tasks 2-5. Mutation checks exercise slot, coverage, competitor, deadline, progress and completion guards.
Proportion: seven tasks. The plan defines boundaries and algorithm choices without transcribing implementation bodies.

Drafting changes documentation only. Builds, tests, mutation checks, release intents and commits above are instructions for later implementation.
