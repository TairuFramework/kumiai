# Pin the dispose guards on the rpc lane calls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks
**Spec:** `docs/superpowers/specs/2026-08-03-pin-dispose-lane-guards-design.md`
**Branch:** `test/pin-dispose-lane-guards`

**Goal:** Pin the post-dispose guards on `@kumiai/rpc`'s `replay()` and `recover()` with tests that
fail when the guard is deleted, and close the same hole in `onCommitDelivery`, which has no guard
at all.

**Architecture:** Three tests appended to `packages/rpc/test/peer-dispose-race.test.ts`, each
asserting both the refusal and that the disposed peer wrote nothing to the hub, plus one silent
`disposed` check added to `onCommitDelivery`. Every guard is verified by mutation — remove it,
watch the new test fail naming real hub traffic, restore it.

**Tech Stack:** TypeScript, vitest, pnpm/turbo. Test doubles are this package's own fixtures
(`FakeHub`, `createMemoryGroupMLS`, `createMemoryCommitJournal`, `makeMLSPeer`).

## Global Constraints

- pnpm only. Run repo scripts as `rtk proxy pnpm run <script>` — a local `rtk` shim intercepts
  plain `pnpm run` and redirects to the wrong tool.
- Do not edit generated files (`lib/`).
- **One shared recording wrapper, `test/fixtures/recording-hub.ts`, created in Task 1 and reused by
  Tasks 2 and 3.** This reverses two earlier rulings (the residual doc, and the
  close-medium-test-gaps final review) which said not to extract one. It holds here because all
  three new tests need the *identical* wrapper, so it takes no per-caller parameter — the failure
  mode those rulings guarded against ("a shared recorder gaining a parameter per caller") does not
  arise. Ruling made 2026-08-03.
- **Do not touch the three pre-existing inline wrappers** in `peer-dispose-race.test.ts`,
  `hub-mux-subscribe-failure.test.ts` and elsewhere. They record different fields, and converting
  them is not this branch's work. The new helper serves the three new tests only.
- `'Peer is disposed'` stays a bare `Error` (residual 4, deferred to `backlog/rpc-api-surface.md`).
  New tests therefore assert `/disposed/i` against the message prose, like their neighbours.
- Comment style: keep the non-obvious *why*, cut the essay.
- Every test in this plan is written red-first **by mutation**: the guard is removed, the test is
  run and must fail, then the guard is restored. A guard that ships without its mutation check is
  unverified no matter how much green surrounds it — that is precisely what produced this work.

## File Structure

- **Create** `packages/rpc/test/fixtures/recording-hub.ts` (Task 1) — a `LogHub` that delegates to
  an inner hub and records every call as a string once started. One responsibility, no options.
- **Modify** `packages/rpc/src/peer.ts` — one new guard in `onCommitDelivery` (Task 3); the
  `assertLive` doc block rewritten (Task 3). No other source change in this plan.
- **Modify** `packages/rpc/test/peer-dispose-race.test.ts` — three new `describe` blocks appended
  (Tasks 1, 2, 3); the in-flight-subscribe comment rewritten (Task 3).
- **Modify** `docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md` — trimmed to
  residuals 3 and 4 (Task 4).

---

### Task 1: Pin `replay()`'s post-dispose guard

**Files:**
- Create: `packages/rpc/test/fixtures/recording-hub.ts`
- Test: `packages/rpc/test/peer-dispose-race.test.ts` (append)
- Mutation target only, never left modified: `packages/rpc/src/peer.ts:1762`

**Interfaces:**
- Consumes: `makeMLSPeer`, `buildLedgerCommit` from `./fixtures/peer.js`; `FakeHub` from
  `./fixtures/fake-hub.js`; `createFakeCrypto` from `./fixtures/fake-crypto.js`;
  `createMemoryGroupMLS` from `./fixtures/memory-group-mls.js`; the file's existing
  `flush(ms = 40)` helper.
- Produces, and **Tasks 2 and 3 both depend on this exact signature**:

```ts
// packages/rpc/test/fixtures/recording-hub.ts
export type RecordingHub = {
  /** The hub to hand a peer. Delegates every call to the inner hub. */
  hub: LogHub
  /** Calls recorded since `start()`, in order. */
  calls: () => Array<string>
  /** Begin recording. Everything before this is delegated and forgotten. */
  start: () => void
}
export function createRecordingHub(inner: LogHub): RecordingHub
```

  Recorded call format, relied on by all three tests: `publish:<topicID>`, `subscribe:<topicID>`,
  `unsubscribe:<topicID>`, `fetchTopic:<topicID>`, and the bare string `receive`.

