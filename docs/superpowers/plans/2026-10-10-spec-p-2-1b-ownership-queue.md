# Spec P 2.1b Ownership Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four layered memory-persistence concurrency mechanisms with Spec P r17 D8's single ownership queue and phase model, pinned by an ownership-phases conformance suite.

**Architecture:** A provider-independent `owner-queue.ts` in `@kumiai/mls-rpc` owns per-device and per-group FIFO slots, typed entries (`transition`, `combined`, `read`), strict phases with phase-derived write capabilities, a per-entry sequencer, retained ambiguity with in-entry proof, external proof joins, root reentrancy refusal and atomic fail-stop. The memory provider shrinks to D8 primitives (open transaction, outcome, completion barrier, marker read). Memory group and device persistence drive every root operation through the queue. `rpc-conformance` gains `testOwnershipPhasesConformance`, run against real MLS and doubles.

**Tech Stack:** TypeScript, Vitest, Node `AsyncLocalStorage` (testing entry only), pnpm/turbo workspace.

**Spec:** `docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md` r17 (commit `8e06c26`): D8 (`:405-500`), D7 ambiguity (`:361-373`), Crash seams, ownership-phases Conformance rows (`:1055-1070`). Background: `.superpowers/sdd/2026-10-10-spec-p-2-1-storage-foundation/concurrency-map.md` (mechanism map at `e51a143`).

## Global Constraints

Plan 2.1's Global Constraints (`docs/superpowers/plans/2026-10-10-spec-p-2-1-storage-foundation.md`, "Global Constraints" and "Placement and contract decisions") apply unchanged. In addition:

- "One FIFO, non-reentrant owner queue per `deviceOwner(ownerDID)` and per `groupOwner(groupID)`". "Backend writer limits never become a global application mutex."
- "`Read` ... never becomes ambiguous and retains nothing: any failure, including an unknown backend outcome on its read transaction, rejects that read and releases at once."
- "Refusals apply to every store or transaction access bound to the entry's provider transaction, however constructed, not only supplied wrappers."
- "A transactional *effect* ... that throws rolls back the whole transition, including its rows. A completion *hook* ... that throws is contained; remaining hooks still run and the outcome stands."
- "Retry from 100 ms doubling to 15 s outside transactions."
- Conflict "fail-stops: no hook queue runs and both are dropped, no further transaction is opened, the caller and every queued or later entry on any scope reject with `GroupStateConflictError`". "Fail-stop is atomic across every entry already active on any scope and every joined resolver".
- "The barrier may create owner rows internally with the marker-neutral value `{mutationID: null, revision: 0}`, classified as absent; it never advances a marker."
- `GroupMutationGate` and `MemoryDatabase.mutationGate` are removed from the public `@kumiai/mls-rpc` barrel: a breaking type change, so run `rtk proxy pnpm turbo run test:types` without `--filter`. The existing `.changeset/spec-p-storage-foundation.md` already raises all fourteen packages at minor; extend its summary, add no second intent.
- Every new conformance case is mutation-checked: break the guarding line in the real implementation, confirm the case fails, restore.

**Out of scope (owned elsewhere).** Registry/runtime deletion drain, bounded re-drain and the runtime owner-creation block (D7/D8 Deletion) belong to plan 2.2. The D6 certification consumer of in-entry retry belongs to plan 2.3; this plan proves the queue keeps the slot across repeated provider transactions in one entry. SQLite/PostgreSQL/Expo primitives and their real-database integration rows (a)-(g) are phase 3.

## Review Focus

- Many reads queued behind one ambiguous transition must all complete, in FIFO order, after proof; none may starve or be released before proof. Pin in Task 3.
- A caller abandoning its promise while a suspended store operation is mid-write must not let `outcome` begin before that operation settles. Pin in Task 2.
- A completion hook that throws during fail-stop's queue drop must not prevent other entries' rejection. Pin in Task 2.
- After fail-stop, `fixture.reopen()` must yield a working factory over the durable rows (restart is the recovery path). Pin in Task 4.
- Two `combined` entries on one device for different groups must not deadlock when one group is held by an ambiguous transition; the second waits on the device slot only. Pin in Task 4.

