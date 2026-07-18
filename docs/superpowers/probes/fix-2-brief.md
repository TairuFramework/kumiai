# Probe brief — the drain must not trust a frame's claim, nor pass an epoch it failed to read

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted for review.

**Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.** That has
destroyed work on this branch twice. To revert a mutation, invert the edit by hand.

## The area

All three defects live in the returning-member drain: `loadAppSegment` (`packages/rpc/src/peer.ts:927`),
`advanceAppCursor` (`:980`), `deliverAppFrames` (`:1035`). Read all three doc comments before touching
anything — two of them are load-bearing and one of them is false (F5).

The safety property they exist for, stated once: **a cursor may only pass a frame that is DELIVERED or
DEAD**, and **a handle may not ratchet past an epoch whose frames were not read**. Both are one-way
doors.

## The three defects

### F4 — HIGH, and it is a security defect

`deliverAppFrames:1055` treats *any* claim above the current epoch as "ahead of the walk": the frame
keeps its bytes and its place, and `advanceAppCursor:985` stops dead at it. There is **no upper bound on
the claim**.

The hub is untrusted and sees every topic ID in the clear. One injected frame claiming epoch `65535`
pins the cursor for the segment's entire life: unbounded buffer growth, whole-segment re-delivery on
every boot, and a permanent spurious `onAppWindowPruned`. For a roster-stable group there is no bound at
all — nothing ever rotates the segment out from under it.

This converts an untrusted party's word into durable local state, which is the exact thing
`frameEpoch`'s trust-boundary doc exists to prevent. That doc covers a claim of *this* epoch and is
silent on a claim of a *future* one. Fix the code and fix the doc.

**Approved bound: the commit log's head.** Fetch the commit topic's head and read its epoch pre-apply
(`readCommitHeader`, as the walk already does). A claim above what that head can justify is **DEAD**,
not ahead — `frame.sealed = null`, and the cursor passes it.

Why that bound is sound and costs no residual: a member can only seal at epoch E after applying the
commit that produced E, so a legitimate frame at E always has its commit **already published** to the
log. Read the head fresh at pull time and the honest race disappears. Do not use the peer's stale view
of the log as the bound — that reintroduces it.

### F3 — HIGH

`deliverAppFrames:1036-1042` catches a `loadAppSegment` failure and `return`s, and the commit walk
ratchets on. The comment — *"the next pull retries it"* — is true of the pull and **false of the
delivery**: one transient fetch error mid-walk destroys the backlog at every epoch the walk then passes.

**Approved fix: stall the walk.** Propagate the failure so `advanceHandle` (`:1097`) does not advance.
No epoch is passed unread. A hub outage stalling commit processing is the accepted cost — the live lane
is dead in that window anyway, and this branch trades liveness for zero loss everywhere else.

No fault injection exists in the suite. You will need to add it (a hub double whose `fetchTopic` fails
once is enough).

### F5 — MEDIUM

`loadAppSegment:928`'s `if (appSegmentLoaded) return` latch, justified by a comment (`:911-915`) that is
**false on both clauses**:

- *"the log is the same log"* — it grows. Frames published during the walk are never seen.
- *"a re-pull would re-deliver"* — the pull is **FROM THE CURSOR**, so it would not.

It was written in Q3.1, before Q4.1 introduced the cursor; the cursor falsified it and the prose was
never revisited. The effect is that the latch defeats the cursor and reintroduces
dropped-if-not-listening *inside the drain*, which is the loss the lane exists to stop.

**Approved fix: drop the latch, pull on every `deliverAppFrames`.** Note that the re-pull's `after` is
the **last fetched position** (in-memory, per topic), which is *not* the durable cursor — the cursor may
be sitting behind a buffered ahead-frame while fetching has gone well past it. Two positions, and
conflating them either re-buffers or skips. Say in a comment which is which and why.

## Done when (all required)

1. **A bounded claim.** A frame claiming an epoch the commit log cannot justify is dead: the cursor
   passes it, the buffer does not grow, and no pruned-window event fires. Assert on the persisted cursor,
   not only on delivery.
2. **A justified claim still waits.** A frame sealed genuinely ahead (its commit *is* in the log) keeps
   its place, is delivered when the walk reaches it, and the cursor passes it only then. F4's fix must
   not eat this.
3. **A failed pull loses nothing.** A drain whose `fetchTopic` fails once does not advance the handle
   past the unread epoch; the retry delivers the backlog whole.
4. **A frame published mid-walk is delivered.** The F5 regression: it must fail against today's latch.
5. **Mutation checks (required, paste each):** restore the unbounded ahead-branch → (1) goes red;
   restore the swallowed load failure → (3) goes red; restore the latch → (4) goes red. Invert by hand;
   confirm green.
6. Whole suite green (rpc 218 + your additions, mls 307, 30/30 turbo). **Do not weaken an existing test
   to make one of these pass** — if an existing test conflicts, that is a finding: report it.

## Known and accepted — do NOT close, do NOT report

The `processCommit`→anchor-`save` crash window; the laggard publisher; a fresh joiner's empty ts-mls
window; the drain being at-least-once against the live path; `oldest > cursor` over-reporting;
`hub-mux` swallowing subscribe failures (filed).

## Scope boundary

The three defects above ONLY. **Out of scope, do not touch, do not work around:** `advanceHandle`'s
roster-diff seam and the anchor capture (just landed), `detectRosterChange`, the `external` signal,
`retentionOf`, the store shapes, the fake crypto's strictness (`unwrap` throwing for any epoch ≠ live is
the contract — do NOT loosen it), and the ephemeral/RPC lane's publish topic (a separate open ruling).

Two test-quality findings are also **out of scope, being fixed separately**: the `retentionOf` re-check
guard and the self-echo guard both surviving deletion, and `peer-app-drain.test.ts:20` sitting in the
drain suite while testing the live lane.

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`. Code/comments/tests never name plan questions, findings, or phases —
state the invariant ("a cursor may only pass a frame that is delivered or dead").

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`
(`pnpm run lint` alone → eslint via the `rtk` shim; use `rtk proxy pnpm run lint`.)

## Report contract

Full report → `docs/superpowers/probes/fix-2-report.md` (changes with file:line, all three mutations
pasted, how the two positions in F5 are kept apart, whether any existing test conflicted, surprises,
concerns). Return ONLY: status, uncommitted-changes note, one-line test summary, concerns. No full diff.
