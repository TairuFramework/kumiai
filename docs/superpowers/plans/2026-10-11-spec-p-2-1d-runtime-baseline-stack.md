# Spec P 2.1d Runtime Baseline Across the Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every kumiai package that `@kumiai/mls-rpc` loads at runtime meets a declared runtime baseline: ES2022 built-ins plus an explicit host whitelist. A type-level and name-level guard enforces it, and a capability smoke test proves it.

**Architecture:** Three APIs that can be replaced remain in that closure. Each gets a small package-local helper, with tests that pin it to the native behaviour:
- `structuredClone` in `@kumiai/mls` (3 sites)
- `String.prototype.isWellFormed` in `@kumiai/broadcast` and `@kumiai/rpc`
- `AbortSignal.prototype.throwIfAborted` in `@kumiai/rpc` (2 sites)

Web Streams and the interval/timeout timers are not replaced, because the enkaku transport layer is built on streams. They join the host whitelist; Hermes provides Web Streams natively, confirmed by the user on 2026-10-11.

The guard has two layers:
- **Type layer:** a type-check of the in-scope sources against `lib: ["es2022", "dom"]` rejects ES2023+ built-ins by symbol, such as `toSorted` and `findLast`.
- **Name layer:** forbids the non-whitelisted host APIs that the `dom` lib would otherwise admit, such as `structuredClone` and `AbortSignal.any`.

**Tech Stack:** TypeScript (compiler API in tests), Vitest, pnpm/turbo.

**Spec:**
- Spec P r18 D8 Reentrancy: "Core logic is runtime-neutral (Node, browsers, Hermes)."
- The runtime baseline in plan 2.1c Global Constraints (`docs/superpowers/plans/2026-10-10-spec-p-2-1c-runtime-neutral-ownership.md`), amended here.
- Starting point: branch `feat/spec-p-phase-2` at `ba1f43c`. Plan review: `.superpowers/sdd/2026-10-11-spec-p-2-1d-runtime-baseline-stack/plan-review.md`.

## Global Constraints

- **Built-ins: ES2022.** No ES2023+ built-in may be used unless it is listed as an optional capability.
- **Host whitelist.** This amends 2.1c by adding Web Streams and the interval/timeout timers.
  - `WeakMap`, `WeakSet`
  - `AbortController`/`AbortSignal`: constructor, `abort`, `aborted`, `reason`, `addEventListener`, `removeEventListener`
  - `queueMicrotask`, `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`
  - `TextEncoder`, `TextDecoder`
  - Web Crypto: `crypto.getRandomValues`, `crypto.subtle`, `crypto.randomUUID`
  - Web Streams: `ReadableStream`, `WritableStream`, `CountQueuingStrategy`
- **Supported hosts:**
  - Node ≥ 20.
  - Evergreen browsers in a secure context.
  - Hermes with polyfills for Web Crypto and `TextEncoder`/`TextDecoder`. Hermes provides Web Streams natively.
  - Syntax lowering is the host bundler's job; this baseline covers runtime built-ins and host APIs only.
- **Optional capabilities.** These may be referenced only behind a `typeof X` presence test (`!== 'undefined'`), or in the branch an absence test (`=== 'undefined'`) leaves for the present case. The test may be a condition of `&&`, `||`, `if` or a ternary. The code must be correct when they are absent:
  - `Float16Array`
  - `SharedArrayBuffer`
  - `Atomics`
- **Forbidden:**
  - `node:` imports
  - `AsyncLocalStorage`
  - `structuredClone`
  - `Promise.withResolvers`
  - `AbortSignal.any`, `AbortSignal.timeout`, `AbortSignal.prototype.throwIfAborted`
  - `String.prototype.isWellFormed`, `String.prototype.toWellFormed`
  - `setImmediate`, `process`, `Buffer`
  - `Symbol.dispose`, `Symbol.asyncDispose`, `using` / `await using`
  - any other host global not on the whitelist
- **Guard scope:** the `src` directories of these packages:
  - `packages/mls-rpc`, `packages/mls`, `packages/rpc`, `packages/broadcast`
  - `packages/hub-client`, `packages/hub-protocol`, `packages/hub-tunnel`, `packages/mls-hub`
  - `packages/rpc-conformance`
