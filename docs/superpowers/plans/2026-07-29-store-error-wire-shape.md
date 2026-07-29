# Store-Error Wire Shape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** planning
**Mode:** tasks
**Spec:** `docs/superpowers/specs/2026-07-29-store-error-wire-shape-design.md`

**Goal:** Make every `HubStore` call in `packages/hub-server/src/handlers.ts` obey one of the file's
two rules — fail the request with a coded wire shape, or swallow deliberately and report to the
store-error sink.

**Architecture:** Two call sites obey neither today. `store.getSubscribers` (publish fan-out) becomes
a reported swallow, because the append it follows is already committed. `store.unsubscribe` becomes
a coded failure. Reporting a topic-keyed site forces `HubStoreErrorEvent` from a flat
`{ method; did?; error }` into a method-keyed discriminated union, and while in the file the hub's
two duplicate reporter instances collapse into one.

**Tech Stack:** TypeScript, vitest, pnpm workspaces + turbo, biome, changesets. `@sozai/log` for
reporting, `@sozai/codec` for base64.

## Global Constraints

- pnpm only. Never edit `lib/` — it is generated.
- Package under change: `@kumiai/hub-server` (`packages/hub-server`). No `@kumiai/hub-protocol`
  port change and no `@kumiai/hub-conformance` change — this is handler behaviour only.
- Run repo scripts as `rtk proxy pnpm run <script>`; an `rtk` shim intercepts plain
  `pnpm run <script>` and redirects it to the wrong tool.
- **Vitest strips types.** A green vitest run proves nothing about types. Every task runs
  `test:types` as well as `test:unit`.
- Per-package commands used throughout (run from the repo root):
  - unit: `pnpm --filter @kumiai/hub-server exec vitest run <file>`
  - types: `pnpm --filter @kumiai/hub-server exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
- Mutation-check every new guard: after the test passes, delete the `try`/`catch` the task added,
  confirm the test fails naming the real symptom, restore. A guard whose test still passes without
  it has not been tested.
- Commit after each task.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/hub-server/src/handlers.ts` | modify | The event union, `subjectOf`, the consequence map, and both wrapped call sites |
| `packages/hub-server/src/hub.ts` | modify | Build one reporter and share it with `createHandlers` |
| `packages/hub-server/test/handlers-store-errors.test.ts` | modify | Reporter rendering for the new variant; the `getSubscribers` swallow |
| `packages/hub-server/test/handlers.test.ts` | modify | `unsubscribe` coded-failure and pass-through cases |
| `packages/hub-server/README.md` | modify | The "store failure that is not a request failure" section: three sites become four |
| `.changeset/hub-server-store-error-wire-shape.md` | create | Release note, including the `HubStoreErrorEvent` type break |
| `docs/agents/plans/backlog/2026-07-29-hub-server-store-error-residuals.md` | modify | Strike items 1, 2, 4; rewrite item 3's trigger |

---

### Task 1: `HubStoreErrorEvent` becomes a method-keyed union

**Files:**
- Modify: `packages/hub-server/src/handlers.ts:74-102` (the event type and consequence map) and
  `:113-132` (`createStoreErrorReporter`)
- Test: `packages/hub-server/test/handlers-store-errors.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `HubStoreErrorEvent`, a discriminated union on `method` with four variants —
  `{ method: 'purge'; error: unknown }`, `{ method: 'ack'; did: string; error: unknown }`,
  `{ method: 'fetchLastResortKeyPackage'; did: string; error: unknown }`,
  `{ method: 'getSubscribers'; topicID: string; error: unknown }`. Tasks 2 and 4 construct the
  `getSubscribers` variant. `createStoreErrorReporter(onStoreError?: HubStoreErrorHook) =>
  (event: HubStoreErrorEvent) => void` keeps its existing signature.

- [ ] **Step 1: Write the failing test**

Append to `packages/hub-server/test/handlers-store-errors.test.ts`, after the existing
`describe('the purge consequence, exercised directly against the exported reporter', ...)` block. It
follows that block's pattern for the same reason: the reporter is exported precisely so a variant
can be pinned without standing up the machinery that produces it.

```ts
/**
 * The fan-out variant is the first event whose subject is a topic rather than a DID, so the
 * default log line has to name it. Exercised directly against the exported reporter for the same
 * reason as `purge` above — the site that produces it is covered separately in the publish tests.
 */
