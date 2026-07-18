# Fix 2b report — a peer that falls behind must not read the group's future as garbage

**Status: DONE.** Uncommitted on `feat/app-lane-delivery`. Not BLOCKED on the `ahead` exposure —
see the argument below, which rests on an empirical finding that changes the question.

## The change

The header's two facts were split by trust and availability.

| File | Line | Change |
|---|---|---|
| `packages/rpc/src/crypto.ts` | 80, 90 | `CommitHeader.epoch` stays required (cleartext, keyless); `committerDID` becomes optional (needs the epoch's sender-data secret). Both fields documented with what they may and may not decide. |
| `packages/rpc/src/crypto.ts` | ~172 | `GroupMLS.readCommitHeader` contract: `null` now means **only** "these bytes are not a Commit", with the failure mode it forbids spelled out. |
| `packages/mls/src/group-handle.ts` | 784 | The one `null` on the member path: the frame is not a PrivateMessage of contentType commit. Both fields are cleartext, so the verdict needs no key. |
| `packages/mls/src/group-handle.ts` | 794 | Failed sender-data decrypt / unresolvable leaf now returns `{ epoch }`, not `null`. |
| `packages/mls/src/group-handle.ts` | 775 | External commit with an unparsable leaf credential returns `{ epoch, external: true }` rather than `null` — it is still a commit. |
| `packages/rpc/src/classify.ts` | 218, 222 | `ahead` / `history` / `fork` dispatch on the **epoch alone**. |
| `packages/rpc/src/classify.ts` | 241 | **New row.** At this peer's own epoch, a missing committer is `poison`. |
| `packages/rpc/src/classify.ts` | 247 | `own-unmerged` unchanged: authenticated committer or nothing. |
| `packages/rpc/test/fixtures/memory-group-mls.ts` | 542 | Double made faithful in **both** directions: a member commit framed at any epoch but its own yields `{ epoch }` with no committer. |

## The per-row trust argument

| Row | Reads | Why that is sound |
|---|---|---|
| `poison` (null) | nothing | Bytes that are not a commit cannot be asked an epoch question. |
| `ahead` | epoch only (**unauthenticated**) | Must. A peer that fell behind holds no sender-data secret for the epoch it fell behind from. Requiring a committer does not make the row safer, it makes it unreachable. Exposure argued below. |
| `history` | epoch only (**unauthenticated**) | Same key argument (a ratcheted-past epoch's secret is gone), and nothing is spent on the answer — the frame is stepped over, never handed to the port, its blob never touched. |
| `fork` | epoch + sequenceID | Reached through the below-epoch branch, so it only ever sees frames whose committer is unavailable. It settles on this peer's own applied-commit record and the hub's chaining. **It never reads the committer, and must not** — a fork check that leaned on the hub's word about authorship would be one an attacker could steer. |
| `poison` (no committer at own epoch) | epoch + committer absence | This is the one epoch where the committer *is* available, so a commit here without one is nothing honest. |
| `own-unmerged` | epoch + **authenticated** committer | Unchanged, deliberately. Only reachable at the current epoch, where the decrypt works, so it loses nothing by refusing everything else. |
| `apply` | epoch + **authenticated** committer | Unchanged. |

Two fall-through hazards the new `poison` row closes, both noted in the code:

- Falling through to `apply` would hand the port a frame it cannot process. `peer.ts:1402` rethrows
  anything that is not `isMissingLedgerEntries`, leaving the cursor put and re-reading the frame —
  **the lane wedges on it forever.** This is the regression the split would have introduced without
  the guard.
- Falling through to `own-unmerged` would let a forged frame heal a peer on demand.

`poison` keeps meaning one thing operationally — *advance, never retry, never heal* — and now covers
two classifications plus the two the port answers for. The cursor advances over all four.

## The `ahead` exposure (brief item 2) — answered, not waved through

**What the peer does:** `peer.ts:1346-1353`. Steps over the frame, sets `healRequested` and
`stranded`, and runs `recover()`: a rendezvous request, a sealed GroupInfo from every responder, an
external commit, and a compare-and-set. Until it lands, `commit()` refuses with
`RecoveryRequiredError`. One publish → every reading peer heals at once → M external commits → M
group-wide epoch advances and app-lane rebuilds. That is real, and it is the same recovery storm
`own-unmerged` refuses to fund.

**The finding that decides it: the exposure already exists today, and this change does not create
it.** `readExternalCommit` (`group-handle.ts:178-199`) is a purely structural read — it verifies no
signature and needs no secret and no tree — and `readMessageEpoch` reads a PublicMessage's epoch
from cleartext. So a forged external commit claiming a high epoch has always reached the `ahead`
row. I probed this against **unmodified** code before touching anything:

```
1. BASELINE PROBE: is `ahead` already attacker-reachable today? a forged EXTERNAL commit claiming a high epoch drives an honest peer to heal
   AssertionError: expected 1 to be +0 // Object.is equality
       at packages/rpc/test/zz-probe-scratch.test.ts:33:29
```

One frame, `encodeMemoryCommit(999, 'mallory', [], { external: true })`, published by a removed
member: one heal. (Scratch file deleted; the permanent version is the bounded-cost test below.)

**Why it is accepted:**

1. **Not new, and closing this row would not close it.** The external branch is unauthenticated in
   exactly the same way and is not being changed.
2. **Unclosable by construction.** Any signal that says "you fell out of the group" is one a hostile
   publisher can also emit, because a peer that fell out is by definition one that cannot
   authenticate what the group is doing now. There is no key on this side of the gap.
3. **A liar can trigger a heal, never suppress one.** Honest ahead-frames are in the log too and are
   classified independently.
4. **Bounded to one heal per frame, no loop.** The frame is stepped over *before* the heal is asked
   for, so it is never re-read; the peer lands at the group's real epoch and is not returned there by
   the same frame. The attacker pays one published frame per heal — a write capability any member
   has anyway.

**What the alternative costs.** BLOCKING here leaves the group with *both* the stall *and* the
exposure: `ahead` stays unreachable for member commits (a fallen-behind peer silently dies at a dead
epoch with a clean bill of health) while the external route stays wide open. That is strictly worse.

The bound in (4) is what makes it survivable, so it is now pinned by a test rather than left to the
argument: `peer-cursor-table.test.ts`, *"a forged epoch claim buys exactly ONE heal per frame, and
does not wedge or loop"* — in the `a hostile commit cannot make an honest peer do expensive work`
block, next to the rows that refuse to fund a storm.

**Residual concern, filed not closed:** the amplification (1 publish → M heals → M epoch advances)
is unchanged and unaddressed. It belongs to whoever can gate *publishing* to the commit topic, not
to `classify.ts`. Worth its own item.

## Done when

| # | Evidence |
|---|---|
| 1 | `peer-cursor-table` *"a peer the group left behind…"* — red before (below), green now. |
| 2 | Two new port-level tests in `packages/mls/test/commit-header.test.ts` (AHEAD and BELOW report their epoch with no committer) — red before (below), green now. Fork check verified to need no committer; see mutation C. |
| 3 | `commit-classify` *"at this peer's OWN epoch a missing committer is poison"* — red under mutation B (below). |
| 4 | All four green, on the port's real behaviour: the double is now *stricter* than before, in both directions. |
| 5 | Both mutations pasted below. |
| 6 | `pnpm run build` ✅, `rtk proxy pnpm run lint` ✅ (224 files, no fixes), `pnpm test` → **30/30 turbo, rpc 227 passed + 1 skipped, mls 309 passed**. No existing test weakened or deleted. |

### Red first — the four (unmodified code)

```
PASS (24) FAIL (4)
1. a peer the group left behind learns it from a later frame, not from the one it could not apply, and heals
   AssertionError: expected 1 to be 4 // Object.is equality
       at packages/rpc/test/peer-cursor-table.test.ts:366:29
2. a heal trigger under a failed heal a frame framed ahead of it: no responder — commit() refuses, and nothing lands
   Error: promise resolved "{}" instead of rejecting
       at packages/rpc/test/peer-failed-heal-strand.test.ts:143:79
3. a heal trigger under a failed heal a frame framed ahead of it: a responder answers — the peer heals, then commits
   AssertionError: expected 1 to be greater than 1
       at packages/rpc/test/peer-failed-heal-strand.test.ts:166:31
4. a heal re-enacts by ledger membership an entry the group already holds is not re-enacted, and a later admin is not reverted
   AssertionError: expected 2 to be 4 // Object.is equality
       at packages/rpc/test/peer-recover-lane.test.ts:140:31
```

### Red first — done-when 2, at the real port

`group-handle.ts:794` inverted by hand to today's `return null`:

```
PASS (5) FAIL (2)
1. GroupHandle.readCommitHeader — a commit framed at another epoch a commit framed AHEAD reports its epoch, and no committer
   AssertionError: expected null not to be null
       at packages/mls/test/commit-header.test.ts:131:24
2. GroupHandle.readCommitHeader — a commit framed at another epoch a commit framed BELOW reports its epoch, and no committer
   AssertionError: expected null not to be null
       at packages/mls/test/commit-header.test.ts:145:24
```

These run against real ts-mls, not a double.

## Mutations (required)

### A — `ahead` falls back to `poison` again

`classify.ts:218` → `return header.committerDID == null ? { row: 'poison' } : { row: 'ahead' }`

```
PASS (40) FAIL (6)
1. the cursor table … a frame AHEAD is ahead on its epoch alone
   AssertionError: expected { row: 'poison' } to deeply equal { row: 'ahead' }
       at packages/rpc/test/commit-classify.test.ts:89:57
2. a hostile commit cannot make an honest peer do expensive work a forged epoch claim buys exactly ONE heal per frame, and does not wedge or loop
   AssertionError: expected [] to have a length of 1 but got +0
       at packages/rpc/test/peer-cursor-table.test.ts:331:28
3. a peer the group left behind learns it from a later frame, not from the one it could not apply, and heals
   AssertionError: expected 1 to be 4 // Object.is equality
       at packages/rpc/test/peer-cursor-table.test.ts:408:29
4. a heal trigger under a failed heal a frame framed ahead of it: no responder — commit() refuses, and nothing lands
   Error: promise resolved "{}" instead of rejecting
       at packages/rpc/test/peer-failed-heal-strand.test.ts:143:79
5. a heal trigger under a failed heal a frame framed ahead of it: a responder answers — the peer heals, then commits
   AssertionError: expected 1 to be greater than 1
       at packages/rpc/test/peer-failed-heal-strand.test.ts:166:31
... +1 more failures
```

Done-when (1) is #3. Inverted by hand; suite green again.

### B — `own-unmerged` accepts an unauthenticated committer

`classify.ts:241` guard removed, `:247` → `if (header.committerDID == null || header.committerDID === state.localDID)`

```
PASS (16) FAIL (1)
1. the cursor table … at this peer’s OWN epoch a missing committer is poison — never own-unmerged, never apply
   AssertionError: expected { row: 'own-unmerged' } to deeply equal { row: 'poison' }
       at packages/rpc/test/commit-classify.test.ts:120:57
```

Done-when (3). Inverted by hand; suite green again.

### C — the double answers `null` for a past-epoch member commit (today's real port)

Run for the coordinator's mid-flight `fork` finding. `memory-group-mls.ts:542` → `return null`:

```
PASS (10) FAIL (2)
1. a heal re-enacts by ledger membership an entry the group already holds is not re-enacted, and a later admin is not reverted
   AssertionError: expected 2 to be 4 // Object.is equality
       at packages/rpc/test/peer-recover-lane.test.ts:140:31
2. a hub that forked the log the losing branch rejoins the winner, and re-enacts the entries the winner never had
   AssertionError: expected [] to have a length of 1 but got +0
       at packages/rpc/test/peer-recover-lane.test.ts:286:39
```

**Confirms the finding: the `fork` row was unreachable against a real port** — the losing branch
never heals (`recoveryRequests` = 0). It is one defect with `ahead`/`history`, and the same split
fixes it: the fork check needs the epoch and the applied-commit record, both of which survive.
Inverted by hand; green again.

## Findings

1. **The `ahead` exposure is pre-existing, via the external-commit branch.** Not a new door — see
   above. `readExternalCommit` verifies no signature at all. Worth knowing independently of this fix.
2. **A currently-green fork test is green for the wrong reason.** `peer-recover-lane.test.ts:312`,
   *"the winning branch sees the same fork and does not heal"*, passes under mutation C — where the
   fork is never detected at all. It asserts an absence (`recoveryRequests === 0`), so it cannot
   distinguish "saw the fork and correctly declined" from "never saw the fork". I did **not** retune
   it: it is correct as written and is now green for the right reason, but it is not discriminating,
   and nothing observable at the peer distinguishes the two cases without exposing classifier state.
   Flagging rather than contorting it.
3. **None of the four red tests was red for the wrong reason.** All four assert the right behaviour
   and were red purely because the double stopped over-answering.
4. **The new `poison` row was not optional.** Without it the split would have replaced a silent
   stall with a wedged lane — `peer.ts:1402` rethrows and re-reads, forever.

## Concerns

- The residual amplification above (1 publish → M heals). Unchanged by this fix, not closable in
  `classify.ts`, and not currently filed anywhere.
- `readCommitHeader`'s member path returns `{ epoch }` for a commit at the *current* epoch whose
  sender-data will not decrypt. That is now `poison` rather than `apply`, which is right — but it
  means a genuine transient decrypt failure at the current epoch is stepped over and never retried.
  Consistent with how every other poison case is treated, and noted rather than changed.
