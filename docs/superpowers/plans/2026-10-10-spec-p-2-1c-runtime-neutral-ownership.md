# Spec P 2.1c Runtime-Neutral Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the 2.1b ownership queue to Spec P r18: no `AsyncLocalStorage` anywhere in `mls-rpc`/`rpc-conformance` sources, a per-entry operation lock with nesting forbidden by construction, a private coordinator writer, explicit internal bindings, and an optional `ownershipContext` port for reentrancy diagnosis.

**Architecture:** `owner-queue.ts` drops Node imports; root reentrancy uses a synchronous marker set around every callback/hook/proof step plus an optional host port carrying an opaque token. Each entry owns an operation lock: store calls register synchronously, run serially over their whole read-modify-write, and are frozen and drained per phase; fatal failures make the transition rollback-only; operations bind to entry, provider transaction and attempt and are revoked on cancellation, fail-stop, retry and failed reads. The memory provider binds transactions to entries explicitly, writes `finalise`/`account` through a private writer, captures host effect callables before `finalise`, and flattens device composition into private helpers.

**Tech Stack:** TypeScript, Vitest, pnpm/turbo. Test files may use Node APIs (an `AsyncLocalStorage` port adapter lives only in tests).

**Spec:** `docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md` r18 (commit `c2bc0cc`): D8 Phases table, Store operations, Coordinator authority, Reentrancy (r18), factory signatures (`ownershipContext?`), ownership-phases Conformance rows "operation lock" and "ordering/reentrancy/deletion". Starting point: branch `feat/spec-p-phase-2` at the 2.1b head; ledger `.superpowers/sdd/2026-10-10-spec-p-2-1b-ownership-queue/progress.md` ("Final:" lines) and findings `final-findings.md`, `final-rereview.log`, `r18-findings.md`, `r18-rereview.md` there.

## Global Constraints

Plans 2.1 and 2.1b Global Constraints apply unchanged, except where r18 replaces them. In addition:

- "Core logic is runtime-neutral (Node, browsers, Hermes) and uses no runtime-specific async-context API; `ownershipContext` only diagnoses public root reentrancy." No `node:` import in `packages/mls-rpc/src` or `packages/rpc-conformance/src`.
- `type OwnershipContextPort = { run<T>(token: object, fn: () => T): T; get(): object | undefined }`; both device persistence factories accept `ownershipContext?: OwnershipContextPort`. Core passes an opaque token with no methods.
- "Operations never nest": no store method, coordinator helper or read callback calls a public store method or another locked operation while holding a reservation.
- "An allowed store call registers its operation synchronously before returning its promise." Phase change freezes and drains only the outgoing phase's operations.
- Fatal failures (seal, failed required open, failure after a row change) are rollback-only even when abandoned or caught; a private diagnostic may classify unreadable MLS state for control/meta-only safety work.
- "A failed `Read` immediately revokes its attempt bindings ... and releases application ownership without awaiting host callbacks."
- Every conformance case runs both without a port and with a test `AsyncLocalStorage` adapter port; reentrancy-after-`await` cases run only with the port.
- Every new case is mutation-checked. `.changeset/spec-p-storage-foundation.md` summary is extended, no second intent.

## Review Focus

- A host effect that keeps stores from `work` and calls them in `effects` while an earlier `work` operation is still suspended: the work operation drains first, the effect call runs in `effects`. Pin in Task 3.
- A codec whose seal awaits a promise that only resolves later in the same tick from unrelated code (not from hooks) must not deadlock or leak authority. Pin in Task 3.
- Two independent concurrent callers on different groups with the port supplied: neither is reported as reentrant. Pin in Task 1.
- Fail-stop while an operation is queued behind a suspended one: both reject, nothing writes, backend completes. Pin in Task 2.
- Reopen with the port after fail-stop works. Pin in Task 4.

---

### Task 1: Conformance for r18 (red)

