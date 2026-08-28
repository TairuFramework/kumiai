# Dispose-teardown hazards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks

**Goal:** Make `dispose()` fully finish what it starts across `@kumiai/rpc` (`peer.ts`, `hub-mux.ts`) and `@kumiai/hub-tunnel` (`transport.ts`) — always reach `mux.dispose()`, wait for the receive drain to close, run the full cleanup on every teardown path, and stay correct under concurrent callers.

**Architecture:** Four interacting slices settled onto one branch. `peer.dispose` and `mux.dispose` each become a synchronous function that runs an eager prologue then memoizes one in-flight promise (so concurrent callers share the outcome); inside those promises, `peer.dispose` collects errors from `teardownEpoch()` and `mux.dispose()` (never losing either) and clears `inboxLane` unconditionally, while `mux.dispose` awaits the drain close. In `transport.ts`, the timer/listener/subscription/iterator teardown is extracted into one `releaseResources()` that every teardown path calls, the `'disposed'` listener becomes async and awaits the receive-close promise, and the hub-status registration is guarded against a pre-aborted construction teardown.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, pnpm + turbo, biome. Cross-repo: `@sozai/event` (`emit` awaits listeners and rethrows), enkaku `Transport` (`dispose()` awaits `emit('disposed')`).

**Spec:** `docs/superpowers/specs/2026-08-27-dispose-teardown-hazards-design.md` — the plan argues from the spec; read both. The spec carries the full rationale, the corrected `@sozai/event` premise (Finding D), and the accepted boundaries.

## Global Constraints

- **pnpm only.** Do not edit generated files (`lib/`). Internal `@kumiai/*` deps are `workspace:^`.
- **Run the real lint**, never the `rtk` shim's fake: `rtk proxy pnpm run lint` (or `pnpm exec biome check` directly). Do this before staging.
- **Verify tests actually ran** — turbo caches. Force and confirm `Cached: 0` in the output; `pnpm test -- --force` is broken, so use `pnpm --filter <pkg> test` and check the cache line, or clear the turbo cache.
- **No port-contract changes.** None of these edits touch a port surface, so the `rpc-conformance` / `hub-conformance` suites need no re-run for correctness (still run the two package suites).
- **Commit trailers** on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01SogXmzsMoJj34YhYgAtKnG
  ```
- **Pre-commit gate** runs lint + typecheck; a commit that fails it does not land. Keep types green.
- **`mls: GroupMLS` is host-passed** — a post-dispose write through it corrupts host-shared state. This is why the disposal guards are correctness, not hygiene. Do not weaken them.
- **Preserve the residual #7 ordering invariant:** in both `dispose()` methods the eager prologue (`disposed = true`, then `suspendPublishing()`/`publishSuspended = true`) MUST run synchronously on the first call, before anything is awaited.

---

### Task 1: `hub-mux.ts` `dispose` — await the drain close (Slice 2) + memoize the in-flight disposal (Slice 4/B)

**Files:**
- Modify: `packages/rpc/src/hub-mux.ts` (the `dispose` method, ~741-764)
- Test: `packages/rpc/test/hub-mux-dispose.test.ts` (create)

**Interfaces:**
- Consumes: `createHubMux({ hub, localDID })` (existing factory); `FakeHub` from `./fixtures/fake-hub.js`; the `MailboxHub`/receive-subscription shape used by the transport tests.
- Produces: `mux.dispose()` still typed `(): Promise<void>` (external type unchanged — the `async` moves to an inner IIFE). After this task, `mux.dispose()` (a) does not resolve until the hub receive-iterator's `return()` has settled, and (b) returns one shared promise to concurrent callers, so a second `dispose()` observes the same completion and the same rejection, and the disposal body runs once.

- [ ] **Step 1: Write the failing tests**

Create `packages/rpc/test/hub-mux-dispose.test.ts`. Build a hub whose `receive()` returns a subscription whose async-iterator `return()` you control (resolve on a delayed tick, or reject), and count `return()` invocations. Reuse `FakeHub` for everything except `receive`, which you wrap so the mux drains your controllable iterator.

```ts
import { fromUTF } from '@sozai/codec'
import { describe, expect, test, vi } from 'vitest'