**Background the implementer needs:** unguarded, `replay()` reaches the hub through
`ensureLedger`, which publishes a ledgerRequest to the rendezvous topic (`peer.ts:1611`) whenever
`isLedgerComplete()` is false. Init runs `ensureLedger` too (`:1417`), but an incomplete ledger is a
standing degraded state, not something one gather repairs: against a responder that withholds an
entry, no reply ever passes the head check, so the seed's gather times out and every later lane
operation gathers again.

- [ ] **Step 1: Create the recording-hub fixture**

Create `packages/rpc/test/fixtures/recording-hub.ts`:

```ts
import type { LogHub } from '@kumiai/hub-tunnel'

export type RecordingHub = {
  /** The hub to hand a peer. Delegates every call to the inner hub. */
  hub: LogHub
  /** Calls recorded since `start()`, in order. */
  calls: () => Array<string>
  /** Begin recording. Everything before this is delegated and forgotten. */
  start: () => void
}

/**
 * A `LogHub` that delegates everything and records what it was asked for, from `start()` onwards.
 *
 * The late start is the point: a peer's init and teardown talk to the hub constantly, and what these
 * tests assert is that a peer talks to it NEVER — after a specific moment. Recording from
 * construction would bury that in a peer's ordinary life.
 *
 * Hand this to ONE peer. A live peer's mux drain calls `receive` on a loop, so a recorder shared
 * with a second peer can never report an empty list no matter what the peer under test does.
 */
export function createRecordingHub(inner: LogHub): RecordingHub {
  let recording = false
  const calls: Array<string> = []
  const record = (call: string): void => {
    if (recording) calls.push(call)
  }
  return {
    hub: {
      publish: (params) => {
        record(`publish:${params.topicID}`)
        return inner.publish(params)
      },
      subscribe: (subscriberDID, topicID, options) => {
        record(`subscribe:${topicID}`)
        return inner.subscribe(subscriberDID, topicID, options)
      },
      unsubscribe: (subscriberDID, topicID) => {
        record(`unsubscribe:${topicID}`)
        // Optional on `HubBase` (hub-tunnel/src/transport.ts:118), so optional here too.
        return inner.unsubscribe?.(subscriberDID, topicID)
      },
      receive: (subscriberDID) => {
        record('receive')
        return inner.receive(subscriberDID)
      },
      fetchTopic: (params) => {
        record(`fetchTopic:${params.topicID}`)
        return inner.fetchTopic(params)
      },
    },
    calls: () => calls,
    start: () => {
      recording = true
    },
  }
}
```

- [ ] **Step 2: Add the fixture imports the new test needs**

`peer-dispose-race.test.ts` imports none of these yet. Add them to the existing import block,
keeping the file's alphabetical ordering:

```ts
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { createRecordingHub } from './fixtures/recording-hub.js'
```

`buildLedgerCommit`, `FakeHub` and `makeMLSPeer` are already imported by this file.

- [ ] **Step 3: Append the failing test**

Append to the end of `packages/rpc/test/peer-dispose-race.test.ts`:

```ts
describe('dispose against a replay made afterwards', () => {
  test('replay() after dispose asks the group for nothing', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x86)
    const healMembers = ['alice', 'bob', 'carol']

    // Only the DISPOSED peer is wrapped; bob is handed the FakeHub directly. Both still talk to
    // one hub, because the recorder delegates to it.
    const recorder = createRecordingHub(fake)

    // The only responder withholds the last ledger entry, so every reply alice gathers fails the
    // head check and her bootstrap never completes. Her ledger stays incomplete for the rest of
    // her life, which is what keeps `ensureLedger` reaching for the hub on every lane operation —
    // including one made after she is gone.
    const bobCrypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    const bobMLS = createMemoryGroupMLS({
      recoverySecret: rs,
      epoch: 1,
      localDID: 'bob',
      members: healMembers,
      serveLedger: (ledger) => ledger.slice(0, ledger.length - 1),
      onAdvance: (e) => bobCrypto.setEpoch(e),
    })
    const bob = makeMLSPeer(fake, 'bob', rs, {
      mls: bobMLS,
      crypto: bobCrypto,
      members: healMembers,
      recovery: { timeoutMs: 100, getDelayMs: () => 5, deadlineMs: 400 },
    })
    await flush()
    await bob.peer.commit(buildLedgerCommit(bob, ['role:carol=admin', 'role:dave=admin']))
    await flush()

    const alice = makeMLSPeer(recorder.hub, 'alice', rs, {
      epoch: 1,
      members: healMembers,
      recovery: { timeoutMs: 100, getDelayMs: () => 5, deadlineMs: 400 },
    })
    await flush()
    await alice.peer.recover()
    expect(await alice.mls.isLedgerComplete()).toBe(false)

    await alice.peer.dispose()
    recorder.start()

    // Owned before the traffic assertion, exactly as the commit test does it: unguarded, `replay()`
    // does not reject promptly — it publishes its ledgerRequest and then waits the gather window
    // out on a timer `dispose()` never clears. Awaiting the rejection first would turn "it asked
    // the group for the ledger" into a bare timeout that names nothing.
    const op = alice.peer.replay()
    const owned = op.catch(() => {})
    await flush(150)

    expect(recorder.calls()).toEqual([])
    await expect(op).rejects.toThrow(/disposed/i)
    await owned

    await bob.peer.dispose()
  })
})
```