**Files:**
- Modify: `packages/rpc-conformance/src/ownership-phases.ts`, `packages/rpc-conformance/src/persistence-fixture.ts`, `packages/rpc-conformance/src/index.ts`
- Modify: `packages/mls-rpc/test/fixtures/storage-persistence.ts`, `packages/mls-rpc/src/persistence-types.ts` (`PersistenceFixture` type only), `packages/mls-rpc/test/ownership-phases-conformance.test.ts`, `packages/mls-rpc/test/storage-fixture.test.ts`
- Create: `packages/mls-rpc/test/fixtures/ownership-context.ts` (`createAsyncLocalOwnershipContext(): OwnershipContextPort`, Node test-only)

**Interfaces:**
- Produces: `StorageConformanceParams.createFixture(id, options?: { effects?; ownershipContext?: ConformanceOwnershipContextPort })`; `testOwnershipPhasesConformance(params & { ownershipContext?: () => ConformanceOwnershipContextPort })` runs every case without a port and, when supplied, again with it.

- [ ] **Step 1: Add cases** to the r18 rows, each bounded by the existing 2000 ms race: same-record concurrent `control.apply` from host both persist; abandoned seal rejection (fixture `failNextSeal()`) rolls back; operation called behind a suspended one before `work` returns still drains and is seen by finalise; work-supplied stores used in `effects`; late call through a revoked attempt (retry) writes nothing; suspended abandoned open then Read failure releases and next same-scope op completes; effect getter, codec callback and accessor during `finalise`/`account` cannot read or write (rows unchanged); hook-scheduled root after release succeeds; two concurrent unrelated callers stay unbound (port mode); reentrancy after `await` in work/effects rejects (port mode only); port binding restored after a throwing callback; device initial/existing load, device transition, package read and Combined complete in no-port mode; corrupt state/trust safety events still commit.
- [ ] **Step 2: Wire** both modes in `ownership-phases-conformance.test.ts` using `createAsyncLocalOwnershipContext`.
- [ ] **Step 3: Run red.** `rtk proxy pnpm turbo run build:js build:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/ownership-phases-conformance.test.ts`; `test:types` for mls-rpc and rpc-conformance. Expected: types pass; new cases fail with reasons recorded per case; pre-existing cases unchanged.
- [ ] **Step 4: Commit** `test(rpc-conformance): add r18 ownership conformance cases`.

### Task 2: Runtime-neutral owner queue

**Files:**
- Modify: `packages/mls-rpc/src/owner-queue.ts`, `packages/mls-rpc/src/index.ts`, `packages/mls-rpc/test/owner-queue.test.ts`

**Interfaces:**
- Produces: `export type OwnershipContextPort`; `createOwnerQueues(options?: { ownershipContext?: OwnershipContextPort }): OwnerQueues`. `OwnerEntry` loses `sequence`; gains `operation<T>(attempt: OwnerAttempt, run: () => Promise<T>): Promise<T>` (registers synchronously, serial execution, rejects `PersistencePhaseError` if the attempt is revoked or the phase admits no public operation), `attempt(): OwnerAttempt` (current attempt; `enter('work')` after a known rollback starts a new one and revokes the old), `fail(error: unknown): void` (records a fatal failure; `rollbackOnly: boolean` getter), `callback<T>(fn: () => T): T` (runs host code under the synchronous marker and the port token). `current()` returns the active entry from the synchronous marker or the port token, never a released one. Remove `sequencedContext`, nested-inline logic and every `node:` import.

- [ ] **Step 1: Rewrite tests** for: registration-before-lock (B queued behind suspended A before closure drains); per-phase freeze (call after closure in same phase refuses, `effects` reopens); fatal failure survives abandonment and catching; attempt revocation rejects pending and discards late; failed read revokes and releases immediately; fail-stop with a queued op rejects both; sync-marker reentrancy from every phase and hook without a port; port reentrancy after `await`; unrelated callers unbound; port restore after throw; released entry never current. Keep every existing case that still applies; retarget nested-`sequence` cases to "nesting is not offered".
- [ ] **Step 2: Run red**, implement, run green: `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/owner-queue.test.ts` and `test:types`. Mutation-check registration, per-phase freeze, fatal-failure record, revocation, sync marker.
- [ ] **Step 3: Commit** `refactor(mls-rpc): make the owner queue runtime-neutral with an operation lock`.

