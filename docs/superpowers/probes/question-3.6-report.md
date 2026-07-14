# Question 3.6 — report

**Status: BLOCKED.** Not by a broken tree — the tree is green (rpc **148**, mls **285**, 27/27 tasks)
— but by the stop condition the brief set: the re-delivered-Welcome clause is **false**, and the
finding is the result.

Nothing was committed. All work is in the tree.

---

## Part 1 — what real ts-mls does with a re-delivered Welcome

### The claim under test

> the invitee, already joined, **no-ops it rather than erroring or building a duplicate group**

### What actually happens

**It builds a duplicate group. Silently.** It does not error, and it does not no-op — it returns a
whole second group state, frozen at the epoch the Welcome was minted for, with the roster as it was
at the join.

Test: `packages/mls/test/welcome-redelivery.test.ts` (2 tests, real ts-mls, no double). Bob joins at
epoch 1; Alice adds Carol; Bob's live handle follows to epoch 2 / 3 members. The **same Welcome bytes
are handed to Bob again**:

| | live handle | what the second `processWelcome` returns |
|---|---|---|
| epoch | `2n` | `1n` |
| members | 3 | 2 |
| roster | alice, bob, **carol** | alice, bob — **carol absent** |
| group id | `welcome-redelivery` | `welcome-redelivery` — *identical* |
| reads current traffic | yes | **no** — `processMessage` rejects |

Both tests pass, because they assert reality, not the spec.

### Why it happens — the reason the brief asked for

`processWelcome` (`packages/mls/src/group.ts:1313`) is a **pure function of (Welcome bytes, key
package, private keys)**. It verifies the invite names this identity, decodes the framed
`MLSMessage(Welcome)`, calls ts-mls `joinGroup`, checks the ledger head, folds the invite's entries,
and returns a **new `GroupHandle`**. Underneath, ts-mls's `joinGroup` is a pure function too.

Neither layer holds a registry of joined groups. **There is no "already joined" state to consult, so
there is nothing that could no-op.** The Welcome is not consumed by the first join: the caller still
holds the `KeyPackageBundle`, so the second decryption succeeds exactly as the first did — and is
*deterministic*, producing a byte-identical state. That is precisely why it neither throws nor
detects anything.

The second test pins the same thing at the joining epoch: two `processWelcome` calls over one Welcome
yield two independent handles with the same group id, same epoch, same member count. A receiver that
keys its groups by handle identity holds the group **twice**.

### Why this matters, and where it must be fixed

The spec's testing clause is false. `PendingCommit.onAccepted`'s doc comment
(`packages/rpc/src/commit.ts:47-50`) is *accurate about the hazard* — "Re-delivering a Welcome is
not [harmless]... Both halves must tolerate a repeat" — but it states that as an obligation without
naming who discharges it, and **nothing in kumiai discharges it.** A host reading that sentence and
concluding the invitee half is handled has been misled.

Concretely, on the crash path: peer publishes → hub accepts → `onAccepted()` delivers the Welcome →
**crash** → restart → replay re-runs `onAccepted` → the Welcome is delivered **a second time**. If
the invitee's delivery path calls `processWelcome` on it, and adopts what comes back:

- it **rolls back** to the joining epoch — silently, with no error anywhere;
- it loses every member added since (Carol is simply not in its roster);
- it can no longer decrypt the group's traffic, and needs a heal to get back.

It is a **live defect on the crash path**, and it is a silent one.

**The fix does not belong in `rpc`, and none was added** (as instructed). The receiving host must
dedup **before** `processWelcome`, keyed on `invite.groupID` — and it *must* be before, because
**nothing in the result distinguishes the duplicate from a first join**: same group id, same shape,
no signal. Two things follow, both of which need a decision from you:

1. **The spec's testing clause must be rewritten.** "the invitee no-ops it" is not what happens and
   cannot be made to happen inside `mls` without giving `processWelcome` state it does not have.
2. **`onAccepted`'s doc comment must say who is responsible.** Either the mls layer grows an
   already-joined guard (a `processWelcome` that takes the caller's current handle for the group and
   returns it untouched when the Welcome is for an epoch it is already past), or the contract states
   plainly that the *invitee host* owns dedup and that re-delivery is at-least-once by design.

---

## Part 2 — the audit

