# Probe report — an external-commit rejoin must rotate the anchor

**Status: CONFIRMED.** Surfacing an external-commit signal on the commit header and rotating on
`rosterChanged || external` makes a rejoining member and the group agree on one app topic. The
approach did not fight the code. Changes are uncommitted on `feat/app-lane-delivery`.

## The answer

Yes. The rotation has two halves and needs both, because a member never applies its own commit:

- **The group's half** — every member applying the external commit rotates to its post-commit epoch,
  off the header's own `external` flag.
- **The rejoiner's half** — it sets its own anchor from the rejoined handle, in `recover()`.

They meet at the same epoch because the rejoiner's `onAccepted` advances its handle to
`framedEpoch + 1`, which is exactly where applying that same commit carries everyone else.

## Changes

### `packages/rpc/src/crypto.ts` — the signal (additive)

- `CommitHeader.external?: boolean` (`crypto.ts:25-49`). Documented like its neighbours: structural,
  pre-apply, from the commit's own bytes. States why it cannot be told any other way (no DID moves,
  no occupied leaf index moves).
- `GroupMLS.rosterDIDs` doc (`crypto.ts:~113`): says what the diff answers for — membership, and
  nothing else — and points at `CommitHeader.external` for rejoins.
- `GroupMLS.readCommitHeader` doc (`crypto.ts:~125`): now reads epoch, committer, and external.

Free at the call site, as predicted: `readCommitHeader` was already called on every frame.

### `packages/rpc/src/peer.ts` — the rotation

- `peer.ts:~762`: hoisted the header out of the `classifyCommit(...)` argument into a `const header`
  so the apply site can read it. The only structural change; `classifyCommit` is untouched.
- `peer.ts:~885`: `if (detectRosterChange(rosterBefore, await port.rosterDIDs()) || header?.external
  === true)`. `detectRosterChange` unchanged, as instructed.
- `peer.ts:~1470`: the rejoiner's own anchor, captured **after** `pending.onAccepted()`.
- `peer.ts:~269`: the `anchor` declaration's doc now covers the rejoin — the invariant restated from
  the side the roster diff cannot see.

### `packages/rpc/test/fixtures/memory-group-mls.ts` — the fake

- `readCommitHeader` reports `external`. Omitted rather than `false` when absent, so existing
  `toEqual` assertions on ordinary member commits keep passing unchanged.
- `decodeMemoryCommit` now type-validates `external`, like its neighbours.
- `encodeMemoryCommit` already threaded `external` through, and `commits.ts` already passed it —
  nothing needed there. The marker existed; only the header did not report it.

### `packages/mls/src/group-handle.ts` — doc only, no behaviour change

`listMembers()`'s comment said "call before and after processMessage to diff a commit's membership
change" without qualification. Corrected to say what the diff can and cannot see, with the leaf-index
reuse and the RFC 9420 §12.4.3.2 citation.

## Was the rejoiner's anchor capture site where it was expected?

Yes — `recover()` step 7, immediately after `await pending.onAccepted()` (`peer.ts:~1469`), the sole
adoption site as the brief said. Two things worth recording:

- **The ordering is load-bearing and the code was already shaped for it.** `rejoinedAtEpoch` is read
  from the header *before* the adopt (it is the framed epoch, for the `appliedByEpoch` fork record).
  The anchor is the *post-commit* epoch, so it must be captured *after*. Capturing it from
  `rejoinedAtEpoch` — the value sitting right there — would have anchored the rejoiner one epoch
  below the group, on a topic no member is on. The two epochs live three lines apart and are not
  interchangeable; the comment says so.
- It lands before the existing `rebuildEpoch()` call, which consumes the anchor. No reordering needed.

## The convergence test

`packages/rpc/test/peer-app-topic.test.ts` — new describe, `a rejoining member and the group agree on
one app topic`. Alice and Eve, both anchored at 1.

1. **Drift** — two commits that touch no leaf. Alice's live epoch runs to 3; her anchor stays at 1.
   Without this the rejoin epoch and the anchor could coincide and the test would prove nothing.