- **Out of scope:** dependencies from other repos. Unguarded `AbortSignal.any` in `@sozai/event` and `@enkaku/client`, and `Symbol.dispose` keys in `@sozai/async` and `@enkaku/transport`, are listed in the final report for the user.
- **Helpers stay internal.** No package `index.ts` re-exports a helper; the public API is unchanged.
- **Changeset.** Extend the summary in `.changeset/spec-p-storage-foundation.md`; no new intent.
- **Every commit compiles.** Each commit passes `rtk proxy pnpm turbo run build:js build:types test:types`.

## Review Focus

- **Lone surrogates:** a lone high surrogate at the end, a lone low surrogate at the start, and a reversed pair are rejected exactly as native `isWellFormed` rejects them. Pinned in Task 2.
- **Abort without a reason:** an aborted signal whose `reason` is `undefined` (older polyfills) still throws, as an `Error` named `AbortError`. Pinned in Task 2.
- **Subarray clone:** a `Uint8Array` subarray with a non-zero `byteOffset` clones to equal, independent bytes. Pinned in Task 1.
- **`bigint` lifetime:** a joined member's key-package leaf keeps its `bigint` lifetime through the clone. Pinned in Task 1.
- **Both history-copy branches independent:** zeroing live secrets for the current epoch AND for an earlier retained epoch after `carryReceiveProgress` leaves the candidate's bytes unchanged. Pinned in Task 1.

---

### Task 1: `@kumiai/mls` data clone

**Files:**
- Create: `packages/mls/src/clone.ts`, `packages/mls/test/clone.test.ts`
- Modify:
  - `packages/mls/src/group-lifecycle.ts:173`
  - `packages/mls/src/group-handle.ts:929,939`
  - the existing `carryReceiveProgress` test file, if its local `fixture()` must move to a module under `packages/mls/test/fixtures/` to be shared

**Interfaces:**
- **Produces** `cloneData<T>(value: T): T` in `packages/mls/src/clone.ts`; it is not exported from the package index.
  - Primitives, including `bigint` and `undefined`, are returned as they are.
  - A `Uint8Array` becomes a fresh `Uint8Array` with its own `ArrayBuffer`, holding only the bytes of the view.
  - Arrays and plain objects (prototype `Object.prototype` or `null`) are copied recursively.
  - Anything else throws `TypeError('cloneData: unsupported value')`. That includes `Map`, `Set`, `Date`, class instances, functions and other typed arrays.

- [ ] **Step 1: Tests** in `clone.test.ts`. Use the existing helpers: `joinBoundDevice` (`packages/mls/test/fixtures/device-harness.ts:68`), or `lifecycleGroup` plus `addMember` (`packages/mls/test/fixtures/lifecycle-ledger.ts:89`).
  - **Secret tree:** in a two-member group, encrypt one application message first, so the sender's leaf secrets are expanded. Select `secretTree.leafNodes[state.privatePath.leafIndex * 2]`: ts-mls keys `leafNodes` by node index. Assert the entry exists, narrowing each access.
    - `expect(cloneData(tree)).toEqual(structuredClone(tree))`.
    - Zeroing the clone's selected `application.secret` leaves the original unchanged.
  - **Leaf node:** take the joined member's own node, `ratchetTree[privatePath.leafIndex * 2]`, narrowed to `nodeType === leaf`.
    - Assert `leaf.leafNodeSource === 'key_package'` (use the ts-mls discriminant actually present) and that `lifetime.notAfter` is a `bigint`.
    - `cloneData` equals `structuredClone`, and the `bigint` is preserved.
  - **Subarray:** `new Uint8Array(new ArrayBuffer(16), 3, 5)` clones to equal bytes with `byteOffset === 0` and an independent buffer.
  - **Unsupported values:** `new Map()`, `new Date()` and `new (class X {})()` throw `TypeError`.
  - **History independence:** build a group with one earlier retained epoch, so both copy branches in `group-handle.ts` (the current epoch at `:929`, earlier history at `:939`) run, then run `carryReceiveProgress`.
    - Snapshot the candidate's secret bytes for both epochs.
    - Zero the corresponding live buffers, in `secretTree` and in `historicalReceiverData.get(earlier).secretTree`.
    - Assert the candidate's bytes are unchanged.
  - **Renewal:** `renewLeaf` (`group-lifecycle.ts`) still produces a valid renewed leaf, and the original tree node is not mutated.
