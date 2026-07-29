# hub-server store-error residuals

One small item left from the whole-branch review of the `onStoreError` work. The other three closed
on 2026-07-29; see `docs/agents/plans/completed/`. Background:
`docs/agents/plans/completed/2026-07-29-errors-reach-a-sink.complete.md`.

## 1. The consequence text is keyed by method but describes a call site

`STORE_ERROR_CONSEQUENCE` is keyed by the `method` union, but its `fetchLastResortKeyPackage` entry
describes the *top-up call site* specifically. That method is called at three places in
`handlers.ts` and only one reports; if either of the others is ever wired, it silently inherits a
sentence that is false for it. A comment records this at the map. The trigger is not "a fourth
site" — one arrived on 2026-07-29 (`getSubscribers`) and a method-keyed union discriminated it
correctly. The trigger is a *second reporting call site of one method*: the moment either of the
other two `fetchLastResortKeyPackage` calls starts reporting, it inherits a sentence that is false
for it, and the fix is a site discriminator alongside `method`.

## Also considered and rejected

The ack test's `setTimeout(..., 20)` before `controller.abort()` was left as-is: it matches the
established convention in the sibling receive test, and the work it waits for is all microtasks, so
the margin is large. A bounded poll on the observed state would make it deterministic if it ever
flakes on a loaded CI machine.
