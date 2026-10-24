# Management tier residuals

**Priority:** backlog. Reviews of the band 0.12 management tier found these minors and deferred them.
**Context:** `../completed/2026-10-24-management-tier.complete.md`.

- **No saturation refusal on `log` and `seed`** (`packages/mls/src/lifecycle-proof.ts`). `revoke` and
  `reset` refuse a saturated ingest; `log` and `seed` do not. This is unreachable within
  `HISTORY_HORIZON` and fails closed anyway, because member roots read `unavailable`. Defence in depth
  only.
- **No receive-side bound on a membership binding's `iat`.** Only authoring checks `iat <= now`. A
  far-future `iat` only blocks the same key's later replacement (`renewal-order`), so the cost falls
  on the device that set it.
- **Quadratic proof-reference upgrades** (`packages/mls/src/registry.ts`). Each proof entry re-derives
  `revokeIndices` for every revoked device of the controller. This is performance only, but it is
  quadratic over the ledger.
- **Replay fold cache equality** (`packages/mls/src/controller-ingest.ts`). A test checks the carried
  fold against a full refold, but it compares only `head`, and saturated epochs are untested. Each
  entry still pays an O(n) digest and clone.
- **Untested clock bound** (`packages/mls/src/lifecycle-proof.ts`). The non-attest clock bound takes
  the max over the pre-envelope and envelope-threaded registries. No test pins this.
- **Revoke refusal after a concurrent advance is untested** (`packages/mls-rpc/src/revoke.ts`). If the
  live handle gains known effects between building a revoke and `onAccepted`, `guardedReplace` throws
  after hub acceptance. That is correct, but no test covers it.
- **Drop proof-ref upgrade ignores the DID** (`memberDropIndices`, `packages/mls/src/registry.ts`).
  It is the same shape as the tombstone upgrade that 0.12.1 fixed. It matters only if root
  deliberately reuses one `add` under another DID across snapshots, which kokuin does not forbid.
- **Attest replay in `registryApply` is narrower than admission.** It checks effectiveness, but not
  the lease, saturation or floor conditions of `effectiveAttestingMembers`. Live admission applies
  the full helper, so this is defence in depth only.
- **The substitute deny set drops key-target entries** (`denySetOf`, `embedded-resolver.ts`,
  `authentication.ts`). kumiai returns only device DIDs from `resolveDenySet`, so kokuin's
  `namesADeniedKey` never sees `#key` denials. kokuin's own key resolution already refuses denied and
  retired keys, but no test proves the gap is harmless.
