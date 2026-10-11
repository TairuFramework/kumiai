# Spec P 2.2a Commit-once Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist one private control build per source epoch and adopt or release its Welcome only after proving first-valid acceptance.

**Architecture:** RPC owns the durable slot, prefix search and operation runner. The MLS adapter supplies retained source validation and guarded build/adoption through the existing single-handle access boundary. Registry ownership replaces that boundary in 2.2b. Network work and crypto preparation remain outside provider transactions.

**Tech Stack:** TypeScript, pnpm 12.10.1, Vitest, ts-mls 2.0.0-rc.13, Web Crypto, existing MLS v2 codecs and transactional memory persistence.

**Spec:** [docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md](../specs/2026-10-08-spec-p-transactional-persistence.md), **r18**, binding. D4 supersedes conflicting [P2a](../specs/2026-10-08-spec-p2a-crash-safe-control-design.md) operation rules.

Starting point: `feat/spec-p-phase-2`, `510dd59`. Source citations remain valid from `89eedeb`, which has identical implementation files. This document authorises no execution during drafting.

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
- Edit the existing `.changeset/spec-p-storage-foundation.md` intent directly. Use pnpm versioning, never `@changesets/cli`.
- “twelve packages share one version band (same minor pre-1.0, same major from 1.0); raising it is a group act, but a patch release within the band is not.” The current band intent names fourteen published packages.
- For test-quality-critical guards, break the guard, confirm its test fails, restore it, then rerun the paired checks.
- Lint before every staging step: `rtk proxy pnpm run lint`.
- Every implementation commit passes `rtk proxy pnpm turbo run build:js build:types test:types` and its task's regression checks.
- Every task changing peer behaviour runs full `@kumiai/rpc` and `@kumiai/mls-rpc` `test` suites and the integration suite.
- These are branch milestones. Publish nothing between 2.2a and 2.2b's replacement of the temporary access seam.
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

- A version-only move preserves prepared bytes. An identity, checkpoint or queue move discards them unpublished. Task 2 tests both paths.
- Retention below the saved checkpoint permits acceptance. A gap after it blocks acceptance. Task 3 tests trimmed and incomplete suffixes.
- Public member commits and unavailable authentication must never hide an earlier winner. Task 3 tests both with later own replays.
- A revoke drain crosses the absolute deadline. Task 4's `expiry during submission drain prevents handoff` asserts zero handoffs.
- An acknowledged unknown slot later lands first-valid. Task 4's late-landing test asserts adoption, a new landed fact and Welcome delivery.

## Phase-2.2 ownership

This table replaces the 2.1 table's 2.2 decomposition and moves registry core from 2.3 into 2.2b. Each item has one delivery owner.

| Spec item | Sole owner | Delivery boundary |
| --- | --- | --- |
| D4 private commit-once slot, BuiltCommit/HostBuilt, immutable searchFrom, deadline and FIFO runner | 2.2a | Tasks 1, 2, 4, 6 |
| FirstValidCommit, CommitSearchResult, ControlSearchPort and accepted-stage proof | 2.2a | Tasks 3-6, including checkpoint-bound suffix validation and slot-driven own settlement |
| Control build-save/adoption source guards and removal of control lineage | 2.2a | Single-incarnation staging below. No registry construction |
| Empty control proposals, rotation builder's empty-proposal refusal, ordinary adoption progress carry | 2.2a | Tasks 2 and 5. Rotation scheduling remains 2.3 |
| First-valid Welcome release and commit-once crash/conformance rows | 2.2a | Tasks 4-7. Invitee package consumption remains 2.3 |
| Registry core: createGroupHandleRegistry, access, seed, judgeWelcomeAdmission, recoverySource, switchIncarnation, delete/dispose | 2.2b | Replaces the single-incarnation runtime staging with lifetime ownership and real versions |
| Incarnations, spent admission, stopped/drained switch and retained old-incarnation obligations | 2.2b | Old outcomes/Welcomes stay addressable. No old peer restarts |
| GroupSafety except recover, durable fork halt/evidence/events and recovery-unavailable hold | 2.2c | Both classifier branches, all send/open/control/startup gates, event acknowledgement |
| Broad removal of automatic fork healing, forkSettlement and deleteAppliedFrom | 2.2c | Task 4 already removes unsupported-version and unexplained-own recovery. General past-fork migration remains here |
| captureHead recovery reply v2 and authenticated target propagation | 2.2d | Signed string/null head, v2 domains, exact initial CAS and retained external attempt |
| Trust-based recovery, stranded reconciliation and confirmed incarnation switch orchestration | 2.2d | Uses 2.2b switch and 2.2a validation concepts, with external-attempt rules |
| Removal of sourceRecheck, SourceScan and conflictEpoch | 2.2d | Removes structural source-prefix recovery approval |
| GroupSafety.recover, ManualRecoveryRecord, selected target and successor retirement | 2.2e | Persist authorisation, resume selected attempt, retain halt on failure |
| Batching, handlers, leases/rotation scheduling, package adapters, atomic Welcome burn, restore-work, settlements/events, registry consumer adapters | 2.3 | Remains runtime follow-up. Core registry ownership is excluded |
| Hub-client lifts, MLSEncryptor, final full contracts and real HTTP smoke | 2.4 | Unchanged |

Search uncertainty holds only private-control acceptance. Ordinary ahead/gap/unprocessable cases retain existing strand behaviour in 2.2a.
Automatic resync orchestration remains 2.2d. Unsupported semantics and control fork evidence receive a persisted control hold in Task 4.
Full durable D1 halt, all-path safety and machine-readable events remain 2.2c.
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

Task 1 adds `HandleAccess.readControl`, reusing the access serialiser. Its owned snapshot supports refreshing without reacquiring access.
`SimpleHandleAccessParams` adds `key?: GroupKey` and required `stateVersion: () => number | Promise<number>`.
An omitted key means `{groupID: handle.groupID, incarnation: 1}` for single-incarnation access. There is no version default.
Simple hosts serialise state writes with that handle. Their callback must describe that same state, never an independently newer row.

Transactional access waits for issued **storage writes**, then restores one stored row's state and revision together.
It never pairs `live` with `store.snapshot().revision` or awaits `openTail` while owning the access gate.
An open may commit before its delayed publish. `readControl` still uses that committed row, preserving consumed receive progress.
Its owned `refresh()` repeats this read-and-restore path. Version-only preparation retries use it without nested access entry.

`GroupMLS.readRecoverySource(): Promise<ControlSource>` uses the configured key and the owned handle/version pair.
Host-db uses `loadVersion(groupID)`. Transactional access uses the restored row's revision.
Memory MLS increments its version on every state write, including opens, seals, proposal changes and adoption.
Reconstruction reloads the version. Searches do not increment it. An epoch is never a state version.

2.2b replaces configured incarnation and host callbacks with registry key/version and its already-owned transition capability.
It also supplies normative `RecoverySource`, including retained trust and lifetimeRevision.
The build saver currently enters one root transition while access owns preparation. Transaction-bound stores never enter another transition.
2.2b replaces this injection with its already-owned registry transition, rather than nesting roots.
Evidence reads use the same replaceable, coherent host seam. No registry is constructed here.

Remove lineage from control and rejoin source types and mirrors. Retain legacy rejoin epoch/authenticator/head with key/incarnation.
2.2d removes its sourceRecheck/conflictEpoch algorithm.
Tasks 1-3 add tested components. Task 4 delivers the guarded adopter **before** activating the runner and hold paths.
Task 5 adds real progress/proposal parity. Task 6 adds crash/shared contracts. Task 7 records the release intent and complete gate.

---

### Task 1: Source identity and an independently retained control slot

**Files:**
- Modify: `packages/rpc/src/control/types.ts:4-161`, `packages/rpc/src/control/store.ts:31-98`, `packages/rpc/src/crypto.ts:427`, `packages/rpc/src/control/operations.ts:24-60`, `packages/rpc/src/control/rejoin.ts:16-48`, `packages/rpc/src/index.ts:38-64`.
- Modify: `packages/mls-rpc/src/access.ts:12-105`, `packages/mls-rpc/src/mls.ts:285-290`, `packages/mls-rpc/src/revoke.ts:60`, `packages/mls-rpc/src/persistence-types.ts:17-19`, `packages/mls-rpc/src/memory-incarnation-stores.ts:154-162`, `packages/mls-rpc/src/memory-group-ports.ts`, `packages/mls-rpc/README.md`.
- Modify mirrors/fixtures: `packages/rpc-conformance/src/control-store.ts`, `packages/rpc-conformance/src/group-mls.ts`, `packages/rpc-conformance/src/memory-control-store.ts`, `packages/rpc-conformance/src/index.ts`, `packages/rpc/test/fixtures/host-db.ts`, `packages/rpc/test/fixtures/memory-group-mls.ts`, `packages/rpc/test/fixtures/peer.ts`, `packages/mls-rpc/test/fixtures/transactional-access.ts`, `packages/mls-rpc/test/fixtures/real-group.ts`, `tests/integration/test/app-lane-e2e.ts`.
- Test: `packages/rpc/test/control-store.test.ts`, `packages/rpc/test/control-store-conformance.test.ts`, `packages/mls-rpc/test/adoption-write.test.ts`, `packages/mls-rpc/test/group-namespaces.test.ts`.
- Mechanical type consumers: `packages/rpc/test/control-operations.test.ts`, `packages/rpc/test/peer-rejoin-record.test.ts`, `packages/rpc/test/peer-fork-settlement.test.ts`, `packages/rpc/test/peer-readmission.test.ts`, `packages/rpc/test/peer-control-retry.test.ts`, `packages/rpc/test/group-mls-adoption.test.ts`, `tests/integration/test/operation-host.test.ts`, `tests/integration/test/recovery-confirmation.test.ts`, `tests/integration/test/anchor-rotation-recovery.test.ts`, `tests/integration/test/epoch-log-delivery.test.ts`, `tests/integration/test/lifecycle-admission.test.ts`, `tests/integration/test/history-frame-size.test.ts`.

