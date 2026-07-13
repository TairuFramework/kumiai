# Probe report — Question 3.3

**Does the commit CAS loop converge, serialize, and journal?**

**Status: DONE_WITH_CONCERNS.** Two admins at one epoch converge with no fork and no lost entries;
two commits on one device serialize; the journal is written before the publish and cleared on both
outcomes; the retry bound is a deadline; all three restart-replay outcomes hold; `lost` is a return
value and the obvious host handler does **not** deadlock — proven by building the callback version
and watching it deadlock. **Both wrong implementations were built and shown to pass most of the
suite**, including the fork the `commitLedgerEntries` doc comment warns about, which is caught by
exactly one assertion.

The load-bearing concern is at the end: **`expectedHead` is the peer's cursor, and a single
mailbox-class frame published on the commit topic wedges every peer's commit lane permanently.**
That is a griefing vector, it interacts with the spec's "a removed member keeps `commitTopic`", and
I did not fix it because the fix is a deviation from the spec's literal step 1.

`rpc` went **93 → 110** tests (17 new, none removed). `mls` 283 and integration 23 unchanged.

---

## 1. The loop, step by step

`packages/rpc/src/peer.ts`. The whole run is one `runSerial` task — one mutex, taken once, released
once.

| step | what | `file:line` |
|---|---|---|
| — | **mutex taken** (`runSerial`, the whole body) | `peer.ts:622` |
| **0** | **replay the journal**, ahead of the pull | `peer.ts:624` → `replayJournal` `peer.ts:564` |
| **1** | pull `commitTopic` to the end, rebuild if it moved | `peer.ts:629` (`reconcileCommits`) |
| **2** | `build()` — against the host's live handle, adopting nothing | `peer.ts:633` |
| **3** | **`journal.put` — BEFORE the publish** | `peer.ts:640` |
| **4** | publish with `expectedHead` + `publishID`, `retain: 'log'` | `peer.ts:653` |
| **5** | accepted → cursor, **`onAccepted()`**, clear, rebuild | `peer.ts:675–678` |
| **6** | `HeadMismatchError` → clear, check deadline, **back to step 1** | `peer.ts:656–669` |
| — | **mutex released** (the task resolves) | `peer.ts:683` |

- **Where the mutex is taken and released:** `runSerial` (`peer.ts:316`) is a promise-tail queue. It
  is **not reentrant** — a task that calls `runSerial` again waits on a tail that contains itself —
  and that is not an accident, it is the property §5 turns on.
- **Where the journal is written relative to the publish:** `slot.put` at `peer.ts:640`, `mux.publish`
  at `peer.ts:653`. Nothing between them but the `await`. The frame is *sealed* before the slot is
  written (`frameCommit`, `peer.ts:648`) so that a seal failure cannot leave a pending commit the
  next replay would land behind the host's back.
- **Where `onAccepted` runs:** `peer.ts:676` — after the cursor moves, before the slot is cleared,
  before the epoch rebuild. It is the **only** place the host adopts.
- **Retry bound:** `commitDeadlineMs`, default 30s (`peer.ts:60`), checked **after a loss** — so a
  zero deadline still gets one full attempt and never refuses to try. `COMMIT_ATTEMPT_CEILING = 1000`
  (`peer.ts:67`) is retained as a runaway guard only.
- **An unknown publish outcome is not a loss.** Only `HeadMismatchError` clears the slot
  (`isHeadMismatch`, `commit.ts:107` — matches the class *and* the name, because the error crosses a
  transport and is rebuilt from a wire code on the far side). Any other publish error propagates with
  the slot **intact**: the hub may have accepted the frame and failed to say so, and the only safe
  move is to ask the store again. Tested.

### `selfCommitted` is dead

