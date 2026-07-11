# mls API hardening

**Priority:** backlog — typing, error, and persistence-surface cleanup in `@kumiai/mls`.
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

The behavioural mls fixes have since landed (see
`../completed/2026-07-11-mls-permission-enforcement.complete.md` and
`../completed/2026-07-11-mls-state-serialization-secret-hygiene.complete.md`); this doc collects the
surface/typing debt that remains. Line numbers reference the tree at `bb343d9` and have drifted.

**Stale items removed below (2026-07-11):** `decrypt` no longer exists (`processMessage` is the sole
receive path) and the capability chain — with `validateGroupCapability` — was deleted outright, so
findings naming either are void rather than outstanding.

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
- **`Uint8Array | unknown` params collapse to `unknown`,** so `processMessage`/`processWelcome`
  accept anything at compile time and rely on runtime casts. Fix: type the legacy path as the
  concrete ts-mls message union. (API design) — still outstanding; `decrypt` is gone, so this now
  applies to `processMessage`/`processWelcome` only.

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

Void: `validateGroupCapability` and `decrypt` no longer exist. `processMessage` fed wire-form
application-message bytes is now covered. See `next/2026-07-07-test-gaps.md` for what remains.

## Added 2026-07-11 — GroupContext extension-data compare is fail-closed on default-typed extensions

`policy.ts`'s `group_context_extensions` rule byte-compares each extension's `extensionData`, which
requires both sides to be `Uint8Array`. ts-mls decodes *default-typed* extensions (`external_senders`,
`required_capabilities`) into objects, and does not re-export its own `extensionsEqual`. So a group
that ever anchors such an extension would have every honest ledger-head move rejected — fail-closed
liveness, not a security gap, and unreachable today because nothing in this repo adds one. Fix when
one is wanted: compare via a structural equality that handles the union (or ask ts-mls to export
`extensionsEqual`). Documented at the guard in `policy.ts`.
