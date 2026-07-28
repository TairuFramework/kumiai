# Errors Reach a Sink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks

**Phase 1 is complete and handed off** (2026-07-28). `sozai` `feat/errors-reach-a-sink`,
`f7335f2..916f48c`, three commits, each reviewed clean. Phase 2 is blocked on the user merging and
publishing `@sozai/log` 0.3.0; Task 4 Step 1 is the gate.

**Correction to the Global Constraints below:** kumiai's branch is `feat/hub-server-error-sink`, not
`feat/errors-reach-a-sink`.

**Goal:** Give every silently-swallowed failure in `@kumiai/rpc` and `@kumiai/hub-server` somewhere to go, by adding a root logger and a shared reporter to `@sozai/log` and an `onStoreError` hook to the hub server.

**Architecture:** Two repos, in order. `@sozai/log` gains a root logger in `getDefaultConfig()` (so a category nobody configured still reaches the console at `error`) and `getReporter(category, packageName)` (the one report mechanism, replacing two hand-rolled copies in rpc). Then `@kumiai` bumps the catalog, adopts the reporter in rpc, and adds an `onStoreError` hook to `hub-server` wired at three sites where a store failure is deliberately not turned into a request failure. No control flow changes anywhere — every swallow stays a swallow, it just stops being silent.

**Tech Stack:** TypeScript, pnpm workspaces, turbo, vitest, biome, changesets, `@logtape/logtape` (via `@sozai/log`).

**Spec:** `docs/superpowers/specs/2026-07-28-errors-reach-a-sink-design.md`

## Global Constraints

- **pnpm only.** Never `npm` or `yarn`.
- **Do not edit generated files** (`lib/` in any package).
- **An `rtk` shim intercepts `pnpm run <script>` and `pnpm exec biome`** and may run the wrong tool. Invoke binaries directly: `<repo-root>/node_modules/.bin/vitest`, `<repo-root>/node_modules/.bin/tsc`, `<repo-root>/node_modules/.bin/biome`.
- **vitest's default reporter hides `console.log`.** Use `--reporter=verbose` when instrumenting.
- Cross-repo deps (`@sozai/*`, `@kokuin/*`, `@enkaku/*`) go through the workspace catalog as published `^` ranges, **never** `workspace:`. Internal `@kumiai/*` deps are `workspace:^`.
- No `interface` (use `type`), no `any`, no `T[]` (use `Array<T>`), no lowercase acronyms in names.
- Comments carry the non-obvious *why*, not a restatement of the code.
- **Phase 1 is in `/Users/paul/dev/yulsi/sozai`** on branch `feat/errors-reach-a-sink` (already exists, fresh off `main` at `f7335f2`). That working tree has an **unrelated uncommitted `package.json` change** (`packageManager` pnpm 11.15.1 → 11.17.0). Never `git add -A` there; stage named files only.
- **Phase 2 is in `/Users/paul/dev/yulsi/kumiai`** on branch `feat/errors-reach-a-sink`.
- **Phase 2 cannot start until `@sozai/log` 0.3.0 is published to npm.** Task 4 is the gate.

---

## Phase 1 — `@sozai/log` (repo: `/Users/paul/dev/yulsi/sozai`)

### Task 1: Root logger in `getDefaultConfig()`

**Files:**
- Modify: `packages/log/src/index.ts` (the `getDefaultConfig` function)
- Test: `packages/log/test/index.test.ts` (the existing `describe('getDefaultConfig')` block)

**Interfaces:**
- Consumes: nothing.
- Produces: `getDefaultConfig(options?: ConsoleSinkOptions): Config<'console', never>` — unchanged signature, one extra entry in `loggers`.

- [ ] **Step 1: Write the failing tests**

In `packages/log/test/index.test.ts`, replace the body of the existing `describe('getDefaultConfig', ...)` block's first test and add three new ones. The existing structural test asserts the `loggers` array literally, so it must become the single root entry:

```ts
  test('routes any category to a console sink at error level', () => {
    const config = getDefaultConfig()
    expect(Object.keys(config.sinks)).toEqual(['console'])
    expect(config.loggers).toEqual([{ category: [], lowestLevel: 'error', sinks: ['console'] }])
  })

  /**
   * The structural assertion above would pass against a root logger wired to no sink. This is the
   * behaviour that actually matters, and the reason it is asserted against the REAL default config
   * rather than a bespoke one: a test that configures its own sink proves only that logging works
   * when someone already thought about the category, which is not the failing case.
   */
  test('carries a category nobody configured, at error level', () => {
    const error = vi.fn()
    const fakeConsole = { error } as unknown as Console
    setup(getDefaultConfig({ console: fakeConsole }))
    getLogger(['kumiai', 'rpc']).error('the push lane ended')
    expect(error).toHaveBeenCalledOnce()
  })

  /** The blast radius stays bounded: a root SINK is not a root VOLUME. */
  test('drops an unconfigured category below error level', () => {
    const methods = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      log: vi.fn(),
    }
    setup(getDefaultConfig({ console: methods as unknown as Console }))
    getLogger(['kumiai', 'rpc']).info('chatty')
    getLogger(['kumiai', 'rpc']).warn('also chatty')
    for (const method of Object.values(methods)) {
      expect(method).not.toHaveBeenCalled()
    }
  })

  /** An app that deliberately narrows a category still wins. The root logger is a floor, not a law. */
  test('is overridden by an app that narrows a category', () => {
    const error = vi.fn()
    const fakeConsole = { error } as unknown as Console
    const config = getDefaultConfig({ console: fakeConsole })
    setup({
      ...config,
      loggers: [
        ...config.loggers,
        { category: ['kumiai'], lowestLevel: null, sinks: [], parentSinks: 'override' },
      ],
    })
    getLogger(['kumiai', 'rpc']).error('silenced on purpose')
    expect(error).not.toHaveBeenCalled()
  })
```

Then add one comment — no assertion change — to the **pre-existing** test
`getDefaultConfig > passes the console option through to the console sink`, which already asserts
`toHaveBeenCalledOnce()` for a `['sozai', 'test']` error and is what catches the trap in Step 3:

```ts
  /**
   * `toHaveBeenCalledOnce` also pins single dispatch. `parentSinks` defaults to 'inherit', which
   * UNIONS a category's own sinks with its parent's and does not de-duplicate by sink identity — so
   * a `['sozai']` entry naming the same sink as the root entry would print every sozai error twice.
   */
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/paul/dev/yulsi/sozai && ./node_modules/.bin/vitest run packages/log/test/index.test.ts
```

Expected: the structural test fails (array missing the root entry) and `carries a category nobody configured` fails (`error` was never called). The `drops ... below error level` and `is overridden by` tests pass already — they assert absence, and absence is the current behaviour. That is expected and fine; their job is to fail if the fix overshoots.

