# Spec P 2.1c Runtime-Neutral Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the 2.1b ownership queue to Spec P r18:
- no `AsyncLocalStorage` and no runtime-specific globals in `mls-rpc`/`rpc-conformance` sources;
- a per-entry operation lock under which nesting is forbidden by construction;
- a private coordinator route;
- explicit internal bindings;
- an optional `ownershipContext` port for diagnosing reentrancy.

**Architecture:** `owner-queue.ts` drops Node imports. Root reentrancy uses a synchronous marker set around every callback, hook and proof step, plus an optional host port carrying an opaque token.

Each entry owns one operation lock with two admission routes:
- **public `operation`**, for store calls;
- **private `coordinate`**, for `finalise`/`account` writes. It is authorised by an unforgeable token that only the provider holds.

Store calls register synchronously, run serially over their whole read-modify-write, and are frozen and drained per phase. Fatal failures make the transition rollback-only.

Operations bind to the entry, the provider transaction and an `OwnerAttempt`. An attempt is revoked on cancellation, fail-stop, retry, failed reads, and work/effect rejection. Revocation always happens before any drain or rollback.

The memory provider binds transactions to entries through a `WeakMap`, captures host effect callables before `finalise`, and flattens device composition into private helpers. The new queue API lands additively in Task 2. Both providers then switch in one atomic commit (Task 3), because they share store helpers. The old path is deleted afterwards (Task 4).

**Tech Stack:** TypeScript, Vitest, pnpm/turbo. Only test files may use Node APIs; the `AsyncLocalStorage` port adapter lives in tests.

**Spec:** `docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md` r18 (commit `c2bc0cc`). Relevant parts:
- D8 Phases table
- Store operations
- Coordinator authority
- Fail-stop
- Reentrancy (r18)
- Factory signatures (`ownershipContext?`)
- the ownership-phases Conformance rows "operation lock" and "ordering/reentrancy/deletion"

**Starting point:** branch `feat/spec-p-phase-2` at the 2.1b head.
- Ledger: `.superpowers/sdd/2026-10-10-spec-p-2-1b-ownership-queue/progress.md` (the "Final:" lines).
- Findings in the same directory: `final-findings.md`, `final-rereview.log`, `r18-findings.md`, `r18-rereview.md`, `r18-round3.md`, `r18-round4.md`.

## Global Constraints

Plans 2.1 and 2.1b Global Constraints apply unchanged, except where r18 replaces them. In addition:

- **Runtime neutrality.** Spec: "Core logic is runtime-neutral (Node, browsers, Hermes) and uses no runtime-specific async-context API; `ownershipContext` only diagnoses public root reentrancy."
- **Runtime baseline** for `packages/mls-rpc/src` and `packages/rpc-conformance/src`.
  - **Language and host APIs:** ES2022 plus:
    - `WeakMap`, `WeakSet`
    - `AbortController`/`AbortSignal` (constructor, `abort`, `aborted`, `reason`, `addEventListener`, `removeEventListener`)
    - `queueMicrotask`, `setTimeout`
    - `TextEncoder`/`TextDecoder`
    - Web Crypto: `crypto.getRandomValues`, `crypto.subtle`, `crypto.randomUUID`
  - **Supported hosts:**
    - Node ≥ 20.
    - Evergreen browsers in a secure context, which Web Crypto `subtle` and `randomUUID` require.
    - React Native Hermes with a Web Crypto and `TextEncoder` polyfill. The MLS layer already requires that polyfill.
  - **Forbidden:**
    - `node:` imports
    - `AsyncLocalStorage`, `structuredClone`, `Promise.withResolvers`
    - `AbortSignal.any`, `AbortSignal.timeout`
    - `setImmediate`, `process`, `Buffer`
  - `SharedArrayBuffer` and `Atomics` may appear only behind `typeof … !== 'undefined'`.
  - Replace each banned use with a local helper: `deferred<T>()`, the `anySignal` binding, or a typed clone.
- **Port type.** `type OwnershipContextPort = { run<T>(token: object, fn: () => T): T; get(): object | undefined }`.
  - `createMemoryDevicePersistence`, `createMemoryGroupPersistence` and `createMemoryGroupCoordinator` all accept `ownershipContext?: OwnershipContextPort`.
  - Core passes an opaque, frozen token that has no methods.
  - The owner queues are bound to a `MemoryDatabase` on first use. A later factory call on the same database that supplies a different port object throws `TypeError('ownershipContext differs from the port bound to this database')`. Omitting the port, or passing the same object, reuses the binding.
