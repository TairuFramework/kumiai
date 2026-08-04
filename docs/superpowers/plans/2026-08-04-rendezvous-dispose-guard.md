# Guard the rendezvous responder lane — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** planning
**Mode:** tasks
**Spec:** `docs/superpowers/specs/2026-08-04-rendezvous-dispose-guard-design.md`
**Branch:** `fix/rendezvous-dispose-guard`

**Goal:** Stop `@kumiai/rpc`'s two rendezvous responders publishing a sealed reply after `dispose()`,
and pin each guard with a test that fails when that guard alone is deleted.

**Architecture:** One `if (disposed) return` immediately before the `mux.publish` in each responder's
timer IIFE, and one test per guard. Each test gates the responder's MLS seal so the reply timer fires
and parks mid-seal, disposes the peer, then releases the gate and asserts the peer wrote nothing to
the hub — plus that the seal was actually entered, so an empty recording cannot pass for a delivery
that never arrived.

**Tech Stack:** TypeScript, vitest, pnpm/turbo. Test doubles are this package's own fixtures
(`FakeHub`, `createRecordingHub`, `createMemoryGroupMLS`, `makeMLSPeer`, `buildLedgerCommit`).

## Global Constraints

- pnpm only. Never edit generated files under `lib/`.
- **Each guard gets its own mutation check, run separately.** Deleting both at once and watching one
  test fail proves nothing about the other — that is exactly how the three original guards shipped
  unverified.
- Gate command: `pnpm exec turbo run test:types test:unit --filter=@kumiai/rpc --force`, and confirm
  the output says `Cached: 0`. **Never** `pnpm run test -- --filter X --force`: pnpm forwards both
  flags to each package's vitest and tsc, which die on `CACError: Unknown option --filter` and
  `tsc error TS5023`, filtering nothing. There is no root `test:types` script.
- `vitest -t` takes a **regex**. Never put `()` in a `-t` filter — it silently matches nothing and
  reports a vacuous pass. Confirm the run line says `1 passed | N skipped`.
- Lint with `rtk proxy pnpm run lint`. A bare `pnpm exec biome` is intercepted by a machine shim and
  does not report real output.
- A test double may be stricter than its port, never more permissive.
- Comment style: keep the non-obvious why, cut the essay. Match the density of neighbouring comments.
- Only the peer under test gets the recording hub; the other peer takes the bare `FakeHub`. A second
  live peer's publish/fetchTopic/subscribe traffic lands in the recording and the assertion could
  never be empty.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `packages/rpc/src/peer.ts` | The two guards, then the `assertLive` doc block | 1, 2, 3 |
| `packages/rpc/test/peer-dispose-race.test.ts` | Both new tests, appended | 1, 2 |
| `docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md` | Residual 5 removed | 3 |
| `docs/agents/plans/completed/2026-08-04-pin-dispose-lane-guards.complete.md` | Follow-on note closed | 3 |
| `.changeset/rendezvous-dispose-guard.md` | Release intent | 3 |

No new files. The recording fixture (`packages/rpc/test/fixtures/recording-hub.ts`) already exists on
`main` and is used as-is — do not modify it.

---

## Task 1: Guard `handleLedgerRequest`, and pin it

**Files:**
- Modify: `packages/rpc/src/peer.ts` (inside `handleLedgerRequest`, around `:951-976`)
- Test: `packages/rpc/test/peer-dispose-race.test.ts` (append a new `describe` at the end)

**Interfaces:**
- Consumes: `createRecordingHub(inner: LogHub): { hub: LogHub; calls: () => Array<string>; start: () => void }`
  from `./fixtures/recording-hub.js`; `createMemoryGroupMLS`, `type MemoryGroupMLS` from
  `./fixtures/memory-group-mls.js`; `createFakeCrypto` from `./fixtures/fake-crypto.js`;
  `makeMLSPeer`, `buildLedgerCommit` from `./fixtures/peer.js`. All are already imported at the top
  of the test file except `MemoryGroupMLS`, which Step 1 adds.
- Produces: nothing later tasks consume. Task 2 mirrors this task's structure but is independent.

- [ ] **Step 1: Add the one missing type import**