- [ ] **Step 3: Add the root logger**

In `packages/log/src/index.ts`:

The root entry **replaces** the two existing ones rather than joining them. That is not tidying — see
the comment, and the spec section "The root logger":

```ts
export function getDefaultConfig(options?: ConsoleSinkOptions): Config<'console', never> {
  return {
    sinks: { console: getConsoleSink(options) },
    // Any category reaches the console at error unless an app deliberately narrows it. Without
    // this, a package logging under its own category is dropped by the very config that made
    // isSetup() answer true — the app took the documented easy path and went deaf.
    //
    // One entry, and the ['logtape','meta'] and ['sozai'] entries it replaces are gone on purpose.
    // `parentSinks` defaults to 'inherit', which UNIONS a category's own sinks with its parent's
    // rather than overriding them, and does not de-duplicate by sink identity: keeping either
    // alongside this would print every record under it twice, through the same sink object. The
    // root entry covers both at the same level, and logtape counts a `category: []` entry as
    // configuring the meta logger, so its "not configured" fallback stays suppressed.
    loggers: [{ category: [], lowestLevel: 'error', sinks: ['console'] }],
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /Users/paul/dev/yulsi/sozai && ./node_modules/.bin/vitest run packages/log/test/index.test.ts
```

Expected: all pass — including the two **pre-existing** tests that assert a `['sozai', …]` error reaches the console `toHaveBeenCalledOnce()`, `setup > notifies through the default configuration's console sink` and `getDefaultConfig > passes the console option through to the console sink`. Those two are the single-dispatch guard. **Do not loosen either to accept two calls**: a second call means the config prints every sozai error line twice, which is the trap Step 3's comment describes.

- [ ] **Step 5: Mutation check — delete the root entry and confirm the right tests fail**

Remove the `{ category: [], ... }` entry from `getDefaultConfig`, leaving `loggers: []`, re-run, and record which tests fail. Expected, exactly these four:

- `getDefaultConfig > routes any category to a console sink at error level` — structural
- `getDefaultConfig > carries a category nobody configured, at error level` — the fix itself
- `setup > notifies through the default configuration's console sink` — pre-existing; the root entry is now the only thing routing `['sozai']`
- `getDefaultConfig > passes the console option through to the console sink` — pre-existing, same reason

If `carries a category nobody configured` still passes, the test is not testing what it claims — stop and fix the test before restoring. Restore the entry and re-run to confirm green.

- [ ] **Step 6: Typecheck and lint**

```bash
cd /Users/paul/dev/yulsi/sozai && ./node_modules/.bin/tsc --noEmit --skipLibCheck -p packages/log/tsconfig.test.json
./node_modules/.bin/biome check packages/log/src/index.ts packages/log/test/index.test.ts
```

- [ ] **Step 7: Commit**

```bash
cd /Users/paul/dev/yulsi/sozai
git add packages/log/src/index.ts packages/log/test/index.test.ts
git commit -m "feat(log): route any category to the console at error level

getDefaultConfig() covered ['logtape','meta'] and ['sozai'] only, so an app
calling setup() with no argument configured logging that drops every other
package's records — isSetup() answered true, the console fallback stayed out of
the way, and the record went nowhere. A root logger closes it; parentSinks
already defaults to inherit, so it propagates by logtape's own resolution.

The root entry REPLACES those two rather than joining them: inherit unions a
category's own sinks with its parent's without de-duplicating by identity, so
keeping either beside it printed every record under it twice. logtape counts a
category: [] entry as configuring the meta logger, so its fallback sink stays
suppressed.

Bounded to error, and an app that narrows a category still wins."
```

---

### Task 2: `getReporter`

**Files:**
- Modify: `packages/log/src/index.ts` (add `Reporter` type and `getReporter` function)
- Test: `packages/log/test/index.test.ts` (new `describe('getReporter')` block)

**Interfaces:**
- Consumes: `getLogger`, `isSetup` from the same module.
- Produces:
  - `type Reporter = (message: string, error?: unknown) => void`
  - `function getReporter(category: string | Array<string> | ReadonlyArray<string>, packageName: string): Reporter`

- [ ] **Step 1: Write the failing tests**

Add to `packages/log/test/index.test.ts`. Import `getReporter` alongside the existing imports from `../src/index.js`.

```ts
describe('getReporter', () => {
  beforeEach(() => {
    reset()
  })

  test('sends the record to the logger for its category when logging is configured', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    const boom = new Error('boom')
    getReporter(['test', 'lane'], '@scope/pkg')('the push lane ended', boom)
    expect(records).toHaveLength(1)
    expect(records[0].category).toEqual(['test', 'lane'])
    expect(records[0].level).toBe('error')
    expect(records[0].properties.error).toBe(boom)
  })

  /**
   * The genuine last resort: logtape drops everything when nothing is configured, so the console
   * is the only place left. Tagged with the package name because a bare line on stderr with no
   * owner is barely better than silence.
   */
  test('falls back to a tagged console line when nothing is configured', () => {
    const error = vi.fn()
    const realError = console.error
    console.error = error
    const boom = new Error('boom')
    try {
      getReporter(['test', 'lane'], '@scope/pkg')('the push lane ended', boom)
    } finally {
      console.error = realError
    }
    expect(error).toHaveBeenCalledWith('[@scope/pkg] the push lane ended', boom)
  })

  /**
   * `error` is optional because one real call site has no error to give (rpc's warnDropped reports
   * a rejected payload, not a thrown thing). Passing it through regardless would print a bare
   * `undefined` after every such line.
   */
  test('omits the error argument entirely when none was given', () => {
    const error = vi.fn()
    const realError = console.error
    console.error = error
    try {
      getReporter(['test', 'lane'], '@scope/pkg')('dropped an invalid event')
    } finally {
      console.error = realError
    }
    expect(error).toHaveBeenCalledWith('[@scope/pkg] dropped an invalid event')
  })

  test('takes a category as a string', () => {
    const records: Array<LogRecord> = []
    setup(memoryConfig(records))
    getReporter('test', '@scope/pkg')('a message')
    expect(records[0].category).toEqual(['test'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/paul/dev/yulsi/sozai && ./node_modules/.bin/vitest run packages/log/test/index.test.ts -t getReporter
```

Expected: FAIL — `getReporter is not a function` / import error.

- [ ] **Step 3: Implement `getReporter`**

In `packages/log/src/index.ts`, after `getSozaiLogger`:

