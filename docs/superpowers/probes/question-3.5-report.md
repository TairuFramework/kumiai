# Question 3.5 — report

**Status: DONE_WITH_CONCERNS.** `recover()` is a top-level lane operation with its own CAS loop;
re-enactment is a subsequent `commit()` filtered by ledger membership. Every mutation check in the
brief goes red, including the spec's worked example (`expected 'Foo' to be 'Bar'`). The tree is green:
**rpc 145, 27/27**.

Four things need a decision, and they are in **Concerns** at the bottom. Two are defects found while
building — one of them is a live bug in already-shipped code, one is a heal trigger that cannot fire.

---

## What was built

### `recover()` — a lane operation with a CAS loop of its own (`packages/rpc/src/peer.ts`)

```
runSerial:
  0. replayJournal()                      # step 0, as in every lane operation
  loop until deadline:
    1. reconcileCommits()                 # may resolve the strand outright; rebuild if it moved
    2. expectedHead = readCommitHead()    # the log's TIP, from the store's own reply
    3. requestID = fresh; request = port.createRecoveryRequest(requestID)
       sealed = rendezvous(request)       # null -> no responder -> break, degraded
    4. pending = port.applyRecovery(sealed, requestID)     # opens; BUILDS; adopts nothing
    5. inFlightEntries ??= await port.getLedger()          # snapshot BEFORE the handle is replaced
    6. publish(pending.commit, expectedHead)
         HeadMismatch -> discard the sealed GroupInfO AND the commit built from it; continue
    7. pending.onAccepted(); cursor = head = sequenceID; appliedByEpoch.set(rejoinEpoch, seq)
    8. ensureLedger(deadline)             # REQUIRED. failure -> healRequested = true,
                                          #   return { advanced: false, reenact: [] }
    9. reenact = inFlight.filter(t => !groupLedger.has(t))
       return { advanced: true, reenact }
  return { advanced: false, reenact: [] }
```