---

### Task 1: Ownership-phases conformance suite (red)

**Files:**
- Create: `packages/rpc-conformance/src/ownership-phases.ts`
- Modify: `packages/rpc-conformance/src/index.ts` (export), `packages/rpc-conformance/src/persistence-fixture.ts` (fixture additions, remove `ConformanceGroupMutationGate` and `ConformanceMemoryDatabase.mutationGate`)
- Modify: `packages/mls-rpc/test/fixtures/storage-persistence.ts` (implement fixture additions)
- Create: `packages/mls-rpc/test/ownership-phases-conformance.test.ts`

**Interfaces:**
- Consumes: `ConformancePersistenceFixture`, `StorageTestPorts`, `StorageConformanceParams`, `storageSeed`, `writeStorageInstall`, `storageChange` (existing `rpc-conformance`).
- Produces:
  - `ConformancePersistenceFixture` gains `forceOwnerMarker(owner: { groupID: string } | { ownerDID: string }, marker: { mutationID: string; revision: number }): Promise<void>` (writes the committed clear marker directly, outside any entry) and `constructGroupStores(tx: TTx, key: ConformanceGroupKey): ConformanceGroupStores<TTx>` (builds stores from a raw transaction without the supplied wrapper).
  - `testOwnershipPhasesConformance<TTx extends ConformanceGroupTransaction>(params: StorageConformanceParams<TTx>): void`, run per `mode` like `testGroupStorageConformance`.

- [ ] **Step 1: Write the suite.** One `describe` per Spec P ownership-phases row. Assert errors by `name` (`'PersistencePhaseError'`, `'ReentrantOwnershipError'`, `'GroupStateConflictError'`, `'GroupStateUncertainError'`, `'StorageOutcomeUnknownError'`). Bound every await with a 2000 ms race that fails the test with `'timed out'`. Cases:
  - `phase capabilities`: an `effects.outbox` effect calling `stores.state.save`, `stores.trust` write and `stores.lifetime` write each rejects `PersistencePhaseError`, through supplied stores and through `fixture.constructGroupStores(tx, key)`. The transition still commits, and the state/trust/lifetime rows equal their post-`work` values. An effect `writeSideRow` commits with the transition.
  - `sequencing`: in `work`, start `stores.outbox.put` whose `seal` is held by a deferred; without awaiting it, call `stores.control.save`; release the deferred; assert both rows present after commit and the lifetime revision advanced exactly once.
  - `effect side writes are accounted`: fixture X writes an anchor in `work`; fixture Y writes the same anchor in `effects`; the committed state version in Y equals that in X.
  - `effect store calls/exceptions`: outbox effect then `stores.lifetime` load, and delete effect then `ports.outbox.clearTransport`, complete. A throwing effect rejects the transition and leaves neither transition rows nor effect side row. An `onCommit` hook that throws: the transition resolves with its result, the second `onCommit` hook runs, and rows are committed.
  - `ambiguous transition fence`: for `commitThenReject()` and for `rejectCommitPending()` (proof delayed until `finish('commit')`): `groups.loadState`, `groups.load`, `ports(key).control.load`, `device.load` and a same-group `transition` stay pending while a group-B transition commits; zero `onCommit`/`onRollback` calls before proof; exactly one queue after; then all pending reads resolve.
  - `ambiguous read releases`: arm `commitThenReject()` then call `groups.loadState(key)` (rejects `StorageOutcomeUnknownError`); the next `loadState` and a same-group `transition` resolve. Repeat with `rejectCommitPending()` armed before the read; then `finish('commit')`.
  - `proof classification/join`: committed and rolled-back each run one hook queue once; `groups.resolve(groupID, id)` and `device.resolve(id)` called during a pending proof resolve with the same outcome as the caller. Fallback `groups.resolve(groupID, 'M')` after a later mutation `'N'` committed rejects `GroupStateUncertainError`. Conflict: arm `rejectCommitPending()`, `forceOwnerMarker({groupID}, {mutationID: 'intruder', revision: 99})`, `finish('rollback')`: the caller rejects `GroupStateConflictError`, no hook runs, and a following `groups.load` and a group-B `transition` both reject `GroupStateConflictError`. A group-B transition already pending on `rejectCommitPending()` when the conflict lands also rejects `GroupStateConflictError` and runs no hook.
  - `combined classification`: device `transition` with `group` set under `rejectCommitPending()`; `finish('commit')` commits both owners once; with `forceOwnerMarker({ownerDID}, …)` it fail-stops.
  - `ordering/reentrancy`: inside `work`, `effects` and an `onCommit` hook, calling `groups.loadState`, `groups.transition`, `device.load` or `device.transition` rejects `ReentrantOwnershipError` within the 2000 ms bound (never times out).
  - `restart before proof`: `rejectCommitPending()`, `reopen()`; the first `groups.loadState` on the reopened ports resolves with committed rows only after `finish('commit')`.
  - `storage guard witnesses`: reuse `testGroupStorageConformance`'s F1/F3/F5 helpers (do not duplicate assertions): partial-loss spent reinstall at incarnation 1 refuses, unreadable source state with readable trust retires, consistent lower-epoch refuses `Epoch regressed`.
