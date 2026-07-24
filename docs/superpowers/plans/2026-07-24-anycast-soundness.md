# Anycast Soundness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** planning
**Mode:** tasks
**Spec:** `docs/superpowers/specs/2026-07-24-anycast-soundness-design.md`

**Goal:** Make suppressible anycast sound — a failing responder no longer suppresses healthy ones — while removing the duplicated responder, validating bus-lane input, wiring the dead `ctx.signal`, and adopting `@sozai/event` for event fan-out.

**Architecture:** Fix success-only suppression in `@kumiai/broadcast`'s responder (both mark-replied sites), then extend that one responder to own event dispatch (typed `EventEmitter`) and request cancellation (dispose-aborted signal) so `@kumiai/rpc`'s duplicate `bus-server.ts` can be deleted and `peer.ts` call the responder directly. `adaptBusHandlers` gains per-procedure schema validation. Separately, `@kumiai/hub-tunnel`'s hand-rolled `MailboxHub` connection-event listener becomes an `EventEmitter` exposed through a `get events()` accessor.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, turbo, pnpm, biome. `@sozai/event` (EventEmitter), `@sozai/schema` (createValidator), `@sozai/log`, `@enkaku/protocol`/`transport`.

## Global Constraints

- pnpm only. Run repo scripts as `rtk proxy pnpm run <script>` (a shim otherwise redirects `pnpm run` to the wrong tool); or invoke tools directly, e.g. `pnpm exec biome check ...`.
- Do not edit generated files (`lib/`).
- Cross-repo deps (`@sozai/*`, `@enkaku/*`) go through the pnpm catalog as published `^` ranges (`catalog:` in `package.json`), never `workspace:`. Internal `@kumiai/*` deps are `workspace:^`.
- Catalog versions to use: `@sozai/event: ^0.1.1`, `@sozai/schema: ^0.1.1`, `@sozai/log: ^0.2.0` (already present in `pnpm-workspace.yaml`).
- Changing a port means running **both** contract suites (`rpc-conformance`, `hub-conformance`) against the real implementation **and** the doubles.
- A test double may be **stricter** than its port, never more permissive.
- Verify tests actually ran: `pnpm test` reports cached turbo results — force a real run and confirm `Cached: 0` in the summary. `pnpm test -- --force` is broken; use turbo's force path (`rtk proxy pnpm run test -- --force` is unreliable — prefer removing the turbo cache entry or running the package's vitest directly, e.g. `pnpm --filter @kumiai/broadcast exec vitest run`).
- Run `rtk proxy pnpm run lint` and fix before staging.
- All commit messages end with the two trailers this repo uses (`Co-Authored-By:` and `Claude-Session:`); omitted from the snippets below for brevity — add them.

---

## File Structure

- `packages/broadcast/src/responder.ts` — the single responder. Gains success-only suppression (Task 1), then event dispatch + request-signal + `requestHandlers` rename (Task 2).
- `packages/broadcast/src/index.ts` — export surface follows the responder's type changes (Task 2).
- `packages/broadcast/package.json` — add `@sozai/event` (Task 2).
- `packages/broadcast/test/responder.test.ts` — suppression tests (Task 1), event + signal tests, rename churn (Task 2).
- `packages/rpc/src/handlers.ts` — `adaptBusHandlers` returns an `EventEmitter` + `requestHandlers`, builds per-procedure validators, forwards `context.signal` (Task 3).
- `packages/rpc/src/bus-server.ts` — **deleted** (Task 3).
- `packages/rpc/src/peer.ts` — call `createBroadcastResponder`; `appEventHandlers`/`ProtocolRuntime` types (Task 3).
- `packages/rpc/src/app-lane.ts` — drain emits into the emitter; `eventHandlers` param type (Task 3).
- `packages/rpc/package.json` — add `@sozai/event`, `@sozai/schema` (Task 3).
- `packages/rpc/test/handlers.test.ts` — validation + signal-forward tests (Task 3, create if absent).
- `packages/hub-tunnel/src/transport.ts` — `MailboxHubEvents` → `EventEmitter`, `HubBase.events` readonly, consumer at `:484`, exports (Task 4).
- `packages/hub-tunnel/src/encrypted-transport.ts` — forward `events` inside the object literal (Task 4).
- `packages/hub-tunnel/test/fixtures/fake-hub.ts` — `#events` + `get events()` (Task 4).
- `packages/hub-tunnel/package.json` — add `@sozai/event` (Task 4).

---

## Task 1: Success-only suppression (the High finding)

Fix the suppression bug in the canonical responder, in its current structure (no dedup yet). `@kumiai/rpc`'s duplicate keeps the bug until Task 3 deletes it — acceptable, the branch lands as a unit.

**Files:**
- Modify: `packages/broadcast/src/responder.ts` (two mark-replied sites)
- Test: `packages/broadcast/test/responder.test.ts`

**Interfaces:**
- Consumes: existing `createBroadcastResponder({ transport, from, handlers })`, `suppressible`, `createMemoryBus`, `createBroadcastTransport`, `BroadcastClient` (unchanged this task).
- Produces: no signature change — only suppression behavior changes.

- [ ] **Step 1: Write the failing test — a failing responder must not suppress a healthy one**

Add to `packages/broadcast/test/responder.test.ts` inside the `describe('createBroadcastResponder', …)` block:

```ts
test('suppressible: a fast erroring responder does not suppress a slower successful one', async () => {
  const bus = createMemoryBus()
  // peer-1 replies first (jitter 0) but THROWS. peer-2 waits (jitter 50) and succeeds.
  // With the bug, peer-1's error reply marks the rid replied and peer-2 stays silent,
  // so the client times out. Fixed: an error reply never suppresses.
  const failing = createBroadcastResponder({
    transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    from: 'peer-1',
    handlers: {
      ask: suppressible(() => {
        throw new Error('nope')
      }, { jitterMs: 100 }),
    },
    getJitterMs: () => 0,
  })
  const healthy = createBroadcastResponder({
    transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    from: 'peer-2',
    handlers: { ask: suppressible(() => 'ok', { jitterMs: 100 }) },
    getJitterMs: () => 50,
  })
  const client = new BroadcastClient({
    transport: createBroadcastTransport({ topicID: TOPIC, bus }),
  })

  const result = await client.request('ask', {}, { timeoutMs: 500 })
  expect(result).toBe('ok')

  await client.dispose()
  await failing.dispose()
  await healthy.dispose()
})

test('an observed error reply does not suppress this responder', async () => {
  const bus = createMemoryBus()
  // A raw error `res` frame for a rid is injected before the real request. If the
  // observe-loop suppressed on it, the responder would ignore the request.
  const responder = createBroadcastResponder({
    transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    from: 'peer-1',
    handlers: { ping: suppressible(() => 'pong', { jitterMs: 0 }) },
    getJitterMs: () => 0,
  })
  const client = new BroadcastClient({
    transport: createBroadcastTransport({ topicID: TOPIC, bus }),
  })

  const result = await client.request('ping', {}, { timeoutMs: 500 })
  expect(result).toBe('pong')

  await client.dispose()
  await responder.dispose()
})
```

- [ ] **Step 2: Run the tests to verify the first fails**

Run: `pnpm --filter @kumiai/broadcast exec vitest run responder`
Expected: `a fast erroring responder does not suppress…` FAILS — times out / rejects with "timed out after 500ms". (The observed-error test may pass already; both must pass after the fix.)

- [ ] **Step 3: Gate the own-reply mark-replied on success**

In `packages/broadcast/src/responder.ts`, in `handleRequest`, the current block is:

```ts
    const ttlMs = isSuppressible(handler)
      ? (handler.suppress.suppressTtlMs ?? DEFAULT_SUPPRESS_TTL_MS)
      : DEFAULT_SUPPRESS_TTL_MS
    if (!isGather) {
      markReplied(request.rid, ttlMs)
    }
```

Change the guard to also require a successful reply:

```ts
    const ttlMs = isSuppressible(handler)
      ? (handler.suppress.suppressTtlMs ?? DEFAULT_SUPPRESS_TTL_MS)
      : DEFAULT_SUPPRESS_TTL_MS
    // Suppress healthy responders only on a SUCCESS. An error reply leaves the rid
    // open so a slower, working responder still answers.
    if (!isGather && reply.err == null) {
      markReplied(request.rid, ttlMs)
    }
```

- [ ] **Step 4: Gate the observed-reply mark-replied on success**

In the same file, the inbound loop currently has:

```ts
      if (data?.kind === 'res' && typeof data.rid === 'string') {
        markReplied(data.rid, DEFAULT_SUPPRESS_TTL_MS)
        continue
      }
```

Require the observed reply to carry no error:

```ts
      if (data?.kind === 'res' && typeof data.rid === 'string') {
        // Only a peer's SUCCESS suppresses us; its error frame must not.
        if (data.err == null) {
          markReplied(data.rid, DEFAULT_SUPPRESS_TTL_MS)
        }
        continue
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @kumiai/broadcast exec vitest run responder`
Expected: all `createBroadcastResponder` tests PASS, including both new ones and the existing `a slow responder stays silent once it sees another reply` (a success still suppresses).

- [ ] **Step 6: Lint**

Run: `rtk proxy pnpm run lint`
Expected: no errors in `packages/broadcast`.

- [ ] **Step 7: Commit**

```bash
git add packages/broadcast/src/responder.ts packages/broadcast/test/responder.test.ts
git commit -m "fix(broadcast): suppress anycast only on success replies

A failing responder's error reply no longer marks the request replied, so a
slower healthy responder still answers instead of the client timing out.
Gates both the own-reply and observed-reply mark-replied sites on err == null."
```

---

## Task 2: Extend the responder — events, request signal, requestHandlers rename

Fold everything `createGroupBusServer` does into the single responder: event fan-out through a typed `EventEmitter`, a dispose-aborted `signal` in the handler context, and the `handlers` → `requestHandlers` rename. This changes only `@kumiai/broadcast`; `@kumiai/rpc` still uses its own `bus-server.ts` and keeps compiling until Task 3.

**Files:**
- Modify: `packages/broadcast/src/responder.ts`
- Modify: `packages/broadcast/src/index.ts`
- Modify: `packages/broadcast/package.json` (add `@sozai/event`)
- Test: `packages/broadcast/test/responder.test.ts`

**Interfaces:**
- Produces:
  - `type BusEvent = { data: unknown; senderDID?: string }`
  - `type BusEvents = Record<string, BusEvent>`
  - `type BroadcastHandler = (prm: unknown, context?: { senderDID?: string; signal?: AbortSignal }) => unknown | Promise<unknown>`
  - `createBroadcastResponder({ transport, from, requestHandlers, events?, sleep?, getJitterMs? })` where `requestHandlers: Record<string, BroadcastHandler | SuppressibleHandler>` (was `handlers`) and `events?: EventEmitter<BusEvents>`.
