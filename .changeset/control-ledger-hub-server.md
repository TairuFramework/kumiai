---
"@kumiai/hub-server": minor
---

BREAKING (lockstep with `@kumiai/hub-protocol`): the store implements the new `HubStore` contract — log/mailbox retention classes, stored `head`, `fetchTopic`, `trim`, and class-scoped trim and depth eviction (a mailbox flood can no longer evict a group's commit log). A deduped publish is no longer re-fanned to subscribers.