- [ ] **Step 4: Run it against the shipped guard — it must pass**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/rpc
pnpm exec vitest run test/peer-dispose-race.test.ts -t 'replay'
```

Expected: PASS. This only shows the test is well-formed; it proves nothing about the guard yet.

- [ ] **Step 5: Mutate — delete the guard and watch it fail**

Remove line 1762 of `packages/rpc/src/peer.ts` (the `assertLive()` inside `replay`, immediately
after its `await ready`). Re-run the command from Step 4.

Expected: FAIL, with the received array containing `publish:<rendezvous-topic>`.

If it passes, STOP. The test does not pin anything and the setup is wrong — the most likely cause
is alice's ledger having completed after all, which Step 3's `isLedgerComplete()` assertion should
have caught first.

- [ ] **Step 6: Restore the guard and confirm green**

Restore `assertLive()` at `peer.ts:1762`. Re-run Step 4's command.

Expected: PASS.

```bash
git diff --stat packages/rpc/src/peer.ts
```

Expected: no output. The source must be byte-identical to where the task started.

- [ ] **Step 7: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
git add packages/rpc/test/fixtures/recording-hub.ts packages/rpc/test/peer-dispose-race.test.ts
git commit -m "test: pin replay()'s post-dispose guard

Deleting assertLive() from replay() left the rpc suite green because
nothing called replay() after dispose. Unguarded it publishes a
ledgerRequest to the rendezvous topic from a peer whose host has already
torn it down; this test now fails when the guard goes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Pin `recover()`'s post-dispose guard

**Files:**
- Test: `packages/rpc/test/peer-dispose-race.test.ts` (append)
- Mutation target only, never left modified: `packages/rpc/src/peer.ts:1827`

**Interfaces:**
- Consumes: `makeMLSPeer` from `./fixtures/peer.js`, `FakeHub`, `createRecordingHub` from
  `./fixtures/recording-hub.js` (created in Task 1, already imported by this file after that task),
  the file's `flush` helper and its existing `members` const (`['alice', 'bob']`).
- Produces: nothing later tasks depend on.

**Background the implementer needs:** `recover()`'s early return cannot save it —
`teardownEpoch` never nulls `commitTopicID` or `rendezvousTopicID`, so a disposed peer still has
both. Unguarded it pulls the commit topic through `reconcileCommits`, reads the head
(`readCommitHead`), then publishes a recoveryRequest to the rendezvous topic (`peer.ts:1790`). No
second member exists here to answer it, so it waits its window out, breaks, and *resolves* — which
is why the traffic assertion must come before the rejection. The recovery window is set short only
so the mutation check is quick.

- [ ] **Step 1: Append the failing test**

Append to the end of `packages/rpc/test/peer-dispose-race.test.ts`:

```ts
describe('dispose against a recover made afterwards', () => {
  test('recover() after dispose asks the group for nothing', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x87)

    const recorder = createRecordingHub(fake)

    // A short rendezvous window, and the only member on the topic. Unguarded, `recover()` cannot be
    // answered and is not refused either: it pulls, publishes its request, waits the window out and
    // RESOLVES. The window is short so the mutation check does not sit on a timer.
    const alice = makeMLSPeer(recorder.hub, 'alice', rs, {
      epoch: 1,
      members,
      recovery: { timeoutMs: 50, getDelayMs: () => 5, deadlineMs: 200 },
    })
    await flush()
    await alice.peer.dispose()
    recorder.start()

    // Owned before the traffic assertion, for the same reason as the commit test: the damage lands
    // long before the promise settles.
    const op = alice.peer.recover()
    const owned = op.catch(() => {})
    await flush(120)

    expect(recorder.calls()).toEqual([])
    await expect(op).rejects.toThrow(/disposed/i)
    await owned
  })
})
```

- [ ] **Step 2: Run it against the shipped guard — it must pass**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/rpc
pnpm exec vitest run test/peer-dispose-race.test.ts -t 'recover'
```

