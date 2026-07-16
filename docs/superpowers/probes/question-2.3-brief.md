# Probe brief — an external-commit rejoin must rotate the anchor

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted for review.

## Context: what is already committed and true

- The app-lane topics derive from peer **anchor state** `{secret, epoch}`, which rotates when an applied
  commit changes the roster — `detectRosterChange(before, after)` (DID-set **inequality**,
  `packages/rpc/src/roster.ts`), evaluated at the apply site in `pullCommits` (~`peer.ts:848`) using the
  `rosterDIDs()` port accessor. Members agree because they all run the same diff over the same commit.
- **The known hole this question closes:** an **external-commit rejoin** by a member the roster still
  holds changes **no DID**, so the diff cannot see it and nobody rotates. The rejoining member's fresh
  handle anchors where it booted; the group stays put. `packages/rpc/test/peer-recovery.test.ts`
  currently **pins that divergence** (eve at 1, carol and dave at 3) — it is a recorded hole, not a
  passing feature. Your job is to close it and invert that test.

## Established facts (investigated — do not re-derive, do not contradict without evidence)

- A resync rejoin is invisible to **every** diff. ts-mls blanks the member's old leaf, then places the
  new leaf at the **leftmost blank** — the leaf it just blanked. Occupied leaf indices are unchanged
  (RFC 9420 §12.4.3.2). So a leaf-index diff is NOT an alternative. DID set: also unchanged (same
  member).
- kumiai's `joinGroupExternal` wrapper types `resync` as the literal `true`
  (`packages/mls/src/group-welcome.ts:176`), so **every** kumiai external rejoin is that index-reusing
  path. It is the only case, not an edge case.
- The exact signal already exists: **`GroupHandle.readExternalCommit`**
  (`packages/mls/src/group-handle.ts:178-198`) — pre-apply, structural: `wireformat ===
  mls_public_message` + `senderType === new_member_commit` + `contentType === commit`, and it pulls the
  joiner's DID from the commit's own UpdatePath leaf credential (the committer has no pre-commit leaf).

## The exact question

Does surfacing an **external-commit** signal on the commit header, and rotating the anchor on
`rosterChanged || external`, make a rejoining member and the group agree on one app topic?

## Relevant spec section (verbatim)

> A rejoin does NOT self-synchronize — it needs an explicit signal. An external-commit rejoin by a
> member the roster still holds changes no DID, so the roster diff cannot see it. Worse, it changes no
> occupied leaf index either: ts-mls's resync blanks the member's old leaf and then places the new one at
> the leftmost blank — the leaf it just blanked. Left undetected, the rejoiner anchors where its fresh
> handle booted while the group stays put — measured as a three-way divergence (eve at 1, carol and dave
> at 3).
>
> So a rejoin rotates the anchor on an explicit external-commit signal, not a roster diff: the applied
> commit's header reports whether it was an external commit, and the lane rotates on
> `rosterChanged || external`. The rejoining member sets its own anchor at the rejoined epoch, and every
> member applying that external commit rotates to the same post-commit epoch. This keeps the model's
> invariant intact — the anchor is ≥ every current member's effective join, and a rejoiner's effective
> join is its rejoin epoch.
>
> The anchor is the post-commit epoch, not the epoch the commit is framed at: the handle advances, then
> the anchor is captured.

## Approved approach (follow it; BLOCKED if it fights the code — do not redesign)

1. **`CommitHeader` gains an optional `external`** — `packages/rpc/src/crypto.ts:25`. Document it like
   its neighbours: whether this Commit is an external commit (a rejoin), structurally readable from the
   commit's own bytes without advancing state. `readCommitHeader` (`crypto.ts:96`) returns it. This is
   **additive** and costs nothing at the call site: the lane already calls `readCommitHeader` on every
   frame via `classifyCommit` (~`peer.ts:704`).
2. **Implement it in the memory fake** — `packages/rpc/test/fixtures/memory-group-mls.ts`. The fake's
   commit encoding will need an additive `external` marker (`encodeMemoryCommit`/`decodeMemoryCommit`);
   `packages/rpc/test/fixtures/commits.ts` already threads an `external` option through `publishCommit`
   — check what it currently does with it and make the header report it.
3. **Rotate on `rosterChanged || external`** at the apply site (~`peer.ts:848`). Keep
   `detectRosterChange` exactly as is — it is correct for add/remove/add+remove and is NOT the thing
   being fixed.
4. **The rejoining peer sets its own anchor at the rejoined epoch.** It never `processCommit`s its own
   external commit (a member cannot apply its own commit; the rejoined handle is adopted in
   `PendingRecovery.onAccepted` — see `recover()` in `peer.ts`). Find where the rejoined handle is
   adopted and capture `{secret: await crypto.exportSecret(), epoch: crypto.epoch()}` there, so the
   rejoiner lands on the same post-commit epoch as everyone applying its commit.
5. **Doc-only fix in `@kumiai/mls`** — `GroupHandle.listMembers()`'s comment
   (`packages/mls/src/group-handle.ts:526-528`) advertises the before/after diff as the way to detect a
   membership change. That is unsound for a resync rejoin (same DID, same leaf index). Correct the
   comment to say what the diff can and cannot see, and point at `readExternalCommit` for rejoins. **No
   behaviour change in `@kumiai/mls`.**

## Done when (all required)

1. **Convergence** — a test rejoins a member by external commit against a group whose anchor is **older
   than the rejoin epoch** (drift the group with non-roster-changing commits first, so the anchor and
   the live epoch differ — otherwise the test proves nothing), and asserts:
   - every member applying the external commit rotates to the rejoin's **post-commit** epoch;
   - the rejoining member anchors at that same epoch;
   - they derive one topic ID and **exchange logged (`retain:'log'`) events both ways** on it.
2. **`peer-recovery.test.ts` is inverted** — its pinned three-way divergence (eve at 1, carol and dave
   at 3) becomes convergence. Do not weaken it; if its real subject is something else, preserve that
   subject.
3. **Mutation check (required)** — drop the `|| external` term, confirm the convergence test goes red,
   paste the failure, revert the mutation, confirm the suite is green again and no residue remains.
4. Existing tests green: `peer-app-topic.test.ts`, `peer-roster-change-detect.test.ts`,
   `peer-app-retention.test.ts`, `peer-control-lanes.test.ts`, `peer-commit-lane.test.ts`.

## Scope boundary

The external-commit signal + rejoin anchor agreement ONLY. **No anchor persistence** (that is the next
question — a restart still re-seeds and still partitions; that is expected here). No returning-member
drain. No `@kumiai/mls` behaviour change (doc only).

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`. Code/comments/tests never name plan questions or phases — state the
invariant ("a rejoin rotates the anchor; the anchor is >= every member's effective join").

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`
(`pnpm run lint` alone → eslint via the `rtk` shim; use `rtk proxy pnpm run lint`.)

## Report contract

Full report → `docs/superpowers/probes/question-2.3-report.md` (changes with file:line, the convergence
test, the mutation result pasted, whether the rejoiner's own anchor capture site was where you expected,
surprises, concerns). Return ONLY: status, uncommitted-changes note, one-line test summary, concerns. No
full diff.
