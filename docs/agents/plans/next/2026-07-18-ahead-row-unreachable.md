# `readCommitHeader` cannot read a commit framed ahead, so the `ahead` row never fires

## The gap

`GroupHandle.readCommitHeader` recovers a member commit's committer by decrypting the commit's
sender-data with **the epoch secret the handle holds right now**
(`packages/mls/src/group-handle.ts:758-767`):

```ts
const pm = readPrivateCommitFrame(decoded)
if (pm == null) return null // non-commit frame
const leafIndex = await readSenderLeafIndex(
  this.#context,
  this.#state.keySchedule.senderDataSecret,
  pm,
)
if (leafIndex == null) return null
```

A commit framed at any epoch other than the handle's own decrypts to nothing, so it returns `null` —
even though the commit's **epoch** is public cleartext and `readMessageEpoch` (called at `:740`, a
few lines above) already read it successfully.

The commit lane classifies on that answer. `classifyCommit` settles `null` as **poison** first, before
any epoch question — `packages/rpc/src/classify.ts`, and the table at the top of that file says so
explicitly: *"Not a commit at all (unreadable header) | advance (poison — never retry, never heal);
settled first, before any epoch question"*.

**So against a real MLS port the `ahead` row is unreachable for member commits.** A peer that falls
behind reads every later commit as poison, steps over it, drains to the end of the log, and reports
itself fully reconciled — stuck at a dead epoch with a clean bill of health, which is precisely the
outcome the `ahead` row was written to prevent. `peer-cursor-table.test.ts:363-366` states the stakes
in its own comment.

Only an **external** commit still classifies correctly ahead of the handle: it is a public message
carrying its committer in its own UpdatePath leaf, needing no secret and no tree.

## How it stayed green

The memory double read a commit at any epoch and said so as if it were the contract
(`packages/rpc/test/fixtures/memory-group-mls.ts:520`):

> `// Reads the commit's own bytes and nothing else: no epoch secret, no blob, no state.`

That is not the port's contract — it is the opposite of what the real handle does. The divergence is
what let the whole `ahead`/heal mechanism look exercised.

The double has now been made faithful (it refuses a non-external commit framed above its own epoch),
which turns the hidden defect into four honest failures:

```
2. a peer the group left behind learns it from a later frame, not from the one it could not apply, and heals
   AssertionError: expected 1 to be 4 // Object.is equality
       at packages/rpc/test/peer-cursor-table.test.ts:366:29
3. a heal trigger under a failed heal a frame framed ahead of it: no responder — commit() refuses, and nothing lands
   Error: promise resolved "{}" instead of rejecting
       at packages/rpc/test/peer-failed-heal-strand.test.ts:143:79
4. a heal trigger under a failed heal a frame framed ahead of it: a responder answers — the peer heals, then commits
   AssertionError: expected 1 to be greater than 1
       at packages/rpc/test/peer-failed-heal-strand.test.ts:166:31
5. a heal re-enacts by ledger membership an entry the group already holds is not re-enacted, and a later admin is not reverted
   AssertionError: expected 2 to be 4 // Object.is equality
       at packages/rpc/test/peer-recover-lane.test.ts:140:31
```

All four are the same mechanism: a peer that should have healed off an ahead frame no longer does.
These tests are asserting the RIGHT behaviour — they are red because the double stopped lying, not
because the intent changed.

## Why it is not a one-line fix

The obvious repair — classify the epoch from the commit's cleartext, as
`justifiedEpochCeiling` now does for the app-lane bound — separates the two facts the classifier
reads from a commit, and only one of them can be had without a key:

- **The epoch** is cleartext and readable at any epoch. Fine.
- **The committer** is what needs the epoch secret, and it is what the `own-unmerged` row turns on.

`own-unmerged` is the row that stops a peer wedging forever on its own un-merged commit, and its doc
in `classify.ts` is emphatic about why the committer must be MLS-authenticated and never the
transport sender:

> Read the committer from the commit itself, where MLS authenticates it — NEVER from the frame's
> transport sender, the untrusted hub's word. A hub that stamped each recipient's own DID onto one
> poison frame would otherwise heal the whole group at will.

So a classifier that reads a cleartext epoch must be clear about which rows are allowed to depend on
an unauthenticated field. `ahead` plausibly can — like the app-lane ceiling, an attacker who lies
about it can only trigger a heal, never suppress one, and the honest commits are in the log too. But
that asymmetry has to be argued per row, not assumed.

## Options to weigh

1. **Split the port method**: keep `readCommitHeader` (authenticated, this-epoch-only) for the rows
   that need a committer, and add a cleartext epoch read for the rows that only need an epoch.
   `GroupCrypto.frameEpoch` already is exactly this and already sits over `readMessageEpoch` — it
   may need nothing new at all beyond being used here.
2. **Widen `readCommitHeader`** to return `{ epoch }` with an absent committer when it cannot
   authenticate one, and make the classifier's rows explicit about which fields they require. Keeps
   one method; makes the partial answer legible in the type.
3. **Leave it and accept that a fallen-behind peer heals only off an external commit.** Cheapest,
   and probably wrong — it means the ordinary case (the group commits past a peer that missed one)
   never heals.

Lean 1: it matches what the app-lane ceiling already had to do for the identical reason, and it keeps
the authenticated read authenticated.

## Also worth checking

The real handle refuses a commit framed **below** its epoch too, for the same sender-data reason. The
double has only been tightened above (per the ruling that scoped this). The `history` row
(`classify.ts`, "Below this peer's epoch, with no recorded applied-commit") therefore rests on the
same read, and every healthy peer walks some — a late joiner reads the commit that added it. Worth
confirming whether `history` and the fork check are equally affected before designing the fix.

## Context

Found by the Fix 2 probe on `feat/app-lane-delivery`. F4 (bound an app frame's ahead-claim by the
commit log) originally used `readCommitHeader` for the bound and would have collapsed to
`crypto.epoch()` in production for exactly the returning member the lane exists for; it now reads the
cleartext epoch via `crypto.frameEpoch`. Making the double faithful is what surfaced the wider
problem. See `docs/superpowers/probes/fix-2-report.md`.
