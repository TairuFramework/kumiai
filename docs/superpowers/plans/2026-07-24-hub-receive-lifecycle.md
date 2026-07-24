# Hub receive lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** qa
**Mode:** tasks
**Spec:** `docs/superpowers/specs/2026-07-24-hub-receive-lifecycle-design.md`

**Goal:** Fix five correctness/hardening findings in the hub `receive`/`publish` lifecycle so the push lane delivers each frame exactly once, in order, with bounded memory and typed errors.

**Architecture:** All changes are in `packages/hub-server/src/handlers.ts` plus one new error code in `packages/hub-protocol/src/errors.ts`. The `hub/v1/receive` handler gains a two-phase delivery state machine (buffer live pushes during the backlog drain, flush deduped afterward, then pass through) with a bounded write queue that tears the channel down on saturation or write failure. Smaller independent fixes: a pre-aborted-signal check, ack-loop error isolation, and a decode guard.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, biome, pnpm. Enkaku server `ChannelHandler`/`HandlerError`, `@sozai/codec` (`fromB64`/`toB64`), `@kumiai/hub-protocol` store + error types.

## Global Constraints

- pnpm only. Do not edit generated files (`lib/`).
- Conventions (kigu): no `interface` (use `type`), no `any`, no `T[]` (use `Array<T>`), no lowercase acronyms, ES `#fields`, `readonly` where applicable.
- Cross-repo deps via catalog `^` ranges; internal `@kumiai/*` deps `workspace:^`. (No dependency changes in this plan.)
- Run scripts as `rtk proxy pnpm run <script>` or invoke the tool directly (`pnpm exec biome check ...`) — the `rtk` shim otherwise redirects to the wrong tool.
- Test command for this package: `pnpm --filter @kumiai/hub-server run test:unit` (vitest). Type check: `pnpm --filter @kumiai/hub-server run test:types`.
- New error code name: `HUB_INVALID_PAYLOAD` (in the `HUB_*` family, not enkaku's `EK0x`). New handler param: `receiveBufferLimit`, default `256`.
- Commit after each task. Commit trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01NirjQJHiZ6thVWQL1qFGvY
  ```

---

## File Structure

- `packages/hub-protocol/src/errors.ts` — add `HUB_INVALID_PAYLOAD` code, `InvalidPayloadError` class, and both round-trip mappings (Task 1).
- `packages/hub-server/src/handlers.ts` — the five handler fixes (Tasks 2–5). Order: M3 decode guard, M1 ack loop, H2 pre-abort, then H1+H3 receive rewrite last (largest, shares the write path).
- `packages/hub-server/test/hub.test.ts` — integration tests for M3 and the receive lifecycle (added per task).
- `packages/hub-server/test/handlers-receive.test.ts` — new file: deterministic unit tests that drive `hub/v1/receive` directly with hand-built streams (Tasks 3, 4, 5) where timing must be controlled.

---

### Task 1: `HUB_INVALID_PAYLOAD` error code (M3, part 1)

**Files:**
- Modify: `packages/hub-protocol/src/errors.ts`
- Test: `packages/hub-protocol/test/errors.test.ts` (create if absent; otherwise add to it)

**Interfaces:**
- Consumes: nothing.
- Produces: `HUB_ERROR_CODES.invalidPayload === 'HUB_INVALID_PAYLOAD'`; `class InvalidPayloadError extends Error` (name `'InvalidPayloadError'`); `hubErrorCodeOf(new InvalidPayloadError()) === 'HUB_INVALID_PAYLOAD'`; `hubErrorFromCode('HUB_INVALID_PAYLOAD', msg) instanceof InvalidPayloadError`.

- [ ] **Step 1: Check for an existing errors test file**

Run: `ls packages/hub-protocol/test/ 2>/dev/null`
If `errors.test.ts` exists, add the test below to it; otherwise create it with the imports shown.

- [ ] **Step 2: Write the failing test**

Create/append `packages/hub-protocol/test/errors.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import {
  HUB_ERROR_CODES,
  hubErrorCodeOf,
  hubErrorFromCode,
  InvalidPayloadError,
} from '../src/errors.js'

describe('InvalidPayloadError', () => {
  test('has a stable code and round-trips through the wire code', () => {
    expect(HUB_ERROR_CODES.invalidPayload).toBe('HUB_INVALID_PAYLOAD')

    const error = new InvalidPayloadError('bad base64')
    expect(error.name).toBe('InvalidPayloadError')
    expect(hubErrorCodeOf(error)).toBe('HUB_INVALID_PAYLOAD')

    const rebuilt = hubErrorFromCode('HUB_INVALID_PAYLOAD', 'bad base64')
    expect(rebuilt).toBeInstanceOf(InvalidPayloadError)
    expect(rebuilt?.message).toBe('bad base64')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @kumiai/hub-protocol run test:unit -- errors`
Expected: FAIL — `InvalidPayloadError` is not exported / `invalidPayload` undefined.

- [ ] **Step 4: Implement the code, class, and round-trip**

In `packages/hub-protocol/src/errors.ts`, add to `HUB_ERROR_CODES`:

```ts
export const HUB_ERROR_CODES = {
  headMismatch: 'HUB_HEAD_MISMATCH',
  notSubscribed: 'HUB_NOT_SUBSCRIBED',
  retentionExceeded: 'HUB_RETENTION_EXCEEDED',
  invalidPayload: 'HUB_INVALID_PAYLOAD',
} as const
```

Add the class (next to the other error classes):

```ts
/** A published payload was not decodable (e.g. malformed base64). The request is refused. */
export class InvalidPayloadError extends Error {
  override name = 'InvalidPayloadError'
}
```

Add the mapping in `hubErrorCodeOf` (before the `return null`):

```ts
  if (error instanceof InvalidPayloadError) return HUB_ERROR_CODES.invalidPayload
```

Add the case in `hubErrorFromCode` (before `default`):

```ts
    case HUB_ERROR_CODES.invalidPayload:
      return new InvalidPayloadError(message)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @kumiai/hub-protocol run test:unit -- errors`
Expected: PASS.

- [ ] **Step 6: Verify the export is public**

Confirm `packages/hub-protocol/src/index.ts` re-exports `InvalidPayloadError` (it should already `export * from './errors.js'` or list the classes). If the file lists error classes explicitly, add `InvalidPayloadError` to that list. Then:

Run: `pnpm --filter @kumiai/hub-protocol run test:types`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/hub-protocol/src/errors.ts packages/hub-protocol/src/index.ts packages/hub-protocol/test/errors.test.ts
git commit -m "feat(hub-protocol): add HUB_INVALID_PAYLOAD error code and class"
```

---

### Task 2: Guard `fromB64` in the publish handler (M3, part 2)

**Files:**
- Modify: `packages/hub-server/src/handlers.ts` (publish handler, around line 169)
- Test: `packages/hub-server/test/hub.test.ts`

**Interfaces:**
- Consumes: `InvalidPayloadError` from `@kumiai/hub-protocol` (Task 1); the existing `rethrowAsHandlerError` helper (`handlers.ts:107-117`), which already maps hub errors to `HandlerError` via `hubErrorCodeOf`.
- Produces: a publish with malformed base64 rejects with a `HandlerError` whose `code` is `HUB_INVALID_PAYLOAD`.

- [ ] **Step 1: Write the failing test**

Append to the `describe('hub pub/sub', ...)` block in `packages/hub-server/test/hub.test.ts`:

```ts
test('a malformed base64 payload is refused with HUB_INVALID_PAYLOAD', async () => {
  const ctx = createTestHub()
  const { client: alice } = ctx.connect()

  await expect(
    alice.request('hub/v1/publish', {
      param: { topicID: TOPIC, payload: '!!!not base64!!!' },
    }),
  ).rejects.toMatchObject({ code: 'HUB_INVALID_PAYLOAD' })

  await ctx.dispose()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kumiai/hub-server run test:unit -- hub`
Expected: FAIL — the raw `fromB64` decode error surfaces without the `HUB_INVALID_PAYLOAD` code.

- [ ] **Step 3: Add the import**

In `packages/hub-server/src/handlers.ts`, extend the `@kumiai/hub-protocol` import to include the class:

```ts
import { hubErrorCodeOf, InvalidPayloadError } from '@kumiai/hub-protocol'
```

(Keep the existing type-only import line for `HubProtocol, HubStore, StoredMessage` as is.)

- [ ] **Step 4: Wrap the decode**

Replace the single decode line in the `hub/v1/publish` handler:

```ts
      const payloadBytes = fromB64(payload)
```

with:

```ts
      let payloadBytes: Uint8Array
      try {
        payloadBytes = fromB64(payload)
      } catch (error) {
        rethrowAsHandlerError(
          new InvalidPayloadError(
            error instanceof Error ? error.message : 'Invalid base64 payload encoding',
          ),
        )
      }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @kumiai/hub-server run test:unit -- hub`
Expected: PASS. Run `pnpm --filter @kumiai/hub-server run test:types` — Expected: PASS (note `rethrowAsHandlerError` returns `never`, so `payloadBytes` is definitely assigned).

- [ ] **Step 6: Commit**

```bash
git add packages/hub-server/src/handlers.ts packages/hub-server/test/hub.test.ts
git commit -m "fix(hub-server): refuse malformed publish payloads with HUB_INVALID_PAYLOAD"
```

---

### Task 3: Isolate ack-loop errors (M1)

**Files:**
- Modify: `packages/hub-server/src/handlers.ts` (ack loop in the `hub/v1/receive` handler, currently `359-371`)
- Test: `packages/hub-server/test/handlers-receive.test.ts` (create)

**Interfaces:**
- Consumes: `createHandlers`, `HubClientRegistry`, `createMemoryStore`.
- Produces: a `store.ack` that throws on one call does not stop the loop from applying later acks.

- [ ] **Step 1: Write the failing test**

Create `packages/hub-server/test/handlers-receive.test.ts`. This drives the receive channel handler directly with hand-built streams so ack timing is deterministic:

```ts
import type { HubStore, StoredMessage } from '@kumiai/hub-protocol'
import { describe, expect, test, vi } from 'vitest'

import { createHandlers } from '../src/handlers.js'
import { createMemoryStore } from '../src/memoryStore.js'
import { HubClientRegistry } from '../src/registry.js'

const DID = 'did:key:receiver'

function receiveCtx(params: {
  did?: string
  after?: string
  acks: ReadableStream<{ ack: Array<string> }>
  signal?: AbortSignal
  writable: WritableStream<StoredMessage>
}) {
  return {
    message: { header: {}, payload: { typ: 'channel', prc: 'hub/v1/receive', rid: '1', iss: params.did ?? DID } },
    param: params.after != null ? { after: params.after } : {},
    signal: params.signal ?? new AbortController().signal,
    writable: params.writable,
    readable: params.acks,
  } as never
}

/** A writable that records every frame written and resolves each write immediately. */
function collectingWritable(sink: Array<unknown>): WritableStream {
  return new WritableStream({
    write(chunk) {
      sink.push(chunk)
    },
  })
}

/** A readable that emits the given ack messages then closes. */
function ackStream(acks: Array<{ ack: Array<string> }>): ReadableStream<{ ack: Array<string> }> {
  return new ReadableStream({
    start(controller) {
      for (const ack of acks) controller.enqueue(ack)
      controller.close()
    },
  })
}

describe('hub/v1/receive ack loop', () => {
  test('a store.ack failure does not stop later acks from being applied', async () => {
    const store = createMemoryStore()
    const applied: Array<Array<string>> = []
    let calls = 0
    vi.spyOn(store, 'ack').mockImplementation(async (params) => {
      calls++
      if (calls === 1) throw new Error('transient ack failure')
      applied.push(params.sequenceIDs)
    })
    const registry = new HubClientRegistry()
    const handlers = createHandlers({ registry, store })

    const controller = new AbortController()
    const written: Array<unknown> = []
    const done = handlers['hub/v1/receive'](
      receiveCtx({
        acks: ackStream([{ ack: ['000000000001'] }, { ack: ['000000000002'] }]),
        signal: controller.signal,
        writable: collectingWritable(written),
      }),
    )

    // Let the drain (empty backlog) finish and the ack loop consume both messages.
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await done

    // First ack threw; the second was still applied — the loop did not exit on the failure.
    expect(applied).toEqual([['000000000002']])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kumiai/hub-server run test:unit -- handlers-receive`
Expected: FAIL — the current `catch { /* Channel closed */ }` wraps the whole loop, so the throwing `store.ack` exits it and the second ack is never applied (`applied` is `[]`).

- [ ] **Step 3: Rewrite the ack loop**

Replace the detached ack loop in the `hub/v1/receive` handler:

```ts
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (value?.ack != null) {
              await store.ack({ recipientDID: clientDID, sequenceIDs: value.ack })
            }
          }
        } catch {
          // Channel closed
        }
      })()
```

with a version that only treats a `reader.read()` error as a close, and isolates `store.ack` failures:

```ts
      void (async () => {
        while (true) {
          let result: { done: boolean; value?: { ack?: Array<string> } }
          try {
            result = await reader.read()
          } catch {
            break // reader errored: the channel is closed
          }
          if (result.done) break
          const ack = result.value?.ack
          if (ack != null) {
            try {
              await store.ack({ recipientDID: clientDID, sequenceIDs: ack })
            } catch {
              // A failed ack is safe to drop: the frame stays pending and the client re-acks it on
              // its next ack round. Do NOT break — that would silently stop all later acks.
            }
          }
        }
      })()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kumiai/hub-server run test:unit -- handlers-receive`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub-server/src/handlers.ts packages/hub-server/test/handlers-receive.test.ts
git commit -m "fix(hub-server): isolate store.ack failures from channel close in receive"
```

---

### Task 4: Pre-aborted signal cleanup (H2)

**Files:**
- Modify: `packages/hub-server/src/handlers.ts` (end of `hub/v1/receive`, currently `373-386`)
- Test: `packages/hub-server/test/handlers-receive.test.ts`

**Interfaces:**
- Consumes: the helpers from Task 3's test file.
- Produces: when `ctx.signal` is already aborted, the handler runs cleanup (releases the registry writer, unregisters the idle DID) and resolves rather than leaking.

- [ ] **Step 1: Write the failing test**

Append to `packages/hub-server/test/handlers-receive.test.ts`:

```ts
describe('hub/v1/receive pre-aborted signal', () => {
  test('an already-aborted signal runs cleanup and resolves without leaking the writer', async () => {
    const store = createMemoryStore()
    const registry = new HubClientRegistry()
    const handlers = createHandlers({ registry, store })

    const controller = new AbortController()
    controller.abort() // aborted BEFORE the handler runs

    const written: Array<unknown> = []
    const done = handlers['hub/v1/receive'](
      receiveCtx({
        acks: ackStream([]),
        signal: controller.signal,
        writable: collectingWritable(written),
      }),
    )

    // Resolves promptly (cleanup ran); does not hang forever.
    await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('handler leaked: never resolved')), 100)),
    ])

    // The registry entry is gone — no bound writer left behind.
    expect(registry.isWriterBound(DID)).toBe(false)
    expect(registry.getClient(DID)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kumiai/hub-server run test:unit -- handlers-receive`
Expected: FAIL — with no `signal.aborted` check, the abort listener registered on an already-aborted signal never fires, `done` never resolves, and the 100ms race rejects with "handler leaked".

- [ ] **Step 3: Add the pre-abort check**

In the returned `Promise` at the end of `hub/v1/receive`, before registering the abort listener:

```ts
      return new Promise((resolve) => {
        const finish = (): void => {
          if (token != null) registry.releaseReceiveWriter(clientDID, token)
          registry.unregisterIfIdle(clientDID)
          reader.cancel().catch(() => {})
          writer.close().catch(() => {})
          resolve(undefined as never)
        }
        // An already-aborted signal never fires 'abort'; run cleanup now or the writer, reader, and
        // registry entry leak forever.
        if (ctx.signal.aborted) {
          finish()
          return
        }
        void evictedHere.then(finish)
        ctx.signal.addEventListener('abort', finish, { once: true })
      })
```

(Only the `if (ctx.signal.aborted) { finish(); return }` block is new; the rest is unchanged from the current handler.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kumiai/hub-server run test:unit -- handlers-receive`
Expected: PASS. Then run the full file plus `hub` to confirm no regression: `pnpm --filter @kumiai/hub-server run test:unit -- "handlers-receive|hub"`.

- [ ] **Step 5: Commit**

```bash
git add packages/hub-server/src/handlers.ts packages/hub-server/test/handlers-receive.test.ts
git commit -m "fix(hub-server): run receive cleanup on an already-aborted signal"
```

---

### Task 5: Buffered-flush delivery + backpressure (H1 + H3)

This is the core change. H1 (no dup/unordered) and H3 (bounded memory, no swallowed writes) share the receive handler's write path, so they land together.

**Files:**
- Modify: `packages/hub-server/src/handlers.ts` — add `receiveBufferLimit` to `CreateHandlersParams` + a default constant; rewrite the body of `hub/v1/receive` (drain + live delivery + teardown). The ack-loop (Task 3) and pre-abort check (Task 4) are preserved.
- Test: `packages/hub-server/test/handlers-receive.test.ts` and `packages/hub-server/test/hub.test.ts`

**Interfaces:**
- Consumes: `HubClientRegistry.bindReceiveWriter/releaseReceiveWriter/unregisterIfIdle/getClient`, `store.fetch({ recipientDID, after?, limit })` returning `{ messages: Array<StoredMessage>, cursor: string | null, hasMore?: boolean }`, `toB64`.
- Produces:
  - `CreateHandlersParams` gains `receiveBufferLimit?: number` (default `DEFAULT_RECEIVE_BUFFER_LIMIT = 256`).
  - A frame published while a receiver is draining its backlog is delivered exactly once and after the backlog frames (ordered).
  - When queued-but-unflushed frames exceed `receiveBufferLimit`, or a write rejects, the channel tears down (registry writer released, DID unregistered, writer aborted) and the frames stay pending in the store for the next connect.

- [ ] **Step 1: Write the failing tests**

Append to `packages/hub-server/test/handlers-receive.test.ts` two deterministic unit tests. They use a fake store whose `fetch` pauses mid-drain, and drive a live push through the registry during that pause — reproducing the publish-during-drain race:

```ts
import type { FetchParams, FetchResult } from '@kumiai/hub-protocol'

/** A store whose `fetch` returns a controllable multi-page backlog and pauses on a gate. */
function drainGateStore(pages: Array<Array<StoredMessage>>, gate: Promise<void>): {
  store: HubStore
  fetchCalls: () => number
} {
  let call = 0
  const store = {
    ...createMemoryStore(),
    async fetch(_params: FetchParams): Promise<FetchResult> {
      const index = call++
      if (index === 0) await gate // pause during the first page so a live push can race in
      const messages = pages[index] ?? []
      const cursor = messages.length > 0 ? messages[messages.length - 1].sequenceID : null
      const hasMore = index < pages.length - 1
      return hasMore ? { messages, cursor, hasMore: true } : { messages, cursor }
    },
  } as HubStore
  return { store, fetchCalls: () => call }
}

function frame(seq: string, topic = 'topic:1'): StoredMessage {
  return { sequenceID: seq, senderDID: 'did:key:alice', topicID: topic, payload: new Uint8Array([1]) }
}

describe('hub/v1/receive delivery ordering (H1)', () => {
  test('a frame pushed live during the drain is delivered once, after the backlog, in order', async () => {
    let openGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    const { store } = drainGateStore([[frame('000000000001'), frame('000000000002')]], gate)
    const registry = new HubClientRegistry()
    const handlers = createHandlers({ registry, store })

    const controller = new AbortController()
    const written: Array<{ sequenceID: string }> = []
    const done = handlers['hub/v1/receive'](
      receiveCtx({ acks: ackStream([]), signal: controller.signal, writable: collectingWritable(written) as WritableStream }),
    )

    // While the drain is paused on the gate, a publish live-pushes seq 3 (newer than the backlog).
    await new Promise((resolve) => setTimeout(resolve, 10))
    registry.getClient(DID)?.sendMessage?.(frame('000000000003'))
    openGate()

    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort()
    await done

    // Exactly once each, in sequence order: backlog (1,2) then the live frame (3). No duplicate 3.
    expect(written.map((m) => m.sequenceID)).toEqual(['000000000001', '000000000002', '000000000003'])
  })

  test('a live frame that is ALSO in the backlog is delivered once (deduped by lastServed)', async () => {
    let openGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    // seq 2 is both pushed live during the drain AND present in the second backlog page.
    const { store } = drainGateStore(
      [[frame('000000000001')], [frame('000000000002')]],
      gate,
    )
    const registry = new HubClientRegistry()
    const handlers = createHandlers({ registry, store })

    const controller = new AbortController()
    const written: Array<{ sequenceID: string }> = []
    const done = handlers['hub/v1/receive'](
      receiveCtx({ acks: ackStream([]), signal: controller.signal, writable: collectingWritable(written) as WritableStream }),
    )

    await new Promise((resolve) => setTimeout(resolve, 10))
    registry.getClient(DID)?.sendMessage?.(frame('000000000002')) // duplicate of the 2nd page
    openGate()

    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort()
    await done

    expect(written.map((m) => m.sequenceID)).toEqual(['000000000001', '000000000002'])
  })
})

describe('hub/v1/receive backpressure (H3)', () => {
  test('a stalled writer over the buffer limit tears down and releases the registry writer', async () => {
    const store = createMemoryStore()
    const registry = new HubClientRegistry()
    const handlers = createHandlers({ registry, store, receiveBufferLimit: 4 })

    const controller = new AbortController()
    // A writable whose writes never resolve: the write queue backs up.
    const stalled = new WritableStream({ write() { return new Promise<void>(() => {}) } })
    const done = handlers['hub/v1/receive'](
      receiveCtx({ acks: ackStream([]), signal: controller.signal, writable: stalled }),
    )

    await new Promise((resolve) => setTimeout(resolve, 10)) // empty backlog → live phase
    // Push more than the limit; the queue exceeds receiveBufferLimit and teardown fires.
    for (let i = 1; i <= 8; i++) {
      registry.getClient(DID)?.sendMessage?.(frame(String(i).padStart(12, '0')))
    }

    await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('never tore down')), 200)),
    ])

    expect(registry.isWriterBound(DID)).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @kumiai/hub-server run test:unit -- handlers-receive`
Expected: FAIL — the current handler binds the live writer before draining with no buffering, so the ordering test sees the live frame interleaved/duplicated; `receiveBufferLimit` is not a param, so the backpressure test's handler never tears down (the stalled writer's `.catch(() => {})` swallows nothing because writes never reject — it hangs).

- [ ] **Step 3: Add the param and default**

In `packages/hub-server/src/handlers.ts`, add the default constant near `DEFAULT_RATE_LIMITS`:

```ts
/** Max frames queued-but-unflushed on a single receive channel before it falls back to the store. */
export const DEFAULT_RECEIVE_BUFFER_LIMIT = 256
```

Add the field to `CreateHandlersParams`:

```ts
export type CreateHandlersParams = {
  registry: HubClientRegistry
  store: HubStore
  authorize?: AuthorizeHook
  rateLimits?: Partial<HubRateLimits>
  keyPackageFetchLimits?: Partial<KeyPackageFetchLimits>
  receiveBufferLimit?: number
}
```

In `createHandlers`, read it near the other param defaults:

```ts
  const receiveBufferLimit = params.receiveBufferLimit ?? DEFAULT_RECEIVE_BUFFER_LIMIT
```

Export the constant from `packages/hub-server/src/index.ts` alongside the other `DEFAULT_*` exports.

- [ ] **Step 4: Add a frame helper**

Add a module-level helper in `handlers.ts` (above `createHandlers`), to build the wire frame once for both the drain and live paths:

```ts
type ReceiveFrame = {
  sequenceID: string
  senderDID: string
  topicID: string
  payload: string
  logPosition?: string
}

function toReceiveFrame(message: StoredMessage): ReceiveFrame {
  return {
    sequenceID: message.sequenceID,
    senderDID: message.senderDID,
    topicID: message.topicID,
    payload: toB64(message.payload),
    // Spread, not assignment — `logPosition: undefined` would serialize as a present key, defeating
    // the field's absent-vs-present meaning.
    ...(message.logPosition != null ? { logPosition: message.logPosition } : {}),
  }
}
```

- [ ] **Step 5: Rewrite the `hub/v1/receive` body**

Replace the entire `hub/v1/receive` handler body (from `const clientDID = getClientDID(ctx)` through the final returned `Promise`) with the state-machine version below. The ack loop keeps the Task 3 shape; the pre-abort check keeps the Task 4 shape; both are folded in here:

```ts
    'hub/v1/receive': (async (ctx) => {
      const clientDID = getClientDID(ctx)
      const { after } = ctx.param ?? {}

      registry.register(clientDID)

      const writer = ctx.writable.getWriter()
      const reader = ctx.readable.getReader()

      let endEvicted: (() => void) | undefined
      const evictedHere = new Promise<void>((resolve) => {
        endEvicted = resolve
      })
      let receiveToken: symbol | undefined

      // Delivery state machine (H1) + bounded write queue (H3).
      // - DRAINING: live pushes buffer instead of writing; the drain writes the backlog in order.
      // - after the drain: flush buffered frames with sequenceID > lastServed (the dedup), then LIVE.
      // - LIVE: live pushes write directly.
      let phase: 'draining' | 'live' = 'draining'
      const liveBuffer: Array<ReceiveFrame> = []
      let lastServed = '' // highest sequenceID written; '' precedes every real (zero-padded) ID
      let pending = 0 // frames queued or mid-write but not yet flushed to the socket
      let tornDown = false
      let writeChain: Promise<void> = Promise.resolve()

      let resolveDone: () => void = () => {}
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve
      })

      // Idempotent teardown, shared by every failure and end path. Frames stay pending in the store
      // and redeliver on the next connect (store-and-forward).
      function finish(): void {
        if (tornDown) return
        tornDown = true
        if (receiveToken != null) registry.releaseReceiveWriter(clientDID, receiveToken)
        registry.unregisterIfIdle(clientDID)
        reader.cancel().catch(() => {})
        writer.abort(new Error('receive channel torn down')).catch(() => {})
        resolveDone()
      }

      // Serialize writes one at a time (preserves order). Over the cap or on a write rejection, tear
      // the channel down rather than swallow the error or grow without bound.
      function pushWrite(frame: ReceiveFrame): void {
        if (tornDown) return
        pending++
        if (pending > receiveBufferLimit) {
          finish()
          return
        }
        writeChain = writeChain.then(async () => {
          if (tornDown) return
          try {
            await writer.ready
            await writer.write(frame)
            if (frame.sequenceID > lastServed) lastServed = frame.sequenceID
          } catch {
            finish()
          } finally {
            pending--
          }
        })
      }

      // The registry callback (publish fan-out). Buffers during the drain, writes once live.
      const onLive = (message: StoredMessage): void => {
        const frame = toReceiveFrame(message)
        if (phase === 'draining') {
          liveBuffer.push(frame)
        } else {
          pushWrite(frame)
        }
      }

      try {
        const { token, evicted } = registry.bindReceiveWriter(clientDID, onLive, () => endEvicted?.())
        receiveToken = token
        // After the bind, so the lane is never unheld between the two.
        evicted?.()

        // Drain the backlog. Await each page so lastServed is exact before the flush.
        let cursor: string | null | undefined = after
        while (!tornDown) {
          const result = await store.fetch({
            recipientDID: clientDID,
            after: cursor ?? undefined,
            limit: 50,
          })
          for (const msg of result.messages) {
            pushWrite(toReceiveFrame(msg))
          }
          await writeChain
          cursor = result.cursor
          if (!result.hasMore) break
        }

        // Flush frames that arrived live during the drain, deduped against what the drain served,
        // then go live. The flip is synchronous (no await between the flush enqueue and the
        // assignment) so a concurrently-firing onLive cannot write ahead of the flush.
        if (!tornDown) {
          for (const frame of liveBuffer) {
            if (frame.sequenceID > lastServed) pushWrite(frame)
          }
          liveBuffer.length = 0
          await writeChain
          phase = 'live'
        }
      } catch (error) {
        // A synchronous drain error (e.g. store.fetch threw): clean up and reject the handler.
        if (receiveToken != null) registry.releaseReceiveWriter(clientDID, receiveToken)
        registry.unregisterIfIdle(clientDID)
        reader.cancel().catch(() => {})
        writer.abort(error).catch(() => {})
        throw error
      }

      // Ack loop (M1): a store.ack failure must not stop later acks; only a reader error closes.
      void (async () => {
        while (true) {
          let result: { done: boolean; value?: { ack?: Array<string> } }
          try {
            result = await reader.read()
          } catch {
            break
          }
          if (result.done) break
          const ack = result.value?.ack
          if (ack != null) {
            try {
              await store.ack({ recipientDID: clientDID, sequenceIDs: ack })
            } catch {
              // Frame stays pending; the client re-acks next round. Do NOT break.
            }
          }
        }
      })()

      // H2: an already-aborted signal never fires 'abort', so run teardown now.
      if (ctx.signal.aborted) {
        finish()
        return done
      }
      void evictedHere.then(finish)
      ctx.signal.addEventListener('abort', finish, { once: true })
      return done
    }) as ChannelHandler<HubProtocol, 'hub/v1/receive'>,
```

- [ ] **Step 6: Run the unit tests to verify they pass**

Run: `pnpm --filter @kumiai/hub-server run test:unit -- handlers-receive`
Expected: PASS (ordering, dedup, backpressure, ack-loop, pre-abort all green).

- [ ] **Step 7: Run the integration tests to verify no regression**

Run: `pnpm --filter @kumiai/hub-server run test:unit -- hub`
Expected: PASS — the existing live-delivery, offline-queue, ack-drains-store, reconnect-redelivery, and take-over-the-lane tests still pass under the new state machine.

- [ ] **Step 8: Add an integration regression test for publish-during-drain**

Append to `describe('hub pub/sub', ...)` in `packages/hub-server/test/hub.test.ts`, exercising the real transport path with a larger-than-one-page backlog:

```ts
test('a backlog larger than one page drains fully and in order, once each', async () => {
  const ctx = createTestHub()
  const { client: alice } = ctx.connect()
  const bobIdentity = randomIdentity()
  const { client: bobSetup } = ctx.connect(bobIdentity)
  await bobSetup.request('hub/v1/subscribe', { param: { topicID: TOPIC } })

  // 60 queued frames (> the 50-frame fetch page) before bob connects.
  for (let i = 0; i < 60; i++) {
    await alice.request('hub/v1/publish', { param: { topicID: TOPIC, payload: encodePayload(`m${i}`) } })
  }
  await delay(20)

  const { client: bob } = ctx.connect(bobIdentity)
  const channel = bob.createChannel('hub/v1/receive', { param: {} })
  const reader = channel.readable.getReader()

  const seen: Array<string> = []
  for (let i = 0; i < 60; i++) {
    const msg = await reader.read()
    seen.push(msg.value?.payload as string)
  }
  // Exactly the 60 frames, in order, no duplicates.
  expect(seen).toEqual(Array.from({ length: 60 }, (_, i) => encodePayload(`m${i}`)))

  channel.close()
  await expect(channel).rejects.toEqual('Close')
  await delay(20)
  await ctx.dispose()
})
```

Run: `pnpm --filter @kumiai/hub-server run test:unit -- hub`
Expected: PASS.

- [ ] **Step 9: Type check and lint**

Run: `pnpm --filter @kumiai/hub-server run test:types`
Expected: PASS.
Run: `pnpm exec biome check packages/hub-server/src/handlers.ts packages/hub-server/test/handlers-receive.test.ts packages/hub-server/test/hub.test.ts`
Expected: no errors (apply `--write` if only formatting differs, then re-run).

- [ ] **Step 10: Commit**

```bash
git add packages/hub-server/src/handlers.ts packages/hub-server/src/index.ts packages/hub-server/test/handlers-receive.test.ts packages/hub-server/test/hub.test.ts
git commit -m "fix(hub-server): buffer live delivery during drain and bound the receive write queue"
```

---

### Task 6: Full regression across the hub stack

**Files:** none (verification only).

**Interfaces:** confirms the store surface and both conformance suites are unaffected.

- [ ] **Step 1: Run the hub-server suite in full**

Run: `pnpm --filter @kumiai/hub-server run test`
Expected: PASS (types + unit, including `conformance.test.ts` and `log-hub-conformance.test.ts`).

- [ ] **Step 2: Run the hub-protocol suite**

Run: `pnpm --filter @kumiai/hub-protocol run test`
Expected: PASS.

- [ ] **Step 3: Run the dependent hub packages**

Run: `pnpm --filter @kumiai/hub-client --filter @kumiai/hub-tunnel --filter @kumiai/hub-conformance run test`
Expected: PASS — no consumer relied on duplicate delivery or the old error surface.

- [ ] **Step 4: Full lint gate**

Run: `rtk proxy pnpm run lint`
Expected: clean (real biome output, not the shim). Confirm `Cached: 0` is not masking results per the repo's test-verification note.

- [ ] **Step 5: Commit any lint fixups (if produced)**

```bash
git add -A
git commit -m "chore(hub-server): lint fixups for receive lifecycle"
```

(If Step 4 produced no changes, skip this commit.)

---

## Self-Review

**Spec coverage:**
- H1 (dup/unordered) → Task 5 (buffer-flush state machine + ordering/dedup tests). ✓
- H2 (pre-abort leak) → Task 4, folded into Task 5's final handler. ✓
- H3 (backpressure/swallowed writes) → Task 5 (`receiveBufferLimit`, `pushWrite` teardown). ✓
- M1 (ack-loop conflation) → Task 3, folded into Task 5's final handler. ✓
- M2 (indexOf cursor) → already fixed; no task (documented in spec). ✓
- M3 (decode guard) → Task 1 (code/class) + Task 2 (handler guard). ✓
- Testing (spec §Testing) → publish-during-drain (Task 5 s1, s8), multi-page (Task 5 s8), abort-before-listener (Task 4), saturation→fallback+redelivery (Task 5 s1 backpressure; redelivery is the store's existing reconnect path, covered by the untouched `redelivers unacked messages on reconnect` test rerun in Task 5 s7), ack-failure mid-loop (Task 3), malformed base64 (Task 2). ✓
- Conformance rerun (spec §Testing, §Non-goals) → Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `receiveBufferLimit`/`DEFAULT_RECEIVE_BUFFER_LIMIT`, `toReceiveFrame`/`ReceiveFrame`, `InvalidPayloadError`/`HUB_INVALID_PAYLOAD`, `pushWrite`/`finish`/`onLive`/`lastServed`/`pending`/`phase` used consistently across Tasks 1–5. `store.fetch` result shape (`messages`/`cursor`/`hasMore?`) matches `memoryStore.ts`. ✓

**Note for the implementer:** the Task 3 and Task 4 edits are supplanted by the full handler in Task 5 Step 5. They are staged first so each fix has its own failing test and commit; Task 5 assembles the final handler containing all three. If executing strictly in order, the Task 5 rewrite will already contain the Task 3/4 shapes — that is intended, not a merge conflict.
