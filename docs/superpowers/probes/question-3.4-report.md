# Question 3.4 — report

**Status: DONE_WITH_CONCERNS.**

The cursor table is built as a pure function, six rows, evaluated in the order written. The
heal trigger keys on **authorship**, and the committer is read from the MLS-authenticated
commit, never from the frame's `senderDID`. Both named wrong implementations were built,
both went red on exactly the test the brief said would catch them, and both were reverted.

Verify from the repo root is green: `rtk proxy pnpm run build && rtk proxy pnpm run lint &&
rtk proxy pnpm test` — 27/27 turbo tasks, 132/132 rpc tests, 23 test files.

---

## What was built

### `packages/rpc/src/classify.ts` (new) — the table

`classifyCommit(header, sequenceID, state) -> CommitDisposition`. A pure function over
`(frame, this peer's state)`, evaluated before anything is applied and before anything is
decrypted. It reads no bytes off the wire, holds no key, and — structurally — **has no
transport sender among its inputs at all**.

```ts
export type CommitDisposition =
  | { row: 'apply' }
  | { row: 'history' }
  | { row: 'fork'; appliedSequenceID: string; branch: 'winning' | 'losing' }
  | { row: 'own-unmerged' }
  | { row: 'poison' }
```

Order in code, which is the order in the spec:

1. `header == null` → **poison**. Bytes with no epoch and no committer cannot be asked any of
   the questions below. This is the one row that must be settled first, and it overlaps
   nothing: an unreadable frame is not somebody's commit, least of all this peer's own.
2. `header.epoch !== state.epoch` and **no record** for that epoch → **history**. Advance, no
   fork check, no unwrap attempt.
3. `header.epoch !== state.epoch` and a record with a **different** sequenceID → **fork**,
   with the tiebreak (`lower sequenceID wins`) computed in the same decision.
4. `header.epoch === state.epoch` and `header.committerDID === state.localDID` →
   **own-unmerged**. Do not advance; heal.
5. otherwise → **apply**: hand it to the port.

Rows 1 (`applied`), 5 (`policy-rejected`) and 6 (`MissingLedgerEntriesError`) are the *port's
answer* to a frame classified `apply`, and are handled in `pullCommits` immediately below the
call. That split is deliberate and is what makes the ordering testable: **the own-unmerged row
is reached without the port being asked anything**, so it cannot possibly depend on the answer.

### Where each input lives (the brief asked)

| Input | Home | Why |
|---|---|---|
| the frame's **epoch** | `GroupMLS.readCommitHeader(commit)` — **new port method** | `rpc` never imports MLS. In the real port this is `readMessageEpoch`. |
| the frame's **committer** | same, `CommitHeader.committerDID` | In the real port, `didOfLeaf(senderLeafIndex)` — authenticated by the Commit's own signature. |
| this peer's **current epoch** | `crypto.epoch()` | already there; read live, not from the cached `epoch` local |
| this peer's **own identity** | `localDID` (peer param) | not attacker-controlled |
| **epoch → sequenceID** of enacted commits | `appliedByEpoch: Map<number, string>` in the peer, **in memory** | see Concern 3 |

### `packages/rpc/src/crypto.ts` — the port contract, drawn explicitly

- New `CommitHeader` type, documented as *from the commit, not from the transport*.
- New `GroupMLS.readCommitHeader`.
- **`processCommit`'s throw contract is now written down**, as the brief's item 1 demanded:
  *a frame it cannot apply is `{ advanced: false }`, and never a throw.* A frame framed at
  another epoch, and a frame the group's policy refuses, are both `{ advanced: false }`. It
  throws for exactly one outcome: the ledger entries it names would not resolve — the one
  retryable one.
- New `isMissingLedgerEntries(error)`, matched **by name**, following the existing
  `isHeadMismatch` precedent (`rpc` does not depend on `@kumiai/mls`, and the error crosses a
  port boundary).

### `packages/rpc/src/memory-group-mls.ts` — the double made faithful

The brief was right that the double was not modelling the thing the question turns on.

- **The committer now lives inside the commit bytes**, exactly as the epoch already did:
  `encodeMemoryCommit(epoch, committerDID, entryIDs)`. `buildCommit` stamps the member's own
  DID.
