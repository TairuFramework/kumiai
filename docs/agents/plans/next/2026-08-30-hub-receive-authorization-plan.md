# Hub `receive` Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate `hub/v1/receive` delivery through the `authorize` hook — a coarse connect-time gate plus a per-frame, per-topic gate with a configurable TTL decision cache — so a removed member stops draining a topic's backlog and live deliveries.

**Architecture:** Two new `AuthorizeRequest` variants (`receive`, `receive/deliver`). The receive handler consults the hook once at channel open (uncached) and once per frame by `topicID` inside `pushWrite`'s serialized write chain (cached per `(did, topicID)`, short TTL). Deny skips the write and leaves the frame pending; hook rejection fails closed and tears the channel down. No hub-conformance change — `authorize` is a `createHub`/`createHandlers` option only.

**Tech Stack:** TypeScript, vitest, `@kumiai/hub-server`, `@kumiai/hub-protocol` (`HUB_ERROR_CODES`).

**Spec:** `docs/agents/plans/next/2026-08-30-hub-receive-authorization-design.md`

## Global Constraints

- pnpm only. Do not edit generated files (`lib/`).
- Lint via `rtk proxy pnpm run lint` (the `rtk` shim fakes plain `pnpm run lint` / `pnpm exec biome`).
- Run tests forced: `pnpm --filter @kumiai/hub-server test` must show `Cached: 0` (turbo caches; `pnpm test -- --force` is broken). To run one file, `cd packages/hub-server && pnpm exec vitest run test/<file>`.
- TS strictness applies: pair any code written into tests with a typecheck (`pnpm --filter @kumiai/hub-server exec tsc --noEmit` or the repo `test:types`), since vitest strips types.
- All 12 packages share one version band; do not touch versions here.
- The `authorize` hook default is allow-all (`params.authorize ?? (() => true)`), so a hub with no hook must behave exactly as before.

---

## File Structure

- `packages/hub-server/src/handlers.ts` — the whole change: two `AuthorizeRequest` variants, the connect gate, the per-frame `gate` + cache in the receive handler, the `receiveAuthCacheTTL` handler option and its validation.
- `packages/hub-server/src/hub.ts` — add `receiveAuthCacheTTL` to `CreateHubParams` and forward it into `createHandlers`; update the `authorize` doc comment.
- `packages/hub-server/test/handlers-receive.test.ts` — new tests (existing harness: `receiveCtx`, `collectingWritable`, `ackStream`, `createMemoryStore`, `HubClientRegistry`).
- `packages/hub-server/README.md` (if it enumerates authorized actions) — add the two receive actions.

---

## Task 1: `receive` variant + coarse connect gate

**Files:**
- Modify: `packages/hub-server/src/handlers.ts` (`AuthorizeRequest` union ~line 32; receive handler top ~line 541-545)
- Test: `packages/hub-server/test/handlers-receive.test.ts`

**Interfaces:**
- Consumes: `authorize` (already in scope in `createHandlers`, defaulted to allow-all at `handlers.ts:287`), `normalizeAuthorizeDecision` (`handlers.ts:76`), `HUB_ERROR_CODES.authorizationDenied`, `HandlerError`.
- Produces: `AuthorizeRequest` now includes `{ action: 'receive'; did: string }`. The receive handler rejects with a `HandlerError` (`authorizationDenied`) before registering any channel state when the hook denies `receive`.

- [ ] **Step 1: Write the failing tests**

Add to `handlers-receive.test.ts`:

```ts
import { HUB_ERROR_CODES } from '@kumiai/hub-protocol'

describe('hub/v1/receive connect gate', () => {
  test('a receive deny rejects the channel and registers no state', async () => {
    const store = createMemoryStore()
    const registry = new HubClientRegistry()
    const handlers = createHandlers({
      registry,
      store,
      authorize: (req) => req.action !== 'receive',
    })

    const written: Array<unknown> = []
    await expect(
      handlers['hub/v1/receive'](
        receiveCtx({ acks: ackStream([]), writable: collectingWritable(written) }),
      ),
    ).rejects.toMatchObject({ code: HUB_ERROR_CODES.authorizationDenied })

    expect(registry.isWriterBound(DID)).toBe(false)
    expect(registry.getClient(DID)).toBeUndefined()
    expect(written).toEqual([])
  })

  test('a receive allow lets the channel open (empty backlog drains clean)', async () => {
    const store = createMemoryStore()
    const registry = new HubClientRegistry()
    const seen: Array<AuthorizeRequestAction> = []
    const handlers = createHandlers({
      registry,
      store,
      authorize: (req) => {
        seen.push(req.action)
        return true
      },
    })

    const controller = new AbortController()
    const done = handlers['hub/v1/receive'](
      receiveCtx({
        acks: ackStream([]),
        signal: controller.signal,
        writable: collectingWritable([]),
      }),
    )
    await new Promise((r) => setTimeout(r, 20))
    controller.abort()
    await done

    expect(seen).toContain('receive')
  })
})
```

Add a local type alias near the top of the test file so the `seen` array is typed without importing internals: `type AuthorizeRequestAction = Parameters<NonNullable<Parameters<typeof createHandlers>[0]['authorize']>>[0]['action']`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/hub-server && pnpm exec vitest run test/handlers-receive.test.ts -t "connect gate"`
Expected: FAIL — the deny test resolves/hangs instead of rejecting (no gate yet); `seen` never contains `'receive'`.

- [ ] **Step 3: Add the union variant**

In `handlers.ts`, extend `AuthorizeRequest` (after the `wake/unregister` line ~57):

```ts
  | { action: 'receive'; did: string }
