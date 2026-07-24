# MLS last-resort key packages (never strand a victim's group joins)

**Priority:** medium — completes the key-package DoS story. The drain is already *rate-bounded*
(per-target consumption quota + authorize dispatch, shipped 2026-07-25, see
`docs/agents/plans/completed/2026-07-25-hub-keypackage-subscribe-caps.complete.md`); this closes
the residual: a determined authorized attacker within quota can still eventually empty a
victim's pool, after which the victim cannot be added to any group until they re-upload.

## The gap

Key packages are stored as opaque `string` blobs and consumed destructively (`splice`). MLS
defines a *last-resort* key package (RFC 9420 `last_resort` extension) that is reusable by
design — the hub may serve it repeatedly without consuming it, so a member can always be added
to a group even when their ordinary single-use packages are exhausted. The stack does not
generate or handle these today:

- `@kumiai/mls` `createKeyPackageBundle` generates only plain single-use packages
  (`generateKeyPackageWithKey` from `ts-mls`). `ts-mls` has no built-in last-resort support — no
  `lastResort` param, no `last_resort` extension — so it must be added manually as a
  `CustomExtension` / `LeafNodeExtension`.
- The hub sees only the encoded blob; it cannot tell a last-resort package from an ordinary one
  without either decoding MLS or a client-supplied flag at upload.

## Sketch

- **`@kumiai/mls`:** generate a key package carrying the `last_resort` extension (a
  reusable-by-design package) and expose it distinctly from ordinary bundles.
- **`@kumiai/hub-protocol`:** add an optional `lastResort` flag to the `keypackage/upload`
  param; extend `HubStore` so a last-resort package is stored in a separate non-consumed slot.
- **`@kumiai/hub-server` store:** on `fetchKeyPackages`, consume ordinary packages first; when
  the ordinary pool is empty, serve the last-resort package **non-destructively** (never splice
  it). Reject reuse of an *ordinary* package as last-resort — that would be init-key reuse, a
  crypto defect.
- **Conformance + doubles:** `hub-conformance` asserts the non-destructive last-resort serve and
  that an ordinary package is never reused. Changing the `HubStore` port means running BOTH
  contract suites against the real implementation and the doubles.

## Why it was deferred

Cross-repo (`mls`, `hub-protocol`, `hub-server`, `hub-conformance`) and cryptographically
load-bearing — reusing an ordinary single-use package is init-key reuse. The rate-bounding
defence that shipped removes the amplification without it, so the eventual-drain residual was
judged medium, not high. The hub-side plumbing (upload flag + separate slot + non-destructive
serve) can land ahead of, or alongside, the `mls` generation work, but is only
cryptographically safe once `mls` actually produces a reusable last-resort package.

## Scope

`@kumiai/mls`, `@kumiai/hub-protocol`, `@kumiai/hub-server` (`memoryStore.ts`),
`@kumiai/hub-conformance`.
