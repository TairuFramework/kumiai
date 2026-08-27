# Dispose & Ordering Residuals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** qa
**Mode:** tasks

**Goal:** Close residuals #3, #4, #6, #7 from the close-medium-test-gaps triage — hub-tunnel subscribe ordering, a named disposed error, a post-dispose ledger-write guard, and a post-dispose publish guard.

**Architecture:** Four independent slices on one branch (`fix/dispose-ordering-residuals`). Task 1 adds `PeerDisposedError` (a prerequisite for Task 4). Tasks 2 and 3 are self-contained. Task 4 guards the mux's single publish funnel with an early "suspend publishing" signal so an in-flight lane op rejects instead of writing to the hub after dispose.

**Tech Stack:** TypeScript, pnpm workspace, vitest, biome. `@kumiai/rpc` and `@kumiai/hub-tunnel`.

**Spec:** `docs/superpowers/specs/2026-08-27-dispose-ordering-residuals-design.md`

## Global Constraints

- pnpm only; do not edit generated `lib/`.
- Run the real lint via `rtk proxy pnpm run lint` (the `rtk` shim fakes `pnpm exec biome`).
- Force tests and confirm `Cached: 0` — turbo replays cached results otherwise. `pnpm test -- --force` is broken; run the package's vitest directly (`pnpm --filter @kumiai/rpc test` after touching source, and check it actually ran).
- Every commit runs a pre-commit typecheck gate; keep types green.
- Commit message trailers as configured for this repo.

---

### Task 1: `PeerDisposedError` named class (residual #4)

**Files:**
- Create: `packages/rpc/src/errors.ts`
- Modify: `packages/rpc/src/index.ts` (export block ~line 19-33)
- Modify: `packages/rpc/src/peer.ts:735` (`assertLive`)
- Test: `packages/rpc/test/peer-dispose-race.test.ts` (upgrade existing `/disposed/i` assertions)

**Interfaces:**
- Produces: `export class PeerDisposedError extends Error` (from `errors.ts`, re-exported by `index.ts`). Task 4 imports it into `hub-mux.ts`.

- [ ] **Step 1: Write the failing test** — in `peer-dispose-race.test.ts`, upgrade the first disposed assertion (currently `peer-dispose-race.test.ts:30`, `await expect(pending).rejects.toThrow(/disposed/i)`) to assert the type. Add an import `import { PeerDisposedError } from '../src/index.js'` and change that assertion to:

```ts
await expect(pending).rejects.toBeInstanceOf(PeerDisposedError)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kumiai/rpc test peer-dispose-race`
Expected: FAIL — `PeerDisposedError` is not exported / thrown value is a plain `Error`.

- [ ] **Step 3: Create `errors.ts`**

```ts
/**
 * A peer that has been disposed refused an operation. A caller branches on this: retry against a
 * fresh peer, versus surface to the user. Lifecycle conditions a caller acts on get a named class;
 * programmer errors (`Unknown protocol`, no-MLS-port) stay bare `Error`.
 */
export class PeerDisposedError extends Error {
  override name = 'PeerDisposedError'
}
```

- [ ] **Step 4: Export from `index.ts`** — add `PeerDisposedError` to the exports (alphabetically near the `commit.js` error exports):

```ts
export { PeerDisposedError } from './errors.js'
```

- [ ] **Step 5: Throw it at `assertLive`** — `peer.ts:735`, add the import at the top (`import { PeerDisposedError } from './errors.js'`) and change:

```ts
const assertLive = (): void => {
  if (disposed) throw new PeerDisposedError('Peer is disposed')
}
```

