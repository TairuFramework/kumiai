# Probe brief — the cursor must mean "delivered by any path", not "delivered by the drain"

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted.

**Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.**

## The defect

`loadAppSegment` (`packages/rpc/src/peer.ts`) pulls a segment's app log **once per segment** and latches
(`appSegmentLoaded`). Frames published during a commit walk are therefore never seen by the drain: the
latch reintroduces dropped-if-not-listening *inside* the drain, which is the loss the whole lane exists
to stop.

The obvious fix — drop the latch, re-pull, since the pull is FROM THE CURSOR — was implemented and
**blocked**, correctly. The live lane advances **no read position**: it runs through `mux.bus` /
`BroadcastClient` in `buildEpoch` and never touches `appCursors`. So a second pull re-delivers
everything an online peer was already pushed. Implementing it reddened four tests with duplicate
deliveries (`peer-app-topic` ×3, `peer-removed-blind` ×1) — those tests are right.

Read `docs/agents/plans/next/2026-07-18-live-lane-read-position.md` first; it records that attempt.

## Approved approach (follow it; BLOCKED if it fights the code — do not redesign)

**Give the live lane a read position, so the cursor means "this peer is done with this frame" whatever
path delivered it.** Today it means "the drain is done with it", and that is why the two cannot be
reconciled.

Concretely: when the live path delivers an app frame to the host, that frame's position advances the
same per-topic cursor the drain advances, under the same rule — **a cursor may only pass a frame that is
DELIVERED or DEAD**, and it advances only over a contiguous done prefix. Then dropping the latch is
safe, because a re-pull returns frames the cursor has already passed only if they were genuinely never
delivered.

Points to get right, and to argue in comments:

1. **Ordering.** A live frame can arrive while the drain holds buffered frames in front of it. The
   contiguous-prefix rule already handles this — do not special-case it, but do assert it: a live
   delivery must not advance the cursor past a buffered frame the drain has not finished.
2. **The two positions stay distinct.** The durable cursor and the last-fetched position are different
   things (the fetch position runs ahead of the cursor whenever an ahead-frame is buffered). Dropping
   the latch makes this live. Name both.
3. **At-least-once is a stated residual and stays one** — but it should get *smaller*, not larger. The
   existing residual is "a restart can re-deliver frames that arrived live and sit after the cursor";
   that is exactly what this closes. Say what remains.
4. **Do not weaken the four tests** that caught the first attempt. They must stay green *and* keep
   catching duplicates.

## Second item — the ephemeral lane's publish topic

Fix 1 made the **logged** publish derive its topic from the live anchor at dispatch time, because a
frame must land on the segment containing its seal epoch. The **ephemeral / RPC** publish still binds to
its runtime's topic, captured at the previous `buildEpoch`. In the rotation window that means a frame
sealed under the new epoch published to the segment the group just left — readable by nobody, the same
inconsistency Fix 1 closed for logged frames.

Make the ephemeral publish derive its topic the same way, so seal epoch and topic segment are always
consistent. It is mailbox-class, so the frame is dropped rather than retained — the cost is a lost
ephemeral event or an RPC that times out, not corruption, which is why this is second and not first.

**If this reveals that the real problem is the receive binding** — that subscribers are still listening
on the runtime's topic while publishes have moved — say so and report it rather than papering over it.
That would be a finding worth more than the fix.

## Done when (all required)

1. **A frame published mid-walk is delivered exactly once.** Must fail against today's latch.
2. **An online peer is not re-delivered anything** across a drain that re-pulls — the four existing
   tests stay green.
3. **A restart does not re-deliver frames that arrived live**, which today it does.
4. **An ephemeral dispatch racing a rotation lands on the segment containing its seal epoch.**
5. **Mutation checks (required, paste each):** restore the latch → (1) goes red; stop the live path
   advancing the cursor → (3) goes red. Invert by hand.
6. Whole suite green (rpc 245+, mls 311, 30/30 turbo, integration 23/23). Do not weaken an existing test.

## Known and accepted — do NOT close, do NOT report

The `processCommit`→anchor-`save` crash window; the laggard publisher; a fresh joiner's empty ts-mls
window; `oldest > cursor` over-reporting; the commit-topic storm and external-commit replay (both filed).

## Scope boundary

The app lane's cursor, drain, and publish paths in `packages/rpc/src/peer.ts` / `app-cursor.ts`, and
their tests. **Out of scope:** `classify.ts`, `readCommitHeader`, `hub-mux.ts`, the anchor seam, and
anything under `packages/hub-tunnel/`, `packages/hub-server/`, `packages/hub-conformance/` (another
probe is working those concurrently).

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`. Comments state the invariant, never a finding or phase number.

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`

## Report contract

Full report → `docs/superpowers/probes/f5-report.md`. Return ONLY: status, uncommitted-changes note,
one-line test summary, concerns. No full diff.