```

- [ ] **Step 4: Add the connect gate**

In the `hub/v1/receive` handler, immediately after `const clientDID = getClientDID(ctx)` and BEFORE `registry.register(clientDID)` (`handlers.ts:542-545`):

```ts
      const connectDecision = normalizeAuthorizeDecision(
        await authorize({ action: 'receive', did: clientDID }),
      )
      if (!connectDecision.allow) {
        throw new HandlerError({
          code: HUB_ERROR_CODES.authorizationDenied,
          message: connectDecision.reason ?? 'Not authorized to receive',
        })
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/hub-server && pnpm exec vitest run test/handlers-receive.test.ts -t "connect gate"`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @kumiai/hub-server exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/hub-server/src/handlers.ts packages/hub-server/test/handlers-receive.test.ts
git commit -m "feat(hub-server): gate hub/v1/receive at connect with the authorize hook"
```

---

## Task 2: `receive/deliver` variant + per-frame gate (default TTL cache)

**Files:**
- Modify: `packages/hub-server/src/handlers.ts` (`AuthorizeRequest` union; a new `DEFAULT_RECEIVE_AUTH_CACHE_TTL` constant near `DEFAULT_RECEIVE_BUFFER_LIMIT` ~line 215; the receive handler's `gate` closure and `pushWrite` ~line 586)
- Test: `packages/hub-server/test/handlers-receive.test.ts`

**Interfaces:**
- Consumes: `authorize`, `normalizeAuthorizeDecision`, the existing `pushWrite`/`onLive`/drain machinery, `registry.getClient(did)?.sendMessage(...)` for pushing a live frame in tests, `registry.isWriterBound(did)`.
- Produces: `AuthorizeRequest` includes `{ action: 'receive/deliver'; did: string; topicID: string }`. A per-channel `gate(did, topicID): Promise<boolean>` caches decisions for `DEFAULT_RECEIVE_AUTH_CACHE_TTL` (5000 ms) and is consulted before every socket write. Task 3 makes the TTL configurable via the same `gate`.

- [ ] **Step 1: Write the failing tests**

The drain path: seed the store with `store.publish` for the recipient's topic, or return frames from a stub `fetch`. Reuse the existing pattern — a store spread over `createMemoryStore()` with a scripted `fetch`. Add:

```ts
function backlogStore(messages: Array<StoredMessage>): HubStore {
  let done = false
  return {
    ...createMemoryStore(),
    async fetch(): Promise<FetchResult> {
      if (done) return { messages: [], cursor: null }
      done = true
      const cursor = messages.length > 0 ? messages[messages.length - 1].sequenceID : null
      return { messages, cursor } // no hasMore -> single page
    },
  } as HubStore
}

function msg(seq: string, topicID: string): StoredMessage {
  return { sequenceID: seq, senderDID: 'did:key:sender', topicID, payload: new Uint8Array([1]) }
}

async function runReceive(handlers: ReturnType<typeof createHandlers>, written: Array<unknown>) {
  const controller = new AbortController()
  const done = handlers['hub/v1/receive'](
    receiveCtx({ acks: ackStream([]), signal: controller.signal, writable: collectingWritable(written) }),
  )
  await new Promise((r) => setTimeout(r, 20))
  return { controller, done }
}

describe('hub/v1/receive per-frame gate', () => {
  test('a receive/deliver deny drops that topic from the backlog drain', async () => {
    const store = backlogStore([msg('000000000001', 'topicX'), msg('000000000002', 'topicY')])
    const registry = new HubClientRegistry()
    const handlers = createHandlers({
      registry,
      store,
      authorize: (req) =>
        !(req.action === 'receive/deliver' && req.topicID === 'topicX'),
    })
    const written: Array<{ topicID: string }> = []
    const { controller, done } = await runReceive(handlers, written)
    controller.abort()
    await done
    expect(written.map((f) => f.topicID)).toEqual(['topicY'])
  })

  test('topic isolation on a live stream: denied topic dropped, allowed topic delivered', async () => {
    const store = backlogStore([])
    const registry = new HubClientRegistry()
    const handlers = createHandlers({
      registry,
      store,
      authorize: (req) =>
        !(req.action === 'receive/deliver' && req.topicID === 'topicX'),
    })
    const written: Array<{ topicID: string }> = []
    const { controller, done } = await runReceive(handlers, written) // drains empty -> phase live
    registry.getClient(DID)?.sendMessage(msg('000000000003', 'topicX') as never)
    registry.getClient(DID)?.sendMessage(msg('000000000004', 'topicY') as never)
    await new Promise((r) => setTimeout(r, 20))
    controller.abort()
    await done
    expect(written.map((f) => f.topicID)).toEqual(['topicY'])
  })

  test('a hook that rejects mid-stream fails closed and tears the channel down', async () => {
    const store = backlogStore([msg('000000000001', 'topicX')])
    const registry = new HubClientRegistry()
    const handlers = createHandlers({
      registry,
      store,
      authorize: (req) => {
        if (req.action === 'receive/deliver') throw new Error('hook exploded')
        return true
      },
    })
    const written: Array<unknown> = []
    const { done } = await runReceive(handlers, written)
    await done // resolves via finish(), does not hang
    expect(registry.isWriterBound(DID)).toBe(false)
    expect(written).toEqual([])
  })

  test('a denied frame is not acked (stays pending for redelivery)', async () => {
    const store = backlogStore([msg('000000000001', 'topicX')])
    const ackSpy = vi.spyOn(store, 'ack')
    const registry = new HubClientRegistry()
    const handlers = createHandlers({
      registry,
      store,
      authorize: (req) => !(req.action === 'receive/deliver' && req.topicID === 'topicX'),
    })
    const written: Array<unknown> = []
    const { controller, done } = await runReceive(handlers, written)
    controller.abort()
    await done
    expect(ackSpy).not.toHaveBeenCalled()
  })
})
```

Note the `phase === 'draining'` buffered-live-flush path: cover it by racing a live `sendMessage` in while the first drain page is still awaiting, using the existing `drainGateStore` helper already in this file. Add one test that pauses the first page on a gate promise, pushes a denied `topicX` live frame during the pause, releases the gate, and asserts `topicX` never appears in `written` while an allowed backlog frame does.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/hub-server && pnpm exec vitest run test/handlers-receive.test.ts -t "per-frame gate"`
Expected: FAIL — denied topics are still written (no gate); the reject test may hang until the abort. This confirms the gap.

- [ ] **Step 3: Add the union variant + default TTL constant**

In `handlers.ts`, extend `AuthorizeRequest`:

```ts
  | { action: 'receive/deliver'; did: string; topicID: string }
```

Near `DEFAULT_RECEIVE_BUFFER_LIMIT` (~line 215):

```ts
/**
 * Default TTL (ms) for a receive channel's per-(did, topicID) delivery-authorization decision.
 * Bounds how long an already-resolved allow is reused before the hook is re-consulted — i.e. the
 * maximum window a removed member can keep draining a topic. See the receive handler's `gate`.
 */
export const DEFAULT_RECEIVE_AUTH_CACHE_TTL = 5000
```

- [ ] **Step 4: Add the `gate` closure in the receive handler**

Inside the `hub/v1/receive` handler, after `clientDID` is known (and after the connect gate from Task 1), add a per-channel cache and gate. For this task the TTL is the constant; Task 3 swaps it for the resolved option.

```ts
      // Per-(did, topicID) delivery-authorization cache, local to this channel (torn down with it).
      const authCache = new Map<string, { allow: boolean; expiresAt: number }>()
      const receiveAuthCacheTTL = DEFAULT_RECEIVE_AUTH_CACHE_TTL // Task 3: resolve from params
      const gate = async (topicID: string): Promise<boolean> => {
        const key = `${clientDID} ${topicID}`
        const now = Date.now()
        const cached = authCache.get(key)
        if (cached != null && cached.expiresAt > now) return cached.allow
        const decision = normalizeAuthorizeDecision(
          await authorize({ action: 'receive/deliver', did: clientDID, topicID }),
        )
        if (receiveAuthCacheTTL > 0) {
          authCache.set(key, { allow: decision.allow, expiresAt: now + receiveAuthCacheTTL })
        }
        return decision.allow
      }
```

- [ ] **Step 5: Fold the gate into `pushWrite`**

In `pushWrite` (`handlers.ts:586`), the check goes INSIDE the existing `try`, before `writer.ready`, so the early `return` still releases `pending` via `finally`:

```ts
        writeChain = writeChain.then(async () => {
          if (tornDown) return
          try {
            if (!(await gate(frame.topicID))) return // denied: skip, leave pending, no ack
            await writer.ready
            await writer.write(frame)
            if (frame.sequenceID > lastServed) lastServed = frame.sequenceID
          } catch {
            finish()
          } finally {
            pending--
          }
        })
```

(Only the added `if (!(await gate(...))) return` line and the wrapping are new; the `pending++` above the chain and everything else stay as-is. A hook that throws lands in the existing `catch` → `finish()`: fail-closed.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/hub-server && pnpm exec vitest run test/handlers-receive.test.ts -t "per-frame gate"`
Expected: PASS (all five: drain deny, live topic isolation, hook rejection teardown, denied-not-acked, buffered-flush deny).

- [ ] **Step 7: Run the full hub-server suite + typecheck**

Run: `pnpm --filter @kumiai/hub-server test` (confirm `Cached: 0`) and `pnpm --filter @kumiai/hub-server exec tsc --noEmit`
Expected: all pass — existing receive tests (ack loop, pre-aborted signal, drain-gate) unaffected, since with no `authorize` hook `gate` returns allow.

- [ ] **Step 8: Commit**

```bash
git add packages/hub-server/src/handlers.ts packages/hub-server/test/handlers-receive.test.ts
git commit -m "feat(hub-server): gate each receive delivery by topic via the authorize hook"
```

---

## Task 3: Configurable `receiveAuthCacheTTL`

**Files:**
- Modify: `packages/hub-server/src/handlers.ts` (`CreateHandlersParams` ~line 217; TTL resolution in `createHandlers` ~line 294; use it in the `gate` from Task 2)
- Modify: `packages/hub-server/src/hub.ts` (`CreateHubParams` ~line 39; forward into `createHandlers` ~line 104)
- Test: `packages/hub-server/test/handlers-receive.test.ts`, `packages/hub-server/test/hub.test.ts`

**Interfaces:**
- Consumes: the `gate`/`authCache` from Task 2.
- Produces: `CreateHandlersParams.receiveAuthCacheTTL?: number` and `CreateHubParams.receiveAuthCacheTTL?: number`. Resolution: finite `> 0` → that value; `0` → no reuse (hook every frame); `undefined`/non-finite/negative → `DEFAULT_RECEIVE_AUTH_CACHE_TTL`. `createHub` forwards the option into `createHandlers`.

- [ ] **Step 1: Write the failing tests**

In `handlers-receive.test.ts`:

```ts
describe('receiveAuthCacheTTL', () => {
  test('within the TTL, repeated same-topic frames consult the hook once', async () => {
    const store = backlogStore([])
    const registry = new HubClientRegistry()
    let deliverCalls = 0
    const handlers = createHandlers({
      registry,
      store,
      receiveAuthCacheTTL: 5000,
      authorize: (req) => {
        if (req.action === 'receive/deliver') deliverCalls++
        return true
      },
    })
    const written: Array<unknown> = []
    const { controller, done } = await runReceive(handlers, written)
    registry.getClient(DID)?.sendMessage(msg('000000000001', 'topicX') as never)
    registry.getClient(DID)?.sendMessage(msg('000000000002', 'topicX') as never)
    await new Promise((r) => setTimeout(r, 20))
    controller.abort()
    await done
    expect(written.length).toBe(2)
    expect(deliverCalls).toBe(1) // second frame hit the cache
  })

  test('TTL 0 disables reuse: every frame consults the hook', async () => {
    const store = backlogStore([])
    const registry = new HubClientRegistry()
    let deliverCalls = 0
    const handlers = createHandlers({
      registry,
      store,
      receiveAuthCacheTTL: 0,
      authorize: (req) => {
        if (req.action === 'receive/deliver') deliverCalls++
        return true
      },
    })
    const written: Array<unknown> = []
    const { controller, done } = await runReceive(handlers, written)
    registry.getClient(DID)?.sendMessage(msg('000000000001', 'topicX') as never)
    registry.getClient(DID)?.sendMessage(msg('000000000002', 'topicX') as never)
    await new Promise((r) => setTimeout(r, 20))
    controller.abort()
    await done
    expect(deliverCalls).toBe(2)
  })
})
```

For a non-finite/negative value falling back to the default, assert behavior equals the default (caches — one hook call for two same-topic frames) when passing `receiveAuthCacheTTL: -1` and `Number.POSITIVE_INFINITY` mapped through resolution. Since Infinity would be rejected to the default (finite 5000), a test passing `Number.POSITIVE_INFINITY` and pushing two frames expects `deliverCalls === 1` (cached, not permanent) — which also proves Infinity does NOT become a permanent allow.

In `hub.test.ts`, add a pass-through test: build a hub via `createHub` with `receiveAuthCacheTTL: 0` and an `authorize` counting `receive/deliver`, drive a receive channel through the hub's registry, push two same-topic frames, assert two hook calls (proving the option reached the handler; with the default it would be one). Follow the existing `hub.test.ts` setup for wiring a receive channel through `createHub`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/hub-server && pnpm exec vitest run test/handlers-receive.test.ts -t "receiveAuthCacheTTL" && pnpm exec vitest run test/hub.test.ts -t "receiveAuthCacheTTL"`
Expected: FAIL — `receiveAuthCacheTTL` is not a known param, so TS errors / the option is ignored (TTL 0 test still sees `deliverCalls === 1`).

- [ ] **Step 3: Add the resolver + handler param**

In `handlers.ts`, add to `CreateHandlersParams` (near `receiveBufferLimit` ~line 225):

```ts
  /**
   * TTL (ms) for the per-(did, topicID) receive delivery-authorization cache. `0` disables reuse
   * (the hook is consulted for every frame). Non-finite or negative values fall back to
   * {@link DEFAULT_RECEIVE_AUTH_CACHE_TTL}. Default: 5000.
   */
  receiveAuthCacheTTL?: number
```

Add a resolver (near the other module helpers, e.g. below `rethrowAsHandlerError`):

```ts
function resolveReceiveAuthCacheTTL(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_RECEIVE_AUTH_CACHE_TTL
  }
  return value // 0 allowed: no reuse
}
```

In `createHandlers` (near line 294):

```ts
  const receiveAuthCacheTTL = resolveReceiveAuthCacheTTL(params.receiveAuthCacheTTL)
```

- [ ] **Step 4: Use the resolved TTL in `gate`**

In the receive handler, replace the Task 2 placeholder line

```ts
      const receiveAuthCacheTTL = DEFAULT_RECEIVE_AUTH_CACHE_TTL // Task 3: resolve from params
```

by removing it and letting the `gate` close over the `receiveAuthCacheTTL` const now defined at `createHandlers` scope (Step 3). Confirm the `gate`'s `if (receiveAuthCacheTTL > 0)` guard now reads the resolved value.

- [ ] **Step 5: Add the `createHub` param + forwarding**

In `hub.ts`, add to `CreateHubParams` (near `keyPackageFetchLimits` ~line 57):

```ts
  /**
   * TTL (ms) for the per-(did, topicID) receive delivery-authorization cache. `0` consults the
   * hook for every frame. Forwarded to {@link createHandlers}. Default: 5000.
   */
  receiveAuthCacheTTL?: number
```

In the `createHandlers({...})` call (~line 104), add:

```ts
    receiveAuthCacheTTL: params.receiveAuthCacheTTL,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/hub-server && pnpm exec vitest run test/handlers-receive.test.ts -t "receiveAuthCacheTTL" && pnpm exec vitest run test/hub.test.ts -t "receiveAuthCacheTTL"`
Expected: PASS.

- [ ] **Step 7: Full suite + typecheck**

Run: `pnpm --filter @kumiai/hub-server test` (confirm `Cached: 0`) and `pnpm --filter @kumiai/hub-server exec tsc --noEmit`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/hub-server/src/handlers.ts packages/hub-server/src/hub.ts packages/hub-server/test
git commit -m "feat(hub-server): make receiveAuthCacheTTL configurable via createHub"
```

---

## Task 4: Documentation

**Files:**
- Modify: `packages/hub-server/src/hub.ts` (`CreateHubParams.authorize` doc ~line 49)
- Modify: `packages/hub-server/README.md` (only if it lists authorized actions)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the `authorize` doc comment**

In `hub.ts`, change the `authorize` doc (~line 49) from "Per-procedure publish/subscribe authorization" to name the full action set, e.g.:

```ts
  /**
   * Per-action authorization hook. Consulted for publish, subscribe, topic/fetch, keypackage/*,
   * wake/*, and receive — the coarse `receive` gate at channel open plus a per-frame
   * `receive/deliver` gate by topic (see {@link CreateHubParams.receiveAuthCacheTTL}). Defaults to
   * allow-any-authed.
   */
  authorize?: AuthorizeHook
```

- [ ] **Step 2: Update the README action list if present**

Run: `grep -n "topic/fetch\|keypackage/upload\|authorize" packages/hub-server/README.md`
If an action list exists, add `receive` and `receive/deliver` with a one-line note that receive gating is per-frame by topic with a TTL cache. If no such list exists, skip — do not invent a section.

- [ ] **Step 3: Lint the touched files**

Run: `rtk proxy pnpm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/hub-server/src/hub.ts packages/hub-server/README.md
git commit -m "docs(hub-server): document receive authorization actions and TTL"
```

---

## Verification (whole branch)

- [ ] `pnpm --filter @kumiai/hub-server test` shows `Cached: 0` and all green.
- [ ] `pnpm --filter @kumiai/hub-server exec tsc --noEmit` clean.
- [ ] `rtk proxy pnpm run lint` clean.
- [ ] The design's security guarantee holds in tests: no `receive/deliver`-denied payload appears in `written`, across drain, buffered-flush, and live paths.
- [ ] A hub with no `authorize` hook delivers all frames unchanged (existing receive tests still pass).

## Out of scope (do not implement)

- Recipient wake authorization (the publish-path `notify` remains gated only by the publisher's action — metadata-only leak, deferred per spec).
- Ack-eligibility tracking (client acks stay unrestricted).
- Any hub-conformance / test-double change (`authorize` is not part of that contract).
