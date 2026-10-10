# Spec P 2.1c Runtime-Neutral Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the 2.1b ownership queue to Spec P r18. No `AsyncLocalStorage` and no runtime-specific globals in `mls-rpc`/`rpc-conformance` sources. Each entry has an operation lock under which nesting is forbidden by construction. Coordinator writes go through a private route. Internal bindings are explicit. An optional `ownershipContext` port diagnoses reentrancy.

**Architecture:** `owner-queue.ts` drops Node imports. Root reentrancy uses a synchronous marker set around every callback, hook and proof step, plus an optional host port carrying an opaque token.

Each entry owns one operation lock with two admission routes:
- **Public:** `operation`, for store calls.
- **Private coordinator:** `coordinate`, authorised by an unforgeable token held only by the provider, for `finalise`/`account` writes.

Store calls register synchronously, run serially over their whole read-modify-write, and are frozen and drained per phase. Fatal failures make the transition rollback-only. Operations bind to the entry, the provider transaction and an `OwnerAttempt`, and are revoked on cancellation, fail-stop, retry and failed reads.

The memory provider binds transactions to entries through a `WeakMap`. It captures host effect callables before `finalise` and flattens device composition into private helpers. The new queue API lands additively first, so every commit compiles; the old `sequence` path is deleted only after both providers have migrated.

**Tech Stack:** TypeScript, Vitest, pnpm/turbo. Only test files may use Node APIs: the `AsyncLocalStorage` port adapter lives in tests.

**Spec:** `docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md` r18 (commit `c2bc0cc`). Relevant D8 sections:
- Phases table, Store operations, Coordinator authority, Reentrancy (r18).
- Factory signatures (`ownershipContext?`).
- ownership-phases Conformance rows "operation lock" and "ordering/reentrancy/deletion".

**Starting point:** branch `feat/spec-p-phase-2` at the 2.1b head. Ledger: `.superpowers/sdd/2026-10-10-spec-p-2-1b-ownership-queue/progress.md` ("Final:" lines). Findings in the same directory: `final-findings.md`, `final-rereview.log`, `r18-findings.md`, `r18-rereview.md`, `r18-round3.md`.

## Global Constraints

Plans 2.1 and 2.1b Global Constraints apply unchanged, except where r18 replaces them. In addition:

- **Runtime neutrality.** Spec: "Core logic is runtime-neutral (Node, browsers, Hermes) and uses no runtime-specific async-context API; `ownershipContext` only diagnoses public root reentrancy."
- **Runtime baseline** for `packages/mls-rpc/src` and `packages/rpc-conformance/src`: ES2022 plus `WeakMap`, `AbortController`/`AbortSignal` (constructor, `abort`, `aborted`, `reason`, `addEventListener`), `queueMicrotask`, `setTimeout`.
  - Forbidden: `node:` imports, `AsyncLocalStorage`, `structuredClone`, `Promise.withResolvers`, `AbortSignal.any`, `AbortSignal.timeout`, `setImmediate`, `process`, `Buffer`.
  - `SharedArrayBuffer` and `Atomics` may appear only behind `typeof … !== 'undefined'`.
  - Each banned use is replaced by a local helper (`deferred<T>()`, a manual signal combiner, a typed clone).
- **Port type.** `type OwnershipContextPort = { run<T>(token: object, fn: () => T): T; get(): object | undefined }`.
  - Both device persistence factories, and `createMemoryGroupPersistence`, accept `ownershipContext?: OwnershipContextPort`.
  - Core passes an opaque, frozen token with no methods.
  - The owner queues are bound to a `MemoryDatabase` on first use. A later factory call on the same database supplying a different port object throws `TypeError('ownershipContext differs from the port bound to this database')`. Omitting the port, or passing the same object, reuses the binding.