```ts
/** An error report that always lands somewhere. `error` is optional: not every condition has one. */
export type Reporter = (message: string, error?: unknown) => void

/**
 * Build a reporter for conditions a host may have wired no handler for, where the alternative to
 * reporting is silence.
 *
 * Records go to the logger for `category`. When logging has not been configured AT ALL, logtape
 * drops everything, so they go to the console tagged with `packageName` instead — the genuine last
 * resort, not an approximation of one: {@link getDefaultConfig} carries every category, so a
 * configured app that still sees nothing narrowed the category deliberately.
 *
 * `error` level only, on purpose. `warn` would be dropped by the default config.
 */
export function getReporter(
  category: string | Array<string> | ReadonlyArray<string>,
  packageName: string,
): Reporter {
  const logger = getLogger(category)
  return (message, error) => {
    if (isSetup()) {
      logger.error(message, error === undefined ? undefined : { error })
      return
    }
    if (error === undefined) {
      console.error(`[${packageName}] ${message}`)
      return
    }
    console.error(`[${packageName}] ${message}`, error)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /Users/paul/dev/yulsi/sozai && ./node_modules/.bin/vitest run packages/log/test/index.test.ts
```

Expected: all pass, including Task 1's.

- [ ] **Step 5: Mutation check — three, one per branch**

Run each, confirm **exactly** the named test fails, then restore:

1. Replace the `isSetup()` branch body with the console branch → `sends the record to the logger` fails.
2. Replace the console branch with the logger call → `falls back to a tagged console line` fails.
3. Change the `error === undefined` console branch to always pass `error` → `omits the error argument entirely` fails.

If any mutation leaves the suite green, that branch is uncovered — fix the test before restoring.

- [ ] **Step 6: Typecheck and lint**

```bash
cd /Users/paul/dev/yulsi/sozai && ./node_modules/.bin/tsc --noEmit --skipLibCheck -p packages/log/tsconfig.test.json
./node_modules/.bin/biome check packages/log/src/index.ts packages/log/test/index.test.ts
```

- [ ] **Step 7: Commit**

```bash
cd /Users/paul/dev/yulsi/sozai
git add packages/log/src/index.ts packages/log/test/index.test.ts
git commit -m "feat(log): add getReporter for conditions a host wired no handler for

One mechanism instead of a copy per consumer: @kumiai/rpc hand-rolled the same
six lines twice and the drift is what surfaced the routing gap above.

The isSetup() branch is now honest rather than approximate — with a root sink,
configured means reaches somewhere unless the app opted out, and !isSetup()
still means logtape drops everything."
```

---

### Task 3: Changeset, then hand off for release

**Files:**
- Create: `.changeset/log-root-sink-and-reporter.md`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: a `minor` bump for `@sozai/log`, `0.2.0` → `0.3.0`.

- [ ] **Step 1: Write the changeset**

Create `.changeset/log-root-sink-and-reporter.md`:

```markdown
---
'@sozai/log': minor
---

`getDefaultConfig()` now carries a single root logger, so any category reaches the console at
`error` unless an app deliberately narrows it. Previously its loggers covered `['logtape', 'meta']`
and `['sozai']` only: an app calling `setup()` with no argument — the documented easy path —
configured logging that dropped every other package's records. `isSetup()` answered true, so
consumers' console fallbacks stayed out of the way, and the record went nowhere.

The root entry **replaces** those two rather than joining them. `parentSinks` defaults to
`'inherit'`, which unions a category's own sinks with its parent's without de-duplicating by sink
identity, so keeping either beside a root entry naming the same sink would print every record under
it twice. Behaviour for `['sozai']` and `['logtape', 'meta']` is unchanged: same level, same sink,
once.

**This is a behaviour change for every consumer of the default config, not only the one that
found it.** Any dependency logging to logtape under any category now prints its errors. Bounded
to `error` — `info` and `warn` under an unconfigured category are still dropped — and any app can
narrow a category back with `parentSinks: 'override'`.

New `getReporter(category, packageName)` returns an error reporter that always lands somewhere:
the logger for `category` when logging is configured, a console line tagged with `packageName`
when it is not. `error` level only, since `warn` is dropped by the default config. Consumers
hand-rolling this pair of branches should adopt it.
```

- [ ] **Step 2: Run the full package suite one more time**

```bash
cd /Users/paul/dev/yulsi/sozai && ./node_modules/.bin/vitest run packages/log
./node_modules/.bin/tsc --noEmit --skipLibCheck -p packages/log/tsconfig.test.json
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/paul/dev/yulsi/sozai
git add .changeset/log-root-sink-and-reporter.md
git commit -m "chore(log): changeset for the root sink and reporter"
```

- [ ] **Step 4: STOP — hand off to the user**

Report to the user that Phase 1 is complete on `sozai`'s `feat/errors-reach-a-sink` branch and ready to merge and publish as `@sozai/log` 0.3.0. **Do not open a PR, merge, or publish** — the user does both. Phase 2 cannot begin until `@sozai/log@0.3.0` is on npm.

Note for the user: the working tree still has the unrelated `packageManager` bump in the root `package.json`, deliberately left uncommitted.

---

## Phase 2 — kumiai (repo: `/Users/paul/dev/yulsi/kumiai`)

### Task 4: The gate — rpc's middle case, red before the bump and green after

**Files:**
- Modify: `packages/rpc/test/hub-mux-receive-ended.test.ts` (add one test)
- Modify: `pnpm-workspace.yaml` (catalog entry for `@sozai/log`)

**Interfaces:**
- Consumes: `@sozai/log@0.3.0`'s root logger from Task 1.
- Produces: nothing for later tasks; this is the acceptance test for Phase 1.

- [ ] **Step 1: Confirm the gate is open**

```bash
npm view @sozai/log version
```

Expected: `0.3.0` or higher. If it is still `0.2.0`, **stop** — Phase 1 has not been released and nothing below can work.

- [ ] **Step 2: Write the failing test**

In `packages/rpc/test/hub-mux-receive-ended.test.ts`, add the import of `getDefaultConfig` and `vi`:

```ts
import { getDefaultConfig, reset, setup } from '@sozai/log'
import { describe, expect, test, vi } from 'vitest'
```

Then add this test inside the existing `describe('the mux reports a push lane that ended without being asked to', ...)` block, directly after `'with logging configured, the report goes to the logger and not the console'`:

