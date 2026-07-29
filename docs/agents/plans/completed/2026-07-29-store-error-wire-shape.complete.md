# Store-error wire shape in hub-server handlers — complete

**Date:** 2026-07-29
**Status:** complete
**Branch:** `fix/store-error-wire-shape`
**Origin:** the residuals recorded after `2026-07-29-errors-reach-a-sink.complete.md`.

## Goal

`packages/hub-server/src/handlers.ts` holds one rule, established by the `onStoreError` work: a
`HubStore` failure either fails the request through `rethrowAsHandlerError` — so a caller can tell a
named store error from an unreachable hub — or is a deliberate swallow reported to the store-error
sink. Two call sites obeyed neither. This closes both.

## What was built

**A failed subscriber read during publish fan-out no longer fails the publish.** `getSubscribers`
runs after `store.publish` returned, and the storage contract commits the append and its
per-recipient delivery rows in one transaction. So the frame is already durable for every subscriber
when that read happens. It is now a reported swallow returning the `sequenceID`.

**`store.unsubscribe` failures cross the wire coded**, like every other store failure in the file.

**`HubStoreErrorEvent` became a discriminated union on `method`** — `purge` carries only `error`,
`ack` and `fetchLastResortKeyPackage` carry a required `did`, and the new `getSubscribers` carries a
required `topicID`. Breaking for a hook reading `event.did` unconditionally; accepted pre-1.0 and
called out in the changeset.

**`createHub` builds one store-error reporter and shares it** with `createHandlers` rather than each
building its own from the same hook.

README, changeset, and the closure of three of the four filed residuals came with it.

## Key design decisions

**Reporting the fan-out failure rather than coding it was the whole point, not a convenience.**
Failing the request would report a falsehood — the append committed — and would also make the loss
permanent: the caller's natural recovery is a `publishID` retry, which returns `deduped: true`, and
the fan-out block is gated on `!deduped`. So the live push for that frame would be gone for good.
Swallowing costs only the live push; the frame stays pending in the store.

**The durability claim was verified at contract level, not against one store.** `hub-conformance`
pins that a conforming store writes delivery rows at publish time for the log class as well as the
mailbox class, so the swallow is sound for any implementation, not just `memoryStore`.

**A method-keyed union, not a site-keyed one.** The earlier residual predicted that "a fourth site"
would force a site discriminator. A fourth site did arrive, but it was a distinct *method*, which a
method-keyed union discriminates correctly. A `site` field would have been derivable from `method`
for every variant. The real trigger — a second *reporting* call site of one method — has still not
fired and stays filed in `backlog/2026-07-29-hub-server-store-error-residuals.md`.

**`unsubscribe`'s wrap is defence, not a port change.** `HubStore.unsubscribe` deliberately declares
no named error, so for a conforming store the wrap is a no-op today. Inventing a named error for it
would be worse than the gap — unsubscribing a topic the DID does not hold should stay idempotent.

**The reporter is shared structurally, not observably.** While the reporter is stateless, one
instance and two are indistinguishable, so no test can pin it. It rests on the code shape and a
comment. The reason it matters is the throttling the hub-server README names as future work: a
stateful reporter built twice would throttle the purge timer and the handlers independently.

## What the review caught

The one substantive finding was in operator-facing text, not code. The swallow's consequence string
and comment said a subscriber recovers the skipped frame "on its next receive drain" — but the
receive channel drains once at open and then goes live permanently, with nothing polling. For the
exact population live fan-out targets, currently-connected subscribers, the recovery point is the
next *reconnect*, which on a healthy connection may be days away. Read as written, an operator would
have deprioritised what is in fact a delivery stall for connected clients. Reworded in the comment,
the consequence map, and the changeset.

## Status

Four tasks, each reviewed; whole-branch review on top. Repo gate green — `turbo run test:types
test:unit --force`, 42/42 with `Cached: 0`, lint clean across 307 files. Two guards were
mutation-checked (removed, tests failed, restored), as was the assertion added for `subjectOf`'s DID
arm.