2. **Strand** — `hub.trim(commitTopic(rs), '999999999999')` sweeps the log (the established idiom;
   the head outlives the frames). Eve then boots at epoch 1: no backlog can carry her, and she is
   silently partitioned two epochs below the group. The roster never stopped holding her.
3. **Rejoin** — `eve.peer.recover()`. The external commit is framed at 3, so applying it carries
   Alice to 4 and Eve's rejoined handle starts at 4.
4. **Asserts** — Alice at 4, Eve at 4; one leaf for Eve before and after (nothing a diff could see);
   both derive the same topic; it is *not* the topic they started on; `retain:'log'` `room/posted`
   events exchanged **both ways**; both frames read back off the wire **as Eve**, and the abandoned
   topic holds neither.

`makeRoomPeer` gained a pass-through `recovery` option (needed for the responder's `getDelayMs`).

## Mutation check — required, and it passed

Dropped the `|| external` term, leaving `if (detectRosterChange(rosterBefore, await
port.rosterDIDs())) {`. The convergence test goes red:

```
 × test/peer-app-topic.test.ts > a rejoining member and the group agree on one app topic > a rejoin
   rotates the anchor: the group and the rejoiner land on the same post-commit epoch 289ms
   → expected 1 to be 4 // Object.is equality

AssertionError: expected 1 to be 4 // Object.is equality

- Expected
+ Received

- 4
+ 1

 ❯ test/peer-app-topic.test.ts:444:38
    442|     // that commit derived — the only way she can, since she never app…
    443|     // left the anchor they shared at 1, and landed on the same one.
    444|     expect(alice.peer.anchorEpoch()).toBe(4)
       |                                      ^
    445|     expect(eve.peer.anchorEpoch()).toBe(4)
```

It fails at exactly the right place: **Alice** (the applying member) stays at 1 while **Eve** reaches
4 — the group's half of the rotation is the half the mutation removes, and the result is the
partition this question closes. `peer-recovery.test.ts` (`expected 3 to be 4`) and
`peer-roster-change-detect.test.ts` (`expected 1 to be 2`) also went red under the mutation, so three
independent tests hold the term.

Mutation reverted; `pnpm run build && rtk proxy pnpm run lint && pnpm test` green again (below), and
`grep "header?.external === true" packages/rpc/src/peer.ts` → `886:` — no residue.

## Tests inverted, and one not in the brief

- **`peer-recovery.test.ts`** — the pinned three-way divergence (eve 1, carol/dave 3) is now
  convergence at 4. Its real subject (a stranded peer rejoins, one responder wins, one leaf) is
  preserved untouched; only the anchor block changed. One assertion had to be **corrected rather
  than inverted**: it read `subscriberCount(protocolTopic(secret, 4, 'chat')) === 0`, and the mirror
  image (`topic 1 === 0`) would be **false** — a rotation tears down listeners but never
  subscriptions, so Eve keeps her stale subscription to topic 1 by design. Replaced with the fact
  that is actually decisive and stronger: all **three** members are subscribed to the rejoin epoch's
  topic (`toBe(3)`).
- **`peer-roster-change-detect.test.ts`** — `an external-commit rejoin by a member still IN the
  roster is invisible to a DID diff` pinned `anchorEpoch === 1`. Its subject is the *predicate's*
  blind spot, which is preserved and now asserted directly (`detectRosterChange(before, after) ===
  false`) alongside the rotation happening anyway (`anchorEpoch === 2`). Nothing weakened: the test
  gained an assertion. The `detectRosterChange` unit tests below it are untouched.
- **`group-mls.test.ts` (not named in the brief)** — asserts the exact header of the
  recovery-built commit via `toEqual`. It now also asserts `external: true`. This is a
  strengthening, and the right place for it: it is the port contract test for a rejoin commit's
  header.

## Surprises

1. **`@kumiai/mls` already computes the signal and throws it away.** `readCommitHeader`
   (`group-handle.ts:713`) calls `readExternalCommit` at line 733 and branches on it — the external
   path is how it resolves a committer with no pre-commit leaf. It returns `{ epoch, committerDID }`
   and drops the fact. Surfacing it there is a ~2-line additive change. Out of scope here (doc only),
   but see Concerns.
2. **The brief calls `readExternalCommit` a `GroupHandle` method.** It is a module-private function
   (`group-handle.ts:178`), not on the class and not exported. So the doc fix could not "point at
   `readExternalCommit`" as something a caller can reach; it points at the structural property
   instead, and notes that `readCommitHeader` already makes that read internally without surfacing
   it. Everything else the brief established held exactly.
3. **Stranding a peer while drifting the group is harder than it looks.** Most strand causes
   (`ahead`, `fork`-losing, `own-unmerged`) set `healRequested`, and the lane auto-heals after the
   wakeup — which would have rejoined Eve at a moment the test does not control, before the drift.
   A swept log is the one cause that strands silently, which is why the test uses `trim` and an
   explicit `recover()`. Not a problem, but it constrained the test's shape.

## Concerns

1. **No real host can populate `CommitHeader.external` today** (scope-adjacent, not a blocker). The
   rpc port declares it, and the memory fake implements it — but `@kumiai/mls`'s `readCommitHeader`
   returns `{ epoch, committerDID }` and is the natural adapter source. Until it surfaces `external`,
   a real host either re-decodes the commit itself or cannot rotate on a rejoin, and the hole this
   question closes stays open in production while being closed in the tests. The fix is the ~2-line
   additive change at `group-handle.ts:733-736` described above. The brief scoped `@kumiai/mls` to
   doc-only, so I did not make it — flagging it as the obvious next step.
2. **Anchor persistence, as scoped** — a restart re-seeds from the live handle and re-partitions.
   Expected and deliberately ignored; it is the next question. The convergence test does not restart
   anyone.
3. **`header?.external` uses optional chaining at a site where `header` is provably non-null** (the
   `apply` row implies it). The compiler cannot see that, and the alternative is a non-null
   assertion. `?.` is the cheaper of the two; noting it in case the repo prefers otherwise.

## Verify (real output, repo root)

```
$ pnpm run build
 Tasks:    8 successful, 8 total
Cached:    7 cached, 8 total
  Time:    468ms

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 214 files in 164ms. No fixes applied.

$ pnpm test
 Tasks:    30 successful, 30 total
```

Per-package test detail from the same run:

```
@kumiai/mls:test:unit:          Test Files  25 passed (25)   Tests  306 passed (306)
@kumiai/rpc:test:unit:          Test Files  32 passed (32)   Tests  194 passed | 1 skipped (195)
@kumiai/broadcast:test:unit:    Test Files   8 passed (8)    Tests   35 passed (35)
@kumiai/hub-tunnel:test:unit:   Test Files  20 passed (20)   Tests   63 passed (63)
@kumiai/hub-server:test:unit:   Test Files   5 passed (5)    Tests   69 passed (69)
@kumiai/hub-client:test:unit:   Test Files   1 passed (1)    Tests    5 passed (5)
@kumiai/hub-protocol:test:unit: Test Files   1 passed (1)    Tests    8 passed (8)
```

All five suites the brief named green: `peer-app-topic`, `peer-roster-change-detect`,
`peer-app-retention`, `peer-control-lanes`, `peer-commit-lane`.

## Files changed (all uncommitted)

```
 M packages/mls/src/group-handle.ts                  (doc only)
 M packages/rpc/src/crypto.ts
 M packages/rpc/src/peer.ts
 M packages/rpc/test/fixtures/memory-group-mls.ts
 M packages/rpc/test/group-mls.test.ts
 M packages/rpc/test/peer-app-topic.test.ts
 M packages/rpc/test/peer-recovery.test.ts
 M packages/rpc/test/peer-roster-change-detect.test.ts
```