- **No nesting.** Spec: "Operations never nest". No store method, coordinator helper or read callback calls a public store method or another locked operation while holding a reservation.
- **Registration.** Spec: "An allowed store call registers its operation synchronously before returning its promise." A phase change freezes and drains only the outgoing phase's operations.
- **Fatal failures** are rollback-only even when abandoned or caught: seal failure, failed required open, and failure after a row change. A private diagnostic may classify unreadable MLS state for control/meta-only safety work without poisoning.
- **Failed Read.** Spec: "A failed `Read` immediately revokes its attempt bindings ... and releases application ownership without awaiting host callbacks." The provider never awaits `enter('outcome')` or a drain before reporting a Read failure. Backend completion is tracked separately.
- **Port modes.** Every conformance case runs both without a port and with a test `AsyncLocalStorage` adapter port. Reentrancy-after-`await` cases run only with the port.
- **Mutation checks.** Every new case is mutation-checked.
- **Changeset.** Extend the `.changeset/spec-p-storage-foundation.md` summary; add no second intent.
- **Every commit compiles.** Each commit passes `rtk proxy pnpm turbo run build:js build:types test:types`. Expected-red is allowed only in Task 1's new runtime cases.
- **Deferred requirements, not in this plan:**
  - runtime deletion drains and owner-creation blocking: plan 2.2;
  - D6 certification retry consumer: plan 2.3;
  - phase-3 factory and SQLite/PostgreSQL/Expo database evidence: phase 3.

## Review Focus

- **Work-supplied stores used in `effects`.** A host effect keeps stores from `work` and calls them in `effects` while an earlier `work` operation is still suspended. Expected: the `work` operation drains first, then the effect call runs in `effects`. Pinned in Task 3.
- **Late same-tick seal.** A codec's seal awaits a promise that only resolves later in the same tick, from unrelated code rather than from hooks. Expected: no deadlock and no leaked authority. Pinned in Task 3.
- **Unrelated concurrent callers.** Two independent callers on different groups, with the port supplied. Expected: neither is reported as reentrant. Pinned in Task 1.
- **Fail-stop with a queued operation.** Fail-stop arrives while an operation is queued behind a suspended one. Expected: both reject, nothing writes, and the backend completes. Pinned in Task 2.
- **Reopen with the port after fail-stop.** Expected: reopen works. Pinned in Task 4.

---

### Task 1: Port type, fixture interfaces and r18 conformance (red)

**Files:**
- **Modify:**
  - `packages/mls-rpc/src/persistence-types.ts`: export `OwnershipContextPort`; the `PersistenceFixture` type.
  - `packages/mls-rpc/src/index.ts`: re-export the type.
  - `packages/rpc-conformance/src/persistence-fixture.ts`: mirror types `ConformanceOwnershipContextPort` and `FixtureOptions`.
  - `packages/rpc-conformance/src/ownership-phases.ts`
  - `packages/rpc-conformance/src/group-storage.ts`: the `:457` caller.
  - `packages/rpc-conformance/src/device-storage.ts`
  - `packages/rpc-conformance/src/index.ts`
  - `packages/mls-rpc/test/fixtures/storage-persistence.ts`
  - `packages/mls-rpc/test/storage-conformance.test.ts`: the `createFixture` wrapper.
  - `packages/mls-rpc/test/ownership-phases-conformance.test.ts`
  - `packages/mls-rpc/test/storage-fixture.test.ts`
- **Create:** `packages/mls-rpc/test/fixtures/ownership-context.ts`, which exports `createAsyncLocalOwnershipContext(): OwnershipContextPort` (Node, test-only).

**Interfaces:**
- **Produces `FixtureOptions`:**
  ```ts
  type FixtureOptions = {
    effects?: ConformanceEffects
    ownershipContext?: ConformanceOwnershipContextPort
  }
  ```
  `StorageConformanceParams.createFixture(id: string, options?: FixtureOptions)`.
  - Every caller and wrapper migrates in this commit. `group-storage.ts:457` passes `{ effects: { outbox } }`.
  - The mls-rpc wrapper forwards `options` to `createStorageFixture({ id, mode, ...options })`.
  - `createStorageFixture` accepts `ownershipContext` and forwards it to the factories. Until Task 3 the factories ignore it, so port-mode cases fail red.
- **Produces fixture instrumentation.** Each method is a one-shot latch, cleared when it fires, when its transaction fails, or when its attempt is revoked. Each has a mirror signature in `persistence-fixture.ts`.

  | Method | Effect |
  |---|---|
  | `failNextSeal(error?: Error): void` | The next codec seal rejects. |
  | `holdNextOpen(): { started: Promise<void>; release(): void }` | The next codec open suspends until `release()`. |
  | `failNextOpen(error?: Error): void` | The next codec open rejects. |
  | `probeCodec(fn: (phase: string) => Promise<void>): void` | The next seal or open first awaits `fn(currentPhase)`. Used for coordinator-phase access probes. |
  | `holdNextReadCallback(): { started: Promise<void>; release(): void }` | Suspends the next public Read's callback; test-only entry-bound probe. |