- [ ] **Step 2: Implement the two fixture methods** in `packages/mls-rpc/test/fixtures/storage-persistence.ts` against the current memory database (owner namespaces `group-owner` / `device-owner`, keys from `groupOwnerKey` and the device owner key in `memory-device-persistence.ts`).
- [ ] **Step 3: Wire** `ownership-phases-conformance.test.ts` with both modes, mirroring `storage-conformance.test.ts`.
- [ ] **Step 4: Run red.** `rtk proxy pnpm turbo run build:js build:types`, then `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/ownership-phases-conformance.test.ts` and `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types` and `rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types`.
  Expected: types pass; unit FAILS. At minimum `ambiguous read releases` times out (N1), `PersistencePhaseError`/`ReentrantOwnershipError` names mismatch, and conflict cases do not fail-stop. Record each failing case and its reason in the report; a case that passes now must name the existing guard it already exercises.
- [ ] **Step 5: Commit**:

```bash
git add packages/rpc-conformance/src packages/mls-rpc/test/fixtures/storage-persistence.ts packages/mls-rpc/test/ownership-phases-conformance.test.ts
git commit -m "test(rpc-conformance): add ownership-phases conformance suite"
```

### Task 2: Owner queue

**Files:**
- Create: `packages/mls-rpc/src/owner-queue.ts`
- Modify: `packages/mls-rpc/src/persistence-errors.ts`, `packages/mls-rpc/src/index.ts` (export new errors and queue types)
- Create: `packages/mls-rpc/test/owner-queue.test.ts`

**Interfaces:**
- Produces (`owner-queue.ts`):

```ts
export type EntryKind = 'transition' | 'combined' | 'read'
export type EntryPhase =
  | 'queued' | 'prepare' | 'work' | 'finalise' | 'effects' | 'account'
  | 'outcome' | 'ambiguous' | 'settled' | 'released'
export type WriteTarget = 'domain' | 'side' | 'coordinator'
export type OwnerScopes = { ownerDID: string | null; groupID: string | null }
export type ProofOutcome = 'committed' | 'rolled-back'
export type OwnerEntry = {
  readonly kind: EntryKind
  readonly scopes: OwnerScopes
  readonly phase: EntryPhase
  readonly mutationID: string | null
  enter(phase: EntryPhase): void
  sequence<T>(operation: () => Promise<T>): Promise<T>
  assertWrite(target: WriteTarget): void
  onCommit(fn: () => void): void
  onRollback(fn: () => void): void
  settle(outcome: ProofOutcome): void
  retain(proof: () => Promise<ProofOutcome>): Promise<ProofOutcome>
}
export type OwnerQueues = {
  run<T>(
    kind: EntryKind,
    scopes: OwnerScopes,
    body: (entry: OwnerEntry) => Promise<T>,
    options?: { mutationID?: string; signal?: AbortSignal },
  ): Promise<T>
  current(): OwnerEntry | undefined
  joinProof(owner: { groupID: string } | { ownerDID: string }, mutationID: string): Promise<ProofOutcome> | null
  started(scopeKey: string): boolean
  markStarted(scopeKey: string): void
  failStop(error: GroupStateConflictError): void
  readonly failure: GroupStateConflictError | null
}
export function createOwnerQueues(): OwnerQueues
```

