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

## Added 2026-07-23 — deferred forward-compatibility API findings

Folded in from `next/2026-07-20-deferred-api-findings.md` at the 2026-07-23 triage. Origin: the four
API-surface audits of 2026-07-20 that preceded
`../completed/2026-07-21-forward-compatibility.complete.md`, which took only the items where
deferring makes the later fix *impossible* and left these. Line numbers are as of `5eb220a`.

Every item marked **breaking** costs a `minor` bump while `@kumiai/mls` is 0.x and a `major` after
1.0 — see `../milestones/pre-1.0-breaking-api.md` for the deadline that implies. None is a
correctness bug; each is a shape a filed consumer would force a break to fix, and none has one yet.

- **A third `GroupPermission`** (breaking). `packages/mls/src/roster.ts` — the role model is exactly
  `'admin' | 'member'`. Widening a value consumers exhaustively `switch` over is the same break class
  `AuthorizeRequest` was built to avoid taking twice. No filed use needs a third role.
- **The dead `GroupSyncScope` export** (breaking). `packages/mls/src/types.ts:62`, re-exported from
  `index.ts:152`, referenced nowhere else in the repo — verified 2026-07-23. Removing an exported
  type is the same break class as everything else here and costs nothing to leave until something
  needs the removal.
- **AAD on `GroupHandle.encrypt`/`decrypt`** (breaking). `packages/mls/src/group-handle.ts:617,654`
  take no AAD parameter, so `@kumiai/rpc`'s B2 item — binding rpc's sealed bytes to a topic/segment
  context, the same silent-failure shape as `exportSecret`'s label — cannot be built above them.
  Only the required-`senderDID` half of that item shipped. The rpc-side blocker is tracked
  separately in `rpc-api-surface.md`; this is the change that must come first.
- **The `0xf102` hatch opens narrower than it reads** (non-breaking — documentation). `@kumiai/mls`
  reserves and advertises the third control extension type, so a future control extension can be
  *installed* into a live group without re-admitting members — but only empty.
  `packages/mls/src/policy.ts:99-118` permits the added entry solely when it is not already
  installed, the list grew by exactly one, and its data is a zero-length `Uint8Array`; the entry is
  then stripped before the compare. Every later change to the GroupContext extension list goes
  through the same
  positional compare (`evaluateGroupContextExtensions`), requiring byte-identical data at every
  position bar the ledger head. So *populating* `0xf102` — the step that makes it useful — remains a
  policy change every peer must ship before any peer can commit it. The reservation buys the
  extension *type* surviving into existing groups' extension lists and every member's capabilities;
  it does not buy a data channel openable later without a flag day. Worth stating plainly at the
  reservation, because the changeset's "escape hatches with a closing window" framing invites the
  stronger read.

`GroupAnchor.version` enforcement also came from this batch but is **not** filed here — it was
ship-before-needed rather than deferrable debt, and **shipped 2026-07-24**, see
[completed](../completed/2026-07-24-group-anchor-version-enforcement.complete.md).

## Added 2026-07-11 — GroupContext extension-data compare is fail-closed on default-typed extensions

`policy.ts`'s `group_context_extensions` rule byte-compares each extension's `extensionData`, which
requires both sides to be `Uint8Array`. ts-mls decodes *default-typed* extensions (`external_senders`,
`required_capabilities`) into objects, and does not re-export its own `extensionsEqual`. So a group
that ever anchors such an extension would have every honest ledger-head move rejected — fail-closed
liveness, not a security gap, and unreachable today because nothing in this repo adds one. Fix when
one is wanted: compare via a structural equality that handles the union (or ask ts-mls to export
`extensionsEqual`). Documented at the guard in `policy.ts`.
