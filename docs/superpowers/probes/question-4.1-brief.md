# Probe brief — a durable app cursor, and a pruned window that is reported rather than silent

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted for review.

**Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.** That has
destroyed work on this plan twice. To revert a mutation, invert the edit by hand.

## Context: what is already committed and true

`packages/rpc/src/peer.ts` (commit `3cee984`, `5b72586`):

- `loadAppSegment()` pulls a segment's topic **from its oldest retained frame, every time**, paged, and
  buffers the frames **sealed**. `deliverAppFrames()` runs before each `port.processCommit` and once at
  the end of the walk, trial-decrypting the buffer at whatever epoch the handle is at.
- A frame is opened at the epoch it was sealed at — the apply ratchets the handle past it and those
  bytes are ciphertext forever after. `unwrap` throwing is ordinary control flow: "not my epoch".
- `captureAnchor` resets the buffer; the anchor moving IS the segment boundary.
- The drain skips self-echo frames and re-checks `retentionOf` per frame. **Do not change either.**
- `mux.retainTopic(topicID)` subscribes without a listener (the hub gates `fetchTopic` on the caller's
  own subscription).
- `// SEAM:` in `loadAppSegment` marks where a below-retention gap is knowable and unreported.

## The exact question

Does the drain read from a durable cursor, and detect a below-retention gap and emit a pruned-window
event rather than dropping frames silently?

## Established facts — do NOT re-derive

**1. The cursor cannot be built on `unwrap` alone, and this is the crux.** To advance a cursor past a
frame you must know that frame is done — delivered, or dead forever. `unwrap` throwing does not say
which: "sealed at an epoch ahead of the walk" (keep buffered) and "sealed at an epoch the handle can
never reach again" (dead) are the same exception. The drain's own comment says so. Advancing past a
not-yet-openable frame loses it on the next restart — **the exact bug this whole feature exists to
kill**.

**2. The sealed epoch is readable without opening the frame.** MLS carries it in a PrivateMessage's
cleartext, and `@kumiai/mls` already exports `readMessageEpoch(bytes): bigint | undefined`
(`packages/mls/src/group-info.ts:25`, re-exported from `index.ts:86`). A host implements the port method
below in one line over it.

**3. ts-mls retains only 4 past epochs and the drain must not lean on it** — the window is spent by
epoch transitions, not time. See `docs/superpowers/probes/ts-mls-past-epoch-decrypt.md`. Unchanged here.

## Approved approach (follow it; BLOCKED if it fights the code — do not redesign)

Three additive surfaces. They are load-bearing for each other: the cursor needs (1), the signal needs
(2).

1. **`GroupCrypto.frameEpoch(bytes): number | null`** (`packages/rpc/src/crypto.ts`) — the epoch a frame
   was sealed at, read from its cleartext without opening it. `null` for bytes that are not a readable
   sealed frame (garbage, truncated) — it must not throw. Document it beside its neighbours, and say
   what it is FOR: a reader cannot otherwise tell a frame it cannot open YET from one it can never open
   again, and that distinction is what makes a durable read position safe. Implement it in
   `test/fixtures/fake-crypto.ts` (the fake already writes the epoch into the first two bytes in
   `wrap`).
   - **Use it to retire the trial decrypt** in `deliverAppFrames`: select the frames whose
     `frameEpoch === crypto.epoch()` rather than trying every buffered frame and catching. Keep the
     `unwrap`-throws-is-normal posture for anything that still slips through — a frame's cleartext epoch
     is the hub's word, not the handle's, and only `unwrap` is authoritative.
2. **`AppCursorStore`** — a durable read position per **topic ID**: `load(topicID): Promise<string |
   null>`, `save(topicID, position): Promise<void>`. Keyed by topic ID because it already encodes
   segment AND protocol; do not fold it into `Anchor` (the drain is per-protocol, and a cursor is
   written per drain rather than per rotation). Required alongside `mls`/`journal`/`anchorStore` in
   `GroupPeerMLSParams`, on that type's own standing argument: the failure is silent, and the type is
   what stops a host wiring it. Fixture: a memory store that can **outlive** a peer.
   - **The advance rule is the whole safety property.** The cursor may only advance past frames that are
     done: delivered, or sealed at an epoch below the handle's current one (dead — `frameEpoch` is how
     you know). It must NEVER advance past a frame sealed at an epoch the walk has not reached. Getting
     this wrong reintroduces the original bug, so state the rule in a comment and let a test hold it.
3. **`onAppWindowPruned` callback** on `GroupPeerParams` — optional (unlike the stores: a host that does
   not want the signal loses no messages by ignoring it, which is exactly the line the required ones
   fail). Fires when `loadAppSegment` finds the hub's `oldest` is **newer than the stored cursor**: a
   gap below the retention floor. Payload carries what rpc knows — the group, and the gap boundary as a
   cursor/sequence. **No wall-clock**: the host renders "messages since <date>" from its own HLC. Shape
   it to drop into a host health condition.

## Done when (all required)

1. A test asserts the drain reads **from the cursor**, not from the topic's oldest: seed frames, let a
   peer drain them, restart it, and assert it does not re-deliver what it already delivered (today it
   re-pulls the segment whole).
2. A test holds the advance rule: a frame sealed at an epoch **ahead** of the walk is buffered, the peer
   is restarted before reaching that epoch, and the frame is **still delivered** afterwards. This is the
   test that stops a future cursor optimisation from silently losing messages.
3. A test forces the hub to prune below a peer's cursor, brings the peer back, and asserts (a) the
   surviving frames are still delivered, and (b) `onAppWindowPruned` fires and names the group.
4. **Mutation checks (required, paste each):** (a) revert the emit → the pruned test goes red; (b) let
   the cursor advance past an un-openable frame → the advance-rule test goes red. Invert both by hand;
   confirm green, no residue.
5. Whole suite green. `peer-app-drain.test.ts` and `peer-app-segment-drain.test.ts` must stay green —
   they are the drain's existing contract and this must not weaken them.

## Known residuals — do NOT close, do NOT report as surprises

- The `processCommit`→`save` window (Question 2.4); the laggard publisher; a fresh joiner's empty
  ts-mls window. All accepted.
- Wiring the event into Kubun's `GroupHealthMonitor` is a **Kubun-side follow-up**. This question's
  obligation is only an rpc event whose shape drops in.

## Scope boundary

The cursor + `frameEpoch` + the pruned signal ONLY. No retention default change (Phase 5). Do not touch
the drain's before-apply design, the self-echo skip, `detectRosterChange`, the external signal, the
`AnchorStore` shape, or the fake's single-epoch `unwrap` strictness.

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`. Code/comments/tests never name plan questions or phases — state the
invariant ("a cursor may only pass a frame that is delivered or dead; a gap below retention is reported,
never silent").

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`
(`pnpm run lint` alone → eslint via the `rtk` shim; use `rtk proxy pnpm run lint`.)

## Report contract

Full report → `docs/superpowers/probes/question-4.1-report.md` (changes with file:line, both mutations
pasted, how the advance rule is enforced and what holds it, what the cursor does to the buffer's size on
a long walk, surprises, concerns). Return ONLY: status, uncommitted-changes note, one-line test summary,
concerns. No full diff.