The test file already imports `createMemoryGroupMLS` from `./fixtures/memory-group-mls.js`. Widen
that import to carry the type as well:

```ts
import { createMemoryGroupMLS, type MemoryGroupMLS } from './fixtures/memory-group-mls.js'
```

- [ ] **Step 2: Append the failing test**

Append this `describe` block to the END of `packages/rpc/test/peer-dispose-race.test.ts`:

```ts
describe('dispose against a ledger reply whose timer already fired', () => {
  test('the sealed ledger is not published after dispose', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x89)

    const recorder = createRecordingHub(fake)

    // The gate goes on the SEAL, not the publish: it parks bob's reply IIFE exactly where the
    // window is — timer fired, so it has already deleted itself from `pendingLedgerReplies` and
    // dispose()'s clear sweep cannot reach it, but the publish has not happened yet.
    let sealEntered = false
    let openGate = (): void => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })

    const bobCrypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    const bobInner = createMemoryGroupMLS({
      recoverySecret: rs,
      epoch: 1,
      localDID: 'bob',
      members,
      onAdvance: (e) => bobCrypto.setEpoch(e),
    })
    const bobMLS: MemoryGroupMLS = {
      ...bobInner,
      async sealLedger(request: Uint8Array) {
        sealEntered = true
        await gate
        return await bobInner.sealLedger(request)
      },
    }

    const bob = makeMLSPeer(recorder.hub, 'bob', rs, {
      mls: bobMLS,
      crypto: bobCrypto,
      members,
      // Delay 0 so the reply timer fires within the test rather than under jitter.
      recovery: { timeoutMs: 120, getDelayMs: () => 0, deadlineMs: 600 },
    })
    await flush()
    // `handleLedgerRequest` checks `isLedgerComplete()` BEFORE sealing, so without an entry bob
    // returns early and never reaches the gate.
    await bob.peer.commit(buildLedgerCommit(bob, ['circle:x=Bob']))
    await flush()

    // Alice takes the bare hub: only the peer under test is recorded. Built plainly, exactly as
    // `peer-dispose-heal.test.ts:79-85` builds its rejoining peer — she needs no pre-adopted
    // commit, because it is her bootstrap and not a divergence that sends the requests.
    const alice = makeMLSPeer(fake, 'alice', rs, {
      epoch: 1,
      members,
      recovery: { timeoutMs: 120, getDelayMs: () => 0, deadlineMs: 600 },
    })
    await flush()

    // Her rejoin publishes a recoveryRequest (bob answers it — sealGroupInfo is NOT gated), then
    // gathers the ledger, which is the request bob parks on. It resolves once that gather times
    // out, so by the time it returns bob's timer has long since fired.
    await alice.peer.recover()

    // The proof the window is open. Without it, a delivery that stopped arriving would leave the
    // recording empty and this test would pass for nothing.
    expect(sealEntered).toBe(true)

    await bob.peer.dispose()
    recorder.start()

    openGate()
    await flush(80)

    // Unguarded, the parked IIFE resumes and publishes the sealed ledger to the rendezvous topic
    // from a peer its host tore down several awaits ago.
    expect(recorder.calls()).toEqual([])

    await alice.peer.dispose()
  })
})
```

- [ ] **Step 3: Run it — it must FAIL, before any guard exists**

```bash
pnpm exec vitest run --root packages/rpc test/peer-dispose-race.test.ts -t 'sealed ledger'
```

Expected: FAIL. The received array must contain a `publish:` entry whose topic ID is the rendezvous
topic. **Record the exact received array in your report** — "it failed" is not evidence; the traffic
it names is.

If instead it fails on `expect(sealEntered).toBe(true)`, the request never reached bob's seal. Do not
lengthen the flush and move on — report it, because the whole test rests on that delivery.

- [ ] **Step 4: Add the guard**

In `handleLedgerRequest`, immediately before its `await mux.publish({`:

```ts
          const sealed = await port.sealLedger(request.request)
          // This timer fired BEFORE dispose, so it had already deleted itself from
          // `pendingLedgerReplies` when dispose()'s clear sweep walked it — too late by
          // construction, not by race. Silent, like `onCommitDelivery`: there is no caller to
          // tell, and the catch below would swallow a throw anyway.
          if (disposed) return
          await mux.publish({
```

