# Every store call in `handlers.ts` reaches a sink or crosses the wire coded

**Date:** 2026-07-29
**Branch:** `fix/store-error-wire-shape`
**Origin:** `docs/agents/plans/backlog/2026-07-29-hub-server-store-error-residuals.md`, items 1, 2, 3
(partly), 4. Background: `docs/agents/plans/completed/2026-07-29-errors-reach-a-sink.complete.md`.

## The problem

`packages/hub-server/src/handlers.ts` holds one rule that the `onStoreError` work established: a
`HubStore` failure either fails the request through `rethrowAsHandlerError`, so the caller can tell
a lost compare-and-set from an unreachable hub, or it is deliberately swallowed and reported to the
store-error sink. Two call sites obey neither.

**`store.unsubscribe` (`handlers.ts:458`)** has no `try`/`catch`, so a store failure propagates raw.
The request does fail — this is not a swallow — but it crosses the wire without the coded shape
every other store failure in the file carries.

**`store.getSubscribers` (`handlers.ts:379`)** also has no `try`/`catch`, and this one carries
behaviour. It runs *after* `store.publish` returned, and the storage contract commits the append and
its delivery rows in one transaction (`hub-protocol/src/types.ts:190-196`). So when `getSubscribers`
throws, the hub rejects a publish whose write is already durable. Worse, the caller's natural
recovery makes it permanent: a retry with the same `publishID` returns `deduped: true`, and
`handlers.ts:373` gates the entire fan-out block on `!deduped`. The live push for that frame is gone
for good. Subscribers still receive it — from their own mailbox on the next receive drain — so the
cost is push degraded to pull, not data loss. The caller, meanwhile, was told a committed publish
failed.

The residual doc recorded `unsubscribe` as "the one `HubStore` call in the file with no
`try`/`catch`". Verified against source on 2026-07-29, that is wrong: there are two, and
`getSubscribers` is the one with teeth.

## Scope

Both call sites. Fixing `getSubscribers` by reporting to the sink makes it a fourth reporting site
whose subject is a `topicID` rather than a DID, which the current flat event type cannot express —
so the event-type rework (residual 2) comes in with it. Residual 4 (a second reporter instance) is
included because it lives in the same few lines and costs nothing.

Out of scope: residual 3's site discriminator (see below), and any `HubStore` port or
`@kumiai/hub-conformance` change — this is entirely hub-server handler behaviour.

## Design

### 1. `getSubscribers`: report and continue

Wrap the call. On failure, report `{ method: 'getSubscribers', topicID, error }` to the store-error
reporter, skip live fan-out, and return `{ sequenceID }` as normal.

This joins the three existing swallows and is correct for the same kind of reason they are: the
publish succeeded, and the frame is durably queued for every subscriber regardless of whether the
hub manages to push it. The alternative — coding the error and failing the request — keeps a
falsehood (the append committed) and converts a transient store blip into permanent loss of that
frame's live delivery, because the retry path dedups and skips fan-out.

Consequence text for the sink:

> The frame is committed and queued; only the live push to connected subscribers was skipped, so
> every subscriber receives it on its next receive drain instead. A `getSubscribers` that keeps
> failing means the hub has silently degraded from push to pull for every publish.

### 2. `unsubscribe`: wrap and rethrow coded

Wrap the call in `try`/`catch` calling `rethrowAsHandlerError`. No sink involvement — the request
genuinely fails and should.

Stated plainly, because the diff looks like more than it is: `HubStore.unsubscribe`
(`hub-protocol/src/types.ts:219`) declares no named error, so for every conforming store this is a
no-op today. Its value is defence against a store that raises a named error the port does not list,
and the removal of the file's one exception to the coded-wire rule. The port is deliberately left
alone — inventing a named error for `unsubscribe` would be worse than the gap, since unsubscribing
a topic the DID does not hold should stay idempotent.

### 3. `HubStoreErrorEvent` becomes a method-keyed discriminated union