| Clause | Test | Load-bearing assertion | Verdict |
|---|---|---|---|
| **The host answers a lane result with `commit()` and does not deadlock** | `packages/rpc/test/peer-commit-replay.test.ts:359` — "the obvious host handler answers a loss by committing" | The handler (`replay()` → `commit()`) is run inside a `Promise.race` against a **2000ms timeout that rejects with "the lane deadlocked"**. A deadlock cannot pass. Not just liveness: `alice.mls.ledgerIDs()` equals the re-issued token and `epoch() === 3` — the follow-up commit actually **landed**, so a `commit()` that resolved without doing anything fails too. | **Pinned.** |
| ...same, for `reenact` | `peer-recover-lane.test.ts:54` (`reenactFrom`), used at `:137`, `:187`, `:292`, `:424` | `reenactFrom` calls `peer.commit()` immediately after the lane op returned. Liveness is pinned by the vitest timeout, and *effect* by the folds: `bob.mls.fold().get('role:bob') === 'admin'` etc. A `commit()` that deadlocked or no-op'd fails the fold. | **Pinned.** |
| **Replay loses the CAS: a `ledger` commit's tokens are handed back, and the peer did not commit them itself** | `peer-commit-replay.test.ts:234` | Three assertions, and all three are needed: `result.lost` equals `{kind:'ledger', tokens:[token]}` (handed back); `commitFrames(hub).toHaveLength(1)` — **only the winner's frame**, so the peer did not republish behind the host's back; `alice.mls.ledgerIDs()).toEqual([])` — **the peer did not enact them itself**. | **Pinned.** |
| **An `invite` is surfaced with no tokens and no side effects** | `peer-commit-replay.test.ts:270` | `result.lost` equals `{kind:'invite'}` and **`alice.welcomes).toEqual([])`** — nothing was re-enacted behind the host's back. | **Pinned.** |
| **A journalled `remove` is surfaced with the member STILL IN THE ROSTER** | `peer-commit-replay.test.ts:301` (new positive control) and `:317` (rewritten) | **Was NOT pinned. Fixed.** | **Was a hole.** |
| `replay()` is a lane operation; every lane result carries `{ lost?, reenact? }` | `src/commit.ts:138`, `src/peer.ts:162,171` | Type-level: `commit()` and `replay()` both return `LaneResult`; `takeLost()` (`peer.ts:972`) is the single drain both go through, so a loss stashed by one lane op surfaces on the next. Exercised at `peer-recover-lane.test.ts:292` (a `reenact` surfacing out of `replay()`, not `recover()`). | **Pinned.** |

### The `remove` notice — the hole, and the fix

The brief was right to single this out. The old test was **one line**:

```ts
expect((await alice.peer.replay()).lost).toEqual({ kind: 'remove' })
```

It asserted a notice came back. It asserted **nothing about the roster** — and it could not have,
because the peer was seeded with no member to evict and the memory double had no way to evict one.
The exact bug the spec names — *"an admin told the removal failed while the member is quietly gone"*
— would have passed it.

Three changes, all in test-facing code:

- `packages/rpc/src/memory-group-mls.ts` — added `evict(did)` to the double: "drop a member's leaf...
  it is what ADOPTING the post-commit handle of a remove does, which is the only way a leaf ever goes
  away." The double had no Remove proposal, so eviction was previously unmodellable.
- `packages/rpc/test/fixtures/peer.ts` — added `buildRemoveCommit(member, victimDID)` (its
  `onAccepted` adopts **and** evicts, which is the truth of the system: the eviction *is* the
  adoption), and a `adoptJournalled` override on `makeMLSPeer` so a remove's journalled blob can be
  modelled as what it really is — the post-commit handle, the one the member is already gone from.
- `peer-commit-replay.test.ts` — a **positive control** ("a remove that lands evicts the member", so
  the negative assertion is not vacuous), then the rewritten failure test, which now asserts:

```ts
expect(lost).toEqual({ kind: 'remove' })
expect(alice.mls.leaves()).toContain('mallory')      // <- the load-bearing one
expect(commitFrames(hub, recoverySecret)).toHaveLength(1)
expect(journal.slot()).toBeNull()
```

**Mutation-checked.** Injecting the wrong implementation — `adoptJournalled(entry.journal)` before
surfacing the loss in `replayJournal()` (`peer.ts:940`), i.e. a peer that adopts a commit it was
never told landed — makes it fail on exactly the intended line:

```
AssertionError: expected [ 'alice' ] to include 'mallory'
  at packages/rpc/test/peer-commit-replay.test.ts:352:32
```

The same mutation is also caught by the `ledger` test (`ledgerIDs()`), and — worth noting — is
**not** caught by the `invite` test, whose `welcomes` assertion is blind to it. The remove test is
now the only thing standing between an admin and a silently-diverged eviction.

Confirmed in the source: `replayJournal()` calls `adoptJournalled` **only** on the `acceptedAs != null`
branch (`peer.ts:901`). On a lost compare-and-set it clears the slot and stashes `lostCommit`
(`peer.ts:940-943`) and adopts nothing. The behaviour was correct; it simply was not pinned.

---

## Verify

```
$ rtk proxy pnpm run build
 Tasks:    7 successful, 7 total
$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 188 files in 169ms. No fixes applied.
$ rtk proxy pnpm test
@kumiai/mls:test:unit:  Test Files  22 passed (22)
@kumiai/mls:test:unit:       Tests  285 passed (285)
@kumiai/rpc:test:unit:  Test Files  24 passed (24)
@kumiai/rpc:test:unit:       Tests  148 passed (148)
 Tasks:    27 successful, 27 total
```

## Files touched

- `packages/mls/test/welcome-redelivery.test.ts` — **new.** The re-delivered Welcome, against real ts-mls.
- `packages/rpc/src/memory-group-mls.ts` — `evict(did)` on the double.
- `packages/rpc/test/fixtures/peer.ts` — `buildRemoveCommit`, `adoptJournalled` override.
- `packages/rpc/test/peer-commit-replay.test.ts` — the remove positive control, and the rewritten failure test.

---

## The primitive

The finding was accepted, and the decision was to **give `mls` the primitive so no host can get
this wrong**. Built, and the false claims it exposed are corrected.

### `processWelcomeOnce` — `packages/mls/src/group.ts`

```ts
export type ProcessWelcomeOnceParams = ProcessWelcomeParams & {
  /** The group ids this member already holds a handle for. */
  joined: Iterable<string>
}

export async function processWelcomeOnce(
  params: ProcessWelcomeOnceParams,
): Promise<ProcessWelcomeResult | null>
```

It joins, compares the group id it got back against `joined`, and returns `null` — **discarding
the stale handle rather than returning it** — for a Welcome whose group the member already holds.
A genuine first join returns the handle, exactly as `processWelcome` would.

`processWelcome` **stays exported and stays pure underneath.** It is the primitive and it is
correct as it is; `processWelcomeOnce` is the safe path over it. Both are exported from
`packages/mls/src/index.ts`.

The doc comment carries the three things a reader needs and cannot infer:

1. **Why the repeat happens at all** — a Welcome is delivered at-least-once *by design*. A sender
   that suppressed the repeat would strand an invitee in a group it was added to and never told
   about, which is the whole reason the Welcome is journalled.
2. **The hazard, concretely** — adopting a re-delivered Welcome rolls the member back to its
   joining epoch, drops every member added since from its roster, and leaves it unable to read the
   group. Silently.
3. **Why the join is done and then thrown away** — the duplicate is only visible *after* the join.
   A Welcome's group id is encrypted to the joiner, so there is nothing to compare against until
   the handle exists, and "re-do the check before joining" is exactly the optimisation that cannot
   work. The wasted work is the price of the guarantee. Stated in the comment, because a reader
   will otherwise try to remove it.

### New tests — `packages/mls/test/welcome-redelivery.test.ts` (4 total, real ts-mls)

The two characterization tests are kept — they are the evidence the primitive exists for — and two
were added under `describe('the safe join path')`:

| Test | Asserts |
|---|---|
| a first join returns the handle; the repeat returns null and the live handle stands | `processWelcomeOnce({ joined: [] })` returns the handle at epoch `1n`. The group advances (Carol added), Bob follows to `2n`. The Welcome is re-delivered: `processWelcomeOnce({ joined: [bobGroup.groupID] })` returns **`null`** — and the live handle is untouched, still at `2n`, still 3 members, Carol still in its roster, and it still **decrypts the group's current traffic**. |
| a Welcome for a group the member does not hold still joins | With `joined: ['some-other-group', 'a-third-group']`, the join goes through and returns the handle. The guard is per group id, not per member. |

