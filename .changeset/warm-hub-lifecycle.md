---
"@kumiai/hub-server": patch
---

Add a `verifyToken` hook to `createHub` and await hub teardown. `WakeDispatcher.dispose()` now returns `Promise<void>`.
