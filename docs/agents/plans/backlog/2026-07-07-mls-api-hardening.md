# mls API hardening

**Priority:** backlog — typing, error, and persistence-surface cleanup in `@kumiai/mls`.
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

The behavioural mls fixes live in `next/` (permission enforcement, state
serialization/secret hygiene); this doc collects the surface/typing debt.

## Findings

### Medium

- `packages/mls/src/codec.ts:16-18` — `encodeClientState` output is plaintext key material
  (private HPKE/signature keys, secret trees) with no warning, inviting unencrypted
  persistence. Fix: document prominently or provide an encrypted-at-rest variant.
  (security)
- `packages/mls/src/codec.ts:12-14` — `decodeClientState` is typed
  `ClientState | undefined` but ts-mls `decode` also throws (e.g. `CodecError`), so the
  "undefined on failure" contract is false. Fix: try/catch to `undefined` or document the
  throw. (correctness)
- **`packages/mls/src/group.ts:284-287,329-332,569` — `Uint8Array | unknown` params
  collapse to `unknown`,** so `decrypt`/`processMessage`/`processWelcome` accept anything
  at compile time and rely on runtime casts. Fix: type the legacy path as the concrete
  ts-mls message union. (API design)

### Low

- `packages/mls/src/group.ts:586` — `processWelcome` dynamically imports `./capability.js`
  although it is statically imported at `group.ts:46-50`. Fix: use the static import.
- `packages/mls/src/group.ts:124-140,311-315` — a commit policy returning `'reject'` for a
  non-commit kind throws `CommitRejectedError` with empty `proposals`/undefined
  `senderLeafIndex`. Fix: capture info for any rejected kind, or scope the message to
  commits.
- `packages/mls/src/group.ts` — all failures throw bare `Error` except
  `CommitRejectedError`; decode/capability/guard failures indistinguishable. Fix: small
  error hierarchy or codes.
- `packages/mls/src/types.ts:17` — `GroupOptions.ciphersuiteName` is `string`, cast
  `as CiphersuiteName` at `group.ts:64`. Fix: type as `CiphersuiteName`.
- `packages/mls/src/crypto.ts:487` — HPKE object returned via `as Hpke`, suppressing
  structural checks against future ts-mls changes. Fix: `satisfies`/annotation.
- `packages/mls/src/group.ts:63,192` — `resolveMlsContext` vs the package's `MLS` casing;
  the `state` getter exposes the full mutable `ClientState` (private keys) as the only
  persistence hook. Fix: rename; consider explicit `exportState()`.
- `packages/mls/src/crypto.ts:25-33` / `authentication.ts:13-21` — `constantTimeEqual`
  duplicated verbatim. Fix: shared internal module.
- `packages/mls/src/crypto.ts:548` — module-level `createNobleCryptoProvider()` runs
  `createRuntime()` at import time; a platform without usable RNG fails at package import
  (contradicts `"sideEffects": false`). Fix: lazy-init on first `randomBytes`. (security)

## Test hooks

`validateGroupCapability`'s `res: '*'` branch, expired-token path, and `decrypt` fed
wire-form application-message bytes untested — see `next/2026-07-07-test-gaps.md`.
