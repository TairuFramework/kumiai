# Probe report — a durable app cursor, and a pruned window that is reported rather than silent

**Status: DONE.** The approved approach fit the code; nothing about it had to be redesigned. Branch
`feat/app-lane-delivery`, **uncommitted**, no commits made, no branch switched.

## The question, answered

The drain now reads from a durable per-topic position, and a below-retention gap raises
`onAppWindowPruned` instead of a frame quietly not being there. The `// SEAM:` in `loadAppSegment`
is gone: it marked the place where `result.oldest` was knowable and unreportable for want of a
position to compare it against, and that position now exists.

## Changes

### 1. `GroupCrypto.frameEpoch(bytes): number | null` — `packages/rpc/src/crypto.ts:33`

Added to the port beside `wrap`/`unwrap`, **required** (the cursor cannot be built without it, and a
host that omitted it would fail silently — the same argument the stores make). Documented at
`crypto.ts:33-55` with what it is FOR: `unwrap` throwing says "not my epoch" and cannot say which,
and the ahead/below distinction is what makes a durable read position safe. Also documented as the
frame's own word (publisher's, relayed by an untrusted hub) and never the handle's — it decides what
to try, never what is authentic.

- Fake: `test/fixtures/fake-crypto.ts:88-99`, one `getUint16` over the two bytes `wrap` already
  writes in the clear. Never throws; `null` for bytes too short to hold the field.
- Real host: one line over `readMessageEpoch` (`packages/mls/src/group-info.ts:25`), unchanged.

**The trial decrypt is retired** (`peer.ts:995-1004`): the drain selects on
`frameEpoch === crypto.epoch()` and calls `unwrap` only for frames claiming this epoch. A frame that
claims this epoch and will not open is treated as any frame that will not open — `unwrap` stays
authoritative, and the `throws-is-normal` posture is intact.

### 2. `AppCursorStore` — `packages/rpc/src/app-cursor.ts:31`

`load(topicID)` / `save(topicID, position)`, keyed by topic ID (which already encodes segment AND
protocol), NOT folded into `Anchor`. Required in `GroupPeerMLSParams` (`peer.ts:127-135`) on that
type's own standing argument; the union's non-MLS branch gained `appCursorStore?: undefined`. The
type immediately caught six hand-wired peers in the existing tests, which is exactly its job.

- Fixture: `test/fixtures/app-cursor.ts` — a memory store that outlives a peer, carried by
  `makeMLSPeer`'s `restartOf` (`test/fixtures/peer.ts:80-86,141-143`) so a restart cannot silently
  drop it.

### 3. `onAppWindowPruned` — `packages/rpc/src/peer.ts:184`, payload at `app-cursor.ts:52`

Optional, and the doc states the line: a host that ignores this loses no message, where a host that
skips a store loses messages and is never told. Payload `{ groupID, protocol, cursor, oldest }` — no
wall-clock. `groupID` is the group's **commit topic**, derived from the epoch-independent recovery
secret: stable for the group's life, identical for every member, and the only name rpc has for a
group. It drops straight into Kubun's `GroupHealthMonitor.signal(groupID, condition)`, which is
keyed by exactly a `groupID: string`. Fired from `loadAppSegment` off the first page's reply only
(`peer.ts:864-869`); a throwing host callback is swallowed (`peer.ts:851-854`) — a returning member
must not lose its surviving history to the host's error handling.

## How the advance rule is enforced, and what holds it

**The rule, in the code's own words** (`peer.ts:955-962`, `app-cursor.ts:12-17`): *a cursor may only
pass a frame that is delivered or dead.*

Enforcement is two pieces that cannot drift apart:

1. **Per frame, in `deliverAppFrames` (`peer.ts:995-1004`).** A buffered frame is `{ position,
   sealed }`; `sealed` goes `null` the moment the frame is DONE and only then. Done is total and
   decided by one comparison: `frameEpoch(sealed) > crypto.epoch()` → **not done** (ahead of the
   walk; it keeps its bytes and its place). Everything else is done — delivered, or dead (sealed
   below the walk, or claiming this epoch and refused by `unwrap`, or not a readable sealed frame at
   all: MLS ratchets forward, so no epoch this peer can still reach opens any of them).
2. **Per pass, in `advanceAppCursor` (`peer.ts:930-942`).** The position moves over the leading run
   of done frames and **stops dead at the first frame that is not**. A done frame further along is
   left where it is — a position is a place in the log, so passing it passes everything before it.
   Passed frames are spliced off the buffer there and only there.

What holds it: `test/peer-app-cursor.test.ts:82` — a frame sealed at epoch 4 reaches a peer at epoch
1; the peer is restarted twice without ever reaching epoch 4, and both the direct assertion
(`stored(topicID)` is still the *first* frame's sequenceID, not the future one's) and the behavioural
one (it is delivered after the walk finally reaches epoch 4, three restarts later) hold. Mutation (b)
below shows the frame is *silently lost* the moment the rule is relaxed.

## Done-when

1. **Reads from the cursor, no re-delivery** — `peer-app-cursor.test.ts:27`. Bob drains two frames,
   restarts over the same handle at the same epoch (so both are still openable by him), and the host
   sees each exactly once. Also asserts the stored position is the second frame's sequenceID.
2. **The advance rule** — `peer-app-cursor.test.ts:82`, above.
3. **Pruned window** — `peer-app-cursor.test.ts:154`. Bob reads one frame, goes away; the group posts
   two more; the hub trims below the survivor, taking out both the frame Bob had read and one he
   never did. Coming back: (a) `still retained` is delivered, and (b) `onAppWindowPruned` fires once,
   naming `commitTopic(recoverySecret)` as the group, `chat` as the protocol, and both edges of the
   gap.