### What we were telling hosts — fixed

| Where | Was | Now |
|---|---|---|
| `packages/rpc/src/commit.ts` — `PendingCommit.onAccepted` | "Both halves must tolerate a repeat" — an obligation **nothing discharged**, with no owner named. | States that the peer **WILL** re-deliver the Welcome on replay, that this is at-least-once and deliberate (suppressing it would strand invitees — the reason the Welcome is journalled), that **the sender must not deduplicate**, and names `processWelcomeOnce` as what absorbs the repeat on the invitee's side — with the explicit warning that plain `processWelcome` does **not**. |
| `packages/rpc/src/peer.ts` — `GroupPeerMLSParams.adoptJournalled` | "MUST be idempotent" and nothing more; it is the *other* place a host delivers a Welcome. | Adds that the Welcome goes out again at-least-once by design, pointing at `PendingCommit.onAccepted` for why and for what absorbs it. |
| `docs/.../2026-07-13-control-ledger-lane-design.md:752` | "The host must therefore write both halves of `onAccepted` to tolerate a repeat (… **or simply no-op a Welcome for a member already at that leaf**)." — the no-op it recommends is not available to a host. | The sender does not deduplicate and must not; at-least-once is the contract; the repeat is absorbed by `processWelcomeOnce`; and *why* the absorption had to be built rather than assumed (pure function, no registry, check cannot be hoisted above the join). |
| `docs/.../2026-07-13-control-ledger-lane-design.md:1824` (testing clause) | "the invitee, already joined, **no-ops it** rather than erroring or building a duplicate group" — **false**. | Asserts both halves: that plain `processWelcome` silently builds a second group state at the joining epoch (it does — it neither errors nor no-ops, which is *why* the safe path exists), and that `processWelcomeOnce` returns `null` and leaves the member's epoch, roster and readability untouched. |
| `docs/.../plans/2026-07-13-control-ledger-lane.md:369` | "the invitee **no-ops the duplicate Welcome**" — **false**. | The duplicate is absorbed by the invitee via `processWelcomeOnce`; plain `processWelcome` does not absorb it. |

`docs/.../control-ledger-lane-review.md:182` was checked and left alone: it says a second
`processWelcome` "is not a no-op — it either errors or builds a duplicate group state", which is
*correct* (it builds a duplicate). It never made the false promise.

The remove-notice fix and its positive control are untouched, and the mutation check still holds.

### Verify

```
$ rtk proxy pnpm run build
 Tasks:    7 successful, 7 total
$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 188 files in 163ms. No fixes applied.
$ rtk proxy pnpm test
@kumiai/hub-protocol:test:unit:  Tests    8 passed (8)
@kumiai/broadcast:test:unit:     Tests   35 passed (35)
@kumiai/hub-tunnel:test:unit:    Tests   63 passed (63)
@kumiai/hub-client:test:unit:    Tests    5 passed (5)
@kumiai/hub-server:test:unit:    Tests   57 passed (57)
@kumiai/mls:test:unit:           Tests  287 passed (287)     <- was 283 (+4)
@kumiai/rpc:test:unit:           Tests  148 passed (148)     <- was 147 (+1)
 Tasks:    27 successful, 27 total
```

Nothing committed.

### Files touched (cumulative)

- `packages/mls/src/group.ts` — **`processWelcomeOnce`**, the safe join path.
- `packages/mls/src/index.ts` — exports it.
- `packages/mls/test/welcome-redelivery.test.ts` — 4 tests: the two characterizations, and the two for the primitive.
- `packages/rpc/src/commit.ts` — `PendingCommit.onAccepted` rewritten.
- `packages/rpc/src/peer.ts` — `adoptJournalled` doc pointer.
- `packages/rpc/src/memory-group-mls.ts` — `evict(did)` on the double.
- `packages/rpc/test/fixtures/peer.ts` — `buildRemoveCommit`, `adoptJournalled` override.
- `packages/rpc/test/peer-commit-replay.test.ts` — remove positive control, rewritten failure test.
- `docs/superpowers/specs/2026-07-13-control-ledger-lane-design.md` — two false claims fixed.
- `docs/superpowers/plans/2026-07-13-control-ledger-lane.md` — false claim fixed.