```ts
  /**
   * THE MIDDLE CASE, and the whole reason this exists. The two tests above cover the two ends —
   * a config that routes ['kumiai'], and no config at all. Neither is what a real app does.
   *
   * `isSetup()` answers "did someone call setup()", not "will this record reach anyone". An app
   * taking the documented easy path configures logging whose loggers do not cover ['kumiai'], so
   * the console fallback stays out of the way and the record is dropped for want of a matching
   * logger — the peer goes silently deaf through the most ordinary setup an app can perform.
   *
   * Asserted against the REAL getDefaultConfig(): a test that configures its own sink proves only
   * that logging works when someone already thought about the category, which is not the failing
   * case.
   */
  test('a default setup() carries the report rather than dropping it', async () => {
    const hub = new FakeHub()
    const wrapped = endableHub(hub, 'done')
    const error = vi.fn()
    setup(getDefaultConfig({ console: { error } as unknown as Console }))
    try {
      let lane: { endLane: () => void } | undefined
      const mux = createHubMux({
        hub: {
          ...wrapped,
          receive: (did: string) => {
            const subscription = wrapped.receive(did)
            lane = subscription as unknown as { endLane: () => void }
            return subscription
          },
        } as LogHub,
        localDID: 'bob',
      })
      mux.onInbound('topic:x', () => {})
      await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: new Uint8Array([1]) })
      await flush()

      lane?.endLane()
      await hub.publish({ senderDID: 'alice', topicID: 'topic:x', payload: new Uint8Array([2]) })
      await flush()

      expect(error).toHaveBeenCalledOnce()
      await mux.dispose()
    } finally {
      reset()
    }
  })
```

- [ ] **Step 3: Run it against the OLD `@sozai/log` and watch it fail**

```bash
cd /Users/paul/dev/yulsi/kumiai && ./node_modules/.bin/vitest run packages/rpc/test/hub-mux-receive-ended.test.ts -t 'default setup'
```

Expected: FAIL — `expected "spy" to be called once, but it was never called`. This is the filed defect reproducing. **If it passes here, stop**: either the installed `@sozai/log` is already 0.3.0 (check `node_modules/@sozai/log/package.json`), or the test is not exercising the report path.

- [ ] **Step 4: Bump the catalog and install**

In `pnpm-workspace.yaml`, change the `@sozai/log` catalog entry:

```yaml
  '@sozai/log': ^0.3.0
```

Then:

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm install
grep '"version"' node_modules/@sozai/log/package.json
```

Expected: `0.3.0`.

- [ ] **Step 5: Run it again and watch it pass**

```bash
cd /Users/paul/dev/yulsi/kumiai && ./node_modules/.bin/vitest run packages/rpc/test/hub-mux-receive-ended.test.ts
```

Expected: all pass, including the four pre-existing tests in that file.

- [ ] **Step 6: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
git add pnpm-workspace.yaml pnpm-lock.yaml packages/rpc/test/hub-mux-receive-ended.test.ts
git commit -m "test(rpc): the middle case — a default setup() carries the report

The two existing tests cover a config that routes ['kumiai'] and no config at
all. Neither is what a real app does: setup() with no argument configures
logging that drops the category, so isSetup() answered true and the record went
nowhere.

Fails against @sozai/log 0.2.0 and passes on 0.3.0, which is the point."
```

---

### Task 5: `onStoreError` and the last-resort top-up site

**Files:**
- Modify: `packages/hub-server/package.json` (add `@sozai/log` dependency)
- Modify: `packages/hub-server/src/handlers.ts` (types, `createStoreErrorReporter`, `CreateHandlersParams`, call site at the top-up read)
- Modify: `packages/hub-server/src/index.ts` (export the two new types)
- Create: `packages/hub-server/test/handlers-store-errors.test.ts`

**Interfaces:**
- Consumes: `getReporter` from `@sozai/log` (Task 2).
- Produces, all used by Tasks 6 and 7:
  - `type HubStoreErrorEvent = { method: 'fetchLastResortKeyPackage' | 'ack' | 'purge'; did?: string; error: unknown }`
  - `type HubStoreErrorHook = (event: HubStoreErrorEvent) => void`
  - `function createStoreErrorReporter(onStoreError?: HubStoreErrorHook): (event: HubStoreErrorEvent) => void` — exported from `handlers.ts` (module-level, **not** from `index.ts`; `hub.ts` imports it in Task 7)
  - `CreateHandlersParams.onStoreError?: HubStoreErrorHook`

- [ ] **Step 1: Add the dependency**

In `packages/hub-server/package.json`, add to `dependencies` (alphabetical, before `@sozai/codec`):

```json
    "@sozai/log": "catalog:",
```

Then:

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm install
```

- [ ] **Step 2: Write the failing test**

Create `packages/hub-server/test/handlers-store-errors.test.ts`:

```ts
// biome-ignore-all lint/suspicious/noExplicitAny: handlers are dispatched through a loosely-typed map in these tests
import type { HubStore } from '@kumiai/hub-protocol'
import { getDefaultConfig, reset, setup } from '@sozai/log'
import { describe, expect, test, vi } from 'vitest'

import type { HubStoreErrorEvent } from '../src/handlers.js'
import { createHandlers } from '../src/handlers.js'
import { createMemoryStore } from '../src/memoryStore.js'
import { HubClientRegistry } from '../src/registry.js'

const REQUESTER = 'did:key:requester'
const TARGET = 'did:key:target'

function reqCtx(prc: string, param: Record<string, unknown>, did = REQUESTER) {
  return {
    message: { header: {}, payload: { typ: 'request', prc, rid: '1', iss: did } },
    param,
  } as never
}

/**
 * A store that fails ONE method and delegates the rest. Test-local fault injection, deliberately
 * NOT a HubStore implementation offered to `hub-conformance`: it is stricter about nothing and
 * broken about one thing, which is the opposite of what a double is for.
 */