5. **Whole suite green**, `peer-app-drain.test.ts` and `peer-app-segment-drain.test.ts` included —
   both untouched and passing.

## 4. Mutation checks (both pasted, both inverted by hand, both green after)

### (a) Revert the emit → the pruned test goes red

Removed the `await reportPrunedWindow(name, cursor, result.oldest)` call in `loadAppSegment` (the
SEAM's original state: knowable, unreported).

```
PASS (2) FAIL (1)

1. the app-lane drain reads from a durable position and reports what aged out below it a window pruned below the position is delivered around and reported, naming the group
   AssertionError: expected [] to have a length of 1 but got +0
       at /Users/paul/dev/yulsi/kumiai/packages/rpc/test/peer-app-cursor.test.ts:210:20
```

Red on the emit specifically: assertion (a) — the surviving frames still delivered — passed above it,
so the test is red because nothing was reported and for no other reason. Inverted by hand →
`PASS (3) FAIL (0)`.

### (b) Let the cursor advance past an un-openable frame → the advance-rule test goes red

Deleted the one line that holds the rule (`if (sealedAt != null && sealedAt > crypto.epoch())
continue`), so a frame ahead of the walk is marked done like any other frame that will not open.

```
PASS (2) FAIL (1)

1. the app-lane drain reads from a durable position and reports what aged out below it a frame sealed ahead of the walk survives restarts and is delivered when the walk reaches it
   AssertionError: expected '000000000002' to be '000000000001' // Object.is equality
       at /Users/paul/dev/yulsi/kumiai/packages/rpc/test/peer-app-cursor.test.ts:120:48
```

The cursor jumped to `000000000002` — the future frame's own position — i.e. it passed a frame the
walk had not reached. To show that this IS the message loss and not just a number, I relaxed that
one assertion temporarily and re-ran the mutation:

```
PASS (2) FAIL (1)

1. ... a frame sealed ahead of the walk survives restarts and is delivered when the walk reaches it
   AssertionError: expected [ { text: 'at epoch one' } ] to deeply equal [ { text: 'at epoch one' }, …(1) ]
       at /Users/paul/dev/yulsi/kumiai/packages/rpc/test/peer-app-cursor.test.ts:146:18
```

The frame is gone: the peer reached epoch 4 holding the key, and the cursor had already fetched past
it. Nothing raised anything — the exact bug the feature exists to kill. Both edits (the source line
and the test relaxation) inverted by hand → `PASS (3) FAIL (0)`, no residue (`git diff` clean of both).

## What the cursor does to the buffer's size on a long walk

It shrinks it, in the dimension that matters, and adds a bounded strings-only tail.

- **The pull is now bounded by the position, not by the hub's retention window.** Before, every
  restart re-pulled the segment from its oldest retained frame and buffered all of it sealed; a peer
  restarting repeatedly mid-walk re-read a month of history each time. Now it fetches `after` the
  cursor: a peer that has read to within N frames of the head buffers N.
- **Bytes are released at the same instant they were before.** `sealed` goes `null` the moment a
  frame is done, which is where the old buffer dropped it from `remaining`. So live bytes in the
  buffer ≈ undelivered frames, unchanged.
- **The new cost is one position string per done frame that sits behind a not-yet-reachable one**,
  spliced away as soon as the run in front clears. In an honest group publish order is non-decreasing
  in seal epoch, so ahead frames are at the tail and the run clears eagerly: the tail is empty
  almost always. The pathological case (a laggard's frame at the front of the buffer, or a
  future-sealed frame early) costs sequenceID strings, not ciphertext, and it is bounded by the
  segment.

## Surprises

- **Nothing fought.** The one thing I expected to be awkward — telling "delivered" from "dead"
  without `unwrap` — is total once `frameEpoch` exists: *not ahead of the walk* is exactly *done*,
  with no residue and no third case. Garbage and a lying epoch claim both fall into "dead" soundly,
  because the handle never returns to an epoch it has left.
- **A real behaviour improvement fell out of retiring the trial decrypt.** Before, a frame sealed
  below the walk was `unwrap`-refused and pushed back into `remaining` — re-tried at every drain pass
  for the rest of the segment, forever, though nothing could ever open it. Now it is recognised dead
  and dropped once. Existing tests were indifferent to it, which is why nobody noticed.
- **The type caught six peers.** Making `appCursorStore` required broke six hand-wired
  `createGroupPeer` call sites in the test suite immediately (`peer-anchor-restart`, `peer-app-topic`,
  `peer-commit-reconnect`, `peer-control-lanes` ×2, `peer-removed-blind`). All fixed; the
  restart-modelling ones (`peer-anchor-restart`) carry the store across the restart rather than
  faking a fresh one.

## Concerns

- **`oldest > cursor` over-reports, and cannot not.** If a peer's own cursor frame ages out with
  nothing behind it, that reads identically to a real gap: nothing anywhere records which positions a
  topic used to hold. It is the conservative side (over-report, never silent) and the doc says so
  (`peer.ts:832-841`), but a host that turns this straight into a user-visible "you missed messages"
  banner will occasionally say so when nothing was missed. Kubun's wiring should treat it as a health
  *condition*, not a message count.
- **The cursor tracks the DRAIN, not the live lane.** A frame delivered by live push is not recorded,
  so a restart re-delivers frames that arrived live and sit after the cursor. This is strictly better
  than before (which re-pulled the whole segment), not a regression, and out of this question's scope
  — but it means the drain is at-least-once against the live path, and hosts should stay idempotent.
- **`groupID` is the commit topic, not a name Kubun already has.** It is honest and stable, but Kubun
  keys health by its own group ID and will need the mapping (it holds the recovery secret, so it can
  derive it). Worth confirming when the Kubun-side follow-up lands; the alternative — no group in the
  payload at all — is worse.