- Mechanical access consumers: `packages/mls-rpc/test/crypto.test.ts`, `packages/mls-rpc/test/durable-save-order.test.ts`, `packages/mls-rpc/test/readme-persistence.test.ts`, `packages/mls-rpc/test/persist-boundary.test.ts`, `packages/mls-rpc/test/transactional-access.test.ts`, `packages/mls-rpc/test/ports-conformance-transactional.test.ts`, `packages/mls-rpc/test/recovery-codec.test.ts`, `packages/mls-rpc/test/commit-topic-proposal.test.ts`, `packages/mls-rpc/test/commit-pre-resolution.test.ts`, `packages/mls-rpc/test/handle-access.test.ts`, `packages/mls-rpc/test/ports-conformance.test.ts`, `packages/mls-rpc/test/recovery-secret.test.ts`, `packages/mls-rpc/test/epoch-results.test.ts`, `packages/mls-rpc/test/recovery-holder-evidence.test.ts`, `packages/mls-rpc/test/standalone-helpers.test.ts`, `packages/mls-rpc/test/fixtures/codec-reopen.ts`, `tests/integration/test/app-lane-delivery.test.ts`, `tests/integration/test/peer-drained-wire.test.ts`, `tests/integration/test/recovery-known-registry.test.ts`, `tests/integration/test/migration-persistence.test.ts`.

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
type ControlSlot = BuiltCommit & { opID: string }
type ControlBuildRef = Pick<BuiltCommit, 'incarnation' | 'epoch' | 'publishID' | 'payloadDigest'>
type HostBuilt = Pick<BuiltCommit,
  'incarnation' | 'epoch' | 'authenticatorBefore' | 'digest' | 'bodies' | 'journal' | 'welcome'
> & { commit: Uint8Array }
```

- Produces required `ControlStore.key: GroupKey`, `ControlSnapshot.commitOnce: ControlSlot | null`, and `StagedAdoption.incarnation: number`.
- Produces `commitOnceAcceptance: FirstValidCommit | null` on snapshots and optional slot/acceptance changes.
- Slot owner `opID` extends the spec's BuiltCommit internally. `HostBuilt` remains the normative builder shape.
- Declares ControlBuildRef for Task 4. Activation then replaces operation journals with slot references, checking every reference field.
- Adds `deadline: number` to the operation base and mirror now. enqueueOperation persists `enqueuedAt + (operationTimeoutMs ?? 30_000)` once.
- Task 4 switches all preparation/runner expiry checks to that stored field. Earlier tasks retain legacy transition behaviour.
- A missing/mismatched slot is uncertainty, never permission to reconstruct bytes. Acceptance metadata must bind the slot's digest and search origin.
- Produces optional `AdoptionWrite.expected?: AdoptionExpected`. Private-control adoption requires it. The host rechecks it inside the save transaction.
- Produces `GroupMLS.readRecoverySource(): Promise<ControlSource>` in RPC.
- Produces in `mls-rpc/src/access.ts`, without importing MLS into RPC:

```ts
type ControlRead = { handle: GroupHandle; source: AdoptionExpected }
type ControlReadScope = ControlRead & { refresh(): Promise<ControlRead> }
// HandleAccess member:
readControl<TValue>(fn: (scope: ControlReadScope) => Promise<TValue>): Promise<TValue>
```
- Control rows, responses, cursor and outcomes are bound by their fixed `ControlStore.key`/incarnation namespace. Never resolve a row through a different active key.

- [ ] **Step 1: Write slot and source tests.** Use existing typed fixtures, with key `{groupID: 'group-A', incarnation: 1}`.

`slot survives operation deletion outcome acknowledgement and reopen`:

```ts
expect(afterAck.commitOnce).toEqual(savedSlot)
expect(afterAck.operations).toEqual([])
expect(afterAck.outcomes).toEqual([])
expect(reopened.commitOnce).toEqual(savedSlot)
expect(afterCallerMutation.commitOnce).toEqual(savedSlot)
```

`enqueue persists the selected absolute deadline` asserts deadline 1_000 for enqueue time 0 and timeout 1_000, plus default 30_000.

`readControl returns the host version and a defensive single-incarnation identity`:

```ts
expect(source.key).toEqual({ groupID: 'group-A', incarnation: 1 })
expect(source.stateVersion).toBe(await hostDB.loadVersion('group-A'))
expect(source.identity?.authenticator).toEqual(authenticator)
expect(source).not.toHaveProperty('lineage')
expect(staged.incarnation).toBe(1)
```

Add `transactional readControl uses committed receive state before open publication` in transactional-access.test.ts.
Suspend an open after its storage commit but before publishing its handle. Invoke readControl during that suspension.
Assert encoded source bytes equal the committed row, source.stateVersion equals its revision, and the consumed message remains unavailable.
Assert readControl and the resumed open finish within the test timeout. Compare complete bytes, not epoch equality.

Add rollback and explicit-null round-trips to shared control-store conformance. Authorise occupied-slot clearing only through an epoch-advancing adoption context.
An omitted change preserves the slot. Generic same-epoch explicit null must fail once Task 2 installs provider guards.

- [ ] **Step 2: Run red checks.**

```sh
rtk proxy pnpm --filter @kumiai/rpc run test:types
rtk proxy pnpm --filter @kumiai/rpc run test:unit test/control-store.test.ts test/control-store-conformance.test.ts
rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/adoption-write.test.ts test/group-namespaces.test.ts test/transactional-access.test.ts
```

Expected: missing source/slot declarations or missing retained slot assertions fail. No synthetic first-valid proof is introduced.

- [ ] **Step 3: Implement the listed declarations and source mapping in their named files.**

Initialise every empty snapshot with `commitOnce: null` and `commitOnceAcceptance: null`. Copy nested slot values defensively in both independent reducers.
Expose memory persistence's already-fixed `ports(key).key` on its control facade. Give legacy stores an explicit constructor key.
Update host fixtures and conformance mirrors atomically. Persist the deadline at enqueue and update manually seeded operation rows.
Existing framing captures searchFrom once, pending Task 2's transactional checkpoint guard.
Keep the legacy runner's inline built value until Task 4 activates guarded save/reference consumers together.
Tasks 1-3 exercise retained slots through their new fixtures/components; the legacy runner does not populate them.
This prevents Task 2's slot guards from breaking the old runner before activation. Final source journals persist only in the slot.
Update every README example with host-backed stateVersion and explain temporary incarnation 1, readControl ownership and 2.2b replacement.
Retain the old accepted shape until Task 4. Add proof types now without manufacturing proof for the old runner.
Mechanically replace legacy rejoin lineage equality with key/incarnation equality. Do not remove sourceRecheck, conflictEpoch or fork settlement here.

- [ ] **Step 4: Run green checks.** Run Step 2 after `rtk proxy pnpm turbo run build:js build:types test:types`.

Also run full `rtk proxy pnpm --filter @kumiai/rpc run test`, `--filter @kumiai/mls-rpc run test`, and `--filter @kumiai/integration-tests run test`.
Expected: all PASS, including rejoin identity, README and migration consumers.

- [ ] **Step 5: Mutation-check slot retention.** Temporarily clear commitOnce on deleteOutcomes. Run Step 2's RPC pair.

Expected: `slot survives operation deletion outcome acknowledgement and reopen` FAILS. Restore the guard and rerun to PASS.

- [ ] **Step 6: Commit the source/slot contract during implementation.**

Run `rtk proxy pnpm run lint`. Stage exactly the paths in this task's Files block.
Run `git commit -m "feat(control): add source identity and retained commit-once slot"`.
Expected: one green contract commit with no unrelated or generated paths.

### Task 2: Guarded preparation and retained MLS validation material

**Files:**
- Create: `packages/rpc/src/control/build.ts`, `packages/mls-rpc/src/control-build.ts`, `packages/mls-rpc/src/control-journal.ts`, `packages/mls/src/group-rotation.ts`.
- Modify: `packages/rpc/src/index.ts`, `packages/mls-rpc/src/index.ts`, `packages/mls/src/index.ts`, `packages/mls/src/group-commit.ts`, `packages/mls/src/group-lifecycle.ts`, `packages/mls/src/group-device.ts`, `packages/mls-rpc/src/revoke.ts`.
- Modify guards/reducers: `packages/rpc/src/control/store.ts`, `packages/mls-rpc/src/memory-incarnation-stores.ts`, `packages/mls-rpc/src/memory-group-ports.ts`, `packages/rpc-conformance/src/control-store.ts`, `packages/rpc-conformance/src/memory-control-store.ts`.
- Modify fixtures: `packages/rpc/test/fixtures/host-db.ts`, `packages/rpc/test/fixtures/peer.ts`, `packages/rpc/test/fixtures/memory-group-mls.ts`, `packages/mls-rpc/test/fixtures/transactional-access.ts`, `tests/integration/test/app-lane-e2e.ts`.
- Create/Test: `packages/mls-rpc/test/control-build.test.ts`, `packages/mls/test/group-rotation.test.ts`.
- Migrate/Test: `packages/rpc/test/control-store-conformance.test.ts`, `packages/mls-rpc/test/group-namespaces.test.ts`, `packages/mls-rpc/test/transactional-access.test.ts`, `packages/mls/test/group-lifecycle.test.ts`, `packages/mls/test/lifecycle-pipeline.test.ts`, `packages/mls/test/device-write.test.ts`.

**Interfaces:**
- Consumes: Task 1 `HandleAccess.readControl`, `ControlSlot`, `ControlBuildRef`, `HostBuilt`, `AdoptionExpected` and fixed `ControlStore.key`.
- Produces RPC build contracts and mls-rpc factories/journal codec:

```ts
type FrameControlBuild = (built: HostBuilt, seal: GroupCrypto['sealEntries']) => Promise<{
  payload: Uint8Array; publishID: string; expectedHead: LogPosition | null
}>
type PrepareControlResult =
  | { kind: 'saved' | 'occupied' | 'moved' | 'expired'; operation: Operation }
  | { kind: 'rejected'; operation: Operation; reason: string }
