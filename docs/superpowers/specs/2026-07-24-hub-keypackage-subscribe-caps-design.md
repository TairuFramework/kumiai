# Hub key-package + subscribe caps — design

**Date:** 2026-07-24
**Branch:** `feat/hub-keypackage-subscribe-caps`
**Origin:** `next/2026-07-07-hub-keypackage-subscribe-caps.md` (June 2026 enkaku audit
follow-up merged with 2026-07-02 kumiai audit, commit `bb343d9`, milestone
`milestones/2026-07-audit-remediation.md`).

## Problem

Authenticated DIDs are free to mint. Two DoS classes follow:

1. **Key-package drain.** `hub/v1/keypackage/fetch` destructively `splice`s a target's key
   packages behind only a per-*requester* window (~30/min keyed on requester DID). N throwaway
   identities drain a victim's packages at N× the rate and block group joins. No authorize hook
   is dispatched for the action even though the `AuthorizeRequest` variant exists.
2. **Unbounded per-DID state.** `hub/v1/subscribe`, `hub/v1/unsubscribe`, and
   `hub/v1/keypackage/upload` have no rate limiting and no per-DID caps. Subscription sets and
   key-package arrays grow without bound — memory exhaustion.

Plus two structural gaps: the `rateLimit.ts` limiter never prunes buckets (one entry per distinct
key, forever), and a subscribe authorization refusal — which exists today as a bare enkaku `EK02`
— falls through `isPermanentSubscribeFailure` to the transient branch, running the full retry
schedule against a settled answer before mislatching non-permanent.

All fixes are DoS hardening. They require authenticated DIDs and carry no confidentiality impact.

## Scope decisions (from brainstorming)

- **All findings in one plan** — High (drain + caps) and both Medium (bucket TTL pruning, hub-mux
  permanence label).
- **Drain defence = quota + authorize only.** No protocol change for last-resort semantics.
  Ordinary single-use `splice` semantics kept. A determined authorized attacker within quota can
  still eventually empty a pool; the amplification and the free-for-all are what close.
- **Authorize dispatch for `keypackage/fetch`, `keypackage/upload`, `topic/fetch`.**
  `unsubscribe` stays ungated — refusing an unsubscribe has no coherent security meaning.

## Design

### 1. `hub-protocol/errors.ts` — named errors + wire codes

Refusals must cross the tunnel diagnosably (and, for authz, permanently). Add:

| Class | Wire code | Raised when |
|-------|-----------|-------------|
| `AuthorizationDeniedError` | `HUB_AUTHORIZATION_DENIED` | an authorize hook denies |
| `KeyPackageQuotaExceededError` | `HUB_KEYPACKAGE_QUOTA` | upload would exceed per-DID storage cap |
| `SubscriptionQuotaExceededError` | `HUB_SUBSCRIPTION_QUOTA` | subscribe would exceed per-DID cap |
| `KeyPackageFetchLimitError` | `HUB_KEYPACKAGE_FETCH_LIMIT` | per-requester OR per-target fetch quota hit |

`KeyPackageFetchLimitError` replaces today's bare `new Error('Key package fetch rate limit
exceeded')` (`handlers.ts:183`), which crosses the wire with no code. Extend `hubErrorCodeOf` and
`hubErrorFromCode` for all four.

### 2. Store caps — `memoryStore.ts` + `hub-conformance` (port invariant)

A per-DID count can only be bounded atomically where it lives, so caps are store invariants, not
handler read-then-write checks (which race under concurrency). `MemoryStoreOptions` gains:

- `maxKeyPackagesPerDID` — default `100`
- `maxSubscriptionsPerDID` — default `1000`

Behaviour:

- `storeKeyPackage`: **reject** over cap (throw `KeyPackageQuotaExceededError`). Not evict-oldest —
  evicting silently drops a valid unused package the owner expects to be consumed, and lets an
  attacker's uploads push out the victim's own.
- `subscribe`: reject over cap (throw `SubscriptionQuotaExceededError`). Add a reverse index
  `subsByDID: Map<DID, Set<topicID>>`, maintained in `subscribe`/`unsubscribe`, for O(1) per-DID
  subscription count.

`HubStore` method signatures are unchanged; the new rejection invariants are documented on the
port and asserted by `hub-conformance` against a store configured with small caps. `createMemoryStore`
is the only implementation, so conformance updates + memoryStore are the full surface.

### 3. `handlers.ts` — authorize dispatch, rate limits, per-target quota