3.1's in-memory `Set<LogPosition>` is **gone**, and nothing replaced it. It did not need replacing:
an accepted commit sets `reconciledHead` to its own frame's position (`peer.ts:675`), so the next
pull starts *after* it. The journal is what carries that across a restart — replay sets the cursor to
the frame it confirms (`peer.ts:597`). The pull's own-frame branch at `peer.ts:404` is deleted.

### `commit(build)` absorbed `localCommitted`

Per 3.2: `adopt` **was** `onAccepted`, `ledgerEntries` **were** `bodies`. `localCommitted` and
`LocalCommitOptions` are **removed**, not deprecated — there is one commit path. The 3.2 guard that
told a host it had adopted too early survives, retargeted at `build()`:
*"a build() that adopts cannot seal the bodies, and is told so"* (`peer.ts:543`).

### The type refuses a peer that can lose commits

`GroupPeerParams` is now a union (`peer.ts:113`): **`mls` arrives with its `journal` and
`adoptJournalled`, or it does not arrive.** A peer with a group and no journal loses every commit
whose process died in the acceptance window — silently, and with no way to ever merge the orphan
frame it left in the log. That is now a **compile error at the host's wiring**, asserted by
`@ts-expect-error` under `test:types` (`peer-commit-cas.test.ts:300`), the same discipline 3.1 used
for `MailboxHub` vs `LogHub`.

---

## 2. Two admins at epoch N → one wins, the loser rebases, both land

`packages/rpc/test/peer-commit-cas.test.ts:51`. **The race is constructed, not hoped for:** Alice's
publish is held until Bob has demonstrably framed his commit at epoch 1, and Bob's first publish is
held until Alice's has landed. Both framed at epoch 1; exactly one won.

```ts
expect(bobFramedAt).toEqual([1, 2])   // framed at 1, lost, rebased, framed the retry at 2
expect(bob.journal.puts()).toBe(2)    // one slot write per attempt

expect(commitFrames(hub, recoverySecret)).toHaveLength(2)   // no fork: two frames, two epochs

// The loser's entries LANDED — in the WINNER's ledger, not just in his own.
const ledger = [memoryEntryID(aliceToken), memoryEntryID(bobToken)]
expect(alice.mls.ledgerIDs()).toEqual(ledger)
expect(bob.mls.ledgerIDs()).toEqual(ledger)
expect(alice.mls.epoch()).toBe(3)
expect(bob.mls.epoch()).toBe(3)
```

`expect(alice.mls.ledgerIDs()).toEqual(ledger)` is the assertion the whole question exists for, and
it is the one that catches the fork (§7.1). "It didn't throw" would have passed under **both** wrong
implementations.

```
 ✓ test/peer-commit-cas.test.ts > the commit loop converges, serializes and journals >
   two admins commit at the same epoch: one wins, the loser rebases, and BOTH land 88ms
```

---

## 3. Two concurrent same-device `commit()` calls serialize

`peer-commit-cas.test.ts:124`. Both calls are made before either can finish. **CAS cannot help
here** — it resolves races between devices, and these are two callers on one.

```ts
await Promise.all([
  alice.peer.commit(buildLedgerCommit(alice, [first], { framedAt })),
  alice.peer.commit(buildLedgerCommit(alice, [second], { framedAt })),
])

expect(framedAt).toEqual([1, 2])              // the second build saw the first commit ADOPTED
expect(alice.journal.puts()).toBe(2)
expect(alice.journal.putWhileOccupied()).toBe(0)   // never two commits in the single slot at once
expect(alice.mls.ledgerIDs()).toEqual([memoryEntryID(first), memoryEntryID(second)])
expect(commitFrames(hub, recoverySecret)).toHaveLength(2)
```

`framedAt === [1, 2]` is the mutex: without it both builds read epoch 1 and frame two commits at the
same epoch — the hazard `commitLedgerEntries` documents. `putWhileOccupied() === 0` is the second
half of the same fact: **the single-slot journal *is* the commit mutex written down**, and two
commits in flight at once would have one destroying the other's only record of itself.