- **Produces** `testOwnershipPhasesConformance(params & { ownershipContext?: () => ConformanceOwnershipContextPort })`. It runs every case without a port and, when `ownershipContext` is supplied, again with a fresh port per fixture.

- [ ] **Step 1: Migrate fixture signatures and add instrumentation.** No behaviour change. `rtk proxy pnpm turbo run build:js build:types test:types` passes, and existing storage conformance stays green.
- [ ] **Step 2: Add cases.** Add one shared case per row of this requirement matrix. Each case is bounded by the existing 2000 ms race.

  | r18 requirement | Case |
  |---|---|
  | Registration before lock | Concurrent same-record `control.apply` from the host: both persist. An operation called behind a suspended one before `work` returns still drains, and finalise sees it. |
  | Per-phase freeze / effects reopen | Work-supplied stores used in `effects`: the `work` operation drains first. |
  | Seal failure fatal | An abandoned seal rejection (`failNextSeal`) rolls back. |
  | Required-open failure fatal | A caught `failNextOpen` inside `work` still rolls back. |
  | Failure after row change fatal | A `control.apply` writes, then a later operation throws and is caught: rollback. |
  | Attempt revocation | A late call through a revoked attempt (retry) writes nothing. |
  | Failed Read release | Suspended abandoned open (`holdNextOpen`), then Read failure: the Read rejects without awaiting `release()`, and the next same-scope operation completes. |
  | Coordinator privacy | An effect getter, a codec callback (`probeCodec`) and an accessor during `finalise`/`account` cannot read or write; rows unchanged. |
  | Released entry | A hook-scheduled root after release succeeds. |
  | Port: unrelated callers | Two concurrent callers on different groups are not reported as reentrant. |
  | Port: reentrancy after `await` | Rejects in each of `prepare`, `work`, `effects`, `finalise`, `account`, hooks and proof (port mode only). |
  | Sync-marker reentrancy | Synchronous reentry rejects in the same phases, without a port. |
  | Port restore | The binding is restored after a throwing callback. |
  | No nesting | Device initial and existing load, device transition, package read, and Combined all complete without a port. |
  | Combined cancellation | Cancelled Combined acquisition releases both entries, and the next Combined completes. |
  | Safety obligations | Corrupt state/trust safety events still commit their control obligations. |
- [ ] **Step 3: Wire** both modes in `ownership-phases-conformance.test.ts` using `createAsyncLocalOwnershipContext`.
- [ ] **Step 4: Run red:**
  - `rtk proxy pnpm turbo run build:js build:types test:types`
  - `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/ownership-phases-conformance.test.ts`

  Expected: types pass; new cases fail, with the failure reason recorded per case; pre-existing cases unchanged.
- [ ] **Step 5: Commit** `test(rpc-conformance): add r18 ownership conformance cases`.

### Task 2: Runtime-neutral owner queue API (additive)

**Files:**
- Modify: `packages/mls-rpc/src/owner-queue.ts`, `packages/mls-rpc/test/owner-queue.test.ts`
- Create: `packages/mls-rpc/src/runtime.ts`, which exports `deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }` and `anySignal(signals: AbortSignal[]): AbortSignal` (manual listeners, removed on abort).

**Interfaces:**
- **Produces:**
  - `export type OwnershipContextPort` (re-exported from `persistence-types.ts`).
  - `createOwnerQueues(options?: { ownershipContext?: OwnershipContextPort }): OwnerQueues`.
- **`OwnerAttempt`:**
  ```ts
  type OwnerAttempt = {
    readonly id: number
    readonly revoked: boolean
    readonly signal: AbortSignal
    revoke(reason: unknown): void
    assertLive(): void // throws PersistencePhaseError when revoked
  }
  ```
  `revoke` aborts `signal`, rejects every pending operation of that attempt with `PersistencePhaseError`, and makes later `assertLive()` calls throw.