```ts
export type HubStoreErrorEvent =
  | { method: 'purge'; error: unknown }
  | { method: 'ack'; did: string; error: unknown }
  | { method: 'fetchLastResortKeyPackage'; did: string; error: unknown }
  | { method: 'getSubscribers'; topicID: string; error: unknown }
```

The flat `{ method; did?; error }` let a site forget its DID with nothing to complain, and had no
way to say "this one is about a topic". The union makes the subject the compiler's job.

`STORE_ERROR_CONSEQUENCE` stays keyed by `method` and gains its fourth entry.
`createStoreErrorReporter`'s default log line currently builds its subject inline:

```ts
`HubStore.${event.method} failed${event.did == null ? '' : ` for ${event.did}`}. `
```

That becomes a small `subjectOf(event)` switch returning `for <did>`, `on topic <topicID>`, or the
empty string.

**Residual 3 stays filed.** Its trigger was recorded as "a fourth call site", but the hazard it
actually describes is two *reporting* call sites of one method — `fetchLastResortKeyPackage` is
called at three places in `handlers.ts` and only the top-up reports, so its consequence text would
be false for the others. The site arriving here is a different method, which a method-keyed union
already discriminates correctly. The warning comment at the map stays put; the discriminator lands
when a second call site of an existing method starts reporting.

**Breaking change.** A host reading `event.did` unconditionally no longer type-checks. Acceptable
pre-1.0; the changeset must say so.

### 4. One reporter instance

`hub.ts:103` builds `createStoreErrorReporter(params.onStoreError)` for the purge timer while
`createHandlers` has already built its own from the same hook. Hoist the reporter above
`createHandlers` and pass it as that call's `onStoreError`.

No API change is needed: the reporter's signature is `HubStoreErrorHook`, so `createHandlers`' own
wrapper simply delegates to the shared instance. Any state a future reporter holds — the hub-server
README names throttling as likely future work — then lives in exactly one place instead of
throttling the purge timer and the handlers independently.

Honest limit: while the reporter is stateless, this is structurally rather than observably correct.
No test can assert single-instance, so it rests on the code shape and this note.

## Testing

In `packages/hub-server/test/handlers-store-errors.test.ts`:

- `getSubscribers` throws → the publish resolves with its `sequenceID`, the reporter receives
  `{ method: 'getSubscribers', topicID }`, and the frame is still readable from the store
  afterwards. The last assertion is what makes the swallow defensible rather than merely quiet.
- A host hook that itself throws does not fail the publish (the existing hook-safety rule, extended
  to the new site).

For `unsubscribe`, in `handlers.test.ts` or a sibling:

- The store throws `NotSubscribedError` → the reply carries `HUB_NOT_SUBSCRIBED`.
- The store throws a plain `Error` → it passes through uncoded, unchanged.

Every new guard is mutation-checked: remove the `try`/`catch` it added, confirm the new test fails
with a message naming the real symptom, restore. A guard whose test still passes without it has not
been tested.

Repo gates: `pnpm test` forced (cached turbo results do not count — confirm `Cached: 0`),
`test:types`, and `rtk proxy pnpm run lint`.

## Deliverables

- `packages/hub-server/src/handlers.ts` — two wrapped call sites, union event type, `subjectOf`,
  fourth consequence entry.
- `packages/hub-server/src/hub.ts` — hoisted, shared reporter.
- `packages/hub-server/README.md` — the section documenting the three reporting sites now documents
  four.
- Tests as above.
- A changeset: minor for `@kumiai/hub-server`, calling out the `HubStoreErrorEvent` break.
- `docs/agents/plans/backlog/2026-07-29-hub-server-store-error-residuals.md` — items 1, 2 and 4
  deleted as closed. Item 3 survives, rewritten so its trigger reads "a second *reporting* call site
  of one method" rather than "a fourth site", which has now fired without being the hazard. The
  file's "the one `HubStore` call in the file with no `try`/`catch`" claim goes with item 1.