- `readCommitHeader` reads it back out — no state, no secret, no blob.
- **`processCommit` refuses a commit the member itself authored** (`{ advanced: false }`).
  This is load-bearing for the mutation checks: without it, the applicability-predicate
  implementation would simply *apply* the crash victim's own commit and the G18 test would
  pass for the wrong reason.
- **New `acceptsCommitter` option** — the group's commit policy, modelled. A commit from a
  refused committer is well-formed and deliberately not applied: `{ advanced: false }`, never
  a throw. This is how the G19 tests build "a removed member's policy-rejected commit".

### `packages/rpc/src/peer.ts` — the lane

`pullCommits` now classifies every frame before touching it, and:

- **`own-unmerged`** → the trigger **records** (`healRequested = true`), the drain stops, the
  cursor stays put, **no tip is taken**, and the pull unwinds. `recover()` is a lane operation
  and takes the commit mutex, so a pull that awaited it would wait on a tail that includes
  itself. `healIfRequested()` runs **outside** the mutex — from the delivery wakeup's tail,
  from `commit()`'s tail, and once after init settles (the seed pull is where the journal-less
  crash victim meets its own commit).
- **`history`** → advance. The port is **never asked**, so the blob is never touched.
- **`fork`** → advance; heal only on the losing branch.
- **`poison`** → advance, never retried.
- **the apply path**: `{ advanced: true }` → advance + record `epoch → sequenceID`.
  `{ advanced: false }` → **poison**: advance, never retry, **and do not heal** — this is the
  whole of the security argument. `MissingLedgerEntriesError` → read the frame again, bounded
  (`COMMIT_ENTRY_ATTEMPTS = 3`); on exhaustion **advance and escalate to a heal**.
- `commit()` and `replayJournal()` also write `appliedByEpoch` for the peer's **own** accepted
  commits — a commit this peer made and adopted is one it enacted at that epoch, and without
  it a second commit at an epoch this peer *owns* would read as history.
- **`recover()` now walks the log after a successful jump.** `applyRecovery` moves the epoch
  and not the cursor, so the commits the peer skipped are still ahead of it. At the epoch it
  landed on they classify as history, and the table steps over them without handing one to the
  port. Without this the recovered peer's cursor stays stale until the next wakeup.

### Test fixtures

- **`FakeHub.lieAboutSender(fn)`** — the hub can now forge `senderDID`, per reader, on both the
  push fan-out and `fetchTopic`. A FakeHub that cannot forge the one field the spec says is
  forgeable is not modelling the threat.
- `publishCommit` gained `committerDID`, defaulting to `senderDID` — the transport sender and
  the committer are now separable, because the whole point is that a peer must never confuse
  them.
- `makeMLSPeer` passes `localDID` into the MLS double (it is what the commits it builds are
  signed by), and gained `acceptsCommitter` and `recovery` options.

---

## The tests

### `packages/rpc/test/commit-classify.test.ts` — the table, row by row, in isolation

10 tests. Every row, plus four ordering tests that an end-to-end run through the hub cannot
express:

- **epoch is settled before authorship** — this peer's own commit at an epoch it has *passed*
  is history, not a heal. (Otherwise a peer that healed once heals forever.)
- **history is settled before the fork check** — no record for that epoch is not a fork.
- **authorship is settled before applicability** — a frame at the current epoch from another
  member classifies `apply` regardless of what the port would say about it.
- **the committer is the only identity the table reads** — there is no `senderDID` in the
  function's signature.

### `packages/rpc/test/peer-cursor-table.test.ts` — the security tests, end to end

5 tests.

1. **`heals, and its epoch advances — with no journal to repair it`** (the G18 test). Alice's
   commit is accepted; her process dies before adopting; her journal is gone. She restarts at
   the epoch she died at, meets her own commit, heals, and **her epoch advances** (2). Also
   asserts `alice.mls.seen() === 0`: **the port was never asked about that frame**, which is
   the ordering proof.
2. **`applies none of the commits it jumped over, and heals only once`** (the stale-commit
   test). Same crash, plus a further group commit. After the heal Alice is at epoch 3, and
   `seen() === 0`, `commits() === 0`, `ledgerIDs() === []` — she applied **neither** skipped
   commit, and she does **not** heal a second time on the way past her own frame. Her lane is
   then shown live at her new epoch.