```
 ✓ two commits on ONE device serialize: neither builds against a superseded handle 68ms
```

---

## 4. The journal is written before the publish — the *ordering*, not just both

`peer-commit-cas.test.ts:157`. A competing admin lands a commit while the first attempt is in flight,
so one run covers **both** terminal outcomes. The journal and the hub push to a shared trace:

```ts
expect(trace.map((step) => step.split(':')[0])).toEqual([
  'journal.put',    // attempt 1: journalled...
  'hub.publish',    // ...then published, and lost the compare-and-set
  'journal.clear',  // the loser's slot cleared, the pending commit dropped untouched
  'journal.put',    // attempt 2, rebased onto the winner
  'hub.publish',
  'journal.clear',  // accepted: cleared after onAccepted ran
])
```

```
 ✓ the journal is written before the publish, and cleared after it — on both outcomes 38ms
```

---

## 5. The retry bound is a deadline, and losing is not an error path

Two tests, `peer-commit-cas.test.ts:203` and `:236`.

**Five consecutive losses, no throw** — someone else commits ahead of every one of the first five
attempts:

```ts
await expect(alice.peer.commit(buildLedgerCommit(alice, [token], { framedAt }))).resolves.toEqual({})
expect(framedAt).toEqual([1, 2, 3, 4, 5, 6])   // rebased five times, landed on the sixth
expect(alice.journal.puts()).toBe(6)
expect(alice.mls.epoch()).toBe(7)
```

An attempt count of 5 would have thrown here. **A deadline is what makes ordinary contention
ordinary.**

**A deadline, not a count:** with `commitDeadlineMs: 0` against a group it can never win, `commit`
rejects with `CommitDeadlineError` after `framedAt === [1]` — **one full attempt was still made**,
because the deadline is checked *after* a loss, not before a try. The loser's slot is cleared, never
left behind.

```
 ✓ losing several compare-and-sets in a row is not an error path 79ms
 ✓ the retry bound is a deadline, not an attempt count 34ms
```

---

## 6. Restart replay — all three outcomes, and the host handler that does not deadlock

`packages/rpc/test/peer-commit-replay.test.ts`. A "restart" is a **new peer over the same durable
state**: the same handle, the same journal. That is exactly what durability buys, and it is the only
thing the new process has.

```
 ✓ accepted, then the process died before it recorded the outcome: the peer adopts and is whole 45ms
 ✓ the commit is applied exactly once across the restart — never once by replay and again by the pull 69ms
 ✓ never accepted, and nobody else committed: the replay wins the compare-and-set and lands 9ms
 ✓ never accepted, and someone else won: a ledger commit hands back its tokens 7ms
 ✓ never accepted, and someone else won: an invite hands back a failure notice, and no tokens 7ms
 ✓ a remove that never landed is surfaced too — the notice is the whole point 8ms
 ✓ the obvious host handler answers a loss by committing — and does not deadlock 42ms
 ✓ an unknown publish outcome keeps the slot: the peer asks the store again 34ms
 ✓ replay is idempotent: running it twice adopts once and delivers a Welcome once 37ms
```

**Accepted-then-crashed** (the crash lands *inside* `onAccepted`, through the real `commit()` path):
the store recognises the `publishID`, returns the original sequenceID, **appends nothing**, and the
peer adopts and is whole.

```ts
expect(result).toEqual({})                                   // nothing was lost
expect(commitFrames(hub, recoverySecret)).toHaveLength(1)    // nothing was appended
expect(restarted.mls.epoch()).toBe(2)
expect(restarted.mls.ledgerIDs()).toEqual([memoryEntryID(token)])
expect(journal.slot()).toBeNull()
```

**Never accepted, someone else won** — routes on `kind`, never on the commit's bytes:

```ts
expect(result.lost).toEqual({ kind: 'ledger', tokens: [token] })  // re-issuable, nothing lost
expect(journal.slot()).toBeNull()   // cleared, AND surfaced. Never cleared silently.
expect(alice.mls.ledgerIDs()).toEqual([])   // this commit did not happen

expect(result.lost).toEqual({ kind: 'invite' })   // a failure notice, and no tokens
expect(alice.welcomes).toEqual([])                // nothing re-enacted behind the host's back
expect((await alice.peer.replay()).lost).toEqual({ kind: 'remove' })
```

**Never accepted, nobody else won** — the sole-member group whose creator crashed mid-commit. The
republish is an ordinary CAS at `expectedHead: null`, it wins, and the group is *not* bricked. No
responder exists, and none is needed.

### `lost` is a return value, and the obvious host handler does not deadlock

`peer-commit-replay.test.ts:266`. This is the handler a host will write:

```ts
const startup = async (): Promise<LostCommit | undefined> => {
  const { lost } = await alice.peer.replay()
  if (lost?.kind === 'ledger') {
    await alice.peer.commit(buildLedgerCommit(alice, lost.tokens))   // <- re-enters the mutex
  }
  return lost
}

const lost = await Promise.race([
  startup(),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('the lane deadlocked: commit() never took the mutex')), 2000),
  ),
])
expect(lost).toEqual({ kind: 'ledger', tokens: [token] })
expect(alice.mls.ledgerIDs()).toEqual([memoryEntryID(token)])   // re-issued, and it landed
expect(alice.mls.epoch()).toBe(3)                               // zoe's commit, then the re-issued one
```

Replay runs at lane step 0, **inside** the mutex; the host answers by calling `commit()`, which takes
that same mutex. Returning the loss means the host acts *after* the lane released, so its follow-up
`commit()` is naturally a separate lane operation. **The whole handler runs under a 2s timeout — a
deadlock cannot pass this test.**

**And the callback version deadlocks — I built it.** Mutation: fire `lost` from inside
`replayJournal`, under the lock, as `onLostCommit?.(...)`, with the identical host handler.

```
FAIL  test/zz-deadlock.test.ts > MUTATION: lost delivered as a callback under the lock >
      the obvious host handler deadlocks
AssertionError: promise rejected "Error: DEADLOCK: commit() is waiting on a…" instead of resolving
Caused by: Error: DEADLOCK: commit() is waiting on a mutex replay() still holds
```

`replay()` never resolves. Reverted; the mutation test deleted.

### The stash — a wakeup is a lane operation too, and it has nowhere to put a loss

`lostCommit` (`peer.ts:309`) holds a loss until a lane operation *with a return value* can hand it
over. This was **forced**, not decorative: a delivery wakeup replays like any other lane operation
(`peer.ts:480`), and it returns nothing. Dropping a loss there would be the one thing that must not
happen. `takeLost()` (`peer.ts:604`) drains it into the next `commit()` or `replay()`.

---

## 7. The two mutation checks

### 7.1 Reuse the source handle across a retry — **the fork**

Build once, outside the loop; a retry is "just a publish that has to wait its turn":

```ts
// MUTATION: build ONCE, and republish the same commit on every retry.
const pending = await build()
for (let attempt = 0; attempt < COMMIT_ATTEMPT_CEILING; attempt++) {
  await reconcileCommits()
  ...
```

**4 of 110 fail.** The direct evidence is `bobFramedAt` — `expected [ 1 ] to deeply equal [ 1, 2 ]`:
the retry never reframed. But the fork itself is what matters, so I relaxed the `framedAt` assertion
and re-ran to see what the **group** does:

```
FAIL  two admins commit at the same epoch: one wins, the loser rebases, and BOTH land
AssertionError: expected [ Array(1) ] to deeply equal [ …(2) ]

  [
    "pFtloSf2_4P4hheoDA30cHXZoyTsyyHWwNCnpB8um6U",
-   "AyjQ1M6QVnVPCZxkly-lRwqRRchNafyYHXOslN-KzTo",
  ]

 ❯ test/peer-commit-cas.test.ts:115:35
    115|     expect(alice.mls.ledgerIDs()).toEqual(ledger)
```

