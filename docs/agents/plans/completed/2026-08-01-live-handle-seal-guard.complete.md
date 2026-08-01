# The live-handle seal guard — and the gap that was not there

**Status:** complete
**Date:** 2026-08-01
**Branch:** `test/live-handle-seal-guard`

## What this was meant to be

A `next/` item filed 2026-07-31 asked for a test proving that a **restarted** member which goes on
to **author** a commit seals at the live epoch rather than a captured, pre-`adopt` handle — the
defect `GroupCryptoParams.handle`'s own doc comment names (`packages/mls-rpc/src/crypto.ts:45-50`):
"the handle is replaced when the peer adopts its own commit, and closing over a fixed handle would
silently seal at a dead epoch."

Its stated premise was that **no test in the repo could catch that defect**. That premise is false,
and disproving it is the main result of this work.

## What the probes showed

Three mutations modelling the defect were applied to source during design, each run against the
suites, then reverted:

| Mutation | Suite | Result |
| --- | --- | --- |
| `crypto.ts` `wrap` snapshots `handle()` at construction | `packages/mls-rpc` | 2 failed / 48 |
| same mutation, built to `lib/` | `tests/integration` | 2 failed / 35 |
| `peer.ts` `buildEpoch` never refreshes the cached `epoch` | `packages/rpc` | 35 failed / 391 |
| `peer.ts` `captureAnchor` reuses the previous anchor | `packages/rpc` | 49 failed / 391 |

Every stale-capture point the entry named or hedged about bites today. Two further facts settled
the rest of it:

- **`epoch` and `exportSecret` following `adopt` were already pinned explicitly**, with a comment
  naming the defect — `packages/mls-rpc/test/crypto.test.ts`, in the export test: "A crypto closing
  over the handle it was built with would still be exporting the line above."
- **Restart-then-author was already covered at the unit layer.**
  `packages/rpc/test/peer-first-commit-crash.test.ts:168` has a restarted peer author a fresh commit
  and advance an epoch; `peer-anchor-restart.test.ts:148` has a restarted peer dispatch on the wire.
  Both against the doubles, which pass the conformance suites.

There was no hiding place for the defect. What survived was smaller and true.

## What shipped

**1. The `wrap` guard, said out loud** (`packages/mls-rpc/test/crypto.test.ts`).

`wrap`'s staleness was guarded only as a *side effect* of two tests named for other properties —
unwrap's epoch refusal, and `frameEpoch` reading cleartext. Nothing stated the property, so an edit
preserving either test's stated intent could have dropped the guard silently. One test now states
it: Alice adds Carol (epoch 2), adopts, and seals; **Carol opens it, Bob — left at epoch 1 — cannot.**

The design decision worth keeping: **Carol, not a Bob who applied the same commit.** `unwrap` opens
a bounded window *below* the live epoch out of ts-mls's retained key material — this port's
documented divergence from the fake. A member who walked from 1 to 2 might therefore still open an
epoch-1 frame and let a stale seal pass. Carol joins *at* epoch 2 and holds nothing below it, so her
refusal of a stale frame is structural rather than a property of how much ts-mls happens to retain.
The fixture gained an `addMember` helper for the third member.

**2. Restart-then-author against real MLS** (`tests/integration/test/app-lane-delivery.test.ts`).

Every restart-then-author test in the repo ran against the doubles. This one walks it through
`createGroupCrypto` and a live `GroupHandle`: the admin dies, restores from persisted state, and the
second process's **first act is a commit** rather than a catch-up. That distinction is the whole
point — a received commit is applied by `processMessage`, which mutates the handle **in place**; an
authored one produces a new handle object the peer swaps in from `onAccepted`, and only that
replaces the reference `createGroupCrypto` reads.

Two decisions inside it:

- **Alice restarts, not Bob.** Only an admin may author a ledger or remove commit, and Bob holds
  `member`. Alice is the founding admin.
- **A ledger commit, not a roster change.** The app-lane anchor rotates only on a roster change, so
  the group stays on one topic across the epoch change and the seal is what is under test, not the
  topic derivation (which `peer-anchor-*` already covers).

The test reads the published frame's epoch off the wire through a fresh observer connection and
asserts it is the post-commit epoch — not merely that a frame arrived.

## What the process caught, worth remembering

- **The mutation attempt recorded, not assumed.** The plan predicted the integration test would bite
  on nothing, and required the outcome be written down either way. It was wrong: the mutation caught
  the new test *as well as* the two pre-existing ones — 3 failures. The recorded conclusion stands
  regardless, and is the honest one: its failure is not evidence of anything it *uniquely* guards,
  and it is kept for the composition coverage.
- **Assertion order decides whether a guard is visible.** The whole-branch review found the
  integration test asserted delivery but never the seal epoch its own name promised. Fixing that
  required placing the epoch check **before** the delivery wait: with the check after it, the
  pre-existing `seen` assertion failed first under the mutation and masked the new one. A guard that
  only fires behind another failing assertion is not a guard.
- The first version of the entry that produced this work was itself the product of an earlier
  discarded test. The rule that came out of that — record why, never discard — is what made this
  branch's disproof legible instead of a second silent dead end.

## Scope

Tests and records only. No source file changed; the mutations were reverted within their tasks and
`packages/mls-rpc/lib/` rebuilt from clean source. No changeset — nothing published changed.

Verified at completion: 42/42 unit and type tasks with `Cached: 0`, integration 36/36, lint clean,
no `packages/*/src/` in the branch diff.