Change nothing else in the handler.

- [ ] **Step 5: Run it — it must now pass**

```bash
pnpm exec vitest run --root packages/rpc test/peer-dispose-race.test.ts -t 'sealed ledger'
```

Expected: PASS, and the run line must read `1 passed | N skipped` — anything else means the `-t`
filter matched the wrong set.

- [ ] **Step 6: Run the whole file**

```bash
pnpm exec vitest run --root packages/rpc test/peer-dispose-race.test.ts
```

Expected: all pass, 9 tests. If any pre-existing test now fails, STOP and report — this guard should
reach nothing else.

- [ ] **Step 7: Typecheck**

```bash
pnpm exec turbo run test:types --filter=@kumiai/rpc --force
```

Expected: pass. vitest strips types, so Steps 3-6 say nothing about what typechecks — in particular
the `{ ...bobInner, async sealLedger }` spread against `MemoryGroupMLS`.

- [ ] **Step 8: Commit**

```bash
git add packages/rpc/src/peer.ts packages/rpc/test/peer-dispose-race.test.ts
git commit -m "fix: refuse a ledger reply whose timer fired before dispose"
```

---

## Task 2: Guard `handleRecoveryRequest`, and pin it

**Files:**
- Modify: `packages/rpc/src/peer.ts` (inside `handleRecoveryRequest`, around `:879-907`)
- Test: `packages/rpc/test/peer-dispose-race.test.ts` (append a new `describe` at the end)

**Interfaces:**
- Consumes: the same fixtures as Task 1. The `MemoryGroupMLS` type import Task 1 added is already
  in place; do not add it twice.
- Produces: nothing later tasks consume.

- [ ] **Step 1: Append the failing test**

Append this `describe` block to the END of `packages/rpc/test/peer-dispose-race.test.ts`, after
Task 1's:

```ts
describe('dispose against a recovery reply whose timer already fired', () => {
  test('the sealed group info is not published after dispose', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x8a)

    const recorder = createRecordingHub(fake)

    // Same gate placement as the ledger reply, on this responder's own seal.
    let sealEntered = false
    let openGate = (): void => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })

    const bobCrypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    const bobInner = createMemoryGroupMLS({
      recoverySecret: rs,
      epoch: 1,
      localDID: 'bob',
      members,
      onAdvance: (e) => bobCrypto.setEpoch(e),
    })
    const bobMLS: MemoryGroupMLS = {
      ...bobInner,
      async sealGroupInfo(request: Uint8Array) {
        sealEntered = true
        await gate
        return await bobInner.sealGroupInfo(request)
      },
    }

    const bob = makeMLSPeer(recorder.hub, 'bob', rs, {
      mls: bobMLS,
      crypto: bobCrypto,
      members,
      recovery: { timeoutMs: 120, getDelayMs: () => 0, deadlineMs: 600 },
    })
    await flush()

    // Bare hub, built plainly — same as the ledger test.
    const alice = makeMLSPeer(fake, 'alice', rs, {
      epoch: 1,
      members,
      recovery: { timeoutMs: 120, getDelayMs: () => 0, deadlineMs: 600 },
    })
    await flush()

    // NOT awaited, unlike the ledger test: bob's groupInfo seal is the thing being held, so no
    // reply can reach her and this settles only on her own recovery timeout. The `.catch` owns
    // whichever way it settles — an unowned rejection fails the run somewhere else entirely.
    const rejoin = alice.peer.recover().catch(() => {})
    await flush(80)

    expect(sealEntered).toBe(true)

    await bob.peer.dispose()
    recorder.start()

    openGate()
    await flush(80)

    // Unguarded, the parked IIFE publishes a sealed GroupInfo to the rendezvous topic.
    expect(recorder.calls()).toEqual([])

    await rejoin
    await alice.peer.dispose()
  })
})
```

- [ ] **Step 2: Run it — it must FAIL, before this guard exists**

```bash
pnpm exec vitest run --root packages/rpc test/peer-dispose-race.test.ts -t 'sealed group info'
```

