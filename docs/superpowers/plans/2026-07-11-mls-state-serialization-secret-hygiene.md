# GroupHandle State Serialization + Secret Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize every async operation that mutates a `GroupHandle`'s `#state`, zero retired secrets, and consolidate the receive path — closing a forward-secrecy race and three correctness/API defects in `packages/mls/src/group.ts`.

**Architecture:** A per-handle FIFO `Mutex` (a standalone internal module, shaped for later extraction to `@sozai/async`) held in a module-private `WeakMap<GroupHandle, Mutex>`. Every async op that reads-or-writes `#state` runs its whole body through the handle's mutex; synchronous getters are untouched. Retired `consumed` buffers from ts-mls are zeroed after each op. `encrypt` returns framed wire bytes and `decrypt` is removed in favor of `processMessage` as the single receive path.

**Tech Stack:** TypeScript, `ts-mls@2.0.0-rc.13`, vitest, biome, pnpm.

## Global Constraints

- pnpm only. `type` not `interface`. `Array<T>` not `T[]`. Never `any`. Capital `ID`/`DID`/`HTTP`/`JWT`. ES `#fields`, never `private`/`readonly`. Do not edit generated `lib/`.
- **No plan/question/phase labels in code, comments, or test names** — state the invariant directly, never `// Task 2` or `// state race`.
- The `rtk` shim fakes both `pnpm run lint` and `pnpm exec biome`. For real biome output use `rtk proxy pnpm run lint` (runs `biome check --write ./packages ./tests`). Lint BEFORE `git add` to avoid the pre-commit hook reformatting after staging.
- Verify commands (exact forms — the shim intercepts the plain ones):
  - `pnpm --filter @kumiai/mls exec vitest run`
  - `pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
- Commit trailers on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WnnpGWMrYcgHpYuDhmJKk3
  ```
- Baseline before starting: `pnpm --filter @kumiai/mls exec vitest run` reports **248 passed**.

---

## File Structure

- `packages/mls/src/mutex.ts` — **new.** The generic FIFO async serializer (`createMutex`, `Mutex` type). Not re-exported from `index.ts` — internal to the package. Extraction target for `@sozai/async`.
- `packages/mls/test/mutex.test.ts` — **new.** Unit tests for the serializer in isolation.
- `packages/mls/src/group.ts` — **modify.** Add the `WeakMap<GroupHandle, Mutex>` glue; wrap `encrypt`, `processMessage`, `commitInvite`, `removeMember`, `commitLedgerEntries` bodies in the mutex; zero `consumed`; reshape `encrypt`; delete `decrypt`.
- `packages/mls/test/group.test.ts` — **modify.** Migrate `encrypt`/`decrypt` call sites; add concurrency, consumed-zeroing, and receive-consolidation tests.
- `packages/mls/test/external-rejoin.test.ts` — **modify.** Migrate `encrypt`/`decrypt` call sites.

---

## Task 1: The `Mutex` serializer module

**Files:**
- Create: `packages/mls/src/mutex.ts`
- Test: `packages/mls/test/mutex.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Mutex = { run: <T>(fn: () => Promise<T>) => Promise<T> }` and `createMutex(): Mutex`. `run` executes `fn`s one at a time in call order (FIFO); a rejected `fn` surfaces its rejection to its own caller but does not stall or poison the queue for later `fn`s.

- [ ] **Step 1: Write the failing tests**

Create `packages/mls/test/mutex.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import { createMutex } from '../src/mutex.js'

describe('createMutex', () => {
  test('runs queued operations one at a time in call order', async () => {
    const mutex = createMutex()
    const log: Array<string> = []
    const op = (id: string, ms: number) =>
      mutex.run(async () => {
        log.push(`start-${id}`)
        await new Promise((r) => setTimeout(r, ms))
        log.push(`end-${id}`)
      })
    // b is enqueued after a but asked to finish sooner; FIFO must still order them.
    await Promise.all([op('a', 20), op('b', 1)])
    expect(log).toEqual(['start-a', 'end-a', 'start-b', 'end-b'])
  })

  test('returns each operation its own result', async () => {
    const mutex = createMutex()
    const [a, b] = await Promise.all([
      mutex.run(async () => 1),
      mutex.run(async () => 2),
    ])
    expect([a, b]).toEqual([1, 2])
  })

  test('a rejecting operation surfaces to its caller and does not poison the queue', async () => {
    const mutex = createMutex()
    const boom = mutex.run(async () => {
      throw new Error('boom')
    })
    const after = mutex.run(async () => 'ok')
    await expect(boom).rejects.toThrow('boom')
    await expect(after).resolves.toBe('ok')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @kumiai/mls exec vitest run test/mutex.test.ts`
