# Probe brief: Question 1.1

Repo: kumiai worktree (this directory), branch feat/mls-rpc-host-handle-access.
Read first: AGENTS.md; the plan docs/superpowers/plans/2026-09-25-mls-rpc-host-handle-access.md (Premise check, Phase 1, Question 1.1); the spec docs/superpowers/specs/2026-09-25-mls-rpc-host-handle-access-design.md ("Epoch reads" section in full).

## Question
Can the port return the epoch that each operation used?

- Assumption: epoch-bearing results can preserve the port's caller ergonomics while leaving `epoch()` synchronous and hint-only.
- Done when: usage tests written first. Typed epoch results for commit apply, secret export, seal, and app open/refusal; real ports, conformance shapes, and doubles aligned. A double with an epoch hint one behind or one ahead returns the same locked result and disposition. The double refuses everything the real port may refuse.

## Spec excerpt (verbatim)
"Every decision takes its epoch from a port result computed under the handle lock (`access.read` or `access.mutate`). The port result carries the epoch it acted at, and `@kumiai/rpc` decides from that value."
"`unwrap` checks the frame epoch against the locked handle and reports past or future distinctly."
"The contract suites test that a decision never follows a stale or ahead scalar: a double whose `epoch()` lies in either direction must not change any disposition."

## Approved approach
1. Write usage tests first (how @kumiai/rpc code would consume each result). If they read awkwardly, stop and report BLOCKED with the alternative you would propose (e.g. separate `...At` methods); do not switch approach yourself.
2. Retype the @kumiai/rpc ports:
   - `GroupMLS.processCommit` -> `{ advanced, epochBefore, epochAfter }`.
   - `GroupCrypto.exportSecret` -> `{ secret, epoch }`.
   - `GroupCrypto.sealEntries` -> `{ sealed, epoch }`.
   - successful `unwrap` result gains `epoch`; a frame whose epoch differs from the locked handle throws an exported typed `FrameEpochError { frameEpoch, handleEpoch }` (past vs future derivable). Other open failures keep their current errors.
   Use `number` epochs consistent with the existing port.
3. Real `@kumiai/mls-rpc` ports compute these values inside the same handle critical section as the operation (not from a separate read).
4. Align rpc test doubles and `@kumiai/rpc-conformance` shapes. Doubles must be at least as strict as the port (never more permissive). Add a conformance clause: with a double/adapter whose `epoch()` hint lags by one or runs ahead by one, results and dispositions are unchanged.
5. Update @kumiai/rpc peer/app-lane callers MECHANICALLY only (e.g. `.secret`, `.sealed`, `.advanced`). Do not move any decision off `crypto.epoch()` yet; that is Questions 1.2 and 1.3.
6. Update the consumers in tests/integration and any other package that fails the repo-wide typecheck.

Stop and report BLOCKED if the approach does not work. Do not try alternatives without asking.

## Verify (run from repo root, paste output tails in the report)
rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2   (check Cached: 0)
pnpm exec vitest run --root tests/integration
rtk proxy pnpm run lint

## Conventions
Follow kigu conventions and AGENTS.md. Comments terse, why-not-what, only for surprises. No plan/question labels in code. Rationale, alternatives and learning go in the report, not code.

## Report contract
Write the full report to docs/superpowers/probes/question-1.1-report.md: findings, the final type shapes, rationale, alternatives considered, surprises, what was learned, verify output tails.
Commit code + brief + report with: git commit --no-gpg-sign -m "feat(rpc)!: port results carry the epoch they acted at" and these trailer lines at the end:
Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NwUs2CfsCevyD3sgxARvpX
Final message: status (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT), commit hash, one-line test summary, concerns.