type ControlBuildPort = {
  prepareBuild(op: Operation, frame: FrameControlBuild): Promise<PrepareControlResult>
}
type SaveControlBuild = (intent: Operation & { stage: 'intent' }, built: ControlSlot,
  expected: AdoptionExpected, mutationID: string) => Promise<'saved' | 'moved' | 'occupied'>
function createPersistenceBuildSaver<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>; key: GroupKey
}): SaveControlBuild
function createControlBuildPort(params: {
  access: HandleAccess; control: ControlStore
  build: (op: Operation, group: GroupHandle) => Promise<HostBuilt>
  saveBuilt: SaveControlBuild; now: () => number; newID: () => string
  entryLabel?: string; runtime?: Runtime
}): ControlBuildPort
type ControlJournal = {
  version: 1; source: AdoptionExpected; checkpoint: LogPosition | null
  sourceState: Uint8Array; sourceCredential: MemberCredential
  sourceLedger: Array<string>; candidate: Uint8Array
}
function encodeControlJournal(value: ControlJournal): Uint8Array
function decodeControlJournal(bytes: Uint8Array): ControlJournal
// Internal provider context, derived inside the transaction. Never a ControlChanges field.
type CommitOnceWriteContext =
  | { kind: 'build'; source: AdoptionExpected; queueHeadID: string; checkpoint: LogPosition | null }
  | { kind: 'adoption'; before: EpochIdentity; after: EpochIdentity | null; retired: boolean }
  | { kind: 'head'; source: EpochIdentity }
function assertCommitOnceChange(previous: ControlSlot | null, next: ControlSlot | null,
  context: CommitOnceWriteContext | null): void
type CommitKeyRotationResult = { commitMessage: Uint8Array; newGroup: GroupHandle; epoch: bigint }
function commitKeyRotation(group: GroupHandle): Promise<CommitKeyRotationResult>
```

`sourceState` is a lossless pre-build MLS v2 snapshot, including proposals and decryption material.
The saved source snapshot proves reconciliation through `checkpoint`, including a Welcome-established initial boundary. The save transaction binds `checkpoint === built.searchFrom === stored cursor.position`.
It also checks cursor.epoch against the source epoch. An absent cursor represents null only at an established initial installation.
The control journal's version 1 is independent of the MLS state codec. Its opaque candidate remains unchanged.

Preparation results never mean completed work. `occupied` leaves the intent waiting. `moved` discards only unpublished preparation.
`expired` delegates lost settlement to the runner. `rejected` delegates rejected settlement. `saved` returns the committed built reference.
Storage ambiguity stays inside the saver until resolved. Ownership conflict fail-stops; it is not a retry result.

- [ ] **Step 1: Write failing preparation and slot-guard tests.**

`raw built-save rejects changed version` exercises the raw saver and asserts `'moved'`, no rows/markers changed and zero publications.
`version-only preparation retry refreshes under owned access` exercises the factory:

```ts
expect(result.kind).toBe('saved')
expect(saveAttempts).toBe(2)
expect(buildCalls).toBe(1)
expect(frameCalls).toBe(1)
expect(secondExpected.stateVersion).toBe(freshVersion)
expect(saved.commitOnce?.payload).toEqual(prepared.payload)
expect(saved.commitOnce?.publishID).toBe(prepared.publishID)
expect(nestedAccessCalls).toBe(0)
expect(prematureOutcomes).toEqual([])
expect(publications).toEqual([])
```

`built-save rejects an identity checkpoint or queue move` covers key, epoch, authenticator, cursor and FIFO head.
Assert `'moved'`, unchanged rows/markers, one build/frame and zero escaped bytes. Do not parameterise it over version-only factory retry.

`preparation framing does not reenter access` asserts completion using the supplied handle and source-bound seal.
`same-source direct and queued preparation share one slot` asserts one build/frame and the second result `'occupied'` with its unchanged intent.
`rolled-back save retries prepared bytes without another build` asserts identical payload/ID/journal and one build/frame.
`built-save first logical operation write rolls back with slot` faults before the slot write and asserts neither write nor marker persists.
`preparation and framing run outside provider transactions` records transaction entry and asserts zero crypto calls inside it.

`transactional build uses committed open state before delayed publication` extends Task 1's suspended-open schedule through guarded save.
Assert journal.sourceState equals committed bytes, source version matches that row, consumed receive progress survives and all calls finish.

Shared `slot changes require provider-verified context` covers each immutable field: owner, source epoch/authenticator/incarnation, payload/digests, ID, searchFrom, bodies, journal and Welcome.
It also covers same-epoch explicit null, arbitrary `apply`, current-slot replacement, head-only refresh, lower-epoch replacement and retirement.
Rejected changes leave every row and marker unchanged. Run both independent reducers through their actual providers.

`rotation refuses local pending proposals and otherwise preserves roster and ledger`:

```ts
await expect(commitKeyRotation(withPending)).rejects.toThrow('pending proposals')
expect(withPending.state).toEqual(before)
expect(rotated.newGroup.epoch).toBe(group.epoch + 1n)
expect(rotated.newGroup.ledgerTokens).toEqual(group.ledgerTokens)
expect(rotated.newGroup.listMembers()).toEqual(group.listMembers())
expect(rotated.newGroup.state.unappliedProposals).toEqual({})
```

Use a non-admin member and real receiver to check the rotation's update path and authenticator.
Migrate lifecycle/device builder refusal assertions to `CommitRejectedError`, preserving the original reason/cause assertion.

- [ ] **Step 2: Run red checks.**

```sh
rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/control-build.test.ts test/transactional-access.test.ts test/group-namespaces.test.ts
rtk proxy pnpm --filter @kumiai/rpc run test:types
rtk proxy pnpm --filter @kumiai/rpc run test:unit test/control-store-conformance.test.ts
rtk proxy pnpm --filter @kumiai/mls run test:types
rtk proxy pnpm --filter @kumiai/mls run test:unit test/group-rotation.test.ts test/group-lifecycle.test.ts test/lifecycle-pipeline.test.ts test/device-write.test.ts
```

Expected: missing factories/rotation, repeated preparation, checkpoint or slot-guard assertions fail.

- [ ] **Step 3: Implement preparation, transactional guards and journal encoding.**

Own readControl across slot/queue reads, preparation and guarded save. Keep provider transactions limited to revalidation and writes.
Use the supplied handle in the builder. Construct its seal with `deriveEntryKey` and `sealEntries` in mls-rpc/crypto.ts.
Revoke construction needs a supplied-handle helper. Preserve publishRevokeProof's enqueue routing.
All durable private-control entry points use prepareBuild. Bare MLS builders remain independent crypto primitives.

Before construction, consult the saved deadline, source, cursor, FIFO head and slot. Capture sourceState and checkpoint before building.
Frame once. Calculate base64url SHA-256 over the **full** payload. Set searchFrom once from the captured reconciled cursor.
The saver verifies key/identity/version, FIFO head, slot and cursor in one transaction, then co-writes slot and operation reference.
Never implement it as preflight reads followed by unconditional apply.

Provider predicates are explicit. Reducers receive only provider-derived context, never authority claimed by ControlChanges:

| Slot change | Required provider context |
| --- | --- |
| Initial build or replacement | Guarded saveBuilt. Stored slot is null, or older than verified source epoch, or belongs to a proven retired incarnation |
| Clear occupied slot | Adoption transaction advances its source epoch, or lifetime transaction proves retirement |
| expectedHead-only refresh | Same owner and all immutable fields equal. Transaction reads the identical source key/epoch/authenticator |
| Exact unchanged slot | No-op; no release or replacement |
| Any other apply carrying commitOnce | Reject atomically |

A same-epoch source change cannot authorise replacement. A later-epoch build may replace a retained older slot without itself advancing the epoch.
Guard acceptance metadata separately: proof must bind the occupied slot. Generic operation/outcome/Welcome deletion cannot alter either slot field.
Implement assertCommitOnceChange in rpc/control/store.ts and invoke it from provider admission paths.
Implement an independent equivalent in the conformance provider/reducer; never import the production predicate there.
Legacy host savers decode their stored state with the host's codec inside the transaction, rather than reading the published live handle.
Extend the shared control-store harness with guarded saveBuilt and epoch-advancing save fixtures, using independent Conformance mirrors of Task 2's signatures.
Plain ControlStore.apply lacks adoption authority. Its provider may verify a head refresh, but cannot accept an arbitrary clear or initial build.

Proven rollback retries the same prepared bytes under access ownership. Refresh version-only conflicts through scope.refresh(), never another readControl call.
Journal source/version remains the original checkpoint evidence. The next save attempt uses fresh expected stateVersion without rebuilding or rewriting the journal.
Identity, cursor or FIFO changes discard preparation unpublished. Death before built-save permits preparation again.

- [ ] **Step 4: Implement rotation and explicit empty control proposals.**

Call commitWithEntries with `pendingProposals: {}`, `extraProposals: []`, `enacted: []`, `requireAdmin: false` after refusing pending proposals.
Retain lifecycle gates and update path. Invite/remove/ledger/revoke builders explicitly pass empty pending proposals.
Preserve commitSelfRemovals' by-reference behaviour. Explicit emptiness wraps lifecycle gate failures in CommitRejectedError; preserve its raw cause.

- [ ] **Step 5: Run green and mutation checks.**

Rebuild and run Step 2 plus repository-wide test:types. Run full rpc, mls-rpc and integration `test` suites.
Expected: PASS, including the migrated lifecycle/device tests.
Omit source-version validation and expect the raw saver test to fail. Restore it.
Allow explicit null or immutable-field replacement and expect shared slot tests to fail. Restore and rerun paired checks.

- [ ] **Step 6: Commit guarded preparation during implementation.**

Run lint. Stage exactly this task's Files. Run `git commit -m "feat(control): guard build persistence and retain checkpoint validation material"`.
Expected: one green deliverable.

### Task 3: Checkpoint-bound first-valid search and three-way MLS validation

**Files:**
- Create: `packages/rpc/src/control/search.ts`, `packages/rpc/src/control/occurrence.ts`, `packages/mls-rpc/src/control-validation.ts`.
- Modify: `packages/mls/src/group-handle.ts:227-317,1137-1178,1378-1391,1480-1540,1638-1647`, `packages/mls/src/sender-data.ts`, `packages/mls/src/group-info.ts`, `packages/mls/src/errors.ts`, `packages/mls/src/index.ts`.
- Modify: `packages/mls-rpc/src/apply-commit.ts`, `packages/mls-rpc/src/mls.ts`, `packages/mls-rpc/src/index.ts`, `packages/mls-rpc/src/persistence-types.ts`, `packages/rpc/src/crypto.ts`, `packages/rpc/src/ledger-entries.ts`, `packages/rpc/src/peer.ts:2117-2145,2711`, `packages/rpc/src/index.ts`.
- Modify mirrors/fixtures: `packages/rpc-conformance/src/group-mls.ts`, `packages/rpc/test/fixtures/memory-group-mls.ts`, `packages/rpc/test/fixtures/host-db.ts`, `packages/mls-rpc/test/fixtures/transactional-access.ts`, `tests/integration/test/app-lane-e2e.ts`.
- Create/Test: `packages/rpc/test/control-search.test.ts`, `packages/rpc/test/ledger-entries.test.ts`, `packages/mls-rpc/test/control-validation.test.ts`.
- Migrate/Test: `packages/mls-rpc/test/commit-pre-resolution.test.ts`, `packages/mls-rpc/test/epoch-results.test.ts`, `packages/mls-rpc/test/ports-conformance.test.ts`, `packages/mls-rpc/test/ports-conformance-transactional.test.ts`, `packages/rpc/test/peer-control-settlement.test.ts`, `packages/rpc/test/peer-strand-observation.test.ts`.

**Interfaces:**
- Consumes: Tasks 1-2 checkpoint journal, slot, proof types and owned source reads.
- Produces in RPC (factory in mls-rpc):

```ts
type ControlLogFrame = { position: LogPosition; payload: Uint8Array; senderDID: string }
type ControlFrameValidation =
  | { kind: 'valid'; header: CommitHeader; own: boolean; advanced: boolean; removed: boolean }
  | { kind: 'invalid'; reason: 'non-commit' | 'malformed' | 'authentication' | 'policy' }
  | { kind: 'unavailable'; reason: 'unsupported-version' | 'missing-proposal' |
      'missing-key' | 'resolver' | 'unrecognised' | 'unexplained-own' }