3. **`a removed member's policy-refused commit is poison, and nobody heals`** (G19). Mallory,
   removed, publishes one well-formed commit at the head. Both honest peers read it, refuse
   it, step over it. **`heals(hub) === 0`.** The lane is not wedged: the group's next commit
   applies.
4. **`and still nobody heals when the hub swears each peer sent it themselves`** (the G19 hub
   variant). Same, but the hub stamps each reader's **own DID** onto the poison frame. Still
   `heals(hub) === 0`. Guarded against vacuity: `bob.mls.lastSender() === 'bob'` proves the lie
   landed and was ignored.
5. **`a frame whose bodies nobody can supply is read again, bounded, and then escalated`** (the
   unopenable-frame test). `seen() === 3` — read again, and only so many times — then the cursor
   advances, one heal is escalated, and the next commit applies. The permanent wedge becomes a
   bounded cost.

Plus 3 new port tests in `group-mls.test.ts` (the header reads without applying; a member
cannot apply its own commit; a policy refusal is a `{ advanced: false }`, not a throw), and
`peer-ledger-bodies.test.ts` updated to the new contract (its late-joiner test now asserts the
epoch-0 frame is **never handed to the port at all** — `seen() === 1`, was 2).

---

## Mutation check 1 — the applicability predicate

Trigger redefined as *"a valid frame at my current epoch that I cannot apply"*: the authorship
check was deleted from `classify.ts`, and `pullCommits` was changed to heal on
`{ advanced: false }`.

```diff
- if (header.committerDID === state.localDID) return { row: 'own-unmerged' }
  return { row: 'apply' }
```
```diff
+ if (!applied.advanced) {
+   // MUTATION: a valid frame at my current epoch that I cannot apply.
+   healRequested = true
+   break
+ }
```

**The G18 crash-victim test still heals the victim and still advances its epoch** — exactly as
the brief warned. What went red:

```
 FAIL  test/peer-cursor-table.test.ts > a hostile commit cannot make an honest peer do expensive work > a removed member’s policy-refused commit is poison, and nobody heals
AssertionError: expected [ { …(4) }, { …(4) } ] to have a length of +0 but got 2

- Expected
+ Received

- 0
+ 2

 ❯ test/peer-cursor-table.test.ts:139:28
    139|     expect(heals(hub, rs)).toHaveLength(0)

 FAIL  test/peer-cursor-table.test.ts > a hostile commit cannot make an honest peer do expensive work > and still nobody heals when the hub swears each peer sent it themselves
AssertionError: expected [ { …(4) }, { …(4) } ] to have a length of +0 but got 2

 FAIL  test/commit-classify.test.ts > the cursor table > this peer's own commit, at the epoch it is still at, heals
AssertionError: expected { row: 'apply' } to deeply equal { row: 'own-unmerged' }

 FAIL  test/peer-cursor-table.test.ts > a peer that meets its own un-merged commit > heals, and its epoch advances — with no journal to repair it
AssertionError: expected 1 to be +0 // Object.is equality
 ❯ test/peer-cursor-table.test.ts:57:30
     57|     expect(alice.mls.seen()).toBe(0)

 Test Files  2 failed | 21 passed (23)
      Tests  6 failed | 126 passed (132)
```

**One publish from a removed member, two heals from a two-member honest group.** That is the
storm, measured. Reverted; suite back to 132/132.

## Mutation check 2 — `senderDID` as the committer

`pullCommits` reads the epoch from the commit and the committer from the frame:

```diff
- const disposition = classifyCommit(port.readCommitHeader(commitFrame.commit), position, {...})
+ const mutatedHeader = port.readCommitHeader(commitFrame.commit)
+ const disposition = classifyCommit(
+   mutatedHeader == null ? null
+     : { epoch: mutatedHeader.epoch, committerDID: message.senderDID ?? '' },
+   position, { localDID, epoch: crypto.epoch(), appliedByEpoch },
+ )
```

**The G18 test passes. The plain G19 test passes. The classifier's own tests all pass** — the
classifier is not what is wrong. Exactly one test goes red, and it is the hub variant:

