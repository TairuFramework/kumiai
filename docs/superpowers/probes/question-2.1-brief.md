# Probe brief: Question 2.1

Repo: kumiai worktree (this directory), branch feat/mls-rpc-host-handle-access.
Read first: AGENTS.md; the plan docs/superpowers/plans/2026-09-25-mls-rpc-host-handle-access.md (Premise check, Phase 2, Question 2.1, Decision Log); the spec docs/superpowers/specs/2026-09-25-mls-rpc-host-handle-access-design.md ("Public API", "Durable save ordering", "Epoch reads", "Other routing"); docs/superpowers/probes/question-1.1-report.md (why this runs first).

## Question
Does one adapter preserve handle lifetime and save ordering?

- Assumption: `simpleHandleAccess` can preserve received-commit rollback, ratchet persistence, and persist-before-publish replacement without saving the same state twice.
- Done when: usage test written before the API. Export `HandleAccess`, `SimpleHandleAccessParams`, and `simpleHandleAccess`; require `access` in both factories. Test shared access, scalar publication after successful save, rollback, `read` callback lifetime, `mutate` save behavior, `replace` ordering, and simple `open` pass-through. Test authored and recovery handle replacement. Keep the ledger slot installed at every handle construction path.

## Spec excerpt (verbatim)
"`read` gives a handle only for the callback's lifetime. `mutate` serialises with every other operation and resolves after persistence. Its `persist` argument is passed to `GroupHandle.processMessage` and `bootstrapLedger`, retaining their rollback-on-save-failure semantics. For ordinary `encrypt` and `decrypt`, the adapter saves the post-operation state. `replace` persists before publishing the new handle. A transactional adapter works on a fresh restored handle; it discards that handle on rollback and publishes only on commit. It may use a no-op `persist` callback within the transaction, then write the final handle and host rows before commit. A simple adapter uses the supplied `persist` hook at the library boundary and must avoid writing the same state twice."
"`epoch` is a host-published scalar hint ... `simpleHandleAccess` seeds the scalar from `handle().epoch` and updates it after successful mutation or replacement, so `epoch()` cannot see a tentative in-place advance. The port requires a single access instance shared by `createGroupMLS({ access, identity, entrySlot })` and `createGroupCrypto({ access, entryLabel?, runtime?, pending? })`."

## Approved approach
1. Usage test first (packages/mls-rpc/test), showing one shared `simpleHandleAccess` passed to both factories. If it reads awkwardly, stop and report.
2. Add `HandleAccess` (exact surface in the spec's Public API block) and `simpleHandleAccess` to @kumiai/mls-rpc. The simple adapter owns ONE access-level mutex that serialises `read`, `mutate`, `replace` and `open` (this is the lock Phase 1 will read epochs under; it is distinct from GroupHandle's internal mutex, so calling handle methods inside it does not double-acquire). `epoch()` is synchronous and returns the published scalar only.
3. Replace `handle` / `adopt` / `persist` in `createGroupMLS` and `createGroupCrypto` params with `access`. Route mutations (processCommit, bootstrapLedger, wrap, unwrap), replacement (authored commit adoption, recovery onAccepted) and durable open through the adapter. Keep persist-before-publish and rollback semantics exactly as today (packages/mls-rpc/test/persist-boundary.test.ts must keep passing unchanged in intent).
4. RE-ENTRY HAZARD: during processCommit the ledger-entry resolver may call back into the crypto port (openEntries / exportSecret) while `mutate` holds the access mutex. Do not deadlock. For this question keep the in-commit key derivation path lock-free exactly as today (do not route it through `access.read`); Question 3.2 fixes it by pre-resolution. Add a test proving a real commit with ledger entries does not deadlock. If you cannot avoid re-entry without a design change, stop and report BLOCKED.
5. Update every caller of the two factories (mls-rpc tests, rpc-conformance wiring, tests/integration, e2e, anything the repo-wide typecheck finds). Do not change @kumiai/rpc port types; no epoch results yet (Question 1.1 resumes after this).
6. Standalone helpers (deriveEntryKey etc.) are Question 2.2: do not add them now.

Stop and report BLOCKED if the approach does not work. Do not try alternatives without asking.

## Verify (run from repo root, paste output tails in the report)
rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2   (check Cached: 0)
pnpm exec vitest run --root tests/integration
rtk proxy pnpm run lint

## Conventions
Follow kigu conventions and AGENTS.md. Comments terse, why-not-what, only for surprises. No plan/question labels in code. Rationale, alternatives and learning go in the report, not code. Doubles may be stricter than a port, never more permissive.

## Report contract
Write the full report to docs/superpowers/probes/question-2.1-report.md: findings, final API, rationale, alternatives considered, surprises, what was learned, verify output tails.
Commit code + brief + report with: git commit --no-gpg-sign -m "feat(mls-rpc)!: factories take a shared HandleAccess" (or "docs: question 2.1 blocked ..." if blocked) and these trailer lines at the end:
Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NwUs2CfsCevyD3sgxARvpX
Final message: status (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT), commit hash, one-line test summary, concerns.