Expected: FAIL — `Cannot find module '../src/mutex.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/mls/src/mutex.ts`:

```ts
/**
 * A FIFO async serializer: `run` executes its callbacks one at a time, in the
 * order they were called. A callback's rejection is delivered to its own caller
 * but never stalls or poisons the queue for later callbacks — the chain always
 * advances. Order is not reprioritized: callers rely on it to preserve causal
 * order (e.g. the epoch at which an MLS message is produced).
 *
 * Deliberately dependency-free and generic, so it can move to `@sozai/async`
 * unchanged; this package's only per-instance glue is a WeakMap keyed by handle.
 */
export type Mutex = {
  run: <T>(fn: () => Promise<T>) => Promise<T>
}

export function createMutex(): Mutex {
  let chain: Promise<unknown> = Promise.resolve()
  const noop = (): void => {}
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = chain.then(fn, fn)
      chain = result.then(noop, noop)
      return result
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @kumiai/mls exec vitest run test/mutex.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint, type-check, commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
rtk proxy pnpm run lint
pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
git add packages/mls/src/mutex.ts packages/mls/test/mutex.test.ts
git commit
```
Commit message:
```
feat(mls): a FIFO async serializer

A dependency-free per-instance mutex whose run() executes callbacks one at a
time in call order, isolating a callback's rejection from the queue. Not
exported from the package root; it is the internal primitive that will serialize
GroupHandle state mutations, shaped for later extraction to @sozai/async.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WnnpGWMrYcgHpYuDhmJKk3
```

---

## Task 2: Serialize every `#state` op through the mutex; zero `consumed`

**Files:**
- Modify: `packages/mls/src/group.ts`
- Test: `packages/mls/test/group.test.ts`

**Interfaces:**
- Consumes: `createMutex`, `Mutex` from `./mutex.js`.
- Produces: no signature changes in this task. `encrypt` still returns `{ message: unknown; consumed: Array<Uint8Array> }` (its `consumed` are now zeroed). `commitInvite`/`removeMember`/`commitLedgerEntries`/`processMessage` unchanged in shape. After this task, all five ops run serialized per handle and wipe retired secrets.

- [ ] **Step 1: Add the mutex glue and the `zeroAll` helper**

In `packages/mls/src/group.ts`, add to the import block:
```ts
import { createMutex, type Mutex } from './mutex.js'
```

Add near the top of the module body (module scope, not exported):
```ts
/** One serializer per live handle, so its state-mutating operations run one at a
 *  time in issue order. Keyed weakly: the entry is collected with the handle, and
 *  the handle carries no reference back to it. */
const MUTEXES = new WeakMap<GroupHandle, Mutex>()

function mutexFor(handle: GroupHandle): Mutex {
  let mutex = MUTEXES.get(handle)
  if (mutex === undefined) {
    mutex = createMutex()
    MUTEXES.set(handle, mutex)
  }
  return mutex
}

/** Overwrite retired secret buffers ts-mls hands back as `consumed`, so key
 *  material does not linger in the heap after the state that used it is replaced. */
function zeroAll(buffers: Array<Uint8Array>): void {
  for (const buffer of buffers) buffer.fill(0)
}
```

- [ ] **Step 2: Write the failing tests**

Add to `packages/mls/test/group.test.ts` (a new `describe`; uses the existing `twoMemberGroup` helper):

```ts
describe('a handle serializes its state mutations', () => {
  test('concurrent encrypts each get a distinct generation and all decrypt on the peer', async () => {
    const { aliceGroup, bobGroup } = await twoMemberGroup()
    const enc = new TextEncoder()

    // Fired together, without awaiting between them: the pre-serialization code
    // lets both read the same #state and clobber one advance, reusing a
    // secret-tree generation so one ciphertext fails to decrypt on the peer.
    const [m1, m2] = await Promise.all([
      aliceGroup.encrypt(enc.encode('one')),
      aliceGroup.encrypt(enc.encode('two')),
    ])

    const d = new TextDecoder()
    const got = new Set<string>()
    for (const { message } of [m1, m2]) {
      got.add(d.decode(await bobGroup.decrypt(message)))
    }
    expect(got).toEqual(new Set(['one', 'two']))
  })

  test('encrypt wipes the retired secrets it consumed', async () => {
    const { aliceGroup } = await twoMemberGroup()
    const { consumed } = await aliceGroup.encrypt(new TextEncoder().encode('x'))
    expect(consumed.length).toBeGreaterThan(0)
    for (const buffer of consumed) {
      expect(buffer.every((byte) => byte === 0)).toBe(true)
    }
  })
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @kumiai/mls exec vitest run test/group.test.ts -t "serializes its state mutations"`
Expected: FAIL — the concurrent-encrypt case fails to decrypt one message (or throws), and the zeroing case sees non-zero bytes.

