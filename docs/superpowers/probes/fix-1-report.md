# Probe report — every site that advances the handle upholds the lane's invariant

Status: **DONE**. Branch `feat/app-lane-delivery`, uncommitted, nothing committed or stashed, no
`git checkout`/`restore`/`stash` run at any point (both mutations were inverted by hand).

## The seam

`advanceHandle` — `packages/rpc/src/peer.ts:1128`.

```ts
const advanceHandle = async <T>(
  port: GroupMLS,
  advance: () => Promise<T>,
  rotatesAnyway: (advanced: T) => boolean = () => false,
): Promise<T> => {
  await deliverAppFrames()
  const rosterBefore = await port.rosterDIDs()
  const advanced = await advance()
  if (detectRosterChange(rosterBefore, await port.rosterDIDs()) || rotatesAnyway(advanced)) {
    await captureAnchor()
  }
  return advanced
}
```

`advance` ratchets the handle and does nothing else; the drain, the roster diff and the capture are
the seam's and are not spellable anywhere else. It sits directly below `deliverAppFrames`, above
every caller.

All four advance sites route through it, and there is no longer any other:

| site | call | `rotatesAnyway` |
| --- | --- | --- |
| `walkCommits` (applying others' commits) | `peer.ts:1280` | `(result) => result.advanced && header?.external === true` |
| `commit()` (a roster change this peer AUTHORS) | `peer.ts:1767` | — (diff only) |
| `replayJournal`, accepted slot | `peer.ts:1493` | — |
| `replayJournal`, republished | `peer.ts:1550` | — |
| `recover()` (rejoin) | `peer.ts:1945` | `() => true` |

`captureAnchor` now has exactly one other caller: the genesis seed in `ready` (`peer.ts:2036`),
which is not an advance — it is the first boot's "there has been no roster change yet".

Notes on the approach, which did not fight the code:

- **The roster diff, not the commit's `kind`**, as briefed. `walkCommits` already trusted it; the
  authored path now trusts the same function over the same before/after read, so the author and the
  applier of one commit answer the same question with the same code.
- **`recover()`'s explicit capture is folded in** and is now the `rotatesAnyway` case rather than a
  fourth spelling. The ordering it depended on (the anchor is the POST-commit epoch, so capture
  strictly after `onAccepted`) is the seam's own ordering, so it survives structurally instead of by
  a comment at one call site.
- **`rotatesAnyway` takes the advance's result**, not a boolean, because the external flag alone is
  not sufficient at the apply site: a refused external commit (`{ advanced: false }`) is a flag on a
  frame nobody enacted and must not rotate. The predicate is where that stays visible.
- `walkCommits`'s `MissingLedgerEntriesError` path is unchanged — the error propagates out through
  the seam and is caught at the same place, with the same `continue`.

## F6 — the dispatch topic

`sealForSegment` — `peer.ts:566`; `dispatch` uses it at `peer.ts:588`.

The seal and the topic are produced as **one answer**: the live anchor is read, the bytes are
sealed, the anchor is re-read, and the pair is discarded and re-made if it moved (identity compare —
every capture mints a fresh anchor object). An anchor that did not move across the seal is one whose
segment runs from its own epoch to a rotation that has not happened, so the seal epoch is inside the
span the topic covers. Deriving from the live anchor without that re-read would still leave the
inverse race (a rotation landing inside `crypto.wrap`, publishing an old-epoch seal to the new
segment), which is unreadable in exactly the same way.

`ProtocolRuntime.topicID` is **deleted** rather than left unread (`peer.ts:301`). It was the only
remaining second spelling of "the app topic", it was a segment stale by construction inside the
rotation window, and leaving it in the struct is leaving the hole writable. The transports still
bind to the topic computed in `buildEpoch`; only the field is gone.

## Fixtures — why no test caught F1

The gap was the fixtures' shape, as briefed, and it was one layer deeper than the missing
`anchorEpoch()` assertion: `buildRemoveCommit`/`buildInviteCommit` built a commit that carried **no
roster op at all** (`mls.buildCommit([])`), and modelled the eviction as `member.mls.evict(victim)`
inside the author's own `onAccepted`. So the roster changed only in the author's local bookkeeping —
no member applying that frame from the log saw an Add or a Remove in it. A test driving a roster
change through `commit()` could not have asserted agreement between the author and an applier,
because there was nothing in the commit for the applier to agree with.

Changed:

- `test/fixtures/memory-group-mls.ts:38,493` — `buildCommit(tokens?, { adds?, removes? })`, passing
  them into `encodeMemoryCommit`, which already accepted both (`publishCommit`'s off-stage admin has
  always used them). Nothing about the double's strictness moved: not `processCommit`'s epoch gate,
  not its refusal to apply its own commit or one that removes it, not `fake-crypto`'s
  current-epoch-only window.
- `test/fixtures/peer.ts:213,240` — the Remove and the Add ride the commit. `buildRemoveCommit`'s
  separate `mls.evict` is dropped: adopting the post-commit handle now performs the eviction, which
  is what the fixture's own doc always said it was.

All 214 pre-existing tests pass against this unchanged. **No existing test conflicted with the fixed
behaviour, and none was weakened.**

## New tests — `packages/rpc/test/peer-anchor-advance.test.ts` (4)

1. `a Remove this peer authors lands it on the anchor every applying member reaches` — alice
   `commit(buildRemoveCommit(alice, 'carol'))`, bob applies from the log. Asserts both
   `anchorEpoch() === 2`, the persisted anchor, and the wire in both directions, plus that both
   frames are on the segment-2 topic and the topic carol still holds is empty.
2. `an Add this peer authors lands it on the anchor every applying member reaches` — same, through
   `buildInviteCommit(alice, 'dave')`.
3. `the adopt reads the epoch it leaves and takes the anchor the roster change moved` — bob's
   eviction of carol is accepted and his process dies before adopting; a frame is published at his
   stuck epoch onto his segment while he is gone; he restarts, drains the frame, adopts, and lands
   on anchor 2.
4. `a dispatch racing a rotation is published where the rotated member can read it` — the race is
   run deterministically from inside the anchor store's write, which IS the F6 window (anchor moved,
   lane not yet rebuilt). Asserts the frame is on the segment containing its seal epoch, that the
   abandoned segment is empty, and that bob — cold, walking the same Remove — reads it.

