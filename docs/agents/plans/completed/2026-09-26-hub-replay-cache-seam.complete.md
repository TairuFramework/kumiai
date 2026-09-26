# Host-supplied replay cache for `@kumiai/hub-server` — complete

**Date:** 2026-09-26
**Status:** complete
**Packages:** `@kumiai/hub-server` (patch).
**Origin:** Kubun's hub relay wraps `createHub`. Kubun persists its replay ledger for every server it
builds, but `CreateHubParams` had no way to pass a replay cache to enkaku `serve()`. After a hub
restart the default in-memory cache was empty, so a captured signed request still inside its
freshness window could run a second time.

## What shipped

- `CreateHubParams.replay?: HubReplayOptions` (`cache`, `maxAge`, `leeway`, `maxEntries`, `now`),
  forwarded to `serve()`. Omitting it keeps enkaku's per-process memory cache.
- `HubReplayOptions` omits `enabled` and `rejectStale`, and `createHub` always passes
  `enabled: true, rejectStale: true`, so a host (or a cast) cannot switch replay checks off.
- Tests: a shared cache rejects a resent signed request after a restart with `EK09`; forcing the
  weakening fields through a cast still rejects; without a shared cache the resend is accepted
  (documents the gap the option closes).

## Replay-safety audit

Every hub procedure except `publish`-with-`publishID` depends on the replay cache: a second run of
`keypackage/fetch` consumes more one-time packages for the replayer, `keypackage/upload` can restore
a consumed package, `receive` can take over the mailbox channel, `subscribe`/`unsubscribe` and
`wake/register`/`unregister` can roll back later changes, and `topic/fetch`/`keypackage/status`
return fresh data to the replayer. With enkaku defaults (`maxAge` 60 s, leeway 5 s, stale tokens
rejected) the restart window covers requests signed in roughly the last 65 s.

## Follow-ups, not done here

- enkaku: a signed token with neither `iat` nor `exp` is never stale, so it can be replayed once its
  cache entry expires. A persistent cache does not close this; authenticated mode should require
  `iat`.
- hub-server: `keyPackageFetchLimits` windows live in handler memory and reset on restart.
- hub-conformance: publish dedup by `publishID` has no restart case; a persistent `HubStore` must
  keep its publish records across restarts for dedup to hold.