- [ ] **Step 4: Wrap `encrypt` in the mutex and zero its `consumed`**

Replace the current `encrypt` method body (keep the signature exactly as-is this task):
```ts
  async encrypt(plaintext: Uint8Array): Promise<{ message: unknown; consumed: Array<Uint8Array> }> {
    return mutexFor(this).run(async () => {
      const { newState, message, consumed } = await createApplicationMessage({
        context: this.#context,
        state: this.#state,
        message: plaintext,
      })
      this.#state = newState
      zeroAll(consumed)
      return { message, consumed }
    })
  }
```

- [ ] **Step 5: Wrap `processMessage` in the mutex and zero its `consumed`**

In `processMessage`, wrap the body from the `#prepareCommitPipeline` call through the final return inside `return mutexFor(this).run(async () => { … })`, and zero the ts-mls `consumed`. The result-handling stays identical; only the wrapper and the `zeroAll` line are added:
```ts
  async processMessage(
    message: Uint8Array | unknown,
    opts?: { commitPolicy?: IncomingMessageCallback },
  ): Promise<Uint8Array | null> {
    let decoded: unknown = message
    if (message instanceof Uint8Array) {
      const parsed = decode(mlsMessageDecoder, message)
      if (parsed == null) {
        throw new Error('processMessage: failed to decode MLSMessage')
      }
      decoded = parsed
    }
    return mutexFor(this).run(async () => {
      const { callback, capture, applyOnAccept } = await this.#prepareCommitPipeline(decoded, opts)
      const result = await mlsProcessMessage({
        context: this.#context,
        state: this.#state,
        message: decoded as Parameters<typeof mlsProcessMessage>[0]['message'],
        ...(callback != null && { callback }),
      })
      this.#state = result.newState
      zeroAll(result.consumed)
      if (result.kind === 'newState' && result.actionTaken === 'reject') {
        throw new CommitRejectedError(
          capture.rejected?.proposals ?? [],
          capture.rejected?.senderLeafIndex,
        )
      }
      if (result.kind === 'applicationMessage') {
        return result.message
      }
      applyOnAccept()
      return null
    })
  }
```
Note: the message decode stays *outside* the mutex (it touches no `#state`); only the state read/await/write is serialized.

- [ ] **Step 6: Wrap `decrypt` in the mutex and zero its `consumed`** (interim — `decrypt` is removed in Task 3)

Apply the same treatment to `decrypt`'s body: wrap from `#prepareCommitPipeline` through the throws/returns in `return mutexFor(this).run(async () => { … })`, and add `zeroAll(result.consumed)` right after `this.#state = result.newState`. Leave its behavior otherwise unchanged.

- [ ] **Step 7: Do NOT zero `consumed` on the commit-producer path**

Leave `commitWithEntries` unchanged — do **not** add `zeroAll(commit.consumed)` here. Unlike `encrypt`/`processMessage`/`decrypt`, the commit producers do not advance the source handle's `#state`: `commitWithEntries` reads `group.state`, and its caller builds a *derived* handle via `deriveGroup(group, result.newState)` while the source `group` stays live at its epoch and is reusable (the suite authors two alternate commits off one base handle — a to-be-rejected `bare` commit and the accepted `removal`). ts-mls's `createCommit` `consumed` buffers alias into the *still-live* source secret tree, not into retired state, so zeroing them corrupts the source handle and the next commit off it fails with `aes/gcm: invalid ghash tag`. The secrets on this path are collected with the source handle by GC when it is dropped; there is no safe eager-wipe point because the library never observes "the source is now done". Zeroing stays only on the state-advancing paths (Steps 4–6), where `this.#state = newState` provably abandons the old state first.

- [ ] **Step 8: Serialize the commit producers on the handle's mutex**

