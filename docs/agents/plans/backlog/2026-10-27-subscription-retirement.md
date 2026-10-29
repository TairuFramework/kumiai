# Hub subscriptions are never retired, so a peer hits the per-DID cap (ask from Sakui, 2026-10-27)

## Context

Sakui CLI daemon (desktop hub peer). After a few weeks of pairing runs, hub.db `kubun_hub_subscriptions` holds exactly
1,000 rows for the desktop DID (`DEFAULT_MAX_SUBSCRIPTIONS_PER_DID`): 806 default retention, 194 app-log, 819 with no
topic head. `SubscriptionQuotaExceededError` persists across restart.

## What happens

- `@kumiai/rpc` `hub-mux.ts` `retainTopic` never releases (~297). Topics for dead groups, finished lanes and departed
  devices stay subscribed.
- The kubun hub purges a subscription only after 90 days of inactivity (`kubun` `create-relay.ts:80`).
- At the cap, publish and fetch on new topics are refused (`hub-mux.ts` ~476). Observed effect: remove lanes broke
  (11 `NotSubscribedError`, then 4,489 quota-rejected removal requests), so dead phones could not be removed from the
  groups.

## Expected

- A subscription lives as long as the topic is needed: released when a lane, group or member is retired, and on
  leave/remove.
- Reaching the cap never blocks control lanes (membership changes, recovery) for a live group.
- A supported way to prune an existing over-cap peer (one-off, or at startup from the set of live topics).

## Open for kumiai / kubun to decide

- Ref-counted retain/release in hub-mux versus the host reconciling the live topic set at startup.
- Whether the hub should expose an unsubscribe-many verb and a shorter purge for topics with no head.
- Whether control lanes get a reserved quota.

## Related

- Minor: `initControlLanes` (`peer.ts` ~1740) subscribes asynchronously and then pulls without awaiting readiness; being
  fixed separately (`fix/control-subscribe-ready`).
- `2026-10-27-durable-recovery-commit-journal.md` (quota errors are a suspected heal trigger).