function failingStore(method: keyof HubStore, error: Error): HubStore {
  const store = createMemoryStore()
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === method) {
        return () => Promise.reject(error)
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

describe('a store failure the hub declines to turn into a request failure is reported', () => {
  /**
   * The top-up read runs AFTER `fetchKeyPackages` has already consumed destructively. Surfacing
   * its failure would destroy packages nobody received and make the client's retry burn the next
   * batch — so it is swallowed on purpose, and a permanently broken slot read returns 200 forever
   * with the availability floor silently absent.
   */
  test('the swallowed last-resort top-up read reaches the hook', async () => {
    const boom = new Error('fetchLastResortKeyPackage is not a function')
    const store = failingStore('fetchLastResortKeyPackage', boom)
    const seen: Array<HubStoreErrorEvent> = []
    const handlers = createHandlers({
      store,
      registry: new HubClientRegistry(),
      onStoreError: (event) => void seen.push(event),
    })

    await (handlers['hub/v1/keypackage/upload'] as any)(
      reqCtx('hub/v1/keypackage/upload', { keyPackages: ['kp-1'] }, TARGET),
    )
    const result = await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 3 }),
    )

    // Behaviour is UNCHANGED: the pool's one package is still served. A "fix" that started
    // failing this request would destroy key packages nobody ever received.
    expect(result).toEqual({ keyPackages: ['kp-1'] })
    expect(seen).toEqual([
      { method: 'fetchLastResortKeyPackage', did: TARGET, error: boom },
    ])
  })

  test('with no hook wired, the failure reaches a default-configured logger', async () => {
    const boom = new Error('fetchLastResortKeyPackage is not a function')
    const store = failingStore('fetchLastResortKeyPackage', boom)
    const error = vi.fn()
    setup(getDefaultConfig({ console: { error } as unknown as Console }))
    try {
      const handlers = createHandlers({ store, registry: new HubClientRegistry() })
      await (handlers['hub/v1/keypackage/upload'] as any)(
        reqCtx('hub/v1/keypackage/upload', { keyPackages: ['kp-1'] }, TARGET),
      )
      await (handlers['hub/v1/keypackage/fetch'] as any)(
        reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 3 }),
      )
      expect(error).toHaveBeenCalledOnce()
    } finally {
      reset()
    }
  })

  /** A hook is a notice, not a dependency: a host whose reporting is broken still gets served. */
  test('a hook that throws does not fail the request', async () => {
    const store = failingStore('fetchLastResortKeyPackage', new Error('boom'))
    const handlers = createHandlers({
      store,
      registry: new HubClientRegistry(),
      onStoreError: () => {
        throw new Error('the host reporting path is itself broken')
      },
    })

    await (handlers['hub/v1/keypackage/upload'] as any)(
      reqCtx('hub/v1/keypackage/upload', { keyPackages: ['kp-1'] }, TARGET),
    )
    const result = await (handlers['hub/v1/keypackage/fetch'] as any)(
      reqCtx('hub/v1/keypackage/fetch', { did: TARGET, count: 3 }),
    )
    expect(result).toEqual({ keyPackages: ['kp-1'] })
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /Users/paul/dev/yulsi/kumiai && ./node_modules/.bin/vitest run packages/hub-server/test/handlers-store-errors.test.ts
```

Expected: FAIL — `HubStoreErrorEvent` is not exported / `onStoreError` is not a known property.

- [ ] **Step 4: Add the types and the reporter factory**

In `packages/hub-server/src/handlers.ts`, add the import beside the existing `@sozai/codec` one:

```ts
import { getReporter } from '@sozai/log'
```

Then, after the `AuthorizeHook` declarations and before `HubRateLimits`:

```ts
/**
 * A `HubStore` operation that failed at a point where the hub deliberately does NOT fail the
 * request. Each of these swallows is correct — see the call sites for why — and each was, until
 * this hook existed, completely silent.
 */
export type HubStoreErrorEvent = {
  /** The HubStore method that threw. The operator's fix is to make this method work. */
  method: 'fetchLastResortKeyPackage' | 'ack' | 'purge'
  /** The DID the operation was for, where it names one. Absent for `purge`. */
  did?: string
  error: unknown
}

export type HubStoreErrorHook = (event: HubStoreErrorEvent) => void

/** What the hub did INSTEAD of failing, and what a permanent failure costs. */
const STORE_ERROR_CONSEQUENCE: Record<HubStoreErrorEvent['method'], string> = {
  fetchLastResortKeyPackage:
    'The fetch returned what the pool could serve, without the last-resort top-up. A read that ' +
    'keeps failing means the availability floor the last-resort slot exists to provide is absent, ' +
    'and joins fail downstream at the inviter with no signal here.',
  ack:
    'The frame stays pending and the client re-acks on the next round. An ack that keeps failing ' +
    'redelivers every frame forever.',
  purge:
    'Retried on the next interval. A purge that keeps failing means the store grows without bound.',
}

const reportStoreError = getReporter(['kumiai', 'hub-server'], '@kumiai/hub-server')

/**
 * Route a swallowed store failure to the host's hook, or to the reporter when it wired none.
 *
 * No throttling, deliberately: a permanently broken store emits per request, and logtape ships
 * `getThrottlingFilter`, so rate control belongs in the app's sink config where an operator can
 * tune it rather than hard-coded here.
 */
export function createStoreErrorReporter(
  onStoreError?: HubStoreErrorHook,
): (event: HubStoreErrorEvent) => void {
  return (event) => {
    if (onStoreError == null) {
      reportStoreError(
        `HubStore.${event.method} failed${event.did == null ? '' : ` for ${event.did}`}. ` +
          `${STORE_ERROR_CONSEQUENCE[event.method]} Wire \`onStoreError\` to handle this.`,
        event.error,
      )
      return
    }
    try {
      onStoreError(event)
    } catch {
      // A notice, not a dependency: a host whose own reporting throws must not fail the request
      // that was being served correctly.
    }
  }
}
```

Add the parameter to `CreateHandlersParams`:

```ts
  /**
   * Called when a `HubStore` operation fails at a point where the hub deliberately does not fail
   * the request. Fire-and-forget; a throw here is swallowed.
   *
   * Omitted, the failure is reported through `@sozai/log` instead of passing silently. Pass an
   * empty handler to silence it deliberately.
   */
  onStoreError?: HubStoreErrorHook
```

- [ ] **Step 5: Wire the top-up call site**

Inside `createHandlers`, near the other derived locals at the top of the function body:

```ts
  const storeErrorReporter = createStoreErrorReporter(params.onStoreError)
```

Then at the top-up read (currently `packages/hub-server/src/handlers.ts:705-712`), add one line to the existing catch — leaving the rethrow and the comment exactly as they are:

```ts
      let lastResort: string | null = null
      try {
        lastResort = await store.fetchLastResortKeyPackage(targetDID)
      } catch (error) {
        // Nothing consumed, so nothing is lost by surfacing it. Otherwise the top-up was a bonus
        // the caller never paid for: hand back what the store has already given up.
        if (consumed.length === 0) rethrowAsHandlerError(error)
        storeErrorReporter({ method: 'fetchLastResortKeyPackage', did: targetDID, error })
      }
```

- [ ] **Step 6: Export the public types**

In `packages/hub-server/src/index.ts`, add to the existing type export from `./handlers.js` (keep the list alphabetical):

```ts
export type {
  AuthorizeDecision,
  AuthorizeHook,
  AuthorizeRequest,
  CreateHandlersParams,
  HubRateLimits,
  HubStoreErrorEvent,
  HubStoreErrorHook,
  KeyPackageFetchLimits,
} from './handlers.js'
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
cd /Users/paul/dev/yulsi/kumiai && ./node_modules/.bin/vitest run packages/hub-server/test/handlers-store-errors.test.ts
```

Expected: all three pass.

- [ ] **Step 8: Mutation check**

Delete the `storeErrorReporter({ method: 'fetchLastResortKeyPackage', ... })` line, re-run the whole `hub-server` suite, and record which tests fail. Expected: exactly `the swallowed last-resort top-up read reaches the hook` and `with no hook wired, the failure reaches a default-configured logger`. If either still passes, that test is not reaching the call site — fix it before restoring. Restore and re-run.

- [ ] **Step 9: Run the full hub-server suite and typecheck**

```bash
cd /Users/paul/dev/yulsi/kumiai && ./node_modules/.bin/vitest run packages/hub-server
./node_modules/.bin/tsc --noEmit --skipLibCheck -p packages/hub-server/tsconfig.test.json
./node_modules/.bin/biome check packages/hub-server/src packages/hub-server/test
```

Expected: all pass, including `conformance.test.ts` and `log-hub-conformance.test.ts` — no port changed.

- [ ] **Step 10: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
git add packages/hub-server/package.json packages/hub-server/src/handlers.ts packages/hub-server/src/index.ts packages/hub-server/test/handlers-store-errors.test.ts pnpm-lock.yaml
git commit -m "feat(hub-server): onStoreError, wired at the last-resort top-up read

createHandlers took no logger and no hook, and the module held no console
reference, so a permanently broken slot read returned 200 forever: the
availability floor the last-resort feature exists to provide, silently absent,
with the operator's only clue being joins failing downstream at the inviter.

The swallow is correct and stays — surfacing it would destroy key packages
nobody received. It just has somewhere to go now."
```

---

### Task 6: The `ack` site

**Files:**
- Modify: `packages/hub-server/src/handlers.ts:541-545` (the ack loop's catch)
- Test: `packages/hub-server/test/handlers-store-errors.test.ts` (add one `describe` block)

**Interfaces:**
- Consumes: `storeErrorReporter` from Task 5, already in scope inside `createHandlers`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `packages/hub-server/test/handlers-store-errors.test.ts`. Add these imports at the top of the file:

```ts
import type { StoredMessage } from '@kumiai/hub-protocol'
```

Then append this block:

```ts
describe('an ack the store refused is reported without stopping the loop', () => {
  const RECEIVER = 'did:key:receiver'

  function receiveCtx(params: {
    acks: ReadableStream<{ ack: Array<string> }>
    writable: WritableStream<StoredMessage>
  }) {
    return {
      message: {
        header: {},
        payload: { typ: 'channel', prc: 'hub/v1/receive', rid: '1', iss: RECEIVER },
      },
      param: {},
      signal: new AbortController().signal,
      writable: params.writable,
      readable: params.acks,
    } as never
  }

  /**
   * The ack loop must not break on a store failure: the frame stays pending and the client re-acks
   * next round. So a store whose ack never works redelivers every frame forever, and until this
   * hook the only evidence was the redelivery itself.
   */
  test('the hook fires and the next ack is still attempted', async () => {
    const boom = new Error('ack column is gone')
    const store = createMemoryStore()
    const acked: Array<Array<string>> = []
    const failingAck: HubStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'ack') {
          return (params: { recipientDID: string; sequenceIDs: Array<string> }) => {
            acked.push(params.sequenceIDs)
            return Promise.reject(boom)
          }
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const seen: Array<HubStoreErrorEvent> = []
    const handlers = createHandlers({
      store: failingAck,
      registry: new HubClientRegistry(),
      onStoreError: (event) => void seen.push(event),
    })

    const acks = new ReadableStream<{ ack: Array<string> }>({
      start(controller) {
        controller.enqueue({ ack: ['seq-1'] })
        controller.enqueue({ ack: ['seq-2'] })
        controller.close()
      },
    })
    const written: Array<unknown> = []
    const writable = new WritableStream<StoredMessage>({
      write(chunk) {
        written.push(chunk)
      },
    })

    await (handlers['hub/v1/receive'] as any)(receiveCtx({ acks, writable }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    // BOTH acks were attempted: the loop did not break on the first failure.
    expect(acked).toEqual([['seq-1'], ['seq-2']])
    expect(seen).toEqual([
      { method: 'ack', did: RECEIVER, error: boom },
      { method: 'ack', did: RECEIVER, error: boom },
    ])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/paul/dev/yulsi/kumiai && ./node_modules/.bin/vitest run packages/hub-server/test/handlers-store-errors.test.ts -t 'next ack is still attempted'
```

Expected: FAIL — `seen` is `[]` while `acked` has both entries. That difference is the whole finding: the loop already behaves correctly, and says nothing.

- [ ] **Step 3: Wire the call site**

In `packages/hub-server/src/handlers.ts`, in the ack loop's catch (currently line 543):

```ts
            try {
              await store.ack({ recipientDID: clientDID, sequenceIDs: ack })
            } catch (error) {
              // Frame stays pending; the client re-acks next round. Do NOT break.
              storeErrorReporter({ method: 'ack', did: clientDID, error })
            }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/paul/dev/yulsi/kumiai && ./node_modules/.bin/vitest run packages/hub-server/test/handlers-store-errors.test.ts
```

Expected: all pass.

- [ ] **Step 5: Mutation check**

Two of them, each run against the whole `hub-server` suite:

1. Delete the `storeErrorReporter({ method: 'ack', ... })` line → expected: exactly `the hook fires and the next ack is still attempted` fails, on the `seen` assertion.
2. Restore it, then add `break` after it → expected: the same test fails, on the `acked` assertion. This is the one that proves the test guards the "do NOT break" contract and not merely the reporting.

Restore and re-run green.

- [ ] **Step 6: Run the full hub-server suite, typecheck, lint**

```bash
cd /Users/paul/dev/yulsi/kumiai && ./node_modules/.bin/vitest run packages/hub-server
./node_modules/.bin/tsc --noEmit --skipLibCheck -p packages/hub-server/tsconfig.test.json
./node_modules/.bin/biome check packages/hub-server/src packages/hub-server/test
```

- [ ] **Step 7: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
git add packages/hub-server/src/handlers.ts packages/hub-server/test/handlers-store-errors.test.ts
git commit -m "feat(hub-server): report a store.ack failure without stopping the loop

The loop already refused to break, which is right — the frame stays pending and
the client re-acks. A store whose ack never works therefore redelivered every
frame forever, and the only evidence was the redelivery."
```

---

### Task 7: The `purge` site

**Files:**
- Modify: `packages/hub-server/src/hub.ts` (`CreateHubParams`, the `createHandlers` call, the purge timer at line 96)
- Test: `packages/hub-server/test/hub.test.ts` (add one test)

**Interfaces:**
- Consumes: `createStoreErrorReporter`, `HubStoreErrorHook`, `HubStoreErrorEvent` from `./handlers.js` (Task 5).
- Produces: `CreateHubParams.onStoreError?: HubStoreErrorHook`.

- [ ] **Step 1: Write the two failing tests**

In `packages/hub-server/test/hub.test.ts`, add `HubStoreErrorEvent` to the existing type import from `../src/handlers.js`. Both tests use the file's own `createTestHub` helper, whose options type is `Omit<CreateHubParams, 'identity' | 'store' | 'transport'> & { store?: HubStore }` — so `purge` and `onStoreError` pass straight through once Step 3 adds the latter to `CreateHubParams`.

Add a new `describe` block at the end of the file:

```ts
describe('a store failure the hub declines to turn into a request failure is reported', () => {
  /**
   * The purge timer swallows its failure because a failed purge is genuinely non-fatal and the
   * next interval retries it. A store that can never purge therefore grows without bound, on a
   * timer nobody is watching.
   */
  test('a purge failure reaches the hook and is still retried next interval', async () => {
    vi.useFakeTimers()
    const boom = new Error('purge is not implemented')
    const purge = vi.fn(() => Promise.reject(boom))
    const store = new Proxy(createMemoryStore(), {
      get(target, property, receiver) {
        if (property === 'purge') return purge
        return Reflect.get(target, property, receiver)
      },
    })
    const seen: Array<HubStoreErrorEvent> = []
    const ctx = createTestHub({
      store,
      purge: { interval: 1000, olderThan: 60 },
      onStoreError: (event) => void seen.push(event),
    })
    try {
      await vi.advanceTimersByTimeAsync(1000)
      expect(purge).toHaveBeenCalledTimes(1)
      expect(seen).toEqual([{ method: 'purge', error: boom }])

      // Still on the timer: a failed purge is not a stopped purge.
      await vi.advanceTimersByTimeAsync(1000)
      expect(purge).toHaveBeenCalledTimes(2)
      expect(seen).toHaveLength(2)
    } finally {
      // Real timers before dispose: teardown awaits transport work that fake timers would stall.
      vi.useRealTimers()
      await ctx.dispose()
    }
  })

  /**
   * The purge timer builds its own reporter from `params.onStoreError`, so it would pass even if
   * `createHub` forgot to FORWARD the hook to `createHandlers`. This drives a handler-level
   * failure through a real client to pin the forwarding.
   */
  test('a handler-level store failure on a createHub hub reaches the hook', async () => {
    const boom = new Error('fetchLastResortKeyPackage is not a function')
    const store = new Proxy(createMemoryStore(), {
      get(target, property, receiver) {
        if (property === 'fetchLastResortKeyPackage') return () => Promise.reject(boom)
        return Reflect.get(target, property, receiver)
      },
    })
    const seen: Array<HubStoreErrorEvent> = []
    const ctx = createTestHub({
      store,
      purge: false,
      onStoreError: (event) => void seen.push(event),
    })
    const targetIdentity = randomIdentity()
    const { client: target } = ctx.connect(targetIdentity)
    const { client: requester } = ctx.connect()

    await target.request('hub/v1/keypackage/upload', { param: { keyPackages: ['kp-1'] } })
    const result = await requester.request('hub/v1/keypackage/fetch', {
      param: { did: targetIdentity.id, count: 3 },
    })

    // Unchanged: the pool's one package is still served.
    expect(result).toEqual({ keyPackages: ['kp-1'] })
    expect(seen).toEqual([
      { method: 'fetchLastResortKeyPackage', did: targetIdentity.id, error: boom },
    ])

    await ctx.dispose()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/paul/dev/yulsi/kumiai && ./node_modules/.bin/vitest run packages/hub-server/test/hub.test.ts -t 'declines to turn into a request failure'
```

Expected: both FAIL — `onStoreError` is not a known property of `CreateHubParams`, and `seen` is empty.

- [ ] **Step 3: Wire it**

In `packages/hub-server/src/hub.ts`, extend the import from `./handlers.js`:

```ts
import {
  type AuthorizeHook,
  createHandlers,
  createStoreErrorReporter,
  type HubRateLimits,
  type HubStoreErrorHook,
  type KeyPackageFetchLimits,
} from './handlers.js'
```

Add to `CreateHubParams`, after `keyPackageFetchLimits`:

```ts
  /**
   * Called when a `HubStore` operation fails where the hub deliberately does not fail the request.
   * Forwarded to {@link createHandlers} and used by the purge timer. Fire-and-forget.
   */
  onStoreError?: HubStoreErrorHook
```

Forward it in the `createHandlers` call:

```ts
  const handlers = createHandlers({
    registry,
    store: params.store,
    authorize: params.authorize,
    rateLimits: params.rateLimits,
    keyPackageFetchLimits: params.keyPackageFetchLimits,
    onStoreError: params.onStoreError,
  })
```

And in the purge timer:

```ts
  if (params.purge !== false) {
    const interval = params.purge?.interval ?? 3_600_000
    const olderThan = params.purge?.olderThan ?? 604_800
    const storeErrorReporter = createStoreErrorReporter(params.onStoreError)
    const purgeTimer = setInterval(() => {
      params.store.purge({ olderThan }).catch((error: unknown) => {
        // Purge failures are non-fatal; retried on the next interval
        storeErrorReporter({ method: 'purge', error })
      })
    }, interval)
    server.disposed.then(() => clearInterval(purgeTimer))
  }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/paul/dev/yulsi/kumiai && ./node_modules/.bin/vitest run packages/hub-server/test/hub.test.ts
```

Expected: all pass.

- [ ] **Step 5: Mutation check**

Two, each against the whole `hub-server` suite:

1. Replace the `storeErrorReporter({ method: 'purge', error })` call with the original empty-comment catch → expected: exactly `a purge failure reaches the hook and is still retried next interval` fails, on `seen`.
2. Restore it, then remove `onStoreError: params.onStoreError` from the `createHandlers` call → expected: exactly `a handler-level store failure on a createHub hub reaches the hook` fails. Task 5's and Task 6's tests must all still pass, since they call `createHandlers` directly and never exercise the forwarding. If this mutation leaves the suite green, the forwarding is untested — stop and fix before restoring.

Restore and re-run green.

- [ ] **Step 6: Run the full hub-server suite, typecheck, lint**

```bash
cd /Users/paul/dev/yulsi/kumiai && ./node_modules/.bin/vitest run packages/hub-server
./node_modules/.bin/tsc --noEmit --skipLibCheck -p packages/hub-server/tsconfig.test.json
./node_modules/.bin/biome check packages/hub-server/src packages/hub-server/test
```

- [ ] **Step 7: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
git add packages/hub-server/src/hub.ts packages/hub-server/test/hub.test.ts
git commit -m "feat(hub-server): forward onStoreError to the purge timer

A store that can never purge grew without bound on a timer nobody was watching.
Still non-fatal, still retried."
```

---

### Task 8: rpc adopts the shared reporter

**Files:**
- Modify: `packages/rpc/src/hub-mux.ts` (replace the local `report`)
- Modify: `packages/rpc/src/handlers.ts` (replace the local `warnDropped`)

**Interfaces:**
- Consumes: `getReporter` from `@sozai/log` (Task 2).
- Produces: nothing new. Behaviour is identical; this removes two copies of one mechanism.

- [ ] **Step 1: Replace `report` in `hub-mux.ts`**

Change the import (line 14) from:

```ts
import { getLogger, isSetup } from '@sozai/log'
```

to:

```ts
import { getReporter } from '@sozai/log'
```

Delete the local `logger` constant and the `report` function, and replace them with:

```ts
const report = getReporter(['kumiai', 'rpc'], '@kumiai/rpc')
```

`warnSubscribeFailed` and `warnReceiveEnded` call `report(message, error)` and are unchanged.

- [ ] **Step 2: Replace `warnDropped` in `rpc/src/handlers.ts`**

Change the import (line 9) the same way, then replace the `logger` constant and the `warnDropped` function (lines 18-28) with:

```ts
/** `['kumiai', 'rpc']` — an app routing this category sees dropped-input diagnostics. */
const warnDropped = getReporter(['kumiai', 'rpc'], '@kumiai/rpc')
```

The single call site (`warnDropped(\`Dropped invalid event "${prc}": ${result.message}\`)`) is unchanged — it passes no error, which is why `Reporter`'s second parameter is optional.

- [ ] **Step 3: Run the rpc suite**

```bash
cd /Users/paul/dev/yulsi/kumiai && ./node_modules/.bin/vitest run packages/rpc
```

Expected: 375 tests pass (374 before this branch, plus Task 4's). In particular all five tests in `hub-mux-receive-ended.test.ts` pass unchanged — the swap must not alter behaviour, and those tests assert both branches.

- [ ] **Step 4: Mutation check**

Change `getReporter(['kumiai', 'rpc'], '@kumiai/rpc')` in `hub-mux.ts` to category `['nobody']`. Expected: `with logging configured, the report goes to the logger and not the console` fails on the category assertion. Restore.

- [ ] **Step 5: Typecheck and lint**

```bash
cd /Users/paul/dev/yulsi/kumiai && ./node_modules/.bin/tsc --noEmit --skipLibCheck -p packages/rpc/tsconfig.test.json
./node_modules/.bin/biome check packages/rpc/src
```

- [ ] **Step 6: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
git add packages/rpc/src/hub-mux.ts packages/rpc/src/handlers.ts
git commit -m "refactor(rpc): adopt @sozai/log's getReporter

Two hand-rolled copies of the same six lines, which is the drift that surfaced
the routing gap. Behaviour is unchanged by the swap; what changed it is the root
sink underneath."
```

---

### Task 9: Documentation and changeset

**Files:**
- Modify: `packages/hub-server/README.md` (document `onStoreError`)
- Create: `.changeset/hub-server-store-error-hook.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the release.

- [ ] **Step 1: Document the hook**

In `packages/hub-server/README.md`, add a section after `## Retention: the store refuses, the hub schedules`:

```markdown
## A store failure that is not a request failure

Three store operations are deliberately not allowed to fail the request they happen in:

- the **last-resort key-package top-up**, read after `fetchKeyPackages` has already consumed
  destructively — surfacing it would destroy packages nobody received, and the client's retry
  would burn the next batch
- an **ack**, where the frame simply stays pending and the client re-acks next round
- a scheduled **purge**, retried on the next interval

All three are correct, and all three were silent. `createHandlers` and `createHub` take
`onStoreError`, called with `{ method, did?, error }` where `method` names the `HubStore` method
that threw. Wire it to whatever an operator watches:

```ts
const { server } = createHub({
  transport,
  store,
  identity,
  onStoreError: ({ method, did, error }) => metrics.storeFailure(method, did, error),
})
```

Fire-and-forget — a throw from the hook is swallowed rather than allowed to fail the request.
Unwired, the failure is reported through `@sozai/log` under `['kumiai', 'hub-server']` at `error`
rather than passing silently. Pass an empty handler to silence it deliberately.

There is no throttling: a permanently broken store reports per request. logtape ships
`getThrottlingFilter`, so rate control belongs in the app's sink configuration where an operator
can tune it.
```

- [ ] **Step 2: Write the changeset**

Create `.changeset/hub-server-store-error-hook.md`:

```markdown
---
'@kumiai/hub-server': minor
'@kumiai/rpc': patch
---

`createHandlers` and `createHub` now take `onStoreError`, called when a `HubStore` operation fails
at a point where the hub deliberately does not fail the request: the last-resort key-package
top-up read, an ack, and the scheduled purge. All three swallows are correct and unchanged — a
permanently broken last-resort read still returns what the pool can serve, rather than destroying
key packages nobody received — but they are no longer silent. Unwired, the failure is reported
through `@sozai/log` under `['kumiai', 'hub-server']`.

`@kumiai/rpc` now reports through `@sozai/log`'s `getReporter` instead of two hand-rolled copies
of the same logic. No behaviour change in rpc itself; what changed is underneath it, in
`@sozai/log` 0.3.0, whose default config now carries every category rather than dropping
`['kumiai']` records for want of a matching logger.
```

- [ ] **Step 3: Full repo gate**

```bash
cd /Users/paul/dev/yulsi/kumiai && ./node_modules/.bin/turbo run test --force 2>&1 | tail -30
```

Expected: every package passes and the summary reports `Cached: 0` — a cached run proves nothing. If it reports cached results, re-run until it does not.

```bash
cd /Users/paul/dev/yulsi/kumiai && ./node_modules/.bin/biome check .
```

- [ ] **Step 4: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
git add packages/hub-server/README.md .changeset/hub-server-store-error-hook.md
git commit -m "docs(hub-server): document onStoreError, and changeset the release"
```

- [ ] **Step 5: Update the plan's stage**

Set `**Stage:** reviewing` at the top of this plan file, commit it, and hand back to `kigu:dev-loop`.

---

## Notes for the reviewer

- **No port changed.** `HubStore`, `HubProtocol`, and the rpc ports are untouched, so
  `rpc-conformance` and `hub-conformance` must pass unmodified. If either needed a change,
  something went wrong.
- **The three swallows must still swallow.** Every task asserts the unchanged behaviour beside the
  new reporting: the top-up still returns the short batch, the ack loop still continues, the purge
  still retries. A change that starts failing those requests is a regression, not a fix — for the
  top-up site specifically, it would destroy key packages nobody ever received.
- **Every mutation check is per-test, not per-suite.** "The suite went red" is not the bar; "exactly
  this test failed" is. On 2026-07-28 a guard in this repo survived deletion with the whole rpc
  suite green while a test that named it existed and passed for a reason forty lines upstream.