- Produces (`persistence-errors.ts`): `export class PersistencePhaseError extends Error` and `export class ReentrantOwnershipError extends Error`, each setting `name` to its class name, following the file's existing pattern.

Semantics the tests pin (from D8): `run` rejects `ReentrantOwnershipError` when `current()` is defined, before waiting. A `combined` entry waits on its device slot, then holds it while waiting for the group slot; aborting `signal` while waiting withdraws the group waiter and releases the device slot, and a grant racing the abort is released immediately. A group-holding entry that requests a device slot rejects `ReentrantOwnershipError`. `enter` accepts only the D8 phase order (`prepare` may be skipped for reads; `ambiguous` only from `outcome` for `transition`/`combined`; a known rollback may return from `outcome` to `work` while slots stay held) and throws otherwise. `assertWrite('domain')` passes only in `work`; `'side'` in `work` and `effects`; `'coordinator'` in `finalise` and `account`; anything else throws `PersistencePhaseError`. `sequence` runs operations one at a time per entry; `enter('outcome')` waits for every started sequenced operation. `settle` runs exactly one hook queue, containing each hook's exception; a second identical `settle` is a no-op and a contradicting one throws `GroupStateConflictError`. `retain` keeps the entry at the head of its slots until `proof` resolves, retrying a rejected `proof` from 100 ms doubling to 15 s; `joinProof` returns that entry's proof promise for a matching mutationID, else `null`. A `read` entry calling `retain` throws. `failStop` rejects every queued, active and joined promise with the given error, drops every hook queue without running it, makes later `run` calls reject immediately, and sets `failure`. Slot release happens only after `settled` (or the read body finishing).

- [ ] **Step 1: Write `owner-queue.test.ts`** with fake timers for backoff. Cases, each with a 2000 ms bound: FIFO per group and independence across groups; `read` failure releases at once; reads queued behind a retained entry release in FIFO order only after proof (Review Focus 1, using 5 reads); combined device-then-group order, abort withdrawal and racing grant; group-holder requesting device rejects; reentrancy rejects from every active phase (`prepare`, `work`, `finalise`, `effects`, `account`, inside a `retain` proof) and from a hook; phase order violations throw; `assertWrite` matrix for every phase × target; sequencer serialises a suspended operation and `enter('outcome')` waits for it even when the body's caller has already received a rejection (Review Focus 2); hook containment and idempotent/contradicting `settle`; retain backoff sequence `100, 200, 400 … 15000, 15000`; `joinProof` match and miss; rollback-then-`work` keeps slots (queued read stays pending across two provider attempts); fail-stop rejects queued, active, retained and joined entries, runs no hook, and a hook queue whose hook would throw does not stop other rejections (Review Focus 3).
- [ ] **Step 2: Run red.** `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/owner-queue.test.ts` and `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`. Expected: FAIL, missing module `owner-queue.js`.
- [ ] **Step 3: Implement `owner-queue.ts`** and the two errors. Use `AsyncLocalStorage` for `current()`, mirroring how `memory-transaction.ts` uses it today; keep the module free of Node imports at type level so it can move behind the testing entry if needed.
- [ ] **Step 4: Run green**, same two commands. Expected: PASS. Mutation-check: disable the reentrancy check, the read-release path, the sequencer wait in `enter('outcome')`, and the `failStop` active-entry rejection, one at a time; each must fail its case; restore.
- [ ] **Step 5: Commit**

```bash
git add packages/mls-rpc/src/owner-queue.ts packages/mls-rpc/src/persistence-errors.ts packages/mls-rpc/src/index.ts packages/mls-rpc/test/owner-queue.test.ts
git commit -m "feat(mls-rpc): add D8 ownership queue and phases"
```

### Task 3: Memory group persistence on the queue