type ControlValidation = {
  source: AdoptionExpected
  readCommitHeader(commit: Uint8Array): Promise<CommitHeader | null>
  validateFrame(frame: ControlLogFrame, built: BuiltCommit): Promise<ControlFrameValidation>
  verifyOwn(built: BuiltCommit): Promise<boolean>
}
type ControlValidationPort = {
  restoreValidation(built: BuiltCommit): Promise<ControlValidation | null>
}
type ControlEvidenceSnapshot = {
  source: AdoptionExpected; applied: Array<AppliedCommit>
  cursor: CommitCursor | null; terminal: boolean
}
type CertifiedControlRange = {
  key: GroupKey; source: EpochIdentity; from: LogPosition | null; through: LogPosition
  winner: { position: LogPosition; payloadDigest: string }
  losers: Array<{ position: LogPosition; payloadDigest: string }>
}
type FollowWinnerResult =
  | { kind: 'applied'; position: LogPosition }
  | { kind: 'unavailable' | 'refused' | 'moved' }
type ControlHold = {
  reason: 'acceptance-unknown' | 'unsupported-version' | 'fork-evidence'
  position: LogPosition | null; evidence?: GroupForkEvidence
}
type ControlSearchDeps = {
  fetch(after: LogPosition | null): Promise<HubFetchTopicResult>
  validation: ControlValidationPort
  readEvidence(): Promise<ControlEvidenceSnapshot>
  followWinner(frame: ControlLogFrame, range: CertifiedControlRange): Promise<FollowWinnerResult>
  reconcileAbsent(head: LogPosition | null, range: CertifiedControlRange | null): Promise<boolean>
  hold(value: ControlHold): Promise<void>
}
function createControlSearch(deps: ControlSearchDeps): ControlSearchPort
function createControlValidationPort(params: {
  identity: OwnIdentity; options: GroupOptions; entryLabel?: string
  restoreCandidate: (candidate: Uint8Array) => Promise<GroupHandle>
}): ControlValidationPort
```

`GroupForkEvidence` uses the exact spec union at lines 809-812. HubFetchTopicResult comes from @kumiai/hub-tunnel.
`readEvidence` reads state identity/version, terminal and control in one committed host/provider snapshot for the fixed key.
Host-db and transactional-access expose atomic row snapshots. Provider-backed readers use one persistence read.
It never combines a published old handle with newer storage metadata.

Retain `GroupMLS.readCommitHeader(): Promise<CommitHeader | null>`, but propagate typed unavailable errors.
Add `validation?: 'unavailable'` to ProcessCommitResult, requiring false applied/advanced and equal epochs.
Add `CommitValidationUnavailableError extends Error` with `(message?: string, options?: ErrorOptions)`.
The epoch probe returns null only for conclusively non-commit bytes. At another epoch it reports structural epoch without attempting current-key authentication.
At the source epoch, probe failures propagate unavailable diagnostics. The search consumes validateFrame's three outcomes, never committer-less headers as invalidity.
External recovery keeps `searchOccurrence(fetch, from, payloadDigest): Promise<{found: LogPosition} | 'absent' | 'gap'>` until 2.2d.

- [ ] **Step 1: Write failing search and real validation tests.**

`first-valid lands on a trimmed log` uses a Welcome-joined builder beyond 64 epochs and trims only below searchFrom.
`normal second-epoch build needs no retained pre-checkpoint applied rows` prunes that history before search.
Both assert first-valid proof from the saved checkpoint, suffix-only fetches and zero validation calls at or below searchFrom.
`mismatched journal checkpoint refuses proof` corrupts checkpoint/searchFrom binding and asserts unknown/no adoption/Welcome.

`match never bypasses suffix or page gaps` covers gaps after searchFrom, matching-page gaps, empty nonterminal pages and inconsistent/backward heads.
Assert unknown, no cursor advance, zero adoption and zero Welcome. Retention before the checkpoint alone is not a failure.

`earlier valid competitor supersedes an alternate-ID exact own replay` asserts superseded, winner cursor/authenticator, no own adoption and no Welcome.
Parameterise private member, public member and external competitors. Include a public member ledger commit with mandatory policy checks.
`first-valid self-removal wins without epoch advance` asserts committed terminal/control state, supersession and zero own adoption/Welcome.

`unavailable header or body resolution cannot hide an earlier winner` injects member AEAD, external authentication/proposal and transient body resolver faults.
Put an exact own replay later in every range. Assert unknown, unchanged cursor, retained slot and zero adoption/Welcome.
`conclusive authentication or policy rejection is skippable poison` separately checks malformed bytes, identified crypto refusal and normal policy refusal.

`validator owns its resolver callbacks and buffers` compares encoded live state, sender/receiver trees, ledger, admission and event counts.
Interleave live and validator ledger commits. Both succeed and resolver slots remain independent.
Assert zero validator onLedgerEntries, live events and host persistence callbacks. Policy callbacks still run for their decisions.
Repeat for refused validation. Do not settle for an unchanged live epoch assertion.

`dependency diagnostics survive binding-error replacement` pins these exact rc.13 ValidationError messages:

```ts
expect(missingReference.message).toBe('Could not find proposal with supplied reference')
expect(futureGeneration.message).toBe('Desired generation too far in the future')
expect(consumedGeneration.message).toBe('Desired gen in the past')
expect(result.kind).toBe('unavailable')
```

`validator and live winner disagreement holds` covers validator-valid/live-refused or unavailable and validator-unavailable/live-capable.
Assert unknown and no Welcome in both directions. The second direction must never call live processing to manufacture proof.

`already adopted own build requires committed full payload evidence` asserts matching applied position/digest permits idempotence after restart.
Candidate authenticator equality without that row yields unknown. A conflicting committed branch yields evidence hold.
`certification excludes only listed loser bytes` asserts unrelated position/digest divergence outside the certified range still reaches the fork classifier.

- [ ] **Step 2: Run red checks.**

```sh
rtk proxy pnpm --filter @kumiai/rpc run test:types
rtk proxy pnpm --filter @kumiai/rpc run test:unit test/control-search.test.ts test/ledger-entries.test.ts test/peer-strand-observation.test.ts
rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/control-validation.test.ts test/commit-pre-resolution.test.ts test/epoch-results.test.ts test/ports-conformance.test.ts test/ports-conformance-transactional.test.ts
```

Expected: missing validator/search contracts, public-member blind spot and swallowed availability errors fail.

- [ ] **Step 3: Implement isolated validation and diagnostics.**

Restore fresh copies of source state/credential/ledger. Create a fresh createLedgerEntrySlot() for each validation instance.
Construct validator-only options/context. Preserve crypto provider, policy and binding inputs. Replace resolveLedgerEntries with the validator's slot.resolve.
Strip onLedgerEntries and live notification/event sinks. Preserve resolver semantics through an isolated, diagnostic frame resolver.
Each source-epoch frame uses a fresh restored working snapshot, so one validation cannot consume another frame's source keys.
Successful competitor processing mutates only that working snapshot. The live walker follows the winner separately.

Support public member commits in header reading, readCommitEntryIDs and the control-envelope policy pre-pass.
Verify public membership tag and signature with normal ts-mls public-message authentication before mapping the sender leaf to its DID.
Do not use rejecting processCommit as a signature-only probe: proposal resolution can fail first.
Private, public member and external commits all receive normal ledger/roster/lifecycle checks.
verifyOwn binds source identity, full payload/commit digests and retained candidate history. Authorship alone supplies no acceptance proof.

Translate missing proposals/generations before group-handle replaces causes with bindingError and before applyCommit reduces errors to invalid.
Treat pinned dependency messages and unrecognised exceptions as unavailable. Only identified CodecError/crypto verification failures and policy rejection are conclusive invalidity.
Narrow sender-data/external-header catch blocks accordingly. Preserve transient failures from createLedgerEntryResolver rather than returning an empty token list.
A conclusively malformed/decrypt-rejected blob remains invalid. A missing referenced proposal or unavailable retained key remains unavailable.

The ordinary walker maps unavailable at its current epoch to existing **unprocessable-gap strand behaviour**.
Preserve its cursor barrier and observation. Do not introduce a search-style acceptance hold or disable ordinary recoverable-gap handling.
D1's new automatic resync orchestration is delivered by 2.2d.
Task 3 leaves ordinary unsupported-version and unexplained-own policy activation to Task 4.

- [ ] **Step 4: Implement checkpoint-bound search and evidence propagation.**

This algorithm fixes decisions that signatures alone cannot determine:

```text
1. Restore the saved journal, verify checkpoint == searchFrom and source binding.
   Read coherent current evidence. Retirement never follows a new owner. Same-epoch
   authenticator divergence holds. An advanced live branch requires matching committed
   applied evidence at the source epoch; a conflicting row is evidence, not rollback permission.