- **New `OwnerEntry` members.** All are additive; `sequence` stays until Task 4.
  - `attempt(): OwnerAttempt`: the current attempt. `enter('work')` after a known rollback revokes the old attempt and starts a new one.
  - `operation<T>(attempt: OwnerAttempt, run: (attempt: OwnerAttempt) => Promise<T>): Promise<T>`: the public route.
    - Registers synchronously and runs serially.
    - Rejects `PersistencePhaseError` if the attempt is revoked or the phase admits no public operation.
    - `run` must call `attempt.assertLive()` after every `await` and before every row write.
  - `coordinator(attempt: OwnerAttempt): CoordinatorToken`: a frozen, unforgeable object, valid only for this entry and attempt. The queue tracks tokens in a private `WeakSet`.
  - `coordinate<T>(token: CoordinatorToken, run: (attempt: OwnerAttempt) => Promise<T>): Promise<T>`: same lock and serial order as `operation`, but admitted only in `finalise`/`account` and only for a live token. It is never exposed to host code.
  - `fail(error: unknown): void` and `get rollbackOnly(): boolean`: record a fatal failure that survives abandonment and catching.
  - `callback<T>(fn: () => T): T`: runs host code under the synchronous marker and inside `port.run(token, fn)` when a port is configured; restores the marker on throw.
  - `trackBackend(p: Promise<unknown>): void`: backend completion is awaited by fail-stop disposal and release, never by Read-failure reporting.
  - `release(): void`: immediate release, used by Read failure after `attempt.revoke`.
- **`current()`** returns the active entry from the synchronous marker or the port token, never a released one.
- **Runtime-neutral pieces.** The new code paths use no `node:`, ALS, `AbortSignal.any` or `Promise.withResolvers`; they use `runtime.ts`. The existing ALS-backed `sequence` path stays untouched until Task 4.

- [ ] **Step 1: Tests** for:
  - registration before lock: B queued behind a suspended A before the closure drains;
  - per-phase freeze: a call after closure in the same phase refuses, and `effects` reopens;
  - `coordinate` admitted only in `finalise`/`account` and only with this entry's live token; a forged object is rejected;
  - a fatal failure survives abandonment and catching;
  - attempt revocation rejects pending operations and discards late writes (`assertLive`);
  - failed read: `revoke` plus `release` without awaiting the suspended operation; the next root proceeds; `trackBackend` still settles;
  - fail-stop with a queued operation rejects both;
  - sync-marker reentrancy from every phase and hook, without a port;
  - port reentrancy after `await`;
  - unrelated callers stay unbound;
  - port restore after a throw;
  - a released entry is never `current`;
  - `anySignal` and `deferred` unit cases.
- [ ] **Step 2: Run red, implement, run green:**
  - `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/owner-queue.test.ts`
  - `rtk proxy pnpm turbo run build:js build:types test:types`

  Then mutation-check registration, per-phase freeze, coordinator admission, the fatal-failure record, revocation and the sync marker.
- [ ] **Step 3: Commit** `feat(mls-rpc): add runtime-neutral operation lock and coordinator route to the owner queue`.

### Task 3: Memory group provider on r18, port threading

**Files:**
- Modify:
  - `packages/mls-rpc/src/memory-transaction.ts`
  - `packages/mls-rpc/src/memory-group-state.ts`
  - `packages/mls-rpc/src/memory-group-persistence.ts`
  - `packages/mls-rpc/src/memory-incarnation-stores.ts`
  - `packages/mls-rpc/src/memory-group-ports.ts`
  - `packages/mls-rpc/src/memory-device-persistence.ts`: factory signature and port only.
  - related tests

**Interfaces:**
- **Consumes:** Task 2's queue.
- **Produces:**
  - `createMemoryGroupPersistence({ ..., ownershipContext? })`, `createMemoryGroupCoordinator({ ..., ownershipContext? })` and `createMemoryDevicePersistence({ ..., ownershipContext? })` all thread the port into the database-bound `createOwnerQueues`, following the binding rule in Global Constraints.
  - Group stores bind to their entry through a private `WeakMap` keyed by the guarded row maps; no `AsyncLocalStorage` in group files.
  - A private `CoordinatorWriter` per entry and attempt wraps `entry.coordinate`. `finalise`/`account` use it. It is never exported and never passed to host code. Codec seal and open called from coordinator steps run through `entry.callback`, so they get no writer.
  - Host effect callables and getter results are captured before `finalise`.
  - Required-open failures call `entry.fail`; the unreadable-state diagnostic does not.
  - Public group stores call `entry.operation`, with private unlocked helpers inside.
  - Read failure calls `attempt.revoke` then `entry.release()` and reports at once. It no longer awaits `enter('outcome')` in `finally`.
- **Unchanged:** device composition still uses `sequence`, flattened in Task 4.

- [ ] **Step 1: Red** for the Review Focus cases plus the final-review probes:
  - an effect getter writing `restorePending` during finalise is refused;
  - a codec reading constructed lifetime stores during account is refused;
  - two host sibling `control.apply` calls both persist;
  - the factory binding-rule `TypeError`.
