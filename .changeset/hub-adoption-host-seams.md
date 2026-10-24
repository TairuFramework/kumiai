---
"@kumiai/hub-store": minor
"@kumiai/hub-server": minor
"@kumiai/hub-conformance": minor
"@kumiai/hub-http": minor
---

Hub host seams and a purge race fix. Moves to `@hozon/db` 0.5, `@hozon/provider` 0.3 and `@teikyo` 0.4, whose minors are breaking, so the hub packages take a minor bump with them.

- `hub-store`: `purge` no longer deletes a log frame published while the sweep runs. Log removal is bounded by the head read under the topic lock, and a topic with no head yet purges mailbox frames only. Previously, on Postgres, the first log publish to a mailbox-only topic could be deleted if it committed mid-sweep.
- `hub-store`: the SQL store adds `purgeSubscriptions({ olderThan })`, which deletes subscriptions idle for longer than the window and returns exactly the rows it deleted. `createHubStore` and `getHubStore` return `SQLHubStore` (`HubStore & HubSubscriptionReaper`).
- `hub-server`: the purge timer also reaps idle subscriptions when the store provides `purgeSubscriptions`. `HubPurgeOptions.subscriptionOlderThan` defaults to 90 days and is clamped to at least `olderThan`. Failures report through `onStoreError` with `method: 'purgeSubscriptions'`.
- `hub-conformance`: new `testHubStorePurgeRaceConformance` export, for stores that run purge concurrently with publishes.
- `hub-http`: `createHubServer` accepts `plugins`, composed after the hub plugin, so a host can serve its own routes beside the hub.