### Task 3: Memory group provider on r18

**Files:**
- Modify: `packages/mls-rpc/src/memory-transaction.ts`, `memory-group-state.ts`, `memory-group-persistence.ts`, `memory-incarnation-stores.ts`, `memory-group-ports.ts`, related tests

**Interfaces:**
- Consumes: Task 2 queue. Produces: no `AsyncLocalStorage` in these files; transaction-to-entry binding through a private `WeakMap` keyed by the guarded row maps; private `CoordinatorWriter` per entry and attempt used by finalise/account (never exported, never passed to host code); host effect callables and getter results captured before `finalise`; required-open failures call `entry.fail`, the unreadable-state diagnostic does not; public stores call `entry.operation` with private unlocked helpers inside.

- [ ] **Step 1: Red** for the Review Focus cases plus the final-review probes: effect getter writing `restorePending` during finalise refused; codec reading constructed lifetime stores during account refused; two host sibling `control.apply` both persist.
- [ ] **Step 2: Migrate**, then green: build, `rtk proxy pnpm --filter @kumiai/mls-rpc run test`; group-scope ownership cases in both port modes pass; list remaining device-scope failures.
- [ ] **Step 3: Mutation-check** writer-only access in finalise/account, effects capture, required-open poisoning; restore.
- [ ] **Step 4: Commit** `refactor(mls-rpc): bind memory group persistence explicitly with a private coordinator writer`.

### Task 4: Memory device provider on r18

**Files:**
- Modify: `packages/mls-rpc/src/memory-device-persistence.ts`, `memory-package-stores.ts`, `testing.ts`, related tests, fixture wiring of `ownershipContext`

**Interfaces:**
- Produces: `createMemoryDevicePersistence({ ..., ownershipContext? })` threading the port into `createOwnerQueues`; device load/restore composed via private helpers under one reservation; package-read callbacks run without an outer reservation.

- [ ] **Step 1: Red**: device initial/existing load, device transition, package read, Combined in no-port mode; reopen with port after fail-stop.
- [ ] **Step 2: Migrate**, green: full ownership-phases suite in both modes and both port modes; all mls-rpc tests.
- [ ] **Step 3: Mutation-check** flattening (reintroduce outer reservation: case times out) and port threading; restore.
- [ ] **Step 4: Commit** `refactor(mls-rpc): flatten memory device persistence onto the operation lock`.

### Task 5: Runtime-neutral guard and gate

**Files:**
- Create: `packages/mls-rpc/test/runtime-neutral.test.ts` (fails if any `packages/mls-rpc/src/**/*.ts` or `packages/rpc-conformance/src/**/*.ts` imports `node:` or references `AsyncLocalStorage`)
- Modify: `.changeset/spec-p-storage-foundation.md` summary: append "Ownership is runtime-neutral with an optional ownershipContext port."

- [ ] **Step 1:** Write the guard test, mutation-check it by temporarily adding an import, restore.
- [ ] **Step 2: Gate**, each passes: `rtk proxy pnpm turbo run build:js build:types`; `rtk proxy pnpm turbo run test:types`; `rtk proxy pnpm --filter @kumiai/mls-rpc run test`; `rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types`; `rtk proxy pnpm --filter @kumiai/integration-tests run test:types`; `rtk proxy pnpm run lint`; `rtk proxy pnpm run check:versions`. Controller: forced `pnpm exec turbo run test:types test:unit --force --continue` (`Cached: 0`) and `pnpm exec vitest run --root tests/integration`.
- [ ] **Step 3: Commit** `test(mls-rpc): guard runtime-neutral persistence sources`.
