# Store errors on the key-package fetch path reach clients without a wire code

**Priority:** low — pre-existing pattern, narrow blast radius, no correctness impact.
**Origin:** deferred minor from the last-resort key-package work landed 2026-07-26; see
`docs/agents/plans/completed/2026-07-26-last-resort-keypackage.complete.md`.

## The gap

In the `hub/v1/keypackage/fetch` handler, `store.fetchKeyPackages` and
`store.fetchLastResortKeyPackage` are both called outside any `try`/`catch`, so neither is routed
through `rethrowAsHandlerError`. A store that throws a classifiable error surfaces it to the client
with no `code` at all — indistinguishable, from the caller's side, from a transport failure. That is
precisely the distinction the hub's wire codes exist to preserve.

This is a long-standing pattern rather than a regression: `fetchKeyPackages` was already unwrapped
before the last-resort work, and other handlers in the file do wrap their store calls.

## The one place it is more than cosmetic

On the per-target quota fallback path, the handler has already caught a
`KeyPackageFetchLimitError` and is about to serve the last-resort package instead of refusing. If
`fetchLastResortKeyPackage` throws there, the store's error does not merely arrive uncoded — it
*replaces* the `HUB_KEYPACKAGE_FETCH_LIMIT` the client would otherwise have received. A retryable,
coded refusal becomes an opaque failure, so a client that would have backed off and retried instead
sees something it cannot classify.

## Sketch

Wrap both store calls in the fetch handler the way the rest of the file wraps its store calls, so a
named store error keeps its wire code. On the fallback path specifically, decide what a store
failure should surface as — the store's own code, or the quota refusal it displaced. The second is
arguably more useful to a caller, since the quota state is the real reason the ordinary path was
unavailable.

Worth doing as a sweep across the handler rather than only for the last-resort calls, since the
inconsistency is what makes the behavior surprising.

## Scope

`@kumiai/hub-server` (`handlers.ts`). No port or protocol change.