- [ ] **Step 2: Run red, implement, replace the three calls, run green:** `rtk proxy pnpm --filter @kumiai/mls run test`. Then mutation-check each site separately:
  - `cloneData` returns a `Uint8Array` input as-is: the subarray and secret-tree independence cases fail.
  - Substitute `receiver.secretTree` directly at `:939`: the earlier-epoch independence case fails.
  - Substitute `this.#state.secretTree` at `:929`: the current-epoch case fails.
- [ ] **Step 3: Commit** `fix(mls): clone MLS state without structuredClone`.

### Task 2: `@kumiai/broadcast` and `@kumiai/rpc` string and abort helpers

**Files:**
- Create:
  - `packages/broadcast/src/well-formed.ts`, `packages/broadcast/test/well-formed.test.ts`
  - `packages/rpc/src/well-formed.ts`, `packages/rpc/test/well-formed.test.ts`
  - `packages/rpc/src/abort.ts`, `packages/rpc/test/abort.test.ts`
- Modify:
  - `packages/broadcast/src/topic.ts:21`
  - `packages/rpc/src/topic.ts:96`
  - `packages/rpc/src/control/store.ts:123,128`
  - `packages/rpc/test/control-store.test.ts`

**Interfaces:**
- **`isWellFormedUTF16(value: string): boolean`**, in each package's `well-formed.ts`. True when every high surrogate (`0xD800–0xDBFF`) is immediately followed by a low surrogate (`0xDC00–0xDFFF`), and every low surrogate is preceded by a high one.
- **`throwIfAborted(signal: AbortSignal | undefined): void`**, in `rpc/src/abort.ts`.
  - When the signal is aborted and `signal.reason !== undefined`, it throws that same `signal.reason` instance.
  - When the signal is aborted and `reason` is `undefined`, it throws `Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })`.
  - Otherwise it returns.

- [ ] **Step 1: Write the tests.**
  - **`isWellFormedUTF16` fixed cases:** true for `''`, `'abc'`, `'😀'`; false for `'\uD83D'`, `'a\uD83D'`, `'\uDE00a'`, `'\uDE00\uD83D'`.
  - **`isWellFormedUTF16` property case:** agrees with native `String.prototype.isWellFormed`, and runs only when the native method exists.
    - Input: 2000 strings with lengths 0 to 6.
    - Alphabet: code units `[0x41, 0xD800, 0xDBFF, 0xDC00, 0xDFFF, 0xFFFF]`.
    - Use a fixed-seed linear congruential generator.
  - **Topic messages unchanged:** `deriveTopicID` (broadcast) and `discoveryTopic` (rpc) still reject a lone surrogate, with exactly their existing messages.
  - **`throwIfAborted`:**
    - not aborted: returns;
    - aborted with a reason `r`: throws that same `r`;
    - aborted with no reason: throws `AbortError`. Simulate it as `{ aborted: true, reason: undefined } as AbortSignal`.
  - **`control-store.test.ts`, via `applyResolved` where `apply` throws `StorageOutcomeUnknownError`:**
    - With a signal already aborted with reason `r`, it rejects with the identical `r`.
    - When the signal aborts during the read-back (`lastMutation` pending), it rejects with the identical reason.
- [ ] **Step 2: Run red, implement, replace the call sites, run green:** `rtk proxy pnpm --filter @kumiai/broadcast run test` and `rtk proxy pnpm --filter @kumiai/rpc run test`. Mutation-checks:
  - Dropping the check that a low surrogate is preceded by a high one makes the `'\uDE00a'` case fail.
  - Replacing `throwIfAborted` with a no-op makes the already-aborted `applyResolved` case fail.
- [ ] **Step 3: Commit** `fix(rpc,broadcast): replace isWellFormed and throwIfAborted with baseline helpers`.

### Task 3: Baseline guard, capability smoke, changeset, gate

**Files:**
- Create: `packages/mls-rpc/test/fixtures/runtime-optional.d.ts`, which declares only `Float16Array`, the optional capability missing from `lib.es2022`. `SharedArrayBuffer` and `Atomics` keep their standard declarations; the name layer enforces their guards.
- Modify:
  - `packages/mls-rpc/test/runtime-neutral.test.ts`
  - `packages/mls-rpc/test/runtime-baseline.test.ts`
  - `.changeset/spec-p-storage-foundation.md`