**`commitFrames(...).toHaveLength(2)` still passes.** Two frames are in the log. But Alice's ledger
holds **only Alice's token**: Bob's retry re-published a commit still framed at the **superseded
epoch 1**, and every member now at epoch 2 dropped it as inapplicable. Bob's `commit()` resolved. Bob
believes he committed. The group never enacted his entry, and nothing anywhere raised a word. That is
precisely *"two commits issued from the same source handle both frame at that handle's epoch and
diverge"* — the fork `commitLedgerEntries` warns about, reproduced.

**One assertion catches it**, and it is the one the brief insisted on: *the loser's entries are in the
winner's ledger*. Reverted.

### 7.2 Adopt `newGroup` when the hub accepts, before `onAccepted`

The peer already holds the journalled blob and an adopt hook, and replay adopts from exactly that —
so adopting it directly on acceptance looks like a simplification:

```ts
reconciledHead = asLogPosition(sequenceID)
// MUTATION: the hub accepted, so adopt the journalled newGroup.
await adoptJournalled(pending.journal)
await slot.clear(publishID)
```

**106 of 110 pass.** Every ledger test is green: two-admin convergence, same-device serialization,
the journal ordering, the deadline, all of it. The epoch advances, the entries enact, the group
converges. **One test names the damage:**

```
FAIL  an invite's Welcome is delivered by onAccepted, and by nothing else
AssertionError: expected [] to deeply equal [ 'dave' ]
```

The invitee never got a Welcome. It lives in the host's `onAccepted` and nowhere else — not in
`bodies`, not in the commit, and the peer cannot produce one. Alice's group is at epoch 2 with Dave's
Add committed and Dave holding nothing. (The other three failures are the replay tests, whose crash
simulation is `onAccepted` throwing — under the mutation it is never called at all.) Reverted.

### 7.3 (bonus) Pull before replay at init

The ordering the spec calls load-bearing. Mutation: seed the cursor first, settle the journal after.

**109 of 110 pass.** One fails:

```
FAIL  the commit is applied exactly once across the restart — never once by replay and again by the pull
AssertionError: expected 1 to be +0     // restarted.mls.commits()
```

The restarted peer met its **own un-merged commit** in the log and ran it through `processCommit` as
if it were somebody else's, instead of adopting the journalled handle. In the memory double the epoch
and ledger still come out right, so **every other assertion in the suite passes** — the only witness
is `commits()`, the same instrumentation 3.2 needed for `seen()`. Against real MLS a member cannot
process its own commit at all, and this is the G18 trigger firing into the rendezvous path the
journal exists to avoid. Reverted.

---

## 8. The journal-holds-what decision: **bodies, not the sealed frame**

**The decision is forced, and the spec's type was right.** `LostCommit.tokens` must hand the host
back re-issuable signed tokens — that is the entire `ledger` row of the replay table. So the journal
**must** hold the plaintext bodies regardless. Journalling the sealed frame *as well* would mean
storing both a ciphertext and its plaintext, where the ciphertext cannot be re-keyed and the
plaintext is the thing that actually survives. That is strictly more state for strictly less.

So replay **re-seals** (`frameCommit`, `peer.ts:542`, called at `peer.ts:567`), and the argument that
this is safe is:

> Re-sealing is only ever *consumed* by the store when the publish was **not** already accepted. A
> publish that was never accepted means `onAccepted` never ran; `onAccepted` is the only place the
> host adopts; so the host is still at the pre-commit epoch, and the re-seal is under the right
> secret. If the publish *was* accepted, the store's dedup returns the original sequenceID and
> **appends nothing** — the re-sealed frame is discarded unread, so sealing it at the wrong epoch
> costs nothing.