2. Start fetch at immutable searchFrom. The durable saved source proves everything through
   that checkpoint. Validate only (searchFrom, captured head]. Never restart at null or at
   refreshed expectedHead. Check every page's gap/head/order before interpreting its rows.
3. Decode supported frames and use the diagnostic epoch probe in order. Conclusive
   malformed/non-commit rows are invalid skips.
   Unsupported semantics or unavailable inputs => unknown. Compare frames with the saved
   source epoch even if live state advanced. Older suffix replays need matching committed
   history evidence; missing evidence => unknown, not assumed history.
4. Classify every source-epoch frame with the isolated three-way validator, including public
   member commits. Invalid skips. Unavailable stops. First valid competitor wins, including
   applied self-removal without epoch advance. Exact saved own bytes plus verifyOwn and
   complete prefix prove an own winner. Different authenticated own bytes hold as evidence.
5. Continue occurrence discovery after a competitor wins. Validate source-epoch frames from
   fresh source snapshots. Record exact certified loser positions/digests. A later exact own
   occurrence under any publishID can yield superseded only after followWinner returns
   applied at the same winner position. Otherwise unknown. No own candidate/Welcome escapes.
6. An own winner produces {source, from: searchFrom, position, payloadDigest}. The earliest
   exact occurrence wins. An acknowledged position is only a hint. Refresh source version
   at unchanged identity. Already-adopted no-op requires matching committed applied payload
   and occurrence evidence, never current candidate authenticator equality alone.
7. A completely covered range with no exact own occurrence can yield absent only after
   following its winner and bounded reconciliation through the captured head. Disagreement
   or incomplete coverage yields unknown. A growing head requires another bounded pass.
```

Search may follow a proven competitor even if later own-occurrence coverage becomes uncertain. Its returned acceptance remains unknown in that case.
`CertifiedControlRange` travels into followWinner and reconcileAbsent. The peer's bounded walk checks exact key/source/position/payload entries before suppressing fork classification.
Keep a range only for that bounded pass. Refetch and revalidate after restart; no unbounded history exception or cached proof survives reconstruction.
The follow/reconcile callbacks reuse the already-owned peer lane. They do not reacquire runSerial or recursively run operation settlement.
Unsupported/unexplained-own walker holds and slot settlement are activated together in Task 4.
Extract legacy external occurrence search before replacing private-control search; do not fabricate BuiltCommit fields for RejoinRecord.

- [ ] **Step 5: Run green and mutation checks.**

Rebuild and run Step 2 plus repo-wide test:types. Run full rpc, mls-rpc and integration `test` suites.
Expected: PASS, including existing ordinary recoverable strand and external-search regressions.
Move matching before coverage and expect suffix-gap tests to fail. Restore it.
Skip public member validation or collapse unavailable to invalid and expect earlier-winner tests to fail. Restore and rerun paired checks.

- [ ] **Step 6: Commit search during implementation.**

Run lint. Stage exactly this task's Files. Run `git commit -m "feat(control): validate checkpoint suffixes before own acceptance"`.
Expected: one green search component commit.

### Task 4: Activate guarded adoption, slot settlement, deadlines and durable control holds

**Files:**
- Create: `packages/mls-rpc/src/control-adoption.ts`, `packages/mls-rpc/test/control-adoption.test.ts`, `packages/rpc/src/control/slot.ts`, `packages/rpc/test/control-slot.test.ts`, `tests/integration/test/control-first-valid.test.ts`.
- Modify: `packages/mls-rpc/src/index.ts`, `packages/rpc/src/control/operations.ts`, `packages/rpc/src/control/types.ts`, `packages/rpc/src/control/store.ts`, `packages/rpc/src/control/welcome.ts`, `packages/rpc/src/peer-types.ts`, `packages/rpc/src/peer.ts`, `packages/rpc/src/host-boundary.ts`, `packages/rpc/src/classify.ts`, `packages/rpc/src/index.ts`.
- Modify mirrors/providers: `packages/rpc-conformance/src/control-store.ts`, `packages/rpc-conformance/src/memory-control-store.ts`, `packages/mls-rpc/src/memory-incarnation-stores.ts`, `packages/mls-rpc/src/memory-group-ports.ts`.
- Modify hosts/fixtures: `packages/rpc/test/fixtures/peer.ts`, `packages/rpc/test/fixtures/host-db.ts`, `packages/rpc/test/fixtures/memory-group-mls.ts`, `packages/mls-rpc/test/fixtures/transactional-access.ts`, `tests/integration/test/app-lane-e2e.ts`.
- Migrate/Test: `packages/rpc/test/control-operations.test.ts`, `packages/rpc/test/peer-commit-cas.test.ts`, `packages/rpc/test/peer-control-settlement.test.ts`, `packages/rpc/test/peer-operations.test.ts`, `packages/rpc/test/peer-control-retry.test.ts`, `packages/rpc/test/peer-first-commit-crash.test.ts`, `packages/rpc/test/peer-welcome-obligations.test.ts`, `packages/rpc/test/peer-delayed-bootstrap.test.ts`, `packages/rpc/test/peer-unknown-frame-version.test.ts`, `packages/rpc/test/peer-unknown-commit-frame-version.test.ts`, `packages/rpc/test/commit-classify.test.ts`, `packages/rpc/test/peer-strand-observation.test.ts`, `packages/rpc/test/peer-recover-lane.test.ts`, `packages/rpc/test/peer-rejoin-record.test.ts`, `packages/rpc/test/peer-fork-settlement.test.ts`, `packages/rpc/test/peer-dispose-continuations.test.ts`, `packages/rpc/test/host-boundary.test.ts`, `packages/rpc/test/peer-removed-blind.test.ts`, `packages/rpc/test/peer-removed-member-anchor.test.ts`, `packages/mls-rpc/test/adoption-write.test.ts`.
- Retain/Test: `tests/integration/test/operation-host.test.ts`, `tests/integration/test/welcome-after-crash.test.ts`.

**Interfaces:**
- Consumes: Tasks 1-3 build/search/evidence contracts. HandleAccess.replace and existing AdoptionWrite.
- Produces operation base `{seq: number; enqueuedAt: number; deadline: number}`, with `built: ControlBuildRef` on built/accepted stages.
- Accepted operations require `{stage: 'accepted'; acceptedAs: LogPosition; acceptance: FirstValidCommit}`.
- Produces:

```ts
type ControlAdoptionPort = {
  adopt(journal: Uint8Array, expected: AdoptionExpected & { acceptance: FirstValidCommit },
    write: AdoptionWrite): Promise<'installed' | 'noop' | 'moved'>
}
function createControlAdoptionPort(params: {
  access: HandleAccess; control: ControlStore
  restoreCandidate: (candidate: Uint8Array) => Promise<GroupHandle>
}): ControlAdoptionPort
type ControlSlotDeps = {
  control: ControlStore; search: ControlSearchPort; adoption: ControlAdoptionPort
  readEvidence(): Promise<ControlEvidenceSnapshot>
  now(): number; newID(): string; emit(outcome: Outcome): void
}
function settleControlSlot(deps: ControlSlotDeps,
  occurrence?: ControlLogFrame): Promise<'landed' | 'superseded' | 'absent' | 'unknown' | 'empty'>