`commitInvite`, `removeMember`, and `commitLedgerEntries` each read the live handle's state and must not interleave with a concurrent `encrypt`/`processMessage`. Wrap each function's body in `return mutexFor(group).run(async () => { … })`. They call `commitWithEntries`, `deriveGroup`, and (on the *new* handle) `applyLedgerEntries` — none re-enter the source handle's mutex, so there is no deadlock. Example for `commitLedgerEntries`:
```ts
export async function commitLedgerEntries(
  group: GroupHandle,
  tokens: Array<string>,
): Promise<CommitLedgerEntriesResult> {
  return mutexFor(group).run(async () => {
    // ... existing body verbatim ...
  })
}
```
Do the same for `commitInvite` and `removeMember`. Do **not** wrap `createGroup`, `processWelcome`, `restoreGroup`, or `joinGroupExternal` — they construct a new handle and have no prior `#state`.

- [ ] **Step 9: Run the new tests, then the whole suite**

Run: `pnpm --filter @kumiai/mls exec vitest run test/group.test.ts -t "serializes its state mutations"`
Expected: PASS (2 tests).

Run: `pnpm --filter @kumiai/mls exec vitest run`
Expected: PASS — **253 passed** (251 baseline at Task 2 start = 248 original + 3 mutex tests from Task 1, plus 2 new here). No signature changed, so every existing test still holds.

- [ ] **Step 10: Lint, type-check, commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
rtk proxy pnpm run lint
pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
git add packages/mls/src/group.ts packages/mls/test/group.test.ts
git commit
```
Commit message:
```
fix(mls): serialize handle state mutations and zero retired secrets

Every async operation that reads-then-writes a handle's #state — encrypt,
decrypt, processMessage, and the commitInvite/removeMember/commitLedgerEntries
producers — now runs through one FIFO mutex per handle, so interleaved
operations can no longer clobber a secret-tree advance or a key-schedule
deletion. The consumed buffers ts-mls returns for wiping are zeroed after the
state that used them is replaced. Synchronous getters are untouched. No public
signature changes yet.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WnnpGWMrYcgHpYuDhmJKk3
```

---

## Task 3: `encrypt` returns framed bytes; remove `decrypt`; consolidate on `processMessage`

**Files:**
- Modify: `packages/mls/src/group.ts`
- Test: `packages/mls/test/group.test.ts`, `packages/mls/test/external-rejoin.test.ts`

**Interfaces:**
- Consumes: the serialized `encrypt`/`processMessage` from Task 2.
- Produces: `encrypt(plaintext: Uint8Array): Promise<Uint8Array>` (framed wire bytes; no `consumed` in the return). `decrypt` no longer exists. `processMessage(message, opts?): Promise<Uint8Array | null>` is the sole receive path: application message → plaintext bytes; accepted handshake → `null`; rejected commit → throws `CommitRejectedError`.

- [ ] **Step 1: Write the failing receive-consolidation assertion**

The existing test `an existing receiver folds the new member in from the commit envelope` (in the `an invite seeds the roster` describe) already builds `addCarol` and calls `await bobGroup.processMessage(addCarol.commitMessage)`. Capture its return and assert it is `null` — an accepted handshake yields `null`, the behavior that replaces `decrypt`'s mutate-then-throw. Change:
```ts
    await bobGroup.processMessage(addCarol.commitMessage)
    expect(bobGroup.roster.roles.get(normalizeDID(carol.id))).toBe('member')
```
to:
```ts
    const outcome = await bobGroup.processMessage(addCarol.commitMessage)
    expect(outcome).toBeNull()
    expect(bobGroup.roster.roles.get(normalizeDID(carol.id))).toBe('member')
```
This adds an assertion to an existing test rather than creating a new one, so the suite count is unchanged by this step (the +1 in Step 6 is the concurrency/receive coverage net of this).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @kumiai/mls exec vitest run test/group.test.ts -t "single receive path"`
Expected: FAIL — before Step 4, `processMessage` on an accepted commit returns `undefined`/mismatch per the current tail (or the new assertion is simply not yet present). Confirm a red run before implementing.

- [ ] **Step 3: Reshape `encrypt` to return framed bytes**

Confirm `mlsMessageEncoder` and `encode` are already imported in `group.ts` (they are — used by `removeMember`/`commitInvite`). Replace `encrypt`:
```ts
  /** Encrypt an application message for the group, returning framed wire bytes. */
  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    return mutexFor(this).run(async () => {
      const { newState, message, consumed } = await createApplicationMessage({
        context: this.#context,
        state: this.#state,
        message: plaintext,
      })
      this.#state = newState
      zeroAll(consumed)
      return encode(mlsMessageEncoder, message)
    })
  }
```

