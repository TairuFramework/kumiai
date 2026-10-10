# Spec P 2.1d Runtime Baseline Across the Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every kumiai package that `@kumiai/mls-rpc` loads at runtime meets the plan 2.1c runtime baseline, and the static guard and capability smoke test enforce it.

**Architecture:** Three non-baseline APIs remain in that closure. Each gets a small package-local helper with tests that pin it to the native behaviour:

| API | Locations |
|---|---|
| `structuredClone` | `@kumiai/mls`, 3 sites |
| `String.prototype.isWellFormed` | `@kumiai/broadcast`, `@kumiai/rpc` |
| `AbortSignal.prototype.throwIfAborted` | `@kumiai/rpc`, 2 sites |

The packages share no utility package, so each owns its helper. The existing guard (`packages/mls-rpc/test/runtime-neutral.test.ts`) widens to the whole closure and to the newly banned APIs. The smoke test (`packages/mls-rpc/test/runtime-baseline.test.ts`) removes those APIs too and drives real-MLS paths that reach the replaced sites.

**Tech Stack:** TypeScript, Vitest, pnpm/turbo.

**Spec:**
- Spec P r18 D8 Reentrancy: "Core logic is runtime-neutral (Node, browsers, Hermes)."
- The runtime baseline in plan 2.1c's Global Constraints: `docs/superpowers/plans/2026-10-10-spec-p-2-1c-runtime-neutral-ownership.md`.
- Starting point: branch `feat/spec-p-phase-2` at `ba1f43c`.

## Global Constraints

- **Baseline:** plan 2.1c's runtime baseline, unchanged, with additions:
  - ES2022 plus the listed host APIs.
  - Supported hosts: Node ≥ 20; evergreen browsers in a secure context; Hermes with a Web Crypto and `TextEncoder` polyfill.
- **Additions to the forbidden list:**
  - `String.prototype.isWellFormed`, `String.prototype.toWellFormed`
  - `AbortSignal.prototype.throwIfAborted`
  - `Symbol.dispose`, `Symbol.asyncDispose`, and `using` / `await using` declarations
- **Guard scope:** the `src` directories of the `@kumiai/mls-rpc` runtime closure plus the conformance package:
  - `packages/mls-rpc`, `packages/mls`, `packages/rpc`, `packages/broadcast`
  - `packages/hub-client`, `packages/hub-protocol`, `packages/hub-tunnel`, `packages/mls-hub`
  - `packages/rpc-conformance`
- **Out of scope:** cross-repo dependencies in other repos.
  - Unguarded `AbortSignal.any` in `@sozai/event` and `@enkaku/client`.
  - `Symbol.dispose`/`Symbol.asyncDispose` keys in `@sozai/async` and `@enkaku/transport`.

  The final report lists them for the user.
- **Helpers stay private.** Each helper is package-internal and not re-exported from any `index.ts`; the public API stays unchanged.
- **Changeset:** extend the `.changeset/spec-p-storage-foundation.md` summary by one sentence; add no new intent. `@kumiai/mls`, `@kumiai/broadcast` and `@kumiai/rpc` are already listed.
- **Commits:** every commit passes `rtk proxy pnpm turbo run build:js build:types test:types`.

## Review Focus

- **Lone surrogates.** A lone high surrogate at the end of a string, a lone low surrogate at the start, and a reversed pair are all rejected exactly as native `isWellFormed` rejects them. Pinned in Task 2.
- **Abort without a reason.** An aborted signal whose `reason` is `undefined` (older polyfills) still throws, as an `Error` named `AbortError`. Pinned in Task 2.
- **Subarray clones.** A `Uint8Array` subarray (non-zero `byteOffset`) clones to equal, independent bytes. Pinned in Task 1.
- **`bigint` fields.** `bigint` lifetime fields in a leaf node survive the clone. Pinned in Task 1.
- **Zeroing the original.** Zeroing the original secret tree after `carryReceiveProgress` leaves the carried candidate's retained secrets intact. Pinned in Task 1.

---

### Task 1: `@kumiai/mls` data clone

**Files:**
- Create: `packages/mls/src/clone.ts`, `packages/mls/test/clone.test.ts`
- Modify: `packages/mls/src/group-lifecycle.ts:173`, `packages/mls/src/group-handle.ts:929,939`

**Interfaces:**
- Produces `cloneData<T>(value: T): T` in `packages/mls/src/clone.ts`; it is not exported from the package index.
  - Primitives, including `bigint` and `undefined`, are returned as-is.
  - A `Uint8Array` becomes a fresh `Uint8Array` with its own `ArrayBuffer`, holding only the view's bytes.
  - Arrays and plain objects (prototype `Object.prototype` or `null`) are copied recursively.
  - Anything else throws `TypeError('cloneData: unsupported value')`. That includes `Map`, `Set`, `Date`, class instances, functions and other typed arrays.

- [ ] **Step 1: Tests** in `clone.test.ts`:
  - **Equivalence:** compare `cloneData` against `structuredClone` with `expect(cloneData(x)).toEqual(structuredClone(x))` for:
    - a real `ClientState.secretTree` from a two-member group, built with the package's existing test helpers;
    - a real own leaf node (`ratchetTree[leafIndex*2]`), including its `bigint` lifetime;
    - a subarray `new Uint8Array(buf, 3, 5)`.
  - **Independence:** after `clone.leafNodes[0].application.secret.fill(0)` the original is unchanged, and the same holds for a subarray clone.
  - **Unsupported values:** `new Map()`, `new Date()` and `new (class X {})()` throw `TypeError`.
  - **Regression:** `carryReceiveProgress`, which already has tests, still passes. Also, zeroing the live handle's `secretTree` buffers after the carry leaves the candidate's historical secret unchanged.