## Mutations (required)

### 1. The authored-commit path leaves the seam → (1) red

`peer.ts:1767`, `await advanceHandle(mls, () => pending.onAccepted())` → `await pending.onAccepted()`:

```
 ❯ test/peer-anchor-advance.test.ts (4 tests | 2 failed) 489ms
     × a Remove this peer authors lands it on the anchor every applying member reaches 119ms
     × an Add this peer authors lands it on the anchor every applying member reaches 109ms

 FAIL  ... > a Remove this peer authors lands it on the anchor every applying member reaches
AssertionError: expected 1 to be 2 // Object.is equality

- Expected
+ Received

- 2
+ 1

 ❯ test/peer-anchor-advance.test.ts:72:38
     70|     // The agreement, and the author is the half of it nothing else ca…
     71|     expect(bob.peer.anchorEpoch()).toBe(2)
     72|     expect(alice.peer.anchorEpoch()).toBe(2)
       |                                      ^

 FAIL  ... > an Add this peer authors lands it on the anchor every applying member reaches
AssertionError: expected 1 to be 2 // Object.is equality
 ❯ test/peer-anchor-advance.test.ts:129:38

 Test Files  1 failed (1)
      Tests  2 failed | 2 passed (4)
```

`expected 1 to be 2` — the brief's confirmed signature. Inverted by hand; green.

### 2. The replay path leaves the seam (dropping its drain) → (2) red

`peer.ts:1493`, `await advanceHandle(mls, () => adoptJournalled(entry.journal))` →
`await adoptJournalled(entry.journal)`:

```
 ❯ test/peer-anchor-advance.test.ts (4 tests | 1 failed) 702ms
     × the adopt reads the epoch it leaves and takes the anchor the roster change moved 112ms

 FAIL  ... > the adopt reads the epoch it leaves and takes the anchor the roster change moved
AssertionError: expected [] to deeply equal [ { text: 'while he was gone' } ]

- Expected
+ Received

- [
-   {
-     "text": "while he was gone",
-   },
- ]
+ []

 ❯ test/peer-anchor-advance.test.ts:204:18
    202|     expect(restarted.mls.epoch()).toBe(2)
    203|     expect(restarted.mls.leaves()).not.toContain('carol')
    204|     expect(seen).toEqual([{ text: 'while he was gone' }])
       |                  ^

 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)
```

The backlog is lost silently — the peer converges, evicts, reaches epoch 2 and raises nothing.
Inverted by hand; green.

### 3. Not required — the publish topic taken from the runtime again → (3) red

Re-added `ProtocolRuntime.topicID` and published to it, to show the F6 test is not vacuous:

```
 ❯ test/peer-anchor-advance.test.ts (4 tests | 1 failed) 658ms
     × a dispatch racing a rotation is published where the rotated member can read it 111ms

AssertionError: expected [] to have a length of 1 but got +0

 ❯ test/peer-anchor-advance.test.ts:277:29
    276|     const landed = await hub.fetchTopic({ subscriberDID: 'alice', topi…
    277|     expect(landed.messages).toHaveLength(1)
```

Inverted by hand; green.

## Verify

```
rtk proxy pnpm run build   → Tasks: 8 successful, 8 total
rtk proxy pnpm run lint    → Checked 223 files in 230ms. Fixed 1 file. (import order, my new test)
rtk proxy pnpm test        → @kumiai/rpc 218 passed (214 + 4) | @kumiai/mls 307 passed
                             broadcast 35, hub-tunnel 63, hub-server 69, hub-protocol 8, hub-client 5
                             Tasks: 30 successful, 30 total
```

The rpc suite was run three further times end to end: 218/218 each time, no flake.

## Surprises

- **The fixture gap was structural, not an oversight.** The two helpers that drive a roster change
  through `commit()` could not have been asserted against an applier at all — the commit they built
  carried no Add or Remove for an applier to read. So the missing `anchorEpoch()` assertion in those
  two files was a symptom; the cause is that the author's roster change lived only in the author's
  own bookkeeping. That is the same shape as the bug in `peer.ts`: the author's half of a roster
  change was treated as a private matter.
- **`recover()`'s comment was already the fix's own argument**, verbatim — "a member does not process
  its own commit, so the apply site never runs" — sitting one function away from `commit()`, which
  had the identical problem. The knowledge was in the file; the structure had no place to put it.

## Concerns

- **`sealForSegment` retries by re-sealing.** The loop is bounded by rotations, which are rare and
  cannot be driven by a publisher, so it cannot spin — but it does mean a dispatch that loses the
  race pays a second `crypto.wrap`. Correct and cheap here; worth a glance if `wrap` ever becomes
  expensive or non-idempotent (the real port's is neither today).
- **The known `processCommit`→`save` crash window is unchanged and now sits inside the seam** rather
  than at three call sites — one place to close it if the anchor ever becomes durable with the
  handle, which is the same bound `captureAnchor`'s doc already names. Not touched (accepted).
- **`advanceHandle`'s drain is at-least-once against the live path**, as it already was in
  `walkCommits`. `commit()` now drains on every commit, which is a no-op after the pull that
  precedes it in the same operation (the segment is already loaded). No behaviour change observed
  across the suite, but it is one more drain per commit than before.
- **The F6 fix is about the LOGGED publish only.** The ephemeral/RPC lane still goes through
  `runtime.client`, bound to the topic its transport was built with, and a mailbox frame published
  into the rotation window still lands on the lane the group left. It is not readable by nobody in
  the same way — the members still on that lane are at the old epoch and it is sealed at the new one,
  so it is the accepted-laggard shape, inverted — but it is not nothing, and it is out of this
  brief's scope (the brief names the logged-event publish).
