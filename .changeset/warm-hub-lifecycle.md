---
"@kumiai/hub-server": minor
---

Add a `verifyToken` hook to `createHub` and await hub teardown. `WakeDispatcher.dispose()` now returns `Promise<void>`.