**Interfaces:**
- **Consumes:** Tasks 1 and 2 (no forbidden use remains in scope).
- **Type layer:** for each source root in scope, a `ts.createProgram` over its `src/**/*.ts`.
  - Compiler options: the package `tsconfig.json`, with `lib` overridden to `["lib.es2022.d.ts", "lib.dom.d.ts"]` and `types: []`, plus `runtime-optional.d.ts`, `skipLibCheck: true` and `noEmit`.
  - Expect zero semantic diagnostics in files under that `src`.
  - Report each diagnostic as `file:line message`.
- **Name layer (AST):**
  - Forbids the Forbidden list, plus any runtime value reference to a top-level `lib.dom.d.ts` global (a `declare var` or `declare function`) that is not on the host whitelist. References in type positions are erased and allowed, such as an annotation of `ReadableStreamDefaultController`.
  - Resolution is symbol-aware: use the program's type checker to resolve each identifier and property access. A local or shadowed binding never fires.
  - Covers computed access (`Promise['withResolvers']`, `globalThis['structuredClone']`), destructured statics (`const { withResolvers } = Promise`), `export … from 'node:…'`, dynamic `import('node:…')` and `require('node:…')`.
  - Optional capabilities are allowed only under the presence or absence `typeof` tests defined in Global Constraints.
- **Fixtures:** a `describe('guard fixtures')` block runs both layers over in-memory source strings. It covers:
  - **Negative:** each forbidden form; `new ReadableStreamDefaultController()`, a non-whitelisted DOM value; `Float16Array` used without a guard; ES2023 `toSorted`, caught by the type layer.
  - **Positive:** a whitelisted host API; a `ReadableStreamDefaultController` type annotation; guarded optional capabilities in both presence form and the absence-ternary form used in `memory-transaction.ts:138`; a shadowed local named `structuredClone`; ES2022 `Array.prototype.at`.
- **Smoke test:**
  - Also delete `String.prototype.isWellFormed`, `String.prototype.toWellFormed`, `AbortSignal.prototype.throwIfAborted` and `Float16Array`, restoring all of them in `afterAll`.
  - Each path is its own `test`, uses real MLS, and asserts the specific domain result or error message:
    1. `renewLeaf` on a bound device.
    2. A two-member group with an earlier retained epoch runs `carryReceiveProgress`.
    3. `deriveTopicID` rejects a lone surrogate with its exact message.
    4. `discoveryTopic` rejects a lone surrogate with its exact message.
    5. `applyResolved` with `StorageOutcomeUnknownError` and an already-aborted signal rejects with the identical reason.
  - Keep the existing persistence paths.
  - If the imports resolve through package `lib` exports, `rtk proxy pnpm turbo run build:js build:types` runs before the smoke test, and each mutation check below rebuilds.

- [ ] **Step 1: Write the guard and smoke changes.** Run them green.
- [ ] **Step 2: Mutation-check.**
  - Restore one `structuredClone` in `group-handle.ts`; the guard and smoke test must both fail. Restore.
  - Restore one `isWellFormed` in `rpc/src/topic.ts`; both must fail. Restore.
  - Add a temporary `[].toSorted()` in `rpc/src`; the type layer must fail. Remove it.
  - Rebuild after each change.
- [ ] **Step 3: Changeset.** Append to the existing summary: "MLS, broadcast and rpc runtime code no longer needs structuredClone, String.isWellFormed or AbortSignal.throwIfAborted; Hermes hosts need Web Crypto and TextEncoder polyfills."
- [ ] **Step 4: Gate.** Each must pass:
  - `rtk proxy pnpm turbo run build:js build:types`
  - `rtk proxy pnpm turbo run test:types`
  - `rtk proxy pnpm --filter @kumiai/mls run test`
  - `rtk proxy pnpm --filter @kumiai/broadcast run test`
  - `rtk proxy pnpm --filter @kumiai/rpc run test`
  - `rtk proxy pnpm --filter @kumiai/mls-rpc run test`
  - `rtk proxy pnpm run lint`
  - `rtk proxy pnpm run check:versions`

  The controller also runs a forced `pnpm exec turbo run test:types test:unit --force --continue` and `pnpm exec vitest run --root tests/integration`.
- [ ] **Step 5: Commit** `test(mls-rpc): enforce the runtime baseline across the mls-rpc runtime closure`.