- **No nesting.** Spec: "Operations never nest". No store method, coordinator helper or read callback calls a public store method or another locked operation while it holds a reservation.
- **Registration.** Spec: "An allowed store call registers its operation synchronously before returning its promise." A phase change freezes and drains only the outgoing phase's operations.
- **Fatal failures.** A failure is fatal when one of the following happens, and stays rollback-only even if it is abandoned or caught:
  - a seal fails;
  - a required open fails;
  - **the failing operation itself** changed a row before failing.

  A refused or failed operation that changed nothing does not poison the transaction. A private diagnostic may classify unreadable MLS state for control/meta-only safety work without poisoning.
- **Release vs backend.**
  - `release()` frees the application ownership slot immediately.
  - Backend completion (memory transaction rollback or commit) is tracked separately with `trackBackend`.
  - The provider's next backend transaction on that database waits for tracked completion through its backend barrier, never through the owner slot.
  - Fail-stop disposal awaits tracked completion.
  - Spec: "A failed `Read` immediately revokes its attempt bindings ... and releases application ownership without awaiting host callbacks."
- **Revoke before drain.** On work, effect or Read rejection, or on cancellation, the provider calls `attempt.revoke(reason)` before it awaits any drain, rollback or `enter`. The attempt's `signal` is bound to the provider transaction's disposal.
- **Errors.**
  - Fail-stop rejects active operations, queued operations and drains with the factory's `GroupStateConflictError` instance (D8 Fail-stop).
  - `PersistencePhaseError` is reserved for expired bindings, revoked attempts outside fail-stop, and ordinary access refusals.
- **Port modes.** Every conformance case runs both without a port and with a test `AsyncLocalStorage` adapter port. Reentrancy-after-`await` cases run only with the port.
- **Mutation checks.** Every new case is mutation-checked.
- **Changeset.** Extend the `.changeset/spec-p-storage-foundation.md` summary; add no second intent.
- **Every commit compiles.** Each commit passes `rtk proxy pnpm turbo run build:js build:types test:types`. Expected-red is allowed only in Task 1's new runtime cases.
- **Evidence limit.** This plan's runtime evidence is a static guard plus a capability-restricted Node smoke run. Real browser and Hermes runs are not in this plan; the final report must say so.
- **Deferred requirements** (not in this plan):
  - runtime deletion drains and owner-creation blocking: plan 2.2;
  - the D6 certification retry consumer: plan 2.3;
  - the phase-3 factory and SQLite/PostgreSQL/Expo database evidence: phase 3.

## Review Focus

- **Stores kept from `work`, used in `effects`.** A host effect keeps stores from `work` and calls them in `effects` while an earlier `work` operation is still suspended. Expected: the `work` operation drains first, then the effect call runs in `effects`. Pinned in Task 3.
- **Codec seal waiting on unrelated code.** A codec's seal awaits a promise that only resolves later in the same tick, resolved by unrelated code rather than hooks. Expected: no deadlock and no leaked authority. Pinned in Task 3.
- **Unrelated concurrent callers with a port.** Two independent concurrent callers on different groups, with the port supplied. Expected: neither is reported as reentrant. Pinned in Task 1.
- **Fail-stop with a queued operation.** Fail-stop arrives while an operation is queued behind a suspended one. Expected: both reject with the conflict error, nothing writes, and the backend completes. Pinned in Task 2.
- **Reopen with the port after fail-stop.** Expected: reopen works. Pinned in Task 3.

---

### Task 1: Port type, fixture interfaces and r18 conformance (red)

**Files:**
- **Modify:**
  - `packages/mls-rpc/src/persistence-types.ts`: export `OwnershipContextPort`; `PersistenceFixture` type.
  - `packages/mls-rpc/src/index.ts`: re-export.
  - `packages/mls-rpc/src/memory-device-persistence.ts`, `packages/mls-rpc/src/memory-group-persistence.ts`: add the `ownershipContext?: OwnershipContextPort` parameter, accepted and unused until Task 3.
  - `packages/rpc-conformance/src/persistence-fixture.ts`: mirror types.
  - `packages/rpc-conformance/src/ownership-phases.ts`
  - `packages/rpc-conformance/src/group-storage.ts`: the `:457` caller.
  - `packages/rpc-conformance/src/device-storage.ts`
  - `packages/rpc-conformance/src/index.ts`
  - `packages/mls-rpc/test/fixtures/storage-persistence.ts`
  - `packages/mls-rpc/test/storage-conformance.test.ts`: the `createFixture` wrapper.
  - `packages/mls-rpc/test/ownership-phases-conformance.test.ts`
  - `packages/mls-rpc/test/storage-fixture.test.ts`