- [ ] **Step 2: Run red, implement, replace the three `structuredClone` calls, run green.** Use `rtk proxy pnpm --filter @kumiai/mls run test`. Mutation-check by making `cloneData` return a `Uint8Array` input as-is: the independence case must fail.
- [ ] **Step 3: Commit** `fix(mls): clone MLS state without structuredClone`.

### Task 2: `@kumiai/broadcast` and `@kumiai/rpc` string and abort helpers

**Files:**
- Create:
  - `packages/broadcast/src/well-formed.ts`
  - `packages/rpc/src/well-formed.ts`
  - `packages/rpc/src/abort.ts`
  - matching tests `packages/broadcast/test/well-formed.test.ts`, `packages/rpc/test/well-formed.test.ts`, `packages/rpc/test/abort.test.ts`
- Modify:
  - `packages/broadcast/src/topic.ts:21`
  - `packages/rpc/src/topic.ts:96`
  - `packages/rpc/src/control/store.ts:123,128`

**Interfaces:**
- **`isWellFormedUTF16(value: string): boolean`**, in each package's `well-formed.ts`. Returns true when every high surrogate (`0xD800–0xDBFF`) is immediately followed by a low surrogate (`0xDC00–0xDFFF`), and every low surrogate is preceded by a high one.
- **`throwIfAborted(signal: AbortSignal | undefined): void`**, in `rpc/src/abort.ts`.
  - If the signal is aborted and `signal.reason !== undefined`, it throws `signal.reason`, the same instance.
  - If the signal is aborted and has no reason, it throws `Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })`.
  - Otherwise it returns.

- [ ] **Step 1: Tests:**
  - `isWellFormedUTF16` cases: `''`, `'abc'`, `'😀'` (true); `'\uD83D'`, `'a\uD83D'`, `'\uDE00a'`, `'\uDE00\uD83D'` (false).
  - Native equivalence: a property case over 2000 strings built from code units drawn from `[0x41, 0xD800, 0xDBFF, 0xDC00, 0xDFFF, 0xFFFF]` (lengths 0–6, fixed seed) agrees with `String.prototype.isWellFormed`. It runs only when the native method exists.
  - Behaviour kept: `deriveTopicID`/`discoveryTopic` still reject a lone surrogate with the existing messages.
  - `throwIfAborted` cases:
    - not aborted: returns;
    - aborted with reason `r`: throws that same `r`;
    - aborted with a reason-less signal: throws `AbortError`. Simulate it with an object `{ aborted: true, reason: undefined } as AbortSignal`.
  - The control-store retry loop still rejects with the caller's reason.
- [ ] **Step 2: Run red, implement, replace the call sites, run green.** Use `rtk proxy pnpm --filter @kumiai/broadcast run test` and `rtk proxy pnpm --filter @kumiai/rpc run test`. Mutation-check by dropping the low-surrogate-preceded check: the `'\uDE00a'` case must fail.
- [ ] **Step 3: Commit** `fix(rpc,broadcast): replace isWellFormed and throwIfAborted with baseline helpers`.

### Task 3: Widen guard and smoke, changeset, gate

**Files:**
- Modify:
  - `packages/mls-rpc/test/runtime-neutral.test.ts`
  - `packages/mls-rpc/test/runtime-baseline.test.ts`
  - `.changeset/spec-p-storage-foundation.md`

**Interfaces:**
- **Consumes:** Tasks 1 and 2 (no non-baseline uses left in scope).
- **Guard:**
  - `sourceRoots` covers the Guard scope list.
  - The forbidden set adds `isWellFormed`, `toWellFormed`, `throwIfAborted`, `Symbol.dispose`, `Symbol.asyncDispose` and `using` declarations.
  - Close the 2.1c gaps: computed access (`Promise['withResolvers']`, `globalThis['structuredClone']`), destructured statics (`const { withResolvers } = Promise`), and `export … from 'node:…'`.
  - Allow `typeof` guards in `if` and ternary conditions, not only in `&&`.
  - Do not flag locally declared or shadowed bindings.
- **Smoke test:**
  - Also delete `String.prototype.isWellFormed`, `String.prototype.toWellFormed` and `AbortSignal.prototype.throwIfAborted`, restoring them in `afterAll`.
  - Add real-MLS paths: a two-member group transition that reaches `carryReceiveProgress`, `deriveTopicID` with a lone-surrogate rejection, and a control-store apply with an aborted signal that rejects with its reason.
  - Each path runs as its own `test`.

- [ ] **Step 1: Write the guard and smoke changes.** Check them red: temporarily restore one `structuredClone` call in `group-handle.ts` and one `isWellFormed` call (the guard and smoke must both fail), then restore. Mutation-check each new guard rule with a temporary fixture string inside the test, not in `src`.
- [ ] **Step 2: Changeset.** Append to the existing summary: "MLS, broadcast and rpc runtime code no longer needs structuredClone, String.isWellFormed or AbortSignal.throwIfAborted."
- [ ] **Step 3: Gate.** Each must pass:
  - `rtk proxy pnpm turbo run build:js build:types`
  - `rtk proxy pnpm turbo run test:types`
  - `rtk proxy pnpm --filter @kumiai/mls run test`
  - `rtk proxy pnpm --filter @kumiai/broadcast run test`
  - `rtk proxy pnpm --filter @kumiai/rpc run test`
  - `rtk proxy pnpm --filter @kumiai/mls-rpc run test`
  - `rtk proxy pnpm run lint`
  - `rtk proxy pnpm run check:versions`

  The controller also runs the forced `pnpm exec turbo run test:types test:unit --force --continue` and `pnpm exec vitest run --root tests/integration`.
- [ ] **Step 4: Commit** `test(mls-rpc): enforce the runtime baseline across the mls-rpc runtime closure`.
