# Hub key-package + subscribe caps (DoS hardening) — complete

**Status:** complete
**Date:** 2026-07-25
**Branch:** `feat/hub-keypackage-subscribe-caps`
**Origin:** P4 audit-remediation item (June 2026 enkaku audit follow-up merged with the
2026-07-02 kumiai audit, commit `bb343d9`, milestone `milestones/2026-07-audit-remediation.md`).

## Goal

Close the hub's DoS-hardening findings: key-package drain, unbounded per-DID state,
un-pruned rate-limit buckets, and a mislatched subscribe-authz refusal. All fixes require
authenticated DIDs and carry no confidentiality impact.

## What was built

Landed across `@kumiai/hub-protocol`, `@kumiai/hub-server`, `@kumiai/hub-conformance`,
`@kumiai/rpc` (7 code/test commits):

- **Named hub errors + wire codes** — `AuthorizationDeniedError` (`HUB_AUTHORIZATION_DENIED`),
  `KeyPackageQuotaExceededError` (`HUB_KEYPACKAGE_QUOTA`), `SubscriptionQuotaExceededError`
  (`HUB_SUBSCRIPTION_QUOTA`), `KeyPackageFetchLimitError` (`HUB_KEYPACKAGE_FETCH_LIMIT`). Each
  round-trips through `hubErrorCodeOf`/`hubErrorFromCode` so refusals cross the RPC tunnel
  diagnosably.
- **Subscribe-authz refusal is permanent in the client mux** — `isPermanentSubscribeFailure`
  now recognizes `AuthorizationDeniedError` (by instance AND by `error.name`, for the
  tunnel-rebuild path). Fixes a live bug where an authz refusal ran the full retry schedule
  then mislatched transient.
- **Per-DID store caps as a `HubStore` port invariant** — `maxKeyPackagesPerDID` (default 100),
  `maxSubscriptionsPerDID` (default 1000). `storeKeyPackage` and `subscribe` reject over-cap; a
  `subsByDID` reverse index gives O(1) per-DID subscription count. Asserted by
  `hub-conformance` (reject-not-evict, per-DID isolation, re-subscribe exemption).
- **Rate-limiter prunes idle buckets** — evicts full-capacity buckets past a TTL (default 300s)
  on the cold path once the map exceeds 1024 entries.
- **Handler authorize dispatch + rate limits + per-target quota** — `authorize()` now dispatched
  for `keypackage/fetch`, `keypackage/upload`, `topic/fetch`; `didLimiter` rate-limits
  `subscribe`/`unsubscribe`/`keypackage/upload`; a per-target-DID consumption quota
  (`maxPerTargetConsumed`, default 60/window) bounds collective drain of one victim's key
  packages on top of the existing per-requester window.

## Key design decisions (rationale preserved)

- **Drain defence = quota + authorize only, no protocol change.** Ordinary single-use `splice`
  semantics kept. The per-target quota charges the *ask* (the capped count) before the
  destructive splice, keyed on the victim and summed across all requesters — so minting N
  throwaway requester DIDs cannot amplify the drain past `maxPerTargetConsumed`/window. A
  determined authorized attacker within quota can still eventually empty a pool; the
  amplification and the free-for-all are what close.
- **Caps live in the store, not the handler.** Only the store can bound a per-DID count
  atomically (handler read-then-write races between awaits). Enforcing there made it a port
  invariant, so both hub contract suites cover it.
- **Reject over-cap, never evict-oldest.** Evicting a stored key package would silently discard
  one the owner expects to be consumed, and would let an attacker's uploads push out the
  victim's own.
- **`SubscriptionQuotaExceededError` is deliberately left TRANSIENT in the mux.** Unlike an
  authz refusal (policy) or a retention refusal (a settled fact about the request), a
  subscription-quota refusal is a *clearable* resource condition — it frees when the peer
  unsubscribes. Latching it permanent would strand a topic the peer legitimately wants once
  capacity frees (a permanent latch clears only on a different-retention re-ask). The cost of
  transient is one bounded retry schedule per hit, after which the topic is naturally re-asked
  on the next retain. Documented in-code at `isPermanentSubscribeFailure`.
- **Authorize → per-requester → per-target ordering is load-bearing.** In `keypackage/fetch` a
  refused or per-requester-throttled request must not charge the per-target window. Pinned by a
  regression test (mutation-verified: reordering the two checks fails the test).
- **`publish` refusal left untouched.** Its existing `EK02` refusal is not in a finding;
  adopting the named authz error there was a deliberate deferral to avoid changing shipped wire
  behaviour outside scope.

## Verification

Uncached at merge candidate: `hub-protocol` 13, `hub-server` 112 (0 skipped, both hub contract
suites), `rpc` 374 (incl hub-conformance); build 10/10; `build:types` clean; biome clean (278
files). Final whole-branch review: zero Critical; drain efficacy, wire-code coherence,
prune-cannot-refund-tokens, and `subsByDID` lockstep all verified.

## Process notes

- The plan's supplied rate-limit prune predicate (`bucket.tokens >= burst`) was **inert** —
  stored tokens are always below burst at rest because every `tryConsume` decrements. The
  implementation correctly recomputes fullness from elapsed time (mirroring the hot-path refill
  formula), and an in-code comment now warns against "simplifying" it back to the broken
  stored-value check. Caught by the task's own TDD RED/GREEN plus a reviewer mutation-check.

## Deferred / follow-on

- **True MLS last-resort key-package semantics** — see
  `docs/agents/plans/next/2026-07-25-hub-last-resort-keypackage.md`.
- Minor, acknowledged non-regressions (not scheduled): the ephemeral rate-window maps
  (`fetchWindows`, `targetWindows`) are bounded by throughput × window, not by an absolute
  ceiling (the store caps are the real per-DID bound); the cold-path prune sweep is O(n) under a
  distinct-key flood. Both are annotated in-code.
