---
"@kumiai/hub-store": patch
"@kumiai/hub-server": patch
"@kumiai/hub-conformance": patch
"@kumiai/hub-http": patch
---

Hub host seams and a purge race fix.

- `hub-store`: `purge` no longer deletes a log frame published while the sweep runs. Log removal is bounded by the head read under the topic lock, and a topic with no head yet purges mailbox frames only. Previously, on Postgres, the first log publish to a mailbox-only topic could be deleted if it committed mid-sweep.
- `hub-store`: the SQL store adds `purgeSubscriptions({ olderThan })`, which deletes subscriptions idle for longer than the window and returns exactly the rows it deleted. `createHubStore` and `getHubStore` return `SQLHubStore` (`HubStore & HubSubscriptionReaper`).
- `hub-server`: the purge timer also reaps idle subscriptions when the store provides `purgeSubscriptions`. `HubPurgeOptions.subscriptionOlderThan` defaults to 90 days and is clamped to at least `olderThan`. Failures report through `onStoreError` with `method: 'purgeSubscriptions'`.
- `hub-conformance`: new `@kumiai/hub-conformance/purge-race` export, `testHubStorePurgeRaceConformance`, for stores that run purge concurrently with publishes.
- `hub-http`: `createHubServer` accepts `plugins`, composed after the hub plugin, so a host can serve its own routes beside the hub.