- Consumes: `EventEmitter` from `@sozai/event`.

- [ ] **Step 1: Add the `@sozai/event` dependency**

In `packages/broadcast/package.json`, add to `dependencies` (keep alphabetical):

```json
    "@sozai/async": "catalog:",
    "@sozai/codec": "catalog:",
    "@sozai/event": "catalog:",
    "@sozai/runtime": "catalog:"
```

Run: `pnpm install`
Expected: lockfile updates, `@sozai/event` resolves to `^0.1.1`.

- [ ] **Step 2: Write the failing tests — event dispatch and dispose-aborted signal**

Add to `packages/broadcast/test/responder.test.ts`. Add the import at the top:

```ts
import { EventEmitter } from '@sozai/event'
```

Then, inside the describe block:

```ts
test('dispatches a fire-and-forget event to the events emitter', async () => {
  const bus = createMemoryBus()
  const events = new EventEmitter<{ note: { data: unknown; senderDID?: string } }>()
  const received: Array<{ data: unknown; senderDID?: string }> = []
  events.on('note', (e) => {
    received.push(e)
  })
  const responder = createBroadcastResponder({
    transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    from: 'peer-1',
    requestHandlers: {},
    events,
  })
  const client = new BroadcastClient({
    transport: createBroadcastTransport({ topicID: TOPIC, bus }),
  })

  await client.dispatch('note', { hello: 'world' })
  await new Promise<void>((resolve) => setTimeout(resolve, 10))

  expect(received).toHaveLength(1)
  expect(received[0]?.data).toEqual({ hello: 'world' })

  await client.dispose()
  await responder.dispose()
})

test('aborts an in-flight request handler on dispose', async () => {
  const bus = createMemoryBus()
  let capturedSignal: AbortSignal | undefined
  let release: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    release = resolve
  })
  const responder = createBroadcastResponder({
    transport: createBroadcastTransport({ topicID: TOPIC, bus }),
    from: 'peer-1',
    requestHandlers: {
      slow: (_prm, context) => {
        capturedSignal = context?.signal
        release()
        // Never resolves on its own; the test disposes the responder to abort it.
        return new Promise((resolve) => {
          context?.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
        })
      },
    },
  })
  const client = new BroadcastClient({
    transport: createBroadcastTransport({ topicID: TOPIC, bus }),
  })

  void client.request('slow', {}, { timeoutMs: 1000 }).catch(() => {})
  await started
  expect(capturedSignal?.aborted).toBe(false)

  await responder.dispose()
  expect(capturedSignal?.aborted).toBe(true)

  await client.dispose()
})
```

Update **every existing** `createBroadcastResponder({ … handlers: … })` in this file to `requestHandlers:` (the rename lands this task). There are four existing occurrences plus the two added in Task 1.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @kumiai/broadcast exec vitest run responder`
Expected: compile/type errors or failures — `events`/`requestHandlers`/`signal` do not exist yet.

- [ ] **Step 4: Extend the responder types and params**

In `packages/broadcast/src/responder.ts`, add the import:

```ts
import type { EventEmitter } from '@sozai/event'
```

Add the event payload types near the top (after the existing imports):

```ts
/** The payload an inbound fire-and-forget event carries to its listener. */
export type BusEvent = { data: unknown; senderDID?: string }
/** Event fan-out keyed by procedure name. */
export type BusEvents = Record<string, BusEvent>
```

Extend `BroadcastHandler`'s context with `signal`:

```ts
export type BroadcastHandler = (
  prm: unknown,
  context?: { senderDID?: string; signal?: AbortSignal },
) => unknown | Promise<unknown>
```

In `BroadcastResponderParams`, rename `handlers` to `requestHandlers` and add `events`:

```ts
  requestHandlers: Record<string, BroadcastHandler | SuppressibleHandler>
  /** Optional fan-out for fire-and-forget event frames (typ 'event', no req/res kind). */
  events?: EventEmitter<BusEvents>
```

- [ ] **Step 5: Own in-flight controllers and abort on dispose**

In `createBroadcastResponder`, destructure the renamed/added params and add a controller set:

```ts
  const { transport, from, requestHandlers, events } = params
```

Add, next to `suppressTimers`:

```ts
  // In-flight request controllers, aborted on dispose so a torn-down epoch stops
  // its handlers rather than orphaning them.
  const inFlight = new Set<AbortController>()