The argument is tight, and it is an argument — it holds by **construction only in the sense that
`onAccepted` is the sole adopt point.** So I wrote that down where a host will read it, on the type:
*"It is the ONLY place the host may adopt"* (`commit.ts:39`).

**What breaks if that stops being true:** a host that adopts anywhere else — at build time, on a
timer, in a "helpful" retry wrapper — and then crashes before its publish landed will, on restart,
re-seal the bodies under the **post**-commit epoch and publish a blob **no member can open**. The
commit applies; every receiver fails to resolve its entries; `processCommit` throws; the cursor does
not advance; **the lane wedges for the whole group, on a frame nobody can ever get past.** There is
no assertion guarding this, because the peer cannot detect it: the journal has no epoch field to
compare against (the spec's `JournalEntry` has none, and I did not add one). **If a cheap guard is
wanted, journalling the epoch and refusing to re-seal at a different one turns a silent group-wide
wedge into a loud local error** — one field, and it is the only thing standing between "an argument"
and "by construction". I did not add it because it changes a host-visible type the spec fixes
verbatim. **Worth a decision.**

---

## 9. Is `onAccepted`'s at-least-once semantics documented where a host will read them?

**Yes — on the type, not in prose.** `PendingCommit.onAccepted` (`commit.ts:39`) says it MUST be
idempotent, says *why* (publish → accepted → `onAccepted` → clear is three steps and a crash lands
between any two), and says which half is dangerous: re-adopting a fixed serialized handle is
harmless; **re-delivering a Welcome is not** — a second `processWelcome` over the same bytes errors
or builds a duplicate group state. `GroupPeerMLSParams.adoptJournalled` (`peer.ts:81`) repeats it for
the restart half.

**Tested, not just documented:** *"replay is idempotent: running it twice adopts once and delivers a
Welcome once"* — a crash *after* the Welcome went out, then two `replay()` calls. Both are no-ops
because the host's handler tolerates a repeat.

**What a host that ignores it breaks:** its invitee's client handles a `processWelcome` for a group
it already belongs to — an error, or a duplicate group state — for an event the host believed
happened exactly once. The journal's whole purpose is to make a commit *look* atomic, and that
framing is exactly what hides the at-least-once semantics underneath, which is why they are stated on
the type rather than left to be inferred.

---

## 10. Concerns, and what 3.4–3.7 will need

**1. `expectedHead` is the peer's cursor, and one mailbox frame on the commit topic wedges the lane
— permanently.** This is the one I would fix before merging. The spec's step 1 says publish with
`expectedHead: reconciledHead`, and I implemented that literally. It is correct **only while every
frame on the commit topic is log-class**, because the store's `head` moves *only* on a `retain: 'log'`
publish while `fetchTopic` returns **mailbox frames too** (`memoryStore.ts` appends every retained
entry to `topicLogs`). So: anyone who can publish to `commitTopic` — which, per the spec's own
"Accepted exposure: a removed member keeps `commitTopic`", **includes a removed member** — publishes
one mailbox-class frame there. Every peer pulls it, steps over it (3.1's rule), and sets
`reconciledHead` to a sequenceID **that is not and can never be the head**. Every subsequent
`commit()` from that peer CASes at a head that will never match, takes `HeadMismatchError` forever,
and dies on its deadline. The frame does not even need to persist — the peer's cursor keeps its value
after the frame is acked away. **The fix is one line in spirit: CAS against the head the drained pull
reported (`fetchTopic`'s `head`), not against the cursor** — two names for two things, exactly the
`LogPosition`/`DeliveryPosition` discipline 3.1 applied. I did not do it because the brief quotes the
`expectedHead: reconciledHead` step as binding, and this is a deviation from it, not an
implementation detail. **It needs a decision.**

**2. The loss notice is not itself durable.** `replayJournal` clears the slot and *then* returns the
loss. A crash between the clear and the host acting on the return value loses the notice — for a
`remove`, that is precisely the "admin believes a member was evicted when they were not" the spec
calls security-relevant. Not clearing is worse (the next lane op re-surfaces the same loss forever
while the host is already re-issuing it), so the current shape is right, but the hand-off is
**at-most-once and the spec does not address it.** A host that needs more must write the returned
`lost` somewhere durable itself, and nothing tells it so.

**3. `recover()` still returns `{ advanced }`, not `LaneResult & { advanced, reenact }`.** Out of
scope (3.5), left alone. It is the only lane operation that does **not** run step 0 — so a loss
sitting in the stash is not drained by it. 3.5 should make `recover()` a lane operation like the
others and return `takeLost()` alongside `reenact`; the symmetry the spec argues for
(*"`recover()` returns `reenact` and replay returns `lost`"*) is half-built.

**4. Still open from 3.1/3.2, untouched here:** no stale-epoch classification (3.4 — and note that
3.4's table must not let the port *throw* on an inapplicable frame, or the wedge in concern 1 has a
second cause); the trimmed-backlog gap is undetected (3.5); the epoch/mailbox interlock (3.7).

**5. The cursor is not persisted.** On restart `reconciledHead` is `null`, so the peer re-reads the
whole retained log and re-hands every frame to `processCommit`. The port drops what it cannot apply,
so this is *correct*, but it is O(retention) work on every process start — 30 days of commits by
default. 3.4/3.5 will want the host to persist the cursor next to the handle.

**6. The runaway ceiling (1000 attempts) is untested.** Reaching it requires 1000 CAS losses inside
the deadline; I left it as a guard and did not write a test that spins it.

---

## 11. Verify

```
$ rtk proxy pnpm run build
 Tasks:    7 successful, 7 total
  Time:    595ms

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 183 files in 201ms. No fixes applied.

$ rtk proxy pnpm test
@kumiai/hub-protocol:test:unit:      Tests  8 passed (8)
@kumiai/mls:test:unit:               Tests  283 passed (283)
@kumiai/broadcast:test:unit:         Tests  35 passed (35)
@kumiai/hub-server:test:unit:        Tests  56 passed (56)
@kumiai/hub-client:test:unit:        Tests  5 passed (5)
@kumiai/hub-tunnel:test:unit:        Tests  63 passed (63)
@kumiai/rpc:test:unit:          Test Files  21 passed (21)
@kumiai/rpc:test:unit:               Tests  110 passed (110)
 Tasks:    27 successful, 27 total

$ cd tests/integration && rtk proxy pnpm test
$ tsc --noEmit --skipLibCheck && vitest run
 Test Files  4 passed (4)
      Tests  23 passed (23)

$ cd packages/rpc && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
TypeScript: No errors found
```

`rpc` 93 → 110: 17 new (7 CAS/journal/deadline + 9 restart replay + 1 type-level wiring assertion),
none removed. `mls` 283 and integration 23 unchanged.

### Files

New: `packages/rpc/src/commit.ts`, `packages/rpc/test/fixtures/journal.ts`,
`packages/rpc/test/fixtures/peer.ts`, `packages/rpc/test/peer-commit-cas.test.ts`,
`packages/rpc/test/peer-commit-replay.test.ts`.

Modified: `packages/rpc/src/peer.ts` (the loop), `packages/rpc/src/hub-mux.ts` and
`packages/hub-tunnel/src/transport.ts` (`expectedHead` + `publishID` plumbed through to the peer —
they were already on `HubStore`/`HubClient` from phase 1), `packages/rpc/src/index.ts`,
`packages/rpc/src/memory-group-mls.ts` (`decodeMemoryCommit` exported for the fixture's idempotent
adopt), both fake hubs (**dedup-before-CAS**, per the store contract — a fixture that ignored the CAS
would have let every one of these tests pass against a broken peer), and the four suites that used
`localCommitted`.

Not committed.
