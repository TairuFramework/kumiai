# Probe brief: Question 1.2

Repo: kumiai worktree (this directory), branch feat/mls-rpc-host-handle-access.
Read first: AGENTS.md; the plan docs/superpowers/plans/2026-09-25-mls-rpc-host-handle-access.md (Phase 1, Question 1.2, the whole Decision Log); the spec docs/superpowers/specs/2026-09-25-mls-rpc-host-handle-access-design.md ("Epoch reads" in full); docs/superpowers/probes/question-1.1-report.md.

## Question
Can commit classification and repair ignore a lying hint?

- Assumption: a commit applied after classification can reclassify from the locked `epochBefore`, then advance the cursor only for the actual disposition.
- Done when: test lagging and ahead hints for applicable, past, future, own, fork, and unknown-version frames. Move the commit-path reads (at the time of the plan: `peer.ts:1348,1363,1376,1448,1487,1532,1604,1681,1689,2382,2395`; line numbers have moved, find them by role) to locked results; check the cursor, anchor barrier, and repair outcome. A mismatch returned by apply triggers reclassification without skipping an applicable commit.

## Spec excerpt (verbatim)
"commit classification and the cursor advance: `applyCommit` compares the frame epoch under the lock and returns `epochBefore` and `epochAfter`; a mismatch returns a disposition, not an advance, so the peer reclassifies instead of moving its cursor past an applicable commit;
advance baselines and repair: use `epochBefore` / `epochAfter` from the port result, not two scalar reads;"
"The unknown-version classifier inputs (`peer.ts:1448,1487`) feed `classifyCommit` and can move the cursor, so they take the locked epoch too."

## Approved approach
1. Tests first, in packages/rpc/test, using the existing doubles with `epoch()` forced one behind and one ahead (and 0): for each frame kind (applicable, history/past, ahead/future, own, fork, unknown frame version, unsupported commit-frame version) assert the same cursor position, strand/recovery observation, anchor barrier, runtime rebuild and repair outcome as with an honest hint. Include the case the probe flagged: an ahead hint must not skip an applicable commit as history.
2. In the commit walk, every decision that moves the cursor, records fork evidence, latches an anchor failure, captures a changed-roster anchor, rebuilds the runtime or retains repair state must use an epoch from a port result computed under the lock:
   - Prefer piggybacking on results that already exist (`processCommit`'s `epochBefore` / `epochAfter`; a wrong-epoch or non-Commit frame is refused under `access.read` and returns its locked epoch cheaply without opening a blob).
   - Where a decision needs a locked epoch and no operation runs (e.g. classifying a frame as history before any apply), you MAY call `processCommit` for its refusal result, or add one locked read to the `GroupMLS` port (e.g. `epoch(): Promise<number>` via `access.read`) if that is simpler. Pick one, keep it minimal, justify it in the report; if you add a port method, implement it in mls-rpc, both doubles and the conformance suite (with the lying-hint clause).
   - The hint may still be used for cheap pre-filtering only when a wrong hint cannot change the outcome (e.g. it only chooses whether to ask the locked source).
3. Keep dispositions identical to today for an honest hint. Do not touch app-lane, anchor-capture-on-export, sealing, replay or journal decisions (Question 1.3), except where a shared helper forces it; say so.
4. Constructor seeds and error-message interpolation may keep reading the hint.

Stop and report BLOCKED if the approach does not work or grows beyond the commit path. Do not try alternatives without asking.

## Verify (run from repo root, paste output tails in the report)
rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2   (check Cached: 0)
pnpm exec vitest run --root tests/integration   (rebuild lib/ first if needed; do not commit lib/)
rtk proxy pnpm run lint
Mutation check: temporarily make one moved decision read `crypto.epoch()` again, confirm a new test fails, restore. Paste the failing line.

## Conventions
Follow kigu conventions and AGENTS.md. Comments terse, why-not-what, only for surprises. No plan/question labels in code. Rationale and learning go in the report. Doubles may be stricter than a port, never more permissive.

## Report contract
Write docs/superpowers/probes/question-1.2-report.md: findings, a table of every moved read (role, old source, new source), any port change, rationale, alternatives, surprises, what was learned, mutation result, verify output tails.
Commit code + brief + report with: git commit --no-gpg-sign -m "fix(rpc): commit decisions use the locked epoch" and exactly these trailer lines at the end:
Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NwUs2CfsCevyD3sgxARvpX
Final message: status (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT), commit hash, one-line test summary, concerns.
