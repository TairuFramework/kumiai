---
'@kumiai/hub-http': patch
'@kumiai/hub-store': patch
---

Move to `@hozon/adapter` 0.3 and the latest hozon packages. `createHubStore` hosts must pass an adapter from the 0.3 line, which rejects a root transaction call inside an active transaction.
