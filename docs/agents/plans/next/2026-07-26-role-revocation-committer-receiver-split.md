# Role revocation would split the committer's Add verdict from the receiver's

**Priority:** none today — a latent hazard, not a defect. Nothing in the codebase can trigger it.
**Origin:** final whole-branch review of `fix/add-proposal-roster-binding`, 2026-07-26.
**Read this before designing role revocation.** That is the only thing that makes it live.

## The asymmetry

The receive-side Add rule (`packages/mls/src/policy.ts`, the `add` arm of `evaluateProposal`) asks
whether the added leaf's credential DID holds a role in `context.candidateRoster`. Two callers build
that context, and they build it at different moments:

- **The committer**, filtering its pending-proposal set before authoring
  (`packages/mls/src/group-commit.ts`, `commitWithEntries`), judges a pending Add against the
  **post-fold** roster — the roster after the commit's own entries apply.
- **A receiver**, judging a standalone proposal on receipt (`packages/mls/src/group-handle.ts`),
  judges the same proposal against its **current** roster, because a standalone proposal enacts no
  entries and its candidate roster collapses to the base one.

They can only disagree about a DID whose grant status changed between the two moments.

## Why it cannot bite today

`roleReducer.apply` (`packages/mls/src/roster.ts:50-53`) only ever `set`s. There is no revocation and
no removal — a DID that has ever been granted a role keeps it forever. So the grant status can only
move from ungranted to granted, never back:

- Ungranted at receipt: the receiver rejects the proposal and never stores it, so there is nothing
  for a later commit to reference.
- Granted at receipt: still granted at commit time, so both sides accept.

Anything a receiver actually holds passed the base-roster check and stays granted. The two verdicts
cannot diverge.

## What revocation would do to it

Add revocation and the ungranted-again direction opens. A receiver stores a pending Add for a DID
that is granted at receipt; the grant is revoked; a committer then authors a commit whose post-fold
roster no longer grants that DID, so the committer's filter **drops** the Add. But the commit still
references it by reference, and receivers that stored it expect it to be there.

The failure is a liveness one, not a security one — a commit that peers cannot resolve, which is the
same shape as the griefing bug the pending filter was introduced to fix (see
`packages/mls/test/group.test.ts`, `the committer filters the pending set before authoring a commit`).
That earlier fix made committer and receiver agree; revocation would reintroduce the disagreement
through a different door.

## What to decide, when the time comes

Whether a receiver should re-judge its stored pending proposals when the roster changes, or whether
the committer should keep a dropped-but-referenced proposal rather than filtering it. Either closes
the split; they have different costs and neither is obviously right from here.

## Scope

No code change today. This file exists so the question is asked at the right moment rather than
rediscovered as a bug report.
