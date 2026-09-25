# Probe brief: Question 2.2

Repo: kumiai worktree (this directory), branch feat/mls-rpc-host-handle-access.
Read first: AGENTS.md; the plan docs/superpowers/plans/2026-09-25-mls-rpc-host-handle-access.md (Question 2.2 and the whole Decision Log); the spec docs/superpowers/specs/2026-09-25-mls-rpc-host-handle-access-design.md ("Standalone exports and recovery choice", "Other routing"); docs/superpowers/probes/question-2.1-report.md (current access design).

## Question
Can reusable byte and recovery helpers replace factory copies?

- Assumption: standalone helpers can preserve the existing wire format and lifetime rules without retaining a handle.
- Done when: test and export `deriveEntryKey`, `sealEntries`, `openEntries`, `createRecoveryPending`, and `deriveRecoverySecret`. Verify v1/24-byte XChaCha sealing, error text, key wiping, 120,000 ms TTL, replacement/deletion zeroing, and timer unref. Route all spec-listed MLS reads through `access.read`, bootstrap through `mutate`, recovery adoption through `replace`, and ratchet operations through `mutate`/`open`. Keep `frameEpoch` and `frameAAD` byte-only.

## Spec excerpt (verbatim)
"Export these from `@kumiai/mls-rpc` and use them in its factories; none should read or retain a global handle:

export function deriveEntryKey(handle: GroupHandle, label?: string): Promise<Uint8Array>
export function sealEntries(key: Uint8Array, entries: Uint8Array, runtime?: Runtime): Uint8Array
export function openEntries(key: Uint8Array, sealed: Uint8Array): Uint8Array
export type RecoveryPending = { get(requestID: string): Uint8Array | null; put(requestID: string, ephemeralPrivateKey: Uint8Array): void; delete(requestID: string): void }
export function createRecoveryPending(options?: { ttlMS?: number }): RecoveryPending
export function deriveRecoverySecret(handle: GroupHandle): Promise<Uint8Array>

`deriveEntryKey` calls `handle.exportSecret(label ?? ENTRY_SEAL_LABEL, new Uint8Array(), 32)`. `sealEntries` and `openEntries` retain version 1, 24-byte nonce, XChaCha20-Poly1305, and the existing errors. The factory wipes derived keys in `finally`; a standalone caller owns wiping its key. `createRecoveryPending` is stateful, despite being a standalone export: it sweeps expired requests, zeroes replaced/deleted private keys, arms an unref timer, and defaults to 120,000 ms. `createGroupMLS` uses it."
Other routing: "`rosterEntries`, `readCommitHeader`, `createRecoveryRequest`, `sealGroupInfo`, `applyRecovery`'s open and rejoin preparation, `isLedgerComplete`, `getLedger`, `sealLedger`, `openSealedLedger`, and `exportRecoverySecret` use `access.read`. ... `bootstrapLedger` uses `access.mutate` ... `exportSecret`, `sealEntries`, and `openEntries` derive a key through `access.read` and do the byte operation after releasing the handle. `frameEpoch` and `frameAAD` use the total `@kumiai/mls` byte readers."

## Approved approach
1. Tests first: byte-exact compatibility (a blob sealed by the old factory code opens with the new `openEntries` and vice versa; pin with a fixed key/nonce vector if the runtime allows), error text, wiping, TTL sweep, zeroing on replace/delete, `unref` on the timer.
2. Extract the existing factory code into the exports; do not change the wire format or error messages. The factories use the exports.
3. Check every factory method against the routing list above; fix any that still bypass `access` or that do a byte operation while holding the access lock. Report the ones you changed.
4. `recoverySecret` override is Question 5.1: do not add it. Epoch-bearing results are Question 1.1: do not add them.

Stop and report BLOCKED if the approach does not work. Do not try alternatives without asking.

## Verify (run from repo root, paste output tails in the report)
rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2   (check Cached: 0)
pnpm exec vitest run --root tests/integration   (rebuild lib/ first if needed; do not commit lib/)
rtk proxy pnpm run lint

## Conventions
Follow kigu conventions and AGENTS.md. Comments terse, why-not-what, only for surprises. No plan/question labels in code. Rationale and learning go in the report.

## Report contract
Write the full report to docs/superpowers/probes/question-2.2-report.md: findings, final exports, routing changes, rationale, alternatives, surprises, what was learned, verify output tails.
Commit code + brief + report with: git commit --no-gpg-sign -m "feat(mls-rpc): export entry-seal and recovery helpers" and these trailer lines at the end:
Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NwUs2CfsCevyD3sgxARvpX
Final message: status (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT), commit hash, one-line test summary, concerns.