- **Create:** `packages/mls-rpc/test/fixtures/ownership-context.ts`, exporting `createAsyncLocalOwnershipContext(): OwnershipContextPort` (Node, test-only).

**Interfaces:**
- **Produces `FixtureOptions<TTx>`:**
  - Type: `{ effects?: ConformanceTransactionalGroupEffects<TTx>; ownershipContext?: ConformanceOwnershipContextPort }`.
  - Signature: `StorageConformanceParams<TTx>.createFixture(id: string, options?: FixtureOptions<TTx>)`.
  - Every caller and wrapper migrates in this commit. `group-storage.ts:457` passes `{ effects: { outbox } }`.
  - The mls-rpc wrapper forwards `options` to `createStorageFixture({ id, mode, ...options })`.
  - `createStorageFixture` passes `ownershipContext` to the factories, which accept it from this task onward.
- **Produces fixture instrumentation.**
  - Every method has a mirror signature in `persistence-fixture.ts`.
  - Every latch is one-shot. It clears when it fires, when its transaction fails, or when its attempt is revoked.

  | Method | Behaviour |
  |---|---|
  | `failNextSeal(error?: Error): void` | The next codec seal rejects. |
  | `holdNextOpen(): { started: Promise<void>; release(): void }` | The next codec open suspends until `release()`. |
  | `failNextOpen(error?: Error): void` | The next codec open rejects. |
  | `probeCodec(fn: (phase: string) => Promise<void>): void` | The next seal or open first awaits `fn(currentPhase)`. |
  | `onPhase(phase: 'prepare' \| 'work' \| 'effects' \| 'finalise' \| 'account' \| 'proof' \| 'hook', fn: () => Promise<void> \| void): void` | Runs `fn` as host code at that phase's callback point in the next transition. |
  | `readWith<T>(fn: (stores: DeviceStores) => Promise<T>): Promise<T>` | An entry-bound public Read that runs an arbitrary callback. It can start an open and then throw. |
  | `combinedWith(signal: AbortSignal): Promise<void>` | Starts a Combined acquisition under a caller signal, so the case can abort it. |
  | `retryNextTransition(): void` | Forces a known rollback on the next transition, so the coordinator retries on the retained entry. |
- **Produces** `testOwnershipPhasesConformance(params & { ownershipContext?: () => ConformanceOwnershipContextPort })`. It runs every case without a port. When `ownershipContext` is supplied, it runs every case again with a fresh port per fixture.

- [ ] **Step 1: Migrate signatures, factory parameters and instrumentation.** No behaviour change. Run `rtk proxy pnpm turbo run build:js build:types test:types`; existing storage conformance stays green.
- [ ] **Step 2: Add cases.** Add one shared case per matrix row. Each case is bounded by the existing 2000 ms race.

  | r18 requirement | Case |
  |---|---|
  | Registration before lock | Same-record concurrent `control.apply` from the host: both persist. An operation called behind a suspended one before `work` returns still drains and is seen by finalise. |
  | Per-phase freeze / effects reopen | Work-supplied stores are used in `effects`; the work operation drains first. |
  | Seal failure fatal | An abandoned seal rejection (`failNextSeal`) rolls back. |
  | Required-open failure fatal | A caught `failNextOpen` inside `work` still rolls back. |
  | Failure after row change fatal | One `outbox.put([valid, invalid])` writes its first row and then fails validation; the failure is caught, and the transition rolls back. |
  | Non-mutating failure not fatal | After an earlier successful write, a caught refused access commits. |
  | Attempt revocation | A late call through a revoked attempt (`retryNextTransition`) writes nothing. |
  | Work/effect rejection | A suspended operation is pending when `work` rejects: it rejects with `PersistencePhaseError`, nothing writes, and the next transition completes. Same for `effects`. |
  | Failed Read release | `readWith` starts an open under `holdNextOpen` and throws. The Read rejects without awaiting `release()`, and the next same-scope op completes. |
  | Coordinator privacy | An effect getter, a codec callback (`probeCodec`) and an accessor during `finalise`/`account` cannot read or write, and the rows are unchanged. |
  | Released entry | A root scheduled by a hook after release succeeds. |
  | Port: unrelated callers | Two concurrent callers on different groups are not reported as reentrant. |
  | Port: reentrancy after `await` | `onPhase` with a root call after an `await` rejects in each of `prepare`, `work`, `effects`, `finalise`, `account`, `proof` and `hook`. Port mode only. |
  | Sync-marker reentrancy | A synchronous `onPhase` root call rejects in the same phases, without a port. |
  | Port restore | The binding is restored after a throwing callback. |
  | No nesting | Device initial/existing load, device transition, package read and Combined all complete without a port. |
  | Combined cancellation | Aborting `combinedWith` releases both entries, and the next Combined completes. |
  | Fail-stop errors | Active, queued and draining operations reject with the same `GroupStateConflictError` instance. |
  | Safety obligations | Safety events for corrupt state or trust still commit their control obligations. |