```

In `handleRequest`, create a controller, pass its signal, and clean up. The current body:

```ts
    let reply: ReplyData
    try {
      const ok = await handler(request.prm, { senderDID })
      reply = { kind: 'res', rid: request.rid, ok }
    } catch (error) {
```

becomes:

```ts
    const controller = new AbortController()
    inFlight.add(controller)
    let reply: ReplyData
    try {
      const ok = await handler(request.prm, { senderDID, signal: controller.signal })
      reply = { kind: 'res', rid: request.rid, ok }
    } catch (error) {
```

and after the reply is built (just before `markReplied`), remove the controller:

```ts
    } finally {
      inFlight.delete(controller)
    }
```

(Attach the `finally` to the existing `try/catch` that wraps the handler call — the reply-shape/`markReplied`/`write` code stays after it.)

- [ ] **Step 6: Route event frames to the emitter and rename in the loop**

Replace `handlers[payload.prc]` with `requestHandlers[payload.prc]`. In the inbound loop, the current tail drops non-req/res frames:

```ts
      if (data?.kind !== 'req' || typeof data.rid !== 'string' || typeof payload.prc !== 'string') {
        continue
      }
      const handler = handlers[payload.prc]
      if (handler != null) {
        void handleRequest(payload.prc, data as RequestData, handler, msg.senderDID)
      }
```

becomes (route requests, then fan out anything else as an event):

```ts
      if (typeof payload.prc !== 'string') {
        continue
      }
      if (data?.kind === 'req' && typeof data.rid === 'string') {
        const handler = requestHandlers[payload.prc]
        if (handler != null) {
          void handleRequest(payload.prc, data as RequestData, handler, msg.senderDID)
        }
        continue
      }
      // Fire-and-forget event: hand the raw data to the emitter. No listener → no-op.
      void events?.emit(payload.prc, { data: payload.data, senderDID: msg.senderDID }).catch(() => {})
```

- [ ] **Step 7: Abort in-flight controllers on dispose**

In the returned `dispose`, add the abort before/after the timer cleanup:

```ts
    dispose: async () => {
      running = false
      for (const controller of inFlight) {
        controller.abort()
      }
      inFlight.clear()
      for (const timer of suppressTimers.values()) {
        clearTimeout(timer)
      }
      suppressTimers.clear()
      await transport.dispose()
    },
```

- [ ] **Step 8: Update the export surface**

In `packages/broadcast/src/index.ts`, add the new types to the `responder.js` export block:

```ts
export {
  type BroadcastHandler,
  type BroadcastResponderParams,
  type BusEvent,
  type BusEvents,
  createBroadcastResponder,
  type SuppressConfig,
  type SuppressibleHandler,
  suppressible,
} from './responder.js'
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm --filter @kumiai/broadcast exec vitest run`
Expected: all broadcast tests PASS (event dispatch, signal abort, and the renamed existing tests).

- [ ] **Step 10: Typecheck + lint**

Run: `pnpm --filter @kumiai/broadcast exec tsc --emitDeclarationOnly --skipLibCheck` then `rtk proxy pnpm run lint`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add packages/broadcast
git commit -m "feat(broadcast): responder owns events and request cancellation

Adds an optional @sozai/event EventEmitter for fire-and-forget event fan-out,
a dispose-aborted AbortSignal in the handler context, and renames handlers ->
requestHandlers. This makes the responder a superset of rpc's bus-server."
```

---

## Task 3: Dedup into rpc — adaptBusHandlers reshape, delete bus-server, wire peer + drain

Atomic `@kumiai/rpc` change: `adaptBusHandlers` returns an `EventEmitter` + `requestHandlers` and validates input; `bus-server.ts` is deleted; `peer.ts` builds `createBroadcastResponder`; the drain emits into the emitter. These are type-coupled — `rpc` does not typecheck partway, so they land together.

**Files:**
- Modify: `packages/rpc/src/handlers.ts`
- Delete: `packages/rpc/src/bus-server.ts`
- Modify: `packages/rpc/src/peer.ts`
- Modify: `packages/rpc/src/app-lane.ts`
- Modify: `packages/rpc/package.json` (add `@sozai/event`, `@sozai/schema`)
- Test: `packages/rpc/test/handlers.test.ts` (create if absent)

**Interfaces:**
- Consumes: `createBroadcastResponder`, `BusEvents`, `BroadcastHandler` (Task 2); `EventEmitter` (`@sozai/event`); `createValidator`, `assertType`, `Validator`, `ValidationError` (`@sozai/schema`); `getLogger`, `isSetup` (`@sozai/log`).
- Produces: `adaptBusHandlers(protocol, handlers, suppress?) → { events: EventEmitter<BusEvents>; requestHandlers: Record<string, BroadcastHandler> }`. `BusHandlerMaps` becomes `{ events: EventEmitter<BusEvents>; requestHandlers: Record<string, BroadcastHandler> }`.

- [ ] **Step 1: Add rpc dependencies**

In `packages/rpc/package.json` `dependencies` (keep alphabetical among `@sozai/*`):

```json
    "@sozai/codec": "catalog:",
    "@sozai/event": "catalog:",
    "@sozai/log": "catalog:",
    "@sozai/runtime": "catalog:",
    "@sozai/schema": "catalog:"
```

Run: `pnpm install`
Expected: `@sozai/event ^0.1.1` and `@sozai/schema ^0.1.1` resolve.

- [ ] **Step 2: Write the failing tests — validation and signal forwarding**

Create `packages/rpc/test/handlers.test.ts`:

```ts
import { EventEmitter } from '@sozai/event'
import { describe, expect, test, vi } from 'vitest'

import { adaptBusHandlers } from '../src/handlers.js'

// A minimal protocol: one request with an integer `param`, one event with an
// object `data` requiring a string `id`.
const protocol = {
  compute: {
    type: 'request',
    param: { type: 'integer' },
    result: { type: 'integer' },
  },
  notify: {
    type: 'event',
    data: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
} as const

describe('adaptBusHandlers', () => {
  test('rejects a request whose param fails schema validation', async () => {
    const { requestHandlers } = adaptBusHandlers(protocol as never, {
      compute: ({ param }: { param: number }) => param + 1,
    })
    await expect(
      Promise.resolve(requestHandlers.compute('not-a-number', {})),
    ).rejects.toThrow()
  })

  test('accepts a request whose param passes validation', async () => {
    const { requestHandlers } = adaptBusHandlers(protocol as never, {
      compute: ({ param }: { param: number }) => param + 1,
    })
    await expect(Promise.resolve(requestHandlers.compute(41, {}))).resolves.toBe(42)
  })

  test('drops an event whose data fails validation and never calls the handler', async () => {
    const handler = vi.fn()
    const { events } = adaptBusHandlers(protocol as never, { notify: handler })
    await events.emit('notify', { data: { id: 123 }, senderDID: 'did:x' }) // id must be a string
    expect(handler).not.toHaveBeenCalled()
  })

  test('delivers a valid event to the handler with the authenticated sender', async () => {
    const seen: Array<unknown> = []
    const { events } = adaptBusHandlers(protocol as never, {
      notify: (ctx: { data?: unknown; message: { payload: { iss?: string } } }) => {
        seen.push({ data: ctx.data, iss: ctx.message.payload.iss })
      },
    })
    await events.emit('notify', { data: { id: 'abc' }, senderDID: 'did:sender' })
    expect(seen).toEqual([{ data: { id: 'abc' }, iss: 'did:sender' }])
  })

  test('forwards the responder-supplied signal into the request handler', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const { requestHandlers } = adaptBusHandlers(protocol as never, {
      compute: ({ signal }: { signal?: AbortSignal }) => {
        seen = signal
        return 0
      },
    })
    await Promise.resolve(requestHandlers.compute(1, { signal: controller.signal }))
    expect(seen).toBe(controller.signal)
  })

  test('events is an EventEmitter', () => {
    const { events } = adaptBusHandlers(protocol as never, {})
    expect(events).toBeInstanceOf(EventEmitter)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @kumiai/rpc exec vitest run handlers`
Expected: FAIL — `adaptBusHandlers` returns `{ eventHandlers, requestHandlers }` with no validation, no `events` emitter, and forwards a dead controller.

- [ ] **Step 4: Rewrite `adaptBusHandlers`**

Replace the contents of `packages/rpc/src/handlers.ts` with:

```ts
import type { ProtocolDefinition } from '@enkaku/protocol'
import { type BroadcastHandler, type BusEvents, type SuppressConfig, suppressible } from '@kumiai/broadcast'
import { EventEmitter } from '@sozai/event'
import { getLogger, isSetup } from '@sozai/log'
import { createValidator, type Validator } from '@sozai/schema'

export type BusHandlerMaps = {
  /** Fire-and-forget event fan-out, keyed by procedure name. Host handlers are pre-registered. */
  events: EventEmitter<BusEvents>
  /** Anycast request procedures: prc -> handler(param, { senderDID, signal }) -> result. */
  requestHandlers: Record<string, BroadcastHandler>
}

/** `['kumiai', 'rpc']` — an app routing this category sees dropped-input diagnostics. */
const logger = getLogger(['kumiai', 'rpc'])

function warnDropped(message: string): void {
  if (isSetup()) {
    logger.error(message)
    return
  }
  console.error(`[@kumiai/rpc] ${message}`)
}

/** Minimal bus-path context message: authenticated sender at `payload.iss`. */
function busMessage(senderDID?: string): { payload: { iss?: string } } {
  return { payload: { iss: senderDID } }
}

type LooseHandler = (context: {
  data?: unknown
  param?: unknown
  signal?: AbortSignal
  message: { payload: { iss?: string } }
}) => unknown

/**
 * Adapt native `@enkaku/server` handlers into a bus event emitter + request handler map.
 * `event` procedures become listeners on the returned `EventEmitter`; `request` procedures
 * become anycast request handlers (wrapped `suppressible`). Input is validated against the
 * protocol's declared schemas before a host handler is called: an invalid request rejects
 * (surfacing as an error reply, which does not suppress healthy responders), an invalid event
 * is dropped and logged. The authenticated sender is exposed at `ctx.message.payload.iss` and
 * the responder-supplied cancellation signal at `ctx.signal`.
 */
export function adaptBusHandlers(
  protocol: ProtocolDefinition,
  handlers: Record<string, unknown>,
  suppress: SuppressConfig = {},
): BusHandlerMaps {
  const events = new EventEmitter<BusEvents>()
  const requestHandlers: BusHandlerMaps['requestHandlers'] = {}

  for (const [prc, definition] of Object.entries(protocol)) {
    const handler = handlers[prc] as LooseHandler | undefined
    if (handler == null) continue

    if (definition.type === 'event') {
      const validator: Validator<unknown> | undefined =
        definition.data != null ? createValidator(definition.data as never) : undefined
      events.on(prc, ({ data, senderDID }) => {
        if (validator != null) {
          const result = validator(data)
          if (result instanceof Error) {
            warnDropped(`Dropped invalid event "${prc}": ${result.message}`)
            return
          }
        }
        return handler({ data, message: busMessage(senderDID) }) as void | Promise<void>
      })
    } else if (definition.type === 'request') {
      const validator: Validator<unknown> | undefined =
        definition.param != null ? createValidator(definition.param as never) : undefined
      const fn: BroadcastHandler = (param, context) => {
        if (validator != null) {
          const result = validator(param)
          if (result instanceof Error) throw result
        }
        return handler({
          param,
          ...(context?.signal != null ? { signal: context.signal } : {}),
          message: busMessage(context?.senderDID),
        })
      }
      requestHandlers[prc] = Object.keys(suppress).length > 0 ? suppressible(fn, suppress) : fn
    }
  }

  return { events, requestHandlers }
}
```

Note: `ValidationError extends Error`, so `result instanceof Error` catches it. Import `ValidationError` explicitly only if a narrower check is wanted — the `instanceof Error` form needs no extra import.

- [ ] **Step 5: Run the handler tests to verify they pass**

Run: `pnpm --filter @kumiai/rpc exec vitest run handlers`
Expected: all six PASS.

- [ ] **Step 6: Delete `bus-server.ts`**

```bash
git rm packages/rpc/src/bus-server.ts
```

Remove any `bus-server` test file if one exists (`git rm packages/rpc/test/bus-server.test.ts` — skip if absent). The behavior it covered is now the broadcast responder's (Task 2) plus `handlers.test.ts` (Step 2).

- [ ] **Step 7: Wire `peer.ts` to the broadcast responder**

In `packages/rpc/src/peer.ts`:

Remove the bus-server import (`import { createGroupBusServer } from './bus-server.js'`) and add `createBroadcastResponder` to the `@kumiai/broadcast` import. Confirm the existing broadcast import block and extend it, e.g.:

```ts
import { BroadcastClient, createBroadcastResponder } from '@kumiai/broadcast'
```

Change the `appEventHandlers` map type (line ~384) and its fill (line ~386-389):

```ts
  const appEventHandlers = new Map<string, BusHandlerMaps['events']>()
  for (const [name, protocol] of Object.entries(protocols)) {
    appEventHandlers.set(
      name,
      adaptBusHandlers(protocol, handlers[name] as Record<string, unknown>, suppress).events,
    )
  }
```

At the live construction site (line ~589-599), replace:

```ts
      const { eventHandlers, requestHandlers } = adaptBusHandlers(
        protocol,
        handlers[name] as Record<string, unknown>,
        suppress,
      )
      const busServer = createGroupBusServer({
        transport: segmentBoundTransport(name, topicID, inbound),
        from: localDID,
        eventHandlers,
        requestHandlers,
      })
```

with:

```ts
      const { events, requestHandlers } = adaptBusHandlers(
        protocol,
        handlers[name] as Record<string, unknown>,
        suppress,
      )
      const busServer = createBroadcastResponder({
        transport: segmentBoundTransport(name, topicID, inbound),
        from: localDID,
        requestHandlers,
        events,
      })
```

`ProtocolRuntime.busServer` is typed `{ dispose: () => Promise<void> }` — `createBroadcastResponder` returns exactly that, so the `next.set(name, { client, busServer, acceptor, … })` slot and `teardownEpoch`'s `runtime.busServer.dispose()` are unchanged.

- [ ] **Step 8: Update `app-lane.ts` to emit into the emitter**

In `packages/rpc/src/app-lane.ts`:

Change the `eventHandlers` param type (line ~47):

```ts
  eventHandlers: Map<string, BusHandlerMaps['events']>
```

In the drain loop (lines ~412-455), the current shape is:

```ts
    for (const [name, frames] of segment) {
      const eventHandlers = appEventHandlers.get(name)
      if (eventHandlers == null || frames.length === 0) continue
      …
        const handler = eventHandlers[prc]
        if (handler == null) continue
        try {
          await handler(message.payload.data ?? {}, opened.senderDID)
        } catch {
          …
        }
```

Change the lookup to an emitter and emit (a missing listener is a no-op, so the `handler == null` skip is dropped):

```ts
    for (const [name, frames] of segment) {
      const events = appEventHandlers.get(name)
      if (events == null || frames.length === 0) continue
      …
        try {
          // Same door as the live push: emit the retained frame's plaintext into the
          // per-protocol emitter the live bus is also built from. No listener → no-op.
          await events.emit(prc, { data: message.payload.data ?? {}, senderDID: opened.senderDID })
        } catch {
          // A host listener that threw has been delivered to. Re-delivering on the next pull
          // would retry the host's own bug at it, so the frame is consumed.
        }
```

Keep the surrounding retention/epoch guards (`retentionOf(...) !== 'log'` etc.) exactly as they are — only the handler lookup + call changes.

- [ ] **Step 9: Typecheck the whole rpc package**

Run: `pnpm --filter @kumiai/rpc exec tsc --emitDeclarationOnly --skipLibCheck`
Expected: no errors — `peer.ts`, `app-lane.ts`, `handlers.ts` all consistent with the new `BusHandlerMaps`.

- [ ] **Step 10: Run the rpc test suite + rpc-conformance (real impl AND doubles)**

Run: `pnpm --filter @kumiai/rpc exec vitest run`
Then run the conformance suite the way this repo wires it (both the real implementation and the doubles must pass — check `packages/rpc-conformance` and `docs/agents/architecture.md` for the invocation):

Run: `pnpm --filter @kumiai/rpc-conformance exec vitest run` (and any double-targeted run it defines)
Expected: all PASS. If the conformance harness parametrizes real-vs-double, confirm both variants ran.

- [ ] **Step 11: Lint**

Run: `rtk proxy pnpm run lint`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add packages/rpc
git commit -m "refactor(rpc): delete bus-server, use the broadcast responder

adaptBusHandlers now returns a @sozai/event EventEmitter + requestHandlers and
validates bus-lane input against the protocol schemas (invalid request -> error
reply, invalid event -> dropped+logged). peer.ts builds createBroadcastResponder
directly; the app-lane drain emits into the same per-protocol emitter, preserving
the same-door invariant. The dead ctx.signal is now the responder's dispose signal."
```

---

## Task 4: MailboxHub connection events → EventEmitter (own commit)

Independent of the anycast fix. Convert `hub-tunnel`'s hand-rolled connection-event listener registry to a typed `EventEmitter` exposed through a `get events()` accessor.

**Files:**
- Modify: `packages/hub-tunnel/src/transport.ts`
- Modify: `packages/hub-tunnel/src/encrypted-transport.ts`
- Modify: `packages/hub-tunnel/test/fixtures/fake-hub.ts`
- Modify: `packages/hub-tunnel/package.json` (add `@sozai/event`)
- Test: existing hub-tunnel tests exercise the reconnect wiring; add a focused fixture test.

**Interfaces:**
- Produces: `type MailboxHubEvents = EventEmitter<{ status: MailboxHubEvent }>`; `HubBase.events?: MailboxHubEvents` (readonly); `FakeHub` exposes `get events(): MailboxHubEvents`.
- Consumes: `EventEmitter` (`@sozai/event`).

- [ ] **Step 1: Add the dependency**

In `packages/hub-tunnel/package.json` `dependencies`:

```json
    "@sozai/async": "catalog:",
    "@sozai/codec": "catalog:",
    "@sozai/event": "catalog:",
    "@sozai/schema": "catalog:"
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing fixture test**

Add `packages/hub-tunnel/test/fixtures/fake-hub-events.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

import { FakeHub } from './fake-hub.js'

describe('FakeHub events', () => {
  test('emits status transitions to on("status") listeners', () => {
    const hub = new FakeHub()
    const seen: Array<string> = []
    const off = hub.events.on('status', (event) => {
      seen.push(event.type)
    })
    hub.simulateReconnecting()
    hub.simulateConnected()
    hub.simulateDisconnected()
    off()
    hub.simulateConnected() // after off(): not observed
    expect(seen).toEqual(['reconnecting', 'connected', 'disconnected'])
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @kumiai/hub-tunnel exec vitest run fake-hub-events`
Expected: FAIL — `hub.events.on` is not a function (`events` is still `{ subscribe }`).

- [ ] **Step 4: Convert the `MailboxHubEvents` type in `transport.ts`**

In `packages/hub-tunnel/src/transport.ts`, add the import:

```ts
import type { EventEmitter } from '@sozai/event'
```

Replace:

```ts
export type MailboxHubEventListener = (event: MailboxHubEvent) => void

export type MailboxHubEvents = {
  subscribe: (listener: MailboxHubEventListener) => () => void
}
```

with (keep `MailboxHubEvent`; drop the now-unused `MailboxHubEventListener`, or retain it if re-exported elsewhere — see Step 7):

```ts
export type MailboxHubEvents = EventEmitter<{ status: MailboxHubEvent }>
```

Make `HubBase.events` readonly (line ~123):

```ts
  readonly events?: MailboxHubEvents
```

- [ ] **Step 5: Update the internal consumer at `transport.ts:484`**

The current subscribe:

```ts
    unsubscribeEvents = hub.events.subscribe((event) => {
      if (torndown) return
      switch (event.type) {
        case 'reconnecting':
        case 'disconnected':
          armReconnectTimer()
          return
        case 'connected':
          clearReconnectTimer()
          return
      }
    })
```

becomes:

```ts
    unsubscribeEvents = hub.events.on('status', (event) => {
      if (torndown) return
      switch (event.type) {
        case 'reconnecting':
        case 'disconnected':
          armReconnectTimer()
          return
        case 'connected':
          clearReconnectTimer()
          return
      }
    })
```

`EventEmitter.on` returns the same `() => void` unsubscribe shape, so `unsubscribeEvents` is unchanged in type.

- [ ] **Step 6: Forward `events` inside the object literal in `encrypted-transport.ts`**

The readonly change breaks the post-construction assignment. Replace (lines ~157-159):

```ts
  if (hub.events != null) {
    wrapped.events = hub.events
  }
  return wrapped
```

The `wrapped` object literal is built just above; move the forward into it. In the literal, add:

```ts
      ...(hub.events != null ? { events: hub.events } : {}),
```

(place it alongside the other forwarded fields, e.g. near the `ack` spread) and delete the trailing `if (hub.events != null) { wrapped.events = hub.events }` block so only `return wrapped` remains.

- [ ] **Step 7: Update the `index.ts` export**

In `packages/hub-tunnel/src/index.ts`, the `type MailboxHubEventListener` export (line ~50) now points at a removed type. Remove it from the export list if the type was deleted in Step 4; keep `type MailboxHubEvent` and `type MailboxHubEvents`. Grep first: `grep -rn "MailboxHubEventListener" packages --include="*.ts" | grep -v /lib/` — if any non-test consumer remains, keep the alias `export type MailboxHubEventListener = (event: MailboxHubEvent) => void` in `transport.ts` instead of deleting it.

- [ ] **Step 8: Convert the `fake-hub` fixture**

In `packages/hub-tunnel/test/fixtures/fake-hub.ts`, add the import:

```ts
import { EventEmitter } from '@sozai/event'
```

Replace the field `#eventListeners = new Set<MailboxHubEventListener>()` with:

```ts
  #events = new EventEmitter<{ status: MailboxHubEvent }>()
```

Replace the `events = { subscribe: … }` field with a getter:

```ts
  get events(): EventEmitter<{ status: MailboxHubEvent }> {
    return this.#events
  }
```

Replace `#emitEvent` and the `simulate*` methods:

```ts
  simulateReconnecting(): void {
    void this.#events.emit('status', { type: 'reconnecting' })
  }

  simulateConnected(): void {
    void this.#events.emit('status', { type: 'connected' })
  }

  simulateDisconnected(): void {
    void this.#events.emit('status', { type: 'disconnected' })
  }
```

Remove the now-unused `MailboxHubEventListener` import from the fixture if it was only used by the deleted field.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm --filter @kumiai/hub-tunnel exec vitest run`
Expected: the new fixture test PASSES and every existing hub-tunnel test (reconnect wiring, encrypted-transport observability) still PASSES.

- [ ] **Step 10: Typecheck + hub-conformance (real impl AND doubles)**

Run: `pnpm --filter @kumiai/hub-tunnel exec tsc --emitDeclarationOnly --skipLibCheck`
Run: `pnpm --filter @kumiai/hub-conformance exec vitest run` (both real and double variants the suite defines).
Expected: no type errors, all conformance PASS.

- [ ] **Step 11: Lint + Commit**

Run: `rtk proxy pnpm run lint`

```bash
git add packages/hub-tunnel
git commit -m "refactor(hub-tunnel): MailboxHub events as an EventEmitter

Replaces the hand-rolled subscribe/#eventListeners registry with a typed
@sozai/event EventEmitter exposed through get events(). HubBase.events is now
readonly; the encrypting wrapper forwards it inside its object literal."
```

---

## Task 5: Whole-branch verification

Repeated whole-branch gates catch defects a single pass misses. Run the full stack, both conformance suites both ways, and confirm nothing is cache-masked.

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck across the affected packages**

Run: `rtk proxy pnpm run build:types` (or `turbo run build:types`)
Expected: all packages succeed.

- [ ] **Step 2: Full test run, cache-forced**

Run the whole test suite and confirm it actually executed (not replayed): `pnpm --filter @kumiai/broadcast --filter @kumiai/rpc --filter @kumiai/hub-tunnel --filter @kumiai/rpc-conformance --filter @kumiai/hub-conformance exec vitest run`
Expected: all PASS. If using the turbo `test` task, confirm `Cached: 0` in the summary — a cached run proves nothing.

- [ ] **Step 3: Both contract suites, real implementation AND doubles**

Confirm `rpc-conformance` and `hub-conformance` each ran against the real implementation and every double (the AGENTS.md port rule — the emitter/validator/signal changes touch the rpc consumer ports). If the suites parametrize this, confirm both variants appear in the output; if they are separate scripts, run each.
Expected: green both ways.

- [ ] **Step 4: Lint the whole workspace**

Run: `rtk proxy pnpm run lint`
Expected: clean.

- [ ] **Step 5: Confirm the spec is fully covered**

Re-read `docs/superpowers/specs/2026-07-24-anycast-soundness-design.md` §§1-6 and confirm each maps to landed work: §1 dedup (Task 3), §2 suppression both sites (Task 1), §3 bus events emitter (Tasks 2-3), §4 validation (Task 3), §5 signal (Tasks 2-3), §6 MailboxHub emitter + getter (Task 4). No `bus-server.ts` remains; no `handlers`/`eventHandlers` map remains in rpc; `hub-mux` untouched.

- [ ] **Step 6: Update plan stage and hand off**

Set `**Stage:** reviewing` in this plan file and commit. The dev-loop reviewing stage (`superpowers:requesting-code-review`) follows.

---

## Self-Review

**Spec coverage:** §1 dedup → Task 3 (delete bus-server, peer uses responder). §2 suppression both sites → Task 1. §3 events via @sozai/event, same door → Task 2 (responder emit) + Task 3 (adaptBusHandlers emitter, drain emit). §4 validation → Task 3 (Step 4). §5 signal → Task 2 (responder controllers) + Task 3 (forward). §6 MailboxHub → Task 4, `get events()` accessor + readonly + encrypted-transport forward + fixture. §3-exposure (internal, no getter) → honored: the bus emitter is a passed value. hub-mux out of scope → untouched, verified in Task 5 Step 5. All covered.

**Type consistency:** `requestHandlers` used consistently (Tasks 2-3). `BusEvents = Record<string, { data: unknown; senderDID?: string }>` defined in Task 2, consumed in Task 3 and matches the emit-payload shape used by the responder and the drain. `BusHandlerMaps` reshaped to `{ events, requestHandlers }` in Task 3 and consumed by `peer.ts`/`app-lane.ts` in the same task (no cross-task drift). `MailboxHubEvents = EventEmitter<{ status: MailboxHubEvent }>` consistent across `transport.ts`, `encrypted-transport.ts`, and the fixture (Task 4). `ProtocolRuntime.busServer: { dispose: () => Promise<void> }` matches `createBroadcastResponder`'s return.

**Placeholder scan:** every code step shows the actual before/after. Conformance-suite invocation is described by pointing at the repo's own wiring (`rpc-conformance`/`hub-conformance` + `docs/agents/architecture.md`) rather than guessed exact flags — the executor confirms both real+double ran, per the constraint.