**Files:**
- Modify: `packages/mls-rpc/src/memory-transaction.ts` (remove `createMutationGate`, `gateContext`, `GateOwner`, `holdUntil` linkage; keep views, merge, faults, per-scope backend queue, `completionBarrier`, `snapshot`)
- Modify: `packages/mls-rpc/src/memory-group-persistence.ts`, `packages/mls-rpc/src/memory-group-state.ts`, `packages/mls-rpc/src/memory-incarnation-stores.ts`, `packages/mls-rpc/src/memory-group-ports.ts`
- Modify: `packages/mls-rpc/src/persistence-types.ts` (remove `GroupMutationGate`, `MemoryDatabase.mutationGate`), `packages/mls-rpc/src/index.ts`
- Modify tests that reference removed internals: `packages/mls-rpc/test/memory-transaction.test.ts`, `group-namespaces.test.ts`, `final-review.test.ts`, `group-state-persistence.test.ts` (retarget, never delete a case: each removed-mechanism assertion becomes the equivalent queue/phase assertion, per Spec P Conformance preamble)

**Interfaces:**
- Consumes: Task 2 `createOwnerQueues`, `OwnerEntry`, errors.
- Produces: `createMemoryGroupCoordinator` and `createMemoryGroupPersistence` take an `owners: OwnerQueues` parameter (added to their existing `params` object); every root method of `GroupPersistence` and `GroupPersistencePorts` runs as one `owners.run` entry (`read` for `load`, `loadState`, `loadTrust`, `list`, port loads, fallback `resolve`; `transition` otherwise). `withMemoryTransactionLock`, `lockMemoryOperation`, `beginMemoryGroupFinalisation` and `assertMemoryGroupMutable` are deleted; their call sites use `entry.sequence` and `entry.assertWrite`.

- [ ] **Step 1: Add red unit tests** to `group-namespaces.test.ts`: (a) first entry per group after construction calls `db.completionBarrier` exactly once per group scope (spy on the database), even when that entry is a `read`; (b) a transition body that runs two provider transactions after a forced rollback keeps the group slot (a queued `loadState` stays pending until the second commits); (c) the barrier creates an absent owner row as `{mutationID: null, revision: 0}`, and proof classifies it as rolled back for an initially absent owner.
- [ ] **Step 2: Run red.** `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/group-namespaces.test.ts` plus `test:types`. Expected: the three new tests FAIL.
- [ ] **Step 3: Migrate.** Map each D8 phase onto the coordinator: `prepare` = barrier/marker check when `!owners.started(scopeKey)` then `markStarted`; `work` = user callback with stores whose methods call `entry.sequence` and `entry.assertWrite('domain' | 'side')`; `finalise` = current validation/persistence/version accounting block as one `entry.sequence` step under `assertWrite('coordinator')`; `effects` = `effects.outbox`/`effects.delete`; `account` = version accounting for side writes made during `effects`; `outcome` via `db.transact` with `onUnknown` feeding `entry.retain(proof)`; proof classification per D8 (matching mutationID committed; exact pre-work `{mutationID, revision}` or neutral/absent rolled back; else `owners.failStop(new GroupStateConflictError(...))`). `resolve` uses `owners.joinProof`, else runs a `read` entry that barriers then answers `committed` only for a matching marker and otherwise throws `GroupStateUncertainError`. Hooks register on the entry (`MemoryTransaction.onCommit/onRollback` delegate to it).
- [ ] **Step 4: Run green.** `rtk proxy pnpm turbo run build:js build:types`, then `rtk proxy pnpm --filter @kumiai/mls-rpc run test` and `rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types`. Expected: all mls-rpc tests pass, including every group-scope ownership-phases case from Task 1, the four Task 6 deadlock cases, F1-F5 and N1. Device-scope ownership cases may still fail; list them.
- [ ] **Step 5: Mutation-check** the account step (skip it: `effect side writes are accounted` fails), the effects-phase domain refusal, the first-entry barrier, and the neutral-marker classification; restore.
- [ ] **Step 6: Commit**

```bash
git add packages/mls-rpc/src packages/mls-rpc/test
git commit -m "refactor(mls-rpc): run memory group persistence through the ownership queue"
```

### Task 4: Memory device persistence on the queue