`recover()` never calls `commit()` and `commit()` never calls `recover()`. The heal trigger in the
pull still only **records**; `healIfRequested()` runs the heal after the lane is released, and stashes
any `reenact` list for the next lane operation that has a return value — the same treatment `lost`
already gets, for the same reason (the host's answer to both is a `commit()`, which takes the mutex).

### The membership filter

`inFlight` is the peer's **pre-rejoin ledger**, snapshotted before `onAccepted` replaces the handle
(a rejoined handle's ledger is empty — there is nothing left to read afterwards). After bootstrap, an
entry is re-enacted **iff the group's authenticated ledger does not contain it**. A token's content id
is its digest, so token equality is id equality and the set-difference is the id set-difference.

### Ledger bootstrap, and the completeness invariant

- `ensureLedger()` runs at step 0.5 of **every** lane operation (seed, wakeup, `commit`, `replay`) and
  inside `recover()` after the rejoin. It is the local invariant — `isLedgerComplete()` — and it
  repairs itself with a gather. That is what makes "crash mid-bootstrap" self-healing at startup with
  no memory of having been mid-heal.
- The gather is two new rendezvous frames (`ledgerRequest` / `ledgerReply`, `HANDSHAKE_KIND` 3 and 4).
  **The responder gates its reply on `isLedgerComplete()`**, and there is deliberately *no*
  storm-collapse on this lane: the requester needs a second answer to fall through to when the first
  fails the head check.

### Port reshape (`GroupMLS`)

| before | after |
|---|---|
| `exportGroupInfo(requesterDID)` | `createRecoveryRequest(requestID)` + `sealGroupInfo(request)` |
| `applyRecovery(groupInfo) -> { advanced }` | `applyRecovery(sealed, requestID) -> PendingRecovery \| null` |
| — | `isLedgerComplete()`, `getLedger()`, `bootstrapLedger(tokens)` |

`PendingRecovery` is `{ commit, onAccepted }` — the recovery twin of `PendingCommit`, non-mutating for
the same reason. This is forced, not cosmetic: the ephemeral HPKE private key is retained by the port
between the request and the reply, so the port must be given the `requestID` at both ends, and the
rejoin must be *built* before it is published because it has to win a compare-and-set.

`memory-group-mls.ts` now models what the lane turns on: a chained **ledger head** carried in the
commit (so a receiver with an incomplete ledger stays visibly incomplete), an **empty ledger after a
rejoin** (the roster reset), a **fold** (last-write-wins by position, no dedup — which is the whole
hazard), **leaves** with `resync` semantics, and per-request sealing.

---

## The tests (`packages/rpc/test/peer-recover-lane.test.ts`, 7 new)

| test | what it pins |
|---|---|
| an entry the group already holds is not re-enacted, and a later admin is not reverted | **the worked example** |
| an entry the group does not hold IS re-enacted, and lands in a later commit | the other half of the rule |
| losing the race discards the GroupInfo, not just the commit | the CAS loop |
| two peers healing at once both converge, and neither loses its entries | concurrent heal |
| a heal triggered while `commit()` is pulling does not deadlock | the lane is never re-entered |
| a crash in `recover()`'s acceptance window converges, with exactly one leaf | the unjournalled window |
| `recover()` never reports advanced with an incomplete ledger | bootstrap is not a formality |

Plus `peer-recovery.test.ts` (rejoin lands on the log; no responder → `{advanced:false}`, no throw),
`group-mls.test.ts` (rejoin builds-then-adopts; a withheld entry is refused and folds nothing; a reply
for another member or another request does not open; a member with no leaf is refused), and the
rendezvous codecs.

---

## Mutation checks

### 1. Drop the membership filter — `const reenact = inFlight`

```
PASS (6) FAIL (1)

1. a heal re-enacts by ledger membership an entry the group already holds is not re-enacted, and a later admin is not reverted
   AssertionError: expected 'Foo' to be 'Bar' // Object.is equality
       at packages/rpc/test/peer-recover-lane.test.ts:131:44
```

The spec's worked example, produced by the wrong implementation, with **nothing thrown anywhere**. The
ledger reads `[Foo, Bar, Foo]` and the circle is "Foo" again.

### 2. Retry the same external commit instead of discarding the GroupInfo

Kept the `PendingRecovery` across the `HeadMismatchError` and republished it at the new head.

```
PASS (6) FAIL (1)

1. recover() is a compare-and-set loop of its own losing the race discards the GroupInfo, not just the commit, and the rejoin still lands
   AssertionError: expected 3 to be 4 // Object.is equality
       at packages/rpc/test/peer-recover-lane.test.ts:243:29
```

The retried commit is framed at the epoch the *stale* GroupInfo described. The group is past it, so
**every member classifies it as history and nobody applies it** — the peer publishes, adopts its own
derived handle, and sits alone on a branch believing it has rejoined. Its epoch (3) equals nobody's
tree. It also never bootstraps (`role:carol` folds to `undefined`), because the stale head it adopted
makes its empty ledger look complete. A peer that merely retried the commit would wedge, silently.

> This mutation exposed a weak assertion in my own first draft: asserting "the peer is in the roster"
> passes trivially, because a stranded member's *old* leaf is still in the tree. The test now asserts
> the group **applied** the rejoin (`bob.mls.epoch()` moved past his own commit).

### 3. Nest the heal inside the pull — `await recover()` on the own-unmerged row

```
× a heal triggered while commit() is pulling does not deadlock: it unwinds, then heals 4005ms
   → Test timed out in 4000ms.
```

`commit()` holds the mutex, its pull calls `recover()`, `recover()` calls `runSerial`, and the tail it
waits on contains the operation waiting for it. The call never returns.

### 4. Return `advanced: true` without completing the bootstrap

```
PASS (5) FAIL (2)

1. a heal re-enacts by ledger membership ...
   AssertionError: expected 'Foo' to be 'Bar'
2. a bootstrap that cannot complete is a degraded state, not a heal ...
   AssertionError: expected { advanced: true, reenact: [ …(2) ] } to deeply equal { advanced: false, reenact: [] }
```

Two things at once, and the first is the interesting one: **bootstrap-before-filter is load-bearing.**
Without the group's ledger there is nothing to filter against, so the peer re-enacts its whole
pre-rejoin ledger and reverts the later admin — the G17 failure reached through the G15 door. The
second is the roster reset reported as a heal, with every role silently gone.

---

## Verify

```
$ rtk proxy pnpm run build
 Tasks:    7 successful, 7 total

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 187 files in 171ms. Fixed 2 files.

$ rtk proxy pnpm test
@kumiai/rpc:test:unit:  Test Files  24 passed (24)
@kumiai/rpc:test:unit:       Tests  145 passed (145)
 Tasks:    27 successful, 27 total
```

---

## Concerns

### 1. A live defect, fixed here: the seed-time journal replay always threw (`peer.ts`)

`epoch` — the epoch the app lane is built at — was initialised to `0`, and `buildEpoch()` runs *after*
`initControlLanes()`. The seed lane operation (replay, then pull) therefore ran with `epoch === 0`, and
`frameCommit`'s guard (*"the local group has already advanced past the epoch this commit was framed
at"*) **refused every journal replay on startup** for any peer whose group is past epoch 0. The peer
booted with its pending commit unsettled *and its cursor unseeded* (the throw aborts the seed pull
too), and recovered only if the host happened to call a lane operation later.

Every existing replay test calls `peer.replay()` explicitly — after `ready`, when `epoch` is correct —
which is why 137 green tests never saw it. It is the crash-restart path, which is the journal's entire
reason for existing. Fixed by seeding `let epoch = crypto.epoch()`. **This is a Q3.3 bug, found by
Q3.5, and it deserves its own line in the plan's decision log.**

### 2. The fork's losing branch cannot be triggered through the pull

`classifyCommit` decides the branch with `sequenceID < applied ? 'losing' : 'winning'`. But
`appliedByEpoch` is only ever written with a sequenceID that the cursor has already reached
(`applied <= reconciledHead`), and the pull only ever delivers frames with `sequenceID > reconciledHead`.
So an incoming fork frame is **always** `'winning'`, and `healRequested` is never set on that row: the
peer on the losing branch cannot learn it from a forward-only cursor. The row is dead code as built.

I did **not** invent a fix (per the brief's stop condition). It means the byzantine heal path has a
correct `recover()` and no live trigger, so my byzantine test drives `recover()` directly, over a peer
whose local ledger holds an entry the group's authenticated ledger does not — which is exactly the
losing branch's observable state. **This needs a decision, and it belongs to the cursor table (3.4).**
The trim-strand trigger is likewise still unbuilt (nothing reads `oldest`), so of the three heal paths
only *own-unmerged* and *ahead* actually fire today.

### 3. The G17 crash path is only reachable through the pre-rejoin ledger — and the test says so

The spec is right that "after a real crash `inFlight` is empty", and the consequence is sharper than it
looks: **with the journal in place a crashed peer that heals holds nothing**, because replay settles
the journal (step 0) before any heal can run — it republishes under the original `publishID`, the
store's dedup answers, and the peer adopts. A journal-sourced `inFlight` can therefore never coexist
with a heal, and a filter over it would be vacuous.

So `inFlight` is the peer's **pre-rejoin ledger**, and the reachable form of the worked example is:
A's commit is accepted, A crashes before adopting, A restarts and **replay adopts it — so A now holds
"Foo"** — the group then leaves A behind, A heals, and A must not re-enact the entry it holds. The
value asserted is exactly the spec's (`"Bar"`), and the wrong implementation produces exactly the
spec's (`"Foo"`). But it is an interpretation of "the entries it had in flight", and it should be
signed off rather than assumed.

### 4. Design decisions that need sign-off

- **The bootstrap gather is two new rendezvous frames.** The spec says the gather "rides the app lane",
  but that sentence is about D3's id-keyed gather, which Q3.2 deleted (bodies ride the commit). The
  bootstrap gather needs a lane that a just-rejoined peer certainly shares with a responder, and the
  rendezvous topic is the only non-rotating one both hold for life. It is one request, many replies,
  first valid one wins.
- **`LaneResult` gained `reenact?: Array<string>`.** A heal fired by the *pull* has no return value to
  put the entries in, so they are stashed and handed to the next lane operation that has one — exactly
  as `lost` is. The spec's own G27 test names both (`lost`, `reenact`) as lane results, but the type is
  question 3.6's to own, and this is a small trespass on it.
- **`GroupMLS.getLedgerEntries(ids)` is now dead** in the lane (bodies ride the commit frame). Left in
  the port; it should probably go.
- **`recover()`'s deadline** is a new `recovery.deadlineMs` (default 30s, matching `commit`'s).

---

# The fixture that could not lie (follow-up)

**Status: DONE.** The fork row is not dead code — my fixture could not reach it. The losing-branch
heal now runs end to end through a byzantine hub, the seed-time replay bug is pinned by a test that
goes red against the old code, and `getLedgerEntries` is gone. **rpc 147, 27/27.**

## 1. The losing branch, end to end

I was wrong, and the correction is worth stating plainly, because the shape of the mistake is the
interesting part: **my reasoning was sound about an honest hub, and a fork only exists because the hub
was not one.** A hub that has already broken the compare-and-set — accepted two commits at one head
and served divergent logs — has no reason to honour `fetchTopic`'s exclusive cursor either. Both are
contracts, and the party bound by both is the party this design does not trust. The peer on the losing
branch can only ever learn it lost by being shown the branch it lost to, and that frame necessarily
carries a *lower* sequenceID than the one it already applied. An honest hub can never deliver it. The
row is unreachable against a fixture that cannot lie, and fires exactly as written against the hub the
threat model actually names.

**`FakeHub` gained three opt-in byzantine controls** (honest by default; no existing test changes
meaning, and none of this touches `hub-protocol`'s conformance suite — a *conforming* store cannot do
any of it, which is the point):

- `acceptAtAnyHead()` — stop honouring the compare-and-set, so two commits at one head both land.
- `hideFrom(readerDID, sequenceID)` — serve divergent logs: withhold a frame from one reader while
  showing it to another (push as well as pull).
- `revealTo(readerDID, sequenceID)` — hand a reader a frame its cursor has already passed. **One-shot**:
  a hub that re-served a below-cursor frame forever would re-trigger every heal forever, which is a hub
  denying service rather than a hub forking a log, and no peer-side rule survives that.

**`a hub that forked the log > the losing branch rejoins the winner, and re-enacts the entries the
winner never had`** — two commits at epoch 1 at the same head (`role:carol=admin` at the lower
sequenceID, `role:bob=admin` at the higher); Carol is served one branch, Bob the other; each applies
what it is shown and holds a ledger the other has never heard of. The hub then shows Bob the branch he
lost. He classifies it `losing` (lower sequenceID wins), heals, rejoins onto the winner, bootstraps the
winner's ledger head-verified — **and his own entry comes back in `reenact`**, because the group's
authenticated ledger has never contained it. The host re-enacts it with an ordinary commit and both
branches' entries end up in one ledger, once each.

Mutation check — make the fork row record nothing (`if (disposition.branch === 'losing')` removed):

```
PASS (8) FAIL (1)

1. a hub that forked the log the losing branch rejoins the winner, and re-enacts the entries the winner never had
   AssertionError: expected [] to have a length of 1 but got +0
       at packages/rpc/test/peer-recover-lane.test.ts:281:39
```

Zero recovery requests: Bob stays on the discarded branch forever, holding an admin grant nobody else
has, with no error anywhere. The row is load-bearing.

**The winning side needed a test too, and it has one** — `the winning branch sees the same fork and
does not heal`. Carol is shown Bob's frame and steps over it: she holds the lower sequenceID at that
epoch, so the same rule evaluated on the same two frames tells her she is the winner. Both sides must
reach *opposite* conclusions from one tiebreak; an implementation that healed on both would rejoin the
two halves of the group onto each other indefinitely. Asserted: no rendezvous, epoch unchanged, ledger
unchanged, and the loser's entry absent from her fold.

My original byzantine test (driving `recover()` directly over a peer whose ledger holds an entry the
group's does not) is kept: it exercises the recovery path in isolation, and it is now no longer the
only coverage of it.

## 2. The seed-time replay bug, pinned

`packages/rpc/test/peer-commit-replay.test.ts` — *a peer whose group is past its first epoch settles
its journalled commit at startup, with the host calling nothing*. A peer at epoch 3 dies between the
hub's answer and the durable acceptance write (so the slot records **no** acceptance and replay must
*republish*, which means re-sealing, which is the path that asks what epoch the handle is at). It
restarts, and **the host calls nothing** — because a host does not know it crashed. The peer's own seed
lane operation must settle it.

Red against the unfixed code (`let epoch = 0`):

```
PASS (11) FAIL (1)

1. restart replay closes the crash window a peer whose group is past its first epoch settles its journalled commit at startup, with the host calling nothing
   AssertionError: expected 3 to be 4 // Object.is equality
       at packages/rpc/test/peer-commit-replay.test.ts:154:35
```

The peer comes up still at epoch 3, still holding the slot, with its cursor unseeded (the throw takes
the seed pull down too). Note the first draft of this test passed against the *unfixed* code and had to
be sharpened: crashing inside `onAccepted` records the acceptance first, so replay adopts from the slot
and never re-seals — the guard is never reached. Only the crash *before* the acceptance is recorded
exercises it. The wrong crash tests the wrong window.

## 3. `getLedgerEntries` is gone

Removed from `GroupMLS` (`crypto.ts`), from `createMemoryGroupMLS`, and its test. Nothing called it:
`grep -rn getLedgerEntries packages --include=*.ts` (excluding `lib/`) now returns nothing. Bodies ride
the commit frame, so the id-keyed gather has had no caller since that change.

## 4. Verify

```
$ rtk proxy pnpm run build
 Tasks:    7 successful, 7 total

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 187 files in 156ms. No fixes applied.

$ rtk proxy pnpm test
@kumiai/broadcast:test:unit:     Tests  35 passed (35)
@kumiai/hub-protocol:test:unit:  Tests  8 passed (8)
@kumiai/mls:test:unit:           Tests  283 passed (283)
@kumiai/hub-tunnel:test:unit:    Tests  63 passed (63)
@kumiai/hub-server:test:unit:    Tests  57 passed (57)
@kumiai/rpc:test:unit:           Tests  147 passed (147)
@kumiai/hub-client:test:unit:    Tests  5 passed (5)
 Tasks:    27 successful, 27 total
```

## Concerns

One, and it is small. **The trim-strand trigger is still unbuilt** — nothing reads `oldest` from the
pull's reply, so of the three heal paths the spec names (trim strand, byzantine losing branch,
un-merged own commit), the first still has no trigger. `recover()` handles it correctly once something
fires it; nothing does. It was not in this question's scope and I have not invented one.