- [ ] **Step 2: Migrate, then go green:**
  - `rtk proxy pnpm turbo run build:js build:types test:types`
  - `rtk proxy pnpm --filter @kumiai/mls-rpc run test`

  Expected: group-scope ownership cases pass in both port modes. Record the remaining device-scope failures.
- [ ] **Step 3: Mutation-check** writer-only access in finalise/account, effects capture, required-open poisoning, Read-failure non-awaiting and port threading; then restore.
- [ ] **Step 4: Commit** `refactor(mls-rpc): bind memory group persistence explicitly with a private coordinator writer`.

### Task 4: Memory device provider on r18; retire `sequence`

**Files:**
- Modify:
  - `packages/mls-rpc/src/memory-device-persistence.ts`
  - `packages/mls-rpc/src/memory-package-stores.ts`
  - `packages/mls-rpc/src/testing.ts`
  - `packages/mls-rpc/src/owner-queue.ts`: remove `sequence`, `sequencedContext`, nested-inline logic and every `node:`/ALS use.
  - `packages/mls-rpc/test/owner-queue.test.ts`: retarget the nested-`sequence` cases to "nesting is not offered".
  - related tests

**Interfaces:**
- **Produces:**
  - Device load and restore compose through private helpers under one reservation.
  - Package-read callbacks run without an outer reservation.
  - `OwnerEntry` no longer has `sequence`.
  - No ALS anywhere in `packages/mls-rpc/src`.

- [ ] **Step 1: Red** for: device initial and existing load, device transition, package read, and Combined in no-port mode; reopen with the port after fail-stop.
- [ ] **Step 2: Migrate, then go green:** the full ownership-phases suite in both modes and both port modes; all mls-rpc tests; `rtk proxy pnpm turbo run build:js build:types test:types`.
- [ ] **Step 3: Mutation-check** flattening (reintroducing an outer reservation makes the case time out) and port reopen; then restore.
- [ ] **Step 4: Commit** `refactor(mls-rpc): flatten memory device persistence onto the operation lock`.

### Task 5: Runtime baseline, guard and gate

**Files:**
- Modify:
  - `packages/mls-rpc/src/memory-transaction.ts`: guard `SharedArrayBuffer`; `Promise.withResolvers` becomes `deferred`.
  - `packages/rpc-conformance/src/memory-control-store.ts`: `structuredClone` becomes a local typed clone.
  - `packages/rpc-conformance/src/ownership-phases.ts`: `Promise.withResolvers` becomes a local deferred, since conformance cannot import mls-rpc src.
  - every remaining banned use found by the guard
- Create:
  - `packages/mls-rpc/test/runtime-neutral.test.ts`: a static guard. It fails if any `packages/mls-rpc/src/**/*.ts` or `packages/rpc-conformance/src/**/*.ts` imports `node:` or references a forbidden global from Global Constraints, unless the reference is inside a `typeof` guard.
  - `packages/mls-rpc/test/runtime-baseline.test.ts`: a capability-limited smoke run.
    - `vi.stubGlobal` removes `structuredClone`, `SharedArrayBuffer`, `Atomics`, `setImmediate` and `process`; it deletes `Promise.withResolvers`, `AbortSignal.any` and `AbortSignal.timeout`, restoring them in `afterAll`.
    - It then dynamically imports the memory factories and runs, without a port: device initial load, device transition, package read, group control apply, and Combined participation.
- Modify: `.changeset/spec-p-storage-foundation.md` summary: append "Ownership is runtime-neutral with an optional ownershipContext port."

- [ ] **Step 1:** Write both tests. Run them red against the current banned uses, replace the uses, and run them green. Mutation-check the guard by temporarily adding a `structuredClone` call, then restore.
- [ ] **Step 2: Gate.** Each must pass:
  - `rtk proxy pnpm turbo run build:js build:types`
  - `rtk proxy pnpm turbo run test:types`
  - `rtk proxy pnpm --filter @kumiai/mls-rpc run test`
  - `rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types`
  - `rtk proxy pnpm --filter @kumiai/integration-tests run test:types`
  - `rtk proxy pnpm run lint`
  - `rtk proxy pnpm run check:versions`

  Controller: the forced `pnpm exec turbo run test:types test:unit --force --continue` (`Cached: 0`) and `pnpm exec vitest run --root tests/integration`.
- [ ] **Step 3: Commit** `fix(mls-rpc): hold persistence sources to the runtime-neutral baseline`.
