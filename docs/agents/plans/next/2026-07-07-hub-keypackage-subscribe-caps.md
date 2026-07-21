# Hub key-package + subscribe caps (Sybil fetch, upload quotas, rate-limit hygiene)

**Priority:** 4 (with the receive-lifecycle fixes) — DoS hardening; requires authenticated
DIDs, no confidentiality impact.
**Origin:** June 2026 enkaku audit follow-up (relocated backlog item
`hub-keypackage-quotas`, 0.18 stack split) merged with the 2026-07-02 kumiai audit
(commit `bb343d9`), milestone `milestones/2026-07-audit-remediation.md`.

## Findings

### High

> **Line and procedure references updated for `feat/app-lane-delivery`.** Every procedure
> gained a `v1` segment (`hub/subscribe` is now `hub/v1/subscribe`, and so on, commit
> `b82f620`), and the `AuthorizeHook` surface was reshaped (`2e9206d`) — see the note under
> the first finding, which that reshape half-addresses.

- **`packages/hub-server/src/handlers.ts:413-420` + `memoryStore.ts:451` — key-package
  drain.** Any authenticated DID can destructively fetch (`splice`) anyone's key packages
  with no authorize hook and only a per-*requester* window (~300/min keyed on requester
  DID, `assertKeyPackageFetchAllowed` at `handlers.ts:135`). DIDs are free to generate, so
  N throwaway identities drain a victim's MLS key packages at N×300/min and block group
  joins; throwaway entries also inflate `fetchWindows`. Fix: extend `AuthorizeHook` to
  key-package actions and/or add a per-target-DID consumption quota.

  **Half of that fix has shipped, and it is the half that does nothing on its own.**
  `AuthorizeRequest` now carries `{ action: 'keypackage/fetch'; did; targetDID; count }`
  and a matching `keypackage/upload` variant (`handlers.ts:35-36`), but **no handler calls
  `authorize` for either** — `hub/v1/keypackage/fetch` calls only the per-requester rate
  check, and `hub/v1/keypackage/upload` calls nothing. Only `publish` (`:184`) and
  `subscribe` (`:257`) are enforced; `unsubscribe` and `topic/fetch` are likewise declared
  and ungated. This is stated at the type (`handlers.ts:24-31`) and was deliberate — the
  variants shipped early because widening that union later is the break the type exists to
  avoid — but it means a host that writes `case 'keypackage/fetch': return false` today is
  refusing nothing. What remains here is the dispatch, not the surface.
- **`packages/hub-server/src/handlers.ts:295-300,406-411` — no caps on
  subscribe/upload.** `hub/v1/subscribe`, `hub/v1/unsubscribe`, and
  `hub/v1/keypackage/upload` have no rate limiting and no per-DID caps, allowing unbounded
  subscription-set entries (`memoryStore.ts:402`) and key-package arrays
  (`memoryStore.ts:442`) — memory exhaustion. Upload is bounded per call by schema caps
  (50 × 16KB) but call count is unlimited and the per-DID array grows without bound
  (`packages.push`). Fix: apply the existing DID token-bucket and cap per-DID storage
  (reject or evict-oldest beyond N).

### Medium

- `packages/hub-server/src/rateLimit.ts:20-27` — limiter buckets never pruned. One entry
  per distinct key, forever; publishing to many random topic IDs grows memory without
  bound. Fix: evict full-capacity buckets past a TTL.
- **When subscribe authorization lands, teach the client which refusals are permanent.**
  `isPermanentSubscribeFailure` (`packages/rpc/src/hub-mux.ts:240`) recognises only
  `RetentionExceededError`, by instance *and* by `error.name` — the name check is there
  because a hub reached over the tunnel rebuilds the error from its wire code. An
  authorization refusal, once one exists, would fall through to the transient branch: run
  the whole retry schedule against a settled answer, then latch as non-permanent. Correct
  behaviour with the wrong label and a slow start, and the fix belongs with whichever
  change first makes a subscribe refusable on authorization grounds rather than
  retention.

## Sketch (carried from the enkaku backlog item)

- Per-*target*-DID fetch cap (bound how fast anyone, collectively, can drain a given DID's
  packages) in addition to the per-requester cap.
- MLS last-resort key-package semantics: never consume the final package, serve it
  non-destructively so the victim can always be added to groups.
- Per-DID stored-package cap on upload: reject or evict-oldest beyond N.

## Scope

`@kumiai/hub-server` (`handlers.ts`, `memoryStore.ts`, `rateLimit.ts`); possibly
`@kumiai/hub-protocol` if the authorize-hook surface grows.

## Test hooks

Key-package limits (`assertKeyPackageFetchAllowed`, `maxCount` capping,
fetch-for-nonexistent-DID) are entirely untested — see `next/2026-07-07-test-gaps.md`.