- [ ] **Step 4: Delete `decrypt`**

Remove the entire `decrypt` method from `GroupHandle`. `processMessage` (from Task 2) already returns `null` for an accepted handshake, plaintext bytes for an application message, and throws `CommitRejectedError` on reject — it is the single receive path. There is no remaining `'Expected application message'` throw.

- [ ] **Step 5: Migrate every `encrypt`/`decrypt` call site in the tests**

Two mechanical rewrites across `packages/mls/test/group.test.ts` and `packages/mls/test/external-rejoin.test.ts`:
- `const { message } = await X.encrypt(p)` → `const message = await X.encrypt(p)` (and `const { message: alias } = …` → `const alias = await …`).
- `await Y.decrypt(m)` → `await Y.processMessage(m)`.

The application-message assertions are unchanged: `processMessage` returns the same plaintext `Uint8Array` for an application message that `decrypt` did. For the stale/removed-member cases that asserted `decrypt(...).rejects.toThrow()` (e.g. `group.test.ts:185,319`, `external-rejoin.test.ts:111`), `processMessage` also rejects (a stale application message fails to decrypt); keep them as `await expect(Y.processMessage(m)).rejects.toThrow()`. Grep to confirm none remain:
```bash
grep -rn "\.decrypt(\|{ message[ ,}]" packages/mls/test/group.test.ts packages/mls/test/external-rejoin.test.ts
```
(The `crypto.test.ts` `.encrypt(`/`.decrypt(` hits are a different cipher object — do not touch them.)

Two Task-2 tests in the `a handle serializes its state mutations` describe need shape-specific handling, not just the mechanical rewrite:

- **The concurrency test** (`concurrent encrypts each get a distinct generation and all decrypt on the peer`) has `for (const { message } of [m1, m2]) { got.add(d.decode(await bobGroup.decrypt(message))) }`. Since `m1`/`m2` are now framed `Uint8Array` directly, rewrite to `for (const message of [m1, m2]) { got.add(d.decode(await bobGroup.processMessage(message))) }`. The `Promise.all([...encrypt...])` above it stays — its results are just bytes now.
- **The consumed-zeroing test** (`encrypt wipes the retired secrets it consumed`) reads `const { consumed } = await aliceGroup.encrypt(...)` — but `encrypt` no longer returns `consumed`. Rewrite it to capture the buffers by tapping the ts-mls call, per the spec's Testing note ("spy/wrap the ts-mls call, or assert on a captured reference"). `group.ts` imports `createApplicationMessage` directly from the pure-ESM `ts-mls`, and the suite has no existing ts-mls mock, so use a file-scoped partial mock with `vi.hoisted` shared state (the standard vitest pattern — it delegates every ts-mls symbol to the real implementation via `importOriginal` and only records `consumed`). Keep the test — the zeroing behavior still runs inside `encrypt`; only its observation point moves.

  Add to the top of `packages/mls/test/group.test.ts` (after the imports; `vi.mock` is auto-hoisted above them by vitest, and `vi.hoisted` makes the capture reachable from the hoisted factory). Also add `vi` to the existing `vitest` import (`import { describe, expect, it, test, vi } from 'vitest'`):
  ```ts
  const consumedCapture = vi.hoisted(() => ({ last: null as Array<Uint8Array> | null }))
  vi.mock('ts-mls', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ts-mls')>()
    return {
      ...actual,
      createApplicationMessage: async (
        ...args: Parameters<typeof actual.createApplicationMessage>
      ) => {
        const result = await actual.createApplicationMessage(...args)
        consumedCapture.last = result.consumed
        return result
      },
    }
  })
  ```
  Replace the test body with:
  ```ts
  test('encrypt wipes the retired secrets it consumed', async () => {
    const { aliceGroup } = await twoMemberGroup()
    consumedCapture.last = null
    await aliceGroup.encrypt(new TextEncoder().encode('x'))
    const consumed = consumedCapture.last
    expect(consumed).not.toBeNull()
    expect((consumed as Array<Uint8Array>).length).toBeGreaterThan(0)
    for (const buffer of consumed as Array<Uint8Array>) {
      expect(buffer.every((byte) => byte === 0)).toBe(true)
    }
  })
  ```
  If the file-wide `vi.mock('ts-mls')` breaks other tests in the suite (unexpected, since it spreads the real module), STOP and report BLOCKED with the failing output rather than improvising a different seam.

