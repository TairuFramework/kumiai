# Errors reach a sink

**Status:** complete
**Date:** 2026-07-29
**Branch:** `feat/hub-server-error-sink`
**Scope:** `@kumiai/hub-server` (the `onStoreError` hook), `@kumiai/rpc` (adopts the shared
reporter), plus a released dependency change in the sibling `sozai` repo (`@sozai/log` 0.3.0)

## The problem

`createHandlers` took no logger and no error hook, and the module held no console reference. Three
`HubStore` failures were therefore not merely swallowed but *unobservable*:

1. the **last-resort key-package top-up** read, which runs after `fetchKeyPackages` has already
   consumed destructively
2. an **ack**, where the frame stays pending and the client re-acks next round
3. the scheduled **purge**, retried on the next interval

All three swallows are correct. The first is the serious one: a store that has not implemented the
slot throws `store.fetchLastResortKeyPackage is not a function` on every fetch, so the request
returned 200 forever, the availability floor the last-resort feature exists to provide was silently
absent, and the operator's only clue was joins failing downstream at a different peer.

A second, subtler failure sat underneath it. `@kumiai/rpc` already reported through `@sozai/log`,
guarded by `isSetup()` — but `isSetup()` answers "did someone call `setup()`", not "will this record
reach anyone". An app taking the documented easy path configured logging whose loggers did not cover
`['kumiai']`, so the console fallback stayed out of the way and the record was dropped for want of a
matching logger. The peer went deaf through the most ordinary setup an app can perform.

## What was built

**`@sozai/log` 0.3.0** (sibling repo, released first — this branch is unmergeable without it).
`getDefaultConfig()` gained a root logger so any category reaches the console at `error` unless an
app deliberately narrows it, and `getReporter(category, packageName)` became the one shared report
mechanism.

**`@kumiai/hub-server`.** `HubStoreErrorEvent` (`{ method, did?, error }`), `HubStoreErrorHook`, and
`createStoreErrorReporter`, with `onStoreError` on both `CreateHandlersParams` and `CreateHubParams`
— the latter forwarded down to `createHandlers` as well as used by the purge timer. All three sites
wired. Unwired, a failure is reported through `@sozai/log` under `['kumiai', 'hub-server']` at
`error` rather than passing silently.

**`@kumiai/rpc`.** Its two hand-rolled copies of the report mechanism deleted in favour of
`getReporter` — 34 lines removed for 4.

## Key design decisions

**Every swallow stays a swallow.** No control flow changed anywhere; only the reporting is new. For
the top-up site this is not a preference but a correctness requirement: surfacing that failure would
destroy key packages nobody ever received, and the client's retry would burn the next batch — which
is the exact drain the last-resort slot exists to close, reintroduced by the top-up read itself. The
invariant was verified by literal diff and by mutation (making the top-up rethrow unconditionally
fails six tests across three files).

**A hook is a notice, not a dependency.** A throw from `onStoreError` is swallowed. A host whose own
reporting path is broken still gets served.

**The root logger replaces, it does not join.** In `@sozai/log`, the new root entry replaced the
existing `['logtape','meta']` and `['sozai']` entries rather than sitting beside them. logtape's
`parentSinks` defaults to `'inherit'`, which *unions* a category's own sinks with its parent's
resolved sinks and does not de-duplicate by identity — two entries naming the same sink object print
every record twice. Dropping the meta entry is safe because logtape counts a `category: []` entry as
configuring the meta logger, so its "not configured" fallback stays suppressed.

**No throttling, deliberately.** A permanently broken store emits per request. logtape ships
`getThrottlingFilter`, so rate control belongs in the app's sink configuration where an operator can
tune it, rather than hard-coded in the hub.

**`STORE_ERROR_CONSEQUENCE` is the product of the unwired path.** Each entry says what the hub did
*instead* of failing and what a permanent failure costs — the availability floor absent, frames
redelivered forever, the store growing without bound. It is a `Record` keyed by the method union, so
a fourth method without an entry is a compile error. Recorded at the map: the key is the method but
the text assumes the top-up *call site*, so a future fourth site needs a site discriminator rather
than a reused method key.

**One site was examined and deliberately left alone.** The second `fetchLastResortKeyPackage` read,
on the branch where the per-target budget is already spent, is not a swallow: its failure is captured
and attached as `cause` on a thrown `HandlerError`, so the request fails and the operator sees it.
Surfacing it differently would turn a retryable coded refusal into an opaque one.

## What the reviews caught

Every task passed a scoped review. Two findings are worth carrying forward, both the same shape — a
guard nobody had mutated:

**A root sink hides a wrong category.** Changing hub-server's reporter category from
`['kumiai','hub-server']` to `['nobody']` left all 159 tests green, while the README and changeset
both instruct operators to filter on that exact string. A console-mock assertion structurally cannot
catch this, because the new root logger carries *every* category to the console — the only consumer
it would have broken is the one that narrowed `['kumiai']`, i.e. the one following the
documentation. Pinning a category requires a `setup()` whose only logger is the narrow category, with
a capture sink asserting `record.category` and `record.level`.

**The consequence strings were untested.** Blanking the interpolation out of the reporter's message
also left the suite green, and the `ack` and `purge` entries were exercised by nothing at all. Three
capture-sink tests now cover all three.

Both were found only by the whole-branch review, after nine per-task gates had passed.

## Status

Complete. 42/42 turbo tasks green on a forced, uncached run; biome clean across 314 files; the
integration suite (which the gate type-checks but does not execute) 35/35. No port changed —
`HubStore`, `HubProtocol` and the rpc ports are untouched, so `rpc-conformance` and
`hub-conformance` pass unmodified. Both new parameters are optional, so the change is backward
compatible.

One environment hazard is worth recording: after the catalog bump, `node_modules` was silently stale
— the lockfile was correct but the installed tree lacked the new version, and `pnpm install`,
`--frozen-lockfile` and `--force` all reported success while changing nothing. Only
`rm -rf node_modules && pnpm install` fixed it. The whole-repo gate would otherwise have run green
against the old dependency. After a catalog bump, check the package-local copy or
`pnpm ls <dep> -r --depth 0`; the root `node_modules` copy can legitimately stay behind when an
unrelated transitive consumer pins an older version.

## Follow-on work

Filed as `docs/agents/plans/backlog/2026-07-29-hub-server-store-error-residuals.md`: four small
residuals the whole-branch review raised and this work deliberately declined, including the one
`HubStore` call in `handlers.ts` that does not follow the file's own error-wrapping pattern.