describe('the publish fan-out consequence, exercised directly against the exported reporter', () => {
  test('with no hook wired, a getSubscribers failure names the topic and the push-to-pull consequence', () => {
    const boom = new Error('subscriber index is gone')
    const records: Array<CapturedRecord> = []
    setupCapture(records)
    try {
      const report = createStoreErrorReporter()
      report({ method: 'getSubscribers', topicID: 'topic-1', error: boom })

      expect(records).toHaveLength(1)
      expect(records[0]?.category).toEqual(['kumiai', 'hub-server'])
      expect(records[0]?.level).toBe('error')
      expect(records[0]?.message).toContain('on topic topic-1')
      expect(records[0]?.message).toContain('degraded from push to pull')
    } finally {
      reset()
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kumiai/hub-server exec vitest run test/handlers-store-errors.test.ts -t "names the topic"`

Expected: FAIL. The message contains neither `on topic topic-1` (no `subjectOf` yet, and the old
line only interpolates `did`) nor the consequence text (`STORE_ERROR_CONSEQUENCE.getSubscribers` is
`undefined`, so the line reads `... failed. undefined Wire ...`).

- [ ] **Step 3: Replace the event type**

In `packages/hub-server/src/handlers.ts`, replace the `HubStoreErrorEvent` declaration at `:74-80`:

```ts
/**
 * A `HubStore` operation that failed at a point where the hub deliberately does NOT fail the
 * request. Each of these swallows is correct — see the call sites for why — and each was, until
 * this hook existed, completely silent.
 *
 * A union rather than a flat record: each variant carries the subject its own site has, so a site
 * cannot forget one and a topic-keyed site cannot be described with a DID.
 */
export type HubStoreErrorEvent =
  | { method: 'purge'; error: unknown }
  /** The DID whose ack the store refused. */
  | { method: 'ack'; did: string; error: unknown }
  /** The DID whose last-resort slot was being read. */
  | { method: 'fetchLastResortKeyPackage'; did: string; error: unknown }
  /** The topic whose subscriber list could not be read for live fan-out. */
  | { method: 'getSubscribers'; topicID: string; error: unknown }
```

- [ ] **Step 4: Add the consequence entry**

In the same file, add a fourth entry to `STORE_ERROR_CONSEQUENCE` (`:92-102`). Leave the map's
existing doc comment about a reused method key exactly as it is — its trigger has not fired.

```ts
  getSubscribers:
    'The frame is committed and queued; only the live push to connected subscribers was skipped, ' +
    'so each of them receives it on its next receive drain instead. A getSubscribers that keeps ' +
    'failing means the hub has silently degraded from push to pull for every publish.',
```

- [ ] **Step 5: Add `subjectOf` and use it in the reporter**

Insert immediately above `createStoreErrorReporter` (`:113`):

```ts
/** What the failed operation was about, for the default log line: a DID for the per-recipient
 * methods, a topic for fan-out, nothing for a store-wide purge. */
function subjectOf(event: HubStoreErrorEvent): string {
  switch (event.method) {
    case 'purge':
      return ''
    case 'getSubscribers':
      return ` on topic ${event.topicID}`
    case 'ack':
    case 'fetchLastResortKeyPackage':
      return ` for ${event.did}`
  }
}
```

Then replace the message construction inside `createStoreErrorReporter`. Old (`:118-122`):

```ts
      reportStoreError(
        `HubStore.${event.method} failed${event.did == null ? '' : ` for ${event.did}`}. ` +
          `${STORE_ERROR_CONSEQUENCE[event.method]} Wire \`onStoreError\` to handle this.`,
        event.error,
      )
```

New:

```ts
      reportStoreError(
        `HubStore.${event.method} failed${subjectOf(event)}. ` +
          `${STORE_ERROR_CONSEQUENCE[event.method]} Wire \`onStoreError\` to handle this.`,
        event.error,
      )
```

- [ ] **Step 6: Run the unit tests**

Run: `pnpm --filter @kumiai/hub-server exec vitest run test/handlers-store-errors.test.ts`

Expected: PASS, all cases in the file. The existing `ack`, top-up, and `purge` tests must still
pass unchanged — they already supply the fields their variants now require.

- [ ] **Step 7: Type-check**

Run: `pnpm --filter @kumiai/hub-server exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`

Expected: clean. If `subjectOf` reports "not all code paths return a value", the switch is not
exhaustive over the union — fix the switch, do not add a `default`.

- [ ] **Step 8: Commit**

```bash
git add packages/hub-server/src/handlers.ts packages/hub-server/test/handlers-store-errors.test.ts
git commit -m "refactor(hub-server): make HubStoreErrorEvent a discriminated union"
```

---

### Task 2: A `getSubscribers` failure is reported, not raised

**Files:**
- Modify: `packages/hub-server/src/handlers.ts:373-393` (the fan-out block in `hub/v1/publish`)
- Test: `packages/hub-server/test/handlers-store-errors.test.ts`

**Interfaces:**
- Consumes: `HubStoreErrorEvent`'s `getSubscribers` variant and the reporter from Task 1. The local
  `storeErrorReporter` already exists in `createHandlers` at `:245`.
- Produces: no new exports. `hub/v1/publish` now resolves `{ sequenceID }` when
  `store.getSubscribers` throws.

- [ ] **Step 1: Write the failing test**

Add to `packages/hub-server/test/handlers-store-errors.test.ts`, as a new `describe` after the
existing ack block. The file's `failingStore` helper and `reqCtx` are already in scope. Add
`import { toB64 } from '@sozai/codec'` to the file's imports.

```ts
describe('a publish whose fan-out cannot read its subscribers still succeeds', () => {
  const PAYLOAD = toB64(new TextEncoder().encode('hello'))

  /**
   * `getSubscribers` runs AFTER `store.publish` committed the append and its delivery rows in one
   * transaction, so the frame is already durable for every subscriber. Failing the request would
   * report a lie AND make the loss permanent: the caller's `publishID` retry returns
   * `deduped: true`, which gates the whole fan-out block off.
   */
  test('the failure reaches the hook and the frame stays readable', async () => {
    const boom = new Error('subscriber index is gone')
    const store = failingStore('getSubscribers', boom)
    const seen: Array<HubStoreErrorEvent> = []
    const handlers = createHandlers({
      store,
      registry: new HubClientRegistry(),
      onStoreError: (event) => void seen.push(event),
    })

    await (handlers['hub/v1/subscribe'] as any)(
      reqCtx('hub/v1/subscribe', { topicID: 'topic-1' }, RECEIVER),
    )
    const result = await (handlers['hub/v1/publish'] as any)(
      reqCtx('hub/v1/publish', { topicID: 'topic-1', payload: PAYLOAD, retain: 'log' }),
    )

    expect(result).toMatchObject({ sequenceID: expect.any(String) })
    expect(seen).toEqual([{ method: 'getSubscribers', topicID: 'topic-1', error: boom }])

    // The point of the swallow: the frame is durable regardless of the failed live push, so the
    // subscriber gets it by pulling. An assertion that only checked the report would pass just as
    // well if the publish had silently dropped the frame.
    const fetched = await (handlers['hub/v1/topic/fetch'] as any)(
      reqCtx('hub/v1/topic/fetch', { topicID: 'topic-1' }, RECEIVER),
    )
    expect(fetched.messages).toHaveLength(1)
    expect(fetched.messages[0]).toMatchObject({ senderDID: REQUESTER, payload: PAYLOAD })
  })

  /** A hook is a notice, not a dependency — same rule as the other sites. */
  test('a hook that throws does not fail the publish', async () => {
    const store = failingStore('getSubscribers', new Error('subscriber index is gone'))
    const handlers = createHandlers({
      store,
      registry: new HubClientRegistry(),
      onStoreError: () => {
        throw new Error('the host reporting path is itself broken')
      },
    })

    const result = await (handlers['hub/v1/publish'] as any)(
      reqCtx('hub/v1/publish', { topicID: 'topic-1', payload: PAYLOAD, retain: 'log' }),
    )
    expect(result).toMatchObject({ sequenceID: expect.any(String) })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kumiai/hub-server exec vitest run test/handlers-store-errors.test.ts -t "fan-out"`

Expected: both FAIL — the publish rejects with `subscriber index is gone`, so neither `result` nor
the report is ever reached.

- [ ] **Step 3: Wrap the call**

In `packages/hub-server/src/handlers.ts`, replace the fan-out block. Old (`:377-379`, inside
`if (!deduped) {`):

```ts
        const logPosition = ctx.param.retain === 'log' ? { logPosition: sequenceID } : {}
        // Live-deliver to currently-connected subscribers (minus the sender).
        const subscribers = await store.getSubscribers(topicID)
```

New:

```ts
        const logPosition = ctx.param.retain === 'log' ? { logPosition: sequenceID } : {}
        // Live-deliver to currently-connected subscribers (minus the sender). A failure here must
        // not fail the request: `publish` committed the append and its delivery rows in one
        // transaction, so every subscriber still receives the frame from its mailbox on the next
        // receive drain. Failing would also make the miss permanent — the caller's `publishID`
        // retry returns `deduped`, and the block below is gated on `!deduped`.
        let subscribers: Array<string>
        try {
          subscribers = await store.getSubscribers(topicID)
        } catch (error) {
          storeErrorReporter({ method: 'getSubscribers', topicID, error })
          return { sequenceID }
        }
```

Leave the `for (const recipientDID of subscribers)` loop and the handler's trailing
`return { sequenceID }` exactly as they are.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kumiai/hub-server exec vitest run test/handlers-store-errors.test.ts`

Expected: PASS, whole file.

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @kumiai/hub-server exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`

Expected: clean.

- [ ] **Step 6: Mutation-check the guard**

Temporarily restore the unguarded line — replace the whole `let subscribers` / `try` / `catch` block
with `const subscribers = await store.getSubscribers(topicID)` — and re-run:

`pnpm --filter @kumiai/hub-server exec vitest run test/handlers-store-errors.test.ts -t "fan-out"`

Expected: FAIL, both cases, rejecting with `subscriber index is gone`. Restore the guard and confirm
green again. If the tests passed without the guard, the tests are wrong; fix them before continuing.

- [ ] **Step 7: Commit**

```bash
git add packages/hub-server/src/handlers.ts packages/hub-server/test/handlers-store-errors.test.ts
git commit -m "fix(hub-server): a fan-out read failure no longer fails a committed publish"
```

---

### Task 3: `unsubscribe` fails with a coded wire shape

**Files:**
- Modify: `packages/hub-server/src/handlers.ts:452-460` (`hub/v1/unsubscribe`)
- Test: `packages/hub-server/test/handlers.test.ts`

**Interfaces:**
- Consumes: the existing module-local `rethrowAsHandlerError(error: unknown): never` at `:203`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Add to `packages/hub-server/test/handlers.test.ts` as a new top-level `describe`. The file's
existing imports need two additions — its value import from `@kumiai/hub-protocol` currently reads
`{ HUB_ERROR_CODES, KeyPackageQuotaExceededError, keyPackageDigest }` and gains `NotSubscribedError`;
the file has no `HubStore` type import yet, so add one:

```ts
import type { HubStore } from '@kumiai/hub-protocol'
```

```ts
/**
 * `unsubscribe` was the one HubStore call in the file with no try/catch, so a named store error
 * crossed the wire uncoded — and a named store error has to stay tellable from an unreachable hub.
 * `HubStore.unsubscribe` declares no named error today, so this is defence against a store that
 * raises one anyway, not a port change.
 */
describe('a store failure during unsubscribe crosses the wire coded', () => {
  function unsubscribeFails(error: Error): HubStore {
    const store = createMemoryStore()
    return new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'unsubscribe') {
          return () => Promise.reject(error)
        }
        return Reflect.get(target, property, receiver)
      },
    })
  }

  test('a named store error carries its hub error code', async () => {
    const store = unsubscribeFails(new NotSubscribedError('not a subscriber of topic-1'))
    const handlers = createHandlers({ store, registry: new HubClientRegistry() })

    await expect(
      (handlers['hub/v1/unsubscribe'] as any)(reqCtx('hub/v1/unsubscribe', { topicID: 'topic-1' })),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.notSubscribed })
  })

  test('anything else passes through untouched', async () => {
    const boom = new Error('subscription table is gone')
    const handlers = createHandlers({
      store: unsubscribeFails(boom),
      registry: new HubClientRegistry(),
    })

    await expect(
      (handlers['hub/v1/unsubscribe'] as any)(reqCtx('hub/v1/unsubscribe', { topicID: 'topic-1' })),
    ).rejects.toBe(boom)
  })
})
```

- [ ] **Step 2: Run the tests to verify one fails**

Run: `pnpm --filter @kumiai/hub-server exec vitest run test/handlers.test.ts -t "crosses the wire coded"`

Expected: the named-error case FAILS — the rejection is the raw `NotSubscribedError`, which has no
`code` property. The pass-through case PASSES already; that is correct and it stays as the guard
that the fix does not over-wrap.

- [ ] **Step 3: Wrap the call**

In `packages/hub-server/src/handlers.ts`, replace line `:458`:

```ts
      await store.unsubscribe(clientDID, topicID)
```

with:

```ts
      try {
        await store.unsubscribe(clientDID, topicID)
      } catch (error) {
        rethrowAsHandlerError(error)
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kumiai/hub-server exec vitest run test/handlers.test.ts`

Expected: PASS, whole file.

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @kumiai/hub-server exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`

Expected: clean.

- [ ] **Step 6: Mutation-check the guard**

Temporarily restore the bare `await store.unsubscribe(clientDID, topicID)` and re-run:

`pnpm --filter @kumiai/hub-server exec vitest run test/handlers.test.ts -t "crosses the wire coded"`

Expected: the named-error case FAILS again. Restore the guard and confirm green.

- [ ] **Step 7: Commit**

```bash
git add packages/hub-server/src/handlers.ts packages/hub-server/test/handlers.test.ts
git commit -m "fix(hub-server): unsubscribe store failures cross the wire coded"
```

---

### Task 4: One reporter per hub, plus docs and changeset

**Files:**
- Modify: `packages/hub-server/src/hub.ts:76-113` (`createHub`)
- Modify: `packages/hub-server/README.md` (the "A store failure that is not a request failure"
  section, currently around `:87-115`)
- Create: `.changeset/hub-server-store-error-wire-shape.md`
- Modify: `docs/agents/plans/backlog/2026-07-29-hub-server-store-error-residuals.md`

**Interfaces:**
- Consumes: `createStoreErrorReporter` and `HubStoreErrorHook` from Task 1, both already imported
  by `hub.ts`.
- Produces: no signature change. `createHub` still accepts `onStoreError?: HubStoreErrorHook`;
  `createHandlers` still accepts the same. The reporter's own type IS `HubStoreErrorHook`, which is
  why it can be passed straight through.

There is no test step for the sharing itself: while the reporter is stateless, one instance and two
are observationally identical. This rests on the code shape and the comment, and the spec says so.
The existing `createHub` tests must keep passing, which is what Step 3 checks.

- [ ] **Step 1: Hoist the reporter**

In `packages/hub-server/src/hub.ts`, change the top of `createHub` (`:76-85`) from:

```ts
export function createHub(params: CreateHubParams): HubInstance {
  const registry = new HubClientRegistry()
  const handlers = createHandlers({
    registry,
    store: params.store,
    authorize: params.authorize,
    rateLimits: params.rateLimits,
    keyPackageFetchLimits: params.keyPackageFetchLimits,
    onStoreError: params.onStoreError,
  })
```

to:

```ts
export function createHub(params: CreateHubParams): HubInstance {
  const registry = new HubClientRegistry()
  // One reporter for the whole hub. Its type IS `HubStoreErrorHook`, so `createHandlers`' own
  // wrapper delegates to this instance rather than building a second one from the same hook —
  // which matters the moment a reporter holds state, as the throttling the README names would.
  const storeErrorReporter = createStoreErrorReporter(params.onStoreError)
  const handlers = createHandlers({
    registry,
    store: params.store,
    authorize: params.authorize,
    rateLimits: params.rateLimits,
    keyPackageFetchLimits: params.keyPackageFetchLimits,
    onStoreError: storeErrorReporter,
  })
```

- [ ] **Step 2: Delete the second instance**

In the same file, remove line `:103` — `const storeErrorReporter = createStoreErrorReporter(params.onStoreError)` —
from inside the `if (params.purge !== false) {` block. The `setInterval` callback below it keeps
calling `storeErrorReporter({ method: 'purge', error })` unchanged; it now closes over the hoisted
one.

- [ ] **Step 3: Run the full package test suite**

Run: `pnpm --filter @kumiai/hub-server exec vitest run`
Then: `pnpm --filter @kumiai/hub-server exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`

Expected: both clean. Nothing about hub behaviour changed, so any failure here is a real regression.

- [ ] **Step 4: Update the README**

In `packages/hub-server/README.md`, rewrite the section body. Replace `Three store operations are
deliberately not allowed to fail the request they happen in:` and its three bullets with:

```markdown
Four store operations are deliberately not allowed to fail the request they happen in:

- the **last-resort key-package top-up**, read after `fetchKeyPackages` has already consumed
  destructively — surfacing it would destroy packages nobody received, and the client's retry
  would burn the next batch
- an **ack**, where the frame simply stays pending and the client re-acks next round
- a scheduled **purge**, retried on the next interval
- the **subscriber read for live fan-out**, which runs after the publish committed its append and
  delivery rows — every subscriber still receives the frame by pulling, and failing the request
  would instead lose the live push for good, since the caller's `publishID` retry dedups and skips
  fan-out
```

Then replace the sentence `All three are correct, and all three were silent.` with `All four are
correct, and all four were silent.`, and replace `called with \`{ method, did?, error }\` where
\`method\` names the \`HubStore\` method that threw` with:

```markdown
called with an event discriminated on `method` — the `HubStore` method that threw — carrying the
subject that method has: `did` for `ack` and `fetchLastResortKeyPackage`, `topicID` for
`getSubscribers`, neither for `purge`.
```

Finally, update the example block so it destructures only what every variant has:

```ts
const { server } = createHub({
  transport,
  store,
  identity,
  onStoreError: (event) => metrics.storeFailure(event),
})
```

- [ ] **Step 5: Write the changeset**

Create `.changeset/hub-server-store-error-wire-shape.md`:

```markdown
---
'@kumiai/hub-server': minor
---

Every `HubStore` call in the hub's handlers now either fails the request with a coded wire shape or
is reported through `onStoreError`. Two did neither.

A failed subscriber read during publish fan-out no longer fails the publish. The append and its
delivery rows were already committed when that read runs, so every subscriber still receives the
frame from its mailbox — while failing the request lost the live push permanently, because the
caller's `publishID` retry dedups and skips fan-out entirely. The failure is now reported as
`{ method: 'getSubscribers', topicID, error }`.

A store failure during `hub/v1/unsubscribe` now crosses the wire with its hub error code, like
every other store failure, instead of propagating raw.

**Breaking:** `HubStoreErrorEvent` is a discriminated union on `method` rather than a flat
`{ method; did?; error }`. Each variant carries the subject its site has — `did` for `ack` and
`fetchLastResortKeyPackage`, `topicID` for the new `getSubscribers`, neither for `purge`. A hook
that read `event.did` unconditionally must narrow on `event.method` first.
```

- [ ] **Step 6: Close the residuals**

In `docs/agents/plans/backlog/2026-07-29-hub-server-store-error-residuals.md`, delete sections 1, 2
and 4 in full (they are implemented). Renumber the surviving section to `## 1.` and rewrite its
trigger so it says what actually fires it — replace the closing sentence `The fix, when a fourth
site arrives, is a site discriminator rather than a reused method key.` with:

```markdown
The trigger is not "a fourth site" — one arrived on 2026-07-29 (`getSubscribers`) and a
method-keyed union discriminated it correctly. The trigger is a *second reporting call site of one
method*: the moment either of the other two `fetchLastResortKeyPackage` calls starts reporting, it
inherits a sentence that is false for it, and the fix is a site discriminator alongside `method`.
```

Replace the file's opening paragraph — the one beginning `Four small items raised by the whole-branch
review` — with:

```markdown
One small item left from the whole-branch review of the `onStoreError` work. The other three closed
on 2026-07-29; see `docs/agents/plans/completed/`. Background:
`docs/agents/plans/completed/2026-07-29-errors-reach-a-sink.complete.md`.
```

- [ ] **Step 7: Run the whole repo gate**

Run, from the repo root:

```bash
pnpm exec turbo run test:types test:unit --force
rtk proxy pnpm run lint
```

Expected: all packages pass, and the turbo summary reads `Cached: 0` — a cached run proves nothing.
`--force` on turbo is required; `pnpm test -- --force` does not work in this repo.

- [ ] **Step 8: Commit**

```bash
git add packages/hub-server/src/hub.ts packages/hub-server/README.md \
  .changeset/hub-server-store-error-wire-shape.md \
  docs/agents/plans/backlog/2026-07-29-hub-server-store-error-residuals.md
git commit -m "refactor(hub-server): share one store-error reporter per hub"
```
