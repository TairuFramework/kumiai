---
"@kumiai/hub-server": patch
---

`createHub` accepts `replay` (a replay cache plus tuning) and forwards it to enkaku `serve()`, so a host can supply a persistent replay cache that survives a hub restart. The hub cannot be configured to disable replay checks.