- [ ] **Step 6: Run the whole suite**

Run: `pnpm --filter @kumiai/mls exec vitest run`
Expected: PASS — **253 passed** (251 baseline at Task 2 start + the 2 tests added in Task 2, both surviving here migrated/rewritten in place; the add-Carol assertion in Step 1 modifies an existing test, adding no count). If any test still destructures `{ message }` from `encrypt` or calls `decrypt`, tsc/vitest will point at it — fix mechanically per Step 5.

- [ ] **Step 7: Type-check**

Run: `pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: clean. (Catches any missed `{ message }` destructure or `decrypt` reference.)

- [ ] **Step 8: Lint, commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
rtk proxy pnpm run lint
git add packages/mls/src/group.ts packages/mls/test/group.test.ts packages/mls/test/external-rejoin.test.ts
git commit
```
Commit message:
```
feat(mls): encrypt returns framed bytes; processMessage is the sole receive path

encrypt now returns wire-framed Uint8Array like every other producer, with no
consumed buffers crossing the boundary. decrypt is removed: processMessage is
the single receive path — application message to plaintext, accepted handshake
to null, rejected commit throws CommitRejectedError — which erases decrypt's
mutate-then-throw bug where an accepted commit advanced the group and then threw.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WnnpGWMrYcgHpYuDhmJKk3
```

---

## Task 4: Fold the second `mls-codec.ts` hit into the kubun migration item

**Files:**
- Modify: `kubun/docs/agents/plans/next/2026-07-11-mls-permission-enforcement-migration.md` (separate repo; leave uncommitted for the maintainer, matching how the migration item was written).

**Interfaces:**
- Consumes: nothing in code — documentation only.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Confirm the migration item already carries the encrypt/decrypt note**

The migration item's "Breaking changes on the version bump" already anticipated this second hit to `mls-codec.ts` (it lists the `decrypt → processMessage` and `encrypt → bytes` edits under the serialization-hygiene fold). Re-read that section:
```bash
grep -n "mls-codec\|processMessage\|framed" /Users/paul/dev/yulsi/kubun/docs/agents/plans/next/2026-07-11-mls-permission-enforcement-migration.md
```

- [ ] **Step 2: If the note is thinner than the shipped change, tighten it**

Ensure it states: `mlsEncryptFramed` drops its JSON framing and `consumed` field (`encrypt` now returns framed `Uint8Array`); `mlsDecryptFramed` calls `handle.processMessage(...)`, whose `null` return means "accepted handshake" and must be handled rather than treated as plaintext. No code change in kubun here — this is the migration record only. Do not commit in the kubun repo.

- [ ] **Step 3: No commit in this repo**

This task changes only the kubun working tree (documentation), left uncommitted per the maintainer's instruction. Nothing to commit in `kumiai`.

---

## Self-Review

- **Spec coverage:** §1 mutation chain → Tasks 1–2 (mutex module + wiring, getters untouched, producers on the chain, constructors excluded). §2 zero consumed → Task 2 Steps 4–8. §3 encrypt framed bytes → Task 3 Step 3. §4 remove decrypt / processMessage sole path → Task 3 Steps 1,4,5. Migration impact → Task 4. Follow-up (@sozai extraction) is recorded in the spec; the mutex is already a standalone module, so the extraction is a later mechanical move, not a task here.
- **Type consistency:** `Mutex.run` used identically in `mutex.ts`, `mutexFor`, and every wrap site. `encrypt` return is `{ message; consumed }` through Task 2 and `Uint8Array` from Task 3 Step 3 onward — every call-site migration (Task 3 Step 5) lands in the same task as the signature change, so the suite is green at each commit. `zeroAll(Array<Uint8Array>)` and `mutexFor(GroupHandle)` signatures are stable across all uses.
- **Placeholder scan:** Task 3 Step 1 contains scaffold that is explicitly instructed to be deleted in favor of extending the existing add-Carol test — the final assertion is shown concretely (`expect(outcome).toBeNull()`). No `TBD`/`TODO`/"add error handling" anywhere.
- **Green-between-commits:** Task 1 standalone (its own `mutex.test.ts`); Task 2 no signature change (248 → 250); Task 3 signature change + call-site migration together, adding one assertion to an existing test (stays 250). Each commit compiles and passes.
