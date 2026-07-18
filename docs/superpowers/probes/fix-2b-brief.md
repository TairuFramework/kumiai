# Probe brief — a peer that falls behind must not read the group's future as garbage

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted for review.

**Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.** That has
destroyed work on this branch twice. To revert a mutation, invert the edit by hand.

## The defect

`classifyCommit` (`packages/rpc/src/classify.ts:121`) settles `header == null` as **poison** at `:128`,
before any epoch question. `GroupMLSHandle.readCommitHeader`
(`packages/mls/src/group-handle.ts:727`) resolves the committer by decrypting sender-data with
`this.#state.keySchedule.senderDataSecret` — the **current** epoch's — so it returns `null` for a member
commit framed at *any* epoch but the peer's own, in **both** directions.

So `ahead` (`:140`) and `history` (`:147`) are unreachable against the real port. Only the current-epoch
rows work.

**What that costs:** a peer that falls behind — trimmed frames, or one commit it alone could not apply —
reads every later commit as poison, advances its cursor past them, and reports itself **fully
reconciled**. Permanently stuck at a dead epoch, with a clean bill of health. Worse than message loss,
because nothing reports it.

Pre-existing on `main` (`classify.ts` arrived with #5), surfaced here because the memory double stopped
answering where the real port refuses. Four tests are red and they assert the RIGHT behaviour — they were
edited by nothing. Read `docs/agents/plans/next/2026-07-18-ahead-row-unreachable.md` first.

## Approved approach (follow it; BLOCKED if it fights the code — do not redesign)

**Split the two facts the header carries.** They have different trust properties and different
availability, and conflating them is the whole defect:

- **The epoch** is in the message's **cleartext**. Keyless, readable at any epoch, and the hub's word.
- **The committer** requires the epoch's sender-data secret. Authenticated, and only available for a
  commit framed at the peer's current epoch.

Change `readCommitHeader` to return the epoch whenever the frame decodes as a commit, with the committer
absent when it cannot be resolved — `null` reserved for **bytes that are not a commit at all**. Then
`classify` dispatches `ahead`/`history` on the epoch alone, and the current-epoch rows keep using the
authenticated committer exactly as they do now.

**Argue every row in the doc comment, and get these three right — they are the reason this is a brief and
not a patch:**

1. **`own-unmerged` must stay authenticated.** It turns on `committerDID == localDID`, and the existing
   comment already says why: forging your own DID onto a frame would otherwise heal the whole group at
   will. It is only reachable at the current epoch, where the decrypt works. It must never fall back to
   an unauthenticated committer. Say so where it would be tempting.
2. **`ahead` on an unauthenticated epoch is new exposure — you must address it.** Today the row is
   unreachable; making it reachable means the untrusted hub can inject a commit claiming a high epoch and
   drive a healthy peer to conclude it fell out of the group. State what that costs (what does the peer
   then DO — and how expensive is it?), whether anything bounds it, and whether that is acceptable. If it
   is not, say so and stop — a BLOCKED report here is worth more than a fix that trades a silent stall
   for a remote-triggered rejoin loop.
3. **`poison` must keep meaning one thing.** Today it means both "not a commit" and "a commit I refuse".
   After the split, decide which it keeps and make sure the cursor still advances over the other — poison
   is never retried, and a row that stops advancing wedges the lane.

Fix the four red tests **only** where the fix makes them right. If one is red because it asserted the
double's over-answer rather than the port's behaviour, that is a finding: report it, do not quietly
retune it.

## Done when (all required)

1. **A peer that fell behind heals.** It reads a commit framed above its epoch as `ahead`, not poison,
   and does not report itself reconciled while stuck. Must fail against today's code.
2. **A peer re-reading its own past** classifies it as `history`, and the fork check still sees what it
   needs to.
3. **`own-unmerged` still requires an authenticated committer.** A frame claiming this peer's DID that
   does not authenticate does NOT heal it. Must fail if you weaken the row.
4. **The four currently-red tests are green**, on the port's real behaviour and not on a retuned double.
5. **Mutation checks (required, paste each):** make `ahead` fall back to `poison` again → (1) goes red;
   let `own-unmerged` accept an unauthenticated committer → (3) goes red. Invert by hand; confirm green.
6. Whole suite green (rpc, mls 307, 30/30 turbo). **Do not weaken an existing test to make one of these
   pass.**

## Known and accepted — do NOT close, do NOT report

The `processCommit`→anchor-`save` crash window; the laggard publisher; a fresh joiner's empty ts-mls
window; the drain being at-least-once against the live path; `oldest > cursor` over-reporting; `hub-mux`
swallowing subscribe failures (filed); the live lane having no read position (filed).

## Scope boundary

`classify.ts`, `readCommitHeader`, and their callers/doubles ONLY. **Out of scope:** the app-lane drain's
ceiling and stall (just landed, uncommitted above you — leave them alone), the anchor seam, the store
shapes, the fake crypto's strictness. Another probe is auditing the test doubles in parallel; it is
read-only and will not edit under you, but do not go audit doubles yourself beyond the ones this fix
touches.

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`. Code/comments/tests never name plan questions, findings, or phases.

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`
(`pnpm run lint` alone → eslint via the `rtk` shim; use `rtk proxy pnpm run lint`.)

## Report contract

Full report → `docs/superpowers/probes/fix-2b-report.md` (changes with file:line, both mutations pasted,
the per-row trust argument, your answer on the `ahead` exposure, whether any red test was red for the
wrong reason, surprises, concerns). Return ONLY: status, uncommitted-changes note, one-line test summary,
concerns. No full diff.