**Files:**
- Modify: `packages/mls-rpc/src/memory-device-persistence.ts`, `packages/mls-rpc/src/memory-package-stores.ts`, `packages/mls-rpc/src/testing.ts`
- Modify: `packages/mls-rpc/test/device-persistence.test.ts` (retarget removed-mechanism assertions)
- Modify: `packages/mls-rpc/test/fixtures/storage-persistence.ts` only if construction signatures changed

**Interfaces:**
- Consumes: Task 2 queue; Task 3 coordinator taking `owners`.
- Produces: `createMemoryDevicePersistence` creates one `OwnerQueues` per database and passes it to its group coordinator, so device and group share one queue set. `transition` with `group: null` is a `transition` entry on `{ownerDID, groupID: null}`; with a group it is a `combined` entry. `device.load` and package reads are `read` entries. `device.resolve` joins or falls back as in Task 3, classifying both owners for combined.

- [ ] **Step 1: Add red tests** to `device-persistence.test.ts`: (a) Review Focus 5: combined C1 for group A blocked behind an ambiguous group-A transition; combined C2 on the same device for group B waits only for the device slot, then commits after C1 settles; no deadlock within 2000 ms; (b) Review Focus 4: after a conflict fail-stop, `fixture.reopen()` returns ports whose `device.load`, `groups.loadState` and a fresh group transition succeed.
- [ ] **Step 2: Run red.** `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/device-persistence.test.ts test/ownership-phases-conformance.test.ts` plus `test:types`. Expected: the new tests and device-scope ownership cases FAIL.
- [ ] **Step 3: Migrate** device and package operations onto the shared queue, removing their uses of the deleted lock helpers.
- [ ] **Step 4: Run green**: `rtk proxy pnpm turbo run build:js build:types`, `rtk proxy pnpm --filter @kumiai/mls-rpc run test`, `rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types`. Expected: PASS, including the full ownership-phases suite in both modes and all prior storage conformance.
- [ ] **Step 5: Mutation-check** combined classification (accept device marker only) and combined device-then-group order; restore.
- [ ] **Step 6: Commit**

```bash
git add packages/mls-rpc/src packages/mls-rpc/test
git commit -m "refactor(mls-rpc): run memory device persistence through the ownership queue"
```

### Task 5: Regression gate and release note

**Files:**
- Modify: `.changeset/spec-p-storage-foundation.md` (summary only)
- Modify: `packages/mls-rpc/README.md` only where it documents removed `GroupMutationGate`/`mutationGate` (check `test/readme-persistence.test.ts`)

- [ ] **Step 1: Search for leftovers.** `grep -rn "mutationGate\|GroupMutationGate\|withMemoryTransactionLock\|lockMemoryOperation\|beginMemoryGroupFinalisation\|assertMemoryGroupMutable" packages tests --include='*.ts' --include='*.md' | grep -v /lib/` returns nothing.
- [ ] **Step 2: Extend the changeset summary** to: "Add transactional memory persistence and lossless MLS/recovery v2 storage codecs; refuse ambiguous v1 snapshots. Replace the group mutation gate with the D8 ownership queue." Keep all fourteen entries at minor.
- [ ] **Step 3: Run the gate.** Each must pass:

```sh
rtk proxy pnpm turbo run build:js build:types
rtk proxy pnpm turbo run test:types
rtk proxy pnpm --filter @kumiai/mls-rpc run test
rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types
rtk proxy pnpm --filter @kumiai/rpc run test:unit test/ports-conformance.test.ts test/control-store-conformance.test.ts
rtk proxy pnpm --filter @kumiai/integration-tests run test:types
rtk proxy pnpm run lint
rtk proxy pnpm run check:versions
```

  Expected: all pass. The controller additionally runs, outside the sandbox, `pnpm exec turbo run test:types test:unit --force --continue` (expect `Cached: 0`) and `pnpm exec vitest run --root tests/integration`.
- [ ] **Step 4: Commit**

```bash
git add .changeset/spec-p-storage-foundation.md packages/mls-rpc/README.md
git commit -m "chore: note ownership queue in storage foundation release intent"
```