import { createHubMux } from '../src/hub-mux.js'
import { FakeHub } from './fixtures/fake-hub.js'

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

// A hub that delegates to FakeHub but hands the mux a receive subscription whose
// iterator.return() is controllable: it counts calls and settles on `gate`.
function controllableReceiveHub(gate: Promise<unknown>) {
  const fake = new FakeHub()
  let returnCalls = 0
  const hub = {
    ...fakeAsMailbox(fake), // publish/subscribe/unsubscribe delegate to fake (see note)
    receive: (subscriberDID: string) => {
      const inner = fake.receive(subscriberDID)
      const iterator = inner[Symbol.asyncIterator]()
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => iterator.next(),
            return: async (v?: unknown) => {
              returnCalls++
              await gate // delays (or rejects) the close
              return iterator.return ? iterator.return(v) : { done: true, value: undefined }
            },
          }
        },
        ack: inner.ack?.bind(inner),
      }
    },
  }
  return { hub, returnCalls: () => returnCalls }
}
```

Then three tests (assertions are the contract; adapt the double to the real `MailboxHub`/receive types — read `hub-mux.ts` for the exact `receive` return shape and `fakeAsMailbox` equivalent, mirroring `recordingHub` in `packages/hub-tunnel/test/transport-teardown.test.ts`):

1. **Await the close (Slice 2).** With a `gate` that resolves after a delayed tick: call `mux.dispose()` without awaiting; assert it has NOT resolved before the gate settles (e.g. a `settled` flag flipped in `.then`), then release the gate and assert it resolves. Assert `returnCalls() === 1`.
2. **Concurrent callers share one disposal (Slice 4/B).** Call `mux.dispose()` twice without awaiting the first; assert the second does not resolve before the gate settles (both settle together), and `returnCalls() === 1` (body ran once).
3. **Shared rejection (Slice 4/B + Finding D consistency).** With a `gate` that rejects: both concurrent `mux.dispose()` promises reject with the same error.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kumiai/rpc test hub-mux-dispose` (confirm `Cached: 0`).
Expected: FAIL — on current code `mux.dispose()` resolves before `return()` settles (test 1), and a second call resolves immediately via the bare `if (disposed) return` (tests 2-3).

- [ ] **Step 3: Implement — memoized promise wrapping the awaited body**

In `packages/rpc/src/hub-mux.ts`, replace the current `dispose: async () => { if (disposed) return; disposed = true; … iterator.return?.() }` with the memoized form (spec Slice 4, mux block). Keep every existing body statement (`sleeping` wakes, `pending.clear()`, `sinks` close+delete, `refcount.clear()`, `listeners.clear()`) and the "SUBSCRIPTIONS STAND" comment; the only changes are: (a) the eager prologue (`disposed = true`, `publishSuspended = true`) runs synchronously before the IIFE; (b) the body is wrapped in a memoized IIFE; (c) the trailing `iterator.return?.()` becomes `await iterator.return?.()`.

```ts
let disposePromise: Promise<void> | undefined
// …inside the returned object:
dispose: () => {
  if (disposePromise != null) return disposePromise
  disposed = true          // synchronous-first: other guards read `disposed` immediately
  publishSuspended = true
  disposePromise = (async () => {
    for (const wake of [...sleeping]) wake()
    pending.clear()
    for (const sink of [...sinks]) { sink.close(); sinks.delete(sink) }
    refcount.clear()
    listeners.clear()
    await iterator.return?.()
  })()
  return disposePromise
},
```

