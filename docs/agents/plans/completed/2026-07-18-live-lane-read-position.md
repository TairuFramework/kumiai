# The live lane advances no read position, so the drain must pull once per segment

> **CLOSED 2026-07-19 on `feat/app-lane-delivery`.** The hub now carries a `logPosition` on every
> log-class push (`hub-protocol/src/types.ts`), so the live lane does have a read position, and the
> `appSegmentLoaded` latch this plan describes no longer exists — the drain re-pulls every time and
> dedupes by that position. The text below is the gap as it stood, kept for the reasoning.

## The gap

The app lane has two deliverers and one read position, and only one of them keeps it.

- **The drain** (`packages/rpc/src/peer.ts`, `loadAppSegment` / `deliverAppFrames` /
  `advanceAppCursor`) pulls the segment's retained log from a durable cursor, delivers what the
  handle can open, and advances the cursor over every frame it is done with.
- **The live lane** (`buildEpoch`, `packages/rpc/src/peer.ts:502-527`) builds a `BroadcastClient`
  and a `createGroupBusServer` over `mux.bus` and hands log-retained frames straight to the host's
  handlers. It touches `appCursors`, `appCursorStore`, and any notion of a read position **not at
  all** — `grep -n appCursors packages/rpc/src/peer.ts` reaches only the drain.

So for an online peer the cursor sits behind every frame the live lane pushed at it, and any second
pull of the same segment reads them all back and delivers them again.

That is what the one-pull-per-segment latch (`appSegmentLoaded`) is actually holding shut. Its
comment used to justify it two other ways — "the log is the same log" and "a re-pull would
re-deliver" — and both are false: the log grows, and the pull is from the cursor. The true reason is
the one above, and it is now written at the declaration.

## What it costs

**A frame published while the walk is walking is never delivered by that walk.** The drain pulls the
segment once, at the first `deliverAppFrames` of the walk; every frame that lands on the topic after
that is invisible to it, because the latch means no later pull ever asks. For a returning member
this is dropped-if-not-listening reintroduced inside the drain that exists to end it.

## Why it is not a one-line fix

Removing the latch alone is a regression. Implemented in full on branch `feat/app-lane-delivery`
(per-topic in-memory `appFetchedTo` fetch position kept distinct from the durable cursor, plus a
per-segment pruned-window report), it made the mid-walk frame arrive **and** broke four existing
tests with duplicate deliveries to live peers:

```
2. the app topic is stable within a roster-change-bounded segment epochs advancing without a roster change leave the app topic put, and delivery continues
   AssertionError: expected [ { n: 1 }, { n: 1 }, { n: 3 } ] to deeply equal [ { n: 1 }, { n: 3 } ]
       at packages/rpc/test/peer-app-topic.test.ts:142:20
3. the app topic is stable within a roster-change-bounded segment a Remove rotates the app topic onto a new ID, and delivery continues across it
   AssertionError: expected [ { n: 'before' }, …(2) ] to deeply equal [ { n: 'before' }, { n: 'after' } ]
       at packages/rpc/test/peer-app-topic.test.ts:207:20
4. the app topic is stable within a roster-change-bounded segment an add-only commit rotates the app topic too, and delivery continues across it
   AssertionError: expected [ { n: 'before' }, …(2) ] to deeply equal [ { n: 'before' }, { n: 'after' } ]
       at packages/rpc/test/peer-app-topic.test.ts:262:20
5. a member removed at the rotation cannot reach the topic the group rotates onto nothing the removed member still holds derives the new topic, and nothing reaches her
   AssertionError: expected [ …(3) ] to deeply equal [ …(2) ]
       at packages/rpc/test/peer-removed-blind.test.ts:143:20
```

Restoring only the latch made exactly those four green again, which isolates the cause to the latch
and not to the restructure. These are duplicates to a **live** peer — not the accepted at-least-once
of a returning one.

## What a fix has to change

The live lane needs to advance a read position when it delivers a log-retained frame, and that pulls
on several things that are currently the drain's alone:

1. **The sequenceID has to reach the lane.** The live path runs through `mux.bus` into
   `BroadcastClient` / `createGroupBusServer`, which are fan-out abstractions over payloads. The
   frame's log position is known at the mux boundary and is discarded before the host's handler. A
   seam has to carry it, or the app lane has to subscribe alongside the bus rather than through it.
2. **Which position does it advance?** Advancing the durable cursor from the live lane is the
   simple answer and it interacts with the invariant the cursor exists for — *a cursor may only pass
   a frame that is delivered or dead*. A live delivery IS a delivery, so it qualifies; but the
   cursor is a position in a LOG, and passing it passes everything before it, including a frame the
   drain is still holding for a later epoch. Live delivery is not in log order relative to the
   drain's buffer, so this cannot be a blind `save`.
3. **Ephemeral frames share the topic.** `chat/changed`-class frames are pushed and never retained,
   so they carry no log position and must not move anything.
4. **Ordering against the drain.** A frame can be live-delivered while the drain holds the same
   frame buffered (the drain pulled it, the push arrived, or the reverse). Whichever way, the host
   must see it once. This is where the accepted at-least-once currently lives, and giving the live
   lane a position is the change that could make it exactly-once — or make it worse.

## Options to weigh

1. **Live lane advances a `deliveredThrough` position, drain reconciles.** The drain skips buffered
   frames at or below it, and the cursor advances as it does today. Keeps one durable position, adds
   one in-memory one. Probably the smallest correct shape.
2. **Live lane advances the durable cursor directly**, with the drain's buffer consulted so it never
   passes an undelivered ahead frame. Fewer moving parts, more ways to violate the invariant.
3. **Drain the topic instead of pushing it** — the live lane becomes a wakeup, like the commit lane
   already is (`onCommitDelivery`: "a delivery is a WAKEUP, nothing more"), and every retained frame
   reaches the host through the drain and its cursor. One deliverer, one position, no reconciliation
   at all. Much larger change; would make the app lane's latency a pull round-trip. Note the commit
   lane already chose this shape for the same reason.

Lean 3 as the design that removes the problem rather than managing it, with 1 as the cheap close if
the mid-walk frame is the only symptom that matters.

## Context

Found by the Fix 2 probe on `feat/app-lane-delivery` while implementing F5 (drop the one-pull latch).
F4 (bound the ahead-claim) and F3 (stall the walk on a failed pull) landed; F5 is blocked on this.
The regression test is in the tree, skipped, with the blocker written above it:
`packages/rpc/test/peer-app-drain-integrity.test.ts` — *"a frame published while the walk is still
walking is picked up by it"*. See `docs/superpowers/probes/fix-2-report.md`.
