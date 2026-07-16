# Probe brief — the three loss scenarios are delivered by pull, and the skipped test comes back

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted for review.

**Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.** That has
destroyed this question's work twice already. To revert a mutation, invert the edit by hand.

## Context: what is already committed and true

The interleaved drain landed (commit `3cee984`). `packages/rpc/src/peer.ts`:

- `deliverAppFrames()` runs **before each `port.processCommit`** (`~:1029`) and once more at the end of
  the walk (`pullCommits`, which wraps `walkCommits`). A frame is opened at the epoch it was sealed at,
  because the apply ratchets the handle past it and those bytes are ciphertext forever after.
- `loadAppSegment()` pulls one segment's topic once, paged, and buffers the frames **sealed**;
  `deliverAppFrames` trial-decrypts the buffer at each epoch the walk passes through. `captureAnchor`
  resets the buffer — the anchor moving IS the segment boundary.
- `mux.retainTopic(topicID)` subscribes without a listener: the hub gates `fetchTopic` on the caller's
  own subscription.
- The drain skips **self-echo** frames (`senderDID === localDID`) — ruled and deliberate, matching the
  live fan-out, which never echoes a publisher its own broadcast. **Do not change this.**
- The drain re-checks `retentionOf` per frame: retention is the protocol's word, not the frame's.

`fixtures/peer.ts` now has **both** classes on one protocol: `chat/changed` (**ephemeral**, live push,
nothing retained) and `chat/posted` (`retain: 'log'`, retained and drainable). Both on one topic, which
is the real shape.

## The exact question

Are all three loss scenarios delivered by pull, with the skipped test un-skipped?

## The three scenarios (spec, §Testing, verbatim)

> The three loss scenarios (epoch never held; own-epoch published after the leaving commit; own-epoch
> after restart), each now delivered by pull.

And, from the same section:

> Assert the **plaintext the handler received**, not the absence of an error (the original loss passed
> a convergence assertion on the line above the failure).

> **Retention split:** an `ephemeral` event (e.g. a typing/presence-shaped procedure) is **not**
> drained — a returning member receives logged events but no ephemeral history.

## Approved approach

1. **Un-skip `packages/rpc/test/peer-app-drain.test.ts:72`** ("a peer that was restarted still reads the
   messages sent at its epoch") and make it pass on `chat/posted`. It is scenario 3.
2. **Rewrite that test's doc comment.** It currently says app frames "are mailbox-class and cannot be
   pulled ... The fix is a pull-readable app lane, and that is a redesign of how app frames are
   addressed and retained ... Unskip this the day it can." That day is here and the comment is now
   false. Replace it with what is true: state the invariant the test pins, not its history.
3. **Cover all three scenarios**, each asserting the **plaintext the handler received**.
4. **Assert the retention split** in the same area: a returning member gets the `chat/posted` history
   and **no** `chat/changed` history. Both procedures live on one protocol and one topic, so this
   proves the split is the protocol's declaration doing the work and not topic separation.
5. **Leave the first test alone.** `peer-app-drain.test.ts:18` ("a peer whose transport dropped still
   reads the messages sent at its epoch") passes today on the **ephemeral** `chat/changed` via the hub's
   mailbox redelivery — a different mechanism from the drain, and a real one. Do not convert it.

## Mutation checks (required, paste each)

Per the spec: "**Mutation-check** the decisive tests: revert the log-class publish; revert the anchor
update — each must turn a green test red."

- Revert the log-class publish (`peer.ts` dispatch: make a logged event take the live path) → a
  decisive test goes red.
- Revert the anchor update (drop the `captureAnchor()` call at the apply site) → a decisive test goes
  red.

Invert each edit by hand afterwards. Confirm green, no residue.

## Honesty requirement — one scenario may not be deliverable

Scenario 2 ("own-epoch published after the leaving commit") may, depending on how you construct it, be
the **laggard-publisher** case: a member still at epoch E writing to segment E's topic *after* the rest
of the group has rotated past E seals bytes nobody can open again. That is inherent, established, and
out of scope — no ordering or store repairs it.

If the scenario as you construct it turns out to be that case, **report it as a finding and do not force
it**. Do not weaken a test, loosen the fake, or contort the drain to make it appear delivered. A clear
"scenario 2 is the laggard case and here is why" is a better outcome than a green test that lies. If it
is instead deliverable (a frame published at the peer's own epoch that simply lands in the log before
the peer's pull), deliver it and say so.

## Known residuals — do NOT close, do NOT report as surprises

- **Unbounded segment buffer** — one pull per segment, so a roster-stable group buffers its whole app
  history. Folded into Phase 4 (it needs the same durable cursor the pruned-window signal needs).
- **The `// SEAM:`** in `loadAppSegment` — a pruned frame is silently absent. Phase 4.
- **`O(frames × commits)`** trial decrypt. Ruled: it delivers a superset, in order, dropping nothing.
- **The `processCommit`→`save` window** (Question 2.4) and **the laggard publisher**. Accepted.

## Scope boundary

The three scenarios + the un-skip + the retention split ONLY. No pruned-window event, no durable cursor
(both Phase 4). No retention default change. Do not touch the drain's design, the self-echo skip,
`detectRosterChange`, the external signal, the `AnchorStore`, or the fake's strictness.

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`. Code/comments/tests never name plan questions or phases — state the
invariant.

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`
(`pnpm run lint` alone → eslint via the `rtk` shim; use `rtk proxy pnpm run lint`.)

## Report contract

Full report → `docs/superpowers/probes/question-3.2-report.md` (changes with file:line, each scenario
and how you constructed it, both mutations pasted, whether scenario 2 was deliverable or the laggard
case, surprises, concerns). Return ONLY: status, uncommitted-changes note, one-line test summary,
concerns. No full diff.