- [ ] **Step 3: Wire** both modes in `ownership-phases-conformance.test.ts` using `createAsyncLocalOwnershipContext`.
- [ ] **Step 4: Run red.**
  - Commands: `rtk proxy pnpm turbo run build:js build:types test:types`, then `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/ownership-phases-conformance.test.ts`.
  - Expected: types pass; the new cases fail, with the failure reason recorded per case; pre-existing cases are unchanged.
- [ ] **Step 5: Commit** `test(rpc-conformance): add r18 ownership conformance cases`.

### Task 2: Runtime-neutral owner queue API (additive)

**Files:**
- Modify: `packages/mls-rpc/src/owner-queue.ts`, `packages/mls-rpc/test/owner-queue.test.ts`
- Create: `packages/mls-rpc/src/runtime.ts`, exporting:
  - `deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }`
  - `anySignal(signals: AbortSignal[]): { signal: AbortSignal; dispose(): void }`. `dispose` removes every listener; abort removes them too.

**Interfaces:**
- **Produces:**
  - `export type OwnershipContextPort` (re-exported from `persistence-types.ts`)
  - `createOwnerQueues(options?: { ownershipContext?: OwnershipContextPort }): OwnerQueues`
- **`OwnerAttempt`:**
  - Type: `{ readonly id: number; readonly revoked: boolean; readonly signal: AbortSignal; revoke(reason: unknown): void; assertLive(): void }`.
  - `revoke` aborts `signal` with `reason` and rejects every pending operation of that attempt with `reason`. The reason is either `PersistencePhaseError` or, under fail-stop, the factory's `GroupStateConflictError`.
  - `assertLive()` throws `signal.reason` once the attempt is revoked.
- **New `OwnerEntry` members.** All additive; `sequence` stays until Task 4.
  - `attempt(): OwnerAttempt`: the current attempt. `enter('work')` after a known rollback revokes the old attempt and starts a new one.
  - `operation<T>(attempt: OwnerAttempt, run: (attempt: OwnerAttempt) => Promise<T>): Promise<T>`: the public route.
    - It registers synchronously and runs serially.
    - It rejects with `PersistencePhaseError` if the attempt is revoked or the phase admits no public operation.
    - `run` calls `attempt.assertLive()` after every `await` and before every row write.
  - `coordinator(attempt: OwnerAttempt): CoordinatorToken`: a frozen, unforgeable object, valid only for this entry and attempt. Tokens are tracked in a private `WeakSet`.
  - `coordinate<T>(token: CoordinatorToken, run: (attempt: OwnerAttempt) => Promise<T>): Promise<T>`: the private route.
    - Same lock and serial order as `operation`.
    - Admitted only in `finalise`/`account`, and only with a live token.
    - Never exposed to host code.
  - `fail(error: unknown): void` and the getter `rollbackOnly: boolean`: record a fatal failure.
  - `callback<T>(fn: () => T): T`: runs host code under the synchronous marker, inside `port.run(token, fn)` when a port is configured, and restores the marker on throw.
  - `trackBackend(p: Promise<unknown>): void` and `backendSettled(): Promise<void>`. Fail-stop disposal awaits `backendSettled()`; release never does.
  - `release(): void`: frees the application slot immediately and disposes the entry's `anySignal` binding.