Expected: PASS.

- [ ] **Step 3: Mutate — delete the guard and watch it fail**

Remove line 1827 of `packages/rpc/src/peer.ts` (the `assertLive()` inside `recover`, immediately
after its `await ready`). Re-run the command from Step 2.

Expected: FAIL, with the received array containing a `fetchTopic:` on the commit topic and
`publish:<rendezvous-topic>`.

If it passes, STOP — most likely `recover()` took its early return, which would mean
`commitTopicID`/`rendezvousTopicID` are being cleared somewhere this plan did not account for.

- [ ] **Step 4: Restore the guard and confirm green**

Restore `assertLive()` at `peer.ts:1827`. Re-run Step 2's command.

Expected: PASS.

```bash
git diff --stat packages/rpc/src/peer.ts
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
git add packages/rpc/test/peer-dispose-race.test.ts
git commit -m "test: pin recover()'s post-dispose guard

Unguarded, recover() is not stopped by its early return — teardownEpoch
leaves both control topics set — so a disposed peer pulls the commit log
and publishes a recovery request. On a reply it would publish an external
commit and rotate the ratchet tree for the whole group.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Guard `onCommitDelivery`, and pin it

**Files:**
- Modify: `packages/rpc/src/peer.ts:1350-1358` (the guard) and `:713-729` (the doc block)
- Modify: `packages/rpc/test/peer-dispose-race.test.ts:115-122` (the stale comment) and append
- Test: `packages/rpc/test/peer-dispose-race.test.ts`

**Interfaces:**
- Consumes: `makeMLSPeer`, `buildLedgerCommit` from `./fixtures/peer.js`;
  `createMemoryCommitJournal` and `MemoryCommitJournal` from `./fixtures/journal.js`;
  `createRecordingHub` from `./fixtures/recording-hub.js` (Task 1, already imported by this file);
  `FakeHub`; the file's `flush` and `members`.
- Produces: the `disposed` early return in `onCommitDelivery`.

**Background the implementer needs — read before writing anything.** The obvious way to queue a
delivery past dispose does NOT work: `retain` is synchronous and fires
`void attemptSubscribe(...)` (`hub-mux.ts:369`), so `buildEpoch` never awaits a subscribe and
holding subscribes open will not keep `ready` pending. Queue behind the **commit mutex** instead.
`onCommitDelivery` puts its `await ready` *inside* the `runSerial` callback (`peer.ts:1350-1351`),
and `runSerial` chains every task on `commitTail` (`:837-847`), so a held mutex stops the callback
from starting at all. `dispose()` never waits on that mutex — it awaits `settled`, derived from
`ready` — which is the whole hole.

The mutex holder must do no hub work after release, or its own traffic pollutes the recording.
`replay()` on a peer with an empty journal and a complete ledger is exactly that: `replayJournal`
returns at `entry == null` (`:1459`), `ensureLedger` returns early, nothing reaches the hub. Gate it
at `journal.get()`, which `replayJournal` awaits under the mutex.

- [ ] **Step 1: Add the journal fixture import**

Add to the import block in `peer-dispose-race.test.ts`:

```ts
import { createMemoryCommitJournal, type MemoryCommitJournal } from './fixtures/journal.js'
```

- [ ] **Step 2: Append the failing test**

Append to the end of `packages/rpc/test/peer-dispose-race.test.ts`:

```ts
describe('dispose against a commit delivery queued behind a lane operation', () => {
  test('a delivery that resumes after dispose does not pull the commit log', async () => {
    const fake = new FakeHub()
    const rs = new Uint8Array(32).fill(0x88)

    const recorder = createRecordingHub(fake)

    // The mutex holder, and the reason it is the JOURNAL that is gated rather than a hub call:
    // whatever holds the mutex keeps running after the gate opens, and anything it says to the hub
    // then would land in the recording. `replay()` over an empty journal and a complete ledger says
    // nothing at all — `replayJournal` returns at the empty slot and `ensureLedger` returns early.
    let openGate = (): void => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    let gateArmed = false
    const real = createMemoryCommitJournal()
    const journal: MemoryCommitJournal = {
      ...real,
      async get() {
        if (gateArmed) {
          gateArmed = false
          await gate
        }
        return await real.get()
      },
    }

    const alice = makeMLSPeer(fake, 'alice', rs, { epoch: 1, members })
    const bob = makeMLSPeer(recorder.hub, 'bob', rs, { epoch: 1, members, journal })
    await flush()

    // Armed only now: bob's init seed replays the journal too, and gating THAT would stop him ever
    // becoming ready.
    gateArmed = true
    const holder = bob.peer.replay()
    await flush()

    // Alice's commit reaches bob's commit listener, which acks and hands its lane operation to
    // `runSerial` — where it queues, because `replay()` still holds the mutex inside the gate.
    await alice.peer.commit(buildLedgerCommit(alice, ['queued-behind-the-lane']))
    await flush()

    // Returns without waiting on the mutex: dispose awaits `settled`, and the queued delivery is
    // not on that path. That is the hole this test is about.
    await bob.peer.dispose()
    recorder.start()

    openGate()
    await holder
    await flush(80)

    // The queued callback has now run, against a peer disposed several awaits ago. Unguarded it
    // runs the whole lane operation, and `pullCommits` is the part that reaches the hub.
    expect(recorder.calls()).toEqual([])

    await alice.peer.dispose()
  })
})
```

- [ ] **Step 3: Run it — it must FAIL, before any guard exists**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/rpc
pnpm exec vitest run test/peer-dispose-race.test.ts -t 'does not pull the commit log'
```