```
 FAIL  test/peer-cursor-table.test.ts > a hostile commit cannot make an honest peer do expensive work > and still nobody heals when the hub swears each peer sent it themselves
AssertionError: expected [ { …(4) }, { …(4) } ] to have a length of +0 but got 2

- Expected
+ Received

- 0
+ 2

 ❯ test/peer-cursor-table.test.ts:175:28
    173|     // authenticates it, so it still says `mallory` — the frame is sti…
    174|     // group-wide recovery storm the hub was reaching for does not hap…
    175|     expect(heals(hub, rs)).toHaveLength(0)
       |                            ^

 Test Files  1 failed | 22 passed (23)
      Tests  1 failed | 131 passed (132)
```

**131 of 132 tests green on an implementation that hands the untrusted hub a group-wide DoS.**
Without `FakeHub.lieAboutSender` this implementation ships. Reverted; suite back to 132/132.

---

## Full verify output

```
$ rtk proxy pnpm run build
 Tasks:    7 successful, 7 total
Cached:    6 cached, 7 total
  Time:    478ms

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 186 files in 151ms. No fixes applied.

$ rtk proxy pnpm test
@kumiai/rpc:test:unit:  ✓ test/commit-classify.test.ts (10 tests) 2ms
@kumiai/rpc:test:unit:  ✓ test/peer-cursor-table.test.ts (5 tests) 1514ms
@kumiai/rpc:test:unit:  ✓ test/group-mls.test.ts (13 tests) 5ms
@kumiai/rpc:test:unit:  Test Files  23 passed (23)
@kumiai/rpc:test:unit:       Tests  132 passed (132)

 Tasks:    27 successful, 27 total
Cached:    25 cached, 27 total
  Time:    2.574s
```

---

## The other three things the brief asked to settle

**1. The port must not throw on an inapplicable frame.** Done, and documented on `GroupMLS`
(`crypto.ts`). The line is drawn explicitly: `{ advanced: false }` for a frame it cannot apply;
throw **only** for `MissingLedgerEntriesError`. The late-joiner-wedge failure mode is named in
the doc comment. Note that with the table in place the lane **never hands the port a
wrong-epoch frame at all** — epoch classification comes first — so the double's wrong-epoch
`{ advanced: false }` is now a defensive port-level guard rather than a path the lane uses.

**2. A recovered peer must not re-apply the stale commits still in the log.** Done. `recover()`
walks the log after a successful jump, and the frames classify as history. Test 2 above; the
assertion is `seen() === 0`, i.e. the port was never even asked.

**3. The one place tempted to grow a `console.warn` stays silent.** No logging was added
anywhere. A blob a peer cannot open is now not even reached on the pull path: a frame from
another epoch is never handed to the port, so its resolver never runs.

---

## Concerns

**1. `commit()` throws a plain `Error` when the pull ends in a heal trigger, and that error is
not in the spec.** The spec says (G13) *"the trigger records, `commit()` unwinds and releases
the lane, `recover()` runs as its own operation"*. Unwinding is the only safe move — the heal
needs the mutex `commit()` is holding, so retrying inside the loop would livelock until the
deadline — but the spec does not say **how** the host is told. I chose a plain `Error` with a
clear message, following the existing plain-`Error` throws in `peer.ts` (`'commit: this peer
has no MLS port…'`, `'commit: the local group has already advanced past…'`), rather than
inventing a new exported error class. **If the design wants a typed error here, this is the
place to add it.** No test covers this path — it is reachable but not in the DoD, and the heal
scheduled after init means a host's `commit()` usually queues behind the heal rather than
racing it.

**2. The `MissingLedgerEntriesError` row retries but does not yet *gather*.** The table says
*"gather the missing ids, retry the frame (bounded)"*. I implemented the bounded retry and the
advance-and-escalate, and **not** the gather ask, because there is nowhere for it to go yet:
D3 says the gather rides the **app lane**, and the app lane is epoch-bound — a peer stuck at
epoch E trying to resolve a commit framed at E is behind every member that applied it, all of
whom have rotated to E+1. So an app-lane gather at epoch E reaches nobody, which is precisely
*why* the row escalates to `recover()` on exhaustion. The gather that *can* work is D3's
bootstrap gather, at the group's shared epoch, after the heal. **As it stands the retries
re-run an identical computation and always exhaust** — they are a placeholder shaped like the
right thing, and the observable behaviour (bounded, then advance + escalate) is exactly what
the brief's DoD asked for. The retry loop is where a gather slots in. Flagging it because a
reader could mistake the loop for a working retry.