Expected: FAIL, with a `publish:` entry on the rendezvous topic in the received array. **Record the
exact received array in your report.**

A failure on `expect(sealEntered).toBe(true)` means alice's recoveryRequest never reached bob's seal
— report it rather than lengthening the flush.

- [ ] **Step 3: Add the guard**

In `handleRecoveryRequest`, immediately before its `await mux.publish({`:

```ts
          const groupInfo = await port.sealGroupInfo(request.request)
          // Same window as `handleLedgerRequest`'s guard: a timer that fired before dispose is
          // gone from `pendingReplies` by the time the clear sweep runs, and is then several
          // awaits from here. Silent, for the same reason.
          if (disposed) return
          // Mailbox class, deliberately: a rendezvous frame must never move the commit topic's
          // head, and its reader — the requester — subscribed before it asked.
          await mux.publish({
```

Keep the existing "Mailbox class, deliberately" comment where it is, directly above `mux.publish`.

- [ ] **Step 4: Run it — it must now pass**

```bash
pnpm exec vitest run --root packages/rpc test/peer-dispose-race.test.ts -t 'sealed group info'
```

Expected: PASS, run line `1 passed | N skipped`.

- [ ] **Step 5: Mutation-check Task 1's guard is still independently pinned**

Delete ONLY the `if (disposed) return` you added in Task 1 (`handleLedgerRequest`), then:

```bash
pnpm exec vitest run --root packages/rpc test/peer-dispose-race.test.ts
```

Expected: exactly ONE failure — the ledger test. Restore the guard, re-run, expect 10 passed.

This is the check the original three guards never got: two guards added on one branch, each proven to
be load-bearing on its own.

- [ ] **Step 6: Mutation-check this task's guard**

Delete ONLY the `if (disposed) return` in `handleRecoveryRequest`, then:

```bash
pnpm exec vitest run --root packages/rpc test/peer-dispose-race.test.ts
```

Expected: exactly ONE failure — the group-info test. Restore, re-run, expect 10 passed. Report both
received arrays.

- [ ] **Step 7: Typecheck**

```bash
pnpm exec turbo run test:types --filter=@kumiai/rpc --force
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add packages/rpc/src/peer.ts packages/rpc/test/peer-dispose-race.test.ts
git commit -m "fix: refuse a recovery reply whose timer fired before dispose"
```

---

## Task 3: Correct the doc block, close residual 5, and gate the branch

**Files:**
- Modify: `packages/rpc/src/peer.ts` (the `assertLive` doc block, around `:713-718`)
- Modify: `docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md`
- Modify: `docs/agents/plans/completed/2026-08-04-pin-dispose-lane-guards.complete.md`
- Create: `.changeset/rendezvous-dispose-guard.md`

**Interfaces:**
- Consumes: both guards from Tasks 1 and 2 must be in place — this task's doc text asserts they are.
- Produces: nothing.

- [ ] **Step 1: Rewrite the `assertLive` doc block's inbound sentence**

The current text says the rendezvous responder lane "still has no check" and points at residual 5.
Both halves stop being true with Tasks 1 and 2 landed. Replace those sentences with:

```
   * Set as `dispose()`'s FIRST statement. The peer's post-dispose rule has two forms and this is
   * the host-facing one: everything a HOST asks of a disposed peer is refused, loudly. The inbound
   * side is refused silently, where a delivery has no caller to tell: the commit lane
   * (`onCommitDelivery`), and the two rendezvous responders, whose reply timers can fire before
   * dispose and would otherwise land their publish after it.
```

Leave the rest of the doc block — the `await ready` paragraph and the `resync` note — untouched.

- [ ] **Step 2: Delete residual 5**

In `docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md`, remove the whole
`## 5. The rendezvous responder lane has no post-dispose check` section. Do NOT renumber sections 3
and 4 — their numbers are cited elsewhere.

Then update the origin paragraph at the top. It currently says residual 5 was opened by
`test/pin-dispose-lane-guards`'s final review on 2026-08-04; it must now say residual 5 was opened
and closed on 2026-08-04, by that review and by `fix/rendezvous-dispose-guard` respectively, leaving
only 3 and 4 open.

