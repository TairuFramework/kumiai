# Ledger replay cost on every restore (ask from Sakui, 2026-10-27)

## Context

Sakui's paired phone runs kubun (and `@kumiai/mls` 0.12.1) on the React Native JS thread, which also runs
the UI. A Hermes CPU profile of a fresh pair + Space sync (Debug build, 115 s) attributes ~42 s to
`GroupHandle.applyLedgerEntries` and every block over 700 ms (1-4 s each, ~0.3-1 s in Release; one 1.73 s
block in a Release run) to it. Each phone group holds ~50 ledger entries (~1.2 KB tokens, issuers are
long-form did:peer:4).

## What happens

`@kubun/plugin-p2p` clones handles by `serializeMLSGroupState` → `restoreMLSGroupHandle` →
`restoreGroup` (per staged app-frame open, `readHandle`, and twice in the post-persist merge path). Every
`restoreGroup` calls `applyLedgerEntries(params.ledgerEntries)` with a freshly deserialized token array,
so `VERIFIED_LEDGER_TOKENS` (a `WeakMap` keyed by the array object, `group-handle.ts:423`) never hits and
each entry is verified again:

- `verifyLedgerEntry` → `@kokuin/token` `resolveIssuerWithDoc` → `decodePeer4` (O(n²) base58 decode of the
  long-form doc + sha256), 11.5 s of the profile. Being memoized in kokuin separately
  (`fix/peer4-decode-memo`).
- `ledgerEntryDigest` (sha256 over the whole token) per entry, a large share of the remaining samples.
- No yield inside the loop, so one replay of 50 entries is one synchronous block.

The `ledgerTokens` doc comment says in-process clones inherit verification through the returned array;
kubun's serialize/restore round trip breaks that, and serialized tokens "must verify afresh" by design.

## Expected

Restoring a handle from tokens this process already verified costs no signature/DID/digest work per
entry, and a replay never blocks the event loop for long.

## Open for kumiai to decide

- Key the verified-entry memo and `ledgerEntryDigest` by token content (string, LRU-bounded) instead of
  array identity. Verification is a pure function of the token bytes except time claims, which the held
  path already re-checks (`assertTimeClaimsValid`).
- And/or a `GroupHandle.clone()` (or `restoreGroup` accepting verified `LedgerLogEntry`s) so hosts never
  re-verify for in-process copies.
- Cooperative yield (`@sozai/async` `maybeYield`) per entry in `applyLedgerEntries`, `bootstrapLedger`
  and the envelope-resolve loop.

## Related

- kubun ask: `kubun/docs/agents/plans/backlog/2026-10-27-group-handle-clone-without-restore.md`.
- Sakui backlog: `sakui/docs/agents/plans/backlog/2026-10-25-mobile-sync-ui-stall-upstream.md`.