Declare `let disposePromise: Promise<void> | undefined` in the same closure scope as `disposed`. Keep the existing belt-and-suspenders comment on `publishSuspended`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kumiai/rpc test hub-mux-dispose` (confirm `Cached: 0`). Expected: PASS.

- [ ] **Step 5: Run the full package suite + lint + typecheck**

Run: `pnpm --filter @kumiai/rpc test` (confirm `Cached: 0`), then `rtk proxy pnpm run lint`. Expected: all existing mux/peer tests still green (they `await mux.dispose()`, unaffected by the type-preserving change).

- [ ] **Step 6: Commit**

```bash
git add packages/rpc/src/hub-mux.ts packages/rpc/test/hub-mux-dispose.test.ts
git commit   # message: "fix(rpc): mux.dispose awaits the drain close and memoizes concurrent callers"
```

---

### Task 2: `peer.ts` `dispose` — error aggregation (Slice 1) + clear `inboxLane` (Slice 3) + memoize (Slice 4/C)

**Files:**
- Modify: `packages/rpc/src/peer.ts` (the `dispose` method, ~2060-2091; `inboxLane` declared ~381, set ~573)
- Test: `packages/rpc/test/peer-dispose-race.test.ts` (extend — established harness)

**Interfaces:**
- Consumes: `makeMLSPeer(hub, did, rootSecret, { epoch, members })` from `./fixtures/peer.js` (returns `{ peer, … }`); `FakeHub`; `createRecordingHub`/`createMemoryGroupMLS` fixtures; `PeerDisposedError` from `../src/index.js`; `mux.dispose()` from Task 1 (now memoized and awaitable, and able to reject).
- Produces: `peer.dispose()` still typed `(): Promise<void>`. After this task: `mux.dispose()` always runs even when `teardownEpoch()` rejects; a lone teardown failure rethrows its `AggregateError` unwrapped, both-fail surfaces an `AggregateError` of both; `inboxLane` is cleared unconditionally; concurrent `peer.dispose()` calls share one promise and run the body once.

- [ ] **Step 1: Write the failing tests**

Extend `packages/rpc/test/peer-dispose-race.test.ts` with a new `describe('dispose reaches mux teardown and is idempotent', …)`. You need two observables:

- **"mux.dispose ran"**: build the peer over a hub whose `receive(localDID)` subscription records whether its iterator `return()` was called (the last thing `mux.dispose` does). Assert it was called even when a child rejected. (Mirror the controllable/recording receive from Task 1 / `createRecordingHub`.)
- **"a child disposal rejects"**: make one child the peer disposes in `teardownEpoch()` reject on dispose. Use the least-invasive seam the fixtures already expose (e.g. a `createMemoryGroupMLS`/runtime double whose teardown-triggered call throws, following the injection patterns already in this file at the `bobMLS`/`aliceMLS` doubles). **Verify the red phase first** — without the fix, forcing the child reject must leave the mux-`return` observable un-called.

Tests:
1. **Child reject still reaches mux (Slice 1).** Build peer; arrange one child's dispose to reject; `await expect(peer.dispose()).rejects.toBeInstanceOf(AggregateError)` (the unwrapped `teardownEpoch()` `AggregateError`); assert the mux-`return` observable fired.
2. **Both fail → AggregateError of both.** Additionally force `mux.dispose()` to reject (Task 1 makes this reachable via a rejecting receive-`return`); assert `peer.dispose()` rejects with an `AggregateError` whose `.errors` has length 2.
3. **`inboxLane` dropped (Slice 3).** After a normal `peer.dispose()`, `.to()`/`protocol().to()` is refused with `PeerDisposedError` (already covered by existing tests via `assertLive`); add the light assertion that dispose completes cleanly on the started peer. (The private closure var has no getter — assert indirectly per spec.)
4. **Concurrent dispose shares one promise (Slice 4/C).** Call `peer.dispose()` twice without awaiting the first; assert both settle together and the disposal body ran once — e.g. the mux-`return` observable fired exactly once, and `teardownEpoch`'s effect (children disposed) happened once.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kumiai/rpc test peer-dispose-race` (confirm `Cached: 0`).
Expected: FAIL — test 1's mux-`return` observable is not called (current sequential `await teardownEpoch(); await mux.dispose()` aborts before the mux on a child reject); test 4's body runs twice (no idempotency guard).

- [ ] **Step 3: Implement — memoized body with error collection and unconditional `inboxLane` clear**

In `packages/rpc/src/peer.ts`, rewrite the `dispose` method to the spec Slice 4 (peer block). Keep the eager prologue synchronous-first (`disposed = true`, then `mux.suspendPublishing()`, with their existing explanatory comments). Wrap the rest in a memoized IIFE. Inside, keep the entire existing body **between `await settled` and the teardown tail unchanged** (`commitUnsubscribe?.()`, `rendezvousUnsubscribe?.()`, the recovery-waiter drain + clear, the timer/waiter clears, `ledgerWaiters.clear()`, `suppressedRequests.clear()`). Replace only the tail `await teardownEpoch(); await mux.dispose()` with the error-collecting block + unconditional `inboxLane = undefined` + aggregated throw:

```ts
let disposePromise: Promise<void> | undefined
// …inside the returned object:
dispose: () => {
  if (disposePromise != null) return disposePromise
  disposed = true              // synchronous-first
  mux.suspendPublishing()      // synchronous-first, before any await (residual #7 invariant)
  disposePromise = (async () => {
    await settled
    // …existing unsubscribe / recovery-drain / timer-and-waiter clears, unchanged…
    const disposeErrors: unknown[] = []
    try { await teardownEpoch() } catch (error) { disposeErrors.push(error) }
    try { await mux.dispose() } catch (error) { disposeErrors.push(error) }
    inboxLane = undefined
    if (disposeErrors.length === 1) throw disposeErrors[0]
    if (disposeErrors.length > 1) throw new AggregateError(disposeErrors, 'Peer dispose failed')
  })()
  return disposePromise
},
```

Declare `let disposePromise: Promise<void> | undefined` in the same scope as `disposed`. Confirm `inboxLane` is a mutable `let` reachable here (declared ~381).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kumiai/rpc test peer-dispose-race` (confirm `Cached: 0`). Expected: PASS.

- [ ] **Step 5: Mutation-check the Slice 1 guards**

Confirm the tests bite (per `[[Mutation-check tests bite]]` discipline — break the guard, watch exactly the right test fail, restore):
- Replace the two `try/catch` blocks with plain `await teardownEpoch(); await mux.dispose()` → test 1 (mux-`return` observable) must fail. Restore.
- Replace with `try { await teardownEpoch() } finally { await mux.dispose() }` → test 2 (both-fail AggregateError) must fail: the surfaced error becomes only `mux.dispose()`'s. Restore.
- Remove the `if (disposePromise != null) return disposePromise` memo → test 4 must fail (body runs twice). Restore.

- [ ] **Step 6: Full package suite + lint**

Run: `pnpm --filter @kumiai/rpc test` (confirm `Cached: 0`), then `rtk proxy pnpm run lint`. Expected: green.

- [ ] **Step 7: Commit**

```bash
git add packages/rpc/src/peer.ts packages/rpc/test/peer-dispose-race.test.ts
git commit   # message: "fix(rpc): peer.dispose always reaches mux teardown, clears inboxLane, memoizes"
```

---

### Task 3: `transport.ts` — extract `releaseResources()`, route every teardown path through it (Slice 2: cleanup-bypass + Findings D, E)

**Files:**
- Modify: `packages/hub-tunnel/src/transport.ts` (`teardown` ~273-299; inline `torndown` paths ~349-361 and ~390-404; the `'disposed'` listener ~485-487; `receiveClosed` new module-scoped var)
- Test: `packages/hub-tunnel/test/transport-teardown.test.ts` (extend — existing `recordingHub` harness)

**Interfaces:**
- Consumes: `createHubTunnelTransport({ hub, sessionID, localDID, sendTopicID, receiveTopicID, signal? })`; `recordingHub()` (records `published` + `unsubscribed`); `FakeHub`; `decodeFrame`.
- Produces: unchanged public transport API. After this task, every teardown path (voluntary `dispose()`, idle, abort, readable-pull error, `result.done`, remote `session-end`) runs the full cleanup via `releaseResources()`; `transport.dispose()` resolves only after the receive-close promise settles and rejects if it rejected; an async `return()` rejection on an involuntary path does not surface as an unhandled rejection.

- [ ] **Step 1: Write the failing tests**

Extend `packages/hub-tunnel/test/transport-teardown.test.ts`. Add a hub double whose `receive()` iterator `return()` you control (delayed / rejecting), on top of `recordingHub()`. Tests (assertions are the contract; wire the double against the real receive type):

1. **Cleanup-bypass fixed (the leak).** Drive an inline `torndown` path (feed a remote `session-end` frame, OR complete/err the iterator), then call `transport.dispose()`. Assert the full cleanup happened — `unsubscribed` contains `[localDID, receiveTopicID]`, and (with `reconnectTimeoutMs` set + a `hub.events` double) a later `'status'` `'reconnecting'` emission arms no reconnect timer (the hub-status listener was removed). Do this for all three inline paths (`next()` rejection, `result.done`, remote `session-end`).
2. **`session-end` ack ordering preserved.** On the remote `session-end` path, assert `ackHandled` is observed before the iterator's `return()` resolves (order the two via your controllable `return` + an ack recorder).
3. **Drain-await ordering (Slice 2).** With a delayed-`return` receive double: `transport.dispose()` does not resolve until `return()` settles (drive it via enkaku `dispose()` → `'disposed'`). Cover both routes: ordinary `dispose()`-triggers-`teardown`, and a remote `session-end` closes first then `dispose()` follows (the delayed `:402` return must delay `dispose()`).
4. **Rejection propagation (Finding D).** A receive double whose `return()` rejects: `await expect(transport.dispose()).rejects` with that error.
5. **Involuntary unhandled-safety (Finding D).** An idle-timeout or abort path whose `return()` rejects with NO following `dispose()`: assert no unhandled rejection surfaces (install a temporary `unhandledRejection`/`process.on` or vitest `onUnhandledRejection` probe; the no-op `catch` in `releaseResources()` must absorb it).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kumiai/hub-tunnel test transport-teardown` (confirm `Cached: 0`).
Expected: FAIL — inline paths leak the listener/unsubscribe (test 1); `dispose()` resolves before `return()` settles (test 3); a rejecting `return()` does not reject `dispose()` (test 4) and surfaces unhandled on the involuntary path (test 5).