```

`settleControlSlot` searches/adopts but **never publishes or rebuilds**. Operation steps reuse it and resolve their reference to the slot.
`OperationDeps` uses prepareBuild's explicit result, ControlSearchPort.searchLog and ControlAdoptionPort.adopt.
It adds coherent readEvidence and readHead. Keep publish/pullToHead/clock/emit and stepOperation's Operation-or-null return.
Only the runner returns null after a proven settlement, never because preparation returned occupied/moved/expired/rejected.
`GroupPeerMLSParams` replaces build with required prepareBuild and validation. The adopt callback uses ControlAdoptionPort.adopt's signature.

Persist `ControlSnapshot.controlHold: ControlHold | null` and optional `ControlChanges.controlHold`.
Add normative `strand: {reason: 'retention-gap' | 'unprocessable-gap' | 'lost-state' | 'ahead' | 'unsupported-version'} | null`.
The hold is a temporary control barrier replaced by 2.2c, not a complete ForkHalt/event API.
Initialise both fields to null in all providers and independent reducers. Copy holds/evidence defensively.
Welcome dependencies add `canDeliver(obligation: WelcomeObligation): Promise<boolean>`.

- [ ] **Step 1: Write failing runner, slot, adoption and hold tests.**

`deadline survives reconstruction with changed configuration` enqueues at 0 with timeout 1_000, then restarts with 30_000 and 100.
Assert stored deadline 1_000 in both cases. No extension or shortening is allowed. Test 999, 1_000 and 1_001; expiry is `now >= deadline`.
Also assert default deadline 30_000. Never-built expired intents lose without building.

Replace control-operations' rebuild-on-absence test with `complete head-only absence refreshes CAS without rebuilding`.
Assert identical payload/ID/journal/handshake generation and searchFrom, with expectedHead alone refreshed.
`proposal and version changes after built-save retain identical bytes` runs actual persistence/search/runner paths with one build/frame.
`gap holds before deadline and settles unknown at deadline` retains the slot through ack and restart.
`transport failure retries before expiry and never hands off after expiry` checks backoff and deadline-clamped wakeups.
`epoch advance rebuilds only after complete absence and intent revalidation` checks fresh source-chain bytes and target rejection when already satisfied.

`expiry during submission drain prevents handoff` blocks settleLogSubmissions until the stored deadline and asserts zero mux/hub publish calls.
`accepted replay rechecks proof before adopt` makes prefix unavailable and asserts zero adoption/Welcome delivery.
`source retirement never rebuilds and same-epoch divergence never republishes` asserts unknown/hold, zero builds and zero handoffs.

`late first-valid landing of an acked unknown slot adopts and owes its Welcome`:

```ts
expect(afterAck.operations).toEqual([])
expect(afterAck.outcomes).toEqual([])
expect(afterAck.commitOnce?.opID).toBe(originalOpID)
expect(adoptedAuthenticator).toEqual(candidateAuthenticator)
expect(lateOutcome).toMatchObject({ kind: 'landed', opID: originalOpID, position })
expect(owedWelcome.opID).toBe(originalOpID)
expect(deliveredWelcome).toEqual(savedWelcome)
expect(buildCalls).toBe(1)
expect(extraPublishCalls).toBe(0)
```

Parameterise prior unknown/lost, acknowledged/unacknowledged, startup discovery and live walker discovery after expiry.
Resolve an already handed-off CAS late. Assert own walking occurs only after adoption. Repeated replay emits no duplicate landed fact.
`rejection abandon and generic deletion retain the slot` exercises each route, acknowledges outcomes, reconstructs and tries a new operation ID.
Assert no second same-epoch build. `committed Welcome survives abandon` fails delivery, abandons, reconstructs and asserts the obligation remains owed.

`unsupported versions and control fork evidence persist before recovery` covers both version layers, unexplained own bytes without a slot and same-epoch divergence.
Remove the triggering frame before restart. Assert saved reason/evidence, unchanged cursor, retained slot, no automatic recovery publication and held sends/control.
`ordinary unavailable validation strands as an unprocessable gap` asserts ordinary strand/observation behaviour, rather than a search-only hold.

`stale adoption version retries proof without rebuilding`, `adoption rollback leaves state control and anchor unchanged`, and `no-op requires committed payload evidence`:

```ts
expect(staleResult).toBe('moved')
expect(afterStale).toEqual(beforeStale)
expect(afterRollback).toEqual(beforeRollback)
expect(landedRows).toHaveLength(1)
expect(appliedRows).toHaveLength(1)
expect(buildCalls).toBe(1)
```

`terminal state governs removal despite historical applied ordering` seeds misleading applied rows in the fixed incarnation.
Assert terminal controls publication/removal, and old sorted removed rows do not mark an active state terminal.
`validation host methods drain and refuse after dispose` suspends validateFrame, disposes, then asserts drainage and refused later restore/header/validate/verify calls.

Existing regression migration is part of this activation task:

| File | Change now | Deferred coverage |
| --- | --- | --- |
| peer-unknown-frame-version.test.ts | Replace commit-topic healing with persisted hold, diagnostic and cursor preservation. Trigger rendezvous reply-decoding tests independently with an ordinary gap | None for unsupported versions |
| peer-unknown-commit-frame-version.test.ts | Replace inner-version healing with the same hold assertions. Retain malformed-frame skip cases | None for unsupported versions |
| commit-classify.test.ts | Give UNKNOWN_FRAME_VERSION a distinct `unsupported-version` disposition. Rename own row to settlement/evidence terminology | General past-epoch fork rows remain 2.2c |
| peer-strand-observation.test.ts | Replace own/tampered-own healing assertions with exact-slot settlement or evidence hold. Retain confidence and observation dedup | Ordinary ahead strand behaviour stays |
| peer-recover-lane.test.ts | Replace unexplained-own operation recovery trigger with a recoverable gap in lane/rendezvous tests. Add saved-slot settlement without lane reentry | Broad losing-branch recovery replacement is 2.2c |
| peer-delayed-bootstrap.test.ts | Replace its unexplained-own automatic-recovery trigger with a recoverable gap; retain anchor/bootstrap failure assertions | None for this trigger |
| peer-rejoin-record.test.ts | Replace own-unmerged recovery permission at :637 with no automatic bypass. Retain saved-build-before-rejoin ordering | sourceRecheck/source-scan cases remain 2.2d |
| peer-fork-settlement.test.ts | Migrate exact certified supersession and control acceptance disagreement to hold/local facts | General stored past-fork healing/forkSettlement/row-retirement cases remain 2.2c |
| peer-commit-cas.test.ts | Keep successive-epoch FIFO. Six head mismatches use one build. Give mailbox/trim tests positive deadlines | No timeout-zero build compatibility |
| peer-control-settlement/peer-operations/peer-control-retry/peer-first-commit-crash/peer-welcome-obligations | Require proof, slot references, orphan settlement and durable Welcome authorisation | External exact-attempt coverage retained |
| peer-dispose-continuations/adoption-write | Use the new host signatures and guarded adopter; preserve disposal and real self-removal assertions | Full terminal handler drain is 2.3 |

- [ ] **Step 2: Run red checks.**

```sh
rtk proxy pnpm --filter @kumiai/rpc run test
rtk proxy pnpm --filter @kumiai/mls-rpc run test
rtk proxy pnpm --filter @kumiai/integration-tests run test
```

Expected: old deadline/rebuild/own-healing/version-healing and raw-journal adopter behaviour fails the replacement assertions.

- [ ] **Step 3: Deliver guarded adoption before runner activation.**

Implement createControlAdoptionPort now, then migrate host-db, transactional-access, memory MLS and app-lane-e2e consumers.
Decode the wrapper and restore its opaque candidate. Check expected key/current identity/version under access ownership and again inside the save transaction.
Installation additionally requires current identity to equal the journal's original source. An already-installed candidate uses the committed-evidence no-op path.
Candidate authenticator equality is insufficient for no-op. Require matching committed full payload/occurrence evidence or the committed adoption mutation.
Return moved on stale expectations. Refresh proof/version without rebuild. Never install over another committed branch.

Carry current sender/receive progress before saving. Co-write state/trust/spent, applied/cursor/outcome, anchor and authorised Welcome changes.
With 2.1 persistence, installation updates trust/spent in that transition. Preserve certified outbox work; runtime finalisation remains 2.3.
Remove integration's raw `{state, ledger}` control decoder and authenticator-only no-op now. Legacy external candidates remain on their separate adapter.
Use the current incarnation state record's terminal flag for removalEffect and publication guards, never snapshot.applied.at(-1).
Legacy real hosts derive terminal from the stored MLS `groupActiveState.kind === 'removedFromGroup'`. The memory double persists an equivalent flag.

- [ ] **Step 4: Implement runner deadlines and independent slot settlement.**

Consume Task 1's absolute deadline persisted at enqueue. Never recompute it from current configuration.
All preparation, wakeup and handoff guards read that field. Configuration affects only new operations. Expiry means `now >= deadline`.
Before preparation, pull to head, revalidate intent and consult the slot. Occupied/moved intents wait; expired/rejected results settle explicitly.
Search before the **initial publication**, every replay, mismatch and transport retry. Search origin never changes.
Complete absence at unchanged identity refreshes only expectedHead. Epoch advancement permits fresh intent validation and a new build.

At first-valid, co-write slot acceptance, accepted operation when present, and the complete Welcome obligation.
The slot's owner supplies opID even without an operation row. Recheck retained acceptance before adoption or pre-adoption Welcome handoff.
canDeliver reads commitOnceAcceptance when the operation is absent. After adoption it uses the committed obligation; outcome rows never gate delivery.
An adoption transaction writes the landed outcome and may clear the epoch-advanced slot and its acceptance metadata.
Use stable landed outcome ID `JSON.stringify(['control:landed', opID, publishID, position])` for slot-driven settlement.
This emits an additional locally observed landed fact after an unknown/lost outcome was acknowledged. It never retracts an earlier uncertainty report.
Committed applied evidence prevents recreating that fact or obligation after acknowledgement/replay.

Call settleControlSlot at startup before operation replay/recovery/publication, and when the walker meets authenticated own-unmerged bytes.
Match the **full payload digest**, not commit digest or hub sender. Matching saved bytes run first-valid search, even after expiry/ack.
First-valid adopts before walking and releases the Welcome. Non-matching authenticated own bytes persist fork evidence hold.
Superseded follows the validated winner without owing the own Welcome. Unknown/absence retains the slot until advancement/retirement.
Driver return values describe observed acceptance only. Returning absent does not settle or recreate an expired/acked operation.
The driver services retained acceptance even after expiry settlement or abandon. It cannot resurrect an intent or make a new handoff.

Unknown keeps work before expiry, then settles unknown. Complete absence at expiry settles lost. Neither route nor ack/abandon clears the slot.
An accepted proof that becomes unavailable retains its obligation without delivery. Already committed obligations survive abandon and outcome ack.
Once ordering trust fails, outcomes assert only local observations; fork-touched work never claims branch-wide absence or automatic reenactment.

Recheck expiry immediately before actual mux.publish, after revoke submission drainage and every awaited step.
Already handed-off publication may complete after expiry. Discover its acceptance without another handoff.
Keep transport backoff from 1 second doubling to 15 seconds; clamp wakeups to the persisted deadline.
Use frameCommit's supplied source-bound seal; legacy external framing retains its existing default.

- [ ] **Step 5: Persist and wire the control hold and host boundary.**

Set the runtime strand barrier immediately when detecting an unsupported version or control fork evidence. Preserve the cursor before the frame.
Commit controlHold reason/position/evidence before enabling further work. Persistence failure/ambiguity keeps the runtime held.
Load controlHold before startup network work and before interpreting legacy cursor.stranded as healRequested.
Gate healIfRequested, runRecovery('automatic'), startup/anchor recovery, rejoin replay/publication and retries against that persisted hold.
An automatic trigger cannot bypass unsupported semantics, unexplained own bytes or same-epoch divergence, even when no slot exists.
Acceptance uncertainty blocks private builds/publication while allowing its search/slot driver to retry. It does not reclassify ordinary recoverable gaps.
Clear acceptance-unknown only with successful acceptance resolution or proved advancement/retirement. Never automatically clear unsupported-version or fork-evidence.
2.2c replaces this temporary diagnostic with full ForkHalt/events and all-path safety. General past-fork healing removal remains there.

Classify prepareBuild as a callback and validation as a port in peerHostFields.
Add `validationHostMembers = {source: 'data', readCommitHeader: 'host', validateFrame: 'host', verifyOwn: 'host'}` and classify restoreValidation as host.
Wrap both the input port and its returned ControlValidation through the existing host boundary. Active calls drain; calls after close refuse.

- [ ] **Step 6: Run green and mutation checks.**

Rebuild, run repository-wide test:types, then Step 2's full rpc, mls-rpc and integration suites.
Expected: PASS at the activation boundary, including real adoption and Welcome tests.
Drop the walker slot lookup and expect the acked late-landing test to fail. Restore it.
Remove the post-drain deadline guard or restart controlHold gate and expect the relevant tests to fail. Restore and rerun full suites.

- [ ] **Step 7: Commit runner activation during implementation.**

Run lint. Stage exactly this task's Files. Run `git commit -m "feat(control): settle retained slots and enforce durable publication deadlines"`.
Expected: one green activation commit with all host and contradictory regression migrations.

### Task 5: Real adoption progress, poison and proposal parity

**Files:**
- Modify: `packages/mls-rpc/src/control-adoption.ts`, `packages/rpc/src/control/welcome.ts`, `packages/rpc/src/peer.ts`, `tests/integration/test/app-lane-e2e.ts`, `packages/rpc/test/fixtures/memory-group-mls.ts` as needed for the asserted parity.
- Migrate/Test: `packages/mls-rpc/test/control-adoption.test.ts`, `tests/integration/test/control-first-valid.test.ts`, `packages/rpc/test/peer-welcome-obligations.test.ts`, `packages/mls-rpc/test/adoption-write.test.ts`, `packages/mls-rpc/test/commit-topic-proposal.test.ts`, `packages/mls/test/carry-receive-progress.test.ts`.

**Interfaces:**
- Consumes: Task 4's guarded ControlAdoptionPort and Welcome canDeliver, Task 3's ControlSearchPort.
- Produces no new port. Retains exact Task 4 signatures; this task proves real progress and receiver parity.

- [ ] **Step 1: Write failing real parity tests.**

`accepted restart carries current progress without resurrecting history` runs actual opens and seals after build, then reconstructs and adopts:

```ts
expect(restoredCandidateAuthenticator).toEqual(originalCandidateAuthenticator)
expect(reopenedConsumedMessage).toBeNull()
expect(adoptedOwnGenerationAtSourceEpoch).toBe(currentOwnGenerationAtSourceEpoch)
expect(adoptedOwnGenerationAtSourceEpoch).toBeGreaterThan(generationAtBuild)
expect(adopted.state.historicalReceiverData.has(evictedEpoch)).toBe(false)
expect(rebuiltCount).toBe(0)
```

Measure the own-leaf ratchet in `historicalReceiverData[E].secretTree`, carried from current source E.
The new E+1 sending chain starts at generation 0. It is not the progress comparison above.
Use actual decrypt refusal if the fixture throws on consumed messages. Preserve matching older history as well as source E.

`poison prefix retries the identical commit and real receiver matches candidate`:

```ts
expect(secondPublish.payload).toEqual(firstPublish.payload)
expect(secondPublish.publishID).toBe(firstPublish.publishID)
expect(secondPublish.expectedHead).toBe(poisonHead)
expect(receiver.state.keySchedule.epochAuthenticator).toEqual(candidateAuthenticator)
```

Include malformed/non-commit/conclusively policy-refused poison. Compare actual handshake bytes/generation, not only the commit digest.
`extra proposal is omitted cleared and requires reproposal` receives a proposal after build, adopts saved bytes, then asserts no enactment and an empty proposal cache.
Assert a later commit omits the proposal until it is freshly reproposed, then enacts it.
`missing referenced proposal holds sender and refuses receiver`:

```ts
expect(ownOutcome.kind).toBe('unknown')
expect(ownWelcomeDeliveries).toEqual([])
expect(receiverResult).toMatchObject({ applied: false, advanced: false, validation: 'unavailable' })
expect(encodedReceiverAfter).toEqual(encodedReceiverBefore)
```

`Welcome is never released for a superseded or unverified accepted stage` asserts zero deliveries.
`Welcome remains owed after landed outcome acknowledgement` checks retained obligation, retry, then deletion only after transport acceptance.
Preserve ordinary self-removal/refusal/holder evidence and revoke/two-revoke regressions.

- [ ] **Step 2: Run red checks.**

```sh
rtk proxy pnpm --filter @kumiai/mls-rpc run test
rtk proxy pnpm --filter @kumiai/rpc run test
rtk proxy pnpm --filter @kumiai/integration-tests run test
rtk proxy pnpm --filter @kumiai/mls run test:types
rtk proxy pnpm --filter @kumiai/mls run test:unit test/carry-receive-progress.test.ts
```

Expected: new real progress/proposal assertions expose missing carry or resolution behaviour; retained regression coverage stays meaningful.

- [ ] **Step 3: Complete real parity through the guarded adopter.**

Use current.carryReceiveProgress(candidate) under adoption ownership. Refresh version after acceptance persistence; the proof's stored version remains historical.
Preserve retained sender/receiver progress and delete candidate history evicted from current state.
Omit extra pending proposals from saved bytes and clear them on adoption. Do not recreate their references.
Incoming winners use normal processCommit, including terminal self-removal without epoch advancement.
Welcome canDeliver rechecks accepted proof before transport handoff. After committed adoption, its co-written obligation authorises delivery through pruning/ack.
Do not require an operation/outcome row to service that obligation. Delivery remains at least once.

- [ ] **Step 4: Run green and mutation checks.**

Rebuild and run Step 2, including full rpc and mls-rpc suites and the integration suite.
Expected: PASS. Bypass carryReceiveProgress and expect historical own-generation/consumed-message tests to fail. Restore it.
Bypass accepted-stage canDeliver proof and expect gap/restart Welcome tests to fail. Restore and rerun paired checks.

- [ ] **Step 5: Commit parity during implementation.**

Run lint. Stage exactly this task's Files. Run `git commit -m "test(control): prove real adoption progress and receiver parity"`.
Expected: one green parity deliverable.

### Task 6: Reconstruction seams and shared control conformance

**Files:**
- Create: `packages/rpc-conformance/src/commit-once.ts`, `packages/rpc/test/commit-once-conformance.test.ts`, `tests/integration/test/commit-once-conformance.test.ts`, `packages/rpc/test/peer-commit-once-crash.test.ts`.
- Modify: `packages/rpc-conformance/src/index.ts`, `packages/rpc-conformance/src/control-store.ts`, `packages/rpc-conformance/src/group-mls.ts`, `packages/rpc/test/fixtures/peer.ts`, `tests/integration/test/app-lane-e2e.ts`, `packages/mls-rpc/test/fixtures/storage-persistence.ts`.
- Migrate/Test: `packages/rpc/test/peer-first-commit-crash.test.ts`, `packages/rpc/test/peer-operations.test.ts`, `packages/rpc/test/peer-welcome-obligations.test.ts`, `tests/integration/test/operation-host.test.ts`, `tests/integration/test/welcome-after-crash.test.ts`.

**Interfaces:**
- Consumes: Tasks 1-5 final records, build/search/adoption/slot ports and existing seam wrappers.
- Produces independent Conformance mirrors and these scenario contracts:

```ts
type CommitOnceScenario = 'alternate-id-replay' | 'public-member-winner' | 'gap-match' |
  'trimmed-checkpoint' | 'validation-unavailable' | 'poison-head' | 'built-restart' |
  'accepted-restart' | 'late-acked-slot' | 'epoch-move' | 'deadline' | 'progress' |
  'slot-guards' | 'terminal-winner' | 'ownership-conflict'