- [ ] **Step 3: Close the follow-on note in the previous branch's summary**

`docs/agents/plans/completed/2026-08-04-pin-dispose-lane-guards.complete.md` has a `## Follow-on`
section whose first paragraph describes residual 5 as open and points at the `next/` file. That
pointer dangles once Step 2 lands. Add one sentence to the END of that paragraph recording that it
was closed on `fix/rendezvous-dispose-guard`, 2026-08-04. Do not rewrite the rest of the paragraph —
it is a record of what was true then.

- [ ] **Step 4: Record the release intent**

Create `.changeset/rendezvous-dispose-guard.md`:

```markdown
---
'@kumiai/rpc': patch
---

A rendezvous reply whose timer fired before `dispose()` no longer publishes after it. Both
responders — `handleRecoveryRequest` and `handleLedgerRequest` — schedule a `setTimeout` whose
callback removes itself from its pending set before awaiting the MLS seal, so `dispose()`'s
`clearTimeout` sweep could not reach one already in flight, and a sealed GroupInfo or the group's
whole sealed ledger could go out from a torn-down peer.
```

- [ ] **Step 5: Gate the package**

```bash
pnpm exec turbo run test:types test:unit --filter=@kumiai/rpc --force
```

Expected: pass, and the output must say `Cached: 0`. **Quote that line in your report** — a cached
green proves nothing.

- [ ] **Step 6: Gate the whole repo**

```bash
pnpm exec turbo run test:types test:unit --force
pnpm exec vitest run --root tests/integration
rtk proxy pnpm run lint
```

Expected: all pass, `Cached: 0` on the turbo run. The integration suite is type-checked by the gate
but not executed by it, so it is run separately — this branch changes peer behaviour on a lane the
integration suite exercises.

- [ ] **Step 7: Confirm the branch diff is exactly what was planned**

```bash
git diff main --stat
```

Expected paths, and nothing else:

- `.changeset/rendezvous-dispose-guard.md`
- `docs/agents/plans/completed/2026-08-04-pin-dispose-lane-guards.complete.md`
- `docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md`
- `docs/superpowers/plans/2026-08-04-rendezvous-dispose-guard.md`
- `docs/superpowers/specs/2026-08-04-rendezvous-dispose-guard-design.md`
- `packages/rpc/src/peer.ts`
- `packages/rpc/test/peer-dispose-race.test.ts`

`packages/rpc/src/peer.ts` must be +6 −2 or thereabouts: two guards with their comments, and the doc
block sentence. If it is larger, something outside this plan's scope was changed — report it.

- [ ] **Step 8: Commit**

```bash
git add packages/rpc/src/peer.ts docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md docs/agents/plans/completed/2026-08-04-pin-dispose-lane-guards.complete.md .changeset/rendezvous-dispose-guard.md
git commit -m "docs: record the rendezvous guard and close residual 5"
```

---

## Verification Summary

1. Each guard fails its own test when deleted alone (Task 2, Steps 5-6), with the received arrays
   recorded — not "it failed".
2. Each test asserts `sealEntered` as well as the empty recording, so a delivery that stops arriving
   turns the test red rather than passing on an absence.
3. `peer-dispose-race.test.ts` ends at 10 tests, all passing.
4. Whole-repo gate forced with `Cached: 0`, integration suite run separately, lint clean.
5. Branch diff is the seven paths above.

## Risks

1. **The MLS spread.** `createMemoryGroupMLS` returns an object literal, so `{ ...bobInner, async
   sealLedger }` copies every other method by own property. If the fixture ever returns a class
   instance, the spread drops prototype methods and the test fails at some unrelated call — loudly,
   not vacuously.
2. **`getDelayMs: () => 0` is still a macrotask.** The timer fires on a later tick, not
   synchronously. `expect(sealEntered).toBe(true)` is what catches a flush that was too short; treat
   a failure there as a finding, not as a number to increase.
3. **Task 1 awaits `alice.peer.recover()` and Task 2 does not.** In Task 1 bob's groupInfo seal is
   open, so her rejoin completes and only the ledger gather times out. In Task 2 the groupInfo seal
   is the thing held, so her recover cannot complete and must not be awaited before the assertions.