Message is unchanged, so every other `/disposed/i` assertion in the suite keeps passing.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @kumiai/rpc test peer-dispose-race`
Expected: PASS.

- [ ] **Step 7: Upgrade the remaining message assertions** — grep the test file for `/disposed/i` (`peer-dispose-race.test.ts:30,42,65,213,272,305`). For each that asserts on a rejected peer op, switch to `rejects.toBeInstanceOf(PeerDisposedError)` where the thrown value is `assertLive`'s (leave any that assert on a *different* disposed message, e.g. a mux-level string, as regex). Re-run the file; expected PASS.

- [ ] **Step 8: Lint + commit**

```bash
rtk proxy pnpm run lint
git add packages/rpc/src/errors.ts packages/rpc/src/index.ts packages/rpc/src/peer.ts packages/rpc/test/peer-dispose-race.test.ts
git commit -m "feat(rpc): PeerDisposedError named class (residual #4)"
```

---

### Task 2: hub-tunnel subscribe ordering (residual #3)

**Files:**
- Modify: `packages/hub-tunnel/src/transport.ts` (subscribe ~214, writable `write` ~428-448, `teardown` ~259-286, contract doc ~180-190)
- Test: `packages/hub-tunnel/test/transport-ordering.test.ts` (add delayed-subscribe cases)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks rely on.

- [ ] **Step 1: Write the failing test — first-send gate.** In `transport-ordering.test.ts`, add a hub double whose `subscribe` resolves on a delayed macrotask (e.g. `await new Promise(r => setTimeout(r, 20))` before mutating the subscription set), everything else delegating to the existing `FakeHub` pattern used at `transport-ordering.test.ts:9`. Construct a transport, write a message immediately, have the double's peer reply on `receiveTopicID`, and assert the reply is delivered to the readable:

```ts
test('first send waits for the subscription to land', async () => {
  // delayed-subscribe double: subscribe resolves after a macrotask
  // ...construct transport, write() one frame, drive a reply on receiveTopicID...
  const first = await readFirstInbound(transport)
  expect(first).toEqual(expectedReplyFrame)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kumiai/hub-tunnel test transport-ordering`
Expected: FAIL — the publish races ahead of the delayed subscribe, the reply is not routed, `readFirstInbound` times out or yields the wrong frame.

- [ ] **Step 3: Capture the subscribe via an async IIFE** — `transport.ts:214`, replace the fire-and-forget line. The IIFE invokes `hub.subscribe` synchronously (preserving today's subscribe-before-`receive` call order at `:215`) while the try/catch absorbs a synchronous throw:

```ts
// Async IIFE, not Promise.resolve(hub.subscribe(...)) (a sync throw would escape construction)
// and not .then(() => hub.subscribe(...)) (would defer the call, reversing subscribe-before-receive).
const subscribed = (async () => {
  try {
    await hub.subscribe(localDID, receiveTopicID)
  } catch {
    // A failed subscribe yields no inbound frames; the send gate still proceeds.
  }
})()
```

- [ ] **Step 4: Gate the send path and re-check teardown** — in the writable `write` (`transport.ts:428`), after the existing `torndown` / `lockedSessionID` guards and before building the frame, add:

```ts
await subscribed
if (torndown) {
  throw new Error('Hub tunnel transport torn down')
}
```

The re-check is required: without it a write can pass the entry `torndown` guard, park on a delayed subscribe, have teardown flip `torndown`, then resume and publish before the unsubscribe runs.

- [ ] **Step 5: Run the first-send test to verify it passes**

Run: `pnpm --filter @kumiai/hub-tunnel test transport-ordering`
Expected: PASS.

- [ ] **Step 6: Write the failing tests — teardown ordering + parked-write.** Add a double whose `subscribe` resolves *after* a synchronous `unsubscribe` would run, recording subscribe/unsubscribe/publish order. Two assertions:

```ts
test('teardown unsubscribe is ordered after an in-flight subscribe', async () => {
  // ...construct, tear down before subscribe settles, flush...
  expect(hub.liveSubscriptions()).toEqual([])
  expect(hub.order).toEqual(['subscribe', 'unsubscribe'])
})

test('a write parked on a delayed subscribe does not publish after teardown', async () => {
  // ...construct; start write() while subscribe is delayed (it parks on `await subscribed`);
  //    tear down before subscribe settles; then settle subscribe and flush...
  await expect(pendingWrite).rejects.toThrow(/torn down/i)
  expect(hub.publishCalls()).toEqual([])   // the re-check stopped the parked write
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm --filter @kumiai/hub-tunnel test transport-ordering`
Expected: FAIL — unsubscribe runs before the subscribe lands, leaving a resurrected subscription.

- [ ] **Step 8: Order teardown's unsubscribe after the subscribe** — `transport.ts:274`, replace the immediate unsubscribe with one chained on `subscribed`:

```ts
void subscribed.then(() => hub.unsubscribe?.(localDID, receiveTopicID)).catch(() => {})
```

Keep `teardown` synchronous; only the unsubscribe is deferred.

- [ ] **Step 9: Update the contract doc block** — `transport.ts:180-190`: state that the first send is gated on the subscribe completing and that teardown's unsubscribe is ordered after it.

- [ ] **Step 10: Run tests to verify they pass**

Run: `pnpm --filter @kumiai/hub-tunnel test`
Expected: PASS (all transport tests).

- [ ] **Step 11: Lint + commit**

```bash
rtk proxy pnpm run lint
git add packages/hub-tunnel/src/transport.ts packages/hub-tunnel/test/transport-ordering.test.ts
git commit -m "fix(hub-tunnel): gate send and order teardown on subscribe (residual #3)"
```

---

### Task 3: ledger-waiter post-dispose write guard (residual #6)

**Files:**
- Modify: `packages/rpc/src/peer.ts` (ledger waiter IIFE ~1610-1626)
- Test: `packages/rpc/test/peer-dispose-race.test.ts` (new describe block)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks rely on.

- [ ] **Step 1: Write the failing test.** Model the fixture on the requester-side heal in `peer-dispose-race.test.ts:373-455`, but gate the *requester's* (alice's) `mls` port, not the responder's. Wrap alice's `MemoryGroupMLS` so `openSealedLedger` parks on a gate and `bootstrapLedger` is a spy:

```ts
describe('dispose against a requester ledger reply already in its IIFE', () => {
  test('bootstrapLedger is not called after dispose', async () => {
    // bob serves a COMPLETE ledger so alice's requestLedger waiter reaches openSealedLedger.
    let openEntered = false
    let openResumed = false
    let bootstrapCalls = 0
    let openGate = (): void => {}
    const gate = new Promise<void>((resolve) => { openGate = resolve })

    const aliceInner = createMemoryGroupMLS({ /* ...as sibling, alice params... */ })
    const aliceMLS: MemoryGroupMLS = {
      ...aliceInner,
      async openSealedLedger(sealed, requestID) {
        openEntered = true
        await gate
        openResumed = true
        return await aliceInner.openSealedLedger(sealed, requestID)
      },
      async bootstrapLedger(tokens) {
        bootstrapCalls++
        return await aliceInner.bootstrapLedger(tokens)
      },
    }
    // ...build alice with mls: aliceMLS, drive recover() so the waiter reaches openSealedLedger...
    expect(openEntered).toBe(true)

    await alice.peer.dispose()
    openGate()
    await flush(80)

    expect(openResumed).toBe(true)        // the IIFE resumed and reached the guard
    expect(bootstrapCalls).toBe(0)         // the host write did not run
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kumiai/rpc test peer-dispose-race`
Expected: FAIL — `bootstrapCalls` is 1; the parked IIFE resumed and wrote through the host handle.

- [ ] **Step 3: Add the guards** — `peer.ts`, in the `ledgerWaiters.set` callback IIFE (~1611):

```ts
ledgerWaiters.set(requestID, (sealed) => {
  void (async () => {
    if (settled || disposed) return
    try {
      const tokens = await port.openSealedLedger(sealed, requestID)
      if (tokens == null) return
      // Re-check: `disposed` can flip during the openSealedLedger await, and bootstrapLedger
      // REPLACES the host-owned ledger — it must not run against a torn-down handle.
      if (disposed) return
      await port.bootstrapLedger(tokens)
      finish(true)
    } catch {
      // ...unchanged...
    }
  })()
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kumiai/rpc test peer-dispose-race`
Expected: PASS.

- [ ] **Step 5: Mutation-check the guard.** Temporarily delete the `if (disposed) return` line before `bootstrapLedger`; re-run; confirm the test FAILS (`bootstrapCalls` is 1). Restore the line; confirm PASS. This proves the test bites the decisive guard.

- [ ] **Step 6: Lint + commit**

```bash
rtk proxy pnpm run lint
git add packages/rpc/src/peer.ts packages/rpc/test/peer-dispose-race.test.ts
git commit -m "fix(rpc): guard ledger waiter against post-dispose host write (residual #6)"
```

---

### Task 4: guard the mux publish paths against post-dispose lanes (residual #7)

**Files:**
- Modify: `packages/rpc/src/hub-mux.ts` (state ~290, `bus.publish` ~587, `mailbox.publish` ~596, `publish` ~665, interface `MuxType`/returned object ~150 & ~698-728)
- Modify: `packages/rpc/src/peer.ts` (`dispose` ~2056-2080)
- Test: `packages/rpc/test/peer-dispose-race.test.ts` (new describe block)

**Interfaces:**
- Consumes: `PeerDisposedError` from Task 1 (`import { PeerDisposedError } from './errors.js'` in `hub-mux.ts`).
- Produces: `suspendPublishing(): void` on the mux object; all three mux publish paths (`publish`, `bus.publish`, `mailbox.publish`) throw `PeerDisposedError` once suspended.

- [ ] **Step 1: Write the failing test.** Park a `commit()` op mid-mutex by gating the host `build()` callback, then dispose. Build alice against a recording hub:

```ts
describe('dispose against a lane op already inside the commit mutex', () => {
  test('an in-flight publish is refused, not written to the hub', async () => {
    let buildEntered = false
    let releaseBuild = (): void => {}
    const buildGate = new Promise<void>((resolve) => { releaseBuild = resolve })
    // ...alice on a recording hub, healthy single-member group so commit reaches build()...

    const op = alice.peer.commit(async () => {
      buildEntered = true
      await buildGate            // park the op AFTER assertLive, BEFORE mux.publish
      return await realBuild()   // the normal PendingCommit builder for this fixture
    })
    const owned = op.catch(() => {})
    await flush()
    expect(buildEntered).toBe(true)

    const disposing = alice.peer.dispose()
    recorder.start()
    releaseBuild()

    await expect(op).rejects.toBeInstanceOf(PeerDisposedError)
    await disposing
    await owned
    expect(recorder.calls()).toEqual([])   // no publish reached the hub
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kumiai/rpc test peer-dispose-race`
Expected: FAIL — the op runs past `build()` and `mux.publish` writes the commit to the hub; `recorder.calls()` is non-empty and the op does not reject with `PeerDisposedError`.

- [ ] **Step 3: Add the suspend flag + guard all three publish paths** — `hub-mux.ts`. Add the import (`import { PeerDisposedError } from './errors.js'`). Beside `let disposed = false` (~290) add `let publishSuspended = false`. Add the same guard as the first line of each of the three routes to `hub.publish` — `publish` (~665, before `assertSubscribable`), `bus.publish` (~587), and `mailbox.publish` (~596):

```ts
if (publishSuspended) throw new PeerDisposedError('mux: publish after dispose')
```

`bus`/`mailbox` are the broadcast and directed-tunnel routes; guarding only `publish` would leave an app or directed publish able to land post-dispose. In `dispose` (~708), after `disposed = true`, also set `publishSuspended = true` (belt-and-suspenders; idempotency guard stays on `disposed`).

- [ ] **Step 4: Expose `suspendPublishing` on the mux** — add to the returned object (~698-728) and to the mux's TypeScript interface (`MuxType`, ~150):

```ts
suspendPublishing: (): void => {
  publishSuspended = true
},
```

- [ ] **Step 5: Call it first thing in `peer.dispose`** — `peer.ts:2057`, immediately after `disposed = true` and before `await settled`:

```ts
disposed = true
mux.suspendPublishing()
await settled
// ...rest unchanged; mux.dispose() stays last...
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @kumiai/rpc test peer-dispose-race`
Expected: PASS — the op rejects with `PeerDisposedError` and no publish reaches the hub.

- [ ] **Step 7: Cover all three routes separately + mutation-check each.** The commit-lane test (Steps 1-6) covers primary `publish`. Add a `bus.publish` test (park an app broadcast before dispose — gate the encrypt/wrap step, fire `dispose()`, release) and a `mailbox.publish` test (same, for a directed publish); each asserts `PeerDisposedError` and an empty recorder. Three separate assertions are required — testing primary plus just one of bus/mailbox leaves the third guard deletable with no test failing. Then mutation-check **each guard independently**: remove the guard line from `publish`, re-run, confirm only the primary test fails; restore. Repeat for `bus.publish` and `mailbox.publish`.

Note in the test file (comment) the documented boundary: the guard stops publishes that have **not yet entered** the mux; a publish already awaiting `hub.publish` is on the wire and is out of scope (closing it would need the rejected unbounded drain).

- [ ] **Step 8: Full rpc suite + lint + commit**

```bash
pnpm --filter @kumiai/rpc test    # confirm it actually ran (not a cache replay)
rtk proxy pnpm run lint
git add packages/rpc/src/hub-mux.ts packages/rpc/src/peer.ts packages/rpc/test/peer-dispose-race.test.ts
git commit -m "fix(rpc): guard mux.publish against post-dispose lane ops (residual #7)"
```

---

### Task 5: prune the residual file & file the new residuals

**Files:**
- Delete: `docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md`
- Create: a new `next/` residual for the three out-of-scope teardown hazards

- [ ] **Step 1: Write the new residual** — create `docs/agents/plans/next/2026-08-27-dispose-teardown-hazards.md` capturing the three items from the spec's "Out of scope" section verbatim (teardownEpoch throw skips `mux.dispose()`; un-awaited `iterator.return?.()`; residual `inboxLane` closure), each with its file:line and why it was deferred.

- [ ] **Step 2: Remove the closed residual file** — all four of its items (#3, #4, #6, #7) are now closed by this branch.

```bash
git rm docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md
git add docs/agents/plans/next/2026-08-27-dispose-teardown-hazards.md
git commit -m "docs: close test-gap residuals #3,#4,#6,#7; file dispose-teardown hazards"
```

---

## Self-Review

**Spec coverage:**
- Slice 4 (PeerDisposedError) → Task 1. ✓
- Slice 1 (subscribe ordering: defer + send gate + teardown order) → Task 2 (steps 3, 4, 8). ✓
- Slice 2 (ledger double-guard) → Task 3. ✓
- Slice 3 (mux.publish guard + suspendPublishing + peer.dispose call) → Task 4. ✓
- Out-of-scope residuals filed → Task 5. ✓
- Dependency (Slice 4 before Slice 3) → Task 1 before Task 4, `PeerDisposedError` imported in Task 4 Step 3. ✓

**Type consistency:** `PeerDisposedError` (Task 1) is the same symbol imported in Task 4. `suspendPublishing` named identically in hub-mux interface (Task 4 Step 4) and the peer.dispose call (Step 5). `subscribed` promise (Task 2) used in both the send gate and teardown. ✓

**Placeholder scan:** Test fixtures reference sibling tests by line for MLS boilerplate (intentional — repeating 80-line crypto fixtures verbatim is error-prone and the executor reads the file), but every decisive assertion and every source edit is shown in full. ✓