**3. `appliedByEpoch` is in memory and does not survive a restart.** A restarted peer holds no
records, so it reads history as history: it can **miss** a fork, never invent one. That is the
safe direction, and inventing forks is the failure that turns every late joiner into a
recovery storm — but it does mean the fork trigger is weaker across restarts than the spec's
prose implies. Making it durable means a second host-provided store, which is a design
decision above my pay grade here. Documented in `peer.ts` and `classify.ts`.

**4. The fork row's action is `advance` + heal-if-losing, and the losing branch is never
reachable end-to-end in these tests.** In a single hub log the peer always applied the *earlier*
(lower) sequenceID, so it is always on the winning branch; the losing branch only arises when a
Byzantine hub has served different logs to different members and then reunified them. The
tiebreak is implemented and unit-tested in `commit-classify.test.ts`, but there is no
end-to-end fork test, because the FakeHub is a single honest log and cannot produce the
divergence. **D1's actual branch resolution — re-enacting the loser's entries after the
rejoin — is not built**; the fork row escalates to `recover()` and stops there.

**5. `recover()` now pulls inside its serialized body.** This is new behaviour for the public
`recover()` call, not just for the heal trigger. It is what makes concern-free the stale-cursor
state a recovered peer would otherwise sit in, and all existing recovery tests stay green — but
it does mean `recover()` is a heavier operation than it was, and a pull that throws inside it
is swallowed.

---

# The escalation was the DoS (follow-up)

**Status: DONE.** Green: build, lint, `rtk proxy pnpm test` → 27/27 tasks, **rpc 137/137** (was
132). Uncommitted.

## What changed

**1. The `MissingLedgerEntriesError` row is now poison: drop, advance, and do NOT heal.** The
bounded retry and the escalate-on-exhaustion are **deleted** — `COMMIT_ENTRY_ATTEMPTS` is gone
from `peer.ts`, and the `for (let attempt = 1; ; attempt++)` loop around `processCommit` is gone
with it. The only `attempt` loop left in `peer.ts` is `commit()`'s compare-and-set rebase, which
is unrelated. The port's throw is now caught once, filed as poison, and the cursor steps over it.

The reasoning, written into the code: the bodies ride the commit sealed under the epoch it is
framed at, so *a blob this peer cannot open is a blob no member at this epoch can open*. Nobody
applies it, the group never moves past that epoch, the frame is dead in the log, and the next
honest commit is framed at the same epoch and lands behind it. The whole cost is one wasted slot
in the serialization lane — a write capability any member has anyway.

**2. The table gained the row it never had.** `{ row: 'ahead' }`: a frame framed at an epoch
**above** this peer's is proof the group advanced at an epoch where this peer did not. Advance,
and heal. This is the only row that tells a peer its own state is broken, and it is why no other
row needs to.

**3. `RecoveryRequiredError`** (`commit.ts`, exported), thrown when `commit()`'s pull ends in a
heal trigger. Doc comment says what the host must do: the commit did not happen, nothing was
published, the heal is already scheduled, re-issue once the lane is whole — and do **not** retry
in a tight loop, which would take the mutex back before the heal can run. Tested.

**4. `appliedByEpoch` stays in memory,** with the limit documented in `classify.ts`: it can miss a
fork and can never invent one; inventing them would storm every joiner; fork *resolution* is not
built, so the trigger has nowhere to go; revisit when it is, and not before.

## Where the new row went, and why

```
1. header unreadable            -> poison
2. header.epoch >  my epoch     -> ahead      (NEW)
3. header.epoch <  my epoch     -> history | fork
4. header.epoch == my epoch, committer == me  -> own-unmerged
5. otherwise                    -> apply
```

**It must precede `history`, and that is the whole placement question.** The two are otherwise
indistinguishable: a peer holds no applied-commit record for an epoch it has never *reached* any
more than for one it was never *part of*. Demoting it below `history` reproduces the live bug —
see mutation B.