- **`current()`** returns the active entry from the synchronous marker or the port token, never a released one.
- **Fail-stop** rejects active operations, queued operations and drains with the factory's `GroupStateConflictError` instance.
- **New code paths** use no `node:`, ALS, `AbortSignal.any` or `Promise.withResolvers`; they use `runtime.ts`. The existing ALS-backed `sequence` path stays untouched until Task 4.

- [ ] **Step 1: Write tests** for:
  - **Ordering:** registration before lock (B queued behind a suspended A before the closure drains); per-phase freeze (a call after closure in the same phase refuses; `effects` reopens).
  - **Coordinator route:** `coordinate` is admitted only in `finalise`/`account` with this entry's live token; a forged object is rejected.
  - **Fatal failures:** a recorded fatal failure survives abandonment and catching.
  - **Revocation:** a revoked attempt rejects pending operations with the given reason and discards late writes (`assertLive`). On a failed read, `revoke` plus `release` happen without awaiting the suspended operation, the next root proceeds, and `backendSettled` still settles.
  - **Fail-stop:** with a queued operation, both the queued and the active operation reject with the same conflict instance.
  - **Reentrancy:** the sync marker detects it from every phase and hook without a port; the port detects it after an `await`; unrelated callers stay unbound; the port binding is restored after a throw.
  - **Release:** a released entry is never `current`; an `anySignal` listener count returns to zero after success, rejection and cancellation.
  - **Helpers:** unit cases for `deferred`.
- [ ] **Step 2: Run red, implement, run green.** Use `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/owner-queue.test.ts` and `rtk proxy pnpm turbo run build:js build:types test:types`. Mutation-check registration, the per-phase freeze, coordinator admission, the fatal-failure record, revocation, the sync marker and listener disposal.
- [ ] **Step 3: Commit** `feat(mls-rpc): add runtime-neutral operation lock and coordinator route to the owner queue`.

### Task 3: Memory group and device providers on r18 (atomic switch)

**Files:**
- Modify, in `packages/mls-rpc/src/`:
  - `memory-transaction.ts`
  - `memory-group-state.ts`
  - `memory-group-persistence.ts`
  - `memory-incarnation-stores.ts`
  - `memory-group-ports.ts`
  - `memory-device-persistence.ts`
  - `memory-package-stores.ts`
  - `testing.ts`
- Modify the related tests.

**Interfaces:**
- **Consumes:** the Task 2 queue and the Task 1 factory parameters.
- **Produces the provider switch.** Both providers stop calling `sequence` in this commit.
- **Port threading.** The three factories thread `ownershipContext` into the database-bound `createOwnerQueues`, following the binding rule in Global Constraints.
- **Transaction binding.**
  - Group and device stores bind to their entry through a private `WeakMap` keyed by the guarded row maps; no `AsyncLocalStorage` in provider files.
  - The provider transaction's disposal listens to `attempt.signal`.
- **Coordinator writer.** A private `CoordinatorWriter` per entry and attempt wraps `entry.coordinate`.
  - Group finalise/account and device accounting write only through it.
  - It is never exported and never passed to host code.
  - Codec seal/open and every host callback called from coordinator steps run through `entry.callback`, and get no writer.
- **Effects capture.** Host effect callables and getter results are captured before `finalise`.
- **Failure classification.** Required-open failures and failing operations that changed rows call `entry.fail`. The unreadable-state diagnostic and non-mutating refusals do not.
- **Store composition.** Public stores call `entry.operation` with private unlocked helpers inside. Device load/restore compose private helpers under one reservation. Package-read callbacks run without an outer reservation.
- **Rejection paths.** Work, effect and Read rejection and cancellation call `attempt.revoke(reason)` before any drain, rollback or `enter`. Read failure then calls `entry.release()` and reports immediately; it no longer awaits `enter('outcome')` in `finally`.
- **Backend tracking.** Backend rollback/commit goes to `entry.trackBackend`. The memory backend barrier serialises the next backend transaction on that completion.

- [ ] **Step 1: Write the red cases:**
  - the Review Focus cases;
  - the final-review probes: an effect getter writing `restorePending` during finalise is refused; a codec reading constructed lifetime stores during account is refused; two host sibling `control.apply` both persist;
  - the factory binding-rule `TypeError`;
  - suspended-operation rejection on work/effect failure for both group and device transitions;
  - reopen with the port after fail-stop.
