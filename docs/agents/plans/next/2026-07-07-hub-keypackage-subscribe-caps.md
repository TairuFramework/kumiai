# Hub key-package + subscribe caps (Sybil fetch, upload quotas, rate-limit hygiene)

**Priority:** 4 (with the receive-lifecycle fixes) — DoS hardening; requires authenticated
DIDs, no confidentiality impact.
**Origin:** June 2026 enkaku audit follow-up (relocated backlog item
`hub-keypackage-quotas`, 0.18 stack split) merged with the 2026-07-02 kumiai audit
(commit `bb343d9`), milestone `milestones/2026-07-audit-remediation.md`.

## Findings

### High

- **`packages/hub-server/src/handlers.ts:233-240` + `memoryStore.ts:261-266` —
  key-package drain.** Any authenticated DID can destructively fetch (`splice`) anyone's
  key packages with no authorize hook and only a per-*requester* window (~300/min keyed on
  requester DID). DIDs are free to generate, so N throwaway identities drain a victim's
  MLS key packages at N×300/min and block group joins; throwaway entries also inflate
  `fetchWindows`. Fix: extend `AuthorizeHook` to key-package actions and/or add a
  per-target-DID consumption quota.
- **`packages/hub-server/src/handlers.ts:127-135,226-231` — no caps on
  subscribe/upload.** `hub/subscribe`, `hub/unsubscribe`, and `hub/keypackage/upload` have
  no rate limiting and no per-DID caps, allowing unbounded subscription-set entries
  (`memoryStore.ts:209-216`) and key-package arrays (`memoryStore.ts:252-259`) — memory
  exhaustion. Upload is bounded per call by schema caps (50 × 16KB) but call count is
  unlimited and the per-DID array grows without bound (`packages.push`). Fix: apply the
  existing DID token-bucket and cap per-DID storage (reject or evict-oldest beyond N).

### Medium

- `packages/hub-server/src/rateLimit.ts:20-27` — limiter buckets never pruned. One entry
  per distinct key, forever; publishing to many random topic IDs grows memory without
  bound. Fix: evict full-capacity buckets past a TTL.

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