- [ ] **Step 3: Implement — the `releaseResources()` extraction**

In `packages/hub-tunnel/src/transport.ts`:

1. Add a module-scoped `let receiveClosed: Promise<unknown> | undefined` and a `releaseResources` function holding what `teardown` used to do (timers, listeners, deferred unsubscribe, iterator close), with the Finding E try/catch wrappers and the Finding D unhandled-guard — verbatim from spec Slice 2:

```ts
let receiveClosed: Promise<unknown> | undefined
const releaseResources = (): void => {
  if (torndown) return
  torndown = true
  clearIdleTimer()
  clearReconnectTimer()
  if (unsubscribeEvents != null) {
    try { unsubscribeEvents() } catch { /* ignore */ }
    unsubscribeEvents = undefined
  }
  if (abortHandler != null && signal != null) {
    signal.removeEventListener('abort', abortHandler)
    abortHandler = undefined
  }
  void subscribed.then(() => hub.unsubscribe?.(localDID, receiveTopicID)).catch(() => {})
  try {
    const rawClose = iterator.return?.()
    receiveClosed = rawClose ?? undefined
    if (rawClose != null) void Promise.resolve(rawClose).catch(() => {})
  } catch {
    receiveClosed = undefined
  }
}
```

2. Reduce `teardown` to its voluntary-path extras (spec Slice 2):

```ts
const teardown = (error?: unknown): void => {
  if (torndown) return
  releaseResources()
  sendSessionEnd()
  if (error !== undefined && readableController != null) {
    try { readableController.error(error) } catch { /* already closed */ }
  }
}
```

3. Route the three inline paths through `releaseResources()`, keeping each path's own controller action (spec Slice 2):
   - `next()` reject (~349-354): `releaseResources(); controller.error(error)`.
   - `result.done` (~357-361): `releaseResources(); controller.close()`.
   - remote `session-end` (~390-404): **ack first, then release** —
     `ackHandled(message.sequenceID); try { controller.close() } catch {}; releaseResources(); onSessionEnd?.()`, with `handled = false` retained. Preserve the `transport.ts:398-399` ack-before-close comment; the inline paths still do NOT `sendSessionEnd`.

4. Make the `'disposed'` listener async and await the promise (spec Slice 2):

```ts
transport.events.on('disposed', async () => {
  teardown()
  await receiveClosed
})
```

