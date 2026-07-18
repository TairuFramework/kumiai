# F5 report — BLOCKED on the read position, second item landed

Branch `feat/app-lane-delivery`, uncommitted. Changes: `packages/rpc/src/peer.ts`,
`packages/rpc/test/peer-anchor-advance.test.ts`. Nothing else touched.

## Status

- **Done-when 1, 2, 3, 5 — BLOCKED.** The approved approach rests on a premise the codebase
  explicitly denies. Detail below.
- **Done-when 4 — DONE.** The ephemeral publish now derives its topic from the live anchor at
  seal time. Test written, watched red, now green.
- **Second item's invited finding — YES, there is one**, and it is the receive binding. It is
  not what makes the publish fix wrong; it is what the publish fix cannot reach. Detail below.

## Why the read position is blocked

The approved approach is: *when the live path delivers an app frame to the host, that frame's
position advances the same per-topic cursor the drain advances.* That needs the frame's **log
position** on the live path. There is none, and there cannot be one without changing the hub
contract.

The plan doc's premise — "the frame's log position is known at the mux boundary and is discarded
before the host's handler" (`2026-07-18-live-lane-read-position.md`, option 1) — is false. What is
known at the mux boundary is `StoredMessage.sequenceID` off `hub.receive`, and the code says in as
many words that this is **not** a log position:

- `packages/rpc/src/cursor.ts` brands the two apart and names the hazard: "A **delivery position**
  is a place in *this recipient's delivery queue* … It runs across every subscribed topic, skips the
  recipient's own frames, and is emptied by acking. Different sequences, different frames, different
  orders. Crossing them silently mis-pages (skipped or re-read commits) with no type error."
- `packages/rpc/src/hub-mux.ts:366` is the one place a pushed sequenceID is consumed, and it is
  named `asDeliveryPosition` with the comment "An ack names a place in THIS recipient's delivery
  queue, not in the topic's log. The two are different sequences and must never be crossed, so the
  position is named for what it is and never leaves this closure."
- `packages/rpc/src/peer.ts` already declined this exact move once, for the commit lane:
  "A commit-topic delivery is a WAKEUP, nothing more … The payload is not read; its sequenceID is a
  delivery position and can never become the cursor."

Two further facts close off the obvious "but they're the same numbers in practice" escape:

1. **The push carries no retention class.** `StoredMessage` is `{ sequenceID, senderDID, topicID,
   payload }` — no `retain`. Ephemeral and logged frames share one app topic by design
   (`packages/rpc/test/fixtures/peer.ts`: "both classes sharing one topic is the real shape
   anyway"), so a live listener is pushed sequenceIDs that name frames the log does not contain.
   The conformance suite pins exactly this: `packages/hub-conformance/src/index.ts:158` asserts the
   delivery stream is `[first, mailbox, second]` while the log at :170 is `[first, second]`.
2. **The coincidence is not contracted.** The reference `memoryStore` mints both from one counter,
   so the two sequences happen to interleave monotonically today. Nothing in `hub-protocol`,
   `hub-tunnel` or the conformance suite requires it, and there is already a filed plan noting the
   suite runs against one implementation. Against a hub with a per-recipient delivery sequence —
   the model `cursor.ts` documents — a cursor saved from a pushed sequenceID is garbage, and a
   garbage app cursor is silent permanent loss of a returning member's messages. That is strictly
   worse than the defect being fixed.

So the datum the approach needs does not exist on the live path. Getting it means one of:

- **Widen the hub contract** so a pushed log-class frame carries its log position (`StoredMessage`
  gains a field, or the push distinguishes the classes). That is `hub-protocol` + `hub-server` +
  `hub-tunnel` + conformance — out of scope here, and the packages another probe holds.
- **Cross the brand** and treat the pushed sequenceID as a log position. Rejected: see above.
- **Resolve the position per live frame with a `fetchTopic`**, i.e. option 3 in the plan doc — the
  live lane becomes a wakeup and every retained frame reaches the host through the drain. One
  deliverer, one position, no reconciliation. It is the design the commit lane already chose, and
  the plan doc's own lean. It is also a redesign, which the brief forbids me.

Nothing in scope reconciles them, so the latch stays, `loadAppSegment` still pulls once per
segment, and `peer-app-drain-integrity.test.ts`'s mid-walk test stays skipped with its blocker
note. I did not write a test for 1/3/5: there is no fix to run them against, and a test I cannot
watch go green is not evidence of anything.

**The unblock is a hub-contract question, not an rpc one.** Recommend it be briefed against the
hub packages, or that option 3 be approved as a redesign.

## The ephemeral publish topic (done when 4)

`buildEpoch` built both live transports (`BroadcastClient` and `createGroupBusServer`) over
`mux.bus` with the topic captured at build time. Fix 1 moved the *logged* publish onto the live
anchor via `sealForSegment`; the ephemeral and RPC publishes still went to the captured topic. In
the rotation window — anchor and handle already moved inside the commit walk, runtimes not yet
rebuilt — a dispatch seals under the new epoch and published to the segment the group just left.

`segmentBoundTransport` now separates the two halves: it **listens** on the topic the runtime was
built for, and **publishes** to the segment containing each frame's own seal epoch. The topic is
decided by the seal and carried to the publish (`wrap` calls `sealForSegment`, records the topic
under the ciphertext it produced; the bus view routes by that record), keyed by the bytes' identity
because two transports share the lane and their writes interleave.

### The finding: the publish fix cannot reach RPC, because the receive binding did not move

The subscribe still binds to the runtime's topic. For a one-way ephemeral event that is right and
complete — the frame goes where the members who can open it are, and this peer does not need to
hear its own.

For **request/gather it is not enough**. In the rotation window this peer now publishes its request
to the new topic and is still listening on the old one, so a reply from a rotated responder — which
that responder publishes to the new topic — never reaches the client. The RPC times out.

That is not a regression: before this change the request went to the old topic sealed under the new
epoch, which nobody could open, so it timed out too. The fix strictly improves ephemeral events and
leaves RPC exactly as broken, by a *different* cause. The residual cause is the receive binding, and
closing it means re-subscribing the listeners at the rotation rather than at the next
`rebuildEpoch` — which is the same "the lane is rebuilt only once the whole walk returns" seam the
whole rotation window comes from. Filing it rather than papering over it, per the brief.

## Verification

Watched red first, against unfixed code:

```
 × test/peer-anchor-advance.test.ts > an ephemeral dispatch lands on the segment that contains
   its seal epoch > an ephemeral dispatch racing a rotation is published to the segment it is
   sealed under 105ms
   → expected [ Array(1) ] to deeply equal [ Array(1) ]

AssertionError: expected [ Array(1) ] to deeply equal [ Array(1) ]

- Expected
+ Received

  [
-   "_T0JTwdhY5xMmGCXvWUXtIDko1rr49qzmLxWVdwup6I",
+   "zlck_SJT_D2VsJHWK0rw9UECjXiQ7it-LGnbXn_BaYc",
  ]

 ❯ test/peer-anchor-advance.test.ts:267:54
```

The received ID is `chatTopic(1)` — the segment the group had just left. Green after the fix:

```
 ✓ the member that authors a roster change rotates with the members that apply it > a Remove
   this peer authors lands it on the anchor every applying member reaches 218ms
 ✓ ... an Add this peer authors lands it on the anchor every applying member reaches 212ms
 ✓ a peer that adopts a journalled roster change reads its backlog and rotates > the adopt
   reads the epoch it leaves and takes the anchor the roster change moved 104ms
 ✓ an ephemeral dispatch lands on the segment that contains its seal epoch > an ephemeral
   dispatch racing a rotation is published to the segment it is sealed under 103ms
 ✓ a logged dispatch lands on the segment that contains its seal epoch > a dispatch racing a
   rotation is published where the rotated member can read it 155ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

Suites:

```
packages/rpc   PASS (246) FAIL (0) skipped (1)
packages/mls   PASS (311) FAIL (0)
rtk proxy pnpm run lint → Checked 230 files in 219ms. Fixed 2 files.
```

The one skip is `peer-app-drain-integrity.test.ts`'s mid-walk test, still blocked and still
carrying its note. No existing test was weakened; the four duplicate-catching tests
(`peer-app-topic` ×3, `peer-removed-blind` ×1) are untouched and green.

**Note on the full rpc run:** `pnpm exec vitest run` with no exclusion reports 2 failures in
`FakeHub/DurableFakeHub: LogHub conformance > a log topic trims itself once its depth bound is
exceeded`. Those come from the concurrent probe's in-flight, uncommitted work
(`packages/rpc/test/hub-conformance.test.ts`, `packages/hub-conformance/src/log-hub.ts`,
`packages/rpc/test/fixtures/fake-hub.ts`) and are not reachable from anything this probe changed.
The 246 above excludes that one file.