type CommitOnceEvidence = {
  outcome: 'landed' | 'lost' | 'unknown'; builds: number; ownAdoptions: number
  welcomeDeliveries: number; payloads: Array<Uint8Array>; publishIDs: Array<string>
  expectedHeads: Array<string | null>; searchFrom: string | null
  slotAfterAck: ConformanceControlSlot | null; winnerFollowed: boolean
  candidateMatchesReceiver: boolean; progressPreserved: boolean
  cursor: string | null; terminal: boolean; publicationsBeforeProof: number
}
function testCommitOnceConformance(params: {
  label: string; run(scenario: CommitOnceScenario): Promise<CommitOnceEvidence>
}): void
```

Runners exercise actual peer/store/hub paths, never canned results or successful search stubs.
The shared suite owns assertions. Real MLS and the strict memory double own scenario construction.

- [ ] **Step 1: Add named crash tests and shared assertions.**

| Spec requirement/seam | Named test | Owner |
| --- | --- | --- |
| 1116 alternate-ID replay, including public member winner | `earlier valid competitor supersedes an alternate-ID exact own replay` | Task 3; shared alternate-id-replay/public-member-winner |
| 1116 gaps and unavailable validation | `match never bypasses suffix or page gaps`; `unavailable header or body resolution cannot hide an earlier winner` | Task 3; shared gap-match/validation-unavailable |
| 1117 poison and receiver parity | `poison prefix retries the identical commit and real receiver matches candidate` | Task 5; shared poison-head |
| 1117 proposals | `extra proposal is omitted cleared and requires reproposal`; `missing referenced proposal holds sender and refuses receiver` | Task 5 |
| 1118 built/mismatch restart | `restart after built-save or head refresh keeps one exact build` | peer-commit-once-crash; shared built-restart |
| 1118 remote acceptance | `restart after remote acceptance searches before own walk` | peer-commit-once-crash |
| 1118 retained slot after expiry/ack | `late first-valid landing of an acked unknown slot adopts and owes its Welcome`; `rejection abandon and generic deletion retain the slot` | Task 4; shared late-acked-slot/slot-guards |
| 1119 epoch/deadline | `epoch advance rebuilds only after complete absence and intent revalidation`; `deadline survives reconstruction with changed configuration` | Task 4; shared epoch-move/deadline |
| D4 pre-save death | `death after preparation before built-save releases no bytes` | peer-commit-once-crash |
| 1056 first logical built write | `built-save first logical operation write rolls back with slot` | Task 2; reused here with reconstruction |
| 1056 first logical adoption write | `adoption rollback leaves state control and anchor unchanged` | Task 4; reused here |
| 1057 accepted save before adoption | `accepted restart rechecks checkpoint suffix before adoption or Welcome` | peer-commit-once-crash; shared accepted-restart |
| Adoption commit before callbacks | `committed adoption reconstructs one applied row cursor and landed fact` | peer-commit-once-crash |
| 1063 rejected COMMIT/backend unfinished | `ambiguous built accepted and adoption saves release no bytes before proof` | peer-commit-once-crash |
| 1064 proof finds ownership conflict | `control transition proof conflict fail-stops before publication Welcome or hooks` | peer-commit-once-crash; shared ownership-conflict |
| 1066 Welcome accepted before deletion | `Welcome delivery repeats after acceptance-before-delete crash` | peer-welcome-obligations |

At pre-save death allow a second preparation, but zero publication of the first payload.
At post-save restart assert one build across both processes, identical bytes/ID/candidate and settlement before own walking.
At ambiguous built/accepted/adoption saves, parameterise final commit and rollback. Use existing completion faults, not rejection as rollback proof.
At proof conflict, assert zero publication, Welcome, callbacks/hooks or later transitions and the same fail-stop error.
Reconstruct afterwards from durable rows/markers; permit only committed obligations to replay.

Reuse ownership-phases' `conflict drops hooks and fail-stops later entries on every scope` and `fail-stop rejects active queued and draining operations with one conflict instance`.
Run them through the new saver/acceptance/adopter callbacks, rather than citing generic provider success as control-path proof.
Reuse group-storage's `enforces lifetime CAS, state versions and spent authenticator refusal` and `null state retains recovery metadata and installation requires co-written trust`.
Assert the control adoption transition preserves those requirements in real-MLS and independent-double provider modes.

Row 1120 retains full-payload poison, moved/no-op, accepted-before-walk, refusal/holder evidence, exact external confirmation, revoke/two-revoke and Welcome tests.
Task 4 owns version/unexplained-own migrations. General past-fork healing/forkSettlement/row retirement remains 2.2c; source-prefix removal remains 2.2d.
Do not claim complete row 1120, D1 halt or resync until those owners land.
1058-1059/1065/1067 are application/lease/restore seams outside 2.2a.
1060 terminal-handler drain and 1061 settlement finalisation remain 2.3. Full 1062 fork-event/switch/invitee-consumption coverage has later owners.
This sub-plan tests inviter adoption/Welcome reconstruction, not those deferred runtime behaviours.

- [ ] **Step 2: Run red reconstruction and contract checks.**

```sh
rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types
rtk proxy pnpm --filter @kumiai/rpc run test
rtk proxy pnpm --filter @kumiai/mls-rpc run test
rtk proxy pnpm --filter @kumiai/integration-tests run test
```

Expected: missing harness/export or unguarded crash paths fail. Preserve every meaningful regression.

- [ ] **Step 3: Implement the independent scenario harness.**

Reopen committed bytes, discarding handles, callbacks, validators, ranges and in-memory preparations.
Run every named scenario against memory MLS and real MLS. Include the sealed 2.1 provider for reopening/ambiguity/conflict.
Keep conformance reducers independent. Mirror slot owner/reference, deadline, hold, validation and acceptance types with assignments in both directions.
Shared checks observe cursor, terminal, receiver parity and emitted facts, not merely search result unions.

- [ ] **Step 4: Run green and crash mutation checks.**

Rebuild, run repo-wide test:types and Step 2's full suites.
Expected: PASS. Walk own bytes before slot settlement and expect accepted-before-walk/late-acked-slot failures. Restore it.
Permit handoff/hooks on unresolved or conflicted completion and expect proof-conflict tests to fail. Restore and rerun full suites.

- [ ] **Step 5: Commit reconstruction conformance during implementation.**

Run lint. Stage exactly this task's Files. Run `git commit -m "test(control): cover commit-once crashes on real MLS and doubles"`.
Expected: one green conformance deliverable.

### Task 7: Release intent and complete regression gate

**Files:** Modify `.changeset/spec-p-storage-foundation.md` only.

**Interfaces:**
- Consumes: final build/search/adoption/slot contracts from Tasks 2-4 and shared testCommitOnceConformance from Task 6.
- Produces: a coherent pending minor band intent and verified implementation/contract parity. No additional runtime interface.

- [ ] **Step 1: Edit the existing intent directly.**

Preserve its fourteen-package minor frontmatter and the existing version-band-0-11.md intent. Do not create an interactive duplicate.
Append: “Persist one private control build per source epoch. Validate checkpoint-bound first-valid acceptance before adoption or Welcome delivery. Retain source slots across deadlines and outcome acknowledgement.”
Expected: updated summary with unchanged band. No version application or publication between 2.2a and 2.2b.

- [ ] **Step 2: Run build and repository type checks.**

```sh
rtk proxy pnpm turbo run build:js build:types
rtk proxy pnpm turbo run test:types
```

Expected: PASS without filtered-away consumers or compatibility casts hiding proof/source requirements.

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

Expected: PASS. RPC exercises memory MLS/control/hub doubles. MLS-rpc exercises simple/transactional real MLS, storage/ownership contracts and runtime guards.
Hub-server runs the real memory view. Hub-store runs SQL contracts. Integration exercises real hosts and the wire hub adapter.
Conformance packages export suites; runners above execute them. Unavailable database infrastructure means an incomplete gate, never a pass.
No full registry persistence or SIGKILL conformance claim belongs here.

- [ ] **Step 4: Check intent, versions and lint.**

```sh
rtk proxy pnpm change status
rtk proxy pnpm run check:versions
rtk proxy pnpm run lint
git diff --check
```

Expected: coherent pending band, passing version checks and clean lint/diff. No generated files staged.

- [ ] **Step 5: Commit the intent during implementation.**

```sh
git add -- .changeset/spec-p-storage-foundation.md
git commit -m "chore(control): record commit-once release intent and regression gate"
```

Expected: intent committed after required checks. Gate fixes rerun their owning task's paired checks.

## Self-review

Spec coverage: D4 save/slot/checkpoint rules map to Tasks 1-2. Task 3 owns validation/evidence; Task 4 owns deadline/adoption/late settlement.
Proposal/progress/receiver parity maps to Task 5. Task 6 names commit-once rows and crash seams, with deferred portions explicitly assigned.
D1 ordinary recoverable gaps retain strand behaviour; 2.2d delivers automatic resync. Task 4 persists unsupported/control-evidence holds without claiming complete D1 safety.
No gap remains in the 2.2a scope. Full row 1120, terminal draining and settlement finalisation remain incomplete until their stated owners land.

Step scan: every implementation step has named files, signatures or explicit predicates. Tests specify names/assertions; verification names commands and expected results.
Tasks are independently reviewable. Guarded adoption precedes activation. Future implementation commits use each task's exact Files list.
Type consistency: BuiltCommit/HostBuilt/FirstValidCommit preserve spec shapes. Slot owner is an explicit internal extension; operation references avoid duplicate private snapshots.
Preparation results are explicit. Owned refresh, evidence snapshots, winner-follow results and certified ranges have defined consumers.
Review Focus: all five conditions map to named tests in Tasks 2-4. Real isolation, late landing and changed restart configuration have decisive assertions.
Proportion: seven tasks. Bodies appear only for the search algorithm; other blocks define contracts or assertions.

Revision changes only this plan and its finding disposition. No implementation, builds, tests, mutations, release actions or commits run during revision.