- `keypackage/fetch`: dispatch
  `authorize({ action: 'keypackage/fetch', did: requesterDID, targetDID: param.did, count: cappedCount })`
  (pass `cappedCount` — the real number to be consumed — not the raw request). Add a **per-target-DID
  consumption quota**: a second window `Map` keyed on the target DID, counting *packages consumed*
  (`cappedCount`) per window; throw `KeyPackageFetchLimitError` when the target's budget is
  exhausted. The existing per-requester window is kept. `KeyPackageFetchLimits` gains
  `maxPerTargetConsumed` (default `60`) sharing the existing `windowMs`.
- `keypackage/upload`: dispatch authorize; rate-limit via the existing `didLimiter`. Storage cap is
  enforced in the store (§2).
- `topic/fetch`: dispatch authorize.
- `subscribe`: on `!decision.allow`, throw `AuthorizationDeniedError` (code
  `HUB_AUTHORIZATION_DENIED`) instead of raw `EK02`, so it crosses as a permanent refusal;
  rate-limit via `didLimiter`.
- `unsubscribe`: rate-limit via `didLimiter`. No authorize dispatch.
- `publish`: left untouched. Its existing `EK02` authz refusal is not in a finding; adopting
  `AuthorizationDeniedError` there is a deliberate deferral to avoid changing shipped wire
  behaviour outside this plan's findings.

### 4. `rateLimit.ts` — bucket TTL pruning

Opportunistic eviction of idle buckets, mirroring the `fetchWindows` prune (`handlers.ts:170`).
On `tryConsume`, when the bucket map exceeds a size threshold, evict buckets that are at full
capacity (tokens refilled to `burst`) and older than a TTL. Config `ttlMs` (default `300_000`). A
full bucket carries no rate state, so dropping and recreating it on next use is behaviourally
identical — the prune can never wrongly grant or deny a token.

### 5. `rpc/hub-mux.ts` — permanence label

`isPermanentSubscribeFailure` also returns true for `AuthorizationDeniedError`, matched by instance
**and** by `error.name` (a hub reached over the tunnel rebuilds the error from its wire code via
`hubErrorFromCode`; a host bundling two copies of hub-protocol would break `instanceof` alone).
This closes the live bug: a subscribe authz refusal currently runs the whole retry schedule then
latches non-permanent.

Note the existing `TopicSubscription` machinery clears a permanent refusal only when a later retain
asks for a *different retention*. An authz denial is not on the retention axis, so a re-ask with a
different retention re-asks, is denied again, and re-latches — bounded and acceptable.

## Error handling

Store-raised quota errors reach the client through the existing `rethrowAsHandlerError` path
(`handlers.ts:119`), which maps them via `hubErrorCodeOf`. Handler-raised errors (`authorize`
refusal, fetch-limit) are thrown as `HandlerError` with the corresponding wire code directly. The
client rebuilds all of them via `hubErrorFromCode`, so both instance and name checks work over the
tunnel.

## Testing

- **hub-conformance:** store cap rejections — `KeyPackageQuotaExceededError` at
  `maxKeyPackagesPerDID`, `SubscriptionQuotaExceededError` at `maxSubscriptionsPerDID`.
- **hub-server handlers:** authorize dispatch for fetch/upload/topic-fetch (refusal → correct wire
  code); per-target consumption quota (N requesters collectively capped); upload rate-limit;
  `maxCount` capping and fetch-for-nonexistent-DID (both currently untested — overlaps
  `next/2026-07-07-test-gaps.md`); bucket TTL pruning (idle buckets evicted, active ones kept).
- **rpc hub-mux:** a subscribe authz refusal latches permanent (no retry storm), verified both by
  instance and by an error rebuilt-from-wire-code (name path).

Changing the `HubStore` port means running **both** contract suites against the real
implementation and the doubles (`docs/agents/architecture.md`).

## Deferred

- **True MLS last-resort key-package semantics** ("victim can always be added to groups,
  non-destructive serve of a reusable package"). Requires `mls` to generate a key package carrying
  the RFC 9420 `last_resort` extension (a reusable-by-design package) and flag it at upload;
  `ts-mls` has no built-in support, so it is a manual `CustomExtension` plus a hub-protocol upload
  flag plus store slotting. Cross-repo, cryptographically load-bearing, its own effort. The
  quota + authorize defence in this plan bounds the drain rate without it.

## Config defaults summary

| Knob | Default | Where |
|------|---------|-------|
| `maxKeyPackagesPerDID` | 100 | `MemoryStoreOptions` |
| `maxSubscriptionsPerDID` | 1000 | `MemoryStoreOptions` |
| `maxPerTargetConsumed` | 60 / window | `KeyPackageFetchLimits` |
| `windowMs` (shared) | 60_000 | `KeyPackageFetchLimits` |
| `ttlMs` (bucket prune) | 300_000 | `RateLimitConfig` / limiter |

All are tunable and not load-bearing for the design.
