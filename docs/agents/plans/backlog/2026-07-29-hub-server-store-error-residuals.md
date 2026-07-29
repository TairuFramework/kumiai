# hub-server store-error residuals

Four small items raised by the whole-branch review of the `onStoreError` work and deliberately
declined at the time. None is urgent; each has a clear trigger. Background:
`docs/agents/plans/completed/2026-07-29-errors-reach-a-sink.complete.md`.

## 1. `store.unsubscribe` does not follow the file's error-wrapping pattern

`packages/hub-server/src/handlers.ts`, the `hub/v1/unsubscribe` handler: `await store.unsubscribe(...)`
is the one `HubStore` call in the file with no `try`/`catch`, so a store failure propagates raw
instead of through `rethrowAsHandlerError` like every other store call. Not a swallow — the request
does fail — but a raw store error crosses the wire without the coded shape callers expect, and a
named store error has to stay tellable from an unreachable hub. Pre-existing, unrelated to the
`onStoreError` work.

## 2. `HubStoreErrorEvent.did` is optional for every method

The type is a flat `{ method; did?; error }`, so a site can forget the DID and nothing complains;
the "absent for `purge`" rule lives in a doc comment rather than the type system. A discriminated
union (`{ method: 'purge'; error } | { method: 'ack' | 'fetchLastResortKeyPackage'; did: string; error }`)
would make it the compiler's job. Not worth doing for three sites — worth doing the moment there is
a fourth.

## 3. The consequence text is keyed by method but describes a call site

`STORE_ERROR_CONSEQUENCE` is keyed by the `method` union, but its `fetchLastResortKeyPackage` entry
describes the *top-up call site* specifically. That method is called at three places in
`handlers.ts` and only one reports; if either of the others is ever wired, it silently inherits a
sentence that is false for it. A comment records this at the map. The fix, when a fourth site
arrives, is a site discriminator rather than a reused method key.

## 4. `createHub` builds a second reporter instance

The purge timer calls `createStoreErrorReporter(params.onStoreError)` while `createHandlers` has
already built one from the same hook. Harmless today because the closure is stateless — but the
hub-server README explicitly points at throttling as future work, and a stateful reporter would then
throttle the purge timer and the handlers independently. If throttling is ever added, share one
instance first.

## Also considered and rejected

The ack test's `setTimeout(..., 20)` before `controller.abort()` was left as-is: it matches the
established convention in the sibling receive test, and the work it waits for is all microtasks, so
the margin is large. A bounded poll on the observed state would make it deterministic if it ever
flakes on a loaded CI machine.