**And it is safe to put that high, which is the part the brief said to prove.** An accepted commit
is the only thing that advances an epoch, and every one of them compare-and-sets at the head, so
**the log's frames run in non-decreasing epoch order**. A peer walking the log applies each frame
at its own epoch and *rises with it*, so the next frame is never ahead. A Welcome joiner at epoch
N reads every frame below N as history, applies the one at N, and rises — it never meets a frame
ahead of itself, and this row never fires on its first pull.

**What actually breaks a Welcome joiner is not the row's position — it is reading the peer's epoch
once per page instead of once per frame.** That is the trap, and it is a plausible one (hoisting
`crypto.epoch()` out of the loop looks like an optimisation). See mutation C: it heals every new
member on arrival. `pullCommits` therefore re-reads `crypto.epoch()` for **every frame**, and the
classifier takes the epoch as an argument so it cannot silently go stale.

## Mutation A — restore the escalation (the check the follow-up asked for)

```diff
  reconciledHead = position
+ healRequested = true // MUTATION: escalate on an unresolvable frame
  continue
```

```
 FAIL  test/peer-cursor-table.test.ts > a hostile commit cannot make an honest peer do expensive work > a frame whose bodies nobody can supply is poison, and nobody heals
AssertionError: expected [ { …(4) }, { …(4) } ] to have a length of +0 but got 2

- Expected
+ Received

- 0
+ 2

 ❯ test/peer-cursor-table.test.ts:222:28
    222|     expect(heals(hub, rs)).toHaveLength(0)

 Test Files  1 failed | 22 passed (23)
      Tests  1 failed | 136 passed (137)
```

**One body-less commit from one member; two heals from a two-member honest group.** Same shape as
the refused-commit storm, arriving through the row that was supposed to be the safe one — and
scaling with group size. Note that the *left-behind peer* test **still passes** under this
mutation: it heals, for the wrong reason. Only counting the heals on the frame *nobody* can
resolve separates them. Reverted.

## Mutation B — the `ahead` row demoted below `history`

```diff
- if (header.epoch > state.epoch) return { row: 'ahead' }
- if (header.epoch < state.epoch) {
+ // MUTATION: the ahead row demoted below history.
+ if (header.epoch !== state.epoch) {
```

```
 FAIL  test/commit-classify.test.ts > the cursor table > a frame from an epoch AHEAD of this peer’s is proof the group moved on without it
AssertionError: expected { row: 'history' } to deeply equal { row: 'ahead' }

 FAIL  test/peer-cursor-table.test.ts > a peer the group left behind > learns it from a later frame, not from the one it could not apply, and heals
AssertionError: expected 1 to be 3 // Object.is equality

- Expected
+ Received

- 3
+ 1

 Test Files  2 failed | 21 passed (23)
      Tests  3 failed | 134 passed (137)
```

**Bob stuck at epoch 1 while the group is at 3** — he calls every subsequent frame "history",
advances over all of them, reaches `reconciledHead == head`, and reports himself fully reconciled.
The G18 failure reached by a different road. Reverted.

## Mutation C — the joiner trap: the epoch read once per page

```diff
+ // MUTATION: the peer's epoch, read once for the whole page.
+ const pageEpoch = crypto.epoch()
  for (const message of result.messages) {
-   epoch: crypto.epoch(),
+   epoch: pageEpoch,
```

```
 FAIL  test/peer-cursor-table.test.ts > a peer the group left behind > a Welcome joiner reading history it was never part of does not heal on arrival
AssertionError: expected 2 to be 3 // Object.is equality

- Expected
+ Received

- 3
+ 2

 FAIL  test/peer-commit-lane.test.ts > the commit lane is pull-driven > a member that subscribes after commits have landed converges by pulling them
AssertionError: expected 2 to be 3

 FAIL  test/peer-commit-lane.test.ts > the commit lane is pull-driven > a peer that has processed nothing seeds from the log, not from the head
AssertionError: expected 1 to be 2

 Test Files  2 failed | 21 passed (23)
      Tests  3 failed | 134 passed (137)
```