- [ ] **Step 2: Migrate, then run green.** Run `rtk proxy pnpm turbo run build:js build:types test:types` and `rtk proxy pnpm --filter @kumiai/mls-rpc run test`. Expected: the full ownership-phases suite passes in both modes and both port modes, and all mls-rpc tests pass.
- [ ] **Step 3: Mutation-check, then restore:**
  - writer-only access in finalise/account
  - effects capture
  - required-open poisoning
  - non-mutating refusal not poisoning
  - Read-failure non-awaiting
  - revoke-before-drain
  - flattening (reintroduce an outer reservation: the case times out)
  - port threading
- [ ] **Step 4: Commit** `refactor(mls-rpc): run memory persistence on the operation lock with a private coordinator writer`.

### Task 4: Retire `sequence` and async context

**Files:**
- Modify:
  - `packages/mls-rpc/src/owner-queue.ts`: remove `sequence`, `sequencedContext`, the nested-inline logic, and every `node:`/ALS use.
  - `packages/mls-rpc/test/owner-queue.test.ts`: retarget the nested-`sequence` cases to "nesting is not offered".

**Interfaces:**
- **Produces:** `OwnerEntry` without `sequence`; no ALS anywhere in `packages/mls-rpc/src`.

- [ ] **Step 1: Remove the old path.** Then run `rtk proxy pnpm turbo run build:js build:types test:types` and `rtk proxy pnpm --filter @kumiai/mls-rpc run test`. Expected: green.
- [ ] **Step 2: Commit** `refactor(mls-rpc): remove sequenced ownership and async context from the owner queue`.

### Task 5: Runtime baseline, guard and gate

**Files:**
- **Modify:**
  - `packages/mls-rpc/src/memory-transaction.ts`: guard `SharedArrayBuffer`; replace `Promise.withResolvers` with `deferred`.
  - `packages/rpc-conformance/src/memory-control-store.ts`: replace `structuredClone` with a local typed clone.
  - `packages/rpc-conformance/src/ownership-phases.ts`: replace `Promise.withResolvers` with a local deferred, since conformance cannot import mls-rpc src.
  - every remaining banned use the guard finds.
- **Create `packages/mls-rpc/test/runtime-neutral.test.ts`:** a static guard. It fails if any `packages/mls-rpc/src/**/*.ts` or `packages/rpc-conformance/src/**/*.ts` imports `node:` or references a forbidden global from Global Constraints. A `SharedArrayBuffer`/`Atomics` reference inside a `typeof` guard is allowed.
- **Create `packages/mls-rpc/test/runtime-baseline.test.ts`:** a capability-restricted smoke test.
  - With `vi.stubGlobal`, remove `structuredClone`, `SharedArrayBuffer`, `Atomics`, `setImmediate`, `process` and `Buffer`, and delete `Promise.withResolvers`, `AbortSignal.any` and `AbortSignal.timeout`. Restore all of them in `afterAll`.
  - Keep only the baseline APIs.
  - Dynamically import the memory factories.
  - Run without a port: device initial load, device transition, package read, group control apply, and Combined participation.
- **Modify `.changeset/spec-p-storage-foundation.md`:** append to the summary "Ownership is runtime-neutral with an optional ownershipContext port."

- [ ] **Step 1: Write both tests and mutation-check.** Run them red against the current banned uses, replace those uses, then run them green. Mutation-check the guard by temporarily adding a `structuredClone` call, then restore.
- [ ] **Step 2: Gate.** Each of these must pass:
  - `rtk proxy pnpm turbo run build:js build:types`
  - `rtk proxy pnpm turbo run test:types`
  - `rtk proxy pnpm --filter @kumiai/mls-rpc run test`
  - `rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types`
  - `rtk proxy pnpm --filter @kumiai/integration-tests run test:types`
  - `rtk proxy pnpm run lint`
  - `rtk proxy pnpm run check:versions`

  The controller also runs a forced `pnpm exec turbo run test:types test:unit --force --continue` (expect `Cached: 0`) and `pnpm exec vitest run --root tests/integration`.
- [ ] **Step 3: Commit** `fix(mls-rpc): hold persistence sources to the runtime-neutral baseline`.
