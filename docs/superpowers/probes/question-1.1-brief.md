# Probe brief: Question 1.1 (second run)

The first run was BLOCKED: the factories had no lock under which to read the epoch an operation used (see question-1.1-report.md and the plan Decision Log). Questions 2.1 and 2.2 have since landed: both factories take a shared `HandleAccess` whose single queue serialises `read` / `mutate` / `replace` / `open`. Read epochs inside those callbacks.

Repo: kumiai worktree (this directory), branch feat/mls-rpc-host-handle-access.
Read first: AGENTS.md; the plan docs/superpowers/plans/2026-09-25-mls-rpc-host-handle-access.md (Phase 1 and the whole Decision Log); the spec docs/superpowers/specs/2026-09-25-mls-rpc-host-handle-access-design.md ("Epoch reads" in full); docs/superpowers/probes/question-1.1-report.md, question-2.1-report.md, question-2.2-report.md.

## Question
Can the port return the epoch that each operation used?

- Assumption: epoch-bearing results can preserve the port's caller ergonomics while leaving `epoch()` synchronous and hint-only.
- Done when: usage tests written first. Typed epoch results for commit apply, secret export, seal, and app open/refusal; real ports, conformance shapes, and doubles aligned. A double with an epoch hint one behind or one ahead returns the same locked result and disposition. The double refuses everything the real port may refuse.

## Spec excerpt (verbatim)
"Every decision takes its epoch from a port result computed under the handle lock (`access.read` or `access.mutate`). The port result carries the epoch it acted at, and `@kumiai/rpc` decides from that value."
"`unwrap` checks the frame epoch against the locked handle and reports past or future distinctly."
"The contract suites test that a decision never follows a stale or ahead scalar: a double whose `epoch()` lies in either direction must not change any disposition."

## Approved approach
1. Usage tests first. The first run already showed these shapes read well; reuse them.
2. Retype the @kumiai/rpc ports (number epochs):
   - `GroupMLS.processCommit` -> `{ advanced, epochBefore, epochAfter }`. Both values are read from the handle inside the same `access` critical section as the apply (for refusals, inside the `access.read` pre-check). `epochBefore === epochAfter` whenever `advanced` is false.
   - `GroupCrypto.exportSecret` -> `{ secret, epoch }`, both from one `access.read`.
   - `GroupCrypto.sealEntries` -> `{ sealed, epoch }`, the epoch of the handle the key was derived from (same `access.read`).
   - successful `unwrap` result gains `epoch`. A frame whose epoch differs from the locked handle epoch throws an exported typed `FrameEpochError { frameEpoch, handleEpoch }` BEFORE any decrypt, under the same `mutate`/`open` critical section. This is stricter than today's real handle, which opens a bounded past window: the port contract already says past-epoch opens must not be relied on. Other open failures keep their current errors.
3. Align @kumiai/rpc test doubles and @kumiai/rpc-conformance. Doubles at least as strict as the port. New conformance clause in both suites: with the `epoch()` hint forced one behind and one ahead of the real state, every result above (values and dispositions, including `FrameEpochError` fields) is unchanged. Run it against the real mls-rpc (a `HandleAccess` wrapper that lies in `epoch()`) and against the doubles.
4. Update @kumiai/rpc peer/app-lane callers MECHANICALLY only (`.secret`, `.sealed`, `.advanced`; treat `FrameEpochError` like today's unwrap throw). Do not move any decision off `crypto.epoch()` yet; that is Questions 1.2 and 1.3. Do not change dispositions.
5. Update every other consumer the repo-wide typecheck finds (tests/integration, e2e).
6. Mind the breaking change: add nothing to changesets yet (Question 6.2 owns the text), but list every public signature you changed in the report.

Stop and report BLOCKED if the approach does not work. Do not try alternatives without asking.

## Verify (run from repo root, paste output tails in the report)
rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2   (check Cached: 0)
pnpm exec vitest run --root tests/integration   (rebuild lib/ first if needed; do not commit lib/)
rtk proxy pnpm run lint

## Conventions
Follow kigu conventions and AGENTS.md. Comments terse, why-not-what, only for surprises. No plan/question labels in code. Rationale and learning go in the report.

## Report contract
Overwrite docs/superpowers/probes/question-1.1-report.md (keep a one-paragraph summary of the first run at the top): findings, final types, changed public signatures, rationale, alternatives, surprises, what was learned, verify output tails.
Commit code + brief + report with: git commit --no-gpg-sign -m "feat(rpc)!: port results carry the epoch they acted at" and exactly these trailer lines at the end:
Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NwUs2CfsCevyD3sgxARvpX
Final message: status (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT), commit hash, one-line test summary, concerns.