Do NOT touch the hub-status registration block in this task — that guard is Task 4.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kumiai/hub-tunnel test transport-teardown` (confirm `Cached: 0`). Expected: PASS. Also run the two neighbouring suites that exercise these paths: `pnpm --filter @kumiai/hub-tunnel test transport-ordering transport-reconnect`.

- [ ] **Step 5: Mutation-check the leak + guards**

- Revert the three inline paths to their old partial cleanup (only `clearIdleTimer`) → test 1 must fail.
- Drop the `void Promise.resolve(rawClose).catch(…)` guard → test 5 (involuntary unhandled) must fail.
- Drop the try/catch around `unsubscribeEvents()` and make it throw → the exception-safety expectation (rest of cleanup still runs) must fail.
Restore after each.

- [ ] **Step 6: Full package suite + lint**

Run: `pnpm --filter @kumiai/hub-tunnel test` (confirm `Cached: 0`), then `rtk proxy pnpm run lint`. Expected: green (all existing teardown/abort/reconnect tests unaffected — they go through `teardown()` → `releaseResources()`).

- [ ] **Step 7: Commit**

```bash
git add packages/hub-tunnel/src/transport.ts packages/hub-tunnel/test/transport-teardown.test.ts
git commit   # message: "fix(hub-tunnel): route every teardown path through releaseResources; await + guard receive close"
```

---

### Task 4: `transport.ts` — guard hub-status registration against a pre-aborted construction teardown (Slice 2 / Finding A)

**Files:**
- Modify: `packages/hub-tunnel/src/transport.ts` (the hub-status registration block, ~489-509)
- Test: `packages/hub-tunnel/test/transport-teardown.test.ts` (extend)

**Interfaces:**
- Consumes: `createHubTunnelTransport({ …, signal })` with an already-aborted signal; `recordingHub()`; a `hub.events` double emitting `'status'`.
- Produces: a transport constructed with an already-aborted signal registers no hub-status listener (nothing to leak); normal construction registers as before.

- [ ] **Step 1: Write the failing test**

Add to `transport-teardown.test.ts`: construct a transport with `signal` already aborted (`const c = new AbortController(); c.abort(); …signal: c.signal`) and `reconnectTimeoutMs` set plus a `hub.events` double. `start()` tears down synchronously during construction. Assert the hub-status listener was never left registered — after construction, a `'status'` `'reconnecting'` emission arms no reconnect timer and triggers no `teardown` side-effect, and no `unsubscribeEvents` handle lingers (observe via the `hub.events` double's listener count, or that a later emission is inert).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kumiai/hub-tunnel test transport-teardown` (confirm `Cached: 0`).
Expected: FAIL — the unguarded `:489` block registers the listener after the pre-abort teardown, so the `'status'` emission is live and the listener leaks.

- [ ] **Step 3: Implement — the `!torndown` guard**

In `packages/hub-tunnel/src/transport.ts`, guard the registration block (spec Slice 2, Finding A):

```ts
if (!torndown && reconnectTimeoutMs != null && hub.events != null) {
  // …existing armReconnectTimer + hub.events.on('status', …) …
}
```

Only the leading `!torndown &&` is added; the block body is unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @kumiai/hub-tunnel test transport-teardown` (confirm `Cached: 0`). Expected: PASS.

- [ ] **Step 5: Mutation-check**

Remove the `!torndown &&` → the Step-1 test must fail again. Restore.

- [ ] **Step 6: Full package suite + lint, then commit**

Run: `pnpm --filter @kumiai/hub-tunnel test` (confirm `Cached: 0`), then `rtk proxy pnpm run lint`.

```bash
git add packages/hub-tunnel/src/transport.ts packages/hub-tunnel/test/transport-teardown.test.ts
git commit   # message: "fix(hub-tunnel): don't register hub-status listener after a pre-aborted teardown"
```

---

## Final verification (after all tasks)

- [ ] Run both package suites forced and confirm `Cached: 0`:
  `pnpm --filter @kumiai/rpc test` and `pnpm --filter @kumiai/hub-tunnel test`.
- [ ] `rtk proxy pnpm run lint` clean; typecheck clean (pre-commit gate proves it per commit).
- [ ] Conformance suites need no re-run (no port-contract change) — note it, don't skip the two package suites.
