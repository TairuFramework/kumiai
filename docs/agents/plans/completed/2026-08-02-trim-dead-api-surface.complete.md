# Two dead exports removed while the band bump makes the break free

**Status:** complete
**Date:** 2026-08-02
**Branch:** `chore/trim-dead-api-surface`

## Goal

The pending release moves all eleven packages 0.4.x → 0.5.0 (`.changeset/version-band-0-5.md`), so
it is already a breaking minor. `../milestones/pre-1.0-breaking-api.md` says the cheap moment to
take a break is one already opening that package's surface. Three items on that milestone were
picked as trivial enough to ride along. Two were taken. The third was dropped — its premise did not
survive being checked.

## What shipped

**`@kumiai/mls` no longer exports `GroupSyncScope`.** Declared at `mls/src/types.ts:62`,
re-exported from `index.ts`, referenced by nothing in this repo or any sibling. A straight deletion.

**`HubClient` no longer exposes `rawClient`** (`hub-client/src/client.ts:73`). The filed reason was
encapsulation — the getter let a caller bypass the typed surface and anything later layered onto it.
Two facts found at removal time made it cheaper than filed:

- `HubClient` has one method per `HubProtocol` procedure, all eight. The "anything not wrapped" the
  getter existed to reach is empty.
- `HubClientParams` takes the `Client<HubProtocol>` in. The caller constructed it and still holds
  it, so the getter only handed back the caller's own reference.

No consumer used it. The only call site was a test asserting the getter existed, deleted with it;
the `rawClient` locals in the integration tests are the callers' own variables, untouched.
`hub-client`'s README lost the escape-hatch mention and gained the reason there is none.

## What was dropped, and why

**`KeyPackageFetchLimits` → `KeyPackageLimits` — premise false.** The milestone and
`../backlog/2026-07-07-hub-protocol-server-cleanup.md` both said the type "sits beside upload-side
limits its name excludes", a claim added 2026-07-28 after the caps work shipped without the rename.
Checked against the source:

- All four fields are fetch-side — `maxCount`, `maxRequests`, `maxPerTargetConsumed`, `windowMs`
  (`hub-server/src/handlers.ts:168`).
- Every read of them is on the fetch path (`handlers.ts:271-321`).
- The upload side is limited by three things, none of which this type declares: the `authorize`
  hook, the generic per-DID limiter from `HubRateLimits.perDID` (`handlers.ts:712`), and the store's
  own per-DID cap.

`KeyPackageFetchLimits` names exactly what it holds. `KeyPackageLimits` would name more than it
holds, so the rename made the surface *less* accurate, not more. Dropped from the milestone with
that reasoning recorded in both docs; refile only if upload-side limits are ever folded into one
config type, motivated by that work rather than by this note.

## Not taken

The rest of the milestone stays open, all of it beyond "trivial": the `HubStore` positional-method
reshape (breaks every implementor and both conformance doubles), AAD on `GroupHandle`
`encrypt`/`decrypt` (the sequencing blocker for rpc's AAD binding), `ProtocolSurface`'s ignored type
parameter, and the bus control-frame envelope (a wire break across `broadcast` + `rpc`). None was
urgent enough to widen this branch: pre-1.0, every minor is a cheap break, so 0.5 is not the last
chance — 1.0 is, which is what the milestone's exit criteria are for.

## Verification

- `pnpm test --force` — 42/42 tasks, `Cached: 0`. `hub-client` at 8 unit tests, one fewer than
  before, exactly the deleted assertion.
- `tests/integration` — 8 files, 43 tests, plus its `tsc --noEmit`.
- `biome check` clean over 313 files.

## Release note

`.changeset/trim-dead-api-surface.md`, minor for `@kumiai/mls` and `@kumiai/hub-client` — redundant
against the band bump's own minor for every package, but it carries the changelog prose those
consumers need.