Dave applies the frame at his snapshot epoch, then classifies **the very next frame** as ahead and
heals on arrival — the storm, self-inflicted, on the group's happiest path. Two pre-existing
joiner tests break with it. Reverted.

## Tests added / changed

| Test | Says |
|---|---|
| `a frame whose bodies nobody can supply is poison, and nobody heals` | two honest peers drop it, advance, **0 heals**; the next honest commit at the same epoch lands behind the dead frame and applies |
| `learns it from a later frame, not from the one it could not apply, and heals` | bob alone lacks the body; the group applied and moved on; bob drops the frame in silence, meets the next one framed **ahead**, and heals — **epoch advances 1 → 3** |
| `a Welcome joiner reading history it was never part of does not heal on arrival` | dave joins at epoch 1 into a log spanning epochs 0–2, rises to 3, **0 heals** |
| `a peer that must recover before it can commit > is told so` | `RecoveryRequiredError`; nothing published, journal slot empty |
| `a frame from an epoch AHEAD of this peer’s…` (classifier) | the new row in isolation |
| `“ahead” is settled before “history”, and a Welcome joiner still reads history as history` (classifier) | the placement, row by row, including the joiner rising with the log |
| `a commit whose bodies are not in its frame is dropped, and never retried` (rewritten) | `seen() === 1`, not 3 — the retry is gone |

## Full verify output

```
$ rtk proxy pnpm run build
 Tasks:    7 successful, 7 total
  Time:    494ms

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 186 files in 284ms. No fixes applied.

$ rtk proxy pnpm test
@kumiai/rpc:test:unit:  Test Files  23 passed (23)
@kumiai/rpc:test:unit:       Tests  137 passed (137)
 Tasks:    27 successful, 27 total
```

## Concerns

**1. A peer that skipped an unresolvable commit can still `commit()`, and forks itself if the
group moved on.** This is the gap the new rule opens, and it is the one place the "learn from a
later frame" design has a window. Bob cannot resolve the frame at epoch E; the group applies it
and reaches E+1; **no further commit has been published yet**, so no ahead frame exists and bob
has nothing to heal on. His cursor is at the head and he looks reconciled. If his host calls
`commit()` now, he frames at E, compare-and-sets at the head (the frame he skipped), **wins**, and
publishes a commit on a branch of his own.

It is not fatal, and I do not think it blocks: the other members hold `appliedByEpoch[E]` = the
frame they applied, so bob's frame lands as a **fork** with a higher sequenceID, they take the
winning branch, ignore it, and carry on. Bob's commit silently does not take effect, and he heals
on the group's next frame. But he loses a commit with no error, and the group burns a CAS slot.
**Closing it means the peer remembering that it skipped an epoch it could not resolve and refusing
to commit at that epoch** — which is what the follow-up brief's *"but remember that I skipped an
epoch I could not resolve"* may have been reaching for. I did **not** build it, because it
collides head-on with the brief's own recovery path: *"the next honest commit is framed at the
same epoch, CASes at the head after the poison, and everyone applies it"* — if the skipping peer
refuses to commit at that epoch, and **every** member skipped it (the nobody-can-resolve case,
which is the common one), then nobody can publish the commit that unsticks the group. The two
requirements point opposite ways and I could not find a discriminator the peer can evaluate
alone. **This wants a decision, and it is the one thing in the follow-up I could not close.**

**2. The "remember that I skipped an epoch" instruction is implemented implicitly, not as state.**
The peer's memory of the skip *is its own epoch*: it did not advance, so any later frame framed
above it is proof. I added no separate set, because nothing would read it (see concern 1 for the
one thing that would, and why I did not build it), and unread state is worse than none. Flagging
in case the brief meant something operational by it.

**3. The `ahead` row makes trim-strand detection implicit.** A peer whose backlog was trimmed now
reads the oldest retained frame, finds it framed above its epoch, and heals — which is the
documented trim-strand trigger, arriving for free. But it is not the `head > reconciledHead &&
oldest > cursor` observation the spec describes, and it fires only when the log actually holds a
frame ahead of the peer. A topic trimmed **empty** (head present, no frames) still leaves the peer
quietly behind with nothing to trip on. Not new, and not made worse — but the ahead row looks like
it covers trim, and it does not cover that case.