Expected: FAIL, with the received array containing a `fetchTopic:` on bob's commit topic.

This is the one task whose red phase comes before the fix rather than from a mutation — there is
no guard to delete yet. If it PASSES here, the delivery never queued past dispose and the test
pins nothing; check whether the list is empty because the callback ran *before* recording started,
by temporarily moving `recorder.start()` to the top of the test and re-reading the call order.

- [ ] **Step 4: Add the guard**

In `packages/rpc/src/peer.ts`, in `onCommitDelivery`'s `runSerial` body, immediately after
`await ready`:

```ts
  const onCommitDelivery = (_message: StoredMessage, ack: () => void): void => {
    ack()
    void runSerial(async () => {
      await ready
      // A delivery queued here when `dispose()` ran is not on the path dispose waits for: it awaits
      // `settled`, never the mutex. Refused SILENTLY, unlike every host-facing entry point — there
      // is no caller to tell, and the catch below would swallow a throw anyway.
      if (disposed) return
      const replayed = await replayJournal()
```

- [ ] **Step 5: Run it — it must now pass**

```bash
pnpm exec vitest run test/peer-dispose-race.test.ts -t 'does not pull the commit log'
```

Expected: PASS.

- [ ] **Step 6: Run the whole file, and decide about the in-flight-subscribe test**

```bash
pnpm exec vitest run test/peer-dispose-race.test.ts
```

Expected: all tests PASS, including "a subscribe still in flight when dispose returns does not
report to the disposed host". That test's rebuild fires at `:132-139`, *before* `bob.peer.dispose()`
at `:139`, so the new guard should not reach it.

**If it fails: STOP and report back rather than patching it.** Its comment at `:115-122` names
`onCommitDelivery`'s unguarded rebuild as load-bearing, and the reshape/re-point/retire choice was
explicitly reserved for the user. Do not adjust the test to make it pass.

- [ ] **Step 7: Rewrite the two comments this guard falsifies**

First, `peer-dispose-race.test.ts:115-122`. It currently claims `onCommitDelivery` carries no guard
and is "the only remaining way anything downstream of that rebuild can be observed post-dispose" —
which this task falsifies. Replace that claim while keeping the reason the callback is the
observable here:

```ts
      // A disposed peer's caller cannot see this any other way: `resync()` and every protocol entry
      // point refuse outright once `disposed` is set (`assertLive`, `peer.ts:731`), and the
      // inbound-commit rebuild is now refused too (`onCommitDelivery`). What this test watches is
      // NOT a post-dispose rebuild — bob's rebuild runs below, while he is still live — but the
      // subscribes it left in flight, answered only after `dispose()` returned.
```

Second, `peer.ts:713-729`. Its opening line calls `assertLive` "the whole of the peer's post-dispose
rule", which is no longer true. Change that sentence only — the rest of the block (the race
mechanism, the four failure modes, the `resync` leak note) stays as it is:

```ts
  /**
   * Set as `dispose()`'s FIRST statement. The peer's post-dispose rule has two forms and this is
   * the host-facing one: everything a HOST asks of a disposed peer is refused, loudly. The inbound
   * side is refused too, silently, where a delivery has no caller to tell (`onCommitDelivery`).
   *
```

- [ ] **Step 8: Confirm the file is still green after the comment edits**

```bash
pnpm exec vitest run test/peer-dispose-race.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
git add packages/rpc/src/peer.ts packages/rpc/test/peer-dispose-race.test.ts
git commit -m "fix: refuse an inbound commit delivery queued past dispose

onCommitDelivery awaited ready and could then rebuild the epoch with no
disposed check. dispose() awaits settled, never the commit mutex, so a
delivery already queued in runSerial resumed into the same post-dispose
rebuild every host-facing entry point already refuses.

Refused silently: a delivery has no caller to reject, and the existing
catch would swallow a throw.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Whole-branch verification and residual bookkeeping

**Files:**
- Modify: `docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md`

**Interfaces:**
- Consumes: the three tests and the guard from Tasks 1-3.
- Produces: nothing.

- [ ] **Step 1: Run the full rpc suite, forced**

```bash
cd /Users/paul/dev/yulsi/kumiai
rtk proxy pnpm run test -- --filter @kumiai/rpc --force
```

Expected: all tests pass, and the turbo summary reads `Cached: 0`. **Check that line.** A cached
run reports the previous result and proves nothing. Do not use `pnpm test -- --force`, which is
broken in this repo.

- [ ] **Step 2: Typecheck**

```bash
rtk proxy pnpm run test:types
```

Expected: PASS. vitest strips types, so Step 1 passing says nothing about what typechecks — the
recording wrappers are typed `LogHub` and the journal wrapper is typed `MemoryCommitJournal`, both
of which only this step checks.

- [ ] **Step 3: Lint**

```bash
rtk proxy pnpm run lint
```

Expected: clean. The `rtk` shim fakes both `pnpm run lint` and `pnpm exec biome`, so this must go
through `rtk proxy` to give real output.

- [ ] **Step 4: Trim the residuals file to what is left**

In `docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md`, delete sections 1 and 2
in full. Keep sections 3 and 4 unchanged. Update the header block to match — the priority line
currently reads "medium for 1 and 2 ..., low for 3 and 4":

```markdown
# Residuals from closing the medium test gaps

**Priority:** low.
**Origin:** the whole-branch review of `test/close-medium-test-gaps`, 2026-07-31. Four items were
triaged out of scope for that branch's final fix wave; residuals 1 and 2 were closed on
`test/pin-dispose-lane-guards`, 2026-08-03. Background:
`docs/agents/plans/completed/2026-07-31-close-medium-test-gaps.complete.md` and the retired doc
`docs/agents/plans/completed/2026-07-07-test-gaps.complete.md`.
```

Do NOT delete the file. Residual 3 (`createHubTunnelTransport`'s fire-and-forget subscribe) and
residual 4 (the bare `'Peer is disposed'` Error) are still open and out of scope here.

Residual 4 carries a note saying the dispose tests assert `/disposed/i` against the message prose,
which "is load-bearing until then". That is still true and now applies to three more tests — leave
the note, and do not renumber the remaining sections.

- [ ] **Step 5: Commit**

```bash
git add docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md
git commit -m "docs: drop the two residuals this branch closed

Residuals 1 and 2 are done. 3 and 4 stay: the hub-tunnel subscribe is a
transport.ts fix, and the named error class belongs with the package-wide
API decision in backlog/rpc-api-surface.md.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification Summary

The branch is done when all of these hold:

1. `peer.ts:1762` (`replay`) — deleting it fails Task 1's test naming `publish:<rendezvous>`.
2. `peer.ts:1827` (`recover`) — deleting it fails Task 2's test naming the commit-topic fetch and
   `publish:<rendezvous>`.
3. `onCommitDelivery`'s `if (disposed) return` — removing it fails Task 3's test naming the
   commit-topic fetch.
4. Full `@kumiai/rpc` suite green with `Cached: 0` confirmed on the line, plus `test:types` and
   `lint` clean.
5. `git diff main --stat` shows exactly: `packages/rpc/src/peer.ts`,
   `packages/rpc/test/peer-dispose-race.test.ts`, `packages/rpc/test/fixtures/recording-hub.ts`,
   the spec, this plan, and the trimmed residuals file. Nothing else — in particular, no rewrites of
   the package's three pre-existing inline hub wrappers.
